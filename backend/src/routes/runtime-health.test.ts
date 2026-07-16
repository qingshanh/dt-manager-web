import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildHealthPayload } from "../services/runtime-health.js";

const configSource = readFileSync(new URL("../config.ts", import.meta.url), "utf8");

test("runtime config accepts an optional launcher instance id", () => {
  assert.match(configSource, /DT_RUNTIME_INSTANCE_ID:\s*z\.string\(\)\.optional\(\)\.default\(""\)/);
});

test("health payload identifies the exact process instance without exposing process details", () => {
  const payload = buildHealthPayload({
    version: "0.2.8",
    gatewayMode: "direct",
    instanceId: "instance-a",
    startedAt: new Date("2026-07-16T00:00:00.000Z"),
    now: new Date("2026-07-16T00:00:05.900Z")
  });

  assert.deepEqual(payload, {
    ok: true,
    version: "0.2.8",
    gatewayMode: "direct",
    instanceId: "instance-a",
    startedAt: "2026-07-16T00:00:00.000Z",
    uptimeSeconds: 5
  });
  assert.equal("pid" in payload, false);
  assert.equal("commandLine" in payload, false);
  assert.equal("env" in payload, false);
});

test("health payload returns null instance id and clamps negative uptime", () => {
  const payload = buildHealthPayload({
    version: "0.2.8",
    gatewayMode: "mock",
    instanceId: "",
    startedAt: new Date("2026-07-16T00:00:05.000Z"),
    now: new Date("2026-07-16T00:00:00.000Z")
  });

  assert.equal(payload.instanceId, null);
  assert.equal(payload.uptimeSeconds, 0);
});
