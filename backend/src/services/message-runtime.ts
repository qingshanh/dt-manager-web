import { MessageDirection, MessageType } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";
import { repairUtf8Mojibake } from "../utils/serializers.js";
import { getSettingsMap } from "./settings.service.js";
import type { ParsedSmsPush } from "./dingtone/message-parser.js";
import { eventBus } from "./event-bus.js";
import { sendSmsTelegramNotification } from "./telegram-notifier.js";

type MessageRuntimeDb = Pick<PrismaClient, "dtAccount" | "message" | "phoneNumber">;

type MessageRuntimeOptions = {
  db?: MessageRuntimeDb;
  emitEvents?: boolean;
  sendTelegram?: boolean;
  collectTeamMessages?: boolean;
};

export type HelperSmsMessageRecord = {
  id?: number | null;
  conversationId?: string | null;
  conversationUserId?: string | null;
  type?: number | null;
  senderId?: string | null;
  msgId?: string | null;
  content?: string | null;
  timestamp?: number | null;
  time?: number | null;
  isRead?: number | null;
  data1?: string | null;
  data2?: string | null;
  data3?: string | null;
};

export async function storeParsedSmsPushes(accountId: number, pushes: ParsedSmsPush[], options: MessageRuntimeOptions = {}) {
  let createdCount = 0;

  for (const push of pushes) {
    if (!push.content?.trim()) {
      continue;
    }
    const created = await storeParsedSmsPush(accountId, push, options);
    if (created) {
      createdCount += 1;
    }
  }

  return createdCount;
}

export async function storeHelperSmsMessages(accountId: number, rows: HelperSmsMessageRecord[], options: MessageRuntimeOptions = {}) {
  let createdCount = 0;
  for (const row of rows) {
    if (!row.content?.trim()) {
      continue;
    }
    const created = await storeHelperSmsMessage(accountId, row, options);
    if (created) {
      createdCount += 1;
    }
  }
  return createdCount;
}

async function storeParsedSmsPush(accountId: number, push: ParsedSmsPush, options: MessageRuntimeOptions) {
  const db = options.db ?? prisma;
  const content = repairUtf8Mojibake(push.content.trim()) ?? push.content.trim();
  let normalizedPush = {
    ...push,
    content,
    toNumber: normalizeDirectTargetNumber(push.toNumber ?? null, push.fromNumber ?? null)
  };
  const account = await db.dtAccount.findUnique({
    where: { id: accountId }
  });
  if (!account) {
    return false;
  }

  normalizedPush = {
    ...normalizedPush,
    toNumber: normalizedPush.toNumber ?? (await inferDirectTargetNumberFromAccountPhones(accountId, normalizedPush, db))
  };

  const msgType = inferMessageType(normalizedPush);
  const systemMessage = msgType === MessageType.system;
  if (systemMessage && !(await shouldCollectTeamMessages(options))) {
    return false;
  }

  const duplicate = await findDuplicateMessage(accountId, normalizedPush, db);
  if (duplicate) {
    return false;
  }

  const message = await db.message.create({
    data: {
      accountId,
      direction: MessageDirection.incoming,
      msgType,
      fromNumber: normalizedPush.fromNumber,
      toNumber: normalizedPush.toNumber ?? null,
      content,
      rawInfo: normalizedPush.rawInfo ?? null,
      rawK3: normalizedPush.rawK3 ?? null,
      k5Flag: normalizedPush.k5Flag ?? null,
      isRead: systemMessage,
      receivedAt: new Date()
    }
  });

  if (!systemMessage) {
    await maybeSendTelegram(account, normalizedPush, message.id, message.receivedAt, db, options.sendTelegram ?? true);
  }
  if ((options.emitEvents ?? true) && !systemMessage) {
    eventBus.emitEvent({
      type: "new_message",
      payload: {
        id: message.id,
        accountId,
        accountNickname: deriveFallbackName(account),
        from: normalizedPush.fromNumber,
        content,
        msgType,
        receivedAt: message.receivedAt.toISOString()
      }
    });
  }
  logger.info("Stored incoming direct SMS push", {
    accountId,
    messageId: message.id,
    fromNumber: normalizedPush.fromNumber,
    toNumber: normalizedPush.toNumber
  });
  return true;
}

