import { encodeTelegramCallback } from "./telegram-bot-callbacks.js";

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

const TELEGRAM_TRUNCATION_SUFFIX = "\n…内容已截断";

export function chunkAdaptiveButtons(
  buttons: TelegramInlineKeyboardButton[],
  maxCharsPerRow = 24,
  maxCols = 2
): TelegramInlineKeyboardButton[][] {
  const rows: TelegramInlineKeyboardButton[][] = [];
  let currentRow: TelegramInlineKeyboardButton[] = [];
  let currentChars = 0;

  for (const btn of buttons) {
    const btnLength = Array.from(btn.text).length;
    if (currentRow.length > 0 && (currentChars + btnLength > maxCharsPerRow || currentRow.length >= maxCols)) {
      rows.push(currentRow);
      currentRow = [];
      currentChars = 0;
    }
    currentRow.push(btn);
    currentChars += btnLength;
  }
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }
  return rows;
}

export function formatPhoneExpiryDisplay(value: string | null | undefined): string {
  if (!value) return "未知";
  const num = Number(value);
  let date: Date;
  if (Number.isFinite(num) && num > 0) {
    date = new Date(num > 1_000_000_000_000 ? num : num * 1000);
  } else {
    date = new Date(value);
  }
  if (Number.isNaN(date.getTime())) return String(value);

  const now = Date.now();
  const diffMs = date.getTime() - now;
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  const formatted = date.toISOString().replace("T", " ").slice(0, 16);

  if (diffMs <= 0) {
    return `${formatted} (❌ 已到期)`;
  }
  if (diffDays <= 1) {
    const hours = Math.max(1, Math.ceil(diffMs / 3600000));
    return `${formatted} (🔴 剩余 ${hours} 小时，急需续期)`;
  }
  if (diffDays <= 3) {
    return `${formatted} (🟠 剩余 ${Math.ceil(diffDays)} 天，即将到期)`;
  }
  if (diffDays <= 7) {
    return `${formatted} (🟡 剩余 ${Math.ceil(diffDays)} 天，临期)`;
  }
  return `${formatted} (🟢 剩余 ${Math.floor(diffDays)} 天)`;
}


