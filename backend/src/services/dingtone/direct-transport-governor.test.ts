import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectTransportKey, DirectTransportGovernor } from "./direct-transport-governor.js";

test("transport governor applies bounded exponential backoff and opens after five shared failures", () => {
  let now = 1_000;
  const governor = new DirectTransportGovernor({ now: () => now, random: () => 0.5 });
  const key = "20.97.117.109:80";

  assert.deepEqual(governor.beforeAttempt(key, "push"), { allowed: true, waitMs: 0, probe: false });
  governor.recordFailure(key, "push");
  assert.deepEqual(governor.beforeAttempt(key, "link"), { allowed: false, waitMs: 500, probe: false });

  const expectedBackoffs = [1_000, 2_000, 4_000];
  for (const expected of expectedBackoffs) {
    now += governor.beforeAttempt(key, "push").waitMs;
    assert.equal(governor.beforeAttempt(key, "link").allowed, true);
    governor.recordFailure(key, "link");
    assert.equal(governor.beforeAttempt(key, "push").waitMs, expected);
  }

  now += governor.beforeAttempt(key, "push").waitMs;
  governor.recordFailure(key, "push");
  assert.deepEqual(governor.beforeAttempt(key, "discovery"), { allowed: false, waitMs: 30_000, probe: false });
});

test("transport governor allows only one half-open probe and success clears shared state", () => {
  let now = 0;
  const governor = new DirectTransportGovernor({ now: () => now, random: () => 0.5 });
  const key = "gateway:80";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    governor.recordFailure(key, attempt % 2 === 0 ? "push" : "link");
    const permit = governor.beforeAttempt(key, "push");
    if (attempt < 4) {
      now += permit.waitMs;
    }
  }

  now += 30_000;
  const owner = {};
  assert.deepEqual(governor.beforeAttempt(key, "push", owner), { allowed: true, waitMs: 0, probe: true });
  assert.deepEqual(governor.beforeAttempt(key, "push", owner), { allowed: false, waitMs: 500, probe: false });
  assert.deepEqual(governor.beforeAttempt(key, "link", owner), { allowed: true, waitMs: 0, probe: true });
  governor.recordSuccess(key, "link");
  assert.equal(governor.snapshot().size, 0);
  assert.deepEqual(governor.beforeAttempt(key, "push"), { allowed: true, waitMs: 0, probe: false });
  governor.recordFailure(key, "link");
  assert.deepEqual(governor.beforeAttempt(key, "link"), { allowed: false, waitMs: 500, probe: false });
});

test("one half-open paired probe can acquire push and link once without admitting duplicate workers", () => {
  let now = 0;
  const governor = new DirectTransportGovernor({ now: () => now, random: () => 0.5, openAfterFailures: 1, openDurationMs: 1_000 });
  const key = "paired-gateway:80";
  const ownerA = {};
  const ownerB = {};
  governor.recordFailure(key, "push");
  now = 1_000;
  assert.deepEqual(governor.beforeAttempt(key, "link", ownerA), { allowed: false, waitMs: 500, probe: false });
  assert.deepEqual(governor.beforeAttempt(key, "push", ownerA), { allowed: true, waitMs: 0, probe: true });
  assert.deepEqual(governor.beforeAttempt(key, "push", ownerB), { allowed: false, waitMs: 500, probe: false });
  assert.deepEqual(governor.beforeAttempt(key, "link", ownerB), { allowed: false, waitMs: 500, probe: false });
  assert.deepEqual(governor.beforeAttempt(key, "discovery", ownerA), { allowed: false, waitMs: 500, probe: false });
  assert.deepEqual(governor.beforeAttempt(key, "link", ownerA), { allowed: true, waitMs: 0, probe: true });
  assert.deepEqual(governor.beforeAttempt(key, "link", ownerA), { allowed: false, waitMs: 500, probe: false });
});

test("an authenticated link can initiate the half-open probe while its paired push socket remains open", () => {
  let now = 0;
  const governor = new DirectTransportGovernor({
    now: () => now,
    random: () => 0.5,
    openAfterFailures: 1,
    openDurationMs: 1_000
  });
  const key = "paired-link-recovery:80";
  const owner = {};

  governor.recordFailure(key, "link");
  now = 1_000;

  assert.deepEqual(
    (governor.beforeAttempt as any)(key, "link", owner, { allowLinkProbe: true }),
    { allowed: true, waitMs: 0, probe: true }
  );
});

test("abandoned half-open probe releases only its owner and retries after the minimum delay", () => {
  let now = 0;
  const governor = new DirectTransportGovernor({
    now: () => now,
    random: () => 0.5,
    minDelayMs: 100,
    openAfterFailures: 1,
    openDurationMs: 1_000
  });
  const key = "abandoned-probe:80";
  const ownerA = {};
  const ownerB = {};
  governor.recordFailure(key, "push");
  now = 1_000;

  assert.equal(governor.beforeAttempt(key, "push", ownerA).probe, true);
  governor.abandonProbe(key, ownerA);
  assert.deepEqual(governor.beforeAttempt(key, "push", ownerB), { allowed: false, waitMs: 100, probe: false });
  now += 100;
  assert.deepEqual(governor.beforeAttempt(key, "push", ownerB), { allowed: true, waitMs: 0, probe: true });
});

