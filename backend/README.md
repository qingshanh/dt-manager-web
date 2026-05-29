# 后端状态说明

## 当前状态

这个后端已经完成了前端接入所需的基础骨架。

## 本次已实现内容

- Express + TypeScript 服务入口
- Prisma + SQLite 数据结构，覆盖管理员、账号、快照、手机号、消息、监控会话和系统设置
- JWT 登录、登录限流、全局 API 限流、helmet、CORS，以及统一 JSON 返回格式
- 账号增删改查、验证码登录流程、刷新、重新登录、开始/停止/重启监控接口
- 手机号列表、候选号预览、确认购买、续期、暂停、恢复、取消接口
- 消息列表、批量已读、删除接口
- 仪表盘统计和最近消息接口
- SSE 事件流接口
- Telegram 测试发送 + 模拟消息注入接口
- 预留给真实 TCP 链路的说道协议辅助骨架
- [2026-05-11 优化标记] 新增 `POST /api/accounts/:id/capture-session`，可以把 helper 里已经登录好的真实会话导出给后端接管
- [2026-05-10 优化标记] 新增 `pending` 账号状态，未验证邮箱验证码的账号不会再污染仪表盘统计
- [2026-05-10 优化标记] 新增按身份 + 应用版本去重复用账号，避免重复登录时生成多条重复记录
- [2026-05-10 优化标记] 新增 `dingtone` / `dingdong` 应用变体支持，以及可选备注流程
- [2026-05-10 优化标记] 新增 `telegram_api_base_url`，支持 Telegram 反代部署
- [2026-05-10 优化标记] 把 `real` 网关里原来返回 `501` 的占位逻辑，替换成 helper 桥接，这样真实邮箱验证码登录、密码登录、快照刷新和手机号接口都可以走本机或局域网服务完成
- [2026-05-11 优化标记] 补上 `real` 网关中文字段乱码修复，真实快照与账户详情里的昵称、国家等中文资料可正常显示
- [2026-05-11 优化标记] 手机号申请流程已拆成“候选号预览”与“确认购买”两步，后端新增 `POST /api/accounts/:id/phone-numbers/preview` 与 `POST /api/accounts/:id/phone-numbers/purchase`
- [2026-05-11 优化标记] 账户详情页展示现在优先递归解析 `raw_json` 里的余额、有效积分、进度积分、会员等级、会员权益和积分商城项目，减少因为部分字段未落库导致的显示不准
- [2026-05-11 优化标记] 快照刷新时会把本次真实回包里缺失的资料字段清空为 `null`，避免旧手机号、旧资料残留在界面上继续误导

## 集成边界

后端支持三种网关模式：

- `DT_GATEWAY_MODE=mock`
  适合前端联调和后端自检。
  这个模式下邮箱验证码不会真的发信，固定测试验证码是 `123456`。
- `DT_GATEWAY_MODE=real` / `bridge`
  真实说道操作会先交给 helper，再由 helper 去连真实应用。
  这样设计是因为首次登录拿 token 仍然依赖原生状态，所以后端需要一个能和真实 APK、Frida 或模拟器/虚拟机对接的本地或局域网 helper。
- `DT_GATEWAY_MODE=direct`
  这是纯服务端模式，适合已经登录好的账号。
  它目前可以在不依赖安卓的情况下刷新快照、拉取私密号码和监听短信。
  首次接入推荐走“手动导入直连会话”：先创建 `manual_session` 账户，再调用 `POST /api/accounts/:id/validate-session` 导入 `dtUserId`、`token`、`deviceId`。

## 真实桥接约定

当 `DT_GATEWAY_MODE=real` 时，需要配置：

- `DT_REAL_BRIDGE_BASE_URL=http://127.0.0.1:19091`
- `DT_REAL_BRIDGE_TOKEN=...`（可选）
- `DT_REAL_BRIDGE_TIMEOUT_MS=60000`

后端会按顺序尝试下面这些接口：

- `/api/v1/dingtone/execute`
- `/api/dingtone/execute`
- `/dingtone/execute`
- `/execute`

请求体示例：

```json
{
  "action": "send_verification_code",
  "payload": {
    "input": {
      "loginType": "email_code",
      "appVariant": "dingtone",
      "email": "user@example.com",
      "deviceId": "And.xxx.dttalk",
      "trackCode": "4005..."
    }
  },
  "meta": {
    "appVersion": "6.3.1",
    "apkCertificateSign": "cf093a0e6b07dce3c8e05f7d4a9c261c",
    "serverIp": "139.224.25.197",
    "serverPort": 443,
    "backupIp": "47.103.133.227",
    "proxyUrl": ""
  }
}
```

支持的 `action` 值：

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

可接受的返回格式：

- `{ "ok": true, "data": { ... } }`
- `{ "code": 0, "data": { ... } }`
- 直接返回符合预期字段的原始 JSON 对象

登录时，helper 至少要返回 `dtUserId` / `userId` 和 `token` / `loginToken`。
导出会话时，helper 至少要返回 `dtUserId`、`token` 和 `deviceId`。
刷新快照时，后端会同时兼容标准化后的快照对象，以及带有 `profile`、`balance` 或 `snapshot` 这类嵌套字段的大对象，并会自动归一化。

