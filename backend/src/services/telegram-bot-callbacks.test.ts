import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeTelegramCallback,
  paginateTelegramItems,
  parseTelegramCallback,
  type TelegramPanelCallback
} from "./telegram-bot-callbacks.js";

test("telegram callbacks round-trip every supported action within 64 bytes", () => {
  const callbacks = [
    { scope: "panel", action: "root" },
    { scope: "panel", action: "status" },
    { scope: "panel", action: "messages" },
    { scope: "panel", action: "help" },
    { scope: "panel", action: "accounts", page: 2 },
    { scope: "panel", action: "phones", page: 3 },
    { scope: "account", action: "detail", accountId: 433 },
    { scope: "account", action: "messages", accountId: 433 },
    { scope: "account", action: "phones", accountId: 433, page: 4 },
    { scope: "account", action: "refresh", accountId: 433 },
    { scope: "account", action: "refresh_phones", accountId: 433 },
    { scope: "account", action: "monitor_on", accountId: 433 },
    { scope: "account", action: "monitor_off", accountId: 433 },
    { scope: "account", action: "notify_on", accountId: 433 },
    { scope: "account", action: "notify_off", accountId: 433 },
    { scope: "account", action: "relogin_send_code", accountId: 433 },
    { scope: "phone", action: "detail", accountId: 433, phoneId: 91 },
    { scope: "phone", action: "note", accountId: 433, phoneId: 91 },
    { scope: "phone", action: "renew_request", accountId: 433, phoneId: 91 },
    { scope: "phone", action: "cancel_request", accountId: 433, phoneId: 91 },
    { scope: "phone", action: "renew_confirm", accountId: 433, phoneId: 91, version: "a1b2c3d4" },
    { scope: "phone", action: "cancel_confirm", accountId: 433, phoneId: 91, version: "f5e6d7c8" }
  ] satisfies TelegramPanelCallback[];

  for (const callback of callbacks) {
    const encoded = encodeTelegramCallback(callback);
    assert.ok(Buffer.byteLength(encoded, "utf8") <= 64, encoded);
    assert.deepEqual(parseTelegramCallback(encoded), callback);
  }
});

test("telegram callback parser rejects malformed and unsupported values", () => {
  const invalidValues = [
    undefined,
    "",
    "p:x",
    "p:r:1",
    "p:a:0",
    "p:a:-1",
    "p:a:1.5",
    "a:0:d",
    "a:9007199254740992:d",
    "a:1:x",
    "a:1:o",
    "a:1:t",
    "a:1:d:2",
    "a:1:n:0",
    "a:1:n:2:extra",
    "n:1:0:d",
    "n:1:2:x",
    "n:1:2:d:extra",
    "n:1:2:rx",
    "n:1:2:rx:bad-version!",
    "n:1:2:cx:",
    "other"
  ];

  for (const value of invalidValues) {
    assert.equal(parseTelegramCallback(value), null, String(value));
  }
});

test("telegram callback encoder rejects non-positive identifiers", () => {
  assert.throws(
    () => encodeTelegramCallback({ scope: "account", action: "detail", accountId: 0 }),
    RangeError
  );
  assert.throws(
    () => encodeTelegramCallback({ scope: "phone", action: "detail", accountId: 1, phoneId: 0 }),
    RangeError
  );
});

test("telegram callback protocol exposes only two-stage renew and cancel actions", () => {
  for (const action of ["buy", "renew", "pause", "resume", "cancel", "renew_confirm", "cancel_confirm"]) {
    assert.equal(parseTelegramCallback(`n:1:2:${action}`), null);
    assert.equal(parseTelegramCallback(`a:1:${action}`), null);
  }
  assert.deepEqual(parseTelegramCallback("n:1:2:rr"), {
    scope: "phone",
    action: "renew_request",
    accountId: 1,
    phoneId: 2
  });
  assert.deepEqual(parseTelegramCallback("n:1:2:rx:a1b2c3d4"), {
    scope: "phone",
    action: "renew_confirm",
    accountId: 1,
    phoneId: 2,
    version: "a1b2c3d4"
  });
});

test("telegram pagination clamps pages and preserves empty collections", () => {
  assert.deepEqual(paginateTelegramItems([1, 2, 3, 4, 5], 99, 2), {
    items: [5],
    page: 3,
    totalPages: 3
  });
  assert.deepEqual(paginateTelegramItems([1, 2, 3], -2, 2), {
    items: [1, 2],
    page: 1,
    totalPages: 2
  });
  assert.deepEqual(paginateTelegramItems([], 4, 8), {
    items: [],
    page: 1,
    totalPages: 1
  });
});

test("telegram pagination rejects invalid page sizes", () => {
  for (const pageSize of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => paginateTelegramItems([1, 2], 1, pageSize), RangeError);
  }
});
