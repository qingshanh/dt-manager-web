import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { fetchPublicJson } from "../public-account-enrichment.js";

const POINT_API_BASE = "https://dt-apigatewayv2.dt-pn1.com";
const MATH_WSS_URL = "wss://d15wptekiod8mq.cloudfront.net/ws";
const MATH_SALT = "8TB{9Iz7";
const KNIFE_SALT = "horace-allin";

const DEFAULT_HEADERS = {
  accept: "application/json, text/plain, */*",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 13; M2012K11AC Build/TKQ1.220829.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36 TengZhan/3"
};

export interface FruitHarvestRecord {
  accountId: number;
  fruitId: number;
  fruitName: string;
  creditsWon: number;
  harvestedAt: string;
}

export interface TaskItemProgress {
  taskType: number;
  taskName: string;
  completed: number;
  total: number;
  rewardDesc?: string;
  isFinished: boolean;
}

export interface RankLeaderboardItem {
  ranking: number;
  nickname: string;
  countryName: string;
  bestScore: number;
  uid: string;
  seasonId?: number;
}

export interface AccountGameSummary {
  accountId: number;
  dtUserId: string | null;
  appVariant: string;
  appType: number;
  gameAppId: number;
  creditExpiry?: {
    expireCredit: number;
    expireDate: string | null;
  } | null;
  pet?: {
    petId: number | null;
    petName: string | null;
    petLevel: number | null;
    fishNum: number | null;
    growthValue: number | null;
    nextLevelRequiredGrowthValue: number | null;
    growthRate: number;
    nextFeedRemainingTime: number | null;
    treasureHuntStatus: number | null;
    treasureHuntEndRemainingTime: number | null;
    nextTreasureHuntRemainingTime: number | null;
    lotteryLeftChance: number;
    playLeftChance: number;
    tasks: TaskItemProgress[];
  } | null;
  fruit?: {
    nutritiveNumber: number | null;
    plantFruitList: Array<{
      fruitId: number;
      name: string;
      completionRate: number;
      type: number;
    }>;
    tasks: TaskItemProgress[];
    harvestHistory: FruitHarvestRecord[];
  } | null;
  knife?: {
    remainPlayTimes: number;
    fruitJuiceAmount: number;
    watchingGetPlayTimes: number;
    watchingGetPlayTimesLimit: number;
    treasureBoxOwned: boolean;
    treasureBoxOpenTime: number | null;
    canOpenTreasureBox: boolean;
  } | null;
  mathGame?: {
    uid: string | null;
    validPoint: number | null;
    expirePoint: number | null;
    chanceLeft: number | null;
    watchAdsAddChanceFrequency: number | null;
    record: number | null;
    shortUuid: string | null;
    redeemProducts: Array<{
      productId: number;
      productName: string;
      price: number;
      stock: number;
    }>;
    shareBoostToday?: {
      count: number;
      isMaxReached: boolean;
    };
    redeemedTodayProductIds?: number[];
  } | null;
  member?: {
    validTimes: number;
    addTimes: number;
    maxAddTimes: number;
    adRouletteRemainTimes: number;
    adRouletteAddedTimes: number;
    lastReward: string | null;
    history: MemberRewardRecord[];
  } | null;
}

export interface GameTaskLog {
  time: string;
  module: "pet" | "fruit" | "knife" | "math" | "checkin" | "system";
  level: "info" | "success" | "warn" | "error";
  message: string;
}

export interface GameExecutionResult {
  accountId: number;
  success: boolean;
  logs: GameTaskLog[];
}

function md5WithSalt(str: string, salt: string) {
  const first = crypto.createHash("md5").update(str, "utf8").digest("hex");
  return crypto.createHash("md5").update(first + salt, "utf8").digest("hex");
}

function md5Direct(str: string) {
  return crypto.createHash("md5").update(str, "utf8").digest("hex");
}

export function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay(minMs: number, maxMs: number): Promise<number> {
  const ms = randomBetween(minMs, maxMs);
  return new Promise((resolve) => setTimeout(() => resolve(ms), ms));
}

function formatLog(module: GameTaskLog["module"], level: GameTaskLog["level"], message: string): GameTaskLog {
  return {
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    module,
    level,
    message
  };
}

async function requestGameJson(path: string, options: { timeoutMs?: number } = {}) {
  const url = path.startsWith("http") ? path : `${POINT_API_BASE}${path}`;
  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
  });
  if (!response.ok) {
    throw new Error(`Game request failed: ${response.status} ${path}`);
  }
  return (await response.json()) as Record<string, any>;
}

export async function resolveAccountContext(accountId: number) {
  const account = await prisma.dtAccount.findUnique({
    where: { id: accountId },
    include: { snapshot: true }
  });
  if (!account) {
    throw new AppError("Account not found", 404, 404);
  }
  const dtUserId = account.dtUserId;
  const appType = account.appVariant === "dingdong" ? 0 : 3;
  const gameAppId = account.appVariant === "dingdong" ? 66 : 67;
  const dingtoneId = account.snapshot?.dtDingtoneId || "196252944";

  // Parse pointUid from snapshot rawJson if available
  let pointUid: string | null = null;
  if (account.snapshot?.rawJson) {
    try {
      const parsed = JSON.parse(account.snapshot.rawJson);
      pointUid = parsed?.point?.uid || parsed?.publicPoint?.uid || parsed?.pointExtras?.pointUid || null;
    } catch {
      // ignore
    }
  }

  return {
    account,
    dtUserId,
    appType,
    gameAppId,
    dingtoneId,
    pointUid
  };
}

