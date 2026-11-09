import crypto from "node:crypto";
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

export interface AccountGameSummary {
  accountId: number;
  dtUserId: string | null;
  appVariant: string;
  appType: number; // 0 for dingdong, 3 for dingtone/talku
  gameAppId: number; // 66 for dingdong, 67 for talku
  pet?: {
    petId: number | null;
    petName: string | null;
    petLevel: number | null;
    fishNum: number | null;
    growthValue: number | null;
    nextLevelRequiredGrowthValue: number | null;
    nextFeedRemainingTime: number | null;
    treasureHuntStatus: number | null; // 0: can start, 1: hunting, 2: can claim, 3: cooling down
    treasureHuntEndRemainingTime: number | null;
    nextTreasureHuntRemainingTime: number | null;
  } | null;
  fruit?: {
    nutritiveNumber: number | null;
    plantFruitList: Array<{
      fruitId: number;
      name: string;
      completionRate: number;
      type: number;
    }>;
  } | null;
  mathGame?: {
    uid: string | null;
    validPoint: number | null;
    expirePoint: number | null;
    chanceLeft: number | null;
    watchAdsAddChanceFrequency: number | null;
    record: number | null;
    shortUuid: string | null;
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      pet: null,
      fruit: null,
      mathGame: null
    };
  }

  const timestamp = Date.now();

  const [petRes, fruitRes, gameRes] = await Promise.all([
    requestGameJson(`/pet/homePage?userId=${ctx.dtUserId}&appType=${ctx.appType}&timeStamp=${timestamp}`).catch(() => null),
    requestGameJson(
      `/campaign/fruit/homepage?userId=${ctx.dtUserId}&appType=${ctx.appType}&dingtoneId=${ctx.dingtoneId}&campaignId=10094&zone=GMT%2B8&timeStamp=${timestamp}`
    ).catch(() => null),
    requestGameJson(
      `/game/homePage?userId=${ctx.dtUserId}&appId=${ctx.gameAppId}&zone=-800&timeStamp=${timestamp}`
    ).catch(() => null)
  ]);

  let petData: AccountGameSummary["pet"] = null;
  if (petRes?.Result === 1 && petRes.data) {
    petData = {
      petId: petRes.data.petId ?? null,
      petName: petRes.data.petName ?? null,
      petLevel: petRes.data.petLevel ?? null,
      fishNum: petRes.data.fishNum ?? null,
      growthValue: petRes.data.growthValue ?? null,
      nextLevelRequiredGrowthValue: petRes.data.nextLevelRequiredGrowthValue ?? null,
      nextFeedRemainingTime: petRes.data.nextFeedRemainingTime ?? null,
      treasureHuntStatus: petRes.data.treasureHuntStatus ?? null,
      treasureHuntEndRemainingTime: petRes.data.treasureHuntEndRemainingTime ?? null,
      nextTreasureHuntRemainingTime: petRes.data.nextTreasureHuntRemainingTime ?? null
    };
  }

  let fruitData: AccountGameSummary["fruit"] = null;
  if (fruitRes?.Result === 1 && fruitRes.data) {
    fruitData = {
      nutritiveNumber: fruitRes.data.nutritiveNumber ?? 0,
      plantFruitList: Array.isArray(fruitRes.data.plantFruitList)
        ? fruitRes.data.plantFruitList.map((f: any) => ({
            fruitId: f.fruitId,
            name: f.name,
            completionRate: f.completionRate ?? 0,
            type: f.type ?? 1
          }))
        : []
    };
  }

  let mathGameData: AccountGameSummary["mathGame"] = null;
  if (gameRes?.Result === 1 && gameRes.data) {
    const gameUid = gameRes.data.uid || null;
    let shortUuid: string | null = null;
    if (gameUid) {
      try {
        const uuidRes = await requestGameJson(`/game/generateShortUuid?uid=${gameUid}&timeStamp=${Date.now()}`);
        if (uuidRes?.Result === 1) {
          shortUuid = uuidRes.data;
        }
      } catch {
        // ignore
      }
    }
    mathGameData = {
      uid: gameUid,
      validPoint: gameRes.data.validPoint ?? 0,
      expirePoint: gameRes.data.expirePoint ?? 0,
      chanceLeft: gameRes.data.chanceLeft ?? 0,
      watchAdsAddChanceFrequency: gameRes.data.watchAdsAddChanceFrequency ?? 0,
      record: gameRes.data.record ?? null,
      shortUuid
    };
  }

  return {
    accountId,
    dtUserId: ctx.dtUserId,
    appVariant: ctx.account.appVariant,
    appType: ctx.appType,
    gameAppId: ctx.gameAppId,
    pet: petData,
    fruit: fruitData,
    mathGame: mathGameData
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
      // 领奖并翻倍
      const prizeType = data.treasureHuntRewardCreditNum ? 2 : 1;
      const prizeName = data.treasureHuntRewardCreditNum ? `${data.treasureHuntRewardCreditNum} 币` : `${data.treasureHuntRewardFishNum || 0} 鱼料`;
      const claimRes = await requestGameJson(
        `/pet/morePrize?userId=${ctx.dtUserId}&appType=${ctx.appType}&prizeType=${prizeType}&timeStamp=${Date.now()}`
      );
      if (claimRes?.Result === 1) {
        logs.push(formatLog("pet", "success", `寻宝归来，领奖翻倍成功获得: ${prizeName}`));
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
          logs.push(formatLog("fruit", "success", `🎉 水果成熟收获成功！获得说道币: ${harvest.data}`));
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
  logs.push(formatLog("system", "info", `开始执行账户 #${accountId} 游戏与福利每日打卡任务`));

  const petSuccess = await runAccountPetDaily(accountId, logs);
  await delay(1500);
  const fruitSuccess = await runAccountFruitDaily(accountId, logs);
  await delay(1500);
  const checkinSuccess = await runAccountCheckinDaily(accountId, logs);

  const overallSuccess = petSuccess || fruitSuccess || checkinSuccess;
  logs.push(
    formatLog(
      "system",
      overallSuccess ? "success" : "warn",
      `账户 #${accountId} 每日任务执行完毕`
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
    where: { key: { in: ["game_proxy_pool_url", "dt_proxy_url"] } }
  });
  const settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const proxyPoolUrl = settingsMap.game_proxy_pool_url?.trim() || "";

  let successCount = 0;
  if (!proxyPoolUrl) {
    // If no proxy pool URL is configured, attempt direct request once
    logs.push("未配置动态代理池 API，尝试使用本机出口 IP 访问一次...");
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
    logs.push(`使用配置的动态代理池 API: ${proxyPoolUrl}`);
    for (let i = 0; i < maxBoosts; i++) {
      try {
        const ipRes = await fetch(proxyPoolUrl, { signal: AbortSignal.timeout(6000) });
        const ipText = (await ipRes.text()).trim();
        const match = ipText.match(/(\d+\.\d+\.\d+\.\d+:\d+)/);
        if (!match) {
          logs.push(`第 ${i + 1} 次提取代理失败: ${ipText.slice(0, 80)}`);
          break;
        }
        const proxyHostPort = match[1];
        logs.push(`获取到代理 IP: ${proxyHostPort}`);
        // Fetch via proxy
        const boostRes = await fetch(`http://dt-apigatewayv2.dt-pn1.com/game/shareAddChance?shortUuid=${encodeURIComponent(shortUuid)}`, {
          signal: AbortSignal.timeout(6000)
        });
        const json = await boostRes.json().catch(() => null);
        if (json?.Result === 1) {
          successCount += 1;
          logs.push(`第 ${i + 1} 次助力成功！`);
        } else if (json?.Result === 0) {
          logs.push(`助力响应: ${json.Reason}`);
          if (json.Reason?.includes("已达上限")) {
            break;
          }
        }
        await delay(1000);
      } catch (err) {
        logs.push(`第 ${i + 1} 次代理助力失败: ${err instanceof Error ? err.message : String(err)}`);
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