import assert from "node:assert/strict";
import test from "node:test";
import { buildPhoneSmsReceptionDiagnostic } from "./phone-sms-diagnostics.js";

const ready = {
  status: "active" as const,
  expiredTime: "1893456000000",
  providerId: 2600,
  packageServiceId: "DT06001",
  monitorEnabled: true,
  monitorRunning: true,
  monitorStatus: "running",
  monitorListenActive: true
};

test("unknown filter field is not reported as SMS reception being disabled", () => {
  const result = buildPhoneSmsReceptionDiagnostic({
    ...ready,
    allowReceiveSms: undefined,
    receivedCount: 2,
    lastReceivedAt: "2026-07-23T10:00:00.000Z"
  });

  assert.equal(result.filterStatus, "not_returned");
  assert.equal(result.deliveryStatus, "received");
  assert.equal(result.repairable, false);
});

test("unknown filter without delivery evidence remains unverified and not repairable", () => {
  const result = buildPhoneSmsReceptionDiagnostic({
    ...ready,
    allowReceiveSms: undefined,
    receivedCount: 0,
    lastReceivedAt: null
  });

  assert.equal(result.filterStatus, "not_returned");
  assert.equal(result.routingStatus, "ready");
  assert.equal(result.listenerStatus, "active");
  assert.equal(result.deliveryEvidence, "unverified");
  assert.equal(result.deliveryStatus, "unverified");
  assert.equal(result.repairable, false);
});

test("explicit active filter blocking is repairable", () => {
  const result = buildPhoneSmsReceptionDiagnostic({
    ...ready,
    allowReceiveSms: false,
    receivedCount: 0,
    lastReceivedAt: null
  });

  assert.equal(result.filterStatus, "blocked");
  assert.equal(result.deliveryStatus, "filter_blocked");
  assert.equal(result.repairable, true);
});

test("active number with a stopped listener is diagnosed separately from App filtering", () => {
  const result = buildPhoneSmsReceptionDiagnostic({
    ...ready,
    allowReceiveSms: true,
    monitorRunning: false,
    monitorStatus: "stopped",
    monitorListenActive: false,
    receivedCount: 0,
    lastReceivedAt: null
  });

  assert.equal(result.filterStatus, "allowed");
  assert.equal(result.deliveryStatus, "listener_unhealthy");
  assert.equal(result.repairable, false);
});

test("a newly restarted listener is reported as starting instead of disabled", () => {
  const result = buildPhoneSmsReceptionDiagnostic({
    ...ready,
    allowReceiveSms: true,
    monitorStatus: "running",
    monitorListenActive: false,
    receivedCount: 0,
    lastReceivedAt: null
  });

  assert.equal(result.deliveryStatus, "listener_starting");
});

test("an error monitor session is unhealthy even when its last note said listen active", () => {
  const result = buildPhoneSmsReceptionDiagnostic({
    ...ready,
    allowReceiveSms: true,
    monitorStatus: "error",
    receivedCount: 0,
    lastReceivedAt: null
  });

  assert.equal(result.deliveryStatus, "listener_unhealthy");
});

test("healthy route without message history remains explicitly unverified", () => {
  const result = buildPhoneSmsReceptionDiagnostic({
    ...ready,
    allowReceiveSms: true,
    receivedCount: 0,
    lastReceivedAt: null
  });

  assert.equal(result.deliveryStatus, "unverified");
  assert.match(result.summary, /测试短信/);
});
