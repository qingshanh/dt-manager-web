export type AppFallbackProbeResult<T> =
  | { status: "available"; value: T }
  | { status: "unavailable"; value: null }
  | { status: "cooldown"; value: null };

type AppFallbackProbeGateOptions = {
  cooldownMs?: number;
  now?: () => number;
};

export class AppFallbackProbeGate {
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private inFlight: Promise<AppFallbackProbeResult<unknown>> | null = null;
  private cooldownUntil = 0;

  constructor(options: AppFallbackProbeGateOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async probe<T>(run: () => Promise<T | null>): Promise<AppFallbackProbeResult<T>> {
    if (this.now() < this.cooldownUntil) {
      return { status: "cooldown", value: null };
    }
    if (this.inFlight) {
      return this.inFlight as Promise<AppFallbackProbeResult<T>>;
    }

    const probe = (async (): Promise<AppFallbackProbeResult<T>> => {
      const value = await run();
      if (value === null) {
        this.cooldownUntil = this.now() + this.cooldownMs;
        return { status: "unavailable", value: null };
      }
      return { status: "available", value };
    })();
    this.inFlight = probe;
    try {
      return await probe;
    } finally {
      if (this.inFlight === probe) {
        this.inFlight = null;
      }
    }
  }

  snapshot() {
    return {
      cooldownUntil: this.cooldownUntil,
      probeInFlight: this.inFlight !== null
    };
  }
}

export function resolveAppFallbackAllowed(value: string | boolean | undefined) {
  if (typeof value === "boolean") {
    return value;
  }
  return ["true", "1", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}
