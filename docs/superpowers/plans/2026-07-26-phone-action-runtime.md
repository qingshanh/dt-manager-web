# Reliable Phone Action Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make renewal, cancellation, pause, resume, label updates, and SMS reception repair fast, restart-safe, variant-aware, auditable, and incapable of repeating a state-changing write after an unknown gateway outcome.

**Architecture:** Persist every phone mutation as a `PhoneActionOperation`, execute it through an action-specific coordinator with a single-write boundary, and confirm it through read-only reconciliation. The frontend receives an operation envelope immediately and polls durable status instead of holding an HTTP request open through multiple direct sessions.

**Tech Stack:** TypeScript, Node.js, Express, Prisma 6, SQLite, React 18, Ant Design, Axios, Node test runner with `tsx`.

**Repository rule:** Do not create Git commits while executing this plan because the shared worktree already contains substantial uncommitted user changes. Use focused `git diff --check` and test checkpoints instead.

---

## File Map

- Create `backend/src/services/phone-action-operation.ts`: persistent operation state machine and Prisma repository.
- Create `backend/src/services/phone-action-operation.test.ts`: state transition, lock, restart, and redaction tests.
- Create `backend/src/services/phone-action-coordinator.ts`: monitor maintenance, one-write execution, and read-only confirmation scheduling.
- Create `backend/src/services/phone-action-coordinator.test.ts`: coordinator behavioral tests with deterministic gateway fakes.
- Create `backend/src/services/dingtone/phone-action-protocol.ts`: action identities, safe payload patches, and result classification.
- Create `backend/src/services/dingtone/phone-action-protocol.test.ts`: TalkU/Dingdong identity and payload-preservation tests.
- Modify `backend/prisma/schema.prisma`: enums, operation model, and relations.
- Create `backend/prisma/migrations/20260726093000_phone_action_operations/migration.sql`: SQLite migration.
- Modify `backend/src/services/dingtone/direct-gateway.ts`: expose one-write mutation methods and remove mutation fallbacks.
- Modify `backend/src/services/dingtone/types.ts`: operation-aware mutation result types.
- Modify `backend/src/routes/accounts.ts`: route all phone mutations through the coordinator and add status endpoints.
- Create `backend/src/routes/phone-action-latency.test.ts`: operation-envelope and status-query route contracts.
- Modify `backend/src/index.ts`: recover unresolved operations after startup.
- Modify `backend/src/services/phone-sms-diagnostics.ts`: correct text encoding and separate filter, routing, listener, and delivery states.
- Modify `backend/src/services/telegram-bot-callbacks.ts`: route Telegram renewal/cancellation through the same coordinator.
- Modify `frontend/src/types/index.ts`: operation types and phone-row operation state.
- Modify `frontend/src/services/endpoints.ts`: idempotency keys and operation polling.
- Modify `frontend/src/pages/AccountDetail.tsx`: fast mutation UX, durable pending state, and split SMS diagnostics.
- Modify existing static and behavioral tests under `backend/src/routes`, `backend/src/services/dingtone`, and `backend/src/services`.

### Task 1: Persist Phone Action Operations

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260726093000_phone_action_operations/migration.sql`
- Create: `backend/src/services/phone-action-operation.ts`
- Test: `backend/src/services/phone-action-operation.test.ts`

- [ ] **Step 1: Write the failing state-machine test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  activePhoneActionLockKey,
  canTransitionPhoneAction,
  phoneActionFamily
} from "./phone-action-operation.js";

test("keeps an unknown renewal locked across restart-compatible states", () => {
  assert.equal(phoneActionFamily("renew"), "renewal");
  assert.equal(activePhoneActionLockKey(459, 4999, "renew"), "459:4999:renewal");
  assert.equal(canTransitionPhoneAction("writing", "awaiting_confirmation"), true);
  assert.equal(canTransitionPhoneAction("awaiting_confirmation", "prepared"), false);
  assert.equal(canTransitionPhoneAction("manual_review", "prepared"), false);
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run:

```powershell
npm --prefix backend exec -- node --import tsx --test src/services/phone-action-operation.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `phone-action-operation.js`.

- [ ] **Step 3: Add Prisma enums, relations, and operation model**

Add to `backend/prisma/schema.prisma`:

