/**
 * Ядро агента — цикл жизни
 *
 * Загружает конфиг → создаёт кошелёк → запускает цикл:
 * wake up → scan → think → act → sleep → repeat
 */

import { createWallet } from "./wallet.js";
import { createMarketAPI } from "./market-api.js";
import { createMemory } from "./memory.js";
import { saveResearch, getAllResearch, hasRecentResearch } from "./shared-research.js";
import { think } from "../brain/brain.js";
import { callLLMJson } from "../utils/venice.js";
import { createLogger } from "../utils/logger.js";
import { createDashboardPusher } from "../utils/dashboard-push.js";
import path from "path";
import fs from "fs";

export class Agent {
  constructor(config, env) {
    this.config = config;
    this.env = env;
    this.log = createLogger(config.name, config.avatar);
    this.running = false;
    this.cycleCount = 0;
  }

  async init() {
    const { config, env, log } = this;
    const dataDir = path.join("data", config.name.toLowerCase().replace(/\s+/g, "-"));

    // Память (SQLite)
    fs.mkdirSync(dataDir, { recursive: true });
    this.memory = createMemory(path.join(dataDir, "memory.db"));

    // Кошелёк NEAR (funder — для создания аккаунтов если faucet недоступен)
    const funder = env.FUNDER_ACCOUNT_ID && env.FUNDER_PRIVATE_KEY
      ? { accountId: env.FUNDER_ACCOUNT_ID, privateKey: env.FUNDER_PRIVATE_KEY }
      : null;

    this.wallet = await createWallet({
      name: config.name,
      avatar: config.avatar,
      network: env.NEAR_NETWORK || "testnet",
      contractId: env.NEARCAST_CONTRACT,
      dataDir,
      funder,
    });

    // API клиент
    this.api = createMarketAPI(env.NEARCAST_API);

    // Сохраняем accountId в конфиг для brain
    config.accountId = this.wallet.accountId;

    // Dashboard push (fire-and-forget)
    this.dashboard = createDashboardPusher(
      env.DASHBOARD_URL, config.name, config.avatar, env.AGENT_SECRET
    );

    log.info(`Инициализирован | Аккаунт: ${this.wallet.accountId}`);
    log.info(`Модель: ${config.model} | Риск: ${config.riskLevel} | Макс. ставка: ${config.maxBetNear} NEAR`);

    return this;
  }

  /** Запустить агента (бесконечный цикл) */
  async start() {
    this.running = true;
    this.log.info("═══ Агент запущен ═══");

    // Первоначальное пополнение
    await this.wallet.ensureFunded(10);
    await this.wallet.ensureContractBalance(5);

    while (this.running) {
      try {
        await this.cycle();
      } catch (err) {
        this.log.error(`Ошибка цикла: ${err.message}`);
      }

      // Сон с рандомным интервалом (имитация человека)
      const sleepMin = (this.config.cycleMinutes?.[0] || 5) * 60 * 1000;
      const sleepMax = (this.config.cycleMinutes?.[1] || 15) * 60 * 1000;
      const sleepMs = sleepMin + Math.random() * (sleepMax - sleepMin);

      this.log.info(`Сплю ${(sleepMs / 60000).toFixed(1)} мин...`);
      await new Promise(r => setTimeout(r, sleepMs));
    }
  }

  /** Один цикл: scan → think → act */
  async cycle() {
    this.cycleCount++;
    const { log, api, wallet, memory, config, env } = this;

    log.info(`─── Цикл #${this.cycleCount} ───`);

    // 1. Проверяем баланс
    const balance = await wallet.getContractBalance();
    log.info(`Баланс на контракте: ${balance.toFixed(2)} NEAR`);

    if (balance < 1) {
      log.warn("Мало средств — пополняю...");
      await wallet.ensureContractBalance(5);
    }

    // 2. Сканируем рынки
    const markets = await api.getMarkets({ status: "active" });
    log.info(`Активных рынков: ${markets.length}`);

    if (markets.length === 0) return;

    // 3. Загружаем чаты + odds для каждого рынка
    const chatByMarket = {};
    for (const m of markets.slice(0, 8)) {
      try {
        chatByMarket[m.id] = await api.getChat(m.id, 10);
      } catch { chatByMarket[m.id] = []; }

      try {
        const oddsData = await api.getOdds(m.id);
        if (oddsData && oddsData.odds) {
          // odds — массив коэффициентов, конвертируем в вероятности
          const total = oddsData.odds.reduce((s, o) => s + (1 / o), 0);
          m.odds = oddsData.odds.map(o => (1 / o) / total);
        }
      } catch { /* нет odds */ }
    }

    // 4. Свои ставки из памяти
    const myBets = memory.getPendingBets();
    const stats = memory.getStats();

    // 5. Проверяем резолвнутые рынки и обновляем P&L
    await this.checkResolutions(markets);

    // 5.5. Фаза research — Shark ищет реальные шансы через веб
    if (config.webSearch) {
      await this.doResearch(markets.slice(0, 8));
    }

    // 5.6. Загружаем исследования для всех агентов
    const researchData = getAllResearch();

    // 6. Думаем (LLM)
    log.think("Анализирую ситуацию...");

    const { actions, reasoning } = await think({
      apiKey: env.VENICE_API_KEY,
      config,
      markets,
      chatByMarket,
      myBets,
      stats,
      balance,
      accountId: wallet.accountId,
      researchData,
    });

    if (reasoning) log.think(reasoning);

    if (actions.length === 0) {
      log.info("Решил ничего не делать");
    } else {
      // 7. Выполняем действия
      for (const action of actions) {
        await this.executeAction(action);
      }
    }

    // 8. Пушим статистику на дашборд (всегда, даже если ничего не делал)
    const updatedStats = memory.getStats();
    const updatedBalance = await wallet.getContractBalance();
    this.dashboard.pushStats({
      accountId: wallet.accountId,
      totalBets: updatedStats.total || 0,
      won: updatedStats.won || 0,
      lost: updatedStats.lost || 0,
      pending: updatedStats.pending || 0,
      pnl: updatedStats.pnl || 0,
      totalBet: updatedStats.totalBet || 0,
      winRate: updatedStats.winRate || 0,
      balance: updatedBalance,
      cycleCount: this.cycleCount,
    });
  }

