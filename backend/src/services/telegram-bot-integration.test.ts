import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AccountStatus, MessageDirection, MessageType } from "@prisma/client";
import * as botModule from "./telegram-bot.js";

type BotModule = typeof botModule & Record<string, unknown>;

const bot = botModule as BotModule;
const source = readFileSync(new URL("./telegram-bot.ts", import.meta.url), "utf8");

test("telegram panel stats exclude system messages and count purchased phones", async () => {
  const load = bot.loadTelegramPanelStats;
  assert.equal(typeof load, "function");
  if (typeof load !== "function") return;

  const calls: Array<{ model: string; args: unknown }> = [];
  const values = [9, 7, 6, 5, 29, 3];
  const db = {
    dtAccount: {
      count: async (args?: unknown) => {
        calls.push({ model: "dtAccount", args });
        return values[calls.length - 1];
      }
    },
    phoneNumber: {
      count: async (args?: unknown) => {
        calls.push({ model: "phoneNumber", args });
        return values[calls.length - 1];
      }
    },
    message: {
      count: async (args?: unknown) => {
        calls.push({ model: "message", args });
        return values[calls.length - 1];
      }
    }
  };

  const result = await (load as (db: unknown) => Promise<unknown>)(db);
  assert.deepEqual(result, {
    accountCount: 9,
    onlineCount: 7,
    monitorCount: 6,
    telegramCount: 5,
    phoneCount: 29,
    unreadCount: 3
  });
  assert.deepEqual(calls, [
    { model: "dtAccount", args: undefined },
    { model: "dtAccount", args: { where: { status: AccountStatus.online } } },
    { model: "dtAccount", args: { where: { monitorEnabled: true } } },
    { model: "dtAccount", args: { where: { telegramNotify: true } } },
    { model: "phoneNumber", args: undefined },
    {
      model: "message",
      args: {
        where: {
          direction: MessageDirection.incoming,
          msgType: { not: MessageType.system },
          isRead: false
        }
      }
    }
  ]);
});

test("telegram account pages use safe projections and fixed page sizes", async () => {
  const loadAccounts = bot.loadTelegramAccountPage;
  const loadPhoneAccounts = bot.loadTelegramPhoneAccountPage;
  assert.equal(typeof loadAccounts, "function");
  assert.equal(typeof loadPhoneAccounts, "function");
  if (typeof loadAccounts !== "function" || typeof loadPhoneAccounts !== "function") return;

  const accountCalls: unknown[] = [];
  const phoneAccountCalls: unknown[] = [];
  const accountRows = [{ id: 9, nickname: "A", email: null, phone: null, dtUserId: "9", status: AccountStatus.online, _count: { phoneNumbers: 2 } }];
  const db = {
    dtAccount: {
      count: async (args?: unknown) => {
        const target = args && JSON.stringify(args).includes("phoneNumbers") ? phoneAccountCalls : accountCalls;
        target.push({ method: "count", args });
        return 17;
      },
      findMany: async (args: unknown) => {
        const target = JSON.stringify(args).includes("phoneNumbers\":{\"some") ? phoneAccountCalls : accountCalls;
        target.push({ method: "findMany", args });
        return accountRows;
      }
    }
  };

  const accounts = await (loadAccounts as (page: number, db: unknown) => Promise<unknown>)(2, db);
  const phoneAccounts = await (loadPhoneAccounts as (page: number, db: unknown) => Promise<unknown>)(2, db);
  assert.deepEqual(accounts, { items: accountRows, page: 2, totalPages: 3 });
  assert.deepEqual(phoneAccounts, { items: accountRows, page: 2, totalPages: 3 });

  const accountQuery = (accountCalls[1] as { args: Record<string, unknown> }).args;
  assert.deepEqual(accountQuery.orderBy, [{ sortOrder: "asc" }, { id: "asc" }]);
  assert.equal(accountQuery.skip, 8);
  assert.equal(accountQuery.take, 8);
  assertNoSensitiveAccountSelection(accountQuery.select);

  const phoneWhere = { phoneNumbers: { some: {} } };
  assert.deepEqual((phoneAccountCalls[0] as { args: unknown }).args, { where: phoneWhere });
  const phoneAccountQuery = (phoneAccountCalls[1] as { args: Record<string, unknown> }).args;
  assert.deepEqual(phoneAccountQuery.where, phoneWhere);
  assert.equal(phoneAccountQuery.skip, 8);
  assert.equal(phoneAccountQuery.take, 8);
  assertNoSensitiveAccountSelection(phoneAccountQuery.select);
});

