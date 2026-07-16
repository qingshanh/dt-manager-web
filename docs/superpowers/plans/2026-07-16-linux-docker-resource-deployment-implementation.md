# Linux systemd 与 Docker 资源受控部署实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task with review checkpoints.

**Goal:** 让同一套 v0.2.9 代码在 Linux 普通部署和 Docker Compose 中长期运行，具备明确的 CPU、内存、PID、日志与停止边界，并可用统一脚本验收。

**Architecture:** Linux 普通部署由 systemd 直接运行 `node dist/index.js`，Nginx 提供前端静态文件；Docker Compose 为后端和前端设置 init、资源限制、停止宽限和日志轮转。两种生产方式都显式禁用 App/ADB fallback，并使用 health、认证 metrics 和采样脚本验证长期稳定性。

**Tech Stack:** Linux systemd、Nginx、Docker Compose、Node.js 22、SQLite/Prisma、PowerShell/Node 跨平台验证脚本。

---

## 执行约束

- 生产后端只运行构建产物 `node dist/index.js`，不运行 Vite、tsx、dev supervisor、ADB、模拟器或 helper。
- 初始后端上限使用 1GB，不在缺少 24 小时实测数据时直接压到 768MB。
- SQLite 数据目录必须持久化；部署更新前不得删除 volume 或数据库。
- 本计划完成时统一升 v0.2.9 并只做一次最终提交；未得到用户明确要求不推送。

## Task 1：补充生产环境变量契约

**Files:**

- Modify: `.env.example`
- Create: `deploy/systemd/dt-manager.env.example`
- Create: `backend/src/routes/deployment-config.test.ts`

### Step 1：先写 RED

测试 `.env.example` 和 systemd 模板都明确包含：

```dotenv
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=512
DT_ALLOW_APP_FALLBACK=false
```

并要求生产模板没有真实 JWT、密码、token、邮箱、手机号、IP 或设备标识。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/routes/deployment-config.test.ts
```

Expected: systemd 模板不存在或环境项缺失。

### Step 3：实现模板

`deploy/systemd/dt-manager.env.example` 只给占位符和本机 loopback/CORS 示例，数据库使用：

```dotenv
DATABASE_URL=file:/var/lib/dt-manager/dingtone.db
```

文档注明真实文件安装到 `/etc/dt-manager/dt-manager.env`，权限 `0600`，不提交真实值。

### Step 4：运行 GREEN

```powershell
Set-Location backend
node --import tsx --test src/routes/deployment-config.test.ts
```

## Task 2：增加 systemd 服务单元

**Files:**

- Create: `deploy/systemd/dt-manager-backend.service`
- Modify: `backend/src/routes/deployment-config.test.ts`

### Step 1：先写服务契约 RED

断言服务包含：

```ini
[Unit]
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=dt-manager
Group=dt-manager
WorkingDirectory=/opt/dt-manager/backend
EnvironmentFile=/etc/dt-manager/dt-manager.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
KillSignal=SIGTERM
MemoryHigh=768M
MemoryMax=1G
CPUQuota=100%
TasksMax=128
```

还要包含 `LimitNOFILE=8192`、`KillMode=mixed`、`NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectHome=true`、`ProtectSystem=strict`、`StateDirectory=dt-manager` 与 `ReadWritePaths=/var/lib/dt-manager`。这样 SQLite 只写 systemd 管理的数据目录。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/routes/deployment-config.test.ts
```

### Step 3：实现并静态验证

在 Linux 目标机执行：

```bash
sudo systemd-analyze verify /etc/systemd/system/dt-manager-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now dt-manager-backend
systemctl show dt-manager-backend -p MainPID -p MemoryCurrent -p MemoryHigh -p MemoryMax -p CPUQuotaPerSecUSec -p TasksCurrent
curl -fsS http://127.0.0.1:5174/health
```

Expected: unit 校验通过；MainPID 直接是生产 Node；health 正常；`DT_ALLOW_APP_FALLBACK=false`。

## Task 3：增加 Nginx 静态前端和 API/SSE 反代模板

**Files:**

- Create: `deploy/nginx/dt-manager.conf`
- Modify: `backend/src/routes/deployment-config.test.ts`

### Step 1：先写 RED

契约测试要求：

