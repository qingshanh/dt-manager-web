import { PhoneStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decryptText } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
import { BackgroundLoop } from "./background-loop.js";
import { DirectDingtoneGateway } from "./dingtone/direct-gateway.js";
import { phoneExpiryActionKeyboard } from "./telegram-bot-ui.js";
import { sendPhoneExpiryTelegramNotification } from "./telegram-notifier.js";

const CHECK_INTERVAL_MS = 60 * 60_000;
const expiryGateway = new DirectDingtoneGateway();

type ExpiryMilestone = "7d" | "3d" | "1d" | "expired";

class PhoneExpiryReminderService {
  private readonly loop = new BackgroundLoop({
    initialDelayMs: 20_000,
    defaultDelayMs: CHECK_INTERVAL_MS,
    task: () => this.runCycle(),
    onError: (error) => {
      logger.warn("Phone expiry reminder cycle failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  start() {
    this.loop.start();
  }

  stop() {
    return this.loop.stop();
  }

  private async runCycle() {
    const balanceByAccount = new Map<number, Promise<number | null>>();
    const phones = await prisma.phoneNumber.findMany({
        where: { status: { in: [PhoneStatus.active, PhoneStatus.expired] } },
        include: {
          account: {
            select: {
              id: true,
              nickname: true,
              email: true,
              phone: true,
              dtUserId: true,
              dtToken: true,
              dtDeviceId: true,
              appVariant: true,
              telegramNotify: true,
              phoneNumbers: {
                where: { status: { not: PhoneStatus.cancelled } },
                orderBy: { id: "asc" },
                select: { phoneNumber: true }
              },
              snapshot: { select: { primaryBalance: true } }
            }
          }
        }
    });
    for (const phone of phones) {
        const expiresAt = parseEpoch(phone.expiredTime);
        if (!expiresAt || !phone.account.telegramNotify) {
          continue;
        }
        const remainingMs = expiresAt - Date.now();
        const milestone = resolveMilestone(remainingMs, phone.status);
        if (!milestone) {
          continue;
        }
        const settingKey = `phone_expiry_notice_${phone.id}_${milestone}`;
        const previous = await prisma.setting.findUnique({ where: { key: settingKey } });
        if (previous?.value === String(expiresAt)) {
          continue;
        }
        const balancePromise = balanceByAccount.get(phone.accountId) ?? resolveCurrentBalance(phone.account);
        balanceByAccount.set(phone.accountId, balancePromise);
        const balance = await balancePromise;
        const sent = await sendPhoneExpiryTelegramNotification({
          account: phone.account,
          phone: {
            phoneNumber: phone.phoneNumber,
            displayName: phone.displayName ?? undefined,
            status: phone.status,
            countryCode: phone.countryCode ?? undefined,
            providerId: phone.providerId ?? undefined,
            packageServiceId: readPackageServiceId(phone.rawJson),
            validPeriodDays: phone.validPeriodDays ?? undefined,
            expiredTime: phone.expiredTime ?? undefined,
            rawJson: phone.rawJson ?? undefined
          },
          balance,
          ownedPhoneNumbers: phone.account.phoneNumbers.map((item) => item.phoneNumber),
          remainingText: formatRemaining(remainingMs),
          expiresAt: new Date(expiresAt).toISOString(),
          title: expiryTitle(milestone)
        }, phoneExpiryActionKeyboard(phone.accountId, phone.id)).catch((error) => {
          logger.warn("Failed to send phone expiry Telegram notification", {
            accountId: phone.accountId,
            phoneNumber: phone.phoneNumber,
            milestone,
            error: error instanceof Error ? error.message : String(error)
          });
          return "";
        });
        if (sent) {
          await prisma.setting.upsert({
            where: { key: settingKey },
            update: { value: String(expiresAt) },
            create: { key: settingKey, value: String(expiresAt), description: "Phone expiry Telegram notice checkpoint" }
          });
        }
    }
  }
}

function readPackageServiceId(rawJson: string | null) {
  if (!rawJson) return undefined;
  try {
    const raw = JSON.parse(rawJson) as Record<string, unknown>;
    const value = raw.packageServiceId ?? raw.package_service_id;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function resolveCurrentBalance(account: {
  id: number;
  dtUserId: string | null;
  dtToken: string | null;
  dtDeviceId: string;
  appVariant: "dingtone" | "dingdong";
  snapshot: { primaryBalance: number | null } | null;
}) {
  const cached = account.snapshot?.primaryBalance ?? null;
  const token = decryptText(account.dtToken);
  if (!account.dtUserId || !token) return cached;
  try {
    const snapshot = await expiryGateway.refreshSnapshot({
      dtUserId: account.dtUserId,
      token,
      deviceId: account.dtDeviceId,
      appVariant: account.appVariant
    });
    return snapshot.primaryBalance ?? cached;
  } catch (error) {
    logger.warn("Phone expiry reminder could not refresh account balance; using cached balance", {
      accountId: account.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return cached;
  }
}

function resolveMilestone(remainingMs: number, status: PhoneStatus): ExpiryMilestone | null {
  if (status === PhoneStatus.expired || remainingMs <= 0) {
    return "expired";
  }
  const dayMs = 24 * 60 * 60_000;
  if (remainingMs <= dayMs) {
    return "1d";
  }
  if (remainingMs <= 3 * dayMs) {
    return "3d";
  }
  if (remainingMs <= 7 * dayMs) {
    return "7d";
  }
  return null;
}

function expiryTitle(milestone: ExpiryMilestone) {
  return {
    "7d": "号码将在 7 天内到期",
    "3d": "号码将在 3 天内到期",
    "1d": "号码将在 1 天内到期",
    expired: "号码刚过期"
  }[milestone];
}

function formatRemaining(remainingMs: number) {
  if (remainingMs <= 0) {
    return `已过期 ${formatDuration(Math.abs(remainingMs))}`;
  }
  return `还剩 ${formatDuration(remainingMs)}`;
}

function formatDuration(ms: number) {
  const totalHours = Math.max(1, Math.ceil(ms / 60 / 60_000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0 && hours > 0) {
    return `${days} 天 ${hours} 小时`;
  }
  if (days > 0) {
    return `${days} 天`;
  }
  return `${hours} 小时`;
}

function parseEpoch(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

export const phoneExpiryReminderService = new PhoneExpiryReminderService();
