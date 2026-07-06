import assert from "node:assert/strict";
import test from "node:test";

import { buildRegisterEmailTemplateParamsForTest, patchQueryForTest, registerEmailIdentityAttemptsForVariant } from "./direct-gateway.js";

test("tries more than one native Dingdong identity for registerEmail", () => {
  const attempts = registerEmailIdentityAttemptsForVariant("dingdong");

  assert.ok(attempts.length >= 3);
  assert.ok(attempts.some((item) => item.appType === 3 && item.appId === "me.dingtone.app.im"));
  assert.ok(attempts.some((item) => item.appType === 3 && item.appId === "me.dingtone.im"));
  assert.ok(attempts.every((item) => item.clientInfoAppId === "me.dingtone.app.im"));
  assert.ok(attempts.every((item) => item.appId !== "me.talkyou.app.im"));
});

test("appends missing registerEmail identity fields to captured templates", () => {
  const templateQuery = "deviceId=old&TrackCode=old&json=%7B%7D&clientInfo=%7B%7D";
  const params = buildRegisterEmailTemplateParamsForTest(
    "deviceId=next&appType=2&appId=me.dingtone.app.im&TrackCode=track&json=%7B%7D&clientInfo=%7B%7D"
  );

  const patched = patchQueryForTest(templateQuery, params);

  assert.match(patched, /(?:^|&)appType=2(?:&|$)/);
  assert.match(patched, /(?:^|&)appId=me\.dingtone\.app\.im(?:&|$)/);
});
