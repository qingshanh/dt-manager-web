import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const supervisorSource = readFileSync(new URL("../../scripts/dev-supervisor.mjs", import.meta.url), "utf8");

test("backend dev script supervises the service process", () => {
  assert.equal(packageJson.scripts.dev, "node scripts/dev-supervisor.mjs");
  assert.equal(packageJson.scripts["dev:raw"], "tsx src/index.ts");
  assert.equal(packageJson.scripts["dev:watch"], "tsx watch src/index.ts");
  assert.doesNotMatch(packageJson.scripts.dev, /tsx\s+watch/);
});

test("backend logs process-level failures instead of disappearing silently", () => {
  assert.match(indexSource, /process\.on\("unhandledRejection"/);
  assert.match(indexSource, /process\.on\("uncaughtException"/);
  assert.match(indexSource, /Backend HTTP server error/);
  assert.match(indexSource, /server\.on\("error"/);
});
test("backend dev supervisor restarts the service after unexpected exits", () => {
  assert.match(supervisorSource, /nextRestartDecision/);
  assert.match(supervisorSource, /backend exited; restart scheduled/);
  assert.match(supervisorSource, /setTimeout\(\(\) => \{/);
  assert.doesNotMatch(supervisorSource, /restartTimer\.unref/);
  assert.match(supervisorSource, /spawn\(process\.execPath, \["--import", "tsx", "src\/index\.ts"\]/);
  assert.match(supervisorSource, /process\.on\("SIGTERM"/);
  assert.match(supervisorSource, /clearTimeout\(restartTimer\)/);
  assert.match(supervisorSource, /circuit-breaker/);
});
test("backend exits nonzero for HTTP listen failures", () => {
  assert.match(indexSource, /error: NodeJS\.ErrnoException/);
  assert.match(indexSource, /error\.code === "EADDRINUSE" \|\| error\.code === "EACCES"/);
  assert.match(indexSource, /FATAL_LISTEN_EXIT_CODE/);
  assert.match(indexSource, /requestRuntimeShutdown\?\.\("listen-fatal", FATAL_LISTEN_EXIT_CODE\)/);
  assert.doesNotMatch(indexSource, /process\.exit\(\)/);
});

test("backend wires SIGTERM through the idempotent shutdown coordinator", () => {
  assert.match(indexSource, /new RuntimeLifecycle\(/);
  assert.match(indexSource, /process\.once\("SIGINT"/);
  assert.match(indexSource, /process\.once\("SIGTERM"/);
  assert.match(indexSource, /telegramBotService\.stop\(\)/);
  assert.match(indexSource, /stopWorkQueue:\s*\(\) => undefined/);
  assert.match(indexSource, /closeAllSseConnections/);
  assert.match(indexSource, /prisma\.\$disconnect\(\)/);
  assert.match(indexSource, /const hardExitTimer = setTimeout/);
  assert.match(indexSource, /hardExitTimer\.unref\(\)/);
  assert.match(indexSource, /process\.exit\(shutdownExitCode\)/);
});
