import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";

export type GatewayMode = "mock" | "real" | "bridge" | "direct";

const defaultSettings = [
  ["telegram_bot_token", config.TELEGRAM_BOT_TOKEN, "Telegram bot token"],
  ["telegram_chat_id", config.TELEGRAM_CHAT_ID, "Telegram chat id"],
  ["telegram_api_base_url", config.TELEGRAM_API_BASE_URL, "Telegram API base url or reverse proxy"],
  ["telegram_bot_enabled", "false", "Enable Telegram bot control panel polling"],
  ["telegram_allowed_chat_ids", "", "Comma separated Telegram chat ids or user ids allowed to control the bot"],
  ["telegram_bot_poll_interval_seconds", "10", "Telegram bot polling interval in seconds"],
  ["telegram_bot_last_update_id", "0", "Telegram bot last processed update id"],
  ["dt_proxy_url", config.DT_PROXY_URL, "Optional proxy for Dingtone requests"],
  ["dt_real_bridge_base_url", config.DT_REAL_BRIDGE_BASE_URL, "Helper base url for real/bridge mode"],
  ["dt_real_bridge_token", config.DT_REAL_BRIDGE_TOKEN, "Optional helper auth token"],
  ["dt_real_bridge_timeout_ms", String(config.DT_REAL_BRIDGE_TIMEOUT_MS), "Helper request timeout in milliseconds"],
  ["adb_path", config.ADB_PATH, "ADB executable path"],
  ["dt_adb_dingtone_package", config.DT_ADB_DINGTONE_PACKAGE, "ADB package name for the dingtone/TalkU app variant"],
  ["dt_adb_dingtone_main_activity", config.DT_ADB_DINGTONE_MAIN_ACTIVITY, "ADB main activity for the dingtone/TalkU app variant"],
  ["dt_adb_dingdong_package", config.DT_ADB_DINGDONG_PACKAGE, "ADB package name for the dingdong app variant"],
  ["dt_adb_dingdong_main_activity", config.DT_ADB_DINGDONG_MAIN_ACTIVITY, "ADB main activity for the dingdong app variant"],
  ["dt_direct_use_tls", String(config.DT_DIRECT_USE_TLS), "Whether direct mode uses TLS"],
  ["dt_server_ip", config.DT_SERVER_IP, "Primary Dingtone server ip"],
  ["dt_server_port", String(config.DT_SERVER_PORT), "Primary Dingtone server port"],
  ["dt_backup_ip", config.DT_BACKUP_IP, "Backup Dingtone server ip"],
  ["dt_direct_api_purchase_phone", "/pstn/share/orderPrivateNumber", "Direct mode API name for purchasing a phone number"],
  ["dt_direct_api_renew_phone", "/pstn/share/orderPrivateNumber", "Direct mode API name for renewing a phone number"],
  ["dt_direct_api_cancel_phone", "/pstn/share/deletePhoneNumber", "Direct mode API name for cancelling a phone number"],
  ["dt_direct_api_pause_phone", "/pstn/share/privateNumberSetting", "Direct mode API name for pausing a phone number"],
  ["dt_direct_api_resume_phone", "/pstn/share/privateNumberSetting", "Direct mode API name for resuming a phone number"],
  ["dt_direct_api_reactivate_phone", "/pstn/share/reactivateGoogleVoiceNumber", "Direct mode API name for reactivating a suspended phone number"],
  ["dt_direct_template_request_phone", "", "Direct mode template for fetching purchasable phone numbers"],
  ["dt_direct_template_purchase_phone", "", "Direct mode template for purchasing a phone number"],
  ["dt_direct_template_renew_phone", "", "Direct mode template for renewing a phone number"],
  ["dt_direct_template_cancel_phone", "", "Direct mode template for cancelling a phone number"],
  ["dt_direct_template_pause_phone", "", "Direct mode template for pausing a phone number"],
  ["dt_direct_template_resume_phone", "", "Direct mode template for resuming a phone number"],
  ["dt_direct_template_phone_setting", "", "Optional shared direct mode template for pause/resume phone settings"],
  ["dt_direct_template_offline_messages", "", "Optional direct mode template for requesting offline SMS/message pushes after login"],
  ["message_poll_interval", String(config.DEFAULT_MESSAGE_POLL_INTERVAL), "Message polling interval in seconds"],
  ["direct_message_listen_seconds", "1800", "Direct SMS push listen window in seconds"],
  ["direct_message_refresh_wait_seconds", "45", "Direct SMS refresh wait window in seconds"],
  ["direct_monitor_max_concurrent", "0", "Maximum concurrent direct SMS monitor sockets; 0 means unlimited"],
  ["dt_direct_listener_host_concurrency", "2", "Maximum gateway hosts a direct SMS listener keeps open per account"],
  ["direct_monitor_app_catchup_enabled", "false", "Allow direct monitors to scan app/helper/ADB messages as a fallback"],
  ["direct_monitor_app_catchup_seconds", "15", "Interval for direct monitors to scan app/helper/ADB messages as a fallback"],
  ["code_receiver_api_tokens", "", "Comma/newline separated code receiver API tokens. Use token or adminId:token."],
  ["auto_refresh_interval", String(config.DEFAULT_AUTO_REFRESH_INTERVAL), "Account auto refresh interval in seconds"],
  ["max_retry_count", String(config.DEFAULT_MAX_RETRY_COUNT), "Maximum retry count"],
  ["monitor_restore_delay", String(config.DEFAULT_MONITOR_RESTORE_DELAY), "Delay in seconds between restoring account monitors after backend startup"],
  ["log_level", config.LOG_LEVEL, "Log level"]
] as const;

