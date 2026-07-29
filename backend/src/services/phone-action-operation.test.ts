import assert from "node:assert/strict";
import test from "node:test";
import {
  activePhoneActionLockKey,
  assertRenewalNoEffectEvidence,
  canTransitionPhoneAction,
  phoneActionFamily,
  sanitizePhoneActionError
} from "./phone-action-operation.js";

test("keeps an unknown renewal locked across restart-compatible states", () => {
  assert.equal(phoneActionFamily("renew"), "renewal");
  assert.equal(activePhoneActionLockKey(459, 4999, "renew"), "459:4999:renewal");
  assert.equal(canTransitionPhoneAction("writing", "awaiting_confirmation"), true);
  assert.equal(canTransitionPhoneAction("awaiting_confirmation", "prepared"), false);
  assert.equal(canTransitionPhoneAction("manual_review", "prepared"), false);
});

test("groups phone setting mutations under one conflict lock", () => {
  assert.equal(phoneActionFamily("pause"), "settings");
  assert.equal(phoneActionFamily("resume"), "settings");
  assert.equal(phoneActionFamily("update_label"), "settings");
  assert.equal(phoneActionFamily("enable_sms"), "settings");
  assert.equal(activePhoneActionLockKey(8, 12, "enable_sms"), "8:12:settings");
});

test("allows only forward-safe operation transitions", () => {
  assert.equal(canTransitionPhoneAction("prepared", "writing"), true);
  assert.equal(canTransitionPhoneAction("writing", "failed_before_write"), true);
  assert.equal(canTransitionPhoneAction("awaiting_confirmation", "confirmed"), true);
  assert.equal(canTransitionPhoneAction("manual_review", "confirmed"), true);
  assert.equal(canTransitionPhoneAction("manual_review", "confirmed_no_effect" as never), true);
  assert.equal(canTransitionPhoneAction("confirmed_no_effect" as never, "writing"), false);
  assert.equal(canTransitionPhoneAction("confirmed", "writing"), false);
  assert.equal(canTransitionPhoneAction("failed_before_write", "prepared"), false);
});

test("releases an uncertain renewal only after matching no-effect evidence", () => {
  assert.doesNotThrow(() => assertRenewalNoEffectEvidence({
    state: "manual_review",
    action: "renew",
    baselineExpiry: "1785074508083",
    balanceBefore: 20030.55
  }, {
    observedExpiry: "1785074508083",
    balanceAfter: 20030.55
  }));

  assert.throws(() => assertRenewalNoEffectEvidence({
    state: "manual_review",
    action: "renew",
    baselineExpiry: "1785074508083",
    balanceBefore: 20030.55
  }, {
    observedExpiry: "1785074508083",
    balanceAfter: 19130.55
  }), /balance changed/i);

  assert.throws(() => assertRenewalNoEffectEvidence({
    state: "manual_review",
    action: "renew",
    baselineExpiry: "1785074508083",
    balanceBefore: 20030.55
  }, {
    observedExpiry: "1793028108083",
    balanceAfter: 20030.55
  }), /expiry changed/i);
});

test("redacts long numeric and token-like values from persisted errors", () => {
  const sanitized = sanitizePhoneActionError(
    "renew +447700900123 token=abcdef0123456789abcdef0123456789 failed"
  );

  assert.doesNotMatch(sanitized, /447700900123/);
  assert.doesNotMatch(sanitized, /abcdef0123456789abcdef0123456789/);
  assert.match(sanitized, /\*\*\*/);
});
