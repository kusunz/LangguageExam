const { callOpenRouter } = require("./openrouter");
const {
  DEFAULT_GEMINI_MODEL_FALLBACK,
  DEFAULT_GEMINI_MODEL_FALLBACK_COMPAT,
  callGeminiText,
  getGeminiTextKeyStages
} = require("./gemini");
const { getRoleConfig } = require("./prompt-roles");

const TEMPORARY_UNAVAILABLE_PAYLOAD = {
  error: "llm_temporarily_unavailable",
  message: "Generation service temporarily unavailable. Please try again later.",
  retryable: true
};
const stageCooldownState = new Map();
const DEFAULT_STAGE_COOLDOWN_MS = parsePositiveInt(process.env.LLM_STAGE_COOLDOWN_MS, 30000);
const RATE_LIMIT_STAGE_COOLDOWN_MS = parsePositiveInt(process.env.LLM_RATE_LIMIT_STAGE_COOLDOWN_MS, 60000);
const MISSING_ENDPOINT_STAGE_COOLDOWN_MS = parsePositiveInt(
  process.env.LLM_MISSING_ENDPOINT_STAGE_COOLDOWN_MS,
  6 * 60 * 60 * 1000
);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function logRouter(message, data = null) {
  const stamp = new Date().toISOString();
  try {
    console.log(`[${stamp}] [LLM_ROUTER] ${message}${data ? " " + JSON.stringify(data) : ""}`);
  } catch (error) {
    console.log(`[${stamp}] [LLM_ROUTER] ${message}`);
  }
}

function createRouterError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function createTemporaryUnavailableError(cause) {
  return createRouterError(TEMPORARY_UNAVAILABLE_PAYLOAD.message, {
    status: 503,
    code: TEMPORARY_UNAVAILABLE_PAYLOAD.error,
    retryable: true,
    payload: { ...TEMPORARY_UNAVAILABLE_PAYLOAD },
    cause
  });
}

function isTemporaryUnavailableError(error) {
  return error?.status === 503 && error?.code === TEMPORARY_UNAVAILABLE_PAYLOAD.error;
}

function getTemporaryUnavailablePayload(error) {
  return error?.payload || { ...TEMPORARY_UNAVAILABLE_PAYLOAD };
}

function getStageCacheKey(stage) {
  return [
    stage?.provider || "unknown",
    stage?.name || "unnamed",
    stage?.model || "default",
    stage?.apiKey ? String(stage.apiKey).slice(-8) : ""
  ].join("|");
}

function getStageCooldownEntry(stage) {
  const cacheKey = getStageCacheKey(stage);
  const entry = stageCooldownState.get(cacheKey);
  if (!entry) return null;
  if (entry.until <= Date.now()) {
    stageCooldownState.delete(cacheKey);
    return null;
  }
  return entry;
}

function clearStageCooldown(stage) {
  stageCooldownState.delete(getStageCacheKey(stage));
}

function parseRetryDelayMs(message) {
  const text = String(message || "");
  let bestMs = 0;
  const patterns = [
    /please retry in\s+([0-9.]+)s/gi,
    /"retryDelay"\s*:\s*"([0-9.]+)s"/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const seconds = Number.parseFloat(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) {
        bestMs = Math.max(bestMs, Math.ceil(seconds * 1000));
      }
    }
  }

  return bestMs || null;
}

function isCompatModel(stage) {
  return stage?.name?.includes("-compat") === true;
}

function getStageCooldownMs(stage, error) {
  if (!error) return null;

  const message = String(error.message || "");

  // Skip compat models entirely on 503 (model overloaded)
  if (
    error.status === 503 &&
    isCompatModel(stage)
  ) {
    return MISSING_ENDPOINT_STAGE_COOLDOWN_MS;
  }

  if (
    stage?.provider === "openrouter" &&
    error.status === 404 &&
    /no endpoints found/i.test(message)
  ) {
    return MISSING_ENDPOINT_STAGE_COOLDOWN_MS;
  }

  if (
    error.status === 429 ||
    /quota exceeded|rate limit|resource_exhausted|please retry in/i.test(message)
  ) {
    return Math.max(parseRetryDelayMs(message) || 0, RATE_LIMIT_STAGE_COOLDOWN_MS);
  }

  if (typeof error.status === "number" && error.status >= 500) {
    return DEFAULT_STAGE_COOLDOWN_MS;
  }

  if (error.retryable) {
    return DEFAULT_STAGE_COOLDOWN_MS;
  }

  return null;
}

