type CacheEntry<T> = {
  value: T;
  updatedAt: number;
};

const CACHE_PREFIX = 'dt-manager-cache:';
const DEFAULT_MAX_AGE_MS = 30 * 60_000;
const memoryCache = new Map<string, CacheEntry<unknown>>();

export function makeCacheKey(scope: string, params?: unknown) {
  return params === undefined ? scope : `${scope}:${stableStringify(params)}`;
}

export function readCachedData<T>(key: string, maxAgeMs = DEFAULT_MAX_AGE_MS): T | null {
  const entry = readCacheEntry<T>(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.updatedAt > maxAgeMs) {
    invalidateCachedData(key);
    return null;
  }
  return entry.value;
}

export function isCachedDataFresh(key: string, ttlMs: number) {
  const entry = readCacheEntry(key);
  return Boolean(entry && Date.now() - entry.updatedAt <= ttlMs);
}

export function writeCachedData<T>(key: string, value: T) {
  const entry: CacheEntry<T> = { value, updatedAt: Date.now() };
  memoryCache.set(key, entry);
  try {
    localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(entry));
  } catch {
    // Memory cache is enough when storage is unavailable or full.
  }
}

export async function fetchCachedData<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  options?: { force?: boolean },
) {
  if (!options?.force && isCachedDataFresh(key, ttlMs)) {
    const cached = readCachedData<T>(key);
    if (cached !== null) {
      return cached;
    }
  }
  const value = await loader();
  writeCachedData(key, value);
  return value;
}

export function invalidateCachedData(prefix?: string) {
  if (!prefix) {
    memoryCache.clear();
    removeStorageKeys('');
    return;
  }
  for (const key of Array.from(memoryCache.keys())) {
    if (key === prefix || key.startsWith(prefix)) {
      memoryCache.delete(key);
    }
  }
  removeStorageKeys(prefix);
}

function readCacheEntry<T>(key: string): CacheEntry<T> | null {
  const memoryEntry = memoryCache.get(key) as CacheEntry<T> | undefined;
  if (memoryEntry) {
    return memoryEntry;
  }
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed || typeof parsed.updatedAt !== 'number' || !('value' in parsed)) {
      return null;
    }
    memoryCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function removeStorageKeys(prefix: string) {
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const storageKey = localStorage.key(index);
      if (!storageKey?.startsWith(CACHE_PREFIX)) {
        continue;
      }
      const cacheKey = storageKey.slice(CACHE_PREFIX.length);
      if (!prefix || cacheKey === prefix || cacheKey.startsWith(prefix)) {
        localStorage.removeItem(storageKey);
      }
    }
  } catch {
    // Ignore storage cleanup failures.
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}