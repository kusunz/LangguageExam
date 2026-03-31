const DEFAULT_OPENROUTER_BASE =
  process.env.OPENROUTER_API_BASE ||
  process.env.OPENROUTER_BASE_URL ||
  'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.LLM_TIMEOUT_MS || '45000', 10);

function createProviderError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function getOpenRouterBaseUrl() {
  return DEFAULT_OPENROUTER_BASE.replace(/\/+$/, '');
}

function extractMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';

  return message.content
    .map((part) => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

async function callOpenRouter(options) {
  const {
    prompt,
    model,
    maxTokens = 16384,
    temperature = 0.4,
    apiKey = process.env.OPENROUTER_API_KEY,
    baseUrl = getOpenRouterBaseUrl(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch
  } = options || {};

  if (!apiKey) {
    throw createProviderError('Missing OPENROUTER_API_KEY', {
      provider: 'openrouter',
      model,
      retryable: false,
      status: 500
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' }
      })
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === 'AbortError') {
      throw createProviderError(`OpenRouter ${model} timed out`, {
        provider: 'openrouter',
        model,
        retryable: true,
        code: 'timeout'
      });
    }

    throw createProviderError(`OpenRouter ${model} request failed: ${error?.message || error}`, {
      provider: 'openrouter',
      model,
      retryable: true,
      code: 'network_error'
    });
  }

  clearTimeout(timeout);

  if (!response.ok) {
    const errorText = await response.text();
    throw createProviderError(`OpenRouter ${model} failed with ${response.status}: ${errorText}`, {
      provider: 'openrouter',
      model,
      status: response.status,
      retryable: response.status === 402 || response.status === 429 || response.status >= 500
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw createProviderError(`OpenRouter ${model} returned invalid JSON envelope`, {
      provider: 'openrouter',
      model,
      retryable: true,
      code: 'invalid_provider_response'
    });
  }

  const text = extractMessageText(data?.choices?.[0]?.message).trim();
  if (!text) {
    throw createProviderError(`OpenRouter ${model} returned empty content`, {
      provider: 'openrouter',
      model,
      retryable: true,
      code: 'empty_response'
    });
  }

  return {
    provider: 'openrouter',
    model,
    text,
    raw: data
  };
}

module.exports = {
  callOpenRouter,
  createProviderError,
  getOpenRouterBaseUrl
};
