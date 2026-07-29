import assert from "node:assert/strict";
import test from "node:test";
import * as renewalModule from "./phone-renewal-confirmation.js";
import { resolvePhoneRenewalConfirmation, shouldDeferRenewalRemoteConfirmation } from "./phone-renewal-confirmation.js";

test("resolves one renewal to the phone-specific 3 or 12 month period", () => {
  const resolve = (renewalModule as typeof renewalModule & {
    resolvePhoneRenewalMonths?: (phone: { validPeriodDays?: number | null; rawJson?: string | null }) => number;
    resolvePhoneRenewalCommandTag?: (extensionMonths: number) => 0 | 2;
    resolvePhoneRenewalExtraChargeMonths?: (extensionMonths: number) => 0 | 12;
  }).resolvePhoneRenewalMonths;
  const resolveCommandTag = (renewalModule as typeof renewalModule & {
    resolvePhoneRenewalCommandTag?: (extensionMonths: number) => 0 | 2;
  }).resolvePhoneRenewalCommandTag;
  const resolveExtraChargeMonths = (renewalModule as typeof renewalModule & {
    resolvePhoneRenewalExtraChargeMonths?: (extensionMonths: number) => 0 | 12;
  }).resolvePhoneRenewalExtraChargeMonths;
  assert.equal(typeof resolve, "function");
  assert.equal(typeof resolveCommandTag, "function");
  assert.equal(typeof resolveExtraChargeMonths, "function");
  if (!resolve || !resolveCommandTag || !resolveExtraChargeMonths) return;

  assert.equal(resolve({ validPeriodDays: 3, rawJson: JSON.stringify({ validPeriodDays: 3, usePeriod: 2 }) }), 3);
  assert.equal(resolve({ validPeriodDays: 12, rawJson: JSON.stringify({ validPeriodDays: 12, usePeriod: 4 }) }), 12);
  assert.equal(resolve({ validPeriodDays: null, rawJson: JSON.stringify({ validPeriodDays: 3 }) }), 3);
  assert.throws(() => resolve({ validPeriodDays: null, rawJson: JSON.stringify({ usePeriod: 2 }) }), /renewal period/i);
  assert.equal(resolveCommandTag(3), 0);
  assert.equal(resolveCommandTag(12), 2);
  assert.equal(resolveExtraChargeMonths(3), 0);
  assert.equal(resolveExtraChargeMonths(12), 12);
});

test("confirms renewal from an action response whose expiry advanced", () => {
  const result = resolvePhoneRenewalConfirmation({
    previous: { expiredTime: "1784870665873" },
    action: { expiredTime: "1785302665873" }
  });

  assert.equal(result.source, "renew_response");
  assert.equal(result.confirmed, true);
  assert.equal(result.phone.expiredTime, "1785302665873");
});

test("confirms renewal from the remote phone list when the action response has no expiry", () => {
  const result = resolvePhoneRenewalConfirmation({
    previous: { expiredTime: "1784870665873" },
    action: {},
    remote: { expiredTime: "1785302665873", status: "active" }
  });

  assert.equal(result.source, "remote_phone_list");
  assert.equal(result.confirmed, true);
  assert.equal((result.phone as { expiredTime?: string }).expiredTime, "1785302665873");
});

test("returns a pending renewal instead of failing when the remote list is still stale", () => {
  const result = resolvePhoneRenewalConfirmation({
    previous: { expiredTime: "1784870665873" },
    action: {},
    remote: { expiredTime: "1784870665873", status: "active" }
  });

  assert.equal(result.source, "renewal_pending");
  assert.equal(result.confirmed, false);
  assert.match(result.note, /do not submit another renewal/i);
});

test("defers inline inventory verification after a renewal write has no response", () => {
  assert.equal(
    shouldDeferRenewalRemoteConfirmation({
      rawJson: '{"result":"no_response_after_write"}'
    }),
    true
  );
  assert.equal(shouldDeferRenewalRemoteConfirmation({ rawJson: '{"Result":1}' }), false);
});
