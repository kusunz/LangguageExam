# Japanese Practice

Language exam practice (JLPT N2; HSK template ready). Exams are generated 100% by AI.

## Features

- JLPT N2 practice (HSK template ready to extend)
- AI-generated, fully randomized questions
- TTS audio (Gemini / Deepgram / browser fallback)
- Overall and per-group timers
- Vietnamese explanations and mini-lessons
- Mistake book for error review
- Mobile-first, responsive UI

## Quick Start

Install all dependencies from the repo root:

```bash
npm install            # server + web
```

Configure the server environment:

```bash
cd server
cp ../.env.local.template .env     # then fill in placeholders
```

Run locally:

```bash
npm start                           # server: http://localhost:3000
cd ../web && npm run dev            # web (Vite, proxies to API): http://localhost:5173
```

## Authentication

The app runs in demo mode by default. Click "Dung thu khong dang nhap" to start; sessions persist via localStorage and user data is stored server-side per session.

For production auth, the app uses Dasun OAuth Authorization Code + PKCE. The server exchanges the code with the backend-only `OAUTH_SERVICE_TOKEN` and creates a local `HttpOnly` session cookie. Set `DASUN_AUTHORIZE_URL`, `OAUTH_TOKEN_URL`, `OAUTH_CLIENT_ID`, `OAUTH_REDIRECT_URI`, `OAUTH_SERVICE_TOKEN`, and `APP_SESSION_SECRET` in `.env.production.template`. The Dasun administrator must approve the exact redirect URI before login works.

## Project Structure

```
japanesePractice/
api/                 # Vercel serverless entry (api/index.js)
server/              # Express API, providers, scripts
web/                 # Vite SPA (HTML/CSS/JS)
.env.local.template  # local dev template (copy to server/.env)
.env.production.template
vercel.json
package.json
README.md
DEPLOYMENT.md
```

## Extend an Exam

1. Add `web/exams/hsk_5.json` following `web/exams/jlpt_n2.json`.
2. Add the tab in `web/index.html`.

Exam spec:

```json
{ "exam_id": "hsk_5", "display_name_vi": "HSK 5", "language": "zh-CN", "level": "HSK5",
  "modes": { "basic": {}, "standard": {}, "official": {} }, "official_time_limits_sec": {},
  "groups": [{}], "ui": {} }
```

## Test Modes

| Mode | Time | Questions |
|------|------|-----------|
| Basic | ~35m | ~33% |
| Standard | ~70m | ~67% |
| Official | ~155m | 100% |

## Environment

Required: `DATABASE_URL` plus at least one LLM provider (NVIDIA NIM, OpenRouter, or Gemini).
Optional: `DEEPGRAM_API_KEY` for TTS.
Template values are placeholders only; never commit a real `.env`.

## Deployment

See `DEPLOYMENT.md` (Vercel).

## License

MIT
