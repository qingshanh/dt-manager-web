import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../../frontend/src/pages/PointStore.tsx", import.meta.url), "utf8");

test("point store loads remote history only when the order tab opens", () => {
  const initialLoadStart = page.indexOf("const load = useCallback");
  const initialLoadEnd = page.indexOf("const loadOrders", initialLoadStart);
  const initialLoadBlock = page.slice(initialLoadStart, initialLoadEnd);

  assert.match(page, /const \[activeTab, setActiveTab\] = useState\('products'\)/);
  assert.match(page, /const \[ordersLoaded, setOrdersLoaded\] = useState\(false\)/);
  assert.match(page, /const loadOrders = useCallback/);
  assert.doesNotMatch(initialLoadBlock, /getAccountPointStoreOrders/);
  assert.match(page, /activeKey=\{activeTab\}/);
  assert.match(page, /onChange=\{handleTabChange\}/);
  assert.match(page, /key === 'orders' && !ordersLoaded/);
  assert.match(page, /onClick=\{\(\) => void loadOrders\(\)\}/);
});

test("point store consumes synchronization metadata and distinguishes history states", () => {
  assert.match(page, /setOrders\(result\.orders\)/);
  assert.match(page, /setOrdersStale\(result\.stale\)/);
  assert.match(page, /setOrdersSyncError\(result\.sync_error\)/);
  assert.match(page, /setOrdersSyncedAt\(result\.synced_at\)/);
  assert.match(page, /最近同步/);
  assert.match(page, /resolvePointStoreHistoryView/);
});

test("point store history view state distinguishes cache, failure, and successful emptiness", async () => {
  const viewModuleUrl = new URL("../../../frontend/src/pages/point-store-view.ts", import.meta.url);
  const viewModule = await import(viewModuleUrl.href) as {
    resolvePointStoreHistoryView(input: { ordersCount: number; stale: boolean; syncError: string | null }): unknown;
  };
  const { resolvePointStoreHistoryView } = viewModule;

  assert.deepEqual(resolvePointStoreHistoryView({ ordersCount: 2, stale: true, syncError: "远端订单同步失败" }), {
    alert: { type: "warning", message: "当前显示缓存数据", description: "远端订单同步失败" },
    emptyText: "暂无历史订单",
  });
  assert.deepEqual(resolvePointStoreHistoryView({ ordersCount: 0, stale: true, syncError: "远端订单同步失败，当前显示缓存数据" }), {
    alert: { type: "error", message: "订单同步失败", description: "远端订单同步失败" },
    emptyText: "订单同步失败",
  });
  assert.deepEqual(resolvePointStoreHistoryView({ ordersCount: 0, stale: false, syncError: null }), {
    alert: null,
    emptyText: "暂无历史订单",
  });
});

test("point store presents normalized Chinese statuses and order provenance", () => {
  assert.match(page, /pending:\s*'已提交'/);
  assert.match(page, /submitting:\s*'提交中'/);
  assert.match(page, /processing:\s*'进行中'/);
  assert.match(page, /completed:\s*'已完成'/);
  assert.match(page, /failed:\s*'失败'/);
  assert.match(page, /unknown:\s*'未知'/);
  assert.match(page, /title:\s*'商品'/);
  assert.match(page, /title:\s*'积分'/);
  assert.match(page, /title:\s*'邮箱'/);
  assert.match(page, /title:\s*'实际时间'/);
  assert.match(page, /title:\s*'状态'/);
  assert.match(page, /title:\s*'来源'/);
  assert.match(page, /本地审计/);
  assert.match(page, /远端订单/);
});
