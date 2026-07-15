import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../../..");

function readProjectFile(relativePath: string) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("release version defaults stay aligned across local and container startup", () => {
  const version = readProjectFile("VERSION").trim();
  const backendPackage = JSON.parse(readProjectFile("backend/package.json")) as { version: string };
  const frontendPackage = JSON.parse(readProjectFile("frontend/package.json")) as { version: string };
  const compose = readProjectFile("docker-compose.yml");
  const startScript = readProjectFile("start.ps1");
  const escapedVersion = version.replaceAll(".", "\\.");

  assert.equal(backendPackage.version, version);
  assert.equal(frontendPackage.version, version);
  assert.match(compose, new RegExp("APP_VERSION: \\$\\{APP_VERSION:-" + escapedVersion + "\\}"));
  assert.match(compose, new RegExp("VITE_APP_VERSION: \\$\\{VITE_APP_VERSION:-" + escapedVersion + "\\}"));
  assert.match(startScript, new RegExp(`-Name "APP_VERSION" -Default "${escapedVersion}"`));
});

test("account table is compact and does not expose the phone column or horizontal scrolling", () => {
  const source = readProjectFile("frontend/src/pages/AccountList.tsx");

  assert.match(source, /title: '备注'[\s\S]{0,240}width: 116/);
  assert.match(source, /title: '类型'[\s\S]{0,120}width: 80/);
  assert.match(source, /title: '邮箱'[\s\S]{0,160}width: 196/);
  assert.match(source, /title: '用户 ID'[\s\S]{0,160}width: 120/);
  assert.doesNotMatch(source, /title: '手机号'/);
  assert.doesNotMatch(source, /title: '号码'/);
  assert.doesNotMatch(source, /搜索备注 \/ 邮箱 \/ 手机号/);
  assert.doesNotMatch(source, /· 号码 \{record\.active_phone_count\}/);
  assert.doesNotMatch(source, /scroll=\{\{ x:/);
  assert.match(source, /size="small"/);
  assert.match(source, /tableLayout="fixed"/);
  assert.match(source, /compactAccountRows/);
});

test("frontend supports light, dark, and system theme modes", () => {
  const main = readProjectFile("frontend/src/main.tsx");
  const store = readProjectFile("frontend/src/stores/theme.ts");
  const layout = readProjectFile("frontend/src/layouts/AppLayout.tsx");

  assert.match(store, /export type ThemeMode = 'light' \| 'dark' \| 'system'/);
  assert.match(store, /prefers-color-scheme: dark/);
  assert.match(store, /localStorage/);
  assert.match(main, /theme\.darkAlgorithm/);
  assert.match(main, /resolvedTheme/);
  assert.match(layout, /value:\s*'system'/);
  assert.match(layout, /SunOutlined/);
  assert.match(layout, /MoonOutlined/);
  assert.match(layout, /DesktopOutlined/);
});

test("settings keep low-frequency transport controls in a collapsed advanced section", () => {
  const source = readProjectFile("frontend/src/pages/Settings.tsx");

  assert.match(source, /<Collapse/);
  assert.match(source, /高级设置/);
  assert.match(source, /defaultActiveKey=\{\[\]\}/);
  assert.match(source, /dt_real_bridge_timeout_ms/);
  assert.match(source, /dt_direct_template_offline_messages/);
});

test("direct monitor concurrency setting matches the backend positive integer contract", () => {
  const source = readProjectFile("frontend/src/pages/Settings.tsx");
  const block = source.slice(
    source.indexOf('name="direct_monitor_max_concurrent"'),
    source.indexOf("</Form.Item>", source.indexOf('name="direct_monitor_max_concurrent"')),
  );

  assert.match(block, /<InputNumber min=\{1\}/);
  assert.doesNotMatch(block, /0 表示不限制/);
});

test("authentication only expires the session for an explicit unauthorized response", () => {
  const api = readProjectFile("frontend/src/services/api.ts");
  const auth = readProjectFile("frontend/src/stores/auth.ts");
  const middleware = readProjectFile("backend/src/middleware/auth.ts");

  assert.match(api, /timeout: 60000/);
  assert.match(api, /export class ApiClientError/);
  assert.match(api, /kind: 'unauthorized' \| 'timeout' \| 'network' \| 'request'/);
  assert.match(api, /export function isUnauthorizedError/);
  assert.match(api, /apiCode === 40101/);
  assert.match(auth, /if \(isUnauthorizedError\(error\)\)/);
  assert.match(auth, /return Boolean\(cachedUser\)/);
  assert.match(middleware, /AppError\("Missing bearer token", 401, 40101\)/);
  assert.match(middleware, /AppError\("Invalid or expired token", 401, 40101\)/);
});

test("team and offline message collection covers non-SMS conversation types", () => {
  const adb = readProjectFile("backend/src/services/adb-database.ts");
  const runtime = readProjectFile("backend/src/services/message-runtime.ts");
  const gateway = readProjectFile("backend/src/services/dingtone/direct-gateway.ts");
  const monitor = readProjectFile("backend/src/services/account-monitor.ts");
  const accounts = readProjectFile("backend/src/routes/accounts.ts");

  assert.match(adb, /conversationType in \(3,4,8,9,11\)/);
  assert.match(adb, /conversationType: toNumber\(row\.conversationType\)/);
  assert.match(runtime, /conversationType\?: number \| null/);
  assert.match(runtime, /resolveHelperTeamName\(normalizedRow, account\.appVariant\)/);
  assert.match(runtime, /叮咚团队/);
  assert.match(runtime, /说道团队/);
  assert.match(gateway, /requestAllOfflineMessage/);
  assert.match(gateway, /getWebOfflineMessage: Buffer\.from/);
  assert.match(gateway, /callJsonFromTemplate\("getWebOfflineMessage", TEMPLATES\.getWebOfflineMessage/);
  assert.match(gateway, /aOfflineMessagse/);
  assert.match(gateway, /normalizeDirectWebOfflineMessages/);
  assert.match(monitor, /onWebOfflineMessages/);
  assert.match(monitor, /sendTelegram: false/);
  assert.match(monitor, /pollAppFallbackMessages/);
  assert.match(monitor, /storeHelperSmsMessages/);
  assert.match(monitor, /direct_monitor_app_ui_fallback_enabled, false/);
  assert.match(accounts, /TEAM_MESSAGE_SENDERS = \["叮咚团队", "说道团队"\]/);
  assert.match(accounts, /fromNumber: \{ in: TEAM_MESSAGE_SENDERS \}/);
});
