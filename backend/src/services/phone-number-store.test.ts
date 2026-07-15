import assert from "node:assert/strict";
import test from "node:test";
import { PhoneStatus } from "@prisma/client";
import {
  mapPhoneNumberCreate,
  mapPhoneNumberPatch,
  syncPhoneNumbersWithStore
} from "./phone-number-store.js";

test("phone number mapping preserves the existing create and patch behavior", () => {
  const rawJson = JSON.stringify({ packageServiceId: "DT03009" });
  const created = mapPhoneNumberCreate(7, {
    phoneNumber: "33700000000",
    countryCode: 33,
    providerId: 2100,
    displayName: "France",
    status: PhoneStatus.active,
    purchaseType: 2,
    payType: 2,
    validPeriodDays: 365,
    gainTime: "1780000000000",
    expiredTime: "1811536000000",
    autoRenew: true,
    isPrimary: false,
    isGoodNumber: false,
    rawJson
  });

  assert.equal(created.accountId, 7);
  assert.equal(created.phoneNumber, "33700000000");
  assert.equal(created.providerId, 2100);
  assert.equal(created.rawJson, rawJson);

  const patched = mapPhoneNumberPatch({ phoneNumber: "ignored-by-patch" });
  assert.equal(patched.autoRenew, false);
  assert.equal(patched.isPrimary, false);
  assert.equal(patched.isGoodNumber, false);
  assert.equal(typeof patched.rawJson, "string");
});

test("phone synchronization upserts remote rows and never deletes omitted local rows", async () => {
  const upserts: unknown[] = [];
  const countCalls: unknown[] = [];
  const result = await syncPhoneNumbersWithStore(
    7,
    [{ phoneNumber: "33700000000", status: "active" }],
    {
      upsert: async (args) => {
        upserts.push(args);
        return {};
      },
      count: async (args) => {
        countCalls.push(args);
        return 2;
      }
    }
  );

  assert.equal(upserts.length, 1);
  assert.equal(countCalls.length, 1);
  assert.deepEqual(countCalls[0], {
    where: { accountId: 7, phoneNumber: { notIn: ["33700000000"] } }
  });
  assert.deepEqual(result, { persisted: 1, missingLocalCount: 2 });
});

test("phone synchronization ignores invalid remote rows without destructive store calls", async () => {
  let upsertCount = 0;
  let countCount = 0;
  const result = await syncPhoneNumbersWithStore(
    7,
    [{ phoneNumber: "" }],
    {
      upsert: async () => {
        upsertCount += 1;
        return {};
      },
      count: async () => {
        countCount += 1;
        return 0;
      }
    }
  );

  assert.equal(upsertCount, 0);
  assert.equal(countCount, 0);
  assert.deepEqual(result, { persisted: 0, missingLocalCount: 0 });
});
