import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const monitorSource = readFileSync(new URL("./account-monitor.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./settings.service.ts", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../config.ts", import.meta.url), "utf8");
const envExampleSource = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");

test("app catch-up requires both the disabled-by-default environment gate and the persisted setting", () => {
  assert.match(
    settingsSource,
    /const directMonitorAppCatchupDescription =\s*"Enable app\/helper\/ADB catch-up only for local emulator\/helper recovery"/
  );
  assert.match(
    settingsSource,
    /\["direct_monitor_app_catchup_enabled", "false", directMonitorAppCatchupDescription\]/
  );
  assert.match(
    configSource,
    /DT_ALLOW_APP_FALLBACK:\s*z[\s\S]*?\.default\("false"\)[\s\S]*?\.transform\(\(value\) => \["true", "1", "yes", "on"\]\.includes\(value\.trim\(\)\.toLowerCase\(\)\)\)/
  );
  assert.match(envExampleSource, /^DT_ALLOW_APP_FALLBACK=false$/m);
  assert.match(
    monitorSource,
    /const appCatchupEnabled = config\.DT_ALLOW_APP_FALLBACK\s*&&\s*parseBooleanSetting\(settings\.direct_monitor_app_catchup_enabled, false\)/
  );
  assert.match(monitorSource, /return \/\^\(1\|true\|yes\|on\)\$\/i\.test\(value\.trim\(\)\)/);
  assert.doesNotMatch(settingsSource, /\["direct_monitor_app_catchup_enabled", "false", "true"\]/);
});

test("default settings preserve existing app catch-up values without bidirectional rewrites", () => {
  assert.match(
    settingsSource,
    /for \(const \[key, value, description\] of defaultSettings\) \{[\s\S]*?where: \{ key \},\s*update: \{\},\s*create: \{ key, value, description \}/
  );

  const rewritesStart = settingsSource.indexOf("const legacySettingRewrites");
  const ensureDefaultsStart = settingsSource.indexOf("export async function ensureDefaultSettings");
  const runtimeSettingsStart = settingsSource.indexOf("for (const [key, value, description] of runtimeSettings");
  assert.ok(rewritesStart >= 0 && ensureDefaultsStart > rewritesStart && runtimeSettingsStart > ensureDefaultsStart);
  assert.doesNotMatch(settingsSource.slice(rewritesStart, ensureDefaultsStart), /direct_monitor_app_catchup_enabled/);
  assert.doesNotMatch(settingsSource.slice(ensureDefaultsStart, runtimeSettingsStart), /direct_monitor_app_catchup_enabled/);
  assert.doesNotMatch(settingsSource, /Allow direct monitors to scan app\/helper\/ADB messages as a fallback/);
});

test("direct monitor schedules app catch-up after non-SMS push activity", () => {
  assert.match(monitorSource, /shouldScheduleAppCatchupForFrame\(liveState\)/);
  assert.match(monitorSource, /scheduleAppCatchup\("direct-frame-gap"\)/);
});
test("direct monitor serializes app fallback scans across accounts", () => {
  assert.match(monitorSource, /let appFallbackScanQueue = Promise\.resolve\(\)/);
  assert.match(monitorSource, /runSerializedAppFallbackScan/);
  assert.match(monitorSource, /appFallbackScanQueue = appFallbackScanQueue\.then\(run, run\)/);
  assert.match(
    monitorSource,
    /await runSerializedAppFallbackScan\(\(\) =>\s*this\.pollAppFallbackMessages\(runner, account\)\s*\)/
  );
});

test("app fallback only scans the account currently logged into the matching app", () => {
  assert.match(monitorSource, /exportSessionFromAdbConfig\(appVariant\)/);
  assert.match(monitorSource, /session\.dtUserId !== account\.dtUserId/);
  assert.match(monitorSource, /app-session-mismatch/);
});

test("UI catch-up keeps enough history to recover messages after downtime", () => {
  assert.match(monitorSource, /Date\.now\(\) - 7 \* 24 \* 60 \* 60_000/);
});
