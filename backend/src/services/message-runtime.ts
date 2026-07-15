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
const DIRECT_FALLBACK_DEDUPE_MS = 30_000;

type MessageRuntimeOptions = {
  db?: MessageRuntimeDb;
  emitEvents?: boolean;
  sendTelegram?: boolean;
  collectTeamMessages?: boolean;
};

export type HelperSmsMessageRecord = {
  id?: number | null;
  conversationType?: number | null;
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
  const fromNumber = repairUtf8Mojibake(push.fromNumber?.trim() ?? null);
  let normalizedPush = {
    ...push,
    content,
    fromNumber,
    toNumber: normalizeDirectTargetNumber(push.toNumber ?? null, fromNumber)
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
  const directOwner = await resolveTargetPhoneOwner(account, normalizedPush.toNumber, normalizedPush.fromNumber, db);
  const targetAccount = directOwner?.account ?? account;
  normalizedPush = {
    ...normalizedPush,
    toNumber: directOwner?.phoneNumber ?? normalizedPush.toNumber
  };

  const teamName = resolveNamedTeamName(normalizedPush.fromNumber, normalizedPush.rawInfo);
  const msgType = teamName ? MessageType.system : inferMessageType(normalizedPush);
  const systemMessage = msgType === MessageType.system;
  if (systemMessage && !(await shouldCollectTeamMessages(options))) {
    return false;
  }

  const duplicate = await findDuplicateMessage(targetAccount.id, normalizedPush, db);
  if (duplicate) {
    return false;
  }

  const message = await db.message.create({
    data: {
      accountId: targetAccount.id,
      direction: MessageDirection.incoming,
      msgType,
      fromNumber: teamName ?? normalizedPush.fromNumber,
      toNumber: normalizedPush.toNumber ?? null,
      content,
      rawInfo: normalizedPush.rawInfo ?? null,
      rawK3: normalizedPush.rawK3 ?? null,
      k5Flag: normalizedPush.k5Flag ?? null,
      isRead: systemMessage,
      receivedAt: new Date()
    }
  });

  if ((options.emitEvents ?? true) && !systemMessage) {
    eventBus.emitEvent({
      adminId: targetAccount.adminId,
      type: "new_message",
      payload: {
        id: message.id,
        accountId: targetAccount.id,
        accountNickname: deriveFallbackName(targetAccount),
        from: teamName ?? normalizedPush.fromNumber,
        toNumber: normalizedPush.toNumber,
        content,
        msgType,
        receivedAt: message.receivedAt.toISOString()
      }
    });
  }
  if (!systemMessage) {
    void maybeSendTelegram(targetAccount, normalizedPush, message.id, message.receivedAt, db, options.sendTelegram ?? true);
  }
  logger.info("Stored incoming direct SMS push", {
    accountId: targetAccount.id,
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

  const recentSince = new Date(Date.now() - DIRECT_FALLBACK_DEDUPE_MS);
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

  const teamName = resolveHelperTeamName(normalizedRow, account.appVariant);
  if (isKnownSystemConversation(normalizedRow) && !teamName) {
    return false;
  }
  const msgType = teamName ? MessageType.system : inferHelperMessageType(normalizedRow);
  const systemMessage = msgType === MessageType.system;
  if (systemMessage && !(await shouldCollectTeamMessages(options))) {
    return false;
  }

  const sender = teamName ?? normalizedRow.senderId ?? normalizedRow.data1 ?? null;
  if (!teamName && await isHelperOutgoingMessage(account, sender, db)) {
    return false;
  }


  const storedContent = teamName ? extractTeamMessageContent(normalizedRow.content, account.appVariant) : content;
  const rowForStorage = { ...normalizedRow, content: storedContent };
  const receivedAtResult = normalizeHelperReceivedAtResult(rowForStorage);
  const receivedAt = receivedAtResult.receivedAt;
  let toNumber =
    extractTargetNumber(rowForStorage.conversationId, sender) ??
    (await inferTargetNumberFromAccountPhones(accountId, rowForStorage, sender, db));
  const helperOwner = await resolveTargetPhoneOwner(account, toNumber, sender, db);
  const targetAccount = helperOwner?.account ?? account;
  toNumber = helperOwner?.phoneNumber ?? toNumber;

  const duplicate = await findDuplicateHelperSmsMessage(targetAccount.id, rowForStorage, db, toNumber);
  if (duplicate) {
    const replacementReceivedAt = resolveDuplicateTeamReceivedAt(
      duplicate,
      receivedAtResult
    );
    if (
      teamName &&
      (duplicate.content !== storedContent ||
        duplicate.fromNumber !== teamName ||
        replacementReceivedAt)
    ) {
      await db.message.update({
        where: { id: duplicate.id },
        data: {
          fromNumber: teamName,
          content: storedContent,
          isRead: true,
          ...(replacementReceivedAt ? { receivedAt: replacementReceivedAt } : {})
        }
      });
    }
    return false;
  }

  const message = await db.message.create({
    data: {
      accountId: targetAccount.id,
      direction: MessageDirection.incoming,
      msgType,
      fromNumber: sender,
      toNumber,
      content: storedContent,
      rawInfo: rowForStorage.conversationId ?? null,
      rawK3: rowForStorage.msgId ?? null,
      k5Flag: rowForStorage.type ?? null,
      isRead: systemMessage || normalizeReadFlag(rowForStorage.isRead),
      receivedAt
    }
  });

  if (!systemMessage) {
    await maybeSendTelegram(
      targetAccount,
      {
        msgType: rowForStorage.type ?? 0,
        fromNumber: sender,
        toNumber,
        content: storedContent,
        rawInfo: rowForStorage.conversationId ?? undefined,
        rawK3: rowForStorage.msgId ?? undefined,
        k5Flag: rowForStorage.type ?? undefined
      },
      message.id,
      message.receivedAt,
      db,
      options.sendTelegram ?? true
    );
  }
  if ((options.emitEvents ?? true) && !systemMessage) {
    eventBus.emitEvent({
      adminId: targetAccount.adminId,
      type: "new_message",
      payload: {
        id: message.id,
        accountId: targetAccount.id,
        accountNickname: deriveFallbackName(targetAccount),
        from: sender,
        toNumber,
        content,
        msgType,
        receivedAt: message.receivedAt.toISOString()
      }
    });
  }
  logger.info("Stored helper SMS message from app database", {
    accountId: targetAccount.id,
    messageId: message.id,
    fromNumber: sender
  });
  return true;
}

async function findDuplicateHelperSmsMessage(accountId: number, row: HelperSmsMessageRecord, db: MessageRuntimeDb, targetOverride?: string | null) {
  const sender = row.senderId ?? row.data1 ?? null;
  const target = targetOverride ?? extractTargetNumber(row.conversationId, sender) ?? (await inferTargetNumberFromAccountPhones(accountId, row, sender, db));
  const content = row.content?.trim() ?? "";
  if (row.msgId) {
    const byMsgId = await db.message.findFirst({
      where: {
        accountId,
        direction: MessageDirection.incoming,
        rawK3: row.msgId
      },
      select: { id: true, content: true, fromNumber: true, receivedAt: true, createdAt: true }
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
    select: { id: true, content: true, fromNumber: true, receivedAt: true, createdAt: true }
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
    select: { id: true, content: true, fromNumber: true, receivedAt: true, createdAt: true }
  });
  if (sameMessage) {
    return sameMessage;
  }

  if (target) {
    const crossSourceMatch = await db.message.findFirst({
      where: {
        accountId,
        direction: MessageDirection.incoming,
        toNumber: target,
        content,
        receivedAt: {
          gte: new Date(normalizedReceivedAt.getTime() - 5_000),
          lte: new Date(normalizedReceivedAt.getTime() + 5_000)
        }
      },
      select: { id: true, content: true, fromNumber: true, receivedAt: true, createdAt: true }
    });
    if (crossSourceMatch) {
      return crossSourceMatch;
    }
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
      select: { id: true, content: true, fromNumber: true, receivedAt: true, createdAt: true }
    });
  }

  return null;
}

function inferMessageType(push: ParsedSmsPush) {
  if (resolveNamedTeamName(push.fromNumber, push.rawInfo)) {
    return MessageType.system;
  }
  if (/\d{4,8}/.test(push.content) || push.msgType === 25) {
    return MessageType.verification;
  }
  return MessageType.sms;
}

function inferHelperMessageType(row: HelperSmsMessageRecord) {
  if (resolveNamedTeamName(row.senderId, row.data1, row.conversationId, row.conversationUserId)) {
    return MessageType.system;
  }
  if (/\d{4,8}/.test(row.content ?? "")) {
    return MessageType.verification;
  }
  return MessageType.sms;
}

function isTeamOrSystemMessage(input: { fromNumber?: string | null; content?: string | null; rawInfo?: string | null }) {
  return Boolean(resolveNamedTeamName(input.fromNumber, input.rawInfo));
}

function resolveNamedTeamName(...values: Array<string | null | undefined>) {
  const candidates = values
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(/[|\n]/))
    .map((value) => repairUtf8Mojibake(value.trim()) ?? value.trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (/^(?:叮咚团队|dingtone\s+team|dingdong\s+team)$/i.test(candidate)) {
      return "叮咚团队";
    }
    if (/^(?:说道团队|talku\s+team|talkyou\s+team)$/i.test(candidate)) {
      return "说道团队";
    }
  }
  return null;
}

function resolveHelperTeamName(row: HelperSmsMessageRecord, appVariant: unknown) {
  const named = resolveNamedTeamName(row.senderId, row.data1, row.conversationId, row.conversationUserId);
  if (named) {
    return named;
  }
  if (row.conversationType === 4 && row.conversationId === "10000") {
    return appVariant === "dingdong" ? "叮咚团队" : "说道团队";
  }
  return null;
}

function extractTeamMessageContent(content: string, appVariant: unknown) {
  const envelope = parseJsonRecord(content);
  if (!envelope) {
    return content;
  }
  const title = readJsonString(envelope.msgTitle);
  const body = readJsonString(envelope.msgContent);
  const meta = parseJsonRecord(readJsonString(envelope.msgMeta));
  const credits = readFiniteNumber(meta?.credits);
  if (credits !== null) {
    const currency = appVariant === "dingdong" ? "叮咚币" : "说道币";
    const messageType = readFiniteNumber(meta?.type);
    const expiryDays = readFiniteNumber(meta?.ex);
    if (messageType === 5) {
      return `您获得了${formatTeamFixedNumber(credits)}个${currency}。此任务已完成，开始一个新任务获得更多${currency}吧！`;
    }
    if (messageType === 34) {
      const expiryMonths = expiryDays !== null && expiryDays > 0 ? Math.max(1, Math.round(expiryDays / 30)) : null;
      const expiryText = expiryMonths === null ? "" : `（有效期${expiryMonths}个月）`;
      return `兑换成功，恭喜您成功获得${currency}${formatTeamNumber(credits)}个${expiryText}。现在去查看余额`;
    }
    if (messageType === 99) {
      return `${formatTeamNumber(credits)}个${currency}已经到你账上。现在去查看余额。`;
    }
    return `${formatTeamNumber(credits)}个${currency}已经到你账上。`;
  }
  if (title && body && !looksLikeJson(body)) {
    return `${title}\n${body}`;
  }
  if (body && !looksLikeJson(body)) {
    return body;
  }
  if (title) {
    return title;
  }
  return content;
}

function parseJsonRecord(value: string | null | undefined) {
  if (!value?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readJsonString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readFiniteNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTeamNumber(value: number) {
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatTeamFixedNumber(value: number) {
  return value.toFixed(2);
}

function looksLikeJson(value: string) {
  const text = value.trim();
  return (text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"));
}

function isKnownSystemConversation(row: HelperSmsMessageRecord) {
  return row.conversationType !== null && row.conversationType !== undefined && [4, 8, 9, 11].includes(row.conversationType);
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
  return normalizeHelperReceivedAtResult(row).receivedAt;
}

function resolveDuplicateTeamReceivedAt(
  duplicate: { receivedAt: Date | null; createdAt: Date },
  incoming: { receivedAt: Date; reliable: boolean }
) {
  const existingTime = duplicate.receivedAt?.getTime() ?? null;
  const createdTime = duplicate.createdAt.getTime();
  const incomingTime = incoming.receivedAt.getTime();
  const existingTimeIsPolluted = existingTime !== null && existingTime > createdTime + 5 * 60_000;

  if (existingTimeIsPolluted) {
    if (incoming.reliable && incomingTime < existingTime! && incomingTime <= createdTime + 5 * 60_000) {
      return incoming.receivedAt;
    }
    return duplicate.createdAt;
  }
  if (!incoming.reliable) {
    return null;
  }
  if (existingTime === null || incomingTime < existingTime) {
    return incoming.receivedAt;
  }
  return null;
}

function normalizeHelperReceivedAtResult(row: HelperSmsMessageRecord) {
  const candidate = [row.time, row.timestamp].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0
  );
  if (candidate === undefined) {
    return { receivedAt: new Date(), reliable: false };
  }
  const timestamp = candidate > 1_000_000_000_000 ? candidate : candidate * 1000;
  const now = Date.now();
  if (timestamp > now + 5 * 60_000) {
    // App databases can encode local wall-clock fields as if they were UTC.
    const localUtcOffsetMs = -new Date(timestamp).getTimezoneOffset() * 60_000;
    if (localUtcOffsetMs > 0) {
      const corrected = timestamp - localUtcOffsetMs;
      if (corrected > 0 && corrected <= now + 5 * 60_000) {
        return { receivedAt: new Date(corrected), reliable: true };
      }
    }
    return { receivedAt: new Date(now), reliable: false };
  }
  return { receivedAt: new Date(timestamp), reliable: true };
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

async function resolveTargetPhoneOwner(
  currentAccount: { id: number; adminId?: number | null; appVariant?: unknown; dtUserId?: string | null },
  targetNumber: string | null | undefined,
  sender: string | null | undefined,
  db: MessageRuntimeDb
) {
  if (!targetNumber?.trim() || samePhoneDigits(targetNumber, sender)) {
    return null;
  }
  if (currentAccount.adminId === undefined || currentAccount.adminId === null) {
    return null;
  }

  const rows = await db.phoneNumber.findMany({
    where: {
      account: {
        adminId: currentAccount.adminId,
        appVariant: currentAccount.appVariant as never
      }
    },
    select: {
      accountId: true,
      phoneNumber: true
    }
  });
  const matches = rows.filter((row) => samePhoneDigits(row.phoneNumber, targetNumber));
  const accountIds = Array.from(new Set(matches.map((row) => row.accountId)));
  if (accountIds.length !== 1) {
    return null;
  }

  const account = await db.dtAccount.findUnique({ where: { id: accountIds[0]! } });
  if (!account) {
    return null;
  }
  return {
    account,
    phoneNumber: matches[0]?.phoneNumber ?? targetNumber
  };
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

async function isHelperOutgoingMessage(
  account: { id: number; phone?: string | null },
  sender: string | null | undefined,
  db: MessageRuntimeDb
) {
  if (!sender?.trim()) {
    return false;
  }
  if (samePhoneDigits(account.phone, sender)) {
    return true;
  }
  const phones = await db.phoneNumber.findMany({
    where: { accountId: account.id },
    select: { phoneNumber: true }
  });
  return phones.some((phone) => samePhoneDigits(phone.phoneNumber, sender));
}

function normalizeDigits(value: string | null | undefined) {
  return value?.replace(/\D/g, "") ?? "";
}

function samePhoneDigits(a: string | null | undefined, b: string | null | undefined) {
  const leftVariants = phoneDigitVariants(a);
  const rightVariants = phoneDigitVariants(b);
  for (const left of leftVariants) {
    for (const right of rightVariants) {
      if (left === right) {
        return true;
      }
      const longer = left.length >= right.length ? left : right;
      const shorter = left.length >= right.length ? right : left;
      const prefixLength = longer.length - shorter.length;
      if (shorter.length >= 7 && prefixLength >= 1 && prefixLength <= 3 && longer.endsWith(shorter)) {
        return true;
      }
    }
  }
  return false;
}

function phoneDigitVariants(value: string | null | undefined) {
  const digits = normalizeDigits(value);
  const variants = new Set<string>();
  if (!digits) {
    return variants;
  }
  variants.add(digits);
  if (digits.startsWith("00") && digits.length > 2) {
    variants.add(digits.slice(2));
  }
  if (digits.startsWith("0") && digits.length > 1) {
    variants.add(digits.slice(1));
  }
  return variants;
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
