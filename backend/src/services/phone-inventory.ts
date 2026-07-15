import {
  AccountStatus,
  AppVariant,
  PhoneStatus,
  Prisma,
  type PhoneNumber
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { serializePhoneNumber } from "../utils/serializers.js";

export type PhoneInventoryFilters = {
  keyword?: string;
  status?: PhoneStatus;
  countryCode?: number;
  providerId?: number;
};

type InventoryAccount = {
  id: number;
  nickname: string | null;
  appVariant: AppVariant;
  status: AccountStatus;
  monitorEnabled: boolean;
  telegramNotify: boolean;
  sortOrder: number;
};

type InventoryRow = PhoneNumber & { account: InventoryAccount };

type SerializedInventoryAccount = {
  id: number;
  nickname: string | null;
  app_variant: AppVariant;
  status: AccountStatus;
  monitor_enabled: boolean;
  telegram_notify: boolean;
  sort_order: number;
};

export function buildPhoneInventoryWhere(
  adminId: number,
  filters: PhoneInventoryFilters
): Prisma.PhoneNumberWhereInput {
  const keyword = filters.keyword?.trim();
  const numericAccountId = keyword ? Number(keyword) : Number.NaN;
  const accountId = Number.isSafeInteger(numericAccountId) && numericAccountId > 0 ? numericAccountId : null;
  return {
    account: { is: { adminId } },
    ...(filters.status !== undefined ? { status: filters.status } : {}),
    ...(filters.countryCode !== undefined ? { countryCode: filters.countryCode } : {}),
    ...(filters.providerId !== undefined ? { providerId: filters.providerId } : {}),
    ...(keyword
      ? {
          OR: [
            { phoneNumber: { contains: keyword } },
            { displayName: { contains: keyword } },
            { account: { is: { nickname: { contains: keyword } } } },
            ...(accountId === null ? [] : [{ accountId }])
          ]
        }
      : {})
  };
}

export function extractPhoneInventoryMetadata(rawJson: string | null) {
  const raw = safeRecord(rawJson);
  return {
    package_service_id: pickString(raw, ["packageServiceId", "package_service_id", "reserved4"]),
    price: pickNumber(raw, [
      "orderPrice",
      "order_price",
      "price",
      "payAmount",
      "amount",
      "coinCost",
      "needBalance",
      "reserved5"
    ]),
    iso_country_code: pickString(raw, ["isoCountryCode", "iso_country_code", "isoCC", "iso_cc"]),
    city_name: pickString(raw, ["cityName", "city_name"]),
    state_name: pickString(raw, ["stateName", "state_name"])
  };
}

export function buildPhoneInventoryPayload(rows: InventoryRow[], now = new Date()) {
  const groups = new Map<
    number,
    { account: SerializedInventoryAccount; phones: Array<Record<string, unknown>> }
  >();
  let expiringSoon = 0;
  const nowMs = now.getTime();
  const cutoff = nowMs + 30 * 86_400_000;
  const orderedRows = [...rows].sort((left, right) => {
    const accountOrder = left.account.sortOrder - right.account.sortOrder;
    if (accountOrder !== 0) return accountOrder;
    const accountIdOrder = left.accountId - right.accountId;
    if (accountIdOrder !== 0) return accountIdOrder;
    const primaryOrder = Number(right.isPrimary) - Number(left.isPrimary);
    if (primaryOrder !== 0) return primaryOrder;
    return right.createdAt.getTime() - left.createdAt.getTime();
  });

  for (const row of orderedRows) {
    const serialized = serializePhoneNumber(row);
    const { raw_json: _rawJson, ...safePhone } = serialized;
    const expiry = parseEpoch(row.expiredTime);
    if (expiry !== null && expiry >= nowMs && expiry <= cutoff) {
      expiringSoon += 1;
    }
    const group = groups.get(row.accountId) ?? {
      account: {
        id: row.account.id,
        nickname: row.account.nickname,
        app_variant: row.account.appVariant,
        status: row.account.status,
        monitor_enabled: row.account.monitorEnabled,
        telegram_notify: row.account.telegramNotify,
        sort_order: row.account.sortOrder
      },
      phones: []
    };
    group.phones.push({
      ...safePhone,
      ...extractPhoneInventoryMetadata(row.rawJson)
    });
    groups.set(row.accountId, group);
  }

  return {
    summary: {
      total: rows.length,
      active: rows.filter((row) => row.status === PhoneStatus.active).length,
      account_count: groups.size,
      expiring_soon: expiringSoon
    },
    groups: Array.from(groups.values())
  };
}

export async function listPhoneInventory(adminId: number, filters: PhoneInventoryFilters) {
  const rows = await prisma.phoneNumber.findMany({
    where: buildPhoneInventoryWhere(adminId, filters),
    include: {
      account: {
        select: {
          id: true,
          nickname: true,
          appVariant: true,
          status: true,
          monitorEnabled: true,
          telegramNotify: true,
          sortOrder: true
        }
      }
    },
    orderBy: [
      { account: { sortOrder: "asc" } },
      { accountId: "asc" },
      { isPrimary: "desc" },
      { createdAt: "desc" }
    ]
  });
  return buildPhoneInventoryPayload(rows as InventoryRow[]);
}

export type RefreshablePhoneAccount = {
  id: number;
  dtUserId: string | null;
  dtToken: string | null;
};

export type PhoneInventoryRefreshItem = {
  account_id: number;
  status: "success" | "failed" | "skipped";
  phone_count: number;
  error: string | null;
};

export async function refreshPhoneInventoryAccounts(
  accounts: RefreshablePhoneAccount[],
  refreshAccount: (accountId: number) => Promise<Array<{ id: number }>>,
  concurrency = 2
) {
  const results = new Array<PhoneInventoryRefreshItem>(accounts.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(Math.trunc(concurrency), 1), 2, accounts.length || 1);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const account = accounts[index];
      if (!account) {
        return;
      }
      if (!account.dtUserId || !account.dtToken) {
        results[index] = {
          account_id: account.id,
          status: "skipped",
          phone_count: 0,
          error: "缺少有效 Direct 会话"
        };
        continue;
      }
      try {
        const phones = await refreshAccount(account.id);
        results[index] = {
          account_id: account.id,
          status: "success",
          phone_count: phones.length,
          error: null
        };
      } catch (error) {
        results[index] = {
          account_id: account.id,
          status: "failed",
          phone_count: 0,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function safeRecord(value: string | null) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function pickString(record: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function pickNumber(record: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
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
  return null;
}

function parseEpoch(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}