export async function getAccountGameSummary(accountId: number): Promise<AccountGameSummary> {
  const ctx = await resolveAccountContext(accountId);
  if (!ctx.dtUserId) {
    return {
      accountId,
      dtUserId: null,
      appVariant: ctx.account.appVariant,
      appType: ctx.appType,
      gameAppId: ctx.gameAppId,
      creditExpiry: null,
      pet: null,
      fruit: null,
      knife: null,
      mathGame: null
    };
  }

  const timestamp = Date.now();

  const [petRes, fruitRes, knifeRes, gameRes, petTaskRes, fruitTaskRes] = await Promise.all([
    requestGameJson(`/pet/homePage?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${timestamp}`).catch(() => null),
    requestGameJson(
      `/campaign/fruit/homepage?userId=${ctx.dtUserId}&appType=${ctx.appType}&dingtoneId=${ctx.dingtoneId}&campaignId=10094&zone=GMT%2B8&timeStamp=${timestamp}`
    ).catch(() => null),
    requestGameJson(`/knife/homePage?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${timestamp}`).catch(() => null),
    requestGameJson(`/game/homePage?userId=${ctx.dtUserId}&appId=${ctx.gameAppId}&zone=-800&timeStamp=${timestamp}`).catch(() => null),
    requestGameJson(`/pet/task/list?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${timestamp}`).catch(() => null),
    requestGameJson(`/campaign/fruit/task/list?userId=${ctx.dtUserId}&campaignId=10094&timeStamp=${timestamp}`).catch(() => null)
  ]);

  // Credit Expiration
  let creditExpiry: AccountGameSummary["creditExpiry"] = null;
  if (ctx.pointUid) {
    try {
      const infoRes = await requestGameJson(`/point/userinfo?uid=${encodeURIComponent(ctx.pointUid)}&zone=800`);
      if (infoRes?.Result === 1 && infoRes.data) {
        creditExpiry = {
          expireCredit: Number(infoRes.data.expirePoint) || 0,
          expireDate: infoRes.data.expireTime ? String(infoRes.data.expireTime) : null
        };
      }
    } catch {
      // ignore
    }
  }

  // Pet
  let petData: AccountGameSummary["pet"] = null;
  if (petRes?.Result === 1 && petRes.data) {
    const p = petRes.data;
    const gCur = p.growthValue ?? 0;
    const gNext = p.nextLevelRequiredGrowthValue ?? 1;
    const growthRate = gCur + gNext > 0 ? Math.round((gCur / (gCur + gNext)) * 100) / 100 : 0;

    const petTasks: TaskItemProgress[] = [];
    if (petTaskRes?.Result === 1 && Array.isArray(petTaskRes.data?.tasks)) {
      for (const t of petTaskRes.data.tasks) {
        petTasks.push({
          taskType: t.taskType,
          taskName: t.taskName === "Daily Check-in" ? "每日签到" : t.taskName === "Watch Video" ? "看视频得鱼粮" : t.taskName === "visit friend's cat pet" ? "拜访好友宠物" : t.taskName,
          completed: t.taskCompletedNum ?? 0,
          total: t.taskUpperLimit ?? 1,
          rewardDesc: t.taskRewardDesc,
          isFinished: t.taskStatus === 3
        });
      }
    }

    let lotteryLeft = 0;
    let playLeft = 0;
    try {
      const lotPage = await requestGameJson(`/pet/lotteryPage?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`);
      lotteryLeft = lotPage?.data?.lotteryLeftChance ?? 0;
      const plPage = await requestGameJson(`/pet/playPage?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`);
      playLeft = plPage?.data?.playLeftChance ?? 0;
    } catch {
      // ignore
    }

    petData = {
      petId: p.petId ?? null,
      petName: p.petName ?? null,
      petLevel: p.petLevel ?? null,
      fishNum: p.fishNum ?? null,
      growthValue: gCur,
      nextLevelRequiredGrowthValue: gNext,
      growthRate,
      nextFeedRemainingTime: p.nextFeedRemainingTime ?? null,
      treasureHuntStatus: p.treasureHuntStatus ?? null,
      treasureHuntEndRemainingTime: p.treasureHuntEndRemainingTime ?? null,
      nextTreasureHuntRemainingTime: p.nextTreasureHuntRemainingTime ?? null,
      lotteryLeftChance: lotteryLeft,
      playLeftChance: playLeft,
      tasks: petTasks
    };
  }

  // Fruit
  let fruitData: AccountGameSummary["fruit"] = null;
  if (fruitRes?.Result === 1 && fruitRes.data) {
    const fruitTasks: TaskItemProgress[] = [];
    if (fruitTaskRes?.Result === 1 && Array.isArray(fruitTaskRes.data?.tasks)) {
      for (const t of fruitTaskRes.data.tasks) {
        fruitTasks.push({
          taskType: t.taskType,
          taskName: t.taskName === "Daily Check-in" ? "每日签到领水滴" : t.taskName === "Feed the cat" ? "投喂猫咪领水滴" : t.taskName.includes("Watch Video") ? "看视频得水滴" : t.taskName.includes("friends") ? "求助好友领水滴" : t.taskName,
          completed: t.taskCompletedNum ?? 0,
          total: t.taskUpperLimit ?? 1,
          rewardDesc: t.taskRewardDesc,
          isFinished: t.taskStatus === 1
        });
      }
    }

    fruitData = {
      nutritiveNumber: fruitRes.data.nutritiveNumber ?? 0,
      plantFruitList: Array.isArray(fruitRes.data.plantFruitList)
        ? fruitRes.data.plantFruitList.map((f: any) => ({
            fruitId: f.fruitId,
            name: f.name,
            completionRate: f.completionRate ?? 0,
            type: f.type ?? 1
          }))
        : [],
      tasks: fruitTasks,
      harvestHistory: loadFruitHarvestHistory(accountId)
    };
  }

  // Knife
  let knifeData: AccountGameSummary["knife"] = null;
  if (knifeRes?.Result === 1 && knifeRes.data) {
    const k = knifeRes.data;
    const canOpenBox = Boolean(k.treasureBoxOwned && k.treasureBoxOpenTime && k.treasureBoxOpenTime <= Date.now());
    knifeData = {
      remainPlayTimes: k.remainPlayTimes ?? 0,
      fruitJuiceAmount: k.fruitJuiceAmount ?? 0,
      watchingGetPlayTimes: k.watchingGetPlayTimes ?? 0,
      watchingGetPlayTimesLimit: k.watchingGetPlayTimesLimit ?? 15,
      treasureBoxOwned: Boolean(k.treasureBoxOwned),
      treasureBoxOpenTime: k.treasureBoxOpenTime ?? null,
      canOpenTreasureBox: canOpenBox
    };
  }

  // Math Game
  let mathGameData: AccountGameSummary["mathGame"] = null;
  if (gameRes?.Result === 1 && gameRes.data) {
    const gameUid = gameRes.data.uid || null;
    let shortUuid: string | null = null;
    const redeemProducts: Array<{ productId: number; productName: string; price: number; stock: number }> = [];

    if (gameUid) {
      try {
        const [uuidRes, redeemRes] = await Promise.all([
          requestGameJson(`/game/generateShortUuid?uid=${gameUid}&timeStamp=${Date.now()}`).catch(() => null),
          requestGameJson(`/game/point/redeemInfo?uid=${gameUid}&timeStamp=${Date.now()}`).catch(() => null)
        ]);
        if (uuidRes?.Result === 1) {
          shortUuid = uuidRes.data;
        }
        if (redeemRes?.Result === 1 && Array.isArray(redeemRes.data?.products)) {
          for (const item of redeemRes.data.products) {
            redeemProducts.push({
              productId: item.productId,
              productName: item.productName,
              price: item.price,
              stock: item.convertibleNum ?? 0
            });
          }
        }
      } catch {
        // ignore
      }
    }

    const mathDaily = loadMathDailyState(accountId);
    mathGameData = {
      uid: gameUid,
      validPoint: gameRes.data.validPoint ?? 0,
      expirePoint: gameRes.data.expirePoint ?? 0,
      chanceLeft: gameRes.data.chanceLeft ?? 0,
      watchAdsAddChanceFrequency: gameRes.data.watchAdsAddChanceFrequency ?? 0,
      record: gameRes.data.record ?? null,
      shortUuid,
      redeemProducts,
      shareBoostToday: {
        count: mathDaily.shareBoostCount,
        isMaxReached: mathDaily.isShareBoostMaxReached
      },
      redeemedTodayProductIds: mathDaily.redeemedProductIds
    };
  }

  // Member
  let memberData: AccountGameSummary["member"] = null;
  const memberHistory = loadMemberRewardHistory(accountId);
  let validTimes = 0;
  let addTimes = 0;
  let maxAddTimes = 1;

  if (ctx.pointUid) {
    try {
      const timesRes = await requestGameJson(`/point/checkin/times?uid=${ctx.pointUid}`).catch(() => null);
      if (timesRes?.Result === 1 && timesRes.data) {
        validTimes = timesRes.data.validTimes ?? 0;
        addTimes = timesRes.data.addTimes ?? 0;
        maxAddTimes = timesRes.data.maxAddTimes ?? 1;
      }
    } catch {
      // ignore
    }
  }

  memberData = {
    validTimes,
    addTimes,
    maxAddTimes,
    adRouletteRemainTimes: 0,
    adRouletteAddedTimes: 0,
    lastReward: memberHistory[0]?.prizeName ?? null,
    history: memberHistory
  };

  return {
    accountId,
    dtUserId: ctx.dtUserId,
    appVariant: ctx.account.appVariant,
    appType: ctx.appType,
    gameAppId: ctx.gameAppId,
    creditExpiry,
    pet: petData,
    fruit: fruitData,
    knife: knifeData,
    mathGame: mathGameData,
    member: memberData
  };
}

