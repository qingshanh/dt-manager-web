import {
  PhoneActionState,
  type PhoneActionOperation
} from "@prisma/client";
import { accountMonitorService } from "./account-monitor.js";
import type { DingtonePhoneMutationResult } from "./dingtone/types.js";
import { schedulePhoneActionReconciliation } from "./phone-action-reconciliation.js";
import {
  createPhoneActionOperation,
  findActivePhoneActionOperation,
  findPhoneActionOperation,
  markPhoneActionAwaitingConfirmation,
  markPhoneActionConfirmed,
  markPhoneActionFailedBeforeWrite,
  markPhoneActionManualReview,
  markPhoneActionWriting,
  type ConfirmPhoneActionInput,
  type CreatePhoneActionOperationInput
} from "./phone-action-operation.js";

export interface PhoneActionCoordinatorRepository {
  create(input: CreatePhoneActionOperationInput): Promise<{ operation: PhoneActionOperation; reused: boolean }>;
  markWriting(id: number): Promise<PhoneActionOperation>;
  markAwaitingConfirmation(id: number, responseClass: string, error?: unknown): Promise<PhoneActionOperation>;
  markConfirmed(id: number, input: ConfirmPhoneActionInput): Promise<PhoneActionOperation>;
  markFailedBeforeWrite(id: number, error: unknown): Promise<PhoneActionOperation>;
  markManualReview(id: number, error?: unknown): Promise<PhoneActionOperation>;
  find(id: number): Promise<PhoneActionOperation | null>;
  findActive(accountId: number, phoneId: number): Promise<PhoneActionOperation | null>;
}

export interface PhoneActionMonitorMaintenance {
  withMaintenance<T>(accountId: number, action: () => Promise<T>): Promise<T>;
}

export type PhoneActionConfirmationEvidence = ConfirmPhoneActionInput;

export interface ExecutePhoneActionInput<T extends Record<string, unknown> = Record<string, unknown>> {
  operation: CreatePhoneActionOperationInput;
  mutate: () => Promise<DingtonePhoneMutationResult<T>>;
  classifyResponse?: (payload: T) => PhoneActionConfirmationEvidence | null;
}

export type PhoneActionOperationEnvelope = {
  operation: PhoneActionOperation;
  reused: boolean;
};

type PhoneActionCoordinatorOptions = {
  repository?: PhoneActionCoordinatorRepository;
  monitor?: PhoneActionMonitorMaintenance;
  onAwaitingConfirmation?: (operation: PhoneActionOperation) => void;
};

const defaultRepository: PhoneActionCoordinatorRepository = {
  create: createPhoneActionOperation,
  markWriting: markPhoneActionWriting,
  markAwaitingConfirmation: markPhoneActionAwaitingConfirmation,
  markConfirmed: markPhoneActionConfirmed,
  markFailedBeforeWrite: markPhoneActionFailedBeforeWrite,
  markManualReview: markPhoneActionManualReview,
  find: findPhoneActionOperation,
  findActive: findActivePhoneActionOperation
};

const defaultMonitor: PhoneActionMonitorMaintenance = {
  withMaintenance: (accountId, action) => accountMonitorService.withMaintenance(accountId, action)
};

export class PhoneActionCoordinator {
  private readonly repository: PhoneActionCoordinatorRepository;
  private readonly monitor: PhoneActionMonitorMaintenance;
  private readonly onAwaitingConfirmation?: (operation: PhoneActionOperation) => void;

  constructor(options: PhoneActionCoordinatorOptions = {}) {
    this.repository = options.repository ?? defaultRepository;
    this.monitor = options.monitor ?? defaultMonitor;
    this.onAwaitingConfirmation = options.onAwaitingConfirmation;
  }

  async execute<T extends Record<string, unknown>>(
    input: ExecutePhoneActionInput<T>
  ): Promise<PhoneActionOperationEnvelope> {
    const created = await this.repository.create(input.operation);
    if (created.reused) {
      return created;
    }

    let operation = created.operation;
    let mutationReturned = false;
    try {
      operation = await this.monitor.withMaintenance(input.operation.accountId, async () => {
        await this.repository.markWriting(created.operation.id);
        const mutation = await input.mutate();
        mutationReturned = true;
        if (mutation.outcome === "unknown_after_write") {
          return this.repository.markAwaitingConfirmation(
            created.operation.id,
            "unknown_after_write",
            mutation.error
          );
        }

        const evidence = input.classifyResponse?.(mutation.payload) ?? null;
        if (evidence) {
          return this.repository.markConfirmed(created.operation.id, evidence);
        }

        return this.repository.markAwaitingConfirmation(created.operation.id, "response_unconfirmed");
      });
    } catch (error) {
      operation = mutationReturned
        ? await this.repository.markManualReview(created.operation.id, error)
        : await this.repository.markFailedBeforeWrite(created.operation.id, error);
    }

    if (operation.state === PhoneActionState.awaiting_confirmation) {
      this.onAwaitingConfirmation?.(operation);
    }
    return { operation, reused: false };
  }

  async getOperation(accountId: number, operationId: number): Promise<PhoneActionOperation | null> {
    const operation = await this.repository.find(operationId);
    return operation?.accountId === accountId ? operation : null;
  }

  async getActiveOperation(accountId: number, phoneId: number): Promise<PhoneActionOperation | null> {
    return this.repository.findActive(accountId, phoneId);
  }
}

export const phoneActionCoordinator = new PhoneActionCoordinator({
  onAwaitingConfirmation: (operation) => schedulePhoneActionReconciliation(operation.id)
});
