const {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIM,
  callGeminiBatchEmbedding,
  callGeminiEmbedding,
  getGeminiEmbeddingKeyStages,
  getGeminiEmbeddingModels
} = require('./gemini');

const DEFAULT_EMBEDDING_BACKFILL_BATCH_SIZE = Math.max(
  1,
  Number.parseInt(process.env.EMBEDDING_BACKFILL_BATCH_SIZE || '24', 10)
);
const DEFAULT_EMBEDDING_BATCH_MAX_ITEMS = Math.max(
  1,
  Number.parseInt(process.env.EMBEDDING_BATCH_MAX_ITEMS || '6', 10)
);
const DEFAULT_EMBEDDING_BATCH_MAX_CHARS = Math.max(
  1000,
  Number.parseInt(process.env.EMBEDDING_BATCH_MAX_CHARS || '24000', 10)
);

let backfillRunning = false;

function logEmbedding(message, data = null) {
  const stamp = new Date().toISOString();
  try {
    console.log(`[${stamp}] [EMBEDDINGS] ${message}${data ? ' ' + JSON.stringify(data) : ''}`);
  } catch (error) {
    console.log(`[${stamp}] [EMBEDDINGS] ${message}`);
  }
}

function flattenText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join('\n');
  if (typeof value === 'object') return Object.values(value).map(flattenText).filter(Boolean).join('\n');
  return '';
}

function buildMondaiEmbeddingText(content) {
  const mondai = content?.content || content || {};
  const parts = [
    mondai.mondai_id,
    mondai.title_vi,
    mondai.instructions_vi,
    mondai.meta?.display_title,
    mondai.passage?.title,
    mondai.passage?.text,
    mondai.media?.script_text
  ];

  if (Array.isArray(mondai.items)) {
    mondai.items.forEach((item) => {
      parts.push(item.id, item.type, item.prompt, flattenText(item.choices), flattenText(item.tags));
    });
  }

  return parts
    .map((part) => flattenText(part).trim())
    .filter(Boolean)
    .join('\n\n');
}

function vectorToPgLiteral(values) {
  return `[${values.map((value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }).join(',')}]`;
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function getEmbeddingModels(options = {}) {
  const explicitModels = uniqueStrings([
    options.model,
    options.modelSecondary,
    ...(Array.isArray(options.models) ? options.models : [])
  ]);

  if (explicitModels.length > 0) {
    return explicitModels;
  }

  const configuredModels = getGeminiEmbeddingModels();
  if (configuredModels.length > 0) {
    return configuredModels;
  }

  return [DEFAULT_GEMINI_EMBEDDING_MODEL];
}

function isRetryableEmbeddingError(error) {
  if (!error) return false;
  if (error.retryable) return true;
  if (error.status === 401 || error.status === 403) return true;
  if (error.status === 402 || error.status === 429) return true;
  if (typeof error.status === 'number' && error.status >= 500) return true;
  return false;
}

function shouldTryNextEmbeddingModel(error) {
  const status = Number(error?.status);
  return status === 400 || status === 404;
}

async function invokeEmbeddingProvider(invoker, payload, options = {}) {
  const {
    outputDimensionality = DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIM,
    fetchImpl
  } = options;

  const keyStages = getGeminiEmbeddingKeyStages();
  if (keyStages.length === 0) {
    throw new Error('No Gemini embedding keys configured');
  }

  const models = getEmbeddingModels(options);
  let lastError = null;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];

    for (const keyStage of keyStages) {
      try {
        return await invoker({
          ...payload,
          model,
          outputDimensionality,
          apiKey: keyStage.apiKey,
          fetchImpl
        });
      } catch (error) {
        lastError = error;

        if (shouldTryNextEmbeddingModel(error) && modelIndex < models.length - 1) {
          break;
        }

        if (!isRetryableEmbeddingError(error)) {
          throw error;
        }
      }
    }
  }

  throw lastError || new Error('Gemini embedding failed');
}

async function generateEmbeddingVector(text, options = {}) {
  return invokeEmbeddingProvider(
    (payload) => callGeminiEmbedding(payload),
    { text },
    options
  );
}

async function generateEmbeddingBatch(texts, options = {}) {
  return invokeEmbeddingProvider(
    (payload) => callGeminiBatchEmbedding(payload),
    { texts },
    options
  );
}

async function updateStoredEmbedding(db, hash, values) {
  const vectorLiteral = vectorToPgLiteral(values);

  await db.query(
    'UPDATE mondai_bank SET embedding=$2::vector, updated_at=NOW() WHERE hash=$1 AND embedding IS NULL',
    [hash, vectorLiteral]
  );
}

async function storeMondaiEmbedding(db, hash, content, options = {}) {
  const text = buildMondaiEmbeddingText(content);
  if (!text) return false;

  const embedding = await generateEmbeddingVector(text, options);
  await updateStoredEmbedding(db, hash, embedding.values);
  return true;
}

