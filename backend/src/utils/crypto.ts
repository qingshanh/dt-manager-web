import crypto from "node:crypto";
import { config } from "../config.js";

const key = crypto.createHash("sha256").update(config.ENCRYPTION_KEY).digest();
const legacyKeys = config.LEGACY_ENCRYPTION_KEYS.split(",")
  .map((value) => value.trim())
  .filter((value) => value && value !== config.ENCRYPTION_KEY)
  .map((value) => crypto.createHash("sha256").update(value).digest());

export function hashPassword(password: string) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function encryptText(plainText: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptText(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  for (const candidateKey of [key, ...legacyKeys]) {
    try {
      return decryptTextWithKey(value, candidateKey);
    } catch {
      // Try the next configured key. This keeps old database rows usable after .env migration.
    }
  }
  return decryptTextWithKey(value, key);
}

function decryptTextWithKey(value: string, candidateKey: Buffer) {
  const payload = Buffer.from(value, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", candidateKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function createDeviceId() {
  return `And.${crypto.randomBytes(16).toString("hex")}.dttalk`;
}

export function createTrackCode() {
  const base = BigInt("40051185300000000");
  const randomTail = BigInt(Math.floor(100000 + Math.random() * 900000));
  return (base + randomTail).toString();
}

let lastActivationTrackTimestamp = 0n;

export function createActivationTrackCode() {
  const now = BigInt(Date.now());
  const timestamp = now > lastActivationTrackTimestamp ? now : lastActivationTrackTimestamp + 1n;
  lastActivationTrackTimestamp = timestamp;
  return ((timestamp << 12n) | 3n).toString();
}

export function isActivationTrackCode(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized || !/^\d{16,19}$/.test(normalized)) {
    return false;
  }
  const numeric = BigInt(normalized);
  return numeric > 0n && numeric < 2n ** 63n && numeric % 4096n === 3n;
}

export function advanceActivationTrackCode(value: string, steps = 1) {
  if (!isActivationTrackCode(value) || !Number.isSafeInteger(steps) || steps < 0) {
    throw new Error("Invalid activation TrackCode sequence");
  }
  const next = BigInt(value) + BigInt(steps) * 4096n;
  if (next >= 2n ** 63n) {
    throw new Error("Activation TrackCode sequence overflow");
  }
  return next.toString();
}

export function createMockToken(seed: string) {
  return crypto.createHash("md5").update(`${seed}:${Date.now()}`).digest("hex");
}
