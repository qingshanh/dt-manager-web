#!/usr/bin/env node
import { spawn } from "node:child_process";
import { FATAL_LISTEN_EXIT_CODE, nextRestartDecision } from "./dev-supervisor-policy.mjs";

let child = null;
let childStartedAt = 0;
let stopping = false;
let restartTimer = null;
let restartCount = 0;
let exitTimestamps = [];

function log(message, meta = undefined) {
  const suffix = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  console.log(`[dev-supervisor] ${new Date().toISOString()} ${message}${suffix}`);
}

function startBackend() {
  if (stopping) {
    return;
  }
  restartCount += 1;
  childStartedAt = Date.now();
  log("starting backend", { attempt: restartCount });
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });

  child.on("exit", (code, signal) => {
    const now = Date.now();
    const stableRunMs = Math.max(0, now - childStartedAt);
    child = null;
    const decision = nextRestartDecision({
      exits: exitTimestamps,
      now,
      stableRunMs,
      exitCode: code,
      stopping
    });

    if (decision.nextFailureCount > 0) {
      const priorExits = stableRunMs >= 60_000
        ? []
        : exitTimestamps.filter((timestamp) => timestamp >= now - 60_000);
      exitTimestamps = [...priorExits, now];
    }

    if (!decision.restart) {
      log(decision.reason === "circuit-breaker" ? "backend restart circuit-breaker opened" : "backend stopped", {
        code,
        signal,
        reason: decision.reason,
        windowFailures: decision.nextFailureCount
      });
      if (!stopping) {
        process.exitCode = decision.reason === "fatal" && code === FATAL_LISTEN_EXIT_CODE
          ? FATAL_LISTEN_EXIT_CODE
          : 1;
      }
      return;
    }

    log("backend exited; restart scheduled", {
      code,
      signal,
      delayMs: decision.delayMs,
      windowFailures: decision.nextFailureCount
    });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (child === null && !stopping) {
        startBackend();
      }
    }, decision.delayMs);
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

  const stoppingChild = child;
  const finish = () => process.exit(0);
  stoppingChild.once("exit", finish);
  stoppingChild.kill(signal);
  setTimeout(() => {
    if (stoppingChild.exitCode !== null || stoppingChild.signalCode !== null) {
      finish();
      return;
    }
    if (process.platform === "win32" && stoppingChild.pid) {
      spawn("taskkill", ["/PID", String(stoppingChild.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        .once("exit", finish);
      return;
    }
    stoppingChild.kill("SIGKILL");
  }, 5_000).unref?.();
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGHUP", () => stop("SIGHUP"));

startBackend();
