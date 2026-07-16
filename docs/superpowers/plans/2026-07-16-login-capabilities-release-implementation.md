# 登录能力收敛与 v0.2.7 发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只向用户展示真实可用的登录方式，把手动直连会话导入改为先验证后持久化，并在所有功能验收后发布本地 v0.2.7 实现提交。

**Architecture:** 新增账号页只收敛可选能力，不缩窄数据库和 API 的完整 `LoginType` 兼容集合；后端使用独立纯编排函数保证 Direct 校验成功后才保存凭据；前端将会话导入抽成受控表单组件。正式运行不依赖模拟器，helper/ADB 入口明确标记为仅逆向与测试。

**Tech Stack:** TypeScript、React、Ant Design、Express、Prisma、Node.js test runner、tsx、PowerShell。

---

## 文件边界

- Create: `backend/src/routes/login-capabilities-ui.test.ts`：新增账号页能力与兼容边界结构测试。
- Modify: `frontend/src/pages/AccountAdd.tsx`：只展示邮箱验证码和手动会话。
- Create: `backend/src/services/direct-session-import.ts`：先验证后持久化的无状态编排和错误分类。
- Create: `backend/src/services/direct-session-import.test.ts`：调用顺序、失败不保存、验证设备 ID 测试。
- Modify: `backend/src/routes/accounts.ts`：在持久化前完成 Direct 校验。
- Create: `frontend/src/components/accounts/DirectSessionImportModal.tsx`：受控会话导入表单。
- Modify: `frontend/src/pages/AccountDetail.tsx`：使用新组件并明确模拟器入口仅用于测试。
- Create: `backend/src/services/version-sync.test.ts`：全部受控版本文件同步测试。
- Modify: `VERSION`、`.env.example`、`docker-compose.yml`、`start.ps1`、`backend/package.json`、`backend/package-lock.json`、`backend/src/config.ts`、`frontend/package.json`、`frontend/package-lock.json`、`frontend/Dockerfile`、`frontend/vite.config.ts`：统一版本 `0.2.7`。

## 兼容边界

以下内容必须继续保留五种历史登录类型，不做收窄：

- `frontend/src/types/index.ts` 的 `LoginType`。
- `backend/prisma/schema.prisma` 的 `LoginType` 枚举。
- `backend/src/routes/accounts.ts` 的请求 schema、导入和旧账号序列化。
- `backend/src/services/dingtone/types.ts` 的网关契约。

本计划只改变“新增账号页面可以选择什么”，不删除已有账号或凭据。

### Task 1: 收敛新增账号页的登录选项

**Files:**
- Create: `backend/src/routes/login-capabilities-ui.test.ts`
- Modify: `frontend/src/pages/AccountAdd.tsx`

- [ ] **Step 1: 写失败结构测试**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

test("account add exposes only verified login methods", () => {
  const source = read("frontend/src/pages/AccountAdd.tsx");
  const start = source.indexOf('<Form.Item label="接入方式"');
  const end = source.indexOf("</Form.Item>", start);
  const block = source.slice(start, end);
  assert.match(block, /value: 'email_code'/);
  assert.match(block, /value: 'manual_session'/);
  assert.doesNotMatch(block, /value: 'phone_code'/);
  assert.doesNotMatch(block, /value: 'email_password'/);
  assert.doesNotMatch(block, /value: 'phone_password'/);
  assert.match(source, /const isVerificationLogin = loginType === 'email_code'/);
  assert.doesNotMatch(source, /PhoneOutlined|LockOutlined/);
});

