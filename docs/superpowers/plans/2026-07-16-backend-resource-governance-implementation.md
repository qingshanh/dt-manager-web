# 后端运行时资源治理与优雅关闭实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task with review checkpoints.

**Goal:** 保持 Direct 短信实时监听和主备接管能力，同时消除长期集合、重连、ADB 回退、周期任务和关闭流程造成的 CPU/内存异常。

**Architecture:** 将诊断集合统一改为有界环形缓冲和计数器；将高成本维护操作放入全局并发为 2 的队列；正式运行默认禁止 App/ADB/helper 回退；为周期服务和 HTTP/Direct/SSE/Prisma 建立幂等 shutdown coordinator；通过认证接口暴露不含敏感信息的运行指标。

**Tech Stack:** TypeScript、Node.js 22、Express、Prisma、Node test runner、Direct TCP 协议实现。

---

## 执行约束

- 不改变短信解析、入库、团队消息隔离和 Telegram 通知语义。
- 不降低 Direct 主备 push socket 的实时性；只限制诊断历史、维护任务和失败重试。
- 正式环境不得依赖模拟器；`DT_ALLOW_APP_FALLBACK=false` 时不能执行 `adb`、helper 或 App 数据库扫描。
- 不在日志或指标中输出手机号、邮箱、token、deviceId、原始帧、完整错误堆栈。
- 所有任务完成后与其它计划一起升 v0.2.9，只做一次提交。

## Task 1：建立通用有界集合和运行计数器

**Files:**

- Create: `backend/src/utils/bounded-buffer.ts`
- Create: `backend/src/utils/bounded-buffer.test.ts`
- Create: `backend/src/services/runtime-metrics.ts`
- Create: `backend/src/services/runtime-metrics.test.ts`

### Step 1：先写 RED

覆盖以下接口：

```ts
const buffer = new BoundedBuffer<number>(3);
buffer.push(1); buffer.push(2); buffer.push(3); buffer.push(4);
assert.deepEqual(buffer.values(), [2, 3, 4]);
assert.equal(buffer.totalAdded, 4);
assert.equal(buffer.dropped, 1);

runtimeMetrics.increment("direct.reconnects");
runtimeMetrics.setGauge("direct.activeListeners", 9);
assert.deepEqual(runtimeMetrics.snapshot(), {
  counters: { "direct.reconnects": 1 },
  gauges: { "direct.activeListeners": 9 }
});
```

还要测试容量小于 1 时抛错、返回值是副本、reset 仅用于测试且不会共享对象。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/utils/bounded-buffer.test.ts src/services/runtime-metrics.test.ts
```

Expected: 模块不存在。

### Step 3：实现最小功能

`BoundedBuffer<T>` 使用固定上限并在 push 时删除最旧记录；运行指标只接受预定义或前缀受控的数值 key，snapshot 返回普通对象。

### Step 4：运行 GREEN

```powershell
Set-Location backend
node --import tsx --test src/utils/bounded-buffer.test.ts src/services/runtime-metrics.test.ts
```

Expected: 全部通过。

## Task 2：限制 Direct 长期监听诊断数据

**Files:**

- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/dingtone/direct-message-listener.test.ts`
- Create: `backend/src/services/dingtone/direct-resource-bounds.test.ts`

### Step 1：先写 1 万次压力 RED

把长期监听诊断聚合提取为可测试对象：

