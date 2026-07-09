import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const cachePath = new URL("../../../frontend/src/services/client-cache.ts", import.meta.url);
const dashboardSource = readFileSync(new URL("../../../frontend/src/pages/Dashboard.tsx", import.meta.url), "utf8");
const accountListSource = readFileSync(new URL("../../../frontend/src/pages/AccountList.tsx", import.meta.url), "utf8");
const accountDetailSource = readFileSync(new URL("../../../frontend/src/pages/AccountDetail.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../../../frontend/src/pages/Settings.tsx", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("../../../frontend/src/layouts/AppLayout.tsx", import.meta.url), "utf8");
const endpointsSource = readFileSync(new URL("../../../frontend/src/services/endpoints.ts", import.meta.url), "utf8");

test("pages render cached data immediately and refresh stale data in the background", () => {
  assert.equal(existsSync(cachePath), true);
  const cacheSource = readFileSync(cachePath, "utf8");
  assert.match(cacheSource, /readCachedData/);
  assert.match(cacheSource, /fetchCachedData/);
  assert.match(cacheSource, /invalidateCachedData/);
  assert.match(dashboardSource, /readCachedData<DashboardStats>/);
  assert.match(accountListSource, /readCachedData<PagedData<DtAccountListItem>>/);
  assert.match(accountDetailSource, /readCachedData<DtAccountDetail>/);
  assert.match(settingsSource, /readCachedData<SettingItem\[\]>/);
});

test("fallback polling is slower than direct page navigation and SSE carries fresh messages", () => {
  assert.match(layoutSource, /RECENT_MESSAGE_FALLBACK_POLL_MS\s*=\s*30_000/);
  assert.match(accountDetailSource, /LOCAL_MESSAGE_POLL_MS\s*=\s*30_000/);
});
test("message list refreshes bypass cached pages", () => {
  assert.match(accountDetailSource, /fetchMessages\(msgPage, \{ silent: true, suppressError: true, force: true \}\)/);
  assert.match(accountDetailSource, /fetchTeamMessages\(\{ silent: true, force: true \}\)/);
  assert.match(accountDetailSource, /fetchMessages\(msgPage, \{ force: true \}\)/);
  assert.match(accountDetailSource, /fetchMessages\(page, \{ force: true \}\)/);
});
test("account detail refreshes point store data without blocking the first account render", () => {
  assert.match(accountDetailSource, /getAccountPointStore/);
  assert.match(accountDetailSource, /useState<PointStoreData \| null>/);
  assert.match(accountDetailSource, /fetchPointStore\(\{ silent: true \}\)/);
  assert.match(accountDetailSource, /pointStore\?\.products/);
  assert.match(accountDetailSource, /data\.snapshot/);
});
test("account detail keeps non-critical fetches out of initial navigation", () => {
  assert.doesNotMatch(accountDetailSource, /fetchAccount\(\);\s*fetchPhones\(\);/);
  assert.doesNotMatch(accountDetailSource, /fetchAccount\(\);[\s\S]*?fetchPointStore\(\{ silent: true \}\);[\s\S]*?\}, \[accountId, fetchAccount, fetchPhones, fetchPointStore\]\)/);
  assert.match(accountDetailSource, /window\.setTimeout\(\(\) => \{\s*void fetchPointStore\(\{ silent: true \}\);/);
});

test("account detail uses point wording that separates redeemable points from upgrade progress", () => {
  assert.match(accountDetailSource, /title="可兑换积分"/);
  assert.match(accountDetailSource, /title="升级进度"/);
  assert.doesNotMatch(accountDetailSource, /title="有效积分"/);
  assert.doesNotMatch(accountDetailSource, /title="可用\/总积分"/);
});
test("recent-message fallback bypasses stale cache after initial baseline", () => {
  assert.match(layoutSource, /getRecentMessages\(10, \{ force: recentBaselineReadyRef\.current \}\)/);
});

test("upgrade progress total does not fall back to current redeemable points", () => {
  const progressTotalStart = accountDetailSource.indexOf("      progressPointTotal:");
  assert.notEqual(progressTotalStart, -1);
  const progressTotalEnd = accountDetailSource.indexOf("      expirePoint:", progressTotalStart);
  assert.notEqual(progressTotalEnd, -1);
  const progressTotalBlock = accountDetailSource.slice(progressTotalStart, progressTotalEnd);

  assert.doesNotMatch(progressTotalBlock, /gameRedeemInfo|gameHomePage|validPoint/);
  assert.match(accountDetailSource, /userGradeValue === 4 \? 5000 : null/);
  assert.match(accountDetailSource, /fetchMessages\(1, \{ force: true \}\)/);
});
test("page navigation API helpers avoid ten second hard timeouts", () => {
  assert.match(endpointsSource, /const PAGE_NAVIGATION_TIMEOUT_MS = 30_000/);
  for (const functionName of ["getAccount", "getAccountMessages", "getPhoneNumbers", "getAccountPoint", "getAccountPointStore"]) {
    const start = endpointsSource.indexOf(`export async function ${functionName}`);
    assert.notEqual(start, -1);
    const next = endpointsSource.indexOf("export async function", start + 1);
    const block = endpointsSource.slice(start, next > start ? next : undefined);
    assert.doesNotMatch(block, /timeout:\s*10_000/);
  }
});