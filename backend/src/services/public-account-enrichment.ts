import type { AppVariant } from "@prisma/client";
import type { DingtoneSnapshot } from "./dingtone/types.js";

type JsonRecord = Record<string, unknown>;

type PublicAccountEnrichmentInput = {
  appVariant: AppVariant;
  dtUserId: string;
  snapshot: DingtoneSnapshot;
  previousRawJson?: string | null;
};

const POINT_API_BASE = "https://dt-apigatewayv2.dt-pn1.com";
const DEFAULT_HEADERS = {
  accept: "application/json, text/plain, */*",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 13; M2012K11AC Build/TKQ1.220829.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36 TengZhan/3"
};

export async function enrichSnapshotWithPublicData(input: PublicAccountEnrichmentInput): Promise<DingtoneSnapshot> {
  const currentRaw = parseJsonRecord(input.snapshot.rawJson);
  const previousRaw = parseJsonRecord(input.previousRawJson);
  const pointUid = pickFirstString([
    readPathString(currentRaw, ["point", "uid"]),
    readPathString(currentRaw, ["publicPoint", "uid"]),
    readPathString(currentRaw, ["pointExtras", "pointUid"]),
    readPathString(currentRaw, ["pointExtras", "context", "pointUid"]),
    readPathString(currentRaw, ["context", "pointUid"]),
    readPathString(previousRaw, ["point", "uid"]),
    readPathString(previousRaw, ["publicPoint", "uid"]),
    readPathString(previousRaw, ["pointExtras", "pointUid"]),
    readPathString(previousRaw, ["pointExtras", "context", "pointUid"]),
    readPathString(previousRaw, ["context", "pointUid"])
  ]);
  const pointUserId = pickFirstString([
    readPathString(currentRaw, ["pointExtras", "dtUserId"]),
    readPathString(currentRaw, ["pointExtras", "context", "dtUserId"]),
    readPathString(currentRaw, ["context", "dtUserId"]),
    readPathString(previousRaw, ["pointExtras", "dtUserId"]),
    readPathString(previousRaw, ["pointExtras", "context", "dtUserId"]),
    readPathString(previousRaw, ["context", "dtUserId"]),
    input.dtUserId
  ]);
  const appType = input.appVariant === "dingdong" ? 0 : 3;
  const gameAppId = input.appVariant === "dingdong" ? 66 : 67;

  const pointGradeInfo = pointUid
    ? await fetchPublicJson(`/point/gradeinfo?uid=${encodeURIComponent(pointUid)}`).catch(() => null)
    : null;
  const pointUserInfo = pointUid
    ? await fetchPublicJson(`/point/userinfo?uid=${encodeURIComponent(pointUid)}&zone=800`).catch(() => null)
    : null;
  const pointStore = pointUid
    ? await fetchPublicJson(`/pointstore/entrance?uid=${encodeURIComponent(pointUid)}&lang=cn&osType=2`).catch(() => null)
    : null;

  const gameHomePage = pointUserId
    ? await fetchPublicJson(
        `/game/homePage?userId=${encodeURIComponent(pointUserId)}&appId=${gameAppId}&zone=-800&timeStamp=${Date.now()}`
      ).catch(() => null)
    : null;
  const gameHomePageData = unwrapData(gameHomePage);
  const gameUid = pickString(gameHomePageData, ["uid"]);
  const gameRedeemInfo = gameUid
    ? await fetchPublicJson(`/game/point/redeemInfo?uid=${encodeURIComponent(gameUid)}&timeStamp=${Date.now()}`).catch(() => null)
    : null;

  const pointGradeInfoData = unwrapData(pointGradeInfo);
  const pointUserData = unwrapData(pointUserInfo);
  const pointStoreData = unwrapData(pointStore);
  const exchangeRatio =
    pickNumber(readPathRecord(currentRaw, ["balance"]), ["creditExchangeRatio"]) ??
    pickNumber(readPathRecord(previousRaw, ["balance"]), ["creditExchangeRatio"]);

  const baseBalance =
    input.snapshot.primaryBalance ??
    pickNumber(readPathRecord(currentRaw, ["balance"]), ["primaryBalance", "balance"]) ??
    pickNumber(readPathRecord(previousRaw, ["balance"]), ["primaryBalance", "balance"]);

  const displayBalance =
    typeof baseBalance === "number" && typeof exchangeRatio === "number" && exchangeRatio > 0
      ? roundTo(baseBalance / exchangeRatio, 2)
      : baseBalance;

  const userGradeLevel = toGradeLevel(
    incrementGradeLevel(pickNumber(pointUserData, ["userGrade"])) ??
      incrementGradeLevel(pickNumber(pointGradeInfoData, ["userGrade"])) ??
      input.snapshot.userGrade ??
      pickNumber(readPathRecord(currentRaw, ["point"]), ["pointGradeLevel", "userGrade"])
  );
  const membershipLevelLabel =
    buildMembershipLevelLabel(userGradeLevel) ?? input.snapshot.membershipLevelLabel ?? undefined;
  const validPoint =
    pickNumber(pointUserData, ["validPoint"]) ??
    pickNumber(pointGradeInfoData, ["validPoint"]) ??
    input.snapshot.validPoint;
  const progressPoint =
    pickNumber(pointGradeInfoData, ["progessPoint", "progressPoint", "historyPoint"]) ??
    pickNumber(pointUserData, ["historyPoint"]) ??
    input.snapshot.progressPoint;
  const progressPointTotal =
    resolveProgressPointTotal(userGradeLevel, pointGradeInfoData, pointUserData) ?? input.snapshot.progressPointTotal;
  const pointBenefits = buildPointBenefits(pointStoreData);
  const gameBenefits = buildGamePointBenefits(unwrapData(gameRedeemInfo));

  const mergedRaw = {
    ...currentRaw,
    publicPoint: {
      uid: pointUid,
      userId: pointUserId,
      appType,
      gameAppId,
      gameUid,
      gradeInfo: pointGradeInfoData,
      userInfo: pointUserData,
      store: pointStoreData,
      gameHomePage: gameHomePageData,
      gameRedeemInfo: unwrapData(gameRedeemInfo),
      validPoint,
      progressPoint,
      progressPointTotal,
      historyPoint: pickNumber(pointUserData, ["historyPoint"]),
      expirePoint: pickNumber(pointUserData, ["expirePoint"]),
      expireTime: pickString(pointUserData, ["expireTime"]),
      membershipLevelLabel,
      balanceDisplay: displayBalance,
      membershipBenefits: mergeBenefits(pointBenefits, gameBenefits),
      fetchedAt: new Date().toISOString()
    }
  };

  return {
    ...input.snapshot,
    primaryBalance: input.snapshot.primaryBalance,
    userGrade: userGradeLevel ?? input.snapshot.userGrade,
    validPoint: validPoint ?? input.snapshot.validPoint,
    progressPoint: progressPoint ?? input.snapshot.progressPoint,
    progressPointTotal,
    membershipType: input.snapshot.membershipType ?? membershipLevelLabel ?? undefined,
    membershipLevelLabel,
    rawJson: JSON.stringify(mergedRaw)
  };
}