```prisma
enum PhoneActionType {
  renew
  cancel
  pause
  resume
  update_label
  enable_sms
  reactivate
}

enum PhoneActionState {
  prepared
  writing
  awaiting_confirmation
  confirmed
  failed_before_write
  manual_review
}

model PhoneActionOperation {
  id                 Int              @id @default(autoincrement())
  accountId          Int              @map("account_id")
  phoneId            Int              @map("phone_id")
  action             PhoneActionType
  state              PhoneActionState @default(prepared)
  appVariant         AppVariant       @map("app_variant")
  idempotencyKey     String           @unique @map("idempotency_key")
  activeLockKey      String?          @unique @map("active_lock_key")
  baselineStatus     PhoneStatus?     @map("baseline_status")
  baselineExpiry     String?          @map("baseline_expiry")
  balanceBefore      Float?           @map("balance_before")
  balanceAfter       Float?           @map("balance_after")
  quotedPrice        Float?           @map("quoted_price")
  confirmedExpiry    String?          @map("confirmed_expiry")
  extensionMonths    Int?             @map("extension_months")
  evidenceAt         DateTime?        @map("evidence_at")
  requestFingerprint String?          @map("request_fingerprint")
  responseClass      String?          @map("response_class")
  errorSummary       String?          @map("error_summary")
  confirmationSource String?          @map("confirmation_source")
  reconcileAttempts  Int              @default(0) @map("reconcile_attempts")
  writeStartedAt     DateTime?        @map("write_started_at")
  writeCompletedAt   DateTime?        @map("write_completed_at")
  confirmedAt        DateTime?        @map("confirmed_at")
  createdAt          DateTime         @default(now()) @map("created_at")
  updatedAt          DateTime         @updatedAt @map("updated_at")
  account            DtAccount        @relation(fields: [accountId], references: [id], onDelete: Cascade)
  phone              PhoneNumber      @relation(fields: [phoneId], references: [id], onDelete: Cascade)

  @@index([accountId, state, updatedAt])
  @@index([phoneId, createdAt(sort: Desc)])
  @@map("phone_action_operations")
}
```

Add `phoneActionOperations PhoneActionOperation[]` to both `DtAccount` and `PhoneNumber`.

- [ ] **Step 4: Add the exact SQLite migration**

Create `backend/prisma/migrations/20260726093000_phone_action_operations/migration.sql`:

```sql
CREATE TABLE "phone_action_operations" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "account_id" INTEGER NOT NULL,
  "phone_id" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'prepared',
  "app_variant" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "active_lock_key" TEXT,
  "baseline_status" TEXT,
  "baseline_expiry" TEXT,
  "balance_before" REAL,
  "balance_after" REAL,
  "quoted_price" REAL,
  "confirmed_expiry" TEXT,
  "extension_months" INTEGER,
  "evidence_at" DATETIME,
  "request_fingerprint" TEXT,
  "response_class" TEXT,
  "error_summary" TEXT,
  "confirmation_source" TEXT,
  "reconcile_attempts" INTEGER NOT NULL DEFAULT 0,
  "write_started_at" DATETIME,
  "write_completed_at" DATETIME,
  "confirmed_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "phone_action_operations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "dt_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "phone_action_operations_phone_id_fkey" FOREIGN KEY ("phone_id") REFERENCES "phone_numbers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "phone_action_operations_idempotency_key_key" ON "phone_action_operations"("idempotency_key");
CREATE UNIQUE INDEX "phone_action_operations_active_lock_key_key" ON "phone_action_operations"("active_lock_key");
CREATE INDEX "phone_action_operations_account_id_state_updated_at_idx" ON "phone_action_operations"("account_id", "state", "updated_at");
CREATE INDEX "phone_action_operations_phone_id_created_at_idx" ON "phone_action_operations"("phone_id", "created_at" DESC);
```

- [ ] **Step 5: Implement the pure state helpers and repository API**

Create `phone-action-operation.ts` with these exported APIs:

```ts
export type PhoneActionFamily = "renewal" | "cancellation" | "settings" | "reactivation";

export function phoneActionFamily(action: PhoneActionType): PhoneActionFamily {
  if (action === "renew") return "renewal";
  if (action === "cancel") return "cancellation";
  if (action === "reactivate") return "reactivation";
  return "settings";
}

export function activePhoneActionLockKey(accountId: number, phoneId: number, action: PhoneActionType) {
  return `${accountId}:${phoneId}:${phoneActionFamily(action)}`;
}

const transitions: Record<PhoneActionState, PhoneActionState[]> = {
  prepared: ["writing", "failed_before_write"],
  writing: ["awaiting_confirmation", "confirmed", "failed_before_write", "manual_review"],
  awaiting_confirmation: ["confirmed", "manual_review"],
  confirmed: [],
  failed_before_write: [],
  manual_review: ["confirmed"]
};

export function canTransitionPhoneAction(from: PhoneActionState, to: PhoneActionState) {
  return transitions[from].includes(to);
}
```

The repository must export `createPhoneActionOperation`, `markPhoneActionWriting`, `markPhoneActionAwaitingConfirmation`, `markPhoneActionConfirmed`, `markPhoneActionFailedBeforeWrite`, `markPhoneActionManualReview`, `findPhoneActionOperation`, and `listRecoverablePhoneActionOperations`. Terminal safe-to-retry states clear `activeLockKey`; unknown states retain it.

- [ ] **Step 6: Generate Prisma and run the focused test**

```powershell
npm --prefix backend run prisma:generate
npm --prefix backend exec -- node --import tsx --test src/services/phone-action-operation.test.ts
```

Expected: PASS.

### Task 2: Enforce A Single Direct Write

**Files:**
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/dingtone/types.ts`
- Test: `backend/src/services/dingtone/direct-phone-registered-session.test.ts`
- Test: `backend/src/services/dingtone/direct-phone-response.test.ts`

- [ ] **Step 1: Write failing tests for the write boundary**

Add tests that call an exported test helper with primary and backup fake sessions:

```ts
test("does not try another host after a phone mutation write", async () => {
  const attempts: string[] = [];
  const result = await runSingleWritePhoneMutationForTest({
    hosts: ["primary", "backup"],
    execute: async (host, markWritten) => {
      attempts.push(host);
      markWritten();
      throw new Error("socket ended after write");
    }
  });

  assert.deepEqual(attempts, ["primary"]);
  assert.equal(result.outcome, "unknown_after_write");
});
```

Add a second test proving a connect failure before `markWritten()` may try the backup host.

- [ ] **Step 2: Run and observe the missing helper failure**

```powershell
npm --prefix backend exec -- node --import tsx --test src/services/dingtone/direct-phone-registered-session.test.ts src/services/dingtone/direct-phone-response.test.ts
```

Expected: FAIL because `runSingleWritePhoneMutationForTest` is not exported.

- [ ] **Step 3: Add the mutation result type**

In `types.ts`:

```ts
export type DingtonePhoneMutationResult =
  | { outcome: "response"; payload: Record<string, unknown> }
  | { outcome: "unknown_after_write"; error: string };
