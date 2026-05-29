import { MessageDirection, MessageType } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../utils/logger.js";
import { repairUtf8Mojibake } from "../utils/serializers.js";
import type { ParsedSmsPush } from "./dingtone/message-parser.js";
import { eventBus } from "./event-bus.js";
import { sendSmsTelegramNotification } from "./telegram-notifier.js";

type MessageRuntimeDb = Pick<PrismaClient, "dtAccount" | "message">;

type MessageRuntimeOptions = {
  db?: MessageRuntimeDb;
  emitEvents?: boolean;
  sendTelegram?: boolean;
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
  const normalizedPush = { ...push, content };
  const account = await db.dtAccount.findUnique({
    where: { id: accountId }
  });
  if (!account) {
    return false;
  }

  const duplicate = await findDuplicateMessage(accountId, normalizedPush, db);
  if (duplicate) {
    return false;
  }

  const msgType = inferMessageType(normalizedPush);
  const message = await db.message.create({
    data: {
      accountId,
      direction: MessageDirection.incoming,
      msgType,
      fromNumber: push.fromNumber,
      toNumber: push.toNumber ?? null,
      content,
      rawInfo: push.rawInfo ?? null,
      rawK3: push.rawK3 ?? null,
      k5Flag: push.k5Flag ?? null,
      receivedAt: new Date()
    }
  });

  await maybeSendTelegram(account, normalizedPush, message.id, message.receivedAt, db, options.sendTelegram ?? true);
  if (options.emitEvents ?? true) {
    eventBus.emitEvent({
      type: "new_message",
      payload: {
        id: message.id,
        accountId,
        accountNickname: deriveFallbackName(account),
        from: push.fromNumber,
        content,
        msgType,
        receivedAt: message.receivedAt.toISOString()
      }
    });
  }
  logger.info("Stored incoming direct SMS push", {
    accountId,
    messageId: message.id,
    fromNumber: push.fromNumber
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
  return db.message.findFirst({
    where: {
      accountId,
      direction: MessageDirection.incoming,
      fromNumber: push.fromNumber,
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

  const duplicate = await findDuplicateHelperSmsMessage(accountId, normalizedRow, db);
  if (duplicate) {
    return false;
  }

  const receivedAt = normalizeHelperReceivedAt(normalizedRow);
  const toNumber = extractTargetNumber(normalizedRow.conversationId, normalizedRow.senderId ?? normalizedRow.data1 ?? null);
  const msgType = inferHelperMessageType(normalizedRow);
  const message = await db.message.create({
    data: {
      accountId,
      direction: MessageDirection.incoming,
      msgType,
      fromNumber: normalizedRow.senderId ?? normalizedRow.data1 ?? null,
      toNumber,
      content,
      rawInfo: normalizedRow.conversationId ?? null,
      rawK3: normalizedRow.msgId ?? null,
      k5Flag: normalizedRow.type ?? null,
      isRead: normalizeReadFlag(normalizedRow.isRead),
      receivedAt
    }
  });

  await maybeSendTelegram(
    account,
    {
      msgType: normalizedRow.type ?? 0,
      fromNumber: normalizedRow.senderId ?? normalizedRow.data1 ?? null,
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
  if (options.emitEvents ?? true) {
    eventBus.emitEvent({
      type: "new_message",
      payload: {
        id: message.id,
        accountId,
        accountNickname: deriveFallbackName(account),
        from: normalizedRow.senderId ?? normalizedRow.data1 ?? null,
        content,
        msgType,
        receivedAt: message.receivedAt.toISOString()
      }
    });
  }
  logger.info("Stored helper SMS message from app database", {
    accountId,
    messageId: message.id,
    fromNumber: normalizedRow.senderId ?? normalizedRow.data1 ?? null
  });
  return true;
}

async function findDuplicateHelperSmsMessage(accountId: number, row: HelperSmsMessageRecord, db: MessageRuntimeDb) {
  const sender = row.senderId ?? row.data1 ?? null;
  const target = extractTargetNumber(row.conversationId, sender);
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

  const sameMessageWithPartialTarget = await db.message.findFirst({
    where: {
      accountId,
      direction: MessageDirection.incoming,
      fromNumber: sender,
      content,
      receivedAt: { gte: recentSince, lte: recentUntil },
      OR: target
        ? [{ toNumber: target }, { toNumber: null }]
        : [{ toNumber: null }, { toNumber: { not: null } }]
    },
    select: { id: true }
  });
  if (sameMessageWithPartialTarget) {
    return sameMessageWithPartialTarget;
  }

  if (isUiExtractedHelperRow(row)) {
    return db.message.findFirst({
      where: {
        accountId,
        direction: MessageDirection.incoming,
        fromNumber: sender,
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
  return /^(dingtone|talku|talkyou|dingdong|dingtone team|talku team|dingdong team|team)$/i.test(sender) ||
    /dingtone team|talku team|talkyou team|dingdong team|叮咚团队|说道团队|系統消息|系统消息|TalkU number|free calling and messaging/i.test(`${sender}\n${content}\n${rawInfo}`);
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
  const other = parts.find((item) => item !== senderId);
  return other ?? null;
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
