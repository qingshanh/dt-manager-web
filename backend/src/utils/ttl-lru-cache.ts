type TtlLruCacheOptions = {
  maxEntries: number;
  ttlMs: number;
  now?: () => number;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export class TtlLruCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TtlLruCacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("TtlLruCache maxEntries must be a positive integer");
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 1) {
      throw new RangeError("TtlLruCache ttlMs must be positive");
    }
    this.maxEntries = options.maxEntries;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  get(key: K) {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    entry.expiresAt = this.now() + this.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V) {
    this.pruneExpired();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
    return this;
  }

  delete(key: K) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    this.pruneExpired();
    return this.entries.size;
  }

  private pruneExpired() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
