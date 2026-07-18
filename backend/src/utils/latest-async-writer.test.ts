import assert from "node:assert/strict";
import test from "node:test";
import { LatestAsyncWriter } from "./latest-async-writer.js";

type FakeTimer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
  unrefCalled: boolean;
  unref: () => void;
};

function createFakeClock() {
  let now = 0;
  const timers: FakeTimer[] = [];
  return {
    now: () => now,
    timers,
    setNow(value: number) {
      now = value;
    },
    setTimer(callback: () => void, delayMs: number) {
      const timer: FakeTimer = {
        callback,
        delayMs,
        cleared: false,
        unrefCalled: false,
        unref() {
          timer.unrefCalled = true;
        }
      };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle: ReturnType<typeof setTimeout>) {
      (handle as unknown as FakeTimer).cleared = true;
    },
    runLatestTimer() {
      const timer = [...timers].reverse().find((candidate) => !candidate.cleared);
      assert.ok(timer);
      timer.cleared = true;
      now += timer.delayMs;
      timer.callback();
      return timer;
    }
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("burst writes the first and latest values without overlapping sinks", async () => {
  const clock = createFakeClock();
  const values: string[] = [];
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  const writer = new LatestAsyncWriter<string>(async (value) => {
    values.push(value);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
  }, { minIntervalMs: 10_000, ...clock });

  writer.schedule("first");
  writer.schedule("middle");
  writer.schedule("latest");
  await settle();
  assert.deepEqual(values, ["first"]);
  releases.shift()?.();
  await settle();
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0]?.unrefCalled, true);
  clock.runLatestTimer();
  await settle();
  assert.deepEqual(values, ["first", "latest"]);
  assert.equal(maxActive, 1);
  releases.shift()?.();
  await writer.close();
});

test("immediate pending value runs as soon as the inflight sink finishes", async () => {
  const clock = createFakeClock();
  const values: string[] = [];
  const releases: Array<() => void> = [];
  const writer = new LatestAsyncWriter<string>(async (value) => {
    values.push(value);
    await new Promise<void>((resolve) => releases.push(resolve));
  }, { minIntervalMs: 10_000, ...clock });

  writer.schedule("first");
  writer.schedule("ordinary");
  writer.schedule("urgent", { immediate: true });
  releases.shift()?.();
  await settle();
  assert.deepEqual(values, ["first", "urgent"]);
  assert.equal(clock.timers.length, 0);
  releases.shift()?.();
  await writer.close();
});

test("flush bypasses the timer and persists only the latest pending value", async () => {
  const clock = createFakeClock();
  const values: string[] = [];
  const writer = new LatestAsyncWriter<string>(async (value) => {
    values.push(value);
  }, { minIntervalMs: 10_000, ...clock });

  writer.schedule("first");
  await settle();
  writer.schedule("middle");
  writer.schedule("latest");
  await settle();
  assert.equal(clock.timers.length, 1);
  await writer.flush();
  assert.deepEqual(values, ["first", "latest"]);
  assert.equal(clock.timers[0]?.cleared, true);
  await writer.close();
});

test("sink failure does not prevent a later value from being written", async () => {
  const clock = createFakeClock();
  const values: string[] = [];
  const writer = new LatestAsyncWriter<string>(async (value) => {
    values.push(value);
    if (value === "first") {
      throw new Error("expected sink failure");
    }
  }, { minIntervalMs: 10_000, ...clock });

  writer.schedule("first");
  await settle();
  writer.schedule("second", { immediate: true });
  await writer.flush();
  assert.deepEqual(values, ["first", "second"]);
  await writer.close();
});

test("close clears timers, waits for the final value, and rejects new schedules", async () => {
  const clock = createFakeClock();
  const values: string[] = [];
  const releases: Array<() => void> = [];
  const writer = new LatestAsyncWriter<string>(async (value) => {
    values.push(value);
    await new Promise<void>((resolve) => releases.push(resolve));
  }, { minIntervalMs: 10_000, ...clock });

  writer.schedule("first");
  writer.schedule("final");
  const closed = writer.close();
  let closeResolved = false;
  void closed.then(() => {
    closeResolved = true;
  });
  await settle();
  assert.equal(closeResolved, false);
  releases.shift()?.();
  await settle();
  assert.deepEqual(values, ["first", "final"]);
  releases.shift()?.();
  await closed;
  assert.throws(() => writer.schedule("after-close"), /closed/i);
});

test("flush with a value replaces pending work and writes it immediately", async () => {
  const clock = createFakeClock();
  const values: string[] = [];
  const writer = new LatestAsyncWriter<string>(async (value) => {
    values.push(value);
  }, { minIntervalMs: 10_000, ...clock });

  writer.schedule("first");
  await settle();
  writer.schedule("stale");
  await writer.flush("final");
  assert.deepEqual(values, ["first", "final"]);
  await writer.close();
});
