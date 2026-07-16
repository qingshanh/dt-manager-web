# v0.2.10 Direct SMS Listener Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复不依赖 App/helper/模拟器的 Direct 实时短信接收，同时保留 v0.2.9 的等待器、队列、缓存和并发资源边界。

**Architecture:** 保留当前双网关和主备路由协调，只移除已认证 socket 的读暂停行为；用已有事件循环让出、批次上限和日志节流控制 CPU。连接健康改为“注册成功后持续存活一段时间才算健康”，读取失败立即上报 degraded，避免数据库和面板长期假在线。

**Tech Stack:** TypeScript、Node.js `net`/`tls`、Node test runner、Prisma、PowerShell 生命周期脚本、Direct 真实回归脚本。

---

## 文件结构

- Modify: `backend/src/services/dingtone/direct-gateway.ts` — Direct socket 读循环、配对连接稳定性和主机状态上报。
- Modify: `backend/src/services/dingtone/direct-message-listener.test.ts` — socket 不暂停和连接稳定性回归测试。
- Modify: `backend/src/services/account-monitor.ts` — 根据配对主机状态生成 `active/degraded` 诊断。
- Modify: `backend/src/services/account-monitor-lifecycle.test.ts` — 假在线诊断回归测试。
- Modify: `backend/src/services/version-sync.test.ts` — 0.2.10 版本同步 RED 测试。
- Modify: `VERSION`, `.env.example`, `backend/package.json`, `backend/package-lock.json`, `backend/src/config.ts`, `frontend/package.json`, `frontend/package-lock.json`, `frontend/vite.config.ts`, `frontend/Dockerfile`, `docker-compose.yml`, `start.ps1`, `deploy/systemd/dt-manager.env.example` — 版本升级为 0.2.10。
- Modify: `docs/runtime-resource-acceptance.md` — 增加短信恢复的真实验收记录格式。

### Task 1: 用失败测试锁定 socket 读暂停回归

**Files:**
- Modify: `backend/src/services/dingtone/direct-message-listener.test.ts`
- Test: `backend/src/services/dingtone/direct-message-listener.test.ts`

- [ ] **Step 1: 把旧的 socket backpressure 测试改为期望已认证 socket 永不 pause**

用以下测试替换 `direct socket applies socket backpressure while dropping idle non-SMS frames`：

```ts
test("direct socket never pauses authenticated reads while dropping idle non-SMS frames", () => {
  assert.doesNotMatch(source, /this\.socket\.pause\(\)/);
  assert.doesNotMatch(source, /this\.socket\?\.resume\(\)/);
  assert.doesNotMatch(source, /DIRECT_IDLE_NON_SMS_FRAME_PAUSE_/);
  assert.match(source, /if \(!shouldTraceFrame\) \{[\s\S]*this\.shouldYieldBufferedConsume\(processedFrames\)[\s\S]*continue;[\s\S]*\}/);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
backend\node_modules\.bin\tsx.cmd --test backend\src\services\dingtone\direct-message-listener.test.ts
```

Expected: FAIL，明确命中 `this.socket.pause()`、`resume()` 或 `DIRECT_IDLE_NON_SMS_FRAME_PAUSE_*`。

### Task 2: 最小移除读暂停并保留 CPU 边界

**Files:**
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Test: `backend/src/services/dingtone/direct-message-listener.test.ts`

- [ ] **Step 1: 删除读暂停专用常量和状态**

删除：

```ts
const DIRECT_IDLE_NON_SMS_FRAME_PAUSE_BATCH = 3;
const DIRECT_IDLE_NON_SMS_FRAME_PAUSE_MS = 750;
```

以及 `DirectSession` 中的：

```ts
private idleDroppedNonSmsFrameCount = 0;
private idleSocketPaused = false;
private idleSocketPauseTimer: NodeJS.Timeout | null = null;
```

- [ ] **Step 2: 非短信空闲帧只做丢弃和事件循环让出**

把 `consume()` 的分支改为：

```ts
if (!shouldTraceFrame) {
  processedFrames += 1;
  if (this.shouldYieldBufferedConsume(processedFrames)) {
    return;
  }
  continue;
}
```

删除 `pauseIdleSocketAfterDroppedFrame()`，并删除 `close()` 中对应 timer 清理。保留：

```ts
const DIRECT_SOCKET_FRAME_BUDGET_PER_TICK = 20;
const DIRECT_PUSH_NON_SMS_FRAME_BATCH_LIMIT = 5;
const DIRECT_PUSH_NON_SMS_FRAME_PAUSE_MS = 1_000;
```

- [ ] **Step 3: 运行目标测试确认 GREEN**

Run:

```powershell
backend\node_modules\.bin\tsx.cmd --test backend\src\services\dingtone\direct-message-listener.test.ts backend\src\services\dingtone\direct-session-queue.test.ts backend\src\services\dingtone\direct-resource-bounds.test.ts
```

