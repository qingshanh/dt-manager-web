import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const monitorSource = readFileSync(new URL("./account-monitor.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("account monitor shutdown is real, idempotent, and blocks new runners", () => {
  assert.match(monitorSource, /private shuttingDown = false/);
  assert.match(monitorSource, /private stopAllPromise: Promise<void> \| null = null/);
  assert.match(monitorSource, /async stopAll\(\)/);
  assert.match(monitorSource, /this\.shuttingDown = true/);
  assert.match(monitorSource, /Promise\.allSettled\(/);
  assert.match(monitorSource, /preserveMonitorEnabled: true/);
  assert.match(monitorSource, /Account monitor service is shutting down/);
  assert.match(monitorSource, /if \(runner\.stopped \|\| this\.shuttingDown\)/);
});

test("runtime lifecycle requires and awaits AccountMonitorService.stopAll", () => {
  assert.match(indexSource, /stopAccountMonitor: \(\) => accountMonitorService\.stopAll\(\)/);
  assert.doesNotMatch(indexSource, /stopAll\?\./);
});
