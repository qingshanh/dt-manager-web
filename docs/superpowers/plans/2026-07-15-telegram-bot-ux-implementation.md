# Telegram Bot UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Telegram Bot 改造成按钮优先、消息清晰、原消息可更新的分层控制面板，同时保留现有命令和危险操作确认机制。

**Architecture:** 扩展 Telegram API 传输层的 HTML 和消息编辑能力，新增纯函数回调协议与格式化模块，再由现有 `telegram-bot.ts` 负责数据库查询和安全操作执行。购号及号码生命周期危险操作继续只走命令，通知文本复用统一的 HTML 卡片格式，并保留编辑失败发送新消息的回退路径。

**Tech Stack:** TypeScript、Node.js `node:test`、Telegram Bot HTTP API、Prisma、现有 Direct 网关与账户监听服务。

---

## 项目提交约束

本计划继续沿用“一次发布、一次提交”策略。完成手机号计划和本计划的全部验证后统一提升版本到 `0.2.5`，创建一个正式提交，不推送远程，除非用户另行要求。

## 文件结构

- Modify: `backend/src/services/telegram.ts`：支持 HTML、编辑消息和编辑失败判断。
- Modify: `backend/src/services/telegram.test.ts`：验证 API 方法、请求体和有限超时。
- Create: `backend/src/services/telegram-bot-callbacks.ts`：短回调协议、解析和分页。
- Create: `backend/src/services/telegram-bot-callbacks.test.ts`：验证回调长度、解析、分页和危险操作缺失。
- Create: `backend/src/services/telegram-bot-ui.ts`：HTML 转义、文本格式化和按钮键盘。
- Create: `backend/src/services/telegram-bot-ui.test.ts`：验证排版、转义、长度和按钮层级。
- Modify: `backend/src/services/telegram-bot.ts`：使用新回调和 UI 模块，编辑原消息并支持分层菜单。
- Create: `backend/src/services/telegram-bot-integration.test.ts`：结构回归，确保旧命令保留且危险按钮不存在。
- Modify: `backend/src/services/telegram-notifier.ts`：短信、号码和积分商城通知使用统一 HTML 卡片。
- Create: `backend/src/services/telegram-notifier.test.ts`：验证通知字段、验证码和 HTML 安全。
- Modify: `backend/src/scripts/verify-direct-regression.ts`：更新 Telegram 文案与按钮回归检查。
- Create: `backend/src/services/version-sync.test.ts`：验证所有受控版本引用一致。
- Modify: `VERSION`、`.env.example`、`docker-compose.yml`、`start.ps1`、`backend/package.json`、`backend/package-lock.json`、`backend/src/config.ts`、`frontend/package.json`、`frontend/package-lock.json`、`frontend/Dockerfile`、`frontend/vite.config.ts`：统一版本 `0.2.5`。
- Modify local only: `.env`：只更新 `APP_VERSION` 和 `VITE_APP_VERSION`，不暂存、不提交。

### Task 1: 扩展 Telegram API 传输层

**Files:**
- Modify: `backend/src/services/telegram.test.ts`
- Modify: `backend/src/services/telegram.ts:5-37`

- [ ] **Step 1: 先写失败测试，固定 HTML 和编辑消息请求**

在 `telegram.test.ts` 追加：

```ts
test("telegram sendMessage supports HTML parse mode", async () => {
  const originalFetch = globalThis.fetch;
  let method = "";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    method = String(url);
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 15 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const service = new TelegramService();
    const messageId = await service.sendMessage({
      botToken: "token",
      chatId: "123",
      text: "<b>状态</b>",
      parseMode: "HTML"
    });
    assert.match(method, /sendMessage$/);
    assert.equal(body.parse_mode, "HTML");
    assert.equal(messageId, "15");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telegram editMessageText sends chat and message ids", async () => {
  const originalFetch = globalThis.fetch;
  let method = "";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    method = String(url);
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const service = new TelegramService();
    await service.editMessageText({
      botToken: "token",
      chatId: "123",
      messageId: 99,
      text: "<b>完成</b>",
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [] }
    });
    assert.match(method, /editMessageText$/);
    assert.equal(body.chat_id, "123");
    assert.equal(body.message_id, 99);
    assert.equal(body.parse_mode, "HTML");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: 运行测试并确认类型或方法缺失**

Run:

```powershell
Set-Location -LiteralPath 'D:\work\dt-manager-web\backend'
node --import tsx --test src/services/telegram.test.ts
```

Expected: FAIL，错误包含 `parseMode does not exist` 或 `editMessageText is not a function`。

- [ ] **Step 3: 实现 HTML 和编辑消息能力**

```ts
type TelegramParseMode = "HTML";

type TelegramMessageInput = {
  botToken: string;
  chatId: string;
  text: string;
  apiBaseUrl?: string | null;
  replyMarkup?: unknown;
  parseMode?: TelegramParseMode;
};

