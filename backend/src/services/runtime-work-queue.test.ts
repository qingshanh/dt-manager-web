import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeWorkQueue } from "./runtime-work-queue.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("runtime work queue never exceeds configured concurrency", async () => {
  const queue = new RuntimeWorkQueue({ concurrency: 2, maxPending: 20 });
  let active = 0;
  let peak = 0;
  const gates = Array.from({ length: 6 }, () => deferred());
  const tasks = gates.map((gate, index) => queue.run(`task-${index}`, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
    return index;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  assert.deepEqual(queue.snapshot(), { active: 2, pending: 4, rejected: 0, stopped: false });

  for (const gate of gates) {
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0, rejected: 0, stopped: false });
});

test("duplicate keys share one in-flight or pending task", async () => {
  const queue = new RuntimeWorkQueue({ concurrency: 1, maxPending: 5 });
  const gate = deferred<number>();
  let calls = 0;
  const first = queue.run("account:1:refresh", async () => {
    calls += 1;
    return gate.promise;
  });
  const second = queue.run("account:1:refresh", async () => {
    calls += 1;
    return 999;
  });

  assert.equal(first, second);
  gate.resolve(42);
  assert.equal(await second, 42);
  assert.equal(calls, 1);
});

test("a completed key can be scheduled again immediately after await", async () => {
  const queue = new RuntimeWorkQueue({ concurrency: 1, maxPending: 5 });
  let calls = 0;
  assert.equal(await queue.run("repeat", async () => ++calls), 1);
  assert.equal(await queue.run("repeat", async () => ++calls), 2);
  assert.equal(calls, 2);
});

test("queue rejects overflow and rejects all new work after stop", async () => {
  const queue = new RuntimeWorkQueue({ concurrency: 1, maxPending: 1 });
  const activeGate = deferred();
  const active = queue.run("active", () => activeGate.promise);
  const pending = queue.run("pending", async () => undefined);

  await assert.rejects(queue.run("overflow", async () => undefined), /queue is full/i);
  assert.equal(queue.snapshot().rejected, 1);

  const pendingRejected = assert.rejects(pending, /stopped before execution/i);
  const stopped = queue.stop();
  await assert.rejects(queue.run("after-stop", async () => undefined), /stopped/i);
  assert.equal(queue.snapshot().rejected, 3);

  activeGate.resolve();
  await Promise.all([active, pendingRejected]);
  await stopped;
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0, rejected: 3, stopped: true });
});

test("stop resolves immediately when the queue is already idle", async () => {
  const queue = new RuntimeWorkQueue();
  await queue.stop();
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0, rejected: 0, stopped: true });
});
