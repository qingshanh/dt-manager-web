import { AccountStatus, MessageDirection, MessageType, PhoneStatus } from "@prisma/client";
import type { DtAccount, PhoneNumber } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decryptText } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
import { serializePhoneNumber } from "../utils/serializers.js";
import { accountMonitorService } from "./account-monitor.js";
import { refreshAccountRuntimeData } from "./account-runtime.js";
import {
  DirectDingtoneGateway,
  buildDirectAccessCodeDryRun,
  inferAccessCodeCountryCode,
  listenDirectSessionPushes,
  runDirectAccessCodeProbe
} from "./dingtone/direct-gateway.js";
import type { DingtonePhoneNumber, DingtonePhonePurchaseCandidate } from "./dingtone/types.js";
import { storeParsedSmsPushes } from "./message-runtime.js";
import { getSettingsMap } from "./settings.service.js";
import { sendPhoneTelegramNotification } from "./telegram-notifier.js";
import { telegramService, type TelegramUpdate } from "./telegram.js";
import { parseTelegramCallback, type TelegramPanelCallback } from "./telegram-bot-callbacks.js";
import {
  accountActionKeyboard,
  accountListKeyboard,
  escapeTelegramHtml,
  formatAccountCard,
  formatAccountListCard,
  formatCommandHelp,
  formatPanelStatusCard,
  formatPhoneAccountListCard,
  formatPhoneCard,
  formatPhoneListCard,
  formatRecentMessagesCard,
  limitTelegramMessage,
  mainPanelKeyboard,
  phoneAccountKeyboard,
  phoneDetailKeyboard,
  phoneListKeyboard
} from "./telegram-bot-ui.js";

const botGateway = new DirectDingtoneGateway();
let botCommandsCacheKey = "";
const TELEGRAM_NOTE_MAX_LENGTH = 100;
const TELEGRAM_ACCOUNT_PAGE_SIZE = 8;
const TELEGRAM_PHONE_ACCOUNT_PAGE_SIZE = 8;
const TELEGRAM_ACCOUNT_PHONE_PAGE_SIZE = 6;
type PhoneMatch = "confirmed" | "unverified" | "mismatch";
type TelegramBotDb = Pick<typeof prisma, "dtAccount" | "phoneNumber" | "message">;

export function isConfirmToken(value: string | undefined | null) {
  return value?.trim().toLowerCase() === "confirm";
}

export function normalizeTelegramNoteText(value: string) {
  const normalized = value.trim();
  return {
    normalized,
    empty: normalized.length === 0,
    tooLong: normalized.length > TELEGRAM_NOTE_MAX_LENGTH,
    maxLength: TELEGRAM_NOTE_MAX_LENGTH
  };
}

type BotReply = {
  text: string;
  replyMarkup?: unknown;
  parseMode?: "HTML";
};

export class TelegramBotService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => void this.tick(), 3_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(seconds: number) {
    this.stop();
    this.timer = setTimeout(() => void this.tick(), Math.max(5, seconds) * 1000);
    this.timer.unref?.();
  }

  private async tick() {
    if (this.running) {
      this.schedule(10);
      return;
    }
    this.running = true;
    let pollSeconds = 10;
    try {
      const settings = await getSettingsMap();
      pollSeconds = parsePositiveInt(settings.telegram_bot_poll_interval_seconds, 10);
      if (settings.telegram_bot_enabled !== "true") {
        return;
      }
      const botToken = settings.telegram_bot_token;
      if (!botToken) {
        return;
      }
      await ensureBotCommands(botToken, settings.telegram_api_base_url);
      const lastUpdateId = parsePositiveInt(settings.telegram_bot_last_update_id, 0);
      const updates = await telegramService.getUpdates({
        botToken,
        offset: lastUpdateId > 0 ? lastUpdateId + 1 : undefined,
        limit: 20,
        timeout: 0,
        apiBaseUrl: settings.telegram_api_base_url
      });
      for (const update of updates) {
        await this.handleUpdate(update, settings).catch((error) => {
          logger.warn("Telegram bot update handling failed", {
            updateId: update.update_id,
            error: sanitizeTelegramError(errorMessage(error))
          });
        });
        await prisma.setting.upsert({
          where: { key: "telegram_bot_last_update_id" },
          update: { value: String(update.update_id) },
          create: { key: "telegram_bot_last_update_id", value: String(update.update_id), description: "Telegram bot last processed update id" }
        });
      }
    } catch (error) {
      logger.warn("Telegram bot polling failed", {
        error: sanitizeTelegramError(errorMessage(error))
      });
    } finally {
      this.running = false;
      this.schedule(pollSeconds);
    }
  }

  private async handleUpdate(update: TelegramUpdate, settings: Record<string, string>) {
    const callback = update.callback_query;
    if (callback) {
      const chatId = callback.message?.chat.id === undefined ? "" : String(callback.message.chat.id);
      const userId = callback.from?.id === undefined ? "" : String(callback.from.id);
      const botToken = settings.telegram_bot_token;
      if (!chatId) {
        return;
      }
      if (!botToken) {
        return;
      }
      await runAuthorizedTelegramCallback(
        {
          allowedChatIds: settings.telegram_allowed_chat_ids,
          chatId,
          userId,
          botToken,
          callbackQueryId: callback.id,
          apiBaseUrl: settings.telegram_api_base_url
        },
        async () => {
          const parsed = parseTelegramCallback(callback.data);
          if (!parsed) {
            await this.replyToCallback(settings, chatId, callback.message?.message_id, await rootPanelReply());
            return;
          }
          if (isSlowTelegramCallback(parsed)) {
            await this.showCallbackProgress(settings, chatId, callback.message?.message_id);
          }
          const reply = await handleTelegramCallbackSafe(parsed);
          await this.replyToCallback(settings, chatId, callback.message?.message_id, reply);
        }
      );
      return;
    }

    const message = update.message;
    const text = message?.text?.trim();
    if (!message || !text) {
      return;
    }
    const chatId = String(message.chat.id);
    const userId = message.from?.id === undefined ? "" : String(message.from.id);
    if (!isWhitelisted(settings.telegram_allowed_chat_ids, chatId, userId)) {
      await this.reply(
        settings,
        chatId,
        `未授权。请在后台 telegram_allowed_chat_ids 添加 chat_id 或 user_id。\nchat_id: ${chatId}\nuser_id: ${userId || "-"}`
      );
      return;
    }

    const [rawCommand = "", ...args] = text.split(/\s+/);
    const command = rawCommand.replace(/@.+$/, "").toLowerCase();
    switch (command) {
      case "/start":
      case "/help":
        await this.reply(settings, chatId, helpReply());
        return;
      case "/panel":
        await this.reply(settings, chatId, await rootPanelReply());
        return;
      case "/accounts":
        await this.reply(settings, chatId, await accountListReply(1));
        return;
      case "/account":
        await this.reply(settings, chatId, await accountDetailReply(Number(args[0])));
        return;
      case "/phones":
        await this.reply(settings, chatId, await accountPhoneListReply(Number(args[0]), 1));
        return;
      case "/messages":
        await this.reply(settings, chatId, await recentMessagesReply(Number(args[0]), Number(args[1])));
        return;
      case "/countries":
        await this.reply(settings, chatId, await countryListText(Number(args[0])));
        return;
      case "/preview_number":
        await this.reply(settings, chatId, await previewNumberText(Number(args[0]), args[1], Number(args[2])));
        return;
      case "/buy_number":
        await this.reply(settings, chatId, await buyNumberText(Number(args[0]), args[1], args.slice(2)));
        return;
      case "/start_monitor":
        await this.reply(settings, chatId, await toggleMonitorText(args[0], true));
        return;
      case "/stop_monitor":
        await this.reply(settings, chatId, await toggleMonitorText(args[0], false));
        return;
      case "/notify":
        await this.reply(settings, chatId, await toggleNotifyText(args[0], args[1]));
        return;
      case "/set_note":
        await this.reply(settings, chatId, await setNoteText(Number(args[0]), args.slice(1).join(" ")));
        return;
      case "/clear_note":
        await this.reply(settings, chatId, await clearNoteText(Number(args[0])));
        return;
      case "/set_phone_note":
        await this.reply(settings, chatId, await setPhoneNoteText(Number(args[0]), args[1], args.slice(2).join(" ")));
        return;
      case "/clear_phone_note":
        await this.reply(settings, chatId, await clearPhoneNoteText(Number(args[0]), args[1]));
        return;
      case "/status":
        await this.reply(settings, chatId, await rootPanelReply());
        return;
      case "/code":
        await this.reply(settings, chatId, await collectCodeText(Number(args[0]), args[1]));
        return;
      case "/trace_access_code":
        await this.reply(settings, chatId, await traceAccessCodeText(args));
        return;
      case "/refresh_account":
        await this.reply(settings, chatId, await refreshAccountText(Number(args[0])));
        return;
      case "/refresh_phones":
        await this.reply(settings, chatId, await refreshPhonesText(Number(args[0])));
        return;
      case "/renew_phone":
        await this.reply(settings, chatId, await phoneActionText(Number(args[0]), parsePhoneActionArgs(args), "renew"));
        return;
      case "/pause_phone":
        await this.reply(settings, chatId, await phoneActionText(Number(args[0]), parsePhoneActionArgs(args), "pause"));
        return;
      case "/resume_phone":
        await this.reply(settings, chatId, await phoneActionText(Number(args[0]), parsePhoneActionArgs(args), "resume"));
        return;
      case "/cancel_phone":
        await this.reply(settings, chatId, await phoneActionText(Number(args[0]), parsePhoneActionArgs(args), "cancel"));
        return;
      default:
        await this.reply(settings, chatId, "未知命令，发送 /help 查看可用命令。");
    }
  }

  private async reply(settings: Record<string, string>, chatId: string, reply: BotReply | string) {
    const botToken = settings.telegram_bot_token;
    if (!botToken) {
      return;
    }
    const normalized = typeof reply === "string" ? { text: reply } : reply;
    const safeText = sanitizeTelegramError(normalized.text);
    await telegramService.sendMessage({
      botToken,
      chatId,
      text: normalized.parseMode === "HTML" ? limitTelegramMessage(safeText) : trimTelegramText(safeText),
      replyMarkup: normalized.replyMarkup,
      parseMode: normalized.parseMode,
      apiBaseUrl: settings.telegram_api_base_url
    });
  }

  private async replyToCallback(
    settings: Record<string, string>,
    chatId: string,
    messageId: number | undefined,
    reply: BotReply
  ) {
    await deliverTelegramCallbackReply({ settings, chatId, messageId, reply });
  }

  private async showCallbackProgress(settings: Record<string, string>, chatId: string, messageId: number | undefined) {
    const botToken = settings.telegram_bot_token;
    if (!botToken || messageId === undefined) {
      return;
    }
    await telegramService.editMessageText({
      botToken,
      chatId,
      messageId,
      text: "<b>⏳ 正在处理</b>",
      parseMode: "HTML",
      apiBaseUrl: settings.telegram_api_base_url
    }).catch((error) => {
      logger.warn("Telegram callback progress edit failed", {
        chatId,
        messageId,
        error: sanitizeTelegramError(errorMessage(error))
      });
    });
  }
}

