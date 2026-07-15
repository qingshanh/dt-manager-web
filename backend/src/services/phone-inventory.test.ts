import assert from "node:assert/strict";
import test from "node:test";
import { AccountStatus, AppVariant, PhoneStatus } from "@prisma/client";
import {
  buildPhoneInventoryPayload,
  buildPhoneInventoryWhere,
  extractPhoneInventoryMetadata,
  refreshPhoneInventoryAccounts
} from "./phone-inventory.js";

function inventoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    accountId: 20,
    phoneNumber: "3197005033038",
    countryCode: 31,
    providerId: 2006,
    displayName: "NL note",
    status: PhoneStatus.active,
    purchaseType: 2,
    payType: 2,
    validPeriodDays: 365,
    gainTime: "1780000000000",
    expiredTime: "1783296000000",
    autoRenew: true,
    isPrimary: false,
    isGoodNumber: false,
    portoutInfo: null,
    rawJson: JSON.stringify({
      packageServiceId: "DT03009",
      orderPrice: "250",
      isoCountryCode: "NL",
      cityName: "Amsterdam",
      stateName: "Noord-Holland",
      token: "must-not-leak"
    }),
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    account: {
      id: 20,
      nickname: "VMOS",
      appVariant: AppVariant.dingtone,
      status: AccountStatus.online,
      monitorEnabled: true,
      telegramNotify: true,
      sortOrder: 2
    },
    ...overrides
  };
}

test("phone inventory where clause is administrator scoped and applies every filter", () => {
  const where = buildPhoneInventoryWhere(3, {
    keyword: "20",
    status: PhoneStatus.active,
    countryCode: 31,
    providerId: 2006
  });

  assert.deepEqual(where.account, { is: { adminId: 3 } });
  assert.equal(where.status, PhoneStatus.active);
  assert.equal(where.countryCode, 31);
  assert.equal(where.providerId, 2006);
  assert.deepEqual(where.OR, [
    { phoneNumber: { contains: "20" } },
    { displayName: { contains: "20" } },
    { account: { is: { nickname: { contains: "20" } } } },
    { accountId: 20 }
  ]);
});

test("phone inventory groups by account sort order, serializes account fields, and hides raw JSON", () => {
  const payload = buildPhoneInventoryPayload(
    [
      inventoryRow(),
      inventoryRow({
        id: 2,
        accountId: 10,
        phoneNumber: "33700000000",
        countryCode: 33,
        providerId: 2100,
        expiredTime: "1783814400000",
        account: {
          id: 10,
          nickname: "France",
          appVariant: AppVariant.dingdong,
          status: AccountStatus.offline,
          monitorEnabled: false,
          telegramNotify: false,
          sortOrder: 1
        }
      })
    ],
    new Date("2026-07-01T00:00:00Z")
  );

  assert.deepEqual(payload.summary, {
    total: 2,
    active: 2,
    account_count: 2,
    expiring_soon: 2
  });
  assert.deepEqual(payload.groups.map((group) => group.account.id), [10, 20]);
  assert.deepEqual(payload.groups[0]?.account, {
    id: 10,
    nickname: "France",
    app_variant: AppVariant.dingdong,
    status: AccountStatus.offline,
    monitor_enabled: false,
    telegram_notify: false,
    sort_order: 1
  });

  const phone = payload.groups[1]?.phones[0];
  assert.equal(phone?.package_service_id, "DT03009");
  assert.equal(phone?.price, 250);
  assert.equal(phone?.iso_country_code, "NL");
  assert.equal(phone?.city_name, "Amsterdam");
  assert.equal(phone?.state_name, "Noord-Holland");
  assert.equal("raw_json" in (phone ?? {}), false);
  assert.equal("token" in (phone ?? {}), false);
});

test("phone inventory metadata extraction safely handles malformed JSON", () => {
  assert.deepEqual(extractPhoneInventoryMetadata("not-json"), {
    package_service_id: null,
    price: null,
    iso_country_code: null,
    city_name: null,
    state_name: null
  });
});

test("refresh all limits concurrency, skips missing sessions, and isolates failures", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await refreshPhoneInventoryAccounts(
    [
      { id: 1, dtUserId: "u1", dtToken: "t1" },
      { id: 2, dtUserId: "u2", dtToken: "t2" },
      { id: 3, dtUserId: null, dtToken: null },
      { id: 4, dtUserId: "u4", dtToken: "t4" }
    ],
    async (accountId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (accountId === 2) {
        throw new Error("refresh failed");
      }
      return [{ id: accountId }];
    },
    10
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(results.map((item) => item.status), ["success", "failed", "skipped", "success"]);
  assert.deepEqual(results[2], {
    account_id: 3,
    status: "skipped",
    phone_count: 0,
    error: "缺少有效 Direct 会话"
  });
  assert.equal(results[1]?.error, "refresh failed");
});
