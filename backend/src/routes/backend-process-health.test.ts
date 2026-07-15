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
  assert.match(supervisorSource, /backend exited; restarting/);
  assert.match(supervisorSource, /setTimeout\(\(\) => \{/);
  assert.doesNotMatch(supervisorSource, /restartTimer\.unref/);
  assert.match(supervisorSource, /spawn\(process\.execPath, \["--import", "tsx", "src\/index\.ts"\]/);
  assert.match(supervisorSource, /process\.on\("SIGTERM"/);
});
test("backend exits nonzero for HTTP listen failures", () => {
  assert.match(indexSource, /error: NodeJS\.ErrnoException/);
  assert.match(indexSource, /error\.code === "EADDRINUSE" \|\| error\.code === "EACCES"/);
  assert.match(indexSource, /process\.exit\(1\)/);
});
