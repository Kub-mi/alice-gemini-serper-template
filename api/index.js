const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_POLZA_MODEL = "deepseek/deepseek-v4.1-flash";
const MAX_OUTPUT_TOKENS = 500;
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
  "Если просят длинный текст (стихотворение, рассказ, перечень), уложись примерно в 500 символов: например, прочитай первую строфу.",
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

function errorText(data) {
  const error = data?.error;
  const parts = [
    typeof error === "string" ? error : error?.message,
    error?.code,
    error?.type,
    data?.message,
    data?.detail
  ];
  return parts.filter(part => typeof part === "string" || typeof part === "number").join(" ").trim();
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

function trimToSentence(value) {
  const text = String(value || "").trim();
  const ends = [...text.matchAll(/[.!?…](?=\s|$)/g)];
  const last = ends.length ? ends[ends.length - 1].index + 1 : -1;
  if (last >= Math.min(40, text.length * 0.4)) return text.slice(0, last).trim();
  const lastSpace = text.lastIndexOf(" ");
  return (lastSpace > 0 ? text.slice(0, lastSpace) : text).replace(/[,;:\-–—\s]+$/, "") + "…";
}

async function readStream(response, deadline) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let finishReason = null;
  while (true) {
    const left = deadline - Date.now();
    if (left <= 0) {
      reader.cancel().catch(() => {});
      return { answer, finishReason, timedOut: true };
    }
    let timer;
    const chunk = await Promise.race([
      reader.read(),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), left); })
    ]);
    clearTimeout(timer);
    if (chunk.timeout) {
      reader.cancel().catch(() => {});
      return { answer, finishReason, timedOut: true };
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return { answer, finishReason, timedOut: false };
      try {
        const event = JSON.parse(payload);
        const choice = event?.choices?.[0];
        if (typeof choice?.delta?.content === "string") answer += choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      } catch {
        // Ignore keep-alive comments and partial lines.
      }
    }
  }
  return { answer, finishReason, timedOut: false };
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
    stream: true
  };
  // A voice skill has no time for "thinking" mode, so it is switched off on the official API.
  if (isOfficial) body.thinking = { type: "disabled" };

  // The answer is streamed: if time runs out, Alice gets the part that is already written.
  const deadline = Date.now() + Math.min(AI_TIMEOUT_MS, timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, deadline - Date.now()));
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const status = Number(response.status);
      const details = errorText(data);
      console.error("AI request failed with HTTP", status, details.slice(0, 300));
      // Providers report an empty balance with different HTTP codes (402, 401, 403, 429), so check the text first.
      if (status === 402 || /balance|insufficient|fund|credit|payment|баланс|недостаточно|пополн/i.test(details)) {
        throw new Error("AI_NO_BALANCE");
      }
      if (status === 401 || status === 403) throw new Error("AI_KEY_REJECTED");
      if (status === 429) throw new Error("AI_QUOTA");
      if (status === 400 || status === 404) throw new Error("AI_BAD_MODEL");
      throw new Error("AI_REQUEST_FAILED");
    }

    let result;
    const contentType = String(response.headers?.get?.("content-type") || "");
    if (contentType.includes("application/json") || !response.body?.getReader) {
      // The provider ignored stream: true and sent a regular JSON answer.
      const data = await response.json().catch(() => ({}));
      const choice = data?.choices?.[0];
      result = { answer: String(choice?.message?.content || ""), finishReason: choice?.finish_reason, timedOut: false };
    } else {
      result = await readStream(response, deadline);
    }

    let answer = result.answer.trim();
    if (!answer) throw new Error(result.timedOut ? "TIME_BUDGET_EXHAUSTED" : "AI_EMPTY_RESPONSE");
    if (result.timedOut || result.finishReason === "length") {
      console.warn("AI answer was cut:", result.timedOut ? "time limit" : "token limit");
      answer = trimToSentence(answer);
    }
    return answer;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("TIME_BUDGET_EXHAUSTED");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_AI_KEY":
      return "Сервер пока не настроен. Проверьте переменную DEEPSEEK_API_KEY в настройках Vercel.";
    case "AI_KEY_REJECTED":
      return "Нейросеть не приняла ключ. Проверьте переменные DEEPSEEK_API_KEY и DEEPSEEK_BASE_URL в Vercel.";
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
    const safeError = error?.name === "AbortError" ? new Error("TIME_BUDGET_EXHAUSTED") : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory, buildMessages, aiSettings, trimToSentence };
