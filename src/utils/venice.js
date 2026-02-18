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
 * @param {object} opts — { model, system, prompt, temperature, maxTokens, webSearch }
 * @returns {string} — текст ответа
 */
export async function callLLM(apiKey, { model, system, prompt, temperature = 0.7, maxTokens = 2000, webSearch = false }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const body = {
    model: model || "llama-3.3-70b",
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  // Venice web search — модель получает доступ к интернету
  if (webSearch) {
    body.web_search = true;
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
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

  // Убираем markdown блоки (LLM часто оборачивает JSON в ```json...```)
  let cleaned = raw.trim();
  // Извлекаем контент между первым ``` и последним ```
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // Убираем trailing commas перед } или ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  // Убираем однострочные комментарии
  cleaned = cleaned.replace(/\/\/.*$/gm, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    // Фоллбек: ищем первый { ... } или [ ... ] в тексте
    const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      try {
        let fallback = jsonMatch[1].replace(/,\s*([}\]])/g, "$1").replace(/\/\/.*$/gm, "");
        return JSON.parse(fallback);
      } catch { /* ниже бросим ошибку */ }
    }
    throw new Error(`Не удалось распарсить JSON от LLM: ${raw.slice(0, 300)}`);
  }
}