async function findDuplicateMessage(accountId: number, push: ParsedSmsPush, db: MessageRuntimeDb) {
  if (push.rawK3) {
    const byRawK3 = await db.message.findFirst({
      where: {
        accountId,
        direction: MessageDirection.incoming,
        rawK3: push.rawK3
      },
      select: { id: true }
    });
    if (byRawK3) {
      return byRawK3;
    }
  }

  const recentSince = new Date(Date.now() - 10 * 60_000);
  const target = push.toNumber ?? null;
  return db.message.findFirst({
    where: {
      accountId,
      direction: MessageDirection.incoming,
      fromNumber: push.fromNumber,
      toNumber: target,
      content: push.content,
      receivedAt: { gte: recentSince }
    },
    select: { id: true }
  });
}

async function storeHelperSmsMessage(accountId: number, row: HelperSmsMessageRecord, options: MessageRuntimeOptions) {
  const db = options.db ?? prisma;
  const content = repairUtf8Mojibake(row.content?.trim() ?? "")?.trim();
  if (!content) {
    return false;
  }
  const normalizedRow = { ...row, content };
  const account = await db.dtAccount.findUnique({
    where: { id: accountId }
  });
  if (!account) {
    return false;
  }

  const msgType = inferHelperMessageType(normalizedRow);
  const systemMessage = msgType === MessageType.system;
  if (systemMessage && !(await shouldCollectTeamMessages(options))) {
    return false;
  }

  const duplicate = await findDuplicateHelperSmsMessage(accountId, normalizedRow, db);
  if (duplicate) {
    return false;
  }

  const receivedAt = normalizeHelperReceivedAt(normalizedRow);
  const sender = normalizedRow.senderId ?? normalizedRow.data1 ?? null;
  const toNumber =
    extractTargetNumber(normalizedRow.conversationId, sender) ??
    (await inferTargetNumberFromAccountPhones(accountId, normalizedRow, sender, db));
  const message = await db.message.create({
    data: {
      accountId,
      direction: MessageDirection.incoming,
      msgType,
      fromNumber: sender,
      toNumber,
      content,
      rawInfo: normalizedRow.conversationId ?? null,
      rawK3: normalizedRow.msgId ?? null,
      k5Flag: normalizedRow.type ?? null,
      isRead: systemMessage || normalizeReadFlag(normalizedRow.isRead),
      receivedAt
    }
  });

  if (!systemMessage) {
    await maybeSendTelegram(
      account,
      {
        msgType: normalizedRow.type ?? 0,
        fromNumber: sender,
        toNumber,
        content,
        rawInfo: normalizedRow.conversationId ?? undefined,
        rawK3: normalizedRow.msgId ?? undefined,
        k5Flag: normalizedRow.type ?? undefined
      },
      message.id,
      message.receivedAt,
      db,
      options.sendTelegram ?? true
    );
  }
  if ((options.emitEvents ?? true) && !systemMessage) {
    eventBus.emitEvent({
      type: "new_message",
      payload: {
        id: message.id,
        accountId,
        accountNickname: deriveFallbackName(account),
        from: sender,
        content,
        msgType,
        receivedAt: message.receivedAt.toISOString()
      }
    });
  }
  logger.info("Stored helper SMS message from app database", {
    accountId,
    messageId: message.id,
    fromNumber: sender
  });
  return true;
}

async function findDuplicateHelperSmsMessage(accountId: number, row: HelperSmsMessageRecord, db: MessageRuntimeDb) {
  const sender = row.senderId ?? row.data1 ?? null;
  const target = extractTargetNumber(row.conversationId, sender) ?? (await inferTargetNumberFromAccountPhones(accountId, row, sender, db));
  const content = row.content?.trim() ?? "";
  if (row.msgId) {
    const byMsgId = await db.message.findFirst({
      where: {
        accountId,
        direction: MessageDirection.incoming,
        rawK3: row.msgId
      },
      select: { id: true }
    });
    if (byMsgId) {
      return byMsgId;
    }
  }

  const normalizedReceivedAt = normalizeHelperReceivedAt(row);
  const recentSince = new Date(normalizedReceivedAt.getTime() - 2 * 60_000);
  const recentUntil = new Date(normalizedReceivedAt.getTime() + 2 * 60_000);
  const exactMatch = await db.message.findFirst({
    where: {
      accountId,
      direction: MessageDirection.incoming,
      fromNumber: sender,
      toNumber: target,
      rawInfo: row.conversationId ?? null,
      content,
      receivedAt: { gte: recentSince, lte: recentUntil }
    },
    select: { id: true }
  });
  if (exactMatch) {
    return exactMatch;
  }

  const sameMessage = await db.message.findFirst({
    where: {
      accountId,
      direction: MessageDirection.incoming,
      fromNumber: sender,
      toNumber: target,
      content,
      receivedAt: { gte: recentSince, lte: recentUntil }
    },
    select: { id: true }
  });
  if (sameMessage) {
    return sameMessage;
  }

  if (isUiExtractedHelperRow(row)) {
    return db.message.findFirst({
      where: {
        accountId,
        direction: MessageDirection.incoming,
        fromNumber: sender,
        toNumber: target,
        content,
        receivedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60_000) }
      },
      select: { id: true }
    });
  }

  return null;
}

