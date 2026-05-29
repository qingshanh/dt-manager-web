import { MessageDirection, MessageType, Prisma } from "@prisma/client";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { verifyAuthToken } from "../middleware/auth.js";
import { listenDirectSessionPushes, type DirectProbePushResult } from "../services/dingtone/direct-gateway.js";
import type { ParsedSmsPush } from "../services/dingtone/message-parser.js";
import { getSettingsMap } from "../services/settings.service.js";
import { storeParsedSmsPushes } from "../services/message-runtime.js";
import { AppError } from "../utils/errors.js";
import { decryptText } from "../utils/crypto.js";
import { ok } from "../utils/response.js";
import { serializeMessage, serializePhoneNumber } from "../utils/serializers.js";

const phoneQuerySchema = z.object({
  status: z.enum(["all", "active", "paused", "expired", "cancelled", "pending"]).optional().default("all")
});

const waitCodeSchema = z
  .object({
    phone_id: z.coerce.number().int().positive().optional(),
    phone_ids: z.array(z.coerce.number().int().positive()).max(10).optional(),
    phone_number: z.string().trim().min(1).optional(),
    phone_numbers: z.array(z.string().trim().min(1)).max(10).optional(),
    account_id: z.coerce.number().int().positive().optional(),
    since_message_id: z.coerce.number().int().positive().optional(),
    since: z.coerce.date().optional(),
    timeout_seconds: z.coerce.number().int().positive().max(120).optional().default(45),
    max_push_frames: z.coerce.number().int().positive().max(50).optional().default(20),
    keyword: z.string().trim().min(1).max(80).optional()
  })
  .refine((value) => value.phone_id || value.phone_ids?.length || value.phone_number || value.phone_numbers?.length, {
    message: "phone_id, phone_ids, phone_number, or phone_numbers is required"
  });

type SelectedPhone = Prisma.PhoneNumberGetPayload<{
  include: {
    account: true;
  };
}>;

type PhoneMatch = "confirmed" | "unverified" | "mismatch";

export const codeReceiverRouter = Router();

codeReceiverRouter.use(requireCodeReceiverAuth);

codeReceiverRouter.get("/phones", async (req, res, next) => {
  try {
    const query = phoneQuerySchema.parse(req.query);
    const where: Prisma.PhoneNumberWhereInput = {
      account: { adminId: req.auth!.userId }
    };
    if (query.status !== "all") {
      where.status = query.status;
    }

    const phones = await prisma.phoneNumber.findMany({
      where,
      include: { account: true },
      orderBy: [{ accountId: "asc" }, { isPrimary: "desc" }, { createdAt: "desc" }]
    });

    ok(res, {
      list: phones.map(serializeCodeReceiverPhone),
      total: phones.length
    });
  } catch (error) {
    next(error);
  }
});