export class TelegramService {
  async sendMessage(input: TelegramMessageInput) {
    if (!input.botToken || !input.chatId) {
      throw new AppError("Telegram config is incomplete", 400, 400);
    }
    const json = await this.callApi<{ result?: { message_id?: number } }>(input.botToken, "sendMessage", {
      chat_id: input.chatId,
      text: input.text,
      ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {})
    }, input.apiBaseUrl);
    return json.result?.message_id?.toString() ?? "";
  }

  async editMessageText(input: TelegramMessageInput & { messageId: number }) {
    if (!input.botToken || !input.chatId || !Number.isInteger(input.messageId)) {
      throw new AppError("Telegram edit config is incomplete", 400, 400);
    }
    await this.callApi(input.botToken, "editMessageText", {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {})
    }, input.apiBaseUrl);
  }

  // 保留现有 setMyCommands、answerCallbackQuery、getUpdates 和 callApi 实现。
}
```

- [ ] **Step 4: 运行 Telegram 传输层测试**

Run:

```powershell
node --import tsx --test src/services/telegram.test.ts
```

Expected: PASS，包含现有有限 `AbortSignal` 测试和新增两个测试。

### Task 2: 建立短回调协议和分页规则

**Files:**
- Create: `backend/src/services/telegram-bot-callbacks.test.ts`
- Create: `backend/src/services/telegram-bot-callbacks.ts`

- [ ] **Step 1: 写失败测试，固定回调类型、长度和危险操作边界**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeTelegramCallback,
  parseTelegramCallback,
  paginateTelegramItems
} from "./telegram-bot-callbacks.js";

test("telegram callbacks round-trip and stay below 64 bytes", () => {
  const callbacks = [
    { scope: "panel", action: "accounts", page: 2 },
    { scope: "account", action: "detail", accountId: 433 },
    { scope: "account", action: "phones", accountId: 433, page: 3 },
    { scope: "phone", action: "detail", accountId: 433, phoneId: 91 }
  ] as const;
  for (const callback of callbacks) {
    const encoded = encodeTelegramCallback(callback);
    assert.ok(Buffer.byteLength(encoded, "utf8") <= 64);
    assert.deepEqual(parseTelegramCallback(encoded), callback);
  }
});

test("telegram callback protocol has no dangerous phone actions", () => {
  const source = ["buy", "renew", "pause", "resume", "cancel"];
  for (const action of source) {
    assert.equal(parseTelegramCallback(`n:1:${action}`), null);
  }
});

test("pagination clamps invalid pages", () => {
  const page = paginateTelegramItems([1, 2, 3, 4, 5], 99, 2);
  assert.equal(page.page, 3);
  assert.deepEqual(page.items, [5]);
  assert.equal(page.totalPages, 3);
});
```

- [ ] **Step 2: 运行测试并确认模块不存在**

```powershell
node --import tsx --test src/services/telegram-bot-callbacks.test.ts
```

Expected: FAIL，缺少 `telegram-bot-callbacks.js`。

- [ ] **Step 3: 实现回调联合类型和编码**

```ts
export type TelegramPanelCallback =
  | { scope: "panel"; action: "root" | "status" | "messages" | "help" }
  | { scope: "panel"; action: "accounts" | "phones"; page: number }
  | { scope: "account"; action: "detail" | "messages" | "refresh" | "refresh_phones" | "monitor" | "notify"; accountId: number }
  | { scope: "account"; action: "phones"; accountId: number; page: number }
  | { scope: "phone"; action: "detail" | "note"; accountId: number; phoneId: number };

const PANEL_CODES = { root: "r", status: "s", messages: "m", help: "h", accounts: "a", phones: "n" } as const;
const ACCOUNT_CODES = { detail: "d", messages: "m", phones: "n", refresh: "r", refresh_phones: "f", monitor: "o", notify: "t" } as const;
const PHONE_CODES = { detail: "d", note: "e" } as const;

export function encodeTelegramCallback(callback: TelegramPanelCallback) {
  if (callback.scope === "panel") {
    const base = `p:${PANEL_CODES[callback.action]}`;
    return "page" in callback ? `${base}:${callback.page}` : base;
  }
  if (callback.scope === "account") {
    const base = `a:${callback.accountId}:${ACCOUNT_CODES[callback.action]}`;
    return "page" in callback ? `${base}:${callback.page}` : base;
  }
  return `n:${callback.accountId}:${callback.phoneId}:${PHONE_CODES[callback.action]}`;
}

export function parseTelegramCallback(value: string | undefined): TelegramPanelCallback | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts[0] === "p") {
    const action = reverseCode(PANEL_CODES, parts[1]);
    if (!action) return null;
    if (action === "accounts" || action === "phones") return { scope: "panel", action, page: positive(parts[2], 1) };
    return { scope: "panel", action };
  }
  if (parts[0] === "a") {
    const accountId = positive(parts[1]);
    const action = reverseCode(ACCOUNT_CODES, parts[2]);
    if (!accountId || !action) return null;
    if (action === "phones") return { scope: "account", action, accountId, page: positive(parts[3], 1) };
    return { scope: "account", action, accountId };
  }
  if (parts[0] === "n") {
    const accountId = positive(parts[1]);
    const phoneId = positive(parts[2]);
    const action = reverseCode(PHONE_CODES, parts[3]);
    return accountId && phoneId && action ? { scope: "phone", action, accountId, phoneId } : null;
  }
  return null;
}

export function paginateTelegramItems<T>(items: T[], requestedPage: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(Number.isInteger(requestedPage) ? requestedPage : 1, 1), totalPages);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, totalPages };
}

function positive(value: string | undefined, fallback?: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function reverseCode<T extends Record<string, string>>(record: T, value: string | undefined) {
  return (Object.keys(record) as Array<keyof T>).find((key) => record[key] === value) as keyof T | undefined;
}
```

