# Language Exam Practice - Operations Guide

This guide covers operational tasks, configuration, and debugging for production deployments.

## 1. Pool Warming (Admin)

To pre-warm question pools and reduce latency for users during the exam start, use the `/api/admin/warm-pool` endpoint.

```bash
# Basic usage (defaults to JLPT N2, basic mode)
curl -X POST https://YOUR_DOMAIN/api/admin/warm-pool \
  -H "x-warmup-secret: YOUR_WARMUP_SECRET" \
  -H "Content-Type: application/json"

# Advanced usage (specify level, mode, targets, and concurrency limits)
curl -X POST https://YOUR_DOMAIN/api/admin/warm-pool \
  -H "x-warmup-secret: YOUR_WARMUP_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "exam_id": "jlpt_n2",
    "level": "N2",
    "mode": "basic",
    "targetPerBucket": 10,
    "maxBuckets": 5,
    "maxConcurrency": 2
  }'
```

## 2. Pool Cleanup (Admin)

To clean up old pool snapshots and generation items, preserving database space, use the `/api/admin/cleanup` endpoint.

```bash
# Cleanup data older than 14 days (default)
curl -X POST https://YOUR_DOMAIN/api/admin/cleanup \
  -H "x-warmup-secret: YOUR_WARMUP_SECRET" \
  -H "Content-Type: application/json"

# Cleanup data older than a specific number of days
curl -X POST https://YOUR_DOMAIN/api/admin/cleanup \
  -H "x-warmup-secret: YOUR_WARMUP_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "keepDays": 7
  }'
```

## 3. Secret Rotation

1. **WARMUP_SECRET**: Update the `WARMUP_SECRET` environment variable in Vercel to a new secure random string. Update any cron jobs or external services (like GitHub Actions) that call the warmup endpoint with the new secret.
2. **LLM/TTS API Keys**: Update the `GEMINI_API_KEY` (or `OPENAI_API_KEY`) or `DEEPGRAM_API_KEY` in Vercel. Vercel will trigger a new deployment or restart serverless functions to pick up the new variables.

## 4. Debugging Common Failures

### 4.1. DB Unavailable
- **Symptom**: `503 Service Unavailable {"error": "DB unavailable for V2"}`
- **Cause**: The `DATABASE_URL` is missing, misconfigured, or the Neon database is down.
- **Fix**: Verify the `DATABASE_URL` environment variable in Vercel. Check Neon dashboard for connection limits or outages.

### 4.2. FK Sessions Error
- **Symptom**: Postgres error about violating foreign key constraints on `sessions` or `user_progress`.
- **Cause**: Trying to insert records referencing a `user_id` that doesn't exist in a parent table (if you've mocked users) or database desynchronization.
- **Fix**: Ensure users are authenticated properly and exist. During tests, ensure mock users are inserted into the parent tables.

### 4.3. Invalid JSON
- **Symptom**: `400 Bad Request {"error": "Invalid JSON payload"}`
- **Cause**: A client sent a malformed JSON body or missed the `Content-Type: application/json` header.
- **Fix**: Review the client's network payload. Ensure quotes are properly escaped. Standard `body-parser` is enforcing strict JSON parsing to prevent crashes.

### 4.4. LLM Cap Reached
- **Symptom**: The application logic (such as `generateMondaiForBucket`) hits the hardcoded `MAX_GEMINI_CALLS_PER_REQUEST = 3`.
- **Cause**: A single request attempted to trigger too many simultaneous LLM generations.
- **Fix**: This is expected behavior to prevent cost runaways. The user should be instructed to proceed, and subsequent requests will fill the remaining gaps. 

### 4.5. Rate Limit Hit
- **Symptom**: `429 Too Many Requests {"error": "Too many TTS requests, please slow down"}`
- **Cause**: The user triggered the TTS endpoint more than 10 times in 1 minute, or hit the verification rate limiter.
- **Fix**: This is expected behavior. The user must wait until the rate limit window expires (1 minute for TTS).
