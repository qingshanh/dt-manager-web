import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transferMonitorRunnerInPlace } from "./account-monitor-runner-transfer.js";

type TestRunner = {
  accountId: number;
  timer: { id: string } | null;
  running: boolean;
  stopped: boolean;
  sessionId: number;
  pollIntervalMs: number;
};

test("transfers an in-flight runner by identity so a target stop reaches the old reference", () => {
  const oldReference: TestRunner = {
    accountId: 1,
    timer: { id: "source" },
    running: true,
    stopped: false,
    sessionId: 101,
    pollIntervalMs: 30_000,
  };
  const runners = new Map<number, TestRunner>([[1, oldReference]]);
  const cleared: string[] = [];
  let scheduled = 0;

  const transferred = transferMonitorRunnerInPlace(runners, 1, 2, {
    clearTimer: (timer) => cleared.push(timer.id),
    schedule: () => {
      scheduled += 1;
    },
  });

  assert.strictEqual(transferred.transferredRunner, oldReference);
  assert.equal(transferred.replacedRunner, null);
  assert.strictEqual(runners.get(2), oldReference);
  assert.equal(runners.has(1), false);
  assert.equal(oldReference.accountId, 2);
  assert.equal(oldReference.timer, null);
  assert.deepEqual(cleared, ["source"]);
  assert.equal(scheduled, 0);

  runners.get(2)!.stopped = true;
  assert.equal(oldReference.stopped, true);
});

test("stops and clears an existing target runner before replacing it", () => {
  const source: TestRunner = {
    accountId: 1,
    timer: null,
    running: false,
    stopped: false,
    sessionId: 102,
    pollIntervalMs: 30_000,
  };
  const existingTarget: TestRunner = {
    accountId: 2,
    timer: { id: "target" },
    running: true,
    stopped: false,
    sessionId: 202,
    pollIntervalMs: 30_000,
  };
  const runners = new Map<number, TestRunner>([
    [1, source],
    [2, existingTarget],
  ]);
  const cleared: string[] = [];
  let scheduled = 0;

  const transferred = transferMonitorRunnerInPlace(runners, 1, 2, {
    clearTimer: (timer) => cleared.push(timer.id),
    schedule: () => {
      scheduled += 1;
    },
  });

  assert.equal(existingTarget.stopped, true);
  assert.equal(existingTarget.timer, null);
  assert.deepEqual(cleared, ["target"]);
  assert.strictEqual(runners.get(2), source);
  assert.strictEqual(transferred.replacedRunner, existingTarget);
  assert.equal(transferred.replacedRunner?.sessionId, 202);
  assert.equal(scheduled, 1);
});

test("account monitor persists a replaced runner session as stopped", () => {
  const source = readFileSync(new URL("./account-monitor.ts", import.meta.url), "utf8");
  const start = source.indexOf("async transferHeartbeat(");
  const end = source.indexOf("async restoreEnabled()", start);
  const block = source.slice(start, end);

  assert.match(block, /await prisma\.monitorSession\.updateMany/);
  assert.match(block, /id: replacedRunner\.sessionId/);
  assert.match(block, /status: \{ in: \[MonitorStatus\.running, MonitorStatus\.error\] \}/);
  assert.match(block, /status: MonitorStatus\.stopped/);
  assert.match(block, /stoppedAt: new Date\(\)/);
});
