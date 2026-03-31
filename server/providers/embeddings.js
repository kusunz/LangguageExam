const {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIM,
  callGeminiEmbedding,
  getGeminiEmbeddingKeyStages
} = require('./gemini');

let pendingEmbeddings = new Map();
let queueScheduled = false;
let backfillScheduled = false;
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

async function generateEmbeddingVector(text, options = {}) {
  const {
    model = DEFAULT_GEMINI_EMBEDDING_MODEL,
    outputDimensionality = DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIM,
    fetchImpl
  } = options;

  const keyStages = getGeminiEmbeddingKeyStages();
  if (keyStages.length === 0) {
    throw new Error('No Gemini embedding keys configured');
  }

  let lastError = null;
  for (const keyStage of keyStages) {
    try {
      return await callGeminiEmbedding({
        text,
        model,
        outputDimensionality,
        apiKey: keyStage.apiKey,
        fetchImpl
      });
    } catch (error) {
      lastError = error;
      if (!error?.retryable && !(typeof error?.status === 'number' && error.status >= 500)) {
        throw error;
      }
    }
  }

  throw lastError || new Error('Gemini embedding failed');
}

async function storeMondaiEmbedding(db, hash, content, options = {}) {
  const text = buildMondaiEmbeddingText(content);
  if (!text) return false;

  const embedding = await generateEmbeddingVector(text, options);
  const vectorLiteral = vectorToPgLiteral(embedding.values);

  await db.query(
    'UPDATE mondai_bank SET embedding=$2::vector, updated_at=NOW() WHERE hash=$1 AND embedding IS NULL',
    [hash, vectorLiteral]
  );

  return true;
}

async function flushPendingEmbeddings(db, options = {}) {
  const workItems = Array.from(pendingEmbeddings.entries());
  pendingEmbeddings = new Map();
  queueScheduled = false;

  for (const [hash, content] of workItems) {
    try {
      await storeMondaiEmbedding(db, hash, content, options);
      logEmbedding('stored', { hash });
    } catch (error) {
      logEmbedding('store_failed', { hash, error: error.message });
    }
  }
}

function scheduleMondaiEmbedding(db, hash, content, options = {}) {
  if (!hash || !content) return;
  if (getGeminiEmbeddingKeyStages().length === 0) return;

  pendingEmbeddings.set(hash, content);
  if (queueScheduled) return;
  queueScheduled = true;

  setTimeout(() => {
    flushPendingEmbeddings(db, options).catch((error) => {
      queueScheduled = false;
      logEmbedding('flush_failed', { error: error.message });
    });
  }, 0);
}

async function runEmbeddingBackfill(db, options = {}) {
  if (backfillRunning) return 0;
  if (getGeminiEmbeddingKeyStages().length === 0) return 0;

  backfillRunning = true;
  try {
    if (!(await db.initDb())) return 0;

    const batchSize = options.batchSize || 10;
    const result = await db.query(
      'SELECT hash, content FROM mondai_bank WHERE embedding IS NULL ORDER BY created_at ASC NULLS LAST, hash ASC LIMIT $1',
      [batchSize]
    );

    for (const row of result.rows || []) {
      try {
        await storeMondaiEmbedding(db, row.hash, row.content, options);
        logEmbedding('backfilled', { hash: row.hash });
      } catch (error) {
        logEmbedding('backfill_failed', { hash: row.hash, error: error.message });
      }
    }

    return result.rows?.length || 0;
  } finally {
    backfillRunning = false;
  }
}

function scheduleEmbeddingBackfill(db, options = {}) {
  if (getGeminiEmbeddingKeyStages().length === 0) return;
  if (backfillScheduled || backfillRunning) {
    backfillScheduled = true;
    return;
  }

  backfillScheduled = true;
  setTimeout(async () => {
    backfillScheduled = false;
    try {
      const processed = await runEmbeddingBackfill(db, options);
      if (processed > 0) {
        scheduleEmbeddingBackfill(db, options);
      }
    } catch (error) {
      logEmbedding('backfill_loop_failed', { error: error.message });
    }
  }, options.delayMs || 250);
}

module.exports = {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_EMBEDDING_OUTPUT_DIM,
  buildMondaiEmbeddingText,
  generateEmbeddingVector,
  scheduleEmbeddingBackfill,
  scheduleMondaiEmbedding,
  storeMondaiEmbedding,
  runEmbeddingBackfill,
  vectorToPgLiteral
};
