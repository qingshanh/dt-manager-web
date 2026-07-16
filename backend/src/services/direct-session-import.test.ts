import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDirectSessionValidationFailure,
  persistedSessionValidationFailureMessage,
  validateThenPersistDirectSession,
} from "./direct-session-import.js";

const session = { dtUserId: "u1", token: "secret-token", deviceId: "candidate-device" };

test("validates before persisting a direct session", async () => {
  const calls: string[] = [];

  await validateThenPersistDirectSession(session, {
    validate: async () => {
      calls.push("validate");
      return { deviceId: "validated-device", probe: { ok: true } };
    },
    persist: async (value) => {
      calls.push("persist");
      return value;
    },
  });

  assert.deepEqual(calls, ["validate", "persist"]);
});

test("persists the device id selected by successful validation", async () => {
  let persistedDeviceId = "";

  const result = await validateThenPersistDirectSession(session, {
    validate: async () => ({ deviceId: "validated-device", probe: { ok: true } }),
    persist: async (value) => {
      persistedDeviceId = value.deviceId;
      return { accountId: 1, session: value };
    },
  });

  assert.equal(persistedDeviceId, "validated-device");
  assert.equal(result.storedSession.session.deviceId, "validated-device");
  assert.equal(result.validation.deviceId, "validated-device");
});

test("does not persist an invalid or expired token and redacts the underlying error", async () => {
  let persisted = false;

  await assert.rejects(
    validateThenPersistDirectSession(session, {
      validate: async () => {
        throw new Error("401 unauthorized token=secret-token params=device-candidate");
      },
      persist: async (value) => {
        persisted = true;
        return value;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Token 已失效或过期/);
      assert.doesNotMatch(error.message, /secret-token|params|device-candidate/);
      return true;
    },
  );

  assert.equal(persisted, false);
});

test("does not persist when direct validation times out", async () => {
  let persisted = false;

  await assert.rejects(
    validateThenPersistDirectSession(session, {
      validate: async () => null,
      persist: async (value) => {
        persisted = true;
        return value;
      },
    }),
    /Direct 会话校验超时/,
  );

  assert.equal(persisted, false);
});

test("classifies device mismatches without persisting or exposing parameters", async () => {
  let persisted = false;

  await assert.rejects(
    validateThenPersistDirectSession(session, {
      validate: async () => {
        throw new Error("device mismatch deviceId=private-device candidate=secondary-device");
      },
      persist: async (value) => {
        persisted = true;
        return value;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /设备参数与会话不匹配/);
      assert.doesNotMatch(error.message, /private-device|secondary-device|deviceId=/);
      return true;
    },
  );

  assert.equal(persisted, false);
});

test("uses a generic safe message for other direct validation failures", async () => {
  let persisted = false;

  await assert.rejects(
    validateThenPersistDirectSession(session, {
      validate: async () => {
        throw new Error("POST /private/probe payload={credential:secret-value}");
      },
      persist: async (value) => {
        persisted = true;
        return value;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Direct 会话校验失败/);
      assert.doesNotMatch(error.message, /private|payload|secret-value/);
      return true;
    },
  );

  assert.equal(persisted, false);
});

test("classifies persisted-session validation failures without leaking raw errors", () => {
  const cases = [
    {
      error: new Error("401 unauthorized token=private-token payload={account:1}"),
      category: "unauthorized" as const,
      expected: /Token 已失效或过期/,
    },
    {
      error: new Error("device mismatch deviceId=private-device params=secondary-device"),
      category: "device" as const,
      expected: /设备参数与会话不匹配/,
    },
    {
      error: new Error("POST /private/probe payload={credential:private-value}"),
      category: "generic" as const,
      expected: /Direct 会话校验失败/,
    },
  ];

  for (const item of cases) {
    const category = classifyDirectSessionValidationFailure(item.error);
    const safeMessage = persistedSessionValidationFailureMessage(category);
    assert.equal(category, item.category);
    assert.match(safeMessage, item.expected);
    assert.doesNotMatch(safeMessage, /private|payload|params|deviceId=|POST \/|token=/i);
  }

  const timeoutMessage = persistedSessionValidationFailureMessage("timeout");
  assert.match(timeoutMessage, /Direct 会话校验超时/);
  assert.doesNotMatch(timeoutMessage, /token|payload|params|path=/i);
});
