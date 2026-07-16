import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

test("production environment templates use the approved resource and fallback defaults", () => {
  const rootEnv = read(".env.example");
  const systemdEnv = read("deploy/systemd/dt-manager.env.example");

  assert.match(rootEnv, /^NODE_OPTIONS=--max-old-space-size=512$/m);
  assert.match(rootEnv, /^DT_ALLOW_APP_FALLBACK=false$/m);
  assert.match(systemdEnv, /^NODE_ENV=production$/m);
  assert.match(systemdEnv, /^NODE_OPTIONS=--max-old-space-size=512$/m);
  assert.match(systemdEnv, /^DT_ALLOW_APP_FALLBACK=false$/m);
  assert.match(systemdEnv, /^DATABASE_URL=file:\/var\/lib\/dt-manager\/dingtone\.db$/m);
  assert.doesNotMatch(systemdEnv, /Bearer\s+\S+|bot\d+:[A-Za-z0-9_-]+|\b\d{10,15}\b/);
});

test("systemd runs the production build directly with restart and cgroup limits", () => {
  const unit = read("deploy/systemd/dt-manager-backend.service");

  assert.match(unit, /^StartLimitIntervalSec=60$/m);
  assert.match(unit, /^StartLimitBurst=5$/m);
  assert.match(unit, /^User=dt-manager$/m);
  assert.match(unit, /^WorkingDirectory=\/opt\/dt-manager\/backend$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node dist\/index\.js$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartSec=5$/m);
  assert.match(unit, /^KillSignal=SIGTERM$/m);
  assert.match(unit, /^KillMode=mixed$/m);
  assert.match(unit, /^TimeoutStopSec=20$/m);
  assert.match(unit, /^MemoryHigh=768M$/m);
  assert.match(unit, /^MemoryMax=1G$/m);
  assert.match(unit, /^CPUQuota=100%$/m);
  assert.match(unit, /^TasksMax=128$/m);
  assert.match(unit, /^StateDirectory=dt-manager$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/dt-manager$/m);
  assert.doesNotMatch(unit, /npm\s+run|tsx|dev-supervisor/);
});

test("native nginx serves the SPA and preserves API and SSE behavior", () => {
  const nginx = read("deploy/nginx/dt-manager.conf");

  assert.match(nginx, /root \/opt\/dt-manager\/frontend;/);
  assert.match(nginx, /try_files \$uri \$uri\/ \/index\.html;/);
  assert.match(nginx, /location = \/api\/accounts\/backup\/import[\s\S]*client_max_body_size 100m;/);
  assert.match(nginx, /location \/api\/events[\s\S]*proxy_buffering off;/);
  assert.match(nginx, /location \/api\/events[\s\S]*access_log off;/);
  assert.match(nginx, /location \/api\/[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:5174;/);
  assert.doesNotMatch(nginx, /server_name\s+(?!_)[^;]+;/);
});

test("Docker Compose enforces real limits and does not enable helper by default", () => {
  const compose = read("docker-compose.yml");

  const backendStart = compose.indexOf("  backend:");
  const frontendStart = compose.indexOf("  frontend:");
  const helperStart = compose.indexOf("  helper:");
  assert.ok(backendStart >= 0 && frontendStart > backendStart && helperStart > frontendStart);
  const backend = compose.slice(backendStart, frontendStart);
  const frontend = compose.slice(frontendStart, helperStart);
  const helper = compose.slice(helperStart);

  assert.match(backend, /\n    init: true\n/);
  assert.match(backend, /\n    cpus: 1\.0\n/);
  assert.match(backend, /\n    mem_limit: 1g\n/);
  assert.match(backend, /\n    pids_limit: 128\n/);
  assert.match(backend, /\n    stop_signal: SIGTERM\n/);
  assert.match(backend, /\n    stop_grace_period: 20s\n/);
  assert.match(backend, /NODE_OPTIONS: .*--max-old-space-size=512/);
  assert.match(backend, /DT_ALLOW_APP_FALLBACK: "false"/);
  assert.match(backend, /max-size: "10m"/);
  assert.match(backend, /max-file: "3"/);

  assert.match(frontend, /\n    init: true\n/);
  assert.match(frontend, /\n    cpus: 0\.25\n/);
  assert.match(frontend, /\n    mem_limit: 128m\n/);
  assert.match(frontend, /\n    pids_limit: 64\n/);
  assert.match(frontend, /condition: service_healthy/);
  assert.match(frontend, /max-size: "10m"/);
  assert.match(frontend, /max-file: "3"/);

  assert.match(helper, /profiles:\s*\n\s*- real/);
  assert.match(helper, /\n    init: true\n/);
  assert.match(helper, /\n    cpus: 0\.5\n/);
  assert.match(helper, /\n    mem_limit: 512m\n/);
  assert.match(helper, /\n    pids_limit: 128\n/);
  assert.match(helper, /max-size: "10m"/);
  assert.match(helper, /127\.0\.0\.1:\$\{HELPER_PORT:-5175\}:\$\{HELPER_PORT:-5175\}/);
});

test("backend container replaces the migration shell with the production Node process", () => {
  const dockerfile = read("backend/Dockerfile");
  const entrypoint = read("backend/docker-entrypoint.sh");
  const frontendNginx = read("frontend/nginx.conf");

  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["dt-manager-entrypoint"\]$/m);
  assert.match(dockerfile, /^CMD \["node", "dist\/index\.js"\]$/m);
  assert.doesNotMatch(dockerfile, /CMD \["sh", "-c"/);
  assert.match(entrypoint, /^#!\/bin\/sh/);
  assert.match(entrypoint, /prisma migrate deploy/);
  assert.match(entrypoint, /exec "\$@"/);
  assert.match(frontendNginx, /location \/api\/events[\s\S]*access_log off;/);
  assert.match(frontendNginx, /client_max_body_size 2m;/);
  assert.match(frontendNginx, /location = \/api\/accounts\/backup\/import[\s\S]*client_max_body_size 100m;/);
});

test("deployment documentation starts at one gigabyte and keeps emulator tooling out of production", () => {
  const readme = read("README.md");
  const linux = read("docs/deployment-linux-systemd.md");
  const docker = read("docs/deployment-docker.md");

  assert.match(readme, /生产.*1GB|1GB.*生产/s);
  assert.doesNotMatch(readme, /512MB[^\n]*(?:足够|推荐|正式)/);
  assert.match(linux, /node dist\/index\.js/);
  assert.match(linux, /DT_ALLOW_APP_FALLBACK=false/);
  assert.match(docker, /docker compose stop --timeout 20/);
  assert.match(docker, /不要.*-v|不得.*-v/);
  assert.match(docker, /默认.*helper|helper.*默认/);
});
