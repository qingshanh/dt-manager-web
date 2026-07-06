import type { AppVariant } from "@prisma/client";
import type { DingtoneSnapshot } from "./dingtone/types.js";
import { execAdb, resolveAdbApp, resolveAdbSerial } from "./adb-app.js";

type JsonRecord = Record<string, unknown>;

const WALLET_MMKV_PATH = "files/mmkv/local_info_for_wallet";
const LOCAL_INFO_MMKV_PATH = "files/mmkv/local_info";
const DEFAULT_CREDIT_EXCHANGE_RATIO = 0.02;

export async function readPointSnapshotFromAdb(variant: AppVariant, expectedDtUserId?: string | null): Promise<DingtoneSnapshot | null> {
  const app = resolveAdbApp(variant);
  const serial = await resolveAdbSerial();
  const walletRemotePath = `/data/user/0/${app.packageName}/${WALLET_MMKV_PATH}`;
  const localInfoRemotePath = `/data/user/0/${app.packageName}/${LOCAL_INFO_MMKV_PATH}`;
  const [walletStrings, localInfoBuffer] = await Promise.all([
    execAdb(["-s", serial, "shell", "su", "0", "strings", walletRemotePath])
      .then(({ stdout }) => stdout)
      .catch(() => ""),
    readRemoteFile(serial, localInfoRemotePath).catch(() => null)
  ]);
  const localInfo = localInfoBuffer ? parseLocalInfoMmkv(localInfoBuffer) : null;
  if (expectedDtUserId && localInfo?.dtUserId && localInfo.dtUserId !== expectedDtUserId) {
    return null;
  }
  const pointGradeInfo = parseLastJsonAfterMarker(walletStrings, "pointGradeInfo<;");
  const pointUid = findPointUidCandidate(walletStrings);
  if (!pointGradeInfo && !pointUid && !localInfo?.displayBalance) {
    return null;
  }

  const rawJson = {
    source: "adb-mmkv",
    localInfo,
    point: {
      uid: pointUid,
      pointGradeInfo
    },
    publicPoint: {
      uid: pointUid,
      appType: variant === "dingdong" ? 0 : 3,
      gradeInfo: pointGradeInfo,
      userInfo: pointGradeInfo,
      validPoint: pickNumber(pointGradeInfo, ["validPoint"]),
      membershipLevelLabel: buildMembershipLevelLabel(incrementGradeLevel(pickNumber(pointGradeInfo, ["userGrade"]))),
      membershipBenefits: buildBenefitPlaceholders(pointGradeInfo),
      balanceDisplay: localInfo?.displayBalance ?? null,
      fetchedAt: new Date().toISOString()
    }
  };

  const userGrade = incrementGradeLevel(pickNumber(pointGradeInfo, ["userGrade"]));
  return {
    userGrade: userGrade ?? undefined,
    validPoint: pickNumber(pointGradeInfo, ["validPoint"]) ?? undefined,
    membershipLevelLabel: buildMembershipLevelLabel(userGrade) ?? undefined,
    primaryBalance: localInfo?.displayBalance ?? undefined,
    rawJson: JSON.stringify(rawJson)
  };
}

async function readRemoteFile(serial: string, remotePath: string) {
  const { stdout } = await execAdb(["-s", serial, "shell", "su", "0", "base64", remotePath]);
  const compact = stdout.replace(/\s+/g, "");
  return compact ? Buffer.from(compact, "base64") : null;
}

function parseLocalInfoMmkv(buffer: Buffer) {
  const dtUserId = parseStringAfterKey(buffer, "UserID");
  const rawBalance = parseFloatAfterKey(buffer, "MyBalanceKey");
  const giftBalance = parseFloatAfterKey(buffer, "MyGiftBalanceKey");
  const adEarnBalance = parseFloatAfterKey(buffer, "MyAdEarnBalanceKey");
  const creditExchangeRatio = parseFloatAfterKey(buffer, "MyCreditExchangeRatioKey") ?? DEFAULT_CREDIT_EXCHANGE_RATIO;
  const displayBalance = rawBalance !== null && creditExchangeRatio > 0 ? roundTo(rawBalance / creditExchangeRatio, 2) : null;
  return {
    dtUserId,
    rawBalance,
    giftBalance,
    adEarnBalance,
    creditExchangeRatio,
    displayBalance
  };
}

function parseFloatAfterKey(buffer: Buffer, key: string) {
  let offset = -1;
  let parsed: number | null = null;
  while ((offset = buffer.indexOf(key, offset + 1, "utf8")) >= 0) {
    const valueOffset = offset + Buffer.byteLength(key, "utf8");
    if (buffer[valueOffset] !== 4 || valueOffset + 5 > buffer.length) {
      continue;
    }
    const value = buffer.readFloatLE(valueOffset + 1);
    if (Number.isFinite(value)) {
      parsed = value;
    }
  }
  return parsed;
}

function parseStringAfterKey(buffer: Buffer, key: string) {
  let offset = -1;
  let parsed: string | null = null;
  while ((offset = buffer.indexOf(key, offset + 1, "utf8")) >= 0) {
    const after = buffer.subarray(offset + Buffer.byteLength(key, "utf8"), Math.min(buffer.length, offset + Buffer.byteLength(key, "utf8") + 48));
    const match = after.toString("latin1").match(/\d{12,21}/);
    if (match?.[0]) {
      parsed = match[0];
    }
  }
  return parsed;
}

function parseLastJsonAfterMarker(value: string, marker: string) {
  const matches = [...value.matchAll(new RegExp(escapeRegExp(marker) + "(\\{[^\\r\\n]+\\})", "g"))];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const candidate = matches[index]?.[1];
    if (!candidate) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function findPointUidCandidate(value: string) {
  const candidates = [...value.matchAll(/(?:^|\D)(\d{15,21})(?:\D|$)/g)]
    .map((match) => match[1])
    .filter((item): item is string => Boolean(item))
    .filter((item) => !item.startsWith("6700"));
  return candidates[candidates.length - 1] ?? null;
}

function buildBenefitPlaceholders(pointGradeInfo: JsonRecord | null) {
  const benefits = Array.isArray(pointGradeInfo?.benefits) ? pointGradeInfo.benefits : [];
  return benefits.map((item) => ({
    code: String(item).padStart(3, "0"),
    name: `Benefit ${String(item).padStart(3, "0")}`,
    price: null
  }));
}

function buildMembershipLevelLabel(level: number | null) {
  if (level === null) {
    return null;
  }
  if (level === 4) {
    return "V4 Platinum";
  }
  return `V${level}`;
}

function incrementGradeLevel(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return value + 1;
}

function pickNumber(record: JsonRecord | null, keys: string[]) {
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

function roundTo(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
