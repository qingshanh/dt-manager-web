import type { AccountSnapshot } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError, assertFound } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { repairUtf8Mojibake, serializeSnapshot } from "../utils/serializers.js";
import { resolveRefreshedAccountNickname } from "../utils/account-name.js";
import { decryptText } from "../utils/crypto.js";
import { dingtoneGateway } from "./dingtone/index.js";
import { RealDingtoneGateway } from "./dingtone/real-gateway.js";
import type { DingtoneGateway, DingtonePhoneNumber, DingtoneSnapshot } from "./dingtone/types.js";
import { syncPhoneNumbers } from "./phone-number-store.js";
import { enrichSnapshotWithPublicData } from "./public-account-enrichment.js";
import { getGatewayMode } from "./settings.service.js";
import { readPointSnapshotFromAdb } from "./adb-point-snapshot.js";

const helperSnapshotGateway = new RealDingtoneGateway();
const GATEWAY_SNAPSHOT_WAIT_MS = 30_000;
const HELPER_SNAPSHOT_WAIT_MS = 6_000;
const ADB_POINT_WAIT_MS = 5_000;
const PUBLIC_ENRICHMENT_WAIT_MS = 8_000;
const PHONE_LIST_WAIT_MS = 25_000;

export type AccountRuntimeRefreshOptions = {
  includePhoneNumbers?: boolean;
  allowHelperSnapshot?: boolean;
  allowAdbPoint?: boolean;
  includePublicEnrichment?: boolean;
  persistCachedSnapshot?: boolean;
  gatewaySnapshotWaitMs?: number;
  helperSnapshotWaitMs?: number;
  adbPointWaitMs?: number;
  publicEnrichmentWaitMs?: number;
  phoneListWaitMs?: number;
};