function markStageCooldown(stage, error) {
  const cooldownMs = getStageCooldownMs(stage, error);
  if (!cooldownMs) return null;

  const entry = {
    until: Date.now() + cooldownMs,
    cooldownMs,
    status: error?.status || null,
    reason: String(error?.message || "").slice(0, 240)
  };
  stageCooldownState.set(getStageCacheKey(stage), entry);
  return entry;
}

function getTaskModels() {
  return {
    generate: {
      openrouterPrimary: process.env.OPENROUTER_MODEL_GENERATE_PRIMARY || "nvidia/nemotron-3-ultra-550b-a55b:free",
      openrouterSecondary: process.env.OPENROUTER_MODEL_GENERATE_SECONDARY || "nvidia/nemotron-3-super-120b-a12b:free",
      openrouterTertiary: process.env.OPENROUTER_MODEL_GENERATE_TERTIARY || "nvidia/nemotron-3-nano-30b-a3b:free"
      // REMOVED: openrouterRouter (was random router)
    },
    repair: {
      openrouterPrimary: process.env.OPENROUTER_MODEL_REPAIR_PRIMARY || "nvidia/nemotron-3-nano-30b-a3b:free",
      openrouterSecondary: process.env.OPENROUTER_MODEL_REPAIR_SECONDARY || "openrouter/free"
    },
    explain: {
      openrouterPrimary: process.env.OPENROUTER_MODEL_EXPLAIN_PRIMARY || "nvidia/nemotron-3-super-120b-a12b:free",
      openrouterSecondary: process.env.OPENROUTER_MODEL_EXPLAIN_SECONDARY || "nvidia/nemotron-3-nano-30b-a3b:free"
    }
  };
}

function buildProviderStages(taskName) {
  const taskModels = getTaskModels();
  const taskConfig = taskModels[taskName];
  const repairConfig = taskModels.repair;
  const roleConfig = getRoleConfig(taskName);
  const stages = [];

  // OpenRouter stages FIRST (primary provider)
  if (process.env.OPENROUTER_API_KEY) {
    const isFreeModel = (model) => model && model.includes(":free");
    

    if (taskConfig.openrouterPrimary) {
      const primaryIsFree = isFreeModel(taskConfig.openrouterPrimary);
      stages.push({
        name: "openrouter-primary",
        provider: "openrouter",
        model: taskConfig.openrouterPrimary,
        repairModel: repairConfig.openrouterPrimary,
        useReasoning: primaryIsFree,
        systemPrompt: roleConfig.system,
        temperature: roleConfig.temperature,
        maxTokens: roleConfig.maxTokens
      });
    }
    if (taskConfig.openrouterSecondary) {
      const secondaryIsFree = isFreeModel(taskConfig.openrouterSecondary);
      stages.push({
        name: "openrouter-secondary",
        provider: "openrouter",
        model: taskConfig.openrouterSecondary,
        repairModel: repairConfig.openrouterSecondary,
        useReasoning: secondaryIsFree,
        systemPrompt: roleConfig.system,
        temperature: roleConfig.temperature,
        maxTokens: roleConfig.maxTokens
      });
    }
    if (taskConfig.openrouterRouter) {
      stages.push({
        name: "openrouter-router",
        provider: "openrouter",
        model: taskConfig.openrouterRouter,
        repairModel: repairConfig.openrouterSecondary,
        useReasoning: routerModel,
        systemPrompt: roleConfig.system,
        temperature: roleConfig.temperature,
        maxTokens: roleConfig.maxTokens
      });
    }
  }

  // Gemini stages as FALLBACK
  const geminiStages = getGeminiTextKeyStages();
  for (const keyStage of geminiStages) {
    stages.push({
      name: keyStage.name,
      provider: "gemini",
      model: DEFAULT_GEMINI_MODEL_FALLBACK,
      repairModel: DEFAULT_GEMINI_MODEL_FALLBACK,
      apiKey: keyStage.apiKey
    });
  }

  if (
    DEFAULT_GEMINI_MODEL_FALLBACK_COMPAT &&
    DEFAULT_GEMINI_MODEL_FALLBACK_COMPAT !== DEFAULT_GEMINI_MODEL_FALLBACK
  ) {
    for (const keyStage of geminiStages) {
      stages.push({
        name: `${keyStage.name}-compat`,
        provider: "gemini",
        model: DEFAULT_GEMINI_MODEL_FALLBACK_COMPAT,
        repairModel: DEFAULT_GEMINI_MODEL_FALLBACK_COMPAT,
        apiKey: keyStage.apiKey
      });
    }
  }

  return stages;
}

