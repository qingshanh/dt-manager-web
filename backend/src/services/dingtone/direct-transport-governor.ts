import { createHash } from "node:crypto";

export type DirectTransportRole = "push" | "link" | "discovery";

export type DirectTransportPermit = {
  allowed: boolean;
  waitMs: number;
  probe: boolean;
};

type DirectTransportEntry = {
  key: string;
  failures: number;
  state: "closed" | "open";
  nextAttemptAt: number;
  openUntil: number;
  probeInFlight: boolean;
  probeRoles: DirectTransportRole[];
  probeOwner: object | null;
  probeExpiresAt: number;
  lastRole: DirectTransportRole;
  lastTouchedAt: number;
};

type DirectTransportGovernorOptions = {
  minDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  openAfterFailures?: number;
  openDurationMs?: number;
  probeTimeoutMs?: number;
  maxEntries?: number;
  now?: () => number;
  random?: () => number;
};

type DirectTransportAttemptOptions = {
  allowLinkProbe?: boolean;
};

export class DirectTransportGovernor {
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly openAfterFailures: number;
  private readonly openDurationMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly entries = new Map<string, DirectTransportEntry>();

  constructor(options: DirectTransportGovernorOptions = {}) {
    this.minDelayMs = Math.max(1, options.minDelayMs ?? 500);
    this.maxDelayMs = Math.max(this.minDelayMs, options.maxDelayMs ?? 30_000);
    this.jitterRatio = Math.max(0, Math.min(1, options.jitterRatio ?? 0.2));
    this.openAfterFailures = Math.max(1, options.openAfterFailures ?? 5);
    this.openDurationMs = Math.max(1, options.openDurationMs ?? 30_000);
    this.probeTimeoutMs = Math.max(1, options.probeTimeoutMs ?? 30_000);
    this.maxEntries = Math.max(1, options.maxEntries ?? 128);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  beforeAttempt(
    key: string,
    role: DirectTransportRole,
    probeOwner?: object,
    options: DirectTransportAttemptOptions = {}
  ): DirectTransportPermit {
    const entry = this.entries.get(key);
    if (!entry) {
      return { allowed: true, waitMs: 0, probe: false };
    }
    const now = this.now();
    entry.lastRole = role;
    entry.lastTouchedAt = now;
    if (entry.state === "open") {
      if (now < entry.openUntil) {
        return { allowed: false, waitMs: Math.max(1, entry.openUntil - now), probe: false };
      }
      if (entry.probeInFlight && entry.probeExpiresAt > 0 && now >= entry.probeExpiresAt) {
        this.clearProbe(entry);
      }
      if (entry.probeInFlight) {
        const firstRole = entry.probeRoles[0];
        const isPairedCompanion = entry.probeRoles.length === 1
          && entry.probeOwner === probeOwner
          && !entry.probeRoles.includes(role)
          && ((firstRole === "push" && role === "link") || (firstRole === "link" && role === "push"));
        if (isPairedCompanion) {
          entry.probeRoles.push(role);
          return { allowed: true, waitMs: 0, probe: true };
        }
        return { allowed: false, waitMs: this.minDelayMs, probe: false };
      }
      const canStartProbe = role === "push" || (role === "link" && options.allowLinkProbe === true);
      if (!canStartProbe || !probeOwner) {
        return { allowed: false, waitMs: this.minDelayMs, probe: false };
      }
      entry.probeInFlight = true;
      entry.probeRoles = [role];
      entry.probeOwner = probeOwner;
      entry.probeExpiresAt = now + this.probeTimeoutMs;
      return { allowed: true, waitMs: 0, probe: true };
    }
    if (now < entry.nextAttemptAt) {
      return { allowed: false, waitMs: Math.max(1, entry.nextAttemptAt - now), probe: false };
    }
    return { allowed: true, waitMs: 0, probe: false };
  }

  recordFailure(key: string, role: DirectTransportRole) {
    const now = this.now();
    const entry = this.entries.get(key) ?? {
      key,
      failures: 0,
      state: "closed" as const,
      nextAttemptAt: now,
      openUntil: 0,
      probeInFlight: false,
      probeRoles: [],
      probeOwner: null,
      probeExpiresAt: 0,
      lastRole: role,
      lastTouchedAt: now
    };
    entry.failures += 1;
    entry.lastRole = role;
    entry.lastTouchedAt = now;
    this.clearProbe(entry);
    if (entry.failures >= this.openAfterFailures) {
      entry.state = "open";
      entry.openUntil = now + this.openDurationMs;
      entry.nextAttemptAt = entry.openUntil;
    } else {
      entry.state = "closed";
      entry.openUntil = 0;
      const baseDelay = Math.min(this.maxDelayMs, this.minDelayMs * (2 ** (entry.failures - 1)));
      const jitter = 1 + ((this.random() * 2) - 1) * this.jitterRatio;
      entry.nextAttemptAt = now + Math.max(1, Math.min(this.maxDelayMs, Math.round(baseDelay * jitter)));
    }
    this.entries.set(key, entry);
    this.evictOldestEntries();
  }

  recordSuccess(key: string, _role: DirectTransportRole) {
    this.entries.delete(key);
  }

  abandonProbe(key: string, probeOwner: object) {
    const entry = this.entries.get(key);
    if (!entry?.probeInFlight || entry.probeOwner !== probeOwner) {
      return;
    }
    const now = this.now();
    this.clearProbe(entry);
    entry.openUntil = now + this.minDelayMs;
    entry.nextAttemptAt = entry.openUntil;
    entry.lastTouchedAt = now;
  }

  snapshot() {
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      entries: [...this.entries.values()].map(({ probeOwner, ...entry }) => ({
        ...entry,
        probeOwnerActive: probeOwner !== null
      }))
    };
  }

  clear() {
    this.entries.clear();
  }

  private clearProbe(entry: DirectTransportEntry) {
    entry.probeInFlight = false;
    entry.probeRoles = [];
    entry.probeOwner = null;
    entry.probeExpiresAt = 0;
  }

  private evictOldestEntries() {
    while (this.entries.size > this.maxEntries) {
      let oldest: DirectTransportEntry | undefined;
      for (const entry of this.entries.values()) {
        if (!oldest || entry.lastTouchedAt < oldest.lastTouchedAt) {
          oldest = entry;
        }
      }
      if (!oldest) {
        return;
      }
      this.entries.delete(oldest.key);
    }
  }
}

export function buildDirectTransportKey(input: {
  host: string;
  port: number;
  proxyUrl?: string | null;
  accountScope?: string | null;
}) {
  const target = `${input.host.trim().toLowerCase()}:${input.port}`;
  const accountScope = input.accountScope?.trim();
  const scopedTarget = accountScope
    ? `account:${createHash("sha256").update(accountScope).digest("hex").slice(0, 16)}->${target}`
    : target;
  const proxyUrl = input.proxyUrl?.trim();
  if (!proxyUrl) {
    return scopedTarget;
  }
  try {
    const parsed = new URL(proxyUrl);
    const protocol = parsed.protocol.toLowerCase();
    const port = parsed.port || (protocol === "https:" ? "443" : "80");
    return `proxy:${protocol}//${parsed.hostname.toLowerCase()}:${port}->${scopedTarget}`;
  } catch {
    return `proxy:invalid->${scopedTarget}`;
  }
}
