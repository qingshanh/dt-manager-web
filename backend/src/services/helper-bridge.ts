import { config } from "../config.js";
import { AppError } from "../utils/errors.js";
import type { HelperSmsMessageRecord } from "./message-runtime.js";
import { getSettingsMap } from "./settings.service.js";

export async function executeHelperAction<T = unknown>(action: string, input: Record<string, unknown>, timeoutMs = 30_000) {
  const payload = await postHelperExecute(action, input, timeoutMs);
  return payload as T;
}

export async function executeHelperActionWithRetry<T = unknown>(
  action: string,
  input: Record<string, unknown>,
  timeoutMs = 30_000,
  attempts = 2
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await executeHelperAction<T>(action, input, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError;
}

export async function dumpHelperSmsMessages(limit: number, appVariant: "dingtone" | "dingdong" = "dingtone", timeoutMs = 30_000) {
  return (await postHelperExecute("dump_sms_messages", { limit, appVariant }, timeoutMs)) as HelperSmsMessageRecord[];
}

export async function getCachedPrivateNumberEvent() {
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  const helperBaseUrl = normalizeOptionalString(settings.dt_real_bridge_base_url) || config.DT_REAL_BRIDGE_BASE_URL || "http://127.0.0.1:5175";
  const response = await fetch(`${helperBaseUrl.replace(/\/+$/, "")}/cached/request_private_number`, {
    signal: AbortSignal.timeout(10_000)
  }).catch((error) => {
    throw new AppError(`Helper cached request_private_number query failed: ${error instanceof Error ? error.message : String(error)}`, 502, 502);
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; data?: { payload?: unknown }; message?: string }
    | null;
  if (!response.ok || !payload?.ok) {
    const message = payload?.message || `Helper cached request_private_number query failed with HTTP ${response.status}`;
    throw new AppError(message, response.status >= 400 ? response.status : 502, 502);
  }
  return payload.data?.payload;
}

export async function assertHelperAvailable(timeoutMs = 2_000) {
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  const helperBaseUrl = normalizeOptionalString(settings.dt_real_bridge_base_url) || config.DT_REAL_BRIDGE_BASE_URL || "http://127.0.0.1:5175";
  const response = await fetch(`${helperBaseUrl.replace(/\/+$/, "")}/health`, {
    signal: AbortSignal.timeout(timeoutMs)
  }).catch((error) => {
    throw new AppError(`Helper is not reachable: ${error instanceof Error ? error.message : String(error)}`, 502, 502);
  });
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: unknown; message?: string } | null;
  if (!response.ok || !payload?.ok) {
    throw new AppError(payload?.message || `Helper health check failed with HTTP ${response.status}`, 502, 502);
  }
  return payload.data;
}

async function postHelperExecute(action: string, input: Record<string, unknown>, timeoutMs: number) {
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  const helperBaseUrl = normalizeOptionalString(settings.dt_real_bridge_base_url) || config.DT_REAL_BRIDGE_BASE_URL || "http://127.0.0.1:5175";
  const response = await fetch(`${helperBaseUrl.replace(/\/+$/, "")}/api/v1/dingtone/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      action,
      payload: {
        input
      },
      meta: {
        timeoutMs
      }
    }),
    signal: AbortSignal.timeout(timeoutMs + 10_000)
  }).catch((error) => {
    throw new AppError(`Helper ${action} request failed: ${error instanceof Error ? error.message : String(error)}`, 502, 502);
  });

  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; data?: unknown; error?: { message?: string } }
    | null;
  if (!response.ok || !payload?.ok) {
    const message =
      payload?.error?.message ||
      (payload && typeof payload === "object" && "message" in payload ? String((payload as { message?: unknown }).message ?? "") : "") ||
      `Helper ${action} failed with HTTP ${response.status}`;
    throw new AppError(message, 502, 502);
  }
  return payload.data;
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
