const test = require("node:test");
const assert = require("node:assert/strict");

const app = require("./index");
const kiraHandler = require("../api/kira");
const tokenHandler = require("../api/token");

function mockResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("Vercel API functions validate their HTTP methods", async () => {
  const tokenResponse = mockResponse();
  await tokenHandler({ method: "POST" }, tokenResponse);
  assert.equal(tokenResponse.statusCode, 405);
  assert.equal(tokenResponse.headers.Allow, "GET");

  const kiraResponse = mockResponse();
  await kiraHandler({ method: "GET" }, kiraResponse);
  assert.equal(kiraResponse.statusCode, 405);
  assert.equal(kiraResponse.headers.Allow, "POST");
});

test("Vercel Kira function returns validation errors without an upstream call", async () => {
  const response = mockResponse();
  await kiraHandler({
    method: "POST",
    body: { buyerId: "seller_1", text: "hello" },
  }, response);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: "Invalid buyerId" });
});

test("health endpoint reports the server is ready", async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

test("CORS allows preflight requests from the Vite development origin", async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/kira`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("kira rejects invalid buyer IDs", async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/api/kira`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buyerId: "other", text: "where is my order?" }),
  });
  assert.equal(response.status, 400);

  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

test("kira waits for Gemini retry, fallback, and Nexconn delivery before accepting", async () => {
  const originalFetch = global.fetch;
  const originalInfo = console.info;
  const originalError = console.error;
  const env = {
    NEXCONN_APP_KEY: process.env.NEXCONN_APP_KEY,
    NEXCONN_APP_SECRET: process.env.NEXCONN_APP_SECRET,
    NEXCONN_API_BASE: process.env.NEXCONN_API_BASE,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    GEMINI_FALLBACK_MODEL: process.env.GEMINI_FALLBACK_MODEL,
  };
  const logs = [];
  let primaryAttempts = 0;
  let sentMessage;
  let resolveSentMessage;
  const messageSent = new Promise((resolve) => {
    resolveSentMessage = resolve;
  });

  Object.assign(process.env, {
    NEXCONN_APP_KEY: "test-nexconn-key",
    NEXCONN_APP_SECRET: "test-nexconn-secret",
    NEXCONN_API_BASE: "https://api.example.test",
    GEMINI_API_KEY: "test-gemini-key",
    GEMINI_MODEL: "primary-model",
    GEMINI_FALLBACK_MODEL: "fallback-model",
  });
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    if (url.hostname === "generativelanguage.googleapis.com") {
      assert.equal(url.search, "");
      assert.equal(new Headers(init.headers).get("x-goog-api-key"), "test-gemini-key");
      if (url.pathname.includes("/primary-model:")) {
        primaryAttempts += 1;
        return new Response("{}", { status: 503 });
      }
      return new Response("{}", { status: 500 });
    }
    if (url.hostname === "api.example.test") {
      const request = JSON.parse(init.body);
      sentMessage = {
        fromUserId: request.fromUserId,
        text: JSON.parse(request.content).content,
      };
      resolveSentMessage();
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected request to ${url.hostname}`);
  };
  console.info = (...values) => logs.push(values.join(" "));
  console.error = (...values) => logs.push(values.join(" "));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/kira`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buyerId: "buyer_1", text: "Where is my order?" }),
    });
    assert.ok(Date.now() - startedAt >= 2_000);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true });

    await messageSent;
    assert.equal(primaryAttempts, 2);
    assert.deepEqual(sentMessage, {
      fromUserId: "kira_bot",
      text: "I'm having trouble right now. A human teammate will help you shortly.",
    });

    const geminiLogs = logs
      .filter((line) => line.startsWith("[Gemini]"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
    assert.deepEqual(geminiLogs.map(({ model, status }) => [model, status]), [
      ["primary-model", 503],
      ["primary-model", 503],
      ["fallback-model", 500],
    ]);
    assert.ok(geminiLogs.every((entry) => Number.isInteger(entry.elapsedMs)));
    assert.doesNotMatch(logs.join("\n"), /test-gemini-key/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    global.fetch = originalFetch;
    console.info = originalInfo;
    console.error = originalError;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Gemini follow-up preserves the original model content and sends a user function response", async () => {
  const originalFetch = global.fetch;
  const originalInfo = console.info;
  const originalError = console.error;
  const env = {
    NEXCONN_APP_KEY: process.env.NEXCONN_APP_KEY,
    NEXCONN_APP_SECRET: process.env.NEXCONN_APP_SECRET,
    NEXCONN_API_BASE: process.env.NEXCONN_API_BASE,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    GEMINI_FALLBACK_MODEL: process.env.GEMINI_FALLBACK_MODEL,
  };
  const originalModelContent = {
    role: "model",
    parts: [
      {
        functionCall: { name: "get_order", args: { orderId: "1042" } },
        thoughtSignature: "signature-from-model",
      },
      { text: "model thought", thought: true, thoughtSignature: "thought-signature" },
    ],
  };
  let geminiCallCount = 0;
  let followupContents;
  let resolveSentMessage;
  const messageSent = new Promise((resolve) => {
    resolveSentMessage = resolve;
  });

  Object.assign(process.env, {
    NEXCONN_APP_KEY: "test-nexconn-key",
    NEXCONN_APP_SECRET: "test-nexconn-secret",
    NEXCONN_API_BASE: "https://api.example.test",
    GEMINI_API_KEY: "test-gemini-key",
    GEMINI_MODEL: "primary-model",
    GEMINI_FALLBACK_MODEL: "fallback-model",
  });
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    if (url.hostname === "generativelanguage.googleapis.com") {
      geminiCallCount += 1;
      const request = JSON.parse(init.body);
      if (geminiCallCount === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: originalModelContent }],
        }), { status: 200 });
      }
      followupContents = request.contents.slice(-2);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Your order shipped." }] } }],
      }), { status: 200 });
    }
    if (url.hostname === "api.example.test") {
      resolveSentMessage();
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected request to ${url.hostname}`);
  };
  console.info = () => {};
  console.error = () => {};

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/kira`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buyerId: "buyer_1", text: "Where is order 1042?" }),
    });
    assert.deepEqual(await response.json(), { accepted: true });
    await messageSent;

    assert.equal(geminiCallCount, 2);
    assert.equal(JSON.stringify(followupContents[0]), JSON.stringify(originalModelContent));
    assert.deepEqual(followupContents, [
      originalModelContent,
      {
        role: "user",
        parts: [{
          functionResponse: {
            name: "get_order",
            response: {
              orderId: "1042",
              buyerId: "buyer_1",
              item: "Wireless headphones",
              status: "shipped",
              eta: "2026-11-20",
              total: 3499,
              damaged: false,
            },
          },
        }],
      },
    ]);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    global.fetch = originalFetch;
    console.info = originalInfo;
    console.error = originalError;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Gemini 400 logs its API status and a redacted error message", async () => {
  const originalFetch = global.fetch;
  const originalInfo = console.info;
  const originalError = console.error;
  const env = {
    NEXCONN_APP_KEY: process.env.NEXCONN_APP_KEY,
    NEXCONN_APP_SECRET: process.env.NEXCONN_APP_SECRET,
    NEXCONN_API_BASE: process.env.NEXCONN_API_BASE,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    GEMINI_FALLBACK_MODEL: process.env.GEMINI_FALLBACK_MODEL,
  };
  const logs = [];
  let resolveSentMessage;
  const messageSent = new Promise((resolve) => {
    resolveSentMessage = resolve;
  });

  Object.assign(process.env, {
    NEXCONN_APP_KEY: "test-nexconn-key",
    NEXCONN_APP_SECRET: "test-nexconn-secret",
    NEXCONN_API_BASE: "https://api.example.test",
    GEMINI_API_KEY: "test-gemini-key",
    GEMINI_MODEL: "primary-model",
    GEMINI_FALLBACK_MODEL: "fallback-model",
  });
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    if (url.hostname === "generativelanguage.googleapis.com") {
      return new Response(JSON.stringify({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "Invalid request for Alice Example, order 1042, key test-gemini-key",
        },
      }), { status: 400 });
    }
    if (url.hostname === "api.example.test") {
      resolveSentMessage();
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected request to ${url.hostname}`);
  };
  console.info = (...values) => logs.push(values.join(" "));
  console.error = () => {};

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/kira`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyerId: "buyer_1",
        text: "Alice Example asked about order 1042",
      }),
    });
    assert.deepEqual(await response.json(), { accepted: true });
    await messageSent;

    const errorLogs = logs
      .filter((line) => line.startsWith("[Gemini]"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
    assert.deepEqual(errorLogs.map(({ status, apiStatus }) => [status, apiStatus]), [
      [400, "INVALID_ARGUMENT"],
      [400, "INVALID_ARGUMENT"],
    ]);
    assert.ok(errorLogs.every(({ errorMessage }) => errorMessage.includes("[REDACTED]")));
    assert.doesNotMatch(logs.join("\n"), /Alice|Example|test-gemini-key/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    global.fetch = originalFetch;
    console.info = originalInfo;
    console.error = originalError;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("token failures log redacted upstream details and return a generic error", async () => {
  const originalFetch = global.fetch;
  const originalInfo = console.info;
  const originalError = console.error;
  const originalEnv = {
    appKey: process.env.NEXCONN_APP_KEY,
    appSecret: process.env.NEXCONN_APP_SECRET,
    apiBase: process.env.NEXCONN_API_BASE,
  };
  const logs = [];

  process.env.NEXCONN_APP_KEY = "test-app-key-123";
  process.env.NEXCONN_APP_SECRET = "test-app-secret-456";
  process.env.NEXCONN_API_BASE = "https://api.example.test";
  global.fetch = async (input, init) => {
    if (String(input).startsWith("https://api.example.test/")) {
      return new Response(JSON.stringify({
        error: "unauthorized",
        appKey: "test-app-key-123",
        appSecret: "test-app-secret-456",
        nonce: "upstream-nonce",
        signature: "upstream-signature",
        accessToken: "upstream-token",
      }), { status: 401 });
    }
    return originalFetch(input, init);
  };
  console.info = (...values) => logs.push(values.join(" "));
  console.error = () => {};

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/token?userId=buyer_1`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Could not complete token request" });

    const logText = logs.join("\n");
    assert.match(logText, /"status":401/);
    assert.match(logText, /https:\/\/api\.example\.test\/v4\/auth\/access-token\/issue/);
    assert.match(logText, /api\.example\.test/);
    assert.doesNotMatch(logText, /test-app-key-123|test-app-secret-456|upstream-nonce|upstream-signature|upstream-token/);
    assert.match(logText, /\[REDACTED\]/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    global.fetch = originalFetch;
    console.info = originalInfo;
    console.error = originalError;
    for (const [key, value] of Object.entries({
      NEXCONN_APP_KEY: originalEnv.appKey,
      NEXCONN_APP_SECRET: originalEnv.appSecret,
      NEXCONN_API_BASE: originalEnv.apiBase,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("token endpoint fails without an API base instead of using a regional default", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  const originalEnv = {
    appKey: process.env.NEXCONN_APP_KEY,
    appSecret: process.env.NEXCONN_APP_SECRET,
    apiBase: process.env.NEXCONN_API_BASE,
  };
  process.env.NEXCONN_APP_KEY = "test-key";
  process.env.NEXCONN_APP_SECRET = "test-secret";
  process.env.NEXCONN_API_BASE = "";
  global.fetch = async (input, init) => {
    if (String(input).startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    throw new Error("Unexpected upstream request");
  };
  console.error = () => {};

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/token?userId=buyer_1`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Could not complete token request" });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    global.fetch = originalFetch;
    console.error = originalError;
    for (const [key, value] of Object.entries({
      NEXCONN_APP_KEY: originalEnv.appKey,
      NEXCONN_APP_SECRET: originalEnv.appSecret,
      NEXCONN_API_BASE: originalEnv.apiBase,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
