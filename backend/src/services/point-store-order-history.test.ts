import assert from "node:assert/strict";
import test from "node:test";
import type { PointStoreOrder } from "@prisma/client";
import {
  type NormalizedRemotePointStoreOrder,
  maskPointStoreEmail,
  normalizeRemotePointStoreOrder,
  normalizeRemotePointStoreOrderList,
  normalizeRemotePointStoreOrderStatus,
  resolvePointStoreOrderSource,
  safelyResolvePointStoreHistoryUid,
  sortPointStoreOrders,
  synchronizePointStoreOrderHistory,
} from "./point-store-order-history.js";

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

test("normalizes the real remote point-store order shape", () => {
  const value = {
    ...remoteOrder,
    name: "Alias should not win",
    price: 123,
  };
  const order = normalizeRemotePointStoreOrder(value);

  assert.equal(order?.remoteOrderId, "remote-1");
  assert.equal(order?.productId, "7001");
  assert.equal(order?.productName, "Amazon Gift Card $5");
  assert.equal(order?.productPrice, 999);
  assert.equal(order?.email, "receiver@example.com");
  assert.equal(order?.status, "processing");
  assert.equal(order?.orderTime, new Date(1711433760000).toISOString());
  assert.deepEqual(JSON.parse(order?.rawInfoJson ?? "{}"), value);
});

test("supports legacy product name and price aliases only as fallbacks", () => {
  const order = normalizeRemotePointStoreOrder({
    ...remoteOrder,
    productName: undefined,
    productPrice: undefined,
    name: "Legacy gift card",
    price: "888",
  });

  assert.equal(order?.productName, "Legacy gift card");
  assert.equal(order?.productPrice, 888);
});

test("rejects rows with an order id but damaged product fields", () => {
  for (const damaged of [
    { ...remoteOrder, productId: "" },
    { ...remoteOrder, productName: "" },
    { ...remoteOrder, productPrice: "not-a-number" },
    { ...remoteOrder, productPrice: null },
    { ...remoteOrder, productPrice: -1 },
  ]) {
    assert.equal(normalizeRemotePointStoreOrder(damaged), null);
  }
});

test("maps all known remote order statuses", () => {
  assert.equal(normalizeRemotePointStoreOrderStatus(0), "pending");
  assert.equal(normalizeRemotePointStoreOrderStatus(1), "completed");
  assert.equal(normalizeRemotePointStoreOrderStatus(2), "failed");
  assert.equal(normalizeRemotePointStoreOrderStatus(3), "processing");
  assert.equal(normalizeRemotePointStoreOrderStatus("4"), "processing");
  assert.equal(normalizeRemotePointStoreOrderStatus(5), "completed");
  assert.equal(normalizeRemotePointStoreOrderStatus(99), "unknown");
});

test("falls back to the displayed order time when no valid timestamp exists", () => {
  const order = normalizeRemotePointStoreOrder({
    ...remoteOrder,
    orderTimeStamp: "not-a-timestamp",
    orderTime: "2024.03.26 14:16",
  });

  assert.equal(order?.orderTime, "2024.03.26 14:16");
});

test("skips malformed rows without dropping valid remote orders", () => {
  const result = normalizeRemotePointStoreOrderList({
    Result: 1,
    data: [
      { ...remoteOrder, orderId: "valid-1" },
      { ...remoteOrder, orderId: "" },
      null,
      { ...remoteOrder, orderId: "valid-1", productId: "", productName: "", productPrice: "bad" },
      { ...remoteOrder, orderId: "valid-2", orderStatus: 5 },
    ],
  });

  assert.deepEqual(result.map((item) => item.remoteOrderId), ["valid-1", "valid-2"]);
});

