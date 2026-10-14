const { createProviderError } = require('./openrouter');

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.NINEROUTER_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || '120000', 10);
const DEFAULT_MAX_TOKENS = Number.parseInt(process.env.NINEROUTER_MAX_TOKENS || process.env.LLM_GENERATE_MAX_TOKENS || '16384', 10);
const DEFAULT_NINEROUTER_BASE = process.env.NINEROUTER_API_BASE || 'https://9r.dasun.app/v1';
const DEFAULT_NINEROUTER_BASE_URL = DEFAULT_NINEROUTER_BASE.replace(/\/+$/, '');

const CF_ID = process.env.NINEROUTER_CF_ID || '';
const CF_TOKEN = process.env.NINEROUTER_CF_TOKEN || '';

const RETRYABLE_STATUS_CODES = new Set([401, 402, 403, 404, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_PATTERNS = [
  'timeout',
  'network',
  'econnreset',
  'etimedout',
  'eai_again',
  'temporarily rate-limited upstream',
  'provider returned error',
  'no endpoints available',
  'run out of credit',
  'err_ngrok_4026'
];

let UndiciAgent;
try {
  ({ Agent: UndiciAgent } = require('undici'));
} catch (_error) {
  UndiciAgent = null;
}

let NINEROUTER_DISPATCHER;
function getNineRouterDispatcher() {
  if (NINEROUTER_DISPATCHER !== undefined) {
    return NINEROUTER_DISPATCHER;
  }
  NINEROUTER_DISPATCHER = null;
  if (!UndiciAgent) {
    return NINEROUTER_DISPATCHER;
  }
  try {
    NINEROUTER_DISPATCHER = new UndiciAgent({
      connectTimeout: Number.parseInt(process.env.NINEROUTER_CONNECT_TIMEOUT_MS || '15000', 10),
      keepAliveTimeout: Number.parseInt(process.env.NINEROUTER_KEEPALIVE_TIMEOUT_MS || '10000', 10),
      keepAliveMaxTimeout: Number.parseInt(process.env.NINEROUTER_KEEPALIVE_MAX_TIMEOUT_MS || '30000', 10),
      connections: Number.parseInt(process.env.NINEROUTER_POOL_CONNECTIONS || '8', 10),
      pipelining: 1
    });
  } catch (_error) {
    NINEROUTER_DISPATCHER = null;
  }
  return NINEROUTER_DISPATCHER;
}

function getNineRouterBaseUrl() {
  return DEFAULT_NINEROUTER_BASE_URL;
}

function extractMessageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') {
      text += part;
      continue;
    }
    if (typeof part.text === 'string') {
      text += part.text;
    }
  }
  return text;
}

function isRetryableNineRouterFailure(status, errorText) {
  const normalized = String(errorText || '').toLowerCase();
  if (RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }
  if (typeof status === 'number' && status >= 500) {
    return true;
  }
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

async function callNineRouter(options) {
  const {
    prompt,
    model,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0.4,
    reasoning,
    apiKey = process.env.NINEROUTER_API_KEY,
    baseUrl = getNineRouterBaseUrl(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    expectJson = true,
    includeRaw = true
  } = options || {};

  if (!apiKey) {
    throw createProviderError('Missing NINEROUTER_API_KEY', {
      provider: 'ninerouter',
      model,
      retryable: false,
      status: 500
    });
  }

  const normalizedTimeoutMs = Number.parseInt(String(timeoutMs), 10) || DEFAULT_TIMEOUT_MS;
  const normalizedMaxTokens = Number.parseInt(String(maxTokens), 10) || DEFAULT_MAX_TOKENS;
  const normalizedBaseUrl = String(baseUrl || getNineRouterBaseUrl()).replace(/\/+$/, '');

  const requestBody = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: normalizedMaxTokens
  };
  if (expectJson) {
    requestBody.response_format = { type: 'json_object' };
  }
  if (reasoning && typeof reasoning === 'object') {
    requestBody.reasoning = reasoning;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (CF_ID) {
    headers['cf-access-client-id'] = CF_ID;
  }
  if (CF_TOKEN) {
    headers['cf-access-client-secret'] = CF_TOKEN;
  }

  const requestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  };

  if (fetchImpl === fetch) {
    const dispatcher = getNineRouterDispatcher();
    if (dispatcher) {
      requestInit.dispatcher = dispatcher;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizedTimeoutMs);
  if (typeof timeout.unref === 'function') {
    timeout.unref();
  }
  requestInit.signal = controller.signal;

  let response;
  try {
    response = await fetchImpl(`${normalizedBaseUrl}/chat/completions`, requestInit);
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === 'AbortError') {
      throw createProviderError(`NineRouter ${model} timed out`, {
        provider: 'ninerouter',
        model,
        retryable: true,
        code: 'timeout'
      });
    }
    throw createProviderError(`NineRouter ${model} request failed: ${error?.message || error}`, {
      provider: 'ninerouter',
      model,
      retryable: true,
      code: 'network_error'
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw createProviderError(`NineRouter ${model} failed with ${response.status}: ${errorText}`, {
      provider: 'ninerouter',
      model,
      status: response.status,
      retryable: isRetryableNineRouterFailure(response.status, errorText)
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (_error) {
    throw createProviderError(`NineRouter ${model} returned invalid JSON envelope`, {
      provider: 'ninerouter',
      model,
      retryable: true,
      code: 'invalid_provider_response'
    });
  }

  const text = extractMessageText(data?.choices?.[0]?.message).trim();
  if (!text) {
    throw createProviderError(`NineRouter ${model} returned empty content`, {
      provider: 'ninerouter',
      model,
      retryable: true,
      code: 'empty_response'
    });
  }

  const result = {
    provider: 'ninerouter',
    model,
    text
  };
  if (includeRaw) {
    result.raw = data;
  }
  return result;
}

async function checkNineRouterHealth() {
  const apiKey = process.env.NINEROUTER_API_KEY;
  if (!apiKey) return false;

  const baseUrl = getNineRouterBaseUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(CF_ID ? { 'cf-access-client-id': CF_ID } : {}),
        ...(CF_TOKEN ? { 'cf-access-client-secret': CF_TOKEN } : {})
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response.ok;
  } catch (_error) {
    clearTimeout(timeout);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(CF_ID ? { 'cf-access-client-id': CF_ID } : {}),
          ...(CF_TOKEN ? { 'cf-access-client-secret': CF_TOKEN } : {})
        },
        signal: controller.signal
      });
      return response.ok;
    } catch (__error) {
      return false;
    }
  }
}

module.exports = {
  callNineRouter,
  getNineRouterBaseUrl,
  isRetryableNineRouterFailure,
  checkNineRouterHealth,
  createProviderError
};
