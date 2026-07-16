export type BackgroundLoopOptions = {
  initialDelayMs: number;
  defaultDelayMs: number;
  task: () => Promise<number | void>;
  onError?: (error: unknown) => void;
  unref?: boolean;
  stopWaitTimeoutMs?: number;
};

export class BackgroundLoop {
  private timer: NodeJS.Timeout | null = null;
  private runningPromise: Promise<void> | null = null;
  private started = false;
  private stopping = false;
  private generation = 0;

  constructor(private readonly options: BackgroundLoopOptions) {}

  start() {
    if (this.started && !this.stopping) {
      return;
    }
    this.started = true;
    this.stopping = false;
    const generation = ++this.generation;
    this.schedule(this.options.initialDelayMs, generation);
  }

  async stop() {
    this.started = false;
    this.stopping = true;
    this.generation += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const runningPromise = this.runningPromise;
    if (!runningPromise) {
      return;
    }
    await waitForCompletion(runningPromise, this.options.stopWaitTimeoutMs ?? 5_000);
  }

  private schedule(delayMs: number, generation: number) {
    if (!this.isActive(generation)) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick(generation);
    }, normalizeDelay(delayMs, this.options.defaultDelayMs));
    if (this.options.unref) {
      this.timer.unref?.();
    }
  }

  private async tick(generation: number) {
    if (!this.isActive(generation)) {
      return;
    }
    if (this.runningPromise) {
      this.schedule(this.options.defaultDelayMs, generation);
      return;
    }

    const runningPromise = this.runTask(generation);
    this.runningPromise = runningPromise;
    try {
      await runningPromise;
    } finally {
      if (this.runningPromise === runningPromise) {
        this.runningPromise = null;
      }
    }
  }

  private async runTask(generation: number) {
    let nextDelayMs = this.options.defaultDelayMs;
    try {
      const requestedDelayMs = await this.options.task();
      if (requestedDelayMs !== undefined) {
        nextDelayMs = normalizeDelay(requestedDelayMs, this.options.defaultDelayMs);
      }
    } catch (error) {
      try {
        this.options.onError?.(error);
      } catch {
        // A reporting failure must not break the loop lifecycle.
      }
    } finally {
      if (this.isActive(generation)) {
        this.schedule(nextDelayMs, generation);
      }
    }
  }

  private isActive(generation: number) {
    return this.started && !this.stopping && this.generation === generation;
  }
}

function normalizeDelay(value: number, fallback: number) {
  return Number.isFinite(value) && value >= 0 ? value : Math.max(0, fallback);
}

async function waitForCompletion(promise: Promise<void>, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return;
  }
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
