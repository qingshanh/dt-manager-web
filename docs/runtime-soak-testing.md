# 运行资源长期采样

资源优化完成后，需要区分“正常堆波动”和“持续泄漏”。项目提供 `tools/soak-runtime.mjs`，定时读取公开 health 与管理员认证 metrics，只保存内存、CPU、计数器和 gauge，不保存 token、邮箱、手机号、设备标识、原始帧或错误堆栈。

## 本地 2 小时

先登录面板取得临时管理员 token，并只放入当前终端环境变量：

```powershell
$env:DT_ADMIN_TOKEN = '当前会话临时 token'
node tools/soak-runtime.mjs `
  --health-url http://127.0.0.1:5174/health `
  --metrics-url http://127.0.0.1:5174/api/runtime/metrics `
  --duration-minutes 120 `
  --interval-seconds 30 `
  --output _tmp/runtime/soak-local.jsonl
```

token 不会写入输出。运行结束会计算预热后的 RSS 斜率和单核 CPU 平均值；超过默认 5MB/小时或单核 10% 时非零退出。

## Linux 或 Docker 24 小时

```bash
node tools/soak-runtime.mjs \
  --health-url http://127.0.0.1:5174/health \
  --metrics-url http://127.0.0.1:5174/api/runtime/metrics \
  --duration-minutes 1440 \
  --interval-seconds 60 \
  --output /var/log/dt-manager/soak-runtime.jsonl
```

同时保留平台旁证：

```bash
systemctl show dt-manager-backend -p MemoryPeak -p CPUUsageNSec -p TasksCurrent -p NRestarts
docker stats --no-stream
docker compose ps --all
```

## 判定标准

- 前 10 分钟作为默认预热期，不纳入斜率；
- RSS 斜率低于 5MB/小时；
- 空闲单核 CPU 平均低于 10%；
- listener、socket、queue 和 cache gauge 保持有界；
- restart count 不持续增长；
- 正式环境没有 adb、Frida、helper 或模拟器子进程。

如果只看到 RSS 上下波动、heapUsed 能回落、句柄和 socket 不增长，不能仅凭单次高点判断为泄漏。