```ts
const state = createDirectListenerDiagnostics();
for (let index = 0; index < 10_000; index += 1) {
  state.recordPush(fakePush(index));
  state.recordCall(fakeCall(index));
  state.recordTrace(fakeTrace(index));
  state.recordHostError("20.97.117.109", new Error(`failure-${index}`));
}
assert.equal(state.pushes.length, 100);
assert.equal(state.calls.length, 100);
assert.equal(state.trace.length, 160);
assert.equal(state.hostErrors.size, 1);
assert.equal(state.snapshot().counters.pushes, 10_000);
assert.doesNotMatch(JSON.stringify(state.snapshot()), /failure-0/);
```

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/services/dingtone/direct-resource-bounds.test.ts
```

Expected: 当前 `pushes/calls/trace/hostErrors` 无界，测试失败。

### Step 3：接入长期监听

在 `listenDirectSessionPushes` 中替换：

- `pushes` => 最近 100 条；
- `calls` => 最近 100 条；
- 外层 `trace` => 最近 160 帧；
- `hostErrors: unknown[]` => `Map<host, { count; lastAt; lastMessage; fatal }>`；
- 所有重连、raw frame、SMS push、丢弃记录写入 `runtimeMetrics`。

返回类型仍保持现有 `DirectProbeResult` 兼容；probe 与 regression 也使用明确上限，禁止 `Number.MAX_SAFE_INTEGER` 作为默认长期容量。短信必须先调用 `onPush` 完成实时入库，再把安全摘要放入诊断缓冲。

### Step 4：运行 GREEN 与回归

```powershell
Set-Location backend
node --import tsx --test src/services/dingtone/direct-resource-bounds.test.ts src/services/dingtone/direct-message-listener.test.ts
npm run verify:direct-regression
```

Expected: 有界断言和 Direct 回归通过。

## Task 3：限制 DirectSession buffer 与 queue

**Files:**

- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Create: `backend/src/services/dingtone/direct-session-queue.test.ts`

### Step 1：先写 RED

测试构造以下异常输入：

- 声明帧长度超过 2MB；
- 未完成 buffer 超过 4MB；
- raw frame queue 超过 512；
- JSON queue 超过 256。

断言：超长帧关闭该 session 并计数；队列满时优先保留 SMS `0x0103` 和协议控制帧，丢弃最旧诊断/未知帧；丢弃不会同步刷屏日志。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/services/dingtone/direct-session-queue.test.ts
```

### Step 3：实现硬上限

在 `DirectSession` 中定义并使用：

```ts
const MAX_DIRECT_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_DIRECT_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_DIRECT_RAW_QUEUE = 512;
const MAX_DIRECT_JSON_QUEUE = 256;
```

集中实现 `enqueueRawFrame` / `enqueueJsonFrame`；不得在多处直接 `queue.push`。超限计数写入 runtime metrics。

### Step 4：运行 GREEN

```powershell
Set-Location backend
node --import tsx --test src/services/dingtone/direct-session-queue.test.ts src/services/dingtone/direct-message-listener.test.ts
npm run verify:direct-regression
```

## Task 4：为 Direct 全局缓存增加 TTL/LRU 和账户释放

**Files:**

- Create: `backend/src/utils/ttl-lru-cache.ts`
- Create: `backend/src/utils/ttl-lru-cache.test.ts`
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/account-monitor.ts`

### Step 1：先写 RED

测试容量、TTL、触碰续期和显式删除：

```ts
const cache = new TtlLruCache<string, number>({ maxEntries: 2, ttlMs: 1000, now });
cache.set("a", 1); cache.set("b", 2); cache.get("a"); cache.set("c", 3);
assert.equal(cache.has("b"), false);
now.advance(1001);
assert.equal(cache.get("a"), undefined);
```

再测试 `releaseDirectAccountRuntime(account)` 会清理 phone country、SMS host affinity、offline tracker 和相关 listener/session 状态。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/utils/ttl-lru-cache.test.ts src/services/dingtone/direct-resource-bounds.test.ts
```

### Step 3：替换缓存

建议初始限制：

- country key：最多 500 个账户，TTL 24h；
- SMS host affinity：最多 500 个账户，TTL 6h；
- web offline tracker：最多 500 个账户，TTL 24h，tracker 内部原有 1000 条上限保留；
- 账户 `stop`、删除或身份变化时调用 `releaseDirectAccountRuntime`。

### Step 4：运行 GREEN

```powershell
Set-Location backend
node --import tsx --test src/utils/ttl-lru-cache.test.ts src/services/dingtone/direct-resource-bounds.test.ts
```

## Task 5：建立全局重任务并发队列

**Files:**

- Create: `backend/src/services/runtime-work-queue.ts`
- Create: `backend/src/services/runtime-work-queue.test.ts`
- Modify: `backend/src/services/account-monitor.ts`
- Modify: `backend/src/services/account-runtime.ts`
- Modify: `backend/src/services/point-store.ts`

### Step 1：先写 RED

队列测试同时提交 20 个 promise，记录峰值：

```ts
const queue = new RuntimeWorkQueue({ concurrency: 2, maxPending: 100 });
await Promise.all(Array.from({ length: 20 }, () => queue.run("offline-catchup", task)));
assert.equal(maxObserved, 2);
assert.equal(queue.snapshot().active, 0);
assert.equal(queue.snapshot().pending, 0);
```