export async function runAccountPetDaily(accountId: number, logs: GameTaskLog[] = []): Promise<boolean> {
  const ctx = await resolveAccountContext(accountId);
  if (!ctx.dtUserId) {
    logs.push(formatLog("pet", "warn", "账户尚未激活或缺少 dtUserId，跳过宠物日常"));
    return false;
  }

  try {
    const home = await requestGameJson(`/pet/homePage?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`);
    if (home?.Result !== 1 || !home.data) {
      logs.push(formatLog("pet", "error", `获取宠物主页失败: ${home?.Reason || "未知错误"}`));
      return false;
    }
    const data = home.data;
    logs.push(
      formatLog(
        "pet",
        "info",
        `🐱 宠物【${data.petName || "小猫"}】Lv${data.petLevel} (ID: ${data.petId || "-"})，鱼粮: ${data.fishNum}g`
      )
    );

    // 1. 喂食
    if (data.nextFeedRemainingTime === 0 && data.fishNum > 0) {
      for (const amount of [50, 10, 5, 2]) {
        if (data.fishNum >= amount) {
          const feedRes = await requestGameJson(
            `/pet/feed?userId=${ctx.dtUserId}&appType=${ctx.appType}&feeFishNum=${amount}&timeStamp=${Date.now()}`
          );
          if (feedRes?.Result === 1) {
            logs.push(formatLog("pet", "success", `成功投喂 ${amount}g 鱼干`));
          } else {
            logs.push(formatLog("pet", "warn", `投喂失败: ${feedRes?.Reason || JSON.stringify(feedRes)}`));
          }
          await delay(1200);
          break;
        }
      }
    } else if (data.nextFeedRemainingTime > 0) {
      const minutes = Math.floor(data.nextFeedRemainingTime / 60);
      logs.push(formatLog("pet", "info", `喂食冷却中，剩余 ${minutes} 分钟`));
    }

    // 2. 寻宝状态处理
    if (data.treasureHuntStatus === 0) {
      const huntRes = await requestGameJson(
        `/pet/treasureHunt?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
      );
      if (huntRes?.Result === 1) {
        logs.push(formatLog("pet", "success", "出发寻宝成功！"));
      }
      await delay(1200);
    } else if (data.treasureHuntStatus === 2) {
      const prizeType = data.treasureHuntRewardCreditNum ? 2 : 1;
      const prizeName = data.treasureHuntRewardCreditNum ? `${data.treasureHuntRewardCreditNum} 币` : `${data.treasureHuntRewardFishNum || 0} 鱼料`;
      const claimRes = await requestGameJson(
        `/pet/morePrize?userId=${ctx.dtUserId}&appType=${ctx.appType}&prizeType=${prizeType}&timeStamp=${Date.now()}`
      );
      if (claimRes?.Result === 1) {
        logs.push(formatLog("pet", "success", `寻宝归来，领奖翻倍成功获得: ${prizeName}`));
      }
      await delay(1200);
      const nextHunt = await requestGameJson(
        `/pet/treasureHunt?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
      ).catch(() => null);
      if (nextHunt?.Result === 1) {
        logs.push(formatLog("pet", "success", "寻宝领奖完毕，已自动开启下一轮寻宝！"));
      }
      await delay(1200);
    }

    // 3. 宠物大转盘抽奖
    const lotteryPage = await requestGameJson(
      `/pet/lotteryPage?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
    );
    if (lotteryPage?.Result === 1 && lotteryPage.data?.lotteryLeftChance > 0) {
      const chances = lotteryPage.data.lotteryLeftChance;
      logs.push(formatLog("pet", "info", `检测到转盘抽奖机会 ${chances} 次，开始抽奖...`));
      for (let i = 0; i < chances; i++) {
        const lotRes = await requestGameJson(
          `/pet/lottery?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
        );
        if (lotRes?.Result === 1 && lotRes.data) {
          logs.push(formatLog("pet", "success", `抽奖获得: 奖品类型 ${lotRes.data.prizeType}，数量 ${lotRes.data.totalPrizeCount}`));
          await delay(1500);
          await requestGameJson(
            `/pet/doublePrize?userId=${ctx.dtUserId}&appType=${ctx.appType}&prizeType=${lotRes.data.prizeType}&totalPrizeCount=${lotRes.data.totalPrizeCount}&timeStamp=${Date.now()}`
          ).catch(() => null);
        }
        await delay(1200);
      }
    }

    // 4. 宠物玩具玩耍
    const playPage = await requestGameJson(
      `/pet/playPage?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
    );
    if (playPage?.Result === 1 && playPage.data?.playLeftChance > 0 && Array.isArray(playPage.data.toys)) {
      let left = playPage.data.playLeftChance;
      for (const toy of playPage.data.toys) {
        if (left <= 0) break;
        if (toy.toyNum > 0) {
          const playRes = await requestGameJson(
            `/pet/play?userId=${ctx.dtUserId}&appType=${ctx.appType}&toyType=${toy.toyType}&timeStamp=${Date.now()}`
          );
          if (playRes?.Result === 1) {
            logs.push(formatLog("pet", "success", `玩耍玩具【${toy.toyName}】成功`));
            left -= 1;
          }
          await delay(1200);
        }
      }
    }

    // 5. 宠物每日任务（包含拜访好友宠物）
    const taskPage = await requestGameJson(
      `/pet/task/list?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
    );
    if (taskPage?.Result === 1 && Array.isArray(taskPage.data?.tasks)) {
      // Collect other accounts' petIds for mutual visiting
      const otherAccounts = await prisma.dtAccount.findMany({
        where: { adminId: ctx.account.adminId, id: { not: accountId } },
        select: { dtUserId: true, appVariant: true }
      });
      const mutualPetIds: number[] = [];
      for (const other of otherAccounts.slice(0, 8)) {
        if (other.dtUserId) {
          const otherAppType = other.appVariant === "dingdong" ? 0 : 3;
          const otherHome = await requestGameJson(
            `/pet/homePage?userId=${other.dtUserId}&appType=${otherAppType}&timeStamp=${Date.now()}`
          ).catch(() => null);
          if (otherHome?.data?.petId) {
            mutualPetIds.push(Number(otherHome.data.petId));
          }
        }
      }
      const fallbackPetIds = [85737, 85719, 85730, 85799, 85763];
      const targetVisitPetIds = Array.from(new Set([...mutualPetIds, ...fallbackPetIds]));

      for (const t of taskPage.data.tasks) {
        if (t.taskStatus === 1 && t.taskType !== 4) {
          const remaining = (t.taskUpperLimit || 1) - (t.taskCompletedNum || 0);
          if (remaining > 0) {
            logs.push(formatLog("pet", "info", `去领取任务奖励: ${t.taskName} (${t.taskCompletedNum}/${t.taskUpperLimit})`));
            if (t.taskType === 3) {
              // Visit pet task
              for (const vId of targetVisitPetIds.slice(0, remaining)) {
                await requestGameJson(
                  `/pet/task/receiveReward?userId=${ctx.dtUserId}&appType=${ctx.appType}&taskType=3&visitPetId=${vId}&timeStamp=${Date.now()}`
                ).catch(() => null);
                await delay(1000);
              }
            } else {
              for (let i = 0; i < remaining; i++) {
                await requestGameJson(
                  `/pet/task/receiveReward?userId=${ctx.dtUserId}&appType=${ctx.appType}&taskType=${t.taskType}&timeStamp=${Date.now()}`
                ).catch(() => null);
                await delay(1000);
              }
            }
          }
        }
      }
    }

    return true;
  } catch (error) {
    logs.push(formatLog("pet", "error", `宠物日常执行异常: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  }
}

export async function runAccountFruitDaily(accountId: number, logs: GameTaskLog[] = []): Promise<boolean> {
  const ctx = await resolveAccountContext(accountId);
  if (!ctx.dtUserId) {
    logs.push(formatLog("fruit", "warn", "账户尚未激活或缺少 dtUserId，跳过果园日常"));
    return false;
  }

  try {
    const home = await requestGameJson(
      `/campaign/fruit/homepage?userId=${ctx.dtUserId}&appType=${ctx.appType}&dingtoneId=${ctx.dingtoneId}&campaignId=10094&zone=GMT%2B8&timeStamp=${Date.now()}`
    );
    if (home?.Result !== 1 || !home.data) {
      logs.push(formatLog("fruit", "error", `获取果园主页失败: ${home?.Reason || "未知错误"}`));
      return false;
    }
    const data = home.data;
    let fruits = Array.isArray(data.plantFruitList) ? data.plantFruitList : [];

    // 1. 如果没有种水果，自动种植苹果树
    if (fruits.length === 0) {
      const plantRes = await requestGameJson(
        `/campaign/fruit/plant?userId=${ctx.dtUserId}&dingtoneId=${ctx.dingtoneId}&fruitType=1&campaignId=10094&appType=${ctx.appType}&zone=GMT%2B8&timeStamp=${Date.now()}`
      );
      if (plantRes?.Result === 1) {
        logs.push(formatLog("fruit", "success", "成功种植苹果树！"));
        const refreshHome = await requestGameJson(
          `/campaign/fruit/homepage?userId=${ctx.dtUserId}&appType=${ctx.appType}&dingtoneId=${ctx.dingtoneId}&campaignId=10094&zone=GMT%2B8&timeStamp=${Date.now()}`
        );
        fruits = refreshHome?.data?.plantFruitList || [];
      }
      await delay(1200);
    }

    // 2. 检查成熟度，100% 则收获
    for (const f of fruits) {
      const rate = Math.round((f.completionRate ?? 0) * 100);
      logs.push(formatLog("fruit", "info", `果树【${f.name || "水果"}】当前成熟度: ${rate}%`));
      if (f.completionRate >= 1.0) {
        const harvest = await requestGameJson(
          `/campaign/fruit/credit/reward?userId=${ctx.dtUserId}&dingtoneId=${ctx.dingtoneId}&campaignId=10094&fruitId=${f.fruitId}&timeStamp=${Date.now()}`
        );
        if (harvest?.Result === 1) {
          const won = Number(harvest.data) || 7;
          logs.push(formatLog("fruit", "success", `🎉 水果成熟收获成功！获得 ${won} 个说道币/叮咚币！`));
          saveFruitHarvestRecord({
            accountId,
            fruitId: f.fruitId,
            fruitName: f.name === "apple" ? "苹果" : f.name,
            creditsWon: won,
            harvestedAt: new Date().toISOString()
          });
        }
        await delay(1200);
      }
    }

    // 3. 做任务领水滴
    const tasks = await requestGameJson(
      `/campaign/fruit/task/list?userId=${ctx.dtUserId}&campaignId=10094&timeStamp=${Date.now()}`
    );
    if (tasks?.Result === 1 && Array.isArray(tasks.data?.tasks)) {
      for (const t of tasks.data.tasks) {
        if (t.taskStatus === 0) {
          const count = (t.taskUpperLimit || 1) - (t.taskCompletedNum || 0);
          for (let i = 0; i < count; i++) {
            const rewardRes = await requestGameJson(
              `/campaign/fruit/mission/reward?userId=${ctx.dtUserId}&campaignId=10094&appType=${ctx.appType}&dingtoneId=${ctx.dingtoneId}&taskType=${t.taskType}&timeStamp=${Date.now()}`
            );
            if (rewardRes?.Result === 1) {
              logs.push(formatLog("fruit", "success", `完成任务【${t.taskName}】，领取水滴 +${rewardRes.data?.reward || ""}`));
            }
            await delay(1200);
          }
        }
      }
    }

    // 4. 浇水
    const reloaded = await requestGameJson(
      `/campaign/fruit/homepage?userId=${ctx.dtUserId}&appType=${ctx.appType}&dingtoneId=${ctx.dingtoneId}&campaignId=10094&zone=GMT%2B8&timeStamp=${Date.now()}`
    );
    if (reloaded?.Result === 1 && reloaded.data) {
      const waterDrops = reloaded.data.nutritiveNumber ?? 0;
      logs.push(formatLog("fruit", "info", `当前拥有水滴: ${waterDrops}`));
      const unharvestedFruit = reloaded.data.plantFruitList?.find((item: any) => item.completionRate < 1);
      if (waterDrops > 0 && unharvestedFruit) {
        const waterRes = await requestGameJson(
          `/campaign/fruit/warter?userId=${ctx.dtUserId}&campaignId=10094&appType=${ctx.appType}&dingtoneId=${ctx.dingtoneId}&fruitId=${unharvestedFruit.fruitId}&timeStamp=${Date.now()}`
        );
        if (waterRes?.Result === 1) {
          const nextRate = Math.round((waterRes.data?.completionRate ?? 0) * 100);
          logs.push(formatLog("fruit", "success", `浇水成功！果树成熟进度提升至: ${nextRate}%`));
          if (waterRes.data?.completionRate >= 1.0) {
            await requestGameJson(
              `/campaign/fruit/credit/reward?userId=${ctx.dtUserId}&dingtoneId=${ctx.dingtoneId}&campaignId=10094&fruitId=${unharvestedFruit.fruitId}&timeStamp=${Date.now()}`
            ).catch(() => null);
          }
        }
      }
    }

    return true;
  } catch (error) {
    logs.push(formatLog("fruit", "error", `果园日常执行异常: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  }
}

export async function runAccountCheckinDaily(accountId: number, logs: GameTaskLog[] = []): Promise<boolean> {
  const ctx = await resolveAccountContext(accountId);
  if (!ctx.pointUid) {
    logs.push(formatLog("checkin", "info", "未获取到 pointUid，跳过签到与积分转盘"));
    return false;
  }

  try {
    const timesRes = await requestGameJson(`/point/checkin/times?uid=${ctx.pointUid}`);
    if (timesRes?.Result === 1 && timesRes.data) {
      const { validTimes, addTimes, maxAddTimes } = timesRes.data;
      logs.push(formatLog("checkin", "info", `签到状态: 已获取 ${addTimes}/${maxAddTimes} 次，可用 ${validTimes} 次`));
      if (addTimes < maxAddTimes) {
        for (let i = 0; i < maxAddTimes - addTimes; i++) {
          await requestGameJson(`/point/checkin/addtimes?uid=${ctx.pointUid}`).catch(() => null);
          const claim = await requestGameJson(`/point/checkin/reward?uid=${ctx.pointUid}`).catch(() => null);
          if (claim?.Result === 1 && claim.data?.prizeName) {
            logs.push(formatLog("checkin", "success", `签到成功获得: ${claim.data.prizeName}`));
          }
          await delay(1200);
        }
      } else if (validTimes > 0) {
        const claim = await requestGameJson(`/point/checkin/reward?uid=${ctx.pointUid}`).catch(() => null);
        if (claim?.Result === 1 && claim.data?.prizeName) {
          logs.push(formatLog("checkin", "success", `签到抽奖获得: ${claim.data.prizeName}`));
        }
      }
    }
    return true;
  } catch (error) {
    logs.push(formatLog("checkin", "error", `签到执行异常: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  }
}

export async function runAccountAllDaily(accountId: number): Promise<GameExecutionResult> {
  const logs: GameTaskLog[] = [];
  logs.push(formatLog("system", "info", `🚀 开始执行账户 #${accountId} 游戏与福利全自动每日打卡任务`));

  // 1. 萌宠日常
  const petSuccess = await runAccountPetDaily(accountId, logs);
  const waitPet = await randomDelay(4000, 10000);
  logs.push(formatLog("system", "info", `萌宠模块完成，随机等待 ${(waitPet / 1000).toFixed(1)} 秒进入每日果园...`));

  // 2. 果园日常
  const fruitSuccess = await runAccountFruitDaily(accountId, logs);
  const waitFruit = await randomDelay(4000, 10000);
  logs.push(formatLog("system", "info", `果园模块完成，随机等待 ${(waitFruit / 1000).toFixed(1)} 秒进入飞刀国王...`));

  // 3. 飞刀国王日常
  const knifeSuccess = await runAccountKnifeDaily(accountId, logs);
  const waitKnife = await randomDelay(4000, 10000);
  logs.push(formatLog("system", "info", `飞刀模块完成，随机等待 ${(waitKnife / 1000).toFixed(1)} 秒进入会员签到与好运抽奖...`));

  // 4. 会员签到与好运抽奖
  const memberSuccess = await runAccountMemberDaily(accountId, logs);
  const waitMember = await randomDelay(3000, 7000);

  // 5. 积分中心日常
  const checkinSuccess = await runAccountCheckinDaily(accountId, logs);

  // 6. 算术不等式挑战日常 (看广告加次数 -> 代理助力 -> WebSocket自动答题全消耗 -> 世界前十冲榜 -> 自动兑换)
  const mathSuccess = await runAccountMathDaily(accountId, logs);

  // Auto-redeem points if balance >= 1000
  try {
    const summary = await getAccountGameSummary(accountId);
    const validPoint = summary.mathGame?.validPoint ?? 0;
    const gameUid = summary.mathGame?.uid;
    if (gameUid && validPoint >= 1000) {
      const targetProdId = summary.appType === 0 ? (validPoint >= 10000 ? 23 : 22) : (validPoint >= 10000 ? 25 : 24);
      logs.push(formatLog("math", "info", `当前积分 ${validPoint}，尝试自动兑换说道币/叮咚币...`));
      const rRes = await redeemMathGamePoints(accountId, targetProdId).catch(() => null);
      if (rRes?.success) {
        logs.push(formatLog("math", "success", `🎉 ${rRes.message}`));
      } else if (rRes?.message) {
        logs.push(formatLog("math", "info", `自动兑换提示: ${rRes.message}`));
      }
    }
  } catch {
    // ignore
  }

  const overallSuccess = petSuccess || fruitSuccess || knifeSuccess || checkinSuccess || memberSuccess || mathSuccess;
  logs.push(
    formatLog(
      "system",
      overallSuccess ? "success" : "warn",
      `账户 #${accountId} 今日日常任务全部执行完毕！`
    )
  );

  return {
    accountId,
    success: overallSuccess,
    logs
  };
}

export async function runBatchAllAccountsDaily(adminId: number): Promise<{ total: number; results: GameExecutionResult[] }> {
  const accounts = await prisma.dtAccount.findMany({
    where: { adminId },
    select: { id: true }
  });
  const results: GameExecutionResult[] = [];
  for (const acc of accounts) {
    const res = await runAccountAllDaily(acc.id);
    results.push(res);
    await delay(3000); // 3 seconds spacing between accounts to prevent rate limiting
  }
  return { total: accounts.length, results };
}

export const BUILTIN_89IP_PROXY_URL = "https://www.89ip.cn/tqdl.html?num=30&address=&kill_address=&port=&kill_port=&isp=";

export function extractProxiesFromResponse(text: string): Array<{ host: string; port: number; proxy: string }> {
  const list: Array<{ host: string; port: number; proxy: string }> = [];
  const seen = new Set<string>();
  const regex = /(\b(?:\d{1,3}\.){3}\d{1,3}\b):(\d{2,5})/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const host = match[1] || "";
    const port = Number(match[2] || 0);
    if (host.startsWith("127.") || host === "0.0.0.0" || port <= 0 || port > 65535) {
      continue;
    }
    const key = `${host}:${port}`;
    if (!seen.has(key)) {
      seen.add(key);
      list.push({ host, port, proxy: key });
    }
  }
  return list;
}

export async function runAccountShareBoost(accountId: number, maxBoosts = 10): Promise<{ count: number; logs: string[] }> {
  const logs: string[] = [];
  const summary = await getAccountGameSummary(accountId);
  const shortUuid = summary.mathGame?.shortUuid;
  if (!shortUuid) {
    throw new AppError("未获取到当前账号的 shortUuid 推广短链码", 400, 400);
  }

  logs.push(`获取到 shortUuid: ${shortUuid}`);

  // Fetch proxy settings
  const settings = await prisma.setting.findMany({
    where: { key: { in: ["game_proxy_extract_url", "game_proxy_pool_url", "dt_proxy_url"] } }
  });
  const settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const proxyPoolUrl = settingsMap.game_proxy_extract_url?.trim() || settingsMap.game_proxy_pool_url?.trim() || BUILTIN_89IP_PROXY_URL;
  logs.push(`使用代理源: ${proxyPoolUrl.includes("89ip.cn") ? "系统内置 89 免费代理池" : proxyPoolUrl}`);

  let candidates: Array<{ host: string; port: number; proxy: string }> = [];
  try {
    const ipRes = await fetch(proxyPoolUrl, {
      headers: { "User-Agent": DEFAULT_HEADERS["user-agent"] },
      signal: AbortSignal.timeout(8000)
    });
    const ipText = (await ipRes.text()).trim();
    candidates = extractProxiesFromResponse(ipText);
    logs.push(`从代理源成功解析到 ${candidates.length} 个候选代理`);
  } catch (err) {
    logs.push(`提取代理源异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  let successCount = 0;
  if (candidates.length === 0) {
    logs.push("未能获取有效候选代理，尝试使用本机出口 IP 访问一次...");
    try {
      const res = await requestGameJson(`/game/shareAddChance?shortUuid=${encodeURIComponent(shortUuid)}`);
      if (res?.Result === 1) {
        successCount += 1;
        logs.push("通过当前 IP 助力成功 +1 次！");
      } else {
        logs.push(`助力返回: ${res?.Reason || JSON.stringify(res)}`);
      }
    } catch (err) {
      logs.push(`助力请求失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    const targetUrl = `http://dt-apigatewayv2.dt-pn1.com/game/shareAddChance?shortUuid=${encodeURIComponent(shortUuid)}`;
    for (let i = 0; i < candidates.length && successCount < maxBoosts; i++) {
      const candidate = candidates[i];
      if (!candidate) continue;
      try {
        const probe = await testHttpProxyConnection(targetUrl, candidate.host, candidate.port);
        if (probe.status === 200 && probe.body) {
          let json: any = null;
          try {
            json = JSON.parse(probe.body);
          } catch {
            continue;
          }
          if (json?.Result === 1) {
            successCount += 1;
            const boostState = loadMathDailyState(accountId);
            boostState.shareBoostCount += 1;
            saveMathDailyState(boostState);
            logs.push(`通过代理 [${candidate.proxy}] 助力成功 +1 次！(累计: ${successCount})`);
          } else if (json?.Result === 0) {
            logs.push(`代理 [${candidate.proxy}] 助力响应: ${json.Reason}`);
            if (json.Reason?.includes("已达上限")) {
              const boostState = loadMathDailyState(accountId);
              boostState.isShareBoostMaxReached = true;
              saveMathDailyState(boostState);
              logs.push("用户当日分享助力已达系统上限，结束助力");
              break;
            }
          }
        }
        await delay(800);
      } catch {
        // timeout or error, continue to next candidate
      }
    }
  }

  return { count: successCount, logs };
}

export function checkMathEquality(expression: string): number {
  try {
    if (expression.includes("=")) {
      const parts = expression.split("=");
      const left = (parts[0] ?? "").trim();
      const right = (parts[1] ?? "").trim();
      return evalMathNumber(left) === evalMathNumber(right) ? 1 : 0;
    }
    const clean = expression.replace(/[^0-9+\-*/().><=!]/g, "").trim();
    // eslint-disable-next-line no-new-func
    return Function(`"use strict"; return Boolean(${clean})`)() ? 1 : 0;
  } catch {
    return 0;
  }
}

function evalMathNumber(fnStr: string): number {
  const clean = fnStr.replace(/[^0-9+\-*/().]/g, "").trim();
  if (!clean) return 0;
  // eslint-disable-next-line no-new-func
  return Number(Function(`"use strict"; return (${clean})`)());
}

function wsSign(s: string): string {
  const first = crypto.createHash("md5").update(s, "utf8").digest("hex");
  return crypto.createHash("md5").update(first + "8TB{9Iz7", "utf8").digest("hex");
}

export async function playMathGameSession(uid: string): Promise<{ success: boolean; earnedPoints: number; reason?: string }> {
  return new Promise((resolve) => {
    let spendTime = 0;
    let earned = 0;
    const ws = new WebSocket("wss://d15wptekiod8mq.cloudfront.net/ws");

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ success: false, earnedPoints: earned, reason: "WebSocket game timeout" });
    }, 45000);

    ws.onopen = () => {
      const sign = wsSign("action=gameBegin&uid=" + uid);
      ws.send(JSON.stringify({ action: "gameBegin", uid, sign }));
    };

    ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(String(e.data));
        if (msg.Result !== 1) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          return resolve({ success: false, earnedPoints: earned, reason: msg.Reason || "Unknown game error" });
        }
        const data = msg.data;
        if (data.action === "questions") {
          const ans = checkMathEquality(data.question);
          const jitter = Math.random() * 0.35 + 0.3; // 0.3 ~ 0.65s
          spendTime += jitter;
          await delay(jitter * 1000);
          const sign = wsSign(`action=report&answer=${ans}&questionSort=${data.questionSort}&timeOut=0&totalSpendTime=${spendTime.toFixed(2)}&uid=${uid}`);
          ws.send(JSON.stringify({
            timeOut: 0,
            answer: ans,
            totalSpendTime: spendTime.toFixed(2),
            questionSort: data.questionSort,
            action: "report",
            uid,
            sign
          }));
        } else if (data.action === "gameOver") {
          earned = data.earnPoints ?? 100;
          if (data.pointDouble === 1) {
            const doubleSign = wsSign(`action=gameSuccessWatchAdsAddDoublePoint&uid=${uid}`);
            ws.send(JSON.stringify({ action: "gameSuccessWatchAdsAddDoublePoint", uid, sign: doubleSign }));
          } else {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve({ success: true, earnedPoints: earned });
          }
        } else if (data.action === "gameSuccessWatchAdsAddDoublePoint") {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve({ success: true, earnedPoints: earned > 0 ? earned * 2 : 200 });
        }
      } catch {
        // ignore
      }
    };

    ws.onerror = (err: any) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ success: false, earnedPoints: earned, reason: err?.message || "WebSocket error" });
    };
  });
}