export async function refreshAccountRuntimeData(
  accountId: number,
  gateway: Pick<DingtoneGateway, "refreshSnapshot" | "listPhoneNumbers"> = dingtoneGateway,
  options: AccountRuntimeRefreshOptions = {}
) {
  const includePhoneNumbers = options.includePhoneNumbers ?? true;
  const allowHelperSnapshot = options.allowHelperSnapshot ?? true;
  const allowAdbPoint = options.allowAdbPoint ?? true;
  const includePublicEnrichment = options.includePublicEnrichment ?? true;
  const persistCachedSnapshot = options.persistCachedSnapshot ?? true;
  const gatewaySnapshotWaitMs = options.gatewaySnapshotWaitMs ?? GATEWAY_SNAPSHOT_WAIT_MS;
  const helperSnapshotWaitMs = options.helperSnapshotWaitMs ?? HELPER_SNAPSHOT_WAIT_MS;
  const adbPointWaitMs = options.adbPointWaitMs ?? ADB_POINT_WAIT_MS;
  const publicEnrichmentWaitMs = options.publicEnrichmentWaitMs ?? PUBLIC_ENRICHMENT_WAIT_MS;
  const phoneListWaitMs = options.phoneListWaitMs ?? PHONE_LIST_WAIT_MS;
  const account = await assertFound(
    await prisma.dtAccount.findUnique({
      where: { id: accountId }
    }),
    "Account not found"
  );
  const previousSnapshot = await prisma.accountSnapshot.findUnique({
    where: { accountId }
  });
  const dtUserId = requireString(account.dtUserId, "Missing dt_user_id");
  const token = requireString(decryptText(account.dtToken), "Missing dt_token");

  let snapshotError: unknown;
  const gatewaySnapshot = await withSoftTimeout(
    gateway.refreshSnapshot({
      dtUserId,
      token,
      deviceId: account.dtDeviceId,
      email: account.email,
      phone: account.phone,
      appVariant: account.appVariant
    }),
    gatewaySnapshotWaitMs,
    null
  ).catch((error: unknown) => {
    snapshotError = error;
    return null;
  });
  if (!gatewaySnapshot && !previousSnapshot) {
    throw snapshotError instanceof Error ? snapshotError : new Error("Account snapshot refresh timed out and no cached snapshot is available");
  }
  if (!gatewaySnapshot) {
    logger.warn("Account snapshot refresh did not complete in time, using cached snapshot", {
      accountId,
      dtUserId,
      timeoutMs: gatewaySnapshotWaitMs,
      error: snapshotError instanceof Error ? snapshotError.message : snapshotError ? String(snapshotError) : null
    });
  }
  const baseSnapshot = gatewaySnapshot ?? snapshotFromStored(previousSnapshot!);
  const helperSnapshotCandidate = allowHelperSnapshot && (await shouldMergeHelperSnapshot(account.loginType, baseSnapshot))
    ? await withSoftTimeout(
        helperSnapshotGateway.refreshSnapshot({
          dtUserId,
          token,
          deviceId: account.dtDeviceId,
          email: account.email,
          phone: account.phone,
          appVariant: account.appVariant
        }),
        helperSnapshotWaitMs,
        null
      ).catch(() => null)
    : null;
  const helperSnapshot = snapshotBelongsToDtUserId(helperSnapshotCandidate, dtUserId) ? helperSnapshotCandidate : null;
  const baseMergedSnapshot = mergeSnapshots(baseSnapshot, helperSnapshot);
  const adbPointSnapshot = allowAdbPoint && (await shouldMergeAdbPointSnapshot(account.loginType, baseMergedSnapshot))
    ? await withSoftTimeout(readPointSnapshotFromAdb(account.appVariant, dtUserId), adbPointWaitMs, null).catch(() => null)
    : null;
  const mergedGatewaySnapshot = mergeSnapshots(baseMergedSnapshot, adbPointSnapshot);
  const snapshot = includePublicEnrichment
    ? await withSoftTimeout(
        enrichSnapshotWithPublicData({
          appVariant: account.appVariant,
          dtUserId,
          snapshot: mergedGatewaySnapshot,
          previousRawJson: previousSnapshot?.rawJson
        }),
        publicEnrichmentWaitMs,
        mergedGatewaySnapshot
      ).catch(() => mergedGatewaySnapshot)
    : mergedGatewaySnapshot;
  if (gatewaySnapshot || persistCachedSnapshot) {
    await prisma.accountSnapshot.upsert({
      where: { accountId },
      update: mapSnapshot(snapshot, previousSnapshot),
      create: {
        accountId,
        ...mapSnapshot(snapshot, previousSnapshot)
      }
    });
  }

  let phoneListError: unknown;
  let phoneNumbers: DingtonePhoneNumber[] = [];
  let phoneListAttempted = false;
  let phoneListResolved = false;
  if (includePhoneNumbers) {
    phoneListAttempted = true;
    const remotePhoneNumbers = await withSoftTimeout(
      gateway.listPhoneNumbers({ dtUserId, token, deviceId: account.dtDeviceId, appVariant: account.appVariant }),
      phoneListWaitMs,
      null
    ).catch((error: unknown) => {
      phoneListError = error;
      return null;
    });
    if (remotePhoneNumbers !== null) {
      phoneListResolved = true;
      phoneNumbers = remotePhoneNumbers;
    } else if (phoneListError) {
      logger.warn("Phone list refresh failed, keeping local phone records", {
        accountId,
        dtUserId,
        error: phoneListError instanceof Error ? phoneListError.message : String(phoneListError)
      });
    }
    if (phoneNumbers.length === 0 && helperSnapshot) {
      phoneNumbers = (await withSoftTimeout(
        helperSnapshotGateway.listPhoneNumbers({ dtUserId, token, deviceId: account.dtDeviceId, appVariant: account.appVariant }),
        helperSnapshotWaitMs,
        []
      ).catch(() => [])) as DingtonePhoneNumber[];
    }

    if (phoneNumbers.length > 0) {
      await syncPhoneNumbers(accountId, phoneNumbers);
    } else {
      logger.warn("Direct refresh returned an empty phone list, keeping local records", {
        accountId,
        dtUserId
      });
    }
  }

  const normalizedNickname = normalizeOptionalString(account.nickname);
  const autoName = resolveRefreshedAccountNickname(account.nickname, snapshot.fullName, account);
  if (!normalizedNickname || autoName !== normalizedNickname) {
    await prisma.dtAccount.update({
      where: { id: accountId },
      data: {
        nickname: autoName
      }
    });
  }

  const [updated, storedPhoneCount] = await Promise.all([
    prisma.accountSnapshot.findUnique({ where: { accountId } }),
    prisma.phoneNumber.count({ where: { accountId } })
  ]);
  return {
    snapshot: serializeSnapshot(updated),
    phoneCount: phoneNumbers.length > 0 ? phoneNumbers.length : storedPhoneCount,
    remotePhoneCount: phoneNumbers.length,
    assetSignals: {
      gatewaySnapshotResolved: Boolean(gatewaySnapshot),
      balanceResolved: gatewaySnapshot?.primaryBalance !== undefined,
      phoneListAttempted,
      phoneListResolved,
      remotePhoneCount: phoneNumbers.length,
      primaryBalance: gatewaySnapshot?.primaryBalance ?? null,
      userGrade: gatewaySnapshot?.userGrade ?? null,
      membershipType: gatewaySnapshot?.membershipType ?? gatewaySnapshot?.membershipLevelLabel ?? null
    }
  };
}

