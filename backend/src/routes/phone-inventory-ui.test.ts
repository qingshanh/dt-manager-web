import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

test("backend exposes scoped global phone inventory and confirmed refresh", () => {
  const index = read("backend/src/index.ts");
  const route = read("backend/src/routes/phone-numbers.ts");
  const accounts = read("backend/src/routes/accounts.ts");

  assert.match(index, /app\.use\("\/api\/phone-numbers", requireAuth, phoneNumbersRouter\)/);
  assert.match(index, /createPhoneNumbersRouter\(syncPhoneNumbersFromRemote\)/);
  assert.match(route, /phoneNumbersRouter\.get\("\/"/);
  assert.match(route, /keyword:\s*query\.keyword/);
  assert.match(route, /status:\s*query\.status/);
  assert.match(route, /countryCode:\s*query\.country_code/);
  assert.match(route, /providerId:\s*query\.provider_id/);
  assert.match(route, /req\.auth!\.userId/);
  assert.match(route, /phoneNumbersRouter\.post\("\/refresh-all"/);
  assert.match(route, /body\.confirm !== true/);
  assert.match(route, /where:\s*\{ adminId: req\.auth!\.userId \}/);
  assert.match(route, /refreshPhoneInventoryAccounts\(accounts, syncPhoneNumbersFromRemote, 2\)/);
  assert.match(route, /export function createPhoneNumbersRouter/);
  assert.doesNotMatch(route, /from "\.\/accounts\.js"/);
  assert.match(accounts, /export async function syncPhoneNumbersFromRemote/);
  assert.match(accounts, /waitForPhoneInventorySync\(accountId\)/);
  assert.match(accounts, /phone_numbers:\s*result\.phoneNumbers\.map\(serializePhoneNumber\)/);
  assert.match(accounts, /refresh_pending:\s*result\.refreshPending/);
  assert.match(accounts, /loadCachedPhoneNumbers\(accountId\)/);
  assert.match(accounts, /refresh_error:\s*formatPhoneInventoryRefreshError\(error\)/);
  assert.match(accounts, /cached:\s*true/);
});

test("interactive refreshes are bounded and never call cached data fresh", () => {
  const accounts = read("backend/src/routes/accounts.ts");
  const refreshStart = accounts.indexOf('accountsRouter.post("/:id/refresh"');
  const refreshEnd = accounts.indexOf('accountsRouter.get("/:id/point"', refreshStart);
  const refreshBlock = accounts.slice(refreshStart, refreshEnd);
  const phoneStart = accounts.indexOf('accountsRouter.post("/:id/phone-numbers/sync"');
  const phoneEnd = accounts.indexOf('accountsRouter.post("/:id/phone-numbers/enable-sms-reception"', phoneStart);
  const phoneBlock = accounts.slice(phoneStart, phoneEnd);

  assert.match(refreshBlock, /accountMonitorService\.withMaintenance/);
  assert.match(refreshBlock, /includePhoneNumbers:\s*false/);
  assert.match(refreshBlock, /allowHelperSnapshot:\s*false/);
  assert.match(refreshBlock, /allowAdbPoint:\s*false/);
  assert.match(refreshBlock, /includePublicEnrichment:\s*false/);
  assert.match(refreshBlock, /persistCachedSnapshot:\s*false/);
  assert.match(refreshBlock, /assetSignals\.gatewaySnapshotResolved/);
  assert.match(refreshBlock, /freshness:/);
  assert.match(phoneBlock, /refresh_pending:/);
  assert.match(phoneBlock, /waitForPhoneInventorySync/);
});

test("direct phone inventory synchronization never falls back to helper or ADB", () => {
  const accounts = read("backend/src/routes/accounts.ts");
  const syncBlock = accounts.slice(
    accounts.indexOf("export async function syncPhoneNumbersFromRemote"),
    accounts.indexOf("async function verifyDirectPhoneAction")
  );

  assert.match(syncBlock, /Phone inventory synchronization requires a valid direct account session/);
  assert.doesNotMatch(syncBlock, /executeHelperAction|listPhoneNumbersFromAdb|helperRefreshGateway/);
});

test("frontend exposes phone inventory types, filtered cache keys, and invalidation", () => {
  const types = read("frontend/src/types/index.ts");
  const endpoints = read("frontend/src/services/endpoints.ts");

  assert.match(types, /export interface PhoneInventoryPhone/);
  assert.match(types, /export interface PhoneInventoryGroup/);
  assert.match(types, /export interface PhoneInventoryResponse/);
  assert.match(types, /export interface PhoneInventoryRefreshResult/);
  assert.match(endpoints, /phoneInventory:\s*\(params[\s\S]*makeCacheKey\('phone-inventory:all', params \?\? \{\}\)/);
  assert.match(endpoints, /export async function getPhoneInventory/);
  assert.match(endpoints, /cacheKeys\.phoneInventory\(params\)/);
  assert.match(endpoints, /export async function refreshAllPhoneNumbers/);
  assert.match(endpoints, /invalidateCachedData\('phone-inventory:'\)/);
});

test("latest request guard accepts only the newest inventory request", async () => {
  const moduleUrl = pathToFileURL(path.join(root, "frontend/src/services/endpoints.ts")).href;
  const endpoints = await import(moduleUrl) as Record<string, unknown>;
  const factory = endpoints.createLatestRequestGuard;
  assert.ok(typeof factory === "function", "createLatestRequestGuard should be exported");

  const guard = factory() as { begin(): number; isLatest(requestId: number): boolean };
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(guard.isLatest(first), false);
  assert.equal(guard.isLatest(second), true);
});

test("inventory loading commits and finishes only for the latest request", () => {
  const page = read("frontend/src/pages/PhoneInventory.tsx");

  assert.match(page, /createLatestRequestGuard/);
  assert.match(page, /const requestId = loadRequestGuardRef\.current\.begin\(\)/);
  assert.match(page, /if \(!loadRequestGuardRef\.current\.isLatest\(requestId\)\) \{[\s\S]*return true;/);
  assert.match(page, /if \(loadRequestGuardRef\.current\.isLatest\(requestId\)\) \{[\s\S]*setLoading\(false\)/);
});

test("single-account phone synchronization uses a bounded interactive window", () => {
  const endpoints = read("frontend/src/services/endpoints.ts");
  const syncBlock = endpoints.match(/export async function syncPhoneNumbers\([\s\S]*?\n\}/)?.[0];
  assert.ok(syncBlock, "syncPhoneNumbers endpoint should exist");
  assert.match(syncBlock, /\{ timeout: 20_000 \}/);
  assert.doesNotMatch(syncBlock, /120_000/);
});

test("phone inventory page is routed, grouped, filterable, and limited to safe actions", () => {
  const app = read("frontend/src/App.tsx");
  const layout = read("frontend/src/layouts/AppLayout.tsx");
  const page = read("frontend/src/pages/PhoneInventory.tsx");

  assert.match(app, /const PhoneInventory = lazy\(\(\) => import\('\.\/pages\/PhoneInventory'\)\)/);
  assert.match(app, /path="phone-numbers" element=\{<PhoneInventory \/>\}/);
  assert.match(layout, /key: '\/phone-numbers'/);
  assert.match(layout, /label: '手机号管理'/);
  assert.match(page, /getPhoneInventory/);
  assert.match(page, /refreshAllPhoneNumbers/);
  assert.match(page, /syncPhoneNumbers/);
  assert.match(page, /updatePhoneNumberLabel/);
  assert.match(page, /document\.execCommand\('copy'\)/);
  assert.match(page, /navigate\(`\/accounts\/\$\{group\.account\.id\}`\)/);
  assert.match(page, /搜索手机号、备注、账户名称或账户 ID/);
  assert.match(page, /刷新全部/);
  assert.match(page, /完整详情/);
  assert.doesNotMatch(
    page,
    /renewPhoneNumber|pausePhoneNumber|resumePhoneNumber|cancelPhoneNumber|purchasePhoneNumber|>\s*(?:续费|暂停|恢复|取消|购号|购买号码)\s*<\/Button>/
  );
});

test("single-account refresh failures persist inside the matching account card", () => {
  const page = read("frontend/src/pages/PhoneInventory.tsx");
  const refreshGroup = page.match(/const refreshGroup = useCallback\([\s\S]*?\n  \}, \[load, message\]\);/)?.[0];
  assert.ok(refreshGroup, "refreshGroup handler should exist");
  const failureBranch = refreshGroup.match(/catch \(error\) \{([\s\S]*?)\n    \} finally/)?.[1];
  assert.ok(failureBranch, "refreshGroup catch branch should exist");

  assert.match(page, /const \[accountRefreshErrors, setAccountRefreshErrors\] = useState<Record<number, string>>\(\{\}\)/);
  assert.match(page, /setAccountRefreshErrors\(\(current\) => \(\{ \.\.\.current, \[accountId\]: errorMessage \}\)\)/);
  assert.match(page, /delete next\[accountId\]/);
  assert.match(page, /accountRefreshErrors\[group\.account\.id\][\s\S]*<Alert[\s\S]*刷新失败[\s\S]*重新刷新/);
  assert.doesNotMatch(failureBranch, /message\.error\(/);
});

test("refresh-all keeps the POST summary when the following list reload fails", () => {
  const page = read("frontend/src/pages/PhoneInventory.tsx");

  assert.match(page, /const \[lastRefreshResult, setLastRefreshResult\] = useState<PhoneInventoryRefreshResult \| null>\(null\)/);
  assert.match(
    page,
    /const result = await refreshAllPhoneNumbers\(\);[\s\S]*setLastRefreshResult\(result\);[\s\S]*const reloaded = await load\(true, false\);[\s\S]*if \(!reloaded\)[\s\S]*刷新已完成，但列表重载失败/
  );
  assert.match(page, /lastRefreshResult\.results\.map/);
  assert.match(page, /return true;/);
  assert.match(page, /return false;/);
});

test("query failures remain visible with retry and the phone layout adapts to narrow screens", () => {
  const page = read("frontend/src/pages/PhoneInventory.tsx");

  assert.match(page, /const \[loadError, setLoadError\] = useState<string \| null>\(null\)/);
  assert.match(page, /setLoadError\(null\)/);
  assert.match(page, /setLoadError\(errorMessage\)/);
  assert.match(page, /message="手机号列表加载失败"[\s\S]*重新加载/);
  assert.match(page, /!loadError && data\.groups\.length === 0/);
  assert.match(page, /Grid\.useBreakpoint\(\)/);
  assert.match(page, /width: isNarrow \? '100%' : 300/);
  assert.match(page, /gridTemplateColumns: isNarrow \? 'minmax\(0, 1fr\)'/);
  assert.match(page, /flexWrap: 'wrap'/);
});
