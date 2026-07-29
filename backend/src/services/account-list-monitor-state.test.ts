import assert from "node:assert/strict";
import test from "node:test";
import {
  isAuthenticationSessionError,
  resolveAccountListMonitorState
} from "./account-list-monitor-state.js";

test("retryable monitor transport errors do not render an account as abnormal", () => {
  assert.deepEqual(
    resolveAccountListMonitorState({
      status: "error",
      monitorEnabled: true,
      lastError: "connect ECONNREFUSED 127.0.0.1:3066"
    }),
    { status: "online", monitorState: "retrying", requiresRelogin: false }
  );
});

test("non-retryable account errors remain abnormal", () => {
  assert.deepEqual(
    resolveAccountListMonitorState({
      status: "error",
      monitorEnabled: true,
      lastError: "Unexpected parser invariant"
    }),
    { status: "error", monitorState: "running", requiresRelogin: false }
  );
});

test("disabled monitors are shown as stopped", () => {
  assert.deepEqual(
    resolveAccountListMonitorState({
      status: "offline",
      monitorEnabled: false,
      lastError: null
    }),
    { status: "offline", monitorState: "stopped", requiresRelogin: false }
  );
});

test("a disabled monitor cannot leave an account displayed as online", () => {
  assert.deepEqual(
    resolveAccountListMonitorState({
      status: "online",
      monitorEnabled: false,
      lastError: null
    }),
    { status: "offline", monitorState: "stopped", requiresRelogin: false }
  );
});

test("authentication binding errors require verification login instead of transport retry", () => {
  assert.equal(
    isAuthenticationSessionError("Direct session bootstrap failed: Authen : userId not match."),
    true
  );
  assert.deepEqual(
    resolveAccountListMonitorState({
      status: "expired",
      monitorEnabled: false,
      lastError: "Direct session bootstrap failed: Authen : userId not match."
    }),
    { status: "expired", monitorState: "stopped", requiresRelogin: true }
  );
});
