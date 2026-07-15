import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as notifierModule from "./telegram-notifier.js";
import * as telegramModule from "./telegram.js";

const notifier = notifierModule as typeof notifierModule & Record<string, unknown>;
const source = readFileSync(new URL("./telegram-notifier.ts", import.meta.url), "utf8");
const regressionSource = readFileSync(new URL("../scripts/verify-direct-regression.ts", import.meta.url), "utf8");

const account = {
  id: 433,
  nickname: "VMOS & <Test>",
  email: null,
  phone: null,
  dtUserId: "123",
  telegramNotify: true
};

test("SMS notification is escaped HTML with target and verification code", () => {
  const build = notifier.buildSmsTelegramNotificationText;
  assert.equal(typeof build, "function");
  if (typeof build !== "function") return;
  const text = (build as (input: unknown) => string)({
    account,
    fromNumber: "OPEN&AI",
    toNumber: "<3197005033038>",
    content: "<code> 748402 & more",
    receivedAt: new Date("2026-07-15T00:00:00Z")
  });
  assert.match(text, /<b>.*验证码短信<\/b>/);
  assert.match(text, /VMOS &amp; &lt;Test&gt;/);
  assert.match(text, /<code>&lt;3197005033038&gt;<\/code>/);
  assert.match(text, /OPEN&amp;AI/);
  assert.match(text, /<code>748402<\/code>/);
  assert.match(text, /&lt;code&gt; 748402 &amp; more/);
  assert.doesNotMatch(text, /<code> 748402/);
});

test("SMS notification never substitutes the account phone when the target is missing", () => {
  const text = notifierModule.buildSmsTelegramNotificationText({
    account: { ...account, phone: "+15550001111" },
    fromNumber: "OPENAI",
    toNumber: null,
    content: "code 748402",
    receivedAt: new Date("2026-07-15T00:00:00Z")
  });
  assert.match(text, /目标号码：<code>-<\/code>/);
  assert.doesNotMatch(text, /15550001111/);
});

test("phone notification keeps verification fields without leaking raw JSON", () => {
  const text = notifierModule.buildPhoneTelegramNotificationText({
    account,
    phone: {
      phoneNumber: "33700000000",
      status: "active",
      countryCode: 33,
      rawJson: JSON.stringify({ price: 250, packageServiceId: "DT03009", token: "SECRET_TOKEN", password: "SECRET_PASSWORD" })
    },
    action: "purchase",
    verificationSource: "remote_phone_list",
    verificationNote: "confirmed <remote> & safe"
  });
  assert.match(text, /<b>.*获取新号码<\/b>/);
  assert.match(text, /<code>33700000000<\/code>/);
  assert.match(text, /remote_phone_list/);
  assert.match(text, /confirmed &lt;remote&gt; &amp; safe/);
  assert.doesNotMatch(text, /SECRET_TOKEN|SECRET_PASSWORD|rawJson|raw_json/);
});

test("copy-code markup stays isolated from HTML and within Telegram limits", () => {
  const build = notifier.buildCopyCodeReplyMarkup;
  assert.equal(typeof build, "function");
  if (typeof build !== "function") return;
  assert.deepEqual((build as (code: string) => unknown)("748402"), {
    inline_keyboard: [[{ text: "复制验证码 748402", copy_text: { text: "748402" } }]]
  });
});

test("notification sender uses escaped HTML and the classified fallback helper", () => {
  assert.match(source, /parseMode:\s*"HTML"/);
  assert.match(source, /sendTelegramNotificationWithMarkupFallback/);
  assert.match(source, /escapeTelegramHtml/);
});

test("notification markup fallback retries only a classified unsupported copy-text Telegram 400", async () => {
  const send = notifier.sendTelegramNotificationWithMarkupFallback;
  const TelegramApiError = (telegramModule as typeof telegramModule & Record<string, unknown>).TelegramApiError;
  assert.equal(typeof send, "function");
  assert.equal(typeof TelegramApiError, "function");
  if (typeof send !== "function" || typeof TelegramApiError !== "function") return;

  const apiError = (status: number, description: string, telegramErrorCode: number | null = null) =>
    Object.assign(Object.create((TelegramApiError as { prototype: object }).prototype), {
      status,
      description,
      telegramErrorCode,
      method: "sendMessage"
    });
  const payload = {
    botToken: "bot-token",
    chatId: "200",
    text: "safe",
    replyMarkup: { inline_keyboard: [[{ text: "copy", copy_text: { text: "748402" } }]] },
    parseMode: "HTML" as const
  };

  const run = async (error: unknown) => {
    const calls: unknown[] = [];
    const service = {
      sendMessage: async (input: unknown) => {
        calls.push(input);
        if (calls.length === 1) throw error;
        return "2";
      }
    };
    let thrown: unknown;
    try {
      await (send as (...args: unknown[]) => Promise<string>)(payload, service);
    } catch (next) {
      thrown = next;
    }
    return { calls, thrown };
  };

  for (const error of [
    apiError(400, "Bad Request: BUTTON_TYPE_INVALID copy_text is unsupported", 400),
    apiError(200, "Bad Request: copy_text button type is unsupported", 400),
    apiError(400, "Bad Request: button type is not supported", 400)
  ]) {
    const unsupported = await run(error);
    assert.equal(unsupported.thrown, undefined);
    assert.equal(unsupported.calls.length, 2);
    assert.equal((unsupported.calls[1] as { replyMarkup?: unknown }).replyMarkup, undefined);
  }

  for (const error of [
    new Error("network failed"),
    apiError(400, "Bad Request: chat not found"),
    apiError(401, "Unauthorized"),
    apiError(500, "Internal Server Error")
  ]) {
    const result = await run(error);
    assert.equal(result.calls.length, 1);
    assert.equal(result.thrown, error);
  }
});

test("static phone notification regression accepts only the current Chinese HTML output", () => {
  assert.match(regressionSource, /ok:\s*currentNotificationCopyOk,/);
  assert.doesNotMatch(regressionSource, /ok:\s*currentNotificationCopyOk\s*\|\|/);
  assert.doesNotMatch(regressionSource, /鏂版墜鏈哄彿|鎵嬫満鍙凤細|鍙风爜鐘舵€?/);
});
