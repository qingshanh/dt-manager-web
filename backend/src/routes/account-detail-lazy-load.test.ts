import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../frontend/src/pages/AccountDetail.tsx", import.meta.url), "utf8");
const routes = readFileSync(new URL("./accounts.ts", import.meta.url), "utf8");
const gateway = readFileSync(new URL("../services/dingtone/direct-gateway.ts", import.meta.url), "utf8");

test("account detail page does not fetch phone countries during initial page load", () => {
  assert.doesNotMatch(source, /fetchAccount\(\);\s*fetchPhones\(\);\s*fetchPhoneCountries\(\);/);
  assert.match(source, /const handleImportDirectSession = async \(\) => \{[\s\S]*?await fetchPhoneCountries\(\);/);
  assert.match(source, /const handleRequestNumber = async \(\) => \{\s*const countries = await fetchPhoneCountries\(\);/);
});

test("country loading preserves the account variant and surfaces the real API error", () => {
  const routeBlock = routes.slice(
    routes.indexOf('accountsRouter.get("/:id/phone-numbers/countries"'),
    routes.indexOf('accountsRouter.post("/:id/phone-numbers/sync"')
  );
  const countryLoader = source.slice(
    source.indexOf("const fetchPhoneCountries"),
    source.indexOf("const syncOwnedPhones")
  );

  assert.match(routeBlock, /appVariant: account\.appVariant/);
  assert.match(gateway, /async listPhoneNumberCountries\(account: \{[\s\S]*?appVariant\?: "dingtone" \| "dingdong"/);
  assert.match(countryLoader, /catch \(err\)/);
  assert.match(countryLoader, /message\.error\(err instanceof Error \? err\.message/);
  assert.match(countryLoader, /return \[\]/);
});

test("account detail silently reconciles stale phone inventory in the background", () => {
  const phoneLoader = source.slice(
    source.indexOf("const fetchPhones"),
    source.indexOf("const pollPhoneOperation")
  );

  assert.match(source, /const PHONE_AUTO_SYNC_MAX_AGE_MS = 15 \* 60 \* 1000/);
  assert.match(source, /function shouldAutoSyncPhoneNumbers\(/);
  assert.match(phoneLoader, /if \(shouldAutoSyncPhoneNumbers\(data\)\)/);
  assert.match(phoneLoader, /void getOrCreateAccountRequest\(/);
  assert.doesNotMatch(phoneLoader, /await reconcileIfStale\(/);
  assert.match(phoneLoader, /\(\) => syncPhoneNumbers\(requestAccountId\)/);
  assert.match(phoneLoader, /commitPhones\(refreshed\.phone_numbers\)/);
  assert.doesNotMatch(phoneLoader, /message\.success/);
});

test("account detail guards stale phone sync with account-scoped single-flight", () => {
  const phoneLoader = source.slice(
    source.indexOf("const fetchPhones"),
    source.indexOf("const pollPhoneOperation")
  );
  assert.match(phoneLoader, /getOrCreateAccountRequest\(/);
  assert.match(phoneLoader, /isCurrentAccountRequest\(/);
  assert.match(source, /phoneAccountScopeRef/);
  assert.match(phoneLoader, /setPhoneLoading\(false\)/);
});

test("team history stays visible and concurrent silent refreshes always release loading", () => {
  const teamLoader = source.slice(
    source.indexOf("const fetchTeamMessages"),
    source.indexOf("const syncLatestMessages")
  );
  const openHandler = source.slice(
    source.indexOf("const openTeamMessageHistory"),
    source.indexOf("const teamMsgColumns")
  );

  assert.match(source, /useState<'credit' \| 'all'>\('all'\)/);
  assert.doesNotMatch(source, /\{teamMsgTotal > 0 \? \(/);
  assert.match(teamLoader, /requestId === teamMessageRequestIdRef\.current[\s\S]*setTeamMsgLoading\(false\)/);
  assert.doesNotMatch(teamLoader, /requestId === teamMessageRequestIdRef\.current && !options\?\.silent[\s\S]*setTeamMsgLoading\(false\)/);
  assert.doesNotMatch(openHandler, /fetchTeamMessages/);
});

test("interactive account refresh commits the returned snapshot and reports cached results honestly", () => {
  const refreshHandler = source.slice(
    source.indexOf("const handleRefresh = async"),
    source.indexOf("const handleReLogin")
  );

  assert.match(refreshHandler, /const result = await refreshAccount\(accountId\)/);
  assert.match(refreshHandler, /snapshot: result\.snapshot/);
  assert.match(refreshHandler, /fetchAccount\(\{ force: true \}\)/);
  assert.match(refreshHandler, /result\.refresh_error \|\| result\.cached/);
  assert.doesNotMatch(refreshHandler, /fetchPhones\(/);
  assert.doesNotMatch(refreshHandler, /fetchMessages\(/);
  assert.doesNotMatch(refreshHandler, /message\.success\('资料和本地消息已刷新'\)/);
});

test("manual phone refresh shares background work and distinguishes pending or cached data", () => {
  const syncHandler = source.slice(
    source.indexOf("const syncOwnedPhones"),
    source.indexOf("const repairSmsReception")
  );

  assert.match(syncHandler, /getOrCreateAccountRequest\(/);
  assert.match(syncHandler, /refresh_pending/);
  assert.match(syncHandler, /data\.cached/);
  assert.doesNotMatch(syncHandler, /message\.success\('已刷新已购手机号'\)/);
});
