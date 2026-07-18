# dt-manager-web

## 0.2.11 运行说明

- 正式部署默认禁用 App/ADB fallback；仅在本地逆向和测试时显式启用。
- 0.2.11：Direct SMS sticky route/governor 增强路由稳定性、故障退避和探针恢复。

一个用于管理 TalkU/叮咚账号、手机号、短信监听、验证码接收和 Telegram 控制的本地 Web 面板。项目支持三种网关模式：

- `mock`：模拟数据，适合先验证前后端和 Docker 部署。
- `real`：通过本地 helper + Frida 连接已登录 App，会依赖安卓设备或模拟器。
- `direct`：导入 `dtUserId`、`token`、`deviceId` 后直连服务端，适合脱离 App 做资料刷新、拉号、监听短信。

## 上传前检查

不要提交真实运行状态和逆向临时材料：

- 根目录 `.env`
- SQLite 数据库、日志、抓包、截图、APK、so、Frida server 二进制
- `_tmp/`、`.playwright-mcp/`、`null/`、`_unused_review/`
- `DESIGN.md`、`LOGIN_RESEARCH_*.md`、抓包说明和内部逆向笔记

仓库里只保留 `.env.example` 作为配置模板。Frida server 请按设备架构自行下载或放在仓库外，不建议上传到 GitHub。

## 本地开发

运行要求：

- Node.js 22+
- Python 3.11+，仅 helper 需要
- Docker Desktop，可选
- 如使用 `real` 模式，Python 环境需要安装 `frida`

Windows 快速启动：

```powershell
Copy-Item .env.example .env
notepad .env
.\start.bat
```

仅本地逆向或设备测试时带 helper 启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1 -WithHelper -HelperDeviceMode remote -HelperRemoteHost 127.0.0.1:27042
```

停止：

```powershell
.\stop.bat
```

`start.ps1` 会为本次实例写入 `_tmp/runtime/processes.json`；`stop.ps1` 只停止该清单中经过项目根、PID、创建时间和实例 ID 校验的进程。普通启动不会启动 Python/helper，并保持 `DT_ALLOW_APP_FALLBACK=false`。

默认地址：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:5174`
- helper：`http://127.0.0.1:5175`

## Docker Compose 部署

正式部署使用 `direct` 模式并保持 `DT_ALLOW_APP_FALLBACK=false`；数据库中的 App 补拉设置也必须保持关闭。资源、停止和数据安全说明见 [Docker 部署](docs/deployment-docker.md)，普通 Linux 部署见 [systemd 部署](docs/deployment-linux-systemd.md)。

### Windows

1. 安装 Docker Desktop，并确认 PowerShell 能执行 `docker compose version`。

2. 准备环境文件：

```powershell
Copy-Item .env.example .env
notepad .env
```

3. 至少修改根目录 `.env` 中这些值：

```env
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=512
DT_GATEWAY_MODE=direct
DT_ALLOW_APP_FALLBACK=false
JWT_SECRET=换成至少32位随机字符串
ENCRYPTION_KEY=换成至少32位随机字符串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=换成强密码
CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
```

Docker Compose 会把后端数据库固定到容器内的 `file:/app/data/dingtone.db`，数据保存在 `backend-data` volume 中；通常不用手动改 `DATABASE_URL`。

4. 构建并启动面板：

```powershell
docker compose up -d --build
docker compose ps
```

5. 打开：

```text
http://localhost:5173
```

6. 如果需要 helper + Frida：

```powershell
docker compose --profile real up -d --build helper
```

Docker 容器里的 helper 连接宿主机 Frida 时，`.env` 里通常使用：

```env
DT_HELPER_REMOTE_HOST=host.docker.internal:27042
```

### Linux

1. 安装 Docker Engine 和 Compose 插件。

2. 准备环境文件：

```bash
cp .env.example .env
nano .env
```

3. 生产环境建议值：

```env
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=512
DT_GATEWAY_MODE=direct
DT_ALLOW_APP_FALLBACK=false
JWT_SECRET=replace-with-a-long-random-secret
ENCRYPTION_KEY=replace-with-a-long-random-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-password
CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
```

4. 启动：

```bash
docker compose up -d --build
docker compose logs -f backend
```

5. 打开：

```text
http://服务器IP:5173
```

如果前面有 Nginx、Caddy 或反向代理，请把 `CORS_ORIGIN` 改成真实访问域名，例如：

