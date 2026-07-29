import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRequestPrivateNumberQueriesForTest,
  normalizePhoneCountryOptionsForTest,
  staticPhoneCountryOptionsForTest
} from "./direct-gateway.js";

test("keeps every country returned by the live TalkU country endpoint", () => {
  const countries = normalizePhoneCountryOptionsForTest({
    Result: 1,
    data: {
      recommend: [{ cc: "1-CA", name: "Canada" }],
      bestSell: [{ cc: "44", name: "United Kingdom" }],
      other: [
        { cc: "55", name: "Brazil" },
        { cc: "358", name: "Finland" },
        { cc: "57", name: "Colombia" },
        { cc: "370", name: "Lithuania" }
      ]
    }
  });

  assert.deepEqual(
    countries.map((item) => item.isoCountryCode),
    ["CA", "GB", "BR", "FI", "CO", "LT"]
  );
});

test("static fallback mirrors the 26 countries currently exposed by TalkU", () => {
  const countries = staticPhoneCountryOptionsForTest();
  assert.equal(countries.length, 26);
  assert.deepEqual(
    new Set(countries.map((item) => item.isoCountryCode)),
    new Set([
      "AT", "AU", "BR", "BE", "PR", "PL", "DK", "FR", "FI", "CO", "NL", "CA", "CZ",
      "LT", "RO", "US", "MX", "NO", "SE", "CH", "ES", "HU", "IL", "IT", "GB", "CL"
    ])
  );
});

test("builds the native authenticated CommonRest requestPrivateNumber query for Australia", () => {
  const queries = buildRequestPrivateNumberQueriesForTest({
    countryCode: 61,
    isoCountryCode: "AU",
    appVersion: "6.3.1"
  });

  assert.deepEqual(queries, [
    "deviceId=And.test.dttalk&TrackCode=40051185300000003&&countryCode=61&providerList=2008&isoCountryCode=AU&clientversion=6.3.1&supportCA=1&useStateCity=0&apiVersion=5&forceCheckNearByType=0&needToPay=true&appVersion=6.3.1&apkCertificateSign=458cf4f3e576f61a26187d218e4af9d3&userId=test-user&token=test-token"
  ]);
  assert.equal(queries[0]?.includes("&&"), true);
});

test("uses the App null-provider shape for dynamically configured countries", () => {
  const queries = buildRequestPrivateNumberQueriesForTest({
    countryCode: 55,
    isoCountryCode: "BR",
    appVersion: "6.3.1"
  });

  assert.deepEqual(queries, [
    "deviceId=And.test.dttalk&TrackCode=40051185300000003&&countryCode=55&providerList=null&isoCountryCode=BR&clientversion=6.3.1&supportCA=1&useStateCity=0&apiVersion=5&forceCheckNearByType=0&needToPay=true&appVersion=6.3.1&apkCertificateSign=458cf4f3e576f61a26187d218e4af9d3&userId=test-user&token=test-token"
  ]);
});

test("uses a configured random US area code when the request omits one", () => {
  const [query] = buildRequestPrivateNumberQueriesForTest({
    countryCode: 1,
    isoCountryCode: "US",
    appVersion: "6.3.1"
  });
  assert.ok(query);
  const areaCode = Number(new URLSearchParams(query.replace(/^&+/, "")).get("areaCode"));

  assert.ok([213, 646, 312, 415, 305, 212, 323, 424, 469, 512, 628, 702, 786, 929, 971].includes(areaCode));
});

test("uses a configured random CA area code when the request omits one", () => {
  const [query] = buildRequestPrivateNumberQueriesForTest({
    countryCode: 1,
    isoCountryCode: "CA",
    appVersion: "6.3.1"
  });
  assert.ok(query);
  const areaCode = Number(new URLSearchParams(query.replace(/^&+/, "")).get("areaCode"));

  assert.ok([416, 647, 437, 604, 778, 236, 514, 438, 613, 343].includes(areaCode));
});

test("preserves an explicit area code override", () => {
  const [query] = buildRequestPrivateNumberQueriesForTest({
    countryCode: 1,
    isoCountryCode: "US",
    areaCode: 202,
    appVersion: "6.3.1"
  });
  assert.ok(query);

  assert.equal(new URLSearchParams(query.replace(/^&+/, "")).get("areaCode"), "202");
});
