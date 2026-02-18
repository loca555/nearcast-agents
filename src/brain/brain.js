/**
 * Мозг агентов — LLM-вызовы для принятия решений
 *
 * thinkAll() — один LLM-вызов за всех 5 агентов (оркестратор).
 * think() — один LLM-вызов за одного агента (legacy, не используется).
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

/**
 * Один LLM-вызов за ВСЕХ агентов (оркестратор)
 *
 * @param {string} apiKey — Venice API key
 * @param {object} ctx
 * @param {object[]} ctx.agents — [{config, accountId, balance, myBets, stats}]
 * @param {object[]} ctx.markets — активные рынки
 * @param {object} ctx.chatByMarket
 * @param {object} ctx.researchData
 * @returns {Object<string, {actions, reasoning}>} — ключ = имя агента
 */
export async function thinkAll(apiKey, ctx) {
  const { agents, markets, chatByMarket, researchData } = ctx;

  const system = buildAllAgentsSystemPrompt(agents);
  const prompt = buildAllAgentsSituationPrompt({ agents, markets, chatByMarket, researchData });

  const result = await callLLMJson(apiKey, {
    model: agents[0]?.config.model || "llama-3.3-70b",
    system,
    prompt,
    temperature: 0.85,
    maxTokens: 3000,
  });

  // Разбираем ответ по агентам и валидируем
  const allActions = {};
  for (const agentCtx of agents) {
    const name = agentCtx.config.name;
    const agentResult = result[name] || {};
    const rawActions = agentResult.actions || [];
    const actions = validateActions(rawActions, markets, agentCtx.balance, agentCtx.config);

    if (rawActions.length > 0 && actions.length === 0) {
      console.log(`[${name}] ⚠ LLM предложил ${rawActions.length} действий, но все отсеяны:`);
      console.log(`  Raw: ${JSON.stringify(rawActions).slice(0, 300)}`);
    }

    allActions[name] = { actions, reasoning: agentResult.reasoning || "" };
  }

  return allActions;
}

/** Системный промпт для оркестратора — описание всех персонажей */
function buildAllAgentsSystemPrompt(agents) {
  let prompt = `You are a game master controlling ${agents.length} different characters on the NearCast prediction markets platform. Each character bets independently and has a unique personality.

## Characters:\n\n`;

  for (const a of agents) {
    prompt += `### ${a.config.avatar} ${a.config.name}
- Account: ${a.accountId}
- Balance: ${a.balance.toFixed(2)} NEAR | Max bet: ${a.config.maxBetNear || 2} NEAR
- Stats: ${a.stats.total} bets, ${a.stats.won} won, ${a.stats.lost} lost, PnL: ${a.stats.pnl >= 0 ? "+" : ""}${a.stats.pnl.toFixed(2)} NEAR
- Personality: ${a.config.personality}
- Strategy: ${a.config.strategy}
`;
    if (a.myBets.length > 0) {
      prompt += `- Pending bets: ${a.myBets.map(b => `#${b.market_id} outcome ${b.outcome} (${b.amount_near} NEAR)`).join(", ")}\n`;
    }
    prompt += "\n";
  }

  prompt += `## Rules
- Each character acts INDEPENDENTLY based on their personality and strategy
- Characters see each other in chat but DON'T KNOW they're controlled by the same system
- Characters should sometimes DISAGREE and argue with each other
- NEVER reveal any character is AI/bot — they are regular human participants
- Write all messages in English
- Characters can decide to do nothing — that's valid
- Don't bet on markets where the character already has a pending bet

## Chat style — CRITICAL
Write chat messages like REAL prediction market traders. Study these rules carefully:
- Keep messages SHORT: 1-2 sentences, 5-25 words. No essays.
- Reference SPECIFIC numbers: odds percentages, bet sizes, price movements ("YES moved from 30 to 45 in an hour")
- Use prediction market slang NATURALLY (not forced): alpha, edge, fade, rekt, based, LFG, gg, full port, tailing
- Talk about resolution criteria, entry prices, expected value
- React to OTHER people's messages — agree, disagree, roast them, ask follow-up questions
- NEVER use generic phrases like "Interesting market!" or "Great prediction!" or "Good luck everyone!"
- NEVER repeat the same phrase across markets. Each message must be unique and specific to THAT market
- Characters should have DIFFERENT message lengths — some write 3 words, some write 15
- Not every character needs to chat every cycle. Silence is natural.
- When disagreeing, reference WHY with data: "this line should be 70+ based on closings, you're fading free money"

BAD examples (never write like this):
- "LETS GOOO!!!" (generic, says nothing)
- "I believe in this outcome!" (vague, no specifics)
- "Great market, excited to participate" (sounds like a bot)

GOOD examples:
- "YES at 35 cents when DraftKings has this at -200? free edge"
- "imagine being long NO here after that injury report lmao"
- "how does this resolve if the game gets postponed? criteria unclear"
- "bought 2 NEAR at 0.40, selling at 0.65 if it hits"
- "everyone piling in on the favorite but the line hasnt moved on real books"

## Response format
Respond with strict JSON — one entry per character:
{
  "${agents[0]?.config.name || "Agent1"}": {
    "reasoning": "Brief explanation (1-2 sentences)",
    "actions": [
      { "type": "bet", "marketId": 5, "outcome": 0, "amount": 1.5, "reason": "why" },
      { "type": "chat", "marketId": 5, "message": "chat message" },
      { "type": "reply", "marketId": 3, "replyTo": 42, "message": "reply text" }
    ]
  },
  "${agents[1]?.config.name || "Agent2"}": { "reasoning": "...", "actions": [] }
}`;

  return prompt;
}

