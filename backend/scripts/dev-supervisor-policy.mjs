export const FATAL_LISTEN_EXIT_CODE = 78;

const FAILURE_WINDOW_MS = 60_000;
const STABLE_RUN_RESET_MS = 60_000;
const MAX_QUICK_FAILURES = 5;
const RESTART_DELAYS_MS = [1_500, 3_000, 6_000, 12_000, 30_000];

export function nextRestartDecision({ exits, now, stableRunMs, exitCode, stopping }) {
  if (stopping) {
    return { restart: false, delayMs: 0, reason: "stopping", nextFailureCount: 0 };
  }
  if (exitCode === FATAL_LISTEN_EXIT_CODE) {
    return { restart: false, delayMs: 0, reason: "fatal", nextFailureCount: 0 };
  }

  const recentExits = stableRunMs >= STABLE_RUN_RESET_MS
    ? []
    : exits.filter((timestamp) => timestamp >= now - FAILURE_WINDOW_MS);
  const nextFailureCount = recentExits.length + 1;
  if (nextFailureCount > MAX_QUICK_FAILURES) {
    return { restart: false, delayMs: 0, reason: "circuit-breaker", nextFailureCount };
  }

  return {
    restart: true,
    delayMs: RESTART_DELAYS_MS[Math.min(nextFailureCount - 1, RESTART_DELAYS_MS.length - 1)],
    reason: "retry",
    nextFailureCount
  };
}
