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
  const routes = readProjectFile("backend/src/routes/accounts.ts");
  assert.match(schema, /sortOrder\s+Int\s+@default\(0\)\s+@map\("sort_order"\)/);
  assert.match(schema, /pointStoreOrders\s+PointStoreOrder\[\]/);
  assert.match(schema, /model PointStoreOrder \{/);
  assert.match(schema, /remoteOrderId\s+String\?\s+@map\("remote_order_id"\)/);
  assert.match(schema, /status\s+String\s+@default\("pending"\)/);
  assert.match(schema, /@@index\(\[accountId, createdAt\(sort: Desc\)\]\)/);
  assert.match(routes, /sort_order: account\.sortOrder/);
  assert.match(routes, /sortOrder: incomingSortOrder !== null/);
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

test("team messages stay inside account history instead of dashboard notifications", () => {
  const accounts = readProjectFile("backend/src/routes/accounts.ts");
  const dashboard = readProjectFile("backend/src/services/dashboard.service.ts");
  const detail = readProjectFile("frontend/src/pages/AccountDetail.tsx");

  assert.match(accounts, /where: \{ accountId: \{ in: accountIds \}, isRead: false, msgType: \{ not: MessageType\.system \} \}/);
  assert.match(accounts, /where: \{ accountId: \{ in: body\.account_ids \}, msgType: \{ not: MessageType\.system \} \}/);
  assert.match(dashboard, /getRecentMessages[\s\S]*msgType:\s*\{ not: MessageType\.system \}/);
  assert.match(dashboard, /getUnreadNotifications[\s\S]*msgType:\s*\{ not: MessageType\.system \}/);
  assert.match(detail, /teamMessageModalOpen/);
  assert.match(detail, /消息历史/);
  assert.match(detail, /teamMsgTotal/);
  assert.match(detail, /fetchTeamMessages\(page/);
  assert.match(detail, /msg_type:\s*'system'/);
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
  assert.match(store, /POINT_STORE_ORDER_GUARD_MS/);
  assert.match(store, /const orderGuardKey = `\$\{accountId\}:\$\{productId\}`/);
  assert.match(store, /OR: \[[\s\S]*\{ status: "unknown" \}[\s\S]*status: "submitting"/);
  assert.match(store, /status: "unknown"/);
  assert.match(store, /POINT_STORE_ORDER_UNCERTAIN_MESSAGE/);
  assert.match(store, /export function resolveSuccessfulPointStoreOrderStatus/);
  assert.match(store, /readOrderStatus\(orderInfo\) \?\? readOrderStatus\(order\) \?\? "completed"/);
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
  const detail = readProjectFile("frontend/src/pages/AccountDetail.tsx");

  assert.match(layout, /getUnreadNotifications/);
  assert.match(layout, /markAllDashboardMessagesRead/);
  assert.match(layout, /<Popover/);
  assert.match(layout, /navigate\(`\/accounts\/\$\{item\.account_id\}\?tab=messages&messageId=\$\{item\.id\}`\)/);
  assert.match(detail, /useSearchParams\(\)/);
  assert.match(detail, /searchParams\.get\('tab'\) === 'messages'/);
  assert.match(detail, /activeKey=\{activeTab\}/);
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
  const storeService = readProjectFile("backend/src/services/point-store.ts");

  assert.match(app, /accounts\/:id\/point-store/);
  assert.match(detail, /navigate\(`\/accounts\/\$\{accountId\}\/point-store`\)/);
  assert.match(storePage, /orderPointStoreProduct/);
  assert.match(storePage, /getAccountPointStoreOrders/);
  assert.match(storePage, /refreshPointStoreOrder/);
  assert.match(storePage, /modal\.confirm/);
  assert.match(storePage, /setEmail\(defaultEmail\)/);
  assert.match(storePage, /pointStoreOrderFeedback/);
  assert.match(storeService, /pointStoreNotificationTitle/);
});

test("message page handles SSE locally instead of refetching system messages and account details", () => {
  const detail = readProjectFile("frontend/src/pages/AccountDetail.tsx");
  const cache = readProjectFile("frontend/src/services/client-cache.ts");
  const handler = detail.slice(detail.indexOf("const handleNewMessage"), detail.indexOf("window.addEventListener", detail.indexOf("const handleNewMessage")));

  assert.match(handler, /setMessages/);
  assert.match(handler, /detail\.msgType === 'system'/);
  assert.match(handler, /if \(msgPage === 1\)/);
  assert.match(detail, /const messageRequestIdRef = useRef\(0\)/);
  assert.match(detail, /const teamMessageRequestIdRef = useRef\(0\)/);
  assert.match(detail, /const requestId = \+\+messageRequestIdRef\.current/);
  assert.match(detail, /const requestId = \+\+teamMessageRequestIdRef\.current/);
  assert.match(detail, /requestId !== messageRequestIdRef\.current/);
  assert.match(detail, /requestId !== teamMessageRequestIdRef\.current/);
  assert.match(handler, /teamMessageRequestIdRef\.current \+= 1/);
  assert.match(handler, /messageRequestIdRef\.current \+= 1/);
  assert.match(handler, /setTeamMsgTotal\(\(current\) => current \+ 1\)/);
  assert.doesNotMatch(handler, /setMsgPage\(1\)/);
  assert.doesNotMatch(handler, /fetchTeamMessages/);
  assert.doesNotMatch(handler, /fetchAccount/);
  assert.match(cache, /cacheGenerations/);
  assert.match(cache, /generation === getCacheGeneration\(key\)/);
});

test("message tab fetches immediately instead of waiting for the fallback polling interval", () => {
  const detail = readProjectFile("frontend/src/pages/AccountDetail.tsx");
  const pollingEffect = detail.slice(
    detail.indexOf("const pollLocalMessages"),
    detail.indexOf("}, [activeTab, fetchMessages", detail.indexOf("const pollLocalMessages")),
  );
  const tabHandler = detail.slice(
    detail.indexOf("const handleTabChange"),
    detail.indexOf("const handleMonitorToggle", detail.indexOf("const handleTabChange")),
  );
  const messageTable = detail.slice(
    detail.indexOf("<Table\n                  columns={msgColumns}"),
    detail.indexOf("scroll={{ x: 860 }}", detail.indexOf("<Table\n                  columns={msgColumns}")),
  );

  assert.match(pollingEffect, /void pollLocalMessages\(false\);[\s\S]*window\.setInterval/);
  assert.match(pollingEffect, /fetchMessages\(msgPage, \{ silent, suppressError: silent, force: true \}\)/);
  assert.doesNotMatch(tabHandler, /fetchMessages/);
  assert.doesNotMatch(tabHandler, /fetchTeamMessages/);
  assert.doesNotMatch(messageTable, /fetchMessages/);
});

test("notification deep links load and highlight the selected account message", () => {
  const routes = readProjectFile("backend/src/routes/accounts.ts");
  const endpoints = readProjectFile("frontend/src/services/endpoints.ts");
  const detail = readProjectFile("frontend/src/pages/AccountDetail.tsx");
  const styles = readProjectFile("frontend/src/styles.css");

  assert.match(routes, /accountsRouter\.get\("\/:id\/messages\/:messageId"/);
  assert.match(endpoints, /export async function getAccountMessage/);
  assert.match(detail, /const focusedMessageId/);
  assert.match(detail, /getAccountMessage\(accountId, focusedMessageId\)/);
  assert.match(detail, /record\.id === focusedMessageId \? 'message-row-focused' : ''/);
  assert.match(styles, /\.message-row-focused > td/);
});

test("version service identifies every commit and checks origin main", () => {
  const service = readProjectFile("backend/src/services/version.ts");
  const route = readProjectFile("backend/src/routes/version.ts");
  const index = readProjectFile("backend/src/index.ts");
  const settings = readProjectFile("frontend/src/pages/Settings.tsx");

  assert.match(service, /const buildVersion = commit\.shortSha \? `\$\{version\}\+\$\{commit\.shortSha\}` : version/);
  assert.match(service, /api\.github\.com\/repos/);
  assert.match(service, /updateAvailable/);
  assert.match(service, /update_status: updateStatus/);
  assert.match(service, /gitIsAncestor/);
  assert.match(service, /classifyVersionRelation/);
  assert.match(service, /sameCommitSha/);
  assert.match(service, /readGitHead/);
  assert.match(service, /per_page=100/);
  assert.match(route, /versionRouter\.get\("\/"/);
  assert.match(index, /app\.use\("\/api\/version"/);
  assert.match(settings, /getVersionInfo/);
  assert.match(settings, /latest_version/);
  assert.match(settings, /检测更新/);
  assert.match(settings, /本地领先/);
  assert.match(settings, /分支不同/);
  assert.match(settings, /recent_versions/);
  assert.match(settings, /versionSearch/);
  assert.match(settings, /pagination=\{\{ pageSize: 10/);
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
