const { handleKiraMessage } = require("../server/service");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const buyerId = String(req.body?.buyerId || "");
  const text = String(req.body?.text || "").trim();
  const result = await handleKiraMessage(buyerId, text);
  return res.status(result.status).json(result.body);
};