export function escapeTelegramHtml(value: unknown) {
  return String(value ?? "-")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatPanelStatusCard(input: {
  accountCount: number;
  onlineCount: number;
  monitorCount: number;
  telegramCount: number;
  phoneCount: number;
  unreadCount: number;
}) {
  return [
    "<b>🤖 dt-manager 控制面板</b>",
    "━━━━━━━━━━━━━━━━━━",
    `账户：${input.accountCount}（在线 ${input.onlineCount}）`,
    `监听中：${input.monitorCount}`,
    `Telegram 通知：${input.telegramCount}`,
    `已购手机号：${input.phoneCount}`,
    `未读短信：${input.unreadCount}`,
    "━━━━━━━━━━━━━━━━━━",
    "👇 请选择下方的安全操作面板："
  ].join("\n");
}

export function formatAccountListCard(
  accounts: Array<{ id: number; name: string; status: string; phoneCount: number }>,
  page: number,
  totalPages: number
) {
  return [
    `<b>👤 账户管理</b> · ${page}/${totalPages}`,
    ...accounts.map(
      (account) =>
        `#${account.id} ${escapeTelegramHtml(account.name)} · ${escapeTelegramHtml(account.status)} · ${account.phoneCount} 个号码`
    )
  ].join("\n");
}

export function formatPhoneAccountListCard(
  accounts: Array<{ id: number; name: string; phoneCount: number }>,
  page: number,
  totalPages: number
) {
  return [
    `<b>📱 手机号管理</b> · ${page}/${totalPages}`,
    ...accounts.map((account) => `#${account.id} ${escapeTelegramHtml(account.name)} · ${account.phoneCount} 个号码`)
  ].join("\n");
}

export function formatAccountCard(input: {
  id: number;
  name: string;
  appVariant: string;
  status: string;
  monitorEnabled: boolean;
  telegramNotify: boolean;
  phoneCount: number;
  unreadCount: number;
  lastError: string | null;
  balance?: number | null;
  currency?: string;
  phone?: string | null;
}) {
  const currency = input.currency ?? (input.appVariant === "dingdong" ? "说道币" : "叮咚币");
  const balanceText = input.balance !== undefined && input.balance !== null
    ? `${input.balance} ${currency}`
    : "暂未获取（可点击下方刷新资料）";

  return [
    `<b>👤 ${escapeTelegramHtml(input.name)}</b>`,
    "━━━━━━━━━━━━━━━━━━",
    `🆔 面板账户：<code>#${input.id}</code>`,
    `📱 绑定手机：<code>${escapeTelegramHtml(input.phone ?? "-")}</code>`,
    `📦 应用：${escapeTelegramHtml(input.appVariant)}`,
    `💰 账户余额：<b>${escapeTelegramHtml(balanceText)}</b>`,
    `⚡ 状态：${escapeTelegramHtml(input.status)}`,
    `📡 监听：${input.monitorEnabled ? "✅ 已开启" : "⏸ 已停止"}`,
    `🔔 Telegram：${input.telegramNotify ? "✅ 已开启" : "🔕 已关闭"}`,
    `📞 手机号：${input.phoneCount} 个`,
    `💬 未读短信：${input.unreadCount} 条`,
    `⚠️ 最近错误：${escapeTelegramHtml(input.lastError ?? "-")}`,
    "━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

export function formatPhoneListCard(
  accountName: string,
  phones: Array<{ phoneNumber: string; status: string }>,
  page: number,
  totalPages: number
) {
  return [
    `<b>📱 ${escapeTelegramHtml(accountName)}</b> · ${page}/${totalPages}`,
    ...phones.map(
      (phone) => `<code>${escapeTelegramHtml(phone.phoneNumber)}</code> · ${escapeTelegramHtml(phone.status)}`
    )
  ].join("\n");
}

export function formatPhoneCard(input: {
  accountId: number;
  accountName?: string;
  accountPhone?: string | null;
  balance?: number | null;
  currency?: string;
  id: number;
  phoneNumber: string;
  displayName: string | null;
  status: string;
  countryCode: number | null;
  providerId: number | null;
  expiredTime: string | null;
  autoRenew: boolean;
  allowReceiveSms: boolean | null;
}) {
  const currency = input.currency ?? "说道币/叮咚币";
  const balanceText = input.balance !== undefined && input.balance !== null
    ? `${input.balance} ${currency}`
    : "暂未获取";
  const expiryDisplay = formatPhoneExpiryDisplay(input.expiredTime);

  return [
    "<b>📱 手机号详情</b>",
    "━━━━━━━━━━━━━━━━━━",
    `📞 手机号码：<code>${escapeTelegramHtml(input.phoneNumber)}</code>`,
    `🏷️ 号码备注：${escapeTelegramHtml(input.displayName ?? "-")}`,
    `👤 所属账户：${escapeTelegramHtml(input.accountName ?? `#${input.accountId}`)} <code>#${input.accountId}</code>`,
    `📱 账户手机：<code>${escapeTelegramHtml(input.accountPhone ?? "-")}</code>`,
    `💰 账户余额：<b>${escapeTelegramHtml(balanceText)}</b>`,
    `⚡ 号码状态：${escapeTelegramHtml(input.status)}`,
    `⏳ 到期时间：${escapeTelegramHtml(input.expiredTime ?? "-")}`,
    `📊 到期状态：<b>${expiryDisplay}</b>`,
    `🌐 国家码：${input.countryCode ? `+${input.countryCode}` : "-"}`,
    `📶 Provider：${input.providerId ?? "-"}`,
    `🔄 自动续费：${input.autoRenew ? "✅ 是" : "❌ 否"}`,
    `📩 短信接收：${input.allowReceiveSms === null ? "未知" : input.allowReceiveSms ? "✅ 已开启" : "❌ 已关闭"}`,
    "━━━━━━━━━━━━━━━━━━",
    `修改备注：<code>/set_phone_note ${input.accountId} ${input.id} 新备注</code>`
  ].join("\n");
}

export function formatRecentMessagesCard(
  items: Array<{
    accountName: string;
    toNumber: string | null;
    fromNumber: string | null;
    content: string;
    receivedAt: Date;
  }>
) {
  if (items.length === 0) return "<b>💬 最近短信</b>\n暂无短信。";
  return [
    "<b>💬 最近短信</b>",
    ...items.flatMap((item, index) => [
      "",
      `<b>${index + 1}. ${escapeTelegramHtml(item.accountName)}</b>`,
      `目标：<code>${escapeTelegramHtml(item.toNumber ?? "-")}</code>`,
      `发送方：${escapeTelegramHtml(item.fromNumber ?? "-")}`,
      `内容：${escapeTelegramHtml(item.content)}`,
      `时间：${escapeTelegramHtml(item.receivedAt.toISOString())}`
    ])
  ].join("\n");
}

export function formatCommandHelp() {
  return [
    "<b>📖 命令帮助</b>",
    "",
    "<b>查看类</b>",
    "<code>/panel</code> <code>/accounts</code> <code>/account</code> <code>/phones</code> <code>/messages</code> <code>/status</code> <code>/countries</code> <code>/preview_number</code>",
    "",
    "<b>安全操作</b>",
    "<code>/start_monitor</code> <code>/stop_monitor</code> <code>/notify</code> <code>/login_code</code> <code>/set_note</code> <code>/clear_note</code> <code>/set_phone_note</code> <code>/clear_phone_note</code> <code>/refresh_account</code> <code>/refresh_phones</code> <code>/code</code>",
    "",
    "<b>高级危险操作</b>",
    "<code>/buy_number</code> <code>/renew_phone</code> <code>/pause_phone</code> <code>/resume_phone</code> <code>/cancel_phone</code> <code>/trace_access_code</code>",
    "以上危险操作必须按命令说明提供 <code>confirm</code>。"
  ].join("\n");
}

export function limitTelegramMessage(text: string, maxLength = 3900) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) {
    throw new RangeError("Telegram message limit must be a non-negative integer");
  }
  if (text.length <= maxLength) return text;
  if (maxLength <= TELEGRAM_TRUNCATION_SUFFIX.length) {
    return TELEGRAM_TRUNCATION_SUFFIX.slice(0, maxLength);
  }

  const openTags: Array<"b" | "code"> = [];
  let content = "";
  let index = 0;
  while (index < text.length) {
    const token = readTelegramHtmlToken(text, index);
    const nextTags = [...openTags];
    if (token.kind === "open" && token.tag) {
      nextTags.push(token.tag);
    } else if (token.kind === "close" && token.tag) {
      if (nextTags.at(-1) !== token.tag) {
        index = token.nextIndex;
        continue;
      }
      nextTags.pop();
    }
    const closingTags = closeTelegramTags(nextTags);
    if (content.length + token.value.length + closingTags.length + TELEGRAM_TRUNCATION_SUFFIX.length > maxLength) {
      break;
    }
    content += token.value;
    openTags.splice(0, openTags.length, ...nextTags);
    index = token.nextIndex;
  }

  content = content.replace(/&(?:#[xX]?[0-9A-Fa-f]*|[A-Za-z][A-Za-z0-9]*)?$/, "");
  return `${content}${closeTelegramTags(openTags)}${TELEGRAM_TRUNCATION_SUFFIX}`;
}

export function mainPanelKeyboard(): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        panelButton("👤 账户管理", "accounts", 1),
        panelButton("📱 手机号管理", "phones", 1)
      ],
      [
        panelButton("⚠️ 临期手机号", "expiring", 1),
        panelButton("💬 最近短信", "messages")
      ],
      [
        panelButton("📊 运行状态", "status"),
        panelButton("📖 命令帮助", "help")
      ]
    ]
  };
}

