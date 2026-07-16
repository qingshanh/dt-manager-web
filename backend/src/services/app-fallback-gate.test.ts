import assert from "node:assert/strict";
import test from "node:test";
import { AppFallbackProbeGate, resolveAppFallbackAllowed } from "./app-fallback-gate.js";

test("app fallback is denied unless explicitly enabled", () => {
  assert.equal(resolveAppFallbackAllowed(undefined), false);
  assert.equal(resolveAppFallbackAllowed("false"), false);
  assert.equal(resolveAppFallbackAllowed("0"), false);
  assert.equal(resolveAppFallbackAllowed("true"), true);
  assert.equal(resolveAppFallbackAllowed("1"), true);
});

test("concurrent accounts share one unavailable device probe and then observe cooldown", async () => {
  let now = 10_000;
  let probes = 0;
  const gate = new AppFallbackProbeGate({ cooldownMs: 5 * 60_000, now: () => now });
  const probe = async () => {
    probes += 1;
    await Promise.resolve();
    return null;
  };

  const results = await Promise.all(Array.from({ length: 9 }, () => gate.probe(probe)));
  assert.equal(probes, 1);
  assert.equal(results.filter((item) => item.status === "unavailable").length, 9);
  assert.equal(gate.snapshot().cooldownUntil, now + 5 * 60_000);

  const duringCooldown = await gate.probe(probe);
  assert.equal(duringCooldown.status, "cooldown");
  assert.equal(probes, 1);

  now += 5 * 60_000 + 1;
  await gate.probe(probe);
  assert.equal(probes, 2);
});

test("available probes do not start cooldown", async () => {
  const gate = new AppFallbackProbeGate({ cooldownMs: 300_000, now: () => 1_000 });
  const result = await gate.probe(async () => ({ dtUserId: "123" }));
  assert.equal(result.status, "available");
  assert.deepEqual(result.value, { dtUserId: "123" });
  assert.equal(gate.snapshot().cooldownUntil, 0);
});
