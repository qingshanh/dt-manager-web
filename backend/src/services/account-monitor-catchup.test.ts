import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const monitorSource = readFileSync(new URL("./account-monitor.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./settings.service.ts", import.meta.url), "utf8");

test("direct monitor app catch-up requires both the environment gate and the persisted setting", () => {
  assert.match(settingsSource, /\["direct_monitor_app_catchup_enabled", "false"/);
  assert.match(monitorSource, /config\.DT_ALLOW_APP_FALLBACK\s*&&\s*parseBooleanSetting\(settings\.direct_monitor_app_catchup_enabled, false\)/);
  assert.doesNotMatch(settingsSource, /\["direct_monitor_app_catchup_enabled", "false", "true"\]/);
});

test("direct monitor schedules app catch-up after non-SMS push activity", () => {
  assert.match(monitorSource, /shouldScheduleAppCatchupForFrame\(liveState\)/);
  assert.match(monitorSource, /scheduleAppCatchup\("direct-frame-gap"\)/);
});
test("direct monitor sends explicit app fallback work through the shared bounded queue", () => {
  assert.match(monitorSource, /import \{ runtimeWorkQueue \} from "\.\/runtime-work-queue\.js"/);
  assert.match(
    monitorSource,
    /runtimeWorkQueue\.run\(`app-fallback:\$\{runner\.accountId\}`, \(\) =>\s*this\.pollAppFallbackMessages\(runner, account\)\s*\)/
  );
});

test("direct monitor does not create a periodic ADB scan timer", () => {
  assert.doesNotMatch(monitorSource, /const appCatchupTimer = runner\.appCatchupEnabled/);
  assert.doesNotMatch(monitorSource, /scheduleAppCatchup\("interval"\)/);
});

test("app fallback only scans the account currently logged into the matching app", () => {
  assert.match(monitorSource, /exportSessionFromAdbConfig\(appVariant\)/);
  assert.match(monitorSource, /session\.dtUserId !== account\.dtUserId/);
  assert.match(monitorSource, /app-session-mismatch/);
});

test("UI catch-up keeps enough history to recover messages after downtime", () => {
  assert.match(monitorSource, /Date\.now\(\) - 7 \* 24 \* 60 \* 60_000/);
});
