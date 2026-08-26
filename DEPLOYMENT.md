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
   - Unauthenticated users are sent to the mini-app backend `/api/auth/start`.
   - The backend generates state and PKCE verifier, then redirects to Dasun `/oauth/authorize`.
   - Dasun returns a one-time authorization code to the exact registered backend callback.
   - The backend exchanges the code and creates a local opaque `HttpOnly; Secure; SameSite=Lax` session cookie.
   - The browser never stores a central JWT, service token, verifier, or authorization code.

### Environment Configuration (Mini-App Side)
Set these environment variables on the mini-app hosting environment (e.g. Vercel project settings):
- `SESSION_INTROSPECT_URL`: Central introspection endpoint (e.g. `https://dasun.app/api/internal/session/introspect`).
- `DASUN_LOGIN_URL`: Central login portal URL (e.g. `https://dasun.app/login`).
- `DASUN_AUTHORIZE_URL`: Central OAuth authorize endpoint (e.g. `https://dasun.app/oauth/authorize`).
- `OAUTH_TOKEN_URL`: Central OAuth token endpoint (e.g. `https://dasun.app/oauth/token`).
- `OAUTH_SERVICE_TOKEN`: Backend-only secret returned once by Dasun admin for this OAuth client.
- `OAUTH_REDIRECT_URI`: Exact callback URI registered by Dasun admin, including path and port.
- `CORS_ORIGINS`: Allowed origins list (e.g. `https://exam.dasun.app,https://exam.com`).

### Admin Approval & Registration Checklist
Before a new mini-app can go live with `dasun.app`, complete these steps with the `dasun.app` administrator:
1. Register the mini-app in the portal registry if it should appear in Dasun.
2. Create an OAuth client through the admin API. The client is always created as `draft`.
3. Register one exact HTTPS callback URI, for example `https://exam.com/api/auth/callback`.
4. Copy the generated service token once into the mini-app secret store if introspection is needed. Never put it in browser code.
5. Validate staging login, refresh, local logout, and callback replay behavior.
6. Explicitly PATCH the OAuth client status to `active`. Draft and disabled clients cannot authorize or exchange codes.
7. Configure entitlements (`free`, `pro`, `premium`, `elite`) only after the client approval is complete.

Example approval API calls (run by a Dasun administrator only):

```text
POST https://dasun.app/api/admin/oauth-clients
X-Admin-Token: <admin-token>
{
  "client_id": "japanesePractice",
  "display_name": "Japanese Practice",
  "redirect_uris": ["https://exam.com/api/auth/callback"],
  "pkce_required": true
}

PATCH https://dasun.app/api/admin/oauth-clients/japanesePractice
X-Admin-Token: <admin-token>
{ "status": "active" }
```
