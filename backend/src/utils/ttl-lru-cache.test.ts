import assert from "node:assert/strict";
import test from "node:test";
import { TtlLruCache } from "./ttl-lru-cache.js";

test("ttl lru cache evicts the least recently used entry", () => {
  let now = 1_000;
  const cache = new TtlLruCache<string, number>({ maxEntries: 2, ttlMs: 1_000, now: () => now });

  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);

  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.size, 2);
});

test("ttl lru cache expires entries and supports explicit deletion", () => {
  let now = 1_000;
  const cache = new TtlLruCache<string, number>({ maxEntries: 2, ttlMs: 1_000, now: () => now });

  cache.set("a", 1);
  now += 1_001;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 0);

  cache.set("b", 2);
  assert.equal(cache.delete("b"), true);
  assert.equal(cache.size, 0);
});

test("ttl lru cache refreshes an entry's ttl when it is touched", () => {
  let now = 1_000;
  const cache = new TtlLruCache<string, number>({ maxEntries: 2, ttlMs: 1_000, now: () => now });

  cache.set("a", 1);
  now = 1_900;
  assert.equal(cache.get("a"), 1);
  now = 2_001;
  assert.equal(cache.get("a"), 1);
  now = 3_002;
  assert.equal(cache.get("a"), undefined);
});
