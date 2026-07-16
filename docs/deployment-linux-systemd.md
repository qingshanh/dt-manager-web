# Linux systemd 部署

正式部署直接运行后端生产构建 `node dist/index.js`，前端由 Nginx 提供静态文件。systemd 模板默认限制后端为 1 个 CPU、1GB 内存和 128 个任务，并显式设置 `DT_ALLOW_APP_FALLBACK=false`，不依赖模拟器、ADB、Frida 或 helper。

## 安装

```bash
sudo useradd --system --home /opt/dt-manager --shell /usr/sbin/nologin dt-manager
sudo mkdir -p /opt/dt-manager/backend /opt/dt-manager/frontend /etc/dt-manager
sudo chown -R dt-manager:dt-manager /opt/dt-manager
```

在构建机或服务器完成：

```bash
cd backend
npm ci
npx prisma generate
npm run build
cd ../frontend
npm ci
npm run build
```

把后端 `dist`、`prisma`、生产依赖和 package 文件放到 `/opt/dt-manager/backend`，把前端 `dist` 内容放到 `/opt/dt-manager/frontend`。

复制环境模板并填写真实密钥：

```bash
sudo install -o root -g dt-manager -m 0640 deploy/systemd/dt-manager.env.example /etc/dt-manager/dt-manager.env
sudoedit /etc/dt-manager/dt-manager.env
```

确认至少设置 `NODE_ENV=production`、`NODE_OPTIONS=--max-old-space-size=512`、`DT_GATEWAY_MODE=direct`、`DT_ALLOW_APP_FALLBACK=false`。不要把真实环境文件提交到 Git。

安装服务：

```bash
sudo install -o root -g root -m 0644 deploy/systemd/dt-manager-backend.service /etc/systemd/system/dt-manager-backend.service
sudo systemd-analyze verify /etc/systemd/system/dt-manager-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now dt-manager-backend
curl -fsS http://127.0.0.1:5174/health
```

若 Node 不在 `/usr/bin/node`，先运行 `command -v node`，再修改 unit 的 `ExecStart`。

## Nginx

```bash
sudo install -o root -g root -m 0644 deploy/nginx/dt-manager.conf /etc/nginx/sites-available/dt-manager.conf
sudo ln -s /etc/nginx/sites-available/dt-manager.conf /etc/nginx/sites-enabled/dt-manager.conf
sudo nginx -t
sudo systemctl reload nginx
```

正式域名和 TLS 证书按服务器实际情况配置；仓库模板不包含真实域名或证书路径。

## 资源和停止检查

```bash
systemctl show dt-manager-backend -p MainPID -p MemoryCurrent -p MemoryHigh -p MemoryMax -p CPUUsageNSec -p TasksCurrent -p TasksMax -p NRestarts
systemd-cgls /system.slice/dt-manager-backend.service
sudo systemctl stop dt-manager-backend
test "$(systemctl is-active dt-manager-backend)" = inactive
! ss -ltnp | grep -q ':5174 '
```

停止应在 20 秒内完成。cgroup 中不应长期出现 npm、tsx、dev supervisor、adb、Frida 或 helper。

## 升级和备份

升级前先备份 `/var/lib/dt-manager/dingtone.db`，再停止服务、替换构建产物、执行 Prisma migration 并启动。不要删除 `/var/lib/dt-manager`。首次生产配置保持 1GB 上限；完成至少 24 小时稳定采样且峰值长期低于 600MB 后，再评估下调。
