const crypto = require("crypto");
const orderData = require("./orders.json");

const allowedUserIds = new Set(["buyer_1", "seller_1", "kira_bot"]);
const conversationHistory = new Map();
const KIRA_GEMINI_BUDGET_MS = 17_000;

function readOrders() {
  return orderData;
}

function nexconnConfig() {
  const apiBase = process.env.NEXCONN_API_BASE?.trim();
  return {
    appKey: process.env.NEXCONN_APP_KEY?.trim(),
    appSecret: process.env.NEXCONN_APP_SECRET?.trim(),
    base: apiBase ? apiBase.replace(/\/+$/, "") : "",
  };
}

function safeUrl(value, sensitiveValues = []) {
  try {
    const url = new URL(value);
    const safePath = url.pathname.replace(
      /(^|\/)(app[-_]?key|key|secret|token|nonce|signature)\/[^/]+/gi,
      "$1$2/[REDACTED]"
    );
    return sensitiveValues.reduce(
      (result, sensitiveValue) => sensitiveValue
        ? result.split(sensitiveValue).join("[REDACTED]")
        : result,
      `${url.origin}${safePath}`
    );
  } catch {
    return "[invalid URL]";
  }
}

function redactBodyValue(value, sensitiveValues) {
  if (Array.isArray(value)) return value.map((entry) => redactBodyValue(entry, sensitiveValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /secret|app.?key|token|nonce|signature|authorization/i.test(key)
          ? "[REDACTED]"
          : redactBodyValue(entry, sensitiveValues),
      ])
    );
  }
  if (typeof value === "string") {
    return sensitiveValues.reduce(
      (result, sensitiveValue) => sensitiveValue
        ? result.split(sensitiveValue).join("[REDACTED]")
        : result,
      value
    );
  }
  return value;
}

