# 积分进度与商城历史订单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复账户升级目标值，按需同步 App 远端订单历史并安全合并本地审计记录，同时统一网页和 Telegram 的订单状态。

**Architecture:** 账户快照由后端序列化明确输出升级目标值；订单历史使用独立纯规范化与同步服务，远端成功时 upsert、失败时返回本地缓存；前端首次进入订单标签时触发同步。现有 Prisma 唯一键足够使用，不增加数据库迁移，也不在远端历史导入时发送 Telegram。

**Tech Stack:** TypeScript、Node.js test runner、tsx、Express、Prisma、React、Ant Design、SQLite。

---

## 文件边界

- Create: `backend/src/utils/serializers.test.ts`：升级目标值纯单元测试。
- Modify: `backend/src/utils/serializers.ts`：从快照原始数据解析并输出 `progress_point_total`。
- Modify: `frontend/src/types/index.ts`：补充快照目标值和订单列表响应类型。
- Modify: `frontend/src/pages/AccountDetail.tsx`：移除 `historyPoint` 总值兜底并优先使用后端字段。
- Modify: `backend/src/routes/frontend-cache.test.ts`：锁定前端升级进度结构。
- Create: `backend/src/services/point-store-order-history.ts`：远端订单字段规范化、状态映射、同步与缓存回退编排。
- Create: `backend/src/services/point-store-order-history.test.ts`：远端实际字段、异常记录、upsert、缓存与排序测试。
- Modify: `backend/src/services/point-store.ts`：提供 Prisma 与公共 GET 的生产适配器。
- Modify: `backend/src/routes/accounts.ts`：订单历史接口返回同步 envelope。
- Modify: `frontend/src/services/endpoints.ts`：消费订单列表 envelope。
- Modify: `frontend/src/pages/PointStore.tsx`：订单标签懒同步、刷新、中文状态和缓存提示。
- Create: `backend/src/routes/point-store-history-ui.test.ts`：订单页面结构回归。
- Create: `backend/src/services/telegram-notifier.test.ts`：订单状态 4/5 通知测试。
- Modify: `backend/src/services/telegram-notifier.ts`：统一订单状态标题。
- Modify: `backend/src/services/version.test.ts`：保留现有状态回归并补数字状态断言。

## 提交策略

本计划各任务完成后只运行测试和 `git diff/status`，不单独提交。三份实施计划全部通过后，在登录与发布计划中统一从 `0.2.6` 提升到 `0.2.7`，创建一次实现提交。

### Task 1: 后端明确序列化升级目标值

**Files:**
- Create: `backend/src/utils/serializers.test.ts`
- Modify: `backend/src/utils/serializers.ts`

- [ ] **Step 1: 写入失败测试**

在 `serializers.test.ts` 创建最小 `AccountSnapshot` 构造器，并加入三个测试：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { AccountSnapshot } from "@prisma/client";
import { serializeSnapshot } from "./serializers.js";

