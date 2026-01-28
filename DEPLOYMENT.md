# Deployment Guide (Vercel)

This app uses Vercel for deployment with:
- **Frontend**: Static files from Vite build (`web/dist/`)
- **Backend**: Serverless Express API (`api/index.js`)

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

### Or via GitHub:
1. Push to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project
3. Import your repository
4. Deploy (Vercel auto-detects `vercel.json`)

## 3. Environment Variables

In Vercel Dashboard → Settings → Environment Variables:

| Variable | Value | Required |
|----------|-------|----------|
| `DATABASE_URL` | Your Neon connection string | ✅ |
| `NODE_ENV` | `production` | ✅ |
| `GEMINI_API_KEY` | Your Gemini API key | ✅ |
| `PRIVY_APP_ID` | Your Privy App ID | Optional |
| `OPENAI_API_KEY` | Your OpenAI key | Optional |

## 4. How It Works

- `vercel.json` routes `/api/*` to Express serverless handler
- Frontend is built with Vite and served as static files
- All API requests go through the Express app in `api/index.js`

## 5. Local Development

```bash
# Terminal 1: Backend
cd server && npm start

# Terminal 2: Frontend (with Vite)
cd web && npm run dev
```

Access via http://localhost:5173 (Vite proxies API to :3000)