- [ ] **Step 4: 运行回调测试**

```powershell
node --import tsx --test src/services/telegram-bot-callbacks.test.ts
```

Expected: PASS，0 failed。

### Task 3: 建立 HTML 格式化和按钮构建模块

**Files:**
- Create: `backend/src/services/telegram-bot-ui.test.ts`
- Create: `backend/src/services/telegram-bot-ui.ts`

- [ ] **Step 1: 写失败测试，固定转义、卡片排版和安全按钮**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  accountActionKeyboard,
  escapeTelegramHtml,
  formatAccountCard,
  formatPhoneCard,
  formatRecentMessagesCard,
  mainPanelKeyboard
} from "./telegram-bot-ui.js";

test("telegram HTML escapes account and message content", () => {
  assert.equal(escapeTelegramHtml('<b>A&B</b>'), '&lt;b&gt;A&amp;B&lt;/b&gt;');
  const text = formatAccountCard({
    id: 1,
    name: '<admin>',
    appVariant: 'dingtone',
    status: 'online',
    monitorEnabled: true,
    telegramNotify: true,
    phoneCount: 2,
    unreadCount: 1,
    lastError: 'A&B'
  });
  assert.match(text, /&lt;admin&gt;/);
  assert.match(text, /A&amp;B/);
});

test("telegram phone card uses code formatting and a note command", () => {
  const text = formatPhoneCard({
    accountId: 433,
    id: 91,
    phoneNumber: '3197005550101',
    displayName: 'NL',
    status: 'active',
    countryCode: 31,
    providerId: 2006,
    expiredTime: '1811536000000',
    autoRenew: true,
    allowReceiveSms: true
  });
  assert.match(text, /<code>3197005550101<\/code>/);
  assert.match(text, /\/set_phone_note 433 91/);
});

test("telegram keyboards expose safe actions only", () => {
  const buttons = JSON.stringify([
    mainPanelKeyboard(),
    accountActionKeyboard({ id: 433, monitorEnabled: true, telegramNotify: false })
  ]);
  assert.match(buttons, /账户管理/);
  assert.match(buttons, /手机号管理/);
  assert.doesNotMatch(buttons, /购号|续费|暂停|恢复|取消/);
});

test("recent messages include account and target number", () => {
  const text = formatRecentMessagesCard([{ accountName: 'VMOS', toNumber: '3197', fromNumber: 'OPENAI', content: 'code 123456', receivedAt: new Date('2026-07-15T00:00:00Z') }]);
  assert.match(text, /VMOS/);
  assert.match(text, /3197/);
  assert.match(text, /123456/);
});
```

- [ ] **Step 2: 运行测试并确认模块不存在**

```powershell
node --import tsx --test src/services/telegram-bot-ui.test.ts
```

Expected: FAIL，缺少 `telegram-bot-ui.js`。

- [ ] **Step 3: 实现统一格式化函数**

```ts
import { encodeTelegramCallback } from "./telegram-bot-callbacks.js";

