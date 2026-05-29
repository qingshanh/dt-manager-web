import type { AppVariant } from "@prisma/client";
import type { DingtoneSnapshot } from "./dingtone/types.js";
import { execAdb, resolveAdbApp, resolveAdbSerial } from "./adb-app.js";

type JsonRecord = Record<string, unknown>;

const WALLET_MMKV_PATH = "files/mmkv/local_info_for_wallet";

export async function readPointSnapshotFromAdb(variant: AppVariant): Promise<DingtoneSnapshot | null> {
  const app = resolveAdbApp(variant);
  const serial = await resolveAdbSerial();
  const remotePath = `/data/user/0/${app.packageName}/${WALLET_MMKV_PATH}`;
  const { stdout } = await execAdb(["-s", serial, "shell", "su", "0", "strings", remotePath]);
  const pointGradeInfo = parseLastJsonAfterMarker(stdout, "pointGradeInfo<;");
  const pointUid = findPointUidCandidate(stdout);
  if (!pointGradeInfo && !pointUid) {
    return null;
  }

  const rawJson = {
    source: "adb-mmkv",
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
      fetchedAt: new Date().toISOString()
    }
  };

  const userGrade = incrementGradeLevel(pickNumber(pointGradeInfo, ["userGrade"]));
  return {
    userGrade: userGrade ?? undefined,
    validPoint: pickNumber(pointGradeInfo, ["validPoint"]) ?? undefined,
    membershipLevelLabel: buildMembershipLevelLabel(userGrade) ?? undefined,
    rawJson: JSON.stringify(rawJson)
  };
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