```env
CORS_ORIGIN=https://your-domain.example
```

Linux helper 连接宿主机 Frida 时，如果 `host.docker.internal` 不可用，可以在 `.env` 里写宿主机网关 IP 或局域网 IP：

```env
DT_HELPER_REMOTE_HOST=172.17.0.1:27042
```

### VPS 内存参考

只跑 `direct` 模式时，常驻进程主要是后端 Node.js、前端 nginx 和 SQLite 文件，空闲通常约 `180-300 MB`，有少量监听任务时建议给 VPS 预留 `512 MB` 以上内存。开启 `real` profile 的 helper + Frida 后，额外内存取决于设备连接和 Frida 会话，建议 `1 GB` 起步。

正式默认使用 `.env` 中 `NODE_OPTIONS=--max-old-space-size=512`。完成至少 24 小时稳定采样、确认峰值和重启次数正常后，小内存 VPS 可评估降到 `192` 或 `256`；始终优先使用 `direct` 模式且不启动 helper profile。

### Docker 拉取卡住

项目默认通过 `docker.hanxi.cc` 拉取官方基础镜像，以减少 VPS 直连 Docker Hub 卡住的概率。如果构建仍然长时间停在基础镜像拉取阶段，可以先单独测试：

```bash
docker pull docker.hanxi.cc/library/node:22-alpine
docker pull docker.hanxi.cc/library/nginx:1.27-alpine
```

我这里用 registry manifest 检查过：`docker.hanxi.cc` 对 `library/node`、`library/nginx`、`library/python` 会返回 Docker Registry 鉴权挑战，Docker 客户端应可继续拉取；`ghcr.nju.edu.cn` 对这些 Docker Hub 官方基础镜像返回 `404`，不适合作为本项目默认基础镜像源。

如果 `docker.hanxi.cc` 在你的 VPS 上也不可用，请在 `.env` 里把基础镜像改成你的 VPS 可访问的镜像源，例如：

```env
DOCKER_NODE_IMAGE=你的镜像源/library/node:22-alpine
DOCKER_NGINX_IMAGE=你的镜像源/library/nginx:1.27-alpine
DOCKER_PYTHON_IMAGE=你的镜像源/library/python:3.11-slim
```

然后重新构建：

```bash
docker compose build --pull --progress=plain
docker compose up -d
```

## 环境变量

项目只使用根目录 `.env` 作为本地开发和 Docker Compose 的配置入口。模板文件 `.env.example` 已按用途分组，每一项上方都有说明；实际部署时复制一份 `.env` 后填写真实值即可。

常用后端变量：

- `DT_GATEWAY_MODE`：`mock`、`real`、`direct`
- `JWT_SECRET`：后台登录 JWT 密钥，生产环境必须改
- `ENCRYPTION_KEY`：账号密码和 token 入库加密密钥，生产环境必须改
- `NODE_OPTIONS`：限制 Node.js 最大堆内存，正式默认 `--max-old-space-size=512`；长期采样后可评估下调
- `DT_ALLOW_APP_FALLBACK`：App/helper/ADB 回退的环境硬门禁；正式部署必须为 `false`，本地逆向测试还需同时打开系统设置
- `DOCKER_NODE_IMAGE`、`DOCKER_NGINX_IMAGE`、`DOCKER_PYTHON_IMAGE`：Docker 基础镜像地址，Docker Hub 拉取慢时可换成可访问的镜像源
- `NPM_REGISTRY`、`PIP_INDEX_URL`：Docker 构建时安装 npm / pip 依赖使用的镜像源
- `DATABASE_URL`：本地开发数据库地址；Docker Compose 默认覆盖为 `file:/app/data/dingtone.db`
- `CORS_ORIGIN`：前端访问源，多个用英文逗号分隔
- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`TELEGRAM_API_BASE_URL`：Telegram 通知和 bot
- `DT_REAL_BRIDGE_BASE_URL`：后端访问 helper 的地址

常用前端和部署变量：

