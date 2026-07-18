import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./account-monitor.ts", import.meta.url), "utf8");

test("direct monitor diagnostics use one latest-only writer and one Prisma route sink", () => {
  assert.match(source, /import \{ LatestAsyncWriter \} from "\.\.\/utils\/latest-async-writer\.js"/);
  const pollStart = source.indexOf("private async pollDirectMessages(");
  const pollEnd = source.indexOf("private async pollHelperMessages", pollStart);
  const pollText = pollStart >= 0 && pollEnd > pollStart ? source.slice(pollStart, pollEnd) : "";
  assert.match(pollText, /new LatestAsyncWriter<string>\(async \(note\) =>/);
  assert.match(pollText, /routeAddress: note/);
  assert.match(pollText, /minIntervalMs: 10_000/);
  assert.equal((pollText.match(/routeAddress:/g) ?? []).length, 1);
});

test("live diagnostic callbacks only build and schedule snapshots while SMS is immediate", () => {
  const updateStart = source.indexOf("const updateLiveDiagnostic =");
  const updateEnd = source.indexOf("activeDirectMonitorPolls += 1", updateStart);
  const updateText = updateStart >= 0 && updateEnd > updateStart ? source.slice(updateStart, updateEnd) : "";
  assert.match(updateText, /diagnosticNote = buildDirectMonitorLiveDiagnosticNote/);
  assert.match(updateText, /diagnosticWriter\.schedule\(diagnosticNote, \{ immediate \}\)/);
  assert.doesNotMatch(updateText, /prisma\.monitorSession\.update/);

  const onPushStart = source.indexOf("onPush: async");
  const onPushEnd = source.indexOf("onWebOfflineMessages:", onPushStart);
  assert.match(source.slice(onPushStart, onPushEnd), /updateLiveDiagnostic\(true\)/);
  const callbacksEnd = source.indexOf("if \(runner\.stopped\)", onPushEnd);
  const callbackText = source.slice(onPushStart, callbacksEnd);
  assert.doesNotMatch(callbackText, /routeAddress|prisma\.monitorSession\.update/);
});

test("direct monitor finally flushes one final diagnostic and closes its writer", () => {
  const pollStart = source.indexOf("private async pollDirectMessages(");
  const pendingCatchup = source.indexOf("const pendingAppCatchup", pollStart);
  const finallyStart = source.lastIndexOf("} finally {", pendingCatchup);
  const finallyEnd = source.indexOf("activeDirectMonitorPolls =", finallyStart);
  const finallyText = finallyStart >= 0 && finallyEnd > finallyStart ? source.slice(finallyStart, finallyEnd) : "";
  assert.match(finallyText, /await diagnosticWriter\.flush\(diagnosticNote\)/);
  assert.match(finallyText, /await diagnosticWriter\.close\(\)/);
  assert.doesNotMatch(finallyText, /prisma\.monitorSession\.update|routeAddress:/);
  assert.match(source, /sanitizeMonitorDiagnosticError\(error\)/);
});

test("diagnostic writer errors redact credentials and personal targets", async () => {
  const { sanitizeMonitorDiagnosticErrorForTest } = await import("./account-monitor.js");
  const sanitized = sanitizeMonitorDiagnosticErrorForTest(
    new Error(
      "token: sample-token password = sample-password secret: sample-secret cookie=sample-cookie "
      + "Authorization=Bearer sample-auth user@example.com +12025550123"
    )
  );
  assert.doesNotMatch(
    sanitized,
    /sample-token|sample-password|sample-secret|sample-cookie|sample-auth|user@example\.test|12025550123/
  );
  assert.match(sanitized, /redacted/i);
});

test("diagnostic writer consumes query credentials and complete Bearer values", async () => {
  const { sanitizeMonitorDiagnosticErrorForTest } = await import("./account-monitor.js");
  const sanitized = sanitizeMonitorDiagnosticErrorForTest(
    "https://example.test/path?token=query-token&cookie=query-cookie "
    + "Authorization: Bearer bearer-value password: colon-password secret=equals-secret"
  );
  assert.doesNotMatch(
    sanitized,
    /query-token|query-cookie|bearer-value|colon-password|equals-secret/
  );
  assert.match(sanitized, /\?token=\[redacted\]/);
  assert.match(sanitized, /Authorization=\[redacted\]/i);
  const bounded = sanitizeMonitorDiagnosticErrorForTest(`token=long-token ${"x".repeat(600)}`);
  assert.equal(bounded.length, 500);
  assert.doesNotMatch(bounded, /long-token/);
});