export function escapeTelegramHtml(value: unknown) {
  return String(value ?? "-")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatAccountCard(input: {
  id: number;
  name: string;
  appVariant: string;
  status: string;
  monitorEnabled: boolean;
  telegramNotify: boolean;
  phoneCount: number;
  unreadCount: number;
  lastError: string | null;
}) {
  return [
    `<b>👤 ${escapeTelegramHtml(input.name)}</b>`,
    `面板账户：<code>#${input.id}</code>`,
    `应用：${escapeTelegramHtml(input.appVariant)}`,
    `状态：${escapeTelegramHtml(input.status)}`,
    `监听：${input.monitorEnabled ? "✅ 已开启" : "⏸ 已停止"}`,
    `Telegram：${input.telegramNotify ? "✅ 已开启" : "🔕 已关闭"}`,
    `手机号：${input.phoneCount}`,
    `未读短信：${input.unreadCount}`,
    `最近错误：${escapeTelegramHtml(input.lastError ?? "-")}`
  ].join("\n");
}

export function formatPhoneCard(input: {
  accountId: number;
  id: number;
  phoneNumber: string;
  displayName: string | null;
  status: string;
  countryCode: number | null;
  providerId: number | null;
  expiredTime: string | null;
  autoRenew: boolean;
  allowReceiveSms: boolean | null;
}) {
  return [
    `<b>📱 手机号详情</b>`,
    `号码：<code>${escapeTelegramHtml(input.phoneNumber)}</code>`,
    `备注：${escapeTelegramHtml(input.displayName ?? "-")}`,
    `状态：${escapeTelegramHtml(input.status)}`,
    `国家码：${input.countryCode ? `+${input.countryCode}` : "-"}`,
    `Provider：${input.providerId ?? "-"}`,
    `到期时间：${escapeTelegramHtml(input.expiredTime ?? "-")}`,
    `自动续费：${input.autoRenew ? "是" : "否"}`,
    `短信接收：${input.allowReceiveSms === null ? "未知" : input.allowReceiveSms ? "已开启" : "已关闭"}`,
    "",
    `修改备注：<code>/set_phone_note ${input.accountId} ${input.id} 新备注</code>`
  ].join("\n");
}

export function formatRecentMessagesCard(items: Array<{
  accountName: string;
  toNumber: string | null;
  fromNumber: string | null;
  content: string;
  receivedAt: Date;
}>) {
  if (items.length === 0) return "<b>💬 最近短信</b>\n暂无短信。";
  return [
    "<b>💬 最近短信</b>",
    ...items.flatMap((item, index) => [
      "",
      `<b>${index + 1}. ${escapeTelegramHtml(item.accountName)}</b>`,
      `目标：<code>${escapeTelegramHtml(item.toNumber ?? "-")}</code>`,
      `发送方：${escapeTelegramHtml(item.fromNumber ?? "-")}`,
      `内容：${escapeTelegramHtml(item.content)}`,
      `时间：${escapeTelegramHtml(item.receivedAt.toISOString())}`
    ])
  ].join("\n");
}

export function formatPanelStatusCard(input: {
  accountCount: number;
  onlineCount: number;
  monitorCount: number;
  telegramCount: number;
  phoneCount: number;
  unreadCount: number;
}) {
  return [
    "<b>🤖 dt-manager 控制面板</b>",
    `账户：${input.accountCount}（在线 ${input.onlineCount}）`,
    `监听中：${input.monitorCount}`,
    `Telegram 通知：${input.telegramCount}`,
    `已购手机号：${input.phoneCount}`,
    `未读短信：${input.unreadCount}`,
    "",
    "请选择下面的安全操作。"
  ].join("\n");
}

export function formatAccountListCard(accounts: Array<{ id: number; name: string; status: string; phoneCount: number }>, page: number, totalPages: number) {
  return [
    `<b>👤 账户管理</b> · ${page}/${totalPages}`,
    ...accounts.map((account) => `#${account.id} ${escapeTelegramHtml(account.name)} · ${escapeTelegramHtml(account.status)} · ${account.phoneCount} 个号码`)
  ].join("\n");
}

export function formatPhoneAccountListCard(accounts: Array<{ id: number; name: string; phoneCount: number }>, page: number, totalPages: number) {
  return [
    `<b>📱 手机号管理</b> · ${page}/${totalPages}`,
    ...accounts.map((account) => `#${account.id} ${escapeTelegramHtml(account.name)} · ${account.phoneCount} 个号码`)
  ].join("\n");
}

export function formatPhoneListCard(accountName: string, phones: Array<{ phoneNumber: string; status: string }>, page: number, totalPages: number) {
  return [
    `<b>📱 ${escapeTelegramHtml(accountName)}</b> · ${page}/${totalPages}`,
    ...phones.map((phone) => `<code>${escapeTelegramHtml(phone.phoneNumber)}</code> · ${escapeTelegramHtml(phone.status)}`)
  ].join("\n");
}

export function formatCommandHelp() {
  return [
    "<b>📖 命令帮助</b>",
    "",
    "<b>查看类</b>",
    "<code>/panel</code> <code>/accounts</code> <code>/account</code> <code>/phones</code> <code>/messages</code> <code>/status</code>",
    "",
    "<b>安全操作</b>",
    "<code>/start_monitor</code> <code>/stop_monitor</code> <code>/notify</code> <code>/set_note</code> <code>/clear_note</code> <code>/set_phone_note</code> <code>/clear_phone_note</code> <code>/refresh_account</code> <code>/refresh_phones</code> <code>/code</code>",
    "",
    "<b>高级危险操作</b>",
    "<code>/preview_number</code> <code>/buy_number</code> <code>/renew_phone</code> <code>/pause_phone</code> <code>/resume_phone</code> <code>/cancel_phone</code> <code>/trace_access_code</code>",
    "危险操作必须按命令说明提供 <code>confirm</code>。"
  ].join("\n");
}

export function limitTelegramMessage(text: string, maxLength = 3900) {
  if (text.length <= maxLength) return text;
  const withoutTags = text.replace(/<\/?(?:b|code)>/g, "");
  const clipped = withoutTags.slice(0, maxLength - 16).replace(/&[^;\s]*$/, "");
  return `${clipped}\n…内容已截断`;
}
```

- [ ] **Step 4: 实现主面板与账户安全按钮**

```ts
type Button = { text: string; callback_data: string };
type Keyboard = { inline_keyboard: Button[][] };

export function mainPanelKeyboard(): Keyboard {
  return {
    inline_keyboard: [
      [
        { text: "👤 账户管理", callback_data: encodeTelegramCallback({ scope: "panel", action: "accounts", page: 1 }) },
        { text: "📱 手机号管理", callback_data: encodeTelegramCallback({ scope: "panel", action: "phones", page: 1 }) }
      ],
      [
        { text: "💬 最近短信", callback_data: encodeTelegramCallback({ scope: "panel", action: "messages" }) },
        { text: "📊 运行状态", callback_data: encodeTelegramCallback({ scope: "panel", action: "status" }) }
      ],
      [{ text: "📖 命令帮助", callback_data: encodeTelegramCallback({ scope: "panel", action: "help" }) }]
    ]
  };
}

export function accountActionKeyboard(account: { id: number; monitorEnabled: boolean; telegramNotify: boolean }): Keyboard {
  return {
    inline_keyboard: [
      [
        { text: "📱 查看号码", callback_data: encodeTelegramCallback({ scope: "account", action: "phones", accountId: account.id, page: 1 }) },
        { text: "💬 最近短信", callback_data: encodeTelegramCallback({ scope: "account", action: "messages", accountId: account.id }) }
      ],
      [
        { text: "🔄 刷新资料", callback_data: encodeTelegramCallback({ scope: "account", action: "refresh", accountId: account.id }) },
        { text: "🔄 刷新号码", callback_data: encodeTelegramCallback({ scope: "account", action: "refresh_phones", accountId: account.id }) }
      ],
      [
        { text: account.monitorEnabled ? "⏹ 停止监听" : "▶️ 启动监听", callback_data: encodeTelegramCallback({ scope: "account", action: "monitor", accountId: account.id }) },
        { text: account.telegramNotify ? "🔕 关闭通知" : "🔔 开启通知", callback_data: encodeTelegramCallback({ scope: "account", action: "notify", accountId: account.id }) }
      ],
      [{ text: "⬅️ 返回账户", callback_data: encodeTelegramCallback({ scope: "panel", action: "accounts", page: 1 }) }]
    ]
  };
}

export function accountListKeyboard(
  accounts: Array<{ id: number; name: string }>,
  page: number,
  totalPages: number
): Keyboard {
  return {
    inline_keyboard: [
      ...accounts.map((account) => [{
        text: `#${account.id} ${account.name}`.slice(0, 48),
        callback_data: encodeTelegramCallback({ scope: "account", action: "detail", accountId: account.id })
      }]),
      paginationRow("accounts", page, totalPages),
      [{ text: "⬅️ 返回主面板", callback_data: encodeTelegramCallback({ scope: "panel", action: "root" }) }]
    ].filter((row) => row.length > 0)
  };
}

export function phoneAccountKeyboard(
  accounts: Array<{ id: number; name: string; phoneCount: number }>,
  page: number,
  totalPages: number
): Keyboard {
  return {
    inline_keyboard: [
      ...accounts.map((account) => [{
        text: `#${account.id} ${account.name} · ${account.phoneCount}`.slice(0, 48),
        callback_data: encodeTelegramCallback({ scope: "account", action: "phones", accountId: account.id, page: 1 })
      }]),
      paginationRow("phones", page, totalPages),
      [{ text: "⬅️ 返回主面板", callback_data: encodeTelegramCallback({ scope: "panel", action: "root" }) }]
    ].filter((row) => row.length > 0)
  };
}

export function phoneListKeyboard(
  accountId: number,
  phones: Array<{ id: number; phoneNumber: string }>,
  page: number,
  totalPages: number
): Keyboard {
  return {
    inline_keyboard: [
      ...phones.map((phone) => [{
        text: phone.phoneNumber.slice(0, 48),
        callback_data: encodeTelegramCallback({ scope: "phone", action: "detail", accountId, phoneId: phone.id })
      }]),
      accountPhonePaginationRow(accountId, page, totalPages),
      [{ text: "⬅️ 返回手机号账户", callback_data: encodeTelegramCallback({ scope: "panel", action: "phones", page: 1 }) }]
    ].filter((row) => row.length > 0)
  };
}

export function phoneDetailKeyboard(accountId: number, phoneId: number): Keyboard {
  return {
    inline_keyboard: [
      [{ text: "✏️ 修改备注命令", callback_data: encodeTelegramCallback({ scope: "phone", action: "note", accountId, phoneId }) }],
      [{ text: "⬅️ 返回号码列表", callback_data: encodeTelegramCallback({ scope: "account", action: "phones", accountId, page: 1 }) }]
    ]
  };
}

function paginationRow(scope: "accounts" | "phones", page: number, totalPages: number): Button[] {
  const action = scope === "accounts" ? "accounts" : "phones";
  return [
    ...(page > 1 ? [{ text: "⬅️", callback_data: encodeTelegramCallback({ scope: "panel", action, page: page - 1 }) }] : []),
    { text: `${page}/${totalPages}`, callback_data: encodeTelegramCallback({ scope: "panel", action, page }) },
    ...(page < totalPages ? [{ text: "➡️", callback_data: encodeTelegramCallback({ scope: "panel", action, page: page + 1 }) }] : [])
  ];
}

function accountPhonePaginationRow(accountId: number, page: number, totalPages: number): Button[] {
  return [
    ...(page > 1 ? [{ text: "⬅️", callback_data: encodeTelegramCallback({ scope: "account", action: "phones", accountId, page: page - 1 }) }] : []),
    { text: `${page}/${totalPages}`, callback_data: encodeTelegramCallback({ scope: "account", action: "phones", accountId, page }) },
    ...(page < totalPages ? [{ text: "➡️", callback_data: encodeTelegramCallback({ scope: "account", action: "phones", accountId, page: page + 1 }) }] : [])
  ];
}
```

- [ ] **Step 5: 运行 UI 纯函数测试**

```powershell
node --import tsx --test src/services/telegram-bot-ui.test.ts src/services/telegram-bot-callbacks.test.ts
```

Expected: PASS，0 failed。

### Task 4: 把分层按钮菜单接入 TelegramBotService

**Files:**
- Create: `backend/src/services/telegram-bot-integration.test.ts`
- Modify: `backend/src/services/telegram-bot.ts:28-310,312-585,741-1212`

- [ ] **Step 1: 写失败的结构回归测试**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./telegram-bot.ts", import.meta.url), "utf8");

test("telegram bot edits callback messages and falls back to sendMessage", () => {
  assert.match(source, /editMessageText/);
  assert.match(source, /replyToCallback/);
  assert.match(source, /catch \(error\)[\s\S]*sendMessage/);
});

test("telegram bot keeps legacy commands while using safe callback actions", () => {
  for (const command of ["/accounts", "/phones", "/messages", "/start_monitor", "/stop_monitor", "/notify", "/buy_number", "/renew_phone", "/pause_phone", "/resume_phone", "/cancel_phone"]) {
    assert.match(source, new RegExp(command.replace("/", "\\/")));
  }
  assert.match(source, /parseTelegramCallback/);
  assert.doesNotMatch(source, /callback_data:[^\n]*(buy|renew|pause|resume|cancel)/);
});
```

- [ ] **Step 2: 运行测试并确认缺少新集成**

```powershell
node --import tsx --test src/services/telegram-bot-integration.test.ts
```

Expected: FAIL，缺少 `editMessageText`、`replyToCallback` 或 `parseTelegramCallback`。

- [ ] **Step 3: 扩展 BotReply 并统一 HTML 回复**

```ts
type BotReply = {
  text: string;
  replyMarkup?: unknown;
  parseMode?: "HTML";
};
```

普通命令回复改为：

```ts
private async reply(settings: Record<string, string>, chatId: string, reply: BotReply | string) {
  const botToken = settings.telegram_bot_token;
  if (!botToken) return;
  const normalized = typeof reply === "string" ? { text: reply } : reply;
  await telegramService.sendMessage({
    botToken,
    chatId,
    text: trimTelegramText(normalized.text),
    replyMarkup: normalized.replyMarkup,
    parseMode: normalized.parseMode,
    apiBaseUrl: settings.telegram_api_base_url
  });
}
```

- [ ] **Step 4: 实现回调原消息编辑和回退**

```ts
private async replyToCallback(
  settings: Record<string, string>,
  chatId: string,
  messageId: number | undefined,
  reply: BotReply
) {
  const botToken = settings.telegram_bot_token;
  if (!botToken) return;
  if (messageId) {
    try {
      await telegramService.editMessageText({
        botToken,
        chatId,
        messageId,
        text: trimTelegramText(reply.text),
        replyMarkup: reply.replyMarkup,
        parseMode: reply.parseMode,
        apiBaseUrl: settings.telegram_api_base_url
      });
      return;
    } catch (error) {
      logger.warn("Telegram callback message edit failed; sending a new message", {
        chatId,
        messageId,
        error: errorMessage(error)
      });
    }
  }
  await this.reply(settings, chatId, reply);
}
```

回调入口必须：

1. 先执行 `answerCallbackQuery`。
2. 使用 `parseTelegramCallback(callback.data)`。
3. 对刷新资料和刷新号码操作先编辑为 `<b>⏳ 正在处理</b>`。
4. 执行安全操作。
5. 使用 `replyToCallback` 更新最终结果。

- [ ] **Step 5: 实现分层查询处理器**

`handlePanelCallbackSafe` 改为接收解析后的联合类型，并按以下数据规则查询：

- 账户列表：`orderBy: [{ sortOrder: "asc" }, { id: "asc" }]`，每页 8 个。
- 手机号账户列表：账户 `include: { _count: { select: { phoneNumbers: true } } }`，只显示号码数大于 0 的账户，每页 8 个。
- 账户号码列表：`orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }]`，每页 6 个。
- 最近短信：全局或账户内 `direction=incoming`、`msgType != system`，最多 5 条，包含账户和目标号码。
- 账户详情：包含号码数、未读非系统消息数和最近错误。
- 号码详情：使用 `serializePhoneNumber` 获取短信接收开关，不把 `raw_json` 放进消息。

危险操作命令的现有 `switch` 分支、参数解析、`confirm` 校验和远端验证逻辑全部保留。

- [ ] **Step 6: 更新 `/panel` 和 `/help`**

`/panel` 返回 HTML 运行概览和 `mainPanelKeyboard()`。`/help` 按以下顺序分组：

```text
查看类：/panel /accounts /account /phones /messages /status
安全操作：/start_monitor /stop_monitor /notify /set_note /clear_note /set_phone_note /clear_phone_note /refresh_account /refresh_phones /code
高级危险操作：/preview_number /buy_number /renew_phone /pause_phone /resume_phone /cancel_phone /trace_access_code
```

每个危险命令继续标明 `confirm` 要求。

- [ ] **Step 7: 运行 Bot 集成和纯函数测试**

```powershell
node --import tsx --test src/services/telegram-bot-integration.test.ts src/services/telegram-bot-ui.test.ts src/services/telegram-bot-callbacks.test.ts src/services/telegram.test.ts
```

Expected: PASS，0 failed。

### Task 5: 统一 Telegram 通知卡片并保持团队消息隔离

**Files:**
- Create: `backend/src/services/telegram-notifier.test.ts`
- Modify: `backend/src/services/telegram-notifier.ts:44-177`
- Modify: `backend/src/scripts/verify-direct-regression.ts:1716-1785,2204-2289`

- [ ] **Step 1: 写失败测试，固定短信通知排版和 HTML 安全**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPhoneTelegramNotificationText,
  buildSmsTelegramNotificationText
} from "./telegram-notifier.js";

