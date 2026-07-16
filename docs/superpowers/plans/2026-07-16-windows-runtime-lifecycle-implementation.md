# Windows 本地进程生命周期与 supervisor 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task with review checkpoints.

**Goal:** 让 `start.ps1` / `stop.ps1` 精确管理本项目进程树，彻底解决停止残留、旧实例误判成功和端口冲突重启风暴。

**Architecture:** 用 `_tmp/runtime/processes.json` 保存带实例标识、PID 与创建时间的所有权清单；启动和停止共用一份 PowerShell 生命周期库。后端 `/health` 返回本次 `instanceId`。开发 supervisor 把退出分为 fatal 与可恢复两类，并使用有上限的退避与熔断。

**Tech Stack:** PowerShell 5.1、Node.js 22、ESM、Node test runner、Express health endpoint。

---

## 执行约束

- 本计划所有任务完成前不要提交；与另外两份资源治理计划一起升到 v0.2.9 后只做一次最终提交。
- 不得使用 `taskkill /IM node.exe` 或按进程名批量杀 Node。
- 集成测试只处理清单中经过 PID、创建时间、实例标识校验的进程。
- 当前旧版后端仍在运行；首次真实生命周期测试前先记录其 PID 和端口，实施新停止逻辑后再由新逻辑接管，不能误杀 Codex、MCP、浏览器或其它项目进程。

## Task 1：建立可测试的 runtime manifest 模型

**Files:**

- Create: `tools/runtime-process-lib.ps1`
- Create: `tools/test-runtime-process-lib.ps1`
- Modify: `.gitignore`

### Step 1：先写失败测试

在 `tools/test-runtime-process-lib.ps1` 中 dot-source 生命周期库，并覆盖：

```powershell
$manifest = New-RuntimeManifest -ProjectRoot $root -InstanceId "test-instance"
Assert-Equal 1 $manifest.schemaVersion
Assert-Equal "test-instance" $manifest.instanceId
Assert-Equal 0 @($manifest.services).Count

$manifest = Add-RuntimeService -Manifest $manifest -Name "backend" -RootPid 1234 `
  -CreationTime "20260716120000.000000+480" -Port 5174
Assert-Equal "backend" $manifest.services[0].name
Assert-Equal 1234 $manifest.services[0].rootPid
```

再写原子写入、损坏 JSON、重复 service 更新、路径不一致拒绝四组断言。测试文件使用自带 `Assert-Equal` / `Assert-Throws`，不引入 Pester。

### Step 2：运行测试确认 RED

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-runtime-process-lib.ps1
```

Expected: 因 `tools/runtime-process-lib.ps1` 或函数不存在而失败。

### Step 3：实现最小生命周期库

导出并逐一实现以下函数：`New-RuntimeManifest`、`Read-RuntimeManifest`、`Write-RuntimeManifestAtomic`、`Add-RuntimeService`、`Remove-RuntimeManifest`、`Get-ProcessCreationTime`、`Test-OwnedRuntimeProcess`、`Get-DescendantProcessSnapshot`、`Stop-OwnedRuntimeService`、`Get-PortOwnerProcessId`。

`Write-RuntimeManifestAtomic` 必须在同目录写临时文件后用 `Move-Item -Force` 替换；manifest 只允许包含：

```json
{
  "schemaVersion": 1,
  "projectRoot": "D:\\workspace\\dt-manager-web",
  "instanceId": "uuid",
  "startedAt": "ISO timestamp",
  "services": [
    { "name": "backend", "rootPid": 1234, "creationTime": "WMI timestamp", "port": 5174 }
  ]
}
```

`Test-OwnedRuntimeProcess` 至少校验 PID 存活、WMI `CreationDate` 一致；若命令行可读，还要匹配 `DT_RUNTIME_INSTANCE_ID=<instanceId>` 或启动根 PowerShell 的明确实例标记。无法验证时返回 false，不允许猜测。

### Step 4：加入忽略规则并确认 GREEN

`.gitignore` 明确加入：

```gitignore
_tmp/runtime/
```

运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-runtime-process-lib.ps1
git status --short
```

Expected: 测试通过；测试生成的 manifest 不出现在 Git 状态中。

## Task 2：让 health 能证明实例身份

**Files:**

- Modify: `backend/src/config.ts`
- Modify: `backend/src/index.ts`
- Create: `backend/src/routes/runtime-health.test.ts`

### Step 1：先写失败测试

测试 `config.ts` 包含可选的 `DT_RUNTIME_INSTANCE_ID`，并测试 health payload 构造函数：

```ts
assert.deepEqual(buildHealthPayload({
  version: "0.2.8",
  gatewayMode: "direct",
  instanceId: "instance-a",
  startedAt: new Date("2026-07-16T00:00:00.000Z"),
  now: new Date("2026-07-16T00:00:05.000Z")
}), {
  ok: true,
  version: "0.2.8",
  gatewayMode: "direct",
  instanceId: "instance-a",
  startedAt: "2026-07-16T00:00:00.000Z",
  uptimeSeconds: 5
});
```

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/routes/runtime-health.test.ts
```

