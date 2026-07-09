import assert from "node:assert/strict";
import test from "node:test";
import { TelegramService } from "./telegram.js";

test("telegram API calls use a finite abort signal", async () => {
  const originalFetch = globalThis.fetch;
  let capturedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedSignal = init?.signal as AbortSignal | null | undefined;
    return new Response(JSON.stringify({ result: { message_id: 42 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const service = new TelegramService();
    const messageId = await service.sendMessage({ botToken: "token", chatId: "123", text: "hello" });

    assert.equal(messageId, "42");
    assert.ok(capturedSignal instanceof AbortSignal);
    assert.equal(capturedSignal.aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});