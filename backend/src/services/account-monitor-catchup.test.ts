import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const monitorSource = readFileSync(new URL("./account-monitor.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./settings.service.ts", import.meta.url), "utf8");

test("direct monitor enables app catch-up by default for intermittent SMS pushes", () => {
  assert.match(settingsSource, /\["direct_monitor_app_catchup_enabled", "true"/);
  assert.match(monitorSource, /parseBooleanSetting\(settings\.direct_monitor_app_catchup_enabled, true\)/);
});

test("direct monitor schedules app catch-up after non-SMS push activity", () => {
  assert.match(monitorSource, /shouldScheduleAppCatchupForFrame\(liveState\)/);
  assert.match(monitorSource, /scheduleAppCatchup\("direct-frame-gap"\)/);
});
test("direct monitor serializes app fallback scans across accounts", () => {
  assert.match(monitorSource, /let appFallbackScanQueue = Promise\.resolve\(\)/);
  assert.match(monitorSource, /runSerializedAppFallbackScan/);
  assert.match(monitorSource, /appFallbackScanQueue = appFallbackScanQueue\.then\(run, run\)/);
});