export function accountListKeyboard(
  accounts: Array<{ id: number; name: string }>,
  page: number,
  totalPages: number
): TelegramInlineKeyboardMarkup {
  const buttons = accounts.map((account) =>
    callbackButton(truncateButtonText(`#${account.id} ${account.name}`), {
      scope: "account",
      action: "detail",
      accountId: account.id
    })
  );
  const rows = chunkAdaptiveButtons(buttons, 24, 2);
  const pagination = panelPaginationRow("accounts", page, totalPages);
  if (pagination.length > 0) rows.push(pagination);
  rows.push([panelButton("⬅️ 返回主面板", "root")]);
  return { inline_keyboard: rows };
}

export function phoneAccountKeyboard(
  accounts: Array<{ id: number; name: string; phoneCount: number }>,
  page: number,
  totalPages: number
): TelegramInlineKeyboardMarkup {
  const buttons = accounts.map((account) =>
    callbackButton(truncateButtonText(`#${account.id} ${account.name} · ${account.phoneCount}号`), {
      scope: "account",
      action: "phones",
      accountId: account.id,
      page: 1
    })
  );
  const rows = chunkAdaptiveButtons(buttons, 24, 2);
  const pagination = panelPaginationRow("phones", page, totalPages);
  if (pagination.length > 0) rows.push(pagination);
  rows.push([panelButton("⬅️ 返回主面板", "root")]);
  return { inline_keyboard: rows };
}