export async function playMathChallengeSession(
  uid: string,
  targetScore: number,
  nickname: string
): Promise<{ success: boolean; bestScore: number; ranking?: number; reason?: string }> {
  try {
    await requestGameJson(
      `/game/challenge/info?uid=${encodeURIComponent(uid)}&nickname=${encodeURIComponent(nickname)}&timeStamp=${Date.now()}`
    );
  } catch (err) {
    return { success: false, bestScore: 0, reason: `初始化挑战赛失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  return new Promise((resolve) => {
    let spendTime = 0;
    let questionsAnswered = 0;
    let finalBestScore = 0;
    let finalRanking: number | undefined;
    const ws = new WebSocket("wss://d15wptekiod8mq.cloudfront.net/ws");

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ success: false, bestScore: finalBestScore, reason: "Challenge timeout" });
    }, 120000);

    ws.onopen = () => {
      const sign = wsSign("action=challengeGameBegin&uid=" + uid);
      ws.send(JSON.stringify({ action: "challengeGameBegin", uid, sign }));
    };

    ws.onmessage = async (e) => {
      try {
        const msg = JSON.parse(String(e.data));
        if (msg.Result !== 1) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          return resolve({ success: false, bestScore: finalBestScore, reason: msg.Reason });
        }
        const data = msg.data;
        if (data.action === "challengeReport" || data.action === "questions") {
          questionsAnswered++;
          let ans = checkMathEquality(data.question);
          if (questionsAnswered > targetScore) {
            ans = ans === 1 ? 0 : 1;
          }
          const jitter = Math.random() * 0.2 + 0.15;
          spendTime += jitter;
          await delay(jitter * 1000);
          const sign = wsSign(
            `action=challengeReport&answer=${ans}&questionSort=${data.questionSort}&timeOut=0&totalSpendTime=${spendTime.toFixed(2)}&uid=${uid}`
          );
          ws.send(JSON.stringify({
            timeOut: 0,
            answer: ans,
            totalSpendTime: spendTime.toFixed(2),
            questionSort: data.questionSort,
            action: "challengeReport",
            uid,
            sign
          }));
        } else if (data.action === "chooseWhetherToContinue") {
          const sign = wsSign("action=challengeCancelContinueGame");
          ws.send(JSON.stringify({ action: "challengeCancelContinueGame", sign }));
        } else if (data.action === "gameOver") {
          finalBestScore = data.bestScore ?? questionsAnswered;
          finalRanking = data.latestRanking;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve({ success: true, bestScore: finalBestScore, ranking: finalRanking });
        }
      } catch {
        // ignore
      }
    };

    ws.onerror = (err: any) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ success: false, bestScore: finalBestScore, reason: err?.message || "Challenge WS error" });
    };
  });
}

export async function runAccountMathDaily(accountId: number, logs: GameTaskLog[] = []): Promise<boolean> {
  const summary = await getAccountGameSummary(accountId);
  const math = summary.mathGame;
  const gameUid = math?.uid;
  if (!gameUid) {
    logs.push(formatLog("math", "warn", "未获取到算术游戏 uid，跳过算术日常"));
    return false;
  }

  let success = false;
  logs.push(formatLog("math", "info", `🧮 算术不等式: 当前剩余 ${math.chanceLeft} 次机会，看广告可加 ${math.watchAdsAddChanceFrequency} 次`));

  // 1. 看广告拿满游戏机会
  const adsFreq = math.watchAdsAddChanceFrequency ?? 0;
  if (adsFreq > 0) {
    logs.push(formatLog("math", "info", `看广告获取算术游戏次数 (${adsFreq} 次)...`));
    for (let i = 0; i < adsFreq; i++) {
      const adRes = await requestGameJson(`/game/watchAdsAddChance?uid=${encodeURIComponent(gameUid)}&timeStamp=${Date.now()}`).catch(() => null);
      if (adRes?.Result === 1) {
        logs.push(formatLog("math", "success", `第 ${i + 1} 次看广告增加游戏机会成功`));
        success = true;
      }
      await delay(1200);
    }
  }

  // 2. 自动代理助力 (使用内置 89 免费代理或配置的携趣代理)
  try {
    logs.push(formatLog("math", "info", "执行代理自动助力增加游戏机会..."));
    const boostRes = await runAccountShareBoost(accountId, 8);
    if (boostRes.count > 0) {
      logs.push(formatLog("math", "success", `代理自动助力成功增加 ${boostRes.count} 次游戏机会！`));
      success = true;
    }
  } catch (err) {
    logs.push(formatLog("math", "warn", `代理助力跳过: ${err instanceof Error ? err.message : String(err)}`));
  }

  // 3. 重新获取总剩余游戏次数，并全部通过 WebSocket 玩完做题
  const reloaded = await requestGameJson(
    `/game/homePage?userId=${summary.dtUserId}&appId=${summary.gameAppId}&zone=-800&timeStamp=${Date.now()}`
  ).catch(() => null);
  const totalChances = reloaded?.data?.chanceLeft ?? math.chanceLeft;

  if (totalChances > 0) {
    logs.push(formatLog("math", "info", `开始执行自动答题消耗所有机会，共 ${totalChances} 次机会...`));
    for (let i = 0; i < totalChances; i++) {
      const playRes = await playMathGameSession(gameUid);
      if (playRes.success) {
        logs.push(formatLog("math", "success", `第 ${i + 1} 局答题通关并翻倍！获得 ${playRes.earnedPoints} 积分`));
        success = true;
      } else {
        logs.push(formatLog("math", "warn", `第 ${i + 1} 局答题异常: ${playRes.reason || "未知"}`));
      }
      await delay(1500);
    }
  }

  // 4. 世界排行榜冲榜保障 (冲进前十名)
  try {
    const rankList = await getGameRankList(summary.gameAppId);
    let userRank = 999;
    const userRankRes = await requestGameJson(`/game/rank/user?uid=${encodeURIComponent(gameUid)}&timeStamp=${Date.now()}`).catch(() => null);
    if (userRankRes?.Result === 1 && userRankRes.data?.ranking) {
      userRank = userRankRes.data.ranking;
    }

    if (userRank > 10 && rankList.length > 0) {
      const rank3Score = rankList[2]?.bestScore ?? 420;
      const rank9Score = rankList[8]?.bestScore ?? 370;
      const targetScore = randomBetween(rank9Score + 10, Math.min(rank3Score + 5, rank9Score + 45));
      const nickname = userRankRes?.data?.nickname || summary.appVariant;
      logs.push(formatLog("math", "info", `当前排名 #${userRank}，未进入世界前十，启动冲榜挑战模式 (目标得分: ${targetScore})...`));
      const challengeRes = await playMathChallengeSession(gameUid, targetScore, nickname);
      if (challengeRes.success) {
        logs.push(formatLog("math", "success", `🏆 挑战成功！最终得分: ${challengeRes.bestScore}，成功跻身世界前十！(当前名次: #${challengeRes.ranking ?? "前十"})`));
        success = true;
      } else {
        logs.push(formatLog("math", "warn", `挑战冲榜提示: ${challengeRes.reason || "已提交成绩"}`));
      }
    } else {
      logs.push(formatLog("math", "info", `当前排名 #${userRank}，已稳居世界前十！`));
    }
  } catch (err) {
    logs.push(formatLog("math", "warn", `排位检测跳过: ${err instanceof Error ? err.message : String(err)}`));
  }

  // 5. 自动积分兑换
  try {
    const afterSummary = await getAccountGameSummary(accountId);
    const validPoint = afterSummary.mathGame?.validPoint ?? 0;
    if (validPoint >= 1000) {
      const prodId = summary.appType === 0 ? (validPoint >= 10000 ? 23 : 22) : (validPoint >= 10000 ? 25 : 24);
      const redeemRes = await redeemMathGamePoints(accountId, prodId);
      if (redeemRes.success) {
        logs.push(formatLog("math", "success", `🎉 ${redeemRes.message}`));
      }
    }
  } catch {
    // ignore
  }

  return success;
}