test("persisted login types remain backward compatible", () => {
  const frontendTypes = read("frontend/src/types/index.ts");
  const schema = read("backend/prisma/schema.prisma");
  const route = read("backend/src/routes/accounts.ts");
  for (const value of ["email_code", "phone_code", "email_password", "phone_password", "manual_session"]) {
    assert.match(frontendTypes, new RegExp(value));
    assert.match(schema, new RegExp(value));
    assert.match(route, new RegExp(value));
  }
});
```

- [ ] **Step 2: 运行并确认 RED**

Run from `backend`:

```powershell
node --import tsx --test src/routes/login-capabilities-ui.test.ts
```

Expected: FAIL，因为新增页面仍包含三种未实现方式。

- [ ] **Step 3: 最小收敛 AccountAdd**

改动要求：

```ts
const isVerificationLogin = loginType === 'email_code';
const verificationTargetLabel = '邮箱';
const verificationDeliveryLabel = '邮件';
```

接入方式只保留：

```ts
options={[
  { value: 'email_code', label: '邮箱 + 验证码' },
  { value: 'manual_session', label: '手动导入直连会话' },
]}
```

删除手机号和密码表单分支、`phone/password` 表单字段及 `PhoneOutlined/LockOutlined` import。手动方式仍创建占位账号后跳转详情页；邮箱验证码仍为默认方式。

- [ ] **Step 4: 运行测试和前端构建**

```powershell
node --import tsx --test src/routes/login-capabilities-ui.test.ts
npm --prefix ..\frontend run build
```

Expected: PASS，build exit 0。

- [ ] **Step 5: 检查差异，不提交**

```powershell
git diff --check
git status --short
```

### Task 2: 建立先验证后持久化的纯编排

**Files:**
- Create: `backend/src/services/direct-session-import.ts`
- Create: `backend/src/services/direct-session-import.test.ts`

- [ ] **Step 1: 写调用顺序和失败安全测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { validateThenPersistDirectSession } from "./direct-session-import.js";

const session = { dtUserId: "u1", token: "secret", deviceId: "candidate" };

test("validates before persisting a direct session", async () => {
  const calls: string[] = [];
  const result = await validateThenPersistDirectSession(session, {
    validate: async () => {
      calls.push("validate");
      return { deviceId: "validated-device", probe: { ok: true } };
    },
    persist: async (value) => {
      calls.push("persist");
      return value;
    },
  });
  assert.deepEqual(calls, ["validate", "persist"]);
  assert.equal(result.storedSession.deviceId, "validated-device");
});

test("does not persist an invalid token", async () => {
  let persisted = false;
  await assert.rejects(
    validateThenPersistDirectSession(session, {
      validate: async () => { throw new Error("unauthorized token"); },
      persist: async (value) => { persisted = true; return value; },
    }),
    /Token.*失效|过期/,
  );
  assert.equal(persisted, false);
});

test("does not persist when validation times out", async () => {
  let persisted = false;
  await assert.rejects(
    validateThenPersistDirectSession(session, {
      validate: async () => null,
      persist: async (value) => { persisted = true; return value; },
    }),
    /校验超时/,
  );
  assert.equal(persisted, false);
});
```

- [ ] **Step 2: 运行并确认 RED**

```powershell
node --import tsx --test src/services/direct-session-import.test.ts
```

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现泛型安全编排**

```ts
import { AppError } from "../utils/errors.js";

export async function validateThenPersistDirectSession<
  TSession extends { deviceId: string },
  TValidation extends { deviceId: string },
  TStored,
>(
  session: TSession,
  dependencies: {
    validate(value: TSession): Promise<TValidation | null>;
    persist(value: TSession): Promise<TStored>;
  },
) {
  let validation: TValidation | null;
  try {
    validation = await dependencies.validate(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unauthorized|token|401/i.test(message)) {
      throw new AppError("Token 已失效或过期，未保存任何会话信息。", 409, 409);
    }
    if (/device/i.test(message)) {
      throw new AppError("设备参数与会话不匹配，未保存任何会话信息。", 409, 409);
    }
    throw new AppError("Direct 会话校验失败，未保存任何会话信息。", 409, 409);
  }
  if (!validation) {
    throw new AppError("Direct 会话校验超时，未保存任何会话信息。", 409, 409);
  }
  const validatedSession = { ...session, deviceId: validation.deviceId };
  const storedSession = await dependencies.persist(validatedSession);
  return { storedSession, validation };
}
```

不要把 Token、底层请求参数或完整异常正文写入返回信息。

- [ ] **Step 4: 运行测试并确认 GREEN**