- `/` 指向 `/opt/dt-manager/frontend`，SPA 使用 `try_files $uri $uri/ /index.html`；
- `/api/` 反代 `http://127.0.0.1:5174`；
- SSE 路径禁用 buffering 并放宽 read timeout；
- 上传限制与后端一致：普通请求不放大，backup import 可到 100MB；
- 不在模板中硬编码公网域名、证书或真实 IP。

### Step 2：实现配置

SSE 位置至少包含：

```nginx
location /api/events {
    proxy_pass http://127.0.0.1:5174;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

backup import 使用精确 location 设置 `client_max_body_size 100m`；普通 `/api/` 设置较小上限。

### Step 3：验证

```bash
sudo nginx -t
curl -fsS http://127.0.0.1/health
curl -fsS http://127.0.0.1/api/version -H "Authorization: Bearer $DT_ADMIN_TOKEN"
```

Expected: 配置通过，静态页面和 API 正常；SSE 长连接不中断。

## Task 4：为 Docker Compose 增加真实资源限制

**Files:**

- Modify: `docker-compose.yml`
- Modify: `backend/Dockerfile`
- Create: `backend/docker-entrypoint.sh`
- Modify: `frontend/Dockerfile`
- Create: `backend/src/routes/docker-resource-config.test.ts`

### Step 1：先写 RED

解析 compose YAML 文本并断言 backend：

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
logging:
  driver: json-file
  options:
    max-size: 10m
    max-file: "3"
```

frontend 断言 `cpus: 0.25`、`mem_limit: 128m`、`pids_limit: 64`、`init: true` 和相同日志轮转；`depends_on.backend.condition` 必须为 `service_healthy`。不得只写 `deploy.resources`，因为普通 `docker compose up` 不保证使用 Swarm deploy 配置。

### Step 2：运行 RED

```powershell
Set-Location backend
node --import tsx --test src/routes/docker-resource-config.test.ts
```

### Step 3：修改 Compose

backend 保留 `backend-data:/app/data`，healthcheck 增加 `start_period`，环境中显式覆盖生产门禁。helper 继续只在 `real` profile 出现，默认 compose 不启动。

新增 entrypoint：

```sh
#!/bin/sh
set -eu
./node_modules/.bin/prisma migrate deploy
exec "$@"
```

Dockerfile 使用：

```dockerfile
COPY docker-entrypoint.sh /usr/local/bin/dt-manager-entrypoint
RUN chmod 755 /usr/local/bin/dt-manager-entrypoint
STOPSIGNAL SIGTERM
ENTRYPOINT ["dt-manager-entrypoint"]
CMD ["node", "dist/index.js"]
```

不得继续使用 `sh -c "npx prisma migrate deploy && node dist/index.js"`，确保迁移完成后 shell 被 Node 替换，SIGTERM 能直接到达应用。

### Step 4：静态 GREEN

```powershell
Set-Location backend
node --import tsx --test src/routes/docker-resource-config.test.ts
Set-Location ..
docker compose config
```

Expected: 配置可展开且资源字段出现在 backend/frontend 服务。当前 Windows 开发机没有 Docker，此命令需在安装 Docker 的 Windows/Linux 或 CI 中完成，不能在本机伪造通过结果。

## Task 5：增加跨平台资源采样与 soak 脚本

**Files:**

- Create: `tools/soak-runtime.mjs`
- Create: `tools/soak-runtime.test.mjs`
- Create: `docs/runtime-soak-testing.md`

### Step 1：先写 RED

脚本参数：

```text
--health-url http://127.0.0.1:5174/health
--metrics-url http://127.0.0.1:5174/api/runtime/metrics
--token-env DT_ADMIN_TOKEN
--duration-minutes 120
--interval-seconds 30
--output _tmp/runtime/soak-local.jsonl
--max-memory-slope-mb-hour 5
--max-idle-single-core-percent 10
```

测试用固定样本验证线性斜率计算、预热样本剔除、超限非零退出、输出自动脱敏。

### Step 2：运行 RED

```powershell
node --test tools/soak-runtime.test.mjs
```

### Step 3：实现采样器

每条 JSONL 只保存时间、instanceId、uptime、memory 数值、计数器、gauge 和计算出的 CPU；不得保存 Authorization、URL query、账户信息或原始错误。跨平台仅依赖 HTTP metrics；Docker/systemd 的容器/cgroup 指标在文档中作为辅助证据。

### Step 4：运行 GREEN

```powershell
node --test tools/soak-runtime.test.mjs
```

## Task 6：编写 Linux 与 Docker 部署操作文档

**Files:**