// ── Persistent Fruit Harvest History ──
export interface MemberRewardRecord {
  accountId: number;
  source: 'roulette' | 'checkin';
  sourceName: string;
  prizeName: string;
  receivedAt: string;
}


export interface MathDailyState {
  accountId: number;
  dateStr: string;
  shareBoostCount: number;
  isShareBoostMaxReached: boolean;
  redeemedProductIds: number[];
}

const MATH_STATE_FILE_PATH = path.resolve(process.cwd(), "_tmp/runtime/math_daily_state.json");

function getTodayDateStr(): string {
  return new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }).replace(/\//g, "-");
}

export function loadMathDailyState(accountId: number): MathDailyState {
  const today = getTodayDateStr();
  try {
    ensureHarvestDir();
    if (fs.existsSync(MATH_STATE_FILE_PATH)) {
      const all = JSON.parse(fs.readFileSync(MATH_STATE_FILE_PATH, "utf8")) as Record<string, MathDailyState>;
      const key = `${accountId}:${today}`;
      if (all[key]) {
        return all[key];
      }
    }
  } catch {
    // ignore
  }
  return {
    accountId,
    dateStr: today,
    shareBoostCount: 0,
    isShareBoostMaxReached: false,
    redeemedProductIds: []
  };
}

export function saveMathDailyState(state: MathDailyState) {
  try {
    ensureHarvestDir();
    let all: Record<string, MathDailyState> = {};
    if (fs.existsSync(MATH_STATE_FILE_PATH)) {
      all = JSON.parse(fs.readFileSync(MATH_STATE_FILE_PATH, "utf8"));
    }
    const key = `${state.accountId}:${state.dateStr}`;
    all[key] = state;
    fs.writeFileSync(MATH_STATE_FILE_PATH, JSON.stringify(all, null, 2), "utf8");
  } catch (err) {
    logger.warn("Failed to save math daily state", { error: String(err) });
  }
}