type TelegramCallbackAuthorizationInput = {
  allowedChatIds?: string;
  chatId: string;
  userId: string;
  botToken: string;
  callbackQueryId: string;
  apiBaseUrl?: string | null;
};

export async function runAuthorizedTelegramCallback(
  input: TelegramCallbackAuthorizationInput,
  operation: () => Promise<void>,
  api: Pick<typeof telegramService, "answerCallbackQuery"> = telegramService
) {
  if (!isWhitelisted(input.allowedChatIds, input.chatId, input.userId)) {
    await api.answerCallbackQuery({
      botToken: input.botToken,
      callbackQueryId: input.callbackQueryId,
      text: "未授权",
      apiBaseUrl: input.apiBaseUrl
    });
    return false;
  }
  await api.answerCallbackQuery({
    botToken: input.botToken,
    callbackQueryId: input.callbackQueryId,
    apiBaseUrl: input.apiBaseUrl
  });
  await operation();
  return true;
}

type TelegramCallbackDeliveryInput = {
  settings: Record<string, string>;
  chatId: string;
  messageId?: number;
  reply: BotReply;
};

export async function deliverTelegramCallbackReply(
  input: TelegramCallbackDeliveryInput,
  api: Pick<typeof telegramService, "editMessageText" | "sendMessage"> = telegramService
) {
  const botToken = input.settings.telegram_bot_token;
  if (!botToken) return "skipped";
  const safeText = sanitizeTelegramError(input.reply.text);
  const payload = {
    botToken,
    chatId: input.chatId,
    text: input.reply.parseMode === "HTML" ? limitTelegramMessage(safeText) : trimTelegramText(safeText),
    replyMarkup: input.reply.replyMarkup,
    parseMode: input.reply.parseMode,
    apiBaseUrl: input.settings.telegram_api_base_url
  };
  if (input.messageId !== undefined) {
    try {
      await api.editMessageText({ ...payload, messageId: input.messageId });
      return "edited";
    } catch (error) {
      logger.warn("Telegram callback message edit failed; sending a new message", {
        chatId: input.chatId,
        messageId: input.messageId,
        error: sanitizeTelegramError(errorMessage(error))
      });
    }
  }
  await api.sendMessage(payload);
  return "sent";
}

async function ensureBotCommands(botToken: string, apiBaseUrl?: string | null) {
  const cacheKey = `${botToken}:${apiBaseUrl ?? ""}`;
  if (botCommandsCacheKey === cacheKey) {
    return;
  }
  await telegramService
    .setMyCommands({
      botToken,
      apiBaseUrl,
      commands: [
        { command: "panel", description: "打开机器人控制面板" },
        { command: "accounts", description: "查看账户列表" },
        { command: "account", description: "查看账户详情：/account 3" },
        { command: "phones", description: "查看手机号：/phones 3" },
        { command: "messages", description: "查看最近消息：/messages 3" },
        { command: "countries", description: "查看可选号国家：/countries 3" },
        { command: "preview_number", description: "预览号码：/preview_number 3 FR" },
        { command: "buy_number", description: "购买号码：/buy_number 3 FR confirm 75" },
        { command: "code", description: "直连收取验证码：/code 3" },
        { command: "trace_access_code", description: "验证码登录追踪：默认 dry-run" },
        { command: "start_monitor", description: "启动监听：/start_monitor 3 或 all" },
        { command: "stop_monitor", description: "停止监听：/stop_monitor 3 或 all" },
        { command: "notify", description: "开关账户通知：/notify 3 on" },
        { command: "set_note", description: "修改账户备注：/set_note 3 备注" },
        { command: "clear_note", description: "清空账户备注：/clear_note 3" },
        { command: "set_phone_note", description: "修改号码备注：/set_phone_note 3 121 备注" },
        { command: "clear_phone_note", description: "清空号码备注：/clear_phone_note 3 121" },
        { command: "status", description: "查看面板运行概览" },
        { command: "refresh_account", description: "刷新账户资料：/refresh_account 3" },
        { command: "refresh_phones", description: "刷新已购号码：/refresh_phones 3" },
        { command: "renew_phone", description: "续费号码：/renew_phone 3 121 confirm" },
        { command: "pause_phone", description: "暂停号码：/pause_phone 3 121 confirm" },
        { command: "resume_phone", description: "恢复号码：/resume_phone 3 121 confirm" },
        { command: "cancel_phone", description: "取消号码：/cancel_phone 3 121 confirm" },
        { command: "help", description: "查看帮助" }
      ]
    })
    .then(() => {
      botCommandsCacheKey = cacheKey;
    })
    .catch((error) => {
      logger.warn("Failed to set Telegram bot commands", {
        error: sanitizeTelegramError(errorMessage(error))
      });
    });
}

function helpReply(): BotReply {
  return { text: formatCommandHelp(), replyMarkup: mainPanelKeyboard(), parseMode: "HTML" };
}

export async function loadTelegramPanelStats(db: TelegramBotDb = prisma) {
  const [accountCount, onlineCount, monitorCount, telegramCount, phoneCount, unreadCount] = await Promise.all([
    db.dtAccount.count(),
    db.dtAccount.count({ where: { status: AccountStatus.online } }),
    db.dtAccount.count({ where: { monitorEnabled: true } }),
    db.dtAccount.count({ where: { telegramNotify: true } }),
    db.phoneNumber.count(),
    db.message.count({
      where: {
        direction: MessageDirection.incoming,
        msgType: { not: MessageType.system },
        isRead: false
      }
    })
  ]);
  return { accountCount, onlineCount, monitorCount, telegramCount, phoneCount, unreadCount };
}

