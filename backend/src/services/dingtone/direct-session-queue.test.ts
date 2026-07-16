import assert from "node:assert/strict";
import test from "node:test";
import {
  appendDirectSocketBufferForTest,
  createDirectWaiterQueueForTest,
  enqueueDirectJsonPayloadForTest,
  enqueueDirectRawFrameForTest,
  isDirectFrameLengthAllowedForTest
} from "./direct-gateway.js";

function frame(type: number, status?: number, length = 22) {
  const value = Buffer.alloc(length);
  value[0] = 0x01;
  value[1] = 0x07;
  value.writeUInt32BE(value.length, 2);
  value.writeUInt16BE(type, 6);
  if (status !== undefined) {
    value.writeUInt16BE(status, 16);
  }
  return value;
}

test("direct socket rejects oversized declared frames and unfinished buffers", () => {
  assert.equal(isDirectFrameLengthAllowedForTest(2 * 1024 * 1024), true);
  assert.equal(isDirectFrameLengthAllowedForTest(2 * 1024 * 1024 + 1), false);

  const result = appendDirectSocketBufferForTest(
    Buffer.alloc(4 * 1024 * 1024),
    Buffer.from([1])
  );
  assert.equal(result.overflow, true);
  assert.equal(result.buffer.length, 0);
});

test("direct raw queue protects SMS and control frames under pressure", () => {
  const sms = frame(0x8107, 0x0103);
  const control = frame(0x8107, 0x0101);
  const diagnostic = frame(0x8107, 0x0102);
  const queue = [sms, control];

  const droppedDiagnostic = enqueueDirectRawFrameForTest(queue, diagnostic, 2);
  assert.equal(droppedDiagnostic, 1);
  assert.deepEqual(queue, [sms, control]);

  const diagnosticQueue = [diagnostic, control];
  const droppedForSms = enqueueDirectRawFrameForTest(diagnosticQueue, sms, 2);
  assert.equal(droppedForSms, 1);
  assert.deepEqual(diagnosticQueue, [control, sms]);
});

test("direct raw queue retains the newest SMS when all queued frames have equal priority", () => {
  const firstSms = frame(0x8107, 0x0103);
  firstSms[12] = 1;
  const secondSms = frame(0x8107, 0x0103);
  secondSms[12] = 2;
  const queue = [firstSms];

  assert.equal(enqueueDirectRawFrameForTest(queue, secondSms, 1), 1);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.[12], 2);
});

test("direct JSON queue keeps the newest bounded payloads", () => {
  const queue: Array<Record<string, number>> = [];
  let dropped = 0;
  for (let index = 0; index < 300; index += 1) {
    dropped += enqueueDirectJsonPayloadForTest(queue, { index }, 256);
  }

  assert.equal(queue.length, 256);
  assert.equal(queue[0]?.index, 44);
  assert.equal(queue[255]?.index, 299);
  assert.equal(dropped, 44);
});

test("timed out direct waiters are removed and cannot swallow the next frame", async () => {
  const waiters = createDirectWaiterQueueForTest<string>();

  await assert.rejects(waiters.wait(5, () => new Error("expected timeout")), /expected timeout/);
  assert.equal(waiters.size, 0);

  const next = waiters.wait(100, () => new Error("unexpected timeout"));
  assert.equal(waiters.resolveNext("next-frame"), true);
  assert.equal(await next, "next-frame");
  assert.equal(waiters.size, 0);
});

test("direct raw queue enforces a total byte budget", () => {
  const queue: Buffer[] = [];
  let dropped = 0;
  for (let index = 0; index < 3; index += 1) {
    const candidate = frame(0x8107, 0x0102, 40);
    candidate[20] = index;
    dropped += enqueueDirectRawFrameForTest(queue, candidate, 512, 80);
  }

  assert.equal(queue.reduce((total, item) => total + item.length, 0), 80);
  assert.equal(queue.length, 2);
  assert.deepEqual(queue.map((item) => item[20]), [1, 2]);
  assert.equal(dropped, 1);
});

test("direct JSON queue enforces a serialized byte budget", () => {
  const queue: Array<{ index: number; text: string }> = [];
  let dropped = 0;
  for (let index = 0; index < 3; index += 1) {
    dropped += enqueueDirectJsonPayloadForTest(queue, { index, text: "x".repeat(20) }, 256, 70);
  }

  const bytes = queue.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
  assert.ok(bytes <= 70);
  assert.deepEqual(queue.map((item) => item.index), [2]);
  assert.equal(dropped, 2);
});
