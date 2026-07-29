import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./accounts.ts", import.meta.url), "utf8");

test("direct phone preview falls through to the App helper path when native CommonRest preview fails", () => {
  const preview = source.slice(
    source.indexOf("async function previewPhoneNumbers"),
    source.indexOf("export async function syncPhoneNumbersFromRemote")
  );

  assert.match(preview, /if \(await shouldUseDirectAccountFlow\(account\)\) \{\s*try \{/);
  assert.match(preview, /catch \(directError\)/);
  assert.match(preview, /logger\.warn\("Direct phone preview failed; trying App helper fallback"/);
  assert.match(preview, /helperRefreshGateway\.requestPhoneNumber/);
  assert.match(preview, /previewPhoneNumbersFromAdb/);
  assert.match(preview, /assertPhoneFallbackSessionMatchesAccount\(account\)/);
  assert.match(preview, /const pausedMonitor = await pauseMonitorForDirectMaintenance\(account\)/);
  assert.match(preview, /finally \{[\s\S]*?accountMonitorService\.start\(accountId\)/);
});

test("direct phone preview treats an empty candidate response as a fallback condition", () => {
  const preview = source.slice(
    source.indexOf("async function previewPhoneNumbers"),
    source.indexOf("export async function syncPhoneNumbersFromRemote")
  );

  assert.match(preview, /const directPreview = await directRefreshGateway\.requestPhoneNumber/);
  assert.match(preview, /if \(directPreview\.candidates\.length > 0 \|\| directPreview\.freeChance !== undefined\) \{/);
  assert.match(preview, /throw new Error\("Direct preview returned no candidates"\)/);
});

test("remote phone inventory sync preserves the account app variant in direct identity", () => {
  const sync = source.slice(
    source.indexOf("export async function syncPhoneNumbersFromRemote"),
    source.indexOf("async function verifyDirectPhoneAction")
  );

  assert.match(sync, /buildDirectPhoneInventoryIdentity\(/);
  assert.match(sync, /appVariant: account\.appVariant/);
  assert.match(sync, /Phone inventory synchronization requires a valid direct account session/);
  assert.match(sync, /activePhoneInventorySyncs\.get\(accountId\)/);
  assert.match(sync, /accountMonitorService\.withMaintenance\(accountId/);
  assert.match(sync, /directRefreshGateway\.listPhoneNumbers\(directAccount\)/);
  assert.doesNotMatch(sync, /executeHelperAction|listPhoneNumbersFromAdb|helperRefreshGateway/);
});

test("phone helper and ADB fallbacks outside purchase are scoped to the requested account session", () => {
  assert.match(source, /async function assertPhoneFallbackSessionMatchesAccount\(account:/);
  assert.match(source, /exportSessionFromAdbConfig\(account\.appVariant\)/);
  assert.match(source, /assertAdbSessionMatchesExpectedUser\(session, expectedDtUserId, account\.appVariant\)/);
});

test("panel phone mutations are direct-only and never fall back to ADB/helper writes", () => {
  const mutationRegion = source.slice(
    source.indexOf('accountsRouter.post("/:id/phone-numbers/:phoneId/renew"'),
    source.indexOf('accountsRouter.delete("/:id/phone-numbers/:phoneId"')
  );
  assert.match(mutationRegion, /phoneActionCoordinator\.execute/);
  assert.match(mutationRegion, /does not use ADB\/helper fallback/);
  assert.doesNotMatch(
    mutationRegion,
    /executeHelperAction|assertPhoneFallbackSessionMatchesAccount|renew_phone_number|cancel_phone_number|pause_phone_number|resume_phone_number/
  );
});
