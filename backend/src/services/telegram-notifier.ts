import type { PrismaClient } from "@prisma/client";
import type { DingtonePhoneNumber } from "./dingtone/types.js";
import { getSettingsMap } from "./settings.service.js";
import { normalizeRemotePointStoreOrderStatus } from "./point-store-order-history.js";
import { TelegramApiError, telegramService } from "./telegram.js";
import { escapeTelegramHtml, limitTelegramMessage } from "./telegram-bot-ui.js";
import { resolveAccountDisplayName } from "../utils/account-name.js";

type TelegramDb = Pick<PrismaClient, "dtAccount">;

type NotifyAccount = {
  id: number;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  dtUserId: string | null;
  telegramNotify: boolean;
  appVariant?: "dingtone" | "dingdong" | string | null;
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
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  renewalDuration?: string | null;
  renewedUntil?: string | null;
  ownedPhoneNumbers?: string[];
};

type PhoneExpiryNotificationInput = {
  account: NotifyAccount;
  phone: Partial<DingtonePhoneNumber> & { phoneNumber?: string };
  balance?: number | null;
  remainingText: string;
  expiresAt: string;
  title?: string;
  ownedPhoneNumbers?: string[];
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

type AccountStatusNotificationInput = {
  account: NotifyAccount;
  status: "expired" | "offline";
  reason?: string | null;
  canVerificationRelogin?: boolean;
};

export async function sendSmsTelegramNotification(input: SmsNotificationInput) {
  const code = extractVerificationCode(input.content);
  return sendPreparedTelegramNotification(input.account, buildSmsTelegramNotificationText(input), code ? buildCopyCodeReplyMarkup(code) : undefined);
}

export async function sendPhoneTelegramNotification(input: PhoneNotificationInput) {
  return sendPreparedTelegramNotification(input.account, buildPhoneTelegramNotificationText(input));
}

export async function sendPhoneExpiryTelegramNotification(input: PhoneExpiryNotificationInput, replyMarkup?: unknown) {
  return sendPreparedTelegramNotification(input.account, buildPhoneExpiryTelegramNotificationText(input), replyMarkup);
}

export async function sendPointStoreTelegramNotification(input: PointStoreNotificationInput) {
  return sendPreparedTelegramNotification(input.account, buildPointStoreTelegramNotificationText(input));
}

export async function sendAccountStatusTelegramNotification(input: AccountStatusNotificationInput, replyMarkup?: unknown) {
  return sendPreparedTelegramNotification(input.account, buildAccountStatusTelegramNotificationText(input), replyMarkup);
}

export function buildAccountStatusTelegramNotificationText(input: AccountStatusNotificationInput) {
  const expired = input.status === "expired";
  return formatAccountNotification(input.account, expired ? "账户登录已失效" : "账户监听已离线", [
    ["当前状态", expired ? "登录凭据已失效" : "监听未运行"],
    ["发生时间", formatTelegramTime(new Date())],
    [
      "恢复方式",
      expired
        ? input.canVerificationRelogin
          ? "点击下方按钮发送登录验证码，再按提示提交验证码"
          : "请在面板重新导入或登录账户"
        : "点击下方按钮恢复监听"
    ]
  ]);
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

export function buildPhoneExpiryTelegramNotificationText(input: PhoneExpiryNotificationInput) {
  const currency = phoneCurrencyLabel(input.account.appVariant);
  const renewalCost = getPhoneRenewalCost(input.phone);
  return formatAccountNotification(input.account, input.title ?? "号码即将到期", [
    ["手机号", input.phone.phoneNumber],
    ["号码备注", input.phone.displayName],
    ["号码状态", input.phone.status],
    ...buildOwnedPhoneFields(input.ownedPhoneNumbers),
    [`当前${currency}`, formatCoinBalance(input.balance)],
    ["续期所需", renewalCost === null ? "暂未获取" : `${formatCoinBalance(renewalCost)} ${currency}`],
    ["每次续期", formatPhoneRenewalPeriod(input.phone)],
    ["剩余时间", input.remainingText],
    ["到期时间", input.expiresAt],
    ["操作提示", "请使用下方按钮，二次确认后才会执行"]
  ]);
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
  const currency = phoneCurrencyLabel(input.account.appVariant);
  return [
    [`${input.account.appVariant === "dingdong" ? "叮咚" : "说道"}用户ID`, input.account.dtUserId],
    ["绑定手机", input.account.phone],
    ["邮箱", input.account.email],
    [action === "purchase" ? "新手机号" : "手机号", input.phone.phoneNumber],
    ["号码状态", input.phone.status],
    ["国家码", input.phone.countryCode === undefined ? null : `+${input.phone.countryCode}`],
    ["收费/套餐", formatPhonePrice(input.phone, input.account.appVariant)],
    ...buildOwnedPhoneFields(input.ownedPhoneNumbers),
    ...(action === "renew"
      ? [
          [`续期前${currency}`, formatCoinBalance(input.balanceBefore)],
          [`续期后${currency}`, formatCoinBalance(input.balanceAfter)],
          ["续期时长", input.renewalDuration ?? formatPhoneRenewalPeriod(input.phone)],
          ["续期后到期", input.renewedUntil ?? formatEpochForTelegram(input.phone.expiredTime)]
        ] satisfies Array<[string, string | number | null | undefined]>
      : []),
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
      telegramNotify: true,
      appVariant: true
    }
  });
}

