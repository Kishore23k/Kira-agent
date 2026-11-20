require("dotenv").config();

const crypto = require("crypto");

function redact(message, sensitiveValues) {
  return sensitiveValues.reduce(
    (result, value) => (value ? result.split(value).join("[REDACTED]") : result),
    message
  ).replace(
    /((?:app[-_ ]?key|app[-_ ]?secret|nonce|signature|authorization)\s*[:=]\s*)[^\s,;]+/gi,
    "$1[REDACTED]"
  ).slice(0, 500);
}

function getErrorMessage(body, sensitiveValues) {
  let response;
  try {
    response = JSON.parse(body);
  } catch {
    return redact(body.trim() || "Nexconn returned an empty error response.", sensitiveValues);
  }

  const message = response?.message
    || response?.errorMessage
    || response?.error_description
    || response?.msg
    || response?.error?.message
    || (typeof response?.error === "string" ? response.error : null);
  if (typeof message === "string" && message.trim()) {
    return redact(message.trim(), sensitiveValues);
  }
  if (response?.code !== undefined && response.code !== 0) {
    return `Nexconn returned error code ${String(response.code).slice(0, 80)}.`;
  }
  return "Nexconn returned an error response.";
}

async function main() {
  const appKey = process.env.NEXCONN_APP_KEY?.trim();
  const appSecret = process.env.NEXCONN_APP_SECRET?.trim();
  const base = process.env.NEXCONN_API_BASE?.trim().replace(/\/+$/, "");
  if (!appKey || !appSecret || !base) {
    console.error("Error: Set NEXCONN_APP_KEY, NEXCONN_APP_SECRET, and NEXCONN_API_BASE in server/.env.");
    process.exitCode = 1;
    return;
  }

  let parsedBase;
  try {
    parsedBase = new URL(base);
  } catch {
    console.error("Error: NEXCONN_API_BASE must be a valid HTTPS URL.");
    process.exitCode = 1;
    return;
  }
  if (parsedBase.protocol !== "https:" || parsedBase.username || parsedBase.password) {
    console.error("Error: NEXCONN_API_BASE must be a valid HTTPS URL.");
    process.exitCode = 1;
    return;
  }

  const nonce = String(crypto.randomInt(0, 1_000_000_000));
  const timestamp = String(Date.now());
  const signature = crypto.createHash("sha1")
    .update(appSecret + nonce + timestamp)
    .digest("hex");
  const url = `${base}/v4/auth/access-token/issue`;
  const sensitiveValues = [appKey, appSecret, nonce, signature];

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "App-Key": appKey,
        "Nonce": nonce,
        "Timestamp": timestamp,
        "Signature": signature,
        "X-Request-ID": crypto.randomUUID(),
      },
      body: JSON.stringify({ userId: "buyer_1", name: "buyer_1" }),
    });
  } catch {
    console.error("HTTP status: unavailable\nError: Could not reach the Nexconn API.");
    process.exitCode = 1;
    return;
  }

  const body = await response.text();
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    result = null;
  }

  if (response.ok && result?.code === 0 && result?.result?.accessToken) {
    console.log(`HTTP status: ${response.status}`);
    return;
  }

  console.error(
    `HTTP status: ${response.status}\nError: ${getErrorMessage(body, sensitiveValues)}`
  );
  process.exitCode = 1;
}

main().catch(() => {
  console.error("HTTP status: unavailable\nError: Nexconn check failed.");
  process.exitCode = 1;
});
