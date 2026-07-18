# Direct SMS Route Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复直连短信路由抖动、重复离线补拉、目标号码误解析、模拟器依赖和故障重连资源风暴，并发布为 `0.2.11`。

**Architecture:** 保留 `e7443a5` 的 epoch/reservation 防并发注册机制，把 route lease 提升到 push worker 生命周期；辅助认证 link 只作为可替换传输，不再拥有 route 的释放权。解析器按二进制 envelope 和显式标签确定目标号码；重连使用独立的共享 transport governor；高频 Prisma 诊断写入由 latest-value writer 串行合并。

**Tech Stack:** Node.js 24、TypeScript、node:test、Prisma、TCP/TLS、React/Vite、PowerShell、Docker/Linux 部署配置。

---

## 文件结构

- Modify: `backend/src/services/dingtone/message-parser.ts` — 可靠提取短信目标号码。
- Modify: `backend/src/services/dingtone/message-parser.test.ts` — 二进制 envelope 与歧义号码回归。
- Modify: `backend/src/services/message-runtime.test.ts` — 验证解析失败时仍由账户已购号码唯一匹配。
- Modify: `backend/src/services/settings.service.ts` — App/ADB fallback 默认关闭，并保留数据库已有显式值。
- Modify: `backend/src/services/account-monitor.ts` — fallback 缺省关闭并接入串行诊断 writer。
- Modify: `backend/src/services/account-monitor-catchup.test.ts` — 正式部署不依赖模拟器的契约。
- Modify: `backend/src/services/dingtone/direct-gateway.ts` — sticky route、认证时序、离线补拉和 transport governor 接入。
- Modify: `backend/src/services/dingtone/direct-message-listener.test.ts` — 路由、心跳、注册和补拉契约。
- Create: `backend/src/services/dingtone/direct-transport-governor.ts` — 共享指数退避、jitter 与熔断。
- Create: `backend/src/services/dingtone/direct-transport-governor.test.ts` — 确定性 governor 行为测试。
- Create: `backend/src/utils/latest-async-writer.ts` — 最新值异步串行写入器。
- Create: `backend/src/utils/latest-async-writer.test.ts` — 并发、合并、flush 和 close 测试。
- Modify: `backend/src/services/dingtone/direct-resource-bounds.test.ts` — 新增 governor/writer 资源边界检查。
- Modify: `VERSION` and version-bearing manifests/configuration — 统一发布版本 `0.2.11`。
- Modify: `README.md` — 记录正式直连默认关闭模拟器 fallback。

### Task 1: 可靠解析短信目标号码

**Files:**
- Modify: `backend/src/services/dingtone/message-parser.test.ts`
- Modify: `backend/src/services/dingtone/message-parser.ts`
- Modify: `backend/src/services/message-runtime.test.ts`

- [ ] **Step 1: 写入二进制 envelope 失败测试**

在 `message-parser.test.ts` 增加以下测试，号码必须保持为虚构测试数据：

```ts
test("direct SMS parser prefers the binary envelope recipient over a trailing numeric id", () => {
  const lp = (value: string) => {
    const body = Buffer.from(value, "latin1");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    return Buffer.concat([length, body]);
  };
  const sender = "18185550101";
  const target = "61415550123";
  const unrelatedId = "32465550199";
  const prefix = Buffer.from("06000000af2c3d6a00000800001102", "hex");
  const control = Buffer.from("02040000000000000000", "hex");
  const info = Buffer.concat([prefix, lp(sender), lp(target), control, lp(unrelatedId), Buffer.alloc(16)]).toString("base64");
  const k3 = Buffer.concat([prefix, lp(sender), lp(target), control, Buffer.alloc(16)]).toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(818) 555-0101", info, k3, k5: 0 }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("PLAIN_AU_ROUTE_TEST")]);

  assert.equal(parseSmsPush(payload)?.toNumber, target);
});

test("direct SMS parser leaves target empty when binary metadata disagrees and has no explicit recipient label", () => {
  const info = Buffer.from("sender=18185550101 alpha=61415550123 beta=32465550199", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(818) 555-0101", info }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("AMBIGUOUS_TARGET")]);

  assert.equal(parseSmsPush(payload)?.toNumber, null);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run from `backend`:

```powershell
node --import tsx --test src/services/dingtone/message-parser.test.ts
```

Expected: 第一项失败，实际返回尾部附加数字标识；第二项失败，实际返回排序后的猜测值。

- [ ] **Step 3: 实现 envelope 和显式标签解析**

在 `message-parser.ts` 用以下职责明确的 helper 替换现有排序猜测：

```ts
const DIRECT_SMS_ENVELOPE_LENGTH_OFFSET = 15;

