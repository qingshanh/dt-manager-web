import { AccountStatus, AppVariant, MonitorStatus } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { AppError, assertFound } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { decryptText } from "../utils/crypto.js";
import { LatestAsyncWriter } from "../utils/latest-async-writer.js";
import { eventBus } from "./event-bus.js";
import { refreshAccountRuntimeData } from "./account-runtime.js";
import {
  hasDirectPushPhonePurchaseNotice,
  hasPhonePurchaseNotice,
  shouldCommitDirectPhoneInventoryRefresh,
  shouldContinueDirectPhoneInventoryListen,
  shouldRefreshDirectPhoneInventoryAfterPoll
} from "./phone-inventory-refresh.js";
import { syncPhoneNumbers } from "./phone-number-store.js";
import { dingtoneGateway } from "./dingtone/index.js";
import {
  DirectDingtoneGateway,
  listenDirectSessionPushes,
  preemptDirectSessionPushListener,
  type DirectProbeResult,
  type DirectProbePushResult,
  type DirectWebOfflineMessage
} from "./dingtone/direct-gateway.js";
import { storeHelperSmsMessages, storeParsedSmsPushes } from "./message-runtime.js";
import { dumpHelperSmsMessages } from "./helper-bridge.js";
import { dumpSmsMessagesFromAdb } from "./adb-database.js";
import { exportSessionFromAdbConfig } from "./adb-session.js";
import { dumpSmsMessagesFromNotifications } from "./adb-notification-ui.js";
import { dumpSmsMessagesFromUi, openMessagesInbox } from "./adb-message-ui.js";
import { getGatewayMode, getSettingsMap } from "./settings.service.js";
import { transferMonitorRunnerInPlace } from "./account-monitor-runner-transfer.js";
import { isRetryableMonitorTransportError } from "./account-list-monitor-state.js";
import { sendAccountStatusTelegramNotification } from "./telegram-notifier.js";
import { accountRecoveryKeyboard } from "./telegram-bot-ui.js";

type MonitorConfig = {
  pollIntervalMs: number;
  refreshIntervalMs: number;
  listenSeconds: number;
  maxRetryCount: number;
  maxConcurrentDirectPolls: number;
  appCatchupEnabled: boolean;
  appCatchupIntervalMs: number;
  appUiFallbackEnabled: boolean;
};

type MonitorRunner = {
  accountId: number;
  adminId: number;
  sessionId: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
  stopped: boolean;
  consecutiveFailures: number;
  pollIntervalMs: number;
  refreshIntervalMs: number;
  listenSeconds: number;
  maxRetryCount: number;
  maxConcurrentDirectPolls: number;
  appCatchupEnabled: boolean;
  appCatchupIntervalMs: number;
  appUiFallbackEnabled: boolean;
  lastRefreshAt: number | null;
  lastPhoneInventoryRefreshAt: number | null;
  phoneInventoryRefreshPending: boolean;
  lastCyclePreempted: boolean;
  lastCycleUsedDirectSlot: boolean;
  lastCycleSkippedDirectSlot: boolean;
  lastDirectSmsAt: string | null;
  lastDirectSmsTarget: string | null;
};

type DirectMonitorFrameState = {
  host: string | null;
  pairedHosts: Set<string>;
  connectingHosts: Set<string>;
  failedHosts: Map<string, string>;
  rawPushFrames: number;
  smsPushes: number;
  nonSmsPushFrames: number;
  statusCounts: Map<string, number>;
  hostCounts: Map<string, {
    rawPushFrames: number;
    smsPushes: number;
    statusCounts: Map<string, number>;
  }>;
  missedStatus0103Sample: string | null;
};

const directMonitorGateway = new DirectDingtoneGateway();
let activeDirectMonitorPolls = 0;
let appFallbackScanQueue = Promise.resolve() as Promise<unknown>;

function monitorFailureRetryDelay(consecutiveFailures: number) {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  return Math.min(60_000, 5_000 * 2 ** Math.min(4, consecutiveFailures - 1));
}

export function monitorFailureRetryDelayForTest(consecutiveFailures: number) {
  return monitorFailureRetryDelay(consecutiveFailures);
}

export class AccountMonitorService {
  private runners = new Map<number, MonitorRunner>();
  private shuttingDown = false;
  private stopAllPromise: Promise<void> | null = null;

  async start(accountId: number) {
    this.assertAcceptingNewRunners();
    const account = assertFound(
      await prisma.dtAccount.findUnique({
        where: { id: accountId }
      }),
      "Account not found"
    );

    if (!account.dtUserId || !account.dtToken) {
      throw new AppError("Account has not completed login yet", 400, 400);
    }
    try {
      requireDecryptedToken(account.dtToken);
    } catch {
      throw new AppError("Account token cannot be decrypted. Re-import this account session or set LEGACY_ENCRYPTION_KEYS to the old ENCRYPTION_KEY.", 400, 400);
    }

    await this.stopDuplicateDtUserIdMonitors(accountId, account.adminId, account.dtUserId);
    await this.stop(accountId, { preserveMonitorEnabled: true, targetStatus: AccountStatus.offline, emitStatus: false });
    const monitorConfig = await this.loadMonitorConfig();
    const session = await prisma.monitorSession.create({
      data: {
        accountId,
        status: MonitorStatus.running,
        serverIp: config.DT_SERVER_IP,
        serverPort: config.DT_SERVER_PORT
      }
    });
    if (this.shuttingDown) {
      await prisma.monitorSession.update({
        where: { id: session.id },
        data: { status: MonitorStatus.stopped, stoppedAt: new Date() }
      });
      this.assertAcceptingNewRunners();
    }

    const runner: MonitorRunner = {
      accountId,
      adminId: account.adminId,
      sessionId: session.id,
      timer: null,
      running: false,
      stopped: false,
      consecutiveFailures: 0,
      pollIntervalMs: monitorConfig.pollIntervalMs,
      refreshIntervalMs: monitorConfig.refreshIntervalMs,
      listenSeconds: monitorConfig.listenSeconds,
      maxRetryCount: monitorConfig.maxRetryCount,
      maxConcurrentDirectPolls: monitorConfig.maxConcurrentDirectPolls,
      appCatchupEnabled: monitorConfig.appCatchupEnabled,
      appCatchupIntervalMs: monitorConfig.appCatchupIntervalMs,
      appUiFallbackEnabled: monitorConfig.appUiFallbackEnabled,
      lastRefreshAt: null,
      lastPhoneInventoryRefreshAt: null,
      phoneInventoryRefreshPending: false,
      lastCyclePreempted: false,
      lastCycleUsedDirectSlot: false,
      lastCycleSkippedDirectSlot: false,
      lastDirectSmsAt: null,
      lastDirectSmsTarget: null
    };
    this.runners.set(accountId, runner);

    await prisma.dtAccount.update({
      where: { id: accountId },
      data: {
        status: AccountStatus.online,
        monitorEnabled: true,
        lastError: null
      }
    });

    this.scheduleNext(runner, 0);
    eventBus.emitEvent({
      adminId: account.adminId,
      type: "account_status",
      payload: { accountId, status: "online" }
    });
    return session;
  }

