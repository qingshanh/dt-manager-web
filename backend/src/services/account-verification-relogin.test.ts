import assert from "node:assert/strict";
import test from "node:test";
import { AccountStatus, AppVariant, LoginType } from "@prisma/client";
import {
  completeAccountVerificationRelogin,
  requestAccountVerificationRelogin,
  type AccountVerificationReloginDeps
} from "./account-verification-relogin.js";

function account() {
  return {
    id: 446,
    adminId: 1,
    loginType: LoginType.email_code,
    appVariant: AppVariant.dingtone,
    email: "owner@example.com",
    phone: null,
    dtUserId: "existing-user",
    dtDeviceId: "old-device",
    dtTrackCode: "old-track",
    status: AccountStatus.expired
  };
}

test("verification relogin stores the new challenge and rolls back a failed send", async () => {
  const current = account();
  const writes: Array<Record<string, unknown>> = [];
  const deps: AccountVerificationReloginDeps = {
    loadAccount: async () => current,
    createDeviceId: () => "new-device",
    createTrackCode: () => "new-track",
    updateAccount: async (_id, data) => { writes.push(data); },
    sendVerificationCode: async () => { throw new Error("send failed"); },
    login: async () => { throw new Error("unused"); },
    persistSession: async () => undefined,
    refreshAccount: async () => undefined,
    startMonitor: async () => undefined
  };

  await assert.rejects(() => requestAccountVerificationRelogin(446, deps), /send failed/);
  assert.deepEqual(writes, [
    { dtDeviceId: "new-device", dtTrackCode: "new-track", lastError: null },
    { dtDeviceId: "old-device", dtTrackCode: "old-track", appVariant: AppVariant.dingtone, lastError: "send failed" }
  ]);
});

test("verification relogin verifies the original account and restores monitoring", async () => {
  const current = account();
  const calls: string[] = [];
  const deps: AccountVerificationReloginDeps = {
    loadAccount: async () => current,
    createDeviceId: () => "unused",
    createTrackCode: () => "unused",
    updateAccount: async () => undefined,
    sendVerificationCode: async () => ({ message: "sent" }),
    login: async (input) => {
      assert.equal(input.verificationCode, "6386");
      return { dtUserId: "existing-user", token: "new-token", deviceId: "new-device" };
    },
    persistSession: async () => { calls.push("persist"); },
    refreshAccount: async () => { calls.push("refresh"); },
    startMonitor: async () => { calls.push("monitor"); }
  };

  const result = await completeAccountVerificationRelogin(446, "6386", deps);
  assert.deepEqual(result, { accountId: 446, monitorStarted: true, monitorError: null });
  assert.deepEqual(calls, ["persist", "refresh", "monitor"]);
});

test("verification relogin rejects a code that authenticates another remote account", async () => {
  const deps: AccountVerificationReloginDeps = {
    loadAccount: async () => account(),
    createDeviceId: () => "unused",
    createTrackCode: () => "unused",
    updateAccount: async () => undefined,
    sendVerificationCode: async () => ({ message: "sent" }),
    login: async () => ({ dtUserId: "different-user", token: "new-token" }),
    persistSession: async () => assert.fail("must not persist a mismatched session"),
    refreshAccount: async () => undefined,
    startMonitor: async () => undefined
  };

  await assert.rejects(() => completeAccountVerificationRelogin(446, "6386", deps), /does not match/);
});
