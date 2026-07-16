import type { PrismaClient } from "@prisma/client";
import type { DingtonePhoneNumber } from "./dingtone/types.js";
import { getSettingsMap } from "./settings.service.js";
import { normalizeRemotePointStoreOrderStatus } from "./point-store-order-history.js";
import { TelegramApiError, telegramService } from "./telegram.js";
import { escapeTelegramHtml, limitTelegramMessage } from "./telegram-bot-ui.js";

type TelegramDb = Pick<PrismaClient, "dtAccount">;

type NotifyAccount = {
  id: number;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  dtUserId: string | null;
  telegramNotify: boolean;
};

type SmsNotificationInput = {
  account: NotifyAccount;
  fromNumber?: string | null;
  toNumber?: string | null;
  content: string;
  receivedAt?: Date | string | null;
};

type PhoneNotificationInput = {
  account: NotifyAccount;
  phone: Partial<DingtonePhoneNumber> & { phoneNumber?: string };
  action?: "purchase" | "renew" | "cancel" | "pause" | "resume";
  verificationSource?: string | null;
  verificationNote?: string | null;
};

type PointStoreNotificationInput = {
  account: NotifyAccount;
  email: string;
  productName: string;
  productId: string;
  productPrice: number | null;
  orderId: string | null;
  status: string;
  orderTime: Date | string | null;
};

export async function sendSmsTelegramNotification(input: SmsNotificationInput) {
  const code = extractVerificationCode(input.content);
  return sendPreparedTelegramNotification(input.account, buildSmsTelegramNotificationText(input), code ? buildCopyCodeReplyMarkup(code) : undefined);
}

export async function sendPhoneTelegramNotification(input: PhoneNotificationInput) {
  return sendPreparedTelegramNotification(input.account, buildPhoneTelegramNotificationText(input));
}

export async function sendPointStoreTelegramNotification(input: PointStoreNotificationInput) {
  return sendPreparedTelegramNotification(input.account, buildPointStoreTelegramNotificationText(input));
}

export function pointStoreNotificationTitle(status: string) {
  const value = status.trim().toLowerCase();
  const remoteStatus = normalizeRemotePointStoreOrderStatus(value);
  const normalized = remoteStatus !== "unknown"
    ? remoteStatus
    : /complete|success|done|fulfilled/.test(value)
      ? "completed"
      : /fail|cancel|error|reject/.test(value)
        ? "failed"
        : /process/.test(value)
          ? "processing"
          : value;
  if (normalized === "completed") {
    return "积分商城兑换成功";
  }
  if (normalized === "failed") {
    return "积分商城兑换失败";
  }
  if (normalized === "processing") {
    return "积分商城订单处理中";
  }
  return "积分商城兑换已提交";
}

export function buildPhoneTelegramNotificationText(input: PhoneNotificationInput) {
  const action = input.action ?? "purchase";
  return formatAccountNotification(input.account, phoneActionTitle(action), buildPhoneTelegramNotificationFields(input));
}

export function buildSmsTelegramNotificationText(input: SmsNotificationInput) {
  const code = extractVerificationCode(input.content);
  return [
    `<b>🔐 ${code ? "验证码短信" : "新短信"}</b>`,
    formatAccountLine(input.account),
    `目标号码：<code>${escapeTelegramHtml(input.toNumber ?? "-")}</code>`,
    `发送方：${escapeTelegramHtml(input.fromNumber ?? "-")}`,
    ...(code ? [`验证码：<code>${escapeTelegramHtml(code)}</code>`] : []),
    `内容：${escapeTelegramHtml(input.content)}`,
    `接收时间：${escapeTelegramHtml(formatTelegramTime(input.receivedAt))}`
  ].join("\n");
}

export function buildPointStoreTelegramNotificationText(input: PointStoreNotificationInput) {
  return formatAccountNotification(input.account, pointStoreNotificationTitle(input.status), [
    ["兑换邮箱", input.email],
    ["兑换商品", input.productName],
    ["商品 ID", input.productId],
    ["消耗积分", input.productPrice],
    ["订单 ID", input.orderId],
    ["订单状态", input.status],
    ["兑换时间", formatTelegramTime(input.orderTime)]
  ]);
}

function buildPhoneTelegramNotificationFields(input: PhoneNotificationInput): Array<[string, string | number | null | undefined]> {
  const action = input.action ?? "purchase";
  const title = phoneActionTitle(action);
  return [
    ["说道用户ID", input.account.dtUserId],
    ["绑定手机", input.account.phone],
    ["邮箱", input.account.email],
    [action === "purchase" ? "新手机号" : "手机号", input.phone.phoneNumber],
    ["号码状态", input.phone.status],
    ["国家码", input.phone.countryCode === undefined ? null : `+${input.phone.countryCode}`],
    ["收费/套餐", formatPhonePrice(input.phone)],
    ["验证来源", input.verificationSource],
    ["验证说明", input.verificationNote],
    ["操作时间", formatTelegramTime(new Date())]
  ];
}

export async function sendAccountTelegramNotification(
  account: NotifyAccount,
  type: string,
  fields: Array<[string, string | number | null | undefined]>,
  replyMarkup?: unknown
) {
  return sendPreparedTelegramNotification(account, formatAccountNotification(account, type, fields), replyMarkup);
}

async function sendPreparedTelegramNotification(account: NotifyAccount, text: string, replyMarkup?: unknown) {
  if (!account.telegramNotify) {
    return "";
  }
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  if (!settings.telegram_bot_token || !settings.telegram_chat_id) {
    return "";
  }

  const payload = {
    botToken: settings.telegram_bot_token,
    chatId: settings.telegram_chat_id,
    text: limitTelegramMessage(text),
    apiBaseUrl: settings.telegram_api_base_url,
    replyMarkup,
    parseMode: "HTML" as const
  };
  return sendTelegramNotificationWithMarkupFallback(payload);
}