codeReceiverRouter.post("/wait-code", async (req, res, next) => {
  try {
    const body = waitCodeSchema.parse(req.body);
    const phones = await findOwnedPhones(req.auth!.userId, body);
    const selectedPhones = phones.map(serializeCodeReceiverPhone);

    const existing = await findLatestCodeMessageForPhones(phones, {
      sinceMessageId: body.since_message_id,
      since: body.since,
      keyword: body.keyword
    });
    if (existing) {
      ok(res, {
        status: "matched",
        source: "stored_message",
        code: extractVerificationCode(existing.message.content),
        match: messagePhoneMatch(existing.message, existing.phone),
        phone: serializeCodeReceiverPhone(existing.phone),
        phones: selectedPhones,
        message: serializeMessage(existing.message)
      });
      return;
    }

    const listenStartedAt = new Date();
    const listenResults = await listenForSelectedPhones(phones, body.timeout_seconds, body.max_push_frames);
    const allSmsPushes = listenResults.flatMap((item) => item.smsPushes);
    const imported = listenResults.reduce((sum, item) => sum + item.imported, 0);

    const storedAfterListen = await findLatestCodeMessageForPhones(phones, {
      sinceMessageId: body.since_message_id,
      since: laterDate(body.since, listenStartedAt),
      keyword: body.keyword
    });
    if (storedAfterListen) {
      ok(res, {
        status: "matched",
        source: "direct_push",
        code: extractVerificationCode(storedAfterListen.message.content),
        match: messagePhoneMatch(storedAfterListen.message, storedAfterListen.phone),
        phone: serializeCodeReceiverPhone(storedAfterListen.phone),
        phones: selectedPhones,
        message: serializeMessage(storedAfterListen.message),
        diagnostics: {
          scanned_pushes: allSmsPushes.length,
          imported_messages: imported,
          listeners: listenResults.map(serializeListenDiagnostic)
        }
      });
      return;
    }

    const matchedPush = findMatchingPush(allSmsPushes, phones, body.keyword);
    if (matchedPush) {
      ok(res, {
        status: "matched",
        source: "direct_push_unstored",
        code: extractVerificationCode(matchedPush.push.content),
        match: pushPhoneMatch(matchedPush.push, matchedPush.phone),
        phone: serializeCodeReceiverPhone(matchedPush.phone),
        phones: selectedPhones,
        message: null,
        push: {
          from_number: matchedPush.push.fromNumber,
          to_number: matchedPush.push.toNumber ?? null,
          content: matchedPush.push.content
        },
        diagnostics: {
          scanned_pushes: allSmsPushes.length,
          imported_messages: imported,
          listeners: listenResults.map(serializeListenDiagnostic)
        }
      });
      return;
    }

    ok(res, {
      status: "timeout",
      source: "direct_push",
      code: null,
      phone: phones.length === 1 ? selectedPhones[0] : null,
      phones: selectedPhones,
      message: null,
      diagnostics: {
        scanned_pushes: allSmsPushes.length,
        imported_messages: imported,
        listeners: listenResults.map(serializeListenDiagnostic)
      }
    });
  } catch (error) {
    next(error);
  }
});

function serializeCodeReceiverPhone(phone: SelectedPhone) {
  return {
    ...serializePhoneNumber(phone),
    account: {
      id: phone.account.id,
      nickname: phone.account.nickname,
      app_variant: phone.account.appVariant,
      login_type: phone.account.loginType,
      email: phone.account.email,
      phone: phone.account.phone,
      status: phone.account.status
    }
  };
}

async function requireCodeReceiverAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (bearerToken) {
    try {
      req.auth = verifyAuthToken(bearerToken);
      next();
      return;
    } catch {
      // Fall through to code receiver tokens.
    }
  }

  const apiToken = getHeaderToken(req, "x-code-receiver-token") ?? getHeaderToken(req, "x-api-key") ?? bearerToken;
  if (!apiToken) {
    next(new AppError("Missing bearer token or code receiver token", 401, 401));
    return;
  }

  const tokenAuth = await resolveCodeReceiverToken(apiToken);
  if (!tokenAuth) {
    next(new AppError("Invalid or expired token", 401, 401));
    return;
  }

  req.auth = tokenAuth;
  next();
}

function getHeaderToken(req: Request, name: string) {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function resolveCodeReceiverToken(token: string) {
  const settings = await getSettingsMap();
  const tokens = parseCodeReceiverTokens(settings.code_receiver_api_tokens);
  const matched = tokens.find((item) => item.token === token);
  if (!matched) {
    return null;
  }

  const admin = matched.adminId
    ? await prisma.adminUser.findUnique({ where: { id: matched.adminId } })
    : await prisma.adminUser.findFirst({ orderBy: { id: "asc" } });
  if (!admin) {
    return null;
  }
  return { userId: admin.id, username: admin.username };
}

function parseCodeReceiverTokens(value: string | undefined) {
  return (value ?? "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^(\d+):(.+)$/);
      if (match) {
        return { adminId: Number(match[1]), token: match[2]!.trim() };
      }
      return { adminId: null, token: item };
    })
    .filter((item) => item.token.length > 0);
}

