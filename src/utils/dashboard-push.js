/**
 * Пуш событий и статистики на дашборд
 *
 * Все вызовы fire-and-forget — дашборд может быть недоступен,
 * это не должно ломать работу агентов.
 */

export function createDashboardPusher(dashboardUrl, agentName, agentAvatar, secret) {
  if (!dashboardUrl) {
    // Заглушка — ничего не отправляем
    return {
      pushEvent: async () => {},
      pushStats: async () => {},
    };
  }

  const headers = {
    "Content-Type": "application/json",
    ...(secret ? { "X-Agent-Secret": secret } : {}),
  };

  /** Отправить событие (bet, chat, reply, win, loss, research, void) */
  async function pushEvent(eventType, data = {}) {
    try {
      await fetch(`${dashboardUrl}/api/events`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentName, agentAvatar, eventType, ...data }),
      });
    } catch {
      // Дашборд недоступен — не критично
    }
  }

  /** Обновить статистику агента (upsert) */
  async function pushStats(stats) {
    try {
      await fetch(`${dashboardUrl}/api/stats`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentName, agentAvatar, ...stats }),
      });
    } catch {
      // Не критично
    }
  }

  return { pushEvent, pushStats };
}
