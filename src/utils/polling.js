// 后台标签页最多每分钟轮询一次，仍保留较慢的用户配置。
export function getPollingDelay(delay, hidden = typeof document !== 'undefined' && document.hidden) {
  return hidden ? Math.max(delay, 60000) : delay;
}

// 连续失败时退避到 30 秒，成功连接后由调用方重置计数。
export function getReconnectDelay(attempt, random = Math.random) {
  const base = Math.min(1000 * (2 ** Math.min(attempt, 5)), 30000);
  return Math.min(30000, Math.round(base * (1 + random() * 0.2)));
}
