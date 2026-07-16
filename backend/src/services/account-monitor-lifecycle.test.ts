import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./account-monitor.ts", import.meta.url), "utf8");

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