关于手机号购买动作：

- `request_phone_number` 现在只负责返回候选号、免费次数和价格预览。
- `purchase_phone_number` 才会真正执行购买，并在成功后回写本地手机号表。

## 真实邮箱验证码登录步骤

如果你要走“首次真实邮箱验证码登录”，建议按这个顺序：

1. 把 `DT_GATEWAY_MODE` 设为 `real`，并确保 `DT_REAL_BRIDGE_BASE_URL` 指向可用的 helper。
2. 先确认 `http://127.0.0.1:19091/health` 可访问，再确认模拟器或设备里的目标应用能正常打开。
3. 前端创建账号时选择“邮箱验证码登录”，后端会先调用 `POST /api/accounts` 创建待验证账号，并触发一次真实发码。
4. 如果要重发验证码，可以调用 `POST /api/accounts/:id/send-verification-code`。
5. 收到真实邮箱验证码后，调用 `POST /api/accounts/:id/verify-code` 提交 `{ "code": "收到的验证码" }`。
6. 验证成功后，后端会自动落库 `dtUserId` / `token` / `deviceId`，并继续刷新快照与手机号。

## 无 app 的直连导入步骤

如果你已经拿到可用的 `dtUserId`、`token`、`deviceId`，可以完全不借助 app UI：

1. 把 `DT_GATEWAY_MODE` 设为 `direct`。
2. 创建一个 `manual_session` 账户。
3. 调用 `POST /api/accounts/:id/validate-session`，请求体示例：

```json
{
  "dt_user_id": "145138329xxxxxx",
  "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "device_id": "Android.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.dttalk",
  "device_id_candidates": ["Android.backup-device-id.dttalk"]
}
```

4. 后端会先做一次直连探测，探测成功后才会保存会话。
5. 保存成功后，可以继续调用刷新、号码、监听相关接口，全程不依赖 app。

## 快速开始

```bash
cd backend
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

默认管理员账号来自 `.env`：

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

## 常用接口

- `GET /health`
- `POST /api/auth/login`
- `GET /api/dashboard/stats`
- `GET /api/accounts`
- `GET /api/events?token=<jwt>`
- `POST /api/settings/mock-message`

## 说明

- 账号密码和说道 token 都会在入库前加密。
- `POST /api/settings/mock-message` 是为了让前端和 SSE 流程在真实推送链路接好之前就能先跑通。
- [2026-05-11 优化标记] 仓库里的 `backend/helper` 现在已经提供基于 Frida 的真实 helper，不再是原生桥接占位阶段。
- [2026-05-11 优化标记] helper 的申请、续期、暂停、恢复、取消和列表动作都已经接入后端真实网关，后端也能自动整理 helper 返回的候选号列表。
- [2026-05-11 优化标记] 新增 `direct` 网关路径，允许在不依赖安卓的情况下，对已经登录好的账号做后登录刷新和列表拉取。
- [2026-05-11 优化标记] 管理员登录失败现在会明确返回 `账户或密码错误`，前端不再依赖乱码兜底文案。

## 真实 helper 启动

```bash
cd backend/helper
python server.py
```

本地真实模式建议这样配：

```bash
DT_GATEWAY_MODE=real
DT_REAL_BRIDGE_BASE_URL=http://127.0.0.1:19091
```

## 本次验证结果

- Python helper 语法检查通过。
- Frida agent 语法检查通过。
- 后端 TypeScript 构建通过。
- 前端生产构建通过。
- [2026-05-11 真实联调验证] 已在逍遥模拟器上完成真实 helper 联调，`export_session` 已成功导出 `dtUserId`、`token`、`deviceId`、`dingtoneId`。
- [2026-05-11 真实联调验证] 本次实测链路为：`127.0.0.1:21503` -> `frida-server 17.9.7 x86_64` -> `127.0.0.1:27042` -> `backend/helper/server.py`。
- [2026-05-11 真实联调验证] `real` 模式下发送邮箱验证码已成功进入待输入验证码步骤；已登录模拟器会话可成功导入后端、刷新真实资料并启动/停止监听。
- [2026-05-10 优化标记] 真实桥接相关配置也已经注册到 `settings` 表里，对应键名是 `dt_real_bridge_*`，但前端设置页当前主要还是先依赖 `.env`。

## 逍遥模拟器接入提示

[2026-05-11 优化标记] 如果你是用安卓模拟器做真实联调，需要先确认 ADB、`frida-server`、端口转发和 helper 连接方式都已打通，再调用 `POST /api/accounts/:id/capture-session` 导出会话。内部模拟器接入笔记不随 GitHub 仓库上传。
## 2026-05-11 优化标记

- 真实快照现在会尽量补充说道号、余额、有效积分、进度积分、进度总分和会员等级。
- 前端手机号为空时会显示“未绑定”，已存在但尚未同步的号码会提示后台仍在刷新。
- 获取新号码增加了国家/地区选择和候选号、扣费预览的提示链路。
