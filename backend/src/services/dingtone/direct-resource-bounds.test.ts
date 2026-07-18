import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DirectTransportGovernor } from "./direct-transport-governor.js";
import {
  createDirectListenerDiagnosticsForTest,
  directRuntimeCacheSizesForTest,
  releaseDirectAccountRuntime,
  seedDirectRuntimeCachesForTest,
  sliceDirectRetainedTraceForTest
} from "./direct-gateway.js";

const directSource = readFileSync(new URL("./direct-gateway.ts", import.meta.url), "utf8");

function fakePush(index: number) {
  return {
    receivedAt: new Date(index).toISOString(),
    frameType: 0x8107,
    status: 0x0103,
    bodyLength: 1,
    rawHexPreview: index.toString(16)
  };
}

function fakeCall(index: number) {
  return { name: `call-${index}`, ok: true, durationMs: index };
}

function fakeTrace(index: number) {
  return {
    receivedAt: new Date(index).toISOString(),
    frameType: 0x8107,
    status: 0x0102,
    rawLength: 1,
    bodyLength: 1,
    rawHexPreview: index.toString(16),
    bodyHexPreview: index.toString(16)
  };
}

test("direct listener diagnostics retain fixed recent windows and cumulative counters", () => {
  const state = createDirectListenerDiagnosticsForTest();

  for (let index = 0; index < 10_000; index += 1) {
    state.recordPush(fakePush(index));
    state.recordCall(fakeCall(index));
    state.recordTrace(fakeTrace(index));
    state.recordHostError("20.97.117.109", new Error(`failure-${index}`));
  }
  state.recordConnectionAttempt("20.97.117.109");
  state.recordConnectionAttempt("20.97.117.109");
  state.recordConnectionAttempt("206.189.228.89");

  const snapshot = state.snapshot();
  assert.equal(snapshot.pushes.length, 100);
  assert.equal(snapshot.calls.length, 100);
  assert.equal(snapshot.trace.length, 160);
  assert.equal(snapshot.hostErrors.size, 1);
  assert.equal(snapshot.counters.pushes, 10_000);
  assert.equal(snapshot.counters.calls, 10_000);
  assert.equal(snapshot.counters.traceFrames, 10_000);
  assert.equal(snapshot.counters.hostErrors, 10_000);
  assert.equal(snapshot.counters.connectionAttempts, 3);
  assert.equal(snapshot.counters.reconnects, 1);
  assert.equal(snapshot.hostErrors.get("20.97.117.109")?.count, 10_000);
  assert.doesNotMatch(JSON.stringify([...snapshot.hostErrors]), /failure-0(?:\D|$)/);
});

test("direct account runtime caches are bounded and explicitly releasable", async () => {
  const account = { dtUserId: "resource-test-user", deviceId: "resource-test-device" };
  seedDirectRuntimeCachesForTest(account);
  const seeded = directRuntimeCacheSizesForTest();
  assert.ok(seeded.phoneCountries > 0);
  assert.ok(seeded.smsHostAffinity > 0);
  assert.ok(seeded.webOfflineTrackers > 0);

  await releaseDirectAccountRuntime(account);

  const released = directRuntimeCacheSizesForTest();
  assert.equal(released.phoneCountries, seeded.phoneCountries - 1);
  assert.equal(released.smsHostAffinity, seeded.smsHostAffinity - 1);
  assert.equal(released.webOfflineTrackers, seeded.webOfflineTrackers - 1);
});

test("direct trace cursors continue from a rolling retained session window", () => {
  const retained = Array.from({ length: 80 }, (_, index) => fakeTrace(index + 120));

  const afterOldCursor = sliceDirectRetainedTraceForTest(retained, 200, 80);
  assert.equal(afterOldCursor.frames.length, 80);
  assert.equal(afterOldCursor.totalSeen, 200);

  const afterRecentCursor = sliceDirectRetainedTraceForTest(retained, 200, 190);
  assert.equal(afterRecentCursor.frames.length, 10);
  assert.equal(afterRecentCursor.frames[0]?.receivedAt, fakeTrace(190).receivedAt);
});

test("long listeners count cumulatively while short probes have an explicit frame cap", () => {
  const listenerStart = directSource.indexOf("export async function listenDirectSessionPushes");
  const probeStart = directSource.indexOf("export async function probeDirectPushSocket", listenerStart);
  const listenerText = directSource.slice(listenerStart, probeStart);
  const probeText = directSource.slice(probeStart, directSource.indexOf("function annotatePairedSocketError", probeStart));

  assert.doesNotMatch(listenerText, /Number\.MAX_SAFE_INTEGER/);
  assert.match(listenerText, /diagnostics\.totalPushes\(\)/);
  assert.match(probeText, /input\.maxPushFrames \?\? MAX_DIRECT_LISTENER_PUSHES/);
});

test("direct transport governor entries remain bounded and clear releases them", () => {
  let now = 0;
  const governor = new DirectTransportGovernor({ now: () => now, random: () => 0.5 });
  for (let index = 0; index < 1_000; index += 1) {
    now = index;
    governor.recordFailure(`transport-${index}:80`, "discovery");
  }
  assert.equal(governor.snapshot().size, 128);
  governor.clear();
  assert.equal(governor.snapshot().size, 0);
});
