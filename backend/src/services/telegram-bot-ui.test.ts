import assert from "node:assert/strict";
import test from "node:test";
import { parseTelegramCallback, type TelegramPanelCallback } from "./telegram-bot-callbacks.js";
import {
  accountActionKeyboard,
  accountListKeyboard,
  escapeTelegramHtml,
  formatAccountCard,
  formatAccountListCard,
  formatCommandHelp,
  formatPanelStatusCard,
  formatPhoneAccountListCard,
  formatPhoneCard,
  formatPhoneListCard,
  formatRecentMessagesCard,
  limitTelegramMessage,
  mainPanelKeyboard,
  phoneAccountKeyboard,
  phoneDetailKeyboard,
  phoneListKeyboard,
  type TelegramInlineKeyboardMarkup
} from "./telegram-bot-ui.js";

test("telegram HTML formatters escape every dynamic text field", () => {
  assert.equal(escapeTelegramHtml('<b>A&B "C"</b>'), "&lt;b&gt;A&amp;B &quot;C&quot;&lt;/b&gt;");

  const panel = formatPanelStatusCard({
    accountCount: 9,
    onlineCount: 7,
    monitorCount: 6,
    telegramCount: 5,
    phoneCount: 29,
    unreadCount: 3
  });
  assert.match(panel, /账户：9（在线 7）/);
  assert.match(panel, /已购手机号：29/);

  const accountList = formatAccountListCard(
    [{ id: 1, name: "<admin>", status: "on&line", phoneCount: 2 }],
    1,
    3
  );
  assert.match(accountList, /&lt;admin&gt;/);
  assert.match(accountList, /on&amp;line/);

  const phoneAccounts = formatPhoneAccountListCard([{ id: 1, name: "A&B", phoneCount: 2 }], 2, 3);
  assert.match(phoneAccounts, /A&amp;B/);

  const account = formatAccountCard({
    id: 1,
    name: "<admin>",
    appVariant: "ding&tone",
    status: "on<line",
    monitorEnabled: true,
    telegramNotify: false,
    phoneCount: 2,
    unreadCount: 1,
    lastError: 'bad "token" & <trace>'
  });
  assert.match(account, /&lt;admin&gt;/);
  assert.match(account, /ding&amp;tone/);
  assert.match(account, /on&lt;line/);
  assert.match(account, /bad &quot;token&quot; &amp; &lt;trace&gt;/);

  const phoneList = formatPhoneListCard(
    "A&B",
    [{ phoneNumber: "<3197>", status: "active&ready" }],
    1,
    1
  );
  assert.match(phoneList, /A&amp;B/);
  assert.match(phoneList, /<code>&lt;3197&gt;<\/code>/);
  assert.match(phoneList, /active&amp;ready/);
});

test("telegram phone and recent-message cards keep required fields safely formatted", () => {
  const phone = formatPhoneCard({
    accountId: 433,
    id: 91,
    phoneNumber: "3197&005",
    displayName: "NL <main>",
    status: "active&ready",
    countryCode: 31,
    providerId: 2006,
    expiredTime: "2027<01",
    autoRenew: true,
    allowReceiveSms: true
  });
  assert.match(phone, /<code>3197&amp;005<\/code>/);
  assert.match(phone, /NL &lt;main&gt;/);
  assert.match(phone, /active&amp;ready/);
  assert.match(phone, /2027&lt;01/);
  assert.match(phone, /<code>\/set_phone_note 433 91 新备注<\/code>/);

  const messages = formatRecentMessagesCard([
    {
      accountName: "VMOS & Test",
      toNumber: "<3197>",
      fromNumber: "OPEN&AI",
      content: "<code> 123456 & more",
      receivedAt: new Date("2026-07-15T00:00:00Z")
    }
  ]);
  assert.match(messages, /VMOS &amp; Test/);
  assert.match(messages, /目标：<code>&lt;3197&gt;<\/code>/);
  assert.match(messages, /发送方：OPEN&amp;AI/);
  assert.match(messages, /内容：&lt;code&gt; 123456 &amp; more/);
  assert.match(messages, /2026-07-15T00:00:00\.000Z/);
});

test("telegram command help classifies read-only and confirmed dangerous commands", () => {
  const help = formatCommandHelp();
  const viewGroup = help.match(/<b>查看类<\/b>\n([\s\S]*?)\n\n<b>安全操作<\/b>/)?.[1] ?? "";
  const dangerousGroup = help.match(/<b>高级危险操作<\/b>\n([\s\S]*?)\n以上危险操作/)?.[1] ?? "";

  for (const command of ["/panel", "/accounts", "/account", "/phones", "/messages", "/status", "/countries", "/preview_number"]) {
    assert.match(viewGroup, new RegExp(`<code>${command}<\\/code>`));
  }
  assert.match(help, /<b>安全操作<\/b>/);
  assert.match(help, /<code>\/set_phone_note<\/code>/);
  for (const command of ["/buy_number", "/renew_phone", "/pause_phone", "/resume_phone", "/cancel_phone", "/trace_access_code"]) {
    assert.match(dangerousGroup, new RegExp(`<code>${command}<\\/code>`));
  }
  assert.doesNotMatch(dangerousGroup, /\/countries|\/preview_number/);
  assert.match(help, /以上危险操作必须按命令说明提供 <code>confirm<\/code>/);
});

