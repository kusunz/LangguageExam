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

- Vercel Hobby/Free supports up to 100 cron jobs, with each job limited to one run per day. The 30 daily entries in `vercel.json` are compatible with that limit.
- The crons call `/api/admin/daily-bank/:level/:mode` for every JLPT level and mode in two waves. Each run fills that day's snapshot buckets (5 items/bucket) and publishes 5 full exam blueprints, so `exam/start` mostly hits the cache instead of the LLM.
- Hobby cron timing has per-hour precision, so a job may start up to 59 minutes after its scheduled minute. Runs are idempotent and must not depend on exact-minute execution; a failed first-wave run can be retried by the second wave.
- NIM is the primary provider; OpenRouter is a fallback/repair path capped by `OPENROUTER_DAILY_MAX` (default 1000 calls/day).
- Tuning knobs: `DAILY_BANK_SET_COUNT`, `DAILY_BANK_TARGET_PER_BUCKET`, `DAILY_BANK_WARM_MAX_GENERATE_TOTAL`, `OPENROUTER_DAILY_MAX`.

## 8. Security

Only `.template` files are tracked and they contain placeholders. Never commit a real `.env` with live secrets.

## 9. Dasun.app Mini-App Pairing & Central Auth Guide

This guide explains how to pair and connect any child/mini-app with the central `dasun.app` portal.

### Architecture & Trust Model
- Central Portal (`dasun.app`): Manages user identity, Privy authentication, central cookies, and subscription entitlements.
- Mini-App (`japanesePractice` / child apps): Maintains its own database for app-specific state, deferring user authentication and subscription checks to central introspection.

### Pairing Setup Modes

1. Subdomain Mode (Recommended: `exam.dasun.app`):
   - Central session cookies are shared across `.dasun.app` subdomains.
   - Client sends `fetch(url, { credentials: 'include' })`.
   - Backend forwards the cookie header to `SESSION_INTROSPECT_URL`.

2. Cross-Domain Mode (Custom Domain: `exam.com`):
   - Unauthenticated users are redirected to `https://dasun.app/login?return_to=https://exam.com`.
   - `dasun.app` authenticates the user and redirects back with `?sso_token=<token>`.
   - Client stores the token in `localStorage` and passes `Authorization: Bearer <sso_token>` header to API requests.
   - Mini-app backend introspects the Bearer token with `SESSION_INTROSPECT_URL`.

### Environment Configuration (Mini-App Side)
Set these environment variables on the mini-app hosting environment (e.g. Vercel project settings):
- `SESSION_INTROSPECT_URL`: Central introspection endpoint (e.g. `https://dasun.app/api/internal/session/introspect`).
- `DASUN_LOGIN_URL`: Central login portal URL (e.g. `https://dasun.app/login`).
- `CORS_ORIGINS`: Allowed origins list (e.g. `https://exam.dasun.app,https://exam.com`).

### Admin Key Confirmation & Registration Checklist
Before a new mini-app can go live with `dasun.app`, complete these steps with the `dasun.app` administrator:
1. Register `home_url`: Provide the entrypoint URL of the mini-app.
2. Select Launch Mode: Choose `same_tab`, `new_tab`, or `embedded`.
3. Set Visibility Level: Select `public`, `login_required`, or `admin_only`.
4. Configure Entitlements: Admin configures `app_plan_keys` on `dasun.app` to grant plan tiers (`free`, `pro`, `premium`, `elite`) to users.
