import assert from "node:assert/strict";
import test from "node:test";
import {
  PHONE_ACTION_REST_CALL_TYPES,
  UnsafePhoneSettingSourceError,
  buildPrivateNumberSettingPayload,
  resolvePhoneActionProtocol
} from "./phone-action-protocol.js";

function fullPhoneSettingFixture() {
  return {
    phoneNumber: "12025550101",
    displayName: "Primary line",
    primaryFlag: 1,
    faxEnabled: 1,
    slientFlag: 1,
    suspendFlag: 0,
    callForwardFlag: 1,
    forwardNumber: "12025550199",
    forwardCountryCode: 1,
    forwardDestCode: 202,
    autoSMSReply: 1,
    useVoicemail: 1,
    voicemailId: "voice-1",
    autoSMSContent: "busy",
    defaultGreetings: 2,
    autoRenew: 1,
    filterSetting: {
      useBlock: 1,
      callBlockSetting: 2,
      allowReceiveSMS: false,
      blockNumberList: ["encrypted-number"]
    }
  };
}

test("uses the App RestCall identities shared by TalkU and Dingdong", () => {
  assert.deepEqual(PHONE_ACTION_REST_CALL_TYPES, {
    renew: 2050,
    settings: 2052,
    cancel: 2132
  });
  assert.equal(resolvePhoneActionProtocol("dingtone", "renew").restCallType, 2050);
  assert.equal(resolvePhoneActionProtocol("dingdong", "settings").restCallType, 2052);
  assert.equal(resolvePhoneActionProtocol("dingdong", "cancel").restCallType, 2132);
});

test("changing suspend state preserves unrelated settings", () => {
  const source = fullPhoneSettingFixture();
  const next = buildPrivateNumberSettingPayload(source, { suspendFlag: true });

  assert.equal(next.suspendFlag, 1);
  assert.equal(next.autoRenew, source.autoRenew);
  assert.equal(next.primaryFlag, 0);
  assert.deepEqual(next.filterSetting, source.filterSetting);
  assert.equal(next.displayName, source.displayName);
  assert.equal(next.forwardNumber, source.forwardNumber);
});

test("an SMS override does not change forwarding or auto renew", () => {
  const source = fullPhoneSettingFixture();
  const next = buildPrivateNumberSettingPayload(source, { allowReceiveSms: true });

  assert.equal(next.filterSetting.allowReceiveSMS, true);
  assert.equal(next.callForwardFlag, source.callForwardFlag);
  assert.equal(next.forwardNumber, source.forwardNumber);
  assert.equal(next.autoRenew, source.autoRenew);
  assert.equal(next.primaryFlag, source.primaryFlag);
});

test("rejects an incomplete source before building a setting write", () => {
  const source = fullPhoneSettingFixture();
  const { filterSetting: _filterSetting, ...incomplete } = source;

  assert.throws(
    () => buildPrivateNumberSettingPayload(incomplete, { displayName: "new label" }),
    UnsafePhoneSettingSourceError
  );
});
