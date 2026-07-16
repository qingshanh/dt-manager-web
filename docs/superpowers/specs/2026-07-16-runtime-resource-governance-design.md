# v0.2.9 运行资源治理与多环境部署设计

## 1. 背景与目标

项目需要同时支持三种运行方式：

1. Windows 本地开发与逆向测试；
2. Linux 服务器普通部署（systemd + Nginx）；
3. Docker Compose 部署。

本次目标是在不明显降低短信实时性的前提下，解决以下问题：

- 本地执行 `stop.ps1` 后项目进程不能完全退出；
- 旧实例占用端口时，新 supervisor 会持续重启并产生 CPU、内存和日志风暴；
- Direct 长期监听把原本有限生命周期的诊断数组变成无界保留数据；
- 正式 Direct 运行仍按账户高频探测 ADB、模拟器数据库或 helper；
- 后端缺少统一 graceful shutdown，部分周期服务在 `stop()` 后可能重新调度；
- 本地、Linux 和 Docker 缺少一致的资源限制、运行指标和验收标准。

明确不做：

- 不降低短信数据的持久化完整性；
- 不删除历史短信、订单或手机号等业务数据；
- 不取消 Direct 主备网关和故障接管；
- 不让正式部署依赖模拟器、ADB 或 helper；
- 不通过全局终止 `node.exe` 解决残留进程，因为系统中存在大量与项目无关的 Node 工具进程。

## 2. 已确认的实际证据

### 2.1 本地停止失效

当前后端运行链路为：

```text
PowerShell
└─ npm
   └─ cmd
      └─ dev-supervisor
         └─ backend node
```

这些进程使用相对命令行，例如 `npm run dev`、`node scripts/dev-supervisor.mjs` 和 `node --import tsx src/index.ts`。现有 `stop.ps1` 依赖项目绝对路径正则，实际执行后整棵进程树仍存活，5174 端口和 `/health` 仍可访问。

### 2.2 supervisor 重启风暴

端口被旧后端占用时，新 supervisor 对 `EADDRINUSE` 仍每 1.5 秒重启一次。实际日志在约 18.5 分钟内记录 458 次启动和 914 行端口占用错误。`start.ps1` 只检查 URL 是否可访问，因此会把旧实例的健康检查误认为新实例已成功启动。

### 2.3 Direct 长期内存增长

9 个账户开启监听、Direct 并发上限为 10，因此监听会长期延长而不返回。`pushes`、`calls`、外层 `trace` 和 `hostErrors` 在长期闭包中持续追加。

实际运行期间：

- link/offline 重连累计接近 8000 次；
- 原始帧超过 11000 条；
- App fallback 扫描超过 33000 条；
- 后端 Private Memory 在约 13 分钟内增加约 35MB。

单个 DirectSession 的 trace 虽有上限，但外层聚合结果没有上限，因此增长与运行时间相关。

### 2.4 正式模式的 ADB 子进程开销

当前设置为每账户每 15 秒执行 App catch-up。无模拟器时仍会先运行 `adb devices`。9 个账户理论上会产生约 36 次 ADB 子进程/分钟。该行为与“正式部署脱离模拟器”冲突。

## 3. 总体架构

治理分为四层：

1. **进程所有权层**：本地启动记录实例清单，停止按清单精确终止；
2. **监督与恢复层**：区分不可恢复错误与普通崩溃，使用退避和熔断；
3. **后端资源层**：所有长期集合、缓存、socket、timer 和周期服务都有明确生命周期与容量；
4. **部署资源层**：Windows、systemd 和 Docker 使用同一生产后端，但由各自平台控制 CPU、内存、进程数和重启策略。

实时短信连接与高消耗维护任务分离：

- 每个已监听账户继续保持 Direct 主备推送连接；
- 离线补偿、资料刷新、App 测试回退等重任务进入全局有界队列；
- 正式环境不运行 App/ADB 回退；
- 诊断数据只保留最近记录和累计计数，不保留无限历史对象。

