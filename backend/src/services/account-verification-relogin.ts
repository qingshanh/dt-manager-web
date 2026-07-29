import { AccountStatus, type AppVariant, type LoginType } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createActivationTrackCode, createDeviceId, encryptText } from "../utils/crypto.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { DingtoneLoginInput, DingtoneLoginResult, VerificationRequestResult } from "./dingtone/types.js";
import { dingtoneGateway } from "./dingtone/index.js";
import { refreshAccountRuntimeData } from "./account-runtime.js";
import { accountMonitorService } from "./account-monitor.js";

type VerificationAccount = {
  id: number;
  adminId: number;
  loginType: LoginType;
  appVariant: AppVariant;
  email: string | null;
  phone: string | null;
  dtUserId: string | null;
  dtDeviceId: string;
  dtTrackCode: string;
  status: AccountStatus;
};

export type AccountVerificationReloginDeps = {
  loadAccount: (accountId: number) => Promise<VerificationAccount | null>;
  createDeviceId: () => string;
  createTrackCode: () => string;
  updateAccount: (accountId: number, data: Record<string, unknown>) => Promise<unknown>;
  sendVerificationCode: (input: DingtoneLoginInput) => Promise<VerificationRequestResult>;
  login: (input: DingtoneLoginInput) => Promise<DingtoneLoginResult>;
  persistSession: (accountId: number, session: DingtoneLoginResult) => Promise<unknown>;
  refreshAccount: (accountId: number) => Promise<unknown>;
  startMonitor: (accountId: number) => Promise<unknown>;
};

const defaultDeps: AccountVerificationReloginDeps = {
  loadAccount: (accountId) => prisma.dtAccount.findUnique({ where: { id: accountId } }),
  createDeviceId,
  createTrackCode: createActivationTrackCode,
  updateAccount: (accountId, data) => prisma.dtAccount.update({ where: { id: accountId }, data }),
  sendVerificationCode: (input) => dingtoneGateway.sendVerificationCode(input),
  login: (input) => dingtoneGateway.login(input),
  persistSession: async (accountId, session) => {
    await prisma.$transaction(async (transaction) => {
      await transaction.dtAccount.update({
        where: { id: accountId },
        data: {
          dtUserId: session.dtUserId,
          dtToken: encryptText(session.token),
          ...(session.deviceId ? { dtDeviceId: session.deviceId } : {}),
          lastLoginAt: new Date(),
          status: AccountStatus.offline,
          lastError: null
        }
      });
      if (session.dingtoneId) {
        await transaction.accountSnapshot.upsert({
          where: { accountId },
          create: { accountId, dtDingtoneId: session.dingtoneId },
          update: { dtDingtoneId: session.dingtoneId }
        });
      }
    });
  },
  refreshAccount: refreshAccountRuntimeData,
  startMonitor: (accountId) => accountMonitorService.start(accountId)
};

export async function requestAccountVerificationRelogin(
  accountId: number,
  deps: AccountVerificationReloginDeps = defaultDeps
) {
  const account = await requireVerificationAccount(accountId, deps);
  const deviceId = normalizeVerificationDeviceId(deps.createDeviceId(), account.appVariant, account.loginType);
  const trackCode = deps.createTrackCode();
  await deps.updateAccount(account.id, { dtDeviceId: deviceId, dtTrackCode: trackCode, lastError: null });

  try {
    const result = await deps.sendVerificationCode(buildLoginInput(account, deviceId, trackCode));
    const nextTrackCode = result.nextTrackCode?.trim() || trackCode;
    if (nextTrackCode !== trackCode) {
      await deps.updateAccount(account.id, { dtTrackCode: nextTrackCode, lastError: null });
    }
    return { accountId: account.id, requested: true };
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    await deps.updateAccount(account.id, {
      dtDeviceId: account.dtDeviceId,
      dtTrackCode: account.dtTrackCode,
      appVariant: account.appVariant,
      lastError: errorText
    }).catch(() => undefined);
    throw error;
  }
}

export async function completeAccountVerificationRelogin(
  accountId: number,
  code: string,
  deps: AccountVerificationReloginDeps = defaultDeps
) {
  const normalizedCode = code.trim();
  if (!/^\d{4,8}$/.test(normalizedCode)) {
    throw new AppError("Verification code must contain 4 to 8 digits", 400, 400);
  }
  const account = await requireVerificationAccount(accountId, deps);
  const result = await deps.login({
    ...buildLoginInput(account, normalizeVerificationDeviceId(account.dtDeviceId, account.appVariant, account.loginType), account.dtTrackCode),
    verificationCode: normalizedCode
  });
  if (account.dtUserId && result.dtUserId !== account.dtUserId) {
    throw new AppError("Verification result does not match the existing remote account", 409, 409);
  }

  await deps.persistSession(account.id, result);
  await deps.refreshAccount(account.id).catch((error) => {
    logger.warn("Verification relogin snapshot refresh failed", {
      accountId: account.id,
      error: error instanceof Error ? error.name : typeof error
    });
  });
  try {
    await deps.startMonitor(account.id);
    return { accountId: account.id, monitorStarted: true, monitorError: null };
  } catch (error) {
    const monitorError = error instanceof Error ? error.message : String(error);
    await deps.updateAccount(account.id, {
      status: AccountStatus.offline,
      monitorEnabled: false,
      lastError: monitorError
    }).catch(() => undefined);
    return { accountId: account.id, monitorStarted: false, monitorError };
  }
}

async function requireVerificationAccount(accountId: number, deps: AccountVerificationReloginDeps) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new AppError("Invalid account id", 400, 400);
  }
  const account = await deps.loadAccount(accountId);
  if (!account) throw new AppError("Account not found", 404, 404);
  if (account.loginType !== "email_code" && account.loginType !== "phone_code") {
    throw new AppError("This account does not support verification-code relogin", 400, 400);
  }
  return account;
}

function buildLoginInput(account: VerificationAccount, deviceId: string, trackCode: string): DingtoneLoginInput {
  return {
    loginType: account.loginType,
    appVariant: account.appVariant,
    email: account.email,
    phone: account.phone,
    deviceId,
    trackCode
  };
}

function normalizeVerificationDeviceId(deviceId: string, appVariant: AppVariant, loginType: LoginType) {
  const trimmed = deviceId.trim();
  return loginType === "email_code" && appVariant === "dingdong" ? trimmed.replace(/\.dttalk$/i, "") : trimmed;
}