还要测试相同账户+任务 key 可合并、队列满时拒绝新的低优先级维护任务、shutdown 后拒绝新任务。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/services/runtime-work-queue.test.ts
```

### Step 3：接入重任务

以下操作通过共享队列，默认并发 2：

- web/offline catch-up；
- 账户资料与手机号刷新；
- Point/商城非实时同步；
- 显式启用的 App fallback。

Direct push socket、路由注册和实时短信回调不得进入此队列。队列 active/pending/rejected 指标写入 runtime metrics。

### Step 4：运行 GREEN 与业务回归

```powershell
Set-Location backend
node --import tsx --test src/services/runtime-work-queue.test.ts src/services/account-monitor-config.test.ts src/services/point-store-order-history.test.ts
```

## Task 6：正式环境禁用 App/ADB/helper fallback，并增加全局冷却

**Files:**

- Modify: `backend/src/config.ts`
- Modify: `.env.example`
- Modify: `backend/src/services/settings.service.ts`
- Modify: `backend/src/services/account-monitor.ts`
- Modify: `backend/src/services/account-monitor-catchup.test.ts`
- Create: `backend/src/services/app-fallback-gate.test.ts`

### Step 1：先写 RED

测试三种环境：

```ts
assert.equal(resolveAppFallbackAllowed({ NODE_ENV: "production", DT_ALLOW_APP_FALLBACK: undefined }), false);
assert.equal(resolveAppFallbackAllowed({ NODE_ENV: "development", DT_ALLOW_APP_FALLBACK: "false" }), false);
assert.equal(resolveAppFallbackAllowed({ NODE_ENV: "development", DT_ALLOW_APP_FALLBACK: "true" }), true);
```

模拟 9 个 runner 在无 ADB 环境同时触发，断言 5 分钟冷却内 `exportSessionFromAdbConfig` 最多调用一次。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/services/app-fallback-gate.test.ts src/services/account-monitor-catchup.test.ts
```

### Step 3：实现门禁和冷却

`config.ts` 新增布尔配置 `DT_ALLOW_APP_FALLBACK`，默认 false。`loadMonitorConfig` 最终值必须为：

```ts
appCatchupEnabled = config.DT_ALLOW_APP_FALLBACK
  && parseBooleanSetting(settings.direct_monitor_app_catchup_enabled, false);
```

取消无条件 15 秒扫描；只允许 startup 的显式测试模式、Direct frame gap 信号或管理端手工触发。全局设备不可用/无 helper 失败后设置 5 分钟冷却，所有账户共享。

### Step 4：运行 GREEN

```powershell
Set-Location backend
node --import tsx --test src/services/app-fallback-gate.test.ts src/services/account-monitor-catchup.test.ts src/services/account-monitor-config.test.ts
```

Expected: production/default 路径不调用 ADB/helper。

## Task 7：修复周期服务 stop 后复活

**Files:**

- Create: `backend/src/services/background-loop.ts`
- Create: `backend/src/services/background-loop.test.ts`
- Modify: `backend/src/services/account-auto-refresh.ts`
- Modify: `backend/src/services/phone-expiry-reminder.ts`
- Modify: `backend/src/services/telegram-bot.ts`

### Step 1：先写 RED

用可控 deferred promise 复现：cycle 已进入 -> 调用 stop -> cycle finally 完成。断言 stop 后 timer 数为 0、不会再次 schedule、再次 start 可正常运行。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/services/background-loop.test.ts
```

### Step 3：实现统一状态机

状态至少包含：

```ts
private started = false;
private stopping = false;
private runningPromise: Promise<void> | null = null;
```

`schedule()` 在 `!started || stopping` 时直接返回；`stop()` 先标记 stopping，再清 timer，并可有限等待当前 promise。三个服务不再在 `finally` 无条件 schedule。

### Step 4：运行 GREEN 与 Telegram 回归

```powershell
Set-Location backend
node --import tsx --test src/services/background-loop.test.ts src/services/telegram-bot-integration.test.ts src/services/telegram-bot-callbacks.test.ts
```

## Task 8：增加 account monitor stopAll 与幂等 shutdown coordinator

**Files:**

- Modify: `backend/src/services/account-monitor.ts`
- Create: `backend/src/services/runtime-lifecycle.ts`
- Create: `backend/src/services/runtime-lifecycle.test.ts`
- Modify: `backend/src/index.ts`

### Step 1：先写 RED

通过注入假服务记录顺序，断言：

```ts
assert.deepEqual(calls, [
  "mark-stopping",
  "telegram.stop",
  "autoRefresh.stop",
  "expiryReminder.stop",
  "workQueue.stop",
  "accountMonitor.stopAll",
  "http.close",
  "sse.closeAll",
  "prisma.disconnect"
]);
```

同时调用 shutdown 两次，所有 stop 只执行一次；超时返回未完成组件，但第二次不会重新启动服务。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/services/runtime-lifecycle.test.ts
```

