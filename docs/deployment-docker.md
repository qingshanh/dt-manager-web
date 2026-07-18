# Docker Compose 部署

默认 Compose 只启动 backend 和 frontend。helper 仅属于 `real` profile；正式 direct 部署默认不启动 helper，也不运行模拟器、ADB 或 Frida。

## 启动

复制 `.env.example` 为 `.env`，填写真实 JWT、加密密钥和管理员密码，并保持：

```dotenv
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=512
DT_GATEWAY_MODE=direct
DT_ALLOW_APP_FALLBACK=false
```

执行：

```bash
docker compose config --quiet
docker compose build backend frontend
docker compose up -d
docker compose ps
docker stats --no-stream
```

backend 初始限制为 1 CPU、1GB 内存、128 PID；frontend 为 0.25 CPU、128MB 内存、64 PID。两者日志均按 10MB、3 个文件轮转。

## 验证

```bash
curl -fsS http://127.0.0.1:5173/health
backend_id=$(docker compose ps -q backend)
docker inspect "$backend_id" --format 'Memory={{.HostConfig.Memory}} NanoCpus={{.HostConfig.NanoCpus}} Pids={{.HostConfig.PidsLimit}} Init={{.HostConfig.Init}}'
docker compose exec backend ps -o pid,ppid,comm,args
```

Prisma migration 完成后，后端容器应由 init 直接管理 `node dist/index.js`，不应长期残留 `sh -c`、npm、tsx 或 dev supervisor。

## 停止和数据安全

```bash
docker compose stop --timeout 20
docker compose down
```

不要对 `docker compose down` 添加 `-v`，否则会删除保存 SQLite 数据库的 `backend-data` volume。升级前建议另外备份 volume 中的 `/app/data/dingtone.db`。

只有逆向测试才显式运行：

```bash
docker compose --profile real up -d helper
```

helper 在容器内监听 `0.0.0.0` 以接收 Docker 端口转发，但端口默认只发布到宿主机 `127.0.0.1`。启用前必须在 `.env` 同时设置非空且相同的 `DT_HELPER_TOKEN` 与 `DT_REAL_BRIDGE_TOKEN`；空令牌会让 helper 明确拒绝启动，缓存私号接口也执行同一鉴权。不要把 Frida/会话接口暴露到公网。正式部署默认 helper 不启动。完成至少 24 小时采样后再根据峰值调整资源限制，不要在缺少数据时直接把后端压到 512MB。
