import {
  PhoneActionState,
  PhoneActionType,
  Prisma,
  type AppVariant,
  type PhoneActionOperation,
  type PhoneStatus
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export type PhoneActionFamily = "renewal" | "cancellation" | "settings" | "reactivation";

export interface CreatePhoneActionOperationInput {
  accountId: number;
  phoneId: number;
  action: PhoneActionType;
  appVariant: AppVariant;
  idempotencyKey: string;
  baselineStatus?: PhoneStatus | null;
  baselineExpiry?: string | null;
  balanceBefore?: number | null;
  quotedPrice?: number | null;
  extensionMonths?: number | null;
  requestFingerprint?: string | null;
  requestPayload?: Record<string, unknown> | null;
}

export interface ConfirmPhoneActionInput {
  confirmationSource: string;
  responseClass?: string | null;
  balanceAfter?: number | null;
  confirmedExpiry?: string | null;
  extensionMonths?: number | null;
  evidenceAt?: Date;
}

export interface ConfirmPhoneActionNoEffectInput {
  confirmationSource: string;
  balanceAfter: number;
  observedExpiry: string;
  evidenceAt?: Date;
}

const transitions: Record<PhoneActionState, readonly PhoneActionState[]> = {
  prepared: ["writing", "failed_before_write"],
  writing: ["awaiting_confirmation", "confirmed", "failed_before_write", "manual_review"],
  awaiting_confirmation: ["confirmed", "manual_review"],
  confirmed: [],
  confirmed_no_effect: [],
  failed_before_write: [],
  manual_review: ["confirmed", "confirmed_no_effect"]
};

export function assertRenewalNoEffectEvidence(
  operation: Pick<PhoneActionOperation, "state" | "action" | "baselineExpiry" | "balanceBefore">,
  input: Pick<ConfirmPhoneActionNoEffectInput, "balanceAfter" | "observedExpiry">
): void {
  if (operation.state !== PhoneActionState.manual_review) {
    throw new Error("Only a renewal in manual review can be confirmed as no effect");
  }
  if (operation.action !== PhoneActionType.renew) {
    throw new Error("Only renewal operations can use renewal no-effect evidence");
  }
  if (!operation.baselineExpiry || input.observedExpiry !== operation.baselineExpiry) {
    throw new Error("Renewal expiry changed or baseline expiry is unavailable");
  }
  if (
    operation.balanceBefore === null
    || !Number.isFinite(operation.balanceBefore)
    || !Number.isFinite(input.balanceAfter)
    || Math.abs(input.balanceAfter - operation.balanceBefore) > 0.0001
  ) {
    throw new Error("Renewal balance changed or baseline balance is unavailable");
  }
}

export function phoneActionFamily(action: PhoneActionType): PhoneActionFamily {
  if (action === PhoneActionType.renew) return "renewal";
  if (action === PhoneActionType.cancel) return "cancellation";
  if (action === PhoneActionType.reactivate) return "reactivation";
  return "settings";
}

export function activePhoneActionLockKey(accountId: number, phoneId: number, action: PhoneActionType): string {
  return `${accountId}:${phoneId}:${phoneActionFamily(action)}`;
}

export function canTransitionPhoneAction(from: PhoneActionState, to: PhoneActionState): boolean {
  return transitions[from].includes(to);
}

export function sanitizePhoneActionError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "Unknown phone action error");
  return message
    .replace(/\+?\d{8,}/g, "***")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "***")
    .slice(0, 500);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function findExistingOperation(input: CreatePhoneActionOperationInput): Promise<PhoneActionOperation | null> {
  return prisma.phoneActionOperation.findFirst({
    where: {
      OR: [
        { idempotencyKey: input.idempotencyKey },
        { activeLockKey: activePhoneActionLockKey(input.accountId, input.phoneId, input.action) }
      ]
    },
    orderBy: { createdAt: "desc" }
  });
}

export async function createPhoneActionOperation(
  input: CreatePhoneActionOperationInput
): Promise<{ operation: PhoneActionOperation; reused: boolean }> {
  const existing = await findExistingOperation(input);
  if (existing) return { operation: existing, reused: true };

  try {
    const operation = await prisma.phoneActionOperation.create({
      data: {
        accountId: input.accountId,
        phoneId: input.phoneId,
        action: input.action,
        appVariant: input.appVariant,
        idempotencyKey: input.idempotencyKey,
        activeLockKey: activePhoneActionLockKey(input.accountId, input.phoneId, input.action),
        baselineStatus: input.baselineStatus ?? null,
        baselineExpiry: input.baselineExpiry ?? null,
        balanceBefore: input.balanceBefore ?? null,
        quotedPrice: input.quotedPrice ?? null,
        extensionMonths: input.extensionMonths ?? null,
        requestFingerprint: input.requestFingerprint ?? null,
        requestPayloadJson: input.requestPayload ? JSON.stringify(input.requestPayload) : null
      }
    });
    return { operation, reused: false };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await findExistingOperation(input);
    if (!raced) throw error;
    return { operation: raced, reused: true };
  }
}

