import { Router } from "express";
import { getVersionInfo } from "../services/version.js";
import { ok } from "../utils/response.js";

export const versionRouter = Router();

versionRouter.get("/", async (req, res, next) => {
  try {
    ok(res, await getVersionInfo(String(req.query.refresh) === "true"));
  } catch (error) {
    next(error);
  }
});