async function findOwnedPhones(adminId: number, body: z.infer<typeof waitCodeSchema>) {
  const selected: SelectedPhone[] = [];
  const seenIds = new Set<number>();

  const appendPhone = (phone: SelectedPhone) => {
    if (!seenIds.has(phone.id)) {
      selected.push(phone);
      seenIds.add(phone.id);
    }
  };

  if (body.phone_id) {
    appendPhone(await findOwnedPhone(adminId, { ...body, phone_id: body.phone_id, phone_number: undefined, phone_numbers: undefined }));
  }
  for (const phoneId of body.phone_ids ?? []) {
    appendPhone(await findOwnedPhone(adminId, { ...body, phone_id: phoneId, phone_number: undefined, phone_numbers: undefined }));
  }
  if (body.phone_number) {
    appendPhone(await findOwnedPhone(adminId, { ...body, phone_id: undefined, phone_ids: undefined, phone_number: body.phone_number }));
  }
  for (const phoneNumber of body.phone_numbers ?? []) {
    appendPhone(await findOwnedPhone(adminId, { ...body, phone_id: undefined, phone_ids: undefined, phone_number: phoneNumber, phone_numbers: undefined }));
  }

  if (selected.length === 0) {
    throw new AppError("No phone numbers selected", 400, 400);
  }
  return selected;
}

async function findOwnedPhone(
  adminId: number,
  body: z.infer<typeof waitCodeSchema>
): Promise<SelectedPhone> {
  if (body.phone_id) {
    const phone = await prisma.phoneNumber.findFirst({
      where: {
        id: body.phone_id,
        account: { adminId }
      },
      include: { account: true }
    });
    if (!phone) {
      throw new AppError("Phone number not found", 404, 404);
    }
    return phone;
  }

  const digits = normalizeDigits(body.phone_number);
  if (digits.length < 7) {
    throw new AppError("phone_number must contain at least 7 digits", 400, 400);
  }

  const candidates = await prisma.phoneNumber.findMany({
    where: {
      ...(body.account_id ? { accountId: body.account_id } : {}),
      account: { adminId }
    },
    include: { account: true }
  });
  const matches = candidates.filter((item) => phoneNumberMatches(item.phoneNumber, digits));
  if (matches.length === 0) {
    throw new AppError("Phone number not found", 404, 404);
  }
  if (matches.length > 1) {
    throw new AppError("Multiple matching phone numbers found; pass phone_id or account_id", 409, 409);
  }
  return matches[0]!;
}

async function findLatestCodeMessage(
  phone: SelectedPhone,
  options: {
    sinceMessageId?: number;
    since?: Date;
    keyword?: string;
  }
) {
  const where: Prisma.MessageWhereInput = {
    accountId: phone.accountId,
    direction: MessageDirection.incoming,
    ...(options.sinceMessageId ? { id: { gt: options.sinceMessageId } } : {}),
    ...(options.since ? { receivedAt: { gte: options.since } } : {}),
    ...(options.keyword ? { content: { contains: options.keyword } } : {})
  };
  const messages = await prisma.message.findMany({
    where,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: 100
  });
  const candidates = messages.filter((message) => messageMatchesSelectedPhone(message, phone) && messageContainsCode(message.content, options.keyword));
  return candidates.find((message) => messagePhoneMatch(message, phone) === "confirmed") ?? candidates[0] ?? null;
}

async function findLatestCodeMessageForPhones(
  phones: SelectedPhone[],
  options: {
    sinceMessageId?: number;
    since?: Date;
    keyword?: string;
  }
) {
  const matches = (
    await Promise.all(
      phones.map(async (phone) => {
        const message = await findLatestCodeMessage(phone, options);
        return message ? { phone, message } : null;
      })
    )
  ).filter((item): item is { phone: SelectedPhone; message: NonNullable<Awaited<ReturnType<typeof findLatestCodeMessage>>> } =>
    Boolean(item)
  );

  return (
    matches.sort((left, right) => {
      const timeDiff = right.message.receivedAt.getTime() - left.message.receivedAt.getTime();
      return timeDiff !== 0 ? timeDiff : right.message.id - left.message.id;
    })[0] ?? null
  );
}

