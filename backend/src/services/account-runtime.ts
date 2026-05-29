import { PhoneStatus, type Prisma, type AccountSnapshot } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError, assertFound } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { serializeSnapshot } from "../utils/serializers.js";
import { decryptText } from "../utils/crypto.js";
import { dingtoneGateway } from "./dingtone/index.js";
import { RealDingtoneGateway } from "./dingtone/real-gateway.js";
import type { DingtoneGateway, DingtonePhoneNumber, DingtoneSnapshot } from "./dingtone/types.js";
import { enrichSnapshotWithPublicData } from "./public-account-enrichment.js";
import { getGatewayMode } from "./settings.service.js";
import { readPointSnapshotFromAdb } from "./adb-point-snapshot.js";

const helperSnapshotGateway = new RealDingtoneGateway();

export async function refreshAccountRuntimeData(
  accountId: number,
  gateway: Pick<DingtoneGateway, "refreshSnapshot" | "listPhoneNumbers"> = dingtoneGateway
) {
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

  const gatewaySnapshot = await gateway.refreshSnapshot({
    dtUserId,
    token,
    deviceId: account.dtDeviceId,
    email: account.email,
    phone: account.phone,
    appVariant: account.appVariant
  });
  const helperSnapshot = (await shouldMergeHelperSnapshot(account.loginType))
    ? await helperSnapshotGateway
        .refreshSnapshot({
          dtUserId,
          token,
          deviceId: account.dtDeviceId,
          email: account.email,
          phone: account.phone,
          appVariant: account.appVariant
        })
        .catch(() => null)
    : null;
  const adbPointSnapshot = await readPointSnapshotFromAdb(account.appVariant).catch(() => null);
  const mergedGatewaySnapshot = mergeSnapshots(mergeSnapshots(gatewaySnapshot, helperSnapshot), adbPointSnapshot);
  const snapshot = await enrichSnapshotWithPublicData({
    appVariant: account.appVariant,
    dtUserId,
    snapshot: mergedGatewaySnapshot,
    previousRawJson: previousSnapshot?.rawJson
  }).catch(() => mergedGatewaySnapshot);
  let phoneNumbers: DingtonePhoneNumber[] = [];
  try {
    phoneNumbers = await gateway.listPhoneNumbers({ dtUserId, token, deviceId: account.dtDeviceId, appVariant: account.appVariant });
  } catch (error) {
    logger.warn("Phone list refresh failed, keeping local phone records", {
      accountId,
      dtUserId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  await prisma.accountSnapshot.upsert({
    where: { accountId },
    update: mapSnapshot(snapshot, previousSnapshot),
    create: {
      accountId,
      ...mapSnapshot(snapshot, previousSnapshot)
    }
  });

  if (phoneNumbers.length > 0) {
    await syncPhoneNumbers(accountId, phoneNumbers);
  } else {
    logger.warn("Direct refresh returned an empty phone list, keeping local records", {
      accountId,
      dtUserId
    });
  }

  const normalizedNickname = normalizeOptionalString(account.nickname);
  const snapshotName = normalizeOptionalString(snapshot.fullName);
  if (!normalizedNickname || shouldReplaceNickname(normalizedNickname, snapshotName)) {
    const autoName = snapshotName || account.email || account.phone || account.dtUserId || "Untitled Account";
    await prisma.dtAccount.update({
      where: { id: accountId },
      data: {
        nickname: autoName
      }
    });
  }

  const updated = await prisma.accountSnapshot.findUnique({ where: { accountId } });
  return {
    snapshot: serializeSnapshot(updated),
    phoneCount: phoneNumbers.length
  };
}

async function syncPhoneNumbers(accountId: number, phoneNumbers: DingtonePhoneNumber[]) {
  const remoteSet = new Set<string>();
  for (const item of phoneNumbers) {
    if (!item.phoneNumber) {
      continue;
    }
    remoteSet.add(item.phoneNumber);
    await prisma.phoneNumber.upsert({
      where: {
        accountId_phoneNumber: {
          accountId,
          phoneNumber: item.phoneNumber
        }
      },
      update: mapPhoneNumberPatch(item),
      create: mapPhoneNumberCreate(accountId, item)
    });
  }

  const missingCount = remoteSet.size
    ? await prisma.phoneNumber.count({
        where: {
          accountId,
          phoneNumber: { notIn: Array.from(remoteSet) }
        }
      })
    : 0;
  if (missingCount > 0) {
    logger.warn("Remote phone list did not include some local phone records; keeping them until an explicit cancel/expire action verifies removal", {
      accountId,
      missingCount
    });
  }
}

function mapSnapshot(snapshot: DingtoneSnapshot, previousSnapshot?: AccountSnapshot | null) {
  return {
    dtDingtoneId: pickNextValue(snapshot.dtDingtoneId, previousSnapshot?.dtDingtoneId),
    fullName: pickNextValue(snapshot.fullName, previousSnapshot?.fullName),
    avatarUrl: pickNextValue(snapshot.avatarUrl, previousSnapshot?.avatarUrl),
    gender: pickNextNumber(snapshot.gender, previousSnapshot?.gender),
    birthday: pickNextValue(snapshot.birthday, previousSnapshot?.birthday),
    email: pickNextValue(snapshot.email, previousSnapshot?.email),
    phone: pickNextValue(snapshot.phone, previousSnapshot?.phone),
    aboutMe: pickNextValue(snapshot.aboutMe, previousSnapshot?.aboutMe),
    feeling: pickNextValue(snapshot.feeling, previousSnapshot?.feeling),
    company: pickNextValue(snapshot.company, previousSnapshot?.company),
    school: pickNextValue(snapshot.school, previousSnapshot?.school),
    country: pickNextValue(snapshot.country, previousSnapshot?.country),
    state: pickNextValue(snapshot.state, previousSnapshot?.state),
    city: pickNextValue(snapshot.city, previousSnapshot?.city),
    primaryBalance: pickNextNumber(snapshot.primaryBalance, previousSnapshot?.primaryBalance),
    userGrade: pickNextNumber(snapshot.userGrade, previousSnapshot?.userGrade),
    validPoint: pickNextNumber(snapshot.validPoint, previousSnapshot?.validPoint),
    progressPoint: pickNextNumber(snapshot.progressPoint, previousSnapshot?.progressPoint),
    membershipType: pickNextValue(snapshot.membershipType ?? snapshot.membershipLevelLabel, previousSnapshot?.membershipType),
    membershipExpireAt: snapshot.membershipExpireAt ?? previousSnapshot?.membershipExpireAt ?? null,
    profileVerCode: pickNextValue(snapshot.profileVerCode, previousSnapshot?.profileVerCode),
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

async function shouldMergeHelperSnapshot(loginType: string) {
  if (loginType === "manual_session") {
    return true;
  }
  const mode = await getGatewayMode().catch(() => "mock");
  return mode !== "direct";
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

function mapPhoneNumberBase(item: Partial<DingtonePhoneNumber>) {
  return {
    countryCode: item.countryCode,
    providerId: item.providerId,
    displayName: item.displayName,
    status: item.status ? (item.status as PhoneStatus) : undefined,
    purchaseType: item.purchaseType,
    payType: item.payType,
    validPeriodDays: item.validPeriodDays,
    gainTime: item.gainTime,
    expiredTime: item.expiredTime,
    autoRenew: item.autoRenew ?? false,
    isPrimary: item.isPrimary ?? false,
    isGoodNumber: item.isGoodNumber ?? false,
    portoutInfo: item.portoutInfo,
    rawJson: item.rawJson ?? JSON.stringify(item)
  };
}

function mapPhoneNumberCreate(accountId: number, item: DingtonePhoneNumber): Prisma.PhoneNumberUncheckedCreateInput {
  return {
    accountId,
    phoneNumber: item.phoneNumber,
    ...mapPhoneNumberBase(item)
  };
}

function mapPhoneNumberPatch(item: Partial<DingtonePhoneNumber>): Prisma.PhoneNumberUncheckedUpdateInput {
  return mapPhoneNumberBase(item);
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldReplaceNickname(currentNickname: string | null, snapshotName: string | null) {
  if (!currentNickname || !snapshotName) {
    return false;
  }
  const repairedNickname = repairUtf8Mojibake(currentNickname);
  return repairedNickname !== currentNickname && repairedNickname === snapshotName;
}

function repairUtf8Mojibake(value: string) {
  if (!value) {
    return value;
  }
  if (/[\u4e00-\u9fff]/.test(value)) {
    return value;
  }

  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (!repaired || repaired === value || repaired.includes("锟")) {
      return value;
    }
    if (/[\u4e00-\u9fff]/.test(repaired)) {
      return repaired;
    }
    return value;
  } catch {
    return value;
  }
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

function pickNextNumber(next: number | null | undefined, previous: number | null | undefined) {
  return next ?? previous ?? null;
}
