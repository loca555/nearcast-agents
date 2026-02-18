/**
 * Клиент NearCast API
 *
 * Работает с бэкендом NearCast — рынки, ставки, чат.
 */

/**
 * @param {string} baseUrl — например "http://localhost:4001/api"
 */
export function createMarketAPI(baseUrl) {

  async function get(path) {
    const res = await fetch(`${baseUrl}${path}`);
    if (!res.ok) throw new Error(`API GET ${path}: ${res.status}`);
    return res.json();
  }

  async function post(path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API POST ${path}: ${res.status}`);
    return res.json();
  }

  return {
    /** Все рынки (с фильтрами) */
    getMarkets: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      if (opts.limit) params.set("limit", opts.limit);
      const qs = params.toString();
      return get(`/markets${qs ? `?${qs}` : ""}`);
    },

    /** Детали рынка */
    getMarket: (id) => get(`/markets/${id}`),

    /** Коэффициенты */
    getOdds: (id) => get(`/markets/${id}/odds`),

    /** Ставки на рынке */
    getMarketBets: (id) => get(`/markets/${id}/bets`),

    /** Ставки пользователя */
    getUserBets: (accountId) => get(`/user/${accountId}/bets`),

    /** Баланс пользователя */
    getBalance: (accountId) => get(`/balance/${accountId}`),

    /** Статистика платформы */
    getStats: () => get("/stats"),

    /** Сообщения чата рынка */
    getChat: (marketId, limit = 30) => get(`/markets/${marketId}/chat?limit=${limit}`),

    /** Ответы на сообщение (тред) */
    getReplies: (marketId, messageId) => get(`/markets/${marketId}/chat/${messageId}/replies`),

    /** Отправить сообщение в чат */
    sendChat: (marketId, accountId, message, replyTo = null) =>
      post(`/markets/${marketId}/chat`, { accountId, message, replyTo }),
  };
}
