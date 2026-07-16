import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeRuntimeSamples,
  linearSlopePerHour,
  resolveRuntimeToken,
  sanitizeRuntimeSample
} from "./soak-runtime.mjs";

test("linear slope converts timestamped byte samples to megabytes per hour", () => {
  const hour = 60 * 60 * 1000;
  const mib = 1024 * 1024;
  const slope = linearSlopePerHour([
    { timestampMs: 0, value: 500 * mib },
    { timestampMs: hour, value: 504 * mib },
    { timestampMs: hour * 2, value: 508 * mib }
  ]);
  assert.equal(Math.round(slope * 1000) / 1000, 4);
});

test("analysis removes warmup samples and detects memory or CPU breaches", () => {
  const minute = 60 * 1000;
  const mib = 1024 * 1024;
  const samples = Array.from({ length: 70 }, (_, index) => ({
    timestamp: new Date(index * minute).toISOString(),
    memory: { rss: (400 + index * 0.2) * mib },
    cpu: { singleCorePercent: index < 10 ? 40 : 7 }
  }));

  const healthy = analyzeRuntimeSamples(samples, {
    warmupMinutes: 10,
    maxMemorySlopeMbHour: 15,
    maxIdleSingleCorePercent: 10
  });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.sampleCount, 60);

  const unhealthy = analyzeRuntimeSamples(samples, {
    warmupMinutes: 10,
    maxMemorySlopeMbHour: 5,
    maxIdleSingleCorePercent: 5
  });
  assert.equal(unhealthy.ok, false);
  assert.deepEqual(unhealthy.failures.sort(), ["cpu", "memory"].sort());
});

test("sanitized samples keep only safe runtime fields", () => {
  const sample = sanitizeRuntimeSample({
    timestamp: "2026-07-16T00:00:00.000Z",
    health: {
      instanceId: "instance-a",
      startedAt: "2026-07-15T23:59:50.000Z",
      uptimeSeconds: 10,
      token: "secret",
      email: "user@example.com"
    },
    metrics: {
      process: {
        memory: { rss: 100, heapUsed: 50, heapTotal: 80, external: 4, arrayBuffers: 2 },
        cpu: { userMicros: 20, systemMicros: 10 }
      },
      counters: { "direct.reconnects": 3 },
      gauges: { "direct.activeListeners": 2 },
      rawFrame: "0103",
      stack: "secret stack"
    },
    cpu: { singleCorePercent: 5 }
  });

  assert.deepEqual(sample, {
    timestamp: "2026-07-16T00:00:00.000Z",
    instanceId: "instance-a",
    startedAt: "2026-07-15T23:59:50.000Z",
    uptimeSeconds: 10,
    memory: { rss: 100, heapUsed: 50, heapTotal: 80, external: 4, arrayBuffers: 2 },
    processCpu: { userMicros: 20, systemMicros: 10 },
    cpu: { singleCorePercent: 5 },
    counters: { "direct.reconnects": 3 },
    gauges: { "direct.activeListeners": 2 }
  });
  assert.doesNotMatch(JSON.stringify(sample), /secret|example\.com|0103/);
});

test("analysis fails when samples are insufficient or the process restarts", () => {
  const insufficient = analyzeRuntimeSamples([
    { timestamp: "2026-07-16T00:00:00.000Z", instanceId: "a", uptimeSeconds: 1, memory: { rss: 1 }, cpu: { singleCorePercent: 0 } }
  ], { warmupMinutes: 0 });
  assert.equal(insufficient.ok, false);
  assert.deepEqual(insufficient.failures, ["insufficient-samples"]);

  const restarted = analyzeRuntimeSamples([
    { timestamp: "2026-07-16T00:00:00.000Z", instanceId: "a", uptimeSeconds: 100, memory: { rss: 1 }, cpu: { singleCorePercent: 0 } },
    { timestamp: "2026-07-16T00:01:00.000Z", instanceId: "b", uptimeSeconds: 2, memory: { rss: 1 }, cpu: { singleCorePercent: 0 } }
  ], { warmupMinutes: 0 });
  assert.equal(restarted.ok, false);
  assert.deepEqual(restarted.failures, ["restart"]);

  const restartedWithoutInstanceId = analyzeRuntimeSamples([
    { timestamp: "2026-07-16T00:00:00.000Z", instanceId: null, startedAt: "2026-07-15T23:59:50.000Z", uptimeSeconds: 10, memory: { rss: 1 }, cpu: { singleCorePercent: 0 } },
    { timestamp: "2026-07-16T00:01:00.000Z", instanceId: null, startedAt: "2026-07-16T00:00:10.000Z", uptimeSeconds: 50, memory: { rss: 1 }, cpu: { singleCorePercent: 0 } }
  ], { warmupMinutes: 0 });
  assert.equal(restartedWithoutInstanceId.ok, false);
  assert.deepEqual(restartedWithoutInstanceId.failures, ["restart"]);
});

test("runtime token defaults to an environment variable instead of command-line exposure", () => {
  assert.deepEqual(resolveRuntimeToken({ envName: "DT_ADMIN_TOKEN", environment: { DT_ADMIN_TOKEN: "secret" } }), {
    token: "secret",
    source: "environment"
  });
  assert.deepEqual(resolveRuntimeToken({ directToken: "legacy", envName: "DT_ADMIN_TOKEN", environment: {} }), {
    token: "legacy",
    source: "command-line"
  });
});
