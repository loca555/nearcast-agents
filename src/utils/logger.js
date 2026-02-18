/**
 * Логирование агента — цветной вывод с именем и аватаром
 */

export function createLogger(agentName, avatar = "🤖") {
  const tag = `[${avatar} ${agentName}]`;

  return {
    info: (...args) => console.log(`${tag}`, ...args),
    warn: (...args) => console.warn(`${tag} ⚠`, ...args),
    error: (...args) => console.error(`${tag} ✗`, ...args),
    action: (type, detail) => console.log(`${tag} → ${type}: ${detail}`),
    think: (thought) => console.log(`${tag} 💭 ${thought}`),
  };
}
