-- CreateTable
CREATE TABLE "admin_users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "dt_accounts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "admin_id" INTEGER NOT NULL,
    "nickname" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "account_snapshots" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "account_id" INTEGER NOT NULL,
    "dt_dingtone_id" TEXT,
    "full_name" TEXT,
    "avatar_url" TEXT,
    "gender" INTEGER,
    "birthday" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "about_me" TEXT,
    "feeling" TEXT,
    "company" TEXT,
    "school" TEXT,
    "country" TEXT,
    "state" TEXT,
    "city" TEXT,
    "primary_balance" REAL,
    "user_grade" INTEGER,
    "valid_point" REAL,
    "progress_point" REAL,
    "membership_type" TEXT,
    "membership_expire_at" DATETIME,
    "profile_ver_code" TEXT,
    "raw_json" TEXT,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "account_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "dt_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "account_id" INTEGER NOT NULL,
    "phone_number" TEXT NOT NULL,
    "country_code" INTEGER,
    "provider_id" INTEGER,
    "display_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "purchase_type" INTEGER,
    "pay_type" INTEGER,
    "valid_period_days" INTEGER,
    "gain_time" TEXT,
    "expired_time" TEXT,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_good_number" BOOLEAN NOT NULL DEFAULT false,
    "portout_info" TEXT,
    "raw_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "phone_numbers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "dt_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "messages" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "account_id" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "msg_type" TEXT NOT NULL,
    "from_number" TEXT,
    "to_number" TEXT,
    "content" TEXT NOT NULL,
    "raw_info" TEXT,
    "raw_k3" TEXT,
    "k5_flag" INTEGER,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "telegram_sent" BOOLEAN NOT NULL DEFAULT false,
    "telegram_msg_id" TEXT,
    "received_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "dt_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "monitor_sessions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "account_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "server_ip" TEXT,
    "server_port" INTEGER,
    "route_address" TEXT,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stopped_at" DATETIME,
    "error_message" TEXT,
    "heartbeat_count" INTEGER NOT NULL DEFAULT 0,
    "msg_received_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "monitor_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "dt_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE INDEX "dt_accounts_admin_id_idx" ON "dt_accounts"("admin_id");

-- CreateIndex
CREATE INDEX "dt_accounts_status_idx" ON "dt_accounts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "account_snapshots_account_id_key" ON "account_snapshots"("account_id");

-- CreateIndex
CREATE INDEX "phone_numbers_account_id_status_idx" ON "phone_numbers"("account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_account_id_phone_number_key" ON "phone_numbers"("account_id", "phone_number");

-- CreateIndex
CREATE INDEX "messages_account_id_received_at_idx" ON "messages"("account_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "messages_account_id_is_read_idx" ON "messages"("account_id", "is_read");

-- CreateIndex
CREATE INDEX "monitor_sessions_account_id_status_idx" ON "monitor_sessions"("account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");
