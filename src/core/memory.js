/**
 * Память агента — SQLite
 *
 * Хранит: историю ставок, результаты, P&L, заметки.
 * Каждый агент имеет свою БД в data/{name}.db
 */

import Database from "better-sqlite3";

export function createMemory(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    -- Ставки агента
    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id INTEGER NOT NULL,
      outcome INTEGER NOT NULL,
      amount_near REAL NOT NULL,
      odds_at_bet REAL,
      reasoning TEXT,
      result TEXT DEFAULT 'pending',
      pnl_near REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    -- Сообщения в чат
    CREATE TABLE IF NOT EXISTS chat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      reply_to INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Общие заметки / память
    CREATE TABLE IF NOT EXISTS notes (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
    CREATE INDEX IF NOT EXISTS idx_bets_result ON bets(result);
  `);

  return {
    /** Записать ставку */
    recordBet(marketId, outcome, amountNear, odds, reasoning) {
      return db.prepare(
        "INSERT INTO bets (market_id, outcome, amount_near, odds_at_bet, reasoning) VALUES (?, ?, ?, ?, ?)"
      ).run(marketId, outcome, amountNear, odds, reasoning);
    },

    /** Обновить результат ставки */
    resolveBet(marketId, result, pnl) {
      db.prepare(
        "UPDATE bets SET result = ?, pnl_near = ?, resolved_at = datetime('now') WHERE market_id = ? AND result = 'pending'"
      ).run(result, pnl, marketId);
    },

    /** Ставки на конкретный рынок */
    getBetsForMarket(marketId) {
      return db.prepare("SELECT * FROM bets WHERE market_id = ?").all(marketId);
    },

    /** Все pending ставки */
    getPendingBets() {
      return db.prepare("SELECT * FROM bets WHERE result = 'pending'").all();
    },

    /** Суммарный P&L */
    getTotalPnL() {
      const row = db.prepare("SELECT COALESCE(SUM(pnl_near), 0) as total FROM bets WHERE result != 'pending'").get();
      return row.total;
    },

    /** Статистика: всего ставок, выиграно, проиграно */
    getStats() {
      const total = db.prepare("SELECT COUNT(*) as c FROM bets").get().c;
      const won = db.prepare("SELECT COUNT(*) as c FROM bets WHERE result = 'won'").get().c;
      const lost = db.prepare("SELECT COUNT(*) as c FROM bets WHERE result = 'lost'").get().c;
      const pending = db.prepare("SELECT COUNT(*) as c FROM bets WHERE result = 'pending'").get().c;
      const pnl = this.getTotalPnL();
      const totalBet = db.prepare("SELECT COALESCE(SUM(amount_near), 0) as s FROM bets").get().s;
      return { total, won, lost, pending, pnl, totalBet, winRate: total > 0 ? (won / (won + lost) || 0) : 0 };
    },

    /** Последние N ставок */
    getRecentBets(limit = 10) {
      return db.prepare("SELECT * FROM bets ORDER BY created_at DESC LIMIT ?").all(limit);
    },

    /** Записать отправленное сообщение */
    recordChat(marketId, message, replyTo) {
      db.prepare("INSERT INTO chat_log (market_id, message, reply_to) VALUES (?, ?, ?)").run(marketId, message, replyTo);
    },

    /** Сохранить/обновить заметку */
    setNote(key, value) {
      db.prepare("INSERT OR REPLACE INTO notes (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
    },

    /** Прочитать заметку */
    getNote(key) {
      const row = db.prepare("SELECT value FROM notes WHERE key = ?").get(key);
      return row?.value || null;
    },

    /** Рынки, на которых уже есть ставки */
    getMarketsWithBets() {
      return db.prepare("SELECT DISTINCT market_id FROM bets").all().map(r => r.market_id);
    },

    /**
     * Восстановить историю ставок из блокчейна (после потери SQLite)
     * @param {object[]} chainBets — результат get_user_bets из контракта
     * @param {object[]} markets — все рынки из API
     */
    syncFromChain(chainBets, markets) {
      if (!chainBets || chainBets.length === 0) return 0;

      const existing = db.prepare("SELECT COUNT(*) as c FROM bets").get().c;
      if (existing > 0) return 0; // уже есть данные — не перезаписываем

      const marketsById = {};
      for (const m of markets) marketsById[m.id] = m;

      const insert = db.prepare(
        "INSERT INTO bets (market_id, outcome, amount_near, odds_at_bet, reasoning, result, pnl_near, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );

      let synced = 0;
      const tx = db.transaction(() => {
        for (const bet of chainBets) {
          const market = marketsById[bet.marketId];
          if (!market) continue;

          // Пропускаем осиротевшие ставки от старых контрактов
          if (Number(bet.timestamp) < Number(market.createdAt)) continue;

          const amountNear = Number(bet.amount) / 1e24;
          let result = "pending";
          let pnl = 0;

          if (market.status === "resolved") {
            const won = market.resolvedOutcome === bet.outcome;
            result = won ? "won" : "lost";
            if (won) {
              const totalPool = Number(market.totalPool) / 1e24;
              const winPool = Number(market.outcomePools[bet.outcome]) / 1e24;
              pnl = winPool > 0 ? (amountNear * totalPool / winPool) - amountNear : 0;
            } else {
              pnl = -amountNear;
            }
          } else if (market.status === "voided") {
            result = "voided";
            pnl = 0;
          }

          // Таймстамп из контракта (наносекунды → ISO строка)
          const createdAt = new Date(Number(bet.timestamp) / 1e6).toISOString();
          const resolvedAt = result !== "pending" ? new Date().toISOString() : null;

          insert.run(bet.marketId, bet.outcome, amountNear, null, "synced from chain", result, pnl, createdAt, resolvedAt);
          synced++;
        }
      });
      tx();
      return synced;
    },

    close() {
      db.close();
    },
  };
}
