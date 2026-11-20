# Kira-agent

## Local development

The local Express server provides:

- `GET /api/token?userId=buyer_1|seller_1|kira_bot` to issue a Nexconn access token.
- `POST /api/kira` to answer buyer support requests with Gemini tools and send the reply through Nexconn.
- `GET /api/health` for a basic readiness check.

Copy `server/.env.example` to `server/.env` and add your Nexconn and Gemini credentials. Set `NEXCONN_API_BASE` to the HTTPS API URL for the data center selected for your app in the Nexconn Console; the server has no regional default. Never commit `.env`.
The server listens on port `3002` by default; set `PORT` to override it. The Vite dev server proxies relative `/api` requests to it.

```bash
(cd server && npm install && npm start)
(cd web && npm install && npm run dev)
```

Check token issuance with `npm run check:nexconn` from `server/`; it prints the HTTP status and a redacted error message only. Run the focused tests with `npm test` from `server/`.

## Deploy to Vercel

Import this repository as a single Vercel project with the repository root as the project root. [vercel.json](./vercel.json) installs and builds the Vite app from `web/`, serves `web/dist`, and deploys the Node.js functions in `api/`. The `/api/kira` request completes Gemini and Nexconn delivery before responding; its Gemini work has a 17-second budget, leaving time for Nexconn within the configured 30-second function limit.

Add these environment variables in **Vercel Project → Settings → Environment Variables** for each deployment environment:

| Variable | Purpose |
| --- | --- |
| `NEXCONN_APP_KEY` | Nexconn App Key used by the server API |
| `NEXCONN_APP_SECRET` | Server-only Nexconn signing secret |
| `NEXCONN_API_BASE` | HTTPS API base URL for the app's Nexconn data center |
| `GEMINI_API_KEY` | Server-only Gemini API key |
| `GEMINI_MODEL` | Primary Gemini model |
| `GEMINI_FALLBACK_MODEL` | Fallback Gemini model |
| `VITE_NEXCONN_APP_KEY` | Nexconn App Key embedded in the browser build; this is public, not a secret |

Never set the Nexconn App Secret or Gemini API key as `VITE_` variables. Redeploy after changing environment variables.
