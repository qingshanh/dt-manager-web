import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const monitorSource = readFileSync(new URL("./account-monitor.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./settings.service.ts", import.meta.url), "utf8");
const accountsRouteSource = readFileSync(new URL("../routes/accounts.ts", import.meta.url), "utf8");

test("direct monitors default to bounded concurrency", () => {
  assert.match(settingsSource, /\["direct_monitor_max_concurrent",\s*"10"/);
  assert.match(settingsSource, /\["direct_monitor_max_concurrent",\s*"12",\s*"10"\]/);
  assert.match(settingsSource, /\["direct_monitor_max_concurrent",\s*"3",\s*"10"\]/);
  assert.match(settingsSource, /\["direct_monitor_max_concurrent",\s*"2",\s*"10"\]/);
  assert.match(settingsSource, /\["direct_monitor_max_concurrent",\s*"0",\s*"10"\]/);
  assert.match(monitorSource, /parsePositiveIntSetting\(settings\.direct_monitor_max_concurrent,\s*10\)/);
  assert.match(settingsSource, /\["direct_message_listen_seconds",\s*"900"/);
  assert.match(settingsSource, /\["direct_message_listen_seconds",\s*"45",\s*"900"\]/);
  assert.match(settingsSource, /\["direct_message_listen_seconds",\s*"120",\s*"900"\]/);
  assert.match(settingsSource, /\["account_monitor_restore_enabled",\s*"true"/);
  assert.match(settingsSource, /\["direct_message_refresh_wait_seconds",\s*"8"/);
  assert.match(settingsSource, /\["direct_message_refresh_wait_seconds",\s*"45",\s*"8"\]/);
  assert.match(settingsSource, /\["direct_message_refresh_wait_seconds",\s*"60",\s*"8"\]/);
  assert.match(accountsRouteSource, /parsePositiveIntSetting\(settings\.direct_message_refresh_wait_seconds,\s*8\)/);
  assert.match(accountsRouteSource, /listenSeconds: Math\.max\(15,\s*Math\.min\(120,\s*directWaitSeconds\)\)/);
  assert.match(monitorSource, /listenSeconds: Math\.max\(300, Math\.min\(1800, directListenSeconds\)\)/);
  assert.doesNotMatch(monitorSource, /parseNonNegativeIntSetting\(settings\.direct_monitor_max_concurrent,\s*0\)/);
});


test("direct bootstrap REST failures stay transient instead of expiring accounts", () => {
  const classifierStart = monitorSource.indexOf("function classifyMonitorError");
  assert.notEqual(classifierStart, -1);
  const transientRestIndex = monitorSource.indexOf('normalized.includes("rest call failed")', classifierStart);
  const expiredBootstrapIndex = monitorSource.indexOf('normalized.includes("bootstrap failed")', classifierStart);
  assert.ok(transientRestIndex > classifierStart);
  assert.ok(expiredBootstrapIndex > classifierStart);
  assert.ok(transientRestIndex < expiredBootstrapIndex);
});test("direct monitor slots rotate fairly after a long listen", () => {
  assert.match(monitorSource, /lastCycleUsedDirectSlot: boolean/);
  assert.match(monitorSource, /lastCycleSkippedDirectSlot: boolean/);
  assert.match(monitorSource, /runner\.lastCycleUsedDirectSlot\s*=\s*Boolean\(directPollResult\?\.listened\)/);
  assert.match(monitorSource, /runner\.lastCycleSkippedDirectSlot\s*=\s*Boolean\(directPollResult\?\.skippedForConcurrency\)/);
  assert.match(monitorSource, /runner\.lastCycleSkippedDirectSlot\s*\? 5_000/);
  assert.match(monitorSource, /this\.directSlotRotationDelay\(runner\)/);
  assert.match(monitorSource, /private directSlotRotationDelay\(runner: MonitorRunner\)/);
  assert.match(monitorSource, /Math\.ceil\(this\.runners\.size \/ Math\.max\(1, runner\.maxConcurrentDirectPolls\)\)/);
  assert.match(monitorSource, /runner\.maxConcurrentDirectPolls >= this\.runners\.size/);
  assert.doesNotMatch(monitorSource, /runner\.lastCyclePreempted \? 1_000 : Math\.max\(1_000, runner\.pollIntervalMs - elapsed\)/);
});
test("direct message refresh returns quickly while a background refresh continues", () => {
  assert.match(accountsRouteSource, /const activeMessageRefreshes = new Set<number>\(\)/);
  assert.match(accountsRouteSource, /startBackgroundMessageRefresh\(account\.id, body\.limit, body\.direct_only\)/);
  assert.match(accountsRouteSource, /background: true/);
});
test("account monitor auto-restore defaults to enabled without blocking health", () => {
  const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(indexSource, /parseBooleanSetting\(settings\.account_monitor_restore_enabled, true\)/);
  assert.match(indexSource, /app\.get\("\/health", \(_req, res\) => \{/);
});

test("direct SMS monitors do not block listening on runtime asset refresh", () => {
  assert.doesNotMatch(monitorSource, /refreshAccountRuntimeData\(runner\.accountId, useDirectFlow \? directMonitorGateway : dingtoneGateway\)/);
  assert.match(monitorSource, /if \(shouldRefreshRuntimeData\(runner\) && !useDirectFlow\)/);
  assert.match(monitorSource, /refreshAccountRuntimeData\(runner\.accountId, dingtoneGateway\)/);
});
test("manual direct refresh only skips when a monitor runner is active in this process", () => {
  assert.match(monitorSource, /isRunning\(accountId: number\)/);
  assert.match(monitorSource, /this\.runners\.get\(accountId\)/);
  assert.match(accountsRouteSource, /if \(!accountMonitorService\.isRunning\(accountId\)\) \{\s*return null;\s*\}/);
  assert.match(accountsRouteSource, /if \(!session\.routeAddress\?\.includes\("listen=active"\)\) \{\s*return null;\s*\}/);
});
test("direct monitor passes account app variant into direct push listener", () => {
  assert.match(monitorSource, /listenDirectSessionPushes\(\{[\s\S]*account: \{[\s\S]*appVariant: account\.appVariant[\s\S]*\}/);
});
test("direct monitor preemption preserves account app variant", () => {
  assert.match(monitorSource, /select: \{ adminId: true, dtUserId: true, dtDeviceId: true, appVariant: true \}/);
  assert.match(monitorSource, /preemptDirectSessionPushListener\(\{[\s\S]*appVariant: account\.appVariant[\s\S]*\}\)/);
});
test("account monitor restore timers stay referenced and independent", () => {
  assert.match(monitorSource, /const restoreTasks = accountsToRestore\.map/);
  assert.match(monitorSource, /Promise\.allSettled\(restoreTasks\)/);
  const restoreStart = monitorSource.indexOf("async restoreEnabled()");
  const restoreEnd = monitorSource.indexOf("private async stopDuplicateDtUserIdMonitors", restoreStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  const restoreSource = monitorSource.slice(restoreStart, restoreEnd);
  assert.doesNotMatch(restoreSource, /\.unref\?\.\(\)/);
});