Expected: 所有测试 PASS；raw 16MB、JSON 8MB、2MB 单帧和 waiter 清理测试仍通过。

### Task 3: 用稳定窗口定义健康连接并消除假在线

**Files:**
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/dingtone/direct-message-listener.test.ts`
- Modify: `backend/src/services/account-monitor.ts`
- Modify: `backend/src/services/account-monitor-lifecycle.test.ts`

- [ ] **Step 1: 先写连接稳定性 RED 测试**

在 `direct-message-listener.test.ts` 增加：

```ts
test("direct paired links become healthy only after a stable read window", () => {
  assert.match(source, /const DIRECT_LINK_HEALTHY_AFTER_MS = 15_000/);
  assert.match(source, /isDirectLinkStable\(linkOpenedAt, Date\.now\(\)\)/);
  assert.match(source, /reportHostStatus\(host, "failed",/);
  assert.match(source, /stablePairs \+= 1/);
});
```

在 `account-monitor-lifecycle.test.ts` 增加：

```ts
test("direct diagnostics report degraded when every paired host has failed", () => {
  const state = createDirectMonitorFrameStateForTest();
  state.failedHosts.set("primary", "socket ended");
  state.failedHosts.set("backup", "socket reset");
  assert.equal(resolveDirectMonitorListenStateForTest(state, false), "degraded");
});
```

- [ ] **Step 2: 运行新测试确认 RED**

Run:

```powershell
backend\node_modules\.bin\tsx.cmd --test backend\src\services\dingtone\direct-message-listener.test.ts backend\src\services\account-monitor-lifecycle.test.ts
```

Expected: FAIL，因为稳定窗口常量、稳定判定和测试导出尚不存在。

- [ ] **Step 3: 实现稳定连接判定**

在 `direct-gateway.ts` 增加：

```ts
const DIRECT_LINK_HEALTHY_AFTER_MS = 15_000;

function isDirectLinkStable(openedAt: number, now: number) {
  return openedAt > 0 && now - openedAt >= DIRECT_LINK_HEALTHY_AFTER_MS;
}
```

在 `successfulPairs` 同级增加整个监听窗口共享的：

```ts
let stablePairs = 0;
```

在每个 paired worker 内增加：

```ts
let linkOpenedAt = 0;
let linkReportedHealthy = false;
```

`openLink()` 和 route registration 成功后设置：

```ts
linkOpenedAt = Date.now();
linkReportedHealthy = false;
```

不要立即 `reportHostStatus(host, "connected", null)`。每次 link `waitForPushes()` 成功返回后执行：

```ts
if (!linkReportedHealthy && isDirectLinkStable(linkOpenedAt, Date.now())) {
  linkReportedHealthy = true;
  stablePairs += 1;
  await reportHostStatus(host, "connected", null);
}
```

link 注册或读取失败时，在关闭 link 前执行：

```ts
await reportHostStatus(host, "failed", error instanceof Error ? error.message : String(error));
linkOpenedAt = 0;
linkReportedHealthy = false;
```

监听窗口结束时，如果没有稳定连接且不是 preempt：

```ts
if (!listener.preempted && stablePairs === 0 && lastError) {
  throw normalizeDirectError(lastError);
}
```

- [ ] **Step 4: 实现 degraded 诊断状态**

在 `account-monitor.ts` 提取并导出测试辅助：

```ts
function resolveDirectMonitorListenState(state: DirectMonitorFrameState, preempted: boolean) {
  if (preempted) return "preempted" as const;
  if (state.pairedHosts.size === 0 && state.failedHosts.size > 0) return "degraded" as const;
  return "active" as const;
}

export function createDirectMonitorFrameStateForTest(): DirectMonitorFrameState {
  return {
    host: null,
    pairedHosts: new Set(),
    connectingHosts: new Set(),
    failedHosts: new Map(),
    rawPushFrames: 0,
    smsPushes: 0,
    nonSmsPushFrames: 0,
    statusCounts: new Map(),
    hostCounts: new Map(),
    missedStatus0103Sample: null
  };
}

export const resolveDirectMonitorListenStateForTest = resolveDirectMonitorListenState;
```

把 `buildDirectMonitorLiveDiagnosticNote()` 的 `listenState` 类型扩展为：

```ts
"active" | "degraded" | "completed" | "preempted"
```

`updateLiveDiagnostic()` 调用时传入：

```ts
resolveDirectMonitorListenState(liveState, preempted)
```

- [ ] **Step 5: 运行目标测试确认 GREEN**

Run:

```powershell
backend\node_modules\.bin\tsx.cmd --test backend\src\services\dingtone\direct-message-listener.test.ts backend\src\services\account-monitor-lifecycle.test.ts
```

Expected: PASS。

### Task 4: 按 TDD 同步版本到 0.2.10

**Files:**
- Modify: `backend/src/services/version-sync.test.ts`
- Modify: `VERSION`
- Modify: `.env.example`
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Modify: `backend/src/config.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `start.ps1`
- Modify: `deploy/systemd/dt-manager.env.example`

- [ ] **Step 1: 只把版本测试期望改为 0.2.10**

在 `version-sync.test.ts` 中把 `expectedVersion` 和所有明确版本正则改为 `0.2.10`。

- [ ] **Step 2: 运行版本测试确认 RED**

Run:

```powershell
backend\node_modules\.bin\tsx.cmd --test backend\src\services\version-sync.test.ts
```

Expected: FAIL，实际版本仍为 0.2.9。

- [ ] **Step 3: 同步所有生产入口**

把文件结构列出的版本入口统一改为 `0.2.10`。本地被忽略的 `.env` 只修改 `APP_VERSION` 和 `VITE_APP_VERSION`，不输出或改动其他配置。

- [ ] **Step 4: 运行版本测试确认 GREEN**

Run:

```powershell
backend\node_modules\.bin\tsx.cmd --test backend\src\services\version-sync.test.ts
```

Expected: PASS。

### Task 5: 自动化回归验证

**Files:**
- Modify: `docs/runtime-resource-acceptance.md`

- [ ] **Step 1: 记录短信恢复验收字段**

在文档增加以下检查项：

```markdown
- Direct link 连续存活至少 60 秒后才报告 active；
- 60 秒观察窗内 paired registration/read failure 不超过初始连接数量；
- `offlineCatchupSends` 不因数秒重连持续增长；
- 已知成功号码必须出现 `0x0103 -> parsed SMS -> stored message`；
- 正式部署 `appFallbackAllowed=false`。
```

- [ ] **Step 2: 运行构建和完整测试**

Run:

```powershell
npm --prefix backend run build
backend\node_modules\.bin\tsx.cmd --test "backend\src\**\*.test.ts"
npm --prefix backend run verify:runtime-bounds
npm --prefix backend run verify:direct-regression
npm --prefix frontend run build
```

Expected: 后端构建、全部测试、20 项资源边界、账户 459 Direct regression 和前端构建全部通过。

- [ ] **Step 3: 运行 Windows 生命周期契约**

Run:

```powershell
tools\test-runtime-process-lib.ps1
tools\test-start-script-contract.ps1
tools\test-stop-script-contract.ps1
node backend\scripts\dev-supervisor-policy.test.mjs
```

Expected: 全部 PASS。

### Task 6: 本地 A/B 和真实短信验收

**Files:**
- Inspect: `_tmp/logs/backend.out.log`
- Inspect: `_tmp/runtime/processes.json`
- Inspect: local Prisma database through safe aggregate queries

- [ ] **Step 1: 停止 0.2.9 并启动 0.2.10**

Run:

```powershell
.\stop.ps1
.\start.ps1 -SkipInstall
```

Expected: `/health` 返回 `version=0.2.10`，instanceId 与 manifest 一致，9 个 Direct 监听恢复。

- [ ] **Step 2: 观察 60 秒连接稳定性**

记录观察窗开始时的日志长度和各账户 `offlineCatchupSends`，60 秒后比较：

- 不能继续出现每 5 秒数十次的 registration/read failure；
- 至少一个主机连接持续超过 15 秒并报告 active；
- `socket ended ... keepaliveWrites=0` 不得持续刷屏；
- raw/JSON drop、oversized frame、buffer overflow 仍为 0。

如果连接抖动没有显著下降，停止修复并执行设计中的回滚条件，不进入多变量修改。

- [ ] **Step 3: 请求用户向已知成功号码发送测试短信**

优先使用此前成功的英国或荷兰号码。验收日志和数据库只输出账户 ID、国家、时间、`0x0103`/解析/入库布尔结果，不输出完整手机号、验证码或原始帧。

Expected: 至少一条真实短信完成 `0x0103 -> parse -> store -> optional Telegram`。

### Task 7: 安全检查并形成单一 v0.2.10 提交

**Files:**
- Inspect: all staged files

- [ ] **Step 1: 检查格式和敏感信息**

Run:

```powershell
git diff --check
git status --short
```

检查新增内容中不存在 `.env`、数据库、token、密码、非示例邮箱、完整手机号、IMEI、MAC、Wi-Fi、序列号、局域网 IP、日志或抓包文件。

- [ ] **Step 2: 将设计 checkpoint amend 为最终发布提交**

先确认 HEAD 是 `ea8f578 docs: specify v0.2.10 SMS listener recovery`，然后：

```powershell
git add -A
git diff --cached --check
git commit --amend -m "fix: release v0.2.10 Direct SMS listener recovery"
```

Expected: 最终历史中只有一个新的 v0.2.10 提交，包含规格、计划、实现、测试和版本升级；工作树干净。不要推送，除非用户另行明确要求。