test("telegram phone pages and recent messages use deterministic safe queries", async () => {
  const loadPhones = bot.loadTelegramAccountPhonePage;
  const loadMessages = bot.loadTelegramRecentMessages;
  assert.equal(typeof loadPhones, "function");
  assert.equal(typeof loadMessages, "function");
  if (typeof loadPhones !== "function" || typeof loadMessages !== "function") return;

  const phoneCalls: unknown[] = [];
  const messageCalls: unknown[] = [];
  const db = {
    phoneNumber: {
      count: async (args: unknown) => {
        phoneCalls.push({ method: "count", args });
        return 7;
      },
      findMany: async (args: unknown) => {
        phoneCalls.push({ method: "findMany", args });
        return [];
      }
    },
    message: {
      findMany: async (args: unknown) => {
        messageCalls.push(args);
        return [];
      }
    }
  };

  assert.deepEqual(await (loadPhones as (id: number, page: number, db: unknown) => Promise<unknown>)(433, 2, db), {
    items: [],
    page: 2,
    totalPages: 2
  });
  const phoneQuery = (phoneCalls[1] as { args: Record<string, unknown> }).args;
  assert.deepEqual(phoneQuery.where, { accountId: 433 });
  assert.deepEqual(phoneQuery.orderBy, [{ isPrimary: "desc" }, { createdAt: "desc" }, { id: "desc" }]);
  assert.equal(phoneQuery.skip, 6);
  assert.equal(phoneQuery.take, 6);
  assert.deepEqual(phoneQuery.select, { id: true, phoneNumber: true, status: true });

  await (loadMessages as (accountId: number | undefined, limit: number, db: unknown) => Promise<unknown>)(undefined, 5, db);
  assert.deepEqual(messageCalls[0], {
    where: {
      direction: MessageDirection.incoming,
      msgType: { not: MessageType.system }
    },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: 5,
    select: {
      id: true,
      accountId: true,
      fromNumber: true,
      toNumber: true,
      content: true,
      receivedAt: true,
      account: {
        select: { id: true, nickname: true, email: true, phone: true, dtUserId: true }
      }
    }
  });
});

