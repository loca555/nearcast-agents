/**
 * Venice AI клиент — OpenAI-совместимый API
 *
 * Отправляет промпты, парсит JSON-ответы.
 * Поддерживает разные модели через конфиг агента.
 */

const BASE_URL = "https://api.venice.ai/api/v1";

/**
 * Вызов LLM через Venice API
 * @param {string} apiKey
 * @param {object} opts — { model, system, prompt, temperature, maxTokens }
 * @returns {string} — текст ответа
 */
export async function callLLM(apiKey, { model, system, prompt, temperature = 0.7, maxTokens = 2000 }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "claude-sonnet-4-6",
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Venice API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

/**
 * Вызов LLM с парсингом JSON ответа
 * Обрабатывает markdown code blocks, trailing commas
 */
export async function callLLMJson(apiKey, opts) {
  const raw = await callLLM(apiKey, opts);

  // Убираем markdown блоки
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  // Убираем trailing commas перед } или ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  // Убираем однострочные комментарии
  cleaned = cleaned.replace(/\/\/.*$/gm, "");

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Не удалось распарсить JSON от LLM: ${err.message}\nОтвет: ${raw.slice(0, 300)}`);
  }
}
