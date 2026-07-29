import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./accounts.ts", import.meta.url), "utf8");
const purchase = source.slice(
  source.indexOf('accountsRouter.post("/:id/phone-numbers/purchase"'),
  source.indexOf('accountsRouter.post("/:id/phone-numbers/:phoneId/renew"')
);
const confirmation = source.slice(
  source.indexOf("async function confirmPurchasedPhone"),
  source.indexOf("async function importSessionAccount")
);

test("phone purchase route is direct-only and never invokes helper or ADB purchase paths", () => {
  assert.match(purchase, /directRefreshGateway\.purchasePhoneNumber/);
  assert.match(purchase, /confirmPurchasedPhone/);
  assert.doesNotMatch(purchase, /executeHelperAction/);
  assert.doesNotMatch(purchase, /assertPhoneFallbackSessionMatchesAccount/);
  assert.doesNotMatch(purchase, /helperPurchaseTimeoutMs|usedHelperPurchaseFallback/);
  assert.doesNotMatch(confirmation, /listPhoneNumbersFromAdb|adb_phone_db/);
});

test("phone purchase route rejects concurrent purchases for one account", () => {
  assert.match(source, /const activePhonePurchases = new Set<number>\(\)/);
  assert.match(purchase, /activePhonePurchases\.has\(accountId\)/);
  assert.match(purchase, /AppError\([^)]*409, 409\)/s);
  assert.match(purchase, /activePhonePurchases\.add\(accountId\)/);
  assert.match(purchase, /finally \{\s*activePhonePurchases\.delete\(accountId\)/);
});
