import { Router } from "express";
import { getDashboardStats, getRecentMessages, getUnreadNotifications, markAllMessagesRead } from "../services/dashboard.service.js";
import { ok } from "../utils/response.js";

export const dashboardRouter = Router();

dashboardRouter.get("/stats", async (req, res, next) => {
  try {
    ok(res, await getDashboardStats(req.auth!.userId));
  } catch (error) {
    next(error);
  }
});

dashboardRouter.get("/recent-messages", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 20);
    ok(res, await getRecentMessages(limit, req.auth!.userId));
  } catch (error) {
    next(error);
  }
});

dashboardRouter.get("/notifications", async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    ok(res, await getUnreadNotifications(req.auth!.userId, limit));
  } catch (error) {
    next(error);
  }
});

dashboardRouter.put("/messages/read-all", async (req, res, next) => {
  try {
    const result = await markAllMessagesRead(req.auth!.userId);
    ok(res, { updated: result.count });
  } catch (error) {
    next(error);
  }
});
