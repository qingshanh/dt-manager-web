# Global Phone Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个按账户分组的全局手机号管理页面，支持安全查询、筛选、复制、备注修改、单账户刷新和确认后的全量刷新。

**Architecture:** 抽取账户运行时与账户路由中重复的手机号持久化逻辑，新增受管理员作用域约束的手机号资产服务和独立路由。前端新增类型、缓存接口和按账户折叠的 Ant Design 页面，继续复用现有单账户备注与同步能力，不触碰短信监听核心。

**Tech Stack:** TypeScript、Node.js `node:test`、Express、Zod、Prisma/SQLite、React 18、Ant Design、Axios、Vite。

---

## 项目提交约束

用户要求每个新提交都提升版本号，因此本计划执行过程中不做逐任务提交。每个任务完成后只检查工作树和测试结果；两份实施计划全部完成并验证后，在 Telegram 计划的发布任务中统一提升到 `0.2.5` 并创建一次正式提交。

## 文件结构

- Create: `backend/src/services/phone-number-store.ts`：统一号码映射、upsert 和“远端遗漏不删除”策略。
- Create: `backend/src/services/phone-number-store.test.ts`：验证映射、upsert 和保留本地号码。
- Create: `backend/src/services/phone-inventory.ts`：管理员作用域查询、筛选、分组、汇总和全量刷新调度。
- Create: `backend/src/services/phone-inventory.test.ts`：验证筛选、分组、补充元数据和并发上限。
- Create: `backend/src/routes/phone-numbers.ts`：全局查询与全量刷新 HTTP 接口。
- Create: `backend/src/routes/phone-inventory-ui.test.ts`：验证后端挂载、前端路由、菜单和关键交互结构。
- Modify: `backend/src/services/account-runtime.ts`：复用统一的号码持久化服务。
- Modify: `backend/src/routes/accounts.ts`：复用统一持久化服务、导出单账户远端刷新函数并修正同步响应契约。
- Modify: `backend/src/index.ts`：挂载 `/api/phone-numbers`。
- Modify: `backend/src/utils/serializers.ts`：导出安全的号码补充字段提取函数或复用其 JSON 读取逻辑。
- Modify: `frontend/src/types/index.ts`：增加全局手机号响应和刷新结果类型。
- Modify: `frontend/src/services/endpoints.ts`：增加全局查询、缓存和全量刷新接口。
- Create: `frontend/src/pages/PhoneInventory.tsx`：按账户分组的手机号管理页面。
- Modify: `frontend/src/App.tsx`：增加懒加载路由。
- Modify: `frontend/src/layouts/AppLayout.tsx`：增加“手机号管理”菜单项和选中逻辑。

### Task 1: 抽取统一的手机号持久化逻辑

**Files:**
- Create: `backend/src/services/phone-number-store.test.ts`
- Create: `backend/src/services/phone-number-store.ts`
- Modify: `backend/src/services/account-runtime.ts:174-203,416-444`
- Modify: `backend/src/routes/accounts.ts:4310-4344,5070-5182`

- [ ] **Step 1: 写入失败测试，固定 upsert 和保留本地记录行为**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { PhoneStatus } from "@prisma/client";
import { mapPhoneNumberCreate, syncPhoneNumbersWithStore } from "./phone-number-store.js";

test("phone number mapping preserves remote metadata", () => {
  const mapped = mapPhoneNumberCreate(7, {
    phoneNumber: "33700000000",
    countryCode: 33,
    providerId: 2100,
    displayName: "France",
    status: PhoneStatus.active,
    purchaseType: 2,
    payType: 2,
    validPeriodDays: 365,
    gainTime: "1780000000000",
    expiredTime: "1811536000000",
    autoRenew: true,
    isPrimary: false,
    isGoodNumber: false,
    rawJson: JSON.stringify({ packageServiceId: "DT03009" })
  });

  assert.equal(mapped.accountId, 7);
  assert.equal(mapped.phoneNumber, "33700000000");
  assert.equal(mapped.providerId, 2100);
  assert.equal(mapped.rawJson, JSON.stringify({ packageServiceId: "DT03009" }));
});

