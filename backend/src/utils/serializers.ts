import type { AccountSnapshot, Message, PhoneNumber, Setting } from "@prisma/client";
import iconv from "iconv-lite";

const DEFAULT_CREDIT_EXCHANGE_RATIO = 0.02;

export function serializeSnapshot(snapshot: AccountSnapshot | null) {
  if (!snapshot) {
    return null;
  }
  return {
    id: snapshot.id,
    account_id: snapshot.accountId,
    dt_dingtone_id: repairUtf8Mojibake(snapshot.dtDingtoneId),
    full_name: repairUtf8Mojibake(snapshot.fullName),
    avatar_url: repairUtf8Mojibake(snapshot.avatarUrl),
    gender: snapshot.gender,
    birthday: repairUtf8Mojibake(snapshot.birthday),
    email: repairUtf8Mojibake(snapshot.email),
    phone: repairUtf8Mojibake(snapshot.phone),
    about_me: repairUtf8Mojibake(snapshot.aboutMe),
    feeling: repairUtf8Mojibake(snapshot.feeling),
    company: repairUtf8Mojibake(snapshot.company),
    school: repairUtf8Mojibake(snapshot.school),
    country: repairUtf8Mojibake(snapshot.country),
    state: repairUtf8Mojibake(snapshot.state),
    city: repairUtf8Mojibake(snapshot.city),
    primary_balance: normalizeSnapshotPrimaryBalance(snapshot.primaryBalance, snapshot.rawJson),
    user_grade: snapshot.userGrade,
    valid_point: normalizeSnapshotMemberPoint(snapshot.validPoint) ?? normalizeSnapshotMemberPoint(snapshot.progressPoint),
    progress_point: normalizeSnapshotMemberPoint(snapshot.progressPoint),
    membership_type: repairUtf8Mojibake(snapshot.membershipType),
    membership_expire_at: snapshot.membershipExpireAt,
    profile_ver_code: repairUtf8Mojibake(snapshot.profileVerCode),
    raw_json: snapshot.rawJson,
    updated_at: snapshot.updatedAt
  };
}

function normalizeSnapshotPrimaryBalance(value: number | null, rawJson: string | null) {
  const raw = parseJsonRecord(rawJson);
  const publicPoint = isRecord(raw?.publicPoint) ? raw.publicPoint : null;
  const rawBalance = isRecord(raw?.balance) ? raw.balance : null;
  const publicDisplay = pickNumber(publicPoint, ["balanceDisplay", "balance_display"]);
  const rawPrimary = pickNumber(rawBalance, [
    "primaryBalance",
    "primary_balance",
    "balance",
    "balanceAmount",
    "balance_amount",
    "availableBalance",
    "available_balance",
    "walletBalance",
    "wallet_balance",
    "coinBalance",
    "coin_balance",
    "creditBalance",
    "credit_balance"
  ]);
  const ratio = pickNumber(rawBalance, ["creditExchangeRatio"]) ?? DEFAULT_CREDIT_EXCHANGE_RATIO;
  if (publicDisplay !== null && publicDisplay > 0) {
    return normalizeCreditBalance(publicDisplay, ratio);
  }

  if (rawPrimary !== null && rawPrimary > 0) {
    return normalizeCreditBalance(rawPrimary, ratio);
  }

  if (value !== null && value > 0 && value < 1000) {
    return roundTo(value / DEFAULT_CREDIT_EXCHANGE_RATIO, 2);
  }
  return value !== null && value > 0 ? value : null;
}

function normalizeCreditBalance(value: number, ratio: number) {
  if (value > 0 && value < 1000 && ratio > 0) {
    return roundTo(value / ratio, 2);
  }
  return value;
}

function normalizeSnapshotMemberPoint(value: number | null) {
  return value !== null && value > 0 && value <= 10_000 ? value : null;
}

