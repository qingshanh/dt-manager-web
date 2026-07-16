import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyDirectMonitorHostStatusForTest,
  createSerializedLatestDiagnosticWriterForTest,
  createDirectMonitorFrameStateForTest,
  resolveDirectMonitorListenStateForTest
} from "./account-monitor.js";

const source = readFileSync(new URL("./account-monitor.ts", import.meta.url), "utf8");

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("account monitor shutdown blocks new work and preserves monitor intent", () => {
  assert.match(source, /private shuttingDown = false/);
  assert.match(source, /async stopAll\(\)/);
  assert.match(source, /this\.shuttingDown = true/);
  assert.match(source, /preserveMonitorEnabled: true/);
  assert.match(source, /if \(this\.shuttingDown\)[\s\S]*Account monitor service is shutting down/);
});

test("stopping an account releases all direct account runtime state", () => {
  assert.match(source, /releaseDirectAccountRuntime/);
  assert.match(source, /await releaseDirectAccountRuntime\(\{[\s\S]*dtUserId: account\.dtUserId[\s\S]*deviceId: account\.dtDeviceId/);
});

test("runtime snapshot contains only bounded aggregate monitor state", () => {
  assert.match(source, /snapshot\(\): AccountMonitorRuntimeSnapshot/);
  assert.match(source, /runnerCount: this\.runners\.size/);
  assert.match(source, /activeDirectMonitorPolls/);
  assert.match(source, /shuttingDown: this\.shuttingDown/);
  assert.doesNotMatch(source, /snapshot\(\)[\s\S]{0,500}(dtToken|email|phone|deviceId)/);
});

test("maintenance work is queued while realtime SMS push storage stays immediate", () => {
  assert.match(source, /runtimeWorkQueue\.run\(`account-refresh:\$\{runner\.accountId\}`/);
  assert.match(source, /runtimeWorkQueue\.run\(\s*`offline-catchup:\$\{runner\.accountId\}:/);
  assert.match(source, /onPush: async[\s\S]*storeParsedSmsPushes\(runner\.accountId, \[push\.sms\]\)/);
});

test("direct diagnostics report degraded when every paired host has failed", () => {
  const state = createDirectMonitorFrameStateForTest();
  state.failedHosts.set("primary", "socket ended");
  state.failedHosts.set("backup", "socket reset");
  assert.equal(resolveDirectMonitorListenStateForTest(state, false), "degraded");
});

test("direct diagnostics preserve failed state while a host reconnects", () => {
  const state = createDirectMonitorFrameStateForTest();
  applyDirectMonitorHostStatusForTest(state, "primary", "failed", "socket ended");
  applyDirectMonitorHostStatusForTest(state, "primary", "connecting", null);

  assert.equal(state.failedHosts.get("primary"), "socket ended");
  assert.equal(state.connectingHosts.has("primary"), true);
  assert.equal(state.pairedHosts.has("primary"), false);
  assert.equal(resolveDirectMonitorListenStateForTest(state, false), "degraded");

  applyDirectMonitorHostStatusForTest(state, "primary", "connected", null);
  assert.equal(state.failedHosts.has("primary"), false);
  assert.equal(state.connectingHosts.has("primary"), false);
  assert.equal(state.pairedHosts.has("primary"), true);
  assert.equal(resolveDirectMonitorListenStateForTest(state, false), "active");
});

test("direct diagnostics distinguish fresh connecting from stable connected", () => {
  const state = createDirectMonitorFrameStateForTest();
  applyDirectMonitorHostStatusForTest(state, "primary", "connecting", null);
  assert.equal(resolveDirectMonitorListenStateForTest(state, false), "connecting");

  applyDirectMonitorHostStatusForTest(state, "primary", "connected", null);
  assert.equal(state.failedHosts.has("primary"), false);
  assert.equal(state.connectingHosts.has("primary"), false);
  assert.equal(state.pairedHosts.has("primary"), true);
  assert.equal(resolveDirectMonitorListenStateForTest(state, false), "active");
});

test("live diagnostic writes serialize and compute queued snapshots after the prior write", async () => {
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const events: string[] = [];
  let state = "old";
  const write = createSerializedLatestDiagnosticWriterForTest<string>(async (snapshot) => {
    events.push(`start:${snapshot}`);
    if (snapshot === "old") {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    events.push(`done:${snapshot}`);
  });

  const first = write(() => state);
  await firstStarted.promise;
  state = "queued";
  const second = write(() => state);
  state = "latest";
  await Promise.resolve();
  assert.deepEqual(events, ["start:old"]);

  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["start:old", "done:old", "start:latest", "done:latest"]);
});

test("live diagnostic writer recovers its tail after a failed write", async () => {
  const events: string[] = [];
  const write = createSerializedLatestDiagnosticWriterForTest<string>(async (snapshot) => {
    events.push(snapshot);
    if (snapshot === "failed") {
      throw new Error("write failed");
    }
  });

  const failed = write(() => "failed");
  const recovered = write(() => "recovered");
  await assert.rejects(failed, /write failed/);
  await recovered;
  assert.deepEqual(events, ["failed", "recovered"]);
});
