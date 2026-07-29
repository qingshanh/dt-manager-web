import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildEdgeOrderPrivateNumberQueryForTest,
  buildOrderPrivateNumberQueriesForTest,
  buildPhonePurchaseLockQueryForTest
} from "./direct-gateway.js";

const source = readFileSync(new URL("./direct-gateway.ts", import.meta.url), "utf8");

function directGatewayMethodBody(name: string) {
  const start = source.indexOf(`async ${name}(`);
  assert.notEqual(start, -1);
  const nextMethod = source.indexOf("\n  async ", start + 1);
  return source.slice(start, nextMethod < 0 ? undefined : nextMethod);
}

test("builds one native first-purchase orderPrivateNumber query", () => {
  const queries = buildOrderPrivateNumberQueriesForTest({
    account: {
      dtUserId: "test-user",
      token: "test-token",
      deviceId: "And.test.dttalk"
    },
    phone: {
      phoneNumber: "+32470123456",
      countryCode: 32,
      isoCountryCode: "BE",
      areaCode: 2,
      category: 0,
      providerId: 2002,
      packageServiceId: "DT03001",
      productId: "preview-product-id"
    },
    options: {
      countryCode: 32,
      isoCountryCode: "BE",
      countryKey: "BE",
      payFlag: 2
    }
  });

  assert.deepEqual(queries, [
    "token=test-token&deviceId=And.test.dttalk&userId=test-user&countryCode=32&areaCode=2&phoneNumber=32470123456&type=2&payFlag=2&payYears=1&coupon=&specialNumber=0&callplanId=0&providerId=2002&packageServiceId=DT03001&simCC=&simu=0&extraChargeMonthsCount=0&apiVersion=4&buyCredit=1"
  ]);
  assert.equal(new URLSearchParams(queries[0]).has("productId"), false);
});