test("requires an explicit numeric success result and an array payload", () => {
  assert.throws(() => normalizeRemotePointStoreOrderList({ data: [remoteOrder] }), /not successful/);
  assert.throws(() => normalizeRemotePointStoreOrderList({ Result: "1", data: [remoteOrder] }), /not successful/);
  assert.throws(() => normalizeRemotePointStoreOrderList({ Result: 0, data: [remoteOrder] }), /not successful/);
  assert.throws(() => normalizeRemotePointStoreOrderList({ Result: 1, data: {} }), /not successful/);
  assert.equal(normalizeRemotePointStoreOrderList({ Result: 1, data: [remoteOrder] }).length, 1);
});

function storedOrder(overrides: Partial<PointStoreOrder> = {}): PointStoreOrder {
  return {
    id: 1,
    accountId: 1,
    remoteOrderId: "cached-1",
    productId: "7001",
    productName: "Cached gift card",
    productPrice: 999,
    email: "cached@example.com",
    status: "completed",
    orderTime: null,
    rawOrderJson: null,
    rawInfoJson: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("syncs each remote row and keeps local audit orders", async () => {
  const upserts: Array<{ accountId: number; order: NormalizedRemotePointStoreOrder; fallbackEmail: string }> = [];
  const cached = [
    storedOrder({ id: 9, remoteOrderId: null, status: "unknown", rawOrderJson: "{}" }),
    storedOrder({ id: 10, remoteOrderId: null, status: "submitting", rawOrderJson: "{}" }),
    storedOrder({ id: 11, remoteOrderId: null, status: "failed", rawOrderJson: "{}" }),
  ];

  const result = await synchronizePointStoreOrderHistory(
    { accountId: 1, pointUid: "point-uid", fallbackEmail: "fallback@example.com" },
    {
      fetchList: async () => ({ Result: 1, data: [remoteOrder, { ...remoteOrder, orderId: "remote-2" }] }),
      upsertRemoteOrder: async (accountId, order, fallbackEmail) => {
        upserts.push({ accountId, order, fallbackEmail });
      },
      listCachedOrders: async () => cached,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    },
  );

  assert.equal(upserts.length, 2);
  assert.deepEqual(upserts.map((item) => item.order.remoteOrderId), ["remote-1", "remote-2"]);
  assert.equal(upserts[0]?.accountId, 1);
  assert.equal(upserts[0]?.fallbackEmail, "fallback@example.com");
  assert.deepEqual(result.orders.map((item) => item.id), [11, 10, 9]);
  assert.equal(result.stale, false);
  assert.equal(result.syncError, null);
  assert.equal(result.syncedAt?.toISOString(), "2026-07-16T00:00:00.000Z");
});

test("returns sorted cache and a safe error when remote synchronization fails", async () => {
  const cached = [
    storedOrder({ id: 3, status: "failed", createdAt: new Date("2025-01-01T00:00:00.000Z") }),
    storedOrder({ id: 4, status: "unknown", createdAt: new Date("2026-01-01T00:00:00.000Z") }),
  ];
  const result = await synchronizePointStoreOrderHistory(
    { accountId: 1, pointUid: "secret-point-uid", fallbackEmail: "fallback@example.com" },
    {
      fetchList: async () => {
        throw new Error("network down for secret-point-uid");
      },
      upsertRemoteOrder: async () => {
        throw new Error("must not run");
      },
      listCachedOrders: async () => cached,
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    },
  );

  assert.deepEqual(result.orders.map((item) => item.id), [4, 3]);
  assert.equal(result.stale, true);
  assert.equal(result.syncError, "远端订单同步失败，当前显示缓存数据");
  assert.doesNotMatch(result.syncError ?? "", /secret-point-uid|network down/);
  assert.equal(result.syncedAt, null);
});

test("safely resolves a point uid without leaking resolver failures", () => {
  assert.equal(safelyResolvePointStoreHistoryUid(() => " point-uid "), "point-uid");
  assert.equal(safelyResolvePointStoreHistoryUid(() => ""), "");
  assert.equal(safelyResolvePointStoreHistoryUid(() => { throw new Error("private uid error"); }), "");
});

test("returns sorted cache without fetching when the point uid is missing", async () => {
  let fetchCalls = 0;
  const result = await synchronizePointStoreOrderHistory(
    { accountId: 1, pointUid: "", fallbackEmail: "fallback@example.com" },
    {
      fetchList: async () => {
        fetchCalls += 1;
        return { Result: 1, data: [remoteOrder] };
      },
      upsertRemoteOrder: async () => undefined,
      listCachedOrders: async () => [
        storedOrder({ id: 7, createdAt: new Date("2025-01-01T00:00:00.000Z") }),
        storedOrder({ id: 8, createdAt: new Date("2026-01-01T00:00:00.000Z") }),
      ],
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    },
  );

  assert.equal(fetchCalls, 0);
  assert.deepEqual(result.orders.map((item) => item.id), [8, 7]);
  assert.equal(result.stale, true);
  assert.equal(result.syncError, "远端订单同步失败，当前显示缓存数据");
  assert.equal(result.syncedAt, null);
});

test("returns an empty stale result when both point uid and cache are missing", async () => {
  const result = await synchronizePointStoreOrderHistory(
    { accountId: 1, pointUid: "", fallbackEmail: "" },
    {
      fetchList: async () => { throw new Error("must not fetch"); },
      upsertRemoteOrder: async () => { throw new Error("must not upsert"); },
      listCachedOrders: async () => [],
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    },
  );

  assert.deepEqual(result.orders, []);
  assert.equal(result.stale, true);
  assert.equal(result.syncError, "远端订单同步失败，当前显示缓存数据");
  assert.equal(result.syncedAt, null);
});

test("treats unsuccessful remote business responses as stale cache", async () => {
  const result = await synchronizePointStoreOrderHistory(
    { accountId: 1, pointUid: "point-uid", fallbackEmail: "fallback@example.com" },
    {
      fetchList: async () => ({ Result: 0, Reason: "private failure", data: [] }),
      upsertRemoteOrder: async () => undefined,
      listCachedOrders: async () => [storedOrder({ id: 6 })],
      now: () => new Date("2026-07-16T00:00:00.000Z"),
    },
  );

  assert.equal(result.stale, true);
  assert.equal(result.syncError, "远端订单同步失败，当前显示缓存数据");
  assert.deepEqual(result.orders.map((item) => item.id), [6]);
});

test("sorts by actual order time and otherwise by local creation time", () => {
  const result = sortPointStoreOrders([
    storedOrder({
      id: 1,
      remoteOrderId: "oldest",
      orderTime: "2024-01-01T00:00:00.000Z",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    }),
    storedOrder({
      id: 2,
      remoteOrderId: "newest",
      orderTime: "2026-01-01T00:00:00.000Z",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    }),
    storedOrder({
      id: 3,
      remoteOrderId: null,
      orderTime: null,
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    }),
  ]);

  assert.deepEqual(result.map((item) => item.remoteOrderId), ["newest", null, "oldest"]);
});

test("masks point-store order email addresses", () => {
  assert.equal(maskPointStoreEmail("receiver@example.com"), "r***r@example.com");
  assert.equal(maskPointStoreEmail("a@example.com"), "a***@example.com");
  assert.equal(maskPointStoreEmail(""), "-");
  assert.equal(maskPointStoreEmail("invalid"), "-");
});

test("distinguishes local audit and remote order sources", () => {
  const remote = storedOrder({
    remoteOrderId: "remote-1",
    rawOrderJson: null,
  });
  const panel = storedOrder({
    remoteOrderId: "remote-2",
    rawOrderJson: "{}",
  });
  const localWithoutRemoteId = storedOrder({
    remoteOrderId: null,
    rawOrderJson: null,
  });
  const remoteWithEmptyAuditPayload = storedOrder({
    remoteOrderId: "remote-3",
    rawOrderJson: "",
  });

  assert.equal(resolvePointStoreOrderSource(remote), "remote");
  assert.equal(resolvePointStoreOrderSource(panel), "panel");
  assert.equal(resolvePointStoreOrderSource(localWithoutRemoteId), "panel");
  assert.equal(resolvePointStoreOrderSource(remoteWithEmptyAuditPayload), "remote");
});
