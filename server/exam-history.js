function extractUniqueMondaiHashes(blueprint) {
  const hashes = new Set();

  for (const group of blueprint?.groups || []) {
    for (const slot of group?.mondai_slots || []) {
      if (slot?.mondai_hash) {
        hashes.add(slot.mondai_hash);
      }
    }
  }

  return Array.from(hashes);
}

function chooseRandomHash(rows, rng = Math.random) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const randomValue = rng();
  const sample = Number.isFinite(Number(randomValue)) ? Number(randomValue) : 0;
  const clamped = Math.max(0, Math.min(0.999999, sample));
  return rows[Math.floor(clamped * rows.length)]?.mondai_hash || null;
}

async function selectMondaiFromBucket(db, options) {
  const {
    snapshotId,
    bucketKey,
    usedHashes = [],
    userId = null,
    allowRepeat = false,
    level = null,
    primaryType = null,
    rng = Math.random
  } = options || {};

  const excludedHashes = Array.from(new Set((usedHashes || []).filter(Boolean)));
  const freshRes = await db.query(
    `SELECT psi.mondai_hash
     FROM pool_snapshot_items psi
     JOIN mondai_bank mb ON mb.hash = psi.mondai_hash
     LEFT JOIN user_mondai_history h ON h.user_id = $3 AND h.mondai_hash = psi.mondai_hash
     WHERE psi.snapshot_id = $1
       AND psi.bucket_key = $2
       AND ($4::text IS NULL OR mb.level = $4 OR mb.level IS NULL)
       AND ($5::text IS NULL OR mb.primary_type = $5)
       AND NOT (psi.mondai_hash = ANY($6::text[]))
       AND ($7::boolean OR h.mondai_hash IS NULL)
     ORDER BY psi.mondai_hash ASC`,
    [snapshotId, bucketKey, userId, level, primaryType, excludedHashes, allowRepeat]
  );

  if (freshRes.rows?.length > 0) {
    const selected = chooseRandomHash(freshRes.rows, rng);
    if (selected) return selected;
  }

  if (allowRepeat || !userId) {
    throw new Error('Bucket empty or exhausted');
  }

  const fallbackRes = await db.query(
    `SELECT psi.mondai_hash
     FROM pool_snapshot_items psi
     JOIN mondai_bank mb ON mb.hash = psi.mondai_hash
     LEFT JOIN user_mondai_history h ON h.user_id = $3 AND h.mondai_hash = psi.mondai_hash
     WHERE psi.snapshot_id = $1
       AND psi.bucket_key = $2
       AND ($4::text IS NULL OR mb.level = $4 OR mb.level IS NULL)
       AND ($5::text IS NULL OR mb.primary_type = $5)
       AND NOT (psi.mondai_hash = ANY($6::text[]))
     ORDER BY COALESCE(h.serve_count, 0) ASC,
              h.last_served_at ASC NULLS FIRST,
              psi.mondai_hash ASC
     LIMIT 1`,
    [snapshotId, bucketKey, userId, level, primaryType, excludedHashes]
  );

  const fallbackHash = fallbackRes.rows?.[0]?.mondai_hash;
  if (!fallbackHash) {
    throw new Error('Bucket empty or exhausted');
  }

  return fallbackHash;
}

async function recordServedMondaiHistory(db, options) {
  const { userId, instanceKey, blueprint } = options || {};
  const mondaiHashes = extractUniqueMondaiHashes(blueprint);
  if (!userId || !instanceKey || mondaiHashes.length === 0) return 0;

  await db.query(
    `INSERT INTO user_mondai_history (
       user_id,
       mondai_hash,
       first_served_at,
       last_served_at,
       serve_count,
       last_instance_key
     )
     SELECT $1, hash, NOW(), NOW(), 1, $2
     FROM unnest($3::text[]) AS hash
     ON CONFLICT (user_id, mondai_hash)
     DO UPDATE SET
       last_served_at = CASE
         WHEN user_mondai_history.last_instance_key IS DISTINCT FROM EXCLUDED.last_instance_key THEN NOW()
         ELSE user_mondai_history.last_served_at
       END,
       serve_count = CASE
         WHEN user_mondai_history.last_instance_key IS DISTINCT FROM EXCLUDED.last_instance_key THEN user_mondai_history.serve_count + 1
         ELSE user_mondai_history.serve_count
       END,
       last_instance_key = CASE
         WHEN user_mondai_history.last_instance_key IS DISTINCT FROM EXCLUDED.last_instance_key THEN EXCLUDED.last_instance_key
         ELSE user_mondai_history.last_instance_key
       END`,
    [userId, instanceKey, mondaiHashes]
  );

  return mondaiHashes.length;
}

module.exports = {
  extractUniqueMondaiHashes,
  recordServedMondaiHistory,
  selectMondaiFromBucket
};

