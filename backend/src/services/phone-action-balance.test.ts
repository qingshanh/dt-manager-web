import assert from "node:assert/strict";
import test from "node:test";

type BalanceResolver = (input: {
  cachedBalance: number | null;
  requireFresh: boolean;
  refresh: () => Promise<number | null | undefined>;
}) => Promise<number | null>;

const balanceModule = await import("./phone-action-balance.js").catch(() => ({}));
const resolveBalance = (balanceModule as { resolvePhoneActionBalanceEvidence?: BalanceResolver })
  .resolvePhoneActionBalanceEvidence;

test("a paid phone action refuses a stale cached balance when live refresh fails", async () => {
  assert.equal(typeof resolveBalance, "function");
  if (!resolveBalance) return;

  const balance = await resolveBalance({
    cachedBalance: 13_663.46,
    requireFresh: true,
    refresh: async () => {
      throw new Error("socket ended");
    }
  });

  assert.equal(balance, null);
});

test("non-writing diagnostics may still use the cached balance after a refresh failure", async () => {
  assert.equal(typeof resolveBalance, "function");
  if (!resolveBalance) return;

  const balance = await resolveBalance({
    cachedBalance: 13_663.46,
    requireFresh: false,
    refresh: async () => {
      throw new Error("socket ended");
    }
  });

  assert.equal(balance, 13_663.46);
});

test("a live balance always replaces an older cached value", async () => {
  assert.equal(typeof resolveBalance, "function");
  if (!resolveBalance) return;

  const balance = await resolveBalance({
    cachedBalance: 13_663.46,
    requireFresh: true,
    refresh: async () => 11_544.46
  });

  assert.equal(balance, 11_544.46);
});
