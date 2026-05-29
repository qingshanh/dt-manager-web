import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import { ok } from "../utils/response.js";
import { changeAdminPassword, verifyAdmin } from "../services/admin.service.js";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const passwordSchema = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(6)
});

export const authRouter = Router();

authRouter.post("/login", async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const user = await verifyAdmin(body.username, body.password);
    const token = signToken({
      userId: user.id,
      username: user.username
    });
    ok(res, {
      token,
      user: {
        id: user.id,
        username: user.username,
        created_at: user.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/logout", requireAuth, async (_req, res) => {
  ok(res, null);
});

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.adminUser.findUnique({
      where: { id: req.auth!.userId }
    });
    ok(res, user ? { id: user.id, username: user.username, created_at: user.createdAt } : null);
  } catch (error) {
    next(error);
  }
});

authRouter.put("/password", requireAuth, async (req, res, next) => {
  try {
    const body = passwordSchema.parse(req.body);
    await changeAdminPassword(req.auth!.userId, body.old_password, body.new_password);
    ok(res, null);
  } catch (error) {
    next(error);
  }
});
