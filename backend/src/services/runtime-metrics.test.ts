import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeMetrics } from "./runtime-metrics.js";

test("runtime metrics track counters and gauges without sharing mutable state", () => {
  const metrics = new RuntimeMetrics();
  metrics.increment("direct.reconnects");
  metrics.increment("direct.reconnects", 2);
  metrics.setGauge("direct.activeListeners", 9);

  const first = metrics.snapshot();
  assert.deepEqual(first, {
    counters: { "direct.reconnects": 3 },
    gauges: { "direct.activeListeners": 9 }
  });
  first.counters["direct.reconnects"] = 999;
  assert.equal(metrics.snapshot().counters["direct.reconnects"], 3);
});

test("runtime metrics reject unsafe keys and non-finite values", () => {
  const metrics = new RuntimeMetrics();
  assert.throws(() => metrics.increment("token secret"), /invalid runtime metric key/i);
  assert.throws(() => metrics.setGauge("runtime.heap", Number.NaN), /finite/i);
  assert.throws(() => metrics.increment("runtime.count", Number.POSITIVE_INFINITY), /finite/i);
});

test("runtime metrics reset clears test state", () => {
  const metrics = new RuntimeMetrics();
  metrics.increment("queue.rejected", 4);
  metrics.setGauge("queue.pending", 2);
  metrics.reset();
  assert.deepEqual(metrics.snapshot(), { counters: {}, gauges: {} });
});
