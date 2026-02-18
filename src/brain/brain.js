/**
 * Мозг агента — единый LLM-вызов для всех решений
 *
 * Агент получает полный контекст (рынки, чат, свои ставки, P&L)
 * и отвечает JSON с действиями: bet, chat, reply, skip.
 *
 * Каждый агент уникален благодаря своему personality/strategy промпту.
 */

import { callLLMJson } from "../utils/venice.js";

/**
 * Один "такт мышления" агента
 *
 * @param {object} ctx
 * @param {string} ctx.apiKey — Venice API key
 * @param {object} ctx.config — конфиг агента (personality, strategy, model, ...)
 * @param {object[]} ctx.markets — активные рынки с odds
 * @param {object} ctx.chatByMarket — { marketId: [messages] }
 * @param {object} ctx.myBets — текущие ставки агента (from memory)
 * @param {object} ctx.stats — статистика агента (P&L, winRate, ...)
 * @param {number} ctx.balance — баланс на контракте (NEAR)
 * @param {string} ctx.accountId
 * @returns {{ actions: Array<{type, marketId, outcome?, amount?, message?, replyTo?}> }}
 */
export async function think(ctx) {
  const { apiKey, config, markets, chatByMarket, myBets, stats, balance, accountId, researchData } = ctx;

  // Формируем системный промпт из конфига агента
  const system = buildSystemPrompt(config, accountId);

  // Формируем контекст ситуации (с данными исследований)
  const prompt = buildSituationPrompt({ markets, chatByMarket, myBets, stats, balance, config, researchData });

  const result = await callLLMJson(apiKey, {
    model: config.model || "llama-3.3-70b",
    system,
    prompt,
    temperature: config.temperature || 0.8,
    maxTokens: 1500,
  });

  // Валидируем и фильтруем действия
  const rawActions = result.actions || [];
  const actions = validateActions(rawActions, markets, balance, config);

  // Диагностика: если LLM предложил действия, но валидация их отсеяла
  if (rawActions.length > 0 && actions.length === 0) {
    console.log(`[${config.name}] ⚠ LLM предложил ${rawActions.length} действий, но все отсеяны:`);
    console.log(`  Raw: ${JSON.stringify(rawActions).slice(0, 300)}`);
  }

  return { actions, reasoning: result.reasoning || "" };
}

function buildSystemPrompt(config, accountId) {
  return `You are ${config.name}, an autonomous AI agent on the NearCast prediction markets platform.

## Your personality
${config.personality}

## Your strategy
${config.strategy}

## Rules
- Your account: ${accountId}
- You bet NEAR tokens on outcomes of sports and other events
- Maximum bet: ${config.maxBetNear || 2} NEAR per bet
- You can write in market chats — act like a real person
- NEVER say you are AI/bot. You are a regular participant with opinions
- Write in English
- You can decide to do nothing — that's a valid choice
- Don't bet on markets where you already have bets (unless strategy says otherwise)

## Response format
Respond with strict JSON:
{
  "reasoning": "Brief explanation of your thinking (1-2 sentences)",
  "actions": [
    { "type": "bet", "marketId": 5, "outcome": 0, "amount": 1.5, "reason": "why" },
    { "type": "chat", "marketId": 5, "message": "chat message text" },
    { "type": "reply", "marketId": 3, "replyTo": 42, "message": "reply to message" }
  ]
}

If you decide to do nothing:
{ "reasoning": "reason", "actions": [] }`;
}

