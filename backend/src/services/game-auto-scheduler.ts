import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";
import { BackgroundLoop } from "./background-loop.js";
import {
  getAccountGameSummary,
  randomDelay,
  runAccountAllDaily,
  runAccountFruitDaily,
  runAccountKnifeDaily,
  runAccountPetDaily,
  runAccountMathDaily,
  runAccountMemberDaily
} from "./dingtone/game-service.js";
import { getSettingsMap } from "./settings.service.js";
import { checkAndAutoRedeemAmazonGiftCard } from "./point-store.js";

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
  const hour = 7 + (positive % 5); // 7:00 到 11:30 上午做完全部日常
  const minute = (positive >> 4) % 60; // 0 to 59
  return { hour, minute };
}

export class GameAutoSchedulerService {
  private readonly accountDailyCompletedDates = new Map<number, string>();
  private isRunning = false;
  private lastCycleAt: Date | null = null;
  private nextCycleAt: Date | null = null;

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
    const lastCycle = this.lastCycleAt;
    const nextCycleAt = lastCycle
      ? new Date(lastCycle.getTime() + (isNightQuietHours(now) ? NIGHT_CYCLE_DELAY_MS : GAME_SCHEDULER_CYCLE_DELAY_MS)).toISOString()
      : new Date(now.getTime() + GAME_SCHEDULER_CYCLE_DELAY_MS).toISOString();
    return {
      running: this.isRunning,
      isNightQuiet: isNightQuietHours(now),
      lastCycleAt: this.lastCycleAt?.toISOString() ?? null,
      nextCycleAt,
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
          (currentHour >= 12 || currentHour > targetHour || (currentHour === targetHour && currentMinute >= targetMinute));

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
                    const waitMs = await randomDelay(30_000, 90_000); // Random 30~90s human-like spacing between accounts
          logger.info("Game auto scheduler waiting randomly between accounts", {
            accountId: account.id,
            waitSeconds: Math.round(waitMs / 1000)
          });
          continue;
        }

        // Tier 2: 全天 10 分钟机会补漏与冷却消化池
        try {
          const summary = await getAccountGameSummary(account.id);

          // 1. 算术不等式: 检测到有剩余机会或广告机会，立即答题做完翻倍
          if (summary.mathGame && ((summary.mathGame.chanceLeft ?? 0) > 0 || (summary.mathGame.watchAdsAddChanceFrequency ?? 0) > 0)) {
            logger.info("Game auto scheduler consuming math game chances and climbing rank", {
              accountId: account.id,
              chanceLeft: summary.mathGame.chanceLeft
            });
            await runAccountMathDaily(account.id);
            await randomDelay(2000, 5000);
          }

          // 2. 飞刀国王: 开箱，投掷全部剩余飞刀并抽奖翻倍
          if (summary.knife) {
            if (summary.knife.canOpenTreasureBox) {
              logger.info("Game auto scheduler opening knife treasure box", { accountId: account.id });
              await runAccountKnifeDaily(account.id);
              await randomDelay(2000, 5000);
            } else if (
              (summary.knife.remainPlayTimes ?? 0) > 0 ||
              summary.knife.watchingGetPlayTimes < summary.knife.watchingGetPlayTimesLimit
            ) {
              logger.info("Game auto scheduler running knife play chances", {
                accountId: account.id,
                remainPlayTimes: summary.knife.remainPlayTimes
              });
              await runAccountKnifeDaily(account.id);
              await randomDelay(2000, 5000);
            }
          }

          // 3. 会员好运与签到: 抽奖机会立即抽完，签到领奖
          if (summary.member) {
            if (
              summary.member.adRouletteRemainTimes > 0 ||
              summary.member.validTimes > 0 ||
              summary.member.addTimes < summary.member.maxAddTimes
            ) {
              logger.info("Game auto scheduler running member roulette and checkin", { accountId: account.id });
              await runAccountMemberDaily(account.id);
              await randomDelay(2000, 5000);
            }
          }

          // 4. 萌宠工坊: 饥饿投喂、寻宝双倍领奖、玩耍与转盘
          if (summary.pet) {
            if (summary.pet.nextFeedRemainingTime === 0 && (summary.pet.fishNum ?? 0) > 0) {
              logger.info("Game auto scheduler auto-feeding hungry pet", { accountId: account.id });
              await runAccountPetDaily(account.id);
              await randomDelay(2000, 5000);
            } else if (summary.pet.treasureHuntStatus === 2) {
              logger.info("Game auto scheduler claiming pet treasure hunt and restarting", { accountId: account.id });
              await runAccountPetDaily(account.id);
              await randomDelay(2000, 5000);
            } else if (summary.pet.lotteryLeftChance > 0 || summary.pet.playLeftChance > 0) {
              logger.info("Game auto scheduler using pet lottery or play chances", { accountId: account.id });
              await runAccountPetDaily(account.id);
              await randomDelay(2000, 5000);
            }
          }

          // 5. 每日果园: 成熟自动收获、未达上限自动浇水
          if (summary.fruit) {
            if (summary.fruit.plantFruitList?.some((f) => (f.completionRate ?? 0) >= 1.0)) {
              logger.info("Game auto scheduler harvesting mature fruit", { accountId: account.id });
              await runAccountFruitDaily(account.id);
              await randomDelay(2000, 5000);
            } else if (!summary.fruit.isDailyWaterLimitReached && (summary.fruit.nutritiveNumber ?? 0) >= 10) {
              logger.info("Game auto scheduler auto-watering fruit tree", { accountId: account.id });
              await runAccountFruitDaily(account.id);
              await randomDelay(2000, 5000);
            }
          }

          // 6. 自动兑换指定积分商品检测
          await checkAndAutoRedeemAmazonGiftCard(account.id).catch(() => null);
        } catch (err) {
          logger.warn("Tier 2 opportunistic task error", {
            accountId: account.id,
            error: err instanceof Error ? err.message : String(err)
          });
        }
        await delay(2000);
      }
    } finally {
      this.isRunning = false;
    }

    const nextDelay = isNightQuietHours(new Date()) ? NIGHT_CYCLE_DELAY_MS : GAME_SCHEDULER_CYCLE_DELAY_MS;
    this.nextCycleAt = new Date(Date.now() + nextDelay);
    return nextDelay;
  }
}

export const gameAutoSchedulerService = new GameAutoSchedulerService();