### Step 3：实现 stopAll 和 coordinator

`AccountMonitorService.stopAll()` 对当前 runner ID 做快照并 `Promise.allSettled` 调用 stop，确保 Direct listener preempt/close，最后 runners 清空、指标归零。

`index.ts` 保存 `http.Server`，注册一次 SIGINT/SIGTERM：

```ts
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
```

默认总超时 15 秒；fatal listen error 使用专用退出码，但仍复用可用的清理逻辑。正常退出前 `prisma.$disconnect()`。

### Step 4：运行 GREEN

```powershell
Set-Location backend
node --import tsx --test src/services/runtime-lifecycle.test.ts src/routes/backend-process-health.test.ts
npm run build
```

## Task 9：补全 SSE 清理与 HTTP body 上限

**Files:**

- Modify: `backend/src/routes/events.ts`
- Create: `backend/src/routes/events-cleanup.test.ts`
- Modify: `backend/src/index.ts`
- Create: `backend/src/routes/request-body-limits.test.ts`

### Step 1：先写 RED

SSE 测试连续连接/断开 100 次，分别触发 `req close`、`res close`、`res error`，断言 eventBus listener 与 heartbeat timer 回到基线，cleanup 仅执行一次。

body limit 测试断言：

- 普通 `/api/*` 约 2MB 以上返回 413；
- `/api/accounts/backup/import` 使用独立 100MB parser；
- 其它路由不会继承 100MB 上限。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/routes/events-cleanup.test.ts src/routes/request-body-limits.test.ts
```

### Step 3：实现

SSE 使用一个幂等函数：

```ts
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  clearInterval(timer);
  eventBus.off("event", listener);
  if (!res.writableEnded) res.end();
};
req.once("close", cleanup);
res.once("close", cleanup);
res.once("error", cleanup);
```

body parser 顺序必须先鉴权大请求，避免未授权请求先分配大内存：

```ts
app.use("/api/accounts/backup/import", requireAuth, express.json({ limit: "100mb" }));
app.use(express.json({ limit: "2mb" }));
```

后续挂载完整 accounts router 时可再次经过 `requireAuth`，但不得再次读取大 body。依赖 body-parser 对已解析请求的幂等检测；增加集成测试证明 backup 不被后续 2MB parser 再次拒绝，且未授权的大 backup 在读取完整 body 前返回 401。

### Step 4：运行 GREEN

```powershell
Set-Location backend
node --import tsx --test src/routes/events-cleanup.test.ts src/routes/request-body-limits.test.ts
```

## Task 10：增加认证运行指标接口

**Files:**

- Create: `backend/src/routes/runtime.ts`
- Create: `backend/src/routes/runtime-metrics.test.ts`
- Modify: `backend/src/index.ts`

### Step 1：先写 RED

断言 `/api/runtime/metrics` 位于 `requireAuth` 后，并返回：

- `process.memoryUsage()` 的 rss、heapUsed、heapTotal、external、arrayBuffers；
- uptime；
- monitor runner、Direct listener/session、缓存大小；
- reconnect/frame/SMS/drop/backoff 计数；
- work queue active/pending；
- `appFallbackAllowed`。

测试递归扫描响应 key/value，拒绝 `token`、`email`、`phoneNumber`、`deviceId`、`rawFrame`、`stack`。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/routes/runtime-metrics.test.ts
```

### Step 3：实现安全快照

route 只组合数值、布尔值、版本和时间；任何子系统读取失败只在 `warnings` 中返回固定类别，不返回原始错误文本。

### Step 4：运行 GREEN

```powershell
Set-Location backend
node --import tsx --test src/routes/runtime-metrics.test.ts src/services/runtime-metrics.test.ts
npm run build
```

## Task 11：后端完整回归和有界压力验收

**Files:**

- Create: `backend/src/scripts/verify-runtime-bounds.ts`
- Modify: `backend/package.json`

新增脚本：

```json
"verify:runtime-bounds": "tsx src/scripts/verify-runtime-bounds.ts"
```

脚本在无真实账户和无敏感数据条件下模拟 1 万次重连/帧/错误，输出仅包含计数与容量，并在超过上限时非零退出。

运行：

```powershell
Set-Location backend
$tests = Get-ChildItem -Recurse -Filter *.test.ts src | ForEach-Object { $_.FullName }
node --import tsx --test $tests
npm run build
npm run verify:runtime-bounds
npm run verify:direct-regression
```

Expected: 完整测试、构建、资源边界和 Direct 回归全部通过；此时仍不单独提交。
