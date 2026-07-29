import assert from "node:assert/strict";
import test from "node:test";
import {
  ORDER_PRIVATE_NUMBER_API_NAME,
  ORDER_PRIVATE_NUMBER_NATIVE_REST_CALL_TYPE,
  encodeOrderPrivateNumberRpcContext,
  patchProxyRestRequestContext
} from "./order-private-number-rpc.js";

test("defines the native orderPrivateNumber RPC identity", () => {
  assert.equal(ORDER_PRIVATE_NUMBER_NATIVE_REST_CALL_TYPE, 2050);
  assert.equal(ORDER_PRIVATE_NUMBER_API_NAME, "/pstn/share/orderPrivateNumber");
});

test("encodes orderPrivateNumber command cookie and tag in native network order", () => {
  assert.equal(encodeOrderPrivateNumberRpcContext().toString("hex"), "0000000000000000");
  assert.equal(
    encodeOrderPrivateNumberRpcContext({ commandCookie: 0x11223344, commandTag: 0x55667788 }).toString("hex"),
    "1122334455667788"
  );
});

test("patches only the eight-byte ProxyRest context after the route", () => {
  const route = Buffer.from("0102030405060708", "hex");
  const commonRestContext = Buffer.from("0000000000010101", "hex");
  const payload = Buffer.from("aabbccdd", "hex");
  const body = Buffer.concat([route, commonRestContext, payload]);

  const patched = patchProxyRestRequestContext(body, encodeOrderPrivateNumberRpcContext());

  assert.equal(patched.subarray(0, 8).toString("hex"), route.toString("hex"));
  assert.equal(patched.subarray(8, 16).toString("hex"), "0000000000000000");
  assert.equal(patched.subarray(16).toString("hex"), payload.toString("hex"));
  assert.equal(body.subarray(8, 16).toString("hex"), commonRestContext.toString("hex"));
});

test("rejects malformed ProxyRest bodies and contexts", () => {
  assert.throws(() => patchProxyRestRequestContext(Buffer.alloc(15), Buffer.alloc(8)), /route and context/);
  assert.throws(() => patchProxyRestRequestContext(Buffer.alloc(16), Buffer.alloc(7)), /8 bytes/);
  assert.throws(() => encodeOrderPrivateNumberRpcContext({ commandCookie: -1 }), /commandCookie/);
  assert.throws(() => encodeOrderPrivateNumberRpcContext({ commandTag: 0x1_0000_0000 }), /commandTag/);
});
