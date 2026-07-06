import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { eventsRouter } from "./routes/events.js";
import { accountsRouter } from "./routes/accounts.js";
import { codeReceiverRouter } from "./routes/code-receiver.js";
import { settingsRouter } from "./routes/settings.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { ensureDefaultAdmin } from "./services/admin.service.js";
import { accountMonitorService } from "./services/account-monitor.js";
import { ensureDefaultSettings, getGatewayMode } from "./services/settings.service.js";
import { telegramBotService } from "./services/telegram-bot.js";
import { accountAutoRefreshService } from "./services/account-auto-refresh.js";
import { phoneExpiryReminderService } from "./services/phone-expiry-reminder.js";
import { logger } from "./utils/logger.js";

logger.setLevel(config.LOG_LEVEL);

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: config.CORS_ORIGIN.split(",").map((item) => item.trim())
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(
  "/api/auth/login",
  rateLimit({
    windowMs: 60_000,
    max: 5
  })
);
app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    max: 300
  })
);

app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    version: config.APP_VERSION,
    now: new Date().toISOString(),
    gatewayMode: await getGatewayMode()
  });
});

app.use("/api/auth", authRouter);
app.use("/api/events", eventsRouter);
app.use("/api/dashboard", requireAuth, dashboardRouter);
app.use("/api/accounts", requireAuth, accountsRouter);
app.use("/api/code-receiver", codeReceiverRouter);
app.use("/api/settings", requireAuth, settingsRouter);

app.use(errorHandler);

async function bootstrap() {
  await prisma.$connect();
  await ensureDefaultAdmin();
  await ensureDefaultSettings();
  app.listen(config.PORT, () => {
    logger.info(`Backend listening on http://localhost:${config.PORT}`);
    void accountMonitorService.restoreEnabled().catch((error) => {
      logger.error("Failed to restore account monitors after startup", error);
    });
    telegramBotService.start();
    accountAutoRefreshService.start();
    phoneExpiryReminderService.start();
  });
}

bootstrap().catch(async (error) => {
  logger.error("Bootstrap failed", error);
  await prisma.$disconnect();
  process.exit(1);
});
