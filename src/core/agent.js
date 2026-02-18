/**
 * Ядро агента — цикл жизни
 *
 * Загружает конфиг → создаёт кошелёк → запускает цикл:
 * wake up → scan → think → act → sleep → repeat
 */

import { createWallet } from "./wallet.js";
import { createMarketAPI } from "./market-api.js";
import { createMemory } from "./memory.js";
import { think } from "../brain/brain.js";
import { createLogger } from "../utils/logger.js";
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

    // Кошелёк NEAR
    this.wallet = await createWallet({
      name: config.name,
      avatar: config.avatar,
      network: env.NEAR_NETWORK || "testnet",
      contractId: env.NEARCAST_CONTRACT,
      dataDir,
    });

    // API клиент
    this.api = createMarketAPI(env.NEARCAST_API);

    // Сохраняем accountId в конфиг для brain
    config.accountId = this.wallet.accountId;

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
        const odds = await api.getOdds(m.id);
        if (odds) m.odds = odds.probabilities || odds;
      } catch { /* нет odds */ }
    }

    // 4. Свои ставки из памяти
    const myBets = memory.getPendingBets();
    const stats = memory.getStats();

    // 5. Проверяем резолвнутые рынки и обновляем P&L
    await this.checkResolutions(markets);

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
    });

    if (reasoning) log.think(reasoning);

    if (actions.length === 0) {
      log.info("Решил ничего не делать");
      return;
    }

    // 7. Выполняем действия
    for (const action of actions) {
      await this.executeAction(action);
    }
  }

  /** Выполнить одно действие */
  async executeAction(action) {
    const { log, wallet, api, memory, config } = this;

    try {
      switch (action.type) {
        case "bet": {
          await wallet.placeBet(action.marketId, action.outcome, action.amount);
          memory.recordBet(action.marketId, action.outcome, action.amount, null, action.reason || "");
          log.action("BET", `${action.amount} NEAR на рынке #${action.marketId}, исход ${action.outcome}`);
          break;
        }

        case "chat": {
          await api.sendChat(action.marketId, wallet.accountId, action.message);
          memory.recordChat(action.marketId, action.message, null);
          log.action("CHAT", `[#${action.marketId}] "${action.message.slice(0, 60)}..."`);
          break;
        }

        case "reply": {
          await api.sendChat(action.marketId, wallet.accountId, action.message, action.replyTo);
          memory.recordChat(action.marketId, action.message, action.replyTo);
          log.action("REPLY", `[#${action.marketId}→${action.replyTo}] "${action.message.slice(0, 60)}..."`);
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
    const { memory, api, log } = this;
    const pending = memory.getPendingBets();

    for (const bet of pending) {
      try {
        const market = await api.getMarket(bet.market_id);
        if (!market || market.status === "active") continue;

        if (market.status === "resolved") {
          const won = market.winning_outcome === bet.outcome;
          // Упрощённый расчёт P&L (реальный зависит от odds)
          const pnl = won ? bet.amount_near * 1.5 : -bet.amount_near;
          memory.resolveBet(bet.market_id, won ? "won" : "lost", pnl);
          log.action(won ? "WIN" : "LOSS",
            `Рынок #${bet.market_id}: ${won ? "+" : ""}${pnl.toFixed(2)} NEAR`);
        } else if (market.status === "voided") {
          memory.resolveBet(bet.market_id, "voided", 0);
          log.action("VOID", `Рынок #${bet.market_id} аннулирован`);
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