export async function loadTelegramAccountPage(requestedPage: number, db: TelegramBotDb = prisma) {
  const total = await db.dtAccount.count();
  const pagination = telegramPagination(total, requestedPage, TELEGRAM_ACCOUNT_PAGE_SIZE);
  const items = await db.dtAccount.findMany({
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    skip: pagination.skip,
    take: TELEGRAM_ACCOUNT_PAGE_SIZE,
    select: {
      id: true,
      nickname: true,
      email: true,
      phone: true,
      dtUserId: true,
      status: true,
      _count: { select: { phoneNumbers: true } }
    }
  });
  return { items, page: pagination.page, totalPages: pagination.totalPages };
}

export async function loadTelegramPhoneAccountPage(requestedPage: number, db: TelegramBotDb = prisma) {
  const where = { phoneNumbers: { some: {} } };
  const total = await db.dtAccount.count({ where });
  const pagination = telegramPagination(total, requestedPage, TELEGRAM_PHONE_ACCOUNT_PAGE_SIZE);
  const items = await db.dtAccount.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    skip: pagination.skip,
    take: TELEGRAM_PHONE_ACCOUNT_PAGE_SIZE,
    select: {
      id: true,
      nickname: true,
      email: true,
      phone: true,
      dtUserId: true,
      status: true,
      _count: { select: { phoneNumbers: true } }
    }
  });
  return { items, page: pagination.page, totalPages: pagination.totalPages };
}

export async function loadTelegramAccountPhonePage(accountId: number, requestedPage: number, db: TelegramBotDb = prisma) {
  const where = { accountId };
  const total = await db.phoneNumber.count({ where });
  const pagination = telegramPagination(total, requestedPage, TELEGRAM_ACCOUNT_PHONE_PAGE_SIZE);
  const items = await db.phoneNumber.findMany({
    where,
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    skip: pagination.skip,
    take: TELEGRAM_ACCOUNT_PHONE_PAGE_SIZE,
    select: { id: true, phoneNumber: true, status: true }
  });
  return { items, page: pagination.page, totalPages: pagination.totalPages };
}

export async function loadTelegramRecentMessages(accountId: number | undefined, limit = 5, db: TelegramBotDb = prisma) {
  const safeLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 10) : 5;
  return db.message.findMany({
    where: {
      direction: MessageDirection.incoming,
      msgType: { not: MessageType.system },
      ...(accountId === undefined ? {} : { accountId })
    },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: safeLimit,
    select: {
      id: true,
      accountId: true,
      fromNumber: true,
      toNumber: true,
      content: true,
      receivedAt: true,
      account: {
        select: { id: true, nickname: true, email: true, phone: true, dtUserId: true }
      }
    }
  });
}

export async function loadTelegramAccountDetail(accountId: number, db: TelegramBotDb = prisma) {
  return db.dtAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      nickname: true,
      email: true,
      phone: true,
      dtUserId: true,
      appVariant: true,
      status: true,
      monitorEnabled: true,
      telegramNotify: true,
      lastError: true,
      _count: {
        select: {
          phoneNumbers: true,
          messages: {
            where: {
              direction: MessageDirection.incoming,
              msgType: { not: MessageType.system },
              isRead: false
            }
          }
        }
      }
    }
  });
}

export async function loadTelegramPhoneDetail(accountId: number, phoneId: number, db: TelegramBotDb = prisma) {
  const phone = await db.phoneNumber.findFirst({ where: { id: phoneId, accountId } });
  if (!phone) return null;
  const { allow_receive_sms: allowReceiveSms } = serializePhoneNumber(phone);
  return {
    id: phone.id,
    accountId: phone.accountId,
    phoneNumber: phone.phoneNumber,
    displayName: phone.displayName,
    status: phone.status,
    countryCode: phone.countryCode,
    providerId: phone.providerId,
    expiredTime: phone.expiredTime,
    autoRenew: phone.autoRenew,
    allowReceiveSms
  };
}

async function rootPanelReply(): Promise<BotReply> {
  return { text: formatPanelStatusCard(await loadTelegramPanelStats()), replyMarkup: mainPanelKeyboard(), parseMode: "HTML" };
}

async function statusPanelReply(): Promise<BotReply> {
  const reply = await rootPanelReply();
  return { ...reply, text: `${reply.text}\n刷新时间：${escapeTelegramHtml(new Date().toISOString())}` };
}

async function accountListReply(page: number): Promise<BotReply> {
  const result = await loadTelegramAccountPage(page);
  const items = result.items.map((item) => ({
    id: item.id,
    name: accountName(item),
    status: String(item.status),
    phoneCount: item._count.phoneNumbers
  }));
  return {
    text: formatAccountListCard(items, result.page, result.totalPages),
    replyMarkup: accountListKeyboard(items, result.page, result.totalPages),
    parseMode: "HTML"
  };
}

async function phoneAccountListReply(page: number): Promise<BotReply> {
  const result = await loadTelegramPhoneAccountPage(page);
  const items = result.items.map((item) => ({ id: item.id, name: accountName(item), phoneCount: item._count.phoneNumbers }));
  return {
    text: formatPhoneAccountListCard(items, result.page, result.totalPages),
    replyMarkup: phoneAccountKeyboard(items, result.page, result.totalPages),
    parseMode: "HTML"
  };
}

async function accountDetailReply(accountId: number): Promise<BotReply> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) return htmlNotice("用法：/account <账户ID>");
  const account = await loadTelegramAccountDetail(accountId);
  if (!account) return htmlNotice("账户不存在。");
  return {
    text: formatAccountCard({
      id: account.id,
      name: accountName(account),
      appVariant: String(account.appVariant),
      status: String(account.status),
      monitorEnabled: account.monitorEnabled,
      telegramNotify: account.telegramNotify,
      phoneCount: account._count.phoneNumbers,
      unreadCount: account._count.messages,
      lastError: sanitizeTelegramError(account.lastError ?? "-")
    }),
    replyMarkup: accountActionKeyboard(account),
    parseMode: "HTML"
  };
}

async function accountPhoneListReply(accountId: number, page: number): Promise<BotReply> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) return htmlNotice("用法：/phones <账户ID>");
  const [account, result] = await Promise.all([loadTelegramAccountDetail(accountId), loadTelegramAccountPhonePage(accountId, page)]);
  if (!account) return htmlNotice("账户不存在。");
  const items = result.items.map((item) => ({ id: item.id, phoneNumber: item.phoneNumber, status: String(item.status) }));
  return {
    text: formatPhoneListCard(accountName(account), items, result.page, result.totalPages),
    replyMarkup: phoneListKeyboard(accountId, items, result.page, result.totalPages),
    parseMode: "HTML"
  };
}

async function phoneDetailReply(accountId: number, phoneId: number): Promise<BotReply> {
  const phone = await loadTelegramPhoneDetail(accountId, phoneId);
  if (!phone) return htmlNotice("号码不存在。");
  return { text: formatPhoneCard(phone), replyMarkup: phoneDetailKeyboard(accountId, phoneId), parseMode: "HTML" };
}

async function recentMessagesReply(accountId?: number, limitInput?: number): Promise<BotReply> {
  if (accountId !== undefined && (!Number.isSafeInteger(accountId) || accountId <= 0)) {
    return htmlNotice("用法：/messages <账户ID> [数量]");
  }
  const messages = await loadTelegramRecentMessages(accountId, limitInput);
  const items = messages.map((item) => ({
    accountName: accountName(item.account),
    toNumber: item.toNumber,
    fromNumber: item.fromNumber,
    content: item.content,
    receivedAt: item.receivedAt
  }));
  const account = accountId === undefined ? null : await loadTelegramAccountDetail(accountId);
  return {
    text: formatRecentMessagesCard(items),
    replyMarkup: account ? accountActionKeyboard(account) : mainPanelKeyboard(),
    parseMode: "HTML"
  };
}

export async function handleTelegramCallback(callback: TelegramPanelCallback): Promise<BotReply> {
  if (callback.scope === "panel") {
    if (callback.action === "accounts") return accountListReply(callback.page);
    if (callback.action === "phones") return phoneAccountListReply(callback.page);
    if (callback.action === "messages") return recentMessagesReply();
    if (callback.action === "help") return helpReply();
    if (callback.action === "status") return statusPanelReply();
    return rootPanelReply();
  }
  if (callback.scope === "phone") {
    if (callback.action === "note") return phoneNoteCommandReply(callback.accountId, callback.phoneId);
    return phoneDetailReply(callback.accountId, callback.phoneId);
  }
  if (callback.action === "detail") return accountDetailReply(callback.accountId);
  if (callback.action === "messages") return recentMessagesReply(callback.accountId, 5);
  if (callback.action === "phones") return accountPhoneListReply(callback.accountId, callback.page);
  if (callback.action === "refresh") return accountMutationReply(callback.accountId, () => refreshAccountText(callback.accountId));
  if (callback.action === "refresh_phones") return accountMutationReply(callback.accountId, () => refreshPhonesText(callback.accountId));
  return applyTelegramAccountTargetState({ accountId: callback.accountId, action: callback.action });
}

