import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeLifecycle } from "./runtime-lifecycle.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("shutdown is idempotent and executes every cleanup once", async () => {
  const calls: string[] = [];
  const lifecycle = new RuntimeLifecycle({
    markStopping: () => { calls.push("mark-stopping"); },
    stopTelegram: () => { calls.push("telegram.stop"); },
    stopAutoRefresh: () => { calls.push("autoRefresh.stop"); },
    stopExpiryReminder: () => { calls.push("expiryReminder.stop"); },
    stopWorkQueue: () => { calls.push("workQueue.stop"); },
    stopAccountMonitor: async () => { calls.push("accountMonitor.stopAll"); },
    closeHttp: async () => { calls.push("http.close"); },
    forceCloseHttp: () => { calls.push("http.forceClose"); },
    closeSse: () => { calls.push("sse.closeAll"); },
    disconnectPrisma: async () => { calls.push("prisma.disconnect"); },
    timeoutMs: 100
  });

  const first = lifecycle.shutdown("SIGTERM");
  const second = lifecycle.shutdown("SIGTERM");
  assert.equal(first, second);
  const result = await first;

  assert.deepEqual(calls, [
    "mark-stopping",
    "sse.closeAll",
    "telegram.stop",
    "autoRefresh.stop",
    "expiryReminder.stop",
    "workQueue.stop",
    "accountMonitor.stopAll",
    "http.close",
    "prisma.disconnect"
  ]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.reason, "SIGTERM");
});

test("component failures do not skip SSE or Prisma cleanup", async () => {
  const calls: string[] = [];
  const lifecycle = new RuntimeLifecycle({
    markStopping: () => undefined,
    stopTelegram: () => { throw new Error("telegram failed"); },
    stopAutoRefresh: () => undefined,
    stopExpiryReminder: () => undefined,
    stopWorkQueue: () => undefined,
    stopAccountMonitor: async () => { throw new Error("monitor failed"); },
    closeHttp: async () => { throw new Error("http failed"); },
    forceCloseHttp: () => { calls.push("http.forceClose"); },
    closeSse: () => { calls.push("sse.closeAll"); },
    disconnectPrisma: async () => { calls.push("prisma.disconnect"); },
    timeoutMs: 100
  });

  const result = await lifecycle.shutdown("test");
  assert.deepEqual(calls, ["sse.closeAll", "prisma.disconnect"]);
  assert.deepEqual(result.warnings.sort(), ["account-monitor", "http", "telegram"].sort());
});

test("timeout force-closes HTTP connections and continues Prisma cleanup", async () => {
  const hanging = deferred();
  const calls: string[] = [];
  const lifecycle = new RuntimeLifecycle({
    markStopping: () => undefined,
    stopTelegram: () => undefined,
    stopAutoRefresh: () => undefined,
    stopExpiryReminder: () => undefined,
    stopWorkQueue: () => undefined,
    stopAccountMonitor: () => hanging.promise,
    closeHttp: async () => undefined,
    forceCloseHttp: () => { calls.push("http.forceClose"); },
    closeSse: () => { calls.push("sse.closeAll"); },
    disconnectPrisma: async () => { calls.push("prisma.disconnect"); },
    timeoutMs: 5
  });

  const result = await lifecycle.shutdown("timeout-test");
  assert.deepEqual(calls, ["sse.closeAll", "http.forceClose", "prisma.disconnect"]);
  assert.deepEqual(result.warnings, ["timeout"]);
  hanging.resolve();
});

test("a hanging Prisma disconnect cannot exceed the global shutdown budget", async () => {
  const hangingPrisma = deferred();
  const lifecycle = new RuntimeLifecycle({
    markStopping: () => undefined,
    stopTelegram: () => undefined,
    stopAutoRefresh: () => undefined,
    stopExpiryReminder: () => undefined,
    stopWorkQueue: () => undefined,
    stopAccountMonitor: async () => undefined,
    closeHttp: async () => undefined,
    forceCloseHttp: () => undefined,
    closeSse: () => undefined,
    disconnectPrisma: () => hangingPrisma.promise,
    timeoutMs: 5
  });
  const result = await lifecycle.shutdown("prisma-timeout");
  assert.deepEqual(result.warnings, ["prisma-timeout"]);
  hangingPrisma.resolve();
});
