const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_POLZA_MODEL = "deepseek/deepseek-v4.1-flash";
const MAX_OUTPUT_TOKENS = 200;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3900;
const SERPER_TIMEOUT_MS = 600;
const AI_TIMEOUT_MS = 3000;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

function aiSettings() {
  const baseUrl = String(process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(baseUrl)) throw new Error("INVALID_BASE_URL");
  const isOfficial = /^https:\/\/api\.deepseek\.com(\/|$)/.test(baseUrl);
  const isPolza = /^https:\/\/([a-z0-9-]+\.)*polza\.ai(\/|$)/.test(baseUrl);
  const defaultModel = isPolza ? DEFAULT_POLZA_MODEL : DEFAULT_MODEL;
  const model = String(process.env.DEEPSEEK_MODEL || defaultModel).trim();
  if (!/^[A-Za-z0-9._:\/-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");
  return { baseUrl, model, isOfficial };
}

function buildMessages(text, history, searchContext) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const item of safeHistory(history)) {
    messages.push({ role: item.role === "model" ? "assistant" : "user", content: item.text });
  }
  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  messages.push({ role: "user", content: prompt });
  return messages;
}

async function askAI(text, history, searchContext, timeoutMs) {
  const key = String(process.env.DEEPSEEK_API_KEY || "").trim();
  if (!key) throw new Error("MISSING_AI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const { baseUrl, model, isOfficial } = aiSettings();
  const body = {
    model,
    messages: buildMessages(text, history, searchContext),
    temperature: 0.5,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: false
  };
  // A voice skill has no time for "thinking" mode, so it is switched off on the official API.
  if (isOfficial) body.thinking = { type: "disabled" };

  const { response, data } = await fetchJson(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify(body)
    },
    Math.min(AI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("AI request failed with HTTP", status, String(data?.error?.message || "").slice(0, 200));
    if (status === 401 || status === 403) throw new Error("AI_KEY_REJECTED");
    if (status === 402) throw new Error("AI_NO_BALANCE");
    if (status === 429) throw new Error("AI_QUOTA");
    if (status === 400 || status === 404) throw new Error("AI_BAD_MODEL");
    throw new Error("AI_REQUEST_FAILED");
  }

  const choice = data?.choices?.[0];
  const answer = String(choice?.message?.content || "").trim();
  if (!answer) throw new Error("AI_EMPTY_RESPONSE");
  if (choice?.finish_reason === "length") console.warn("AI reached the output token limit.");
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_AI_KEY":
      return "Сервер пока не настроен. Проверьте переменную DEEPSEEK_API_KEY в настройках Vercel.";
    case "AI_KEY_REJECTED":
      return "Не удалось подключиться к нейросети. Проверьте API-ключ в настройках Vercel.";
    case "AI_NO_BALANCE":
      return "На счёте нейросети закончились деньги. Пополните баланс и попробуйте снова.";
    case "AI_QUOTA":
      return "Сейчас превышен лимит запросов к нейросети. Попробуйте немного позже.";
    case "AI_BAD_MODEL":
    case "INVALID_MODEL_NAME":
    case "INVALID_BASE_URL":
      return "Нейросеть не приняла запрос. Проверьте переменные DEEPSEEK_MODEL и DEEPSEEK_BASE_URL в Vercel.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-deepseek-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 3200)));
    }

    const answer = await askAI(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(AI_TIMEOUT_MS, remainingMs() - 300))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory, buildMessages, aiSettings };
