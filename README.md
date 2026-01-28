# Language Exam Practice App

Ứng dụng luyện thi ngoại ngữ (JLPT N2, HSK) với đề thi được tạo 100% ngẫu nhiên bằng AI.

## Features

- 🎯 **JLPT N2** support (HSK template ready for extension)
- 🤖 **AI-generated questions** - 100% original, random questions
- 🎧 **TTS audio** for listening sections (Gemini/Deepgram/Browser)
- ⏱️ **Real-time timers** - Overall + group timers
- 📊 **Detailed feedback** - Vietnamese explanations, mini-lessons
- 📕 **Mistake book** - Track and review errors
- 📱 **Mobile-first** - Touch-friendly, responsive design

## Quick Start

### 1. Clone and Setup

```bash
cd g:\japanesePractice
cd server
npm install
```

### 2. Configure Environment

Copy the example env file and fill in your API keys:

```bash
copy .env.example .env
```

Edit `.env`:

```env
PORT=3000
NODE_ENV=development

# Privy Auth (optional for demo mode)
PRIVY_APP_ID=your-privy-app-id
PRIVY_APP_SECRET=your-privy-app-secret

# LLM (at least one required)
OPENAI_API_KEY=your-openai-key
GEMINI_API_KEY=your-gemini-key

# TTS (optional)
DEEPGRAM_API_KEY=your-deepgram-key
```

### 3. Run Locally

```bash
npm start
```

Open http://localhost:3000

## Auth Mode

The app runs in **demo mode** by default:
- Click "Dùng thử không đăng nhập" to enter
- Session persists via localStorage
- User data is stored server-side per session

For production with real email authentication, you can integrate Privy or another auth provider by updating `app.js` Auth module.

## API Keys

### OpenAI (optional)
- Go to [OpenAI API](https://platform.openai.com/api-keys)
- Create an API key
- Add to `.env` as `OPENAI_API_KEY`

### Google Gemini (recommended)
- Go to [Google AI Studio](https://aistudio.google.com/apikey)
- Create an API key
- Add to `.env` as `GEMINI_API_KEY`

### Deepgram TTS (optional)
- Go to [Deepgram Console](https://console.deepgram.com)
- Create an API key
- Add to `.env` as `DEEPGRAM_API_KEY`

## Project Structure

```
japanesePractice/
├── web/
│   ├── index.html      # SPA entry point
│   ├── styles.css      # Mobile-first styles
│   ├── app.js          # Application logic
│   └── exams/
│       ├── jlpt_n2.json    # JLPT N2 exam spec
│       └── hsk_template.json # HSK template
├── server/
│   ├── server.js       # Express server
│   ├── package.json
│   ├── .env.example
│   └── data/           # User data (auto-created)
└── README.md
```

## Extending with New Exams

To add a new exam (e.g., HSK 5):

1. Create `web/exams/hsk_5.json` following the same schema as `jlpt_n2.json`
2. Add the exam tab in `index.html`
3. Enable the tab in UI (remove `disabled` attribute)

Exam spec structure:
```json
{
  "exam_id": "hsk_5",
  "display_name_vi": "HSK 5",
  "language": "zh-CN",
  "level": "HSK5",
  "modes": { ... },
  "official_time_limits_sec": { ... },
  "groups": [ ... ],
  "ui": { ... }
}
```

## Test Modes

| Mode | Time | Questions | Use Case |
|------|------|-----------|----------|
| Basic | ~35 min | ~33% | Quick practice |
| Standard | ~70 min | ~67% | Regular study |
| Official | ~155 min | 100% | Exam simulation |

## Deployment

### Option 1: Node.js Server

```bash
# Production
NODE_ENV=production npm start
```

### Option 2: Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --production
COPY server/ ./
COPY web/ ./web/
EXPOSE 3000
CMD ["node", "server.js"]
```

### Option 3: Vercel/Railway

Deploy the `server/` folder as a Node.js app, with `web/` as static files.

## Security Notes

- API keys are only stored on server, never exposed to client
- User tokens are verified server-side with Privy JWKS
- Rate limiting protects API endpoints
- Per-user data is isolated by verified userId

## License

MIT