## 4. Windows 本地进程生命周期

### 4.1 Runtime manifest

`start.ps1` 每次启动生成随机 `instanceId`，并原子写入：

```text
_tmp/runtime/processes.json
```

清单至少包含：

```json
{
  "schemaVersion": 1,
  "projectRoot": "...",
  "instanceId": "uuid",
  "startedAt": "ISO timestamp",
  "services": [
    {
      "name": "backend",
      "rootPid": 1234,
      "creationTime": "WMI creation timestamp",
      "port": 5174
    }
  ]
}
```

`_tmp/runtime` 继续保持 Git 忽略状态，不保存 token、邮箱、手机号、设备标识或其它凭据。

### 4.2 启动流程

1. 读取旧 manifest；
2. 校验 PID、创建时间和项目实例标记；
3. 清理确属旧实例的进程树；
4. 验证目标端口为空；
5. 注入 `DT_RUNTIME_INSTANCE_ID`；
6. 启动 backend、frontend，以及可选 helper；
7. 每启动一个服务就更新 manifest；
8. 健康检查必须返回本次 `instanceId`；
9. 任一组件失败时回收本次已启动的所有进程并清除 manifest。

不得只因为 5174 返回 HTTP 200 就判定本次后端启动成功。

### 4.3 停止流程

1. 读取并校验 manifest；
2. 快照每个 root PID 的后代进程；
3. 先停止 supervisor/root，冻结重新拉起能力；
4. 再终止快照中的剩余后代；
5. 验证 manifest PID 全部消失；
6. 验证 5173、5174 和可选 5175 不再由本实例占用；
7. 清除 manifest；
8. 若仍有残留，脚本必须非零退出并列出 PID/端口。

停止命令必须幂等。没有 manifest 时才使用严格 fallback：从端口 owner 构建祖先/后代图，并要求项目实例标记或确定的脚本路径；不得按泛化文件夹名或 `node.exe` 批量清理。

## 5. supervisor 治理

### 5.1 错误分类

后端对 `EADDRINUSE`、`EACCES` 使用专门 fatal exit code。Supervisor 遇到 fatal code 后立即退出，不再重启。

### 5.2 普通崩溃恢复

普通崩溃采用：

```text
1.5s → 3s → 6s → 12s → 30s
```

60 秒滑动窗口内最多允许 5 次快速失败；超过后进入熔断并退出。子进程稳定运行超过约 60 秒后清零失败计数。

### 5.3 supervisor 停止

收到 SIGINT、SIGTERM 或 SIGHUP 后：

- 先设置 stopping，禁止所有重新调度；
- 清除 restart timer；
- 向后端发送终止信号；
- 有限等待；
- 超时后确保 child 不再存活；
- 最后退出 supervisor。

## 6. Direct 长期监听资源上限

### 6.1 诊断数据

监控模式改为“累计计数 + 最近记录”：

- `pushes`：仅保留最近 100 条结果；短信已通过回调实时入库，不依赖该数组保存历史；
- `calls`：仅保留最近 100 次调用；
- 外层 `trace`：仅保留最近 160 帧；
- `hostErrors`：每个 host 仅保存最近错误、次数和最近时间；
- 重连、帧、短信和 catch-up 使用数值累计计数。

Probe/回归模式也必须有硬上限，不能默认使用 `Number.MAX_SAFE_INTEGER` 作为长期监控容量。

### 6.2 Socket 输入保护

- 单帧声明长度设置合理上限；
- 未完成输入 buffer 设置最大字节数；
- raw frame queue 和 JSON queue 设置最大长度；
- 超限时丢弃可恢复的旧诊断帧，协议控制帧和短信帧优先保留；
- 记录受限次数，但限制日志频率。

### 6.3 全局缓存

以下缓存增加 TTL/LRU 或账户释放机制：

- phone country key cache；
- SMS host affinity；
- web offline delivery tracker 外层 Map；
- 与账户 Direct 会话相关的其它长期 Map。

