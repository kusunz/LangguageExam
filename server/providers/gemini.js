const { createProviderError } = require('./openrouter');

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10);
const DEFAULT_GEMINI_MODEL_FALLBACK =
  process.env.GEMINI_MODEL_FALLBACK || 'gemini-3.1-flash-lite-preview';
const DEFAULT_GEMINI_MODEL_FALLBACK_COMPAT =
  Object.prototype.hasOwnProperty.call(process.env, 'GEMINI_MODEL_FALLBACK_COMPAT')
    ? process.env.GEMINI_MODEL_FALLBACK_COMPAT
    : '';
const DEFAULT_GEMINI_EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL_PRIMARY ||
  process.env.GEMINI_EMBEDDING_MODEL ||
  'gemini-embedding-001';
const DEFAULT_GEMINI_EMBEDDING_MODEL_SECONDARY =
  process.env.GEMINI_EMBEDDING_MODEL_SECONDARY || '';
const DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIM = Number.parseInt(
  process.env.GEMINI_EMBEDDING_OUTPUT_DIM || '768',
  10
);

function uniqueKeyStages(candidates) {
  const stages = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!candidate?.apiKey) continue;
    if (seen.has(candidate.apiKey)) continue;
    seen.add(candidate.apiKey);
    stages.push(candidate);
  }

  return stages;
}

function getGeminiTextKeyStages() {
  const legacyKey = process.env.GEMINI_API_KEY || '';
  const stageAKey = process.env.GEMINI_API_KEY_A || legacyKey;
  const stageBKey = process.env.GEMINI_API_KEY_B || (process.env.GEMINI_API_KEY_A ? legacyKey : '');

  return uniqueKeyStages([
    { name: 'gemini-key-a', apiKey: stageAKey },
    { name: 'gemini-key-b', apiKey: stageBKey }
  ]);
}

function getGeminiEmbeddingKeyStages() {
  const textStages = getGeminiTextKeyStages();
  const textKeyA = textStages[0]?.apiKey || '';
  const textKeyB = textStages.find((stage) => stage.apiKey && stage.apiKey !== textKeyA)?.apiKey || '';

  const stageAKey = process.env.GEMINI_EMBEDDING_KEY_A || textKeyA;
  const stageBKey = process.env.GEMINI_EMBEDDING_KEY_B || textKeyB;

  return uniqueKeyStages([
    { name: 'gemini-embedding-key-a', apiKey: stageAKey },
    { name: 'gemini-embedding-key-b', apiKey: stageBKey }
  ]);
}