  async stop(
    accountId: number,
    options?: {
      preserveMonitorEnabled?: boolean;
      targetStatus?: AccountStatus;
      emitStatus?: boolean;
    }
  ) {
    const runner = this.runners.get(accountId);
    if (runner) {
      runner.stopped = true;
      if (runner.timer) {
        clearTimeout(runner.timer);
      }
      this.runners.delete(accountId);
    }

    const account = await prisma.dtAccount.findUnique({
      where: { id: accountId },
      select: { adminId: true, dtUserId: true, dtDeviceId: true, appVariant: true }
    });
    if (account?.dtUserId) {
      await preemptDirectSessionPushListener({
        dtUserId: account.dtUserId,
        deviceId: account.dtDeviceId,
        appVariant: account.appVariant
      });
    }

    const targetStatus = options?.targetStatus ?? AccountStatus.offline;
    const preserveMonitorEnabled = options?.preserveMonitorEnabled ?? false;
    const emitStatus = options?.emitStatus ?? true;

    await prisma.monitorSession.updateMany({
      where: {
        accountId,
        status: {
          in: [MonitorStatus.running, MonitorStatus.error]
        }
      },
      data: {
        status: targetStatus === AccountStatus.expired ? MonitorStatus.error : MonitorStatus.stopped,
        stoppedAt: new Date()
      }
    });

    await prisma.dtAccount.update({
      where: { id: accountId },
      data: {
        status: targetStatus,
        monitorEnabled: preserveMonitorEnabled,
        ...(targetStatus === AccountStatus.offline ? {} : { lastError: null })
      }
    });

    if (emitStatus && account) {
      eventBus.emitEvent({
        adminId: account.adminId,
        type: "account_status",
        payload: { accountId, status: targetStatus }
      });
    }
  }

  isRunning(accountId: number) {
    const runner = this.runners.get(accountId);
    return Boolean(runner && !runner.stopped);
  }

