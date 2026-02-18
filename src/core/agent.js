/**
 * Агент — кошелёк, память, выполнение действий
 *
 * Цикл жизни управляется Orchestrator'ом (src/core/orchestrator.js).
 * Агент отвечает за: init, executeAction, checkResolutions, stop.
 */

import { createWallet } from "./wallet.js";
import { createMarketAPI } from "./market-api.js";
import { createMemory } from "./memory.js";
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
