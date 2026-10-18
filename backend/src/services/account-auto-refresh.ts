import { AccountStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decryptText } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
import { refreshAccountRuntimeData } from "./account-runtime.js";
import { BackgroundLoop } from "./background-loop.js";
import { getSettingsMap } from "./settings.service.js";

// 默认每个账号至少间隔 2 小时才刷新一次，最小不低于 30 分钟
export const MIN_STALE_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_STALE_INTERVAL_MS = 2 * 60 * 60_000; // 2 小时

// 每次循环轮询的节奏：白天每 3 分钟检查一小批，夜间每 15 分钟检查一次是否天亮
export const DAY_CYCLE_DELAY_MS = 3 * 60_000;
export const NIGHT_CYCLE_DELAY_MS = 15 * 60_000;
export const MAX_ACCOUNTS_PER_CYCLE = 3;
export const DELAY_BETWEEN_ACCOUNTS_MS = 1_500;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isNightQuietHours(date = new Date()): boolean {
  // 默认半夜 0:00 - 7:00 为静默期，不自动更新账号
  const hour = date.getHours();
  return hour >= 0 && hour < 7;
}

export class AccountAutoRefreshService {
  private readonly loop = new BackgroundLoop({
    initialDelayMs: 20_000,
    defaultDelayMs: DAY_CYCLE_DELAY_MS,
    task: () => this.runCycle(),
    onError: (error) => {
      logger.warn("Account auto refresh cycle failed", {
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

  async runCycle(now = new Date()) {
    const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
    if (!parseBooleanSetting(settings.account_auto_refresh_enabled, true)) {
      return DAY_CYCLE_DELAY_MS;
    }

    // 半夜（0:00 - 7:00）静默跳过，避免夜间打扰和风控
    if (isNightQuietHours(now)) {
      logger.debug("Account auto refresh skipped during midnight quiet hours");
      return NIGHT_CYCLE_DELAY_MS;
    }

    const intervalMs = Math.max(
      MIN_STALE_INTERVAL_MS,
      parsePositiveIntSetting(settings.auto_refresh_interval, DEFAULT_STALE_INTERVAL_MS / 1000) * 1000
    );
    const staleBefore = new Date(now.getTime() - intervalMs);

    // 查询所有登录态账号（包含已开启和未开启 monitor 的账号）
    const accounts = await prisma.dtAccount.findMany({
      where: {
        dtUserId: { not: null },
        dtToken: { not: null },
        status: { in: [AccountStatus.online, AccountStatus.offline, AccountStatus.error] },
        OR: [{ snapshot: null }, { snapshot: { updatedAt: { lt: staleBefore } } }]
      },
      orderBy: { updatedAt: "asc" },
      take: MAX_ACCOUNTS_PER_CYCLE,
      select: { id: true, dtToken: true }
    });

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      if (!account || !decryptText(account.dtToken)) {
        continue;
      }
      try {
        await refreshAccountRuntimeData(account.id);
        await prisma.dtAccount.update({
          where: { id: account.id },
          data: { status: AccountStatus.online, lastError: null }
        });
      } catch (error) {
        logger.warn("Account auto refresh failed", {
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      if (i < accounts.length - 1) {
        await delay(DELAY_BETWEEN_ACCOUNTS_MS);
      }
    }
    return DAY_CYCLE_DELAY_MS;
  }
}

function parseBooleanSetting(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveIntSetting(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const accountAutoRefreshService = new AccountAutoRefreshService();
