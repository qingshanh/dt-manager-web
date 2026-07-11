import { AccountStatus, MonitorStatus } from "@prisma/client";
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
import { versionRouter } from "./routes/version.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { ensureDefaultAdmin } from "./services/admin.service.js";
import { accountMonitorService } from "./services/account-monitor.js";
import { ensureDefaultSettings, getSettingsMap } from "./services/settings.service.js";
import { telegramBotService } from "./services/telegram-bot.js";
import { accountAutoRefreshService } from "./services/account-auto-refresh.js";
import { phoneExpiryReminderService } from "./services/phone-expiry-reminder.js";
import { logger } from "./utils/logger.js";

logger.setLevel(config.LOG_LEVEL);

function formatFatalError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { error: String(error) };
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled backend promise rejection", formatFatalError(reason));
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught backend exception", formatFatalError(error));
});

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: config.CORS_ORIGIN.split(",").map((item) => item.trim())
  })
);
app.use(express.json({ limit: "100mb" }));
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

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    version: config.APP_VERSION,
    now: new Date().toISOString(),
    gatewayMode: config.DT_GATEWAY_MODE
  });
});

app.use("/api/auth", authRouter);
app.use("/api/events", eventsRouter);
app.use("/api/dashboard", requireAuth, dashboardRouter);
app.use("/api/accounts", requireAuth, accountsRouter);
app.use("/api/code-receiver", codeReceiverRouter);
app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/version", requireAuth, versionRouter);

app.use(errorHandler);

function parseBooleanSetting(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

async function stopStaleMonitorSessionsAfterStartup() {
  await prisma.monitorSession.updateMany({
    where: {
      status: {
        in: [MonitorStatus.running, MonitorStatus.error]
      }
    },
    data: {
      status: MonitorStatus.stopped,
      stoppedAt: new Date(),
      errorMessage: null,
      routeAddress: "monitor auto-restore disabled at backend startup"
    }
  });
  await prisma.dtAccount.updateMany({
    where: {
      monitorEnabled: true,
      status: {
        in: [AccountStatus.online, AccountStatus.error]
      }
    },
    data: {
      status: AccountStatus.offline
    }
  });
}

async function bootstrap() {
  await prisma.$connect();
  await ensureDefaultAdmin();
  await ensureDefaultSettings();
  const server = app.listen(config.PORT, () => {
    logger.info(`Backend listening on http://localhost:${config.PORT}`);
    void getSettingsMap()
      .then((settings) => {
        if (parseBooleanSetting(settings.account_monitor_restore_enabled, true)) {
          return accountMonitorService.restoreEnabled();
        }
        return stopStaleMonitorSessionsAfterStartup().then(() => {
          logger.info("Account monitor auto-restore is disabled; monitor switches stay saved but do not start inside the web process.");
        });
      })
      .catch((error) => {
        logger.error("Failed to restore account monitors after startup", error);
      });
    telegramBotService.start();
    accountAutoRefreshService.start();
    phoneExpiryReminderService.start();
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    logger.error("Backend HTTP server error", formatFatalError(error));
    if (error.code === "EADDRINUSE" || error.code === "EACCES") {
      process.exit(1);
    }
  });
}

bootstrap().catch(async (error) => {
  logger.error("Bootstrap failed", error);
  await prisma.$disconnect();
  process.exit(1);
});
