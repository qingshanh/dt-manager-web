import type { AccountSnapshot, DtAccount, PointStoreOrder } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError, assertFound } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { serializeSnapshot } from "../utils/serializers.js";
import { fetchPublicJson } from "./public-account-enrichment.js";
import {
  maskPointStoreEmail,
  normalizeRemotePointStoreOrderStatus,
  resolvePointStoreOrderSource,
  safelyResolvePointStoreHistoryUid,
  synchronizePointStoreOrderHistory,
} from "./point-store-order-history.js";
import { pointStoreNotificationTitle, sendPointStoreTelegramNotification } from "./telegram-notifier.js";

type JsonRecord = Record<string, unknown>;

const POINT_STORE_ORDER_GUARD_MS = 15 * 60_000;
const POINT_STORE_ORDER_UNCERTAIN_MESSAGE = "兑换请求结果未知，系统已阻止重复提交。请先检查历史订单、当前积分和收件邮箱，确认未兑换后再重试。";
const activePointStoreOrderKeys = new Set<string>();

export type PointStoreProduct = {
  productId: string;
  name: string;
  stock: number | null;
  price: number | null;
  rawJson: string;
};

export type AccountPointStore = {
  pointUid: string;
  email: string | null;
  userName: string | null;
  userGrade: number | null;
  validPoint: number | null;
  historyPoint: number | null;
  expirePoint: number | null;
  expireTime: string | null;
  products: PointStoreProduct[];
  snapshot: ReturnType<typeof serializeSnapshot> | null;
  raw: {
    userInfo: JsonRecord | null;
    store: JsonRecord | null;
  };
};

export async function getAccountPointStore(accountId: number): Promise<AccountPointStore> {
  const account = await getAccountWithSnapshot(accountId);
  const pointUid = resolvePointUid(account);
  const [userInfoResponse, storeResponse] = await Promise.all([
    fetchPublicJson(`/point/userinfo?uid=${encodeURIComponent(pointUid)}&zone=800`),
    fetchPublicJson(`/pointstore/entrance?uid=${encodeURIComponent(pointUid)}&lang=cn&osType=2`)
  ]);
  validatePointStoreBusinessResult(userInfoResponse, "获取积分信息失败");
  validatePointStoreBusinessResult(storeResponse, "获取积分商城失败");
  const userInfo = unwrapData(userInfoResponse);
  const store = unwrapData(storeResponse);
  const products = normalizeProducts(store);
  const snapshot = await mergePointStoreSnapshot(account, {
    pointUid,
    userInfo,
    store,
    products
  });

  return {
    pointUid,
    email: normalizeOptionalString(account.email ?? account.snapshot?.email),
    userName: pickString(userInfo, ["userName", "name", "nickName", "nickname"]),
    userGrade: incrementGrade(pickNumber(userInfo, ["userGrade", "grade"])),
    validPoint: normalizeMemberPoint(pickNumber(userInfo, ["validPoint"])),
    historyPoint: pickNumber(userInfo, ["historyPoint"]),
    expirePoint: pickNumber(userInfo, ["expirePoint"]),
    expireTime: pickString(userInfo, ["expireTime"]),
    products,
    snapshot,
    raw: {
      userInfo,
      store
    }
  };
}