账户停止、删除、重新导入为不同身份时，释放对应运行状态。

## 7. 实时连接与重任务分离

Direct 主备推送连接保持现有实时性和故障接管能力。

以下操作进入全局并发限制，默认同时最多 2 个：

- 离线消息补偿；
- 资料和手机号刷新；
- Point/商城等非实时资料补充；
- 显式启用的 App 测试回退。

连续 link/maintenance 失败使用账户 + host 维度退避。首次失败保持快速恢复，连续失败最高退避约 15–30 秒；备用推送 socket 正常时，不因维护链路错误关闭健康推送连接。

## 8. 模拟器、ADB 与 helper 隔离

新增正式运行门禁：

```text
DT_ALLOW_APP_FALLBACK=false
```

规则：

- `NODE_ENV=production` 时默认 false；
- Linux 和 Docker 示例明确设置 false；
- Windows 本地默认 false；
- 只有显式 `start.ps1 -WithHelper` 或测试配置才允许 true；
- 即使为 true，无设备/无 helper 时也使用全局 5 分钟失败冷却；
- 不再由 9 个账户分别执行 `adb devices`；
- 只有 Direct 明确出现补偿信号或手工触发时才执行测试回退，并受账户级和全局节流控制。

正式 Direct 监听、短信入库、Telegram、订单同步和管理页面在该开关为 false 时必须完整工作。

## 9. 后端 graceful shutdown

后端增加幂等 shutdown coordinator，顺序为：

1. 标记 shutting down，拒绝启动新的后台周期；
2. 停止 Telegram、自动刷新和到期提醒的重新调度；
3. `AccountMonitorService.stopAll()`，抢占并关闭全部 Direct listener/socket；
4. 停止接收新的 HTTP 连接；
5. 等待有限时间的在途任务；
6. 关闭仍存活的 HTTP/SSE 连接；
7. `prisma.$disconnect()`；
8. 正常退出，超时才强制退出。

周期服务必须有 `started/stopping` 状态。`stop()` 与正在运行的 `tick/finally` 竞争时，后续 `schedule()` 必须被拒绝，避免服务“复活”。

SSE 在 `req close`、`res close` 和 `res error` 上使用同一个幂等 cleanup，清除 heartbeat timer 和 eventBus listener。

## 10. HTTP 与内存峰值控制

全局 `express.json` 限制从 100MB 降到约 2MB。只有备份导入路由使用单独的大请求限制，并继续要求认证和数据校验。

这避免普通 API 被单个超大 JSON 请求瞬间占用数百 MB 内存，同时保留现有备份导入功能。

## 11. 运行指标与诊断

公共 `/health` 保持轻量，只增加：

- `instanceId`；
- `startedAt`；
- `uptimeSeconds`。

新增需要管理员认证的运行状态接口，返回：

- RSS、heapUsed、heapTotal、external、arrayBuffers；
- 活跃 monitor runner 数；
- 活跃 Direct listener/session 数；
- Direct 缓存大小；
- 重连、帧、短信、丢弃队列和退避计数；
- 后台重任务队列长度和在途数量；
- 是否允许 App/ADB fallback。

不返回 token、设备 ID、邮箱、手机号、原始帧或完整错误堆栈。

## 12. 三种运行方式

### 12.1 Windows 本地

- 前端使用 Vite；
- 后端使用修复后的 dev supervisor；
- manifest 管理完整进程树；
- 默认不启动 helper/ADB；
- `-WithHelper` 仅用于逆向和测试。

### 12.2 Linux + systemd

后端直接运行：

```text
node dist/index.js
```

提供 systemd 模板，建议：

```ini
Restart=on-failure
RestartSec=5
MemoryHigh=768M
MemoryMax=1G
CPUQuota=100%
TasksMax=128
TimeoutStopSec=20
```

