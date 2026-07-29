import assert from "node:assert/strict";
import test from "node:test";
import { PhoneActionType } from "@prisma/client";
import { evaluatePhoneActionReconciliation } from "./phone-action-reconciliation.js";

const localPhone = {
  phoneNumber: "+12025550101",
  status: "active" as const,
  expiredTime: "1784870665873"
};

test("confirms renewal only when remote expiry advanced", () => {
  const confirmed = evaluatePhoneActionReconciliation(
    { action: PhoneActionType.renew, baselineExpiry: localPhone.expiredTime, requestPayloadJson: null },
    localPhone,
    [{ phoneNumber: "12025550101", status: "active", expiredTime: "1785302665873" }]
  );
  const stale = evaluatePhoneActionReconciliation(
    { action: PhoneActionType.renew, baselineExpiry: localPhone.expiredTime, requestPayloadJson: null },
    localPhone,
    [{ phoneNumber: "12025550101", status: "active", expiredTime: localPhone.expiredTime }]
  );

  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.confirmedExpiry, "1785302665873");
  assert.equal(stale.confirmed, false);
});

test("confirms cancellation when the number is absent", () => {
  const result = evaluatePhoneActionReconciliation(
    { action: PhoneActionType.cancel, baselineExpiry: null, requestPayloadJson: null },
    localPhone,
    []
  );

  assert.equal(result.confirmed, true);
  assert.equal(result.phonePatch?.status, "cancelled");
});

test("confirms precise setting targets from the remote inventory", () => {
  const paused = evaluatePhoneActionReconciliation(
    { action: PhoneActionType.pause, baselineExpiry: null, requestPayloadJson: '{"status":"paused"}' },
    localPhone,
    [{ phoneNumber: "12025550101", status: "paused" }]
  );
  const labelled = evaluatePhoneActionReconciliation(
    { action: PhoneActionType.update_label, baselineExpiry: null, requestPayloadJson: '{"displayName":"work"}' },
    localPhone,
    [{ phoneNumber: "12025550101", status: "active", displayName: "work" }]
  );
  const sms = evaluatePhoneActionReconciliation(
    { action: PhoneActionType.enable_sms, baselineExpiry: null, requestPayloadJson: '{"allowReceiveSms":true}' },
    localPhone,
    [{ phoneNumber: "12025550101", status: "active", allowReceiveSms: true }]
  );

  assert.equal(paused.confirmed, true);
  assert.equal(labelled.confirmed, true);
  assert.equal(sms.confirmed, true);
});
