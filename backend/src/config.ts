import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config({ path: process.env.DT_ENV_FILE || path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "..", ".env"), override: false });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5174),
  DATABASE_URL: z.string().default("file:./data/dingtone.db"),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default("24h"),
  ENCRYPTION_KEY: z.string().min(16),
  LEGACY_ENCRYPTION_KEYS: z.string().optional().default(""),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().min(8).default("change-me"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  DT_GATEWAY_MODE: z.enum(["mock", "real", "bridge", "direct"]).default("mock"),
  DT_APP_VERSION: z.string().default("6.3.1"),
  DT_DINGDONG_APP_VERSION: z.string().default("6.5.0"),
  DT_SERVER_IP: z.string().default("139.224.25.197"),
  DT_SERVER_PORT: z.coerce.number().int().positive().default(443),
  DT_BACKUP_IP: z.string().default("47.103.133.227"),
  DT_PROXY_URL: z.string().optional().default(""),
  DT_DIRECT_USE_TLS: z
    .string()
    .optional()
    .default("false")
    .transform((value) => ["true", "1", "yes"].includes(value.trim().toLowerCase())),
  DT_APK_CERTIFICATE_SIGN: z.string().default("cf093a0e6b07dce3c8e05f7d4a9c261c"),
  DT_REAL_BRIDGE_BASE_URL: z.string().optional().default("http://127.0.0.1:5175"),
  DT_REAL_BRIDGE_TOKEN: z.string().optional().default(""),
  DT_REAL_BRIDGE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  DT_HELPER_PURCHASE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  ADB_PATH: z.string().default("C:\\tmp\\reverse-tools\\android-sdk\\platform-tools\\adb.exe"),
  DT_ADB_DINGTONE_PACKAGE: z.string().default("me.talkyou.app.im"),
  DT_ADB_DINGTONE_MAIN_ACTIVITY: z.string().default(".activity.TalkuSplashActivity"),
  DT_ADB_DINGDONG_PACKAGE: z.string().default("me.dingtone.app.im"),
  DT_ADB_DINGDONG_MAIN_ACTIVITY: z.string().default(".activity.SplashActivity"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APP_VERSION: z.string().default("0.2.4"),
  APP_COMMIT_SHA: z.string().optional().default(""),
  APP_REPOSITORY: z.string().default("qingshanh/dt-manager-web"),
  APP_UPDATE_BRANCH: z.string().default("main"),
  DEFAULT_MESSAGE_POLL_INTERVAL: z.coerce.number().int().positive().default(30),
  DEFAULT_AUTO_REFRESH_INTERVAL: z.coerce.number().int().positive().default(300),
  DEFAULT_MAX_RETRY_COUNT: z.coerce.number().int().positive().default(3),
  DEFAULT_MONITOR_RESTORE_DELAY: z.coerce.number().int().positive().default(1),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  TELEGRAM_API_BASE_URL: z.string().optional().default("")
});

export const config = schema.parse(process.env);