function buildEmbeddingWorkItems(workItems) {
  return (Array.isArray(workItems) ? workItems : [])
    .map((item) => {
      const hash = item?.hash;
      const text = buildMondaiEmbeddingText(item?.content);
      if (!hash || !text) return null;
      return {
        hash,
        text,
        charCount: Math.max(1, text.length)
      };
    })
    .filter(Boolean);
}

function chunkEmbeddingWorkItems(workItems, options = {}) {
  const maxItems = Math.max(
    1,
    Number.parseInt(
      options.maxItemsPerRequest || options.maxItems || DEFAULT_EMBEDDING_BATCH_MAX_ITEMS,
      10
    )
  );
  const maxChars = Math.max(
    1000,
    Number.parseInt(
      options.maxCharsPerRequest || options.maxChars || DEFAULT_EMBEDDING_BATCH_MAX_CHARS,
      10
    )
  );

  const chunks = [];
  let currentChunk = [];
  let currentChars = 0;

  for (const item of workItems) {
    const wouldOverflow =
      currentChunk.length > 0 &&
      (currentChunk.length >= maxItems || currentChars + item.charCount > maxChars);

    if (wouldOverflow) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }

    currentChunk.push(item);
    currentChars += item.charCount;

    if (item.charCount >= maxChars) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function storeEmbeddingChunk(db, items, options = {}) {
  if (items.length === 0) return 0;

  if (items.length === 1) {
    const embedding = await generateEmbeddingVector(items[0].text, options);
    await updateStoredEmbedding(db, items[0].hash, embedding.values);
    return 1;
  }

  const batch = await generateEmbeddingBatch(items.map((item) => item.text), options);

  for (let index = 0; index < items.length; index += 1) {
    await updateStoredEmbedding(db, items[index].hash, batch.valuesList[index]);
  }

  return items.length;
}

async function storeMondaiEmbeddingsBatch(db, workItems, options = {}) {
  const preparedItems = buildEmbeddingWorkItems(workItems);
  if (preparedItems.length === 0) return 0;

  let storedCount = 0;

  for (const chunk of chunkEmbeddingWorkItems(preparedItems, options)) {
    try {
      const stored = await storeEmbeddingChunk(db, chunk, options);
      storedCount += stored;
      logEmbedding('stored_batch', { count: stored, mode: chunk.length > 1 ? 'batch' : 'single' });
    } catch (error) {
      logEmbedding('stored_batch_failed', { count: chunk.length, error: error.message });

      if (chunk.length === 1) {
        throw error;
      }

      for (const item of chunk) {
        try {
          await storeEmbeddingChunk(db, [item], options);
          storedCount += 1;
          logEmbedding('stored', { hash: item.hash });
        } catch (singleError) {
          logEmbedding('store_failed', { hash: item.hash, error: singleError.message });
        }
      }
    }
  }

  return storedCount;
}

async function runEmbeddingBackfill(db, options = {}) {
  if (backfillRunning) {
    return { selected: 0, processed: 0, remaining: null, skipped: 'already_running' };
  }
  if (getGeminiEmbeddingKeyStages().length === 0) {
    return { selected: 0, processed: 0, remaining: null, skipped: 'keys_unconfigured' };
  }

  backfillRunning = true;
  try {
    if (!(await db.initDb())) {
      return { selected: 0, processed: 0, remaining: null, skipped: 'db_unavailable' };
    }

    const batchSize = Math.max(
      1,
      Number.parseInt(options.batchSize || DEFAULT_EMBEDDING_BACKFILL_BATCH_SIZE, 10)
    );
    const result = await db.query(
      'SELECT hash, content FROM mondai_bank WHERE embedding IS NULL ORDER BY created_at ASC NULLS LAST, hash ASC LIMIT $1',
      [batchSize]
    );

    const selected = result.rows?.length || 0;
    const processed = await storeMondaiEmbeddingsBatch(db, result.rows || [], options);
    const remainingRes = await db.query('SELECT COUNT(*) AS count FROM mondai_bank WHERE embedding IS NULL');
    const remaining = Number.parseInt(remainingRes.rows?.[0]?.count || '0', 10);

    return {
      selected,
      processed,
      remaining
    };
  } finally {
    backfillRunning = false;
  }
}

module.exports = {
  DEFAULT_EMBEDDING_BACKFILL_BATCH_SIZE,
  DEFAULT_EMBEDDING_BATCH_MAX_CHARS,
  DEFAULT_EMBEDDING_BATCH_MAX_ITEMS,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIM,
  buildMondaiEmbeddingText,
  generateEmbeddingBatch,
  generateEmbeddingVector,
  runEmbeddingBackfill,
  storeMondaiEmbedding,
  storeMondaiEmbeddingsBatch,
  vectorToPgLiteral
};
