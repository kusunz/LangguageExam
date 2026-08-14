const { parsePositiveInt, createProviderError } = require("./provider-utils");

const DEFAULT_NIM_BASE = process.env.NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const DEFAULT_NIM_BASE_URL = DEFAULT_NIM_BASE.replace(/\/+$/, "");
const DEFAULT_NIM_TIMEOUT_MS = parsePositiveInt(process.env.NIM_TIMEOUT_MS, 180000);
const DEFAULT_NIM_MAX_TOKENS = parsePositiveInt(process.env.NIM_MAX_TOKENS, 8192);

const RETRYABLE_STATUS_CODES = new Set([401, 402, 403, 404, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_PATTERNS = [
  "temporarily rate-limited upstream",
  "provider returned error",
  "no endpoints available matching your guardrail restrictions",
  "run out of credit",
  "quota exceeded",
  "rate limit"
];

let UndiciAgent;
try {
  ({ Agent: UndiciAgent } = require("undici"));
} catch (_error) {
  UndiciAgent = null;
}

let NIM_DISPATCHER;
function getNimDispatcher() {
  if (NIM_DISPATCHER !== undefined) {
    return NIM_DISPATCHER;
  }
  NIM_DISPATCHER = null;
  if (!UndiciAgent) {
    return NIM_DISPATCHER;
  }
  try {
    NIM_DISPATCHER = new UndiciAgent({
      connectTimeout: parsePositiveInt(process.env.NIM_CONNECT_TIMEOUT_MS, 15000),
      keepAliveTimeout: parsePositiveInt(process.env.NIM_KEEPALIVE_TIMEOUT_MS, 10000),
      keepAliveMaxTimeout: parsePositiveInt(process.env.NIM_KEEPALIVE_MAX_TIMEOUT_MS, 30000),
      headersTimeout: DEFAULT_NIM_TIMEOUT_MS,
    });
  } catch (_error) {
    NIM_DISPATCHER = null;
  }
  return NIM_DISPATCHER;
}

function isRetryableNimFailure(status, errorText) {
  const normalized = String(errorText || "").toLowerCase();
  if (RETRYABLE_STATUS_CODES.has(status)) return true;
  if (typeof status === "number" && status >= 500) return true;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

async function callNIM(options) {
  const {
    prompt,
    model,
    maxTokens,
    temperature = 0.4,
    timeoutMs = DEFAULT_NIM_TIMEOUT_MS,
    reasoning = null,
    fetchImpl = fetch,
    includeRaw = false,
    useReasoning = false,
    systemPrompt = null
  } = options || {};

  const apiKey = process.env.NIM_API_KEY || process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw createProviderError("Missing NIM_API_KEY or NVIDIA_API_KEY", {
      provider: "nim",
      model,
      retryable: false,
      status: 500
    });
  }

  const normalizedTimeoutMs = parsePositiveInt(timeoutMs, DEFAULT_NIM_TIMEOUT_MS);
  const normalizedMaxTokens = parsePositiveInt(maxTokens, DEFAULT_NIM_MAX_TOKENS);

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const requestBody = {
    model,
    messages,
    max_tokens: normalizedMaxTokens,
    temperature,
    stream: false
  };

  if (reasoning) {
    requestBody.reasoning = reasoning;
  }

  const requestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(requestBody)
  };

  if (fetchImpl === fetch) {
    const dispatcher = getNimDispatcher();
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

  const start = Date.now();
  let response;
  try {
    response = await fetchImpl(`${DEFAULT_NIM_BASE_URL}/chat/completions`, requestInit);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createProviderError(`NIM ${model} timed out`, {
        provider: "nim",
        model,
        retryable: true,
        code: "timeout"
      });
    }
    throw createProviderError(`NIM ${model} request failed: ${error?.message || error}`, {
      provider: "nim",
      model,
      retryable: true,
      code: "network_error"
    });
  } finally {
    clearTimeout(timeout);
  }

  const latencyMs = Date.now() - start;

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw createProviderError(`NIM ${model} failed with ${response.status}: ${errorText}`, {
      provider: "nim",
      model,
      status: response.status,
      retryable: isRetryableNimFailure(response.status, errorText)
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (_error) {
    throw createProviderError(`NIM ${model} returned invalid JSON envelope`, {
      provider: "nim",
      model,
      retryable: true,
      code: "invalid_provider_response"
    });
  }

  const text = (data.choices?.[0]?.message?.content || "").trim();
  if (!text) {
    throw createProviderError(`NIM ${model} returned empty content`, {
      provider: "nim",
      model,
      retryable: true,
      code: "empty_response"
    });
  }

  const result = {
    text,
    latencyMs,
    provider: "nim",
    model
  };

  if (includeRaw) {
    result.raw = data;
  }

  return result;
}

module.exports = { callNIM, DEFAULT_NIM_BASE_URL, DEFAULT_NIM_TIMEOUT_MS, DEFAULT_NIM_MAX_TOKENS };