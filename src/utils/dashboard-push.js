/**
 * Пуш событий и статистики на встроенный дашборд
 *
 * Прямая запись в SQLite (без HTTP).
 */

import { pushEvent as dbPushEvent, pushStats as dbPushStats } from "../dashboard/index.js";

export function createDashboardPusher(_url, agentName, agentAvatar, _secret) {
  return {
    pushEvent(eventType, data = {}) {
      dbPushEvent(agentName, agentAvatar, eventType, data);
    },
    pushStats(stats) {
      dbPushStats(agentName, agentAvatar, stats);
    },
  };
}