function inferMessageType(push: ParsedSmsPush) {
  if (isTeamOrSystemMessage(push)) {
    return MessageType.system;
  }
  if (/\d{4,8}/.test(push.content) || push.msgType === 25) {
    return MessageType.verification;
  }
  return MessageType.sms;
}

function inferHelperMessageType(row: HelperSmsMessageRecord) {
  if (
    isTeamOrSystemMessage({
      fromNumber: row.senderId ?? row.data1 ?? null,
      content: row.content,
      rawInfo: row.conversationId
    })
  ) {
    return MessageType.system;
  }
  if (/\d{4,8}/.test(row.content ?? "")) {
    return MessageType.verification;
  }
  return MessageType.sms;
}

function isTeamOrSystemMessage(input: { fromNumber?: string | null; content?: string | null; rawInfo?: string | null }) {
  const sender = (input.fromNumber ?? "").trim();
  const content = (input.content ?? "").trim();
  const rawInfo = (input.rawInfo ?? "").trim();
  const text = `${sender}\n${content}\n${rawInfo}`;
  if (containsTeamOrSystemText(text)) {
    return true;
  }
  if (/鍙挌鍥㈤槦|璇撮亾鍥㈤槦|绯荤当娑堟伅|绯荤粺娑堟伅/i.test(`${sender}\n${content}\n${rawInfo}`)) {
    return true;
  }
  return /^(dingtone|talku|talkyou|dingdong|dingtone team|talku team|dingdong team|team)$/i.test(sender) ||
    /dingtone team|talku team|talkyou team|dingdong team|鍙挌鍥㈤槦|璇撮亾鍥㈤槦|绯荤当娑堟伅|绯荤粺娑堟伅|TalkU number|free calling and messaging/i.test(`${sender}\n${content}\n${rawInfo}`);
}

function containsTeamOrSystemText(value: string) {
  return /dingtone team|talku team|talkyou team|dingdong team|TalkU number|free calling and messaging|private number order|number order succeeded|order succeeded|number purchase|purchase succeeded|will expire|has expired|expires in|credits?|points?|balance changed|\u53ee\u549a\u56e2\u961f|\u8bf4\u9053\u56e2\u961f|\u7cfb\u7d71\u6d88\u606f|\u7cfb\u7edf\u6d88\u606f|\u8bf4\u9053\u5e01|\u53ee\u549a\u5e01|\u79ef\u5206|\u53f7\u7801\u8ba2\u8d2d|\u8ba2\u8d2d\u6210\u529f|\u8d2d\u4e70\u6210\u529f|\u5373\u5c06\u5230\u671f|\u5df2\u5230\u671f|\u8fc7\u671f|\u7eed\u8d39/i.test(
    value
  );
}

async function shouldCollectTeamMessages(options: MessageRuntimeOptions) {
  if (options.collectTeamMessages !== undefined) {
    return options.collectTeamMessages;
  }
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  return parseBooleanSetting(settings.collect_team_messages, true);
}

function parseBooleanSetting(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return !/^(false|0|no|off)$/i.test(value.trim());
}
function normalizeHelperReceivedAt(row: HelperSmsMessageRecord) {
  const candidate = row.time ?? row.timestamp ?? null;
  if (!candidate || !Number.isFinite(candidate)) {
    return new Date();
  }
  return new Date(candidate > 1_000_000_000_000 ? candidate : candidate * 1000);
}

function normalizeReadFlag(value: number | null | undefined) {
  return value === 1;
}

function extractTargetNumber(conversationId: string | null | undefined, senderId: string | null | undefined) {
  if (!conversationId) {
    return null;
  }
  const parts = conversationId.split("|").map((item) => item.trim()).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const other = parts.find((item) => item !== senderId && !samePhoneDigits(item, senderId));
  return other ?? null;
}