export function accountActionKeyboard(account: {
  id: number;
  monitorEnabled: boolean;
  telegramNotify: boolean;
}): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        callbackButton("📱 查看号码", { scope: "account", action: "phones", accountId: account.id, page: 1 }),
        callbackButton("💬 最近短信", { scope: "account", action: "messages", accountId: account.id })
      ],
      [
        callbackButton("🔄 刷新资料", { scope: "account", action: "refresh", accountId: account.id }),
        callbackButton("🔄 刷新号码", { scope: "account", action: "refresh_phones", accountId: account.id })
      ],
      [
        callbackButton(account.monitorEnabled ? "⏹ 停止监听" : "▶️ 启动监听", {
          scope: "account",
          action: account.monitorEnabled ? "monitor_off" : "monitor_on",
          accountId: account.id
        }),
        callbackButton(account.telegramNotify ? "🔕 关闭通知" : "🔔 开启通知", {
          scope: "account",
          action: account.telegramNotify ? "notify_off" : "notify_on",
          accountId: account.id
        })
      ],
      [panelButton("⬅️ 返回账户", "accounts", 1)]
    ]
  };
}

export function accountRecoveryKeyboard(input: {
  accountId: number;
  canVerificationRelogin: boolean;
  canRestoreMonitor: boolean;
}): TelegramInlineKeyboardMarkup {
  const recoveryRow: TelegramInlineKeyboardButton[] = [];
  if (input.canVerificationRelogin) {
    recoveryRow.push(callbackButton("发送登录验证码", {
      scope: "account",
      action: "relogin_send_code",
      accountId: input.accountId
    }));
  }
  if (input.canRestoreMonitor) {
    recoveryRow.push(callbackButton("恢复监听", {
      scope: "account",
      action: "monitor_on",
      accountId: input.accountId
    }));
  }
  return {
    inline_keyboard: [
      ...(recoveryRow.length > 0 ? [recoveryRow] : []),
      [callbackButton("查看账户", { scope: "account", action: "detail", accountId: input.accountId })]
    ]
  };
}

