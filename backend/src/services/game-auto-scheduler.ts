import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";
import { BackgroundLoop } from "./background-loop.js";
import {
  getAccountGameSummary,
  randomDelay,
  climbMathGameRank,
  autoRedeemMathPoints,
  runAccountAllDaily,
  runAccountFruitDaily,
  runAccountKnifeDaily,
  runAccountPetDaily,
  runAccountMathDaily,
  runAccountMemberDaily,
  loadMathDailyState,
  runAccountFreeCreditsDaily
} from "./dingtone/game-service.js";
import { getSettingsMap } from "./settings.service.js";
import { checkAndAutoRedeemAmazonGiftCard } from "./point-store.js";

export const GAME_SCHEDULER_CYCLE_DELAY_MS = 10 * 60_000; // 10 minutes
export const NIGHT_CYCLE_DELAY_MS = 20 * 60_000; // 20 minutes in night

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))
  ]);
}

export function getCstTime(date = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateStr: string;
} {
  // China Standard Time is UTC+8
  const cst = new Date(date.getTime() + 8 * 3600_000);
  const year = cst.getUTCFullYear();
  const month = cst.getUTCMonth() + 1;
  const day = cst.getUTCDate();
  const hour = cst.getUTCHours();
  const minute = cst.getUTCMinutes();
  const second = cst.getUTCSeconds();
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, hour, minute, second, dateStr };
}

