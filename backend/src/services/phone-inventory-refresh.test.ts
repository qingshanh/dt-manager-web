import assert from "node:assert/strict";
import test from "node:test";
import {
  PHONE_INVENTORY_SAFETY_REFRESH_MS,
  buildDirectPhoneInventoryIdentity,
  hasDirectPushPhonePurchaseNotice,
  hasPhonePurchaseNotice,
  shouldCommitDirectPhoneInventoryRefresh,
  shouldContinueDirectPhoneInventoryListen,
  shouldRefreshDirectPhoneInventoryAfterPoll,
  shouldRefreshPhoneInventory
} from "./phone-inventory-refresh.js";

test("phone inventory refreshes initially, after fifteen minutes, or immediately after a purchase notice", () => {
  const now = 1_800_000_000_000;

  assert.equal(shouldRefreshPhoneInventory({ now, lastRefreshAt: null, pendingPurchase: false }), true);
  assert.equal(
    shouldRefreshPhoneInventory({
      now,
      lastRefreshAt: now - PHONE_INVENTORY_SAFETY_REFRESH_MS + 1,
      pendingPurchase: false
    }),
    false
  );
  assert.equal(
    shouldRefreshPhoneInventory({
      now,
      lastRefreshAt: now - PHONE_INVENTORY_SAFETY_REFRESH_MS,
      pendingPurchase: false
    }),
    true
  );
  assert.equal(shouldRefreshPhoneInventory({ now, lastRefreshAt: now, pendingPurchase: true }), true);
});

test("recognizes native purchase secretary messages without treating ordinary SMS as inventory changes", () => {
  assert.equal(hasPhonePurchaseNotice([{ type: 1048578, content: "+32 470000001:900" }]), true);
  assert.equal(
    hasPhonePurchaseNotice([{
      conversationId: "10000",
      senderId: "说道团队",
      content: "+32 470000002:900"
    }]),
    true
  );
  assert.equal(
    hasPhonePurchaseNotice([{
      senderId: "Provider",
      content: "Your verification code is 123456"
    }]),
    false
  );
});

test("dedicated direct listening stops extending when inventory expires or a purchase is pending", () => {
  const now = 1_800_000_000_000;
  const base = {
    stopped: false,
    hasDedicatedSlots: true,
    now,
    lastRefreshAt: now - PHONE_INVENTORY_SAFETY_REFRESH_MS + 1,
    pendingPurchase: false
  };

  assert.equal(shouldContinueDirectPhoneInventoryListen(base), true);
  assert.equal(
    shouldContinueDirectPhoneInventoryListen({
      ...base,
      lastRefreshAt: now - PHONE_INVENTORY_SAFETY_REFRESH_MS
    }),
    false
  );
  assert.equal(
    shouldContinueDirectPhoneInventoryListen({
      ...base,
      pendingPurchase: true
    }),
    false
  );
});

test("a stopped runner never refreshes inventory after direct polling returns", () => {
  const now = 1_800_000_000_000;

  assert.equal(
    shouldRefreshDirectPhoneInventoryAfterPoll({
      stopped: true,
      listened: true,
      now,
      lastRefreshAt: null,
      pendingPurchase: true
    }),
    false
  );
  assert.equal(
    shouldRefreshDirectPhoneInventoryAfterPoll({
      stopped: false,
      listened: true,
      now,
      lastRefreshAt: null,
      pendingPurchase: true
    }),
    true
  );
});

test("a runner stopped during the inventory request cannot commit its result", () => {
  assert.equal(shouldCommitDirectPhoneInventoryRefresh({ stopped: false }), true);
  assert.equal(shouldCommitDirectPhoneInventoryRefresh({ stopped: true }), false);
});

test("real-time direct push msgType 1048578 marks phone inventory pending", () => {
  assert.equal(
    hasDirectPushPhonePurchaseNotice({
      msgType: 1048578,
      content: "inventory changed"
    }),
    true
  );
});

test("direct phone inventory identity preserves appVariant", () => {
  assert.deepEqual(
    buildDirectPhoneInventoryIdentity({
      dtUserId: "user-id",
      token: "token",
      deviceId: "device-id",
      appVariant: "dingdong"
    }),
    {
      dtUserId: "user-id",
      token: "token",
      deviceId: "device-id",
      appVariant: "dingdong"
    }
  );
});