export function phoneListKeyboard(
  accountId: number,
  phones: Array<{ id: number; phoneNumber: string }>,
  page: number,
  totalPages: number
): TelegramInlineKeyboardMarkup {
  const buttons = phones.map((phone) =>
    callbackButton(truncateButtonText(phone.phoneNumber), {
      scope: "phone",
      action: "detail",
      accountId,
      phoneId: phone.id
    })
  );
  const rows = chunkAdaptiveButtons(buttons, 26, 2);
  const pagination = accountPhonePaginationRow(accountId, page, totalPages);
  if (pagination.length > 0) rows.push(pagination);
  rows.push([panelButton("⬅️ 返回手机号账户", "phones", 1)]);
  return { inline_keyboard: rows };
}

export function phoneDetailKeyboard(accountId: number, phoneId: number): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [callbackButton("✏️ 修改备注命令", { scope: "phone", action: "note", accountId, phoneId })],
      [callbackButton("⬅️ 返回号码列表", { scope: "account", action: "phones", accountId, page: 1 })]
    ]
  };
}

export function phoneExpiryActionKeyboard(accountId: number, phoneId: number): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      callbackButton("续期号码", { scope: "phone", action: "renew_request", accountId, phoneId }),
      callbackButton("取消号码", { scope: "phone", action: "cancel_request", accountId, phoneId })
    ]]
  };
}

export function phoneActionConfirmationKeyboard(
  action: "renew" | "cancel",
  accountId: number,
  phoneId: number,
  version: string
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [callbackButton(action === "renew" ? "确认续期" : "确认取消", {
        scope: "phone",
        action: action === "renew" ? "renew_confirm" : "cancel_confirm",
        accountId,
        phoneId,
        version
      })],
      [callbackButton("返回号码详情", { scope: "phone", action: "detail", accountId, phoneId })]
    ]
  };
}


export function formatExpiringPhonesCard(
  phones: Array<{
    accountId: number;
    accountName: string;
    accountPhone: string | null;
    phoneNumber: string;
    expiredTime: string | null;
    daysRemainingText: string;
    balanceText: string;
  }>,
  page: number,
  totalPages: number
) {
  if (phones.length === 0) {
    return [
      "<b>⚠️ 临期手机号查询</b>",
      "━━━━━━━━━━━━━━━━━━",
      "🎉 当前暂无 7 天内即将到期的手机号，所有号码运行正常！",
      "━━━━━━━━━━━━━━━━━━"
    ].join("\n");
  }

  const lines = [
    `<b>⚠️ 临期手机号清单（7天内到期）</b> · 第 ${page}/${totalPages} 页`,
    "━━━━━━━━━━━━━━━━━━"
  ];

  for (const p of phones) {
    lines.push(
      `📞 <code>${escapeTelegramHtml(p.phoneNumber)}</code> · <b>${escapeTelegramHtml(p.daysRemainingText)}</b>`,
      `   👤 账户：${escapeTelegramHtml(p.accountName)} (<code>#${p.accountId}</code>)`,
      `   📱 账户手机：<code>${escapeTelegramHtml(p.accountPhone ?? "-")}</code>`,
      `   💰 账户余额：${escapeTelegramHtml(p.balanceText)}`,
      ""
    );
  }
  lines.push("👇 点击下方对应号码按钮，可查看详情、续期或取消号码：");
  return lines.join("\n");
}

export function expiringPhonesKeyboard(
  phones: Array<{ accountId: number; phoneId: number; phoneNumber: string; daysRemainingText: string }>,
  page: number,
  totalPages: number
): TelegramInlineKeyboardMarkup {
  const buttons = phones.map((phone) =>
    callbackButton(truncateButtonText(`${phone.phoneNumber} (${phone.daysRemainingText})`), {
      scope: "phone",
      action: "expiring_detail",
      accountId: phone.accountId,
      phoneId: phone.phoneId
    })
  );
  const rows = chunkAdaptiveButtons(buttons, 26, 2);
  const pagination = panelPaginationRow("expiring", page, totalPages);
  if (pagination.length > 0) rows.push(pagination);
  rows.push([panelButton("⬅️ 返回主面板", "root")]);
  return { inline_keyboard: rows };
}

