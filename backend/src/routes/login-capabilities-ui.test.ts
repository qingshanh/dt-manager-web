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
  const values = [...block.matchAll(/value: '([^']+)'/g)].map((match) => match[1]);

  assert.deepEqual(values, ["email_code", "manual_session"]);
  assert.match(source, /useState<LoginType>\('email_code'\)/);
  assert.match(source, /const isVerificationLogin = loginType === 'email_code';/);
  assert.doesNotMatch(source, /PhoneOutlined|LockOutlined/);
  assert.doesNotMatch(source, /name="phone"|name="password"/);
  assert.doesNotMatch(source, /loginType === 'phone_code'|loginType === 'email_password'|loginType === 'phone_password'/);
  assert.match(source, /title: '验证邮箱'/);
  assert.match(source, /验证码已发送至邮箱/);
});

test("persisted login types remain backward compatible", () => {
  const frontendTypes = read("frontend/src/types/index.ts");
  const schema = read("backend/prisma/schema.prisma");
  const route = read("backend/src/routes/accounts.ts");
  const values = ["email_code", "phone_code", "email_password", "phone_password", "manual_session"];

  for (const value of values) {
    assert.match(frontendTypes, new RegExp(value));
    assert.match(schema, new RegExp(value));
    assert.match(route, new RegExp(value));
  }
});