```

- [ ] **Step 4: Implement `withSingleWriteSession`**

The method must connect and authenticate on multiple hosts only before the write callback fires. After `markWritten()`, every timeout, EOF, parse failure, or socket close returns `unknown_after_write` and stops host/template iteration.

```ts
private async withSingleWriteSession(
  runtime: DirectRuntimeConfig,
  account: DirectSessionAccount,
  execute: (session: DirectSession, markWritten: () => void) => Promise<ApiResult>
): Promise<DingtonePhoneMutationResult> {
  let lastError: unknown;
  for (const host of uniqueHosts([runtime.primaryHost, runtime.backupHost])) {
    const session = new DirectSession(runtime, host);
    let wrote = false;
    try {
      await session.open(account);
      const payload = await execute(session, () => { wrote = true; });
      await session.close();
      return { outcome: "response", payload };
    } catch (error) {
      lastError = error;
      await session.close().catch(() => undefined);
      if (wrote) {
        return {
          outcome: "unknown_after_write",
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  }
  throw normalizeDirectError(lastError);
}
```

Wrap it in the existing per-account operation lock and preempt the push listener before connecting.

- [ ] **Step 5: Remove mutation-time host and template fallback behavior**

Keep `callDirectPhoneAction` for read-only compatibility only. New mutation methods must call `withSingleWriteSession` directly. Delete the automatic resume-to-reactivate branch; reactivation remains a separate method.

- [ ] **Step 6: Run focused tests**

Expected: the new one-write tests and existing response tests pass.

### Task 3: Add Variant-Aware Action Protocol Builders

**Files:**
- Create: `backend/src/services/dingtone/phone-action-protocol.ts`
- Test: `backend/src/services/dingtone/phone-action-protocol.test.ts`
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/dingtone/direct-phone-sms-setting.test.ts`

- [ ] **Step 1: Write failing identity and preservation tests**

```ts
test("uses the App RestCall identities shared by TalkU and Dingdong", () => {
  assert.deepEqual(PHONE_ACTION_REST_CALL_TYPES, {
    renew: 2050,
    settings: 2052,
    cancel: 2132
  });
});

test("changing suspend state preserves unrelated settings", () => {
  const source = fullPhoneSettingFixture();
  const next = buildPrivateNumberSettingPayload(source, { suspendFlag: true });
  assert.equal(next.suspendFlag, true);
  assert.equal(next.autoRenew, source.autoRenew);
  assert.equal(next.primaryFlag, false);
  assert.equal(next.filterSetting, source.filterSetting);
  assert.equal(next.displayName, source.displayName);
});

test("an SMS override does not change forwarding or auto renew", () => {
  const source = fullPhoneSettingFixture();
  const next = buildPrivateNumberSettingPayload(source, { allowReceiveSms: true });
  assert.equal(JSON.parse(next.filterSetting).allowReceiveSMS, true);
  assert.equal(next.callForwardFlag, source.callForwardFlag);
  assert.equal(next.autoRenew, source.autoRenew);
});
```

- [ ] **Step 2: Run and verify failure**

Expected: FAIL because the protocol module does not exist.

- [ ] **Step 3: Implement action identities and preserved DTO construction**

Export:

```ts
export const PHONE_ACTION_REST_CALL_TYPES = {
  renew: 2050,
  settings: 2052,
  cancel: 2132
} as const;

export type PrivateNumberSettingPatch = {
  suspendFlag?: boolean;
  displayName?: string;
  allowReceiveSms?: boolean;
};
```

`buildPrivateNumberSettingPayload` must require these source fields: phone number, primary flag, silent flag, suspend flag, call-forward flag, auto SMS reply, voicemail usage, auto-renew, and filter setting. It must throw `UnsafePhoneSettingSourceError` when a required field is unavailable. It changes only fields present in `PrivateNumberSettingPatch`; suspending a primary number sets `primaryFlag=false` because the App does the same.

- [ ] **Step 4: Add byte-verified adapters and reject unverifiable writes**

Implement `OrderPrivateNumberAdapter`, `PrivateNumberSettingAdapter`, and `DeletePrivateNumberAdapter`. Tests must assert the emitted outer RestCall identity, variant selection, and request bytes or captured-template fixture for both TalkU and Dingdong. If no verified native frame/template exists for the requested variant and action, return `failed_before_write` with `unsupported_protocol` and do not fall back to generic CommonRest.

- [ ] **Step 5: Propagate `appVariant` through every gateway mutation identity**

Change all account argument types for renewal, cancellation, pause, resume, label, SMS, and reactivation to `DirectSessionAccount`. Ensure every route passes `account.appVariant`.

- [ ] **Step 6: Run protocol and existing setting tests**

```powershell
npm --prefix backend exec -- node --import tsx --test src/services/dingtone/phone-action-protocol.test.ts src/services/dingtone/direct-phone-sms-setting.test.ts
```

Expected: PASS.

### Task 4: Build The Phone Action Coordinator

**Files:**
- Create: `backend/src/services/phone-action-coordinator.ts`
- Test: `backend/src/services/phone-action-coordinator.test.ts`
- Modify: `backend/src/services/account-monitor.ts`

- [ ] **Step 1: Write failing coordinator tests**

Cover four behaviors with a fake repository, monitor, and gateway:

```ts
test("returns awaiting confirmation after exactly one unknown write", async () => {
  const writes: string[] = [];
  const result = await coordinator.execute(input, {
    mutate: async () => {
      writes.push("write");
      return { outcome: "unknown_after_write", error: "EOF" };
    }
  });
  assert.deepEqual(writes, ["write"]);
  assert.equal(result.state, "awaiting_confirmation");
});
```

Also prove that the monitor is restored in `finally`, a duplicate active lock returns the existing operation, and a failure before write clears the lock.

- [ ] **Step 2: Run and verify failure**

Expected: FAIL because `PhoneActionCoordinator` is missing.

- [ ] **Step 3: Implement the coordinator interface**

```ts
export class PhoneActionCoordinator {
  async execute(input: ExecutePhoneActionInput): Promise<PhoneActionOperationEnvelope>;
  async reconcile(operationId: number): Promise<PhoneActionOperationEnvelope>;
  async getOperation(accountId: number, operationId: number): Promise<PhoneActionOperationEnvelope>;
  async getActiveOperation(accountId: number, phoneId: number): Promise<PhoneActionOperationEnvelope | null>;
  async recoverPending(): Promise<void>;
}
```

`execute` must create or reuse the durable operation, pause the monitor with `preserveMonitorEnabled=true`, mark `writing` immediately before gateway execution, classify response/unknown/pre-write failure, and restore the monitor. It schedules reconciliation only for `awaiting_confirmation`.

- [ ] **Step 4: Add operation-aware monitor maintenance**

Expose a single account-monitor maintenance method so routes and the coordinator do not duplicate stop/start logic:

```ts
await accountMonitorService.withMaintenance(accountId, async () => operation(), {
  preserveMonitorEnabled: true,
  targetStatus: AccountStatus.online
});
```

- [ ] **Step 5: Run coordinator tests**

Expected: PASS with exactly one mutation call in every unknown-after-write case.

- [ ] **Step 6: Add durable status query routes**

Add read-only routes:

- `GET /accounts/:accountId/phone-actions/:operationId`
- `GET /accounts/:accountId/phone-numbers/:phoneId/operations/active`

Both routes must enforce account ownership, return the same operation envelope shape as mutation routes, and perform no gateway write. Include the active unresolved operation in each phone row returned by account detail.

### Task 5: Migrate Renewal And Add Accounting Evidence

**Files:**
- Modify: `backend/src/routes/accounts.ts`
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/phone-renewal-confirmation.ts`
- Test: `backend/src/services/phone-renewal-confirmation.test.ts`
- Test: `backend/src/routes/phone-action-latency.test.ts`

- [ ] **Step 1: Write failing renewal-operation tests**

Tests must assert:

- route calls the coordinator instead of `pendingPhoneRenewals`
- persisted operation stores baseline expiry and balance before
- exact quote identity and extension term are persisted before the write
- unknown write returns `awaiting_confirmation`
- another request receives the same locked operation
- confirmation stores balance after, confirmed expiry, extension months, and evidence time
- confirmation clears the active lock only after expiry advances

- [ ] **Step 2: Run and verify failure against the in-memory implementation**

Expected: FAIL because `pendingPhoneRenewals` is still present and no operation envelope is returned.

- [ ] **Step 3: Replace the in-memory renewal set**

Delete `pendingPhoneRenewals` and `schedulePhoneRenewalReconciliation`. Build an `ExecutePhoneActionInput` with action `renew`, baseline expiry, balance before, quote, variant, and request idempotency key.

Resolve an exact renewal quote before user confirmation from a fresh remote price response or a recent persisted remote `orderPrice` with matching phone/package/term identity. If the exact quote cannot be established, fail before write; never estimate the charge from the current balance or historical deductions.

- [ ] **Step 4: Return the operation envelope**

The response shape is:

```ts
{
  operation: {
    id: number;
    action: "renew";
    state: PhoneActionState;
    confirmation_source: string | null;
    error_summary: string | null;
    created_at: string;
    updated_at: string;
  };
  phone: PhoneNumber;
}
```

- [ ] **Step 5: Run renewal tests**

After confirmation, persist `balanceAfter`, confirmed expiry, extension duration, and the evidence timestamp. Expected: PASS and no source reference to `pendingPhoneRenewals`.

### Task 6: Migrate Cancellation And Phone Settings

**Files:**
- Modify: `backend/src/routes/accounts.ts`
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Test: `backend/src/routes/management-upgrades.test.ts`
- Test: `backend/src/services/dingtone/direct-phone-registered-session.test.ts`

- [ ] **Step 1: Write failing tests for all mutations**

Add tests proving:

- cancel, pause, resume, label, and enable SMS all use the coordinator
- every inline direct account object includes `appVariant`
- cancellation retains the local phone row
- resume never invokes reactivation automatically
- settings payload failures occur before the write boundary
- unconfirmed mutations return quickly instead of synchronously calling inventory twice

- [ ] **Step 2: Run and verify failure**

Expected: FAIL on current direct route calls and automatic resume fallback.

- [ ] **Step 3: Implement action-specific gateway methods**

Each gateway mutation returns `DingtonePhoneMutationResult` and accepts a state-preserving payload. Cancellation uses its own API/RestCall identity; setting actions use the shared setting adapter with a precise patch.

- [ ] **Step 4: Route each endpoint through the coordinator**

Use action family `settings` for pause, resume, label, and SMS so conflicting setting mutations cannot overlap. Cancellation uses its own durable lock.

After cancellation confirmation, retain the local phone record, set its status to cancelled, preserve historical expiry/label/provider data, and return it in account detail instead of deleting or hiding it.

- [ ] **Step 5: Run mutation tests**

Expected: PASS and no generic mutation fallback remains.

### Task 7: Recover And Reconcile Operations

**Files:**
- Modify: `backend/src/services/phone-action-coordinator.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/services/phone-action-coordinator.test.ts`
- Test: `backend/src/services/account-monitor-config.test.ts`

- [ ] **Step 1: Write failing restart-recovery tests**

Seed `writing` and `awaiting_confirmation` operations. Assert startup converts stale `writing` to `manual_review`, schedules read-only checks for awaiting confirmation, performs no mutation calls, and preserves active locks.

- [ ] **Step 2: Run and verify failure**

Expected: FAIL because startup does not recover operations.

- [ ] **Step 3: Implement bounded read-only reconciliation**

Use delays `[5_000, 20_000, 60_000, 300_000]` without holding an HTTP request. Increment `reconcileAttempts` before each inventory read. After the final unsuccessful read, mark manual review and retain the lock.

- [ ] **Step 4: Wire startup recovery**

After database initialization and before automatic account refresh, call:

```ts
phoneActionCoordinator.recoverPending().catch((error) => {
  logger.error("Failed to recover pending phone actions", error);
});
```

- [ ] **Step 5: Run recovery tests**

Expected: PASS with zero gateway mutation calls during recovery.

### Task 8: Correct SMS Diagnosis And Repair Semantics

**Files:**
- Modify: `backend/src/services/phone-sms-diagnostics.ts`
- Modify: `backend/src/routes/accounts.ts`
- Test: `backend/src/services/phone-sms-diagnostics.test.ts`
- Test: `backend/src/services/dingtone/direct-phone-sms-setting.test.ts`

- [ ] **Step 1: Write failing tests for the nine unknown-field scenario**

```ts
test("does not claim that an unknown filter can be automatically repaired", () => {
  const result = buildPhoneSmsReceptionDiagnostic({
    status: "active",
    allowReceiveSms: undefined,
    providerId: 2002,
    packageServiceId: "pkg",
    receivedCount: 0,
    lastReceivedAt: null,
    monitorEnabled: true,
    monitorRunning: true,
    monitorStatus: "running",
    monitorListenActive: true
  });
  assert.equal(result.filterStatus, "not_returned");
  assert.equal(result.repairable, false);
  assert.equal(result.deliveryStatus, "unverified");
});
```

Add tests for explicit force-enable confirmation, missing routing metadata, listener restart, and readable Chinese summaries.

- [ ] **Step 2: Run and verify the text/behavior failures**

Expected: at least the readable-Chinese assertions fail because the current source contains mojibake.

- [ ] **Step 3: Replace all mojibake strings with UTF-8 Chinese**

Use explicit summaries for inactive number, blocked filter, missing routing, listener disabled, listener unhealthy, listener starting, received evidence, and unverified delivery.

- [ ] **Step 4: Split repair operations**

Keep these endpoints distinct:

- `POST /phone-numbers/refresh-routing`: read-only inventory sync
- `POST /phone-numbers/restart-listener`: non-destructive monitor restart
- `POST /phone-numbers/enable-sms-reception`: only explicit blocked filters by default
- `POST /phone-numbers/:phoneId/force-enable-sms`: coordinator mutation requiring `confirm=true`

- [ ] **Step 5: Run SMS tests**

Expected: PASS and the bulk repair response reports explicit blocked, unknown, routing, listener, and delivery counts separately.

### Task 9: Add Operation-Aware Frontend And Telegram UX

**Files:**
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/services/endpoints.ts`
- Modify: `frontend/src/pages/AccountDetail.tsx`
- Modify: `backend/src/services/telegram-bot-callbacks.ts`
- Test: `backend/src/routes/phone-action-latency.test.ts`
- Test: `backend/src/services/telegram-bot-callbacks.test.ts`

- [ ] **Step 1: Write failing source-level UX tests**

Assert the frontend creates one `crypto.randomUUID()` idempotency key per confirmed click, stores unresolved operation state by phone ID, polls the status endpoint, disables conflicting actions, and renders awaiting confirmation as a warning rather than success/failure.

- [ ] **Step 2: Run and verify failure**

Expected: FAIL because endpoints return only `PhoneActionResult` and do not poll operations.

- [ ] **Step 3: Add frontend operation types and endpoints**

```ts
export type PhoneActionOperationState =
  | "prepared"
  | "writing"
  | "awaiting_confirmation"
  | "confirmed"
  | "failed_before_write"
  | "manual_review";

export async function getPhoneActionOperation(accountId: number, operationId: number) {
  const response = await api.get<ApiResponse<PhoneActionOperationEnvelope>>(
    `/accounts/${accountId}/phone-actions/${operationId}`
  );
  return response.data.data;
}
```

All mutation requests include `request_id` and use a short 20-second HTTP timeout because remote confirmation is asynchronous.

- [ ] **Step 4: Implement row-level operation status and polling**

Poll at 2, 5, 10, 20, and 30 seconds, then leave the durable status visible without an active spinner. `manual_review` displays a warning and keeps conflicting buttons disabled.

Cancelled numbers remain visible in the phone table with a clear cancelled state, historical expiry, and disabled mutation actions that no longer apply.

- [ ] **Step 5: Route Telegram actions through the coordinator**

Telegram confirmation callbacks create the same request ID and operation records. They must not call a direct gateway mutation independently.

Expiry reminders show the full phone number, current TalkU/Dingdong balance, exact renewal price, and the extension term, with renewal and cancellation buttons followed by a second confirmation. Renewal result messages show balance before, balance after, deducted amount, extension duration, and confirmed new expiry; unknown outcomes say confirmation is pending and never claim success or encourage another click.

- [ ] **Step 6: Run frontend/Telegram tests and frontend build**

```powershell
npm --prefix backend exec -- node --import tsx --test src/routes/phone-action-latency.test.ts src/services/telegram-bot-callbacks.test.ts
npm --prefix frontend run build
```

Expected: PASS.

### Task 10: Full Verification And Local Runtime Handoff

**Files:**
- Modify only files required by failures discovered in this task.

- [ ] **Step 1: Apply the migration to the local development database**

```powershell
npm --prefix backend run prisma:deploy
```

Expected: migration `20260726093000_phone_action_operations` applied once.

- [ ] **Step 2: Run all backend TypeScript tests**

```powershell
npm --prefix backend exec -- node --import tsx --test "src/**/*.test.ts"
```

Expected: all tests pass. If PowerShell does not expand the glob, enumerate tests with `rg --files backend/src -g '*.test.ts'` and pass the paths through the backend `tsx` environment.

- [ ] **Step 3: Run regression and builds**

```powershell
npm --prefix backend run verify:direct-regression
npm --prefix backend run build
npm --prefix frontend run build
```

Expected: regression reports success and both builds exit `0`.

- [ ] **Step 4: Run start-script contract tests**

```powershell
powershell -ExecutionPolicy Bypass -File tools/test-start-script-contract.ps1
```

Expected: stale process records are replaced and duplicate active instances are not created.

- [ ] **Step 5: Restart and verify health**

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1 -SkipInstall
```

Verify `http://127.0.0.1:5174/health` and `http://127.0.0.1:5173/` return successfully.

- [ ] **Step 6: Run read-only operation checks**

Confirm operation status endpoints, account/phone listing, SMS diagnostics, pending-operation recovery, and remote inventory reads without invoking renewal, cancellation, reactivation, or SMS-setting writes.

- [ ] **Step 7: Review the focused diff**

```powershell
git -C 'D:\work\dt-manager-web' diff --check
git -C 'D:\work\dt-manager-web' status --short
```

Expected: no whitespace errors and no unrelated files reverted.

- [ ] **Step 8: Stop before live mutation validation**

Report which actions have static, unit, integration, startup, and read-only live proof. Request a separately specified test account and phone before exactly one real write for each action. Do not infer permission from this implementation plan.
