import { config } from "../../config.js";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { getSettingsMap } from "../settings.service.js";
import type {
  DingtoneGateway,
  DingtoneLoginInput,
  DingtoneLoginResult,
  DingtonePhonePurchaseCandidate,
  DingtonePhonePurchasePreview,
  DingtoneSessionExportInput,
  DingtoneSessionExport,
  DingtonePhoneNumber,
  DingtoneSnapshot,
  VerificationRequestResult
} from "./types.js";

type JsonRecord = Record<string, unknown>;
type AppVariant = "dingtone" | "dingdong";
type BridgeAction =
  | "send_verification_code"
  | "login"
  | "export_session"
  | "refresh_snapshot"
  | "list_phone_numbers"
  | "request_phone_number_via_activity"
  | "request_phone_number"
  | "purchase_phone_number"
  | "renew_phone_number"
  | "update_phone_number_label"
  | "cancel_phone_number"
  | "pause_phone_number"
  | "resume_phone_number";

type BridgeRuntimeConfig = {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  proxyUrl: string;
  serverIp: string;
  serverPort: number;
  backupIp: string;
};

const BRIDGE_EXECUTE_PATHS = [
  "/api/v1/dingtone/execute",
  "/api/dingtone/execute",
  "/dingtone/execute",
  "/execute"
];

class BridgeEndpointNotFoundError extends Error {}

export class RealDingtoneGateway implements DingtoneGateway {
  async sendVerificationCode(input: DingtoneLoginInput): Promise<VerificationRequestResult> {
    const payload = await this.callBridge("send_verification_code", { input });
    const body = toRecord(unwrapPayload(payload));
    return {
      message: pickString(body, ["message", "detail"]) ?? "Verification code request accepted",
      mock: pickBoolean(body, ["mock"]),
      verificationCode: pickString(body, ["verificationCode", "verification_code"]),
      verificationFlow: "register"
    };
  }

  async login(input: DingtoneLoginInput): Promise<DingtoneLoginResult> {
    const payload = await this.callBridge("login", { input });
    const body = toRecord(unwrapPayload(payload));
    const dtUserId = pickString(body, ["dtUserId", "dt_user_id", "userId", "user_id"]);
    const token = pickString(body, ["token", "loginToken", "login_token", "dtToken", "dt_token"]);
    if (!dtUserId || !token) {
      throw new AppError("Real gateway helper returned an incomplete login result", 502, 502);
    }
    return {
      dtUserId,
      token,
      deviceId: pickString(body, ["deviceId", "device_id", "wdeviceId", "wdevice_id"]),
      dingtoneId: pickString(body, ["dingtoneId", "dingtone_id", "dtDingtoneId", "dt_dingtone_id"]),
      routeAddress: pickString(body, ["routeAddress", "route_address", "routingAddress", "routing_address"]),
      serverIp: pickString(body, ["serverIp", "server_ip"]),
      serverPort: pickNumber(body, ["serverPort", "server_port"])
    };
  }

  async exportSession(input: DingtoneSessionExportInput): Promise<DingtoneSessionExport> {
    const payload = await this.callBridge("export_session", { input });
    const body = toRecord(unwrapPayload(payload));
    const dtUserId = pickString(body, ["dtUserId", "dt_user_id", "userId", "user_id"]);
    const token = pickString(body, ["token", "loginToken", "login_token", "dtToken", "dt_token"]);
    const deviceId = pickString(body, ["deviceId", "device_id", "wdeviceId", "wdevice_id"]);
    if (!dtUserId || !token || !deviceId) {
      throw new AppError("Real gateway helper returned an incomplete session export", 502, 502);
    }
    const snapshot = isRecord(body.snapshot) ? normalizeSnapshot(body.snapshot) : undefined;
    return {
      dtUserId,
      token,
      deviceId,
      dingtoneId: pickString(body, ["dingtoneId", "dingtone_id", "dtDingtoneId", "dt_dingtone_id"]),
      appVariant: normalizeAppVariant(pickString(body, ["appVariant", "app_variant", "variant"])),
      packageName: pickString(body, ["packageName", "package_name", "androidPackage", "android_package"]),
      activatedEmail: pickString(body, ["activatedEmail", "activated_email", "email"]) ?? snapshot?.email,
      mainPhone: pickString(body, ["mainPhone", "main_phone", "phone", "phoneNumber", "phone_number"]) ?? snapshot?.phone,
      snapshot,
      phoneNumbers: Array.isArray(body.phoneNumbers) ? normalizePhoneNumbers(body.phoneNumbers) : undefined
    };
  }

