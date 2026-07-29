import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./account-monitor.ts", import.meta.url), "utf8");

test("direct monitors reconcile phone inventory after listening and react to purchase notices", () => {
  assert.match(source, /lastPhoneInventoryRefreshAt: number \| null/);
  assert.match(source, /phoneInventoryRefreshPending: boolean/);
  assert.match(source, /hasPhonePurchaseNotice\(messages\)/);
  assert.match(source, /runner\.phoneInventoryRefreshPending = true/);
  assert.match(source, /shouldRefreshDirectPhoneInventoryAfterPoll\(/);
  assert.match(source, /await this\.refreshDirectPhoneInventory\(/);
  assert.match(source, /await syncPhoneNumbers\(runner\.accountId, phoneNumbers\)/);
});

test("direct monitor uses inventory state to end listen renewal and gate post-poll refresh", () => {
  assert.match(source, /shouldContinueDirectPhoneInventoryListen\(/);
  assert.match(source, /shouldRefreshDirectPhoneInventoryAfterPoll\(/);
});

test("real-time purchase detection receives the native direct push msgType", () => {
  assert.match(source, /hasDirectPushPhonePurchaseNotice\(push\.sms\)/);
});

test("phone inventory reconciliation remains non-fatal to SMS monitoring", () => {
  const helper = source.slice(
    source.indexOf("private async refreshDirectPhoneInventory"),
    source.indexOf("private async pollDirectMessages")
  );
  assert.match(helper, /catch \(error\)/);
  assert.match(helper, /logger\.warn\("Automatic phone inventory refresh failed"/);
  assert.doesNotMatch(helper, /throw error/);
});
