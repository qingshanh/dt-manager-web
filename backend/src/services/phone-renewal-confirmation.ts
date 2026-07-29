type RenewalExpiryPatch = { expiredTime?: string | null };
type RenewalActionResponse = RenewalExpiryPatch & { rawJson?: string | null };
type RenewalPeriodSource = { validPeriodDays?: number | null; rawJson?: string | null };

export type PhoneRenewalConfirmation<TPhone extends RenewalExpiryPatch = RenewalExpiryPatch> = {
  source: "renew_response" | "remote_phone_list" | "renewal_pending";
  confirmed: boolean;
  phone: TPhone;
  note: string;
};

export function resolvePhoneRenewalConfirmation<
  TAction extends RenewalExpiryPatch,
  TRemote extends RenewalExpiryPatch = TAction
>(input: {
  previous: RenewalExpiryPatch;
  action: TAction;
  remote?: TRemote | null;
}): PhoneRenewalConfirmation<TAction | TRemote> {
  if (hasAdvancedPhoneExpiry(input.previous, input.action)) {
    return {
      source: "renew_response",
      confirmed: true,
      phone: input.action,
      note: "Renewal was confirmed by the native order response because its expiry time advanced."
    };
  }

  if (input.remote && hasAdvancedPhoneExpiry(input.previous, input.remote)) {
    return {
      source: "remote_phone_list",
      confirmed: true,
      phone: input.remote,
      note: "Renewal was confirmed by the remote purchased phone list because its expiry time advanced."
    };
  }

  return {
    source: "renewal_pending",
    confirmed: false,
    phone: input.action,
    note: "The renewal request was accepted, but the remote phone list is still stale. Background confirmation will continue; do not submit another renewal."
  };
}

export function hasAdvancedPhoneExpiry(previous: RenewalExpiryPatch, current: RenewalExpiryPatch) {
  const previousExpiry = parsePhoneExpiry(previous.expiredTime);
  const currentExpiry = parsePhoneExpiry(current.expiredTime);
  return previousExpiry !== null && currentExpiry !== null && currentExpiry > previousExpiry;
}

export function shouldDeferRenewalRemoteConfirmation(action: RenewalActionResponse) {
  if (!action.rawJson) {
    return false;
  }
  try {
    const payload = JSON.parse(action.rawJson) as { result?: unknown; Result?: unknown };
    return payload.result === "no_response_after_write" || payload.Result === "no_response_after_write";
  } catch {
    return false;
  }
}

export function resolvePhoneRenewalMonths(phone: RenewalPeriodSource): number {
  const raw = parseRenewalRaw(phone.rawJson);
  for (const value of [phone.validPeriodDays, raw?.validPeriodDays, raw?.valid_period_days]) {
    const months = normalizeRenewalMonths(value);
    if (months !== null) return months;
  }
  throw new Error("Could not establish the exact phone renewal period from the latest remote phone record.");
}

export function resolvePhoneRenewalCommandTag(extensionMonths: number): 0 | 2 {
  return extensionMonths === 12 ? 2 : 0;
}

export function resolvePhoneRenewalExtraChargeMonths(extensionMonths: number): 0 | 12 {
  return extensionMonths === 12 ? 12 : 0;
}

function normalizeRenewalMonths(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (Number.isInteger(numeric) && numeric <= 12) return numeric;
  if (numeric >= 28 && numeric <= 372) {
    const months = Math.round(numeric / 31);
    return months >= 1 && months <= 12 ? months : null;
  }
  return null;
}

function parseRenewalRaw(value?: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parsePhoneExpiry(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
