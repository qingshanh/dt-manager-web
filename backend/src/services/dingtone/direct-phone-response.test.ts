import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptsCommonRestJsonPayloadForTest,
  isExpectedEdgeOrderPrivateNumberPayloadForTest,
  isExpectedOrderPrivateNumberPayloadForTest,
  normalizeRenewedPhoneNumberResponse
} from "./direct-gateway.js";

test("accepts requestPrivateNumber candidates without an echoed TrackCode", () => {
  assert.equal(
    acceptsCommonRestJsonPayloadForTest(
      "/pstn/share/requestPrivateNumber",
      "deviceId=test&TrackCode=40051185300000003",
      { Result: 1, phoneList: [{ phoneNumber: "32470123456" }] }
    ),
    true
  );
});

test("accepts requestPrivateNumber business errors without an echoed TrackCode", () => {
  assert.equal(
    acceptsCommonRestJsonPayloadForTest(
      "/pstn/share/requestPrivateNumber",
      "deviceId=test&TrackCode=40051185300000003",
      { Result: 0, ErrCode: 60009, Reason: "not available" }
    ),
    true
  );
});

test("keeps waiting after a requestPrivateNumber success acknowledgement without candidates", () => {
  assert.equal(
    acceptsCommonRestJsonPayloadForTest(
      "/pstn/share/requestPrivateNumber",
      "deviceId=test&TrackCode=40051185300000003",
      { SiteId: 3, TrackCode: 40051185300000003, Result: 1 }
    ),
    false
  );
});

test("accepts getNumberPrice quotes without an echoed TrackCode", () => {
  assert.equal(
    acceptsCommonRestJsonPayloadForTest(
      "/pstn/getNumberPrice",
      "phoneNumber=32470123456",
      { Result: 1, orderPrice: 900 }
    ),
    true
  );
});

test("keeps waiting after a getNumberPrice success acknowledgement without a price", () => {
  assert.equal(
    acceptsCommonRestJsonPayloadForTest(
      "/pstn/getNumberPrice",
      "phoneNumber=32470123456&TrackCode=40051185300000003",
      { SiteId: 3, TrackCode: 40051185300000003, Result: 1 }
    ),
    false
  );
});

test("still rejects an unrelated balance payload for phone requests", () => {
  assert.equal(
    acceptsCommonRestJsonPayloadForTest(
      "/pstn/share/requestPrivateNumber",
      "deviceId=test&TrackCode=40051185300000003",
      { balance: 1234 }
    ),
    false
  );
});

test("edge phone purchase order ignores plain lock acknowledgements", () => {
  assert.equal(isExpectedEdgeOrderPrivateNumberPayloadForTest({ Result: 1 }), false);
});

test("edge phone purchase order accepts typed order success", () => {
  assert.equal(
    isExpectedEdgeOrderPrivateNumberPayloadForTest({
      Result: 1,
      phoneNumber: "32470123456",
      payFlag: 2
    }),
    true
  );
});

test("edge phone purchase order accepts business errors", () => {
  assert.equal(
    isExpectedEdgeOrderPrivateNumberPayloadForTest({
      Result: 0,
      ErrCode: 9001,
      Reason: "verification required"
    }),
    true
  );
});

test("renewal ignores an interleaved purchased-number inventory payload", () => {
  assert.equal(
    isExpectedOrderPrivateNumberPayloadForTest(
      {
        Result: 1,
        numberExList: [
          { phoneNumber: "33757934708", expireTime: 1787819224123 },
          { phoneNumber: "33755547881", expireTime: 1794908270148 }
        ]
      },
      "33757934708"
    ),
    false
  );
});

test("renewal accepts only a typed order success for the target phone", () => {
  assert.equal(
    isExpectedOrderPrivateNumberPayloadForTest(
      {
        Result: 1,
        data: {
          orderPayload: {
            phoneNumber: "33757934708",
            payFlag: 3,
            expireTime: 1795768024123
          }
        }
      },
      "33757934708"
    ),
    true
  );
  assert.equal(
    isExpectedOrderPrivateNumberPayloadForTest(
      { Result: 1, phoneNumber: "33755547881", payFlag: 3, expireTime: 1794908270148 },
      "33757934708"
    ),
    false
  );
});

test("renewal accepts an explicit business failure without a phone payload", () => {
  assert.equal(
    isExpectedOrderPrivateNumberPayloadForTest(
      { Result: 0, ErrCode: 60009, Reason: "renewal rejected" },
      "33757934708"
    ),
    true
  );
});

test("renewal response extracts expiry from a nested native order payload", () => {
  const normalized = normalizeRenewedPhoneNumberResponse(
    {
      Result: 1,
      data: {
        orderPayload: {
          phoneNumber: "447700900123",
          expireTime: 1785302665873,
          gainTime: 1730179465945,
          payType: 2
        }
      }
    },
    "447700900123"
  );

  assert.equal(normalized.phoneNumber, "447700900123");
  assert.equal(normalized.expiredTime, "1785302665873");
  assert.equal(normalized.gainTime, "1730179465945");
  assert.equal(normalized.payType, 2);
});

test("accepts deletePhoneNumber success response with or without TrackCode", () => {
  assert.equal(
    acceptsCommonRestJsonPayloadForTest(
      "/pstn/share/deletePhoneNumber",
      "phoneNumber=32470123456&TrackCode=40051185300000003",
      { Result: 1 }
    ),
    true
  );
  assert.equal(
    acceptsCommonRestJsonPayloadForTest(
      "/pstn/share/deletePhoneNumber",
      "phoneNumber=32470123456",
      { Result: 1 }
    ),
    true
  );
  assert.equal(
    acceptsCommonRestJsonPayloadForTest(
      "/pstn/share/deletePrivateNumber",
      "phoneNumber=32470123456",
      { Result: 1, status: "cancelled" }
    ),
    true
  );
});
