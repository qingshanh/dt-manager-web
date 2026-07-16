import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeStatus } from "./runtime-status.js";

test("runtime status flattens safe process, monitor, direct, and queue metrics", () => {
  const status = buildRuntimeStatus({
    memoryUsage: { rss: 100, heapUsed: 50, heapTotal: 80, external: 4, arrayBuffers: 2 },
    cpuUsage: { user: 20, system: 10 },
    uptimeSeconds: 30,
    metrics: { counters: { "queue.rejected": 1 }, gauges: { "custom.gauge": 2 } },
    monitor: { activeRunners: 9, shuttingDown: false },
    direct: {
      activeListeners: 9,
      activeSessions: 18,
      operationLocks: 1,
      caches: { phoneCountry: 3, smsHostAffinity: 4, webOfflineTrackers: 5 },
      counters: { rawQueueDrops: 6, reconnects: 7 }
    },
    queue: { active: 2, pending: 4, rejected: 1, stopped: false },
    appFallbackAllowed: false
  });

  assert.deepEqual(status.process.memory, { rss: 100, heapUsed: 50, heapTotal: 80, external: 4, arrayBuffers: 2 });
  assert.deepEqual(status.process.cpu, { userMicros: 20, systemMicros: 10 });
  assert.equal(status.counters["direct.rawQueueDrops"], 6);
  assert.equal(status.counters["direct.reconnects"], 7);
  assert.equal(status.gauges["monitor.activeRunners"], 9);
  assert.equal(status.gauges["direct.activeListeners"], 9);
  assert.equal(status.gauges["direct.cache.phoneCountry"], 3);
  assert.equal(status.gauges["queue.pending"], 4);
  assert.equal(status.appFallbackAllowed, false);
});

test("runtime status output contains no sensitive key families", () => {
  const status = buildRuntimeStatus({
    monitor: { activeRunners: 0, shuttingDown: true },
    direct: { activeListeners: 0, activeSessions: 0, operationLocks: 0, caches: {}, counters: {} },
    queue: { active: 0, pending: 0, rejected: 0, stopped: true },
    appFallbackAllowed: false
  });
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /token|email|phoneNumber|deviceId|rawFrame|stack/i);
});
