# dt-manager-web

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

带 helper 启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1 -WithHelper -HelperDeviceMode remote -HelperRemoteHost 127.0.0.1:27042
```

停止：

```powershell
.\stop.bat
```

默认地址：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`
- helper：`http://127.0.0.1:19091`

## Docker Compose 部署

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
DT_GATEWAY_MODE=direct
JWT_SECRET=换成至少32位随机字符串
ENCRYPTION_KEY=换成至少32位随机字符串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=换成强密码
CORS_ORIGIN=http://localhost:8080,http://127.0.0.1:8080
```

Docker Compose 会把后端数据库固定到容器内的 `file:/app/data/dingtone.db`，数据保存在 `backend-data` volume 中；通常不用手动改 `DATABASE_URL`。

4. 构建并启动面板：

```powershell
docker compose up -d --build
docker compose ps
```

5. 打开：

```text
http://localhost:8080
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
DT_GATEWAY_MODE=direct
JWT_SECRET=replace-with-a-long-random-secret
ENCRYPTION_KEY=replace-with-a-long-random-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-password
CORS_ORIGIN=http://localhost:8080,http://127.0.0.1:8080
```

4. 启动：

```bash
docker compose up -d --build
docker compose logs -f backend
```

5. 打开：

```text
http://服务器IP:8080
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

小内存 VPS 建议保持 `.env` 中 `NODE_OPTIONS=--max-old-space-size=192`，并优先使用 `direct` 模式，不启动 helper profile。后端 Docker 镜像已只保留生产依赖，能减少镜像体积和运行时文件扫描开销。

## 环境变量

项目只使用根目录 `.env` 作为本地开发和 Docker Compose 的配置入口。模板文件 `.env.example` 已按用途分组，每一项上方都有说明；实际部署时复制一份 `.env` 后填写真实值即可。

常用后端变量：

- `DT_GATEWAY_MODE`：`mock`、`real`、`direct`
- `JWT_SECRET`：后台登录 JWT 密钥，生产环境必须改
- `ENCRYPTION_KEY`：账号密码和 token 入库加密密钥，生产环境必须改
- `NODE_OPTIONS`：限制 Node.js 最大堆内存，小内存 VPS 可设为 `--max-old-space-size=192`
- `DATABASE_URL`：本地开发数据库地址；Docker Compose 默认覆盖为 `file:/app/data/dingtone.db`
- `CORS_ORIGIN`：前端访问源，多个用英文逗号分隔
- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`TELEGRAM_API_BASE_URL`：Telegram 通知和 bot
- `DT_REAL_BRIDGE_BASE_URL`：后端访问 helper 的地址

常用前端和部署变量：

- `PORT`：本地后端进程端口，默认 `3000`
- `BACKEND_PORT`：Docker 暴露到宿主机的后端端口，默认 `3000`
- `BACKEND_INTERNAL_PORT`：Docker 后端容器内部端口，默认 `3000`
- `FRONTEND_PORT`：Docker 暴露到宿主机的前端端口，默认 `8080`
- `VITE_DEV_HOST`、`VITE_DEV_PORT`：本地 Vite 开发服务地址，默认 `127.0.0.1:5173`
- `VITE_BACKEND_URL`：本地 Vite 代理到的后端地址
- `VITE_APP_VERSION`：前端显示的版本号；为空时可跟随 `APP_VERSION`
- `HELPER_PORT`：宿主机 helper 端口，默认 `19091`
- `DT_HELPER_REMOTE_HOST`：helper 连接 Frida 的地址

## 直连会话使用

1. 设置 `DT_GATEWAY_MODE=direct`。
2. 启动前后端。
3. 在“添加账户”里选择“手动导入直连会话”。
4. 进入账户详情，导入 `dtUserId`、`token`、`deviceId`。
5. 验证通过后可刷新资料、同步号码、购买号码、启动短信监听。

需要区号的国家，例如美国、加拿大，面板会在未填写区号时按内置常用区号随机尝试；也可以手动指定区号提高命中率。

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
