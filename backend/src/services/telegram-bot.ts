import { PhoneStatus } from "@prisma/client";
import type { DtAccount, PhoneNumber } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { decryptText } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
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

const botGateway = new DirectDingtoneGateway();
let botCommandsCacheKey = "";
const TELEGRAM_NOTE_MAX_LENGTH = 100;
type PhoneMatch = "confirmed" | "unverified" | "mismatch";

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
            error: error instanceof Error ? error.message : String(error)
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
        error: error instanceof Error ? error.message : String(error)
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
      if (!isWhitelisted(settings.telegram_allowed_chat_ids, chatId, userId)) {
        await telegramService.answerCallbackQuery({
          botToken,
          callbackQueryId: callback.id,
          text: "未授权",
          apiBaseUrl: settings.telegram_api_base_url
        });
        return;
      }
      await telegramService.answerCallbackQuery({
        botToken,
        callbackQueryId: callback.id,
        apiBaseUrl: settings.telegram_api_base_url
      });
      const reply = await handlePanelCallbackSafe(callback.data);
      await this.reply(settings, chatId, reply.text, reply.replyMarkup);
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
        await this.reply(settings, chatId, helpText());
        return;
      case "/panel":
        await this.reply(settings, chatId, await panelText(), panelMarkup());
        return;
      case "/accounts":
        await this.reply(settings, chatId, await listAccountsText());
        return;
      case "/account":
        await this.reply(settings, chatId, await accountDetailText(Number(args[0])));
        return;
      case "/phones":
        await this.reply(settings, chatId, await phoneListText(Number(args[0])));
        return;
      case "/messages":
        await this.reply(settings, chatId, await messageListText(Number(args[0]), Number(args[1])));
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
        await this.reply(settings, chatId, await panelStatusText());
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

  private async reply(settings: Record<string, string>, chatId: string, text: string, replyMarkup?: unknown) {
    const botToken = settings.telegram_bot_token;
    if (!botToken) {
      return;
    }
    await telegramService.sendMessage({
      botToken,
      chatId,
      text: trimTelegramText(text),
      replyMarkup,
      apiBaseUrl: settings.telegram_api_base_url
    });
  }
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
        error: error instanceof Error ? error.message : String(error)
      });
    });
}

function helpText() {
  return [
    "dt-manager 机器人命令：",
    "/panel - 打开控制面板按钮菜单",
    "/accounts - 查看账户列表",
    "/account <账户ID> - 查看账户详情",
    "/phones <账户ID> - 查看已购手机号",
    "/messages <账户ID> [数量] - 查看最近消息",
    "/countries <账户ID> - 查看可选号国家",
    "/preview_number <账户ID> <国家ISO> [区号] - 预览号码和价格，不扣费",
    "/buy_number <账户ID> <国家ISO> [confirm] [区号] [phone=号码] - 先预览，带 confirm 才购买",
    "/code <账户ID> [号码ID|手机号] - 直连等待指定已购手机号的新短信/验证码 60 秒",
    "/trace_access_code <账户ID> <phone|email> <目标> [验证码] [cc=国家码] [confirm] - 追踪验证码登录参数；默认 dry-run，confirm 才会发真实请求",
    "/start_monitor <账户ID|all> - 启动监听",
    "/stop_monitor <账户ID|all> - 停止监听",
    "/notify <账户ID|all> <on|off> - 开关 Telegram 通知",
    "/set_note <账户ID> <备注> - 修改账户备注，支持中英文",
    "/clear_note <账户ID> - 清空账户备注",
    "/set_phone_note <账户ID> <号码ID|手机号> <备注> - 修改号码备注并同步到 app",
    "/clear_phone_note <账户ID> <号码ID|手机号> - 清空号码备注并同步到 app",
    "/status - 查看面板运行概览",
    "/refresh_account <账户ID> - 刷新账户资料和积分",
    "/refresh_phones <账户ID> - 刷新已购号码",
    "/renew_phone <账户ID> <号码ID|手机号> confirm - 续费号码，会扣费",
    "/pause_phone <账户ID> <号码ID|手机号> confirm - 暂停号码",
    "/resume_phone <账户ID> <号码ID|手机号> confirm - 恢复号码",
    "/cancel_phone <账户ID> <号码ID|手机号> confirm - 取消号码，谨慎使用"
  ].join("\n");
}

async function panelText() {
  return [
    await panelStatusText(),
    "",
    "常用操作可以点下面按钮；指定账户、指定号码的操作仍用命令，避免误购号或误取消。"
  ].join("\n");
}

function panelMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "账户列表", callback_data: "panel:accounts" },
        { text: "运行状态", callback_data: "panel:status" }
      ],
      [
        { text: "开启全部监听", callback_data: "panel:start_all" },
        { text: "停止全部监听", callback_data: "panel:stop_all" }
      ],
      [
        { text: "开启全部通知", callback_data: "panel:notify_on_all" },
        { text: "关闭全部通知", callback_data: "panel:notify_off_all" }
      ],
      [
        { text: "命令帮助", callback_data: "panel:help" }
      ]
    ]
  };
}

async function handlePanelCallback(data: string | undefined): Promise<BotReply> {
  const parsed = parsePanelCallback(data);
  if (parsed) {
    const account = await prisma.dtAccount.findUnique({ where: { id: parsed.accountId } });
    if (!account) {
      return { text: "账户不存在。", replyMarkup: await accountsMarkup() };
    }
    switch (parsed.action) {
      case "detail":
        return { text: await accountDetailText(parsed.accountId), replyMarkup: accountActionMarkup(account) };
      case "messages":
        return { text: await messageListText(parsed.accountId, 5), replyMarkup: accountActionMarkup(account) };
      case "code":
        return { text: await collectCodeText(parsed.accountId), replyMarkup: accountActionMarkup(await reloadAccount(parsed.accountId, account)) };
      case "phones":
        return { text: await refreshPhonesText(parsed.accountId), replyMarkup: accountActionMarkup(await reloadAccount(parsed.accountId, account)) };
      case "monitor":
        return {
          text: await toggleMonitorText(String(parsed.accountId), !account.monitorEnabled),
          replyMarkup: accountActionMarkup(await reloadAccount(parsed.accountId, account))
        };
      case "notify":
        return {
          text: await toggleNotifyText(String(parsed.accountId), account.telegramNotify ? "off" : "on"),
          replyMarkup: accountActionMarkup(await reloadAccount(parsed.accountId, account))
        };
      case "clear_note":
        return {
          text: await clearNoteText(parsed.accountId),
          replyMarkup: accountActionMarkup(await reloadAccount(parsed.accountId, account))
        };
      default:
        return { text: "未知账户操作。", replyMarkup: accountActionMarkup(account) };
    }
  }

  switch (data) {
    case "panel:accounts":
      return { text: await listAccountsText(), replyMarkup: await accountsMarkup() };
    case "panel:status":
      return { text: await panelStatusText(), replyMarkup: panelMarkup() };
    case "panel:start_all":
      return { text: await toggleMonitorText("all", true), replyMarkup: panelMarkup() };
    case "panel:stop_all":
      return { text: await toggleMonitorText("all", false), replyMarkup: panelMarkup() };
    case "panel:notify_on_all":
      return { text: await toggleNotifyText("all", "on"), replyMarkup: panelMarkup() };
    case "panel:notify_off_all":
      return { text: await toggleNotifyText("all", "off"), replyMarkup: panelMarkup() };
    case "panel:help":
      return { text: helpText(), replyMarkup: panelMarkup() };
    default:
      return { text: "未知面板操作。发送 /panel 重新打开控制面板。", replyMarkup: panelMarkup() };
  }
}

async function handlePanelCallbackSafe(data: string | undefined): Promise<BotReply> {
  try {
    return await handlePanelCallback(data);
  } catch (error) {
    logger.warn("Telegram bot callback failed", {
      data,
      error: errorMessage(error)
    });
    return {
      text: `操作失败：${errorMessage(error)}`,
      replyMarkup: panelMarkup()
    };
  }
}

async function listAccountsText() {
  const accounts = await prisma.dtAccount.findMany({
    orderBy: { id: "asc" },
    take: 30,
    select: {
      id: true,
      nickname: true,
      email: true,
      phone: true,
      dtUserId: true,
      status: true,
      monitorEnabled: true,
      telegramNotify: true
    }
  });
  if (accounts.length === 0) {
    return "暂无账户。";
  }
  return accounts
    .map((item) => `${item.id}. ${accountName(item)} | ${item.status} | 监听:${item.monitorEnabled ? "开" : "关"} | TG:${item.telegramNotify ? "开" : "关"}`)
    .join("\n");
}

async function accountsMarkup() {
  const accounts = await prisma.dtAccount.findMany({
    orderBy: { id: "asc" },
    take: 12,
    select: {
      id: true,
      nickname: true,
      email: true,
      phone: true,
      dtUserId: true
    }
  });
  const rows = accounts.map((item) => [
    {
      text: `${item.id}. ${truncateButtonText(accountName(item), 24)}`,
      callback_data: `acct:${item.id}:detail`
    }
  ]);
  rows.push([{ text: "返回面板", callback_data: "panel:status" }]);
  return { inline_keyboard: rows };
}