async function listenForSelectedPhones(phones: SelectedPhone[], listenSeconds: number, maxPushFrames: number) {
  const accountPhones = new Map<number, SelectedPhone>();
  for (const phone of phones) {
    accountPhones.set(phone.accountId, phone);
  }

  return Promise.all(
    [...accountPhones.values()].map(async (phone) => {
      const token = decryptText(phone.account.dtToken);
      if (!phone.account.dtUserId || !token) {
        throw new AppError(`Account ${phone.accountId} has no usable direct session token`, 400, 400);
      }

      const result = await listenDirectSessionPushes({
        account: {
          dtUserId: phone.account.dtUserId,
          token,
          deviceId: phone.account.dtDeviceId,
          email: phone.account.email,
          phone: phone.account.phone
        },
        listenSeconds,
        maxPushFrames
      });
      const smsPushes = result.pushes.map((item: DirectProbePushResult) => item.sms).filter((item): item is ParsedSmsPush => Boolean(item));
      const imported = smsPushes.length > 0 ? await storeParsedSmsPushes(phone.accountId, smsPushes) : 0;
      return {
        accountId: phone.accountId,
        accountNickname: phone.account.nickname,
        smsPushes,
        imported,
        host: result.host,
        preempted: result.preempted ?? false
      };
    })
  );
}

function serializeListenDiagnostic(result: Awaited<ReturnType<typeof listenForSelectedPhones>>[number]) {
  return {
    account_id: result.accountId,
    account_nickname: result.accountNickname,
    scanned_pushes: result.smsPushes.length,
    imported_messages: result.imported,
    host: result.host,
    preempted: result.preempted
  };
}

function findMatchingPush(pushes: ParsedSmsPush[], phones: SelectedPhone[], keyword?: string) {
  const matches: Array<{ push: ParsedSmsPush; phone: SelectedPhone; match: PhoneMatch }> = [];
  for (const push of pushes) {
    if (!pushContainsCode(push, keyword)) {
      continue;
    }
    for (const phone of phones) {
      const match = pushPhoneMatch(push, phone);
      if (match !== "mismatch") {
        matches.push({ push, phone, match });
      }
    }
  }
  return matches.find((item) => item.match === "confirmed") ?? matches[0] ?? null;
}

function messageMatchesSelectedPhone(message: { toNumber: string | null }, phone: SelectedPhone) {
  return messagePhoneMatch(message, phone) !== "mismatch";
}

function messagePhoneMatch(message: { toNumber: string | null }, phone: SelectedPhone): PhoneMatch {
  const target = normalizeDigits(message.toNumber);
  if (!target) {
    return "unverified";
  }
  return phoneNumberMatches(phone.phoneNumber, target) ? "confirmed" : "mismatch";
}

function pushMatchesSelectedPhone(push: ParsedSmsPush, phone: SelectedPhone) {
  return pushPhoneMatch(push, phone) !== "mismatch";
}

function pushPhoneMatch(push: ParsedSmsPush, phone: SelectedPhone): PhoneMatch {
  const target = normalizeDigits(push.toNumber);
  if (!target) {
    return "unverified";
  }
  return phoneNumberMatches(phone.phoneNumber, target) ? "confirmed" : "mismatch";
}

function pushContainsCode(push: ParsedSmsPush, keyword?: string) {
  return messageContainsCode(push.content, keyword);
}

function messageContainsCode(content: string, keyword?: string) {
  return (!keyword || content.includes(keyword)) && Boolean(extractVerificationCode(content));
}

function extractVerificationCode(content: string) {
  return content.match(/\b\d{4,8}\b/)?.[0] ?? null;
}

function normalizeDigits(value: string | null | undefined) {
  return value?.replace(/\D/g, "") ?? "";
}

function phoneNumberMatches(phoneNumber: string, targetDigits: string) {
  const phoneDigits = normalizeDigits(phoneNumber);
  return Boolean(phoneDigits && targetDigits && (phoneDigits === targetDigits || phoneDigits.endsWith(targetDigits) || targetDigits.endsWith(phoneDigits)));
}

function laterDate(left?: Date, right?: Date) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
}
