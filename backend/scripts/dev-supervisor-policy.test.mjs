import assert from "node:assert/strict";
import test from "node:test";
import { FATAL_LISTEN_EXIT_CODE, nextRestartDecision } from "./dev-supervisor-policy.mjs";

test("listen permission and address conflicts are fatal", () => {
  assert.equal(FATAL_LISTEN_EXIT_CODE, 78);
  assert.deepEqual(nextRestartDecision({
    exits: [],
    now: 1_000,
    stableRunMs: 0,
    exitCode: FATAL_LISTEN_EXIT_CODE,
    stopping: false
  }), {
    restart: false,
    delayMs: 0,
    reason: "fatal",
    nextFailureCount: 0
  });
});

test("quick failures use bounded exponential backoff", () => {
  const expectedDelays = [1500, 3000, 6000, 12000, 30000];
  for (let index = 0; index < expectedDelays.length; index += 1) {
    const now = 10_000 + index * 1_000;
    const exits = Array.from({ length: index }, (_, previous) => 10_000 + previous * 1_000);
    const decision = nextRestartDecision({ exits, now, stableRunMs: 1_000, exitCode: 1, stopping: false });
    assert.equal(decision.restart, true);
    assert.equal(decision.delayMs, expectedDelays[index]);
    assert.equal(decision.reason, "retry");
    assert.equal(decision.nextFailureCount, index + 1);
  }
});

test("sixth quick failure inside sixty seconds opens the circuit", () => {
  const decision = nextRestartDecision({
    exits: [1_000, 2_000, 3_000, 4_000, 5_000],
    now: 6_000,
    stableRunMs: 2_000,
    exitCode: 1,
    stopping: false
  });
  assert.deepEqual(decision, {
    restart: false,
    delayMs: 0,
    reason: "circuit-breaker",
    nextFailureCount: 6
  });
});

test("a stable sixty-second run resets failure history", () => {
  const decision = nextRestartDecision({
    exits: [1_000, 2_000, 3_000, 4_000, 5_000],
    now: 120_000,
    stableRunMs: 60_000,
    exitCode: 1,
    stopping: false
  });
  assert.deepEqual(decision, {
    restart: true,
    delayMs: 1500,
    reason: "retry",
    nextFailureCount: 1
  });
});

test("shutdown never schedules a restart", () => {
  assert.deepEqual(nextRestartDecision({
    exits: [],
    now: 1_000,
    stableRunMs: 0,
    exitCode: 1,
    stopping: true
  }), {
    restart: false,
    delayMs: 0,
    reason: "stopping",
    nextFailureCount: 0
  });
});