function accountActionMarkup(account: { id: number; monitorEnabled: boolean; telegramNotify: boolean }) {
  return {
    inline_keyboard: [
      [
        { text: "详情", callback_data: `acct:${account.id}:detail` },
        { text: "最近消息", callback_data: `acct:${account.id}:messages` }
      ],
      [
        { text: "收验证码", callback_data: `acct:${account.id}:code` },
        { text: "刷新号码", callback_data: `acct:${account.id}:phones` }
      ],
      [
        { text: account.monitorEnabled ? "停止监听" : "启动监听", callback_data: `acct:${account.id}:monitor` },
        { text: account.telegramNotify ? "关闭通知" : "开启通知", callback_data: `acct:${account.id}:notify` }
      ],
      [
        { text: "清空备注", callback_data: `acct:${account.id}:clear_note` }
      ],
      [
        { text: "账户列表", callback_data: "panel:accounts" },
        { text: "返回面板", callback_data: "panel:status" }
      ]
    ]
  };
}

function parsePanelCallback(data: string | undefined) {
  const match = data?.match(/^acct:(\d+):(detail|messages|code|phones|monitor|notify|clear_note)$/);
  if (!match) {
    return null;
  }
  return {
    accountId: Number(match[1]),
    action: match[2] as "detail" | "messages" | "code" | "phones" | "monitor" | "notify" | "clear_note"
  };
}

async function reloadAccount(accountId: number, fallback: DtAccount) {
  return (await prisma.dtAccount.findUnique({ where: { id: accountId } })) ?? fallback;
}

async function accountDetailText(accountId: number) {
  if (!Number.isInteger(accountId)) {
    return "用法：/account <账户ID>";
  }
  const account = await prisma.dtAccount.findUnique({
    where: { id: accountId },
    include: { _count: { select: { phoneNumbers: true, messages: true } } }
  });
  if (!account) {
    return "账户不存在。";
  }
  return [
    `账户: ${accountName(account)}`,
    `ID: ${account.id}`,
    `说道用户ID: ${account.dtUserId ?? "-"}`,
    `说道号: ${account.phone ?? "-"}`,
    `邮箱: ${account.email ?? "-"}`,
    `状态: ${account.status}`,
    `监听: ${account.monitorEnabled ? "开" : "关"}`,
    `Telegram: ${account.telegramNotify ? "开" : "关"}`,
    `手机号: ${account._count.phoneNumbers}`,
    `消息: ${account._count.messages}`,
    `最后错误: ${account.lastError ?? "-"}`
  ].join("\n");
}

async function phoneListText(accountId: number) {
  if (!Number.isInteger(accountId)) {
    return "用法：/phones <账户ID>";
  }
  const phones = await prisma.phoneNumber.findMany({
    where: { accountId },
    orderBy: { id: "asc" },
    take: 30
  });
  if (phones.length === 0) {
    return "该账户暂无手机号。";
  }
  return phones.map(formatPhoneLine).join("\n");
}

async function messageListText(accountId: number, limitInput: number) {
  if (!Number.isInteger(accountId)) {
    return "用法：/messages <账户ID> [数量]";
  }
  const limit = Number.isInteger(limitInput) ? Math.min(Math.max(limitInput, 1), 10) : 5;
  const messages = await prisma.message.findMany({
    where: { accountId, direction: "incoming" },
    orderBy: { receivedAt: "desc" },
    take: limit
  });
  if (messages.length === 0) {
    return "该账户暂无消息。";
  }
  return messages
    .map((item) => [`${item.receivedAt.toISOString()}`, `来源: ${item.fromNumber ?? "-"}`, `内容: ${item.content}`].join("\n"))
    .join("\n\n");
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
      results.push(`${id}: 失败 ${errorMessage(error)}`);
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

async function panelStatusText() {
  const [accounts, monitoring, notifyOn, phones, unread] = await Promise.all([
    prisma.dtAccount.count(),
    prisma.dtAccount.count({ where: { monitorEnabled: true } }),
    prisma.dtAccount.count({ where: { telegramNotify: true } }),
    prisma.phoneNumber.count({ where: { status: PhoneStatus.active } }),
    prisma.message.count({ where: { direction: "incoming", isRead: false } })
  ]);
  return [
    "面板概览：",
    `账户: ${accounts}`,
    `监听中: ${monitoring}`,
    `Telegram 通知开启: ${notifyOn}`,
    `活跃手机号: ${phones}`,
    `未读消息: ${unread}`
  ].join("\n");
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
        error: errorMessage(error)
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
        error: errorMessage(error)
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
      error: errorMessage(error)
    });
    return `操作失败：${errorMessage(error)}`;
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
        error: errorMessage(error)
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

function truncateButtonText(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 1))}…`;
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
