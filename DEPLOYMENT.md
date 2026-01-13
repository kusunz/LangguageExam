# Deployment Guide

This app consists of a Node.js backend (`server/`) and a vanilla JS frontend (`web/`). The server serves the frontend static files, so they are deployed together as a single service.

## 1. Database Setup (Neon)

We use **Neon** (Serverless PostgreSQL) for the database.

1.  Go to [Neon.tech](https://neon.tech) and sign up.
2.  Create a new project.
3.  On the Dashboard, copy the **Connection String** (Postgres URL).
    *   It looks like: `postgres://user:password@host/dbname?sslmode=require`
4.  Keep this URL safe; you will need it for the Environment Variables.

## 2. Deployment Options

### Option A: Railway (Recommended)

Railway handles the monorepo structure well.

1.  Push your code to GitHub.
2.  Login to [Railway.app](https://railway.app).
3.  Click "New Project" -> "Deploy from GitHub repo".
4.  Select your repository.
5.  **Configuration**:
    *   Railway usually detects `server/package.json`.
    *   If asked for **Root Directory**, leave it as `/` (Root) so it can access both `server` and `web`.
    *   **Build Command**: `cd server && npm install`
    *   **Start Command**: `cd server && npm start`
6.  **Variables**: Add the following variables:
    *   `DATABASE_URL`: (Paste your Neon connection string)
    *   `PRIVY_APP_ID`: (Your Privy App ID)
    *   `GEMINI_API_KEY`: (Your Google Gemini Key)
    *   `OPENAI_API_KEY`: (Optional)
    *   `NODE_ENV`: `production`

### Option B: Render / Heroku

1.  Connect your GitHub repo.
2.  **Settings**:
    *   **Root Directory**: `.` (Keep default).
    *   **Build Command**: `cd server && npm install`
    *   **Start Command**: `cd server && npm start`
3.  **Environment Variables**: Add the same variables as above.

## 3. Important check

Ensure your root directory contains the `Procfile` if the platform uses it.
We have added a `Procfile` in the root:
```
web: cd server && npm start
```
*Note: Some platforms separate Build and Start steps. If so, put `cd server && npm install` in Build Settings and `cd server && npm start` in Start Command.*

## 4. Troubleshooting

*   **"Table not found"**: The server attempts to create tables on startup. Check logs to see if `db.initDb()` succeeded. Ensure `DATABASE_URL` is correct.
*   **"Static files not found"**: Ensure the deployment context included the `web/` folder. If you set "Root Directory" to `server/`, the app cannot see `../web`. Always deploy from **Project Root**.
