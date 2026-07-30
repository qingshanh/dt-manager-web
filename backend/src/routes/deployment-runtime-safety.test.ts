import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

test("real helper is host-loopback-only and requires authentication for cached private-number data", () => {
  const compose = read("docker-compose.yml");
  const helper = read("backend/helper/server.py");
  const helperSection = compose.slice(compose.indexOf("  helper:"));

  assert.match(helperSection, /DT_HELPER_BIND_HOST:\s*0\.0\.0\.0/);
  assert.match(helperSection, /DT_HELPER_TOKEN:\s*\$\{DT_HELPER_TOKEN:-\}/);
  assert.match(helperSection, /127\.0\.0\.1:\$\{HELPER_PORT:-5175\}:\$\{HELPER_PORT:-5175\}/);
  assert.match(helper, /if not auth_token:\s*raise RuntimeError\(/);
  assert.doesNotMatch(helper, /if not token:\s*return/);
  const cachedStart = helper.indexOf('if parsed_path.path == "/cached/request_private_number":');
  const cachedEnd = helper.indexOf('if parsed_path.path != "/health":', cachedStart);
  assert.ok(cachedStart >= 0 && cachedEnd > cachedStart);
  assert.match(helper.slice(cachedStart, cachedEnd), /self\._authorize\(\)/);
});

test("Docker services define process, resource, shutdown, and log bounds", () => {
  const compose = read("docker-compose.yml");
  const dockerfile = read("backend/Dockerfile");
  const backendStart = compose.indexOf("  backend:");
  const frontendStart = compose.indexOf("  frontend:");
  const helperStart = compose.indexOf("  helper:");
  const sections = [
    compose.slice(backendStart, frontendStart),
    compose.slice(frontendStart, helperStart),
    compose.slice(helperStart)
  ];
  for (const section of sections) {
    assert.match(section, /\n    init: true\n/);
    assert.match(section, /\n    cpus:/);
    assert.match(section, /\n    mem_limit:/);
    assert.match(section, /\n    pids_limit:/);
    assert.match(section, /\n    stop_grace_period:/);
    assert.match(section, /max-size: "10m"/);
    assert.match(section, /max-file: "3"/);
  }
  assert.match(sections[0] ?? "", /stop_signal: SIGTERM/);
  assert.match(sections[0] ?? "", /NODE_OPTIONS: .*--max-old-space-size=512/);
  assert.match(sections[0] ?? "", /DT_ALLOW_APP_FALLBACK: "false"/);
  assert.match(sections[1] ?? "", /condition: service_healthy/);
  assert.match(sections[2] ?? "", /stop_signal: SIGTERM/);
  assert.match(dockerfile, /ENTRYPOINT \["dt-manager-entrypoint"\]/);
  assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]/);
  assert.doesNotMatch(dockerfile, /CMD \["sh", "-c"/);
});

test("Docker builds default to official images and ignore stale Compose mirror overrides", () => {
  const compose = read("docker-compose.yml");
  const dockerfiles = [
    read("backend/Dockerfile"),
    read("frontend/Dockerfile"),
    read("backend/helper/Dockerfile")
  ].join("\n");

  assert.doesNotMatch(compose, /DOCKER_(?:NODE|NGINX|PYTHON)_IMAGE/);
  assert.match(dockerfiles, /ARG NODE_IMAGE=node:22-alpine/);
  assert.match(dockerfiles, /ARG NGINX_IMAGE=nginx:1\.27-alpine/);
  assert.match(dockerfiles, /ARG PYTHON_IMAGE=python:3\.11-slim/);
  assert.doesNotMatch(compose, /docker\.hanxi\.cc/);
  assert.doesNotMatch(dockerfiles, /docker\.hanxi\.cc/);
});