export async function sendTelegramNotificationWithMarkupFallback(
  payload: Parameters<typeof telegramService.sendMessage>[0],
  api: Pick<typeof telegramService, "sendMessage"> = telegramService
) {
  try {
    return await api.sendMessage(payload);
  } catch (error) {
    if (payload.replyMarkup && isUnsupportedTelegramCopyMarkup(error)) {
      return api.sendMessage({ ...payload, replyMarkup: undefined });
    }
    throw error;
  }
}

function isUnsupportedTelegramCopyMarkup(error: unknown) {
  if (!(error instanceof TelegramApiError)) return false;
  if (error.status !== 400 && error.telegramErrorCode !== 400) return false;
  return /copy_text|button[_\s-]*type(?:[_\s-]+is)?[_\s-]*(?:invalid|unsupported|not[_\s-]*supported)|(?:invalid|unsupported|not supported)[^\r\n]*button[_\s-]*type/i.test(
    error.description
  );
}

export async function findNotifyAccount(db: TelegramDb, accountId: number) {
  return db.dtAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      nickname: true,
      email: true,
      phone: true,
      dtUserId: true,
      telegramNotify: true
    }
  });
}

function formatAccountNotification(
  account: NotifyAccount,
  type: string,
  fields: Array<[string, string | number | null | undefined]>
) {
  const lines = [`<b>🔔 ${escapeTelegramHtml(type)}</b>`, formatAccountLine(account)];
  for (const [label, value] of fields) {
    const normalized = value === null || value === undefined || value === "" ? "-" : String(value);
    lines.push(formatNotificationField(label, normalized));
  }
  return lines.join("\n");
}

function formatAccountLine(account: NotifyAccount) {
  return `账号：${escapeTelegramHtml(deriveAccountName(account))} <code>#${account.id}</code>`;
}

function formatNotificationField(label: string, value: string) {
  const escapedLabel = escapeTelegramHtml(label);
  const escapedValue = escapeTelegramHtml(value);
  if (/手机号|号码|验证码/.test(label) && value !== "-") {
    return `${escapedLabel}：<code>${escapedValue}</code>`;
  }
  return `${escapedLabel}：${escapedValue}`;
}

function deriveAccountName(input: { nickname?: string | null; email?: string | null; phone?: string | null; dtUserId?: string | null }) {
  return input.nickname?.trim() || input.email?.trim() || input.phone?.trim() || input.dtUserId?.trim() || "未命名账号";
}

function phoneActionTitle(action: "purchase" | "renew" | "cancel" | "pause" | "resume") {
  return {
    purchase: "获取新号码",
    renew: "续费号码",
    cancel: "取消号码",
    pause: "暂停号码",
    resume: "恢复号码"
  }[action];
}

function formatTelegramTime(value?: Date | string | null) {
  if (!value) {
    return new Date().toISOString();
  }
  return value instanceof Date ? value.toISOString() : value;
}

function formatPhonePrice(phone: Partial<DingtonePhoneNumber>) {
  const raw = phone.rawJson ? safeParseJson(phone.rawJson) : null;
  const price =
    pickNumber(raw, ["reserved5", "price", "orderPrice", "payAmount", "amount", "coinCost", "needBalance"]) ??
    pickNumber(raw?.priceQuote, ["price", "orderPrice", "payAmount", "amount", "coinCost", "needBalance"]);
  const packageServiceId = phone.packageServiceId ?? pickString(raw, ["packageServiceId", "package_service_id"]);
  const extraChargeMonthsCount = pickNumber(raw, ["extraChargeMonthsCount", "extra_charge_months_count"]);
  const extraChargeMonthsPrice = pickNumber(raw, ["extraChargeMonthsPrice", "extra_charge_months_price"]);
  const validPeriod =
    phone.validPeriodDays ?? pickNumber(raw, ["validPeriodDays", "valid_period_days", "usePeriod", "use_period"]);
  if (price === undefined && !packageServiceId && validPeriod === undefined && extraChargeMonthsPrice === undefined) {
    return "-";
  }
  return [
    price === undefined ? null : `${price} 说道币`,
    validPeriod === undefined ? null : formatValidPeriod(validPeriod),
    extraChargeMonthsPrice === undefined ? null : `${extraChargeMonthsPrice} 说道币 / ${extraChargeMonthsCount || 12}个月`,
    packageServiceId
  ].filter(Boolean).join(" / ");
}

function formatValidPeriod(value: number) {
  if (value <= 12) {
    return `${value} 个月`;
  }
  if (value >= 28 && value <= 372) {
    const months = Math.round(value / 31);
    return `${months} 个月`;
  }
  return `${value} 天`;
}

function extractVerificationCode(content: string) {
  return content.match(/\b\d{4,8}\b/)?.[0] ?? null;
}

export function buildCopyCodeReplyMarkup(code: string) {
  return {
    inline_keyboard: [
      [
        {
          text: `复制验证码 ${code}`,
          copy_text: { text: code }
        }
      ]
    ]
  };
}

function safeParseJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickNumber(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const next = record[key];
    if (typeof next === "number" && Number.isFinite(next)) {
      return next;
    }
    if (typeof next === "string" && next.trim() && Number.isFinite(Number(next))) {
      return Number(next);
    }
  }
  return undefined;
}

function pickString(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const next = record[key];
    if (typeof next === "string" && next.trim()) {
      return next.trim();
    }
  }
  return undefined;
}
