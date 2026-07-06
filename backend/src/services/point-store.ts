import type { AccountSnapshot, DtAccount } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError, assertFound } from "../utils/errors.js";
import { serializeSnapshot } from "../utils/serializers.js";
import { fetchPublicJson } from "./public-account-enrichment.js";

type JsonRecord = Record<string, unknown>;

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

export async function orderAccountPointStoreProduct(accountId: number, productId: string) {
  const account = await getAccountWithSnapshot(accountId);
  const email = normalizeOptionalString(account.email ?? account.snapshot?.email);
  if (!email) {
    throw new AppError("当前账户没有邮箱，无法作为积分商城兑换地址。", 400, 400);
  }

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

  const orderResponse = await fetchPublicJson(
    `/pointstore/order?uid=${encodeURIComponent(pointStore.pointUid)}&productId=${encodeURIComponent(product.productId)}&address=${encodeURIComponent(email)}&key=${Date.now()}`
  );
  if (pickNumber(orderResponse, ["Result"]) !== 1) {
    throw new AppError(`兑换失败：${pickString(orderResponse, ["Reason", "reason", "message"]) ?? "接口未返回成功"}`, 400, 400);
  }

  const order = unwrapData(orderResponse) ?? {};
  const orderId = pickString(order, ["orderId", "order_id", "id"]) ?? String(pickNumber(order, ["orderId", "order_id", "id"]) ?? "");
  const orderInfoResponse = orderId
    ? await fetchPublicJson(`/pointstore/order/info?orderId=${encodeURIComponent(orderId)}&uid=${encodeURIComponent(pointStore.pointUid)}`).catch(() => null)
    : null;
  const orderInfo = unwrapData(orderInfoResponse);
  const refreshedPointStore = await getAccountPointStore(accountId).catch(() => pointStore);

  return {
    product,
    email,
    orderId: orderId || null,
    order,
    orderInfo,
    pointStore: refreshedPointStore
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
