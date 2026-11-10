import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { gameAutoSchedulerService } from "../services/game-auto-scheduler.js";
import {
  addXiequWhitelist,
  getAccountGameSummary,
  runAccountMemberDaily,
  getGameRankList,
  loadFruitHarvestHistory,
  loadMemberRewardHistory,
  testHttpProxyConnection,
  redeemMathGamePoints,
  runAccountAllDaily,
  runAccountFruitDaily,
  runAccountKnifeDaily,
  runAccountPetDaily,
  runAccountShareBoost,
  runBatchAllAccountsDaily
} from "../services/dingtone/game-service.js";
import { AppError } from "../utils/errors.js";
import { ok } from "../utils/response.js";

export const gamesRouter = Router({ mergeParams: true });

async function assertAccountAccess(accountId: number, adminId: number) {
  const account = await prisma.dtAccount.findFirst({
    where: { id: accountId, adminId }
  });
  if (!account) {
    throw new AppError("Account not found", 404, 404);
  }
  return account;
}

// GET /api/accounts/:id/games/summary or /api/games/:id/summary
gamesRouter.get("/summary", async (req, res, next) => {
  try {
    const accountId = Number((req.params as any).id || req.query.account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new AppError("Valid account ID is required", 400, 400);
    }
    await assertAccountAccess(accountId, req.auth!.userId);
    const summary = await getAccountGameSummary(accountId);
    ok(res, summary);
  } catch (error) {
    next(error);
  }
});

// GET /api/games/rank or /api/accounts/:id/games/rank
gamesRouter.get("/rank", async (req, res, next) => {
  try {
    const appId = Number(req.query.app_id || 66);
    const rankList = await getGameRankList(appId);
    ok(res, rankList);
  } catch (error) {
    next(error);
  }
});

// GET /api/accounts/:id/games/harvests
gamesRouter.get("/harvests", async (req, res, next) => {
  try {
    const accountId = Number((req.params as any).id || req.query.account_id);
    const history = loadFruitHarvestHistory(accountId ? Number(accountId) : undefined);
    ok(res, history);
  } catch (error) {
    next(error);
  }
});

// POST /api/accounts/:id/games/daily - Run daily tasks for one account
gamesRouter.post("/daily", async (req, res, next) => {
  try {
    const accountId = Number((req.params as any).id || req.body.account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new AppError("Valid account ID is required", 400, 400);
    }
    await assertAccountAccess(accountId, req.auth!.userId);
    const result = await runAccountAllDaily(accountId);
    ok(res, result);
  } catch (error) {
    next(error);
  }
});

// POST /api/accounts/:id/games/pet/feed
gamesRouter.post("/pet/feed", async (req, res, next) => {
  try {
    const accountId = Number((req.params as any).id || req.body.account_id);
    await assertAccountAccess(accountId, req.auth!.userId);
    const logs: any[] = [];
    const success = await runAccountPetDaily(accountId, logs);
    ok(res, { success, logs });
  } catch (error) {
    next(error);
  }
});

// POST /api/accounts/:id/games/fruit/water
gamesRouter.post("/fruit/water", async (req, res, next) => {
  try {
    const accountId = Number((req.params as any).id || req.body.account_id);
    await assertAccountAccess(accountId, req.auth!.userId);
    const logs: any[] = [];
    const success = await runAccountFruitDaily(accountId, logs);
    ok(res, { success, logs });
  } catch (error) {
    next(error);
  }
});

// POST /api/accounts/:id/games/knife/daily
gamesRouter.post("/knife/daily", async (req, res, next) => {
  try {
    const accountId = Number((req.params as any).id || req.body.account_id);
    await assertAccountAccess(accountId, req.auth!.userId);
    const logs: any[] = [];
    const success = await runAccountKnifeDaily(accountId, logs);
    ok(res, { success, logs });
  } catch (error) {
    next(error);
  }
});

// POST /api/accounts/:id/games/math/redeem
gamesRouter.post("/math/redeem", async (req, res, next) => {
  try {
    const accountId = Number((req.params as any).id || req.body.account_id);
    const productId = Number(req.body.product_id);
    if (!productId) {
      throw new AppError("productId is required for redemption", 400, 400);
    }
    await assertAccountAccess(accountId, req.auth!.userId);
    const result = await redeemMathGamePoints(accountId, productId);
    ok(res, result);
  } catch (error) {
    next(error);
  }
});

