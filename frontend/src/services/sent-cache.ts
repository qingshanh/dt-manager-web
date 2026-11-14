/**
 * 记录面板近期主动发出的短信内容与会话，用于全局拦截自发自弹“新短信”通知
 */
const recentSentContents = new Map<string, number>();

export function markMessageAsSent(content: string, accountId?: number) {
  const clean = content.trim();
  if (!clean) return;
  const now = Date.now();
  recentSentContents.set(clean, now);
  if (accountId) {
    recentSentContents.set(`${accountId}:${clean}`, now);
  }
  // 60 秒后清理过期记录
  setTimeout(() => {
    recentSentContents.delete(clean);
    if (accountId) recentSentContents.delete(`${accountId}:${clean}`);
  }, 60_000);
}

export function isRecentSentMessage(content: string, accountId?: number): boolean {
  const clean = content.trim();
  if (!clean) return false;
  if (recentSentContents.has(clean)) return true;
  if (accountId && recentSentContents.has(`${accountId}:${clean}`)) return true;
  return false;
}
