require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { handleKiraMessage, issueToken } = require("./service");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/token", async (req, res) => {
  const result = await issueToken(String(req.query.userId || ""));
  return res.status(result.status).json(result.body);
});

app.post("/api/kira", async (req, res) => {
  const buyerId = String(req.body?.buyerId || "");
  const text = String(req.body?.text || "").trim();
  const result = await handleKiraMessage(buyerId, text);
  return res.status(result.status).json(result.body);
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 3002);
if (require.main === module) {
  app.listen(port, () => console.log(`Kira server listening on http://localhost:${port}`));
}

module.exports = app;