function getGeminiEmbeddingModels() {
  const seen = new Set();

  return [
    DEFAULT_GEMINI_EMBEDDING_MODEL,
    DEFAULT_GEMINI_EMBEDDING_MODEL_SECONDARY
  ].filter((model) => {
    const normalized = String(model || '').trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';

  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

async function callGeminiText(options) {
  const {
    prompt,
    model = DEFAULT_GEMINI_MODEL_FALLBACK,
    apiKey,
    maxTokens = 16384,
    temperature = 0.4,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch
  } = options || {};

  if (!apiKey) {
    throw createProviderError('Missing Gemini API key', {
      provider: 'gemini',
      model,
      retryable: false,
      status: 500
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          responseMimeType: 'application/json',
          topP: 0.95
        }
      })
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === 'AbortError') {
      throw createProviderError(`Gemini ${model} timed out`, {
        provider: 'gemini',
        model,
        retryable: true,
        code: 'timeout'
      });
    }

    throw createProviderError(`Gemini ${model} request failed: ${error?.message || error}`, {
      provider: 'gemini',
      model,
      retryable: true,
      code: 'network_error'
    });
  }

  clearTimeout(timeout);

  if (!response.ok) {
    const errorText = await response.text();
    throw createProviderError(`Gemini ${model} failed with ${response.status}: ${errorText}`, {
      provider: 'gemini',
      model,
      status: response.status,
      retryable: response.status === 402 || response.status === 429 || response.status >= 500
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw createProviderError(`Gemini ${model} returned invalid JSON envelope`, {
      provider: 'gemini',
      model,
      retryable: true,
      code: 'invalid_provider_response'
    });
  }

  const text = extractGeminiText(data);
  if (!text) {
    throw createProviderError(`Gemini ${model} returned empty content`, {
      provider: 'gemini',
      model,
      retryable: true,
      code: 'empty_response'
    });
  }

  return {
    provider: 'gemini',
    model,
    text,
    raw: data
  };
}

async function callGeminiEmbedding(options) {
  const {
    text,
    apiKey,
    model = DEFAULT_GEMINI_EMBEDDING_MODEL,
    outputDimensionality = DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIM,
    taskType = 'RETRIEVAL_DOCUMENT',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch
  } = options || {};

  if (!apiKey) {
    throw createProviderError('Missing Gemini embedding API key', {
      provider: 'gemini-embedding',
      model,
      retryable: false,
      status: 500
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: {
          role: 'user',
          parts: [{ text }]
        },
        taskType,
        outputDimensionality
      })
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === 'AbortError') {
      throw createProviderError(`Gemini embedding ${model} timed out`, {
        provider: 'gemini-embedding',
        model,
        retryable: true,
        code: 'timeout'
      });
    }

    throw createProviderError(`Gemini embedding ${model} request failed: ${error?.message || error}`, {
      provider: 'gemini-embedding',
      model,
      retryable: true,
      code: 'network_error'
    });
  }

  clearTimeout(timeout);

  if (!response.ok) {
    const errorText = await response.text();
    throw createProviderError(`Gemini embedding ${model} failed with ${response.status}: ${errorText}`, {
      provider: 'gemini-embedding',
      model,
      status: response.status,
      retryable: response.status === 402 || response.status === 429 || response.status >= 500
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw createProviderError(`Gemini embedding ${model} returned invalid JSON envelope`, {
      provider: 'gemini-embedding',
      model,
      retryable: true,
      code: 'invalid_provider_response'
    });
  }

  const values = data?.embedding?.values || data?.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw createProviderError(`Gemini embedding ${model} returned empty vector`, {
      provider: 'gemini-embedding',
      model,
      retryable: true,
      code: 'empty_response'
    });
  }

  return {
    provider: 'gemini-embedding',
    model,
    values
  };
}

async function callGeminiBatchEmbedding(options) {
  const {
    texts,
    apiKey,
    model = DEFAULT_GEMINI_EMBEDDING_MODEL,
    outputDimensionality = DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIM,
    taskType = 'RETRIEVAL_DOCUMENT',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch
  } = options || {};

  if (!apiKey) {
    throw createProviderError('Missing Gemini embedding API key', {
      provider: 'gemini-embedding',
      model,
      retryable: false,
      status: 500
    });
  }

  const normalizedTexts = Array.isArray(texts)
    ? texts.map((text) => String(text || '')).filter((text) => text.trim().length > 0)
    : [];

  if (normalizedTexts.length === 0) {
    return {
      provider: 'gemini-embedding',
      model,
      valuesList: []
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: normalizedTexts.map((text) => ({
          model: `models/${model}`,
          content: {
            role: 'user',
            parts: [{ text }]
          },
          taskType,
          outputDimensionality
        }))
      })
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === 'AbortError') {
      throw createProviderError(`Gemini embedding ${model} timed out`, {
        provider: 'gemini-embedding',
        model,
        retryable: true,
        code: 'timeout'
      });
    }

    throw createProviderError(`Gemini embedding ${model} request failed: ${error?.message || error}`, {
      provider: 'gemini-embedding',
      model,
      retryable: true,
      code: 'network_error'
    });
  }

  clearTimeout(timeout);

  if (!response.ok) {
    const errorText = await response.text();
    throw createProviderError(`Gemini embedding ${model} failed with ${response.status}: ${errorText}`, {
      provider: 'gemini-embedding',
      model,
      status: response.status,
      retryable: response.status === 402 || response.status === 429 || response.status >= 500
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw createProviderError(`Gemini embedding ${model} returned invalid JSON envelope`, {
      provider: 'gemini-embedding',
      model,
      retryable: true,
      code: 'invalid_provider_response'
    });
  }

  const valuesList = Array.isArray(data?.embeddings)
    ? data.embeddings.map((entry) => entry?.values || entry?.embedding?.values)
    : [];

  if (
    valuesList.length !== normalizedTexts.length ||
    valuesList.some((values) => !Array.isArray(values) || values.length === 0)
  ) {
    throw createProviderError(`Gemini embedding ${model} returned empty batch vector`, {
      provider: 'gemini-embedding',
      model,
      retryable: true,
      code: 'empty_response'
    });
  }

  return {
    provider: 'gemini-embedding',
    model,
    valuesList
  };
}

module.exports = {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_EMBEDDING_MODEL_SECONDARY,
  DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIM,
  DEFAULT_GEMINI_MODEL_FALLBACK,
  DEFAULT_GEMINI_MODEL_FALLBACK_COMPAT,
  callGeminiBatchEmbedding,
  callGeminiEmbedding,
  callGeminiText,
  getGeminiEmbeddingModels,
  getGeminiEmbeddingKeyStages,
  getGeminiTextKeyStages
};

