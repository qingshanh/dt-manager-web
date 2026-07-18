import { AccountStatus, MonitorStatus } from "@prisma/client";
import type { Server } from "node:http";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { closeAllSseConnections, eventsRouter } from "./routes/events.js";
import { accountsRouter, syncPhoneNumbersFromRemote } from "./routes/accounts.js";
import { createPhoneNumbersRouter } from "./routes/phone-numbers.js";
import { codeReceiverRouter } from "./routes/code-receiver.js";
import { settingsRouter } from "./routes/settings.js";
import { versionRouter } from "./routes/version.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { ensureDefaultAdmin } from "./services/admin.service.js";
import { accountMonitorService } from "./services/account-monitor.js";
import { ensureDefaultSettings, getGatewayMode, getSettingsMap } from "./services/settings.service.js";
import { telegramBotService } from "./services/telegram-bot.js";
import { accountAutoRefreshService } from "./services/account-auto-refresh.js";
import { phoneExpiryReminderService } from "./services/phone-expiry-reminder.js";
import { buildHealthPayload } from "./services/runtime-health.js";
import { installJsonBodyParsers } from "./services/request-body-limits.js";
import { RuntimeLifecycle } from "./services/runtime-lifecycle.js";
import { logger } from "./utils/logger.js";

logger.setLevel(config.LOG_LEVEL);

const processStartedAt = new Date();
const FATAL_LISTEN_EXIT_CODE = 78;
let runtimeState: "starting" | "running" | "stopping" = "starting";
let requestRuntimeShutdown: ((reason: string, exitCode: number) => Promise<void>) | null = null;

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
  if (requestRuntimeShutdown) {
    void requestRuntimeShutdown("uncaughtException", 1);
  } else {
    process.exitCode = 1;
  }
});

const app = express();
const phoneNumbersRouter = createPhoneNumbersRouter(syncPhoneNumbersFromRemote);

app.use(helmet());
app.use(
  cors({
    origin: config.CORS_ORIGIN.split(",").map((item) => item.trim())
  })
);
installJsonBodyParsers(app, requireAuth);
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

app.get("/health", async (_req, res, next) => {
  try {
    res.json(buildHealthPayload({
      version: config.APP_VERSION,
      gatewayMode: await getGatewayMode(),
      instanceId: config.DT_RUNTIME_INSTANCE_ID,
      startedAt: processStartedAt,
      runtimeState
    }));
  } catch (error) {
    next(error);
  }
});

app.use("/api/auth", authRouter);
app.use("/api/events", eventsRouter);
app.use("/api/dashboard", requireAuth, dashboardRouter);
app.use("/api/accounts", requireAuth, accountsRouter);
app.use("/api/phone-numbers", requireAuth, phoneNumbersRouter);
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

  let shuttingDown = false;
  const server = app.listen(config.PORT, () => {
    if (shuttingDown) {
      return;
    }
    runtimeState = "running";
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

  const lifecycle = new RuntimeLifecycle({
    markStopping: () => {
      shuttingDown = true;
      runtimeState = "stopping";
    },
    stopTelegram: () => telegramBotService.stop(),
    stopAutoRefresh: () => accountAutoRefreshService.stop(),
    stopExpiryReminder: () => phoneExpiryReminderService.stop(),
    stopWorkQueue: () => undefined,
    stopAccountMonitor: () => accountMonitorService.stopAll(),
    closeHttp: () => closeHttpServer(server),
    forceCloseHttp: () => server.closeAllConnections?.(),
    closeSse: closeAllSseConnections,
    disconnectPrisma: () => prisma.$disconnect(),
    timeoutMs: 15_000
  });

  let shutdownExitCode = 0;
  let shutdownPromise: Promise<void> | null = null;
  requestRuntimeShutdown = (reason, exitCode) => {
    shutdownExitCode = Math.max(shutdownExitCode, exitCode);
    process.exitCode = shutdownExitCode;
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      const hardExitTimer = setTimeout(() => {
        logger.error("Backend shutdown exceeded the hard exit deadline", { reason });
        process.exit(shutdownExitCode);
      }, 18_000);
      hardExitTimer.unref();
      try {
        const result = await lifecycle.shutdown(reason);
        if (result.warnings.length > 0) {
          logger.warn("Backend shutdown completed with warnings", { reason, warnings: result.warnings });
        } else {
          logger.info("Backend shutdown completed", { reason });
        }
      } finally {
        clearTimeout(hardExitTimer);
        process.exit(shutdownExitCode);
      }
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => void requestRuntimeShutdown?.("SIGINT", 0));
  process.once("SIGTERM", () => void requestRuntimeShutdown?.("SIGTERM", 0));
  server.on("error", (error: NodeJS.ErrnoException) => {
    logger.error("Backend HTTP server error", formatFatalError(error));
    if (error.code === "EADDRINUSE" || error.code === "EACCES") {
      void requestRuntimeShutdown?.("listen-fatal", FATAL_LISTEN_EXIT_CODE);
    }
  });
}

function closeHttpServer(server: Server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

bootstrap().catch(async (error) => {
  logger.error("Bootstrap failed", error);
  runtimeState = "stopping";
  await prisma.$disconnect();
  process.exit(1);
});