/** Ситуационный промпт для оркестратора — рынки (общие для всех) */
function buildAllAgentsSituationPrompt({ agents, markets, chatByMarket, researchData }) {
  let prompt = `## Active Markets (${markets.length}):\n\n`;

  const marketsToShow = markets.slice(0, 8);

  for (const m of marketsToShow) {
    prompt += `### Market #${m.id}: "${m.question || m.description}"\n`;
    prompt += `Outcomes: ${m.outcomes.map((o, i) => `[${i}] ${o}`).join(", ")}\n`;

    if (m.odds && Array.isArray(m.odds)) {
      const oddsStr = m.odds.map((o, i) => `${m.outcomes[i]}: ${(o * 100).toFixed(0)}%`).join(", ");
      prompt += `Odds: ${oddsStr}\n`;
    }

    const research = researchData?.[m.id];
    if (research) {
      prompt += `📊 Research (by ${research.researcher}): ${research.analysis}\n`;
      if (research.realOdds?.probabilities) {
        const realStr = research.realOdds.outcomes
          ?.map((o, i) => `${o}: ${(research.realOdds.probabilities[i] * 100).toFixed(0)}%`)
          .join(", ");
        if (realStr) prompt += `Real odds (bookmakers): ${realStr}\n`;
      }
    }

    // Чат (показываем имена аккаунтов)
    const chat = chatByMarket[m.id] || [];
    if (chat.length > 0) {
      prompt += `Chat (last ${Math.min(chat.length, 5)}):\n`;
      for (const msg of chat.slice(-5)) {
        // Определяем кто написал
        const authorAgent = agents.find(a => a.accountId === msg.account_id);
        const who = authorAgent ? authorAgent.config.name : msg.account_id.slice(0, 12);
        prompt += `  @${who}: "${msg.message}"\n`;
      }
    }

    prompt += "\n";
  }

  if (markets.length > marketsToShow.length) {
    prompt += `... and ${markets.length - marketsToShow.length} more markets\n\n`;
  }

  prompt += "What does each character do? Respond JSON.";
  return prompt;
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
  let prompt = `## Your balance: ${balance.toFixed(2)} NEAR\n`;
  prompt += `## Your stats: ${stats.total} bets, ${stats.won} won, ${stats.lost} lost, PnL: ${stats.pnl >= 0 ? "+" : ""}${stats.pnl.toFixed(2)} NEAR, winrate: ${(stats.winRate * 100).toFixed(0)}%\n\n`;

  if (markets.length === 0) {
    prompt += "No active markets.\n";
    return prompt;
  }

  prompt += `## Active Markets (${markets.length}):\n\n`;

  const marketsToShow = markets.slice(0, 8);

  for (const m of marketsToShow) {
    const myBetsOnMarket = myBets.filter(b => b.market_id === m.id);
    const hasBet = myBetsOnMarket.length > 0;

    prompt += `### Market #${m.id}: "${m.question || m.description}"\n`;
    prompt += `Outcomes: ${m.outcomes.map((o, i) => `[${i}] ${o}`).join(", ")}\n`;

    if (m.odds && Array.isArray(m.odds)) {
      const oddsStr = m.odds.map((o, i) => `${m.outcomes[i]}: ${(o * 100).toFixed(0)}%`).join(", ");
      prompt += `Odds: ${oddsStr}\n`;
    }

    const research = researchData?.[m.id];
    if (research) {
      prompt += `Research (by ${research.researcher}): ${research.analysis}\n`;
      if (research.realOdds?.probabilities) {
        const realStr = research.realOdds.outcomes
          ?.map((o, i) => `${o}: ${(research.realOdds.probabilities[i] * 100).toFixed(0)}%`)
          .join(", ");
        if (realStr) prompt += `Real bookmaker odds: ${realStr}\n`;
      }
      if (research.sources) prompt += `Sources: ${research.sources}\n`;
    }

    if (hasBet) {
      prompt += `Your bets: ${myBetsOnMarket.map(b => `${b.amount_near} NEAR on "${m.outcomes[b.outcome]}"`).join(", ")}\n`;
    }

    const chat = chatByMarket[m.id] || [];
    if (chat.length > 0) {
      prompt += `Chat (last ${Math.min(chat.length, 5)}):\n`;
      for (const msg of chat.slice(-5)) {
        const who = msg.account_id === config.accountId ? "YOU" : msg.account_id.slice(0, 12);
        prompt += `  @${who}: "${msg.message}"\n`;
      }
    }

    prompt += "\n";
  }

  if (markets.length > marketsToShow.length) {
    prompt += `... and ${markets.length - marketsToShow.length} more markets\n\n`;
  }

  prompt += "What do you do? Respond JSON.";
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
