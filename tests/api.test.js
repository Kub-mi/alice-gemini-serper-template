import test from "node:test";
import assert from "node:assert/strict";
import { aliceResponse, fitAliceText, isSearchIntent, safeHistory, buildMessages, aiSettings } from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-deepseek-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

test("history is converted to OpenAI-style roles with system prompt first", () => {
  const messages = buildMessages("Вопрос", [{ role: "user", text: "А" }, { role: "model", text: "Б" }], "");
  assert.equal(messages[0].role, "system");
  assert.deepEqual(messages.slice(1).map(m => m.role), ["user", "assistant", "user"]);
  assert.equal(messages.at(-1).content, "Вопрос");
});

test("default settings point to the official DeepSeek API; polza.ai gets a prefixed model", () => {
  const saved = { ...process.env };
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_MODEL;
  assert.deepEqual(aiSettings(), { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", isOfficial: true });
  process.env.DEEPSEEK_BASE_URL = "https://polza.ai/api/v1/";
  const polza = aiSettings();
  assert.equal(polza.baseUrl, "https://polza.ai/api/v1");
  assert.equal(polza.model, "deepseek/deepseek-v4.1-flash");
  assert.equal(polza.isOfficial, false);
  process.env = saved;
});

test("a question is answered through the chat completions endpoint", async () => {
  const handler = (await import("../api/index.js")).default;
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "test-key";
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.SERPER_API_KEY;
  let calledUrl, calledBody, calledAuth;
  globalThis.fetch = async (url, options) => {
    calledUrl = url;
    calledBody = JSON.parse(options.body);
    calledAuth = options.headers.Authorization;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Привет, я DeepSeek." }, finish_reason: "stop" }] }) };
  };
  let payload;
  const res = { status() { return this; }, json(value) { payload = value; return value; }, setHeader() {} };
  try {
    await handler({ method: "POST", body: { request: { command: "кто ты" }, state: { session: { history: [] } } } }, res);
  } finally {
    globalThis.fetch = savedFetch;
    process.env = saved;
  }
  assert.equal(calledUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(calledAuth, "Bearer test-key");
  assert.equal(calledBody.model, "deepseek-flash");
  assert.deepEqual(calledBody.thinking, { type: "disabled" });
  assert.equal(payload.response.text, "Привет, я DeepSeek.");
  assert.deepEqual(payload.session_state.history.map(h => h.role), ["user", "model"]);
});

test("an empty balance gives a clear spoken message", async () => {
  const handler = (await import("../api/index.js")).default;
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = async () => ({ ok: false, status: 402, json: async () => ({ error: { message: "Insufficient Balance" } }) });
  let payload;
  const res = { status() { return this; }, json(value) { payload = value; return value; }, setHeader() {} };
  const savedError = console.error;
  console.error = () => {};
  try {
    await handler({ method: "POST", body: { request: { command: "привет" } } }, res);
  } finally {
    globalThis.fetch = savedFetch;
    process.env = saved;
    console.error = savedError;
  }
  assert.match(payload.response.text, /Пополните баланс/);
});