function readLengthPrefixedDigits(buffer: Buffer, offset: number) {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  const length = buffer.readUInt32LE(offset);
  if (length < 7 || length > 15 || offset + 4 + length > buffer.length) return null;
  const value = buffer.subarray(offset + 4, offset + 4 + length).toString("latin1");
  if (!/^\d+$/.test(value)) return null;
  return { value, nextOffset: offset + 4 + length };
}

function extractBinaryEnvelopeTarget(value?: string) {
  if (!value?.trim()) return null;
  try {
    const decoded = Buffer.from(value, "base64");
    const sender = readLengthPrefixedDigits(decoded, DIRECT_SMS_ENVELOPE_LENGTH_OFFSET);
    if (!sender) return null;
    return readLengthPrefixedDigits(decoded, sender.nextOffset)?.value ?? null;
  } catch {
    return null;
  }
}

function extractExplicitTarget(value?: string) {
  if (!value?.trim()) return null;
  try {
    const decoded = Buffer.from(value, "base64").toString("latin1");
    return decoded.match(/(?:target|recipient|to)\s*[:=]\s*\+?(\d{7,15})/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractTargetNumberFromPushMetadata(json: { info?: string; k3?: string }, fromNumber: string | null) {
  const binaryTargets = [json.info, json.k3]
    .map(extractBinaryEnvelopeTarget)
    .filter((value): value is string => Boolean(value))
    .filter((value) => !samePhoneDigits(value, fromNumber));
  const uniqueBinaryTargets = [...new Set(binaryTargets)];
  if (uniqueBinaryTargets.length === 1) return uniqueBinaryTargets[0];
  if (uniqueBinaryTargets.length > 1) return null;

  const explicitTargets = [json.info, json.k3]
    .map(extractExplicitTarget)
    .filter((value): value is string => Boolean(value))
    .filter((value) => !samePhoneDigits(value, fromNumber));
  const uniqueExplicitTargets = [...new Set(explicitTargets)];
  return uniqueExplicitTargets.length === 1 ? uniqueExplicitTargets[0] : null;
}
```

保留 `extractDigitRunsFromBase64()` 仅供 `restoreInternationalSender()` 使用。

- [ ] **Step 4: 增加运行时唯一已购号码兜底回归**

在 `message-runtime.test.ts` 增加：

```ts
test("uses the unique purchased phone when the parser intentionally leaves an ambiguous target empty", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    nickname: null,
    email: "owner@example.com",
    phone: null,
    dtUserId: "test-owner-1",
    telegramNotify: false
  });
  runtime.phones.set(1, [{ phoneNumber: "+61415550123" }]);

  const imported = await storeParsedSmsPushes(
    1,
    [{
      msgType: 561,
      fromNumber: "(818) 555-0101",
      toNumber: null,
      content: "TEST_DIRECT_TARGET",
      rawInfo: Buffer.from("recipient=61415550123 extra=32465550199", "utf8").toString("base64"),
      rawK3: Buffer.from("recipient=61415550123", "utf8").toString("base64")
    }],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.accountId, 1);
  assert.equal(runtime.messages[0]?.toNumber, "+61415550123");
});
```

不新增生产分支，因为当前 `inferDirectTargetNumberFromAccountPhones()` 已负责 `toNumber === null` 的唯一号码匹配。

- [ ] **Step 5: 运行定向测试并确认 GREEN**

```powershell
node --import tsx --test src/services/dingtone/message-parser.test.ts src/services/message-runtime.test.ts
```

Expected: 全部通过，错误附加数字标识不再进入存储结果。

### Task 2: 正式部署默认关闭 App/ADB fallback

**Files:**
- Modify: `backend/src/services/account-monitor-catchup.test.ts`
- Modify: `backend/src/services/settings.service.ts`
- Modify: `backend/src/services/account-monitor.ts`

- [ ] **Step 1: 把旧默认契约改成 RED 测试**

将 `account-monitor-catchup.test.ts` 第一项替换为：

```ts
test("direct monitor keeps app catch-up opt-in for emulator-only recovery", () => {
  assert.match(settingsSource, /\["direct_monitor_app_catchup_enabled", "false"/);
  assert.match(monitorSource, /parseBooleanSetting\(settings\.direct_monitor_app_catchup_enabled, false\)/);
  assert.doesNotMatch(settingsSource, /\["direct_monitor_app_catchup_enabled", "false", "true"\]/);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
node --import tsx --test src/services/account-monitor-catchup.test.ts
```

Expected: 默认值和解析 fallback 仍为 `true`，测试失败。

- [ ] **Step 3: 修改默认值并禁止启动时覆盖已有配置**

在 `settings.service.ts` 定义新描述并使用它：

```ts
const directAppCatchupDescription = "Local emulator/helper recovery only; disabled by default for formal direct deployments";

// defaultSettings
["direct_monitor_app_catchup_enabled", "false", directAppCatchupDescription],
```

删除：

```ts
["direct_monitor_app_catchup_enabled", "false", "true"],
```

不得新增任何 `true -> false` 自动迁移。旧版本无法可靠区分“历史默认 true”和“用户手动 true”，强制迁移会破坏显式配置。保持默认设置 upsert 的 `update: {}`，使数据库已有 `false` 或 `true` 都不被后端启动覆盖；当前项目由部署者显式设置为 `false`。

在 `account-monitor.ts` 改为：

```ts
const appCatchupEnabled = parseBooleanSetting(settings.direct_monitor_app_catchup_enabled, false);
```

- [ ] **Step 4: 验证手动开启能力仍保留**

保持现有“串行扫描”“只读取匹配登录账户”“UI 七天历史”测试不变，并运行：

```powershell
node --import tsx --test src/services/account-monitor-catchup.test.ts
```

Expected: 全部通过；代码仍可通过设置接口显式改成 `true`。

### Task 3: Sticky route 与安全主备接管

**Files:**
- Modify: `backend/src/services/dingtone/direct-message-listener.test.ts`
- Modify: `backend/src/services/dingtone/direct-gateway.ts`

- [ ] **Step 1: 写 sticky lease 和 grace 失败测试**

在 coordinator 测试区增加：

```ts
test("sticky route survives auxiliary link churn without backup takeover", () => {
  const route = createDirectRouteCoordinatorForTest("primary");
  const primaryEpoch = route.claim("primary");
  route.beginOwnerGrace("primary", primaryEpoch, 1_000, 15_000);

  assert.equal(route.ownerHost(), "primary");
  assert.equal(route.shouldClaim("backup", 15_999), false);
  assert.equal(route.shouldClaim("backup", 16_000), true);
  const backupEpoch = route.claim("backup");
  route.release("primary", primaryEpoch);
  assert.equal(route.isOwner("backup", backupEpoch), true);
});
```

把现有“辅助 link 关闭释放 route”测试反转为：

```ts
test("auxiliary link closure does not release the worker route lease", () => {
  const closeText = source.slice(
    source.indexOf("const closeLinkSession = async () =>"),
    source.indexOf("const ensureRouteRegistration = async")
  );
  assert.doesNotMatch(closeText, /routeCoordinator\.release/);
  assert.match(source, /const releaseRouteOwnership = \(\) =>/);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
node --import tsx --test src/services/dingtone/direct-message-listener.test.ts
```

Expected: coordinator 没有 grace API，且 `closeLinkSession()` 仍释放 route。

- [ ] **Step 3: 扩展 route coordinator 的 epoch-safe grace**

在 `createDirectRouteCoordinator()` 中加入 `ownerGraceUntil`，并实现：

```ts
beginOwnerGrace(host: string, epoch: number, now: number, graceMs: number) {
  if (owner === host && ownerEpoch === epoch) ownerGraceUntil = now + Math.max(0, graceMs);
},
confirmOwner(host: string, epoch: number) {
  if (owner === host && ownerEpoch === epoch) ownerGraceUntil = 0;
},
shouldClaim(host: string, now = Date.now()) {
  if (owner !== null && ownerGraceUntil > 0 && now >= ownerGraceUntil) {
    const expiredOwner = owner;
    owner = null;
    ownerEpoch += 1;
    ownerGraceUntil = 0;
    backupEligible = expiredOwner === primaryHost;
  }
  return owner === null && (host === primaryHost ? !backupEligible : backupEligible);
},
```

`claim()`、`release()` 和 `markPrimaryUnavailable()` 均清除 `ownerGraceUntil`。旧 epoch release 继续无效。

- [ ] **Step 4: 把 route lease 提升到 push worker 生命周期**

在 `runPairedHostWorker()` 中保留 `linkReservationEpoch`，把注册成功后的 epoch 存入 worker 级 `routeLeaseEpoch`。实现统一释放函数：

```ts
const releaseRouteOwnership = () => {
  if (routeLeaseEpoch !== null) {
    routeCoordinator.release(host, routeLeaseEpoch);
    routeLeaseEpoch = null;
  }
  if (linkReservationEpoch !== null) {
    routeCoordinator.release(host, linkReservationEpoch);
    linkReservationEpoch = null;
  }
};
```

`closeLinkSession()` 只关闭 socket 和 trace，不修改 lease。辅助 link 结束时调用：

```ts
if (routeLeaseEpoch !== null) {
  routeCoordinator.beginOwnerGrace(host, routeLeaseEpoch, Date.now(), DIRECT_ROUTE_OWNER_GRACE_MS);
}
await closeLinkSession();
```

同一 worker 重建 link 时，若 `routeCoordinator.isOwner(host, routeLeaseEpoch)`，允许 `ensureLinkSession()` 继续执行，但 `ensureRouteRegistration()` 直接返回并调用 `confirmOwner()`，不得再次执行 `updateClientLink`。只有注册失败、push worker finally、preempt 或明确主线路不可用时调用 `releaseRouteOwnership()`。

- [ ] **Step 5: 运行 sticky route 测试并确认 GREEN**

```powershell
node --import tsx --test src/services/dingtone/direct-message-listener.test.ts
```

Expected: 辅助 link 重连不释放、不重复注册；grace 到期或 push worker 退出后才接管。

### Task 4: 修正认证心跳顺序并限制启动离线补拉

**Files:**
- Modify: `backend/src/services/dingtone/direct-message-listener.test.ts`
- Modify: `backend/src/services/dingtone/direct-gateway.ts`

- [ ] **Step 1: 写认证顺序和补拉失败测试**

更新现有时序测试，要求：

```ts
test("paired sockets start heartbeat only after authentication and priming", () => {
  const openText = source.slice(source.indexOf("async openPush"), source.indexOf("private async openPrelogin"));
  assert.doesNotMatch(openText, /openLink[\s\S]*startSocketKeepalive/);
  assert.match(openText, /openLink[\s\S]*bootstrapAuthenticatedSession[\s\S]*startPairedKeepalive/);
});

test("auxiliary link churn does not resend startup offline catch-up", () => {
  const primeText = source.slice(source.indexOf("private async primeLinkRegistration"), source.indexOf("private async openPrelogin"));
  assert.doesNotMatch(primeText, /requestAllOfflineMessage|dt_direct_template_offline_messages/);
  assert.match(source, /await requestOfflineCatchup\(linkSession, host, "startup"\)/);
});
```

反转 private-number 顺序断言：`ensureRouteRegistration(linkSession)` 必须早于 `runPushMaintenanceCalls(...)`。

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
node --import tsx --test src/services/dingtone/direct-message-listener.test.ts
```

Expected: `openLink()` 仍在 bootstrap 前立即写 heartbeat，且 prime 每次都隐式发送离线模板。

- [ ] **Step 3: 改造 heartbeat API 和 bootstrap callback**

把 paired keepalive 改为显式首发和周期参数：

```ts
private startPairedKeepalive(firstHeartbeatAtMs: number, intervalMs: number) {
  // 保留现有非阻塞 write 逻辑
  const elapsedSinceConnect = Math.max(0, Date.now() - this.socketConnectedAt);
  const firstDelayMs = calculateDirectPairedKeepaliveDelay(elapsedSinceConnect, firstHeartbeatAtMs);
  this.keepaliveTimer = setTimeout(() => {
    sendPairedKeepalive();
    this.keepaliveTimer = setInterval(sendPairedKeepalive, intervalMs);
    this.keepaliveTimer.unref?.();
  }, firstDelayMs);
  this.keepaliveTimer.unref?.();
}
```

`bootstrapAuthenticatedSession()` 增加 `onStarted?: () => Promise<void>`，在 login packet 写入后、drain frames 前执行。`openPush()` 在 `openPrelogin()` 完成后启动 paired keepalive；`openLink()` 使用：

```ts
await this.openPrelogin(account);
await this.bootstrapAuthenticatedSession(account, DIRECT_LINK_BOOTSTRAP_WAIT_MS, async () => {
  await this.primeLinkRegistration(account);
});
this.startPairedKeepalive(DIRECT_LINK_FIRST_KEEPALIVE_MS, DIRECT_PAIRED_KEEPALIVE_INTERVAL_MS);
```

`openLink()` 不再调用 `startSocketKeepalive()`。

- [ ] **Step 4: 把离线补拉移出每次 link prime**

从 `primeLinkRegistration()` 删除 `dt_direct_template_offline_messages` 发送。`ensureLinkSession()` 改成：

```ts
await linkSession.openLink(input.account);
await ensureRouteRegistration(linkSession);
if (!offlineTemplateSent && Date.now() >= nextOfflineCatchupAt) {
  await requestOfflineCatchup(linkSession, host, "startup");
}
diagnostics.recordCalls(await runPushMaintenanceCalls(linkSession, runtime, input.account));
```

删除原来无条件增加 `offlineTemplateSendCount` 的代码，只允许 `requestOfflineCatchup()` 在 `sent === true` 时计数。成功后 `nextOfflineCatchupAt = deadline`；失败后沿用 `DIRECT_OFFLINE_CATCHUP_RETRY_MS`。discovery 和 probe 调用 `openLink()` 时不再隐式消耗补拉额度。

- [ ] **Step 5: 运行定向测试并确认 GREEN**

```powershell
node --import tsx --test src/services/dingtone/direct-message-listener.test.ts src/services/dingtone/direct-resource-bounds.test.ts
```

Expected: 认证时序、route 注册顺序和启动补拉计数全部通过。

### Task 5: 共享 transport governor

**Files:**
- Create: `backend/src/services/dingtone/direct-transport-governor.ts`
- Create: `backend/src/services/dingtone/direct-transport-governor.test.ts`
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/dingtone/direct-resource-bounds.test.ts`

- [ ] **Step 1: 写 governor 行为测试**

```ts
test("transport governor opens one shared circuit and permits one half-open probe", () => {
  let now = 0;
  const governor = new DirectTransportGovernor({ now: () => now, random: () => 0.5, openAfterFailures: 3 });
  governor.recordFailure("proxy:local", "push");
  governor.recordFailure("proxy:local", "push");
  governor.recordFailure("proxy:local", "push");

  assert.equal(governor.beforeAttempt("proxy:local", "push").allowed, false);
  now = 30_000;
  assert.equal(governor.beforeAttempt("proxy:local", "push").allowed, true);
  assert.equal(governor.beforeAttempt("proxy:local", "push").allowed, false);
  governor.recordSuccess("proxy:local", "push");
  assert.equal(governor.beforeAttempt("proxy:local", "push").allowed, true);
});
```

另加指数退避封顶、jitter 边界和最多 128 entries 的测试。

- [ ] **Step 2: 运行新测试并确认 RED**

```powershell
node --import tsx --test src/services/dingtone/direct-transport-governor.test.ts
```

Expected: 模块不存在。

- [ ] **Step 3: 实现有界 governor**

实现以下公开接口：

```ts
export type DirectTransportRole = "push" | "link" | "discovery";
export type DirectTransportPermit = { allowed: boolean; waitMs: number; probe: boolean };

export class DirectTransportGovernor {
  constructor(options?: {
    now?: () => number;
    random?: () => number;
    minDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    openAfterFailures?: number;
    openDurationMs?: number;
    maxEntries?: number;
  });
  beforeAttempt(key: string, role: DirectTransportRole): DirectTransportPermit;
  recordFailure(key: string, role: DirectTransportRole): number;
  recordSuccess(key: string, role: DirectTransportRole): void;
  snapshot(): { entries: number; openCircuits: number };
  clear(): void;
}
```

默认参数：`500ms`、`30_000ms`、`0.2` jitter、5 次失败开启、30 秒 open、128 entries。每个 state 记录连续失败、`blockedUntil`、`probeInFlight` 和最后访问时间；超限时删除最旧 entry。

- [ ] **Step 4: 接入 push/link 重连**

在 `direct-gateway.ts` 创建模块级 governor。transport key 只使用脱敏 endpoint：代理模式使用 `protocol + hostname + port`，直连模式使用 `host + port`，不得包含用户名或密码。

每次连接前使用同一调用模式：

```ts
const permit = directTransportGovernor.beforeAttempt(transportKey, role);
if (!permit.allowed) {
  const remainingMs = Math.max(0, deadline - Date.now());
  await delay(Math.min(permit.waitMs, remainingMs));
  if (listener.preempted || !isWithinCurrentListenWindow()) return null;
}

try {
  await session.openLink(input.account);
} catch (error) {
  directTransportGovernor.recordFailure(transportKey, role);
  throw error;
}
```

当 route-owning push 读取稳定达到 `DIRECT_LINK_HEALTHY_AFTER_MS` 后执行：

```ts
directTransportGovernor.recordSuccess(transportKey, "push");
directTransportGovernor.recordSuccess(transportKey, "link");
```

在 `openPush()` 和 `openLink()` 前调用 `beforeAttempt()`；不允许时等待 `Math.min(waitMs, remainingListenWindow)`，且等待后重新检查 `listener.preempted`。连接/注册失败调用 `recordFailure()`；route-owning push 稳定达到现有 15 秒健康阈值后调用 `recordSuccess()`，TCP 刚连通时不能立即清零。

- [ ] **Step 5: 运行 governor 和 listener 测试**

```powershell
node --import tsx --test src/services/dingtone/direct-transport-governor.test.ts src/services/dingtone/direct-message-listener.test.ts src/services/dingtone/direct-resource-bounds.test.ts
```

Expected: 熔断共享、有界，故障期间不再出现每秒数百次连接尝试。

### Task 6: 合并高频 Prisma 诊断写入

**Files:**
- Create: `backend/src/utils/latest-async-writer.ts`
- Create: `backend/src/utils/latest-async-writer.test.ts`
- Modify: `backend/src/services/account-monitor.ts`

- [ ] **Step 1: 写 writer RED 测试**

```ts
test("latest async writer coalesces a burst and never overlaps sinks", async () => {
  const releases: Array<() => void> = [];
  const written: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const writer = new LatestAsyncWriter<string>(async (value) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => releases.push(resolve));
    written.push(value);
    inFlight -= 1;
  }, { minIntervalMs: 0 });

  writer.schedule("first", { immediate: true });
  writer.schedule("middle", { immediate: true });
  writer.schedule("latest", { immediate: true });
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()?.();
  await writer.close();

  assert.equal(maxInFlight, 1);
  assert.deepEqual(written, ["first", "latest"]);
});
```

再覆盖 `flush()` 立即写最新值以及 `close()` 清 timer 并等待最终写入。

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
node --import tsx --test src/utils/latest-async-writer.test.ts
```

Expected: 模块不存在。

- [ ] **Step 3: 实现 LatestAsyncWriter**

公开接口：

```ts
export class LatestAsyncWriter<T> {
  constructor(sink: (value: T) => Promise<void>, options: { minIntervalMs: number; now?: () => number });
  schedule(value: T, options?: { immediate?: boolean }): void;
  flush(value?: T): Promise<void>;
  close(): Promise<void>;
}
```

实现约束：只保存一个 pending 最新值；一个 drain promise；任何时候最多一个 sink；sink 失败后允许后续值继续写；所有 timer 调用 `unref?.()`；`close()` 禁止新 schedule、清 timer 并 flush。

- [ ] **Step 4: 接入 account monitor**

在 `pollDirectMessages()` 创建：

```ts
const diagnosticWriter = new LatestAsyncWriter<string>(async (value) => {
  await prisma.monitorSession.update({
    where: { id: runner.sessionId },
    data: { routeAddress: value }
  });
}, { minIntervalMs: 10_000 });
```

`updateLiveDiagnostic(force)` 只构造最新 `diagnosticNote` 并调用：

```ts
diagnosticWriter.schedule(diagnosticNote, { immediate: force });
```

SMS、host status、offline catch-up callback 不再直接并发 Prisma update。`finally` 中只执行一次：

```ts
await diagnosticWriter.flush(diagnosticNote ?? undefined).catch(logDiagnosticError);
await diagnosticWriter.close().catch(logDiagnosticError);
```

删除当前 final 路径的重复 `monitorSession.update()`。

- [ ] **Step 5: 运行 writer 和 monitor 测试**

```powershell
node --import tsx --test src/utils/latest-async-writer.test.ts src/services/account-monitor-config.test.ts src/services/account-monitor-catchup.test.ts
```

Expected: writer 最大并发为 1，最终数据库快照等于最新状态。

### Task 7: 版本同步、完整自动验证与发布检查

**Files:**
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
- Modify: `backend/src/services/version-sync.test.ts`
- Modify: `README.md`

- [ ] **Step 1: 将全部版本源同步为 0.2.11**

只修改现有版本字段，不恢复已经被用户回退删除的完整 runtime-governance 模块。运行：

```powershell
node --import tsx --test src/services/version-sync.test.ts
```

Expected: 所有版本源均为 `0.2.11`。

- [ ] **Step 2: 运行定向测试**

```powershell
node --import tsx --test `
  src/services/dingtone/direct-message-listener.test.ts `
  src/services/dingtone/direct-resource-bounds.test.ts `
  src/services/dingtone/direct-session-queue.test.ts `
  src/services/dingtone/direct-transport-governor.test.ts `
  src/services/dingtone/message-parser.test.ts `
  src/services/message-runtime.test.ts `
  src/services/account-monitor-catchup.test.ts `
  src/utils/latest-async-writer.test.ts
```

Expected: 全部通过。

- [ ] **Step 3: 运行完整后端测试**

```powershell
$tests = Get-ChildItem -LiteralPath 'src' -Recurse -Filter '*.test.ts' -File | Select-Object -ExpandProperty FullName
node --import tsx --test $tests
```

Expected: 当前 332 项基线测试加新增测试全部通过，无 skipped failure。

- [ ] **Step 4: 运行双端生产构建**

From repository root:

```powershell
npm --prefix backend run build
npm --prefix frontend run build
```

Expected: TypeScript 与 Vite build 成功。

- [ ] **Step 5: 运行 direct regression**

```powershell
npm --prefix backend run verify:direct-regression -- --static-only
npm --prefix backend run verify:direct-regression -- --account-id 459
```

Expected: 静态协议回归和指定已知有效账户回归通过。真实回归不替代短信端到端验证。

- [ ] **Step 6: 检查 diff 与敏感文件**

```powershell
git status --short --ignored
git ls-files --others --exclude-standard
git diff --check
git diff --cached --check

$badTracked = git ls-files | Where-Object {
  $_ -match '(^|/)\.env($|\.(?!example$))' -or
  $_ -match '\.(db|sqlite|sqlite3|log|pcap|pcapng|har)$' -or
  $_ -match '(^|/)_tmp/'
}
if ($badTracked) { throw '发现不应追踪的敏感文件' }
```

Expected: `.env`、数据库、日志、抓包和 `_tmp` 均未被追踪；人工查看 staged diff 中不存在 token、密码、邮箱、真实手机号、IMEI、MAC、序列号或局域网 IP。

### Task 8: 正式直连运行时验收

**Files:**
- Create ignored artifact: `_tmp/direct-sms-soak.csv`
- Inspect: `_tmp/logs/backend.out.log`

- [ ] **Step 1: 停止模拟器 App 并确认 fallback=false**

```powershell
adb -s 127.0.0.1:21503 shell am force-stop com.talkyou.app.im
adb -s 127.0.0.1:21503 shell am force-stop me.dingtone.app.im
```

在 `backend` 目录运行已有只读查询：

```powershell
node --import tsx ..\_tmp\query-sms-state.ts 12025550123
```

Expected: 输出设置中的 `direct_monitor_app_catchup_enabled` 为 `false`；重启后端后再次查询仍为 `false`。

- [ ] **Step 2: 检查健康状态**

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:5174/health' -TimeoutSec 5 | ConvertTo-Json -Depth 6
```

Expected: `ok=true`、`version=0.2.11`、`gatewayMode=direct`。

- [ ] **Step 3: 运行 30 分钟进程 soak**

在仓库根目录运行：

```powershell
$samples = [System.Collections.Generic.List[object]]::new()
$lastPid = 0
$lastCpu = 0.0
$lastAt = Get-Date

1..60 | ForEach-Object {
  $now = Get-Date
  $pidNow = Get-NetTCPConnection -LocalPort 5174 -State Listen |
    Select-Object -First 1 -ExpandProperty OwningProcess
  $process = Get-Process -Id $pidNow
  $elapsed = [Math]::Max(0.001, ($now - $lastAt).TotalSeconds)
  $cpuPercent = if ($pidNow -eq $lastPid) {
    (($process.CPU - $lastCpu) / $elapsed) * 100
  } else { 0 }

  $samples.Add([pscustomobject]@{
    Timestamp = $now.ToString('o')
    PID = $pidNow
    Restarted = $lastPid -ne 0 -and $pidNow -ne $lastPid
    CPUPercentSingleCore = [Math]::Round($cpuPercent, 2)
    WorkingSetMB = [Math]::Round($process.WorkingSet64 / 1MB, 2)
    PrivateMB = [Math]::Round($process.PrivateMemorySize64 / 1MB, 2)
    Handles = $process.HandleCount
    Threads = $process.Threads.Count
    TcpConnections = @(Get-NetTCPConnection -OwningProcess $pidNow -ErrorAction SilentlyContinue).Count
  })

  $lastPid = $pidNow
  $lastCpu = $process.CPU
  $lastAt = $now
  Start-Sleep -Seconds 30
}

$samples | Export-Csv '_tmp\direct-sms-soak.csv' -NoTypeInformation -Encoding UTF8
$samples | Format-Table -AutoSize
```

验收：PID 不变化；故障恢复后各指标进入平台区间，没有持续线性增长。

- [ ] **Step 4: 对比 route 与离线补拉日志增量**

记录 soak 开始和结束时以下模式的计数：

```powershell
Select-String -LiteralPath '_tmp\logs\backend.out.log' -Pattern `
  'Direct auxiliary link read ended|releasing SMS route|owns the SMS route|requestAllOfflineMessage'
```

Expected: 辅助 link 可重连，但不再伴随 route release/claim 风暴；`offlineCatchupSends` 不随 5 秒 link 波动增长。

- [ ] **Step 5: 做真实短信端到端验证**

在模拟器 App 停止状态下，选择至少三个此前已验证可投递的不同国家号码发送普通短信。验收：10 秒内入库、账户归属正确、`toNumber` 正确。外部验证码若官方客户端也未收到，单独标记为上游未投递，不计为项目回归失败。

- [ ] **Step 6: 最终提交与推送**

只 stage 本次修复和已经确认需要纳入发布的用户修改，确认版本为 `0.2.11` 后提交：

```powershell
git commit -m "fix: release v0.2.11 direct SMS route stability"
git push origin codex/management-upgrades
```

如果用户要求直接更新 `main`，先确认远程分支状态再执行相应 push；不得擅自重写历史或强推。