async function inferDirectTargetNumberFromAccountPhones(accountId: number, push: ParsedSmsPush, db: MessageRuntimeDb) {
  const metadataParts = [push.toNumber, push.rawInfo, push.rawK3, push.content];
  const decodedParts = [push.rawInfo, push.rawK3].flatMap(decodeMetadataForSearch);
  const haystack = [...metadataParts, ...decodedParts].filter(Boolean).join("\n");
  const normalizedHaystack = normalizeDigits(haystack);
  if (!normalizedHaystack) {
    return null;
  }

  const phones = await db.phoneNumber.findMany({
    where: { accountId },
    select: { phoneNumber: true }
  });
  const candidates = phones.filter((phone) => {
    if (samePhoneDigits(phone.phoneNumber, push.fromNumber)) {
      return false;
    }
    const digits = normalizeDigits(phone.phoneNumber);
    if (!digits) {
      return false;
    }
    if (normalizedHaystack.includes(digits)) {
      return true;
    }
    const tail = digits.slice(-7);
    return tail.length >= 7 && normalizedHaystack.includes(tail);
  });

  return candidates.length === 1 ? candidates[0]!.phoneNumber : null;
}

function normalizeDirectTargetNumber(toNumber: string | null | undefined, sender: string | null | undefined) {
  if (!toNumber?.trim()) {
    return null;
  }
  return samePhoneDigits(toNumber, sender) ? null : toNumber;
}

function decodeMetadataForSearch(value: string | null | undefined) {
  if (!value?.trim()) {
    return [] as string[];
  }
  const trimmed = value.trim();
  const decoded = new Set<string>();
  decoded.add(trimmed);
  if (/^[A-Za-z0-9+/=_-]{8,}$/.test(trimmed)) {
    for (const encoding of ["utf8", "latin1"] as const) {
      try {
        decoded.add(Buffer.from(trimmed, "base64").toString(encoding));
      } catch {
        // Ignore malformed metadata; plain text remains searchable.
      }
    }
  }
  return [...decoded];
}

async function inferTargetNumberFromAccountPhones(
  accountId: number,
  row: HelperSmsMessageRecord,
  senderId: string | null | undefined,
  db: MessageRuntimeDb
) {
  const haystack = [
    row.conversationId,
    row.conversationUserId,
    row.senderId,
    senderId,
    row.data1,
    row.data2,
    row.data3,
    row.content
  ]
    .filter(Boolean)
    .join("\n");
  const phones = await db.phoneNumber.findMany({
    where: { accountId },
    select: { phoneNumber: true }
  });
  const normalizedHaystack = normalizeDigits(haystack);
  for (const phone of phones) {
    if (samePhoneDigits(phone.phoneNumber, senderId)) {
      continue;
    }
    const digits = normalizeDigits(phone.phoneNumber);
    if (digits && normalizedHaystack.includes(digits)) {
      return phone.phoneNumber;
    }
  }
  const candidates = phones
    .filter((phone) => !samePhoneDigits(phone.phoneNumber, senderId))
    .map((phone) => ({ phoneNumber: phone.phoneNumber, tail: normalizeDigits(phone.phoneNumber).slice(-7) }))
    .filter((item) => item.tail.length >= 7 && normalizedHaystack.includes(item.tail));
  return candidates.length === 1 ? candidates[0]!.phoneNumber : null;
}

function normalizeDigits(value: string | null | undefined) {
  return value?.replace(/\D/g, "") ?? "";
}

function samePhoneDigits(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizeComparablePhoneDigits(a);
  const right = normalizeComparablePhoneDigits(b);
  return Boolean(left && right && left === right);
}

function normalizeComparablePhoneDigits(value: string | null | undefined) {
  const digits = normalizeDigits(value);
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

function isUiExtractedHelperRow(row: HelperSmsMessageRecord) {
  return row.data3 === "adb-ui" || (!row.msgId && !row.conversationId);
}

async function maybeSendTelegram(
  account: { id: number; nickname: string | null; email: string | null; phone: string | null; dtUserId: string | null; telegramNotify: boolean },
  push: ParsedSmsPush,
  messageId: number,
  receivedAt: Date,
  db: MessageRuntimeDb,
  enabled: boolean
) {
  if (!enabled) {
    return;
  }
  if (!account.telegramNotify) {
    return;
  }
  if (isTeamOrSystemMessage(push)) {
    return;
  }

  try {
    const telegramMsgId = await sendSmsTelegramNotification({
      account,
      fromNumber: push.fromNumber,
      toNumber: push.toNumber,
      content: push.content,
      receivedAt
    });
    if (!telegramMsgId) {
      return;
    }
    await db.message.update({
      where: { id: messageId },
      data: {
        telegramSent: true,
        telegramMsgId
      }
    });
  } catch (error) {
    logger.warn("Failed to send Telegram notification for direct SMS push", {
      accountId: account.id,
      messageId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function deriveFallbackName(input: {
  nickname?: string | null;
  email?: string | null;
  phone?: string | null;
  dtUserId?: string | null;
}) {
  return input.nickname?.trim() || input.email?.trim() || input.phone?.trim() || input.dtUserId?.trim() || "Untitled Account";
}