  /** Фаза research — веб-поиск реальных шансов (только для агентов с webSearch) */
  async doResearch(markets) {
    const { log, config, env } = this;
    const researchModel = config.researchModel || "claude-opus-4-6";

    for (const m of markets) {
      // Пропускаем если уже есть свежее исследование (< 30 мин)
      if (hasRecentResearch(m.id, 30)) continue;

      const question = m.question || m.description || "";
      if (!question) continue;

      log.think(`🔍 Research: рынок #${m.id} — "${question.slice(0, 60)}..."`);

      try {
        const researchPrompt = config.researchPrompt || "Analyze this prediction market and find real odds.";

        const result = await callLLMJson(env.VENICE_API_KEY, {
          model: researchModel,
          system: researchPrompt,
          prompt: `Market question: "${question}"\nOutcomes: ${(m.outcomes || []).join(", ")}\n\nSearch the web for real betting odds on this event and respond in JSON.`,
          temperature: 0.3,
          maxTokens: 1500,
          webSearch: true,
        });

        saveResearch(m.id, {
          marketQuestion: question,
          realOdds: result.realOdds || {},
          analysis: result.analysis || "",
          sources: result.sources || "",
          researcher: config.name,
        });

        log.action("RESEARCH", `Рынок #${m.id}: ${result.analysis?.slice(0, 80) || "done"}`);
        this.dashboard.pushEvent("research", {
          marketId: m.id,
          message: result.analysis || "",
          metadata: { realOdds: result.realOdds, sources: result.sources },
        });

        // Пауза между запросами (не спамить API)
        await new Promise(r => setTimeout(r, 2000));

      } catch (err) {
        log.warn(`Research failed для рынка #${m.id}: ${err.message}`);
      }
    }
  }

  /** Выполнить одно действие */
  async executeAction(action) {
    const { log, wallet, api, memory, dashboard } = this;

    try {
      switch (action.type) {
        case "bet": {
          await wallet.placeBet(action.marketId, action.outcome, action.amount);
          memory.recordBet(action.marketId, action.outcome, action.amount, null, action.reason || "");
          log.action("BET", `${action.amount} NEAR на рынке #${action.marketId}, исход ${action.outcome}`);
          dashboard.pushEvent("bet", {
            marketId: action.marketId, outcome: action.outcome,
            amountNear: action.amount, message: action.reason || "",
          });
          break;
        }

        case "chat": {
          await api.sendChat(action.marketId, wallet.accountId, action.message);
          memory.recordChat(action.marketId, action.message, null);
          log.action("CHAT", `[#${action.marketId}] "${action.message.slice(0, 60)}..."`);
          dashboard.pushEvent("chat", { marketId: action.marketId, message: action.message });
          break;
        }

        case "reply": {
          await api.sendChat(action.marketId, wallet.accountId, action.message, action.replyTo);
          memory.recordChat(action.marketId, action.message, action.replyTo);
          log.action("REPLY", `[#${action.marketId}→${action.replyTo}] "${action.message.slice(0, 60)}..."`);
          dashboard.pushEvent("reply", {
            marketId: action.marketId, message: action.message,
            metadata: { replyTo: action.replyTo },
          });
          break;
        }
      }

      // Пауза между действиями (имитация человека)
      const delay = 1000 + Math.random() * 3000;
      await new Promise(r => setTimeout(r, delay));

    } catch (err) {
      log.error(`Ошибка действия ${action.type}: ${err.message}`);
    }
  }

  /** Проверить резолвнутые рынки и обновить P&L */
  async checkResolutions() {
    const { memory, api, log, dashboard } = this;
    const pending = memory.getPendingBets();

    for (const bet of pending) {
      try {
        const market = await api.getMarket(bet.market_id);
        if (!market || market.status === "active") continue;

        if (market.status === "resolved") {
          const won = market.winning_outcome === bet.outcome;
          const pnl = won ? bet.amount_near * 1.5 : -bet.amount_near;
          memory.resolveBet(bet.market_id, won ? "won" : "lost", pnl);
          log.action(won ? "WIN" : "LOSS",
            `Рынок #${bet.market_id}: ${won ? "+" : ""}${pnl.toFixed(2)} NEAR`);
          dashboard.pushEvent(won ? "win" : "loss", {
            marketId: bet.market_id, pnlNear: pnl,
          });
        } else if (market.status === "voided") {
          memory.resolveBet(bet.market_id, "voided", 0);
          log.action("VOID", `Рынок #${bet.market_id} аннулирован`);
          dashboard.pushEvent("void", { marketId: bet.market_id });
        }
      } catch { /* рынок недоступен */ }
    }
  }

  /** Остановить агента */
  stop() {
    this.running = false;
    this.log.info("═══ Агент остановлен ═══");
    this.memory?.close();
  }
}

/**
 * Загрузить конфиг агента из JSON файла
 */
export function loadConfig(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}
