import type { AccountSnapshot, Message, PhoneNumber, Setting } from "@prisma/client";

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
    primary_balance: snapshot.primaryBalance,
    user_grade: snapshot.userGrade,
    valid_point: snapshot.validPoint,
    progress_point: snapshot.progressPoint,
    membership_type: repairUtf8Mojibake(snapshot.membershipType),
    membership_expire_at: snapshot.membershipExpireAt,
    profile_ver_code: repairUtf8Mojibake(snapshot.profileVerCode),
    raw_json: snapshot.rawJson,
    updated_at: snapshot.updatedAt
  };
}

export function serializePhoneNumber(phone: PhoneNumber) {
  const validPeriodDays = derivePhoneValidPeriodDays(phone.gainTime, phone.expiredTime, phone.validPeriodDays);
  return {
    id: phone.id,
    account_id: phone.accountId,
    phone_number: repairUtf8Mojibake(phone.phoneNumber),
    country_code: phone.countryCode,
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

export function serializeMessage(message: Message) {
  const fromNumber = repairUtf8Mojibake(message.fromNumber);
  const toNumber = repairUtf8Mojibake(message.toNumber);
  const content = repairUtf8Mojibake(message.content) ?? "";
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

export function repairUtf8Mojibake(value: string | null) {
  if (!value) {
    return value;
  }

  const known = repairKnownReplacementText(decodeNumericHtmlEntities(value));
  if (known !== value) {
    return known;
  }
  if (/[\u4e00-\u9fff]/.test(value)) {
    return value;
  }
  if (!/[\u00c0-\u00ff]/.test(value)) {
    return value;
  }

  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (!repaired || repaired === value || repaired.includes("\uFFFD")) {
      return value;
    }
    return repairKnownReplacementText(decodeNumericHtmlEntities(repaired));
  } catch {
    return value;
  }
}

function repairKnownReplacementText(value: string) {
  return value
    .replace(/\[\uFFFD{7}\](Verification code is:)/g, "[硅基流动]$1")
    .replace(/^\uFFFD{4}\s+OpenAI\s+\uFFFD{2}\u05A4\uFFFD{6}:(\d{4,8})$/g, "您的 OpenAI 验证代码是:$1");
}

function decodeNumericHtmlEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => safeCodePointToString(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => safeCodePointToString(Number.parseInt(code, 16)));
}

function safeCodePointToString(codePoint: number) {
  if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
    return "";
  }
  return String.fromCodePoint(codePoint);
}

function isTeamOrSystemSerializedMessage(fromNumber: string | null, content: string, rawInfo: string | null) {
  const text = `${fromNumber ?? ""}\n${content}\n${rawInfo ?? ""}`;
  return /^(dingtone|talku|talkyou|dingdong|dingtone team|talku team|dingdong team|team)$/i.test((fromNumber ?? "").trim()) ||
    /dingtone team|talku team|dingdong team|叮咚团队|说道团队|系统消息|TalkU number|free calling and messaging/i.test(text);
}
