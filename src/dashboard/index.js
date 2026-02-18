/**
 * Встроенный дашборд — Express сервер + SQLite
 *
 * Агенты пишут напрямую через pushEvent/pushStats (без HTTP).
 * Фронтенд читает через GET /api/agents, /api/events, /api/research.
 */

import express from "express";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── SQLite ────────────────────────────────────────────────────

const dataDir = path.resolve("data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "dashboard.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_stats (
    agent_name TEXT PRIMARY KEY,
    agent_avatar TEXT,
    account_id TEXT,
    total_bets INTEGER DEFAULT 0,
    won INTEGER DEFAULT 0,
    lost INTEGER DEFAULT 0,
    pending INTEGER DEFAULT 0,
    pnl_near REAL DEFAULT 0,
    total_bet_near REAL DEFAULT 0,
    win_rate REAL DEFAULT 0,
    balance_near REAL DEFAULT 0,
    cycle_count INTEGER DEFAULT 0,
    last_active TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    agent_avatar TEXT,
    event_type TEXT NOT NULL,
    market_id INTEGER,
    amount_near REAL,
    outcome INTEGER,
    message TEXT,
    pnl_near REAL,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
`);

// Чистим старые события (> 7 дней) при старте
db.prepare("DELETE FROM events WHERE datetime(created_at) < datetime('now', '-7 days')").run();

// ── Prepared statements ───────────────────────────────────────

const stmts = {
  upsertStats: db.prepare(`
    INSERT INTO agent_stats (agent_name, agent_avatar, account_id, total_bets, won, lost, pending, pnl_near, total_bet_near, win_rate, balance_near, cycle_count, last_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(agent_name) DO UPDATE SET
      agent_avatar = excluded.agent_avatar,
      account_id = excluded.account_id,
      total_bets = excluded.total_bets,
      won = excluded.won,
      lost = excluded.lost,
      pending = excluded.pending,
      pnl_near = excluded.pnl_near,
      total_bet_near = excluded.total_bet_near,
      win_rate = excluded.win_rate,
      balance_near = excluded.balance_near,
      cycle_count = excluded.cycle_count,
      last_active = datetime('now'),
      updated_at = datetime('now')
  `),

  insertEvent: db.prepare(`
    INSERT INTO events (agent_name, agent_avatar, event_type, market_id, amount_near, outcome, message, pnl_near, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  getAgents: db.prepare("SELECT * FROM agent_stats ORDER BY pnl_near DESC"),
  getEvents: db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?"),
  getResearch: db.prepare("SELECT * FROM events WHERE event_type = 'research' ORDER BY id DESC LIMIT ?"),
};

// ── Express app ───────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.resolve("public")));

// GET endpoints
app.get("/api/agents", (_req, res) => {
  try { res.json(stmts.getAgents.all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/events", (req, res) => {
  try {
    const afterId = parseInt(req.query.after) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json(stmts.getEvents.all(afterId, limit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/research", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    res.json(stmts.getResearch.all(limit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", agents: stmts.getAgents.all().length, uptime: process.uptime() });
});

// ── Прямой push (вызывается агентами без HTTP) ────────────────

/** Записать событие напрямую в БД */
function pushEvent(agentName, agentAvatar, eventType, data = {}) {
  try {
    stmts.insertEvent.run(
      agentName,
      agentAvatar || "",
      eventType,
      data.marketId || null,
      data.amountNear || null,
      data.outcome ?? null,
      data.message || null,
      data.pnlNear || null,
      typeof data.metadata === "object" ? JSON.stringify(data.metadata) : (data.metadata || null)
    );
  } catch { /* не критично */ }
}

/** Обновить статистику агента напрямую в БД */
function pushStats(agentName, agentAvatar, stats) {
  try {
    stmts.upsertStats.run(
      agentName,
      agentAvatar || "",
      stats.accountId || "",
      stats.totalBets || 0,
      stats.won || 0,
      stats.lost || 0,
      stats.pending || 0,
      stats.pnl || 0,
      stats.totalBet || 0,
      stats.winRate || 0,
      stats.balance || 0,
      stats.cycleCount || 0
    );
  } catch { /* не критично */ }
}

export { app, pushEvent, pushStats };
