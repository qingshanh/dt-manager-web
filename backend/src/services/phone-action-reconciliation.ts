import {
  PhoneActionState,
  PhoneActionType,
  PhoneStatus,
  type PhoneActionOperation
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decryptText } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
import { accountMonitorService } from "./account-monitor.js";
import { DirectDingtoneGateway } from "./dingtone/direct-gateway.js";
import type { DingtonePhoneNumber } from "./dingtone/types.js";
import { mapPhoneNumberPatch } from "./phone-number-store.js";
import {
  formatPhoneRenewalPeriod,
  sendPhoneTelegramNotification
} from "./telegram-notifier.js";
import {
  incrementPhoneActionReconcileAttempts,
  listRecoverablePhoneActionOperations,
  markPhoneActionConfirmed,
  markPhoneActionManualReview
} from "./phone-action-operation.js";

const RECONCILE_DELAYS_MS = [5_000, 20_000, 60_000, 300_000] as const;
const NOTIFIABLE_PHONE_ACTIONS = new Set<PhoneActionType>([
  PhoneActionType.renew,
  PhoneActionType.cancel,
  PhoneActionType.pause,
  PhoneActionType.resume
]);
const scheduled = new Map<number, NodeJS.Timeout>();
const directGateway = new DirectDingtoneGateway();

type ReconciliationOperation = Pick<
  PhoneActionOperation,
  "action" | "baselineExpiry" | "requestPayloadJson"
>;

type ReconciliationLocalPhone = {
  phoneNumber: string;
  status?: string | null;
  expiredTime?: string | null;
};

export type PhoneActionReconciliationResult = {
  confirmed: boolean;
  confirmationSource?: string;
  confirmedExpiry?: string | null;
  phonePatch?: Partial<DingtonePhoneNumber>;
};

export function evaluatePhoneActionReconciliation(
  operation: ReconciliationOperation,
  localPhone: ReconciliationLocalPhone,
  remotePhones: DingtonePhoneNumber[]
): PhoneActionReconciliationResult {
  const target = normalizePhoneDigits(localPhone.phoneNumber);
  const remote = remotePhones.find((phone) => normalizePhoneDigits(phone.phoneNumber) === target) ?? null;
  const desired = parseRequestPayload(operation.requestPayloadJson);

  if (operation.action === PhoneActionType.cancel) {
    const confirmed = remote === null || remote.status === "cancelled";
    return confirmed
      ? {
          confirmed: true,
          confirmationSource: "remote_phone_list",
          phonePatch: { ...(remote ?? { phoneNumber: localPhone.phoneNumber }), status: "cancelled" }
        }
      : { confirmed: false };
  }

  if (!remote) return { confirmed: false };

  if (operation.action === PhoneActionType.renew) {
    const baseline = parsePhoneEpoch(operation.baselineExpiry);
    const current = parsePhoneEpoch(remote.expiredTime);
    const confirmed = baseline !== null && current !== null && current > baseline;
    return confirmed
      ? {
          confirmed: true,
          confirmationSource: "remote_phone_list",
          confirmedExpiry: remote.expiredTime ?? null,
          phonePatch: remote
        }
      : { confirmed: false };
  }

  if (operation.action === PhoneActionType.pause) {
    return remote.status === "paused"
      ? { confirmed: true, confirmationSource: "remote_phone_list", phonePatch: remote }
      : { confirmed: false };
  }

  if (operation.action === PhoneActionType.resume || operation.action === PhoneActionType.reactivate) {
    return remote.status === "active"
      ? { confirmed: true, confirmationSource: "remote_phone_list", phonePatch: remote }
      : { confirmed: false };
  }

  if (operation.action === PhoneActionType.update_label) {
    return typeof desired.displayName === "string" && remote.displayName === desired.displayName
      ? { confirmed: true, confirmationSource: "remote_phone_list", phonePatch: remote }
      : { confirmed: false };
  }

  if (operation.action === PhoneActionType.enable_sms) {
    return desired.allowReceiveSms === true && remote.allowReceiveSms === true
      ? { confirmed: true, confirmationSource: "remote_phone_list", phonePatch: remote }
      : { confirmed: false };
  }

  return { confirmed: false };
}