// POST /api/accounts/:id/games/boost - Share boost
gamesRouter.post("/boost", async (req, res, next) => {
  try {
    const accountId = Number((req.params as any).id || req.body.account_id);
    await assertAccountAccess(accountId, req.auth!.userId);
    const result = await runAccountShareBoost(accountId);
    ok(res, result);
  } catch (error) {
    next(error);
  }
});

// POST /api/games/daily-all - Batch run for all accounts
gamesRouter.post("/daily-all", async (req, res, next) => {
  try {
    const adminId = req.auth!.userId;
    const result = await runBatchAllAccountsDaily(adminId);
    ok(res, result);
  } catch (error) {
    next(error);
  }
});

// POST /api/games/xiequ/whitelist - Add server IP to Xiequ whitelist
gamesRouter.post("/xiequ/whitelist", async (req, res, next) => {
  try {
    const ukey = req.body?.ukey ? String(req.body.ukey).trim() : undefined;
    const result = await addXiequWhitelist(ukey);
    ok(res, result);
  } catch (error) {
    next(error);
  }
});

// GET /api/games/scheduler/status
gamesRouter.get("/scheduler/status", async (_req, res, next) => {
  try {
    const status = gameAutoSchedulerService.getStatus();
    ok(res, status);
  } catch (error) {
    next(error);
  }
});

// POST /api/accounts/:id/games/member/daily - Run member checkin and ad roulette
gamesRouter.post("/member/daily", async (req, res, next) => {
  try {
    const accountId = Number((req.params as any).id || req.body.account_id);
    await assertAccountAccess(accountId, req.auth!.userId);
    const logs: any[] = [];
    const success = await runAccountMemberDaily(accountId, logs);
    ok(res, { success, logs });
  } catch (error) {
    next(error);
  }
});

// GET /api/accounts/:id/games/member/rewards
gamesRouter.get("/member/rewards", async (req, res, next) => {
  try {
    const accountId = Number((req.params as any).id || req.query.account_id);
    const history = loadMemberRewardHistory(accountId ? Number(accountId) : undefined);
    ok(res, history);
  } catch (error) {
    next(error);
  }
});

// POST /api/games/proxy/test
gamesRouter.post("/proxy/test", async (req, res, next) => {
  try {
    let extractUrl = req.body?.extract_url ? String(req.body.extract_url).trim() : "";
    if (!extractUrl) {
      const s = await prisma.setting.findFirst({
        where: { key: { in: ["game_proxy_extract_url", "game_proxy_pool_url"] } }
      });
      extractUrl = s?.value?.trim() || "";
    }
    if (!extractUrl) {
      throw new AppError("请先在输入框或系统设置中提供代理提取 URL", 400, 400);
    }
    const extractRes = await fetch(extractUrl, { signal: AbortSignal.timeout(8000) });
    const text = (await extractRes.text()).trim();
    const match = text.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
    if (!match) {
      return ok(res, {
        success: false,
        message: `未能从提取链接解析出 IP:端口，响应内容: ${text.slice(0, 150)}`
      });
    }
    const host = match[1] || "";
    const port = Number(match[2] || 0);
    const start = Date.now();
    try {
      const probe = await testHttpProxyConnection("http://dt-apigatewayv2.dt-pn1.com/game/point/redeemInfo", host, port);
      const latency = Date.now() - start;
      return ok(res, {
        success: true,
        proxy: `${host}:${port}`,
        latency_ms: latency,
        status: probe.status,
        message: `代理连接测试成功 (耗时: ${latency}ms, 状态码: ${probe.status})`
      });
    } catch (testErr) {
      return ok(res, {
        success: false,
        proxy: `${host}:${port}`,
        message: `提取到代理 ${host}:${port}，但连接网关测试超时或失败: ${testErr instanceof Error ? testErr.message : String(testErr)}`
      });
    }
  } catch (error) {
    next(error);
  }
});
