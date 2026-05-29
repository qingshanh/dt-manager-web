# 本地助手服务

这个目录里的服务，是 `DT_GATEWAY_MODE=real` 时使用的仓库内助手。

它和 Node 后端是分开的：

- `backend/src/...` 仍然只是普通的 HTTP 网关客户端
- `backend/helper/server.py` 负责 Frida 和设备会话
- `backend/helper/frida_agent.js` 会运行在真实的安卓应用进程里

## 2026-05-11 优化标记

- 真实登录、邮箱验证码登录、密码登录流程已经接到本机应用链路。
- 号码候选号预览、确认购买、续期、暂停、恢复、取消、列表等动作，在条件允许时会走真实应用。
- 后端现在可以接收 helper 返回的候选号列表，并自动整理成保存账号或手机号时需要的结构。
- [2026-05-11 真实联调验证] 已在逍遥模拟器实测 `export_session`，能够成功导出 `dtUserId`、`token`、`deviceId`、`dingtoneId`。
- [2026-05-11 优化标记] helper 现在直接以 `backend/helper` 作为 Frida 编译根目录，不再为每次注入复制整份 `node_modules`，启动更轻也更快。
- [2026-05-11 优化标记] helper 已补上 `purchase_phone_number` 动作，号码申请不再把“预览”和“真购买”混在一起。

## 覆盖的能力

这个 helper 目前支持账号流程里需要的真实桥接动作：

- `send_verification_code`
- `login`
- `export_session`
- `refresh_snapshot`
- `list_phone_numbers`
- `request_phone_number`
- `purchase_phone_number`
- `renew_phone_number`
- `cancel_phone_number`
- `pause_phone_number`
- `resume_phone_number`

说明：

- `request_phone_number` 会尽量走真实应用里的候选号查询流程，并把候选数据返回给后端。
- `purchase_phone_number` 会调用真实应用里的购号逻辑，返回购买后的号码资料，后端再负责落库和刷新账号快照。
- `export_session` 会读取当前已登录的应用状态，导出 `dtUserId`、`token` 和 `deviceId`，这样后端就能接管一个已经登录好的会话。

## 运行要求

- Python 3.10+
- Python 环境里已经安装 `frida`
- 安卓设备、模拟器或虚拟机里已经有可访问的 `frida-server`
- 目标应用已经安装，并且能正常启动

## 启动方式

```bash
cd backend/helper
python server.py
```

默认监听地址：

- `http://127.0.0.1:19091`

## 环境变量说明

推荐在项目根目录 `.env` 里统一配置下面这些变量，然后通过根目录的 `start.ps1 -WithHelper` 或 Docker Compose 启动。若在 `backend/helper` 目录手动运行 `python server.py`，helper 也会尝试读取根目录 `.env`；当前 shell 里已存在的同名变量优先级更高。

```env
DT_HELPER_BIND_HOST=127.0.0.1
DT_HELPER_PORT=19091
DT_HELPER_TOKEN=
DT_HELPER_DEVICE_MODE=usb
DT_HELPER_DEVICE_ID=
DT_HELPER_REMOTE_HOST=127.0.0.1:27042
DT_HELPER_DINGTONE_PACKAGE=me.talkyou.app.im
DT_HELPER_DINGDONG_PACKAGE=me.dingtone.app.im
DT_HELPER_TIMEOUT_MS=90000
DT_HELPER_SPAWN_PAUSE_MS=1500
```

字段说明：

- `DT_HELPER_BIND_HOST`：helper 监听的地址，默认只在本机可访问。
- `DT_HELPER_PORT`：helper 监听端口。
- `DT_HELPER_TOKEN`：可选鉴权令牌，后端和 helper 都支持。
- `DT_HELPER_DEVICE_MODE`：Frida 设备模式，支持 `usb`、`local`、`remote`、`id`。
- `DT_HELPER_DEVICE_ID`：当 `DT_HELPER_DEVICE_MODE=id` 时使用的设备 ID。
- `DT_HELPER_REMOTE_HOST`：`remote` 模式下要连接的 Frida 地址。
- `DT_HELPER_DINGTONE_PACKAGE`：说道包名，默认值适合当前项目的常见场景。
- `DT_HELPER_DINGDONG_PACKAGE`：叮咚包名，如果包名不同可以单独覆盖。
- `DT_HELPER_TIMEOUT_MS`：单次动作超时时间。
- `DT_HELPER_SPAWN_PAUSE_MS`：spawn 之后等待应用启动的时间。