async function handleTelegramCallbackSafe(callback: TelegramPanelCallback): Promise<BotReply> {
  try {
    return await handleTelegramCallback(callback);
  } catch (error) {
    logger.warn("Telegram bot callback failed", { callback, error: sanitizeTelegramError(errorMessage(error)) });
    return htmlNotice(telegramUserErrorText(error));
  }
}

type TelegramAccountTargetAction = "monitor_on" | "monitor_off" | "notify_on" | "notify_off";
type TelegramAccountState = { monitorEnabled: boolean; telegramNotify: boolean };
type TelegramAccountStateDeps = {
  loadAccount: (accountId: number) => Promise<TelegramAccountState | null>;
  setMonitor: (accountId: number, enabled: boolean) => Promise<void>;
  setNotify: (accountId: number, enabled: boolean) => Promise<void>;
  renderAccount: (accountId: number) => Promise<BotReply>;
};

const telegramAccountStateDeps: TelegramAccountStateDeps = {
  loadAccount: loadTelegramAccountDetail,
  setMonitor: async (accountId, enabled) => {
    if (enabled) await accountMonitorService.start(accountId);
    else await accountMonitorService.stop(accountId);
  },
  setNotify: async (accountId, enabled) => {
    await prisma.dtAccount.update({ where: { id: accountId }, data: { telegramNotify: enabled } });
  },
  renderAccount: accountDetailReply
};

export async function applyTelegramAccountTargetState(
  input: { accountId: number; action: TelegramAccountTargetAction },
  deps: TelegramAccountStateDeps = telegramAccountStateDeps
) {
  const account = await deps.loadAccount(input.accountId);
  if (!account) return htmlNotice("账户不存在。");
  const enabled = input.action.endsWith("_on");
  if (input.action.startsWith("monitor_")) {
    if (account.monitorEnabled !== enabled) await deps.setMonitor(input.accountId, enabled);
  } else if (account.telegramNotify !== enabled) {
    await deps.setNotify(input.accountId, enabled);
  }
  return deps.renderAccount(input.accountId);
}

function phoneNoteCommandReply(accountId: number, phoneId: number): BotReply {
  const command = `/set_phone_note ${accountId} ${phoneId} 新备注`;
  return {
    text: `<b>修改号码备注</b>\n复制下面的命令并替换“新备注”：\n<code>${escapeTelegramHtml(command)}</code>`,
    replyMarkup: phoneDetailKeyboard(accountId, phoneId),
    parseMode: "HTML"
  };
}

async function accountMutationReply(accountId: number, operation: () => Promise<string>): Promise<BotReply> {
  const result = await operation();
  const detail = await accountDetailReply(accountId);
  return {
    text: `<b>操作结果</b>\n${escapeTelegramHtml(sanitizeTelegramError(result))}\n\n${detail.text}`,
    replyMarkup: detail.replyMarkup,
    parseMode: "HTML"
  };
}

function htmlNotice(text: string): BotReply {
  return { text: `<b>${escapeTelegramHtml(sanitizeTelegramError(text))}</b>`, replyMarkup: mainPanelKeyboard(), parseMode: "HTML" };
}

