const DEFAULT_OPENROUTER_BASE =
  process.env.OPENROUTER_API_BASE ||
  process.env.OPENROUTER_BASE_URL ||
  "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_BASE_URL = DEFAULT_OPENROUTER_BASE.replace(/\/+$/, "");

const { parsePositiveInt, createProviderError: _sharedCreateProviderError, extractMessageText } = require("./provider-utils");

const DEFAULT_TIMEOUT_MS = parsePositiveInt(
  process.env.OPENROUTER_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS,
  120000
);
const DEFAULT_MAX_TOKENS = parsePositiveInt(
  process.env.OPENROUTER_MAX_TOKENS || process.env.LLM_GENERATE_MAX_TOKENS,
  16384
);
const RETRYABLE_STATUS_CODES = new Set([401, 402, 403, 404, 429]);
const RETRYABLE_ERROR_PATTERNS = [
  "temporarily rate-limited upstream",
  "provider returned error",
  "no endpoints available matching your guardrail restrictions",
  "run out of credit",
  "err_ngrok_4026"
];

let UndiciAgent;
try {
  ({ Agent: UndiciAgent } = require("undici"));
} catch (_error) {
  UndiciAgent = null;
}

let OPENROUTER_DISPATCHER;
function getOpenRouterDispatcher() {
  if (OPENROUTER_DISPATCHER !== undefined) {
    return OPENROUTER_DISPATCHER;
  }

  OPENROUTER_DISPATCHER = null;
  if (!UndiciAgent) {
    return OPENROUTER_DISPATCHER;
  }

  try {
    OPENROUTER_DISPATCHER = new UndiciAgent({
      connectTimeout: parsePositiveInt(process.env.OPENROUTER_CONNECT_TIMEOUT_MS, 15000),
      keepAliveTimeout: parsePositiveInt(process.env.OPENROUTER_KEEPALIVE_TIMEOUT_MS, 10000),
      keepAliveMaxTimeout: parsePositiveInt(process.env.OPENROUTER_KEEPALIVE_MAX_TIMEOUT_MS, 30000),
      connections: parsePositiveInt(process.env.OPENROUTER_POOL_CONNECTIONS, 8),
      pipelining: 1
    });
  } catch (_error) {
    OPENROUTER_DISPATCHER = null;
  }

  return OPENROUTER_DISPATCHER;
}

function createProviderError(message, extra = {}) {
  return _sharedCreateProviderError(message, extra);
}

function getOpenRouterBaseUrl() {
  return DEFAULT_OPENROUTER_BASE_URL;
}

// extractMessageText imported from provider-utils.js

function isRetryableOpenRouterFailure(status, errorText) {
  const normalized = String(errorText || "").toLowerCase();

  if (RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  if (typeof status === "number" && status >= 500) {
    return true;
  }

  return RETRYABLE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

async function callOpenRouter(options) {
  const {
    prompt,
    model,
    maxTokens = DEFAULT_MAX_TOKENS,
    temperature = 0.4,
    reasoning,
    apiKey = process.env.OPENROUTER_API_KEY,
    baseUrl = getOpenRouterBaseUrl(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    expectJson = true,
    includeRaw = true,
    useReasoning = false,
    systemPrompt
  } = options || {};

  if (!apiKey) {
    throw createProviderError("Missing OPENROUTER_API_KEY", {
      provider: "openrouter",
      model,
      retryable: false,
      status: 500
    });
  }

  const normalizedTimeoutMs = parsePositiveInt(timeoutMs, DEFAULT_TIMEOUT_MS);
  const normalizedMaxTokens = parsePositiveInt(maxTokens, DEFAULT_MAX_TOKENS);
  const normalizedBaseUrl = String(baseUrl || getOpenRouterBaseUrl()).replace(/\/+$/, "");

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const requestBody = {
    model,
    messages,
    temperature,
    max_tokens: normalizedMaxTokens
  };

  if (useReasoning && reasoning) {
    requestBody.reasoning = reasoning;
  } else if (expectJson) {
    requestBody.response_format = { type: "json_object" };
  }

  const requestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  };

  if (fetchImpl === fetch) {
    const dispatcher = getOpenRouterDispatcher();
    if (dispatcher) {
      requestInit.dispatcher = dispatcher;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizedTimeoutMs);
  if (typeof timeout.unref === "function") {
    timeout.unref();
  }

  requestInit.signal = controller.signal;

  let response;
  try {
    response = await fetchImpl(`${normalizedBaseUrl}/chat/completions`, requestInit);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createProviderError(`OpenRouter ${model} timed out`, {
        provider: "openrouter",
        model,
        retryable: true,
        code: "timeout"
      });
    }

    throw createProviderError(`OpenRouter ${model} request failed: ${error?.message || error}`, {
      provider: "openrouter",
      model,
      retryable: true,
      code: "network_error"
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw createProviderError(`OpenRouter ${model} failed with ${response.status}: ${errorText}`, {
      provider: "openrouter",
      model,
      status: response.status,
      retryable: isRetryableOpenRouterFailure(response.status, errorText)
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (_error) {
    throw createProviderError(`OpenRouter ${model} returned invalid JSON envelope`, {
      provider: "openrouter",
      model,
      retryable: true,
      code: "invalid_provider_response"
    });
  }

  const text = extractMessageText(data?.choices?.[0]?.message).trim();
  if (!text) {
    throw createProviderError(`OpenRouter ${model} returned empty content`, {
      provider: "openrouter",
      model,
      retryable: true,
      code: "empty_response"
    });
  }

  const result = {
    provider: "openrouter",
    model,
    text
  };

  if (includeRaw) {
    result.raw = data;
  }

  return result;
}

module.exports = {
  callOpenRouter,
  createProviderError,
  getOpenRouterBaseUrl,
  isRetryableOpenRouterFailure
};