## 运行说明

- 先把应用装进设备或虚拟机，再启动 helper。
- 如果应用没在运行，helper 会尝试自动拉起。
- [2026-05-11 真实联调验证] 逍遥模拟器链路已经完成过一次真实导出验证；如果你本机的包名、Frida 版本和端口一致，可以直接按文档启动。
- Frida 17 之后，helper 需要通过 `frida-java-bridge` 编译 agent，所以 `backend/helper` 目录里要先执行一次 `npm install`。
- [2026-05-11 优化标记] 如果你在受限终端、沙箱或某些 IDE 插件里单独测试 `frida.Compiler.build()` 遇到路径权限报错，先不要直接判断 helper 不可用；本项目在真实系统环境下已经验证过 Frida 编译与注入可以正常工作。
- [2026-05-11 优化标记] 一键启动、Docker 和虚拟大师连接流程，见根目录 [README.md](../../README.md)。

## 逍遥模拟器补充说明

[2026-05-11 优化标记] 如果你的目标环境是安卓模拟器，请先确认 ADB 连接、`frida-server` 启动、端口转发和会话导出流程都已打通。内部模拟器接入笔记不随 GitHub 仓库上传。
## 2026-05-11 优化标记

- `buildSnapshotPayload` 现在会尽量提取余额、有效积分、进度积分、进度总分、会员等级和说道号。
- `request_phone_number` 返回的候选号码和原始回包会一并保留，方便后端和前端展示扣费预览。
- `purchase_phone_number` 返回的真实购号结果会带上原始回包，便于后端定位余额、号码状态和地区字段差异。

## 2026-05-11 优化标记（本轮补充）

- `refresh_snapshot` 现在会额外抓取 `game/homePage` 和 `game/point/redeemInfo`，并把游戏积分、游戏兑换商品、可兑数量等真实数据一并放进快照原始 JSON。
- 会员权益展示现在会合并普通积分商城和游戏积分兑换商品，便于前端在不改接口结构的前提下直接展示更多真实可兑换项和价格。
- helper 在 `frida.Compiler.build()` 失败时，会直接返回底层编译错误信息，排查路径权限、依赖缺失或模块解析问题时更直观。

## direct 号码模板抓取

`direct` 模式的号码购买、续费、暂停、恢复、取消可以脱离 app 运行，但前提是先从已登录 app 抓到一次真实直连请求帧。仓库里提供了一个独立抓帧脚本：

```bash
cd backend/helper
python capture_direct_frames.py --seconds 90 --output ../../_tmp/direct-frame-templates.json
```

运行后在 app 里手动点击要抓的动作，例如选号、续费或暂停。脚本会 hook Java socket 写入，过滤 `0107...` 直连帧，解析其中的压缩 query，并输出：

- `frames[].template`：可直接粘到系统设置页 `direct 号码模板` 的 JSON。
- `frames[].settingHint`：建议粘贴到哪个设置项，例如 `dt_direct_template_request_phone`。
- `settings`：按建议设置项整理好的首个模板映射。

常用参数：

- `--package me.talkyou.app.im`：目标包名。
- `--pid 15184`：当 Frida 只能看到中文进程名时，直接按 PID attach。
- `--device-mode remote --remote-host 127.0.0.1:27042`：连接远程 Frida server。

如果出现 `need Gadget to attach on jailed Android` 或 `unable to connect to remote frida-server: closed`，说明当前设备的 Frida attach 链路还没通；先确认 app 已打开、frida-server/Gadget 可 attach，再重新运行脚本。
