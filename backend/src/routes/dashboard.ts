import { Router } from "express";
import { getDashboardStats, getRecentMessages } from "../services/dashboard.service.js";
import { ok } from "../utils/response.js";

export const dashboardRouter = Router();

dashboardRouter.get("/stats", async (_req, res, next) => {
  try {
    ok(res, await getDashboardStats());
  } catch (error) {
    next(error);
  }
});

dashboardRouter.get("/recent-messages", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 20);
    ok(res, await getRecentMessages(limit));
  } catch (error) {
    next(error);
  }
});
