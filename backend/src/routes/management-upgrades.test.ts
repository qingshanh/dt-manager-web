import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../../..");

function readProjectFile(relativePath: string) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("persists account ordering and point-store order history", () => {
  const schema = readProjectFile("backend/prisma/schema.prisma");
  assert.match(schema, /sortOrder\s+Int\s+@default\(0\)\s+@map\("sort_order"\)/);
  assert.match(schema, /pointStoreOrders\s+PointStoreOrder\[\]/);
  assert.match(schema, /model PointStoreOrder \{/);
  assert.match(schema, /remoteOrderId\s+String\?\s+@map\("remote_order_id"\)/);
  assert.match(schema, /status\s+String\s+@default\("pending"\)/);
  assert.match(schema, /@@index\(\[accountId, createdAt\(sort: Desc\)\]\)/);
});

test("account list uses persisted order and the refreshed bound phone", () => {
  const source = readProjectFile("backend/src/routes/accounts.ts");
  const runtime = readProjectFile("backend/src/services/account-runtime.ts");
  assert.match(source, /orderBy:\s*\[\{ sortOrder: "asc" \}, \{ createdAt: "desc" \}\]/);
  assert.match(source, /snapshot:\s*\{\s*select:\s*\{\s*fullName: true,\s*phone: true/s);
  assert.match(source, /phone:\s*resolveAccountBoundPhone\(item\)/);
  assert.match(runtime, /!normalizeOptionalString\(snapshot\.phone\)/);
  assert.match(runtime, /snapshotBelongsToDtUserId\(helperSnapshotCandidate, dtUserId\)/);
});

test("frontend account types expose stable ordering and point-store order history", () => {
  const source = readProjectFile("frontend/src/types/index.ts");
  assert.match(source, /sort_order: number;/);
  assert.match(source, /export interface PointStoreOrder \{/);
  assert.match(source, /remote_order_id: string \| null;/);
  assert.match(source, /status: string;/);
});

test("backend exposes global read, unread notifications, bulk actions, and ordering", () => {
  const accounts = readProjectFile("backend/src/routes/accounts.ts");
  const dashboard = readProjectFile("backend/src/routes/dashboard.ts");
  const events = readProjectFile("backend/src/routes/events.ts");
  const eventBus = readProjectFile("backend/src/services/event-bus.ts");

  assert.match(accounts, /accountsRouter\.param\("id"[\s\S]*adminId: req\.auth!\.userId/);
  assert.match(accounts, /prisma\.message\.deleteMany\([\s\S]*accountId/);
  assert.match(accounts, /accountsRouter\.post\("\/bulk-action"/);
  assert.match(accounts, /start_monitor/);
  assert.match(accounts, /telegram_on/);
  assert.match(accounts, /mark_unread/);
  assert.match(accounts, /accountsRouter\.post\("\/:id\/reorder"/);
  assert.match(accounts, /move_top/);
  assert.match(accounts, /runSerializedAccountReorder/);
  assert.match(dashboard, /dashboardRouter\.get\("\/notifications"/);
  assert.match(dashboard, /dashboardRouter\.put\("\/messages\/read-all"/);
  assert.match(eventBus, /adminId: number/);
  assert.match(events, /event\.adminId !== auth\.userId/);
});

test("SSE message events carry the target phone number", () => {
  const runtime = readProjectFile("backend/src/services/message-runtime.ts");
  const types = readProjectFile("frontend/src/types/index.ts");

  assert.match(runtime, /toNumber: normalizedPush\.toNumber/);
  assert.match(runtime, /toNumber,\s*content,\s*msgType/s);
  assert.match(types, /export interface SSENewMessageEvent[\s\S]*toNumber: string \| null;/);
});

test("point store supports email override, persisted history, status refresh, and Telegram notification", () => {
  const routes = readProjectFile("backend/src/routes/accounts.ts");
  const store = readProjectFile("backend/src/services/point-store.ts");
  const notifier = readProjectFile("backend/src/services/telegram-notifier.ts");

  assert.match(routes, /pointStoreOrderSchema[\s\S]*email: z\.string\(\)\.trim\(\)\.email\(\)\.optional\(\)/);
  assert.match(routes, /accountsRouter\.get\("\/:id\/pointstore\/orders"/);
  assert.match(routes, /accountsRouter\.post\("\/:id\/pointstore\/orders\/:orderId\/refresh"/);
  assert.match(store, /export async function listAccountPointStoreOrders/);
  assert.match(store, /export async function refreshAccountPointStoreOrder/);
  assert.match(store, /prisma\.pointStoreOrder\.create/);
  const orderAttemptIndex = store.indexOf("const orderAttempt = await prisma.pointStoreOrder.create");
  const remoteOrderIndex = store.indexOf("orderResponse = await fetchPublicJson");
  assert.ok(orderAttemptIndex >= 0 && remoteOrderIndex > orderAttemptIndex);
  assert.match(store, /status: "submitting"/);
  assert.match(store, /return "pending"/);
  assert.match(store, /sendPointStoreTelegramNotification/);
  assert.match(notifier, /export async function sendPointStoreTelegramNotification/);
  assert.match(notifier, /订单 ID/);
});

test("dashboard and account list expose the requested management controls", () => {
  const dashboard = readProjectFile("frontend/src/pages/Dashboard.tsx");
  const accounts = readProjectFile("frontend/src/pages/AccountList.tsx");

  assert.match(dashboard, /markAllDashboardMessagesRead/);
  assert.match(dashboard, /dataIndex: 'to_number'/);
  assert.match(dashboard, /title: '内容'[\s\S]*width: 320/);
  assert.match(dashboard, /scroll=\{\{ x: 1020 \}\}/);
  assert.match(accounts, /rowSelection=/);
  assert.match(accounts, /bulkAccountAction/);
  assert.match(accounts, /reorderAccount/);
  assert.doesNotMatch(accounts, /title: '排序'[\s\S]{0,120}fixed: 'right'/);
  assert.match(accounts, /setSelectedAccountIds\(\(items\) => items\.filter\(\(item\) => item !== id\)\)/);
  assert.match(accounts, /if \(!document\.execCommand\('copy'\)\)/);
  assert.match(accounts, /title: '邮箱'[\s\S]*width: 196/);
  assert.match(accounts, /title: '用户 ID'[\s\S]*width: 120/);
  assert.match(accounts, /message\.success\('copied'\)/);
});

test("header bell shows unread messages and the sidebar stays visible", () => {
  const layout = readProjectFile("frontend/src/layouts/AppLayout.tsx");

  assert.match(layout, /getUnreadNotifications/);
  assert.match(layout, /markAllDashboardMessagesRead/);
  assert.match(layout, /<Popover/);
  assert.match(layout, /if \(!rememberIncomingMessage\(data\)\)/);
  assert.ok(layout.indexOf("rememberIncomingMessage(data)") < layout.indexOf("dispatchIncomingMessage(data)"));
  assert.match(layout, /position: 'sticky'/);
  assert.match(layout, /breakpoint="lg"/);
  assert.match(layout, /overflowY: 'auto'/);
  assert.doesNotMatch(layout, /onClick=\{\(\) => setNotificationCount\(0\)\}/);
});

test("point store is a dedicated routed page with redemption and order history", () => {
  const app = readProjectFile("frontend/src/App.tsx");
  const detail = readProjectFile("frontend/src/pages/AccountDetail.tsx");
  const storePage = readProjectFile("frontend/src/pages/PointStore.tsx");

  assert.match(app, /accounts\/:id\/point-store/);
  assert.match(detail, /navigate\(`\/accounts\/\$\{accountId\}\/point-store`\)/);
  assert.match(storePage, /orderPointStoreProduct/);
  assert.match(storePage, /getAccountPointStoreOrders/);
  assert.match(storePage, /refreshPointStoreOrder/);
  assert.match(storePage, /modal\.confirm/);
  assert.match(storePage, /setEmail\(defaultEmail\)/);
});

test("message page handles SSE locally instead of refetching system messages and account details", () => {
  const detail = readProjectFile("frontend/src/pages/AccountDetail.tsx");
  const cache = readProjectFile("frontend/src/services/client-cache.ts");
  const handler = detail.slice(detail.indexOf("const handleNewMessage"), detail.indexOf("window.addEventListener", detail.indexOf("const handleNewMessage")));

  assert.match(handler, /setMessages/);
  assert.match(handler, /detail\.msgType === 'system'/);
  assert.match(handler, /if \(msgPage === 1\)/);
  assert.doesNotMatch(handler, /setMsgPage\(1\)/);
  assert.doesNotMatch(handler, /fetchTeamMessages/);
  assert.doesNotMatch(handler, /fetchAccount/);
  assert.match(cache, /cacheGenerations/);
  assert.match(cache, /generation === getCacheGeneration\(key\)/);
});

test("version service identifies every commit and checks origin main", () => {
  const service = readProjectFile("backend/src/services/version.ts");
  const route = readProjectFile("backend/src/routes/version.ts");
  const index = readProjectFile("backend/src/index.ts");
  const settings = readProjectFile("frontend/src/pages/Settings.tsx");

  assert.match(service, /const buildVersion = commit\.shortSha \? `\$\{version\}\+\$\{commit\.shortSha\}` : version/);
  assert.match(service, /api\.github\.com\/repos/);
  assert.match(service, /updateAvailable/);
  assert.match(service, /sameCommitSha/);
  assert.match(service, /readGitHead/);
  assert.match(route, /versionRouter\.get\("\/"/);
  assert.match(index, /app\.use\("\/api\/version"/);
  assert.match(settings, /getVersionInfo/);
  assert.match(settings, /latest_version/);
  assert.match(settings, /检测更新/);
  assert.match(settings, /recent_versions/);
});

test("phone actions normalize second timestamps and verify that renewal advanced expiry", () => {
  const gateway = readProjectFile("backend/src/services/dingtone/direct-gateway.ts");
  const routes = readProjectFile("backend/src/routes/accounts.ts");

  assert.match(gateway, /expireTime > 1_000_000_000_000 \? expireTime : expireTime \* 1000/);
  assert.match(routes, /const renewalBaseline = useDirect \? await getDirectPhoneBaseline\(account, phoneItem\) : phoneItem/);
  assert.match(routes, /assertPhoneRenewalAdvanced\(phoneItem, matched\)/);
  assert.match(routes, /previousExpiry !== null && currentExpiry !== null && currentExpiry > previousExpiry/);
  assert.match(routes, /Remote verification failed: renewed phone expiry did not advance/);
});

test("phone number preview stops after one endpoint pass on transport failures", () => {
  const gateway = readProjectFile("backend/src/services/dingtone/direct-gateway.ts");

  assert.match(gateway, /this\.withSession\(runtime, account, async \(session\) => \{[\s\S]*?\}, 1\);/);
  assert.match(gateway, /if \(isDirectTransportError\(error\)\) \{\s*break;\s*\}/);
  assert.match(gateway, /function isDirectTransportError\(error: unknown\)/);
  assert.match(gateway, /socket ended/);
});
