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
  assert.equal(resolvePhoneActionProtocol("dingtone", "renew").apiName, "/pstn/share/orderPrivateNumber");
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

test("allows enabling SMS reception with safe defaults when remote record omits optional forwarding and filterSetting", () => {
  const minimalRemoteRecord = {
    phoneNumber: "3197010201002",
    countryCode: 31,
    areaCode: 97,
    providerId: 2006,
    autoRenew: 1,
    callForwardFlag: 0,
    faxEnabled: 0,
    slientFlag: 0,
    suspendFlag: 0,
    primaryFlag: 0,
    displayName: "",
    autoSMSReply: 0,
    useVoicemail: 0
  };

  const payload = buildPrivateNumberSettingPayload(minimalRemoteRecord, { allowReceiveSms: true });

  assert.equal(payload.phoneNumber, "3197010201002");
  assert.equal(payload.filterSetting.allowReceiveSMS, true);
  assert.equal(payload.callForwardFlag, 0);
  assert.equal(payload.forwardNumber, "");
  assert.equal(payload.useVoicemail, 0);
  assert.equal(payload.voicemailId, "");
  assert.equal(payload.autoSMSReply, 0);
  assert.equal(payload.autoSMSContent, "");
  assert.equal(payload.autoRenew, 1);
});
