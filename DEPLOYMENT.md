# Deployment Guide (Vercel)

This app uses Vercel for deployment with:
- **Frontend**: Served by the Express app from the `web/` folder
- **Backend**: Serverless Express API from `api/index.js`

## 1. Database Setup (Neon)

1.  Go to [Neon.tech](https://neon.tech) and sign up.
2.  Create a new project.
3.  Copy the **Connection String** (Postgres URL).

## 2. Deploy to Vercel

### Quick Deploy:
```bash
# Install Vercel CLI
npm i -g vercel

# Deploy from project root
cd g:\japanesePractice
vercel
```

For production after the first link:

```bash
vercel --prod
```

### Or via GitHub:
1. Push to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project
3. Import your repository
4. Keep the project root as the repository root
5. Deploy with `vercel.json`

## 3. Environment Variables

In Vercel Dashboard → Settings → Environment Variables:

| Variable | Value | Required |
|----------|-------|----------|
| `DATABASE_URL` | Your Neon connection string | ✅ |
| `DB_MODE` | `neon` | ✅ |
| `NODE_ENV` | `production` | ✅ |
| `ANSWER_HASH_SECRET` | Long random secret for answer hashing | ✅ |
| `WARMUP_SECRET` | Long random secret for admin warmup cron endpoints | ✅ |
| `DEMO_AUTH_SECRET` | Long random secret for signed demo sessions when Privy is enabled | Recommended |
| `OPENROUTER_API_KEY` | Needed if OpenRouter should generate exams | Optional |
| `GEMINI_API_KEY_A` | Gemini text generation key | Optional |
| `GEMINI_API_KEY_B` | Backup Gemini text generation key | Optional |
| `GEMINI_API_KEY` | Legacy Gemini key used by some text/TTS paths | Optional |
| `GEMINI_EMBEDDING_KEY_A` | Gemini embeddings key | Optional |
| `GEMINI_EMBEDDING_KEY_B` | Backup Gemini embeddings key | Optional |
| `DEEPGRAM_API_KEY` | Deepgram TTS key | Optional |
| `PRIVY_APP_ID` | Privy app ID | Optional |
| `PRIVY_CLIENT_ID` | Privy client ID | Optional |
| `CORS_ORIGIN` | Single allowed frontend origin if frontend is hosted separately | Optional |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins if hosting cross-origin | Optional |

## 4. How It Works

- `vercel.json` routes both `/api/*` and app page requests to the same Express serverless handler
- Express serves `/exams/*` from `web/public/exams` and the SPA shell from `web/index.html`
- This keeps the frontend and backend on the same deployment without requiring a separate Vite output folder
- Same-origin deploys work without extra CORS configuration; only set `CORS_ORIGIN` or `CORS_ORIGINS` if your frontend runs on a different host
- If Privy is enabled and demo login should remain available, set `DEMO_AUTH_SECRET` so demo sessions stay valid across server restarts and scale-out instances

## 5. Local Development

```bash
# Terminal 1: Backend
cd server && npm start

# Terminal 2: Frontend (with Vite)
cd web && npm run dev
```

Access via http://localhost:5173 (Vite proxies API to :3000)

## 6. Recommended Vercel Checks

After deploy, verify:

1. Open `/` and confirm the login screen renders.
2. Open `/exams/jlpt_base.json` and confirm it returns JSON.
3. Use demo login and confirm `/api/user-data` returns `200`.
4. Start one practice session and confirm the first exam spec loads without `404`.
5. If Privy is enabled, confirm both email login and demo login still work after a fresh deploy.
