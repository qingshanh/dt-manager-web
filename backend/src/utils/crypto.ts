import crypto from "node:crypto";
import { config } from "../config.js";

const key = crypto.createHash("sha256").update(config.ENCRYPTION_KEY).digest();

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
  const payload = Buffer.from(value, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function createDeviceId() {
  return `Android.${crypto.randomBytes(16).toString("hex")}.dttalk`;
}

export function createTrackCode() {
  const base = BigInt("40051185300000000");
  const randomTail = BigInt(Math.floor(100000 + Math.random() * 900000));
  return (base + randomTail).toString();
}

export function createMockToken(seed: string) {
  return crypto.createHash("md5").update(`${seed}:${Date.now()}`).digest("hex");
}