  async refreshSnapshot(account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
    appVariant?: AppVariant;
  }): Promise<DingtoneSnapshot> {
    const payload = await this.callBridge("refresh_snapshot", { account });
    return normalizeSnapshot(unwrapPayload(payload));
  }

  async listPhoneNumbers(account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: AppVariant }): Promise<DingtonePhoneNumber[]> {
    const payload = await this.callBridge("list_phone_numbers", { account });
    return normalizePhoneNumbers(unwrapPayload(payload));
  }

  async requestPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: AppVariant },
    payload: { countryCode?: number; isoCountryCode?: string | null; countryKey?: string | null; areaCode?: number | null }
  ): Promise<DingtonePhonePurchasePreview> {
    try {
      const result = await this.callBridge("request_phone_number_via_activity", { account, payload });
      return normalizePhonePurchasePreview(unwrapPayload(result));
    } catch {
      const result = await this.callBridge("request_phone_number", { account, payload });
      return normalizePhonePurchasePreview(unwrapPayload(result));
    }
  }

  async purchasePhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: AppVariant },
    payload: { countryCode?: number; isoCountryCode?: string | null; countryKey?: string | null; candidate: DingtonePhonePurchaseCandidate }
  ): Promise<DingtonePhoneNumber> {
    const result = await this.callBridge("purchase_phone_number", { account, payload });
    const payloadValue = unwrapPayload(result);
    const orderedPhone = extractOrderedPhone(payloadValue);
    const normalized = normalizePhoneNumber(orderedPhone ?? payloadValue);
    return {
      ...normalized,
      rawJson: safeJsonStringify(payloadValue)
    };
  }

  async renewPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: AppVariant },
    phoneNumber: string
  ): Promise<Partial<DingtonePhoneNumber>> {
    const result = await this.callBridge("renew_phone_number", { account, phoneNumber });
    return normalizePhoneNumberPatch(unwrapPayload(result));
  }

  async updatePhoneNumberLabel(
    account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: AppVariant },
    phoneNumber: string,
    displayName: string
  ): Promise<Partial<DingtonePhoneNumber>> {
    const result = await this.callBridge("update_phone_number_label", { account, phoneNumber, displayName });
    return normalizePhoneNumberPatch(unwrapPayload(result));
  }

  async cancelPhoneNumber(account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: AppVariant }, phoneNumber: string) {
    await this.callBridge("cancel_phone_number", { account, phoneNumber });
  }

  async pausePhoneNumber(account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: AppVariant }, phoneNumber: string) {
    await this.callBridge("pause_phone_number", { account, phoneNumber });
  }

  async resumePhoneNumber(account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: AppVariant }, phoneNumber: string) {
    await this.callBridge("resume_phone_number", { account, phoneNumber });
  }

  private async callBridge(action: BridgeAction, payload: JsonRecord) {
    const runtime = await getBridgeRuntimeConfig();
    const timeoutMs = resolveBridgeActionTimeoutMs(action, runtime.timeoutMs);
    const requestBody = {
      action,
      payload,
      meta: {
        appVersion: config.DT_APP_VERSION,
        apkCertificateSign: config.DT_APK_CERTIFICATE_SIGN,
        timeoutMs,
        serverIp: runtime.serverIp,
        serverPort: runtime.serverPort,
        backupIp: runtime.backupIp,
        proxyUrl: runtime.proxyUrl,
        requestedAt: new Date().toISOString()
      }
    };

    let lastError: Error | undefined;
    for (const path of BRIDGE_EXECUTE_PATHS) {
      try {
        return await postBridgeRequest(runtime, path, requestBody, timeoutMs);
      } catch (error) {
        if (error instanceof BridgeEndpointNotFoundError) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    logger.warn("Real gateway bridge endpoint not found", {
      baseUrl: runtime.baseUrl,
      action
    });
    throw new AppError(
      lastError?.message ??
        "Real gateway bridge endpoint was not found. Please expose /api/v1/dingtone/execute from your helper.",
      503,
      503
    );
  }
}

function resolveBridgeActionTimeoutMs(action: BridgeAction, fallbackMs: number) {
  if (action === "send_verification_code" || action === "login") {
    return Math.max(fallbackMs, 110_000);
  }
  return fallbackMs;
}

async function getBridgeRuntimeConfig(): Promise<BridgeRuntimeConfig> {
  const settings: Record<string, string> = await getSettingsMap().catch(() => ({} as Record<string, string>));
  const baseUrl = normalizeString(settings.dt_real_bridge_base_url) || config.DT_REAL_BRIDGE_BASE_URL;
  if (!baseUrl) {
    throw new AppError(
      "Real gateway mode is enabled, but DT_REAL_BRIDGE_BASE_URL is not configured. Please point it to your local/native helper service.",
      503,
      503
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token: normalizeString(settings.dt_real_bridge_token) || config.DT_REAL_BRIDGE_TOKEN,
    timeoutMs: parsePositiveInt(settings.dt_real_bridge_timeout_ms, config.DT_REAL_BRIDGE_TIMEOUT_MS),
    proxyUrl: normalizeString(settings.dt_proxy_url) || config.DT_PROXY_URL,
    serverIp: normalizeString(settings.dt_server_ip) || config.DT_SERVER_IP,
    serverPort: parsePositiveInt(settings.dt_server_port, config.DT_SERVER_PORT),
    backupIp: normalizeString(settings.dt_backup_ip) || config.DT_BACKUP_IP
  };
}

async function postBridgeRequest(runtime: BridgeRuntimeConfig, path: string, body: JsonRecord, timeoutMs = runtime.timeoutMs) {
  const url = `${runtime.baseUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildBridgeHeaders(runtime),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    logger.error("Real gateway bridge request failed", { url, error });
    throw new AppError(
      `Real gateway helper is unreachable: ${error instanceof Error ? error.message : "unknown network error"}`,
      502,
      502
    );
  }

  const payload = await readJsonPayload(response);
  if (response.status === 404 || response.status === 405) {
    throw new BridgeEndpointNotFoundError(`Bridge endpoint not found at ${url}`);
  }

  if (!response.ok) {
    throw toBridgeAppError(payload, response.status);
  }

  if (isRecord(payload) && payload.ok === false) {
    throw toBridgeAppError(payload, pickNumber(payload, ["statusCode", "status", "httpStatus"]) ?? 502);
  }

  if (isRecord(payload) && typeof payload.code === "number" && payload.code !== 0 && payload.code !== 200) {
    throw toBridgeAppError(payload, pickNumber(payload, ["statusCode", "status", "httpStatus"]) ?? 502);
  }

  return payload;
}

function buildBridgeHeaders(runtime: BridgeRuntimeConfig) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json"
  });
  if (runtime.token) {
    headers.set("authorization", `Bearer ${runtime.token}`);
    headers.set("x-dt-bridge-token", runtime.token);
  }
  return headers;
}

async function readJsonPayload(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function toBridgeAppError(payload: unknown, fallbackStatus: number) {
  const statusCode = normalizeHttpStatus(fallbackStatus);
  if (isRecord(payload)) {
    const message =
      pickString(payload, ["message", "error", "detail"]) ??
      `Real gateway helper request failed with HTTP ${statusCode}`;
    const code = pickNumber(payload, ["code", "statusCode", "status", "httpStatus"]) ?? statusCode;
    return new AppError(message, statusCode, code);
  }
  return new AppError(`Real gateway helper request failed with HTTP ${statusCode}`, statusCode, statusCode);
}

function unwrapPayload(value: unknown) {
  if (!isRecord(value)) {
    return value;
  }
  if ("data" in value && value.data !== undefined) {
    return value.data;
  }
  if ("result" in value && value.result !== undefined) {
    return value.result;
  }
  return value;
}

function extractPhoneCandidate(value: unknown) {
  return extractPhoneCandidates(value)[0];
}

function extractOrderedPhone(value: unknown) {
  const records = collectCandidateRecords(value);
  for (const record of records) {
    if (isRecord(record.orderPayload)) {
      return record.orderPayload;
    }
    if (isRecord(record.phone)) {
      return record.phone;
    }
  }
  return extractPhoneCandidate(value);
}

function normalizeSnapshot(value: unknown): DingtoneSnapshot {
  const records = collectCandidateRecords(value);
  return {
    dtDingtoneId: pickStringFromRecords(records, ["dtDingtoneId", "dt_dingtone_id", "dingtoneId", "dingtone_id", "uid"]),
    fullName:
      pickStringFromRecords(records, ["fullName", "full_name", "displayName", "DisplayName", "nickname", "nickName", "userName"]) ??
      pickStringFromRecords(records.filter((record) => hasAnyOwnKey(record, ["profileImg", "profileVerCode", "dingtoneID"])), ["name"]),
    avatarUrl: pickStringFromRecords(records, ["avatarUrl", "avatar_url", "photoUrl", "photo_url"]),
    gender: pickNumberFromRecords(records, ["gender", "sex"]),
    birthday: pickStringFromRecords(records, ["birthday", "birthDay"]),
    email: pickStringFromRecords(records, ["email"]),
    phone: pickStringFromRecords(records, ["phone", "phoneNumber", "phone_number"]),
    aboutMe: pickStringFromRecords(records, ["aboutMe", "about_me", "signature"]),
    feeling: pickStringFromRecords(records, ["feeling", "mood"]),
    company: pickStringFromRecords(records, ["company"]),
    school: pickStringFromRecords(records, ["school"]),
    country: pickStringFromRecords(records, ["country", "countryName"]),
    state: pickStringFromRecords(records, ["state", "province"]),
    city: pickStringFromRecords(records, ["city"]),
    primaryBalance: pickNumberFromRecords(records, [
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
      "credit_balance",
    ]),
    userGrade: pickNumberFromRecords(records, [
      "userGrade",
      "user_grade",
      "grade",
      "vipGrade",
      "vip_grade",
      "memberGrade",
      "member_grade",
      "currentGrade",
      "current_grade",
      "pointGradeLevel",
      "point_grade_level",
    ]),
    validPoint: pickNumberFromRecords(records, [
      "validPoint",
      "valid_point",
      "usablePoint",
      "usable_point",
      "availablePoint",
      "available_point",
      "tokenNumber",
      "token_number",
    ]),
    progressPoint: pickNumberFromRecords(records, [
      "progressPoint",
      "progress_point",
      "currentPoint",
      "current_point",
      "levelPoint",
      "level_point",
      "totalPoint",
      "total_point",
      "historyPoint",
      "history_point",
    ]),
    progressPointTotal: pickNumberFromRecords(records, [
      "progressPointTotal",
      "progress_point_total",
      "totalProgressPoint",
      "total_progress_point",
      "progressTotalPoint",
      "progress_total_point",
      "pointTotal",
      "point_total",
      "nextGradePoint",
      "next_grade_point",
      "nextLevelPoint",
      "next_level_point",
    ]),
    membershipType: pickStringFromRecords(records, [
      "membershipType",
      "membership_type",
      "premiumType",
      "premium_type",
      "memberType",
      "member_type",
      "walletType",
      "wallet_type",
    ]),
    membershipLevelLabel: pickStringFromRecords(records, [
      "membershipLevelLabel",
      "membership_level_label",
      "levelName",
      "level_name",
      "vipLevelName",
      "vip_level_name",
      "gradeName",
      "grade_name",
    ]),
    membershipExpireAt: pickDateFromRecords(records, ["membershipExpireAt", "membership_expire_at", "expireTime", "expire_time"]),
    profileVerCode: pickStringFromRecords(records, ["profileVerCode", "profile_ver_code", "verCode", "ver_code"]),
    rawJson: safeJsonStringify(value)
  };
}

function normalizePhonePurchasePreview(value: unknown): DingtonePhonePurchasePreview {
  return {
    freeChance: pickNumberFromRecords(collectCandidateRecords(value), ["freeChance", "free_chance"]),
    candidates: extractPhoneCandidates(value).map((item) => normalizePhonePurchaseCandidate(item)).filter((item) => Boolean(item.phoneNumber)),
    rawJson: safeJsonStringify(value)
  };
}

function normalizePhonePurchaseCandidate(value: unknown): DingtonePhonePurchaseCandidate {
  const record = isRecord(value) ? value : {};
  return {
    phoneNumber: pickString(record, ["phoneNumber", "phone_number", "number", "privateNumber", "private_number"]) ?? "",
    countryCode: pickNumber(record, ["countryCode", "country_code"]),
    areaCode: pickNumber(record, ["areaCode", "area_code"]),
    providerId: pickNumber(record, ["providerId", "provider_id"]),
    packageServiceId: pickString(record, ["packageServiceId", "package_service_id"]),
    category: pickNumber(record, ["category", "purchaseType", "purchase_type"]),
    phoneType: pickNumber(record, ["phoneType", "phone_type", "payType", "pay_type"]),
    displayName: pickString(record, ["displayName", "display_name", "cityName", "city_name", "stateName", "state_name"]),
    cityName: pickString(record, ["cityName", "city_name"]),
    stateName: pickString(record, ["stateName", "state_name"]),
    isoCountryCode: pickString(record, ["isoCountryCode", "iso_country_code", "isoCC", "iso_cc"]),
    goodNumberLevel: pickNumber(record, ["goodNumberLevel", "good_number_level"]),
    useHistory: pickNumber(record, ["useHistory", "use_history"]),
    productId: pickString(record, ["productId", "product_id"]),
    price: pickNumber(record, [
      "orderPrice",
      "order_price",
      "price",
      "creditPrice",
      "credit_price",
      "reserved5",
      "payAmount",
      "pay_amount",
      "amount",
      "credit",
      "creditNum",
      "credit_num",
      "coinCost",
      "coin_cost",
      "needPay",
      "need_pay",
      "needBalance",
      "need_balance",
      "cost",
      "totalPrice",
      "total_price",
    ]),
    rawJson: safeJsonStringify(value)
  };
}

function normalizePhoneNumbers(value: unknown): DingtonePhoneNumber[] {
  if (Array.isArray(value)) {
    return value.map((item) => normalizePhoneNumber(item)).filter((item) => Boolean(item.phoneNumber));
  }

  if (!isRecord(value)) {
    return [];
  }

  const nestedData = isRecord(value.data) ? value.data : {};
  const groups = [
    value.phoneNumbers,
    value.phone_numbers,
    value.phones,
    value.phoneList,
    value.numberExList,
    value.number_ex_list,
    value.numberList,
    value.number_list,
    value.items,
    value.list,
    value.numbers,
    nestedData.phoneNumbers,
    nestedData.phones,
    nestedData.phoneList,
    nestedData.numberExList,
    nestedData.numberList,
    nestedData.list,
    nestedData.items
  ];

  const items = groups.find(Array.isArray) as unknown[] | undefined;
  return (items ?? []).map((item) => normalizePhoneNumber(item)).filter((item) => Boolean(item.phoneNumber));
}

function normalizePhoneNumber(value: unknown): DingtonePhoneNumber {
  if (typeof value === "string") {
    return { phoneNumber: value, rawJson: JSON.stringify(value) };
  }

  const record = isRecord(value) ? value : {};
  const phoneNumber =
    pickString(record, ["phoneNumber", "phone_number", "number", "privateNumber", "private_number"]) ?? "";
  return {
    phoneNumber,
    countryCode: pickNumber(record, ["countryCode", "country_code"]),
    providerId: pickNumber(record, ["providerId", "provider_id"]),
    displayName: pickString(record, ["displayName", "display_name", "cityName", "city_name", "stateName", "state_name"]),
    status: normalizePhoneStatus(record),
    purchaseType: pickNumber(record, ["purchaseType", "purchase_type", "category"]),
    payType: pickNumber(record, ["payType", "pay_type", "phoneType", "phone_type"]),
    validPeriodDays: pickNumber(record, ["validPeriodDays", "valid_period_days", "usePeriod", "use_period"]),
    gainTime: stringifyPrimitive(record.gainTime ?? record.gain_time),
    expiredTime: stringifyPrimitive(record.expireTime ?? record.expire_time),
    autoRenew: pickBoolean(record, ["autoRenew", "auto_renew"]),
    isPrimary: pickBoolean(record, ["isPrimary", "is_primary", "primaryFlag", "primary_flag"]),
    isGoodNumber:
      pickBoolean(record, ["isGoodNumber", "is_good_number"]) ??
      ((pickNumber(record, ["goodNumberLevel", "good_number_level"]) ?? 0) > 0 ? true : undefined),
    portoutInfo: pickString(record, ["portoutInfo", "portout_info"]),
    rawJson: safeJsonStringify(value)
  };
}

function normalizePhoneNumberPatch(value: unknown): Partial<DingtonePhoneNumber> {
  const normalized = normalizePhoneNumber(value);
  return {
    countryCode: normalized.countryCode,
    providerId: normalized.providerId,
    displayName: normalized.displayName,
    status: normalized.status,
    purchaseType: normalized.purchaseType,
    payType: normalized.payType,
    validPeriodDays: normalized.validPeriodDays,
    gainTime: normalized.gainTime,
    expiredTime: normalized.expiredTime,
    autoRenew: normalized.autoRenew,
    isPrimary: normalized.isPrimary,
    isGoodNumber: normalized.isGoodNumber,
    portoutInfo: normalized.portoutInfo,
    rawJson: normalized.rawJson
  };
}

function normalizePhoneStatus(record: JsonRecord): DingtonePhoneNumber["status"] {
  const explicit = pickString(record, ["status", "phoneStatus", "phone_status"])?.toLowerCase();
  if (explicit === "active" || explicit === "paused" || explicit === "expired" || explicit === "cancelled" || explicit === "pending") {
    return explicit;
  }
  if (pickBoolean(record, ["cancelled", "isCancelled", "is_cancelled"])) {
    return "cancelled";
  }
  if (pickBoolean(record, ["suspendFlag", "suspend_flag", "paused", "isPaused", "is_paused"])) {
    return "paused";
  }
  const expireAt = pickEpochMs(record, ["expireTime", "expire_time"]);
  if (expireAt && expireAt <= Date.now()) {
    return "expired";
  }
  return "active";
}

function collectCandidateRecords(value: unknown): JsonRecord[] {
  const records: JsonRecord[] = [];
  const visited = new Set<unknown>();
  const visit = (candidate: unknown, depth = 0) => {
    if (depth > 5 || candidate === null || candidate === undefined || visited.has(candidate)) {
      return;
    }
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item, depth + 1);
      }
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    records.push(candidate);
    for (const value of Object.values(candidate)) {
      visit(value, depth + 1);
    }
  };

  visit(value);
  return records;
}

function extractPhoneCandidates(value: unknown) {
  const records = collectCandidateRecords(value);
  for (const record of records) {
    const list =
      (Array.isArray(record.candidates) && record.candidates) ||
      (Array.isArray(record.phones) && record.phones) ||
      (Array.isArray(record.phoneNumbers) && record.phoneNumbers) ||
      (Array.isArray(record.phoneList) && record.phoneList) ||
      (Array.isArray(record.phone_numbers) && record.phone_numbers) ||
      (Array.isArray(record.items) && record.items) ||
      (Array.isArray(record.list) && record.list);
    if (list && list.length > 0) {
      return list;
    }
  }
  return [];
}

function pickStringFromRecords(records: JsonRecord[], keys: string[]) {
  for (const record of records) {
    const value = pickString(record, keys);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function hasAnyOwnKey(record: JsonRecord, keys: string[]) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function pickNumberFromRecords(records: JsonRecord[], keys: string[]) {
  for (const record of records) {
    const value = pickNumber(record, keys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function pickDateFromRecords(records: JsonRecord[], keys: string[]) {
  for (const record of records) {
    const value = pickDate(record, keys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function pickString(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const normalized = normalizeString(value);
      if (normalized) {
        return normalized;
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function pickBoolean(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") {
        return true;
      }
      if (normalized === "false" || normalized === "0") {
        return false;
      }
    }
  }
  return undefined;
}

function pickNumber(record: JsonRecord, keys: string[]) {
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
  return undefined;
}

function pickDate(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return new Date(value > 1_000_000_000_000 ? value : value * 1000);
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return new Date(parsed > 1_000_000_000_000 ? parsed : parsed * 1000);
      }
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
  }
  return undefined;
}

function pickEpochMs(record: JsonRecord, keys: string[]) {
  const value = pickDate(record, keys);
  return value?.getTime();
}

function normalizeString(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = repairUtf8Mojibake(value).trim();
  return /^(null|undefined|none|nil)$/i.test(normalized) ? "" : normalized;
}

function normalizeAppVariant(value: string | undefined): AppVariant | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "dingtone" || normalized === "talku" || normalized === "talkyou") {
    return "dingtone";
  }
  if (normalized === "dingdong") {
    return "dingdong";
  }
  return undefined;
}

function repairUtf8Mojibake(value: string) {
  if (!value) {
    return value;
  }
  if (/[\u4e00-\u9fff]/.test(value)) {
    return value;
  }
  if (!/[À-ÿ]/.test(value)) {
    return value;
  }

  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (!repaired || repaired === value || repaired.includes("�")) {
      return value;
    }
    if (/[\u4e00-\u9fff]/.test(repaired)) {
      return repaired;
    }
    const suspiciousOriginal = (value.match(/[À-ÿ]/g) || []).length;
    const suspiciousRepaired = (repaired.match(/[À-ÿ]/g) || []).length;
    return suspiciousRepaired < suspiciousOriginal ? repaired : value;
  } catch {
    return value;
  }
}

function parsePositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHttpStatus(value: number) {
  return value >= 400 && value <= 599 ? value : 502;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyPrimitive(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializeError: true });
  }
}

function toRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}
