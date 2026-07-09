#!/usr/bin/env node
import { spawn } from "node:child_process";

const restartDelayMs = Number(process.env.DEV_SUPERVISOR_RESTART_DELAY_MS ?? 1500);
let child = null;
let stopping = false;
let restartTimer = null;
let restartCount = 0;

function log(message, meta = undefined) {
  const suffix = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  console.log(`[dev-supervisor] ${new Date().toISOString()} ${message}${suffix}`);
}

function startBackend() {
  if (stopping) {
    return;
  }
  restartCount += 1;
  log("starting backend", { attempt: restartCount });
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });

  child.on("exit", (code, signal) => {
    const exitedChild = child;
    child = null;
    if (stopping) {
      log("backend stopped", { code, signal });
      return;
    }
    log("backend exited; restarting", { code, signal, delayMs: restartDelayMs });
    restartTimer = setTimeout(() => {
      if (child === null && exitedChild !== child) {
        startBackend();
      }
    }, restartDelayMs);
    restartTimer.unref?.();
  });

  child.on("error", (error) => {
    log("failed to spawn backend", { error: error instanceof Error ? error.message : String(error) });
  });
}

function stop(signal) {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (!child) {
    process.exit(0);
    return;
  }
  child.once("exit", () => process.exit(0));
  child.kill(signal);
  setTimeout(() => process.exit(0), 5000).unref?.();
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGHUP", () => stop("SIGHUP"));

startBackend();