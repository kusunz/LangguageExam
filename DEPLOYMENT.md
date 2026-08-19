# Deployment Guide

Deploys to Vercel. The Express handler (`api/index.js`) serves both the API and the static `web/` frontend from the same origin.

## 1. Database (Neon Postgres)

1. Sign up at https://neon.tech.
2. Create a project and copy its connection string into `DATABASE_URL`.

## 2. Deploy to Vercel

```bash
npm i -g vercel
vercel            # first time: link the project
vercel --prod     # production deploy
```

Or push to GitHub and import at https://vercel.com.

## 3. Environment Variables

Configure in the Vercel dashboard. Use placeholders only and never commit real values (see `.env.production.template`).

### Core
| Variable | Value |
|---|---|
| DATABASE_URL | Neon Postgres connection string |
| ANSWER_HASH_SECRET | openssl rand -hex 32 |
| WARMUP_SECRET | openssl rand -hex 32 |
| DEMO_AUTH_SECRET | openssl rand -hex 32 |

### Auth (example domain)
| Variable | Example |
|---|---|
| SESSION_INTROSPECT_URL | https://app.example.com/api/internal/session/introspect |
| DASUN_LOGIN_URL | https://app.example.com/login |
| CORS_ORIGIN | https://app.example.com |

### LLM (NVIDIA NIM - grading/explain primary)
| Variable | Value |
|---|---|
| NIM_BASE_URL | https://integrate.api.nvidia.com/v1 |
| NIM_API_KEY | Your NIM API key |
| NIM_MODEL_PRIMARY | nvidia/nemotron-4-340b-reward |

### LLM (OpenRouter - free tier)
| Variable | Value |
|---|---|
| OPENROUTER_API_KEY | Free-tier OpenRouter key |
| OPENROUTER_API_BASE | https://openrouter.ai/api/v1 |
| OPENROUTER_MODEL_GENERATE_PRIMARY | openai/gpt-oss-120b:free |

### Optional
| Variable | Notes |
|---|---|
| GEMINI_API_KEY_A | Embeddings + fallback generation |
| DEEPGRAM_API_KEY | TTS (falls back to Gemini/browser) |

Tuning (optional defaults in template): `LLM_TIMEOUT_MS`, `BLUEPRINT_GENERATION_CONCURRENCY`, `DB_MODE=neon`, `PORT`.

## 4. How It Works

- `vercel.json` routes `/api/*` and all other paths to the Express handler.
- Express serves `/exams/*` from `web/public/exams` and the SPA shell from `web/index.html`.
- Same-origin deploys need no CORS. Set `CORS_ORIGIN`/`CORS_ORIGINS` only when the frontend is hosted elsewhere.
- Keep `DEMO_AUTH_SECRET` set so demo login works across restarts and scale-out.

## 5. Local Development

```bash
cd server && npm start       # http://localhost:3000
cd ../web && npm run dev     # http://localhost:5173 (proxies to API)
```

Copy `.env.local.template` to `server/.env`.

## 6. Verification

1. `GET /` renders the login screen.
2. `GET /exams/jlpt_n2.json` returns JSON.
3. Demo login: `POST /api/user-data` returns `200`.
4. Start a practice exam; the first spec loads without `404`.

## 7. Daily Warmup & LLM Budget

- Vercel crons (30/day) call `/api/admin/daily-bank/:level/:mode` for every JLPT level and mode, spread over the day in two waves. Each run fills that day's snapshot buckets (5 items/bucket) and publishes 5 full exam blueprints, so `exam/start` mostly hits the cache instead of the LLM.
- Runs are idempotent and spaced 1-2 hours apart to respect provider per-minute limits; a failed run is retried by the next scheduled slot.
- NIM is the primary provider; OpenRouter is a fallback/repair path capped by `OPENROUTER_DAILY_MAX` (default 1000 calls/day).
- Tuning knobs: `DAILY_BANK_SET_COUNT`, `DAILY_BANK_TARGET_PER_BUCKET`, `DAILY_BANK_WARM_MAX_GENERATE_TOTAL`, `OPENROUTER_DAILY_MAX`.

## 8. Security

Only `.template` files are tracked and they contain placeholders. Never commit a real `.env` with live secrets.