export function schedulePhoneActionReconciliation(operationId: number): void {
  if (scheduled.has(operationId)) return;
  void scheduleNext(operationId);
}

async function scheduleNext(operationId: number) {
  const operation = await prisma.phoneActionOperation.findUnique({ where: { id: operationId } }).catch(() => null);
  if (!operation || operation.state !== PhoneActionState.awaiting_confirmation) return;
  const delay = RECONCILE_DELAYS_MS[Math.min(operation.reconcileAttempts, RECONCILE_DELAYS_MS.length - 1)]!;
  const timer = setTimeout(() => {
    scheduled.delete(operationId);
    void reconcilePhoneActionOperation(operationId)
      .then((next) => {
        if (next?.state === PhoneActionState.awaiting_confirmation) schedulePhoneActionReconciliation(operationId);
      })
      .catch((error) => {
        logger.warn("Phone action read-only reconciliation failed", {
          operationId,
          error: error instanceof Error ? error.message : String(error)
        });
        schedulePhoneActionReconciliation(operationId);
      });
  }, delay);
  timer.unref?.();
  scheduled.set(operationId, timer);
}

export async function reconcilePhoneActionOperation(operationId: number): Promise<PhoneActionOperation | null> {
  const operation = await prisma.phoneActionOperation.findUnique({
    where: { id: operationId },
    include: { account: true, phone: true }
  });
  if (!operation || operation.state !== PhoneActionState.awaiting_confirmation) return operation;

  const attempted = await incrementPhoneActionReconcileAttempts(operation.id);
  const token = operation.account.dtToken ? decryptText(operation.account.dtToken) : null;
  if (!operation.account.dtUserId || !token) {
    return markPhoneActionManualReview(operation.id, "Direct session is unavailable for read-only confirmation");
  }

  let remotePhones: DingtonePhoneNumber[] = [];
  let balanceAfter: number | null = null;
  try {
    await accountMonitorService.withMaintenance(operation.accountId, async () => {
      const directAccount = {
        dtUserId: operation.account.dtUserId!,
        token,
        deviceId: operation.account.dtDeviceId,
        appVariant: operation.appVariant
      };
      remotePhones = await directGateway.listPhoneNumbers(directAccount);
      if (operation.action === PhoneActionType.renew) {
        const snapshot = await directGateway.refreshSnapshot(directAccount).catch(() => null);
        balanceAfter = snapshot?.primaryBalance ?? null;
      }
    });
  } catch (error) {
    if (attempted.reconcileAttempts >= RECONCILE_DELAYS_MS.length) {
      return markPhoneActionManualReview(operation.id, error);
    }
    throw error;
  }

  const result = evaluatePhoneActionReconciliation(operation, operation.phone, remotePhones);
  if (!result.confirmed) {
    if (attempted.reconcileAttempts >= RECONCILE_DELAYS_MS.length) {
      return markPhoneActionManualReview(operation.id, "Remote state did not confirm the requested action");
    }
    return prisma.phoneActionOperation.findUnique({ where: { id: operation.id } });
  }

  if (result.phonePatch) {
    await prisma.phoneNumber.update({
      where: { id: operation.phoneId },
      data: mapPhoneNumberPatch(result.phonePatch)
    });
  } else if (operation.action === PhoneActionType.cancel) {
    await prisma.phoneNumber.update({
      where: { id: operation.phoneId },
      data: { status: PhoneStatus.cancelled }
    });
  }

  const confirmed = await markPhoneActionConfirmed(operation.id, {
    confirmationSource: result.confirmationSource ?? "remote_phone_list",
    responseClass: "read_only_confirmed",
    balanceAfter,
    confirmedExpiry: result.confirmedExpiry,
    extensionMonths: operation.extensionMonths,
    evidenceAt: new Date()
  });
  const storedPhone = await prisma.phoneNumber.findUnique({ where: { id: operation.phoneId } });
  if (storedPhone && NOTIFIABLE_PHONE_ACTIONS.has(operation.action)) {
    const action = operation.action as "renew" | "cancel" | "pause" | "resume";
    const ownedPhoneNumbers = action === "renew"
      ? (await prisma.phoneNumber.findMany({
          where: { accountId: operation.accountId, status: { not: PhoneStatus.cancelled } },
          orderBy: { id: "asc" },
          select: { phoneNumber: true }
        })).map((item) => item.phoneNumber)
      : undefined;
    await sendPhoneTelegramNotification({
      account: operation.account,
      phone: mapStoredPhoneForNotification(storedPhone),
      action,
      verificationSource: result.confirmationSource ?? "remote_phone_list",
      verificationNote: "操作已通过只读远端号码列表确认。",
      balanceBefore: operation.balanceBefore,
      balanceAfter,
      ownedPhoneNumbers,
      renewalDuration: action === "renew"
        ? formatRenewalExtension(operation.baselineExpiry, storedPhone.expiredTime) ?? formatPhoneRenewalPeriod(mapStoredPhoneForNotification(storedPhone))
        : null,
      renewedUntil: action === "renew" ? formatPhoneExpiryTime(storedPhone.expiredTime) : null
    }).catch((error) => {
      logger.warn("Failed to send confirmed phone action Telegram notification", {
        operationId: operation.id,
        accountId: operation.accountId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  return confirmed;
}

export async function recoverPhoneActionOperations(): Promise<void> {
  const operations = await listRecoverablePhoneActionOperations();
  for (const operation of operations) {
    if (operation.state === PhoneActionState.writing) {
      await markPhoneActionManualReview(operation.id, "Process restarted while a mutation write was in progress");
      continue;
    }
    schedulePhoneActionReconciliation(operation.id);
  }
}

function parseRequestPayload(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizePhoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function parsePhoneEpoch(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function mapStoredPhoneForNotification(phone: {
  phoneNumber: string;
  countryCode: number | null;
  providerId: number | null;
  displayName: string | null;
  status: PhoneStatus;
  purchaseType: number | null;
  payType: number | null;
  validPeriodDays: number | null;
  gainTime: string | null;
  expiredTime: string | null;
  autoRenew: boolean;
  isPrimary: boolean;
  isGoodNumber: boolean;
  portoutInfo: string | null;
  rawJson: string | null;
}): DingtonePhoneNumber {
  return {
    phoneNumber: phone.phoneNumber,
    countryCode: phone.countryCode ?? undefined,
    providerId: phone.providerId ?? undefined,
    displayName: phone.displayName ?? undefined,
    status: phone.status,
    purchaseType: phone.purchaseType ?? undefined,
    payType: phone.payType ?? undefined,
    validPeriodDays: phone.validPeriodDays ?? undefined,
    gainTime: phone.gainTime ?? undefined,
    expiredTime: phone.expiredTime ?? undefined,
    autoRenew: phone.autoRenew,
    isPrimary: phone.isPrimary,
    isGoodNumber: phone.isGoodNumber,
    portoutInfo: phone.portoutInfo ?? undefined,
    rawJson: phone.rawJson ?? undefined
  };
}

function formatRenewalExtension(before?: string | null, after?: string | null) {
  const beforeEpoch = parsePhoneEpoch(before);
  const afterEpoch = parsePhoneEpoch(after);
  if (!beforeEpoch || !afterEpoch || afterEpoch <= beforeEpoch) return null;
  const days = Math.round((afterEpoch - beforeEpoch) / 86_400_000);
  if (days >= 28) return `${Math.max(1, Math.round(days / 31))} 个月`;
  return `${Math.max(1, days)} 天`;
}

function formatPhoneExpiryTime(value?: string | null) {
  const epoch = parsePhoneEpoch(value);
  return epoch ? new Date(epoch).toISOString() : value ?? null;
}