Expected: 缺少配置项或 `buildHealthPayload` 导出而失败。

### Step 3：实现 health 身份字段

新增 `backend/src/services/runtime-health.ts` 或在 `index.ts` 外提纯函数。`/health` 仅增加：

```ts
instanceId: config.DT_RUNTIME_INSTANCE_ID || null,
startedAt: processStartedAt.toISOString(),
uptimeSeconds: Math.max(0, Math.floor((Date.now() - processStartedAt.getTime()) / 1000))
```

不得输出 PID、命令行、环境变量、token 或路径。

### Step 4：运行 GREEN

```powershell
Set-Location backend
node --import tsx --test src/routes/runtime-health.test.ts src/routes/backend-process-health.test.ts
npm run build
```

Expected: 测试与生产构建通过。

## Task 3：把 start.ps1 改为基于所有权清单启动

**Files:**

- Modify: `start.ps1`
- Modify: `tools/runtime-process-lib.ps1`
- Create: `tools/test-start-script-contract.ps1`

### Step 1：先写脚本契约测试

测试必须验证：

- manifest 路径固定为 `_tmp/runtime/processes.json`；
- 每次启动生成 `[guid]::NewGuid()`；
- backend 命令注入 `DT_RUNTIME_INSTANCE_ID`；
- 不带 `-WithHelper` 时注入 `DT_ALLOW_APP_FALLBACK=false`；
- 带 `-WithHelper` 时才注入 `DT_ALLOW_APP_FALLBACK=true`；
- `Wait-HttpEndpoint` 对 backend 要比较返回的 `instanceId`；
- 任一服务失败进入 `catch/finally`，回收本次已写入 manifest 的服务。

### Step 2：运行 RED

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-start-script-contract.ps1
```

Expected: 现有 `start.ps1` 不满足 manifest 和实例校验断言。

### Step 3：实现启动流程

在导入 `.env` 后：

```powershell
$runtimeDir = Join-Path $root "_tmp\runtime"
$manifestPath = Join-Path $runtimeDir "processes.json"
$instanceId = [guid]::NewGuid().ToString("D")
$manifest = New-RuntimeManifest -ProjectRoot $root -InstanceId $instanceId
```

启动前执行：

1. 读取旧 manifest；
2. 只停止校验为本项目所有的旧服务；
3. 检查 5173、5174 和可选 5175 owner；无关进程占用时抛出包含 PID 的错误，但不终止它；
4. 每成功 `Start-DetachedPowerShell` 一个服务，立即读取 CreationDate、写入 manifest；
5. backend ready 检查解析 JSON 并要求 `instanceId -eq $instanceId`；
6. 部分失败时按 manifest 回收本次服务并删除 manifest。

后端启动命令必须包含：

```powershell
`$env:DT_RUNTIME_INSTANCE_ID = '$instanceId';
`$env:DT_ALLOW_APP_FALLBACK = '$($WithHelper.IsPresent.ToString().ToLowerInvariant())';
```

前端和 helper 根 PowerShell 命令也加入只用于所有权校验的 `DT_RUNTIME_INSTANCE_ID` 环境标记。

### Step 4：运行 GREEN

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-runtime-process-lib.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-start-script-contract.ps1
```

Expected: 全部通过。

## Task 4：把 stop.ps1 改为精确、幂等停止

**Files:**

- Modify: `stop.ps1`
- Modify: `tools/runtime-process-lib.ps1`
- Create: `tools/test-stop-script-contract.ps1`

### Step 1：先写失败测试

契约测试验证：

- 首选读取 manifest，不再以命令行正则为主；
- 先对 root/supervisor 发停止信号，再处理启动时快照出的后代；
- 验证 PID 与创建时间，PID 复用时拒绝终止；
- 最后检查 manifest PID 和端口；
- 有残留时 `$global:LASTEXITCODE`/进程退出码非零；
- manifest 不存在时第二次 stop 返回成功；
- fallback 只接受端口 owner + 明确实例/脚本路径的交叉证据。

