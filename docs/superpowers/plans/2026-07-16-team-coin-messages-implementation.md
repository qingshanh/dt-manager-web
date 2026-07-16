# 团队币消息正式直连 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让正式 Direct web-offline 链路完整保存和渲染说道币、叮咚币的 531/532 与 3300 团队消息，同时保持团队消息不进入面板通知、不发送 Telegram。

**Architecture:** 新增无副作用的团队消息规范化模块，集中解析 envelope、`msgMeta`、`data2`、`args.params` 和币种正文；Direct 网关只负责把远端记录转换为稳定行，运行时负责分类、入库和重复升级。模拟器与 App 数据库只用于已有逆向证据和测试，不成为生产依赖。

**Tech Stack:** TypeScript、Node.js test runner、tsx、Prisma、Direct native REST、SQLite。

---

## 文件边界

- Create: `backend/src/services/team-message-normalizer.ts`：团队元数据解析、envelope 构造、币消息正文渲染。
- Modify: `backend/src/services/dingtone/direct-gateway.ts`：在空正文判断前识别 531/532/3300 并保留元数据。
- Modify: `backend/src/services/dingtone/direct-web-offline.test.ts`：真实 Direct 记录规范化和 type 29 负向测试。
- Modify: `backend/src/services/message-runtime.ts`：按整行渲染团队正文，允许元数据消息入库，重复记录更新 `k5Flag`。
- Modify: `backend/src/services/message-runtime.test.ts`：531/532、3300、重复升级和通知隔离端到端测试。
- Modify: `backend/src/scripts/verify-direct-regression.ts`：加强正式直连团队消息隔离检查。

## 提交策略

本计划结束只检查工作树，不提交。三份计划全部完成后统一提升到 `0.2.7` 并创建一次实现提交。

### Task 1: 为 Direct 531/532 和 3300 建立失败测试

**Files:**
- Modify: `backend/src/services/dingtone/direct-web-offline.test.ts`

- [ ] **Step 1: 添加 531 空正文数字发送方测试**

```ts
test("keeps metadata-only TalkU credit messages from numeric senders", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [{
      msgTitle: "",
      msgContent: "",
      msgMeta: JSON.stringify({ k1: 531, credits: 20, bc: 20, adType: 0, ex: 90, type: 34 }),
      msgSenderID: "2684354560",
      msgId: "direct-credit-531",
      msgType: 531,
      msgTimeStamp: 1_800_000_000,
    }],
  }, "dingtone");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.type, 531);
  assert.equal(rows[0]?.senderId, "说道团队");
  assert.equal(rows[0]?.conversationId, "10000");
  assert.equal(rows[0]?.msgId, "direct-credit-531");
  assert.match(rows[0]?.data2 ?? "", /"credits":20/);
  assert.doesNotThrow(() => JSON.parse(rows[0]!.content));
});
```

- [ ] **Step 2: 添加 3300 嵌套参数测试**

```ts
test("promotes common-event credit metadata to its inner secretary type", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [{
      content: JSON.stringify({
        content: "",
        args: { type: 99, params: { k1: 531, credits: 4, ex: -1 } },
      }),
      from: "2684354560",
      msgId: "direct-credit-3300",
      msgType: 3300,
      msgTimeStamp: 1_800_000_002,
    }],
  }, "dingtone");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.type, 531);
  assert.match(rows[0]?.data2 ?? "", /"credits":4/);
  assert.doesNotThrow(() => JSON.parse(rows[0]!.content));
});
```

- [ ] **Step 3: 加强 type 29 负向测试**

在现有 offer 测试中使用数字发送方并加入 `credits` 文本，但保持 `msgType: 29`，断言仍为：

```ts
assert.deepEqual(normalizeDirectWebOfflineMessages(payload, "dingtone"), []);
```

- [ ] **Step 4: 运行测试并确认 RED**

Run from `backend`:

```powershell
node --import tsx --test src/services/dingtone/direct-web-offline.test.ts
```

Expected: 531 测试实际得到 0 条；3300 仍为类型 3300 或原始 JSON；type 29 继续 PASS。

- [ ] **Step 5: 检查差异，不提交**

```powershell
git diff --check
git status --short
```

### Task 2: 创建共享团队元数据解析模块

**Files:**
- Create: `backend/src/services/team-message-normalizer.ts`

- [ ] **Step 1: 定义稳定类型和安全 JSON 读取**

