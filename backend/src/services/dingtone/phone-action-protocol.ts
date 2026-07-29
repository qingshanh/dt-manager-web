export const PHONE_ACTION_REST_CALL_TYPES = {
  renew: 2050,
  settings: 2052,
  cancel: 2132
} as const;

export type PhoneActionProtocolKind = keyof typeof PHONE_ACTION_REST_CALL_TYPES;
export type PhoneActionAppVariant = "dingtone" | "dingdong";

export type PrivateNumberSettingPatch = {
  suspendFlag?: boolean;
  displayName?: string;
  allowReceiveSms?: boolean;
};

export type PrivateNumberSettingPayload = {
  phoneNumber: string;
  displayName: string;
  primaryFlag: 0 | 1;
  faxEnabled: number;
  slientFlag: 0 | 1;
  suspendFlag: 0 | 1;
  callForwardFlag: 0 | 1;
  forwardNumber: string;
  forwardCountryCode: number;
  forwardDestCode: number;
  autoSMSReply: number;
  useVoicemail: number;
  voicemailId: string;
  autoSMSContent: string;
  defaultGreetings: number;
  autoRenew: 0 | 1;
  filterSetting: Record<string, unknown> & { allowReceiveSMS?: boolean };
};

const PHONE_ACTION_API_NAMES: Record<PhoneActionProtocolKind, string> = {
  renew: "/pstn/share/orderPrivateNumber",
  settings: "/pstn/share/privateNumberSetting",
  cancel: "/pstn/share/deletePhoneNumber"
};

export class UnsafePhoneSettingSourceError extends Error {
  readonly missingFields: string[];

  constructor(missingFields: string[]) {
    super(`Phone setting source is incomplete: ${missingFields.join(", ")}`);
    this.name = "UnsafePhoneSettingSourceError";
    this.missingFields = missingFields;
  }
}

export function resolvePhoneActionProtocol(appVariant: PhoneActionAppVariant, action: PhoneActionProtocolKind) {
  return {
    appVariant,
    action,
    restCallType: PHONE_ACTION_REST_CALL_TYPES[action],
    apiName: PHONE_ACTION_API_NAMES[action]
  } as const;
}

export function buildPrivateNumberSettingPayload(
  source: Record<string, unknown>,
  patch: PrivateNumberSettingPatch
): PrivateNumberSettingPayload {
  const records = collectSourceRecords(source);
  const missingFields: string[] = [];

  const phoneNumber = requireString(records, ["phoneNumber", "phone_number"], "phoneNumber", missingFields);
  const displayName = requireString(records, ["displayName", "display_name"], "displayName", missingFields, true);
  const primaryFlag = requireBoolean(records, ["primaryFlag", "primary_flag", "isPrimary", "is_primary"], "primaryFlag", missingFields);
  const faxEnabled = requireNumber(records, ["faxEnabled", "fax_enabled"], "faxEnabled", missingFields);
  const slientFlag = requireBoolean(records, ["slientFlag", "silentFlag", "slient_flag", "silent_flag"], "slientFlag", missingFields);
  const suspendFlag = requireBoolean(records, ["suspendFlag", "suspend_flag"], "suspendFlag", missingFields);
  const callForwardFlag = requireBoolean(records, ["callForwardFlag", "call_forward_flag"], "callForwardFlag", missingFields);
  const forwardNumber = requireString(records, ["forwardNumber", "forward_number"], "forwardNumber", missingFields, true);
  const forwardCountryCode = requireNumber(records, ["forwardCountryCode", "forward_country_code"], "forwardCountryCode", missingFields);
  const forwardDestCode = requireNumber(records, ["forwardDestCode", "forward_dest_code"], "forwardDestCode", missingFields);
  const autoSMSReply = requireNumber(records, ["autoSMSReply", "auto_sms_reply"], "autoSMSReply", missingFields);
  const useVoicemail = requireNumber(records, ["useVoicemail", "use_voicemail"], "useVoicemail", missingFields);
  const voicemailId = requireString(records, ["voicemailId", "voicemail_id"], "voicemailId", missingFields, true);
  const autoSMSContent = requireString(records, ["autoSMSContent", "auto_sms_content"], "autoSMSContent", missingFields, true);
  const defaultGreetings = requireNumber(records, ["defaultGreetings", "default_greetings"], "defaultGreetings", missingFields);
  const autoRenew = requireBoolean(records, ["autoRenew", "auto_renew"], "autoRenew", missingFields);
  const filterSetting = requireFilterSetting(records, missingFields);

  if (missingFields.length > 0) {
    throw new UnsafePhoneSettingSourceError(missingFields);
  }

  const nextSuspend = patch.suspendFlag ?? suspendFlag!;
  const nextFilterSetting = { ...filterSetting! };
  if (patch.allowReceiveSms !== undefined) {
    nextFilterSetting.allowReceiveSMS = patch.allowReceiveSms;
  }

  return {
    phoneNumber: stripPhonePrefix(phoneNumber!),
    displayName: patch.displayName ?? displayName!,
    primaryFlag: booleanFlag(nextSuspend ? false : primaryFlag!),
    faxEnabled: faxEnabled!,
    slientFlag: booleanFlag(slientFlag!),
    suspendFlag: booleanFlag(nextSuspend),
    callForwardFlag: booleanFlag(callForwardFlag!),
    forwardNumber: forwardNumber!,
    forwardCountryCode: forwardCountryCode!,
    forwardDestCode: forwardDestCode!,
    autoSMSReply: autoSMSReply!,
    useVoicemail: useVoicemail!,
    voicemailId: voicemailId!,
    autoSMSContent: autoSMSContent!,
    defaultGreetings: defaultGreetings!,
    autoRenew: booleanFlag(autoRenew!),
    filterSetting: nextFilterSetting
  };
}

function collectSourceRecords(source: Record<string, unknown>): Record<string, unknown>[] {
  const records = [source];
  for (const key of ["rawJson", "raw_json"]) {
    const value = source[key];
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // An invalid raw snapshot is treated as missing data by the required-field checks.
    }
  }
  return records;
}

function requireString(
  records: Record<string, unknown>[],
  keys: string[],
  label: string,
  missing: string[],
  allowEmpty = false
): string | undefined {
  const value = pickValue(records, keys);
  if (typeof value === "string" && (allowEmpty || value.length > 0)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  missing.push(label);
  return undefined;
}

function requireNumber(
  records: Record<string, unknown>[],
  keys: string[],
  label: string,
  missing: string[]
): number | undefined {
  const value = pickValue(records, keys);
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (Number.isFinite(numberValue)) return numberValue;
  missing.push(label);
  return undefined;
}

function requireBoolean(
  records: Record<string, unknown>[],
  keys: string[],
  label: string,
  missing: string[]
): boolean | undefined {
  const value = pickValue(records, keys);
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  missing.push(label);
  return undefined;
}

function requireFilterSetting(
  records: Record<string, unknown>[],
  missing: string[]
): (Record<string, unknown> & { allowReceiveSMS?: boolean }) | undefined {
  const value = pickValue(records, ["filterSetting", "filter_setting"]);
  if (isRecord(value)) return { ...value };
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) return { ...parsed };
    } catch {
      // Fall through to the explicit missing-field error.
    }
  }
  missing.push("filterSetting");
  return undefined;
}

function pickValue(records: Record<string, unknown>[], keys: string[]): unknown {
  for (const record of records) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined && record[key] !== null) {
        return record[key];
      }
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanFlag(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function stripPhonePrefix(value: string): string {
  return value.replace(/^\+/, "");
}
