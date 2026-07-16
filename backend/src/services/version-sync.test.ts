import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");
const expectedVersion = "0.2.8";

test("release version stays synchronized across production entry points", () => {
  assert.equal(read("VERSION").trim(), expectedVersion);
  assert.equal(JSON.parse(read("backend/package.json")).version, expectedVersion);
  assert.equal(JSON.parse(read("backend/package-lock.json")).version, expectedVersion);
  assert.equal(JSON.parse(read("backend/package-lock.json")).packages[""].version, expectedVersion);
  assert.equal(JSON.parse(read("frontend/package.json")).version, expectedVersion);
  assert.equal(JSON.parse(read("frontend/package-lock.json")).version, expectedVersion);
  assert.equal(JSON.parse(read("frontend/package-lock.json")).packages[""].version, expectedVersion);
  assert.match(read("backend/src/config.ts"), /APP_VERSION: z\.string\(\)\.default\("0\.2\.8"\)/);
  assert.match(read("frontend/vite.config.ts"), /'0\.2\.8'/);
  assert.match(read("frontend/Dockerfile"), /ARG APP_VERSION=0\.2\.8/);
  assert.match(read("docker-compose.yml"), /APP_VERSION: \$\{APP_VERSION:-0\.2\.8\}/);
  assert.match(read("docker-compose.yml"), /VITE_APP_VERSION: \$\{VITE_APP_VERSION:-0\.2\.8\}/);
  assert.match(read("start.ps1"), /APP_VERSION" -Default "0\.2\.8"/);
  assert.match(read(".env.example"), /APP_VERSION=0\.2\.8/);
  assert.match(read(".env.example"), /VITE_APP_VERSION=0\.2\.8/);
});
