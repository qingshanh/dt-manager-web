import type { RuntimeMetricsSnapshot } from "./runtime-metrics.js";
import type { RuntimeWorkQueueSnapshot } from "./runtime-work-queue.js";

type ProcessMemorySnapshot = Partial<{
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}>;

type ProcessCpuSnapshot = Partial<{ user: number; system: number }>;

type MonitorRuntimeSnapshot = {
  activeRunners: number;
  runningCount?: number;
  shuttingDown: boolean;
  activeDirectMonitorPolls?: number;
  appFallbackCooldownUntil?: number;
  appFallbackProbeInFlight?: boolean;
};

type DirectRuntimeSnapshot = {
  activeListeners: number;
  activeSessions: number;
  operationLocks: number;
  caches: Record<string, number>;
  counters: Record<string, number>;
};

type RuntimeStatusInput = {
  memoryUsage?: ProcessMemorySnapshot;
  cpuUsage?: ProcessCpuSnapshot;
  uptimeSeconds?: number;
  metrics?: RuntimeMetricsSnapshot;
  monitor: MonitorRuntimeSnapshot;
  direct: DirectRuntimeSnapshot;
  queue: RuntimeWorkQueueSnapshot;
  appFallbackAllowed: boolean;
};

export function buildRuntimeStatus(input: RuntimeStatusInput) {
  const memory = input.memoryUsage ?? process.memoryUsage();
  const cpu = input.cpuUsage ?? process.cpuUsage();
  const counters = { ...(input.metrics?.counters ?? {}) };
  const gauges = { ...(input.metrics?.gauges ?? {}) };

  for (const [key, value] of Object.entries(input.direct.counters)) {
    counters[`direct.${safeSegment(key)}`] = finiteNumber(value);
  }
  gauges["monitor.activeRunners"] = finiteNumber(input.monitor.activeRunners);
  gauges["monitor.runningCount"] = finiteNumber(input.monitor.runningCount);
  gauges["monitor.shuttingDown"] = input.monitor.shuttingDown ? 1 : 0;
  gauges["monitor.activeDirectPolls"] = finiteNumber(input.monitor.activeDirectMonitorPolls);
  gauges["monitor.appFallbackCooldownUntil"] = finiteNumber(input.monitor.appFallbackCooldownUntil);
  gauges["monitor.appFallbackProbeInFlight"] = input.monitor.appFallbackProbeInFlight ? 1 : 0;
  gauges["direct.activeListeners"] = finiteNumber(input.direct.activeListeners);
  gauges["direct.activeSessions"] = finiteNumber(input.direct.activeSessions);
  gauges["direct.operationLocks"] = finiteNumber(input.direct.operationLocks);
  for (const [key, value] of Object.entries(input.direct.caches)) {
    gauges[`direct.cache.${safeSegment(key)}`] = finiteNumber(value);
  }
  gauges["queue.active"] = finiteNumber(input.queue.active);
  gauges["queue.pending"] = finiteNumber(input.queue.pending);
  gauges["queue.rejected"] = finiteNumber(input.queue.rejected);
  gauges["queue.stopped"] = input.queue.stopped ? 1 : 0;

  return {
    process: {
      memory: {
        rss: finiteNumber(memory.rss),
        heapUsed: finiteNumber(memory.heapUsed),
        heapTotal: finiteNumber(memory.heapTotal),
        external: finiteNumber(memory.external),
        arrayBuffers: finiteNumber(memory.arrayBuffers)
      },
      cpu: {
        userMicros: finiteNumber(cpu.user),
        systemMicros: finiteNumber(cpu.system)
      },
      uptimeSeconds: finiteNumber(input.uptimeSeconds ?? process.uptime())
    },
    counters,
    gauges,
    appFallbackAllowed: input.appFallbackAllowed
  };
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function safeSegment(value: string) {
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  return safe || "unknown";
}