async function transitionPhoneActionOperation(
  id: number,
  to: PhoneActionState,
  data: Prisma.PhoneActionOperationUpdateInput = {}
): Promise<PhoneActionOperation> {
  const current = await prisma.phoneActionOperation.findUnique({ where: { id } });
  if (!current) throw new Error(`Phone action operation ${id} was not found`);
  if (!canTransitionPhoneAction(current.state, to)) {
    throw new Error(`Invalid phone action transition ${current.state} -> ${to}`);
  }

  return prisma.phoneActionOperation.update({
    where: { id },
    data: {
      ...data,
      state: to,
      activeLockKey:
        to === PhoneActionState.confirmed
          || to === PhoneActionState.confirmed_no_effect
          || to === PhoneActionState.failed_before_write
          ? null
          : current.activeLockKey
    }
  });
}

export async function markPhoneActionWriting(id: number): Promise<PhoneActionOperation> {
  return transitionPhoneActionOperation(id, PhoneActionState.writing, {
    writeStartedAt: new Date(),
    errorSummary: null
  });
}

export async function markPhoneActionAwaitingConfirmation(
  id: number,
  responseClass: string,
  error?: unknown
): Promise<PhoneActionOperation> {
  return transitionPhoneActionOperation(id, PhoneActionState.awaiting_confirmation, {
    writeCompletedAt: new Date(),
    responseClass,
    errorSummary: error === undefined ? null : sanitizePhoneActionError(error)
  });
}

export async function markPhoneActionConfirmed(
  id: number,
  input: ConfirmPhoneActionInput
): Promise<PhoneActionOperation> {
  return transitionPhoneActionOperation(id, PhoneActionState.confirmed, {
    confirmationSource: input.confirmationSource,
    responseClass: input.responseClass ?? undefined,
    balanceAfter: input.balanceAfter ?? undefined,
    confirmedExpiry: input.confirmedExpiry ?? undefined,
    extensionMonths: input.extensionMonths ?? undefined,
    evidenceAt: input.evidenceAt ?? new Date(),
    confirmedAt: new Date(),
    writeCompletedAt: new Date(),
    errorSummary: null
  });
}

export async function markPhoneActionConfirmedNoEffect(
  id: number,
  input: ConfirmPhoneActionNoEffectInput
): Promise<PhoneActionOperation> {
  const current = await prisma.phoneActionOperation.findUnique({ where: { id } });
  if (!current) throw new Error(`Phone action operation ${id} was not found`);
  assertRenewalNoEffectEvidence(current, input);

  return transitionPhoneActionOperation(id, PhoneActionState.confirmed_no_effect, {
    confirmationSource: input.confirmationSource,
    responseClass: "confirmed_no_effect",
    balanceAfter: input.balanceAfter,
    confirmedExpiry: input.observedExpiry,
    evidenceAt: input.evidenceAt ?? new Date(),
    confirmedAt: new Date(),
    writeCompletedAt: current.writeCompletedAt ?? new Date(),
    errorSummary: null
  });
}

export async function markPhoneActionFailedBeforeWrite(id: number, error: unknown): Promise<PhoneActionOperation> {
  return transitionPhoneActionOperation(id, PhoneActionState.failed_before_write, {
    responseClass: "failed_before_write",
    errorSummary: sanitizePhoneActionError(error),
    writeCompletedAt: new Date()
  });
}

export async function markPhoneActionManualReview(id: number, error?: unknown): Promise<PhoneActionOperation> {
  const current = await prisma.phoneActionOperation.findUnique({ where: { id } });
  if (!current) throw new Error(`Phone action operation ${id} was not found`);
  if (current.state === PhoneActionState.manual_review) return current;
  return transitionPhoneActionOperation(id, PhoneActionState.manual_review, {
    responseClass: "manual_review",
    errorSummary: error === undefined ? current.errorSummary : sanitizePhoneActionError(error)
  });
}

export async function incrementPhoneActionReconcileAttempts(id: number): Promise<PhoneActionOperation> {
  return prisma.phoneActionOperation.update({
    where: { id },
    data: { reconcileAttempts: { increment: 1 } }
  });
}

export async function updatePhoneActionAuditEvidence(
  id: number,
  input: {
    balanceAfter?: number | null;
    confirmedExpiry?: string | null;
    extensionMonths?: number | null;
    evidenceAt?: Date;
  }
): Promise<PhoneActionOperation> {
  return prisma.phoneActionOperation.update({
    where: { id },
    data: {
      balanceAfter: input.balanceAfter ?? undefined,
      confirmedExpiry: input.confirmedExpiry ?? undefined,
      extensionMonths: input.extensionMonths ?? undefined,
      evidenceAt: input.evidenceAt ?? new Date()
    }
  });
}

export async function findPhoneActionOperation(id: number): Promise<PhoneActionOperation | null> {
  return prisma.phoneActionOperation.findUnique({ where: { id } });
}

export async function findActivePhoneActionOperation(
  accountId: number,
  phoneId: number
): Promise<PhoneActionOperation | null> {
  return prisma.phoneActionOperation.findFirst({
    where: {
      accountId,
      phoneId,
      activeLockKey: { not: null }
    },
    orderBy: { createdAt: "desc" }
  });
}

export async function listRecoverablePhoneActionOperations(): Promise<PhoneActionOperation[]> {
  return prisma.phoneActionOperation.findMany({
    where: {
      state: { in: [PhoneActionState.writing, PhoneActionState.awaiting_confirmation] }
    },
    orderBy: { updatedAt: "asc" }
  });
}
