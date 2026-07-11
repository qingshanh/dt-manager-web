import type { PrismaClient } from "@prisma/client";
import type { DingtonePhoneNumber } from "./dingtone/types.js";
import { getSettingsMap } from "./settings.service.js";
import { telegramService } from "./telegram.js";

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
  return sendAccountTelegramNotification(
    input.account,
    code ? "验证码短信" : "新短信",
    [
      ["账号", deriveAccountName(input.account)],
      ["面板账号ID", input.account.id],
      ["说道用户ID", input.account.dtUserId],
      ["接收号码", input.toNumber ?? input.account.phone],
      ["发送方", input.fromNumber],
      ["验证码", code],
      ["短信内容", input.content],
      ["接收时间", formatTelegramTime(input.receivedAt)]
    ],
    code ? buildCopyCodeReplyMarkup(code) : undefined
  );
}

export async function sendPhoneTelegramNotification(input: PhoneNotificationInput) {
  return sendAccountTelegramNotification(input.account, phoneActionTitle(input.action ?? "purchase"), buildPhoneTelegramNotificationFields(input));
}

export async function sendPointStoreTelegramNotification(input: PointStoreNotificationInput) {
  return sendAccountTelegramNotification(input.account, "积分商城兑换成功", [
    ["账号", deriveAccountName(input.account)],
    ["面板账号ID", input.account.id],
    ["说道用户ID", input.account.dtUserId],
    ["兑换邮箱", input.email],
    ["兑换商品", input.productName],
    ["商品 ID", input.productId],
    ["消耗积分", input.productPrice],
    ["订单 ID", input.orderId],
    ["订单状态", input.status],
    ["兑换时间", formatTelegramTime(input.orderTime)]
  ]);
}

export function buildPhoneTelegramNotificationText(input: PhoneNotificationInput) {
  const action = input.action ?? "purchase";
  return formatAccountNotification(input.account, phoneActionTitle(action), buildPhoneTelegramNotificationFields(input));
}

function buildPhoneTelegramNotificationFields(input: PhoneNotificationInput): Array<[string, string | number | null | undefined]> {
  const action = input.action ?? "purchase";
  const title = phoneActionTitle(action);
  return [
    ["通知类型", title],
    ["面板账号ID", input.account.id],
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
    text: formatAccountNotification(account, type, fields),
    apiBaseUrl: settings.telegram_api_base_url,
    replyMarkup
  };
  try {
    return await telegramService.sendMessage(payload);
  } catch (error) {
    if (replyMarkup) {
      return telegramService.sendMessage({ ...payload, replyMarkup: undefined });
    }
    throw error;
  }
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
  const title = `${deriveAccountName(account)} - ${type}`;
  const lines = [`【${title}】`, ""];
  for (const [label, value] of fields) {
    const normalized = value === null || value === undefined || value === "" ? "-" : String(value);
    lines.push(`${label}: ${normalized}`);
  }
  return lines.join("\n");
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

function buildCopyCodeReplyMarkup(code: string) {
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