export function formatPrizeName(rawPrize: string): string {
  const clean = rawPrize.trim();
  const MAP: Record<string, string> = {
    "point_system_lucky_reward_0": "谢谢参与 (未中奖)",
    "point_system_lucky_reward_1": "10 会员积分",
    "point_system_lucky_reward_2": "20 会员积分",
    "point_system_lucky_reward_3": "50 会员积分",
    "point_system_lucky_reward_4": "商城通用卡券",
    "point_system_lucky_reward_5": "商城抵扣券 (卡券包)",
    "Thanks!": "谢谢参与 (未中奖)",
    "thanks": "谢谢参与 (未中奖)"
  };
  return MAP[clean] || clean;
}

const MEMBER_REWARDS_FILE_PATH = path.resolve(process.cwd(), "_tmp/runtime/member_rewards.json");

export function loadMemberRewardHistory(accountId?: number): MemberRewardRecord[] {
  try {
    ensureHarvestDir();
    if (!fs.existsSync(MEMBER_REWARDS_FILE_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(MEMBER_REWARDS_FILE_PATH, "utf8");
    const all = JSON.parse(raw) as MemberRewardRecord[];
    if (accountId !== undefined) {
      return all.map(r => ({ ...r, prizeName: formatPrizeName(r.prizeName) })).filter((r) => r.accountId === accountId);
    }
    return all.map(r => ({ ...r, prizeName: formatPrizeName(r.prizeName) }));
  } catch {
    return [];
  }
}

export function saveMemberRewardRecord(record: MemberRewardRecord) {
  try {
    ensureHarvestDir();
    const existing = loadMemberRewardHistory();
    existing.unshift(record);
    fs.writeFileSync(MEMBER_REWARDS_FILE_PATH, JSON.stringify(existing.slice(0, 300), null, 2), "utf8");
  } catch (err) {
    logger.warn("Failed to persist member reward record", { error: String(err) });
  }
}

const HARVEST_FILE_PATH = path.resolve(process.cwd(), "_tmp/runtime/fruit_harvests.json");

function ensureHarvestDir() {
  const dir = path.dirname(HARVEST_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadFruitHarvestHistory(accountId?: number): FruitHarvestRecord[] {
  try {
    ensureHarvestDir();
    if (!fs.existsSync(HARVEST_FILE_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(HARVEST_FILE_PATH, "utf8");
    const all = JSON.parse(raw) as FruitHarvestRecord[];
    if (accountId !== undefined) {
      return all.filter((r) => r.accountId === accountId);
    }
    return all;
  } catch {
    return [];
  }
}

export function saveFruitHarvestRecord(record: FruitHarvestRecord) {
  try {
    ensureHarvestDir();
    const existing = loadFruitHarvestHistory();
    existing.unshift(record);
    fs.writeFileSync(HARVEST_FILE_PATH, JSON.stringify(existing.slice(0, 200), null, 2), "utf8");
  } catch (err) {
    logger.warn("Failed to persist fruit harvest record", { error: String(err) });
  }
}

// ── Knife King Automation ──
export async function runAccountKnifeDaily(accountId: number, logs: GameTaskLog[] = []): Promise<boolean> {
  const ctx = await resolveAccountContext(accountId);
  if (!ctx.dtUserId) {
    logs.push(formatLog("knife", "warn", "账户尚未激活或缺少 dtUserId，跳过飞刀日常"));
    return false;
  }

  try {
    const home = await requestGameJson(
      `/knife/homePage?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
    );
    if (home?.Result !== 1 || !home.data) {
      logs.push(formatLog("knife", "error", `获取飞刀主页失败: ${home?.Reason || "未知错误"}`));
      return false;
    }
    const data = home.data;
    logs.push(
      formatLog(
        "knife",
        "info",
        `🗡️ 飞刀国王: 剩余游戏次数 ${data.remainPlayTimes}，果汁金币 ${data.fruitJuiceAmount}，看广告次数 ${data.watchingGetPlayTimes}/${data.watchingGetPlayTimesLimit}`
      )
    );

    // 1. 如果开宝箱时间已到，自动开宝箱
    if (data.treasureBoxOwned && data.treasureBoxOpenTime && data.treasureBoxOpenTime <= Date.now()) {
      const boxRes = await requestGameJson(
        `/knife/openTreasureBox?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
      );
      if (boxRes?.Result === 1) {
        logs.push(formatLog("knife", "success", "成功开启飞刀国王宝箱！"));
      }
      await delay(1200);
    }

    // 2. 看广告获取游戏次数
    if (data.watchingGetPlayTimes < data.watchingGetPlayTimesLimit) {
      const remainingAds = data.watchingGetPlayTimesLimit - data.watchingGetPlayTimes;
      logs.push(formatLog("knife", "info", `执行看广告获取飞刀次数 (${remainingAds} 次)...`));
      for (let i = 0; i < remainingAds; i++) {
        const adRes = await requestGameJson(
          `/knife/watchingForPlay?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
        );
        if (adRes?.Result === 1) {
          logs.push(formatLog("knife", "success", `第 ${i + 1} 次看广告增加游戏机会成功`));
        }
        await delay(1200);
      }
    }

    // 3. 玩飞刀游戏并抽奖翻倍
    const reloaded = await requestGameJson(
      `/knife/homePage?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
    );
    let playTimes = reloaded?.data?.remainPlayTimes ?? 0;
    if (playTimes > 0) {
      logs.push(formatLog("knife", "info", `开始进行飞刀投掷游戏，共 ${playTimes} 次...`));
      for (let i = 0; i < playTimes; i++) {
        const playRes = await requestGameJson(
          `/knife/play?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${Date.now()}`
        );
        if (playRes?.Result === 1) {
          logs.push(formatLog("knife", "success", `第 ${i + 1} 局飞刀游戏完成！当前果汁: ${playRes.data?.fruitJuiceAmount}`));
          await delay(1500);

          // 抽奖页
          const ts = Date.now();
          const firstHash = crypto.createHash("md5").update(`${ctx.dtUserId}-${ctx.appType}-10-${ts}-${KNIFE_SALT}`).digest("hex");
          const lotPage = await requestGameJson(
            `/knife/lotteryPage?userId=${ctx.dtUserId}&appType=${ctx.appType}&level=10&md5=${firstHash}&timeStamp=${ts}`
          );
          if (lotPage?.Result === 1 && lotPage.data?.lotteryId) {
            const lotId = lotPage.data.lotteryId;
            const ts2 = Date.now();
            const lotHash = crypto.createHash("md5").update(`${ctx.dtUserId}-${ctx.appType}-${lotId}-${ts2}-${KNIFE_SALT}`).digest("hex");
            const lotRes = await requestGameJson(
              `/knife/lottery?userId=${ctx.dtUserId}&appType=${ctx.appType}&lotteryId=${lotId}&md5=${lotHash}&timeStamp=${ts2}`
            );
            if (lotRes?.Result === 1 && lotRes.data) {
              logs.push(formatLog("knife", "success", `飞刀抽奖获得: ${lotRes.data.prizeName || "奖品"}`));
              await delay(1200);
              // 翻倍
              if (lotRes.data.prizeType && lotRes.data.totalPrizeCount) {
                await requestGameJson(
                  `/knife/doublePrize?userId=${ctx.dtUserId}&appType=${ctx.appType}&prizeType=${lotRes.data.prizeType}&totalPrizeCount=${lotRes.data.totalPrizeCount}&timeStamp=${Date.now()}`
                ).catch(() => null);
              }
            }
          }
        }
        await delay(1500);
      }
    }

    return true;
  } catch (error) {
    logs.push(formatLog("knife", "error", `飞刀日常执行异常: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  }
}

// ── Math Game Rank & Redeem ──
export async function getGameRankList(appId = 66): Promise<RankLeaderboardItem[]> {
  try {
    const res = await requestGameJson(`/game/rank/list?appId=${appId}&timeStamp=${Date.now()}`);
    if (res?.Result === 1 && Array.isArray(res.data)) {
      return res.data.slice(0, 50).map((item: any) => ({
        ranking: item.ranking,
        nickname: item.nickname || "神秘玩家",
        countryName: item.countryName || "-",
        bestScore: item.bestScore,
        uid: item.uid,
        seasonId: item.seasonId
      }));
    }
    return [];
  } catch {
    return [];
  }
}

export async function redeemMathGamePoints(accountId: number, productId: number): Promise<{ success: boolean; message: string }> {
  const ctx = await resolveAccountContext(accountId);
  const summary = await getAccountGameSummary(accountId);
  const gameUid = summary.mathGame?.uid;
  if (!gameUid) {
    throw new AppError("未获取到算术游戏 uid", 400, 400);
  }

  const res = await requestGameJson(
    `/game/point/redeem?uid=${encodeURIComponent(gameUid)}&productId=${productId}&timeStamp=${Date.now()}`
  );
  const redeemState = loadMathDailyState(accountId);
  if (res?.Result === 1) {
    if (!redeemState.redeemedProductIds.includes(productId)) {
      redeemState.redeemedProductIds.push(productId);
      saveMathDailyState(redeemState);
    }
    return {
      success: true,
      message: `兑换成功！获得 ${res.data} 个说道币/叮咚币（有效期3个月）`
    };
  }
  if (res?.Reason?.includes("已达") || res?.Reason?.includes("上限") || res?.Reason?.includes("一次")) {
    if (!redeemState.redeemedProductIds.includes(productId)) {
      redeemState.redeemedProductIds.push(productId);
      saveMathDailyState(redeemState);
    }
  }
  return {
    success: false,
    message: res?.Reason || "兑换失败，库存不足或积分未达标"
  };
}

// ── Member Daily (Check-in & Ad Roulette) ──
export async function runAccountMemberDaily(accountId: number, logs: GameTaskLog[] = []): Promise<boolean> {
  const ctx = await resolveAccountContext(accountId);
  let success = false;

  // 1. 每日好运广告转盘 (Ad Roulette)
  if (ctx.dtUserId) {
    try {
      const devId = ctx.account.dtDeviceId || "And.8b0355c263713b5301559b2a0c222859.dttalk";
      let totalTimes = 0;
      // 看广告增加2次抽奖机会
      for (let i = 0; i < 2; i++) {
        const addRes = await requestGameJson(
          `/web/ad/roulette/chance/add?userId=${ctx.dtUserId}&deviceId=${encodeURIComponent(devId)}`
        ).catch(() => null);
        if (addRes?.Result === 1 && typeof addRes.data === "number") {
          totalTimes = addRes.data;
        }
        await delay(1200);
      }

      if (totalTimes > 0) {
        logs.push(formatLog("checkin", "info", `🌟 会员好运抽奖可用次数: ${totalTimes} 次，开始抽奖...`));
        for (let i = 0; i < totalTimes; i++) {
          const lotRes = await requestGameJson(
            `/web/ad/roulette/reward?userId=${ctx.dtUserId}&deviceId=${encodeURIComponent(devId)}&timeZone=Asia%2FShanghai&isoCC=US`
          ).catch(() => null);
          if (lotRes?.Result === 1 && lotRes.data?.prizeName) {
            const prize = lotRes.data.prizeName;
            logs.push(formatLog("checkin", "success", `好运抽奖获得: ${prize}`));
            saveMemberRewardRecord({
              accountId,
              source: "roulette",
              sourceName: "每日好运转盘",
              prizeName: prize,
              receivedAt: new Date().toISOString()
            });
            success = true;
          }
          await delay(1200);
        }
      }
    } catch (err) {
      logs.push(formatLog("checkin", "warn", `好运抽奖执行异常: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // 2. 积分中心签到 (Checkin)
  if (ctx.pointUid) {
    try {
      const timesRes = await requestGameJson(`/point/checkin/times?uid=${ctx.pointUid}`).catch(() => null);
      if (timesRes?.Result === 1 && timesRes.data) {
        const { validTimes, addTimes, maxAddTimes } = timesRes.data;
        if (addTimes < maxAddTimes) {
          const needed = maxAddTimes - addTimes;
          for (let i = 0; i < needed; i++) {
            await requestGameJson(`/point/checkin/addtimes?uid=${ctx.pointUid}`).catch(() => null);
            const claim = await requestGameJson(`/point/checkin/reward?uid=${ctx.pointUid}`).catch(() => null);
            if (claim?.Result === 1 && claim.data?.prizeName) {
              const prize = claim.data.prizeName;
              logs.push(formatLog("checkin", "success", `每日签到领奖: ${prize}`));
              saveMemberRewardRecord({
                accountId,
                source: "checkin",
                sourceName: "每日签到",
                prizeName: prize,
                receivedAt: new Date().toISOString()
              });
              success = true;
            }
            await delay(1200);
          }
        } else if (validTimes > 0) {
          const claim = await requestGameJson(`/point/checkin/reward?uid=${ctx.pointUid}`).catch(() => null);
          if (claim?.Result === 1 && claim.data?.prizeName) {
            logs.push(formatLog("checkin", "success", `签到抽奖获得: ${claim.data.prizeName}`));
            success = true;
          }
        }
      }
    } catch (err) {
      logs.push(formatLog("checkin", "warn", `签到执行异常: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return success;
}

// ── Xiequ Whitelist & Proxy Tester ──
export async function addXiequWhitelist(customUkey?: string): Promise<{ success: boolean; ip: string; message: string }> {
  let ukey = customUkey?.trim();
  if (!ukey) {
    const setting = await prisma.setting.findUnique({
      where: { key: "game_xiequ_whitelist_ukey" }
    });
    ukey = setting?.value?.trim() || "";
  }
  if (!ukey) {
    throw new AppError("未配置携趣加白名单 ukey，请先在系统设置中配置。", 400, 400);
  }

  let myIp = "";
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) });
    const json = (await res.json()) as any;
    myIp = json.ip;
  } catch {
    const res2 = await fetch("https://checkip.amazonaws.com", { signal: AbortSignal.timeout(5000) });
    myIp = (await res2.text()).trim();
  }

  if (!myIp) {
    throw new AppError("无法获取本机公网 IP 地址", 500, 500);
  }

  const wlUrl = `http://op.xiequ.cn/IpWhiteList.aspx?uid=105900&ukey=${ukey}&act=add&ip=${myIp}&meno=dtmanager`;
  const wlRes = await fetch(wlUrl, { signal: AbortSignal.timeout(8000) });
  const text = (await wlRes.text()).trim();
  return {
    success: text.includes("success") || text.includes("已存在") || text.includes("成功"),
    ip: myIp,
    message: text
  };
}

export function testHttpProxyConnection(targetUrl: string, proxyHost: string, proxyPort: number): Promise<{ status?: number; body: string }> {
  return new Promise((resolve, reject) => {
    import("node:http").then((http) => {
      const parsed = new URL(targetUrl);
      const req = http.request({
        host: proxyHost,
        port: proxyPort,
        path: targetUrl,
        headers: {
          Host: parsed.host,
          "User-Agent": DEFAULT_HEADERS["user-agent"]
        },
        timeout: 6000
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("Proxy timeout")));
      req.end();
    }).catch(reject);
  });
}
