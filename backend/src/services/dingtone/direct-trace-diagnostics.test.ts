import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDirectTraceWindowForTest, type DirectProbeFrameTrace } from "./direct-gateway.js";

function makeEntry(overrides: Partial<DirectProbeFrameTrace> = {}): DirectProbeFrameTrace {
  return {
    receivedAt: new Date().toISOString(),
    frameType: 0x8107,
    status: 0x0102,
    rawLength: 48,
    bodyLength: 26,
    rawHexPreview: "aabbccdd",
    bodyHexPreview: "ccdd",
    ...overrides
  };
}

test("reports no frames when the capture window is empty", () => {
  const sinceIso = new Date().toISOString();
  assert.equal(summarizeDirectTraceWindowForTest([], sinceIso), "no frames observed during capture window");
});

test("excludes frames received before the capture window started", () => {
  const before = makeEntry({ receivedAt: "2020-01-01T00:00:00.000Z" });
  const sinceIso = "2020-01-01T00:00:01.000Z";
  const summary = summarizeDirectTraceWindowForTest([before], sinceIso);
  assert.equal(summary, "no frames observed during capture window");
});

test("summarizes a frame that failed JSON extraction using its raw hex preview", () => {
  const sinceIso = "2020-01-01T00:00:00.000Z";
  const entry = makeEntry({ receivedAt: "2020-01-01T00:00:01.000Z", jsonPayload: undefined });
  const summary = summarizeDirectTraceWindowForTest([entry], sinceIso);
  assert.match(summary, /1 frame\(s\) observed:/);
  assert.match(summary, /type=0x8107 status=0x102 len=48 rawHex=aabbccdd/);
});

test("summarizes a frame with a parsed JSON payload and redacts sensitive fields", () => {
  const sinceIso = "2020-01-01T00:00:00.000Z";
  const entry = makeEntry({
    receivedAt: "2020-01-01T00:00:01.000Z",
    jsonPayload: { token: "super-secret", errCode: 0 }
  });
  const summary = summarizeDirectTraceWindowForTest([entry], sinceIso);
  assert.match(summary, /json=/);
  assert.ok(!summary.includes("super-secret"));
  assert.match(summary, /<redacted>/);
});

test("caps the number of shown frames and reports how many were omitted", () => {
  const sinceIso = "2020-01-01T00:00:00.000Z";
  const entries = Array.from({ length: 8 }, (_, index) =>
    makeEntry({ receivedAt: `2020-01-01T00:00:0${index + 1}.000Z`, rawLength: index })
  );
  const summary = summarizeDirectTraceWindowForTest(entries, sinceIso, 3);
  assert.match(summary, /^8 frame\(s\) observed \(showing last 3\):/);
  const shownCount = summary.split(" | ").length;
  assert.equal(shownCount, 3);
});