- Create: `docs/deployment-linux-systemd.md`
- Create: `docs/deployment-docker.md`
- Modify: `README.md`

Linux 文档必须包含：

1. 构建 backend/frontend；
2. 创建非 root 用户，并由 systemd `StateDirectory` 管理 `/var/lib/dt-manager`；
3. 安装 env、systemd、Nginx；
4. `systemctl stop` 后确认 Node 与端口消失；
5. 日志查看与滚动；
6. 数据库备份与升级顺序；
7. 资源上限如何逐步调整。

Docker 文档必须包含：

```bash
docker compose build
docker compose up -d
docker compose ps
docker stats --no-stream
docker inspect dt-manager-web-backend-1 --format '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}'
docker compose stop --timeout 20
docker compose down
```

明确 `down` 不加 `-v`，避免删除 SQLite volume；默认不启用 `--profile real`。

## Task 7：执行三环境验收

**Files:**

- Create: `docs/runtime-resource-acceptance.md`

### Windows 本地

执行第一份计划中的 10 次启动/停止测试，再运行：

```powershell
node tools/soak-runtime.mjs --health-url http://127.0.0.1:5174/health `
  --metrics-url http://127.0.0.1:5174/api/runtime/metrics `
  --token-env DT_ADMIN_TOKEN --duration-minutes 120 --interval-seconds 30 `
  --output _tmp/runtime/soak-local.jsonl
```

### Linux systemd

至少 24 小时：

```bash
node tools/soak-runtime.mjs --health-url http://127.0.0.1:5174/health \
  --metrics-url http://127.0.0.1:5174/api/runtime/metrics \
  --token-env DT_ADMIN_TOKEN --duration-minutes 1440 --interval-seconds 60 \
  --output /var/log/dt-manager/soak-systemd.jsonl
systemctl show dt-manager-backend -p MemoryPeak -p CPUUsageNSec -p TasksCurrent
```

### Docker

至少 24 小时，并采集：

```bash
docker compose ps
docker stats --no-stream
docker compose top backend
docker inspect dt-manager-web-backend-1 --format '{{json .State}}'
```

三环境共同通过标准：

- 预热后内存斜率低于 5MB/小时；
- 空闲 CPU 低于单核 10%；
- Direct 诊断集合、queue、cache 数量保持有界；
- production 没有 ADB/helper 子进程；
- stop 后 20 秒内退出，端口释放；
- 普通短信、团队消息、主备故障接管、Telegram 行为无回退。

若 1GB 上限稳定且峰值长期低于 600MB，再单独评估将 `MemoryHigh`/`mem_limit` 下调，不在本次实现中直接压缩。

## Task 8：统一升版、完整验证和敏感信息检查

**Files:**

- Modify: `VERSION`
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `backend/src/config.ts`
- Modify: `backend/src/services/version-sync.test.ts`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `start.ps1`
- Modify: `.env.example`

### Step 1：先让版本测试 RED

将 `backend/src/services/version-sync.test.ts` 的 `expectedVersion` 改为 `0.2.9`，运行：

```powershell
Set-Location backend
node --import tsx --test src/services/version-sync.test.ts
```

Expected: 各入口仍为 0.2.8，测试失败。

### Step 2：同步所有版本入口到 0.2.9

只修改版本，不改真实 `.env`。再次运行版本测试确认 GREEN。

### Step 3：完整验证

```powershell
Set-Location backend
$tests = Get-ChildItem -Recurse -Filter *.test.ts src | ForEach-Object { $_.FullName }
node --import tsx --test $tests
npm run build
npm run verify:runtime-bounds
npm run verify:direct-regression
Set-Location ..\frontend
npm run build
Set-Location ..
docker compose config
git diff --check
```

### Step 4：敏感信息与产物检查

```powershell
git status --short
git diff --name-only
rg -n --hidden -g '!node_modules/**' -g '!.git/**' -g '!_tmp/**' `
  '(imei|macAddress|serialNumber|wifi|Bearer |bot[0-9]+:|password\s*=|token\s*=|\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+\b)' .
```

人工检查命中项，确认没有 `.env`、数据库、日志、抓包、PID manifest、真实 token、密码、邮箱、手机号、设备标识进入提交。

### Step 5：一次性提交，不推送

```powershell
git add .
git diff --cached --check
git commit -m "feat: release v0.2.9 runtime resource governance"
```

Expected: 只产生一个 v0.2.9 提交。除非用户再次明确要求，否则不执行 push。
