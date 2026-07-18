import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import express, { type RequestHandler } from "express";
import test from "node:test";

import { installJsonBodyParsers } from "./request-body-limits.js";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const nginxSource = readFileSync(new URL("../../../frontend/nginx.conf", import.meta.url), "utf8");

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  const requireTestAuth: RequestHandler = (req, res, next) => {
    if (req.headers.authorization !== "Bearer test") {
      res.status(401).json({ ok: false });
      return;
    }
    next();
  };
  installJsonBodyParsers(app, requireTestAuth, { standardLimit: "1kb", backupLimit: "4kb" });
  app.post("/api/accounts/backup/import", (_req, res) => res.json({ ok: true }));
  app.post("/api/echo", (_req, res) => res.json({ ok: true }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
    res.status(status).json({ ok: false });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function body(size: number) {
  return JSON.stringify({ content: "x".repeat(size) });
}

test("ordinary API rejects oversized JSON while backup uses its independent limit", async () => {
  await withServer(async (baseUrl) => {
    const ordinary = await fetch(`${baseUrl}/api/echo`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: body(1500)
    });
    assert.equal(ordinary.status, 413);

    const backup = await fetch(`${baseUrl}/api/accounts/backup/import`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: body(1500)
    });
    assert.equal(backup.status, 200);

    const oversizedBackup = await fetch(`${baseUrl}/api/accounts/backup/import`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: body(5000)
    });
    assert.equal(oversizedBackup.status, 413);
  });
});

test("unauthorized backup is rejected before the large parser", async () => {
  await withServer(async (baseUrl) => {
    const unauthorizedBackup = await fetch(`${baseUrl}/api/accounts/backup/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(5000)
    });
    assert.equal(unauthorizedBackup.status, 401);
  });
});

test("backend entrypoint installs the scoped JSON body parsers", () => {
  assert.match(indexSource, /import \{ installJsonBodyParsers \} from "\.\/services\/request-body-limits\.js";/);
  assert.match(indexSource, /installJsonBodyParsers\(app, requireAuth\);/);
});

test("nginx grants 100 MB only to the exact backup import route", () => {
  assert.match(nginxSource, /client_max_body_size 2m;/);
  const backupLocation = nginxSource.match(/location = \/api\/accounts\/backup\/import \{([\s\S]*?)\n  \}/);
  assert.ok(backupLocation);
  const backupLocationBody = backupLocation[1];
  assert.ok(backupLocationBody);
  assert.match(backupLocationBody, /client_max_body_size 100m;/);
  assert.ok(
    nginxSource.indexOf("location = /api/accounts/backup/import") < nginxSource.indexOf("location /api/"),
    "the exact backup route must be declared before the generic API proxy"
  );
});
