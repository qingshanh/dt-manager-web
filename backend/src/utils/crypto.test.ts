import assert from "node:assert/strict";
import test from "node:test";

import { advanceActivationTrackCode, createActivationTrackCode, createTrackCode, isActivationTrackCode } from "./crypto.js";

test("activation TrackCode matches the live native 64-bit low-12-bit sequence", () => {
  const values = Array.from({ length: 64 }, () => createActivationTrackCode());

  for (const value of values) {
    assert.match(value, /^\d{16}$/);
    assert.equal(BigInt(value) % 4096n, 3n);
    assert.ok(BigInt(value) < 2n ** 63n);
    assert.equal(isActivationTrackCode(value), true);
  }
  assert.equal(new Set(values).size, values.length);
  assert.equal(isActivationTrackCode("40051185300487701"), false);
  assert.equal(isActivationTrackCode("362348547"), false);
  assert.equal(isActivationTrackCode("268578819"), false);
  assert.equal(isActivationTrackCode("6701025728065539"), true);
  assert.equal(advanceActivationTrackCode("6701025728065539"), "6701025728069635");
  assert.equal(advanceActivationTrackCode("6701025728065539", 2), "6701025728073731");
});

test("generic TrackCode keeps the legacy non-activation format", () => {
  const value = createTrackCode();

  assert.match(value, /^400511853\d{8}$/);
  assert.equal(isActivationTrackCode(value), false);
});