export function serializePhoneNumber(phone: PhoneNumber) {
  const validPeriodDays = derivePhoneValidPeriodDays(phone.gainTime, phone.expiredTime, phone.validPeriodDays);
  const raw = parseJsonRecord(phone.rawJson);
  return {
    id: phone.id,
    account_id: phone.accountId,
    phone_number: repairUtf8Mojibake(phone.phoneNumber),
    country_code: phone.countryCode,
    area_code: pickNumber(raw, ["areaCode", "area_code"]),
    provider_id: phone.providerId,
    display_name: repairUtf8Mojibake(phone.displayName),
    status: phone.status,
    purchase_type: phone.purchaseType,
    pay_type: phone.payType,
    valid_period_days: validPeriodDays,
    gain_time: repairUtf8Mojibake(phone.gainTime),
    expired_time: repairUtf8Mojibake(phone.expiredTime),
    auto_renew: phone.autoRenew,
    is_primary: phone.isPrimary,
    is_good_number: phone.isGoodNumber,
    portout_info: repairUtf8Mojibake(phone.portoutInfo),
    raw_json: phone.rawJson,
    created_at: phone.createdAt,
    updated_at: phone.updatedAt
  };
}

function derivePhoneValidPeriodDays(gainTime: string | null, expiredTime: string | null, fallback: number | null) {
  const gain = parseEpoch(gainTime);
  const expire = parseEpoch(expiredTime);
  if (gain && expire && expire > gain) {
    return Math.round((expire - gain) / 86_400_000);
  }
  return fallback;
}

function parseEpoch(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function parseJsonRecord(value: string | null) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pickNumber(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundTo(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function serializeMessage(message: Message) {
  const fromNumber = repairUtf8Mojibake(message.fromNumber);
  const toNumber = repairUtf8Mojibake(message.toNumber);
  const content = cleanSerializedMessageContent(repairUtf8Mojibake(message.content) ?? "");
  const rawInfo = repairUtf8Mojibake(message.rawInfo);
  const rawK3 = repairUtf8Mojibake(message.rawK3);
  return {
    id: message.id,
    account_id: message.accountId,
    direction: message.direction,
    msg_type: isTeamOrSystemSerializedMessage(fromNumber, content, rawInfo) ? "system" : message.msgType,
    from_number: fromNumber,
    to_number: toNumber,
    content,
    raw_info: rawInfo,
    raw_k3: rawK3,
    k5_flag: message.k5Flag,
    is_read: message.isRead,
    telegram_sent: message.telegramSent,
    telegram_msg_id: repairUtf8Mojibake(message.telegramMsgId),
    received_at: message.receivedAt,
    created_at: message.createdAt
  };
}

export function serializeSetting(setting: Setting) {
  return {
    id: setting.id,
    key: setting.key,
    value: setting.value,
    description: setting.description,
    updated_at: setting.updatedAt
  };
}

function cleanSerializedMessageContent(value: string) {
  return value.replace(/^[A-Za-z](?=(?:\?|<|\[硅基流动\]|\[SiliconFlow\]|\[Dingtone\]|\[TalkU\]))/, "");
}
export function repairUtf8Mojibake(value: string | null) {
  if (!value) {
    return value;
  }

  let best = repairKnownReplacementText(decodeNumericHtmlEntities(value));
  const gbkDecoded = decodeGbkUtf8Mojibake(best);
  if (gbkDecoded) {
    best = repairKnownReplacementText(decodeNumericHtmlEntities(gbkDecoded));
  }
  let bestScore = mojibakeScore(best);
  if (best !== value && containsHanText(best)) {
    return best;
  }

  for (let i = 0; i < 4; i += 1) {
    if (containsHanText(best) || !hasMojibakeBytes(best)) {
      return best;
    }
    try {
      const decoded = decodeMojibakeLayer(best);
      if (!decoded) {
        return best;
      }
      const candidate = repairKnownReplacementText(decodeNumericHtmlEntities(decoded));
      if (!candidate || candidate === best || candidate.includes("\uFFFD")) {
        return best;
      }
      const candidateScore = mojibakeScore(candidate);
      if (containsHanText(candidate) || candidateScore < bestScore) {
        best = candidate;
        bestScore = candidateScore;
        continue;
      }
      return best;
    } catch {
      return best;
    }
  }

  return best;
}

function decodeGbkUtf8Mojibake(value: string) {
  const sourceScore = gbkMojibakeHintScore(value);
  if (sourceScore < 2) {
    return null;
  }
  try {
    const decoded = iconv.decode(iconv.encode(value, "gb18030"), "utf8");
    if (!decoded || decoded === value || decoded.includes("\uFFFD") || !containsHanText(decoded)) {
      return null;
    }
    return gbkMojibakeHintScore(decoded) < sourceScore ? decoded : null;
  } catch {
    return null;
  }
}

function gbkMojibakeHintScore(value: string) {
  return (value.match(/[璇撮亾鍥㈤槦绯荤粺娑堟伅纭呭熀娴佸姩鎮ㄧ殑鍙风爜鍗冲皢鍒版湡绉垎]/g) ?? []).length;
}

function repairKnownReplacementText(value: string) {
  return value
    .replace(/\u7ead\u546d\u7180\u5a34\u4f78\u59e9/g, "\u7845\u57fa\u6d41\u52a8")
    .replace(/\[\uFFFD{7}\](Verification code is:)/g, "[硅基流动]$1")
    .replace(/^\uFFFD{4}\s+OpenAI\s+\uFFFD{2}\u05A4\uFFFD{6}:(\d{4,8})$/g, "您的 OpenAI 验证代码是:$1");
}

function decodeNumericHtmlEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePointToString(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => safeCodePointToString(Number.parseInt(code, 16)));
}

function containsHanText(value: string) {
  return /[\u4e00-\u9fff]/.test(value);
}

function hasMojibakeBytes(value: string) {
  return /[\u0080-\u00ff]/.test(value) || Array.from(value).some((char) => WINDOWS_1252_BYTE_BY_CHAR.has(char));
}

function mojibakeScore(value: string) {
  let score = 0;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 0x80 && code <= 0xff) {
      score += 2;
    }
    if (code >= 0x80 && code <= 0x9f) {
      score += 3;
    }
    if (char === "\uFFFD") {
      score += 10;
    }
  }
  return score;
}

