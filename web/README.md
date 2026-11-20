# Kira web chat

The React/Vite app provides Buyer (`buyer_1`) and Seller (`seller_1`) views using Nexconn ChatUI.

Copy `.env.example` to `.env` and set `VITE_NEXCONN_APP_KEY`. The App Key is intended for browser use; never place the Nexconn App Secret or any other server secret in this app.

The Nexconn app is configured for the North America data center with `AreaCode.NA`. In local development, start the API server on port 3002 and the web app on port 5173. In production, the frontend calls same-origin `/api` Vercel Functions.

```bash
npm install
npm run dev
```

The server already permits cross-origin requests from the Vite development origin.
