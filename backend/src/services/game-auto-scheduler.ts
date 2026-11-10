import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";
import { BackgroundLoop } from "./background-loop.js";
import {
  getAccountGameSummary,
  runAccountAllDaily,
  runAccountFruitDaily,
  runAccountKnifeDaily,
  runAccountPetDaily
} from "./dingtone/game-service.js";
import { getSettingsMap } from "./settings.service.js";

export const GAME_SCHEDULER_CYCLE_DELAY_MS = 10 * 60_000; // 10 minutes
export const NIGHT_CYCLE_DELAY_MS = 20 * 60_000; // 20 minutes in night

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNightQuietHours(date = new Date()): boolean {
  const hour = date.getHours();
  return hour >= 0 && hour < 7;
}

function parseBooleanSetting(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  const n = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(n)) return true;
  if (["false", "0", "no", "off"].includes(n)) return false;
  return fallback;
}

function getTodayDateString(date = new Date()): string {
  return date.toISOString().split("T")[0]!;
}

// Deterministically assign each account a daily run hour (between 8:00 and 20:59) and minute
function getAccountScheduledDailyTime(accountId: number, dateStr: string): { hour: number; minute: number } {
  let hash = 0;
  const str = `${accountId}:${dateStr}:gamesched`;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const positive = Math.abs(hash);
  const hour = 8 + (positive % 13); // 8 to 20
  const minute = (positive >> 4) % 60; // 0 to 59
  return { hour, minute };
}

export class GameAutoSchedulerService {
  private readonly accountDailyCompletedDates = new Map<number, string>();
  private isRunning = false;
  private lastCycleAt: Date | null = null;

  private readonly loop = new BackgroundLoop({
    initialDelayMs: 30_000,
    defaultDelayMs: GAME_SCHEDULER_CYCLE_DELAY_MS,
    task: () => this.runCycle(),
    onError: (error) => {
      logger.warn("Game auto scheduler cycle failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  start() {
    this.loop.start();
    logger.info("Game auto scheduler service started");
  }

  stop() {
    return this.loop.stop();
  }

  getStatus() {
    const now = new Date();
    return {
      running: this.isRunning,
      isNightQuiet: isNightQuietHours(now),
      lastCycleAt: this.lastCycleAt,
      completedTodayCount: Array.from(this.accountDailyCompletedDates.values()).filter((d) => d === getTodayDateString(now)).length
    };
  }

  async runCycle(now = new Date()): Promise<number> {
    const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
    if (!parseBooleanSetting(settings.game_auto_scheduler_enabled, true)) {
      return GAME_SCHEDULER_CYCLE_DELAY_MS;
    }

    // Skip during midnight quiet hours (0:00 - 7:00)
    if (isNightQuietHours(now)) {
      return NIGHT_CYCLE_DELAY_MS;
    }

    if (this.isRunning) {
      return GAME_SCHEDULER_CYCLE_DELAY_MS;
    }

    this.isRunning = true;
    this.lastCycleAt = now;
    const dateStr = getTodayDateString(now);
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    try {
      const accounts = await prisma.dtAccount.findMany({
        where: { dtUserId: { not: null } },
        select: { id: true, nickname: true, dtUserId: true }
      });

      for (const account of accounts) {
        const lastCompleted = this.accountDailyCompletedDates.get(account.id);
        const { hour: targetHour, minute: targetMinute } = getAccountScheduledDailyTime(account.id, dateStr);

        // Tier 1: Check if main daily tasks should run for this account today
        const shouldRunMainDaily =
          lastCompleted !== dateStr &&
          (currentHour > targetHour || (currentHour === targetHour && currentMinute >= targetMinute));

        if (shouldRunMainDaily) {
          logger.info("Game auto scheduler running daily tasks for account", {
            accountId: account.id,
            targetTime: `${targetHour}:${targetMinute}`
          });
          try {
            await runAccountAllDaily(account.id);
            this.accountDailyCompletedDates.set(account.id, dateStr);
          } catch (err) {
            logger.warn("Game auto scheduler daily run failed for account", {
              accountId: account.id,
              error: err instanceof Error ? err.message : String(err)
            });
          }
          await delay(12_000); // 12 seconds spacing between accounts to ensure strict single-concurrency
          continue;
        }

        // Tier 2: For accounts that have completed daily, perform cooldown checks (feeding, treasure hunt)
        try {
          const summary = await getAccountGameSummary(account.id);
          // 1. Pet Feed
          if (summary.pet && summary.pet.nextFeedRemainingTime === 0 && (summary.pet.fishNum ?? 0) > 0) {
            logger.info("Game auto scheduler auto-feeding hungry pet", { accountId: account.id });
            await runAccountPetDaily(account.id);
            await delay(3000);
          }
          // 2. Pet Treasure Hunt Claim
          if (summary.pet && summary.pet.treasureHuntStatus === 2) {
            logger.info("Game auto scheduler claiming pet treasure hunt and restarting", { accountId: account.id });
            await runAccountPetDaily(account.id);
            await delay(3000);
          }
          // 3. Knife Box Open
          if (summary.knife && summary.knife.canOpenTreasureBox) {
            logger.info("Game auto scheduler opening knife treasure box", { accountId: account.id });
            await runAccountKnifeDaily(account.id);
            await delay(3000);
          }
          // 4. Fruit Harvest
          if (summary.fruit?.plantFruitList?.some((f) => f.completionRate >= 1.0)) {
            logger.info("Game auto scheduler harvesting mature fruit", { accountId: account.id });
            await runAccountFruitDaily(account.id);
            await delay(3000);
          }
        } catch {
          // ignore single account cooldown poll error
        }

        await delay(2000);
      }
    } finally {
      this.isRunning = false;
    }

    return GAME_SCHEDULER_CYCLE_DELAY_MS;
  }
}

export const gameAutoSchedulerService = new GameAutoSchedulerService();