async function fetchPublicJson(path: string) {
  const response = await fetch(`${POINT_API_BASE}${path}`, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`Public point request failed: ${response.status} ${path}`);
  }
  return (await response.json()) as JsonRecord;
}

function buildPointBenefits(pointStoreData: JsonRecord | null) {
  const benefits: Array<{ code: string; name: string; price: number | null; stock?: number | null }> = [];
  const pointProducts = Array.isArray(pointStoreData?.products) ? pointStoreData.products : [];

  for (const product of pointProducts) {
    if (!isRecord(product)) {
      continue;
    }
    const name = pickString(product, ["name"]);
    if (!name) {
      continue;
    }

    const stock = pickNumber(product, ["stock"]);
    const price = pickNumber(product, ["price"]);
    const suffix =
      stock !== null && price !== null
        ? `（剩余 ${stock}，需 ${price} 积分）`
        : stock !== null
          ? `（剩余 ${stock}）`
          : price !== null
            ? `（需 ${price} 积分）`
            : "";

    benefits.push({
      code: String(product.id ?? name),
      name: `${name}${suffix}`,
      price: null,
      stock
    });
  }

  return benefits;
}

function buildGamePointBenefits(gameRedeemInfoData: JsonRecord | null) {
  const benefits: Array<{ code: string; name: string; price: number | null; stock?: number | null }> = [];
  const products = Array.isArray(gameRedeemInfoData?.products) ? gameRedeemInfoData.products : [];

  for (const product of products) {
    if (!isRecord(product)) {
      continue;
    }
    const name = pickString(product, ["productName", "name"]);
    if (!name) {
      continue;
    }

    benefits.push({
      code: String(product.productId ?? product.id ?? name),
      name,
      price: pickNumber(product, ["price"]),
      stock: pickNumber(product, ["convertibleNum", "stock"])
    });
  }

  return benefits;
}

function mergeBenefits(
  primary: Array<{ code: string; name: string; price: number | null; stock?: number | null }>,
  secondary: Array<{ code: string; name: string; price: number | null; stock?: number | null }>
) {
  const merged = [...primary];
  for (const item of secondary) {
    if (!merged.some((candidate) => candidate.name === item.name)) {
      merged.push(item);
    }
  }
  return merged;
}

function buildMembershipLevelLabel(level: number | null) {
  if (level === null) {
    return null;
  }
  if (level === 4) {
    return "V4白金";
  }
  return `V${level}`;
}

function resolveProgressPointTotal(level: number | null, pointGradeInfoData: JsonRecord | null, pointUserData: JsonRecord | null) {
  const explicit =
    pickNumber(pointGradeInfoData, ["progressPointTotal", "nextGradePoint", "nextLevelPoint"]) ??
    pickNumber(pointUserData, ["progressPointTotal", "nextGradePoint", "nextLevelPoint"]);
  if (explicit !== null) {
    return explicit;
  }

  if (level === 4) {
    return 5000;
  }
  return null;
}

function toGradeLevel(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return value >= 1 && Number.isInteger(value) ? value : value + 1;
}

function incrementGradeLevel(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return value + 1;
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

function readPathRecord(value: JsonRecord | null | undefined, path: string[]) {
  const resolved = readPath(value, path);
  return isRecord(resolved) ? resolved : null;
}

function readPathString(value: JsonRecord | null | undefined, path: string[]) {
  const resolved = readPath(value, path);
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : null;
}

function readPath(value: JsonRecord | null | undefined, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return current;
}

function pickFirstString(values: Array<string | null>) {
  return values.find((value) => Boolean(value)) ?? null;
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundTo(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
