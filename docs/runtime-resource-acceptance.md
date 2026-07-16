# v0.2.9 运行资源验收清单

## Windows 本地

- 连续启动/停止 10 次；
- 每次 health `instanceId` 唯一；
- 停止后 manifest 所有 PID 消失；
- 5173、5174 和可选 5175 释放；
- 第二次 stop 幂等成功；
- 不影响 Codex、浏览器、MCP 或其它项目 Node 进程；
- 人为占用 5174 时，启动在 10 秒内失败且不产生 supervisor 重启风暴。

## Linux systemd

- `systemd-analyze verify` 通过；
- MainPID 直接运行 `node dist/index.js`；
- MemoryHigh=768M、MemoryMax=1G、CPUQuota=100%、TasksMax=128 生效；
- `systemctl stop` 后 20 秒内退出并释放 5174；
- 60 秒内连续快速失败最多 5 次，之后触发 start limit；
- cgroup 中没有 npm、tsx、dev supervisor、adb、Frida 或 helper。

## Docker Compose

- `docker compose config --quiet` 通过；
- backend 实际限制为 1 CPU、1GB、128 PID、init=true；
- frontend 实际限制为 0.25 CPU、128MB、64 PID；
- migration 后后端只长期运行 init 和 `node dist/index.js`；
- `docker compose stop --timeout 20` 能优雅退出；
- 默认 helper 容器不存在；
- 日志轮转为 10MB × 3；
- `backend-data` volume 保留，验收不得执行 `docker compose down -v`。

## 业务与资源共同标准

- 约 9 个监听账户本地采样至少 2 小时，Linux 或 Docker 采样至少 24 小时；
- 预热后内存增长斜率低于 5MB/小时；
- 空闲 CPU 平均低于单核 10%；
- Direct pushes、calls、trace、错误、queue 和 cache 保持固定上限；
- Direct link 必须连续存活至少 60 秒后，验收才报告 `active`；代码健康门槛仍为 15 秒，验收观察窗口为 60 秒；
- 同一 60 秒窗口内，paired registration/read failure 不得超过初始连接数量；
- `offlineCatchupSends` 不得仅因间隔数秒的重连而持续增长；
- 已知成功号码必须出现 `0x0103 -> parsed SMS -> stored message` 的完整链路；
- 正式环境必须满足 `appFallbackAllowed=false`；
- 正式环境不执行 App/helper/ADB fallback；
- 普通短信、目标号码、团队消息、主备故障接管、Telegram 和商城订单同步无回退。

首次保持 1GB 后端上限。只有完整 24 小时数据证明峰值长期低于 600MB，才单独评估下调。
