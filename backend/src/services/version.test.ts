import assert from "node:assert/strict";
import test from "node:test";

test("version relation does not report an update when the local commit is ahead", async () => {
  const service = await import("./version.js") as Record<string, unknown>;
  assert.equal(typeof service.classifyVersionRelation, "function");

  const classify = service.classifyVersionRelation as (input: {
    sameCommit: boolean;
    localFoundInRemoteHistory: boolean;
    localIsAncestor: boolean | null;
    latestIsAncestor: boolean | null;
  }) => string;

  assert.equal(classify({ sameCommit: true, localFoundInRemoteHistory: true, localIsAncestor: true, latestIsAncestor: true }), "current");
  assert.equal(classify({ sameCommit: false, localFoundInRemoteHistory: true, localIsAncestor: null, latestIsAncestor: null }), "behind");
  assert.equal(classify({ sameCommit: false, localFoundInRemoteHistory: false, localIsAncestor: true, latestIsAncestor: false }), "behind");
  assert.equal(classify({ sameCommit: false, localFoundInRemoteHistory: false, localIsAncestor: false, latestIsAncestor: true }), "ahead");
  assert.equal(classify({ sameCommit: false, localFoundInRemoteHistory: false, localIsAncestor: false, latestIsAncestor: false }), "diverged");
  assert.equal(classify({ sameCommit: false, localFoundInRemoteHistory: false, localIsAncestor: null, latestIsAncestor: null }), "unknown");
});

test("point-store notification titles reflect the actual remote order status", async () => {
  const notifier = await import("./telegram-notifier.js") as Record<string, unknown>;
  assert.equal(typeof notifier.pointStoreNotificationTitle, "function");

  const title = notifier.pointStoreNotificationTitle as (status: string) => string;
  assert.equal(title("completed"), "积分商城兑换成功");
  assert.equal(title("success"), "积分商城兑换成功");
  assert.equal(title("failed"), "积分商城兑换失败");
  assert.equal(title("pending"), "积分商城兑换已提交");
  assert.equal(title("processing"), "积分商城订单处理中");
  assert.equal(title("4"), "积分商城订单处理中");
  assert.equal(title("5"), "积分商城兑换成功");
});

test("point-store rejects explicit business failures instead of rendering an empty store", async () => {
  const service = await import("./point-store.js") as Record<string, unknown>;
  assert.equal(typeof service.validatePointStoreBusinessResult, "function");

  const validate = service.validatePointStoreBusinessResult as (value: Record<string, unknown>, action: string) => void;
  assert.doesNotThrow(() => validate({ Result: 1, data: {} }, "load store"));
  assert.doesNotThrow(() => validate({ data: {} }, "load store"));
  assert.throws(() => validate({ Result: 0, Reason: "service unavailable" }, "load store"), /service unavailable/);
});

test("successful point-store orders default to completed when status fields are absent", async () => {
  const service = await import("./point-store.js") as Record<string, unknown>;
  assert.equal(typeof service.resolveSuccessfulPointStoreOrderStatus, "function");

  const resolveStatus = service.resolveSuccessfulPointStoreOrderStatus as (
    orderInfo: Record<string, unknown> | null,
    order: Record<string, unknown>
  ) => string;
  assert.equal(resolveStatus(null, { orderId: "123" }), "completed");
  assert.equal(resolveStatus({ status: "processing" }, { orderId: "123" }), "processing");
  assert.equal(resolveStatus(null, { status: 2 }), "failed");
  assert.equal(resolveStatus(null, { orderStatus: 4 }), "processing");
  assert.equal(resolveStatus(null, { orderStatus: 5 }), "completed");
});

test("point-store refresh normalization and terminal detection share remote status semantics", async () => {
  const service = await import("./point-store.js") as Record<string, unknown>;
  assert.equal(typeof service.normalizePointStoreOrderStatus, "function");
  assert.equal(typeof service.isTerminalPointStoreStatus, "function");

  const normalize = service.normalizePointStoreOrderStatus as (
    value: Record<string, unknown> | null,
    fallback?: string
  ) => string;
  const isTerminal = service.isTerminalPointStoreStatus as (status: string) => boolean;

  assert.equal(normalize({ orderStatus: 4 }), "processing");
  assert.equal(normalize({ orderStatus: 5 }), "completed");
  assert.equal(normalize({ status: "completed" }), "completed");
  assert.equal(normalize({ status: "failed" }), "failed");
  assert.equal(normalize({ status: "processing" }), "processing");
  assert.equal(normalize({ status: "custom-review" }), "custom-review");
  assert.equal(normalize(null, "pending"), "pending");

  assert.equal(isTerminal("5"), true);
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("4"), false);
  assert.equal(isTerminal("custom-review"), false);
});
