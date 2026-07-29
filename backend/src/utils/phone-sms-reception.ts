const SMS_RECEPTION_KEYS = ["allowReceiveSMS", "allowReceiveSms", "allow_receive_sms"];
const ACTIVE_FILTER_KEYS = [
  "useBlock",
  "use_block",
  "callBlockSetting",
  "call_block_setting",
  "callBlockHandle",
  "call_block_handle",
  "useVoicemail",
  "useVoiceMail",
  "use_voicemail",
  "voicemailEnabled",
  "voiceMailEnabled",
  "voicemailFlag",
  "voiceMailFlag",
  "voicemailStatus",
  "voiceMailStatus"
];

export function derivePhoneSmsReceptionState(value: unknown): boolean | undefined {
  let confirmedDisabled = false;

  for (const record of collectRecords(value)) {
    const filterSetting = parseFilterSetting(record.filterSetting ?? record.filter_setting);
    const activeFilter = hasActiveFilter(record) || (filterSetting ? hasActiveFilter(filterSetting) : false);
    const direct = pickBoolean(record, SMS_RECEPTION_KEYS);
    if (direct === true) {
      return true;
    }
    if (direct === false && activeFilter) {
      confirmedDisabled = true;
    }

    if (filterSetting) {
      const nested = pickBoolean(filterSetting, SMS_RECEPTION_KEYS);
      if (nested === true) {
        return true;
      }
      if (nested === false && activeFilter) {
        confirmedDisabled = true;
      }
    }
  }

  return confirmedDisabled ? false : undefined;
}

function collectRecords(
  value: unknown,
  depth = 0,
  output: Record<string, unknown>[] = [],
  visited = new Set<unknown>()
) {
  if (depth > 6 || value === null || value === undefined || visited.has(value)) {
    return output;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRecords(item, depth + 1, output, visited);
    }
    return output;
  }
  if (!isRecord(value)) {
    return output;
  }
  output.push(value);
  for (const item of Object.values(value)) {
    collectRecords(item, depth + 1, output, visited);
  }
  return output;
}

function parseFilterSetting(value: unknown) {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasActiveFilter(record: Record<string, unknown>) {
  return ACTIVE_FILTER_KEYS.some((key) => isEnabledValue(record[key]));
}

function isEnabledValue(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "off" && normalized !== "null";
  }
  return false;
}

function pickBoolean(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (value === 1 || value === "1" || value === "true") {
      return true;
    }
    if (value === 0 || value === -1 || value === "0" || value === "-1" || value === "false") {
      return false;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