```ts
export type TeamAppVariant = "dingtone" | "dingdong";

export type ParsedTeamMessageMeta = {
  k1: number | null;
  actionType: number | null;
  credits: number | null;
  expiryDays: number | null;
  raw: string | null;
};

type JsonRecord = Record<string, unknown>;

function parseJsonRecord(value: unknown): JsonRecord | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: 实现元数据优先级**

`parseTeamMessageMeta(...sources)` 必须递归读取：正文 envelope 的 `msgMeta`、`data2`、`args`、`params`，优先使用 531/532 的 `k1`，并读取 `type`、`credits`、`ex`。返回 `raw` 时只序列化最终有效元数据对象。

实现主体：

```ts
function toFiniteNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseTeamMessageMeta(...sources: unknown[]): ParsedTeamMessageMeta {
  const records: JsonRecord[] = [];
  const visit = (value: unknown) => {
    const record = parseJsonRecord(value);
    if (!record || records.includes(record)) return;
    records.push(record);
    for (const key of ["msgMeta", "data2", "args", "params"]) {
      if (record[key] !== undefined) visit(record[key]);
    }
  };
  sources.forEach(visit);
  const numbers = (key: string) => records.map((record) => toFiniteNumber(record[key])).filter((value): value is number => value !== null);
  const k1 = numbers("k1").find((value) => value === 531 || value === 532) ?? null;
  const actionType = numbers("type").find((value) => value !== 531 && value !== 532 && value !== 3300) ?? null;
  const credits = numbers("credits")[0] ?? numbers("bc")[0] ?? null;
  const expiryDays = numbers("ex")[0] ?? null;
  const rawRecord = records.find((record) => toFiniteNumber(record.credits) !== null) ?? null;
  return {
    k1,
    actionType,
    credits,
    expiryDays,
    raw: rawRecord ? JSON.stringify(rawRecord) : null,
  };
}
```

- [ ] **Step 3: 实现稳定 envelope**

```ts
export function buildTeamMessageEnvelope(input: {
  title?: string | null;
  body?: string | null;
  meta?: unknown;
}) {
  const parsed = parseTeamMessageMeta(input.meta);
  return JSON.stringify({
    msgContent: input.body?.trim() ?? "",
    msgTitle: input.title?.trim() ?? "",
    msgMeta: parsed.raw ?? "",
  });
}
```

- [ ] **Step 4: 实现币消息中文渲染**

```ts
export function renderTeamMessageContent(
  input: { content?: string | null; data2?: string | null; type?: number | null },
  appVariant: TeamAppVariant,
) {
  const meta = parseTeamMessageMeta(input.content, input.data2, { k1: input.type });
  if (meta.credits === null) return null;
  const coin = appVariant === "dingdong" ? "叮咚币" : "说道币";
  const amount = meta.credits.toFixed(2);
  if (meta.actionType === 5) return `任务完成，获得 ${amount} ${coin}`;
  if (meta.actionType === 34) return `兑换成功，${amount} ${coin}已到账`;
  if (meta.actionType === 99) return `获得 ${amount} ${coin}`;
  return `获得 ${amount} ${coin}`;
}
```

没有有效 `credits` 时返回 `null`，让调用方使用非币团队正文，不能凭关键词猜币消息。

- [ ] **Step 5: 运行 TypeScript 构建**

```powershell
npm run build
```

Expected: exit 0。

### Task 3: Direct 网关保留 metadata-only 团队消息

**Files:**
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/dingtone/direct-web-offline.test.ts`

- [ ] **Step 1: 在空正文判断前解析元数据**

导入共享函数。对每条远端记录先读取外层 `msgType`、`msgMeta` 和 common-event，再调用 `parseTeamMessageMeta()`。

有效团队证据固定为：

```ts
const hasCreditMeta =
  (parsedMeta.k1 === 531 || parsedMeta.k1 === 532) &&
  parsedMeta.credits !== null;
const isSecretary =
  outerType === 3300 ||
  hasCreditMeta ||
  Boolean(resolveDirectWebOfflineTeamName(record));
```

不要把 type 29 或仅包含 `credits` 文本的普通消息归为团队消息。

- [ ] **Step 2: 生成稳定输出行**

对 `hasCreditMeta` 的记录：

```ts
const effectiveType = parsedMeta.k1 ?? outerType;
const teamName = appVariant === "dingdong" ? "叮咚团队" : "说道团队";
const stableContent = buildTeamMessageEnvelope({ title, body, meta: parsedMeta.raw });
```

输出 `content=stableContent`、`data2=parsedMeta.raw`、`type=effectiveType`、`conversationType=4`、`conversationId="10000"`。只有既无正文也无有效元数据时才跳过。

- [ ] **Step 3: 运行 Direct 测试并确认 GREEN**

```powershell
node --import tsx --test src/services/dingtone/direct-web-offline.test.ts
```

Expected: 新增 531 和 3300 测试 PASS，type 29 负向测试 PASS。

- [ ] **Step 4: 后端构建**

```powershell
npm run build
```

Expected: exit 0。

- [ ] **Step 5: 检查差异，不提交**

```powershell
git diff --check
git status --short
```

### Task 4: 运行时读取整行元数据并生成币消息

**Files:**
- Modify: `backend/src/services/message-runtime.test.ts`
- Modify: `backend/src/services/message-runtime.ts`

- [ ] **Step 1: 写 532 DingDong 端到端失败测试**

将 Direct 规范化后的行传给 `storeHelperSmsMessages()`：