前端由 Nginx 提供构建后的静态文件。systemd EnvironmentFile 保存部署环境变量，正式配置明确禁止 App fallback。

### 12.3 Docker Compose

后端建议：

```yaml
restart: unless-stopped
init: true
cpus: 1.0
mem_limit: 1g
pids_limit: 128
stop_signal: SIGTERM
stop_grace_period: 20s
environment:
  NODE_ENV: production
  NODE_OPTIONS: --max-old-space-size=512
  DT_ALLOW_APP_FALLBACK: "false"
```

日志使用 `json-file`，限制为 10MB × 3。数据库目录使用持久化 volume。

前端 Nginx 建议限制为 0.25 CPU、128MB 内存和 64 个 PID。

普通 `docker compose up` 使用 `cpus`、`mem_limit` 和 `pids_limit`，不能只依赖 Swarm 的 `deploy.resources`。

## 13. 错误处理

- manifest 损坏：不盲杀进程，报告并使用严格端口 owner fallback；
- PID 已复用：创建时间或 instance marker 不匹配时拒绝终止；
- 端口被无关服务占用：启动失败并显示 PID，不终止无关服务；
- 部分启动失败：回收本次已启动的全部服务；
- shutdown 超时：记录未完成组件，再由平台强制终止；
- Direct 队列超限：优先保留短信和控制帧，丢弃旧诊断数据并累计指标；
- 资源指标读取失败：不影响健康检查和业务请求。

## 14. 测试与验收

### 14.1 自动测试

- manifest 创建、原子写入、过期和 PID 复用验证；
- 相对命令行进程树仍可完整停止；
- 第二次 stop 幂等；
- 端口冲突不接受旧 health，不产生 supervisor 无限重启；
- supervisor fatal code、指数退避、熔断和稳定后复位；
- 启动部分失败自动回收；
- 1 万次 Direct 重连、push、trace 和错误后集合仍在固定容量；
- socket buffer/queue 超限策略保留短信和控制帧；
- 9 个 runner、无 ADB 时一个冷却周期最多探测一次；
- production fallback=false 时不执行 ADB/helper；
- Telegram、自动刷新、提醒在 stop 与 in-flight finally 竞争后不再重新调度；
- shutdown 顺序和幂等性；
- SSE 重复连接/断开后 listener 和 timer 数量回到基线；
- 普通 API 拒绝超大 JSON，备份导入仍可使用单独上限。

### 14.2 本地集成验收

连续执行启动/停止 10 次：

- 每次启动 instanceId 唯一；
- 停止后项目 PID 全部消失；
- 5173、5174 和可选 5175 释放；
- 项目 Node 数量恢复到启动前基线；
- 不影响 Codex、浏览器、逆向和其它项目 Node 进程。

人为占用 5174 后启动：

- 10 秒内明确失败；
- 不接受旧实例 health；
- supervisor 不产生持续重启；
- 日志不持续增长；
- 无新增孤儿进程。

### 14.3 长期资源验收

以约 9 个监听账户运行：

- 本地至少 2 小时采样；
- Linux 或 Docker 至少 24 小时采样；
- 预热后 Private/RSS 不再随重连次数线性增长；
- 目标内存增长斜率低于约 5MB/小时；
- 空闲 CPU 平均低于单核 10%；
- handles、threads、socket 和 cache 数量保持有界；
- 正式环境没有 ADB/helper 子进程；
- 普通短信监听、团队消息、主备接管和 Telegram 行为不回退。

初始资源上限使用 1GB，不在缺少 24 小时数据时直接压到 768MB。压测稳定后再下调。

## 15. 发布与版本

- 本设计检查点按项目规则提升到 v0.2.8；
- 正式实现提交提升到 v0.2.9；
- 实现提交前运行完整后端测试、双端生产构建、Direct 回归、进程生命周期集成测试和敏感信息扫描；
- 不提交 `.env`、数据库、日志、PID manifest、抓包或逆向临时文件；
- 未经用户明确要求不推送远程仓库。
