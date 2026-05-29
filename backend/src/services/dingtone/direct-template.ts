import { AppError } from "../../utils/errors.js";

export type DirectTemplateParams = Record<string, string | number | boolean | undefined>;

export type DirectActionTemplate = {
  name: string;
  hex: string;
  params?: DirectTemplateParams;
};

export const DIRECT_TEMPLATE_SETTING_KEYS = [
  "dt_direct_template_request_phone",
  "dt_direct_template_purchase_phone",
  "dt_direct_template_renew_phone",
  "dt_direct_template_cancel_phone",
  "dt_direct_template_pause_phone",
  "dt_direct_template_resume_phone",
  "dt_direct_template_phone_setting",
  "dt_direct_template_offline_messages"
] as const;

export type DirectTemplateSettingKey = (typeof DIRECT_TEMPLATE_SETTING_KEYS)[number];

export const DIRECT_TEMPLATE_SETTING_KEY_SET = new Set<string>(DIRECT_TEMPLATE_SETTING_KEYS);

export function parseDirectActionTemplate(key: string, rawValue: string | undefined): DirectActionTemplate | null {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return null;
  }

  if (!trimmed.startsWith("{")) {
    return {
      name: key,
      hex: validateDirectTemplateHex(key, trimmed)
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AppError(`${key} is not valid JSON`, 400, 400);
  }
  if (!isRecord(parsed)) {
    throw new AppError(`${key} must be a JSON object`, 400, 400);
  }

  const hex = pickString(parsed, ["hex", "templateHex", "frameHex", "template"]);
  if (!hex) {
    throw new AppError(`${key} is missing hex/templateHex`, 400, 400);
  }

  return {
    name: pickString(parsed, ["name", "label"]) ?? key,
    hex: validateDirectTemplateHex(key, hex),
    params: parseDirectTemplateParams(parsed.params)
  };
}

export function validateDirectTemplateSetting(key: string, rawValue: string | undefined) {
  if (!DIRECT_TEMPLATE_SETTING_KEY_SET.has(key) || !rawValue?.trim()) {
    return;
  }
  parseDirectActionTemplate(key, rawValue);
}

export function normalizeDirectTemplateHex(value: string) {
  const pairs = value.match(/[0-9a-fA-F]{2}/g);
  return pairs ? pairs.join("").toLowerCase() : "";
}

export function validateDirectTemplateHex(key: string, value: string) {
  const hex = normalizeDirectTemplateHex(value);
  if (!hex.startsWith("0107") || hex.length < 44 || hex.length % 2 !== 0) {
    throw new AppError(`${key} must contain a complete 0107 direct frame`, 400, 400);
  }
  const declared = Number.parseInt(hex.slice(4, 12), 16);
  if (!Number.isFinite(declared) || declared < 22) {
    throw new AppError(`${key} has an invalid direct frame length`, 400, 400);
  }
  if (declared * 2 > hex.length) {
    throw new AppError(`${key} direct frame is truncated: declared ${declared} bytes but only ${hex.length / 2} bytes were provided`, 400, 400);
  }
  return hex.slice(0, declared * 2);
}

export function parseDirectTemplateParams(value: unknown): DirectTemplateParams | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const params: DirectTemplateParams = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === undefined) {
      params[key] = item;
    }
  }
  return params;
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