export function sanitizeTelegramError(value: unknown) {
  return String(value ?? "")
    .replace(/\bbearer\s+[^\s"',;}]+/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:authorization|(?:dt_?)?token|password|device_?id|dt_?device_?id|imei|mac|serial|dt_?track_?code|local_?ip|wifi)["']?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\{[^}\r\n]*\}|\[[^\]\r\n]*\]|[^\s,;}]+)/gi,
      "$1[redacted]"
    );
}

export function telegramSafeFailureText(_error?: unknown) {
  return "操作失败，请查看后端日志。";
}

export function telegramUserErrorText(error: unknown) {
  const raw = `${error instanceof Error ? error.name : "Error"}: ${errorMessage(error)}`;
  if (/timeout|timed out|超时|aborterror/i.test(raw)) return "操作超时，请稍后重试。";
  if (/missing confirm|confirm required|缺少.*确认|需要.*confirm/i.test(raw)) return "缺少确认参数，请按提示添加 confirm。";
  if (/unauthori[sz]ed|登录.*(?:失效|过期)|token.*(?:invalid|expired)|session.*expired/i.test(raw)) {
    return "登录已失效，请重新登录账户。";
  }
  if (/(?:direct )?会话.*(?:缺失|不完整)|缺少.*(?:direct )?会话|session.*(?:missing|incomplete)/i.test(raw)) {
    return "账户会话缺失，请重新登录后重试。";
  }
  if (/账户.*不存在|account.*not found/i.test(raw)) return "账户不存在，请刷新列表后重试。";
  if (/号码.*不存在|未找到.*号码|phone.*not found/i.test(raw)) return "号码不存在，请刷新号码列表后重试。";
  if (/参数|用法|格式错误|invalid.*(?:argument|parameter|format)|must be/i.test(raw)) return "参数错误，请检查命令格式。";
  return telegramSafeFailureText(error);
}

function isSlowTelegramCallback(callback: TelegramPanelCallback) {
  return callback.scope === "account" && (callback.action === "refresh" || callback.action === "refresh_phones");
}

function telegramPagination(total: number, requestedPage: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const normalized = Number.isSafeInteger(requestedPage) ? requestedPage : 1;
  const page = Math.min(Math.max(normalized, 1), totalPages);
  return { page, totalPages, skip: (page - 1) * pageSize };
}

async function countryListText(accountId: number) {
  return withTelegramCommandError(async () => {
    if (!Number.isInteger(accountId)) {
      return "用法：/countries <账户ID>";
    }
    const account = await requireAccount(accountId);
    const countries = await botGateway.listPhoneNumberCountries(directAccount(account));
    return countries.map((item) => `${item.countryKey} +${item.countryCode} ${item.label}`).join("\n");
  });
}

async function previewNumberText(accountId: number, isoCountryCode: string | undefined, areaCodeInput: number) {
  return withTelegramCommandError(async () => {
    if (!Number.isInteger(accountId) || !isoCountryCode) {
      return "用法：/preview_number <账户ID> <国家ISO> [区号]";
    }
    const account = await requireAccount(accountId);
    const country = await findCountry(account, isoCountryCode);
    if (!country) {
      return `未找到国家 ${isoCountryCode}。先用 /countries ${accountId} 查看。`;
    }
    const preview = await botGateway.requestPhoneNumber(directAccount(account), {
      countryCode: country.countryCode,
      isoCountryCode: country.isoCountryCode,
      countryKey: country.countryKey,
      areaCode: Number.isInteger(areaCodeInput) ? areaCodeInput : undefined
    });
    if (preview.candidates.length === 0) {
      return `${country.label} 暂无可购买号码。`;
    }
    const sample = preview.candidates.slice(0, 5).map((item, index) => `${index + 1}. ${item.phoneNumber} | ${formatCandidatePrice(item)}`);
    return [`${country.label} 可购买号码预览（不扣费）：`, ...sample].join("\n");
  });
}

async function toggleMonitorText(target: string | undefined, enabled: boolean) {
  if (!target) {
    return `用法：/${enabled ? "start_monitor" : "stop_monitor"} <账户ID|all>`;
  }
  const ids =
    target.toLowerCase() === "all"
      ? (await prisma.dtAccount.findMany({ where: { dtUserId: { not: null }, dtToken: { not: null } }, select: { id: true } })).map((item) => item.id)
      : [Number(target)];
  const results: string[] = [];
  for (const id of ids) {
    if (!Number.isInteger(id)) {
      continue;
    }
    try {
      if (enabled) {
        await accountMonitorService.start(id);
      } else {
        await accountMonitorService.stop(id);
      }
      results.push(`${id}: ${enabled ? "已启动监听" : "已停止监听"}`);
    } catch (error) {
      logger.warn("Telegram monitor command failed", { accountId: id, error: sanitizeTelegramError(errorMessage(error)) });
      results.push(`${id}: ${telegramUserErrorText(error)}`);
    }
  }
  return results.join("\n") || "没有匹配账户。";
}

async function toggleNotifyText(target: string | undefined, flag: string | undefined) {
  if (!target || !flag || !["on", "off"].includes(flag.toLowerCase())) {
    return "用法：/notify <账户ID|all> <on|off>";
  }
  const enabled = flag.toLowerCase() === "on";
  const where =
    target.toLowerCase() === "all"
      ? {}
      : Number.isInteger(Number(target))
        ? { id: Number(target) }
        : { id: -1 };
  const result = await prisma.dtAccount.updateMany({
    where,
    data: { telegramNotify: enabled }
  });
  return `已${enabled ? "开启" : "关闭"} ${result.count} 个账户的 Telegram 通知。`;
}

async function setNoteText(accountId: number, note: string) {
  if (!Number.isInteger(accountId)) {
    return "用法：/set_note <账户ID> <备注>";
  }
  const noteText = normalizeTelegramNoteText(note);
  if (noteText.empty) {
    return "备注不能为空。清空备注请使用 /clear_note <账户ID>。";
  }
  if (noteText.tooLong) {
    return `备注不能超过 ${noteText.maxLength} 个字符。`;
  }
  const account = await prisma.dtAccount.update({
    where: { id: accountId },
    data: { nickname: noteText.normalized },
    select: { id: true, nickname: true }
  });
  return `已更新账户 ${account.id} 备注：${account.nickname}`;
}

async function clearNoteText(accountId: number) {
  if (!Number.isInteger(accountId)) {
    return "用法：/clear_note <账户ID>";
  }
  const account = await prisma.dtAccount.update({
    where: { id: accountId },
    data: { nickname: null },
    select: { id: true, email: true, phone: true, dtUserId: true }
  });
  return `已清空账户 ${account.id} 备注。当前显示名：${accountName(account)}`;
}

async function setPhoneNoteText(accountId: number, phoneRef: string | undefined, note: string) {
  if (!Number.isInteger(accountId) || !phoneRef) {
    return "用法：/set_phone_note <账户ID> <号码ID|手机号> <备注>";
  }
  const noteText = normalizeTelegramNoteText(note);
  if (noteText.empty) {
    return "号码备注不能为空。清空号码备注请使用 /clear_phone_note <账户ID> <号码ID|手机号>。";
  }
  if (noteText.tooLong) {
    return `号码备注不能超过 ${noteText.maxLength} 个字符。`;
  }
  return updatePhoneNoteText(accountId, phoneRef, noteText.normalized);
}

async function clearPhoneNoteText(accountId: number, phoneRef: string | undefined) {
  if (!Number.isInteger(accountId) || !phoneRef) {
    return "用法：/clear_phone_note <账户ID> <号码ID|手机号>";
  }
  return updatePhoneNoteText(accountId, phoneRef, "");
}

async function updatePhoneNoteText(accountId: number, phoneRef: string, displayName: string) {
  return withTelegramCommandError(async () => {
    const account = await requireAccount(accountId);
    const phone = await findStoredPhone(accountId, phoneRef);
    if (!phone) {
      return "未找到该号码。";
    }
    const direct = directAccount(account);
    await botGateway.updatePhoneNumberLabel(direct, phone.phoneNumber, displayName, mapStoredPhoneContext(phone));
    const updated = await prisma.phoneNumber.update({
      where: { id: phone.id },
      data: {
        displayName
      }
    });
    return displayName
      ? `已更新号码备注：${formatPhoneLine(updated)} | 备注:${displayName}`
      : `已清空号码备注：${formatPhoneLine(updated)}`;
  });
}

async function collectCodeText(accountId: number, phoneRef?: string) {
  return withTelegramCommandError(async () => {
    if (!Number.isInteger(accountId)) {
      return "用法：/code <账户ID> [号码ID|手机号]";
    }
    const account = await requireAccount(accountId);
    const phone = phoneRef ? await findStoredPhone(accountId, phoneRef) : await findDefaultStoredPhone(accountId);
    if (!phone) {
      return phoneRef ? "没有找到这个账户下的指定已购手机号。" : "该账户暂无已购手机号，无法限定接码目标。";
    }
    const listenStartedAt = new Date();
    const pushes = await listenDirectSessionPushes({
      account: directAccount(account),
      listenSeconds: 60,
      onPush: async (push) => {
        if (push.sms) {
          await storeParsedSmsPushes(accountId, [push.sms]);
        }
      }
    });
    const latestMessages = await prisma.message.findMany({
      where: { accountId, direction: "incoming", receivedAt: { gte: listenStartedAt } },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: 50
    });
    const latest = preferConfirmedMessage(
      latestMessages.filter((message) => messageTargetsPhone(message.toNumber, phone) && extractVerificationCode(message.content)),
      phone
    );
    const matchedPushes = pushes.pushes
      .map((item) => item.sms)
      .filter((sms): sms is NonNullable<typeof sms> => Boolean(sms))
      .filter((sms) => smsTargetsPhone(sms.toNumber, phone) && Boolean(extractVerificationCode(sms.content)));
    const note = [
      `host=${pushes.host}`,
      `phone=${phone.phoneNumber}`,
      formatOfflineTemplateNote(pushes)
    ].filter(Boolean).join("；");
    if (latest) {
      return `已收到指定号码验证码：${extractVerificationCode(latest.content) ?? "-"}\n${latest.fromNumber ?? "-"}: ${latest.content}\n${note}`;
    }
    const matchedPush = preferConfirmedSms(matchedPushes, phone);
    if (matchedPush) {
      return `已收到指定号码验证码：${extractVerificationCode(matchedPush.content) ?? "-"}\n${matchedPush.fromNumber ?? "-"}: ${matchedPush.content}\n${note}`;
    }
    const lastStoredForPhone = await prisma.message.findMany({
      where: { accountId, direction: "incoming" },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: 100
    });
    const fallback = preferConfirmedMessage(
      lastStoredForPhone.filter((message) => messageTargetsPhone(message.toNumber, phone) && extractVerificationCode(message.content)),
      phone
    );
    return fallback
      ? `本次未收到指定号码的新验证码。最近一条：\n${fallback.fromNumber ?? "-"}: ${fallback.content}\n${note}`
      : `60 秒内未收到指定号码验证码。\n${note}`;
  });
}

function formatOfflineTemplateNote(pushes: Awaited<ReturnType<typeof listenDirectSessionPushes>>) {
  if (pushes.offlineTemplateSent) {
    return "离线补拉模板已发送";
  }
  if (pushes.offlineTemplateAttempted) {
    return pushes.offlineTemplateError
      ? `离线补拉模板已尝试但未发送：${pushes.offlineTemplateError}`
      : "离线补拉模板已尝试但未发送";
  }
  return "离线补拉模板未尝试，仅能接收在线实时 push";
}

async function traceAccessCodeText(args: string[]) {
  return withTelegramCommandError(async () => {
    const parsed = parseTraceAccessCodeArgs(args);
    if (!parsed) {
      return "用法：/trace_access_code <账户ID> <phone|email> <目标> [验证码] [cc=国家码] [confirm]\n默认 dry-run，不会联网；最后加 confirm 才会发真实请求。";
    }
    const account = await requireAccount(parsed.accountId);
    const targetError = validateTraceAccessCodeTarget(parsed.kind, parsed.target);
    if (targetError) {
      return targetError;
    }
    if (parsed.dryRun) {
      return buildTraceAccessCodeDryRunText(parsed.kind, parsed.target, parsed.countryCode, parsed.accessCode);
    }
    const result = await runDirectAccessCodeProbe({
      account: directAccount(account),
      kind: parsed.kind,
      target: parsed.target,
      countryCode: parsed.countryCode,
      accessCode: parsed.accessCode
    });
    return formatTraceAccessCodeProbe(result, parsed.kind, parsed.target);
  });
}

export function parseTraceAccessCodeArgs(args: string[]) {
  const accountId = Number(args[0]);
  const kind = parseAccessCodeKind(args[1]);
  const target = args[2]?.trim();
  if (!Number.isInteger(accountId) || !kind || !target) {
    return null;
  }
  const rest = args.slice(3);
  const confirmIndex = rest.findIndex((item) => isConfirmToken(item));
  const dryRun = confirmIndex < 0;
  let countryCode: number | undefined;
  let accessCode: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]?.trim();
    if (!item || index === confirmIndex) {
      continue;
    }
    const parsedCountryCode = parseTraceCountryCodeToken(item);
    if (parsedCountryCode !== undefined) {
      if (kind === "phone") {
        countryCode = parsedCountryCode;
      }
      continue;
    }
    if (accessCode === undefined) {
      accessCode = item;
    }
  }
  return {
    accountId,
    kind,
    target,
    countryCode: kind === "phone" ? countryCode ?? inferCountryCode(target) : undefined,
    accessCode,
    dryRun
  };
}

