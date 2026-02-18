/**
 * Оркестратор — единый цикл для всех агентов
 *
 * Один LLM-вызов за цикл вместо 5. Экономия ~5x на Venice API.
 * Рынки, чаты, odds загружаются один раз и шарятся между агентами.
 */

import { createMarketAPI } from "./market-api.js";
import { getAllResearch, hasRecentResearch, saveResearch } from "./shared-research.js";
import { thinkAll } from "../brain/brain.js";
import { callLLMJson } from "../utils/venice.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Orchestrator", "🎯");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class Orchestrator {
  constructor(agents, env) {
    this.agents = agents;
    this.api = createMarketAPI(env.NEARCAST_API);
    this.env = env;
    this.running = false;
    this.cycleCount = 0;
    this.balances = {}; // { agentName: { near, contract } } — кэш для /api/balances
  }

  async start() {
    this.running = true;
    log.info(`═══ Оркестратор запущен (${this.agents.length} агентов) ═══`);

    // Первоначальное пополнение всех кошельков
    for (const agent of this.agents) {
      try {
        await agent.wallet.ensureFunded(10);
        await agent.wallet.ensureContractBalance(5);
      } catch (err) {
        agent.log.error(`Ошибка пополнения: ${err.message}`);
      }
    }

    while (this.running) {
      try {
        await this.cycle();
      } catch (err) {
        log.error(`Ошибка цикла: ${err.message}`);
      }

      // Единый интервал: 10-20 мин
      const sleepMs = (10 + Math.random() * 10) * 60 * 1000;
      log.info(`Сплю ${(sleepMs / 60000).toFixed(1)} мин...`);
      await sleep(sleepMs);
    }
  }

  async cycle() {
    this.cycleCount++;
    log.info(`─── Цикл #${this.cycleCount} ───`);

    // 1. Загружаем рынки (ОДИН раз для всех)
    const markets = await this.api.getMarkets({ status: "active" });
    log.info(`Активных рынков: ${markets.length}`);

    if (markets.length === 0) {
      log.info("Нет активных рынков");
      // Пушим stats даже без рынков
      await this.pushAllStats();
      return;
    }

    // 2. Загружаем чаты + odds (ОДИН раз для всех)
    const chatByMarket = {};
    for (const m of markets.slice(0, 8)) {
      try {
        chatByMarket[m.id] = await this.api.getChat(m.id, 10);
      } catch { chatByMarket[m.id] = []; }

      try {
        const oddsData = await this.api.getOdds(m.id);
        if (oddsData && oddsData.odds) {
          const total = oddsData.odds.reduce((s, o) => s + (1 / o), 0);
          m.odds = oddsData.odds.map(o => (1 / o) / total);
        }
      } catch { /* нет odds */ }
    }

    // 3. Research — только агент с webSearch (Shark)
    const sharkAgent = this.agents.find(a => a.config.webSearch);
    if (sharkAgent) {
      await this.doResearch(sharkAgent, markets.slice(0, 8));
    }
    const researchData = getAllResearch();

    // 4. Проверяем резолвнутые рынки для ВСЕХ агентов
    for (const agent of this.agents) {
      await agent.checkResolutions();
    }

    // 5. Мониторинг балансов + пополнение если нужно
    await this.monitorBalances();

    // 6. Собираем контексты всех агентов
    const agentContexts = [];
    for (const agent of this.agents) {
      try {
        const balance = await agent.wallet.getContractBalance();
        const myBets = agent.memory.getPendingBets();
        const stats = agent.memory.getStats();

        agentContexts.push({
          agent,
          config: agent.config,
          accountId: agent.wallet.accountId,
          balance,
          myBets,
          stats,
        });
      } catch (err) {
        agent.log.error(`Ошибка сбора контекста: ${err.message}`);
      }
    }

    if (agentContexts.length === 0) {
      log.error("Нет агентов с контекстом");
      return;
    }

    // 7. ОДИН LLM-вызов за ВСЕХ агентов
    log.info(`💭 Один LLM-вызов за ${agentContexts.length} агентов...`);

    let allActions;
    try {
      allActions = await thinkAll(this.env.VENICE_API_KEY, {
        agents: agentContexts,
        markets,
        chatByMarket,
        researchData,
      });
    } catch (err) {
      log.error(`LLM ошибка: ${err.message}`);
      await this.pushAllStats();
      return;
    }

    // 8. Диспатч действий с рандомными задержками
    for (const actx of agentContexts) {
      const name = actx.config.name;
      const result = allActions[name];
      if (!result) continue;

      if (result.reasoning) actx.agent.log.think(result.reasoning);

      if (result.actions.length === 0) {
        actx.agent.log.info("Решил ничего не делать");
      } else {
        // Рандомная задержка 0-30 сек (имитация разных людей)
        const agentDelay = Math.random() * 30_000;
        await sleep(agentDelay);

        for (const action of result.actions) {
          await actx.agent.executeAction(action);
        }
      }
    }

    // 9. Push stats для ВСЕХ
    await this.pushAllStats();
  }

  /** Мониторинг балансов всех агентов + автопополнение */
  async monitorBalances() {
    log.info("── Проверка балансов ──");
    const MIN_NEAR = 5;       // минимум NEAR на аккаунте
    const MIN_CONTRACT = 3;   // минимум на контракте

    for (const agent of this.agents) {
      try {
        const nearBal = await agent.wallet.getNearBalance();
        const contractBal = await agent.wallet.getContractBalance();

        // Сохраняем для /api/balances
        this.balances[agent.config.name] = {
          accountId: agent.wallet.accountId,
          near: nearBal,
          contract: contractBal,
          lastCheck: new Date().toISOString(),
        };

        const status = contractBal < MIN_CONTRACT ? "⚠ LOW" : "✓";
        log.info(`  ${agent.config.avatar} ${agent.config.name}: ${nearBal.toFixed(2)} NEAR (wallet) | ${contractBal.toFixed(2)} NEAR (contract) ${status}`);

        // Автопополнение: если на контракте мало — пополняем
        if (contractBal < MIN_CONTRACT) {
          agent.log.warn(`Контракт ${contractBal.toFixed(2)} < ${MIN_CONTRACT} — пополняю...`);
          await agent.wallet.ensureContractBalance(MIN_CONTRACT + 2).catch(err => {
            agent.log.error(`Ошибка пополнения контракта: ${err.message}`);
          });
        }

        // Если на кошельке мало — пробуем faucet/funder
        if (nearBal < MIN_NEAR) {
          agent.log.warn(`Кошелёк ${nearBal.toFixed(2)} < ${MIN_NEAR} — пополняю...`);
          await agent.wallet.ensureFunded(MIN_NEAR + 5).catch(err => {
            agent.log.error(`Ошибка пополнения кошелька: ${err.message}`);
          });
        }
      } catch (err) {
        agent.log.error(`Ошибка проверки баланса: ${err.message}`);
      }
    }
  }

  /** Research фаза — делегируем агенту с webSearch */
  async doResearch(agent, markets) {
    const { env } = this;
    const researchModel = agent.config.researchModel || "llama-3.3-70b";

    for (const m of markets) {
      if (hasRecentResearch(m.id, 30)) continue;

      const question = m.question || m.description || "";
      if (!question) continue;

      agent.log.think(`🔍 Research: рынок #${m.id} — "${question.slice(0, 60)}..."`);

      try {
        const researchPrompt = agent.config.researchPrompt || "Analyze this prediction market and find real odds.";

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
          researcher: agent.config.name,
        });

        agent.log.action("RESEARCH", `Рынок #${m.id}: ${result.analysis?.slice(0, 80) || "done"}`);
        agent.dashboard.pushEvent("research", {
          marketId: m.id,
          message: result.analysis || "",
          metadata: { realOdds: result.realOdds, sources: result.sources },
        });

        await sleep(2000);
      } catch (err) {
        agent.log.warn(`Research failed для рынка #${m.id}: ${err.message}`);
      }
    }
  }

  /** Push stats на дашборд для всех агентов */
  async pushAllStats() {
    for (const agent of this.agents) {
      try {
        const stats = agent.memory.getStats();
        const balance = await agent.wallet.getContractBalance().catch(() => 0);
        agent.dashboard.pushStats({
          accountId: agent.wallet.accountId,
          totalBets: stats.total || 0,
          won: stats.won || 0,
          lost: stats.lost || 0,
          pending: stats.pending || 0,
          pnl: stats.pnl || 0,
          totalBet: stats.totalBet || 0,
          winRate: stats.winRate || 0,
          balance,
          cycleCount: this.cycleCount,
        });
      } catch (err) {
        agent.log.error(`Ошибка pushStats: ${err.message}`);
      }
    }
    log.info("Dashboard stats обновлены для всех агентов");
  }

  stop() {
    this.running = false;
    log.info("═══ Оркестратор остановлен ═══");
    this.agents.forEach(a => a.stop());
  }
}
