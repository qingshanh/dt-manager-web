type RuntimeWorkQueueOptions = {
  concurrency?: number;
  maxPending?: number;
};

type QueueEntry = {
  key: string;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export type RuntimeWorkQueueSnapshot = {
  active: number;
  pending: number;
  rejected: number;
  stopped: boolean;
};

export class RuntimeWorkQueue {
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly pending: QueueEntry[] = [];
  private readonly sharedPromises = new Map<string, Promise<unknown>>();
  private readonly idleWaiters = new Set<() => void>();
  private active = 0;
  private rejected = 0;
  private stopped = false;

  constructor(options: RuntimeWorkQueueOptions = {}) {
    this.concurrency = positiveInteger(options.concurrency, 2, "concurrency");
    this.maxPending = positiveInteger(options.maxPending, 100, "maxPending");
  }

  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return Promise.reject(new Error("Runtime work queue key is required"));
    }
    const shared = this.sharedPromises.get(normalizedKey);
    if (shared) {
      return shared as Promise<T>;
    }
    if (this.stopped) {
      this.rejected += 1;
      return Promise.reject(new Error("Runtime work queue is stopped"));
    }
    if (this.active >= this.concurrency && this.pending.length >= this.maxPending) {
      this.rejected += 1;
      return Promise.reject(new Error("Runtime work queue is full"));
    }

    let resolveEntry!: (value: T | PromiseLike<T>) => void;
    let rejectEntry!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });
    this.sharedPromises.set(normalizedKey, promise);
    this.pending.push({
      key: normalizedKey,
      task: async () => task(),
      resolve: (value) => resolveEntry(value as T),
      reject: rejectEntry
    });
    this.drain();
    return promise;
  }

  stop() {
    this.stopped = true;
    const cancelled = this.pending.splice(0);
    for (const entry of cancelled) {
      this.sharedPromises.delete(entry.key);
      this.rejected += 1;
      entry.reject(new Error("Runtime work queue stopped before execution"));
    }
    return this.whenIdle();
  }

  whenIdle() {
    if (this.active === 0 && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  snapshot(): RuntimeWorkQueueSnapshot {
    return {
      active: this.active,
      pending: this.pending.length,
      rejected: this.rejected,
      stopped: this.stopped
    };
  }

  private drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) {
        return;
      }
      this.active += 1;
      void entry.task()
        .then(
          (value) => this.complete(entry, () => entry.resolve(value)),
          (error) => this.complete(entry, () => entry.reject(error))
        );
    }
  }

  private complete(entry: QueueEntry, settle: () => void) {
    this.active -= 1;
    this.sharedPromises.delete(entry.key);
    this.drain();
    this.resolveIdleWaitersIfNeeded();
    settle();
  }

  private resolveIdleWaitersIfNeeded() {
    if (this.active !== 0 || this.pending.length !== 0) {
      return;
    }
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

export const runtimeWorkQueue = new RuntimeWorkQueue({ concurrency: 2, maxPending: 100 });
