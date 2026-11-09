import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import {
  getAccountGameSummary,
  getGameRankList,
  loadFruitHarvestHistory,
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