### Step 2：运行 RED

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-stop-script-contract.ps1
```

Expected: 当前正则型 stop 脚本失败。

### Step 3：实现停止流程

核心伪代码：

```powershell
$manifest = Read-RuntimeManifest -Path $manifestPath
foreach ($service in @($manifest.services | Sort-Object { $_.name -eq "backend" } -Descending)) {
  Stop-OwnedRuntimeService -Service $service -InstanceId $manifest.instanceId
}
$residuals = Test-RuntimeManifestResiduals -Manifest $manifest
if ($residuals.Count -gt 0) {
  $residuals | ForEach-Object { Write-Error $_ }
  exit 1
}
Remove-RuntimeManifest -Path $manifestPath
exit 0
```

`Stop-OwnedRuntimeService` 必须先快照后代，再停止 root 以冻结 supervisor，最后清理快照中仍存活且创建时间未变化的后代。停止失败时列出服务名、PID、端口。

### Step 4：运行 GREEN

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-stop-script-contract.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-runtime-process-lib.ps1
```

Expected: 全部通过。

## Task 5：为 supervisor 增加 fatal 分类、退避和熔断

**Files:**

- Create: `backend/scripts/dev-supervisor-policy.mjs`
- Create: `backend/scripts/dev-supervisor-policy.test.mjs`
- Modify: `backend/scripts/dev-supervisor.mjs`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/routes/backend-process-health.test.ts`

### Step 1：先写纯策略失败测试

策略接口：

模块导出 `FATAL_LISTEN_EXIT_CODE = 78`，以及接受 `exits`、`now`、`stableRunMs`、`exitCode`、`stopping` 的 `nextRestartDecision(input)`；返回值固定为 `{ restart, delayMs, reason, nextFailureCount }`。

测试断言：

- exit code 78 => `{ restart: false, reason: "fatal" }`；
- 连续失败延迟依次为 1500、3000、6000、12000、30000ms；
- 60 秒窗口第 6 次快速失败 => 熔断、不重启；
- 子进程稳定运行 60 秒后下一次回到 1500ms；
- stopping 状态不重启。

### Step 2：运行 RED

```powershell
Set-Location backend
node --test scripts/dev-supervisor-policy.test.mjs
```

Expected: 模块不存在而失败。

### Step 3：实现策略并接入 supervisor

`index.ts` 对 `EADDRINUSE` / `EACCES` 设置 `process.exitCode = 78` 并关闭 server/退出；supervisor 收到 78 立即退出。普通崩溃按策略调度，日志包含 attempt、delayMs、windowFailures，不重复打印完整堆栈。

停止处理必须：

```js
stopping = true;
clearTimeout(restartTimer);
child.kill(signal);
```

等待 child 有限退出；Windows 兜底只结束这个 child PID 的树，不结束所有 Node。

### Step 4：运行 GREEN

```powershell
Set-Location backend
node --test scripts/dev-supervisor-policy.test.mjs
node --import tsx --test src/routes/backend-process-health.test.ts
npm run build
```

Expected: 全部通过。

## Task 6：真实生命周期与端口冲突集成验收

**Files:**

- Create: `tools/test-local-lifecycle.ps1`
- Modify: `README.md`

### Step 1：编写集成脚本

脚本记录运行前 Node PID 基线，然后循环 10 次：

```powershell
& .\start.ps1 -SkipInstall
$health = Invoke-RestMethod http://127.0.0.1:5174/health
Assert-True ([guid]::TryParse($health.instanceId, [ref]([guid]::Empty)))
& .\stop.ps1
Assert-PortFree 5173
Assert-PortFree 5174
Assert-ManifestMissing
Assert-NoOwnedPidRemains
```

另起一个只占用 5174 的测试进程，运行 `start.ps1 -SkipInstall`，断言 10 秒内非零退出、占位进程仍存活、backend 日志不持续出现 `starting backend`。

### Step 2：先执行一次受控验收

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-local-lifecycle.ps1 -Iterations 1
```

Expected: 完整启动/停止成功；不影响运行前不属于 manifest 的 Node 进程。

### Step 3：执行 10 次稳定性验收

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-local-lifecycle.ps1 -Iterations 10
```

Expected:

- 每次 `instanceId` 不同；
- 5173/5174/可选 5175 全部释放；
- manifest 中 PID 全消失；
- 不出现持续重启和日志风暴；
- Codex/MCP/其它 Node PID 基线仍存活。

### Step 4：更新文档

README 写明：普通本地启动默认禁用 helper/ADB；逆向测试使用 `start.ps1 -WithHelper`；停止脚本只处理本项目 manifest 所有的进程。

## 本计划验收门槛

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-runtime-process-lib.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-start-script-contract.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/test-stop-script-contract.ps1
Set-Location backend
node --test scripts/dev-supervisor-policy.test.mjs
node --import tsx --test src/routes/runtime-health.test.ts src/routes/backend-process-health.test.ts
npm run build
```

全部通过后才能进入跨环境总验收；此时仍不单独提交。