function formatAccountNotification(
  account: NotifyAccount,
  type: string,
  fields: Array<[string, string | number | null | undefined]>
) {
  const lines = [`<b>${notificationIcon(type)} ${escapeTelegramHtml(type)}</b>`, formatAccountLine(account), ""];
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
  if (label !== "账户号码数量" && /手机号|号码|验证码/.test(label) && value !== "-") {
    return `${escapedLabel}：<code>${escapedValue}</code>`;
  }
  return `${escapedLabel}：${escapedValue}`;
}

function buildOwnedPhoneFields(phoneNumbers?: string[]): Array<[string, string]> {
  if (!phoneNumbers) return [];
  const unique = [...new Set(phoneNumbers.map((value) => value.trim()).filter(Boolean))];
  return [
    ["账户号码数量", `${unique.length} 个`],
    ...unique.map((phoneNumber, index) => [`号码 ${index + 1}`, phoneNumber] as [string, string])
  ];
}

function deriveAccountName(input: { nickname?: string | null; email?: string | null; phone?: string | null; dtUserId?: string | null }) {
  return resolveAccountDisplayName(input, "未命名账号");
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

function notificationIcon(type: string) {
  if (/到期|过期/.test(type)) return "⏰";
  if (/续费|续期/.test(type)) return "✅";
  if (/取消/.test(type)) return "🗑";
  if (/短信|验证码/.test(type)) return "🔐";
  return "🔔";
}

function formatTelegramTime(value?: Date | string | null) {
  if (!value) {
    return new Date().toISOString();
  }
  return value instanceof Date ? value.toISOString() : value;
}

function formatPhonePrice(phone: Partial<DingtonePhoneNumber>, appVariant?: NotifyAccount["appVariant"]) {
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
    price === undefined ? null : `${formatCoinBalance(price)} ${phoneCurrencyLabel(appVariant)}`,
    validPeriod === undefined ? null : formatValidPeriod(validPeriod),
    extraChargeMonthsPrice === undefined
      ? null
      : `${formatCoinBalance(extraChargeMonthsPrice)} ${phoneCurrencyLabel(appVariant)} / ${extraChargeMonthsCount || 12}个月`,
    packageServiceId
  ].filter(Boolean).join(" / ");
}

export function getPhoneRenewalCost(phone: Partial<DingtonePhoneNumber>) {
  const raw = phone.rawJson ? safeParseJson(phone.rawJson) : null;
  return (
    pickNumber(raw, ["reserved5", "price", "orderPrice", "payAmount", "amount", "coinCost", "needBalance"]) ??
    pickNumber(raw?.priceQuote, ["price", "orderPrice", "payAmount", "amount", "coinCost", "needBalance"]) ??
    null
  );
}

export function formatPhoneRenewalPeriod(phone: Partial<DingtonePhoneNumber>) {
  const raw = phone.rawJson ? safeParseJson(phone.rawJson) : null;
  const period = phone.validPeriodDays ?? pickNumber(raw, ["validPeriodDays", "valid_period_days", "usePeriod", "use_period"]);
  return period === undefined ? "暂未获取" : formatValidPeriod(period);
}

export function phoneCurrencyLabel(appVariant?: NotifyAccount["appVariant"]) {
  return appVariant === "dingdong" ? "叮咚币" : "说道币";
}

export function formatCoinBalance(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "暂未获取";
  return Number(value.toFixed(2)).toString();
}

function formatEpochForTelegram(value?: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return value;
  return new Date(parsed > 1_000_000_000_000 ? parsed : parsed * 1000).toISOString();
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
