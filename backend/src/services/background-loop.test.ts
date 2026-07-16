import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function loadBackgroundLoop() {
  const loaded = await import("./background-loop.js").catch((error: unknown) => ({ error }));
  assert.equal("error" in loaded, false, "background-loop module must exist");
  if ("error" in loaded) {
    throw loaded.error;
  }
  return loaded.BackgroundLoop;
}

test("stop during an in-flight cycle prevents rescheduling and permits a later restart", async () => {
  const BackgroundLoop = await loadBackgroundLoop();
  const firstStarted = deferred();
  const firstRelease = deferred();
  const secondStarted = deferred();
  const secondRelease = deferred();
  let runs = 0;

  const loop = new BackgroundLoop({
    initialDelayMs: 0,
    defaultDelayMs: 1,
    stopWaitTimeoutMs: 100,
    task: async () => {
      runs += 1;
      if (runs === 1) {
        firstStarted.resolve();
        await firstRelease.promise;
      } else if (runs === 2) {
        secondStarted.resolve();
        await secondRelease.promise;
      }
      return 1;
    }
  });

  loop.start();
  await firstStarted.promise;
  const firstStop = loop.stop();
  firstRelease.resolve();
  await firstStop;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs, 1);

  loop.start();
  await secondStarted.promise;
  const secondStop = loop.stop();
  secondRelease.resolve();
  await secondStop;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs, 2);
});

test("start and stop are idempotent while a cycle is running", async () => {
  const BackgroundLoop = await loadBackgroundLoop();
  const started = deferred();
  const release = deferred();
  let runs = 0;

  const loop = new BackgroundLoop({
    initialDelayMs: 0,
    defaultDelayMs: 1,
    stopWaitTimeoutMs: 100,
    task: async () => {
      runs += 1;
      started.resolve();
      await release.promise;
    }
  });

  loop.start();
  loop.start();
  await started.promise;
  const stopOne = loop.stop();
  const stopTwo = loop.stop();
  release.resolve();
  await Promise.all([stopOne, stopTwo]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs, 1);
});

test("periodic services delegate scheduling to the shared lifecycle loop", () => {
  for (const file of ["account-auto-refresh.ts", "phone-expiry-reminder.ts", "telegram-bot.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(source, /import \{ BackgroundLoop \} from "\.\/background-loop\.js";/, file);
    assert.match(source, /new BackgroundLoop\(/, file);
  }
});