const runtimeSettings = [
  ["APP_VERSION", config.APP_VERSION, "Application version"],
  [
    "DT_GATEWAY_MODE",
    config.DT_GATEWAY_MODE,
    "Gateway mode: mock for demo/testing, real/bridge for helper + app, direct for no-app direct session flow"
  ],
  ["PORT", String(config.PORT), "Backend port"]
] as const;

const legacySettingRewrites = [
  ["dt_direct_api_cancel_phone", "/pstn/share/deletePrivateNumber", "/pstn/share/deletePhoneNumber"],
  ["direct_message_listen_seconds", String(Math.max(60, config.DEFAULT_MESSAGE_POLL_INTERVAL)), "1800"],
  ["direct_message_listen_seconds", "300", "1800"],
  ["dt_adb_dingdong_package", "me.talkyou.app.im", "me.dingtone.app.im"],
  ["dt_adb_dingtone_main_activity", ".activity.TalkuMainActivity", ".activity.TalkuSplashActivity"],
  ["dt_adb_dingdong_main_activity", ".activity.DTActivity", ".activity.SplashActivity"]
] as const;

export async function ensureDefaultSettings() {
  for (const [key, value, description] of defaultSettings) {
    await prisma.setting.upsert({
      where: { key },
      update: {},
      create: { key, value, description }
    });
  }

  for (const [key, oldValue, nextValue] of legacySettingRewrites) {
    await prisma.setting.updateMany({
      where: { key, value: oldValue },
      data: { value: nextValue }
    });
  }

  for (const [key, value, description] of runtimeSettings) {
    await prisma.setting.upsert({
      where: { key },
      update: { description },
      create: { key, value, description }
    });
  }
}

export async function getSettingsMap() {
  const rows = await prisma.setting.findMany({
    orderBy: { key: "asc" }
  });
  return Object.fromEntries(rows.map((item) => [item.key, item.value]));
}

export async function getGatewayMode(): Promise<GatewayMode> {
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  return normalizeGatewayMode(settings.DT_GATEWAY_MODE) ?? config.DT_GATEWAY_MODE;
}

function normalizeGatewayMode(value: string | undefined): GatewayMode | null {
  if (value === "mock" || value === "real" || value === "bridge" || value === "direct") {
    return value;
  }
  return null;
}
