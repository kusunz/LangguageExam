const { callOpenRouter } = require('./openrouter');
const {
  DEFAULT_GEMINI_MODEL_FALLBACK,
  DEFAULT_GEMINI_MODEL_FALLBACK_COMPAT,
  callGeminiText,
  getGeminiTextKeyStages
} = require('./gemini');

const TEMPORARY_UNAVAILABLE_PAYLOAD = {
  error: 'llm_temporarily_unavailable',
  message: 'Generation service temporarily unavailable. Please try again later.',
  retryable: true
};

function logRouter(message, data = null) {
  const stamp = new Date().toISOString();
  try {
    console.log(`[${stamp}] [LLM_ROUTER] ${message}${data ? ' ' + JSON.stringify(data) : ''}`);
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

function getTaskModels() {
  return {
    generate: {
      openrouterPrimary:
        process.env.OPENROUTER_MODEL_GENERATE_PRIMARY || 'qwen/qwen3.6-plus-preview:free',
      openrouterSecondary:
        process.env.OPENROUTER_MODEL_GENERATE_SECONDARY || 'nvidia/nemotron-3-super-120b-a12b:free'
    },
    repair: {
      openrouterPrimary:
        process.env.OPENROUTER_MODEL_REPAIR_PRIMARY || 'nvidia/nemotron-3-nano-30b-a3b:free',
      openrouterSecondary:
        process.env.OPENROUTER_MODEL_REPAIR_SECONDARY || 'arcee-ai/trinity-large-preview:free'
    },
    explain: {
      openrouterPrimary:
        process.env.OPENROUTER_MODEL_EXPLAIN_PRIMARY || 'qwen/qwen3.6-plus-preview:free',
      openrouterSecondary:
        process.env.OPENROUTER_MODEL_EXPLAIN_SECONDARY || 'nvidia/nemotron-3-super-120b-a12b:free'
    }
  };
}

function buildProviderStages(taskName) {
  const taskModels = getTaskModels();
  const taskConfig = taskModels[taskName];
  const repairConfig = taskModels.repair;
  const stages = [];

  if (!taskConfig) {
    throw createRouterError(`Unsupported LLM task: ${taskName}`, { status: 500, retryable: false });
  }

  if (process.env.OPENROUTER_API_KEY) {
    if (taskConfig.openrouterPrimary) {
      stages.push({
        name: 'openrouter-primary',
        provider: 'openrouter',
        model: taskConfig.openrouterPrimary,
        repairModel: repairConfig.openrouterPrimary
      });
    }
    if (taskConfig.openrouterSecondary) {
      stages.push({
        name: 'openrouter-secondary',
        provider: 'openrouter',
        model: taskConfig.openrouterSecondary,
        repairModel: repairConfig.openrouterSecondary
      });
    }
  }

  const geminiStages = getGeminiTextKeyStages();
  for (const keyStage of geminiStages) {
    stages.push({
      name: keyStage.name,
      provider: 'gemini',
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
        provider: 'gemini',
        model: DEFAULT_GEMINI_MODEL_FALLBACK_COMPAT,
        repairModel: DEFAULT_GEMINI_MODEL_FALLBACK_COMPAT,
        apiKey: keyStage.apiKey
      });
    }
  }

  return stages;
}

function stripMarkdownFences(text) {
  return String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
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

    if (char === '\\') {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;

    if (depth === 0) {
      return cleaned.slice(start, index + 1);
    }
  }

  return cleaned.slice(start);
}

function normalizeValidationErrors(validationResult) {
  if (!validationResult) return [];
  if (validationResult === true) return [];
  if (validationResult === false) return ['validation_failed'];
  if (typeof validationResult === 'string') return [validationResult];
  if (!Array.isArray(validationResult)) return ['validation_failed'];
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
      validationErrors: ['invalid_json'],
      error: createRouterError(`Invalid JSON response: ${error.message}`, {
        retryable: true,
        code: 'invalid_json'
      })
    };
  }

  if (typeof validateResult === 'function') {
    let validationErrors;
    try {
      validationErrors = normalizeValidationErrors(validateResult(parsedValue));
    } catch (error) {
      validationErrors = [error.message || 'validation_failed'];
    }

    if (validationErrors.length > 0) {
      return {
        ok: false,
        rawText: text,
        fragment,
        parsedValue,
        validationErrors,
        error: createRouterError(`Schema validation failed: ${validationErrors.join(', ')}`, {
          retryable: true,
          code: 'schema_invalid',
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
  if (explicitReasoning && typeof explicitReasoning === 'object') return explicitReasoning;

  if (task !== 'generate') return undefined;

  const budget = Number.parseInt(process.env.OPENROUTER_GENERATE_REASONING_MAX_TOKENS || '1024', 10);
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

  return `You are repairing a JSON response for a strict downstream parser.

ORIGINAL TASK:
${String(originalPrompt || '').slice(0, 12000)}

CURRENT OUTPUT:
${String(rawText || '').slice(0, 12000)}

VALIDATION ERRORS:
${validationErrors.length > 0 ? validationErrors.join('\n') : 'invalid_json'}

RULES:
1. Return valid JSON only.
2. Preserve the original meaning unless a field must change to satisfy JSON/schema validity.
3. Do not add commentary or markdown.
4. If a value is missing, infer the smallest valid fix.

FIX THE JSON NOW.`;
}

function isRetryableFailure(error) {
  if (!error) return false;
  if (error.retryable) return true;
  if (error.status === 402 || error.status === 429) return true;
  if (typeof error.status === 'number' && error.status >= 500) return true;
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
    fetchImpl: options.fetchImpl
  };

  if (stage.provider === 'openrouter') {
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
    model: stage.repairModel || stage.model
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
    fetchImpl = fetch
  } = options || {};

  const taskReasoning = buildTaskReasoningOptions(task, options);
  const stages = buildProviderStages(task);
  if (stages.length === 0) {
    throw createTemporaryUnavailableError(
      createRouterError('No LLM providers configured', { retryable: true, code: 'provider_unconfigured' })
    );
  }

  let lastRetryableError = null;

  for (const stage of stages) {
    logRouter('stage_start', {
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
        fetchImpl
      });
    } catch (error) {
      if (isRetryableFailure(error)) {
        lastRetryableError = error;
        logRouter('stage_retryable_failure', {
          task,
          stage: stage.name,
          provider: stage.provider,
          model: stage.model,
          error: error.message
        });
        continue;
      }
      throw error;
    }

    const parsed = parseAndValidateJson(response.text, validateResult);
    if (parsed.ok) {
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

    const repairPrompt = typeof buildRepairPrompt === 'function'
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

    logRouter('repair_start', {
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
          code: 'invalid_json_after_repair',
          provider: stage.provider,
          model: stage.repairModel || stage.model,
          validationErrors: repaired.validationErrors
        }
      );

      logRouter('repair_invalid_after_pass', {
        task,
        stage: stage.name,
        provider: stage.provider,
        model: stage.repairModel || stage.model,
        validationErrors: repaired.validationErrors
      });
    } catch (error) {
      if (isRetryableFailure(error)) {
        lastRetryableError = error;
        logRouter('repair_retryable_failure', {
          task,
          stage: stage.name,
          provider: stage.provider,
          model: stage.repairModel || stage.model,
          error: error.message
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
