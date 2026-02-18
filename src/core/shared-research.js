/**
 * Общая БД исследований — Shark записывает, все читают
 *
 * Shark использует web_search чтобы узнать реальные шансы
 * на события, и сохраняет их здесь. Остальные агенты
 * читают эти данные при принятии решений.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = path.join("data", "shared-research.db");

let db = null;

function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS research (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id INTEGER NOT NULL,
      market_question TEXT,
      real_odds TEXT,
      analysis TEXT,
      sources TEXT,
      researcher TEXT DEFAULT 'Shark',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_research_market ON research(market_id, created_at);
  `);

  return db;
}

/**
 * Сохранить результат исследования рынка
 * @param {number} marketId
 * @param {string} marketQuestion — вопрос рынка
 * @param {object} realOdds — реальные шансы { outcomes: [...], probabilities: [...] }
 * @param {string} analysis — текстовый анализ от LLM
 * @param {string} sources — источники информации
 * @param {string} researcher — кто провёл исследование
 */
export function saveResearch(marketId, { marketQuestion, realOdds, analysis, sources, researcher = "Shark" }) {
  const d = getDb();
  d.prepare(`
    INSERT INTO research (market_id, market_question, real_odds, analysis, sources, researcher)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    marketId,
    marketQuestion || "",
    JSON.stringify(realOdds || {}),
    analysis || "",
    sources || "",
    researcher
  );
}

/**
 * Получить последнее исследование по рынку
 * @param {number} marketId
 * @returns {object|null} — { marketQuestion, realOdds, analysis, sources, researcher, createdAt }
 */
export function getResearch(marketId) {
  const d = getDb();
  const row = d.prepare(
    "SELECT * FROM research WHERE market_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(marketId);

  if (!row) return null;

  return {
    marketId: row.market_id,
    marketQuestion: row.market_question,
    realOdds: JSON.parse(row.real_odds || "{}"),
    analysis: row.analysis,
    sources: row.sources,
    researcher: row.researcher,
    createdAt: row.created_at,
  };
}

/**
 * Получить исследования по всем рынкам (последние)
 * @returns {object} — { marketId: research }
 */
export function getAllResearch() {
  const d = getDb();
  const rows = d.prepare(`
    SELECT r1.* FROM research r1
    INNER JOIN (
      SELECT market_id, MAX(created_at) as max_date
      FROM research GROUP BY market_id
    ) r2 ON r1.market_id = r2.market_id AND r1.created_at = r2.max_date
    ORDER BY r1.created_at DESC
  `).all();

  const result = {};
  for (const row of rows) {
    result[row.market_id] = {
      marketId: row.market_id,
      marketQuestion: row.market_question,
      realOdds: JSON.parse(row.real_odds || "{}"),
      analysis: row.analysis,
      sources: row.sources,
      researcher: row.researcher,
      createdAt: row.created_at,
    };
  }
  return result;
}

/**
 * Проверить, есть ли свежее исследование (не старше maxAgeMinutes)
 */
export function hasRecentResearch(marketId, maxAgeMinutes = 30) {
  const d = getDb();
  const row = d.prepare(`
    SELECT 1 FROM research
    WHERE market_id = ?
      AND datetime(created_at) > datetime('now', ? || ' minutes')
    LIMIT 1
  `).get(marketId, -maxAgeMinutes);

  return !!row;
}

export function closeResearchDb() {
  if (db) {
    db.close();
    db = null;
  }
}
