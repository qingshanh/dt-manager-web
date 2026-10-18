import assert from "node:assert/strict";
import test from "node:test";
import {
  isNightQuietHours,
  NIGHT_CYCLE_DELAY_MS,
  DAY_CYCLE_DELAY_MS,
  accountAutoRefreshService
} from "./account-auto-refresh.js";

test("isNightQuietHours returns true from 00:00 to 06:59 and false otherwise", () => {
  const midnight = new Date("2026-10-18T00:30:00");
  assert.equal(isNightQuietHours(midnight), true);

  const dawn = new Date("2026-10-18T06:59:59");
  assert.equal(isNightQuietHours(dawn), true);

  const morning = new Date("2026-10-18T07:00:00");
  assert.equal(isNightQuietHours(morning), false);

  const noon = new Date("2026-10-18T12:00:00");
  assert.equal(isNightQuietHours(noon), false);

  const evening = new Date("2026-10-18T23:59:59");
  assert.equal(isNightQuietHours(evening), false);
});

test("runCycle skips and returns NIGHT_CYCLE_DELAY_MS when called during night hours", async () => {
  const nightTime = new Date("2026-10-18T03:00:00");
  const delay = await accountAutoRefreshService.runCycle(nightTime);
  assert.equal(delay, NIGHT_CYCLE_DELAY_MS);
});
