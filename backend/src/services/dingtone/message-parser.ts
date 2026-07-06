import zlib from "node:zlib";
import { TextDecoder } from "node:util";

export type ParsedSmsPush = {
  msgType: number;
  fromNumber: string | null;
  toNumber?: string | null;
  content: string;
  rawInfo?: string;
  rawK3?: string;
  k5Flag?: number;
};

export function parseSmsPush(payload: Buffer): ParsedSmsPush | null {
  return parseCompressedSmsPush(payload) ?? parsePlaintextSmsPush(payload);
}

function parseCompressedSmsPush(payload: Buffer): ParsedSmsPush | null {
  const decompressedBuffer = inflateFirstJsonPayload(payload);
  if (!decompressedBuffer) {
    return null;
  }
  const decompressed = decompressedBuffer.toString("utf8");
  const jsonEnd = decompressed.indexOf("}") + 1;
  if (jsonEnd <= 0) {
    return null;
  }

  const json = JSON.parse(decompressed.slice(0, jsonEnd)) as {
    info?: string;
    k1?: number;
    k2?: string;
    k3?: string;
    k5?: number;
  };
  const jsonByteEnd = Buffer.byteLength(decompressed.slice(0, jsonEnd), "utf8");
  const contentBytes = decompressedBuffer.subarray(jsonByteEnd);
  const content = decodeSmsContent(contentBytes, decompressed.slice(jsonEnd));
  if (!content.trim()) {
    return null;
  }

  return {
    msgType: json.k1 ?? 0,
    fromNumber: json.k2 ?? null,
    toNumber: extractTargetNumberFromPushMetadata(json, json.k2 ?? null),
    content,
    rawInfo: json.info,
    rawK3: json.k3,
    k5Flag: json.k5
  };
}

function parsePlaintextSmsPush(payload: Buffer): ParsedSmsPush | null {
  const jsonRange = findJsonObjectRange(payload);
  if (!jsonRange) {
    return null;
  }

  const json = JSON.parse(payload.subarray(jsonRange.start, jsonRange.end).toString("utf8")) as {
    info?: string;
    k1?: number;
    k2?: string;
    k3?: string;
    k5?: number;
  };
  const contentBytes = extractPlaintextContentBytes(payload, jsonRange.end);
  if (!contentBytes) {
    return null;
  }
  const content = decodeSmsContent(contentBytes, contentBytes.toString("utf8"));
  if (!content.trim()) {
    return null;
  }
  if (!looksLikeSmsMetadata(json, content)) {
    return null;
  }

  return {
    msgType: json.k1 ?? 0,
    fromNumber: json.k2 ?? null,
    toNumber: extractTargetNumberFromPushMetadata(json, json.k2 ?? null),
    content,
    rawInfo: json.info,
    rawK3: json.k3,
    k5Flag: json.k5
  };
}

function extractTargetNumberFromPushMetadata(json: { info?: string; k3?: string }, fromNumber: string | null) {
  const senderDigits = normalizePhoneDigits(fromNumber);
  const candidates = [json.info, json.k3]
    .flatMap((value) => extractDigitRunsFromBase64(value))
    .filter((value) => value.length >= 7)
    .filter((value) => !samePhoneDigits(value, senderDigits));
  const best = candidates.sort((left, right) => right.length - left.length || left.localeCompare(right))[0];
  return best ?? null;
}

function samePhoneDigits(candidate: string, normalizedSender: string) {
  const digits = normalizePhoneDigits(candidate);
  if (!digits || !normalizedSender) {
    return false;
  }
  if (digits === normalizedSender) {
    return true;
  }
  return stripUsCountryCode(digits) === stripUsCountryCode(normalizedSender);
}

function stripUsCountryCode(value: string) {
  return value.length === 11 && value.startsWith("1") ? value.slice(1) : value;
}

function normalizePhoneDigits(value: string | null | undefined) {
  return value?.replace(/\D/g, "") ?? "";
}