function snapshot(overrides: Partial<AccountSnapshot>): AccountSnapshot {
  return {
    id: 1,
    accountId: 1,
    dtDingtoneId: null,
    fullName: null,
    avatarUrl: null,
    gender: null,
    birthday: null,
    email: null,
    phone: null,
    aboutMe: null,
    feeling: null,
    company: null,
    school: null,
    country: null,
    state: null,
    city: null,
    primaryBalance: null,
    userGrade: null,
    validPoint: null,
    progressPoint: null,
    membershipType: null,
    membershipExpireAt: null,
    profileVerCode: null,
    rawJson: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

test("serializeSnapshot exposes explicit progress point total", () => {
  const result = serializeSnapshot(snapshot({
    userGrade: 4,
    rawJson: JSON.stringify({ publicPoint: { progressPointTotal: 5000, historyPoint: 3178.2 } }),
  }));
  assert.equal(result?.progress_point_total, 5000);
});

test("serializeSnapshot derives the V4 progress target", () => {
  const result = serializeSnapshot(snapshot({ userGrade: 4, rawJson: JSON.stringify({ publicPoint: {} }) }));
  assert.equal(result?.progress_point_total, 5000);
});

test("historyPoint is never accepted as the progress target", () => {
  const result = serializeSnapshot(snapshot({
    userGrade: 3,
    rawJson: JSON.stringify({ publicPoint: { historyPoint: 3178.2, validPoint: 1442.2 } }),
  }));
  assert.equal(result?.progress_point_total, null);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run from `backend`:

```powershell
node --import tsx --test src/utils/serializers.test.ts
```

Expected: FAIL，`progress_point_total` 尚不存在。

- [ ] **Step 3: 实现明确的总值解析**

在 `serializers.ts` 添加：

```ts
function resolveSnapshotProgressPointTotal(
  snapshot: Pick<AccountSnapshot, "rawJson" | "userGrade">
) {
  const raw = parseJsonRecord(snapshot.rawJson);
  const publicPoint = isRecord(raw?.publicPoint) ? raw.publicPoint : null;
  const gradeInfo = isRecord(publicPoint?.gradeInfo) ? publicPoint.gradeInfo : null;
  const userInfo = isRecord(publicPoint?.userInfo) ? publicPoint.userInfo : null;
  const explicit =
    pickNumber(publicPoint, ["progressPointTotal", "progress_point_total", "nextGradePoint", "nextLevelPoint"]) ??
    pickNumber(gradeInfo, ["progressPointTotal", "progress_point_total", "nextGradePoint", "nextLevelPoint"]) ??
    pickNumber(userInfo, ["progressPointTotal", "progress_point_total", "nextGradePoint", "nextLevelPoint"]);
  if (explicit !== null && explicit > 0) {
    return explicit;
  }
  return snapshot.userGrade === 4 ? 5000 : null;
}
```

并在 `serializeSnapshot()` 返回对象中加入：

```ts
progress_point_total: resolveSnapshotProgressPointTotal(snapshot),
```

不要将 `historyPoint`、`validPoint` 或 `progressPoint` 加入候选。

- [ ] **Step 4: 运行测试并确认 GREEN**

```powershell
node --import tsx --test src/utils/serializers.test.ts
```

Expected: 3 tests PASS。

- [ ] **Step 5: 检查本任务差异，不提交**

```powershell
git diff --check
git status --short
```

Expected: 仅出现本任务文件，`git diff --check` 无输出。

### Task 2: 前端只使用明确升级目标

**Files:**
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/pages/AccountDetail.tsx`
- Modify: `backend/src/routes/frontend-cache.test.ts`

- [ ] **Step 1: 扩展失败结构测试**

在 `frontend-cache.test.ts` 的升级进度测试中增加：

```ts
assert.doesNotMatch(progressTotalBlock, /historyPoint|history_point|validPoint/);
assert.match(accountDetailSource, /snapshot\?\.progress_point_total/);
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
node --import tsx --test src/routes/frontend-cache.test.ts
```

Expected: FAIL，因为当前候选仍包含 `historyPoint`，且未读取 `snapshot.progress_point_total`。

- [ ] **Step 3: 更新类型和取值优先级**

在 `AccountSnapshot` 接口中加入：

```ts
progress_point_total: number | null;
```

从 `parseSnapshotExtras().progressPointTotal` 的所有候选数组中删除：

```ts
"historyPoint"
"history_point"
```

将页面值改为：

```ts
const progressPointTotalValue =
  snapshot?.progress_point_total ??
  snapshotExtras.progressPointTotal ??
  (userGradeValue === 4 ? 5000 : null);
```

保持未知值显示 `-` 的现有 `formatNumber(..., '-')` 行为。

- [ ] **Step 4: 运行测试和前端构建**

```powershell
node --import tsx --test src/routes/frontend-cache.test.ts
npm --prefix ..\frontend run build
```

Expected: 测试 PASS，前端构建 exit 0。

- [ ] **Step 5: 检查差异，不提交**

```powershell
git diff --check
git status --short
```

### Task 3: 规范化远端订单实际字段与状态

**Files:**
- Create: `backend/src/services/point-store-order-history.ts`
- Create: `backend/src/services/point-store-order-history.test.ts`

- [ ] **Step 1: 写远端实际字段失败测试**

测试夹具使用已只读确认的字段：

```ts
const remoteOrder = {
  category: 1,
  categoryName: "Gift Card",
  orderAddress: "receiver@example.com",
  orderId: "remote-1",
  orderStatus: 4,
  orderTime: "2024.03.26 14:16",
  orderTimeStamp: "1711433760000",
  productId: 7001,
  productImage: "",
  productName: "Amazon Gift Card $5",
  productPrice: 999,
  productType: 1,
};

test("normalizes the real remote order shape", () => {
  const order = normalizeRemotePointStoreOrder(remoteOrder);
  assert.equal(order?.remoteOrderId, "remote-1");
  assert.equal(order?.productId, "7001");
  assert.equal(order?.productName, "Amazon Gift Card $5");
  assert.equal(order?.productPrice, 999);
  assert.equal(order?.email, "receiver@example.com");
  assert.equal(order?.status, "processing");
  assert.equal(order?.orderTime, new Date(1711433760000).toISOString());
});

test("maps remote status four and five", () => {
  assert.equal(normalizeRemotePointStoreOrderStatus(4), "processing");
  assert.equal(normalizeRemotePointStoreOrderStatus(5), "completed");
  assert.equal(normalizeRemotePointStoreOrderStatus(99), "unknown");
});

test("skips malformed rows without dropping valid orders", () => {
  const result = normalizeRemotePointStoreOrderList({
    Result: 1,
    data: [
      { ...remoteOrder, orderId: "valid-1" },
      { ...remoteOrder, orderId: "" },
      { ...remoteOrder, orderId: "valid-2", orderStatus: 5 },
    ],
  });
  assert.deepEqual(result.map((item) => item.remoteOrderId), ["valid-1", "valid-2"]);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
node --import tsx --test src/services/point-store-order-history.test.ts
```

Expected: FAIL，模块或导出函数尚不存在。

- [ ] **Step 3: 创建纯规范化模块**

定义以下公共类型和函数：

```ts
export type NormalizedPointStoreOrderStatus =
  | "pending"
  | "submitting"
  | "processing"
  | "completed"
  | "failed"
  | "unknown";

export type NormalizedRemotePointStoreOrder = {
  remoteOrderId: string;
  productId: string;
  productName: string;
  productPrice: number | null;
  email: string | null;
  status: NormalizedPointStoreOrderStatus;
  orderTime: string | null;
  rawInfoJson: string;
};

export function normalizeRemotePointStoreOrderStatus(value: unknown): NormalizedPointStoreOrderStatus {
  const numeric = typeof value === "number" ? value : Number(value);
  return ({
    0: "pending",
    1: "completed",
    2: "failed",
    3: "processing",
    4: "processing",
    5: "completed",
  } as Record<number, NormalizedPointStoreOrderStatus>)[numeric] ?? "unknown";
}
```

`normalizeRemotePointStoreOrder()` 必须校验非空 `orderId`，将 `productId` String 化，优先将毫秒 `orderTimeStamp` 转 ISO，缺失时保留 `orderTime`，并把单条远端记录安全序列化到 `rawInfoJson`。`normalizeRemotePointStoreOrderList()` 只接受 `Result` 缺失或为 1 且 `data` 为数组的响应。

- [ ] **Step 4: 运行测试并确认 GREEN**

```powershell
node --import tsx --test src/services/point-store-order-history.test.ts
```

Expected: 3 tests PASS。

- [ ] **Step 5: 检查差异，不提交**

```powershell
git diff --check
git status --short
```

### Task 4: 实现同步、upsert、缓存回退与排序

**Files:**
- Modify: `backend/src/services/point-store-order-history.ts`
- Modify: `backend/src/services/point-store-order-history.test.ts`
- Modify: `backend/src/services/point-store.ts`

- [ ] **Step 1: 写同步编排失败测试**

在测试文件构建内存依赖并断言：

```ts
test("syncs remote rows and keeps local audit orders", async () => {
  const upserts: NormalizedRemotePointStoreOrder[] = [];
  const localUnknown = storedOrder({ id: 9, remoteOrderId: null, status: "unknown" });
  const result = await synchronizePointStoreOrderHistory(
    { accountId: 1, pointUid: "point-uid", fallbackEmail: "fallback@example.com" },
    {
      fetchList: async () => ({ Result: 1, data: [remoteOrder] }),
      upsertRemoteOrder: async (_accountId, order) => { upserts.push(order); },
      listCachedOrders: async () => [localUnknown],
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    },
  );
  assert.equal(result.stale, false);
  assert.equal(result.syncError, null);
  assert.equal(upserts.length, 1);
  assert.ok(result.orders.some((item) => item.id === 9));
});

test("returns cache when remote sync fails", async () => {
  const cached = [storedOrder({ id: 3, status: "failed" })];
  const result = await synchronizePointStoreOrderHistory(
    { accountId: 1, pointUid: "point-uid", fallbackEmail: "fallback@example.com" },
    {
      fetchList: async () => { throw new Error("network down"); },
      upsertRemoteOrder: async () => { throw new Error("must not run"); },
      listCachedOrders: async () => cached,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    },
  );
  assert.equal(result.stale, true);
  assert.match(result.syncError ?? "", /远端订单同步失败/);
  assert.deepEqual(result.orders.map((item) => item.id), [3]);
});

test("sorts by actual order time before local creation time", async () => {
  const result = sortPointStoreOrders([
    storedOrder({ id: 1, remoteOrderId: "oldest", orderTime: "2024-01-01T00:00:00.000Z" }),
    storedOrder({ id: 2, remoteOrderId: "newest", orderTime: "2026-01-01T00:00:00.000Z" }),
    storedOrder({ id: 3, remoteOrderId: "middle", orderTime: "2025-01-01T00:00:00.000Z" }),
  ]);
  assert.deepEqual(result.map((item) => item.remoteOrderId), ["newest", "middle", "oldest"]);
});
```

- [ ] **Step 2: 运行并确认 RED**

```powershell
node --import tsx --test src/services/point-store-order-history.test.ts
```

Expected: FAIL，同步函数尚不存在。

- [ ] **Step 3: 实现依赖注入同步函数**

在模块中定义：

```ts
export type PointStoreOrderHistoryDependencies = {
  fetchList(pointUid: string): Promise<unknown>;
  upsertRemoteOrder(accountId: number, order: NormalizedRemotePointStoreOrder, fallbackEmail: string): Promise<void>;
  listCachedOrders(accountId: number): Promise<PointStoreOrder[]>;
  now(): Date;
};

export type PointStoreOrderHistoryResult = {
  orders: PointStoreOrder[];
  stale: boolean;
  syncError: string | null;
  syncedAt: Date | null;
};
```

`synchronizePointStoreOrderHistory()` 流程必须是：远端 GET、逐条 upsert、重新查询全部缓存、按 `orderTime ?? createdAt` 倒序；任何远端或 upsert 异常进入缓存回退，不删除已有行，不把 point UID 或原始异常返回给前端。

最小实现：

```ts
export async function synchronizePointStoreOrderHistory(
  input: { accountId: number; pointUid: string; fallbackEmail: string },
  dependencies: PointStoreOrderHistoryDependencies,
): Promise<PointStoreOrderHistoryResult> {
  try {
    const response = await dependencies.fetchList(input.pointUid);
    const remoteOrders = normalizeRemotePointStoreOrderList(response);
    for (const order of remoteOrders) {
      await dependencies.upsertRemoteOrder(input.accountId, order, input.fallbackEmail);
    }
    const orders = sortPointStoreOrders(await dependencies.listCachedOrders(input.accountId));
    return { orders, stale: false, syncError: null, syncedAt: dependencies.now() };
  } catch {
    const orders = sortPointStoreOrders(await dependencies.listCachedOrders(input.accountId));
    return {
      orders,
      stale: true,
      syncError: "远端订单同步失败，当前显示缓存数据",
      syncedAt: null,
    };
  }
}

export function sortPointStoreOrders(orders: PointStoreOrder[]) {
  return [...orders].sort((left, right) => {
    const leftTime = Date.parse(left.orderTime ?? "") || left.createdAt.getTime();
    const rightTime = Date.parse(right.orderTime ?? "") || right.createdAt.getTime();
    return rightTime - leftTime || right.id - left.id;
  });
}
```

- [ ] **Step 4: 在 point-store.ts 接入生产依赖**

新增：

```ts
export async function syncAndListAccountPointStoreOrders(accountId: number) {
  const account = await getAccountWithSnapshot(accountId);
  const pointUid = resolvePointUid(account);
  const fallbackEmail = normalizeOptionalString(account.email ?? account.snapshot?.email) ?? "";
  return synchronizePointStoreOrderHistory(
    { accountId, pointUid, fallbackEmail },
    {
      fetchList: (uid) => fetchPublicJson(`/pointstore/order/list?uid=${encodeURIComponent(uid)}`),
      upsertRemoteOrder: async (targetAccountId, order, emailFallback) => {
        await prisma.pointStoreOrder.upsert({
          where: { accountId_remoteOrderId: { accountId: targetAccountId, remoteOrderId: order.remoteOrderId } },
          update: {
            productId: order.productId,
            productName: order.productName,
            productPrice: order.productPrice,
            email: order.email ?? emailFallback,
            status: order.status,
            orderTime: order.orderTime,
            rawInfoJson: order.rawInfoJson,
          },
          create: {
            accountId: targetAccountId,
            remoteOrderId: order.remoteOrderId,
            productId: order.productId,
            productName: order.productName,
            productPrice: order.productPrice,
            email: order.email ?? emailFallback,
            status: order.status,
            orderTime: order.orderTime,
            rawInfoJson: order.rawInfoJson,
          },
        });
      },
      listCachedOrders: (targetAccountId) => prisma.pointStoreOrder.findMany({ where: { accountId: targetAccountId } }),
      now: () => new Date(),
    },
  );
}
```

不要覆盖 `rawOrderJson`，不要在同步历史时发送 Telegram。

- [ ] **Step 5: 运行单测和后端构建**

```powershell
node --import tsx --test src/services/point-store-order-history.test.ts
npm run build
```

Expected: tests PASS，build exit 0。

- [ ] **Step 6: 检查差异，不提交**

```powershell
git diff --check
git status --short
```

### Task 5: 修改订单 API envelope 与安全序列化

**Files:**
- Modify: `backend/src/services/point-store.ts`
- Modify: `backend/src/routes/accounts.ts`
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/services/endpoints.ts`

- [ ] **Step 1: 添加接口结构失败断言**

在 `point-store-order-history.test.ts` 增加邮箱脱敏测试：

```ts
test("masks order email addresses", () => {
  assert.equal(maskPointStoreEmail("receiver@example.com"), "r***r@example.com");
  assert.equal(maskPointStoreEmail("a@example.com"), "a***@example.com");
  assert.equal(maskPointStoreEmail(""), "-");
});
```

- [ ] **Step 2: 运行并确认 RED**

```powershell
node --import tsx --test src/services/point-store-order-history.test.ts
```

- [ ] **Step 3: 实现脱敏和来源字段**

`serializeStoredPointStoreOrder()` 返回：

```ts
email: maskPointStoreEmail(order.email),
source: order.rawOrderJson !== null || order.remoteOrderId === null ? "panel" : "remote",
```

脱敏函数实现为：

```ts
export function maskPointStoreEmail(value: string) {
  const [local, domain] = value.trim().split("@");
  if (!local || !domain) return "-";
  const visible = local.length === 1 ? local : `${local[0]}***${local.at(-1)}`;
  return `${visible}${local.length === 1 ? "***" : ""}@${domain}`;
}
```

路由改为调用 `syncAndListAccountPointStoreOrders()`，响应：

```ts
ok(res, {
  orders: result.orders.map(serializeStoredPointStoreOrder),
  stale: result.stale,
  sync_error: result.syncError,
  synced_at: result.syncedAt,
});
```

前端增加：

```ts
export interface PointStoreOrderListResult {
  orders: PointStoreOrder[];
  stale: boolean;
  sync_error: string | null;
  synced_at: string | null;
}
```

并给 `PointStoreOrder` 增加：

```ts
source: "panel" | "remote";
```

`getAccountPointStoreOrders()` 的泛型和返回值改成 `PointStoreOrderListResult`。

- [ ] **Step 4: 运行相关测试和构建**

```powershell
node --import tsx --test src/services/point-store-order-history.test.ts src/routes/management-upgrades.test.ts
npm run build
npm --prefix ..\frontend run build
```

Expected: tests PASS，双端构建 exit 0。

- [ ] **Step 5: 检查差异，不提交**

```powershell
git diff --check
git status --short
```

### Task 6: 订单标签按需同步与清晰状态

**Files:**
- Modify: `frontend/src/pages/PointStore.tsx`
- Create: `backend/src/routes/point-store-history-ui.test.ts`

- [ ] **Step 1: 写页面结构失败测试**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../../frontend/src/pages/PointStore.tsx", import.meta.url), "utf8");

test("point store loads remote history only when the order tab opens", () => {
  assert.match(page, /ordersLoaded/);
  assert.match(page, /loadOrders/);
  assert.match(page, /activeKey=\{activeTab\}/);
  assert.doesNotMatch(page, /Promise\.all\([\s\S]*getAccountPointStoreOrders\(accountId\)/);
});

test("point store distinguishes cached, failed, and empty histories", () => {
  assert.match(page, /当前显示缓存数据/);
  assert.match(page, /订单同步失败/);
  assert.match(page, /暂无历史订单/);
  assert.match(page, /最近同步/);
  assert.match(page, /进行中/);
  assert.match(page, /已完成/);
  assert.match(page, /本地审计|远端订单/);
});
```

- [ ] **Step 2: 运行并确认 RED**

```powershell
node --import tsx --test src/routes/point-store-history-ui.test.ts
```

- [ ] **Step 3: 重构页面加载状态**

新增状态：

```ts
const [activeTab, setActiveTab] = useState("products");
const [ordersLoaded, setOrdersLoaded] = useState(false);
const [ordersLoading, setOrdersLoading] = useState(false);
const [ordersStale, setOrdersStale] = useState(false);
const [ordersSyncError, setOrdersSyncError] = useState<string | null>(null);
const [ordersSyncedAt, setOrdersSyncedAt] = useState<string | null>(null);
```

初始 `load()` 只并发加载账户和商城。实现 `loadOrders()`：设置 loading，调用 endpoint，写入 orders/stale/error/time，成功后 `ordersLoaded=true`；手动刷新复用该函数。

Tabs 使用 `activeKey` 和 `onChange`，首次切换到 `orders` 时调用 `loadOrders()`。订单状态显示映射固定为：

```ts
const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "已提交",
  submitting: "提交中",
  processing: "进行中",
  completed: "已完成",
  failed: "失败",
  unknown: "未知",
};
```

有缓存错误时显示 warning Alert；无缓存且错误时显示 error Empty；真正无订单显示“暂无历史订单”。来源显示“本地审计”或“远端订单”。

- [ ] **Step 4: 运行结构测试和前端构建**

```powershell
node --import tsx --test src/routes/point-store-history-ui.test.ts
npm --prefix ..\frontend run build
```

Expected: PASS，build exit 0。

- [ ] **Step 5: 检查差异，不提交**

```powershell
git diff --check
git status --short
```

### Task 7: 统一 Telegram 订单状态

**Files:**
- Create: `backend/src/services/telegram-notifier.test.ts`
- Modify: `backend/src/services/telegram-notifier.ts`
- Modify: `backend/src/services/version.test.ts`

- [ ] **Step 1: 写数字状态失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { pointStoreNotificationTitle } from "./telegram-notifier.js";

test("maps remote order status four and five", () => {
  assert.equal(pointStoreNotificationTitle("4"), "积分商城订单处理中");
  assert.equal(pointStoreNotificationTitle("5"), "积分商城兑换成功");
});
```

并在 `version.test.ts` 的现有测试中加入同样的两条断言。

- [ ] **Step 2: 运行并确认 RED**

```powershell
node --import tsx --test src/services/telegram-notifier.test.ts src/services/version.test.ts
```

- [ ] **Step 3: 复用统一状态映射**

`pointStoreNotificationTitle()` 先使用 `normalizeRemotePointStoreOrderStatus(status)`，再按规范化状态返回：

```ts
if (normalized === "completed") return "积分商城兑换成功";
if (normalized === "failed") return "积分商城兑换失败";
if (normalized === "processing") return "积分商城订单处理中";
return "积分商城兑换已提交";
```

保持历史同步路径不调用通知函数。

- [ ] **Step 4: 运行测试**

```powershell
node --import tsx --test src/services/telegram-notifier.test.ts src/services/version.test.ts
```

Expected: PASS。

- [ ] **Step 5: 本计划验收，不提交**

```powershell
node --import tsx --test src/utils/serializers.test.ts src/services/point-store-order-history.test.ts src/services/telegram-notifier.test.ts src/services/version.test.ts src/routes/frontend-cache.test.ts src/routes/point-store-history-ui.test.ts
npm run build
npm --prefix ..\frontend run build
git diff --check
git status --short
```

Expected: 所有测试 PASS，双端构建 exit 0，未创建提交。