```ts
test("stores metadata-only DingDong task credits from Direct web offline", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    appVariant: "dingdong",
    nickname: null,
    email: "owner@example.com",
    phone: null,
    dtUserId: "u1",
    telegramNotify: false,
  });
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [{
      msgTitle: "",
      msgContent: "",
      msgMeta: JSON.stringify({ k1: 532, credits: 0.5, ex: -1, type: 5 }),
      msgSenderID: "2684354560",
      msgId: "direct-credit-532",
      msgType: 532,
      msgTimeStamp: 1_800_000_001,
    }],
  }, "dingdong");
  const imported = await storeHelperSmsMessages(1, rows, {
    db: runtime.db as any,
    emitEvents: false,
    sendTelegram: false,
    collectTeamMessages: true,
  });
  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.msgType, MessageType.system);
  assert.equal(runtime.messages[0]?.k5Flag, 532);
  assert.equal(runtime.messages[0]?.fromNumber, "叮咚团队");
  assert.equal(runtime.messages[0]?.content, "任务完成，获得 0.50 叮咚币");
  assert.equal(runtime.messages[0]?.isRead, true);
});
```

- [ ] **Step 2: 写 3300 args.params 失败测试**

使用 `k1=531`、`credits=4`、`type=99` 的 common-event，断言最终 `k5Flag=531` 且正文为 `获得 4.00 叮咚币`。

- [ ] **Step 3: 运行并确认 RED**

```powershell
node --import tsx --test src/services/message-runtime.test.ts
```

Expected: 新用例因空正文门槛或未读取 `data2` 而 FAIL。

- [ ] **Step 4: 改为按整行渲染**

将旧的 `extractTeamMessageContent(content, appVariant)` 替换为调用：

```ts
const renderedTeamContent = renderTeamMessageContent({
  content: row.content,
  data2: row.data2,
  type: row.type,
}, account.appVariant);
```

团队候选行存在有效规范化结果时，即使原 `row.content` 为空也允许继续；存储正文优先 `renderedTeamContent`，其次使用非空团队正文。普通短信仍保持原有空正文过滤。

- [ ] **Step 5: 运行测试并确认 GREEN**

```powershell
node --import tsx --test src/services/message-runtime.test.ts
```

Expected: 新增币消息用例 PASS，现有普通短信和团队消息用例继续 PASS。

### Task 5: 同 msgId 升级正文和 k5Flag

**Files:**
- Modify: `backend/src/services/message-runtime.test.ts`
- Modify: `backend/src/services/message-runtime.ts`

- [ ] **Step 1: 扩展重复记录失败测试**

预置同 `rawK3="credit-upgrade"` 的系统消息，`k5Flag=3300`、正文 `积分变动：4`。重新导入完整 531 元数据后断言：

```ts
assert.equal(imported, 0);
assert.equal(runtime.messages.length, 1);
assert.equal(runtime.messages[0]?.k5Flag, 531);
assert.equal(runtime.messages[0]?.content, "获得 4.00 叮咚币");
assert.equal(runtime.messages[0]?.fromNumber, "叮咚团队");
```

- [ ] **Step 2: 运行并确认 RED**

```powershell
node --import tsx --test src/services/message-runtime.test.ts
```

Expected: 正文可能更新，但 `k5Flag` 仍为 3300。

- [ ] **Step 3: 更新重复查找和 update 数据**

给 `findDuplicateHelperSmsMessage` 使用的所有 `select` 增加：

```ts
k5Flag: true,
```

当新行具有更明确类型时，更新数据加入：

```ts
k5Flag: rowForStorage.type ?? duplicate.k5Flag,
```

只更新同账号、同远端消息标识的记录，不进行模糊跨账号合并。

- [ ] **Step 4: 运行测试**

```powershell
node --import tsx --test src/services/message-runtime.test.ts
```

Expected: PASS。

### Task 6: 锁定团队消息通知隔离

**Files:**
- Modify: `backend/src/services/message-runtime.test.ts`
- Modify: `backend/src/scripts/verify-direct-regression.ts`

- [ ] **Step 1: 添加强制开启通知参数的隔离测试**

账号设置 `telegramNotify=true`，调用参数故意使用：

```ts
{ emitEvents: true, sendTelegram: true, collectTeamMessages: true }
```

导入一条 531 币消息后断言：

```ts
assert.equal(message.msgType, MessageType.system);
assert.equal(message.isRead, true);
assert.equal(message.telegramSent, false);
assert.equal(message.telegramMsgId, null);
assert.equal(events.filter((event) => event.type === "new_message").length, 0);
```

- [ ] **Step 2: 运行测试**

```powershell
node --import tsx --test src/services/message-runtime.test.ts
```

Expected: 既有隔离逻辑应 PASS；如果失败，只修系统消息隔离，不改变普通短信通知。

- [ ] **Step 3: 加强 Direct 回归检查**

在 `checkTeamMessagesPerAccountNoTelegram` 中加入一条规范化币消息，验证它只写入目标账号、类型为 system、`telegramSent=false`，并确认其它账号消息数不变。

- [ ] **Step 4: 本计划完整验收，不提交**

```powershell
node --import tsx --test src/services/dingtone/direct-web-offline.test.ts src/services/message-runtime.test.ts
npm run build
npm run verify:direct-regression
git diff --check
git status --short
```

Expected: 新增与既有测试全部 PASS，Direct 回归中的团队消息隔离检查 PASS，未创建提交。