function logNexconnResponse({ base, url, status, body, sensitiveValues, elapsedMs }) {
  console.info("[Nexconn] base URL:", safeUrl(base, sensitiveValues));

  let redactedBody;
  try {
    redactedBody = JSON.stringify(redactBodyValue(JSON.parse(body), sensitiveValues));
  } catch {
    redactedBody = sensitiveValues.reduce(
      (result, sensitiveValue) => sensitiveValue
        ? result.split(sensitiveValue).join("[REDACTED]")
        : result,
      body
    ).replace(
      /("(?:[^"\\]*(?:secret|app.?key|token|nonce|signature|authorization)[^"\\]*)"\s*:\s*")[^"]*(")/gi,
      "$1[REDACTED]$2"
    );
  }
  console.info("[Nexconn] upstream response:", JSON.stringify({
    status,
    elapsedMs,
    url: safeUrl(url, sensitiveValues),
    body: redactedBody,
  }));
}

async function nexconnPost(endpoint, body) {
  const { appKey, appSecret, base } = nexconnConfig();
  if (!appKey || !appSecret || !base) {
    throw new Error("Nexconn credentials and API base URL must be configured");
  }
  let parsedBase;
  try {
    parsedBase = new URL(base);
  } catch {
    throw new Error("NEXCONN_API_BASE must be a valid HTTPS URL");
  }
  if (parsedBase.protocol !== "https:" || parsedBase.username || parsedBase.password) {
    throw new Error("NEXCONN_API_BASE must be a valid HTTPS URL");
  }

  const nonce = String(Math.floor(Math.random() * 1_000_000_000));
  const timestamp = String(Date.now());
  const signature = crypto.createHash("sha1").update(appSecret + nonce + timestamp).digest("hex");
  const url = `${base}${endpoint}`;
  const sensitiveValues = [appKey, appSecret, nonce, signature];
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response;
  let text;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "App-Key": appKey,
        "Nonce": nonce,
        "Timestamp": timestamp,
        "Signature": signature,
        "X-Request-ID": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    text = await response.text();
  } finally {
    clearTimeout(timeout);
  }
  logNexconnResponse({
    base,
    url,
    status: response.status,
    body: text,
    sensitiveValues,
    elapsedMs: Date.now() - startedAt,
  });
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Nexconn returned invalid JSON (${response.status})`);
  }
  if (!response.ok) throw new Error(`Nexconn request failed (${response.status})`);
  return data;
}

function getOrder(orderId) {
  const { orders } = readOrders();
  return orders.find((order) => order.orderId === String(orderId)) || null;
}

function checkReturnPolicy(orderId) {
  const { policy } = readOrders();
  const order = getOrder(orderId);
  if (!order) return { allowed: false, reason: "Order not found" };

  const needsSeller = order.damaged || order.total > policy.sellerApprovalRefundAbove;
  return {
    allowed: true,
    needsSeller,
    reason: needsSeller
      ? "Damaged item or refund above the automatic approval limit"
      : "Return is within policy",
  };
}

async function sendNexconnMessage(toUserId, text) {
  return nexconnPost("/v4/direct-channel/message/send", {
    fromUserId: "kira_bot",
    toUserIds: [toUserId],
    messageType: "RC:TxtMsg",
    content: JSON.stringify({ content: text }),
    pushContent: text,
    isEchoToSender: 1,
    shouldPersist: 1,
  });
}

function redactGeminiErrorMessage(message, contents, key) {
  const orderIds = new Set();
  const sensitiveValues = new Set(key ? [key] : []);
  const userTextValues = [];

  function collectOrderIds(value) {
    if (Array.isArray(value)) {
      value.forEach((entry) => collectOrderIds(entry));
    } else if (value && typeof value === "object") {
      for (const [name, entry] of Object.entries(value)) {
        if (name === "orderId" && typeof entry === "string") orderIds.add(entry);
        else collectOrderIds(entry);
      }
    }
  }

  function collectSensitiveValues(value, parentKey = "") {
    if (Array.isArray(value)) {
      value.forEach((entry) => collectSensitiveValues(entry));
    } else if (value && typeof value === "object") {
      for (const [name, entry] of Object.entries(value)) {
        if (name !== "orderId" && name !== "role" && name !== "name") {
          collectSensitiveValues(entry, name);
        }
      }
    } else if (typeof value === "string" && value) {
      sensitiveValues.add(value);
      if (parentKey === "text") userTextValues.push(value);
    } else if (typeof value === "number") {
      sensitiveValues.add(String(value));
    }
  }

  collectOrderIds(contents);
  collectSensitiveValues(contents);
  for (const text of userTextValues) {
    for (const token of text.match(/[\p{L}\p{N}_@.+-]+/gu) || []) {
      if (!orderIds.has(token)) sensitiveValues.add(token);
    }
  }

  let safeMessage = String(message || "Gemini request failed");
  const placeholders = [];
  for (const orderId of orderIds) {
    const placeholder = `\u0000ORDER_ID_${placeholders.length}\u0000`;
    placeholders.push({ orderId, placeholder });
    safeMessage = safeMessage.split(orderId).join(placeholder);
  }
  for (const value of [...sensitiveValues].sort((a, b) => b.length - a.length)) {
    if (value) safeMessage = safeMessage.split(value).join("[REDACTED]");
  }
  for (const { orderId, placeholder } of placeholders) {
    safeMessage = safeMessage.split(placeholder).join(orderId);
  }
  return safeMessage.slice(0, 1000);
}

async function requestGemini(model, key, payload, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Kira response time budget exceeded");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(20_000, remainingMs));
  let status = null;
  let apiStatus = null;
  let errorMessage = null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    status = response.status;
    const responseText = await response.text();
    if (!response.ok) {
      let errorBody;
      try {
        errorBody = responseText ? JSON.parse(responseText) : {};
      } catch {
        errorBody = {};
      }
      apiStatus = errorBody?.error?.status || null;
      errorMessage = redactGeminiErrorMessage(errorBody?.error?.message, payload.contents, key);
      const error = new Error(errorMessage);
      error.status = response.status;
      error.apiStatus = apiStatus;
      throw error;
    }
    return responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("Gemini request timed out");
      timeoutError.code = "GEMINI_TIMEOUT";
      throw timeoutError;
    }
    if (status !== null) {
      error.status = status;
      error.apiStatus = apiStatus;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    console.info("[Gemini] call:", JSON.stringify({
      model,
      status: status ?? (controller.signal.aborted ? "timeout" : "error"),
      apiStatus,
      elapsedMs: Date.now() - startedAt,
      errorMessage,
    }));
  }
}

function isRetryableGeminiError(error) {
  return error.code === "GEMINI_TIMEOUT" || error.status === 429 || error.status === 503;
}

async function callGeminiModel(messages, model, key, tools, systemInstruction, deadline) {
  let contents = [...messages];
  for (let step = 0; step < 5; step += 1) {
    const payload = { systemInstruction, contents, tools };
    let data;
    try {
      data = await requestGemini(model, key, payload, deadline);
    } catch (error) {
      if (!isRetryableGeminiError(error)) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 2_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      data = await requestGemini(model, key, payload, deadline);
    }

    const modelContent = data?.candidates?.[0]?.content;
    const parts = modelContent?.parts || [];
    const callPart = parts.find((part) => part.functionCall);
    if (!callPart) {
      const text = parts.map((part) => part.text || "").join("").trim();
      if (!text) throw new Error("Gemini returned no final text");
      return text;
    }

    const { name, args = {} } = callPart.functionCall;
    let result;
    if (name === "get_order") result = getOrder(args.orderId);
    else if (name === "check_return_policy") result = checkReturnPolicy(args.orderId);
    else if (name === "escalate") result = { escalationRecorded: true, ...args };
    else result = { error: "Unknown tool" };

    contents = [
      ...contents,
      modelContent,
      { role: "user", parts: [{ functionResponse: { name, response: result } }] },
    ];
  }
  throw new Error("Gemini exceeded the tool-calling limit");
}

async function callGemini(messages, deadline) {
  const key = process.env.GEMINI_API_KEY;
  const primaryModel = process.env.GEMINI_MODEL;
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL;
  if (!key || !primaryModel || !fallbackModel) {
    throw new Error("Gemini credentials and models are not configured");
  }

  const tools = [{
    functionDeclarations: [
      {
        name: "get_order",
        description: "Look up an order by orderId.",
        parameters: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        },
      },
      {
        name: "check_return_policy",
        description: "Check whether an order is eligible for return or refund.",
        parameters: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        },
      },
      {
        name: "escalate",
        description: "Escalate the conversation to a human seller.",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string" },
            summary: { type: "string" },
            suggested_reply: { type: "string" },
          },
          required: ["reason", "summary", "suggested_reply"],
        },
      },
    ],
  }];

  const systemInstruction = {
    parts: [{
      text: "You are Kira, a support helper for a small online seller. Always reply in the same language the buyer wrote in, even for Tamil, Hindi, Spanish, or other languages. Use tools to look up facts and never invent order details. Escalate to the human seller if: the item is damaged, the buyer is angry or threatens a bad review, the refund is above the limit, or the buyer asks for a human. Keep replies short and friendly.",
    }],
  };

  try {
    return await callGeminiModel(messages, primaryModel, key, tools, systemInstruction, deadline);
  } catch {
    return callGeminiModel(messages, fallbackModel, key, tools, systemInstruction, deadline);
  }
}

async function issueToken(userId) {
  if (!allowedUserIds.has(userId)) {
    return { status: 400, body: { error: "Invalid userId" } };
  }

  try {
    const data = await nexconnPost("/v4/auth/access-token/issue", { userId, name: userId });
    const token = data?.result?.accessToken;
    if (!token) {
      console.error("[Nexconn token] Upstream response did not contain an access token");
      return { status: 502, body: { error: "Could not complete token request" } };
    }
    return { status: 200, body: { token, userId } };
  } catch {
    console.error("[Nexconn token] Upstream request failed");
    return { status: 502, body: { error: "Could not complete token request" } };
  }
}

async function handleKiraMessage(buyerId, text) {
  if (buyerId !== "buyer_1") {
    return { status: 400, body: { error: "Invalid buyerId" } };
  }
  if (!text) {
    return { status: 400, body: { error: "Message text is required" } };
  }

  const history = conversationHistory.get(buyerId) || [];
  const recentHistory = [...history, { role: "user", parts: [{ text }] }].slice(-10);
  const deadline = Date.now() + KIRA_GEMINI_BUDGET_MS;
  let answer;
  try {
    answer = await callGemini(recentHistory, deadline);
  } catch (error) {
    console.error("Gemini failed:", error.message);
    answer = "I'm having trouble right now. A human teammate will help you shortly.";
  }

  try {
    await sendNexconnMessage(buyerId, answer);
  } catch (error) {
    console.error("Nexconn send failed:", error.message);
    return { status: 502, body: { error: "Could not send the reply" } };
  }

  conversationHistory.set(buyerId, [
    ...recentHistory,
    { role: "model", parts: [{ text: answer }] },
  ].slice(-10));
  return { status: 200, body: { accepted: true } };
}

module.exports = { handleKiraMessage, issueToken };