function parseTraceCountryCodeToken(value: string) {
  const match = value.match(/^(?:cc|country|country_code|countryCode)=\+?(\d{1,4})$/i);
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseAccessCodeKind(value: string | undefined): "email" | "phone" | null {
  const normalized = value?.toLowerCase();
  return normalized === "email" || normalized === "phone" ? normalized : null;
}

function inferCountryCode(target: string) {
  return inferAccessCodeCountryCode(target) ?? 1;
}

export function validateTraceAccessCodeTarget(kind: "email" | "phone", target: string) {
  const trimmed = target.trim();
  if (kind === "email") {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) ? null : "目标格式错误：请输入有效邮箱。";
  }
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? null : "目标格式错误：请输入 7-15 位手机号数字。";
}

function redactAccessCodeTarget(kind: "email" | "phone", target: string) {
  if (kind === "email") {
    const [name = "", domain = ""] = target.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return target.replace(/(\d{2})\d+(\d{2})$/, "$1***$2");
}

export function buildTraceAccessCodeDryRunText(
  kind: "email" | "phone",
  target: string,
  countryCode?: number,
  accessCode?: string
) {
  return formatTraceAccessCodeDryRun(
    buildDirectAccessCodeDryRun({
      kind,
      target,
      countryCode,
      accessCode
    })
  );
}

function formatTraceAccessCodeDryRun(output: ReturnType<typeof buildDirectAccessCodeDryRun>) {
  return [
    `Capability: ${output.capability.mode}; loginTokenCompleted=${output.capability.loginTokenCompleted}`,
    "验证码登录追踪 dry-run（未联网）",
    `类型: ${output.kind}`,
    `目标: ${output.target}`,
    `国家码: +${output.countryCode}`,
    `recoverPassword: ${output.recoverPassword.params.type === "2" ? "phone" : "email"} type=${output.recoverPassword.params.type} noCode=${output.recoverPassword.params.noCode}`,
    `recoverPassword json: ${output.recoverPassword.params.json}`,
    output.verifyAccessCode
      ? `verifyAccessCode: type=${output.verifyAccessCode.params.type} accessCode=${output.verifyAccessCode.params.accessCode}`
      : "verifyAccessCode: 未提供验证码，跳过",
    "真实请求可能触发短信；确认要发真实请求时，在命令最后加 confirm。"
  ].join("\n");
}

function formatTraceAccessCodeProbe(
  output: Awaited<ReturnType<typeof runDirectAccessCodeProbe>>,
  kind: "email" | "phone",
  target: string
) {
  return [
    `Capability: ${output.capability.mode}; loginTokenCompleted=${output.capability.loginTokenCompleted}`,
    "验证码登录追踪真实请求已完成",
    `结果: ${output.ok ? "ok" : "failed"}`,
    `Host: ${output.host}`,
    `类型: ${kind}`,
    `目标: ${redactAccessCodeTarget(kind, target)}`,
    `recoverPassword: ${formatTraceProbeCall(output.recoverPassword)}`,
    `verifyAccessCode: ${formatTraceProbeCall(output.verifyAccessCode)}`,
    `trace frames: ${output.trace?.length ?? 0}`,
    "注意：此追踪只验证 recoverPassword / verifyAccessCode 链路，不代表首次登录 token 已完成。"
  ].join("\n");
}

function formatTraceProbeCall(call: Awaited<ReturnType<typeof runDirectAccessCodeProbe>>["recoverPassword"]) {
  if (!call) {
    return "skipped";
  }
  if (!call.ok) {
    return `failed ${call.durationMs}ms ${call.error ?? ""}`.trim();
  }
  return `ok ${call.durationMs}ms`;
}

async function refreshAccountText(accountId: number) {
  return withTelegramCommandError(async () => {
    if (!Number.isInteger(accountId)) {
      return "用法：/refresh_account <账户ID>";
    }
    const result = await refreshAccountRuntimeData(accountId, botGateway);
    return `刷新完成。已购号码 ${result.phoneCount} 个，余额/积分请在面板查看最新资料。`;
  });
}

async function refreshPhonesText(accountId: number) {
  return withTelegramCommandError(async () => {
    if (!Number.isInteger(accountId)) {
      return "用法：/refresh_phones <账户ID>";
    }
    const account = await requireAccount(accountId);
    const phones = await botGateway.listPhoneNumbers(directAccount(account));
    for (const phone of phones) {
      await savePurchasedPhone(accountId, phone);
    }
    return `刷新完成，远端返回 ${phones.length} 个号码。本地不会删除远端本次未返回的旧号码。`;
  });
}

async function buyNumberText(accountId: number, isoCountryCode: string | undefined, args: string[] = []) {
  return withTelegramCommandError(async () => {
    if (!Number.isInteger(accountId) || !isoCountryCode) {
      return "用法：/buy_number <账户ID> <国家ISO> [confirm] [区号] [phone=号码]";
    }
    const parsedArgs = parseBuyNumberArgs(args);
    const account = await requireAccount(accountId);
    const country = await findCountry(account, isoCountryCode);
    if (!country) {
      return `未找到国家 ${isoCountryCode}。先用 /countries ${accountId} 查看。`;
    }
    const direct = directAccount(account);
    const preview = await botGateway.requestPhoneNumber(direct, {
      countryCode: country.countryCode,
      isoCountryCode: country.isoCountryCode,
      countryKey: country.countryKey,
      areaCode: parsedArgs.areaCode
    });
    const candidate = selectPreviewCandidate(preview.candidates, parsedArgs.phoneNumber);
    if (!candidate) {
      return parsedArgs.phoneNumber
        ? `${country.label} 本次预览未找到指定号码 ${parsedArgs.phoneNumber}。请先用 /preview_number ${accountId} ${country.countryKey}${parsedArgs.areaCode ? ` ${parsedArgs.areaCode}` : ""} 查看。`
        : `${country.label} 暂无可购买号码。`;
    }
    const candidateForPurchase = {
      ...candidate,
      areaCode: candidate.areaCode ?? parsedArgs.areaCode
    };
    if (!parsedArgs.confirm) {
      const confirmCommand = [
        `/buy_number ${accountId} ${country.countryKey} confirm`,
        parsedArgs.areaCode ? String(parsedArgs.areaCode) : null,
        `phone=${candidateForPurchase.phoneNumber}`
      ]
        .filter(Boolean)
        .join(" ");
      return [
        `${country.label} 候选号预览（未扣费）：`,
        formatPreviewCandidateLine(candidateForPurchase),
        `确认购买请发送：${confirmCommand}`
      ].join("\n");
    }
    const ordered = await botGateway.purchasePhoneNumber(direct, {
      countryCode: country.countryCode,
      isoCountryCode: country.isoCountryCode,
      countryKey: country.countryKey,
      candidate: candidateForPurchase
    });
    const confirmed = await confirmPurchasedPhone(direct, ordered);
    const saved = await savePurchasedPhone(accountId, confirmed);
    await sendPhoneTelegramNotification({
      account,
      phone: confirmed,
      verificationSource: "remote_phone_list",
      verificationNote: "Purchase was confirmed by polling the remote purchased phone list before writing local data."
    }).catch((error) => {
      logger.warn("Failed to send Telegram notification for purchased phone from bot", {
        accountId,
        phoneNumber: confirmed.phoneNumber,
        error: sanitizeTelegramError(errorMessage(error))
      });
    });
    return [
      `已获取新号码: ${saved.phoneNumber}`,
      `国家: ${country.label}`,
      `状态: ${saved.status}`,
      `远端确认: 已在已购号码列表中确认`,
      `收费: ${formatPhoneCost(confirmed)}`
    ].join("\n");
  });
}

export function parseBuyNumberArgs(args: string[]) {
  let areaCode: number | undefined;
  let phoneNumber: string | undefined;
  let confirm = false;
  for (const item of args) {
    const normalized = item.trim();
    if (isConfirmToken(normalized)) {
      confirm = true;
      continue;
    }
    const explicitPhone = normalized.match(/^(?:phone|number|num)=(\+?\d+)$/i)?.[1];
    if (explicitPhone) {
      phoneNumber = normalizePhoneDigits(explicitPhone);
      continue;
    }
    const parsed = Number(normalized);
    if (Number.isInteger(parsed) && parsed > 9999) {
      phoneNumber = normalizePhoneDigits(normalized);
    } else if (Number.isInteger(parsed) && parsed > 0) {
      areaCode = parsed;
    }
  }
  return { confirm, areaCode, phoneNumber };
}

function selectPreviewCandidate(candidates: DingtonePhonePurchaseCandidate[], phoneNumber?: string) {
  if (!phoneNumber) {
    return candidates[0];
  }
  const target = normalizePhoneDigits(phoneNumber);
  return candidates.find((item) => normalizePhoneDigits(item.phoneNumber) === target) ?? null;
}

function formatPreviewCandidateLine(candidate: DingtonePhonePurchaseCandidate) {
  const parts = [
    candidate.phoneNumber,
    candidate.areaCode ? `区号:${candidate.areaCode}` : null,
    candidate.providerId ? `provider:${candidate.providerId}` : null,
    candidate.packageServiceId ? `package:${candidate.packageServiceId}` : null,
    candidate.productId ? `product:${candidate.productId}` : null,
    formatCandidatePrice(candidate)
  ].filter(Boolean);
  return parts.join(" | ");
}

export function parsePhoneActionArgs(args: string[]) {
  let phoneRef: string | undefined;
  let confirm = false;
  for (const item of args.slice(1)) {
    if (isConfirmToken(item)) {
      confirm = true;
      continue;
    }
    const normalized = item.trim();
    if (normalized && !phoneRef) {
      phoneRef = normalized;
    }
  }
  return { phoneRef, confirm };
}

async function phoneActionText(
  accountId: number,
  parsedArgs: ReturnType<typeof parsePhoneActionArgs>,
  action: "renew" | "pause" | "resume" | "cancel"
) {
  return withTelegramCommandError(async () => {
    const { phoneRef, confirm } = parsedArgs;
    if (!Number.isInteger(accountId) || !phoneRef) {
      return `用法：/${action}_phone <账户ID> <号码ID|手机号> confirm`;
    }
    if (action === "renew" && !confirm) {
      return "续费会扣费。确认续费请发送：/renew_phone <账户ID> <号码ID|手机号> confirm";
    }
    if (action === "pause" && !confirm) {
      return "暂停会修改真实号码状态。确认暂停请发送：/pause_phone <账户ID> <号码ID|手机号> confirm";
    }
    if (action === "resume" && !confirm) {
      return "恢复会修改真实号码状态。确认恢复请发送：/resume_phone <账户ID> <号码ID|手机号> confirm";
    }
    if (action === "cancel" && !confirm) {
      return "取消号码不可逆。确认取消请发送：/cancel_phone <账户ID> <号码ID|手机号> confirm";
    }
    const account = await requireAccount(accountId);
    const phone = await findStoredPhone(accountId, phoneRef);
    if (!phone) {
      return "未找到该号码。";
    }
    const direct = directAccount(account);
    const renewalBaseline = action === "renew" ? await getBotPhoneBaseline(direct, phone.phoneNumber) : null;
    if (action === "renew") {
      await botGateway.renewPhoneNumber(direct, phone.phoneNumber, mapStoredPhoneContext(phone));
    } else if (action === "pause") {
      await botGateway.pausePhoneNumber(direct, phone.phoneNumber, mapStoredPhoneContext(phone));
    } else if (action === "resume") {
      await botGateway.resumePhoneNumber(direct, phone.phoneNumber, mapStoredPhoneContext(phone));
    } else {
      await botGateway.cancelPhoneNumber(direct, phone.phoneNumber, mapStoredPhoneContext(phone));
    }
    const expectedStatus =
      action === "renew" ? null : action === "resume" ? PhoneStatus.active : action === "pause" ? PhoneStatus.paused : PhoneStatus.cancelled;
    const verified = await verifyPhoneStatus(direct, phone.phoneNumber, expectedStatus, renewalBaseline?.expiredTime);
    const updated = await prisma.phoneNumber.update({
      where: { id: phone.id },
      data: mapPhoneNumber({ ...verified, phoneNumber: phone.phoneNumber })
    });
    const verificationNote = buildBotPhoneActionVerificationNote(action, updated.status);
    await sendPhoneTelegramNotification({
      account,
      phone: mapStoredPhoneContext(updated),
      action,
      verificationSource: "remote_phone_list",
      verificationNote
    }).catch((error) => {
      logger.warn("Failed to send Telegram notification for phone action from bot", {
        accountId,
        phoneNumber: updated.phoneNumber,
        action,
        error: sanitizeTelegramError(errorMessage(error))
      });
    });
    return [
      `操作完成：${formatPhoneLine(updated)}`,
      `远端确认：${phoneActionVerificationText(action, updated.status)}`
    ].join("\n");
  });
}

async function requireAccount(accountId: number) {
  const account = await prisma.dtAccount.findUnique({ where: { id: accountId } });
  if (!account || !account.dtUserId || !account.dtToken) {
    throw new Error("账户不存在或缺少 direct 会话。");
  }
  return account;
}

function directAccount(account: { dtUserId: string | null; dtToken: string | null; dtDeviceId?: string | null; email?: string | null; phone?: string | null }) {
  const token = decryptText(account.dtToken);
  if (!account.dtUserId || !token) {
    throw new Error("账户 direct 会话不完整。");
  }
  return {
    dtUserId: account.dtUserId,
    token,
    deviceId: account.dtDeviceId,
    email: account.email,
    phone: account.phone
  };
}

async function withTelegramCommandError(operation: () => Promise<string>) {
  try {
    return await operation();
  } catch (error) {
    logger.warn("Telegram bot command failed", {
      error: sanitizeTelegramError(errorMessage(error))
    });
    return telegramUserErrorText(error);
  }
}

async function findCountry(account: DtAccount, isoCountryCode: string) {
  const countries = await botGateway.listPhoneNumberCountries(directAccount(account));
  const normalized = isoCountryCode.toLowerCase();
  return countries.find((item) => item.countryKey.toLowerCase() === normalized || item.isoCountryCode.toLowerCase() === normalized);
}

async function findStoredPhone(accountId: number, phoneRef: string) {
  const id = Number(phoneRef);
  if (Number.isInteger(id)) {
    const byId = await prisma.phoneNumber.findFirst({ where: { id, accountId } });
    if (byId) {
      return byId;
    }
  }
  const digits = normalizePhoneDigits(phoneRef);
  if (!digits) {
    return null;
  }
  const phones = await prisma.phoneNumber.findMany({ where: { accountId } });
  return phones.find((item) => normalizePhoneDigits(item.phoneNumber) === digits) ?? null;
}

async function findDefaultStoredPhone(accountId: number) {
  return prisma.phoneNumber.findFirst({
    where: { accountId, status: { in: [PhoneStatus.active, PhoneStatus.paused, PhoneStatus.pending] } },
    orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }]
  });
}