test("phone synchronization upserts remote rows and never deletes omitted local rows", async () => {
  const upserts: unknown[] = [];
  const result = await syncPhoneNumbersWithStore(
    7,
    [{ phoneNumber: "33700000000", status: "active" }],
    {
      upsert: async (args) => {
        upserts.push(args);
        return {};
      },
      count: async () => 2
    }
  );

  assert.equal(upserts.length, 1);
  assert.equal(result.persisted, 1);
  assert.equal(result.missingLocalCount, 2);
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run:

```powershell
Set-Location -LiteralPath 'D:\work\dt-manager-web\backend'
node --import tsx --test src/services/phone-number-store.test.ts
```

Expected: FAIL，错误包含 `Cannot find module './phone-number-store.js'`。

- [ ] **Step 3: 实现统一持久化服务**

```ts
import { PhoneStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { DingtonePhoneNumber } from "./dingtone/types.js";
import { logger } from "../utils/logger.js";

export type PhoneNumberStore = {
  upsert(args: {
    where: { accountId_phoneNumber: { accountId: number; phoneNumber: string } };
    update: Prisma.PhoneNumberUncheckedUpdateInput;
    create: Prisma.PhoneNumberUncheckedCreateInput;
  }): Promise<unknown>;
  count(args: { where: { accountId: number; phoneNumber: { notIn: string[] } } }): Promise<number>;
};

export function mapPhoneNumberBase(item: Partial<DingtonePhoneNumber>) {
  return {
    countryCode: item.countryCode,
    providerId: item.providerId,
    displayName: item.displayName,
    status: item.status ? (item.status as PhoneStatus) : undefined,
    purchaseType: item.purchaseType,
    payType: item.payType,
    validPeriodDays: item.validPeriodDays,
    gainTime: item.gainTime,
    expiredTime: item.expiredTime,
    autoRenew: item.autoRenew,
    isPrimary: item.isPrimary,
    isGoodNumber: item.isGoodNumber,
    portoutInfo: item.portoutInfo,
    rawJson: item.rawJson ?? JSON.stringify(item)
  };
}

export function mapPhoneNumberCreate(
  accountId: number,
  item: DingtonePhoneNumber
): Prisma.PhoneNumberUncheckedCreateInput {
  return {
    accountId,
    phoneNumber: item.phoneNumber,
    ...mapPhoneNumberBase(item)
  };
}

export function mapPhoneNumberPatch(
  item: Partial<DingtonePhoneNumber>
): Prisma.PhoneNumberUncheckedUpdateInput {
  return mapPhoneNumberBase(item);
}

export async function syncPhoneNumbersWithStore(
  accountId: number,
  phoneNumbers: DingtonePhoneNumber[],
  store: PhoneNumberStore
) {
  const remoteSet = new Set<string>();
  let persisted = 0;
  for (const item of phoneNumbers) {
    if (!item.phoneNumber) continue;
    remoteSet.add(item.phoneNumber);
    await store.upsert({
      where: { accountId_phoneNumber: { accountId, phoneNumber: item.phoneNumber } },
      update: mapPhoneNumberPatch(item),
      create: mapPhoneNumberCreate(accountId, item)
    });
    persisted += 1;
  }

  const missingLocalCount = remoteSet.size
    ? await store.count({ where: { accountId, phoneNumber: { notIn: [...remoteSet] } } })
    : 0;
  return { persisted, missingLocalCount };
}

export async function syncPhoneNumbers(accountId: number, phoneNumbers: DingtonePhoneNumber[]) {
  const result = await syncPhoneNumbersWithStore(
    accountId,
    phoneNumbers,
    prisma.phoneNumber as unknown as PhoneNumberStore
  );
  if (result.missingLocalCount > 0) {
    logger.warn("Remote phone sync omitted local phone records; keeping local rows instead of deleting them", {
      accountId,
      missingCount: result.missingLocalCount
    });
  }
  return result;
}
```

- [ ] **Step 4: 让现有运行时和账户路由复用新服务**

在 `account-runtime.ts` 和 `accounts.ts` 中加入：

```ts
import {
  mapPhoneNumberBase,
  mapPhoneNumberCreate,
  mapPhoneNumberPatch,
  syncPhoneNumbers
} from "../services/phone-number-store.js";
```

`account-runtime.ts` 位于同一 `services` 目录，因此使用：

```ts
import {
  mapPhoneNumberCreate,
  mapPhoneNumberPatch,
  syncPhoneNumbers
} from "./phone-number-store.js";
```

删除两个文件中被新模块替代的本地 `syncPhoneNumbers`、`mapPhoneNumberBase`、`mapPhoneNumberCreate` 和 `mapPhoneNumberPatch` 定义。所有现有调用点保持函数名不变。

- [ ] **Step 5: 运行新测试和现有号码序列化测试**

Run:

```powershell
node --import tsx --test src/services/phone-number-store.test.ts src/utils/serializers.test.ts
```

Expected: PASS，0 failed。

- [ ] **Step 6: 检查本任务差异但不提交**

Run:

```powershell
git -C 'D:\work\dt-manager-web' diff --stat
git -C 'D:\work\dt-manager-web' diff --check
```

Expected: 仅出现上述服务、测试和复用改动；`diff --check` 无输出。

### Task 2: 新增管理员作用域的手机号资产服务与全量刷新调度

**Files:**
- Create: `backend/src/services/phone-inventory.test.ts`
- Create: `backend/src/services/phone-inventory.ts`
- Modify: `backend/src/routes/accounts.ts:2784-2805`

- [ ] **Step 1: 写入失败测试，固定分组、补充字段和并发限制**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { PhoneStatus } from "@prisma/client";
import {
  buildPhoneInventoryPayload,
  buildPhoneInventoryWhere,
  refreshPhoneInventoryAccounts
} from "./phone-inventory.js";

test("phone inventory is scoped, grouped in account order, and hides raw JSON", () => {
  const where = buildPhoneInventoryWhere(3, { keyword: "VMOS", status: PhoneStatus.active });
  assert.deepEqual(where.account, { is: { adminId: 3 } });
  assert.equal(where.status, PhoneStatus.active);

  const payload = buildPhoneInventoryPayload(
    [
      {
        id: 1,
        accountId: 20,
        phoneNumber: "3197005550101",
        countryCode: 31,
        providerId: 2006,
        displayName: "NL",
        status: PhoneStatus.active,
        purchaseType: 2,
        payType: 2,
        validPeriodDays: 365,
        gainTime: "1780000000000",
        expiredTime: "1811536000000",
        autoRenew: true,
        isPrimary: false,
        isGoodNumber: false,
        portoutInfo: null,
        rawJson: JSON.stringify({ packageServiceId: "DT03009", orderPrice: 250 }),
        createdAt: new Date("2026-07-01T00:00:00Z"),
        updatedAt: new Date("2026-07-01T00:00:00Z"),
        account: {
          id: 20,
          nickname: "VMOS",
          appVariant: "dingtone",
          status: "online",
          monitorEnabled: true,
          telegramNotify: true,
          sortOrder: 1
        }
      }
    ],
    new Date("2026-07-15T00:00:00Z")
  );

  assert.equal(payload.summary.total, 1);
  assert.equal(payload.groups[0]?.account.id, 20);
  assert.equal(payload.groups[0]?.phones[0]?.package_service_id, "DT03009");
  assert.equal(payload.groups[0]?.phones[0]?.price, 250);
  assert.equal("raw_json" in (payload.groups[0]?.phones[0] ?? {}), false);
});

test("refresh all limits concurrency and isolates account failures", async () => {
  let active = 0;
  let maxActive = 0;
  const results = await refreshPhoneInventoryAccounts(
    [
      { id: 1, dtUserId: "u1", dtToken: "t1" },
      { id: 2, dtUserId: "u2", dtToken: "t2" },
      { id: 3, dtUserId: null, dtToken: null },
      { id: 4, dtUserId: "u4", dtToken: "t4" }
    ],
    async (accountId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (accountId === 2) throw new Error("refresh failed");
      return [{ id: accountId }];
    },
    2
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(results.map((item) => item.status), ["success", "failed", "skipped", "success"]);
});
```

- [ ] **Step 2: 运行测试并确认缺少模块而失败**

Run:

```powershell
node --import tsx --test src/services/phone-inventory.test.ts
```

Expected: FAIL，错误包含 `Cannot find module './phone-inventory.js'`。

- [ ] **Step 3: 实现查询条件、分组和补充字段提取**

```ts
import { PhoneStatus, Prisma, type PhoneNumber } from "@prisma/client";
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
  appVariant: string;
  status: string;
  monitorEnabled: boolean;
  telegramNotify: boolean;
  sortOrder: number;
};

type InventoryRow = PhoneNumber & { account: InventoryAccount };
type SerializedInventoryAccount = {
  id: number;
  nickname: string | null;
  app_variant: string;
  status: string;
  monitor_enabled: boolean;
  telegram_notify: boolean;
  sort_order: number;
};

export function buildPhoneInventoryWhere(adminId: number, filters: PhoneInventoryFilters): Prisma.PhoneNumberWhereInput {
  const keyword = filters.keyword?.trim();
  const accountId = keyword && /^\d+$/.test(keyword) ? Number(keyword) : null;
  return {
    account: { is: { adminId } },
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.countryCode ? { countryCode: filters.countryCode } : {}),
    ...(filters.providerId ? { providerId: filters.providerId } : {}),
    ...(keyword
      ? {
          OR: [
            { phoneNumber: { contains: keyword } },
            { displayName: { contains: keyword } },
            { account: { is: { nickname: { contains: keyword } } } },
            ...(accountId ? [{ accountId }] : [])
          ]
        }
      : {})
  };
}

export function extractPhoneInventoryMetadata(rawJson: string | null) {
  const raw = safeRecord(rawJson);
  return {
    package_service_id: pickString(raw, ["packageServiceId", "package_service_id"]),
    price: pickNumber(raw, ["orderPrice", "order_price", "price", "reserved5"]),
    iso_country_code: pickString(raw, ["isoCountryCode", "iso_country_code"]),
    city_name: pickString(raw, ["cityName", "city_name"]),
    state_name: pickString(raw, ["stateName", "state_name"])
  };
}

export function buildPhoneInventoryPayload(rows: InventoryRow[], now = new Date()) {
  const groups = new Map<number, { account: SerializedInventoryAccount; phones: Array<Record<string, unknown>> }>();
  let expiringSoon = 0;
  const cutoff = now.getTime() + 30 * 86_400_000;

  for (const row of rows) {
    const serialized = serializePhoneNumber(row);
    const { raw_json: _rawJson, ...safePhone } = serialized;
    const expiry = parseEpoch(row.expiredTime);
    if (expiry !== null && expiry >= now.getTime() && expiry <= cutoff) expiringSoon += 1;
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
    group.phones.push({ ...safePhone, ...extractPhoneInventoryMetadata(row.rawJson) });
    groups.set(row.accountId, group);
  }

  return {
    summary: {
      total: rows.length,
      active: rows.filter((row) => row.status === PhoneStatus.active).length,
      account_count: groups.size,
      expiring_soon: expiringSoon
    },
    groups: [...groups.values()]
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

function safeRecord(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pickString(record: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickNumber(record: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function parseEpoch(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}
```

- [ ] **Step 4: 实现并发上限为 2 的批量刷新调度器**

在同一文件追加：

```ts
export type RefreshablePhoneAccount = {
  id: number;
  dtUserId: string | null;
  dtToken: string | null;
};

export async function refreshPhoneInventoryAccounts(
  accounts: RefreshablePhoneAccount[],
  refreshAccount: (accountId: number) => Promise<Array<{ id: number }>>,
  concurrency = 2
) {
  const results = new Array<{
    account_id: number;
    status: "success" | "failed" | "skipped";
    phone_count: number;
    error: string | null;
  }>(accounts.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), accounts.length || 1) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const account = accounts[index];
      if (!account) return;
      if (!account.dtUserId || !account.dtToken) {
        results[index] = { account_id: account.id, status: "skipped", phone_count: 0, error: "缺少有效 Direct 会话" };
        continue;
      }
      try {
        const phones = await refreshAccount(account.id);
        results[index] = { account_id: account.id, status: "success", phone_count: phones.length, error: null };
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
```

- [ ] **Step 5: 导出单账户远端刷新函数**

将 `accounts.ts` 中的定义改为：

```ts
export async function syncPhoneNumbersFromRemote(accountId: number) {
```

保留其 Direct、helper、ADB 和旧网关回退顺序不变；内部继续调用 Task 1 的 `syncPhoneNumbers`。

- [ ] **Step 6: 运行服务测试**

Run:

```powershell
node --import tsx --test src/services/phone-inventory.test.ts src/services/phone-number-store.test.ts
```

Expected: PASS，0 failed。

### Task 3: 新增全局手机号 HTTP 接口并修正单账户同步契约

**Files:**
- Create: `backend/src/routes/phone-numbers.ts`
- Create: `backend/src/routes/phone-inventory-ui.test.ts`
- Modify: `backend/src/routes/accounts.ts:1563-1571`
- Modify: `backend/src/index.ts:8-14,83-90`

- [ ] **Step 1: 写入失败的路由和响应契约测试**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

test("backend exposes scoped global phone inventory and confirmed refresh", () => {
  const index = read("backend/src/index.ts");
  const route = read("backend/src/routes/phone-numbers.ts");
  const accounts = read("backend/src/routes/accounts.ts");

  assert.match(index, /app\.use\("\/api\/phone-numbers", requireAuth, phoneNumbersRouter\)/);
  assert.match(route, /phoneNumbersRouter\.get\("\/"/);
  assert.match(route, /req\.auth!\.userId/);
  assert.match(route, /phoneNumbersRouter\.post\("\/refresh-all"/);
  assert.match(route, /confirm !== true/);
  assert.match(accounts, /phone_numbers: phoneNumbers\.map\(serializePhoneNumber\)/);
  assert.match(accounts, /refresh_error: null/);
  assert.match(accounts, /cached: false/);
});
```

- [ ] **Step 2: 运行测试并确认路由文件不存在**

Run:

```powershell
node --import tsx --test src/routes/phone-inventory-ui.test.ts
```

Expected: FAIL，错误指出 `backend/src/routes/phone-numbers.ts` 不存在。

- [ ] **Step 3: 实现独立路由**

```ts
import { PhoneStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  listPhoneInventory,
  refreshPhoneInventoryAccounts
} from "../services/phone-inventory.js";
import { AppError } from "../utils/errors.js";
import { ok } from "../utils/response.js";
import { syncPhoneNumbersFromRemote } from "./accounts.js";

const querySchema = z.object({
  keyword: z.string().trim().optional(),
  status: z.nativeEnum(PhoneStatus).optional(),
  country_code: z.coerce.number().int().positive().optional(),
  provider_id: z.coerce.number().int().nonnegative().optional()
});

const refreshSchema = z.object({
  confirm: z.boolean().optional().default(false)
});

export const phoneNumbersRouter = Router();

phoneNumbersRouter.get("/", async (req, res, next) => {
  try {
    const query = querySchema.parse(req.query);
    ok(res, await listPhoneInventory(req.auth!.userId, {
      keyword: query.keyword,
      status: query.status,
      countryCode: query.country_code,
      providerId: query.provider_id
    }));
  } catch (error) {
    next(error);
  }
});

phoneNumbersRouter.post("/refresh-all", async (req, res, next) => {
  try {
    const body = refreshSchema.parse(req.body ?? {});
    if (body.confirm !== true) throw new AppError("Refreshing all phone numbers requires confirm=true", 400, 400);
    const accounts = await prisma.dtAccount.findMany({
      where: { adminId: req.auth!.userId },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { id: true, dtUserId: true, dtToken: true }
    });
    const results = await refreshPhoneInventoryAccounts(accounts, syncPhoneNumbersFromRemote, 2);
    ok(res, {
      success: results.filter((item) => item.status === "success").length,
      failed: results.filter((item) => item.status === "failed").length,
      skipped: results.filter((item) => item.status === "skipped").length,
      results
    });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: 挂载路由并修正单账户同步响应**

在 `backend/src/index.ts` 导入并挂载：

```ts
import { phoneNumbersRouter } from "./routes/phone-numbers.js";

app.use("/api/phone-numbers", requireAuth, phoneNumbersRouter);
```

将账户同步接口响应改为：

```ts
const phoneNumbers = await syncPhoneNumbersFromRemote(accountId);
ok(res, {
  phone_numbers: phoneNumbers.map(serializePhoneNumber),
  refresh_error: null,
  cached: false
});
```

- [ ] **Step 5: 运行路由与现有账户回归测试**

Run:

```powershell
node --import tsx --test src/routes/phone-inventory-ui.test.ts src/routes/accounts-list-visibility.test.ts src/routes/management-upgrades.test.ts
```

Expected: PASS，0 failed。

### Task 4: 增加前端类型、缓存和接口调用

**Files:**
- Modify: `frontend/src/types/index.ts:241-327`
- Modify: `frontend/src/services/endpoints.ts:45-72,433-450`
- Modify: `backend/src/routes/phone-inventory-ui.test.ts`

- [ ] **Step 1: 扩展结构测试，先固定前端类型和 API 名称**

在 `phone-inventory-ui.test.ts` 追加：

```ts
test("frontend exposes phone inventory types and endpoints", () => {
  const types = read("frontend/src/types/index.ts");
  const endpoints = read("frontend/src/services/endpoints.ts");
  assert.match(types, /export interface PhoneInventoryResponse/);
  assert.match(types, /export interface PhoneInventoryGroup/);
  assert.match(types, /export interface PhoneInventoryRefreshResult/);
  assert.match(endpoints, /phoneInventory: \(params[\s\S]*makeCacheKey\(`phone-inventory:all`/);
  assert.match(endpoints, /export async function getPhoneInventory/);
  assert.match(endpoints, /export async function refreshAllPhoneNumbers/);
});
```

- [ ] **Step 2: 运行测试并确认类型和函数缺失**

Run:

```powershell
node --import tsx --test src/routes/phone-inventory-ui.test.ts
```

Expected: FAIL，缺少 `PhoneInventoryResponse` 或 `getPhoneInventory`。

- [ ] **Step 3: 增加前端类型**

```ts
export interface PhoneInventoryPhone extends Omit<PhoneNumber, 'raw_json'> {
  area_code: number | null;
  package_service_id: string | null;
  price: number | null;
  iso_country_code: string | null;
  city_name: string | null;
  state_name: string | null;
}

export interface PhoneInventoryGroup {
  account: {
    id: number;
    nickname: string | null;
    app_variant: AppVariant;
    status: AccountStatus;
    monitor_enabled: boolean;
    telegram_notify: boolean;
    sort_order: number;
  };
  phones: PhoneInventoryPhone[];
}

export interface PhoneInventoryResponse {
  summary: {
    total: number;
    active: number;
    account_count: number;
    expiring_soon: number;
  };
  groups: PhoneInventoryGroup[];
}

export interface PhoneInventoryRefreshResult {
  success: number;
  failed: number;
  skipped: number;
  results: Array<{
    account_id: number;
    status: 'success' | 'failed' | 'skipped';
    phone_count: number;
    error: string | null;
  }>;
}
```

- [ ] **Step 4: 增加缓存键和接口**

```ts
phoneInventory: (params?: Record<string, unknown>) => makeCacheKey(`phone-inventory:all`, params ?? {}),
```

```ts
export async function getPhoneInventory(
  params?: { keyword?: string; status?: PhoneStatus; country_code?: number; provider_id?: number },
  options?: CacheOptions,
) {
  return fetchCachedData(cacheKeys.phoneInventory(params), CACHE_TTL_MS.phoneNumbers, async () => {
    const res = await api.get<ApiResponse<PhoneInventoryResponse>>('/phone-numbers', { params });
    return res.data.data;
  }, options);
}

export async function refreshAllPhoneNumbers() {
  const res = await api.post<ApiResponse<PhoneInventoryRefreshResult>>(
    '/phone-numbers/refresh-all',
    { confirm: true },
    { timeout: 180_000 },
  );
  invalidateCachedData('phone-inventory:');
  invalidateCachedData('accounts:');
  return res.data.data;
}
```

在 `invalidateAccountCaches` 中同时加入：

```ts
invalidateCachedData('phone-inventory:');
```

- [ ] **Step 5: 运行结构测试和前端构建**

Run:

```powershell
Set-Location -LiteralPath 'D:\work\dt-manager-web\backend'
node --import tsx --test src/routes/phone-inventory-ui.test.ts
npm --prefix 'D:\work\dt-manager-web\frontend' run build
```

Expected: 结构测试 PASS；前端构建 exit 0。

### Task 5: 实现按账户分组的手机号管理页面

**Files:**
- Create: `frontend/src/pages/PhoneInventory.tsx`
- Modify: `frontend/src/App.tsx:8-15,75-90`
- Modify: `frontend/src/layouts/AppLayout.tsx:1-38,81-88`
- Modify: `backend/src/routes/phone-inventory-ui.test.ts`

- [ ] **Step 1: 写入失败的页面路由与交互结构测试**

在 `phone-inventory-ui.test.ts` 追加：

```ts
test("phone inventory page is routed, grouped, filterable, and limited to safe actions", () => {
  const app = read("frontend/src/App.tsx");
  const layout = read("frontend/src/layouts/AppLayout.tsx");
  const page = read("frontend/src/pages/PhoneInventory.tsx");
  assert.match(app, /const PhoneInventory = lazy\(\(\) => import\('\.\/pages\/PhoneInventory'\)\)/);
  assert.match(app, /path="phone-numbers" element=\{<PhoneInventory \/>\}/);
  assert.match(layout, /key: '\/phone-numbers'/);
  assert.match(layout, /label: '手机号管理'/);
  assert.match(page, /getPhoneInventory/);
  assert.match(page, /refreshAllPhoneNumbers/);
  assert.match(page, /syncPhoneNumbers/);
  assert.match(page, /updatePhoneNumberLabel/);
  assert.match(page, /navigate\(`\/accounts\/\$\{group\.account\.id\}`\)/);
  assert.match(page, /刷新全部/);
  assert.doesNotMatch(page, /renewPhoneNumber|pausePhoneNumber|resumePhoneNumber|cancelPhoneNumber|purchasePhoneNumber/);
});
```

- [ ] **Step 2: 运行测试并确认页面文件不存在**

Run:

```powershell
node --import tsx --test src/routes/phone-inventory-ui.test.ts
```

Expected: FAIL，错误指出 `PhoneInventory.tsx` 不存在。

- [ ] **Step 3: 新增路由和菜单**

在 `App.tsx` 增加：

```tsx
const PhoneInventory = lazy(() => import('./pages/PhoneInventory'));
```

```tsx
<Route path="phone-numbers" element={<PhoneInventory />} />
```

在 `AppLayout.tsx` 导入 `PhoneOutlined`，增加：

```tsx
{ key: '/phone-numbers', icon: <PhoneOutlined />, label: '手机号管理' },
```

并在 `selectedKey` 中优先匹配：

```ts
if (path.startsWith('/phone-numbers')) return '/phone-numbers';
```

- [ ] **Step 4: 实现页面的数据加载和安全操作处理器**

`PhoneInventory.tsx` 使用以下完整状态和处理器骨架；渲染只消费这些状态，不再自行发请求：

```tsx
import {
  CopyOutlined,
  EditOutlined,
  ReloadOutlined,
  RightOutlined,
} from '@ant-design/icons';
import {
  App,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getPhoneInventory,
  refreshAllPhoneNumbers,
  syncPhoneNumbers,
  updatePhoneNumberLabel,
} from '../services/endpoints';
import type {
  PhoneInventoryGroup,
  PhoneInventoryPhone,
  PhoneInventoryResponse,
  PhoneStatus,
} from '../types';

const EMPTY_DATA: PhoneInventoryResponse = {
  summary: { total: 0, active: 0, account_count: 0, expiring_soon: 0 },
  groups: [],
};

export default function PhoneInventory() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<PhoneInventoryResponse>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [status, setStatus] = useState<PhoneStatus | undefined>();
  const [countryCode, setCountryCode] = useState<number | undefined>();
  const [providerId, setProviderId] = useState<number | undefined>();
  const [refreshingAccountId, setRefreshingAccountId] = useState<number | null>(null);
  const [detailPhone, setDetailPhone] = useState<PhoneInventoryPhone | null>(null);
  const [editing, setEditing] = useState<{ accountId: number; phone: PhoneInventoryPhone } | null>(null);
  const [noteForm] = Form.useForm<{ display_name: string }>();

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      setData(await getPhoneInventory({
        keyword: appliedKeyword || undefined,
        status,
        country_code: countryCode,
        provider_id: providerId,
      }, { force }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载手机号失败');
    } finally {
      setLoading(false);
    }
  }, [appliedKeyword, countryCode, message, providerId, status]);

  useEffect(() => { void load(); }, [load]);

  const copyPhone = useCallback(async (phone: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(phone);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = phone;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      if (!document.execCommand('copy')) throw new Error('复制失败');
      document.body.removeChild(textarea);
    }
    message.success('copied');
  }, [message]);

  const refreshGroup = useCallback(async (accountId: number) => {
    setRefreshingAccountId(accountId);
    try {
      await syncPhoneNumbers(accountId);
      await load(true);
      message.success(`账户 #${accountId} 的号码已刷新`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '刷新账户号码失败');
    } finally {
      setRefreshingAccountId(null);
    }
  }, [load, message]);

  const refreshAll = useCallback(() => {
    modal.confirm({
      title: '刷新全部账户手机号？',
      content: '后端会以最多 2 个账户并发执行；单个账户失败不会中断其他账户。',
      okText: '确认刷新',
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await refreshAllPhoneNumbers();
          await load(true);
          message.success(`刷新完成：成功 ${result.success}，失败 ${result.failed}，跳过 ${result.skipped}`);
        } catch (error) {
          message.error(error instanceof Error ? error.message : '刷新全部号码失败');
          throw error;
        }
      },
    });
  }, [load, message, modal]);

  const saveNote = useCallback(async () => {
    if (!editing) return;
    const values = await noteForm.validateFields();
    await updatePhoneNumberLabel(editing.accountId, editing.phone.id, values);
    setEditing(null);
    await load(true);
    message.success('号码备注已更新');
  }, [editing, load, message, noteForm]);

  const countryOptions = useMemo(() => uniqueOptions(data.groups, (phone) => phone.country_code), [data.groups]);
  const providerOptions = useMemo(() => uniqueOptions(data.groups, (phone) => phone.provider_id), [data.groups]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <div>
          <Typography.Title level={2} style={{ marginBottom: 0 }}>手机号管理</Typography.Title>
          <Typography.Text type="secondary">按账户查看所有已购手机号，默认使用本地数据库。</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={refreshAll}>刷新全部</Button>
      </Space>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <Card><Statistic title="全部号码" value={data.summary.total} /></Card>
        <Card><Statistic title="正常号码" value={data.summary.active} /></Card>
        <Card><Statistic title="所属账户" value={data.summary.account_count} /></Card>
        <Card><Statistic title="30 天内到期" value={data.summary.expiring_soon} /></Card>
      </div>

      <Card>
        <Space wrap>
          <Input.Search
            allowClear
            style={{ width: 280 }}
            placeholder="搜索手机号、备注、账户名称或账户 ID"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onSearch={(value) => setAppliedKeyword(value.trim())}
          />
          <Select
            allowClear
            style={{ width: 140 }}
            placeholder="号码状态"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'active', label: '正常' },
              { value: 'paused', label: '暂停' },
              { value: 'expired', label: '已到期' },
              { value: 'cancelled', label: '已取消' },
              { value: 'pending', label: '处理中' },
            ]}
          />
          <Select allowClear showSearch style={{ width: 140 }} placeholder="国家码" value={countryCode} onChange={setCountryCode} options={countryOptions} />
          <Select allowClear showSearch style={{ width: 160 }} placeholder="Provider" value={providerId} onChange={setProviderId} options={providerOptions} />
          <Button onClick={() => setAppliedKeyword(keyword.trim())}>应用筛选</Button>
        </Space>
      </Card>

      <Card loading={loading} styles={{ body: { padding: 12 } }}>
        {data.groups.length === 0 ? (
          <Empty description="没有符合条件的手机号" />
        ) : (
          <Collapse
            defaultActiveKey={data.groups.map((group) => String(group.account.id))}
            items={data.groups.map((group) => ({
              key: String(group.account.id),
              label: (
                <Space wrap>
                  <Typography.Text strong>#{group.account.id} {group.account.nickname || '未命名账户'}</Typography.Text>
                  <Tag>{group.account.app_variant}</Tag>
                  <Tag color={group.account.status === 'online' ? 'success' : 'default'}>{group.account.status}</Tag>
                  <Tag color={group.account.monitor_enabled ? 'processing' : 'default'}>监听{group.account.monitor_enabled ? '中' : '停'}</Tag>
                  <Tag color={group.account.telegram_notify ? 'blue' : 'default'}>TG{group.account.telegram_notify ? '开' : '关'}</Tag>
                  <Tag>{group.phones.length} 个号码</Tag>
                </Space>
              ),
              extra: (
                <Space onClick={(event) => event.stopPropagation()}>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={refreshingAccountId === group.account.id}
                    onClick={() => void refreshGroup(group.account.id)}
                  >刷新</Button>
                  <Button size="small" icon={<RightOutlined />} onClick={() => navigate(`/accounts/${group.account.id}`)}>账户详情</Button>
                </Space>
              ),
              children: (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
                  {group.phones.map((phone) => (
                    <Card key={phone.id} size="small" title={<Typography.Text copyable={false}>{formatPhone(phone)}</Typography.Text>}>
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Space wrap>
                          <Tag color={statusColor(phone.status)}>{phone.status}</Tag>
                          {phone.display_name && <Tag>{phone.display_name}</Tag>}
                          {phone.is_primary && <Tag color="gold">主号码</Tag>}
                          {phone.is_good_number && <Tag color="purple">靓号</Tag>}
                          <Tag color={phone.allow_receive_sms === false ? 'error' : phone.allow_receive_sms === true ? 'success' : 'default'}>
                            短信{phone.allow_receive_sms === false ? '关闭' : phone.allow_receive_sms === true ? '开启' : '未知'}
                          </Tag>
                        </Space>
                        <Descriptions size="small" column={2} colon={false}>
                          <Descriptions.Item label="国家码">{phone.country_code ? `+${phone.country_code}` : '-'}</Descriptions.Item>
                          <Descriptions.Item label="Provider">{phone.provider_id ?? '-'}</Descriptions.Item>
                          <Descriptions.Item label="获得时间">{formatDate(phone.gain_time)}</Descriptions.Item>
                          <Descriptions.Item label="到期时间">{formatDate(phone.expired_time)}</Descriptions.Item>
                        </Descriptions>
                        <Space wrap>
                          <Button size="small" icon={<CopyOutlined />} onClick={() => void copyPhone(phone.phone_number)}>复制</Button>
                          <Button
                            size="small"
                            icon={<EditOutlined />}
                            onClick={() => {
                              setEditing({ accountId: group.account.id, phone });
                              noteForm.setFieldsValue({ display_name: phone.display_name ?? '' });
                            }}
                          >修改备注</Button>
                          <Button size="small" onClick={() => setDetailPhone(phone)}>完整详情</Button>
                        </Space>
                      </Space>
                    </Card>
                  ))}
                </div>
              ),
            }))}
          />
        )}
      </Card>

      <Drawer title="手机号详情" open={Boolean(detailPhone)} onClose={() => setDetailPhone(null)} width={480}>
        {detailPhone && (
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="手机号">{formatPhone(detailPhone)}</Descriptions.Item>
            <Descriptions.Item label="备注">{detailPhone.display_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="状态">{detailPhone.status}</Descriptions.Item>
            <Descriptions.Item label="国家码">{detailPhone.country_code ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="Provider">{detailPhone.provider_id ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="套餐 ID">{detailPhone.package_service_id || '-'}</Descriptions.Item>
            <Descriptions.Item label="价格">{detailPhone.price ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="获得时间">{formatDate(detailPhone.gain_time)}</Descriptions.Item>
            <Descriptions.Item label="到期时间">{formatDate(detailPhone.expired_time)}</Descriptions.Item>
            <Descriptions.Item label="有效期天数">{detailPhone.valid_period_days ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="自动续费">{detailPhone.auto_renew ? '是' : '否'}</Descriptions.Item>
            <Descriptions.Item label="短信接收">{detailPhone.allow_receive_sms === null ? '未知' : detailPhone.allow_receive_sms ? '开启' : '关闭'}</Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>

      <Modal title="修改号码备注" open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={() => void saveNote()}>
        <Form form={noteForm} layout="vertical">
          <Form.Item name="display_name" label="备注" rules={[{ max: 100, message: '备注不能超过 100 个字符' }]}>
            <Input allowClear />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
```

辅助函数使用确定实现：

```tsx
function uniqueOptions(
  groups: PhoneInventoryGroup[],
  pick: (phone: PhoneInventoryPhone) => number | null,
) {
  return [...new Set(groups.flatMap((group) => group.phones.map(pick)).filter((value): value is number => value !== null))]
    .sort((left, right) => left - right)
    .map((value) => ({ value, label: String(value) }));
}

function formatPhone(phone: PhoneInventoryPhone) {
  return phone.country_code && !phone.phone_number.startsWith(String(phone.country_code))
    ? `+${phone.country_code} ${phone.phone_number}`
    : `+${phone.phone_number}`;
}

function statusColor(status: PhoneStatus) {
  return { active: 'success', paused: 'warning', expired: 'default', cancelled: 'error', pending: 'processing' }[status];
}

function formatDate(value: string | null) {
  if (!value) return '-';
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
```

- [ ] **Step 5: 运行结构测试和前端构建**

Run:

```powershell
Set-Location -LiteralPath 'D:\work\dt-manager-web\backend'
node --import tsx --test src/routes/phone-inventory-ui.test.ts
npm --prefix 'D:\work\dt-manager-web\frontend' run build
```

Expected: PASS；Vite 构建 exit 0。

### Task 6: 验证手机号子系统并检查真实数据库页面

**Files:**
- Modify only if verification reveals a failing requirement from Tasks 1-5.

- [ ] **Step 1: 运行手机号相关测试**

```powershell
Set-Location -LiteralPath 'D:\work\dt-manager-web\backend'
node --import tsx --test src/services/phone-number-store.test.ts src/services/phone-inventory.test.ts src/routes/phone-inventory-ui.test.ts src/utils/serializers.test.ts src/routes/management-upgrades.test.ts
```

Expected: PASS，0 failed。

- [ ] **Step 2: 运行后端构建**

```powershell
npm run build
```

Expected: `tsc -p tsconfig.json` exit 0。

- [ ] **Step 3: 运行前端生产构建**

```powershell
npm --prefix 'D:\work\dt-manager-web\frontend' run build
```

Expected: `tsc -b && vite build` exit 0。

- [ ] **Step 4: 用真实数据库验证页面**

在当前开发服务中访问：

```text
http://127.0.0.1:5173/phone-numbers
```

验证：

1. 显示 29 个号码和 9 个所属账户。
2. 账户顺序与账户列表一致。
3. 搜索账户名称、账户 ID、号码和备注均可缩小结果。
4. Provider `2100` 与国家码 `33` 的筛选能显示法国号码组。
5. 账户跳转进入正确的 `/accounts/:id`。
6. 复制号码显示 `copied`。
7. 修改备注后页面和账户详情一致。
8. 单账户刷新只刷新对应账户。
9. 全量刷新弹出二次确认并显示成功/失败/跳过汇总。
10. 页面中没有续费、暂停、恢复、取消或购号按钮。

- [ ] **Step 5: 检查工作树但不提交**

```powershell
git -C 'D:\work\dt-manager-web' status --short
git -C 'D:\work\dt-manager-web' diff --check
```

Expected: 只包含设计文档、计划文档和手机号子系统改动；`diff --check` 无输出。