```powershell
node --import tsx --test src/services/direct-session-import.test.ts
```

Expected: 3 tests PASS。

### Task 3: 在 accounts 路由中先验证再保存

**Files:**
- Modify: `backend/src/routes/accounts.ts`
- Modify: `backend/src/services/direct-session-import.test.ts`

- [ ] **Step 1: 添加验证设备 ID 持久化测试**

```ts
test("persists the device id selected by the successful probe", async () => {
  let persistedDeviceId = "";
  await validateThenPersistDirectSession(session, {
    validate: async () => ({ deviceId: "validated-device" }),
    persist: async (value) => {
      persistedDeviceId = value.deviceId;
      return value;
    },
  });
  assert.equal(persistedDeviceId, "validated-device");
});
```

- [ ] **Step 2: 重写 importAuthorizedSession 顺序**

保留以下校验在远端探测前执行：

```text
标准化 deviceId
应用类型与包名匹配
会话不属于其它账号
```

随后调用：

```ts
const result = await validateThenPersistDirectSession(storedSession, {
  validate: (candidate) => validateCapturedSessionBeforeImport(account, candidate, options),
  persist: async (candidate) => {
    const persistedAccountId = await persistCapturedSession(accountId, account, candidate);
    await tryHydrateImportedAccountFromHelper(persistedAccountId);
    return { persistedAccountId, session: candidate };
  },
});
```

成功后只将账号设为 `offline`、`lastError=null`，不要自动启动监听。返回结构继续兼容 route：

```ts
return {
  storedSession: result.storedSession.session,
  validation: result.validation,
  validationError: null,
};
```

删除“先保存、验证失败仍保存”的分支。校验失败时不得调用 `persistCapturedSession()`，因此原账号的会话、状态和监听设置保持不变。

`validateCapturedSessionBeforeImport()` 不得复用当前会吞掉所有异常的 `tryValidateCapturedSessionQuickly()`；使用明确超时值并让 Token/设备错误继续抛给编排层：

```ts
async function validateCapturedSessionBeforeImport(
  account: Parameters<typeof validateCapturedSession>[0],
  session: DingtoneSessionExport,
  options: { phonePreviewCountryCode?: number },
) {
  const timeout = Symbol("direct-session-timeout");
  const result = await Promise.race([
    validateCapturedSession(account, session, options),
    delayResult(8_000, timeout),
  ]);
  return result === timeout ? null : result;
}
```

- [ ] **Step 3: 增加源码顺序回归**

在 `login-capabilities-ui.test.ts` 读取 `accounts.ts` 并断言 `validateThenPersistDirectSession` 存在，且 `importAuthorizedSession` 内验证调用出现在 `persistCapturedSession` 前。使用 `indexOf` 比较函数片段内的位置，不匹配整个文件其它调用。

- [ ] **Step 4: 运行测试和后端构建**

```powershell
node --import tsx --test src/services/direct-session-import.test.ts src/routes/login-capabilities-ui.test.ts
npm run build
```

Expected: PASS，build exit 0。

- [ ] **Step 5: 检查差异，不提交**

```powershell
git diff --check
git status --short
```

### Task 4: 抽取受控的手动会话导入表单

**Files:**
- Create: `frontend/src/components/accounts/DirectSessionImportModal.tsx`
- Modify: `frontend/src/pages/AccountDetail.tsx`
- Modify: `backend/src/routes/login-capabilities-ui.test.ts`

- [ ] **Step 1: 写组件结构失败测试**

```ts
test("manual session import protects credentials and explains failures", () => {
  const modal = read("frontend/src/components/accounts/DirectSessionImportModal.tsx");
  assert.match(modal, /<Input\.Password/);
  assert.match(modal, /Token.*默认隐藏/);
  assert.match(modal, /设备 ID/);
  assert.match(modal, /应用类型/);
  assert.match(modal, /校验超时/);
  assert.match(modal, /Token.*失效/);
  assert.match(modal, /destroyOnClose/);
});
```

- [ ] **Step 2: 运行并确认 RED**

```powershell
node --import tsx --test src/routes/login-capabilities-ui.test.ts
```

