import assert from "node:assert/strict";
import test from "node:test";

type RenewalSequence = <TBalance, TResult>(input: {
  refreshBalance: () => Promise<TBalance>;
  isBalanceConfirmed: (balance: TBalance) => boolean;
  writeOrder: () => Promise<TResult>;
}) => Promise<TResult>;

const sequenceModule = await import("./phone-renewal-session.js").catch(() => ({}));
const runSequence = (sequenceModule as { runPhoneRenewalSession?: RenewalSequence }).runPhoneRenewalSession;

test("renewal confirms balance and writes the order on the same prepared session", async () => {
  assert.equal(typeof runSequence, "function");
  if (!runSequence) return;

  const events: string[] = [];
  const result = await runSequence({
    refreshBalance: async () => {
      events.push("balance");
      return { primaryBalance: 11_544.46 };
    },
    isBalanceConfirmed: (balance) => balance.primaryBalance > 0,
    writeOrder: async () => {
      events.push("order");
      return { Result: 1 };
    }
  });

  assert.deepEqual(events, ["balance", "order"]);
  assert.deepEqual(result, { Result: 1 });
});

test("renewal never reaches the write boundary when the same-session balance is unconfirmed", async () => {
  assert.equal(typeof runSequence, "function");
  if (!runSequence) return;

  let writes = 0;
  await assert.rejects(
    runSequence({
      refreshBalance: async () => ({ refreshError: "socket ended" }),
      isBalanceConfirmed: () => false,
      writeOrder: async () => {
        writes += 1;
        return { Result: 1 };
      }
    }),
    /same-session balance/i
  );
  assert.equal(writes, 0);
});