function prioritizeStages(stages, options = {}) {
  const preferredProviders = Array.isArray(options.preferredProviders)
    ? options.preferredProviders.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const preferredStageNames = Array.isArray(options.preferredStageNames)
    ? options.preferredStageNames.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const preferredModels = Array.isArray(options.preferredModels)
    ? options.preferredModels.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  if (
    preferredProviders.length === 0 &&
    preferredStageNames.length === 0 &&
    preferredModels.length === 0
  ) {
    return stages;
  }

  const providerRank = new Map(preferredProviders.map((value, index) => [value, index]));
  const stageRank = new Map(preferredStageNames.map((value, index) => [value, index]));
  const modelRank = new Map(preferredModels.map((value, index) => [value, index]));

  return stages
    .map((stage, index) => ({ stage, index }))
    .sort((left, right) => {
      const leftStageRank = stageRank.has(left.stage.name) ? stageRank.get(left.stage.name) : Number.MAX_SAFE_INTEGER;
      const rightStageRank = stageRank.has(right.stage.name) ? stageRank.get(right.stage.name) : Number.MAX_SAFE_INTEGER;
      if (leftStageRank !== rightStageRank) return leftStageRank - rightStageRank;

      const leftProviderRank = providerRank.has(left.stage.provider) ? providerRank.get(left.stage.provider) : Number.MAX_SAFE_INTEGER;
      const rightProviderRank = providerRank.has(right.stage.provider) ? providerRank.get(right.stage.provider) : Number.MAX_SAFE_INTEGER;
      if (leftProviderRank !== rightProviderRank) return leftProviderRank - rightProviderRank;

      const leftModelRank = modelRank.has(left.stage.model) ? modelRank.get(left.stage.model) : Number.MAX_SAFE_INTEGER;
      const rightModelRank = modelRank.has(right.stage.model) ? modelRank.get(right.stage.model) : Number.MAX_SAFE_INTEGER;
      if (leftModelRank !== rightModelRank) return leftModelRank - rightModelRank;

      return left.index - right.index;
    })
    .map((entry) => entry.stage);
}

