ALTER TABLE "dt_accounts" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "point_store_orders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "account_id" INTEGER NOT NULL,
    "remote_order_id" TEXT,
    "product_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "product_price" REAL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "order_time" TEXT,
    "raw_order_json" TEXT,
    "raw_info_json" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "point_store_orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "dt_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "point_store_orders_account_id_remote_order_id_key" ON "point_store_orders"("account_id", "remote_order_id");
CREATE INDEX "point_store_orders_account_id_created_at_idx" ON "point_store_orders"("account_id", "created_at" DESC);
CREATE INDEX "point_store_orders_remote_order_id_idx" ON "point_store_orders"("remote_order_id");