function isNightQuietHours(date = new Date()): boolean {
  const { hour } = getCstTime(date);
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
  return getCstTime(date).dateStr;
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
  private currentRunningAccountId: number | null = null;
  private currentTaskName: string | null = null;
  private lastCycleAt: Date | null = null;
  private nextWakeUpTime: number = Date.now() + 30_000;

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
    this.nextWakeUpTime = Date.now() + 30_000;
    this.loop.start();
    logger.info("Game auto scheduler service started");
  }

  stop() {
    return this.loop.stop();
  }

  getStatus() {
    const now = new Date();
    const cst = getCstTime(now);
    const completedTodayCount = Array.from(this.accountDailyCompletedDates.values()).filter((d) => d === cst.dateStr).length;
    const safeNextTime = Math.max(this.nextWakeUpTime, now.getTime() + 5_000);
    return {
      running: this.isRunning,
      currentAccountId: this.currentRunningAccountId,
      currentTask: this.currentTaskName,
      isNightQuiet: isNightQuietHours(now),
      cstTime: `${cst.dateStr} ${String(cst.hour).padStart(2, "0")}:${String(cst.minute).padStart(2, "0")}:${String(cst.second).padStart(2, "0")}`,
      lastCycleAt: this.lastCycleAt?.toISOString() ?? null,
      nextCycleAt: new Date(safeNextTime).toISOString(),
      completedTodayCount
    };
  }

  async runCycle(now = new Date()): Promise<number> {
    const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
    if (!parseBooleanSetting(settings.game_auto_scheduler_enabled, true)) {
      this.nextWakeUpTime = Date.now() + GAME_SCHEDULER_CYCLE_DELAY_MS;
      return GAME_SCHEDULER_CYCLE_DELAY_MS;
    }

    // Skip during midnight quiet hours (0:00 - 7:00)
    if (isNightQuietHours(now)) {
      this.nextWakeUpTime = Date.now() + NIGHT_CYCLE_DELAY_MS;
      return NIGHT_CYCLE_DELAY_MS;
    }

    if (this.isRunning) {
      return GAME_SCHEDULER_CYCLE_DELAY_MS;
    }

    this.isRunning = true;
    this.lastCycleAt = now;
    const cst = getCstTime(now);
    const dateStr = cst.dateStr;
    const currentHour = cst.hour;
    const currentMinute = cst.minute;

    try {
      const accounts = await prisma.dtAccount.findMany({
        where: { dtUserId: { not: null } },
        select: { id: true, nickname: true, email: true, phone: true, dtUserId: true }
      });

      for (const account of accounts) {
        this.currentRunningAccountId = account.id;
        const accountLabel = account.nickname?.trim() || account.email?.trim() || account.phone?.trim() || `账户 #${account.id}`;
        const lastCompleted = this.accountDailyCompletedDates.get(account.id);
        const { hour: targetHour, minute: targetMinute } = getAccountScheduledDailyTime(account.id, dateStr);

        // Tier 1: Check if main daily tasks should run for this account today
        const shouldRunMainDaily =
          lastCompleted !== dateStr &&
          (currentHour >= 12 || currentHour > targetHour || (currentHour === targetHour && currentMinute >= targetMinute));

        if (shouldRunMainDaily) {
          this.currentTaskName = `执行主干日常 (${accountLabel})`;
          logger.info("Game auto scheduler running daily tasks for account", {
            accountId: account.id,
            accountLabel,
            targetTime: `${targetHour}:${targetMinute}`
          });
          try {
            await withTimeout(runAccountAllDaily(account.id), 120_000, null);
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
          this.currentTaskName = `10分钟机会消化 (${accountLabel})`;
          const summary = await withTimeout(getAccountGameSummary(account.id), 25_000, null);
          if (!summary) continue;

          // 1. 算术不等式: 消耗做题机会、世界前十冲榜与积分兑换
          if (summary.mathGame) {
            if ((summary.mathGame.chanceLeft ?? 0) > 0 || (summary.mathGame.watchAdsAddChanceFrequency ?? 0) > 0) {
              logger.info("Game auto scheduler consuming math game chances", {
                accountId: account.id,
                chanceLeft: summary.mathGame.chanceLeft
              });
              await withTimeout(runAccountMathDaily(account.id), 60_000, false);
              await randomDelay(2000, 5000);
            } else {
              const rank = summary.mathGame.ranking ?? -1;
              if (rank <= 0 || rank > 10) {
                logger.info("Game auto scheduler auto climbing math rank into top 10", {
                  accountId: account.id,
                  currentRank: rank
                });
                await withTimeout(climbMathGameRank(account.id), 60_000, null);
                await randomDelay(2000, 5000);
              }
            }
            await autoRedeemMathPoints(account.id, summary).catch(() => null);
          }

          // 2. 飞刀国王: 开箱，投掷全部剩余飞刀并抽奖翻倍
          if (summary.knife) {
            if (summary.knife.canOpenTreasureBox) {
              logger.info("Game auto scheduler opening knife treasure box", { accountId: account.id });
              await withTimeout(runAccountKnifeDaily(account.id), 40_000, false);
              await randomDelay(2000, 5000);
            } else if (
              (summary.knife.remainPlayTimes ?? 0) > 0 ||
              summary.knife.watchingGetPlayTimes < summary.knife.watchingGetPlayTimesLimit
            ) {
              logger.info("Game auto scheduler running knife play chances", {
                accountId: account.id,
                remainPlayTimes: summary.knife.remainPlayTimes
              });
              await withTimeout(runAccountKnifeDaily(account.id), 60_000, false);
              await randomDelay(2000, 5000);
            }
          }

          // 3. 会员好运与签到: 抽奖机会立即抽完，签到领奖
          if (summary.member) {
            const dailyState = loadMathDailyState(account.id);
            // 严格防重：每天只调度执行一次好运转盘看广告与抽奖
            const canDoRoulette = !dailyState.rouletteAddsCompleted;
            const canDoCheckin = summary.member.validTimes > 0 || summary.member.addTimes < summary.member.maxAddTimes;
            if (canDoRoulette || canDoCheckin) {
              logger.info("Game auto scheduler running member roulette and checkin", { accountId: account.id });
              await withTimeout(runAccountMemberDaily(account.id), 30_000, false);
              await randomDelay(2000, 5000);
            }
          }

          // 4. 萌宠工坊: 饥饿投喂、寻宝双倍领奖、玩耍与转盘
          if (summary.pet) {
            const hasPetTasks = summary.pet.tasks?.some((t) => !t.isFinished);
            const canFeed = summary.pet.nextFeedRemainingTime === 0 && (summary.pet.fishNum ?? 0) > 0;
            const canHunt = summary.pet.treasureHuntStatus === 2 || summary.pet.treasureHuntStatus === 0;
            const hasChances = (summary.pet.lotteryLeftChance ?? 0) > 0 || (summary.pet.playLeftChance ?? 0) > 0;

            if (canFeed || canHunt || hasChances || hasPetTasks) {
              logger.info("Game auto scheduler running pet daily/chances/tasks", {
                accountId: account.id,
                canFeed,
                canHunt,
                hasChances,
                hasPetTasks
              });
              await withTimeout(runAccountPetDaily(account.id), 40_000, false);
              await randomDelay(2000, 5000);
            }
          }

          // 5. 每日果园: 成熟自动收获、未达上限自动浇水
          if (summary.fruit) {
            const isMature = summary.fruit.plantFruitList?.some((f) => (f.completionRate ?? 0) >= 1.0);
            const canWater = !summary.fruit.isDailyWaterLimitReached && (summary.fruit.nutritiveNumber ?? 0) >= 10;
            const hasFruitTasks = summary.fruit.tasks?.some((t) => !t.isFinished);

            if (isMature || canWater || hasFruitTasks) {
              logger.info("Game auto scheduler running fruit harvest/watering/tasks", {
                accountId: account.id,
                isMature,
                canWater,
                hasFruitTasks
              });
              await withTimeout(runAccountFruitDaily(account.id), 40_000, false);
              await randomDelay(2000, 5000);
            }
          }

          // 6. 自动兑换指定积分商品检测
          await withTimeout(checkAndAutoRedeemAmazonGiftCard(account.id), 20_000, null).catch(() => null);

          // 7. 免费币每日签到与幸运测试 (若今天未完成)
          if (account.dtUserId) {
            await withTimeout(runAccountFreeCreditsDaily(account.id), 20_000, { totalCreditsWon: 0 }).catch(() => null);
          }
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
      this.currentRunningAccountId = null;
      this.currentTaskName = null;
    }

    const nextDelay = isNightQuietHours(new Date()) ? NIGHT_CYCLE_DELAY_MS : GAME_SCHEDULER_CYCLE_DELAY_MS;
    this.nextWakeUpTime = Date.now() + nextDelay;
    return nextDelay;
  }
}

export const gameAutoSchedulerService = new GameAutoSchedulerService();
