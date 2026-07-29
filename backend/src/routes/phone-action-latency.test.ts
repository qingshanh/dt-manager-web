import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync(new URL("./accounts.ts", import.meta.url), "utf8");
const coordinator = readFileSync(new URL("../services/phone-action-coordinator.ts", import.meta.url), "utf8");
const reconciliation = readFileSync(new URL("../services/phone-action-reconciliation.ts", import.meta.url), "utf8");
const accountMonitor = readFileSync(new URL("../services/account-monitor.ts", import.meta.url), "utf8");
const accountDetail = readFileSync(new URL("../../../frontend/src/pages/AccountDetail.tsx", import.meta.url), "utf8");
const endpoints = readFileSync(new URL("../../../frontend/src/services/endpoints.ts", import.meta.url), "utf8");

function routeHandler(start: string, end: string) {
  return routes.slice(routes.indexOf(start), routes.indexOf(end));
}

test("renewal reuses a valid stored expiry baseline before opening another direct session", () => {
  assert.match(routes, /parsePhoneExpiry\(phoneItem\.expiredTime\) !== null\s*\? phoneItem\s*:\s*await getDirectPhoneBaseline/);
});

test("renewal persists exact price and balance evidence before one mutation", () => {
  const handler = routeHandler(
    'accountsRouter.post("/:id/phone-numbers/:phoneId/renew"',
    'accountsRouter.put("/:id/phone-numbers/:phoneId/label"'
  );
  assert.match(handler, /resolveStoredRenewalQuote\(phoneItem\)/);
  assert.match(handler, /balanceBefore = await resolvePhoneActionBalance/);
  assert.match(handler, /phoneActionCoordinator\.execute/);
  assert.match(handler, /renewPhoneNumberMutation/);
  assert.doesNotMatch(handler, /pendingPhoneRenewals|schedulePhoneRenewalReconciliation|executeHelperAction/);
});

test("unknown writes become durable awaiting-confirmation operations", () => {
  assert.match(coordinator, /mutation\.outcome === "unknown_after_write"/);
  assert.match(coordinator, /markAwaitingConfirmation/);
  assert.match(reconciliation, /RECONCILE_DELAYS_MS = \[5_000, 20_000, 60_000, 300_000\]/);
  assert.match(reconciliation, /listRecoverablePhoneActionOperations/);
});

test("direct mutations reserve the account monitor through the coordinator", () => {
  assert.match(coordinator, /this\.monitor\.withMaintenance/);
  assert.match(accountMonitor, /async withMaintenance<T>/);
  assert.match(accountMonitor, /preserveMonitorEnabled: true/);
});

test("all panel phone mutations use the durable coordinator and direct session", () => {
  for (const [start, end] of [
    ['accountsRouter.post("/:id/phone-numbers/:phoneId/renew"', 'accountsRouter.put("/:id/phone-numbers/:phoneId/label"'],
    ['accountsRouter.put("/:id/phone-numbers/:phoneId/label"', 'accountsRouter.post("/:id/phone-numbers/:phoneId/cancel"'],
    ['accountsRouter.post("/:id/phone-numbers/:phoneId/cancel"', 'accountsRouter.post("/:id/phone-numbers/:phoneId/pause"'],
    ['accountsRouter.post("/:id/phone-numbers/:phoneId/pause"', 'accountsRouter.post("/:id/phone-numbers/:phoneId/resume"'],
    ['accountsRouter.post("/:id/phone-numbers/:phoneId/resume"', 'accountsRouter.delete("/:id/phone-numbers/:phoneId"']
  ] as const) {
    const handler = routeHandler(start, end);
    assert.match(handler, /phoneActionCoordinator\.execute/);
    assert.match(handler, /appVariant: account\.appVariant/);
    assert.doesNotMatch(handler, /executeHelperAction|verifyDirectPhoneAction/);
  }
});

test("frontend creates one idempotency key and polls durable status", () => {
  const handler = accountDetail.slice(
    accountDetail.indexOf("const phoneAction = async"),
    accountDetail.indexOf("const handleDeletePhone")
  );
  assert.match(handler, /const requestId = crypto\.randomUUID\(\)/);
  assert.match(handler, /pollPhoneOperation\(result\.operation\)/);
  assert.match(accountDetail, /\[2_000, 5_000, 10_000, 20_000, 30_000\]/);
  assert.match(accountDetail, /等待远端确认/);
});

test("interactive phone actions use a short HTTP timeout", () => {
  for (const functionName of ["renewPhoneNumber", "cancelPhoneNumber", "pausePhoneNumber", "resumePhoneNumber"]) {
    const start = endpoints.indexOf(`export async function ${functionName}`);
    const end = endpoints.indexOf("\n}\n", start) + 3;
    const block = endpoints.slice(start, end);
    assert.match(block, /request_id: requestId/);
    assert.match(block, /timeout: 20_000/);
    assert.doesNotMatch(block, /90_000|120_000/);
  }
});
