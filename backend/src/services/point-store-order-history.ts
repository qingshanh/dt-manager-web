import type { PointStoreOrder } from "@prisma/client";

type JsonRecord = Record<string, unknown>;

const REMOTE_ORDER_STATUS_BY_CODE: Record<number, NormalizedPointStoreOrderStatus> = {
  0: "pending",
  1: "completed",
  2: "failed",
  3: "processing",
  4: "processing",
  5: "completed",
};

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
  productPrice: number;
  email: string | null;
  status: NormalizedPointStoreOrderStatus;
  orderTime: string | null;
  rawInfoJson: string;
};

export type PointStoreOrderHistoryDependencies = {
  fetchList(pointUid: string): Promise<unknown>;
  upsertRemoteOrder(
    accountId: number,
    order: NormalizedRemotePointStoreOrder,
    fallbackEmail: string,
  ): Promise<void>;
  listCachedOrders(accountId: number): Promise<PointStoreOrder[]>;
  now(): Date;
};

export type PointStoreOrderHistoryResult = {
  orders: PointStoreOrder[];
  stale: boolean;
  syncError: string | null;
  syncedAt: Date | null;
};

export function normalizeRemotePointStoreOrderStatus(value: unknown): NormalizedPointStoreOrderStatus {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric) ? REMOTE_ORDER_STATUS_BY_CODE[numeric] ?? "unknown" : "unknown";
}

export function normalizeRemotePointStoreOrder(value: unknown): NormalizedRemotePointStoreOrder | null {
  if (!isRecord(value)) {
    return null;
  }
  const remoteOrderId = normalizeString(value.orderId);
  const productId = normalizeScalarString(value.productId);
  const productName = normalizeString(value.productName) ?? normalizeString(value.name);
  const productPrice = normalizeNumber(value.productPrice) ?? normalizeNumber(value.price);
  if (!remoteOrderId || !productId || !productName || productPrice === null || productPrice < 0) {
    return null;
  }
  return {
    remoteOrderId,
    productId,
    productName,
    productPrice,
    email: normalizeString(value.orderAddress),
    status: normalizeRemotePointStoreOrderStatus(value.orderStatus),
    orderTime: normalizeRemoteOrderTime(value.orderTimeStamp, value.orderTime),
    rawInfoJson: safeJsonStringify(value),
  };
}

export function normalizeRemotePointStoreOrderList(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Invalid remote point-store order response");
  }
  if (value.Result !== 1 || !Array.isArray(value.data)) {
    throw new Error("Remote point-store order response was not successful");
  }
  return value.data.flatMap((item) => {
    const order = normalizeRemotePointStoreOrder(item);
    return order ? [order] : [];
  });
}

export async function synchronizePointStoreOrderHistory(
  input: { accountId: number; pointUid: string; fallbackEmail: string },
  dependencies: PointStoreOrderHistoryDependencies,
): Promise<PointStoreOrderHistoryResult> {
  try {
    if (!input.pointUid.trim()) {
      throw new Error("Point-store uid is unavailable");
    }
    const response = await dependencies.fetchList(input.pointUid);
    const remoteOrders = normalizeRemotePointStoreOrderList(response);
    for (const order of remoteOrders) {
      await dependencies.upsertRemoteOrder(input.accountId, order, input.fallbackEmail);
    }
    return {
      orders: sortPointStoreOrders(await dependencies.listCachedOrders(input.accountId)),
      stale: false,
      syncError: null,
      syncedAt: dependencies.now(),
    };
  } catch {
    return {
      orders: sortPointStoreOrders(await dependencies.listCachedOrders(input.accountId)),
      stale: true,
      syncError: "远端订单同步失败，当前显示缓存数据",
      syncedAt: null,
    };
  }
}

export function safelyResolvePointStoreHistoryUid(resolveUid: () => string) {
  try {
    return resolveUid().trim();
  } catch {
    return "";
  }
}

export function sortPointStoreOrders(orders: PointStoreOrder[]) {
  return [...orders].sort((left, right) => {
    const leftTime = resolveStoredOrderSortTime(left);
    const rightTime = resolveStoredOrderSortTime(right);
    return rightTime - leftTime || right.id - left.id;
  });
}

export function maskPointStoreEmail(value: string) {
  const [local, domain] = value.trim().split("@");
  if (!local || !domain) {
    return "-";
  }
  const visible = local.length === 1 ? `${local}***` : `${local[0]}***${local.at(-1)}`;
  return `${visible}@${domain}`;
}

export function resolvePointStoreOrderSource(
  order: Pick<PointStoreOrder, "rawOrderJson" | "remoteOrderId">,
): "panel" | "remote" {
  return order.rawOrderJson?.trim() || order.remoteOrderId === null ? "panel" : "remote";
}

function resolveStoredOrderSortTime(order: Pick<PointStoreOrder, "orderTime" | "createdAt">) {
  if (order.orderTime) {
    const parsed = Date.parse(order.orderTime);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return order.createdAt.getTime();
}

function normalizeRemoteOrderTime(timestamp: unknown, fallback: unknown) {
  const milliseconds = normalizeNumber(timestamp);
  if (milliseconds !== null && milliseconds > 0) {
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return normalizeString(fallback);
}

function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeScalarString(value: unknown) {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