function mapSnapshot(snapshot: DingtoneSnapshot, previousSnapshot?: AccountSnapshot | null) {
  return {
    dtDingtoneId: pickNextValue(snapshot.dtDingtoneId, previousSnapshot?.dtDingtoneId),
    fullName: pickNextTextValue(snapshot.fullName, previousSnapshot?.fullName),
    avatarUrl: pickNextTextValue(snapshot.avatarUrl, previousSnapshot?.avatarUrl),
    gender: pickNextNumber(snapshot.gender, previousSnapshot?.gender),
    birthday: pickNextTextValue(snapshot.birthday, previousSnapshot?.birthday),
    email: pickNextTextValue(snapshot.email, previousSnapshot?.email),
    phone: pickNextTextValue(snapshot.phone, previousSnapshot?.phone),
    aboutMe: pickNextTextValue(snapshot.aboutMe, previousSnapshot?.aboutMe),
    feeling: pickNextTextValue(snapshot.feeling, previousSnapshot?.feeling),
    company: pickNextTextValue(snapshot.company, previousSnapshot?.company),
    school: pickNextTextValue(snapshot.school, previousSnapshot?.school),
    country: pickNextTextValue(snapshot.country, previousSnapshot?.country),
    state: pickNextTextValue(snapshot.state, previousSnapshot?.state),
    city: pickNextTextValue(snapshot.city, previousSnapshot?.city),
    primaryBalance: pickNextPositiveNumber(snapshot.primaryBalance, previousSnapshot?.primaryBalance),
    userGrade: pickNextNonNegativeNumber(snapshot.userGrade, previousSnapshot?.userGrade),
    validPoint: pickNextMemberPoint(snapshot.validPoint, previousSnapshot?.validPoint),
    progressPoint: pickNextMemberPoint(snapshot.progressPoint, previousSnapshot?.progressPoint),
    membershipType: pickNextTextValue(snapshot.membershipType ?? snapshot.membershipLevelLabel, previousSnapshot?.membershipType),
    membershipExpireAt: snapshot.membershipExpireAt ?? previousSnapshot?.membershipExpireAt ?? null,
    profileVerCode: pickNextTextValue(snapshot.profileVerCode, previousSnapshot?.profileVerCode),
    rawJson: snapshot.rawJson ?? previousSnapshot?.rawJson ?? JSON.stringify(snapshot)
  };
}

function mergeSnapshots(base: DingtoneSnapshot, helper: DingtoneSnapshot | null) {
  if (!helper) {
    return base;
  }

  return {
    ...base,
    dtDingtoneId: helper.dtDingtoneId ?? base.dtDingtoneId,
    fullName: helper.fullName ?? base.fullName,
    avatarUrl: helper.avatarUrl ?? base.avatarUrl,
    gender: helper.gender ?? base.gender,
    birthday: helper.birthday ?? base.birthday,
    email: helper.email ?? base.email,
    phone: helper.phone ?? base.phone,
    aboutMe: helper.aboutMe ?? base.aboutMe,
    feeling: helper.feeling ?? base.feeling,
    company: helper.company ?? base.company,
    school: helper.school ?? base.school,
    country: helper.country ?? base.country,
    state: helper.state ?? base.state,
    city: helper.city ?? base.city,
    primaryBalance: pickNextPositiveNumber(helper.primaryBalance, base.primaryBalance) ?? undefined,
    userGrade: helper.userGrade ?? base.userGrade,
    validPoint: helper.validPoint ?? base.validPoint,
    progressPoint: helper.progressPoint ?? base.progressPoint,
    progressPointTotal: helper.progressPointTotal ?? base.progressPointTotal,
    membershipType: helper.membershipType ?? base.membershipType,
    membershipLevelLabel: helper.membershipLevelLabel ?? base.membershipLevelLabel,
    membershipExpireAt: helper.membershipExpireAt ?? base.membershipExpireAt,
    profileVerCode: helper.profileVerCode ?? base.profileVerCode,
    rawJson: mergeSnapshotRawJson(base.rawJson, helper.rawJson)
  };
}

function snapshotFromStored(snapshot: AccountSnapshot): DingtoneSnapshot {
  return {
    dtDingtoneId: snapshot.dtDingtoneId ?? undefined,
    fullName: snapshot.fullName ?? undefined,
    avatarUrl: snapshot.avatarUrl ?? undefined,
    gender: snapshot.gender ?? undefined,
    birthday: snapshot.birthday ?? undefined,
    email: snapshot.email ?? undefined,
    phone: snapshot.phone ?? undefined,
    aboutMe: snapshot.aboutMe ?? undefined,
    feeling: snapshot.feeling ?? undefined,
    company: snapshot.company ?? undefined,
    school: snapshot.school ?? undefined,
    country: snapshot.country ?? undefined,
    state: snapshot.state ?? undefined,
    city: snapshot.city ?? undefined,
    primaryBalance: snapshot.primaryBalance ?? undefined,
    userGrade: snapshot.userGrade ?? undefined,
    validPoint: snapshot.validPoint ?? undefined,
    progressPoint: snapshot.progressPoint ?? undefined,
    membershipType: snapshot.membershipType ?? undefined,
    membershipLevelLabel: snapshot.membershipType ?? undefined,
    membershipExpireAt: snapshot.membershipExpireAt ?? undefined,
    profileVerCode: snapshot.profileVerCode ?? undefined,
    rawJson: snapshot.rawJson ?? undefined
  };
}