function messageTargetsPhone(toNumber: string | null, phone: PhoneNumber) {
  return messagePhoneMatch(toNumber, phone) !== "mismatch";
}

function messagePhoneMatch(toNumber: string | null, phone: PhoneNumber): PhoneMatch {
  const target = normalizePhoneDigits(toNumber ?? "");
  if (!target) {
    return "unverified";
  }
  return phoneDigitsMatch(phone.phoneNumber, target) ? "confirmed" : "mismatch";
}

function smsTargetsPhone(toNumber: string | null | undefined, phone: PhoneNumber) {
  return smsPhoneMatch(toNumber, phone) !== "mismatch";
}

function smsPhoneMatch(toNumber: string | null | undefined, phone: PhoneNumber): PhoneMatch {
  const target = normalizePhoneDigits(toNumber ?? "");
  if (!target) {
    return "unverified";
  }
  return phoneDigitsMatch(phone.phoneNumber, target) ? "confirmed" : "mismatch";
}

function preferConfirmedMessage<T extends { toNumber: string | null }>(messages: T[], phone: PhoneNumber) {
  return messages.find((message) => messagePhoneMatch(message.toNumber, phone) === "confirmed") ?? messages[0] ?? null;
}

function preferConfirmedSms<T extends { toNumber?: string | null }>(messages: T[], phone: PhoneNumber) {
  return messages.find((message) => smsPhoneMatch(message.toNumber, phone) === "confirmed") ?? messages[0] ?? null;
}

