import { PhoneStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  listPhoneInventory,
  refreshPhoneInventoryAccounts
} from "../services/phone-inventory.js";
import { AppError } from "../utils/errors.js";
import { ok } from "../utils/response.js";

const querySchema = z.object({
  keyword: z.string().trim().optional(),
  status: z.nativeEnum(PhoneStatus).optional(),
  country_code: z.coerce.number().int().positive().optional(),
  provider_id: z.coerce.number().int().nonnegative().optional()
});

const refreshSchema = z.object({
  confirm: z.boolean().optional().default(false)
});

export type PhoneNumberAccountRefresher = (
  accountId: number
) => Promise<Array<{ id: number }>>;

export function createPhoneNumbersRouter(syncPhoneNumbersFromRemote: PhoneNumberAccountRefresher) {
  const phoneNumbersRouter = Router();

  phoneNumbersRouter.get("/", async (req, res, next) => {
    try {
      const query = querySchema.parse(req.query);
      ok(
        res,
        await listPhoneInventory(req.auth!.userId, {
          keyword: query.keyword,
          status: query.status,
          countryCode: query.country_code,
          providerId: query.provider_id
        })
      );
    } catch (error) {
      next(error);
    }
  });

  phoneNumbersRouter.post("/refresh-all", async (req, res, next) => {
    try {
      const body = refreshSchema.parse(req.body ?? {});
      if (body.confirm !== true) {
        throw new AppError("Refreshing all phone numbers requires confirm=true", 400, 400);
      }
      const accounts = await prisma.dtAccount.findMany({
        where: { adminId: req.auth!.userId },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: { id: true, dtUserId: true, dtToken: true }
      });
      const results = await refreshPhoneInventoryAccounts(accounts, syncPhoneNumbersFromRemote, 2);
      ok(res, {
        success: results.filter((item) => item.status === "success").length,
        failed: results.filter((item) => item.status === "failed").length,
        skipped: results.filter((item) => item.status === "skipped").length,
        results
      });
    } catch (error) {
      next(error);
    }
  });

  return phoneNumbersRouter;
}