const account = {
  id: 433,
  nickname: "VMOS & Test",
  email: null,
  phone: null,
  dtUserId: "123",
  telegramNotify: true
};

test("SMS notification is a safe HTML card with target and code", () => {
  const text = buildSmsTelegramNotificationText({
    account,
    fromNumber: "OPENAI",
    toNumber: "3197005550101",
    content: "<code> 748402",
    receivedAt: new Date("2026-07-15T00:00:00Z")
  });
  assert.match(text, /<b>🔐 验证码短信<\/b>/);
  assert.match(text, /VMOS &amp; Test/);
  assert.match(text, /<code>3197005550101<\/code>/);
  assert.match(text, /<code>748402<\/code>/);
  assert.doesNotMatch(text, /<code> 748402/);
});

test("phone action notification keeps verification fields", () => {
  const text = buildPhoneTelegramNotificationText({
    account,
    phone: { phoneNumber: "33700000000", status: "active", countryCode: 33 },
    action: "purchase",
    verificationSource: "remote_phone_list",
    verificationNote: "confirmed"
  });
  assert.match(text, /获取新号码/);
  assert.match(text, /remote_phone_list/);
  assert.match(text, /confirmed/);
});
```

- [ ] **Step 2: 运行测试并确认短信构建函数缺失或排版不符**

```powershell
node --import tsx --test src/services/telegram-notifier.test.ts
```

Expected: FAIL，缺少 `buildSmsTelegramNotificationText` 或 HTML 断言不匹配。

- [ ] **Step 3: 实现统一通知卡片**

在 `telegram-notifier.ts` 导入 `escapeTelegramHtml`，新增：

```ts
export function buildSmsTelegramNotificationText(input: SmsNotificationInput) {
  const code = extractVerificationCode(input.content);
  return [
    `<b>${code ? "🔐 验证码短信" : "💬 新短信"}</b>`,
    `账户：${escapeTelegramHtml(deriveAccountName(input.account))} <code>#${input.account.id}</code>`,
    `目标号码：<code>${escapeTelegramHtml(input.toNumber ?? input.account.phone ?? "-")}</code>`,
    `发送方：${escapeTelegramHtml(input.fromNumber ?? "-")}`,
    ...(code ? [`验证码：<code>${escapeTelegramHtml(code)}</code>`] : []),
    `内容：${escapeTelegramHtml(input.content)}`,
    `接收时间：${escapeTelegramHtml(formatTelegramTime(input.receivedAt))}`
  ].join("\n");
}
```

`sendSmsTelegramNotification` 使用该函数，`sendAccountTelegramNotification` 的 payload 增加：

```ts
parseMode: "HTML" as const
```

`buildPhoneTelegramNotificationText` 和积分商城通知改为同样的 `<b>标题</b>`、分行标签和 HTML 转义，但保留现有字段含义和复制验证码按钮。

- [ ] **Step 4: 更新直连回归脚本中的通知断言**

将旧的纯文本断言替换为：

```ts
purchaseText.includes("获取新号码") &&
purchaseText.includes("<code>33700000000</code>") &&
purchaseText.includes("remote_phone_list") &&
pauseText.includes("暂停号码") &&
renewText.includes("续费号码") &&
cancelText.includes("取消号码")
```

团队消息验证仍必须断言：

```ts
stored.every((message) =>
  message.msgType === MessageType.system &&
  message.isRead &&
  !message.telegramSent &&
  !message.telegramMsgId
)
```

- [ ] **Step 5: 运行通知和团队消息回归**

```powershell
node --import tsx --test src/services/telegram-notifier.test.ts src/services/message-runtime.test.ts src/services/team-message-ui.test.ts
npm run verify:direct-regression
```

Expected: 单元测试 PASS；直连回归所有检查为 `ok`。

### Task 6: 统一提升版本并完成全量验证

**Files:**
- Modify: `VERSION`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `start.ps1`
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Modify: `backend/src/config.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/Dockerfile`
- Modify: `frontend/vite.config.ts`
- Modify local only: `.env`
- Create: `backend/src/services/version-sync.test.ts`

- [ ] **Step 1: 先新增失败的版本同步测试**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");
const expectedVersion = "0.2.5";

test("release version is synchronized across runtime and build files", () => {
  assert.equal(read("VERSION").trim(), expectedVersion);
  assert.equal(JSON.parse(read("backend/package.json")).version, expectedVersion);
  assert.equal(JSON.parse(read("frontend/package.json")).version, expectedVersion);
  assert.equal(JSON.parse(read("backend/package-lock.json")).version, expectedVersion);
  assert.equal(JSON.parse(read("frontend/package-lock.json")).version, expectedVersion);
  assert.match(read(".env.example"), /APP_VERSION=0\.2\.5/);
  assert.match(read(".env.example"), /VITE_APP_VERSION=0\.2\.5/);
  assert.match(read("docker-compose.yml"), /APP_VERSION:-0\.2\.5/);
  assert.match(read("start.ps1"), /-Default "0\.2\.5"/);
  assert.match(read("backend/src/config.ts"), /default\("0\.2\.5"\)/);
  assert.match(read("frontend/Dockerfile"), /ARG APP_VERSION=0\.2\.5/);
  assert.match(read("frontend/vite.config.ts"), /'0\.2\.5'/);
});
```

