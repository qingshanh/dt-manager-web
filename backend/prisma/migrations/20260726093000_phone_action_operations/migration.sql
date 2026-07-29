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
  "request_payload_json" TEXT,
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