function buildSituationPrompt({ markets, chatByMarket, myBets, stats, balance, config, researchData }) {
  let prompt = `## Твой баланс: ${balance.toFixed(2)} NEAR\n`;
  prompt += `## Твоя статистика: ${stats.total} ставок, ${stats.won} выиграно, ${stats.lost} проиграно, P&L: ${stats.pnl >= 0 ? "+" : ""}${stats.pnl.toFixed(2)} NEAR, винрейт: ${(stats.winRate * 100).toFixed(0)}%\n\n`;

  if (markets.length === 0) {
    prompt += "Активных рынков нет.\n";
    return prompt;
  }

  prompt += `## Активные рынки (${markets.length}):\n\n`;

  // Показываем до 8 рынков (чтобы не превысить лимит токенов)
  const marketsToShow = markets.slice(0, 8);

  for (const m of marketsToShow) {
    const myBetsOnMarket = myBets.filter(b => b.market_id === m.id);
    const hasBet = myBetsOnMarket.length > 0;

    prompt += `### Рынок #${m.id}: "${m.question || m.description}"\n`;
    prompt += `Исходы: ${m.outcomes.map((o, i) => `[${i}] ${o}`).join(", ")}\n`;

    if (m.odds && Array.isArray(m.odds)) {
      const oddsStr = m.odds.map((o, i) => `${m.outcomes[i]}: ${(o * 100).toFixed(0)}%`).join(", ");
      prompt += `Коэффициенты: ${oddsStr}\n`;
    }

    // Данные исследований (от Shark через web search)
    const research = researchData?.[m.id];
    if (research) {
      prompt += `📊 Web Research (by ${research.researcher}): ${research.analysis}\n`;
      if (research.realOdds?.probabilities) {
        const realStr = research.realOdds.outcomes
          ?.map((o, i) => `${o}: ${(research.realOdds.probabilities[i] * 100).toFixed(0)}%`)
          .join(", ");
        if (realStr) prompt += `Реальные шансы (букмекеры): ${realStr}\n`;
      }
      if (research.sources) prompt += `Источники: ${research.sources}\n`;
    }

    if (hasBet) {
      prompt += `Твои ставки: ${myBetsOnMarket.map(b => `${b.amount_near} NEAR на "${m.outcomes[b.outcome]}"`).join(", ")}\n`;
    }

    // Чат (последние 5 сообщений)
    const chat = chatByMarket[m.id] || [];
    if (chat.length > 0) {
      prompt += `Чат (последние ${Math.min(chat.length, 5)}):\n`;
      for (const msg of chat.slice(-5)) {
        const who = msg.account_id === config.accountId ? "ТЫ" : msg.account_id.slice(0, 12);
        prompt += `  @${who}: "${msg.message}"\n`;
      }
    }

    prompt += "\n";
  }

  if (markets.length > marketsToShow.length) {
    prompt += `... и ещё ${markets.length - marketsToShow.length} рынков\n\n`;
  }

  prompt += "Что делаешь? Ответь JSON.";
  return prompt;
}

function validateActions(actions, markets, balance, config) {
  if (!Array.isArray(actions)) return [];

  const maxBet = config.maxBetNear || 2;
  const validMarketIds = new Set(markets.map(m => m.id));
  let totalBet = 0;

  return actions.filter(a => {
    if (!a.type) return false;

    // LLM часто возвращает marketId как строку — приводим к числу
    if (a.marketId != null) a.marketId = Number(a.marketId);
    if (a.outcome != null) a.outcome = Number(a.outcome);
    if (a.amount != null) a.amount = Number(a.amount);

    if (a.type === "bet") {
      if (!validMarketIds.has(a.marketId)) return false;
      if (typeof a.outcome !== "number" || isNaN(a.outcome) || a.outcome < 0) return false;
      if (typeof a.amount !== "number" || isNaN(a.amount) || a.amount <= 0) return false;
      if (a.amount > maxBet) a.amount = maxBet;
      if (totalBet + a.amount > balance) return false;
      totalBet += a.amount;
      return true;
    }

    if (a.type === "chat" || a.type === "reply") {
      if (!validMarketIds.has(a.marketId)) return false;
      if (!a.message || typeof a.message !== "string") return false;
      if (a.message.length > 500) a.message = a.message.slice(0, 500);
      return true;
    }

    return false;
  });
}
