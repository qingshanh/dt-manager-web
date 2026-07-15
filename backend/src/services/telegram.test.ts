import assert from "node:assert/strict";
import test from "node:test";
import { TelegramApiError, TelegramService } from "./telegram.js";

test("telegram sendMessage posts chat text and HTML parse mode with a finite abort signal", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody: Record<string, unknown> = {};
  let capturedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedMethod = init?.method ?? "";
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    capturedSignal = init?.signal as AbortSignal | null | undefined;
    return new Response(JSON.stringify({ result: { message_id: 42 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const service = new TelegramService();
    const messageId = await service.sendMessage({
      botToken: "token",
      chatId: "123",
      text: "<b>hello</b>",
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [] }
    });

    assert.equal(messageId, "42");
    assert.match(capturedUrl, /\/bottoken\/sendMessage$/);
    assert.equal(capturedMethod, "POST");
    assert.deepEqual(capturedBody, {
      chat_id: "123",
      text: "<b>hello</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
    assert.ok(capturedSignal instanceof AbortSignal);
    assert.equal(capturedSignal.aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telegram editMessageText posts message id and HTML parse mode with a finite abort signal", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody: Record<string, unknown> = {};
  let capturedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedMethod = init?.method ?? "";
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    capturedSignal = init?.signal as AbortSignal | null | undefined;
    return new Response(JSON.stringify({ result: { message_id: 99 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const service = new TelegramService();
    await service.editMessageText({
      botToken: "token",
      chatId: "123",
      messageId: 99,
      text: "<b>done</b>",
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [[{ text: "back", callback_data: "p:r" }]] }
    });

    assert.match(capturedUrl, /\/bottoken\/editMessageText$/);
    assert.equal(capturedMethod, "POST");
    assert.deepEqual(capturedBody, {
      chat_id: "123",
      message_id: 99,
      text: "<b>done</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "back", callback_data: "p:r" }]] }
    });
    assert.ok(capturedSignal instanceof AbortSignal);
    assert.equal(capturedSignal.aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telegram editMessageText rejects non-positive and unsafe message ids", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch;

  try {
    const service = new TelegramService();
    for (const messageId of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        service.editMessageText({ botToken: "token", chatId: "123", messageId, text: "invalid" }),
        /Telegram edit config is incomplete/
      );
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telegram HTTP errors expose copy_text classification without leaking sensitive values", async () => {
  const originalFetch = globalThis.fetch;
  const description = "Bad Request: BUTTON_TYPE_INVALID for copy_text";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error_code: 400, description }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  try {
    const service = new TelegramService();
    await assert.rejects(
      service.sendMessage({ botToken: "secret-token", chatId: "123", text: "hello" }),
      (error: unknown) => {
        assert.ok(error instanceof TelegramApiError);
        assert.equal(error.status, 400);
        assert.equal(error.telegramErrorCode, 400);
        assert.equal(error.description, description);
        assert.equal(error.method, "sendMessage");
        assert.doesNotMatch(error.message, /secret-token|copy_text|BUTTON_TYPE_INVALID/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telegram HTTP 200 with ok false throws a classified API error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  try {
    const service = new TelegramService();
    await assert.rejects(
      service.sendMessage({ botToken: "token", chatId: "123", text: "hello" }),
      (error: unknown) => {
        assert.ok(error instanceof TelegramApiError);
        assert.equal(error.status, 200);
        assert.equal(error.telegramErrorCode, 400);
        assert.equal(error.description, "Bad Request: chat not found");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telegram network timeouts remain transport errors rather than API 400 errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new DOMException("The operation timed out", "TimeoutError");
  }) as typeof fetch;

  try {
    const service = new TelegramService();
    await assert.rejects(
      service.sendMessage({ botToken: "token", chatId: "123", text: "hello" }),
      (error: unknown) => {
        assert.ok(error instanceof DOMException);
        assert.equal(error.name, "TimeoutError");
        assert.equal(error instanceof TelegramApiError, false);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