function extractDigitRunsFromBase64(value?: string) {
  if (!value?.trim()) {
    return [];
  }
  try {
    const decoded = Buffer.from(value, "base64").toString("latin1");
    return Array.from(decoded.matchAll(/\d{3,15}/g), (match) => match[0] ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

function findJsonObjectRange(payload: Buffer) {
  const text = payload.toString("latin1");
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            JSON.parse(payload.subarray(start, index + 1).toString("utf8"));
            return { start, end: index + 1 };
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function looksLikeSmsMetadata(json: { k1?: number; k2?: string; info?: string; k3?: string }, content: string) {
  const hasSender = typeof json.k2 === "string" && json.k2.trim().length > 0;
  const hasMessageIdentity = typeof json.info === "string" || typeof json.k3 === "string";
  const knownSmsType =
    (json.k1 === 561 || json.k1 === 0x231) &&
    hasSender &&
    hasMessageIdentity;
  return knownSmsType || (hasSender && hasMessageIdentity && looksLikeSmsText(content));
}

function looksLikeSmsText(content: string) {
  const value = content.trim();
  if (value.length < 3 || value.length > 2000) {
    return false;
  }
  if (/\b(code|verification|verify|otp|pin|password|login)\b/i.test(value)) {
    return true;
  }
  if (/验证码|驗證碼|校验码|動態碼|动态码|登录|登入/.test(value)) {
    return true;
  }
  return /[A-Za-z0-9\u4e00-\u9fff]/.test(value) && !/^\{.*\}$/.test(value);
}

function extractPlaintextContentBytes(payload: Buffer, afterJsonOffset: number) {
  let cursor = afterJsonOffset;
  while (cursor < payload.length && (payload[cursor] === 0x00 || payload[cursor] === 0x0a || payload[cursor] === 0x0d || payload[cursor] === 0x20)) {
    cursor += 1;
  }

  const lengthPrefixed = readLengthPrefixedText(payload, cursor);
  if (lengthPrefixed) {
    return lengthPrefixed;
  }

  const start = findLikelyTextStart(payload, cursor);
  if (start < 0) {
    return null;
  }
  let end = start;
  while (end < payload.length && payload[end] !== 0x00) {
    end += 1;
  }
  return payload.subarray(start, end);
}

function readLengthPrefixedText(payload: Buffer, cursor: number) {
  if (isLikelyTextLeadByte(payload[cursor])) {
    return null;
  }
  for (const width of [1, 2, 4]) {
    if (cursor + width >= payload.length) {
      continue;
    }
    const length =
      width === 1 ? payload[cursor] : width === 2 ? payload.readUInt16BE(cursor) : payload.readUInt32BE(cursor);
    if (!length || cursor + width + length > payload.length) {
      continue;
    }
    const candidate = payload.subarray(cursor + width, cursor + width + length);
    const decoded = decodeSmsContent(candidate, candidate.toString("utf8"));
    if (scoreDecodedText(decoded) > 8 && /[A-Za-z0-9\u4e00-\u9fff]/.test(decoded)) {
      return candidate;
    }
  }
  return null;
}

function isLikelyTextLeadByte(byte: number | undefined) {
  return byte !== undefined && (byte === 0x5b || byte === 0x28 || (byte >= 0x30 && byte <= 0x7a) || byte >= 0xe0);
}
function findLikelyTextStart(payload: Buffer, cursor: number) {
  for (let index = cursor; index < payload.length; index += 1) {
    const byte = payload[index];
    if (isLikelyTextLeadByte(byte)) {
      return index;
    }
  }
  return -1;
}

function inflateFirstJsonPayload(payload: Buffer) {
  for (let index = 0; index < payload.length - 1; index += 1) {
    if (payload[index] !== 0x78 || ![0x01, 0x9c, 0xda].includes(payload[index + 1] ?? -1)) {
      continue;
    }
    try {
      const inflated = zlib.inflateSync(payload.subarray(index));
      if (inflated.includes(0x7b) && inflated.includes(0x7d)) {
        return inflated;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function decodeSmsContent(bytes: Buffer, utf8Fallback: string) {
  const utf8 = utf8Fallback.trim();
  if (!utf8.includes("\uFFFD")) {
    return normalizeSmsContent(utf8);
  }

  try {
    const gb18030 = new TextDecoder("gb18030").decode(bytes).trim();
    if (scoreDecodedText(gb18030) > scoreDecodedText(utf8)) {
      return normalizeSmsContent(gb18030);
    }
  } catch {
    // Keep the original UTF-8 decode below.
  }
  return normalizeSmsContent(utf8);
}

function normalizeSmsContent(value: string) {
  return stripPushMetadata(value.replace(/\0+$/g, "")).trim();
}

function stripPushMetadata(value: string) {
  const patterns = [
    /[\u0000-\u001f\u007f-\u009f]+\s*(?:dtId|who|devfilter|orgsrc|statusOff)\b/i,
    /\s+(?:dtId|who|devfilter|orgsrc)\b/i,
    /\s+devfilter\d*\s*\{"only":"And\.[^"\s]+"\}/i,
    /\s+\{"statusOff":"\d+"\}/i
  ];
  let end = value.length;
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match?.index !== undefined && match.index >= 0) {
      end = Math.min(end, match.index);
    }
  }
  return value.slice(0, end);
}

function scoreDecodedText(value: string) {
  const replacementPenalty = (value.match(/\uFFFD/g) ?? []).length * -10;
  const chineseScore = (value.match(/[\u4e00-\u9fff]/g) ?? []).length * 3;
  const printableScore = (value.match(/[ -~]/g) ?? []).length;
  return replacementPenalty + chineseScore + printableScore;
}
