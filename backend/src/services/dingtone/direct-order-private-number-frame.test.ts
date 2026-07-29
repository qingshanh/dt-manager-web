import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import {
  buildEdgeOrderPrivateNumberRequestFrameForTest,
  buildPhonePurchaseLockRequestFrameForTest,
  buildOrderPrivateNumberRequestFrameForTest,
  buildRequestPrivateNumberRequestFrameForTest,
  nextEdgeRestCallTypesForTest
} from "./direct-gateway.js";

test("builds an orderPrivateNumber ProxyRest frame with an empty native command context", () => {
  const session = Buffer.from("11223344", "hex");
  const route = Buffer.from("0102030405060708", "hex");
  const query = "token=test&phoneNumber=32470123456&apiVersion=4&buyCredit=1";

  const frame = buildOrderPrivateNumberRequestFrameForTest({ session, route, query });

  assert.equal(frame.readUInt16BE(0), 0x0107);
  assert.equal(frame.readUInt32BE(2), frame.length);
  assert.equal(frame.readUInt16BE(6), 0x8107);
  assert.equal(frame.subarray(8, 12).toString("hex"), session.toString("hex"));
  assert.equal(frame.readUInt16BE(16), 0x0102);
  assert.equal(frame.subarray(22, 30).toString("hex"), route.toString("hex"));
  assert.equal(frame.subarray(30, 38).toString("hex"), "0000000000000000");
  assert.notEqual(frame.indexOf(Buffer.from("/pstn/share/orderPrivateNumber")), -1);
  assert.equal(inflateFirstPayload(frame), query);
});

test("encodes the App yearly-renewal command tag in the ProxyRest context", () => {
  const frame = buildOrderPrivateNumberRequestFrameForTest({
    session: Buffer.from("11223344", "hex"),
    route: Buffer.from("0102030405060708", "hex"),
    query: "payFlag=3&extraChargeMonthsCount=12",
    commandTag: 2
  });

  assert.equal(frame.subarray(30, 38).toString("hex"), "0000000000000002");
});

test("encodes the App manual three-month renewal with an empty command context", () => {
  const frame = buildOrderPrivateNumberRequestFrameForTest({
    session: Buffer.from("11223344", "hex"),
    route: Buffer.from("0102030405060708", "hex"),
    query: "payFlag=3&extraChargeMonthsCount=3",
    commandTag: 0
  });

  assert.equal(frame.subarray(30, 38).toString("hex"), "0000000000000000");
});

test("builds requestPrivateNumber with the App-observed ProxyRest context", () => {
  const frame = buildRequestPrivateNumberRequestFrameForTest({
    session: Buffer.from("11223344", "hex"),
    route: Buffer.from("0102030405060708", "hex"),
    query: "countryCode=31&isoCountryCode=NL"
  });

  assert.equal(frame.subarray(30, 38).toString("hex"), "0000000000000001");
  assert.notEqual(frame.indexOf(Buffer.from("/pstn/share/requestPrivateNumber")), -1);
});

test("builds phone purchase lock as edge CommonRest with seal rest call context", () => {
  const frame = buildPhonePurchaseLockRequestFrameForTest({
    session: Buffer.from("11223344", "hex"),
    route: Buffer.from("0102030405060708", "hex"),
    query: "phoneNumber=319701234567&countryCode=31&providerId=2006"
  });

  assert.equal(frame.subarray(30, 38).toString("hex"), "0000000027100101");
  assert.notEqual(frame.indexOf(Buffer.from("/number/lock")), -1);
  assert.equal(inflateFirstPayload(frame), "phoneNumber=319701234567&countryCode=31&providerId=2006");
});

test("builds phone purchase order as edge CommonRest with product id", () => {
  const query = "countryCode=32&phoneNumber=32470123456&apiVersion=3&buyCredit=1&productId=preview-product-id";
  const frame = buildEdgeOrderPrivateNumberRequestFrameForTest({
    session: Buffer.from("11223344", "hex"),
    route: Buffer.from("0102030405060708", "hex"),
    query
  });

  assert.equal(frame.subarray(30, 38).toString("hex"), "0000000027110101");
  assert.notEqual(frame.indexOf(Buffer.from("pstn/share/orderPrivateNumber")), -1);
  assert.equal(frame.indexOf(Buffer.from("/pstn/share/orderPrivateNumber")), -1);
  assert.equal(inflateFirstPayload(frame), query);
});

test("rotates App edge CommonRest call types across sequential requests", () => {
  assert.deepEqual(nextEdgeRestCallTypesForTest(5), [10000, 10001, 10000, 10001, 10000]);
});

function inflateFirstPayload(frame: Buffer) {
  for (let index = 0; index < frame.length - 2; index += 1) {
    if (frame[index] !== 0x78) {
      continue;
    }
    try {
      return zlib.inflateSync(frame.subarray(index)).toString("utf8");
    } catch {
      // Keep scanning until the embedded zlib stream is found.
    }
  }
  throw new Error("frame does not contain a zlib payload");
}