export async function orderAccountPointStoreProduct(accountId: number, productId: string, emailOverride?: string | null) {
  const account = await getAccountWithSnapshot(accountId);
  const email = normalizeOptionalString(emailOverride) ?? normalizeOptionalString(account.email ?? account.snapshot?.email);
  if (!email) {
    throw new AppError("当前账户没有邮箱，无法作为积分商城兑换地址。", 400, 400);
  }

  const orderGuardKey = `${accountId}:${productId}`;
  if (activePointStoreOrderKeys.has(orderGuardKey)) {
    throw new AppError("相同商品正在兑换，请等待当前请求完成，不要重复提交。", 409, 409);
  }
  activePointStoreOrderKeys.add(orderGuardKey);

  try {
  const pointStore = await getAccountPointStore(accountId);
  const product = pointStore.products.find((item) => item.productId === productId);
  if (!product) {
    throw new AppError("未找到要兑换的商城商品，请先刷新积分商城。", 404, 404);
  }
  if (product.stock !== null && product.stock <= 0) {
    throw new AppError("该商品当前库存不足，无法兑换。", 400, 400);
  }
  if (product.price === null) {
    throw new AppError("该商品价格未返回，无法安全兑换。", 400, 400);
  }
  if (pointStore.validPoint === null || pointStore.validPoint < product.price) {
    throw new AppError("当前有效积分不足，无法兑换该商品。", 400, 400);
  }

  const recentUnconfirmedOrder = await prisma.pointStoreOrder.findFirst({
    where: {
      accountId,
      productId: product.productId,
      OR: [
        { status: "unknown" },
        {
          status: "submitting",
          createdAt: { gte: new Date(Date.now() - POINT_STORE_ORDER_GUARD_MS) }
        }
      ]
    },
    orderBy: { createdAt: "desc" }
  });
  if (recentUnconfirmedOrder) {
    throw new AppError(POINT_STORE_ORDER_UNCERTAIN_MESSAGE, 409, 409);
  }

  const orderAttempt = await prisma.pointStoreOrder.create({
    data: {
      accountId,
      productId: product.productId,
      productName: product.name,
      productPrice: product.price,
      email,
      status: "submitting"
    }
  });

  let orderResponse: JsonRecord;
  try {
    orderResponse = await fetchPublicJson(
      `/pointstore/order?uid=${encodeURIComponent(pointStore.pointUid)}&productId=${encodeURIComponent(product.productId)}&address=${encodeURIComponent(email)}&key=${Date.now()}`
    );
  } catch (error) {
    await prisma.pointStoreOrder.update({
      where: { id: orderAttempt.id },
      data: {
        status: "unknown",
        rawOrderJson: safeJsonStringify({
          error: error instanceof Error ? error.message : String(error),
          validPointBefore: pointStore.validPoint,
          productPrice: product.price
        })
      }
    }).catch(() => undefined);
    throw new AppError(POINT_STORE_ORDER_UNCERTAIN_MESSAGE, 504, 504);
  }
  if (pickNumber(orderResponse, ["Result"]) !== 1) {
    await prisma.pointStoreOrder.update({
      where: { id: orderAttempt.id },
      data: {
        status: "failed",
        rawOrderJson: safeJsonStringify(orderResponse)
      }
    });
    throw new AppError(`兑换失败：${pickString(orderResponse, ["Reason", "reason", "message"]) ?? "接口未返回成功"}`, 400, 400);
  }

  const order = unwrapData(orderResponse) ?? {};
  const orderId = pickString(order, ["orderId", "order_id", "id"]) ?? String(pickNumber(order, ["orderId", "order_id", "id"]) ?? "");
  const orderInfoResponse = orderId
    ? await fetchPublicJson(`/pointstore/order/info?orderId=${encodeURIComponent(orderId)}&uid=${encodeURIComponent(pointStore.pointUid)}`).catch(() => null)
    : null;
  const orderInfo = orderInfoResponse && isSuccessfulPointStoreBusinessResult(orderInfoResponse)
    ? unwrapData(orderInfoResponse)
    : null;
  const status = resolveSuccessfulPointStoreOrderStatus(orderInfo, order);
  const orderTime = pickString(orderInfo, ["orderTime", "order_time", "createdAt", "created_at"]) ??
    pickString(order, ["orderTime", "order_time", "createdAt", "created_at"]);
  const storedOrder = await prisma.pointStoreOrder.update({
    where: { id: orderAttempt.id },
    data: {
      remoteOrderId: orderId || null,
      status,
      orderTime,
      rawOrderJson: safeJsonStringify(orderResponse),
      rawInfoJson: orderInfo ? safeJsonStringify(orderInfo) : null
    }
  });
  void sendPointStoreTelegramNotification({
    account,
    email,
    productName: product.name,
    productId: product.productId,
    productPrice: product.price,
    orderId: orderId || null,
    status,
    orderTime: orderTime ?? storedOrder.createdAt
  }).catch((error) => {
    logger.warn("Failed to send Telegram notification for point-store order", {
      accountId,
      orderId: orderId || null,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  const refreshedPointStore = await getAccountPointStore(accountId).catch(() => pointStore);

  return {
    product,
    email,
    orderId: orderId || null,
    order,
    orderInfo,
    storedOrder,
    pointStore: refreshedPointStore
  };
  } finally {
    activePointStoreOrderKeys.delete(orderGuardKey);
  }
}

export async function listAccountPointStoreOrders(accountId: number) {
  await getAccountWithSnapshot(accountId);
  return prisma.pointStoreOrder.findMany({
    where: { accountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
}

export async function refreshAccountPointStoreOrder(accountId: number, orderId: number) {
  const [account, storedOrder] = await Promise.all([
    getAccountWithSnapshot(accountId),
    prisma.pointStoreOrder.findFirst({ where: { id: orderId, accountId } })
  ]);
  const found = assertFound(storedOrder, "Point-store order not found");
  if (!found.remoteOrderId) {
    return found;
  }
  const pointUid = resolvePointUid(account);
  const response = await fetchPublicJson(
    `/pointstore/order/info?orderId=${encodeURIComponent(found.remoteOrderId)}&uid=${encodeURIComponent(pointUid)}`
  );
  if (pickNumber(response, ["Result"]) !== 1) {
    throw new AppError(`查询订单失败：${pickString(response, ["Reason", "reason", "message"]) ?? "接口未返回成功"}`, 400, 400);
  }
  const info = unwrapData(response) ?? {};
  const nextStatus = normalizePointStoreOrderStatus(info, found.status);
  const updated = await prisma.pointStoreOrder.update({
    where: { id: found.id },
    data: {
      status: nextStatus,
      orderTime: pickString(info, ["orderTime", "order_time", "createdAt", "created_at"]) ?? found.orderTime,
      rawInfoJson: safeJsonStringify(info)
    }
  });
  if (found.status !== nextStatus && isTerminalPointStoreStatus(nextStatus)) {
    void sendPointStoreTelegramNotification({
      account,
      email: found.email,
      productName: found.productName,
      productId: found.productId,
      productPrice: found.productPrice,
      orderId: found.remoteOrderId,
      status: nextStatus,
      orderTime: updated.orderTime ?? updated.updatedAt
    }).catch((error) => {
      logger.warn("Failed to send Telegram notification for refreshed point-store order", {
        accountId,
        orderId: found.remoteOrderId,
        title: pointStoreNotificationTitle(nextStatus),
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  return updated;
}

export async function syncAndListAccountPointStoreOrders(accountId: number) {
  const account = await getAccountWithSnapshot(accountId);
  const pointUid = safelyResolvePointStoreHistoryUid(() => resolvePointUid(account));
  const fallbackEmail = normalizeOptionalString(account.email ?? account.snapshot?.email) ?? "";
  return synchronizePointStoreOrderHistory(
    { accountId, pointUid, fallbackEmail },
    {
      fetchList: (uid) => fetchPublicJson(`/pointstore/order/list?uid=${encodeURIComponent(uid)}`),
      upsertRemoteOrder: async (targetAccountId, order, emailFallback) => {
        await prisma.pointStoreOrder.upsert({
          where: {
            accountId_remoteOrderId: {
              accountId: targetAccountId,
              remoteOrderId: order.remoteOrderId,
            },
          },
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

export function serializeStoredPointStoreOrder(order: PointStoreOrder) {
  return {
    id: order.id,
    account_id: order.accountId,
    remote_order_id: order.remoteOrderId,
    product_id: order.productId,
    product_name: order.productName,
    product_price: order.productPrice,
    email: maskPointStoreEmail(order.email),
    status: order.status,
    source: resolvePointStoreOrderSource(order),
    order_time: order.orderTime,
    created_at: order.createdAt,
    updated_at: order.updatedAt
  };
}

async function getAccountWithSnapshot(accountId: number) {
  return assertFound(
    await prisma.dtAccount.findUnique({
      where: { id: accountId },
      include: { snapshot: true }
    }),
    "Account not found"
  );
}

function resolvePointUid(account: DtAccount & { snapshot: AccountSnapshot | null }) {
  const raw = parseJsonRecord(account.snapshot?.rawJson);
  const candidates = [
    readPathString(raw, ["point", "uid"]),
    readPathString(raw, ["point", "summary", "uid"]),
    readPathString(raw, ["point", "summary", "data", "uid"]),
    readPathString(raw, ["point", "summary", "result", "uid"]),
    readPathString(raw, ["publicPoint", "uid"]),
    readPathString(raw, ["pointExtras", "pointUid"]),
    readPathString(raw, ["pointExtras", "context", "pointUid"]),
    readPathString(raw, ["context", "pointUid"])
  ];
  const pointUid = candidates.find((value) => Boolean(value));
  if (!pointUid) {
    throw new AppError("当前账户缺少积分系统 uid，请先刷新账户或从已登录 App 导入一次会话。", 400, 400);
  }
  return pointUid;
}

async function mergePointStoreSnapshot(
  account: DtAccount & { snapshot: AccountSnapshot | null },
  input: {
    pointUid: string;
    userInfo: JsonRecord | null;
    store: JsonRecord | null;
    products: PointStoreProduct[];
  }
) {
  const currentRaw = parseJsonRecord(account.snapshot?.rawJson);
  const publicPoint = isRecord(currentRaw.publicPoint) ? currentRaw.publicPoint : {};
  const userGrade = incrementGrade(pickNumber(input.userInfo, ["userGrade", "grade"]));
  const validPoint = normalizeMemberPoint(pickNumber(input.userInfo, ["validPoint"]));
  const historyPoint = pickNumber(input.userInfo, ["historyPoint"]);
  const userName = pickString(input.userInfo, ["userName", "name", "nickName", "nickname"]);
  const membershipLevelLabel = userGrade !== null ? buildMembershipLevelLabel(userGrade) : pickString(publicPoint, ["membershipLevelLabel"]);
  const mergedRaw = {
    ...currentRaw,
    publicPoint: {
      ...publicPoint,
      uid: input.pointUid,
      userInfo: input.userInfo,
      store: input.store,
      validPoint,
      historyPoint,
      expirePoint: pickNumber(input.userInfo, ["expirePoint"]),
      expireTime: pickString(input.userInfo, ["expireTime"]),
      userGrade,
      membershipLevelLabel,
      membershipBenefits: input.products.map((item) => ({
        code: item.productId,
        name: item.name,
        price: item.price,
        stock: item.stock
      })),
      fetchedAt: new Date().toISOString()
    }
  };
  const data = {
    rawJson: JSON.stringify(mergedRaw),
    ...(userName ? { fullName: userName } : {}),
    ...(validPoint !== null ? { validPoint } : {}),
    ...(historyPoint !== null ? { progressPoint: historyPoint } : {}),
    ...(userGrade !== null ? { userGrade, membershipType: membershipLevelLabel } : {})
  };
  const snapshot = await prisma.accountSnapshot.upsert({
    where: { accountId: account.id },
    update: data,
    create: {
      accountId: account.id,
      email: account.email,
      ...data
    }
  });
  return serializeSnapshot(snapshot);
}

function normalizeProducts(store: JsonRecord | null) {
  const products = Array.isArray(store?.products) ? store.products : [];
  return products
    .map((item): PointStoreProduct | null => {
      if (!isRecord(item)) {
        return null;
      }
      const name = pickString(item, ["name", "productName", "title"]);
      const productId =
        pickString(item, ["id", "productId", "product_id"]) ??
        String(pickNumber(item, ["id", "productId", "product_id"]) ?? "");
      if (!name || !productId) {
        return null;
      }
      return {
        productId,
        name,
        stock: pickNumber(item, ["stock", "convertibleNum"]),
        price: pickNumber(item, ["price", "productPrice"]),
        rawJson: safeJsonStringify(item)
      };
    })
    .filter((item): item is PointStoreProduct => Boolean(item));
}

function buildMembershipLevelLabel(level: number) {
  return level === 4 ? "V4白金" : `V${level}`;
}

function unwrapData(value: JsonRecord | null) {
  if (!value) {
    return null;
  }
  return isRecord(value.data) ? value.data : value;
}

function parseJsonRecord(value: string | null | undefined) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readPathString(value: JsonRecord, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function pickString(record: JsonRecord | null | undefined, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function pickNumber(record: JsonRecord | null | undefined, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function incrementGrade(value: number | null) {
  return value === null ? null : value + 1;
}

function normalizeMemberPoint(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    return null;
  }
  return value;
}

export function validatePointStoreBusinessResult(value: JsonRecord, action: string) {
  const result = pickNumber(value, ["Result", "result"]);
  if (result === null || result === 1) {
    return;
  }
  const reason = pickString(value, ["Reason", "reason", "message", "Message"]);
  throw new AppError(`${action}：${reason ?? "接口未返回成功"}`, 400, 400);
}

export function resolveSuccessfulPointStoreOrderStatus(orderInfo: JsonRecord | null, order: JsonRecord) {
  return readOrderStatus(orderInfo) ?? readOrderStatus(order) ?? "completed";
}

function isSuccessfulPointStoreBusinessResult(value: JsonRecord) {
  const result = pickNumber(value, ["Result", "result"]);
  return result === null || result === 1;
}

export function normalizePointStoreOrderStatus(value: JsonRecord | null | undefined, fallback = "pending") {
  return readOrderStatus(value) ?? normalizePointStoreOrderStatusValue(fallback) ?? fallback;
}

function readOrderStatus(value: JsonRecord | null | undefined) {
  if (!value) {
    return null;
  }
  for (const key of ["status", "orderStatus", "order_status", "state"]) {
    const normalized = normalizePointStoreOrderStatusValue(value[key]);
    if (normalized !== null) {
      return normalized;
    }
  }
  return null;
}

function normalizePointStoreOrderStatusValue(value: unknown) {
  const remoteStatus = normalizeRemotePointStoreOrderStatus(value);
  if (remoteStatus !== "unknown") {
    return remoteStatus;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const text = value.trim();
  const normalized = text.toLowerCase();
  if (/complete|success|done|fulfilled/.test(normalized)) {
    return "completed";
  }
  if (/fail|cancel|error|reject/.test(normalized)) {
    return "failed";
  }
  if (/process/.test(normalized)) {
    return "processing";
  }
  if (/submit/.test(normalized)) {
    return "submitting";
  }
  if (/pending/.test(normalized)) {
    return "pending";
  }
  return text;
}

export function isTerminalPointStoreStatus(status: string) {
  const normalized = normalizePointStoreOrderStatusValue(status);
  return normalized === "completed" || normalized === "failed";
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializeError: true });
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