- `PORT`：本地后端进程端口，默认 `5174`
- `BACKEND_PORT`：Docker 暴露到宿主机的后端端口，默认 `5174`
- `BACKEND_INTERNAL_PORT`：Docker 后端容器内部端口，默认 `5174`
- `FRONTEND_PORT`：Docker 暴露到宿主机的前端端口，默认 `5173`
- `VITE_DEV_HOST`、`VITE_DEV_PORT`：本地 Vite 开发服务地址，默认 `127.0.0.1:5173`
- `VITE_BACKEND_URL`：本地 Vite 代理到的后端地址
- `VITE_APP_VERSION`：前端显示的版本号；为空时可跟随 `APP_VERSION`
- `HELPER_PORT`：宿主机 helper 端口，默认 `5175`
- `DT_HELPER_REMOTE_HOST`：helper 连接 Frida 的地址

## 直连会话使用

1. 设置 `DT_GATEWAY_MODE=direct`、`DT_ALLOW_APP_FALLBACK=false`，并确认系统设置中的 App 补拉保持关闭。
2. 启动前后端。
3. 在“添加账户”里选择“手动导入直连会话”。
4. 进入账户详情，导入 `dtUserId`、`token`、`deviceId`。
5. 验证通过后可刷新资料、同步号码、购买号码、启动短信监听。

需要区号的国家，例如美国、加拿大，面板会在未填写区号时按内置常用区号随机尝试；也可以手动指定区号提高命中率。

## 积分与会员商城接口

部署后后端会提供两组独立接口，避免把游戏积分入口和会员商城混在一起：

- `GET /api/accounts/:id/point`：刷新并返回 `point` 游戏/积分入口相关数据。
- `GET /api/accounts/:id/pointstore`：刷新并返回 `pointstore` 会员商城商品、有效积分和兑换邮箱。
- `POST /api/accounts/:id/pointstore/order`：兑换会员商城商品，请求体需要 `product_id` 和 `confirm=true`，兑换地址自动使用当前账户邮箱。

旧的 `/api/accounts/:id/point-store...` 仅作为兼容别名保留，新部署和前端默认使用 `pointstore`。

## Direct 邮箱验证码登录

`DT_GATEWAY_MODE=direct` 时，邮箱 + 验证码登录由后端直接连接 TalkU/Dingtone 服务端完成，不需要模拟器、Frida 或 helper 常驻。每次创建验证码账号或点击“重新发送验证码”都会生成新的随机 `And.<32hex>.dttalk` 设备号和新的 `TrackCode`，验证码必须和这一次发码保存的设备号配套使用。

如果发码返回 `ip region is restricted`，说明当前服务器出口 IP 被对方限制。可以在 `.env` 或设置页填写 `DT_PROXY_URL=http://user:pass@proxy-host:port`，direct TCP 连接会通过 HTTP CONNECT 代理转发；不需要代理时留空。

验证码登录成功后，后端会保存 `dtUserId`、`token`、`deviceId`，并把复用同一原生会话但绑定到其他 `dt_user_id` 的旧账号标记为失效，避免多账号混用同一个设备会话导致后续账号状态互相污染。

## Telegram Bot

开启 bot 后可用命令包括：

- `/accounts`：查看账户
- `/phones <账户ID>`：查看已购手机号
- `/preview_number <账户ID> <国家ISO> [区号]`：预览候选号和价格，不扣费
- `/buy_number <账户ID> <国家ISO> [confirm] [区号] [phone=号码]`：不带 `confirm` 只预览，带 `confirm` 才购买
- `/code <账户ID> [号码ID|手机号]`：等待指定号码的新短信/验证码
- `/refresh_account <账户ID>`、`/refresh_phones <账户ID>`：刷新资料和号码
- `/pause_phone`、`/resume_phone`、`/renew_phone`、`/cancel_phone`：号码操作，均需要 `confirm`

生产环境建议配置 `telegram_allowed_chat_ids`，只允许自己的 chat_id 或 user_id 控制面板。

## GitHub 上传命令

首次上传：

```bash
git init
git add .
git status --short
git commit -m "Initial dt-manager web panel"
git branch -M main
git remote add origin https://github.com/<your-name>/<your-repo>.git
git push -u origin main
```

如果远端已经存在：

```bash
git remote set-url origin https://github.com/<your-name>/<your-repo>.git
git add .
git status --short
git commit -m "Prepare docker deployment"
git push -u origin main
```

上传前建议再跑一次：

```bash
git status --short --ignored
git ls-files --others --exclude-standard
```

确认没有 `.env`、数据库、日志、抓包或 `_tmp/` 内容出现在待提交列表里。