export function expiringPhoneDetailKeyboard(accountId: number, phoneId: number): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        callbackButton("🔄 续期号码", { scope: "phone", action: "renew_request", accountId, phoneId }),
        callbackButton("🗑️ 取消号码", { scope: "phone", action: "cancel_request", accountId, phoneId })
      ],
      [
        callbackButton("✏️ 修改备注命令", { scope: "phone", action: "note", accountId, phoneId }),
        panelButton("⬅️ 返回临期列表", "expiring", 1)
      ]
    ]
  };
}

function panelButton(
  text: string,
  action: "root" | "status" | "messages" | "help" | "accounts" | "phones" | "expiring",
  page?: number
) {
  if (action === "accounts" || action === "phones" || action === "expiring") {
    return callbackButton(text, { scope: "panel", action, page: page ?? 1 });
  }
  return callbackButton(text, { scope: "panel", action });
}

function callbackButton(
  text: string,
  callback: Parameters<typeof encodeTelegramCallback>[0]
): TelegramInlineKeyboardButton {
  return { text, callback_data: encodeTelegramCallback(callback) };
}

function panelPaginationRow(
  action: "accounts" | "phones" | "expiring",
  page: number,
  totalPages: number
): TelegramInlineKeyboardButton[] {
  const pagination = normalizePagination(page, totalPages);
  return [
    ...(pagination.page > 1 ? [panelButton("⬅️", action, pagination.page - 1)] : []),
    ...(pagination.page < pagination.totalPages ? [panelButton("➡️", action, pagination.page + 1)] : [])
  ];
}

function accountPhonePaginationRow(accountId: number, page: number, totalPages: number) {
  const pagination = normalizePagination(page, totalPages);
  return [
    ...(pagination.page > 1
      ? [callbackButton("⬅️", { scope: "account", action: "phones", accountId, page: pagination.page - 1 })]
      : []),
    ...(pagination.page < pagination.totalPages
      ? [callbackButton("➡️", { scope: "account", action: "phones", accountId, page: pagination.page + 1 })]
      : [])
  ];
}

function normalizePagination(page: number, totalPages: number) {
  const safeTotalPages = Number.isSafeInteger(totalPages) && totalPages > 0 ? totalPages : 1;
  const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
  return { page: Math.min(safePage, safeTotalPages), totalPages: safeTotalPages };
}

function truncateButtonText(value: string, maxCharacters = 48) {
  return Array.from(value).slice(0, maxCharacters).join("");
}

function closeTelegramTags(tags: Array<"b" | "code">) {
  return [...tags].reverse().map((tag) => `</${tag}>`).join("");
}

function readTelegramHtmlToken(text: string, index: number): {
  value: string;
  nextIndex: number;
  kind?: "open" | "close" | "entity" | "text";
  tag?: "b" | "code";
} {
  const remaining = text.slice(index);
  const tagMatch = remaining.match(/^<(\/)?(b|code)>/);
  if (tagMatch?.[0]) {
    return {
      value: tagMatch[0],
      nextIndex: index + tagMatch[0].length,
      kind: tagMatch[1] ? "close" : "open",
      tag: tagMatch[2] as "b" | "code"
    };
  }
  const entityMatch = remaining.match(/^&(?:amp|lt|gt|quot|#\d+|#x[0-9A-Fa-f]+);/);
  if (entityMatch?.[0]) {
    return { value: entityMatch[0], nextIndex: index + entityMatch[0].length, kind: "entity" };
  }
  const codePoint = text.codePointAt(index);
  const value = codePoint === undefined ? "" : String.fromCodePoint(codePoint);
  return { value, nextIndex: index + value.length, kind: "text" };
}
