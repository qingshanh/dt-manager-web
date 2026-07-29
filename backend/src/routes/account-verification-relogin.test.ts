import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync(new URL("./accounts.ts", import.meta.url), "utf8");
const list = readFileSync(new URL("../../../frontend/src/pages/AccountList.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("../../../frontend/src/pages/AccountDetail.tsx", import.meta.url), "utf8");
const modal = readFileSync(new URL("../../../frontend/src/components/accounts/VerificationReloginModal.tsx", import.meta.url), "utf8");
const types = readFileSync(new URL("../../../frontend/src/types/index.ts", import.meta.url), "utf8");

test("account responses expose verification login recovery state", () => {
  assert.match(routes, /login_type: item\.loginType/);
  assert.match(routes, /requires_relogin: monitorState\.requiresRelogin/);
  assert.match(routes, /monitor_state: monitorState\.monitorState/);
  assert.match(types, /requires_relogin: boolean;/);
});

test("verification completion restores the account monitor", () => {
  const verifyRoute = routes.slice(
    routes.indexOf('accountsRouter.post("/:id/verify-code"'),
    routes.indexOf('accountsRouter.post("/:id/probe-access-code"')
  );

  assert.match(verifyRoute, /startMonitorAfterVerification/);
  assert.match(verifyRoute, /monitor_started/);
  assert.match(verifyRoute, /monitor_error/);
});

test("failed verification resend restores the previous device binding", () => {
  const resendRoute = routes.slice(
    routes.indexOf('accountsRouter.post("/:id/send-verification-code"'),
    routes.indexOf('accountsRouter.post("/:id/verify-code"')
  );
  const sendHelper = routes.slice(
    routes.indexOf("async function sendVerificationCodeWithFastAck"),
    routes.indexOf("function formatLastError")
  );

  assert.match(resendRoute, /rollbackSession: account\.dtUserId/);
  assert.match(sendHelper, /dtDeviceId: input\.rollbackSession\.deviceId/);
  assert.match(sendHelper, /dtTrackCode: input\.rollbackSession\.trackCode/);
});

test("offline verification accounts can resend and submit a code from list and detail", () => {
  assert.match(list, /VerificationReloginModal/);
  assert.match(list, /requires_relogin/);
  assert.match(detail, /VerificationReloginModal/);
  assert.match(modal, /sendVerificationCode/);
  assert.match(modal, /verifyCode/);
  assert.match(modal, /重新发送验证码/);
});
