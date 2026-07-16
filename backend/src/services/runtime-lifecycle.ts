export type RuntimeShutdownResult = {
  reason: string;
  warnings: string[];
};

type RuntimeLifecycleDependencies = {
  markStopping: () => void;
  stopTelegram: () => void | Promise<void>;
  stopAutoRefresh: () => void | Promise<void>;
  stopExpiryReminder: () => void | Promise<void>;
  stopWorkQueue: () => void | Promise<void>;
  stopAccountMonitor: () => Promise<void>;
  closeHttp: () => Promise<void>;
  forceCloseHttp: () => void;
  closeSse: () => void;
  disconnectPrisma: () => Promise<void>;
  timeoutMs?: number;
};

export class RuntimeLifecycle {
  private readonly timeoutMs: number;
  private shutdownPromise: Promise<RuntimeShutdownResult> | null = null;

  constructor(private readonly dependencies: RuntimeLifecycleDependencies) {
    this.timeoutMs = dependencies.timeoutMs ?? 15_000;
  }

  shutdown(reason: string): Promise<RuntimeShutdownResult> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.executeShutdown(reason);
    }
    return this.shutdownPromise;
  }

  private async executeShutdown(reason: string): Promise<RuntimeShutdownResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];
    invokeSync("mark-stopping", this.dependencies.markStopping, warnings);
    invokeSync("sse", this.dependencies.closeSse, warnings);
    const shutdownTasks = [
      { name: "telegram", promise: invokeAsync(this.dependencies.stopTelegram) },
      { name: "auto-refresh", promise: invokeAsync(this.dependencies.stopAutoRefresh) },
      { name: "expiry-reminder", promise: invokeAsync(this.dependencies.stopExpiryReminder) },
      { name: "work-queue", promise: invokeAsync(this.dependencies.stopWorkQueue) },
      { name: "account-monitor", promise: invokeAsync(this.dependencies.stopAccountMonitor) },
      { name: "http", promise: invokeAsync(this.dependencies.closeHttp) }
    ];
    const settled = Promise.allSettled(shutdownTasks.map((task) => task.promise));
    const waitResult = await waitWithin(settled, remainingBudget(this.timeoutMs, startedAt));
    if (waitResult.timedOut) {
      warnings.push("timeout");
      invokeSync("http-force-close", this.dependencies.forceCloseHttp, warnings);
    } else {
      for (const [index, result] of waitResult.value.entries()) {
        if (result.status === "rejected") {
          const task = shutdownTasks[index];
          warnings.push(task?.name ?? `shutdown-task-${index}`);
        }
      }
    }

    const prismaResult = await waitWithin(
      Promise.allSettled([invokeAsync(this.dependencies.disconnectPrisma)]),
      remainingBudget(this.timeoutMs, startedAt)
    );
    if (prismaResult.timedOut) {
      warnings.push("prisma-timeout");
    } else if (prismaResult.value[0]?.status === "rejected") {
      warnings.push("prisma");
    }
    return { reason, warnings: unique(warnings) };
  }
}

function invokeSync(name: string, action: () => void, warnings: string[]) {
  try {
    action();
  } catch {
    warnings.push(name);
  }
}

async function invokeAsync(action: () => void | Promise<void>) {
  await action();
}

async function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<
  { timedOut: false; value: T } | { timedOut: true }
> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, timeoutMs));
    timer.unref?.();
  });
  const completed = promise.then((value) => ({ timedOut: false as const, value }));
  const result = await Promise.race([completed, timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function remainingBudget(timeoutMs: number, startedAt: number) {
  return Math.max(1, timeoutMs - (Date.now() - startedAt));
}