- [ ] **Step 2: 运行版本测试并确认仍为 `0.2.4`**

```powershell
node --import tsx --test src/services/version-sync.test.ts
```

Expected: FAIL，输出至少一个 `0.2.4 !== 0.2.5`。

- [ ] **Step 3: 将所有受控版本引用更新为 `0.2.5`**

更新以下值：

```text
VERSION=0.2.5
APP_VERSION=0.2.5
VITE_APP_VERSION=0.2.5
backend package version=0.2.5
frontend package version=0.2.5
Docker/default config version=0.2.5
```

只修改 `.env` 中两条版本变量，不输出或改动其他密钥；`.env` 不加入 Git。

- [ ] **Step 4: 运行完整后端测试**

```powershell
Set-Location -LiteralPath 'D:\work\dt-manager-web\backend'
$tests = Get-ChildItem -LiteralPath 'src' -Recurse -Filter '*.test.ts' -File | Select-Object -ExpandProperty FullName
node --import tsx --test $tests
```

Expected: 所有测试 PASS，失败数为 0；总数应高于实施前的 189。

- [ ] **Step 5: 运行后端和前端生产构建**

```powershell
npm run build
npm --prefix 'D:\work\dt-manager-web\frontend' run build
```

Expected: 两个命令 exit 0。

