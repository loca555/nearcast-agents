/**
 * NearCast Agents — точка входа
 *
 * Запуск одного или нескольких агентов:
 *   node src/index.js --agent agents/maxbet.json
 *   node src/index.js --all              (все агенты из agents/)
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { Agent, loadConfig } from "./core/agent.js";
import { Orchestrator } from "./core/orchestrator.js";
import { app as dashboardApp } from "./dashboard/index.js";

dotenv.config();

// ── Восстановление ключей из AGENT_KEYS (для Render / CI) ──
if (process.env.AGENT_KEYS) {
  try {
    const keys = JSON.parse(process.env.AGENT_KEYS);
    for (const [agentName, keyData] of Object.entries(keys)) {
      const dir = path.join("data", agentName.toLowerCase().replace(/\s+/g, "-"));
      const keyFile = path.join(dir, `${agentName}.key.json`);
      if (!fs.existsSync(keyFile)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(keyFile, JSON.stringify(keyData, null, 2));
        console.log(`  ✓ Ключ восстановлен: ${agentName}`);
      }
    }
  } catch (err) {
    console.error(`  ✗ Ошибка разбора AGENT_KEYS: ${err.message}`);
  }
}

// ── Проверка окружения ──────────────────────────────────

const required = ["VENICE_API_KEY", "NEARCAST_API", "NEARCAST_CONTRACT"];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n  ✗ Не заданы переменные окружения: ${missing.join(", ")}`);
  console.error("  Скопируй .env.example → .env и заполни\n");
  process.exit(1);
}

const env = {
  VENICE_API_KEY: process.env.VENICE_API_KEY,
  NEARCAST_API: process.env.NEARCAST_API,
  NEARCAST_CONTRACT: process.env.NEARCAST_CONTRACT,
  NEAR_NETWORK: process.env.NEAR_NETWORK || "testnet",
  FUNDER_ACCOUNT_ID: process.env.FUNDER_ACCOUNT_ID || "",
  FUNDER_PRIVATE_KEY: process.env.FUNDER_PRIVATE_KEY || "",
  DASHBOARD_URL: "", // встроенный дашборд, HTTP push не нужен
  AGENT_SECRET: "",
};

// ── Парсинг аргументов ──────────────────────────────────

const args = process.argv.slice(2);
let configPaths = [];

if (args.includes("--all")) {
  // Загружаем все конфиги из agents/
  const agentsDir = path.resolve("agents");
  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith(".json"));
  configPaths = files.map(f => path.join(agentsDir, f));
} else {
  const agentIdx = args.indexOf("--agent");
  if (agentIdx !== -1 && args[agentIdx + 1]) {
    configPaths.push(path.resolve(args[agentIdx + 1]));
  }
}

if (configPaths.length === 0) {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   NearCast Agents — AI Trading Arena             ║
  ╚══════════════════════════════════════════════════╝

  Использование:
    node src/index.js --agent agents/maxbet.json   Запустить одного агента
    node src/index.js --all                        Запустить всех агентов

  Доступные агенты:
`);
  const agentsDir = path.resolve("agents");
  if (fs.existsSync(agentsDir)) {
    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const cfg = JSON.parse(fs.readFileSync(path.join(agentsDir, f), "utf8"));
      console.log(`    ${cfg.avatar} ${cfg.name.padEnd(12)} — agents/${f}`);
    }
  }
  console.log("");
  process.exit(0);
}

// ── Запуск агентов ──────────────────────────────────────

console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   NearCast Agents — Orchestrator Mode             ║
  ║   Агентов: ${String(configPaths.length).padEnd(38)}║
  ║   API: ${env.NEARCAST_API.padEnd(42)}║
  ║   Контракт: ${env.NEARCAST_CONTRACT.padEnd(37)}║
  ╚══════════════════════════════════════════════════╝
`);

const agents = [];

for (const cfgPath of configPaths) {
  try {
    const config = loadConfig(cfgPath);
    const agent = new Agent(config, env);
    await agent.init();
    agents.push(agent);
  } catch (err) {
    console.error(`  ✗ Ошибка загрузки ${cfgPath}: ${err.message}`);
  }
}

if (agents.length === 0) {
  console.error("  Ни один агент не загружен.");
  process.exit(1);
}

// ── Буфер логов (последние 200 строк) ─────────────────────
const logBuffer = [];
const MAX_LOGS = 200;
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
const capture = (level, args) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] [${level}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}`;
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
};
console.log = (...args) => { capture("LOG", args); origLog(...args); };
console.error = (...args) => { capture("ERR", args); origErr(...args); };
console.warn = (...args) => { capture("WRN", args); origWarn(...args); };

// ── Dashboard + Health сервер ─────────────────────────────
const PORT = process.env.PORT || 10000;

// Оркестратор (создаём до endpoints чтобы /api/debug имел доступ)
const orchestrator = new Orchestrator(agents, env);

// Runtime debug endpoint
dashboardApp.get("/api/debug", (_req, res) => {
  res.json({
    mode: "orchestrator",
    loaded: agents.length,
    orchestratorCycles: orchestrator.cycleCount,
    agents: agents.map(a => ({
      name: a.config.name,
      accountId: a.config.accountId,
    })),
    uptime: process.uptime(),
    env: { NEARCAST_API: env.NEARCAST_API, NEARCAST_CONTRACT: env.NEARCAST_CONTRACT },
  });
});

// Балансы всех агентов
dashboardApp.get("/api/balances", (_req, res) => {
  res.json(orchestrator.balances);
});

// Логи через браузер
dashboardApp.get("/api/logs", (req, res) => {
  const n = Math.min(parseInt(req.query.n) || 50, MAX_LOGS);
  res.type("text/plain").send(logBuffer.slice(-n).join("\n"));
});

// Принудительный сброс stale ставок (POST /api/force-reset)
dashboardApp.post("/api/force-reset", async (_req, res) => {
  try {
    let result = {};
    for (const agent of agents) {
      const before = agent.memory.getStats();
      // Принудительно удаляем все ставки из памяти агента
      agent.memory.clearAllBets();
      const after = agent.memory.getStats();
      result[agent.config.name] = { before: before.total, after: after.total };
    }
    // Пушим обнулённые stats на дашборд
    await orchestrator.pushAllStats();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Диагностика синхронизации (GET /api/sync-status)
dashboardApp.get("/api/sync-status", (_req, res) => {
  const result = {};
  for (const agent of agents) {
    const stats = agent.memory.getStats();
    result[agent.config.name] = {
      accountId: agent.wallet.accountId,
      localBets: stats.total,
      won: stats.won,
      lost: stats.lost,
      pending: stats.pending,
    };
  }
  res.json(result);
});

const server = dashboardApp.listen(PORT, () => {
  console.log(`  Dashboard: http://localhost:${PORT}/`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n  Останавливаю оркестратор...");
  orchestrator.stop();
  server.close();
  setTimeout(() => process.exit(0), 1000);
});

// Запускаем оркестратор (один цикл за всех агентов)
await orchestrator.start();
