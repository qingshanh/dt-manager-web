import assert from "node:assert/strict";
import test from "node:test";
import { AppVariant, PhoneActionState, PhoneActionType, PhoneStatus, type PhoneActionOperation } from "@prisma/client";
import {
  PhoneActionCoordinator,
  type PhoneActionCoordinatorRepository
} from "./phone-action-coordinator.js";

function operationFixture(overrides: Partial<PhoneActionOperation> = {}): PhoneActionOperation {
  return {
    id: 1,
    accountId: 459,
    phoneId: 4999,
    action: PhoneActionType.renew,
    state: PhoneActionState.prepared,
    appVariant: AppVariant.dingtone,
    idempotencyKey: "request-1",
    activeLockKey: "459:4999:renewal",
    baselineStatus: PhoneStatus.active,
    baselineExpiry: "1784870665873",
    balanceBefore: 19968.55,
    balanceAfter: null,
    quotedPrice: 2000,
    confirmedExpiry: null,
    extensionMonths: 12,
    evidenceAt: null,
    requestFingerprint: null,
    requestPayloadJson: null,
    responseClass: null,
    errorSummary: null,
    confirmationSource: null,
    reconcileAttempts: 0,
    writeStartedAt: null,
    writeCompletedAt: null,
    confirmedAt: null,
    createdAt: new Date("2026-07-26T00:00:00Z"),
    updatedAt: new Date("2026-07-26T00:00:00Z"),
    ...overrides
  };
}

function createFakeRepository(options: { reused?: boolean } = {}) {
  let operation = operationFixture();
  const repository: PhoneActionCoordinatorRepository = {
    create: async () => ({ operation, reused: options.reused ?? false }),
    markWriting: async () => (operation = { ...operation, state: PhoneActionState.writing }),
    markAwaitingConfirmation: async (_id, responseClass, error) =>
      (operation = {
        ...operation,
        state: PhoneActionState.awaiting_confirmation,
        responseClass,
        errorSummary: error ? String(error) : null
      }),
    markConfirmed: async (_id, input) =>
      (operation = {
        ...operation,
        state: PhoneActionState.confirmed,
        activeLockKey: null,
        confirmationSource: input.confirmationSource
      }),
    markFailedBeforeWrite: async (_id, error) =>
      (operation = {
        ...operation,
        state: PhoneActionState.failed_before_write,
        activeLockKey: null,
        errorSummary: String(error)
      }),
    markManualReview: async (_id, error) =>
      (operation = {
        ...operation,
        state: PhoneActionState.manual_review,
        errorSummary: error ? String(error) : null
      }),
    find: async () => operation,
    findActive: async () => operation
  };
  return { repository, getOperation: () => operation };
}

const executeInput = {
  operation: {
    accountId: 459,
    phoneId: 4999,
    action: PhoneActionType.renew,
    appVariant: AppVariant.dingtone,
    idempotencyKey: "request-1",
    baselineStatus: PhoneStatus.active,
    baselineExpiry: "1784870665873",
    balanceBefore: 19968.55,
    quotedPrice: 2000,
    extensionMonths: 12
  }
};

test("returns awaiting confirmation after exactly one unknown write", async () => {
  const writes: string[] = [];
  const maintenance: string[] = [];
  const { repository } = createFakeRepository();
  const coordinator = new PhoneActionCoordinator({
    repository,
    monitor: {
      withMaintenance: async (_accountId, action) => {
        maintenance.push("pause");
        try {
          return await action();
        } finally {
          maintenance.push("restore");
        }
      }
    }
  });

  const result = await coordinator.execute({
    ...executeInput,
    mutate: async () => {
      writes.push("write");
      return { outcome: "unknown_after_write", error: "EOF" };
    }
  });

  assert.deepEqual(writes, ["write"]);
  assert.deepEqual(maintenance, ["pause", "restore"]);
  assert.equal(result.operation.state, PhoneActionState.awaiting_confirmation);
});

test("returns the existing operation without another mutation", async () => {
  const { repository } = createFakeRepository({ reused: true });
  const coordinator = new PhoneActionCoordinator({ repository });
  let writes = 0;

  const result = await coordinator.execute({
    ...executeInput,
    mutate: async () => {
      writes += 1;
      return { outcome: "response", payload: { Result: 1 } };
    }
  });

  assert.equal(writes, 0);
  assert.equal(result.reused, true);
});

test("clears the active lock when mutation fails before write", async () => {
  const { repository, getOperation } = createFakeRepository();
  const coordinator = new PhoneActionCoordinator({ repository });

  const result = await coordinator.execute({
    ...executeInput,
    mutate: async () => {
      throw new Error("protocol is not available");
    }
  });

  assert.equal(result.operation.state, PhoneActionState.failed_before_write);
  assert.equal(getOperation().activeLockKey, null);
});

test("confirms a response only when its classifier provides evidence", async () => {
  const { repository } = createFakeRepository();
  const coordinator = new PhoneActionCoordinator({ repository });

  const result = await coordinator.execute({
    ...executeInput,
    mutate: async () => ({ outcome: "response", payload: { expiredTime: "1785302665873" } }),
    classifyResponse: () => ({ confirmationSource: "renew_response", confirmedExpiry: "1785302665873" })
  });

  assert.equal(result.operation.state, PhoneActionState.confirmed);
  assert.equal(result.operation.confirmationSource, "renew_response");
});

test("keeps the lock when local confirmation handling fails after a response", async () => {
  const { repository } = createFakeRepository();
  const coordinator = new PhoneActionCoordinator({ repository });

  const result = await coordinator.execute({
    ...executeInput,
    mutate: async () => ({ outcome: "response", payload: { Result: 1 } }),
    classifyResponse: () => {
      throw new Error("local evidence parser failed");
    }
  });

  assert.equal(result.operation.state, PhoneActionState.manual_review);
  assert.equal(result.operation.activeLockKey, "459:4999:renewal");
});