- [ ] **Step 6: 运行直连协议回归**

```powershell
npm run verify:direct-regression
```

Expected: 所有检查为 `ok`，包括 Telegram 回调、通知、团队消息隔离和手机号动作。

- [ ] **Step 7: 重启开发服务并验证健康接口**

使用现有 `stop.ps1` / `start.ps1` 流程重启，不启动模拟器。随后运行：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:5174/health' -TimeoutSec 5 | ConvertTo-Json -Depth 6
```

Expected:

```json
{
  "ok": true,
  "version": "0.2.5",
  "gatewayMode": "direct"
}
```

- [ ] **Step 8: 进行真实 Telegram 安全交互验证**

在已授权的 Telegram 对话中验证：

1. `/panel` 显示 HTML 主面板和 5 个入口。
2. 点击“账户管理”后原消息被编辑，不新增刷屏消息。
3. 账户分页、详情、号码列表和号码详情可返回上一级。
4. 号码以 `<code>` 样式显示并能复制。
5. 最近短信显示账户、目标号码、发送方、内容和时间。
6. 刷新资料或号码先显示“正在处理”，完成后更新同一消息。
7. 编辑失败的兼容测试能发送新消息。
8. 按钮中没有购号、续费、暂停、恢复和取消。
9. `/help` 仍列出旧命令并把危险命令单独分组。

不执行购号、续费、暂停、恢复或取消。

- [ ] **Step 9: 做提交前敏感信息检查**

```powershell
git -C 'D:\work\dt-manager-web' status --short
git -C 'D:\work\dt-manager-web' diff --check
git -C 'D:\work\dt-manager-web' diff --stat
```

人工确认未包含：

- `.env`
- `backend/prisma/**/*.db`
- `_tmp/`
- `.playwright-mcp/`
- Token、密码和登录验证码
- 邮箱、完整手机号和账户导出
- 日志、抓包、IMEI、MAC、序列号和局域网 IP

- [ ] **Step 10: 创建一次 `0.2.5` 正式提交**

只暂存两份设计/计划文档、受控版本文件和实际源代码/测试文件。确认：

```powershell
git diff --cached --check
git status --short
```

Expected: 暂存区不含 `.env`、数据库、日志、抓包和临时文件。

Commit:

```powershell
git commit -m "feat: release v0.2.5 phone inventory and Telegram UX"
```

Expected: commit 成功；不执行 `git push`，等待用户明确要求。