function phoneDigitsMatch(phoneNumber: string, targetDigits: string) {
  const phoneDigits = normalizePhoneDigits(phoneNumber);
  return Boolean(phoneDigits && targetDigits && (phoneDigits === targetDigits || phoneDigits.endsWith(targetDigits) || targetDigits.endsWith(phoneDigits)));
}

function extractVerificationCode(content: string) {
  return content.match(/\b\d{4,8}\b/)?.[0] ?? null;
}

async function confirmPurchasedPhone(account: { dtUserId: string; token: string; deviceId?: string | null }, phone: DingtonePhoneNumber) {
  const target = normalizePhoneDigits(phone.phoneNumber);
  if (!target) {
    throw new Error("购买接口没有返回可确认的手机号，本地未写入。");
  }
  let lastError: unknown;
  for (const waitMs of [0, 1_500, 3_000, 5_000]) {
    if (waitMs > 0) {
      await delay(waitMs);
    }
    try {
      const remotePhones = await botGateway.listPhoneNumbers(account);
      const matched = remotePhones.find((item) => normalizePhoneDigits(item.phoneNumber) === target);
      if (matched) {
        return {
          ...phone,
          ...matched,
          rawJson: matched.rawJson ?? phone.rawJson
        };
      }
      lastError = new Error("远端已购号码列表中暂未出现该号码。");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`购买未能被远端已购列表确认，本地未写入。${errorMessage(lastError)}`);
}

async function verifyPhoneStatus(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  phoneNumber: string,
  expectedStatus: PhoneStatus | null,
  previousExpiry?: string | null
) {
  let lastError: unknown;
  for (const waitMs of [1_500, 3_000, 5_000]) {
    await delay(waitMs);
    try {
      const remotePhones = await botGateway.listPhoneNumbers(account);
      const matched = remotePhones.find((item) => normalizePhoneDigits(item.phoneNumber) === normalizePhoneDigits(phoneNumber));
      if (expectedStatus === PhoneStatus.cancelled) {
        if (!matched || matched.status === PhoneStatus.cancelled) {
          return { phoneNumber, status: PhoneStatus.cancelled };
        }
        lastError = new Error(`远端仍返回该号码，状态为 ${matched.status ?? "未知"}`);
        continue;
      }
      if (!matched) {
        lastError = new Error("远端号码列表未找到该号码");
        continue;
      }
      if (!expectedStatus) {
        const baseline = parseBotPhoneExpiry(previousExpiry);
        const current = parseBotPhoneExpiry(matched.expiredTime);
        if (baseline === null || current === null || current <= baseline) {
          lastError = new Error("远端号码到期时间尚未延长");
          continue;
        }
        return matched;
      }
      if (matched.status !== expectedStatus) {
        lastError = new Error(`远端状态未生效，期望 ${expectedStatus}，实际 ${matched.status ?? "未知"}`);
        continue;
      }
      return matched;
    } catch (error) {
      lastError = error;
      logger.warn("Phone action verification failed in Telegram bot", {
        phoneNumber,
        error: sanitizeTelegramError(errorMessage(error))
      });
    }
  }
  throw new Error(`操作已发送但远端校验失败：${errorMessage(lastError)}`);
}

async function getBotPhoneBaseline(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  phoneNumber: string
) {
  const matched = (await botGateway.listPhoneNumbers(account)).find(
    (item) => normalizePhoneDigits(item.phoneNumber) === normalizePhoneDigits(phoneNumber)
  );
  if (!matched || parseBotPhoneExpiry(matched.expiredTime) === null) {
    throw new Error("续期前无法从远端读取号码到期时间");
  }
  return matched;
}

function parseBotPhoneExpiry(value: string | null | undefined) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function savePurchasedPhone(accountId: number, phone: DingtonePhoneNumber) {
  return prisma.phoneNumber.upsert({
    where: {
      accountId_phoneNumber: {
        accountId,
        phoneNumber: phone.phoneNumber
      }
    },
    update: mapPhoneNumber(phone),
    create: {
      accountId,
      phoneNumber: phone.phoneNumber,
      ...mapPhoneNumber(phone)
    }
  });
}

function mapPhoneNumber(phone: Partial<DingtonePhoneNumber>) {
  return {
    countryCode: phone.countryCode,
    providerId: phone.providerId,
    displayName: phone.displayName,
    status: (phone.status as PhoneStatus | undefined) ?? PhoneStatus.active,
    purchaseType: phone.purchaseType,
    payType: phone.payType,
    validPeriodDays: phone.validPeriodDays,
    gainTime: phone.gainTime,
    expiredTime: phone.expiredTime,
    autoRenew: phone.autoRenew ?? false,
    isPrimary: phone.isPrimary ?? false,
    isGoodNumber: phone.isGoodNumber ?? false,
    portoutInfo: phone.portoutInfo,
    rawJson: phone.rawJson
  };
}

function mapStoredPhoneContext(phone: PhoneNumber): Partial<DingtonePhoneNumber> {
  return {
    phoneNumber: phone.phoneNumber,
    countryCode: phone.countryCode ?? undefined,
    providerId: phone.providerId ?? undefined,
    displayName: phone.displayName ?? undefined,
    status: phone.status,
    purchaseType: phone.purchaseType ?? undefined,
    payType: phone.payType ?? undefined,
    validPeriodDays: phone.validPeriodDays ?? undefined,
    gainTime: phone.gainTime ?? undefined,
    expiredTime: phone.expiredTime ?? undefined,
    autoRenew: phone.autoRenew,
    isPrimary: phone.isPrimary,
    isGoodNumber: phone.isGoodNumber,
    portoutInfo: phone.portoutInfo ?? undefined,
    rawJson: phone.rawJson ?? undefined
  };
}

function formatPhoneLine(item: PhoneNumber) {
  return `${item.id}. ${item.phoneNumber} | ${item.status} | +${item.countryCode ?? "-"} | 到期:${item.expiredTime ?? "-"}`;
}

function phoneActionVerificationText(action: "renew" | "pause" | "resume" | "cancel", status: PhoneStatus) {
  if (action === "cancel") {
    return "已通过已购号码列表确认号码取消或不再返回";
  }
  if (action === "renew") {
    return "已通过已购号码列表确认到期时间已延长";
  }
  return `已通过已购号码列表确认状态为 ${status}`;
}

export function buildBotPhoneActionVerificationNote(action: "renew" | "pause" | "resume" | "cancel", status?: PhoneStatus | string | null) {
  if (action === "cancel") {
    return "Action was confirmed by polling the remote purchased phone list until the number disappeared or returned cancelled.";
  }
  if (action === "renew") {
    return "Action was confirmed by polling the remote purchased phone list until the expiry time advanced.";
  }
  return `Action was confirmed by polling the remote purchased phone list until status became ${status ?? "expected"}.`;
}

function formatCandidatePrice(candidate: DingtonePhonePurchaseCandidate) {
  return formatPhoneCost(candidate);
}

function formatPhoneCost(phone: Partial<DingtonePhoneNumber & DingtonePhonePurchaseCandidate>) {
  const raw = phone.rawJson ? safeParseJson(phone.rawJson) : null;
  const price = phone.price ?? pickNumber(raw, ["reserved5", "price", "orderPrice", "payAmount", "amount", "coinCost", "needBalance"]);
  const packageServiceId = phone.packageServiceId ?? pickString(raw, ["packageServiceId", "package_service_id"]);
  const period = pickNumber(raw, ["usePeriod", "validPeriodDays", "valid_period_days"]);
  const parts = [
    price === undefined ? "价格待解析" : `${price} 说道币`,
    period === undefined ? null : `${period <= 12 ? `${period} 个月` : `${period} 天`}`,
    packageServiceId
  ].filter(Boolean);
  return parts.join(" / ");
}

function isWhitelisted(settingValue: string | undefined, chatId: string, userId: string) {
  const allowed = new Set(
    (settingValue ?? "")
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  );
  return allowed.has(chatId) || (userId ? allowed.has(userId) : false);
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function accountName(input: { nickname?: string | null; email?: string | null; phone?: string | null; dtUserId?: string | null }) {
  return input.nickname?.trim() || input.email?.trim() || input.phone?.trim() || input.dtUserId?.trim() || "未命名账户";
}

function normalizePhoneDigits(value: string) {
  return value.replace(/[^\d]/g, "");
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function trimTelegramText(text: string) {
  return text.length <= 3900 ? text : `${text.slice(0, 3900)}\n...`;
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

export const telegramBotService = new TelegramBotService();