Expected: FAIL，组件尚不存在。

- [ ] **Step 3: 创建组件的公开契约**

```ts
export type DirectSessionImportValues = {
  dtUserId: string;
  token: string;
  deviceId: string;
  deviceIdCandidates: string[];
  phonePreviewCountryCode?: number;
};

type Props = {
  open: boolean;
  appVariant: "dingtone" | "dingdong";
  initialDtUserId: string;
  initialDeviceId: string;
  countries: Array<{ country_code: number; label: string }>;
  loading: boolean;
  onCancel(): void;
  onSubmit(values: DirectSessionImportValues): Promise<void>;
};
```

使用 Ant Design `Modal + Form`。`dtUserId`、Token、主 deviceId 必填；Token 使用 `Input.Password`；候选设备按换行或逗号分隔、trim、去重、最多 8 个。`destroyOnClose` 与 `form.resetFields()` 确保关闭后 Token 清空。提交时禁用关闭和重复提交。

组件核心 JSX：

```tsx
const [form] = Form.useForm();
return (
  <Modal
    open={open}
    title="导入直连会话"
    okText="验证并保存"
    cancelText="取消"
    confirmLoading={loading}
    closable={!loading}
    maskClosable={!loading}
    destroyOnClose
    onCancel={() => { form.resetFields(); onCancel(); }}
    onOk={() => form.submit()}
  >
    <Alert type="info" showIcon message={`应用类型：${appVariant === "dingdong" ? "叮咚" : "说道"}`} />
    <Form
      form={form}
      layout="vertical"
      initialValues={{ dtUserId: initialDtUserId, deviceId: initialDeviceId }}
      onFinish={async (values) => {
        const candidates = String(values.deviceCandidates ?? "")
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean);
        await onSubmit({
          dtUserId: values.dtUserId.trim(),
          token: values.token.trim(),
          deviceId: values.deviceId.trim(),
          deviceIdCandidates: [...new Set(candidates)].slice(0, 8),
          phonePreviewCountryCode: values.phonePreviewCountryCode,
        });
        form.resetFields();
      }}
    >
      <Form.Item label="用户 ID (dtUserId)" name="dtUserId" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item label="Token（敏感信息，默认隐藏）" name="token" rules={[{ required: true }]}>
        <Input.Password autoComplete="off" />
      </Form.Item>
      <Form.Item label="设备 ID" name="deviceId" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item label="备用设备 ID" name="deviceCandidates">
        <Input.TextArea rows={3} />
      </Form.Item>
      <Typography.Text type="secondary">失败提示会区分 Token 失效、设备不匹配和校验超时。</Typography.Text>
    </Form>
  </Modal>
);
```

组件内错误分类只展示以下安全中文：

```text
Token 已失效或过期
设备参数与会话不匹配
Direct 会话校验超时
网络或后端暂时不可用
```

不要写 localStorage、sessionStorage 或日志。

- [ ] **Step 4: AccountDetail 使用新组件**

把当前 `modal.confirm` 中的可变局部变量替换为受控 `open/loading/countries` state。提交时调用现有 `validateSession()`，成功后关闭组件、清空敏感表单并刷新账户与号码；失败时保持弹窗打开。

现有 helper/ADB 导入按钮改名为：

```text
模拟器测试导入（仅逆向/测试）
```

并在确认弹窗增加：

```text
该入口不是正式部署依赖，仅用于逆向和测试环境。
```

不要删除后端兼容路由。

- [ ] **Step 5: 运行结构测试和前端构建**

```powershell
node --import tsx --test src/routes/login-capabilities-ui.test.ts
npm --prefix ..\frontend run build
```

Expected: PASS，build exit 0。

### Task 5: 完成三个子系统的联合验证

**Files:**
- No production changes unless a test exposes a scoped defect.

- [ ] **Step 1: 运行全部后端测试**

Run from `backend`:

```powershell
$tests = Get-ChildItem -LiteralPath 'src' -Recurse -Filter '*.test.ts' -File | Select-Object -ExpandProperty FullName
node --import tsx --test $tests
```

