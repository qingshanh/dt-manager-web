import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("runtime metrics endpoint is mounted behind administrator authentication", () => {
  assert.match(indexSource, /app\.use\("\/api\/runtime", requireAuth, runtimeRouter\)/);
});
