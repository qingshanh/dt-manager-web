import assert from "node:assert/strict";
import test from "node:test";

import {
  isActivationDeviceIdAcceptedForVariant,
  normalizeActivationDeviceIdForVariant,
} from "./direct-gateway.js";

const bareDeviceId = "And.0123456789abcdef0123456789abcdef";
const talkuDeviceId = `${bareDeviceId}.dttalk`;

test("accepts Dingdong email activation device ids without the dttalk suffix", () => {
  assert.equal(isActivationDeviceIdAcceptedForVariant(bareDeviceId, "dingdong"), true);
});

test("keeps TalkU email activation device ids bound to the dttalk suffix", () => {
  assert.equal(isActivationDeviceIdAcceptedForVariant(bareDeviceId, "dingtone"), false);
  assert.equal(isActivationDeviceIdAcceptedForVariant(talkuDeviceId, "dingtone"), true);
});

test("normalizes Dingdong activation device ids to the native app form", () => {
  assert.equal(normalizeActivationDeviceIdForVariant(talkuDeviceId, "dingdong"), bareDeviceId);
});

test("normalizes TalkU activation device ids to the dttalk form", () => {
  assert.equal(normalizeActivationDeviceIdForVariant(bareDeviceId, "dingtone"), talkuDeviceId);
});
