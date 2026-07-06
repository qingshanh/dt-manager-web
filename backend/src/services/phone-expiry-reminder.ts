import { PhoneStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";
import { sendAccountTelegramNotification } from "./telegram-notifier.js";

const CHECK_INTERVAL_MS = 60 * 60_000;

type ExpiryMilestone = "7d" | "3d" | "1d" | "expired";

class PhoneExpiryReminderService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start() {
    if (this.timer) {
      return;
    }
    this.schedule(20_000);
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number) {
    this.stop();
    this.timer = setTimeout(() => {
      void this.runCycle().catch((error) => {
        logger.warn("Phone expiry reminder cycle failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, delayMs);
  }

  private async runCycle() {
    if (this.running) {
      this.schedule(CHECK_INTERVAL_MS);
      return;
    }
    this.running = true;
    try {
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
              telegramNotify: true
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
        const sent = await sendAccountTelegramNotification(phone.account, expiryTitle(milestone), [
          ["账号", phone.account.nickname ?? phone.account.email ?? phone.account.dtUserId],
          ["面板账号ID", phone.account.id],
          ["手机号", phone.phoneNumber],
          ["备注", phone.displayName],
          ["状态", phone.status],
          ["剩余时间", formatRemaining(remainingMs)],
          ["到期时间", new Date(expiresAt).toISOString()]
        ]).catch((error) => {
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
    } finally {
      this.running = false;
      this.schedule(CHECK_INTERVAL_MS);
    }
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
