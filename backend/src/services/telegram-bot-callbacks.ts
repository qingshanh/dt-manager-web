export type TelegramPanelCallback =
  | { scope: "panel"; action: "root" | "status" | "messages" | "help" }
  | { scope: "panel"; action: "accounts" | "phones"; page: number }
  | {
      scope: "account";
      action:
        | "detail"
        | "messages"
        | "refresh"
        | "refresh_phones"
        | "monitor_on"
        | "monitor_off"
        | "relogin_send_code"
        | "notify_on"
        | "notify_off";
      accountId: number;
    }
  | { scope: "account"; action: "phones"; accountId: number; page: number }
  | {
      scope: "phone";
      action: "detail" | "note" | "renew_request" | "cancel_request";
      accountId: number;
      phoneId: number;
    }
  | {
      scope: "phone";
      action: "renew_confirm" | "cancel_confirm";
      accountId: number;
      phoneId: number;
      version: string;
    };

const PANEL_CODES = {
  root: "r",
  status: "s",
  messages: "m",
  help: "h",
  accounts: "a",
  phones: "n"
} as const;

const ACCOUNT_CODES = {
  detail: "d",
  messages: "m",
  phones: "n",
  refresh: "r",
  refresh_phones: "f",
  monitor_on: "o1",
  monitor_off: "o0",
  relogin_send_code: "lc",
  notify_on: "t1",
  notify_off: "t0"
} as const;

const PHONE_CODES = {
  detail: "d",
  note: "e",
  renew_request: "rr",
  cancel_request: "cr",
  renew_confirm: "rx",
  cancel_confirm: "cx"
} as const;

export function encodeTelegramCallback(callback: TelegramPanelCallback) {
  let encoded: string;
  if (callback.scope === "panel") {
    const base = `p:${PANEL_CODES[callback.action]}`;
    encoded = "page" in callback ? `${base}:${positiveInteger(callback.page, "page")}` : base;
  } else if (callback.scope === "account") {
    const accountId = positiveInteger(callback.accountId, "accountId");
    const base = `a:${accountId}:${ACCOUNT_CODES[callback.action]}`;
    encoded = "page" in callback ? `${base}:${positiveInteger(callback.page, "page")}` : base;
  } else {
    const base = `n:${positiveInteger(callback.accountId, "accountId")}:${positiveInteger(callback.phoneId, "phoneId")}:${PHONE_CODES[callback.action]}`;
    encoded = "version" in callback ? `${base}:${callbackVersion(callback.version)}` : base;
  }

  if (Buffer.byteLength(encoded, "utf8") > 64) {
    throw new RangeError("Telegram callback_data exceeds 64 bytes");
  }
  return encoded;
}

export function parseTelegramCallback(value: string | undefined): TelegramPanelCallback | null {
  if (!value) return null;
  const parts = value.split(":");

  if (parts[0] === "p") {
    const action = panelAction(parts[1]);
    if (!action) return null;
    if (action === "accounts" || action === "phones") {
      const page = parsePositiveInteger(parts[2]);
      return parts.length === 3 && page ? { scope: "panel", action, page } : null;
    }
    return parts.length === 2 ? { scope: "panel", action } : null;
  }

  if (parts[0] === "a") {
    const accountId = parsePositiveInteger(parts[1]);
    const action = accountAction(parts[2]);
    if (!accountId || !action) return null;
    if (action === "phones") {
      const page = parsePositiveInteger(parts[3]);
      return parts.length === 4 && page ? { scope: "account", action, accountId, page } : null;
    }
    return parts.length === 3 ? { scope: "account", action, accountId } : null;
  }

  if (parts[0] === "n") {
    const accountId = parsePositiveInteger(parts[1]);
    const phoneId = parsePositiveInteger(parts[2]);
    const action = phoneAction(parts[3]);
    if (!accountId || !phoneId || !action) return null;
    if (action === "renew_confirm" || action === "cancel_confirm") {
      const version = parseCallbackVersion(parts[4]);
      return parts.length === 5 && version ? { scope: "phone", action, accountId, phoneId, version } : null;
    }
    return parts.length === 4 ? { scope: "phone", action, accountId, phoneId } : null;
  }

  return null;
}

export function paginateTelegramItems<T>(items: readonly T[], requestedPage: number, pageSize: number) {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new RangeError("Telegram page size must be a positive integer");
  }
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const normalizedPage = Number.isSafeInteger(requestedPage) ? requestedPage : 1;
  const page = Math.min(Math.max(normalizedPage, 1), totalPages);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, totalPages };
}

function positiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  return value;
}

function parsePositiveInteger(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function callbackVersion(value: string) {
  const normalized = parseCallbackVersion(value);
  if (!normalized) {
    throw new RangeError("version must contain 6 to 16 lowercase letters or digits");
  }
  return normalized;
}

function parseCallbackVersion(value: string | undefined) {
  return value && /^[a-z0-9]{6,16}$/.test(value) ? value : null;
}

function panelAction(value: string | undefined) {
  if (value === PANEL_CODES.root) return "root" as const;
  if (value === PANEL_CODES.status) return "status" as const;
  if (value === PANEL_CODES.messages) return "messages" as const;
  if (value === PANEL_CODES.help) return "help" as const;
  if (value === PANEL_CODES.accounts) return "accounts" as const;
  if (value === PANEL_CODES.phones) return "phones" as const;
  return null;
}

function accountAction(value: string | undefined) {
  if (value === ACCOUNT_CODES.detail) return "detail" as const;
  if (value === ACCOUNT_CODES.messages) return "messages" as const;
  if (value === ACCOUNT_CODES.phones) return "phones" as const;
  if (value === ACCOUNT_CODES.refresh) return "refresh" as const;
  if (value === ACCOUNT_CODES.refresh_phones) return "refresh_phones" as const;
  if (value === ACCOUNT_CODES.monitor_on) return "monitor_on" as const;
  if (value === ACCOUNT_CODES.monitor_off) return "monitor_off" as const;
  if (value === ACCOUNT_CODES.relogin_send_code) return "relogin_send_code" as const;
  if (value === ACCOUNT_CODES.notify_on) return "notify_on" as const;
  if (value === ACCOUNT_CODES.notify_off) return "notify_off" as const;
  return null;
}

function phoneAction(value: string | undefined) {
  if (value === PHONE_CODES.detail) return "detail" as const;
  if (value === PHONE_CODES.note) return "note" as const;
  if (value === PHONE_CODES.renew_request) return "renew_request" as const;
  if (value === PHONE_CODES.cancel_request) return "cancel_request" as const;
  if (value === PHONE_CODES.renew_confirm) return "renew_confirm" as const;
  if (value === PHONE_CODES.cancel_confirm) return "cancel_confirm" as const;
  return null;
}
