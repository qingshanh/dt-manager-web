-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_dt_accounts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "admin_id" INTEGER NOT NULL,
    "nickname" TEXT,
    "app_variant" TEXT NOT NULL DEFAULT 'dingtone',
    "login_type" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "password" TEXT,
    "dt_user_id" TEXT,
    "dt_token" TEXT,
    "dt_device_id" TEXT NOT NULL,
    "dt_track_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "monitor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "telegram_notify" BOOLEAN NOT NULL DEFAULT false,
    "proxy_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" DATETIME,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "dt_accounts_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_dt_accounts" ("admin_id", "created_at", "dt_device_id", "dt_token", "dt_track_code", "dt_user_id", "email", "id", "last_error", "last_login_at", "login_type", "monitor_enabled", "nickname", "password", "phone", "proxy_enabled", "status", "telegram_notify", "updated_at") SELECT "admin_id", "created_at", "dt_device_id", "dt_token", "dt_track_code", "dt_user_id", "email", "id", "last_error", "last_login_at", "login_type", "monitor_enabled", "nickname", "password", "phone", "proxy_enabled", "status", "telegram_notify", "updated_at" FROM "dt_accounts";
DROP TABLE "dt_accounts";
ALTER TABLE "new_dt_accounts" RENAME TO "dt_accounts";
CREATE INDEX "dt_accounts_admin_id_idx" ON "dt_accounts"("admin_id");
CREATE INDEX "dt_accounts_status_idx" ON "dt_accounts"("status");
CREATE UNIQUE INDEX "dt_accounts_admin_id_app_variant_email_key" ON "dt_accounts"("admin_id", "app_variant", "email");
CREATE UNIQUE INDEX "dt_accounts_admin_id_app_variant_phone_key" ON "dt_accounts"("admin_id", "app_variant", "phone");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