const WINDOWS_1252_BYTE_BY_CHAR = new Map<string, number>([
  ["\u20ac", 0x80],
  ["\u201a", 0x82],
  ["\u0192", 0x83],
  ["\u201e", 0x84],
  ["\u2026", 0x85],
  ["\u2020", 0x86],
  ["\u2021", 0x87],
  ["\u02c6", 0x88],
  ["\u2030", 0x89],
  ["\u0160", 0x8a],
  ["\u2039", 0x8b],
  ["\u0152", 0x8c],
  ["\u017d", 0x8e],
  ["\u2018", 0x91],
  ["\u2019", 0x92],
  ["\u201c", 0x93],
  ["\u201d", 0x94],
  ["\u2022", 0x95],
  ["\u2013", 0x96],
  ["\u2014", 0x97],
  ["\u02dc", 0x98],
  ["\u2122", 0x99],
  ["\u0161", 0x9a],
  ["\u203a", 0x9b],
  ["\u0153", 0x9c],
  ["\u017e", 0x9e],
  ["\u0178", 0x9f]
]);

function decodeMojibakeLayer(value: string) {
  const bytes: number[] = [];
  for (const char of value) {
    const mapped = WINDOWS_1252_BYTE_BY_CHAR.get(char);
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }
    const code = char.charCodeAt(0);
    if (code <= 0xff) {
      bytes.push(code);
      continue;
    }
    return null;
  }
  return Buffer.from(bytes).toString("utf8");
}

function safeCodePointToString(codePoint: number) {
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
    return "";
  }
  return String.fromCodePoint(codePoint);
}

function isTeamOrSystemSerializedMessage(fromNumber: string | null, content: string, rawInfo: string | null) {
  const text = `${fromNumber ?? ""}\n${content}\n${rawInfo ?? ""}`;
  if (containsTeamOrSystemText(text)) {
    return true;
  }
  if (/叮咚团队|说道团队|系統消息|系统消息/i.test(text)) {
    return true;
  }
  return /^(dingtone|talku|talkyou|dingdong|dingtone team|talku team|dingdong team|team)$/i.test((fromNumber ?? "").trim()) ||
    /dingtone team|talku team|dingdong team|叮咚团队|说道团队|系统消息|TalkU number|free calling and messaging/i.test(text);
}

function containsTeamOrSystemText(value: string) {
  return /dingtone team|talku team|talkyou team|dingdong team|TalkU number|free calling and messaging|\u53ee\u549a\u56e2\u961f|\u8bf4\u9053\u56e2\u961f|\u7cfb\u7d71\u6d88\u606f|\u7cfb\u7edf\u6d88\u606f/i.test(
    value
  );
}
