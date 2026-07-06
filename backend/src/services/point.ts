import type { AccountSnapshot, DtAccount } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertFound } from "../utils/errors.js";
import { serializeSnapshot } from "../utils/serializers.js";
import { fetchPublicJson } from "./public-account-enrichment.js";

type JsonRecord = Record<string, unknown>;

export type PointBenefit = {
  code: string;
  name: string;
  price: number | null;
  stock: number | null;
};

export type AccountPointData = {
  pointUid: string | null;
  userId: string | null;
  gameUid: string | null;
  appType: number;
  gameAppId: number;
  userName: string | null;
  userGrade: number | null;
  validPoint: number | null;
  historyPoint: number | null;
  expirePoint: number | null;
  expireTime: string | null;
  gameBenefits: PointBenefit[];
  snapshot: ReturnType<typeof serializeSnapshot> | null;
  raw: {
    userInfo: JsonRecord | null;
    gradeInfo: JsonRecord | null;
    gameHomePage: JsonRecord | null;
    gameRedeemInfo: JsonRecord | null;
  };
};

export async function getAccountPoint(accountId: number): Promise<AccountPointData> {
  const account = await getAccountWithSnapshot(accountId);
  const raw = parseJsonRecord(account.snapshot?.rawJson);
  const pointUid = resolveOptionalPointUid(raw);
  const userId = resolvePointUserId(account, raw);
  const appType = account.appVariant === "dingdong" ? 0 : 3;
  const gameAppId = account.appVariant === "dingdong" ? 66 : 67;

  const [userInfoResponse, gradeInfoResponse, gameHomePageResponse] = await Promise.all([
    pointUid ? fetchPublicJson(`/point/userinfo?uid=${encodeURIComponent(pointUid)}&zone=800`).catch(() => null) : Promise.resolve(null),
    pointUid ? fetchPublicJson(`/point/gradeinfo?uid=${encodeURIComponent(pointUid)}`).catch(() => null) : Promise.resolve(null),
    userId
      ? fetchPublicJson(
          `/game/homePage?userId=${encodeURIComponent(userId)}&appId=${gameAppId}&zone=-800&timeStamp=${Date.now()}`
        ).catch(() => null)
      : Promise.resolve(null)
  ]);

  const userInfo = unwrapData(userInfoResponse);
  const gradeInfo = unwrapData(gradeInfoResponse);
  const gameHomePage = unwrapData(gameHomePageResponse);
  const gameUid =
    pickString(gameHomePage, ["uid"]) ??
    readPathString(raw, ["publicPoint", "gameUid"]);
  const gameRedeemInfo = gameUid
    ? unwrapData(await fetchPublicJson(`/game/point/redeemInfo?uid=${encodeURIComponent(gameUid)}&timeStamp=${Date.now()}`).catch(() => null))
    : null;
  const gameBenefits = buildGamePointBenefits(gameRedeemInfo);
  const historyPoint =
    pickNumber(userInfo, ["historyPoint"]) ??
    pickNumber(gradeInfo, ["historyPoint"]);
  const progressPoint =
    normalizeMemberPoint(pickNumber(gradeInfo, ["progessPoint", "progressPoint", "historyPoint"])) ??
    normalizeMemberPoint(historyPoint);
  const validPoint =
    normalizeMemberPoint(pickNumber(userInfo, ["validPoint"])) ??
    normalizeMemberPoint(pickNumber(gradeInfo, ["validPoint"])) ??
    normalizeMemberPoint(progressPoint);
  const snapshot = await mergePointSnapshot(account, {
    pointUid,
    userId,
    gameUid,
    appType,
    gameAppId,
    userInfo,
    gradeInfo,
    gameHomePage,
    gameRedeemInfo,
    gameBenefits
  });

  return {
    pointUid,
    userId,
    gameUid,
    appType,
    gameAppId,
    userName: pickString(userInfo, ["userName", "name", "nickName", "nickname"]),
    userGrade: incrementGrade(pickNumber(userInfo, ["userGrade", "grade"]) ?? pickNumber(gradeInfo, ["userGrade", "grade"])) ?? snapshot?.user_grade ?? null,
    validPoint: validPoint ?? snapshot?.valid_point ?? null,
    historyPoint,
    expirePoint: pickNumber(userInfo, ["expirePoint"]) ?? pickNumber(gameHomePage, ["expirePoint"]),
    expireTime: pickString(userInfo, ["expireTime"]) ?? pickString(gameHomePage, ["expireTime"]),
    gameBenefits,
    snapshot,
    raw: {
      userInfo,
      gradeInfo,
      gameHomePage,
      gameRedeemInfo
    }
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

function resolveOptionalPointUid(raw: JsonRecord) {
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
  return candidates.find((value) => Boolean(value)) ?? null;
}

function resolvePointUserId(account: DtAccount, raw: JsonRecord) {
  return (
    readPathString(raw, ["pointExtras", "dtUserId"]) ??
    readPathString(raw, ["pointExtras", "context", "dtUserId"]) ??
    readPathString(raw, ["context", "dtUserId"]) ??
    account.dtUserId
  );
}

async function mergePointSnapshot(
  account: DtAccount & { snapshot: AccountSnapshot | null },
  input: {
    pointUid: string | null;
    userId: string | null;
    gameUid: string | null;
    appType: number;
    gameAppId: number;
    userInfo: JsonRecord | null;
    gradeInfo: JsonRecord | null;
    gameHomePage: JsonRecord | null;
    gameRedeemInfo: JsonRecord | null;
    gameBenefits: PointBenefit[];
  }
) {
  const currentRaw = parseJsonRecord(account.snapshot?.rawJson);
  const publicPoint = isRecord(currentRaw.publicPoint) ? currentRaw.publicPoint : {};
  const userGrade = incrementGrade(pickNumber(input.userInfo, ["userGrade", "grade"]) ?? pickNumber(input.gradeInfo, ["userGrade", "grade"]));
  const historyPoint =
    pickNumber(input.userInfo, ["historyPoint"]) ??
    pickNumber(input.gradeInfo, ["historyPoint"]);
  const previousProgressPoint = normalizeMemberPoint(pickNumber(publicPoint, ["progressPoint", "progress_point"])) ?? normalizeMemberPoint(account.snapshot?.progressPoint ?? null);
  const progressPoint =
    normalizeMemberPoint(pickNumber(input.gradeInfo, ["progessPoint", "progressPoint", "historyPoint"])) ??
    normalizeMemberPoint(historyPoint) ??
    previousProgressPoint;
  const validPoint =
    normalizeMemberPoint(pickNumber(input.userInfo, ["validPoint"])) ??
    normalizeMemberPoint(pickNumber(input.gradeInfo, ["validPoint"])) ??
    normalizeMemberPoint(progressPoint);
  const userName = pickString(input.userInfo, ["userName", "name", "nickName", "nickname"]);
  const membershipLevelLabel = userGrade !== null ? buildMembershipLevelLabel(userGrade) : pickString(publicPoint, ["membershipLevelLabel"]);
  const mergedRaw = {
    ...currentRaw,
    publicPoint: {
      ...publicPoint,
      ...(input.pointUid ? { uid: input.pointUid } : {}),
      userId: input.userId,
      appType: input.appType,
      gameAppId: input.gameAppId,
      gameUid: input.gameUid,
      userInfo: input.userInfo,
      gradeInfo: input.gradeInfo,
      gameHomePage: input.gameHomePage,
      gameRedeemInfo: input.gameRedeemInfo,
      validPoint,
      progressPoint,
      historyPoint,
      expirePoint: pickNumber(input.userInfo, ["expirePoint"]) ?? pickNumber(input.gameHomePage, ["expirePoint"]),
      expireTime: pickString(input.userInfo, ["expireTime"]) ?? pickString(input.gameHomePage, ["expireTime"]),
      membershipLevelLabel,
      gamePointBenefits: input.gameBenefits,
      fetchedAt: new Date().toISOString()
    }
  };
  const data = {
    rawJson: JSON.stringify(mergedRaw),
    ...(userName ? { fullName: userName } : {}),
    ...(validPoint !== null ? { validPoint } : {}),
    ...(progressPoint !== null ? { progressPoint } : {}),
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

function buildGamePointBenefits(gameRedeemInfoData: JsonRecord | null) {
  const products = Array.isArray(gameRedeemInfoData?.products) ? gameRedeemInfoData.products : [];
  return products
    .map((product): PointBenefit | null => {
      if (!isRecord(product)) {
        return null;
      }
      const name = pickString(product, ["productName", "name"]);
      if (!name) {
        return null;
      }
      return {
        code: String(product.productId ?? product.id ?? name),
        name,
        price: pickNumber(product, ["price"]),
        stock: pickNumber(product, ["convertibleNum", "stock"])
      };
    })
    .filter((item): item is PointBenefit => Boolean(item));
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
  if (value === null || !Number.isFinite(value) || value <= 0 || value > 10_000) {
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
