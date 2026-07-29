import assert from "node:assert/strict";
import test from "node:test";
import {
  getOrCreateAccountRequest,
  isCurrentAccountRequest
} from "../frontend/src/utils/account-request.js";

test("account-scoped request helper shares in-flight work and clears it after completion", async () => {
  const requests = new Map<number, Promise<string>>();
  let calls = 0;
  let resolveRequest!: (value: string) => void;
  const createRequest = () => {
    calls += 1;
    return new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });
  };

  const first = getOrCreateAccountRequest(requests, 446, createRequest);
  const second = getOrCreateAccountRequest(requests, 446, createRequest);

  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  resolveRequest("done");
  assert.equal(await first, "done");
  await Promise.resolve();
  assert.equal(requests.size, 0);
});

test("only the latest request for the active account may commit", () => {
  const firstA = { accountId: 446, generation: 0 };
  const accountB = { accountId: 447, generation: 1 };
  const secondA = { accountId: 446, generation: 2 };

  assert.equal(isCurrentAccountRequest(firstA, firstA, 7, 7), true);
  assert.equal(isCurrentAccountRequest(accountB, firstA, 7, 7), false);
  assert.equal(isCurrentAccountRequest(secondA, firstA, 7, 7), false);
  assert.equal(isCurrentAccountRequest(secondA, secondA, 8, 7), false);
});

test("account-scoped request helper clears rejected work", async () => {
  const requests = new Map<number, Promise<string>>();
  const request = getOrCreateAccountRequest(requests, 446, async () => {
    throw new Error("expected failure");
  });

  await assert.rejects(request, /expected failure/);
  await Promise.resolve();
  assert.equal(requests.size, 0);
});
