const { issueToken } = require("../server/service");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const userId = String(req.query?.userId || "");
  const result = await issueToken(userId);
  return res.status(result.status).json(result.body);
};