test("direct purchase sends the App-observed Edge orderPrivateNumber request after locking", () => {
  const body = directGatewayMethodBody("purchasePhoneNumber");

  assert.match(body, /buildPhonePurchaseLockQuery/);
  assert.match(body, /callEdgeRestJson\("phone purchase lock"/);
  assert.match(body, /buildEdgeOrderPrivateNumberQuery\(payload\.candidate/);
  assert.match(body, /callEdgeOrderPrivateNumberJson\(query, PHONE_PURCHASE_ORDER_TIMEOUT_MS\)/);
  assert.doesNotMatch(body, /buildOrderPrivateNumberQuery\(account, payload\.candidate/);
  assert.doesNotMatch(body, /callOrderPrivateNumberJson/);
});

test("single-write phone sessions reproduce the App pre-registration private-number prime", () => {
  const body = directGatewayMethodBody("withSingleWriteRegisteredSession");

  assert.match(
    body,
    /await runPushMaintenanceCalls\(session, runtime, account, true\);[\s\S]*await runPushLinkRegistration\(session, runtime, account\)/
  );
  assert.match(body, /return await handler\(session, markWritten\)/);
});

test("uses the native former-number branch without extra charge months", () => {
  const [query] = buildOrderPrivateNumberQueriesForTest({
    account: {
      dtUserId: "test-user",
      token: "test-token",
      deviceId: "And.test.dttalk"
    },
    phone: {
      phoneNumber: "+12135550123",
      countryCode: 1,
      isoCountryCode: "US",
      providerId: 2000,
      packageServiceId: "DT01001",
      rawJson: JSON.stringify({ formerPhoneNumber: "12135550999", callPlanId: 7, simCC: "310" })
    },
    options: {
      countryCode: 1,
      isoCountryCode: "US",
      countryKey: "US",
      payFlag: 3
    }
  });
  const params = new URLSearchParams(query);

  assert.equal(params.get("type"), "0");
  assert.equal(params.get("payFlag"), "3");
  assert.equal(params.get("coupon"), "");
  assert.equal(params.get("callplanId"), "7");
  assert.equal(params.get("oldPhoneNum"), "12135550999");
  assert.equal(params.get("simCC"), "310");
  assert.equal(params.has("extraChargeMonthsCount"), false);
  assert.equal(params.get("apiVersion"), "4");
});

test("matches the App manual three-month renewal fields", () => {
  const body = directGatewayMethodBody("renewPhoneNumberMutation");
  const dryRunStart = source.indexOf("async buildPhoneActionDryRuns");
  const dryRunEnd = source.indexOf("\n  private async callDirectPhoneAction", dryRunStart);
  const dryRun = source.slice(dryRunStart, dryRunEnd);
  assert.match(body, /extraChargeMonthsCount: resolvePhoneRenewalExtraChargeMonths\(extensionMonths\)/);
  assert.match(body, /commandTag: resolvePhoneRenewalCommandTag\(extensionMonths\)/);
  assert.match(dryRun, /extraChargeMonthsCount: resolvePhoneRenewalExtraChargeMonths\(resolvePhoneRenewalMonths\(context\)\)/);

  const [query] = buildOrderPrivateNumberQueriesForTest({
    account: {
      dtUserId: "test-user",
      token: "test-token",
      deviceId: "And.test.dttalk"
    },
    phone: {
      phoneNumber: "+32470123456",
      countryCode: 32,
      isoCountryCode: "BE",
      providerId: 2600,
      packageServiceId: "DT06012",
      status: "active",
      rawJson: JSON.stringify({ payType: 2 })
    },
    options: {
      countryCode: 32,
      isoCountryCode: "BE",
      countryKey: "BE",
      payFlag: 3,
      extraChargeMonthsCount: 0
    }
  });
  const params = new URLSearchParams(query);

  assert.equal(params.get("type"), "0");
  assert.equal(params.get("payFlag"), "3");
  assert.equal(params.get("extraChargeMonthsCount"), "0");
});

test("keeps the App yearly renewal extra-charge fields", () => {
  const [query] = buildOrderPrivateNumberQueriesForTest({
    account: {
      dtUserId: "test-user",
      token: "test-token",
      deviceId: "And.test.dttalk"
    },
    phone: {
      phoneNumber: "+447700900123",
      countryCode: 44,
      isoCountryCode: "GB",
      providerId: 2600,
      packageServiceId: "DT06012",
      status: "active",
      rawJson: JSON.stringify({ payType: 2 })
    },
    options: {
      countryCode: 44,
      isoCountryCode: "GB",
      countryKey: "GB",
      payFlag: 3,
      extraChargeMonthsCount: 12
    }
  });

  assert.equal(new URLSearchParams(query).get("extraChargeMonthsCount"), "12");
});

test("uses native candidate type for first-purchase orderPrivateNumber query", () => {
  const [query] = buildOrderPrivateNumberQueriesForTest({
    account: {
      dtUserId: "test-user",
      token: "test-token",
      deviceId: "And.test.dttalk"
    },
    phone: {
      phoneNumber: "+319701234567",
      countryCode: 31,
      isoCountryCode: "NL",
      areaCode: 97,
      providerId: 2006,
      packageServiceId: "DT03005",
      rawJson: JSON.stringify({ type: 0, category: 0 })
    },
    options: {
      countryCode: 31,
      isoCountryCode: "NL",
      countryKey: "NL",
      payFlag: 2
    }
  });

  const params = new URLSearchParams(query);
  assert.equal(params.get("type"), "0");
  assert.equal(params.get("specialNumber"), "0");
});

test("builds App-shaped phone purchase lock params without account credentials", () => {
  const query = buildPhonePurchaseLockQueryForTest({
    phone: {
      phoneNumber: "+319701234567",
      countryCode: 31,
      isoCountryCode: "NL",
      providerId: 2006,
      packageServiceId: "DT03005",
      rawJson: JSON.stringify({ type: 2, category: 0 })
    },
    options: {
      countryCode: 31,
      isoCountryCode: "NL",
      countryKey: "NL"
    }
  });
  const params = new URLSearchParams(query);

  assert.equal(params.get("phoneNumber"), "319701234567");
  assert.equal(params.get("countryCode"), "31");
  assert.equal(params.get("providerId"), "2006");
  assert.equal(params.has("token"), false);
  assert.equal(params.has("deviceId"), false);
  assert.equal(params.has("userId"), false);
});

test("builds App-shaped credit purchase order params with product id and default sim country", () => {
  const query = buildEdgeOrderPrivateNumberQueryForTest({
    phone: {
      phoneNumber: "+32470123456",
      countryCode: 32,
      isoCountryCode: "BE",
      areaCode: 2,
      providerId: 2002,
      packageServiceId: "DT03001",
      productId: "preview-product-id",
      rawJson: JSON.stringify({ type: 2, category: 0 })
    },
    options: {
      countryCode: 32,
      isoCountryCode: "BE",
      countryKey: "BE"
    }
  });
  const params = new URLSearchParams(query);

  assert.equal(query, [
    "countryCode=32",
    "areaCode=2",
    "phoneNumber=32470123456",
    "type=2",
    "payFlag=2",
    "payYears=1",
    "specialNumber=0",
    "packageServiceId=DT03001",
    "providerId=2002",
    "simCC=CN",
    "simu=0",
    "apiVersion=3",
    "buyCredit=1",
    "productId=preview-product-id"
  ].join("&"));
  assert.equal(params.has("token"), false);
  assert.equal(params.has("deviceId"), false);
  assert.equal(params.has("userId"), false);
  assert.equal(params.has("callplanId"), false);
  assert.equal(params.has("extraChargeMonthsCount"), false);
});

test("rejects App-shaped credit purchase order params without product id", () => {
  assert.throws(
    () =>
      buildEdgeOrderPrivateNumberQueryForTest({
        phone: {
          phoneNumber: "+319701234567",
          countryCode: 31,
          isoCountryCode: "NL",
          providerId: 2006,
          packageServiceId: "DT03005",
          rawJson: JSON.stringify({ type: 2, category: 0 })
        },
        options: {
          countryCode: 31,
          isoCountryCode: "NL",
          countryKey: "NL"
        }
      }),
    /productId/
  );
});
