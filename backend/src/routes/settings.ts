import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ok } from "../utils/response.js";
import { getSettingsMap } from "../services/settings.service.js";
import { telegramService } from "../services/telegram.js";
import { validateDirectTemplateSetting } from "../services/dingtone/direct-template.js";
import { createMockIncomingMessage } from "./accounts.js";
import { serializeMessage, serializeSetting } from "../utils/serializers.js";

const updateSettingsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const READONLY_SETTING_KEYS = new Set(["PORT"]);

export const settingsRouter = Router();

settingsRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await prisma.setting.findMany({
      orderBy: { key: "asc" }
    });
    ok(res, rows.map(serializeSetting));
  } catch (error) {
    next(error);
  }
});

settingsRouter.put("/", async (req, res, next) => {
  try {
    const body = updateSettingsSchema.parse(req.body);
    const entries = Object.entries(body)
      .filter(([key]) => !READONLY_SETTING_KEYS.has(key))
      .map(([key, value]) => [key, String(value)] as const);
    for (const [key, value] of entries) {
      validateDirectTemplateSetting(key, value);
    }
    await prisma.$transaction(
      entries.map(([key, value]) =>
        prisma.setting.upsert({
          where: { key },
          update: { value },
          create: { key, value }
        })
      )
    );
    const rows = await prisma.setting.findMany({ orderBy: { key: "asc" } });
    ok(res, rows.map(serializeSetting));
  } catch (error) {
    next(error);
  }
});

settingsRouter.post("/test-telegram", async (req, res, next) => {
  try {
    const settings = await getSettingsMap();
    const messageId = await telegramService.sendMessage(
      {
        botToken: settings.telegram_bot_token ?? "",
        chatId: settings.telegram_chat_id ?? "",
        text: "dt-manager-web Telegram test message",
        apiBaseUrl: settings.telegram_api_base_url
      }
    );
    ok(res, { message_id: messageId });
  } catch (error) {
    next(error);
  }
});

settingsRouter.post("/mock-message", async (req, res, next) => {
  try {
    const schema = z.object({
      account_id: z.number().int().positive(),
      content: z.string().min(1),
      from_number: z.string().optional()
    });
    const body = schema.parse(req.body);
    const result = await createMockIncomingMessage(body.account_id, body.content, body.from_number);
    ok(res, serializeMessage(result));
  } catch (error) {
    next(error);
  }
});