function withSoftTimeout<T, F>(promise: Promise<T>, timeoutMs: number, fallback: F): Promise<T | F> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => finish(() => resolve(fallback)), timeoutMs);
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

async function shouldMergeHelperSnapshot(loginType: string, snapshot: DingtoneSnapshot) {
  if (loginType === "manual_session") {
    return true;
  }
  const mode = await getGatewayMode().catch(() => "mock");
  if (mode !== "direct") {
    return true;
  }
  return (
    !normalizeOptionalString(snapshot.phone) ||
    !isPositiveNumber(snapshot.primaryBalance) ||
    snapshot.userGrade === undefined ||
    snapshot.validPoint === undefined
  );
}

async function shouldMergeAdbPointSnapshot(loginType: string, snapshot: DingtoneSnapshot) {
  if (loginType === "manual_session") {
    return true;
  }
  const mode = await getGatewayMode().catch(() => "mock");
  if (mode !== "direct") {
    return true;
  }
  return !isPositiveNumber(snapshot.primaryBalance) || snapshot.userGrade === undefined || snapshot.validPoint === undefined;
}

function isPositiveNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function mergeSnapshotRawJson(baseRawJson: string | undefined, helperRawJson: string | undefined) {
  if (!helperRawJson) {
    return baseRawJson;
  }
  if (!baseRawJson) {
    return helperRawJson;
  }

  try {
    const baseParsed = JSON.parse(baseRawJson) as unknown;
    const helperParsed = JSON.parse(helperRawJson) as unknown;
    if (isRecord(baseParsed) && isRecord(helperParsed)) {
      return JSON.stringify({
        ...baseParsed,
        ...helperParsed,
        balance: isRecord(baseParsed.balance) ? baseParsed.balance : helperParsed.balance,
        profile: helperParsed.profile ?? baseParsed.profile,
        point: helperParsed.point ?? baseParsed.point,
        snapshot: helperParsed.snapshot ?? baseParsed.snapshot
      });
    }
  } catch {
    return helperRawJson;
  }

  return helperRawJson;
}

function snapshotBelongsToDtUserId(snapshot: DingtoneSnapshot | null, dtUserId: string) {
  if (!snapshot) {
    return false;
  }
  const raw = parseJsonRecord(snapshot.rawJson);
  const account = isRecord(raw.account) ? raw.account : null;
  const rawDtUserId =
    pickStringFromRecord(account, ["dtUserId", "dt_user_id", "userId", "user_id"]) ??
    pickStringFromRecord(raw, ["dtUserId", "dt_user_id", "userId", "user_id"]);
  return rawDtUserId === dtUserId;
}

function parseJsonRecord(value: string | undefined) {
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

function pickStringFromRecord(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: string | null, message: string) {
  if (!value) {
    throw new AppError(message, 400, 400);
  }
  return value;
}

function pickNextValue(next: string | null | undefined, previous: string | null | undefined) {
  return normalizeOptionalString(next) ?? previous ?? null;
}

function pickNextTextValue(next: string | null | undefined, previous: string | null | undefined) {
  const normalizedNext = normalizeOptionalString(next);
  if (normalizedNext) {
    return repairUtf8Mojibake(normalizedNext);
  }
  const normalizedPrevious = normalizeOptionalString(previous);
  return normalizedPrevious ? repairUtf8Mojibake(normalizedPrevious) : null;
}

function pickNextNumber(next: number | null | undefined, previous: number | null | undefined) {
  return next ?? previous ?? null;
}

function pickNextNonNegativeNumber(next: number | null | undefined, previous: number | null | undefined) {
  if (typeof next === "number" && Number.isFinite(next) && next >= 0) {
    return next;
  }
  if (typeof previous === "number" && Number.isFinite(previous) && previous >= 0) {
    return previous;
  }
  return null;
}

function pickNextPositiveNumber(next: number | null | undefined, previous: number | null | undefined) {
  if (typeof next === "number" && Number.isFinite(next) && next > 0) {
    return next;
  }
  if (typeof previous === "number" && Number.isFinite(previous) && previous > 0) {
    return previous;
  }
  return null;
}

function pickNextMemberPoint(next: number | null | undefined, previous: number | null | undefined) {
  const normalizedNext = normalizeMemberPoint(next);
  if (normalizedNext !== null) {
    return normalizedNext;
  }
  return normalizeMemberPoint(previous);
}

function normalizeMemberPoint(value: number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10_000) {
    return value;
  }
  return null;
}
