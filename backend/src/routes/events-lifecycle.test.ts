import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  attachSseCleanup,
  closeAllSseConnections,
  getActiveSseConnectionCountForTest,
  writeSseEvent
} from "./events.js";

class FakeResponse extends EventEmitter {
  writableEnded = false;
  endCalls = 0;

  end() {
    this.endCalls += 1;
    this.writableEnded = true;
    return this;
  }
}

test("request, response close, and response error share one idempotent cleanup", () => {
  for (const event of ["request-close", "response-close", "response-error"] as const) {
    const req = new EventEmitter();
    const res = new FakeResponse();
    const bus = new EventEmitter();
    const listener = () => undefined;
    let cleared = 0;
    bus.on("event", listener);
    attachSseCleanup({
      req,
      res,
      clearHeartbeat: () => { cleared += 1; },
      removeListener: () => bus.off("event", listener)
    });

    if (event === "request-close") req.emit("close");
    if (event === "response-close") res.emit("close");
    if (event === "response-error") res.emit("error", new Error("closed"));
    req.emit("close");
    res.emit("close");

    assert.equal(cleared, 1, event);
    assert.equal(bus.listenerCount("event"), 0, event);
    assert.equal(res.endCalls, 1, event);
    assert.equal(getActiveSseConnectionCountForTest(), 0, event);
  }
});

test("one hundred connect-disconnect cycles return listeners to baseline", () => {
  const bus = new EventEmitter();
  const baseline = bus.listenerCount("event");
  for (let index = 0; index < 100; index += 1) {
    const req = new EventEmitter();
    const res = new FakeResponse();
    const listener = () => undefined;
    bus.on("event", listener);
    attachSseCleanup({
      req,
      res,
      clearHeartbeat: () => undefined,
      removeListener: () => bus.off("event", listener)
    });
    req.emit("close");
  }
  assert.equal(bus.listenerCount("event"), baseline);
  assert.equal(getActiveSseConnectionCountForTest(), 0);
});

test("shutdown closes every active SSE response", () => {
  const responses = Array.from({ length: 3 }, () => {
    const req = new EventEmitter();
    const res = new FakeResponse();
    attachSseCleanup({
      req,
      res,
      clearHeartbeat: () => undefined,
      removeListener: () => undefined
    });
    return res;
  });
  assert.equal(getActiveSseConnectionCountForTest(), 3);
  closeAllSseConnections();
  assert.equal(getActiveSseConnectionCountForTest(), 0);
  assert.deepEqual(responses.map((response) => response.endCalls), [1, 1, 1]);
});

test("SSE writer reports backpressure so the route can close a slow client", () => {
  const writes: string[] = [];
  const writable = {
    write(chunk: string) {
      writes.push(chunk);
      return writes.length < 2;
    }
  };
  assert.equal(writeSseEvent(writable, "message", { ok: true }), false);
  assert.equal(writes.length, 2);
});