test("validate-session remains protected by the authenticated account param", () => {
  const route = read("backend/src/routes/accounts.ts");
  const paramStart = route.indexOf('accountsRouter.param("id"');
  const paramEnd = route.indexOf("accountsRouter.get", paramStart);
  const paramBlock = route.slice(paramStart, paramEnd);

  assert.match(paramBlock, /where: \{ id: accountId, adminId: req\.auth!\.userId \}/);
  assert.match(paramBlock, /throw new AppError\("Account not found", 404, 404\)/);
  assert.match(route, /accountsRouter\.post\("\/:id\/validate-session"/);
});

test("duplicate session ownership and merge queries stay within the same app variant", () => {
  const route = read("backend/src/routes/accounts.ts");
  const ownerStart = route.indexOf("async function assertCapturedSessionIsNotOwnedByAnotherAccount(");
  const ownerEnd = route.indexOf("function describeAccountVariant", ownerStart);
  const ownerBlock = route.slice(ownerStart, ownerEnd);
  const mergeStart = route.indexOf("async function mergeDuplicateAccounts(");
  const mergeEnd = route.indexOf("async function mergeDuplicateAccountData(", mergeStart);
  const mergeBlock = route.slice(mergeStart, mergeEnd);

  assert.match(ownerBlock, /buildSameVariantDuplicateAccountWhere/);
  assert.match(mergeBlock, /buildSameVariantDuplicateAccountWhere/);
  assert.match(route, /from "\.\.\/services\/account-duplicate-scope\.js"/);
});

test("manual session placeholders stay pending with monitoring disabled", () => {
  const route = read("backend/src/routes/accounts.ts");
  const start = route.indexOf('if (body.login_type === "manual_session")');
  const end = route.indexOf("return ok(res", start);
  const block = route.slice(start, end);

  assert.match(block, /status: AccountStatus\.pending/);
  assert.match(block, /monitorEnabled: false/);
});

test("account creation preserves an explicitly requested device id", () => {
  const route = read("backend/src/routes/accounts.ts");
  const schemaStart = route.indexOf("const createAccountSchema = z");
  const schemaEnd = route.indexOf("const updateAccountSchema", schemaStart);
  const schemaBlock = route.slice(schemaStart, schemaEnd);
  const createStart = route.indexOf('accountsRouter.post("/"');
  const createEnd = route.indexOf('accountsRouter.get("/:id"', createStart);
  const createBlock = route.slice(createStart, createEnd);

  assert.match(schemaBlock, /device_id: z\.string\(\)\.trim\(\)\.min\(1\)\.optional\(\)/);
  assert.match(createBlock, /body\.device_id \?\? existing\?\.dtDeviceId \?\? createDeviceId\(\)/);
  assert.match(createBlock, /dtDeviceId: deviceId/);
  assert.match(createBlock, /sendInput:[\s\S]*deviceId/);
});

test("account session import validates before any persistence", () => {
  const route = read("backend/src/routes/accounts.ts");
  const start = route.indexOf("async function importAuthorizedSession(");
  const end = route.indexOf("async function validateCapturedSessionBeforeImport(", start);
  const block = route.slice(start, end);
  const orchestratorIndex = block.indexOf("validateThenPersistDirectSession");
  const validationIndex = block.indexOf("validateCapturedSessionBeforeImport");
  const persistenceIndex = block.indexOf("persistCapturedSession");

  assert.ok(orchestratorIndex >= 0, "session import must use the validate-then-persist orchestrator");
  assert.ok(validationIndex > orchestratorIndex, "validation callback must be configured on the orchestrator");
  assert.ok(persistenceIndex > validationIndex, "persistence must appear after validation in the import function");
  assert.doesNotMatch(block, /tryValidateCapturedSessionQuickly/);
  assert.match(block, /validationError: null/);
  assert.match(block, /accountMonitorService\.stop\(persistedAccountId/);
  assert.match(block, /preserveMonitorEnabled: false/);
  assert.match(block, /targetStatus: AccountStatus\.offline/);
  assert.match(block, /emitStatus: false/);
});

test("public refresh errors are safe and do not echo raw Direct failures", () => {
  const route = read("backend/src/routes/accounts.ts");
  const refreshStart = route.indexOf('accountsRouter.post("/:id/refresh"');
  const refreshEnd = route.indexOf('accountsRouter.get("/:id/pointstore"', refreshStart);
  const refreshBlock = route.slice(refreshStart, refreshEnd);
  const validatedStart = route.indexOf("async function tryRefreshValidatedAccountData(");
  const validatedEnd = route.indexOf("async function tryHydrateImportedAccountFromHelper(", validatedStart);
  const validatedBlock = route.slice(validatedStart, validatedEnd);

  assert.match(route, /const SAFE_ACCOUNT_REFRESH_ERROR = "账号数据刷新失败，请稍后重试。"/);
  assert.match(refreshBlock, /refresh_error: SAFE_ACCOUNT_REFRESH_ERROR/);
  assert.doesNotMatch(refreshBlock, /refresh_error: error instanceof Error|refresh_error: String\(error\)/);
  assert.match(validatedBlock, /error: SAFE_ACCOUNT_REFRESH_ERROR/);
  assert.doesNotMatch(validatedBlock, /error: message|error instanceof Error \? error\.message : String\(error\)/);
});

test("pre-import validation has an explicit timeout and no account side effects", () => {
  const route = read("backend/src/routes/accounts.ts");
  const validationStart = route.indexOf("async function validateCapturedSession(");
  const validationEnd = route.indexOf("async function startMonitorAfterVerification(", validationStart);
  const validationBlock = route.slice(validationStart, validationEnd);
  const beforeImportStart = route.indexOf("async function validateCapturedSessionBeforeImport(");
  const beforeImportEnd = route.indexOf("async function tryValidateCapturedSessionQuickly(", beforeImportStart);
  const beforeImportBlock = route.slice(beforeImportStart, beforeImportEnd);

  assert.doesNotMatch(validationBlock, /prisma\.dtAccount\.update|persistCapturedSession/);
  assert.match(beforeImportBlock, /Promise\.race/);
  assert.match(beforeImportBlock, /delayResult\(8_000, timeout\)/);
  assert.match(beforeImportBlock, /result === timeout \? null : result/);
  assert.doesNotMatch(beforeImportBlock, /markPersistedSessionValidationFailure|prisma\.dtAccount\.update/);
});

test("legacy persisted-session validation marks safe failures while keeping manual import isolated", () => {
  const route = read("backend/src/routes/accounts.ts");
  const manualStart = route.indexOf("async function importAuthorizedSession(");
  const manualEnd = route.indexOf("async function validateCapturedSessionBeforeImport(", manualStart);
  const manualBlock = route.slice(manualStart, manualEnd);
  const quickStart = route.indexOf("async function tryValidateCapturedSessionQuickly(");
  const markStart = route.indexOf("async function markPersistedSessionValidationFailure(", quickStart);
  const assertStart = route.indexOf("function assertCapturedSessionMatchesAccountVariant", quickStart);
  const quickBlock = route.slice(quickStart, markStart);
  const markBlock = route.slice(markStart, assertStart);
  const sessionImportStart = route.indexOf("async function importSessionAccount(");
  const sessionImportEnd = route.indexOf("async function importFullBackupAccount(", sessionImportStart);
  const sessionImportBlock = route.slice(sessionImportStart, sessionImportEnd);
  const backupImportStart = sessionImportEnd;
  const backupImportEnd = route.indexOf("function normalizeAppVariantValue", backupImportStart);
  const backupImportBlock = route.slice(backupImportStart, backupImportEnd);

  assert.ok(markStart > quickStart, "quick validation must delegate persisted failure updates to a dedicated helper");
  assert.doesNotMatch(manualBlock, /tryValidateCapturedSessionQuickly|markPersistedSessionValidationFailure/);
  assert.match(quickBlock, /result === timeout/);
  assert.match(quickBlock, /markPersistedSessionValidationFailure\(account\.id, "timeout"\)/);
  assert.match(quickBlock, /classifyDirectSessionValidationFailure\(error\)/);
  assert.match(quickBlock, /markPersistedSessionValidationFailure\(account\.id, reasonCategory\)/);
  assert.doesNotMatch(quickBlock, /error instanceof Error|String\(error\)/);
  assert.match(markBlock, /prisma\.dtAccount\.update/);
  assert.match(markBlock, /status: AccountStatus\.error/);
  assert.match(markBlock, /lastError: persistedSessionValidationFailureMessage\(reasonCategory\)/);
  assert.match(sessionImportBlock, /tryValidateCapturedSessionQuickly/);
  assert.doesNotMatch(sessionImportBlock, /Imported session was saved, but direct validation did not complete/);
  assert.match(backupImportBlock, /tryValidateCapturedSessionQuickly/);
  assert.equal([...route.matchAll(/tryValidateCapturedSessionQuickly\(/g)].length, 3);
});

test("manual session import protects credentials and explains safe failures", () => {
  const modal = read("frontend/src/components/accounts/DirectSessionImportModal.tsx");

  assert.match(modal, /<Input\.Password autoComplete="off"/);
  assert.match(modal, /Token（敏感信息，默认隐藏）/);
  assert.match(modal, /应用类型/);
  assert.match(modal, /用户 ID \(dtUserId\)/);
  assert.match(modal, /设备 ID/);
  assert.match(modal, /rules=\{\[\{ required: true/);
  assert.match(modal, /Token 已失效或过期/);
  assert.match(modal, /设备参数与会话不匹配/);
  assert.match(modal, /Direct 会话校验超时/);
  assert.match(modal, /网络或后端暂时不可用/);
  assert.match(modal, /split\(\/\[\\n,\]\//);
  assert.match(modal, /new Set\(candidates\)/);
  assert.match(modal, /slice\(0, 8\)/);
  assert.match(modal, /destroyOnClose/);
  assert.match(modal, /form\.resetFields\(\)/);
  assert.match(modal, /closable=\{!loading\}/);
  assert.match(modal, /maskClosable=\{!loading\}/);
  assert.doesNotMatch(modal, /localStorage|sessionStorage|console\./);
});

test("account detail uses the controlled import modal and labels emulator-only capture", () => {
  const detail = read("frontend/src/pages/AccountDetail.tsx");

  assert.match(detail, /<DirectSessionImportModal/);
  assert.match(detail, /await validateSession\(accountId/);
  assert.match(detail, /setDirectSessionImportOpen\(false\)/);
  assert.match(detail, /await Promise\.all\(\[fetchAccount\(\{ force: true \}\), fetchPhones\(\{ force: true \}\)\]\)/);
  assert.match(detail, /模拟器测试导入（仅逆向\/测试）/);
  assert.match(detail, /不是正式部署依赖/);
  assert.doesNotMatch(detail, /let token = ''/);
});