test("telegram message limiting closes formatting tags and keeps entities whole", () => {
  const input = `<b>${"A".repeat(24)}&quot;<code>${"B".repeat(48)}&amp;tail</code></b>`;
  const limited = limitTelegramMessage(input, 64);

  assert.ok(limited.length <= 64, limited);
  assert.match(limited, /…内容已截断$/);
  assertBalancedTelegramHtml(limited);
  assert.doesNotMatch(limited.replace(/\n…内容已截断$/, ""), /&[^;\s<]*$/);
  assert.equal(limitTelegramMessage("<b>short</b>", 64), "<b>short</b>");
});

test("telegram keyboards encode all navigation and safe account actions", () => {
  const main = mainPanelKeyboard();
  const accounts = accountListKeyboard([{ id: 433, name: "Account" }], 2, 3);
  const phoneAccounts = phoneAccountKeyboard([{ id: 433, name: "Account", phoneCount: 4 }], 2, 3);
  const accountActions = accountActionKeyboard({ id: 433, monitorEnabled: true, telegramNotify: false });
  const inverseAccountActions = accountActionKeyboard({ id: 433, monitorEnabled: false, telegramNotify: true });
  const phones = phoneListKeyboard(433, [{ id: 91, phoneNumber: "3197005" }], 2, 3);
  const phoneDetail = phoneDetailKeyboard(433, 91);
  const singlePage = accountListKeyboard([], 1, 1);
  const keyboards = [main, accounts, phoneAccounts, accountActions, inverseAccountActions, phones, phoneDetail, singlePage];

  const serialized = JSON.stringify(keyboards);
  assert.match(serialized, /账户管理/);
  assert.match(serialized, /手机号管理/);
  assert.doesNotMatch(serialized, /购号|续费|暂停|恢复|取消|buy|renew|pause|resume|cancel/i);
  for (const keyboard of keyboards) {
    for (const button of buttons(keyboard)) {
      assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
      assert.notEqual(parseTelegramCallback(button.callback_data), null, button.callback_data);
    }
  }

  assertCallbacks(accounts, [
    { scope: "account", action: "detail", accountId: 433 },
    { scope: "panel", action: "accounts", page: 1 },
    { scope: "panel", action: "accounts", page: 3 },
    { scope: "panel", action: "root" }
  ]);
  assertCallbacks(phoneAccounts, [
    { scope: "account", action: "phones", accountId: 433, page: 1 },
    { scope: "panel", action: "phones", page: 1 },
    { scope: "panel", action: "phones", page: 3 },
    { scope: "panel", action: "root" }
  ]);
  assertCallbacks(accountActions, [
    { scope: "account", action: "phones", accountId: 433, page: 1 },
    { scope: "account", action: "messages", accountId: 433 },
    { scope: "account", action: "refresh", accountId: 433 },
    { scope: "account", action: "refresh_phones", accountId: 433 },
    { scope: "account", action: "monitor_off", accountId: 433 },
    { scope: "account", action: "notify_on", accountId: 433 },
    { scope: "panel", action: "accounts", page: 1 }
  ]);
  assertCallbacks(inverseAccountActions, [
    { scope: "account", action: "phones", accountId: 433, page: 1 },
    { scope: "account", action: "messages", accountId: 433 },
    { scope: "account", action: "refresh", accountId: 433 },
    { scope: "account", action: "refresh_phones", accountId: 433 },
    { scope: "account", action: "monitor_on", accountId: 433 },
    { scope: "account", action: "notify_off", accountId: 433 },
    { scope: "panel", action: "accounts", page: 1 }
  ]);
  assertCallbacks(phones, [
    { scope: "phone", action: "detail", accountId: 433, phoneId: 91 },
    { scope: "account", action: "phones", accountId: 433, page: 1 },
    { scope: "account", action: "phones", accountId: 433, page: 3 },
    { scope: "panel", action: "phones", page: 1 }
  ]);
  assertCallbacks(phoneDetail, [
    { scope: "phone", action: "note", accountId: 433, phoneId: 91 },
    { scope: "account", action: "phones", accountId: 433, page: 1 }
  ]);
  assertCallbacks(singlePage, [{ scope: "panel", action: "root" }]);
  for (const keyboard of keyboards) {
    assert.ok(keyboard.inline_keyboard.every((row) => row.length > 0));
  }
});

function buttons(keyboard: TelegramInlineKeyboardMarkup) {
  return keyboard.inline_keyboard.flat();
}

function assertCallbacks(keyboard: TelegramInlineKeyboardMarkup, expected: TelegramPanelCallback[]) {
  assert.deepEqual(buttons(keyboard).map((button) => parseTelegramCallback(button.callback_data)), expected);
}

function assertBalancedTelegramHtml(value: string) {
  const stack: string[] = [];
  const tokens = value.match(/<\/?(?:b|code)>|&(?:amp|lt|gt|quot);/g) ?? [];
  for (const token of tokens) {
    if (token === "<b>" || token === "<code>") {
      stack.push(token.slice(1, -1));
      continue;
    }
    if (token === "</b>" || token === "</code>") {
      assert.equal(stack.pop(), token.slice(2, -1), value);
    }
  }
  assert.deepEqual(stack, [], value);
}