function stripMarkdownFences(text) {
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractJsonFragment(text) {
  const cleaned = stripMarkdownFences(text);
  const start = cleaned.search(/[\[{]/);
  if (start === -1) return cleaned;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = start; index < cleaned.length; index++) {
    const char = cleaned[index];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;

    if (depth === 0) {
      return cleaned.slice(start, index + 1);
    }
  }

  return cleaned.slice(start);
}

function normalizeValidationErrors(validationResult) {
  if (!validationResult) return [];
  if (validationResult === true) return [];
  if (validationResult === false) return ["validation_failed"];
  if (typeof validationResult === "string") return [validationResult];
  if (!Array.isArray(validationResult)) return ["validation_failed"];
  return validationResult.filter(Boolean).map((item) => String(item));
}

function parseAndValidateJson(text, validateResult) {
  const fragment = extractJsonFragment(text);
  let parsedValue;

  try {
    parsedValue = JSON.parse(fragment);
  } catch (error) {
    return {
      ok: false,
      rawText: text,
      fragment,
      validationErrors: ["invalid_json"],
      error: createRouterError(`Invalid JSON response: ${error.message}`, {
        retryable: true,
        code: "invalid_json"
      })
    };
  }

  if (typeof validateResult === "function") {
    let validationErrors;
    try {
      validationErrors = normalizeValidationErrors(validateResult(parsedValue));
    } catch (error) {
      validationErrors = [error.message || "validation_failed"];
    }

    if (validationErrors.length > 0) {
      return {
        ok: false,
        rawText: text,
        fragment,
        parsedValue,
        validationErrors,
        error: createRouterError(`Schema validation failed: ${validationErrors.join(", ")}`, {
          retryable: true,
          code: "schema_invalid",
          validationErrors
        })
      };
    }
  }

  return {
    ok: true,
    rawText: text,
    fragment,
    value: parsedValue,
    validationErrors: []
  };
}

function buildTaskReasoningOptions(task, options = {}) {
  const explicitReasoning = options.reasoning;
  if (explicitReasoning === null) return undefined;
  if (explicitReasoning && typeof explicitReasoning === "object") return explicitReasoning;

  if (task !== "generate") return undefined;

  const budget = Number.parseInt(process.env.OPENROUTER_GENERATE_REASONING_MAX_TOKENS || "1024", 10);
  if (!Number.isFinite(budget) || budget <= 0) return undefined;

  return {
    max_tokens: budget,
    exclude: true
  };
}

function buildDefaultRepairPrompt(context) {
  const {
    originalPrompt,
    rawText,
    validationErrors = []
  } = context;

  return `You are a JSON repair specialist. Fix invalid JSON while preserving original intent.

ORIGINAL TASK:
${String(originalPrompt || "").slice(0, 12000)}

CURRENT OUTPUT:
${String(rawText || "").slice(0, 12000)}

VALIDATION ERRORS:
${validationErrors.length > 0 ? validationErrors.join("\n") : "invalid_json"}

RULES:
1. Output ONLY valid JSON - no markdown, no explanation
2. Fix syntax errors: missing quotes, trailing commas, unclosed brackets
3. Preserve all original fields and values where possible
4. If a value is missing, infer the minimal valid fix
5. Maintain the original schema structure`;
}

function isRetryableFailure(error) {
  if (!error) return false;
  if (error.retryable) return true;
  if (error.status === 402 || error.status === 429) return true;
  if (typeof error.status === "number" && error.status >= 500) return true;
  return false;
}

async function invokeStage(stage, prompt, options) {
  const requestOptions = {
    prompt,
    model: stage.model,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs,
    reasoning: options.reasoning,
    fetchImpl: options.fetchImpl,
    includeRaw: options.includeRaw,
    // OpenRouter-specific
    useReasoning: stage.useReasoning,
    systemPrompt: stage.systemPrompt
  };

  if (stage.provider === "openrouter") {
    return callOpenRouter(requestOptions);
  }

  return callGeminiText({
    ...requestOptions,
    apiKey: stage.apiKey
  });
}

async function invokeRepairStage(stage, prompt, options) {
  const repairStage = {
    ...stage,
    model: stage.repairModel || stage.model,
    // Repair always uses json_object mode, no reasoning
    useReasoning: false,
    systemPrompt: getRoleConfig("repair").system
  };

  return invokeStage(repairStage, prompt, {
    ...options,
    maxTokens: Math.min(options.maxTokens || 8192, 8192),
    temperature: 0
  });
}

async function runJsonTask(options) {
  const {
    task,
    prompt,
    validateResult,
    buildRepairPrompt,
    maxTokens = 16384,
    temperature = 0.4,
    timeoutMs,
    fetchImpl = fetch,
    includeRaw = false,
    preferredProviders,
    preferredStageNames,
    preferredModels
  } = options || {};

  const taskReasoning = buildTaskReasoningOptions(task, options);
  const stages = prioritizeStages(buildProviderStages(task), {
    preferredProviders,
    preferredStageNames,
    preferredModels
  });
  if (stages.length === 0) {
    throw createTemporaryUnavailableError(
      createRouterError("No LLM providers configured", { retryable: true, code: "provider_unconfigured" })
    );
  }

  let lastRetryableError = null;

  for (const stage of stages) {
    const cooldownEntry = getStageCooldownEntry(stage);
    if (cooldownEntry) {
      lastRetryableError = createRouterError(`Stage ${stage.name} cooling down`, {
        retryable: true,
        provider: stage.provider,
        model: stage.model,
        code: "stage_cooling_down",
        retryAfterMs: Math.max(1, cooldownEntry.until - Date.now())
      });
      logRouter("stage_skipped_cooldown", {
        task,
        stage: stage.name,
        provider: stage.provider,
        model: stage.model,
        status: cooldownEntry.status,
        cooldownMs: cooldownEntry.cooldownMs,
        retryAt: new Date(cooldownEntry.until).toISOString()
      });
      continue;
    }

    logRouter("stage_start", {
      task,
      stage: stage.name,
      provider: stage.provider,
      model: stage.model
    });

    let response;
    try {
      response = await invokeStage(stage, prompt, {
        maxTokens,
        temperature,
        timeoutMs,
        reasoning: taskReasoning,
        fetchImpl,
        includeRaw
      });
    } catch (error) {
      if (isRetryableFailure(error)) {
        const cooldown = markStageCooldown(stage, error);
        lastRetryableError = error;
        logRouter("stage_retryable_failure", {
          task,
          stage: stage.name,
          provider: stage.provider,
          model: stage.model,
          error: error.message,
          cooldownMs: cooldown?.cooldownMs || null
        });
        continue;
      }
      throw error;
    }

    const parsed = parseAndValidateJson(response.text, validateResult);
    if (parsed.ok) {
      clearStageCooldown(stage);
      return {
        result: parsed.value,
        meta: {
          provider: stage.provider,
          model: stage.model,
          stage: stage.name,
          repaired: false
        }
      };
    }

    const repairPrompt = typeof buildRepairPrompt === "function"
      ? buildRepairPrompt({
        task,
        stage,
        originalPrompt: prompt,
        rawText: response.text,
        parsedValue: parsed.parsedValue,
        validationErrors: parsed.validationErrors
      })
      : buildDefaultRepairPrompt({
        task,
        stage,
        originalPrompt: prompt,
        rawText: response.text,
        parsedValue: parsed.parsedValue,
        validationErrors: parsed.validationErrors
      });

    logRouter("repair_start", {
      task,
      stage: stage.name,
      provider: stage.provider,
      model: stage.repairModel || stage.model,
      validationErrors: parsed.validationErrors
    });

    try {
      const repairedResponse = await invokeRepairStage(stage, repairPrompt, {
        maxTokens,
        temperature,
        timeoutMs,
        fetchImpl
      });

      const repaired = parseAndValidateJson(repairedResponse.text, validateResult);
      if (repaired.ok) {
        clearStageCooldown(stage);
        return {
          result: repaired.value,
          meta: {
            provider: stage.provider,
            model: stage.repairModel || stage.model,
            stage: stage.name,
            repaired: true
          }
        };
      }

      lastRetryableError = createRouterError(
        `Invalid JSON after repair from ${stage.provider} ${stage.repairModel || stage.model}`,
        {
          retryable: true,
          code: "invalid_json_after_repair",
          provider: stage.provider,
          model: stage.repairModel || stage.model,
          validationErrors: repaired.validationErrors
        }
      );

      logRouter("repair_invalid_after_pass", {
        task,
        stage: stage.name,
        provider: stage.provider,
        model: stage.repairModel || stage.model,
        validationErrors: repaired.validationErrors
      });
    } catch (error) {
      if (isRetryableFailure(error)) {
        const cooldown = markStageCooldown(stage, error);
        lastRetryableError = error;
        logRouter("repair_retryable_failure", {
          task,
          stage: stage.name,
          provider: stage.provider,
          model: stage.repairModel || stage.model,
          error: error.message,
          cooldownMs: cooldown?.cooldownMs || null
        });
        continue;
      }

      throw error;
    }
  }

  throw createTemporaryUnavailableError(lastRetryableError);
}

module.exports = {
  buildDefaultRepairPrompt,
  buildProviderStages,
  createTemporaryUnavailableError,
  getTemporaryUnavailablePayload,
  isTemporaryUnavailableError,
  runJsonTask
};