Expected: fail 0。

- [ ] **Step 2: 运行双端生产构建**

```powershell
npm run build
npm --prefix ..\frontend run build
```

Expected: 两项 exit 0。

- [ ] **Step 3: 运行 Direct 回归**

```powershell
npm run verify:direct-regression
```

Expected: 全部检查 `ok`，团队消息仍按账号隔离且不发送 Telegram。

- [ ] **Step 4: 执行真实只读验收**

仅允许以下行为：

```text
GET /health
GET 本地账户详情、商城和订单历史 API
GET 远端 /pointstore/order/list
查看正式 Direct 监听诊断
```

禁止调用 `/pointstore/order`、任何兑换或扣积分接口。验证：升级进度为正确总值；已有远端历史订单出现；状态 4/5 显示正确；团队币测试链路不依赖 ADB/helper；新增账号页只有两个方式；错误 Token 不覆盖原账号会话。

- [ ] **Step 5: 检查工作树**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: 只有三份计划列出的代码、测试和计划文档，没有 `.env`、数据库和逆向临时文件。

### Task 6: 统一提升到 v0.2.7 并创建一次本地提交

**Files:**
- Create: `backend/src/services/version-sync.test.ts`
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

- [ ] **Step 1: 写完整版本同步失败测试**

测试读取上述受控文件并断言 `0.2.7`。至少包含：

```ts
const expectedVersion = "0.2.7";
assert.equal(read("VERSION").trim(), expectedVersion);
assert.equal(JSON.parse(read("backend/package.json")).version, expectedVersion);
assert.equal(JSON.parse(read("frontend/package.json")).version, expectedVersion);
assert.match(read("backend/src/config.ts"), /APP_VERSION: z\.string\(\)\.default\("0\.2\.7"\)/);
assert.match(read("frontend/vite.config.ts"), /'0\.2\.7'/);
assert.match(read("docker-compose.yml"), /APP_VERSION:-0\.2\.7/);
assert.match(read("start.ps1"), /APP_VERSION" -Default "0\.2\.7"/);
```

- [ ] **Step 2: 运行并确认 RED**

```powershell
node --import tsx --test src/services/version-sync.test.ts
```

Expected: FAIL，当前版本为 0.2.6。

- [ ] **Step 3: 使用 apply_patch 统一替换受控版本**

把全部受控文件的应用版本从 `0.2.6` 更新为 `0.2.7`。不要修改 `.env`，不要改 Dingtone/DingDong 官方 App 版本。

- [ ] **Step 4: 重新运行完整验证**

```powershell
node --import tsx --test src/services/version-sync.test.ts
$tests = Get-ChildItem -LiteralPath 'src' -Recurse -Filter '*.test.ts' -File | Select-Object -ExpandProperty FullName
node --import tsx --test $tests
npm run build
npm run verify:direct-regression
npm --prefix ..\frontend run build
```

Expected: tests fail 0，构建与 Direct 回归 exit 0。

- [ ] **Step 5: 检查健康接口和敏感内容**

启动或重启正式服务时不得启动模拟器、ADB、helper 或 Frida。检查：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:5174/health' -TimeoutSec 5 | ConvertTo-Json -Depth 6
git status --short
git diff --check
git diff --stat
```

Expected: health 包含 `ok=true`、`version=0.2.7`、`gatewayMode=direct`。

逐项确认工作树不含 `.env`、SQLite 数据库、Token、密码、验证码、完整邮箱/手机号、设备标识、日志、抓包、APK、模拟器文件和逆向临时产物。

- [ ] **Step 6: 暂存明确文件并检查暂存区**

只暂存三份计划列出的源码、测试、计划文档和版本文件。随后运行：

```powershell
git diff --cached --check
git diff --cached --stat
git status --short
```

Expected: 暂存区没有用户环境文件或运行数据。

- [ ] **Step 7: 创建一次实现提交，不推送**

```powershell
git commit -m "feat: release v0.2.7 data correctness and session UX"
```

Expected: commit 成功，工作树干净。不要执行 `git push`，等待用户明确要求。