  async withMaintenance<T>(accountId: number, operation: () => Promise<T>): Promise<T> {
    const wasRunning = this.isRunning(accountId);
    if (wasRunning) {
      await this.stop(accountId, {
        preserveMonitorEnabled: true,
        targetStatus: AccountStatus.online,
        emitStatus: false
      });
    }

    try {
      return await operation();
    } finally {
      if (wasRunning) {
        await this.start(accountId).catch((error) => {
          logger.warn("Failed to restore account monitor after maintenance", {
            accountId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
  }

  async stopAll() {
    this.shuttingDown = true;
    if (!this.stopAllPromise) {
      const accountIds = Array.from(this.runners.keys());
      this.stopAllPromise = Promise.allSettled(
        accountIds.map((accountId) => this.stop(accountId, {
          preserveMonitorEnabled: true,
          targetStatus: AccountStatus.offline,
          emitStatus: false
        }))
      ).then(() => undefined);
    }
    await this.stopAllPromise;
  }

  private assertAcceptingNewRunners() {
    if (this.shuttingDown) {
      throw new AppError("Account monitor service is shutting down", 503, 503);
    }
  }

  async restart(accountId: number) {
    await this.stop(accountId);
    return this.start(accountId);
  }

  async transferHeartbeat(fromAccountId: number, toAccountId: number) {
    const { replacedRunner } = transferMonitorRunnerInPlace(this.runners, fromAccountId, toAccountId, {
      clearTimer: (timer) => clearTimeout(timer),
      schedule: (runner) => this.scheduleNext(runner, runner.pollIntervalMs)
    });
    if (replacedRunner) {
      await prisma.monitorSession.updateMany({
        where: {
          id: replacedRunner.sessionId,
          status: { in: [MonitorStatus.running, MonitorStatus.error] }
        },
        data: {
          status: MonitorStatus.stopped,
          stoppedAt: new Date()
        }
      });
    }
  }

  async restoreEnabled() {
    if (this.shuttingDown) {
      return;
    }
    const accounts = await prisma.dtAccount.findMany({
      where: {
        monitorEnabled: true,
        dtUserId: { not: null },
        dtToken: { not: null }
      },
      orderBy: { id: "asc" }
    });
    const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
    const configuredRestoreDelayMs = parsePositiveIntSetting(
      settings.monitor_restore_delay,
      config.DEFAULT_MONITOR_RESTORE_DELAY
    ) * 1000;
    const restoreDelayMs = Math.min(configuredRestoreDelayMs, 1_000);

    const accountsToRestore = await this.disableDuplicateRestoreCandidates(accounts);

    const restoreAccountIds = accountsToRestore.map((account) => account.id);
    if (restoreAccountIds.length > 0) {
      await prisma.monitorSession.updateMany({
        where: {
          accountId: { in: restoreAccountIds },
          status: { in: [MonitorStatus.running, MonitorStatus.error] }
        },
        data: {
          status: MonitorStatus.stopped,
          stoppedAt: new Date(),
          routeAddress: "monitor auto-restore restarting after backend startup"
        }
      });
    }

    const restoreTasks = accountsToRestore.map(async (account, index) => {
      if (index > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, index * restoreDelayMs));
      }
      if (this.shuttingDown) {
        return;
      }
      try {
        await this.start(account.id);
        logger.info("Restored account monitor after backend restart", { accountId: account.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await prisma.dtAccount.update({
          where: { id: account.id },
          data: { status: AccountStatus.offline, monitorEnabled: false, lastError: message }
        }).catch(() => null);
        void notifyAccountMonitorUnavailable(account.id, "offline", message);
        logger.warn("Failed to restore account monitor after backend restart", {
          accountId: account.id,
          error: message
        });
      }
    });
    void Promise.allSettled(restoreTasks).then(() => {
      logger.info("Account monitor restore queue finished", { count: accountsToRestore.length });
    });

    if (accountsToRestore.length > 0) {
      logger.info("Queued account monitor restore after backend restart", {
        count: accountsToRestore.length,
        delaySeconds: restoreDelayMs / 1000
      });
    }
  }

  private async stopDuplicateDtUserIdMonitors(accountId: number, adminId: number, dtUserId: string) {
    const duplicates = await prisma.dtAccount.findMany({
      where: {
        adminId,
        dtUserId,
        id: { not: accountId }
      },
      select: { id: true, monitorEnabled: true }
    });
    for (const duplicate of duplicates) {
      await this.stop(duplicate.id, {
        preserveMonitorEnabled: false,
        targetStatus: AccountStatus.offline,
        emitStatus: false
      });
      logger.warn("Stopped duplicate account monitor for shared dt_user_id", {
        accountId,
        duplicateAccountId: duplicate.id,
        dtUserId
      });
    }
  }

  private async disableDuplicateRestoreCandidates<T extends { id: number; dtUserId: string | null }>(accounts: T[]) {
    const seen = new Set<string>();
    const output: T[] = [];
    const duplicateIds: number[] = [];
    for (const account of accounts) {
      const key = account.dtUserId?.trim();
      if (!key) {
        continue;
      }
      if (seen.has(key)) {
        duplicateIds.push(account.id);
        continue;
      }
      seen.add(key);
      output.push(account);
    }
    if (duplicateIds.length > 0) {
      await prisma.dtAccount.updateMany({
        where: { id: { in: duplicateIds } },
        data: {
          monitorEnabled: false,
          status: AccountStatus.offline,
          lastError: "Monitor disabled because another account with the same dt_user_id is already being restored."
        }
      });
      await prisma.monitorSession.updateMany({
        where: {
          accountId: { in: duplicateIds },
          status: { in: [MonitorStatus.running, MonitorStatus.error] }
        },
        data: {
          status: MonitorStatus.stopped,
          stoppedAt: new Date()
        }
      });
      logger.warn("Disabled duplicate monitor restore candidates for shared dt_user_id", {
        duplicateAccountIds: duplicateIds
      });
    }
    return output;
  }

  private scheduleNext(runner: MonitorRunner, delayMs?: number) {
    if (runner.stopped || this.shuttingDown) {
      return;
    }
    if (runner.timer) {
      clearTimeout(runner.timer);
    }
    runner.timer = setTimeout(() => {
      void this.tick(runner.accountId);
    }, delayMs ?? runner.pollIntervalMs);
    runner.timer.unref?.();
  }

  private async tick(accountId: number) {
    const runner = this.runners.get(accountId);
    if (!runner || runner.stopped || this.shuttingDown) {
      return;
    }
    if (runner.running) {
      this.scheduleNext(runner);
      return;
    }
    runner.running = true;
    const startedAt = Date.now();
    try {
      await this.runCycle(runner, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runner.stopped) {
        return;
      }
      logger.error("Account monitor tick failed, keeping runner enabled", {
        accountId,
        error: message,
        failureCount: runner.consecutiveFailures
      });
    } finally {
      runner.running = false;
      if (!runner.stopped && !this.shuttingDown) {
        const elapsed = Date.now() - startedAt;
        const nextDelay = runner.consecutiveFailures > 0
          ? monitorFailureRetryDelay(runner.consecutiveFailures)
          : runner.lastCyclePreempted
            ? 1_000
            : runner.lastCycleSkippedDirectSlot
              ? 5_000
              : runner.lastCycleUsedDirectSlot
                ? this.hasDedicatedDirectSlots(runner) ? 1_000 : this.directSlotRotationDelay(runner)
                : Math.max(1_000, runner.pollIntervalMs - elapsed);
        this.scheduleNext(runner, nextDelay);
      }
    }
  }

  private hasDedicatedDirectSlots(runner: MonitorRunner) {
    return runner.maxConcurrentDirectPolls >= this.runners.size;
  }

  private directSlotRotationDelay(runner: MonitorRunner) {
    const rotationSize = Math.ceil(this.runners.size / Math.max(1, runner.maxConcurrentDirectPolls));
    return Math.max(runner.pollIntervalMs, runner.pollIntervalMs * rotationSize);
  }

  private async runCycle(runner: MonitorRunner, failFast: boolean) {
    const latestConfig = await this.loadMonitorConfig();
    runner.pollIntervalMs = latestConfig.pollIntervalMs;
    runner.refreshIntervalMs = latestConfig.refreshIntervalMs;
    runner.listenSeconds = latestConfig.listenSeconds;
    runner.maxRetryCount = latestConfig.maxRetryCount;
    runner.maxConcurrentDirectPolls = latestConfig.maxConcurrentDirectPolls;
    runner.appCatchupEnabled = latestConfig.appCatchupEnabled;
    runner.appCatchupIntervalMs = latestConfig.appCatchupIntervalMs;
    runner.appUiFallbackEnabled = latestConfig.appUiFallbackEnabled;
    runner.lastCycleUsedDirectSlot = false;
    runner.lastCycleSkippedDirectSlot = false;

    try {
      let phoneCount = 0;
      const account = await assertFound(
        await prisma.dtAccount.findUnique({
          where: { id: runner.accountId }
        }),
        "Account not found"
      );
      const useDirectFlow = await shouldUseDirectAccountFlow(account);

      if (shouldRefreshRuntimeData(runner) && !useDirectFlow) {
        const result = await refreshAccountRuntimeData(runner.accountId, dingtoneGateway);
        phoneCount = result.phoneCount;
        runner.lastRefreshAt = Date.now();
      }
      const dtUserId = account.dtUserId;
      const token = account.dtToken;
      if (!dtUserId || !token) {
        throw new AppError("Account session is incomplete", 400, 400);
      }

      runner.lastCyclePreempted = false;
      const directPollResult = useDirectFlow
        ? await this.pollDirectMessages(runner, {
            dtUserId,
            token,
            deviceId: account.dtDeviceId,
            email: account.email,
            phone: account.phone,
            appVariant: account.appVariant
          })
        : null;
      const createdMessages = directPollResult ? directPollResult.createdMessages : await this.pollHelperMessages(runner);
      if (
        useDirectFlow
        && shouldRefreshDirectPhoneInventoryAfterPoll({
          stopped: runner.stopped,
          listened: Boolean(directPollResult?.listened),
          now: Date.now(),
          lastRefreshAt: runner.lastPhoneInventoryRefreshAt,
          pendingPurchase: runner.phoneInventoryRefreshPending
        })
      ) {
        phoneCount = await this.refreshDirectPhoneInventory(runner, {
          dtUserId,
          token: requireDecryptedToken(token),
          deviceId: account.dtDeviceId,
          appVariant: account.appVariant
        });
      }
      runner.lastCyclePreempted = Boolean(directPollResult?.preempted);
      runner.lastCycleUsedDirectSlot = Boolean(directPollResult?.listened);
      runner.lastCycleSkippedDirectSlot = Boolean(directPollResult?.skippedForConcurrency);
      if (runner.stopped) {
        return;
      }
      runner.consecutiveFailures = 0;

      await prisma.monitorSession.update({
        where: { id: runner.sessionId },
        data: {
          status: MonitorStatus.running,
          stoppedAt: null,
          errorMessage: null,
          routeAddress: directPollResult?.diagnosticNote ?? null,
          heartbeatCount: { increment: 1 },
          msgReceivedCount: createdMessages > 0 ? { increment: createdMessages } : undefined
        }
      });
      await prisma.dtAccount.update({
        where: { id: runner.accountId },
        data: {
          status: AccountStatus.online,
          monitorEnabled: true,
          lastError: null
        }
      });
      eventBus.emitEvent({
        adminId: runner.adminId,
        type: "heartbeat",
        payload: { time: new Date().toISOString(), accountId: runner.accountId }
      });
      eventBus.emitEvent({
        adminId: runner.adminId,
        type: "account_status",
        payload: { accountId: runner.accountId, status: "online" }
      });
      logger.info("Account monitor cycle succeeded", {
        accountId: runner.accountId,
        mode: useDirectFlow ? "direct" : await getGatewayMode(),
        phoneCount,
        storedMessages: createdMessages,
        preempted: runner.lastCyclePreempted,
        directDiagnostic: directPollResult?.diagnosticNote ?? undefined
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runner.stopped) {
        return;
      }
      runner.consecutiveFailures += 1;
      const classification = classifyMonitorError(message);

      await prisma.monitorSession.update({
        where: { id: runner.sessionId },
        data: {
          status: MonitorStatus.error,
          errorMessage: message,
          heartbeatCount: { increment: 1 }
        }
      });

      if (classification === "expired") {
        runner.stopped = true;
        if (runner.timer) {
          clearTimeout(runner.timer);
        }
        this.runners.delete(runner.accountId);
        await prisma.monitorSession.update({
          where: { id: runner.sessionId },
          data: {
            stoppedAt: new Date()
          }
        });
        await prisma.dtAccount.update({
          where: { id: runner.accountId },
          data: {
            status: AccountStatus.expired,
            monitorEnabled: false,
            lastError: message
          }
        });
        eventBus.emitEvent({
          adminId: runner.adminId,
          type: "account_status",
          payload: { accountId: runner.accountId, status: "expired", message }
        });
        void notifyAccountMonitorUnavailable(runner.accountId, "expired", message);
        throw new AppError(message, 401, 401);
      }

      const shouldSurfaceTransientError = shouldSurfaceMonitorError(
        message,
        classification,
        runner.consecutiveFailures,
        runner.maxRetryCount
      );

      await prisma.dtAccount.update({
        where: { id: runner.accountId },
        data: shouldSurfaceTransientError
          ? {
              status: AccountStatus.error,
              monitorEnabled: true,
              lastError: message
            }
          : {
              status: AccountStatus.online,
              monitorEnabled: true,
              lastError: isRetryableMonitorTransportError(message) ? message : null
            }
      });
      eventBus.emitEvent({
        adminId: runner.adminId,
        type: "account_status",
        payload: shouldSurfaceTransientError
          ? {
              accountId: runner.accountId,
              status: "error",
              message: `${message} (failure ${runner.consecutiveFailures}/${runner.maxRetryCount})`
            }
          : {
              accountId: runner.accountId,
              status: "online",
              message: "Transient monitor transport failed; retry remains scheduled"
            }
      });
      logger.warn("Account monitor cycle failed", {
        accountId: runner.accountId,
        error: message,
        mode: await getGatewayMode(),
        failureCount: runner.consecutiveFailures,
        maxRetryCount: runner.maxRetryCount
      });

      if (failFast || runner.consecutiveFailures >= runner.maxRetryCount) {
        throw new AppError(message, 502, 502);
      }
    }
  }

  private async loadMonitorConfig(): Promise<MonitorConfig> {
    const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
    const pollIntervalSeconds = parsePositiveIntSetting(settings.message_poll_interval, config.DEFAULT_MESSAGE_POLL_INTERVAL);
    const directListenSeconds = parsePositiveIntSetting(
      settings.direct_message_listen_seconds,
      Math.max(300, pollIntervalSeconds * 5)
    );
    const refreshIntervalSeconds = parsePositiveIntSetting(settings.auto_refresh_interval, config.DEFAULT_AUTO_REFRESH_INTERVAL);
    const maxRetryCount = parsePositiveIntSetting(settings.max_retry_count, config.DEFAULT_MAX_RETRY_COUNT);
    const maxConcurrentDirectPolls = parsePositiveIntSetting(settings.direct_monitor_max_concurrent, 10);
    const appCatchupEnabled = config.DT_ALLOW_APP_FALLBACK
      && parseBooleanSetting(settings.direct_monitor_app_catchup_enabled, false);
    const appUiFallbackEnabled = parseBooleanSetting(settings.direct_monitor_app_ui_fallback_enabled, false);
    const appCatchupIntervalSeconds = parsePositiveIntSetting(settings.direct_monitor_app_catchup_seconds, 45);
    return {
      pollIntervalMs: Math.max(15_000, pollIntervalSeconds * 1000),
      refreshIntervalMs: Math.max(30_000, refreshIntervalSeconds * 1000),
      listenSeconds: Math.max(300, Math.min(1800, directListenSeconds)),
      maxRetryCount: Math.max(1, maxRetryCount),
      maxConcurrentDirectPolls,
      appCatchupEnabled,
      appCatchupIntervalMs: Math.max(15_000, appCatchupIntervalSeconds * 1000),
      appUiFallbackEnabled
    };
  }

  private async refreshDirectPhoneInventory(
    runner: MonitorRunner,
    account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" }
  ) {
    try {
      const phoneNumbers = await directMonitorGateway.listPhoneNumbers(account);
      if (!shouldCommitDirectPhoneInventoryRefresh(runner)) {
        return 0;
      }
      if (phoneNumbers.length > 0) {
        await syncPhoneNumbers(runner.accountId, phoneNumbers);
        runner.phoneInventoryRefreshPending = false;
      }
      runner.lastPhoneInventoryRefreshAt = Date.now();
      logger.info("Automatic phone inventory refresh completed", {
        accountId: runner.accountId,
        remotePhoneCount: phoneNumbers.length,
        pendingPurchase: runner.phoneInventoryRefreshPending
      });
      return phoneNumbers.length;
    } catch (error) {
      logger.warn("Automatic phone inventory refresh failed", {
        accountId: runner.accountId,
        error: error instanceof Error ? error.message : String(error)
      });
      return 0;
    }
  }

  private async pollDirectMessages(
    runner: MonitorRunner,
    account: {
      dtUserId: string;
      token: string;
      deviceId?: string | null;
      email?: string | null;
      phone?: string | null;
      appVariant: AppVariant;
    }
  ): Promise<{ createdMessages: number; preempted: boolean; diagnosticNote: string | null; listened: boolean; skippedForConcurrency: boolean }> {
    if (runner.maxConcurrentDirectPolls > 0 && activeDirectMonitorPolls >= runner.maxConcurrentDirectPolls) {
      logger.info("Skipping direct SMS monitor cycle because concurrency limit is reached", {
        accountId: runner.accountId,
        activeDirectMonitorPolls,
        maxConcurrentDirectPolls: runner.maxConcurrentDirectPolls
      });
      return { createdMessages: 0, preempted: false, diagnosticNote: "direct-monitor=skipped; reason=concurrency-limit", listened: false, skippedForConcurrency: true };
    }

    let createdMessages = 0;
    let preempted = false;
    let diagnosticNote: string | null = null;
    let directListenCompleted = false;
    let appCatchupInFlight = false;
    let appCatchupScanned = 0;
    let appCatchupImported = 0;
    let appCatchupSource: string | null = null;
    let appCatchupError: string | null = null;
    let lastAppCatchupScheduledAt = 0;
    let offlineCatchupAttempted = false;
    let offlineCatchupSent = false;
    let offlineCatchupSendCount = 0;
    let offlineCatchupError: string | null = null;
    const liveState: DirectMonitorFrameState = {
      host: null,
      pairedHosts: new Set(),
      connectingHosts: new Set(),
      failedHosts: new Map(),
      rawPushFrames: 0,
      smsPushes: 0,
      nonSmsPushFrames: 0,
      statusCounts: new Map(),
      hostCounts: new Map(),
      missedStatus0103Sample: null
    };
    const diagnosticWriter = new LatestAsyncWriter<string>(async (note) => {
      try {
        await prisma.monitorSession.update({
          where: { id: runner.sessionId },
          data: { routeAddress: note }
        });
      } catch (error) {
        logger.warn("Failed to update direct SMS monitor diagnostics", {
          accountId: runner.accountId,
          error: sanitizeMonitorDiagnosticError(error)
        });
      }
    }, { minIntervalMs: 10_000 });
    const updateLiveDiagnostic = (immediate = false) => {
      if (runner.stopped) {
        return;
      }
      diagnosticNote = buildDirectMonitorLiveDiagnosticNote(liveState, createdMessages, preempted, {
        scanned: appCatchupScanned,
        imported: appCatchupImported,
        source: appCatchupSource,
        error: appCatchupError
      }, {
        attempted: offlineCatchupAttempted,
        sent: offlineCatchupSent,
        sendCount: offlineCatchupSendCount,
        error: offlineCatchupError
      }, {
        at: runner.lastDirectSmsAt,
        target: runner.lastDirectSmsTarget
      });
      diagnosticWriter.schedule(diagnosticNote, { immediate });
    };
    activeDirectMonitorPolls += 1;
    runner.lastCycleUsedDirectSlot = true;
    const appCatchupState: { promise: Promise<void> | null } = { promise: null };
    const runAppCatchup = async (source: string) => {
      if (runner.stopped || appCatchupInFlight) {
        return;
      }
      appCatchupInFlight = true;
      try {
        const result = await runSerializedAppFallbackScan(() =>
          this.pollAppFallbackMessages(runner, account)
        );
        appCatchupScanned += result.scanned;
        appCatchupImported += result.imported;
        appCatchupSource = result.source ?? source;
        appCatchupError = null;
        if (result.imported > 0) {
          createdMessages += result.imported;
          updateLiveDiagnostic(true);
          logger.info("Direct monitor imported SMS via app fallback", {
            accountId: runner.accountId,
            imported: result.imported,
            scanned: result.scanned,
            source: result.source
          });
        }
      } catch (error) {
        appCatchupError = error instanceof Error ? error.message : String(error);
        logger.warn("Direct monitor app fallback scan failed", {
          accountId: runner.accountId,
          error: appCatchupError
        });
      } finally {
        appCatchupInFlight = false;
      }
    };
    const scheduleAppCatchup = (source: string) => {
      if (appCatchupInFlight) {
        return;
      }
      lastAppCatchupScheduledAt = Date.now();
      const promise = runAppCatchup(source).finally(() => {
        if (appCatchupState.promise === promise) {
          appCatchupState.promise = null;
        }
      });
      appCatchupState.promise = promise;
      void promise;
    };
    const appCatchupTimer = runner.appCatchupEnabled
      ? setInterval(() => {
          scheduleAppCatchup("interval");
        }, runner.appCatchupIntervalMs)
      : null;
    appCatchupTimer?.unref?.();
    try {
      if (runner.appCatchupEnabled) {
        scheduleAppCatchup("startup");
      }
      const result = await listenDirectSessionPushes({
        account: {
          dtUserId: account.dtUserId,
          token: requireDecryptedToken(account.token),
          deviceId: account.deviceId,
          email: account.email,
          phone: account.phone,
          appVariant: account.appVariant
        },
        listenSeconds: runner.listenSeconds,
        shouldContinue: () => shouldContinueDirectPhoneInventoryListen({
          stopped: runner.stopped,
          hasDedicatedSlots: this.hasDedicatedDirectSlots(runner),
          now: Date.now(),
          lastRefreshAt: runner.lastPhoneInventoryRefreshAt,
          pendingPurchase: runner.phoneInventoryRefreshPending
        }),
        onListenWindowExtended: async () => {
          if (runner.stopped) {
            return;
          }
          await prisma.monitorSession.update({
            where: { id: runner.sessionId },
            data: {
              status: MonitorStatus.running,
              stoppedAt: null,
              errorMessage: null,
              heartbeatCount: { increment: 1 }
            }
          });
          eventBus.emitEvent({
            adminId: runner.adminId,
            type: "heartbeat",
            payload: { time: new Date().toISOString(), accountId: runner.accountId }
          });
        },
        onPush: async (push: DirectProbePushResult) => {
          if (!push.sms) {
            return;
          }
          runner.lastDirectSmsAt = push.receivedAt;
          runner.lastDirectSmsTarget = push.sms.toNumber ?? null;
          if (hasDirectPushPhonePurchaseNotice(push.sms)) {
            runner.phoneInventoryRefreshPending = true;
          }
          try {
            createdMessages += await storeParsedSmsPushes(runner.accountId, [push.sms]);
            updateLiveDiagnostic(true);
          } catch (error) {
            logger.warn("Direct SMS push was received but could not be stored immediately", {
              accountId: runner.accountId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        },
        onWebOfflineMessages: async (messages: DirectWebOfflineMessage[]) => {
          try {
            if (hasPhonePurchaseNotice(messages)) {
              runner.phoneInventoryRefreshPending = true;
            }
            createdMessages += await storeHelperSmsMessages(runner.accountId, messages, {
              sendTelegram: false
            });
            updateLiveDiagnostic();
          } catch (error) {
            logger.warn("Direct web-offline team messages could not be stored", {
              accountId: runner.accountId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        },
        onHostStatus: async (status) => {
          liveState.host ??= status.host;
          liveState.connectingHosts.delete(status.host);
          if (status.state === "connecting") {
            liveState.connectingHosts.add(status.host);
            liveState.failedHosts.delete(status.host);
          } else if (status.state === "connected") {
            liveState.pairedHosts.add(status.host);
            liveState.failedHosts.delete(status.host);
          } else {
            liveState.pairedHosts.delete(status.host);
            liveState.failedHosts.set(status.host, status.error ?? "unknown error");
          }
          updateLiveDiagnostic();
        },
        onOfflineCatchup: async (status) => {
          offlineCatchupAttempted = status.attempted;
          offlineCatchupSent = status.sent;
          offlineCatchupSendCount = status.sendCount;
          offlineCatchupError = status.error;
          updateLiveDiagnostic();
        },
        onFrame: async (push, host) => {
          liveState.host = host;
          liveState.rawPushFrames += 1;
          if (push.sms) {
            liveState.smsPushes += 1;
          } else {
            liveState.nonSmsPushFrames += 1;
            if (push.status === 0x0103 && !liveState.missedStatus0103Sample) {
              liveState.missedStatus0103Sample = formatMissedDirectMonitorFrameSample(push);
              logger.warn("Direct monitor saw status=0x0103 but parser did not extract SMS", {
                accountId: runner.accountId,
                host,
                bodyLength: push.bodyLength,
                rawHexPreview: push.rawHexPreview,
                bodyHexPreview: push.bodyHexPreview
              });
            }
          }
          const status = push.status === undefined ? "unknown" : `0x${push.status.toString(16).padStart(4, "0")}`;
          liveState.statusCounts.set(status, (liveState.statusCounts.get(status) ?? 0) + 1);
          const hostState =
            liveState.hostCounts.get(host) ??
            {
              rawPushFrames: 0,
              smsPushes: 0,
              statusCounts: new Map<string, number>()
            };
          hostState.rawPushFrames += 1;
          if (push.sms) {
            hostState.smsPushes += 1;
          }
          hostState.statusCounts.set(status, (hostState.statusCounts.get(status) ?? 0) + 1);
          liveState.hostCounts.set(host, hostState);
          if (
            runner.appCatchupEnabled &&
            shouldScheduleAppCatchupForFrame(liveState) &&
            Date.now() - lastAppCatchupScheduledAt >= runner.appCatchupIntervalMs
          ) {
            scheduleAppCatchup("direct-frame-gap");
          }
          updateLiveDiagnostic(Boolean(push.sms));
        }
      });
      if (runner.stopped) {
        return { createdMessages, preempted: Boolean(result.preempted), diagnosticNote, listened: true, skippedForConcurrency: false };
      }
      preempted = Boolean(result.preempted);
      directListenCompleted = true;
      diagnosticNote = buildDirectMonitorDiagnosticNote(result, createdMessages);
      if (preempted) {
        logger.info("Direct SMS monitor was preempted by another direct operation; reconnecting shortly", {
          accountId: runner.accountId,
          storedMessages: createdMessages,
          diagnosticNote
        });
      }
    } finally {
      if (appCatchupTimer) {
        clearInterval(appCatchupTimer);
      }
      const pendingAppCatchup = appCatchupState.promise;
      if (pendingAppCatchup) {
        await pendingAppCatchup.catch(() => undefined);
      }
      try {
        diagnosticNote = buildDirectMonitorLiveDiagnosticNote(liveState, createdMessages, preempted, {
          scanned: appCatchupScanned,
          imported: appCatchupImported,
          source: appCatchupSource,
          error: appCatchupError
        }, {
          attempted: offlineCatchupAttempted,
          sent: offlineCatchupSent,
          sendCount: offlineCatchupSendCount,
          error: offlineCatchupError
        }, {
          at: runner.lastDirectSmsAt,
          target: runner.lastDirectSmsTarget
        }, directListenCompleted ? (preempted ? "preempted" : "completed") : "active");
        await diagnosticWriter.flush(diagnosticNote);
      } finally {
        await diagnosticWriter.close();
        activeDirectMonitorPolls = Math.max(0, activeDirectMonitorPolls - 1);
      }
    }
    return { createdMessages, preempted, diagnosticNote, listened: true, skippedForConcurrency: false };
  }

  private async pollHelperMessages(runner: MonitorRunner) {
    const rows = await dumpHelperSmsMessages(Math.max(20, runner.maxRetryCount * 20));
    return rows.length > 0 ? await storeHelperSmsMessages(runner.accountId, rows) : 0;
  }

  private async pollAppFallbackMessages(
    runner: MonitorRunner,
    account: { dtUserId: string; appVariant: AppVariant }
  ) {
    const appVariant = account.appVariant;
    const session = await exportSessionFromAdbConfig(appVariant).catch(() => null);
    if (!session || session.dtUserId !== account.dtUserId) {
      return { source: "app-session-mismatch", scanned: 0, imported: 0 };
    }
    const limit = Math.max(20, runner.maxRetryCount * 20);
    const helperRows = await dumpHelperSmsMessages(limit, appVariant, 8_000).catch(() => []);
    if (helperRows.length > 0) {
      const imported = await storeHelperSmsMessages(runner.accountId, helperRows).catch(() => 0);
      if (imported > 0) {
        return { source: "helper-db", scanned: helperRows.length, imported };
      }
    }

    const adbRows = await dumpSmsMessagesFromAdb(limit, appVariant).catch(() => []);
    if (adbRows.length > 0) {
      const imported = await storeHelperSmsMessages(runner.accountId, adbRows).catch(() => 0);
      if (imported > 0) {
        return { source: "adb-db", scanned: adbRows.length, imported };
      }
    }

    if (!runner.appUiFallbackEnabled) {
      return {
        source: helperRows.length > 0 ? "helper-db" : adbRows.length > 0 ? "adb-db" : "read-only-empty",
        scanned: helperRows.length + adbRows.length,
        imported: 0
      };
    }

    const notificationRows = await dumpSmsMessagesFromNotifications(limit, appVariant).catch(() => []);
    if (notificationRows.length > 0) {
      const imported = await storeHelperSmsMessages(runner.accountId, notificationRows).catch(() => 0);
      if (imported > 0) {
        return { source: "notification-ui", scanned: notificationRows.length, imported };
      }
    }

    await openMessagesInbox(appVariant).catch((error) => {
      logger.warn("Direct monitor app UI fallback failed to open messages inbox", {
        accountId: runner.accountId,
        appVariant,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    const uiRows = filterFreshUiSmsRows(await dumpSmsMessagesFromUi(limit, appVariant).catch(() => []));
    if (uiRows.length > 0) {
      const imported = await storeHelperSmsMessages(runner.accountId, uiRows).catch(() => 0);
      return { source: "adb-ui", scanned: uiRows.length, imported };
    }

    return {
      source: notificationRows.length > 0 ? "notification-ui" : helperRows.length > 0 ? "helper-db" : adbRows.length > 0 ? "adb-db" : "adb-ui",
      scanned: notificationRows.length + helperRows.length + adbRows.length + uiRows.length,
      imported: 0
    };
  }
}

function runSerializedAppFallbackScan<T>(run: () => Promise<T>): Promise<T> {
  appFallbackScanQueue = appFallbackScanQueue.then(run, run);
  const next = appFallbackScanQueue as Promise<T>;
  appFallbackScanQueue = appFallbackScanQueue.then(() => undefined, () => undefined);
  return next;
}

async function notifyAccountMonitorUnavailable(accountId: number, status: "expired" | "offline", reason: string) {
  const account = await prisma.dtAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      nickname: true,
      email: true,
      phone: true,
      dtUserId: true,
      telegramNotify: true,
      appVariant: true,
      loginType: true
    }
  });
  if (!account) return;
  const canVerificationRelogin = account.loginType === "email_code" || account.loginType === "phone_code";
  await sendAccountStatusTelegramNotification(
    { account, status, reason, canVerificationRelogin },
    accountRecoveryKeyboard({
      accountId,
      canVerificationRelogin: status === "expired" && canVerificationRelogin,
      canRestoreMonitor: status === "offline"
    })
  ).catch((error) => {
    logger.warn("Failed to send account recovery Telegram notification", {
      accountId,
      error: error instanceof Error ? error.name : typeof error
    });
  });
}

function sanitizeMonitorDiagnosticError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(
      /([?&]|\b)(token|password|secret|authorization|cookie)\b\s*[:=]\s*(?:Bearer\s+)?[^\s&,;]+/gi,
      "$1$2=[redacted]"
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted-phone]")
    .slice(0, 500);
}

export function sanitizeMonitorDiagnosticErrorForTest(error: unknown) {
  return sanitizeMonitorDiagnosticError(error);
}
function shouldScheduleAppCatchupForFrame(state: DirectMonitorFrameState) {
  return state.smsPushes === 0 && (state.missedStatus0103Sample !== null || state.nonSmsPushFrames >= 2);
}
function filterFreshUiSmsRows(rows: Awaited<ReturnType<typeof dumpSmsMessagesFromUi>>) {
  const freshSince = Date.now() - 7 * 24 * 60 * 60_000;
  return rows.filter((row) => {
    if (row.data3 !== "adb-ui") {
      return true;
    }
    const timestamp = row.time ?? row.timestamp ?? 0;
    return Number.isFinite(timestamp) && timestamp >= freshSince;
  });
}

function buildDirectMonitorDiagnosticNote(result: DirectProbeResult, storedMessages: number) {
  const rawPushFrames = (result.trace ?? []).filter((item) => item.frameType === 0x8107).length;
  const nonSmsPushFrames = Math.max(0, rawPushFrames - result.pushes.length);
  const statusCounts = new Map<string, number>();
  for (const frame of result.trace ?? []) {
    if (frame.frameType !== 0x8107) {
      continue;
    }
    const status = frame.status === undefined ? "unknown" : `0x${frame.status.toString(16).padStart(4, "0")}`;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const statusSummary = Array.from(statusCounts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(",");
  const parts = [
    `host=${result.host}`,
    `raw8107=${rawPushFrames}`,
    `smsPushes=${result.pushes.length}`,
    `nonSms8107=${nonSmsPushFrames}`,
    `stored=${storedMessages}`,
    `listen=${result.preempted ? "preempted" : "completed"}`,
    `offlineTemplate=${result.offlineTemplateSent ? "sent" : result.offlineTemplateAttempted ? "attempted" : "not-attempted"}`,
    `offlineCatchupSends=${result.offlineTemplateSendCount ?? 0}`
  ];
  if (statusSummary) {
    parts.push(`status=${statusSummary}`);
  }
  if (result.offlineTemplateError) {
    parts.push(`offlineTemplateError=${result.offlineTemplateError}`);
  }
  return parts.join("; ");
}

function buildDirectMonitorLiveDiagnosticNote(
  state: DirectMonitorFrameState,
  storedMessages: number,
  preempted: boolean,
  appCatchup?: { scanned: number; imported: number; source: string | null; error: string | null },
  offlineCatchup?: { attempted: boolean; sent: boolean; sendCount: number; error: string | null },
  lastDirectSms?: { at: string | null; target: string | null },
  listenState?: "active" | "completed" | "preempted"
) {
  const statusSummary = Array.from(state.statusCounts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(",");
  const parts = [
    `host=${state.host ?? "pending"}`,
    `raw8107=${state.rawPushFrames}`,
    `smsPushes=${state.smsPushes}`,
    `nonSms8107=${state.nonSmsPushFrames}`,
    `stored=${storedMessages}`,
    `listen=${listenState ?? (preempted ? "preempted" : "active")}`
  ];
  if (state.pairedHosts.size > 0) {
    parts.push(`pairedHosts=${Array.from(state.pairedHosts).sort().join(",")}`);
  }
  if (state.connectingHosts.size > 0) {
    parts.push(`connectingHosts=${Array.from(state.connectingHosts).sort().join(",")}`);
  }
  if (state.failedHosts.size > 0) {
    parts.push(
      `failedHosts=${Array.from(state.failedHosts.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([host, error]) => `${host}:${error}`)
        .join("|")}`
    );
  }
  if (statusSummary) {
    parts.push(`status=${statusSummary}`);
  }
  if (state.missedStatus0103Sample) {
    parts.push(`missed0103=${state.missedStatus0103Sample}`);
  }
  if (offlineCatchup) {
    parts.push(`offlineTemplate=${offlineCatchup.sent ? "sent" : offlineCatchup.attempted ? "attempted" : "not-attempted"}`);
    parts.push(`offlineCatchupSends=${offlineCatchup.sendCount}`);
    if (offlineCatchup.error) {
      parts.push(`offlineTemplateError=${offlineCatchup.error}`);
    }
  }
  if (appCatchup) {
    parts.push(`appCatchup=${appCatchup.source ?? "none"}:${appCatchup.scanned}/${appCatchup.imported}`);
    if (appCatchup.error) {
      parts.push(`appCatchupError=${appCatchup.error}`);
    }
  }
  if (lastDirectSms?.at) {
    parts.push(`lastDirectSmsAt=${lastDirectSms.at}`);
    if (lastDirectSms.target) {
      parts.push(`lastDirectSmsTo=${lastDirectSms.target}`);
    }
  }
  const hostSummary = formatDirectMonitorHostSummary(state.hostCounts);
  if (hostSummary) {
    parts.push(`hosts=${hostSummary}`);
  }
  return parts.join("; ");
}

function formatDirectMonitorHostSummary(hostCounts: DirectMonitorFrameState["hostCounts"]) {
  return Array.from(hostCounts.entries())
    .sort(([leftHost, left], [rightHost, right]) => hostSummaryRank(right) - hostSummaryRank(left) || leftHost.localeCompare(rightHost))
    .slice(0, 8)
    .map(([host, state]) => {
      const statusSummary = Array.from(state.statusCounts.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => `${status}:${count}`)
        .join(",");
      return `${host}(raw=${state.rawPushFrames},sms=${state.smsPushes}${statusSummary ? `,${statusSummary}` : ""})`;
    })
    .join("|");
}

function hostSummaryRank(state: { rawPushFrames: number; smsPushes: number; statusCounts: Map<string, number> }) {
  return state.smsPushes * 1_000_000 + (state.statusCounts.get("0x0103") ?? 0) * 10_000 + state.rawPushFrames;
}

function formatMissedDirectMonitorFrameSample(push: DirectProbePushResult) {
  const bodyHex = push.bodyHex ?? push.bodyHexPreview ?? "";
  const rawHex = push.rawHex ?? push.rawHexPreview ?? "";
  const bodyPreview = bodyHex ? `${bodyHex.slice(0, 1600)}${bodyHex.length > 1600 ? "..." : ""}` : "empty";
  const rawPreview = rawHex ? `${rawHex.slice(0, 240)}${rawHex.length > 240 ? "..." : ""}` : "empty";
  return `body=${push.bodyLength},bodyHex=${bodyPreview},rawHex=${rawPreview}`;
}

function classifyMonitorError(message: string) {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("rest call failed") ||
    normalized.includes("socket closed") ||
    normalized.includes("socket has been ended") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("etimedout")
  ) {
    return "transient";
  }
  if (
    normalized.includes("authen failed") ||
    normalized.includes("deviceid not find") ||
    normalized.includes("60011") ||
    normalized.includes("missing dt_token") ||
    normalized.includes("missing dt_user_id") ||
    normalized.includes("bootstrap failed")
  ) {
    return "expired";
  }
  return "transient";
}

function shouldSurfaceMonitorError(
  message: string,
  classification: ReturnType<typeof classifyMonitorError>,
  consecutiveFailures: number,
  maxRetryCount: number
) {
  if (classification !== "transient") return true;
  return !isRetryableMonitorTransportError(message);
}

export function shouldSurfaceMonitorErrorForTest(message: string, consecutiveFailures: number, maxRetryCount: number) {
  return shouldSurfaceMonitorError(message, classifyMonitorError(message), consecutiveFailures, maxRetryCount);
}

function parsePositiveIntSetting(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeIntSetting(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBooleanSetting(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function shouldRefreshRuntimeData(runner: MonitorRunner) {
  if (!runner.lastRefreshAt) {
    return true;
  }
  return Date.now() - runner.lastRefreshAt >= runner.refreshIntervalMs;
}

async function shouldUseDirectAccountFlow(account: { loginType: string; dtUserId?: string | null; dtToken?: string | null }) {
  const mode = await getGatewayMode();
  return mode === "direct" || account.loginType === "manual_session" || (mode !== "mock" && Boolean(account.dtUserId && account.dtToken));
}

function requireDecryptedToken(value: string) {
  const token = decryptToken(value);
  if (!token) {
    throw new AppError("Missing dt_token", 400, 400);
  }
  return token;
}

function decryptToken(value: string) {
  try {
    // Lazy import avoidance isn't needed here; keep it local and explicit.
    return decryptText(value);
  } catch {
    return null;
  }
}

export const accountMonitorService = new AccountMonitorService();
