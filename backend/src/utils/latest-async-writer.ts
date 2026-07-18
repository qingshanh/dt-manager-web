export type LatestAsyncWriterOptions = {
  minIntervalMs: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

export type LatestAsyncWriterScheduleOptions = {
  immediate?: boolean;
};

type PendingWrite<T> = {
  value: T;
  immediate: boolean;
};

export class LatestAsyncWriter<T> {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private pending: PendingWrite<T> | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastStartedAt: number | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly sink: (value: T) => Promise<void>,
    options: LatestAsyncWriterOptions
  ) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  schedule(value: T, options: LatestAsyncWriterScheduleOptions = {}) {
    if (this.closed) {
      throw new Error("LatestAsyncWriter is closed");
    }
    const immediate = Boolean(options.immediate) || Boolean(this.pending?.immediate);
    this.pending = { value, immediate };
    if (immediate) {
      this.cancelTimer();
    }
    this.pump();
  }

  async flush(value?: T) {
    if (arguments.length > 0) {
      if (this.closed) {
        throw new Error("LatestAsyncWriter is closed");
      }
      this.pending = { value: value as T, immediate: true };
    } else if (this.pending) {
      this.pending.immediate = true;
    }
    this.cancelTimer();
    while (true) {
      this.pump(true);
      const current = this.inFlight;
      if (current) {
        await current;
        continue;
      }
      if (!this.pending) {
        return;
      }
    }
  }

  close() {
    if (!this.closePromise) {
      this.closed = true;
      this.cancelTimer();
      if (this.pending) {
        this.pending.immediate = true;
      }
      this.closePromise = this.flush();
    }
    return this.closePromise;
  }

  private pump(force = false) {
    if (this.inFlight || !this.pending) {
      return;
    }
    if (force || this.closed || this.pending.immediate || this.lastStartedAt === null) {
      this.startPendingWrite();
      return;
    }
    const waitMs = Math.max(0, this.lastStartedAt + this.minIntervalMs - this.now());
    if (waitMs === 0) {
      this.startPendingWrite();
      return;
    }
    if (this.timer) {
      return;
    }
    const timer = this.setTimer(() => {
      if (this.timer === timer) {
        this.timer = null;
      }
      this.pump();
    }, waitMs);
    this.timer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private startPendingWrite() {
    const pending = this.pending;
    if (!pending || this.inFlight) {
      return;
    }
    this.pending = null;
    this.cancelTimer();
    this.lastStartedAt = this.now();
    let task!: Promise<void>;
    task = (async () => {
      try {
        await this.sink(pending.value);
      } catch {
        // A failed snapshot must not stall later writes.
      } finally {
        if (this.inFlight === task) {
          this.inFlight = null;
        }
        this.pump();
      }
    })();
    this.inFlight = task;
  }

  private cancelTimer() {
    if (!this.timer) {
      return;
    }
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