test("telegram integration edits callbacks, rejects invalid data, and preserves command-only danger", () => {
  assert.match(source, /parseTelegramCallback\(callback\.data\)/);
  assert.match(source, /replyToCallback/);
  assert.match(source, /editMessageText/);
  assert.match(source, /catch \(error\)[\s\S]*this\.reply\(/);
  assert.match(source, /if \(!parsed\)[\s\S]*rootPanelReply/);
  assert.match(source, /callback\.action === "status"[\s\S]*statusPanelReply/);
  assert.doesNotMatch(source, /panelMarkup|accountsMarkup|accountActionMarkup|parsePanelCallback/);
  for (const command of [
    "/accounts", "/phones", "/messages", "/start_monitor", "/stop_monitor", "/notify",
    "/buy_number", "/renew_phone", "/pause_phone", "/resume_phone", "/cancel_phone", "/trace_access_code"
  ]) {
    assert.match(source, new RegExp(command.replace("/", "\\/")));
  }
  assert.doesNotMatch(source, /callback_data:[^\n]*(buy|renew|pause|resume|cancel)/i);
});

test("telegram error text redacts credentials before rendering", () => {
  const sanitize = bot.sanitizeTelegramError;
  assert.equal(typeof sanitize, "function");
  if (typeof sanitize !== "function") return;
  const text = (sanitize as (value: unknown) => string)(
    'request failed token=secret-token password:secret-password {"dt_token":"json-token"} ' +
      'deviceId=device-secret dtDeviceId:dt-device-secret IMEI=imei-secret MAC=aa:bb:cc:dd:ee:ff ' +
      'serial=serial-secret dt_track_code=track-secret local_ip=10.0.0.8 wifi={"ssid":"private-wifi"} ' +
      'Authorization: Bearer bearer-token {"authorization":"Bearer json-bearer"}'
  );
  assert.doesNotMatch(
    text,
    /secret-token|secret-password|json-token|device-secret|dt-device-secret|imei-secret|aa:bb:cc:dd:ee:ff|serial-secret|track-secret|10\.0\.0\.8|private-wifi|bearer-token|json-bearer/
  );
  assert.match(text, /\[redacted\]/);
});

test("telegram user failures are fixed and every error log callsite sanitizes values", () => {
  const safeFailure = bot.telegramSafeFailureText;
  assert.equal(typeof safeFailure, "function");
  if (typeof safeFailure === "function") {
    assert.equal(
      (safeFailure as (error?: unknown) => string)(new Error("deviceId=device-secret token=secret-token")),
      "操作失败，请查看后端日志。"
    );
  }
  assert.doesNotMatch(source, /error:\s*errorMessage\(error\)/);
  assert.doesNotMatch(source, /error:\s*error instanceof Error/);
  assert.doesNotMatch(source, /操作失败[：:]\$\{/);
  assert.match(source, /handleTelegramCallbackSafe[\s\S]*telegramUserErrorText\(error\)/);
  assert.match(source, /withTelegramCommandError[\s\S]*telegramUserErrorText\(error\)/);
});

test("telegram business errors map to safe actionable Chinese without exposing originals", () => {
  const map = bot.telegramUserErrorText;
  assert.equal(typeof map, "function");
  if (typeof map !== "function") return;
  const userText = map as (error: unknown) => string;
  assert.equal(userText(new Error("账户不存在")), "账户不存在，请刷新列表后重试。");
  assert.equal(userText(new Error("号码不存在")), "号码不存在，请刷新号码列表后重试。");
  assert.equal(userText(new Error("账户 direct 会话不完整")), "账户会话缺失，请重新登录后重试。");
  assert.equal(userText(new Error("401 unauthorized: token invalid")), "登录已失效，请重新登录账户。");
  assert.equal(userText(new Error("invalid parameter format")), "参数错误，请检查命令格式。");
  assert.equal(userText(new Error("missing confirm")), "缺少确认参数，请按提示添加 confirm。");
  assert.equal(userText(Object.assign(new Error("request timed out"), { name: "TimeoutError" })), "操作超时，请稍后重试。");
  assert.equal(userText(new Error("deviceId=device-secret token=secret-token unexpected")), "操作失败，请查看后端日志。");
});

test("unauthorized callbacks are acknowledged but never execute their operation", async () => {
  const run = bot.runAuthorizedTelegramCallback;
  assert.equal(typeof run, "function");
  if (typeof run !== "function") return;
  const answers: unknown[] = [];
  let executed = 0;
  const allowed = await (run as (...args: unknown[]) => Promise<boolean>)(
    {
      allowedChatIds: "100",
      chatId: "200",
      userId: "201",
      botToken: "bot-token",
      callbackQueryId: "callback-1",
      apiBaseUrl: null
    },
    async () => {
      executed += 1;
    },
    {
      answerCallbackQuery: async (input: unknown) => {
        answers.push(input);
      }
    }
  );
  assert.equal(allowed, false);
  assert.equal(executed, 0);
  assert.deepEqual(answers, [{ botToken: "bot-token", callbackQueryId: "callback-1", text: "未授权", apiBaseUrl: null }]);
});

test("callback delivery edits first and sends exactly once when editing fails", async () => {
  const deliver = bot.deliverTelegramCallbackReply;
  assert.equal(typeof deliver, "function");
  if (typeof deliver !== "function") return;
  const calls: Array<{ method: string; input: unknown }> = [];
  const result = await (deliver as (...args: unknown[]) => Promise<string>)(
    {
      settings: { telegram_bot_token: "bot-token", telegram_api_base_url: "https://telegram.invalid" },
      chatId: "200",
      messageId: 91,
      reply: { text: "<b>safe</b>", replyMarkup: { inline_keyboard: [] }, parseMode: "HTML" }
    },
    {
      editMessageText: async (input: unknown) => {
        calls.push({ method: "edit", input });
        throw new Error("message cannot be edited");
      },
      sendMessage: async (input: unknown) => {
        calls.push({ method: "send", input });
        return "92";
      }
    }
  );
  assert.equal(result, "sent");
  assert.deepEqual(calls.map((item) => item.method), ["edit", "send"]);
});

test("explicit account callback target states are idempotent and render after mutation", async () => {
  const apply = bot.applyTelegramAccountTargetState;
  assert.equal(typeof apply, "function");
  if (typeof apply !== "function") return;
  const state = { monitorEnabled: true, telegramNotify: false };
  const writes: Array<[string, boolean]> = [];
  const renders: Array<{ monitorEnabled: boolean; telegramNotify: boolean }> = [];
  const deps = {
    loadAccount: async () => ({ ...state }),
    setMonitor: async (_accountId: number, enabled: boolean) => {
      writes.push(["monitor", enabled]);
      state.monitorEnabled = enabled;
    },
    setNotify: async (_accountId: number, enabled: boolean) => {
      writes.push(["notify", enabled]);
      state.telegramNotify = enabled;
    },
    renderAccount: async () => {
      renders.push({ ...state });
      return { text: JSON.stringify(state), parseMode: "HTML" as const };
    }
  };
  const invoke = apply as (...args: unknown[]) => Promise<unknown>;
  await invoke({ accountId: 433, action: "monitor_on" }, deps);
  await invoke({ accountId: 433, action: "monitor_off" }, deps);
  await invoke({ accountId: 433, action: "monitor_off" }, deps);
  await invoke({ accountId: 433, action: "notify_on" }, deps);
  await invoke({ accountId: 433, action: "notify_on" }, deps);
  assert.deepEqual(writes, [["monitor", false], ["notify", true]]);
  assert.equal(renders.length, 5);
  assert.deepEqual(renders.at(-1), { monitorEnabled: false, telegramNotify: true });
});

test("phone note callback returns a copyable set-phone-note command template", async () => {
  const handle = bot.handleTelegramCallback;
  assert.equal(typeof handle, "function");
  if (typeof handle !== "function") return;
  const reply = await (handle as (callback: unknown) => Promise<{ text: string }>)(
    { scope: "phone", action: "note", accountId: 433, phoneId: 91 }
  );
  assert.match(reply.text, /<code>\/set_phone_note 433 91 新备注<\/code>/);
  assert.doesNotMatch(reply.text, /号码详情/);
});

test("telegram bot removes obsolete panel status and button truncation helpers", () => {
  assert.doesNotMatch(source, /function panelStatusText\(/);
  assert.doesNotMatch(source, /function truncateButtonText\(/);
});

function assertNoSensitiveAccountSelection(value: unknown) {
  const select = value as Record<string, unknown>;
  assert.equal(select.password, undefined);
  assert.equal(select.dtToken, undefined);
  assert.equal(select.dtDeviceId, undefined);
  assert.equal(select.dtTrackCode, undefined);
  assert.equal(select.snapshot, undefined);
}
