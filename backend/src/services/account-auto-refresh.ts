import { AccountStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decryptText } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
import { refreshAccountRuntimeData } from "./account-runtime.js";
import { BackgroundLoop } from "./background-loop.js";
import { getSettingsMap } from "./settings.service.js";

const MIN_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const MAX_ACCOUNTS_PER_CYCLE = 10;

class AccountAutoRefreshService {
  private readonly loop = new BackgroundLoop({
    initialDelayMs: 15_000,
    defaultDelayMs: DEFAULT_REFRESH_INTERVAL_MS,
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

  private async runCycle() {
    let nextDelay = DEFAULT_REFRESH_INTERVAL_MS;
    const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
    if (!parseBooleanSetting(settings.account_auto_refresh_enabled, true)) {
      return nextDelay;
    }
    const intervalMs = Math.max(
      MIN_REFRESH_INTERVAL_MS,
      parsePositiveIntSetting(settings.auto_refresh_interval, DEFAULT_REFRESH_INTERVAL_MS / 1000) * 1000
    );
    nextDelay = intervalMs;
    const staleBefore = new Date(Date.now() - intervalMs);
    const accounts = await prisma.dtAccount.findMany({
      where: {
        dtUserId: { not: null },
        dtToken: { not: null },
        monitorEnabled: false,
        status: { in: [AccountStatus.online, AccountStatus.offline, AccountStatus.error] },
        OR: [{ snapshot: null }, { snapshot: { updatedAt: { lt: staleBefore } } }]
      },
      orderBy: { updatedAt: "asc" },
      take: MAX_ACCOUNTS_PER_CYCLE,
      select: { id: true, dtToken: true }
    });

    for (const account of accounts) {
      if (!decryptText(account.dtToken)) {
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
    }
    return nextDelay;
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
