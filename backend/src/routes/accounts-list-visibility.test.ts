import assert from "node:assert/strict";
import test from "node:test";
import { AccountStatus, MessageType } from "@prisma/client";
import {
  accountsRouter,
  buildMessagesWhereForTest,
  otherVerificationAppVariant,
  shouldRetryVerificationWithOtherVariant,
  shouldShowAccountInList
} from "./accounts.js";

test("hides verification-code placeholder accounts until login succeeds", () => {
  assert.equal(
    shouldShowAccountInList({
      status: AccountStatus.pending,
      loginType: "email_code",
      dtUserId: null,
      dtToken: null
    }),
    false
  );
});

test("keeps expired logged-in accounts visible so they can be re-logged in", () => {
  assert.equal(
    shouldShowAccountInList({
      status: AccountStatus.expired,
      loginType: "email_code",
      dtUserId: "145138338218889",
      dtToken: "encrypted-token"
    }),
    true
  );
});

test("retries verification-code send with the other app on app ownership failures", () => {
  assert.equal(otherVerificationAppVariant("dingdong"), "dingtone");
  assert.equal(otherVerificationAppVariant("dingtone"), "dingdong");
  assert.equal(shouldRetryVerificationWithOtherVariant(new Error("Direct registerEmail failed: user exist in other app")), true);
  assert.equal(shouldRetryVerificationWithOtherVariant(new Error("Direct registerEmail failed: REST call failed")), true);
  assert.equal(shouldRetryVerificationWithOtherVariant(new Error("ConfirmCode is not matched")), false);
});

test("message list filters can isolate and exclude system messages", () => {
  assert.deepEqual(buildMessagesWhereForTest(7, { page: 1, pageSize: 20, msg_type: MessageType.system }), {
    accountId: 7,
    msgType: MessageType.system
  });
  assert.deepEqual(buildMessagesWhereForTest(7, { page: 1, pageSize: 20, exclude_system: true }), {
    accountId: 7,
    msgType: { not: MessageType.system }
  });
});
test("account routes include point and point store endpoints", () => {
  const routes = accountsRouter.stack
    .map((layer: { route?: { path?: string; methods?: Record<string, boolean> } }) => layer.route)
    .filter(Boolean)
    .flatMap((route) => Object.keys(route!.methods ?? {}).map((method) => `${method.toUpperCase()} ${route!.path}`));

  assert.ok(routes.includes("GET /:id/point"));
  assert.ok(routes.includes("GET /:id/pointstore"));
  assert.ok(routes.includes("POST /:id/pointstore/order"));
});