test("a different owner cannot abandon an active half-open probe", () => {
  let now = 0;
  const governor = new DirectTransportGovernor({
    now: () => now,
    random: () => 0.5,
    openAfterFailures: 1,
    openDurationMs: 1_000
  });
  const key = "owned-probe:80";
  const ownerA = {};
  const ownerB = {};
  governor.recordFailure(key, "push");
  now = 1_000;

  assert.equal(governor.beforeAttempt(key, "push", ownerA).probe, true);
  governor.abandonProbe(key, ownerB);
  assert.deepEqual(governor.beforeAttempt(key, "push", ownerB), { allowed: false, waitMs: 500, probe: false });
  assert.equal(governor.snapshot().entries[0]?.probeOwnerActive, true);
});

test("an expired half-open probe is cleared even when its worker never runs finally", () => {
  let now = 0;
  const governor = new DirectTransportGovernor({
    now: () => now,
    random: () => 0.5,
    openAfterFailures: 1,
    openDurationMs: 1_000,
    probeTimeoutMs: 750
  });
  const key = "expired-probe:80";
  governor.recordFailure(key, "push");
  now = 1_000;

  assert.equal(governor.beforeAttempt(key, "push", {}).probe, true);
  assert.equal(governor.snapshot().entries[0]?.probeExpiresAt, 1_750);
  now = 1_750;
  assert.deepEqual(governor.beforeAttempt(key, "push", {}), { allowed: true, waitMs: 0, probe: true });
});

test("failed half-open probe reopens the circuit and exponential delay is capped", () => {
  let now = 0;
  const governor = new DirectTransportGovernor({
    now: () => now,
    random: () => 0.5,
    openAfterFailures: 2,
    openDurationMs: 1_000,
    maxDelayMs: 2_000
  });
  const key = "gateway:80";
  governor.recordFailure(key, "push");
  now += 500;
  governor.recordFailure(key, "link");
  now += 1_000;
  assert.equal(governor.beforeAttempt(key, "push", {}).probe, true);
  governor.recordFailure(key, "push");
  assert.equal(governor.beforeAttempt(key, "link").waitMs, 1_000);

  governor.clear();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    governor.recordFailure(key, "push");
    const entry = governor.snapshot().entries[0];
    assert.ok((entry?.nextAttemptAt ?? now) - now <= 2_000 || entry?.state === "open");
    governor.clear();
  }
});

test("transport governor bounds entries, evicts the oldest item, and clear releases all state", () => {
  let now = 0;
  const governor = new DirectTransportGovernor({ now: () => now, random: () => 0.5 });
  for (let index = 0; index < 130; index += 1) {
    now = index;
    governor.recordFailure(`gateway-${index}:80`, "discovery");
  }
  const snapshot = governor.snapshot();
  assert.equal(snapshot.size, 128);
  assert.equal(snapshot.maxEntries, 128);
  assert.equal(snapshot.entries.some((entry) => entry.key === "gateway-0:80"), false);
  assert.equal(snapshot.entries.some((entry) => entry.key === "gateway-129:80"), true);
  governor.clear();
  assert.equal(governor.snapshot().size, 0);
});

test("transport keys redact proxy credentials and direct keys contain only host and port", () => {
  assert.equal(
    buildDirectTransportKey({
      host: "20.97.117.109",
      port: 80,
      proxyUrl: "http://private-user:private-password@proxy.example:3066/sensitive-path?token=secret"
    }),
    "proxy:http://proxy.example:3066->20.97.117.109:80"
  );
  assert.notEqual(
    buildDirectTransportKey({ host: "20.97.117.109", port: 80, proxyUrl: "http://proxy.example:3066" }),
    buildDirectTransportKey({ host: "206.189.228.89", port: 80, proxyUrl: "http://proxy.example:3066" })
  );
  assert.equal(buildDirectTransportKey({ host: "20.97.117.109", port: 80, proxyUrl: "" }), "20.97.117.109:80");
});

test("transport keys isolate accounts sharing one gateway without exposing account identity", () => {
  const accountA = "dingtone:account-433:user-145000000000001";
  const accountB = "dingtone:account-440:user-145000000000002";
  const keyA = buildDirectTransportKey({
    host: "20.97.117.109",
    port: 80,
    proxyUrl: "",
    accountScope: accountA
  } as any);
  const keyB = buildDirectTransportKey({
    host: "20.97.117.109",
    port: 80,
    proxyUrl: "",
    accountScope: accountB
  } as any);

  assert.notEqual(keyA, keyB);
  assert.doesNotMatch(keyA, /account-433|145000000000001/);
  assert.doesNotMatch(keyB, /account-440|145000000000002/);
});
