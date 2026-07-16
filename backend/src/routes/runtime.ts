import { Router } from "express";
import { ok } from "../utils/response.js";

export function createRuntimeRouter(getStatus: () => unknown) {
  const router = Router();
  router.get("/metrics", (_req, res, next) => {
    try {
      ok(res, getStatus());
    } catch (error) {
      next(error);
    }
  });
  return router;
}
