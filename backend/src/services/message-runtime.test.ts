import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MessageDirection, MessageType } from "@prisma/client";
import { normalizeDirectWebOfflineMessages } from "./dingtone/direct-gateway.js";
import { eventBus, type AppEvent } from "./event-bus.js";
import { storeHelperSmsMessages, storeParsedSmsPushes } from "./message-runtime.js";

function createMessageRuntimeDb() {
  const accounts = new Map<number, {
    id: number;
    adminId?: number;
    appVariant?: "dingtone" | "dingdong";
    nickname: string | null;
    email: string | null;
    phone: string | null;
    dtUserId: string | null;
    telegramNotify: boolean;
  }>();
  const phones = new Map<number, Array<{ phoneNumber: string }>>();
  const messages: Array<{
    id: number;
    accountId: number;
    direction: MessageDirection;
    msgType: MessageType;
    fromNumber: string | null;
    toNumber: string | null;
    content: string;
    rawInfo: string | null;
    rawK3: string | null;
    k5Flag: number | null;
    isRead: boolean;
    telegramSent: boolean;
    telegramMsgId: string | null;
    receivedAt: Date;
    createdAt: Date;
  }> = [];

  function matchesWhere(message: (typeof messages)[number], where: Record<string, unknown>): boolean {
    for (const [key, expected] of Object.entries(where)) {
      if (key === "OR") {
        const clauses = expected as Array<Record<string, unknown>>;
        if (!clauses.some((clause) => matchesWhere(message, clause))) {
          return false;
        }
        continue;
      }
      const actual = message[key as keyof typeof message];
      if (expected && typeof expected === "object" && "gte" in expected) {
        const range = expected as { gte?: Date; lte?: Date };
        if (range.gte && (actual as Date).getTime() < range.gte.getTime()) {
          return false;
        }
        if (range.lte && (actual as Date).getTime() > range.lte.getTime()) {
          return false;
        }
        continue;
      }
      if (expected && typeof expected === "object" && "not" in expected) {
        if (actual === (expected as { not: unknown }).not) {
          return false;
        }
        continue;
      }
      if (actual !== expected) {
        return false;
      }
    }
    return true;
  }

  return {
    accounts,
    phones,
    messages,
    db: {
      dtAccount: {
        findUnique: async ({ where }: { where: { id: number } }) => accounts.get(where.id) ?? null
      },
      phoneNumber: {
        findMany: async ({ where }: { where: { accountId?: number; account?: { adminId?: number; appVariant?: string; dtUserId?: string | null } } }) => {
          if (where.accountId !== undefined) {
            return phones.get(where.accountId) ?? [];
          }
          const rows: Array<{ accountId: number; phoneNumber: string }> = [];
          for (const [accountId, accountPhones] of phones.entries()) {
            const account = accounts.get(accountId);
            if (!account) {
              continue;
            }
            if (where.account?.adminId !== undefined && account.adminId !== where.account.adminId) {
              continue;
            }
            if (where.account?.appVariant !== undefined && account.appVariant !== where.account.appVariant) {
              continue;
            }
            if (where.account?.dtUserId !== undefined && account.dtUserId !== where.account.dtUserId) {
              continue;
            }
            rows.push(...accountPhones.map((phone) => ({ accountId, phoneNumber: phone.phoneNumber })));
          }
          return rows;
        }
      },
      message: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => messages.find((message) => matchesWhere(message, where)) ?? null,
        create: async ({ data }: { data: Omit<(typeof messages)[number], "id" | "createdAt" | "telegramSent" | "telegramMsgId"> }) => {
          const message = {
            ...data,
            id: messages.length + 1,
            createdAt: new Date(),
            telegramSent: false,
            telegramMsgId: null
          };
          messages.push(message);
          return message;
        },
        update: async ({ where, data }: { where: { id: number }; data: Partial<(typeof messages)[number]> }) => {
          const message = messages.find((item) => item.id === where.id);
          if (!message) {
            return null;
          }
          Object.assign(message, data);
          return message;
        }
      }
    }
  };
}

test("stores direct SMS pushes with the same sender and content when target phone differs", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });

  const imported = await storeParsedSmsPushes(
    1,
    [
      { msgType: 25, fromNumber: "SiliconFlow", toNumber: "12025550101", content: "Your code is 1087", rawK3: "k3-a" },
      { msgType: 25, fromNumber: "SiliconFlow", toNumber: "33199000001", content: "Your code is 1087", rawK3: "k3-b" }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 2);
  assert.deepEqual(runtime.messages.map((message) => message.toNumber), ["12025550101", "33199000001"]);
});

test("only deduplicates adjacent direct frames when the provider message id is missing", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  const push = { msgType: 1, fromNumber: "Provider", toNumber: "33612345678", content: "Repeated service notice" };

  assert.equal(await storeParsedSmsPushes(1, [push], { db: runtime.db as any, emitEvents: false, sendTelegram: false }), 1);
  assert.equal(await storeParsedSmsPushes(1, [push], { db: runtime.db as any, emitEvents: false, sendTelegram: false }), 0);

  runtime.messages[0]!.receivedAt = new Date(Date.now() - 31_000);
  assert.equal(await storeParsedSmsPushes(1, [push], { db: runtime.db as any, emitEvents: false, sendTelegram: false }), 1);
});

test("does not treat an unknown helper target as a duplicate of a confirmed target", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  runtime.phones.set(1, [{ phoneNumber: "12025550101" }, { phoneNumber: "33199000001" }]);

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationId: "12025550101|SiliconFlow",
        senderId: "SiliconFlow",
        msgId: "helper-a",
        content: "Your code is 1087",
        time: 1_800_000_000_000
      },
      {
        senderId: "SiliconFlow",
        data3: "adb-ui",
        content: "Your code is 1087",
        time: 1_800_000_030_000
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 2);
});

test("deduplicates the same targeted SMS imported by direct push and app fallback", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  runtime.phones.set(1, [{ phoneNumber: "61412345678" }]);
  const content = "[硅基流动]Verification code is: 441071, valid for 5 minutes.";

  assert.equal(await storeParsedSmsPushes(1, [{
    msgType: 25,
    fromNumber: "硅基流动",
    toNumber: "61412345678",
    content,
    rawK3: "direct-au-code"
  }], { db: runtime.db as any, emitEvents: false, sendTelegram: false }), 1);
  const directReceivedAt = runtime.messages[0]!.receivedAt.getTime();

  assert.equal(await storeHelperSmsMessages(1, [{
    conversationId: "61412345678|Unverified",
    senderId: "Unverified",
    msgId: "adb-au-code",
    content,
    timestamp: directReceivedAt - 500
  }], { db: runtime.db as any, emitEvents: false, sendTelegram: false }), 0);

  assert.equal(runtime.messages.length, 1);
});
test("stores team messages as read system messages", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: true });

  const imported = await storeParsedSmsPushes(
    1,
    [
      {
        msgType: 561,
        fromNumber: "TalkU Team",
        toNumber: null,
        content: "Your TalkU number order succeeded. Balance changed by 100 credits.",
        rawK3: "team-a"
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.msgType, MessageType.system);
  assert.equal(runtime.messages[0]?.isRead, true);
});

test("repairs garbled team pushes and keeps them out of panel and Telegram notifications", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    adminId: 1,
    appVariant: "dingdong",
    nickname: "Team account",
    email: "owner@example.com",
    phone: null,
    dtUserId: "u1",
    telegramNotify: true
  });
  const events: AppEvent[] = [];
  const listener = (event: AppEvent) => events.push(event);
  eventBus.on("event", listener);

  try {
    const imported = await storeParsedSmsPushes(
      1,
      [
        {
          msgType: 561,
          fromNumber: "璇撮亾鍥㈤槦",
          toNumber: null,
          content: "璇撮亾鍥㈤槦绯荤粺娑堟伅 team-example-7433",
          rawK3: "garbled-team-push"
        }
      ],
      { db: runtime.db as any, emitEvents: true, sendTelegram: true }
    );

    assert.equal(imported, 1);
    assert.equal(runtime.messages[0]?.msgType, MessageType.system);
    assert.equal(runtime.messages[0]?.fromNumber, "说道团队");
    assert.equal(runtime.messages[0]?.content, "说道团队系统消息 team-example-7433");
    assert.equal(runtime.messages[0]?.isRead, true);
    assert.equal(runtime.messages[0]?.telegramSent, false);
    assert.equal(events.filter((event) => event.type === "new_message").length, 0);
  } finally {
    eventBus.off("event", listener);
  }
});

test("does not classify a regular message as a team message from its content", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });

  const imported = await storeParsedSmsPushes(
    1,
    [
      {
        msgType: 561,
        fromNumber: "Service Notice",
        toNumber: null,
        content: "Dingtone Team will perform maintenance tonight.",
        rawK3: "ordinary-message-mentions-team"
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.msgType, MessageType.sms);
  assert.equal(runtime.messages[0]?.isRead, false);
});

test("skips team messages when collection is disabled", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationId: "TalkU Team|system",
        senderId: "TalkU Team",
        msgId: "team-disabled",
        content: "Your private number will expire in 3 days.",
        time: 1_800_000_000_000
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false, collectTeamMessages: false }
  );

  assert.equal(imported, 0);
  assert.equal(runtime.messages.length, 0);
});

test("stores the named DingDong team conversation as a system message", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, appVariant: "dingdong", nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationType: 4,
        conversationId: "10000",
        senderId: "service-10001",
        msgId: "secretary-a",
        content: "A new benefit is available in your account.",
        time: 1_800_000_000_000
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false, collectTeamMessages: true }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.msgType, MessageType.system);
  assert.equal(runtime.messages[0]?.fromNumber, "叮咚团队");
  assert.equal(runtime.messages[0]?.isRead, true);
});

test("renders a TalkU redemption message from its real secretary envelope", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, appVariant: "dingtone", nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationType: 4,
        conversationId: "10000",
        conversationUserId: "10000",
        type: 531,
        senderId: "2684354560",
        msgId: "talku-credit-envelope",
        content: "{\"msgContent\":\"\",\"msgTitle\":\"\",\"msgMeta\":\"{\\\"k1\\\":531,\\\"credits\\\":20.0,\\\"bc\\\":20.0,\\\"adType\\\":0,\\\"ex\\\":90,\\\"type\\\":34}\"}",
        time: 1_800_000_000_000
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false, collectTeamMessages: true }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.msgType, MessageType.system);
  assert.equal(runtime.messages[0]?.fromNumber, "说道团队");
  assert.equal(runtime.messages[0]?.content, "兑换成功，20.00 说道币已到账");
});

test("renders DingDong team credit arrivals and completed tasks from real metadata", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, appVariant: "dingdong", nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationType: 4,
        conversationId: "10000",
        conversationUserId: "10000",
        type: 531,
        senderId: "2684354560",
        msgId: "dingdong-credit-arrival",
        content: "{\"msgContent\":\"\",\"msgTitle\":\"\",\"msgMeta\":\"{\\\"k1\\\":531,\\\"credits\\\":4.0,\\\"bc\\\":4.0,\\\"ex\\\":-1,\\\"type\\\":99}\"}",
        timestamp: Date.now()
      },
      {
        conversationType: 4,
        conversationId: "10000",
        conversationUserId: "10000",
        type: 532,
        senderId: "2684354560",
        msgId: "dingdong-task-completed",
        content: "{\"msgContent\":\"\",\"msgTitle\":\"\",\"msgMeta\":\"{\\\"k1\\\":532,\\\"credits\\\":0.5,\\\"bc\\\":0.5,\\\"ex\\\":-1,\\\"type\\\":5}\"}",
        timestamp: Date.now() - 1
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false, collectTeamMessages: true }
  );

  assert.equal(imported, 2);
  assert.equal(runtime.messages[0]?.content, "获得 4.00 叮咚币");
  assert.equal(runtime.messages[1]?.content, "任务完成，获得 0.50 叮咚币");
});

test("stores metadata-only DingDong task credits from Direct web offline", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    appVariant: "dingdong",
    nickname: null,
    email: "owner@example.com",
    phone: null,
    dtUserId: "u1",
    telegramNotify: false
  });
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        msgTitle: "",
        msgContent: "",
        msgMeta: JSON.stringify({ k1: 532, credits: 0.5, ex: -1, type: 5 }),
        msgSenderID: "2684354560",
        msgId: "direct-credit-532",
        msgType: 532,
        msgTimeStamp: 1_800_000_001
      }
    ]
  }, "dingdong");

  const imported = await storeHelperSmsMessages(1, rows, {
    db: runtime.db as any,
    emitEvents: false,
    sendTelegram: false,
    collectTeamMessages: true
  });

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.msgType, MessageType.system);
  assert.equal(runtime.messages[0]?.k5Flag, 532);
  assert.equal(runtime.messages[0]?.fromNumber, "叮咚团队");
  assert.equal(runtime.messages[0]?.content, "任务完成，获得 0.50 叮咚币");
  assert.equal(runtime.messages[0]?.isRead, true);
});

test("stores common-event credits using nested params metadata", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    appVariant: "dingdong",
    nickname: null,
    email: "owner@example.com",
    phone: null,
    dtUserId: "u1",
    telegramNotify: false
  });
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        content: JSON.stringify({
          content: "",
          args: { type: 99, params: { k1: 531, credits: 4, ex: -1 } }
        }),
        from: "2684354560",
        msgId: "direct-credit-3300-store",
        msgType: 3300,
        msgTimeStamp: 1_800_000_002
      }
    ]
  }, "dingdong");

  const imported = await storeHelperSmsMessages(1, rows, {
    db: runtime.db as any,
    emitEvents: false,
    sendTelegram: false,
    collectTeamMessages: true
  });

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.k5Flag, 531);
  assert.equal(runtime.messages[0]?.content, "获得 4.00 叮咚币");
});

test("stores team credit metadata from data2 when the helper content is empty", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "owner@example.com",
    phone: null,
    dtUserId: "u1",
    telegramNotify: false
  });

  const imported = await storeHelperSmsMessages(1, [
    {
      conversationType: 4,
      conversationId: "10000",
      type: 531,
      senderId: "2684354560",
      msgId: "data2-only-credit",
      content: "",
      data2: JSON.stringify({ k1: 531, credits: 4, ex: -1, type: 99 }),
      timestamp: 1_800_000_003
    }
  ], {
    db: runtime.db as any,
    emitEvents: false,
    sendTelegram: false,
    collectTeamMessages: true
  });

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.content, "获得 4.00 说道币");
  assert.equal(runtime.messages[0]?.k5Flag, 531);
});

test("uses the inner team type for direct helper creation and duplicate upgrades", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    appVariant: "dingdong",
    nickname: null,
    email: "owner@example.com",
    phone: null,
    dtUserId: "u1",
    telegramNotify: false
  });
  const row = {
    conversationType: 4,
    conversationId: "10000",
    type: 3300,
    senderId: "2684354560",
    msgId: "helper-inner-type-531",
    content: "",
    data2: JSON.stringify({ k1: 531, credits: 4, ex: -1, type: 99 }),
    timestamp: 1_800_000_006
  };

  assert.equal(await storeHelperSmsMessages(1, [row], {
    db: runtime.db as any,
    emitEvents: false,
    sendTelegram: false,
    collectTeamMessages: true
  }), 1);
  assert.equal(runtime.messages[0]?.k5Flag, 531);

  runtime.messages[0]!.k5Flag = 3300;
  runtime.messages[0]!.content = "积分变动：";
  runtime.messages[0]!.fromNumber = "2684354560";

  assert.equal(await storeHelperSmsMessages(1, [row], {
    db: runtime.db as any,
    emitEvents: false,
    sendTelegram: false,
    collectTeamMessages: true
  }), 0);
  assert.equal(runtime.messages.length, 1);
  assert.equal(runtime.messages[0]?.k5Flag, 531);
  assert.equal(runtime.messages[0]?.content, "获得 4.00 叮咚币");
  assert.equal(runtime.messages[0]?.fromNumber, "叮咚团队");
});

test("keeps untrusted helper JSON metadata as an ordinary unread SMS", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    adminId: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "owner@example.com",
    phone: null,
    dtUserId: "u1",
    telegramNotify: true
  });
  const events: AppEvent[] = [];
  const listener = (event: AppEvent) => events.push(event);
  eventBus.on("event", listener);

  try {
    const imported = await storeHelperSmsMessages(1, [
      {
        conversationType: 1,
        conversationId: "12025550101|Service Notice",
        type: 1,
        senderId: "Service Notice",
        msgId: "ordinary-json-credit-meta",
        content: "Ordinary balance notice",
        data2: JSON.stringify({ k1: 531, credits: 4, type: 99 })
      }
    ], {
      db: runtime.db as any,
      emitEvents: true,
      sendTelegram: false,
      collectTeamMessages: true
    });

    assert.equal(imported, 1);
    assert.equal(runtime.messages[0]?.msgType, MessageType.sms);
    assert.equal(runtime.messages[0]?.fromNumber, "Service Notice");
    assert.equal(runtime.messages[0]?.content, "Ordinary balance notice");
    assert.equal(runtime.messages[0]?.k5Flag, 1);
    assert.equal(runtime.messages[0]?.isRead, false);
    assert.equal(events.filter((event) => event.type === "new_message").length, 1);
  } finally {
    eventBus.off("event", listener);
  }
});

test("keeps empty ordinary helper SMS rows filtered", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "owner@example.com",
    phone: null,
    dtUserId: "u1",
    telegramNotify: false
  });

  const imported = await storeHelperSmsMessages(1, [
    {
      conversationType: 1,
      conversationId: "12025550101|Service",
      senderId: "Service",
      msgId: "empty-ordinary-helper",
      content: ""
    }
  ], { db: runtime.db as any, emitEvents: false, sendTelegram: false });

  assert.equal(imported, 0);
  assert.equal(runtime.messages.length, 0);
});

test("upgrades an existing team summary when the same helper message is scanned again", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, appVariant: "dingdong", nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  runtime.messages.push({
    id: 1,
    accountId: 1,
    direction: MessageDirection.incoming,
    msgType: MessageType.system,
    fromNumber: "叮咚团队",
    toNumber: null,
    content: "积分变动：4",
    rawInfo: "10000",
    rawK3: "existing-team-summary",
    k5Flag: 3300,
    isRead: true,
    telegramSent: false,
    telegramMsgId: null,
    receivedAt: new Date(Date.now() + 8 * 60 * 60_000),
    createdAt: new Date()
  });

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationType: 4,
        conversationId: "10000",
        conversationUserId: "10000",
        type: 531,
        senderId: "2684354560",
        msgId: "existing-team-summary",
        content: "{\"msgContent\":\"\",\"msgTitle\":\"\",\"msgMeta\":\"{\\\"k1\\\":531,\\\"credits\\\":4.0,\\\"bc\\\":4.0,\\\"ex\\\":-1,\\\"type\\\":99}\"}",
        timestamp: Date.now() + 8 * 60 * 60_000
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false, collectTeamMessages: true }
  );

  assert.equal(imported, 0);
  assert.equal(runtime.messages.length, 1);
  assert.equal(runtime.messages[0]?.content, "获得 4.00 叮咚币");
  assert.equal(runtime.messages[0]?.fromNumber, "叮咚团队");
  assert.equal(runtime.messages[0]?.k5Flag, 531);
  assert.ok((runtime.messages[0]?.receivedAt.getTime() ?? 0) <= Date.now() + 1_000);
});

test("upgrades repeated team messages from outer 3300 to inner 531 and 532 types", async () => {
  for (const scenario of [
    { k1: 531, actionType: 99, credits: 4, expected: "获得 4.00 叮咚币" },
    { k1: 532, actionType: 5, credits: 0.5, expected: "任务完成，获得 0.50 叮咚币" }
  ]) {
    const runtime = createMessageRuntimeDb();
    runtime.accounts.set(1, {
      id: 1,
      appVariant: "dingdong",
      nickname: null,
      email: "owner@example.com",
      phone: null,
      dtUserId: "u1",
      telegramNotify: false
    });
    const msgId = `credit-upgrade-${scenario.k1}`;
    runtime.messages.push({
      id: 1,
      accountId: 1,
      direction: MessageDirection.incoming,
      msgType: MessageType.system,
      fromNumber: "2684354560",
      toNumber: null,
      content: "积分变动：",
      rawInfo: "10000",
      rawK3: msgId,
      k5Flag: 3300,
      isRead: true,
      telegramSent: false,
      telegramMsgId: null,
      receivedAt: new Date(),
      createdAt: new Date()
    });
    const rows = normalizeDirectWebOfflineMessages({
      Result: 1,
      Message: [
        {
          content: JSON.stringify({
            content: "",
            args: {
              type: scenario.actionType,
              params: { k1: scenario.k1, credits: scenario.credits, ex: -1 }
            }
          }),
          from: "2684354560",
          msgId,
          msgType: 3300,
          msgTimeStamp: 1_800_000_004
        }
      ]
    }, "dingdong");

    const imported = await storeHelperSmsMessages(1, rows, {
      db: runtime.db as any,
      emitEvents: false,
      sendTelegram: false,
      collectTeamMessages: true
    });

    assert.equal(imported, 0);
    assert.equal(runtime.messages.length, 1);
    assert.equal(runtime.messages[0]?.content, scenario.expected);
    assert.equal(runtime.messages[0]?.fromNumber, "叮咚团队");
    assert.equal(runtime.messages[0]?.k5Flag, scenario.k1);
  }
});

test("isolates normalized team credits from events and Telegram even when forced on", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    adminId: 1,
    appVariant: "dingtone",
    nickname: "Team account",
    email: "owner@example.com",
    phone: null,
    dtUserId: "u1",
    telegramNotify: true
  });
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        msgTitle: "",
        msgContent: "",
        msgMeta: JSON.stringify({ k1: 531, credits: 20, ex: 90, type: 34 }),
        msgSenderID: "2684354560",
        msgId: "isolated-team-credit",
        msgType: 531,
        msgTimeStamp: 1_800_000_005
      }
    ]
  }, "dingtone");
  const events: AppEvent[] = [];
  const listener = (event: AppEvent) => events.push(event);
  eventBus.on("event", listener);

  try {
    const imported = await storeHelperSmsMessages(1, rows, {
      db: runtime.db as any,
      emitEvents: true,
      sendTelegram: true,
      collectTeamMessages: true
    });

    assert.equal(imported, 1);
    assert.equal(runtime.messages[0]?.msgType, MessageType.system);
    assert.equal(runtime.messages[0]?.isRead, true);
    assert.equal(runtime.messages[0]?.telegramSent, false);
    assert.equal(runtime.messages[0]?.telegramMsgId, null);
    assert.equal(events.filter((event) => event.type === "new_message").length, 0);
  } finally {
    eventBus.off("event", listener);
  }
});

test("keeps the original import time when a repeated team message has no provider timestamp", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, appVariant: "dingdong", nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  const row = {
    conversationType: 4,
    conversationId: "10000",
    conversationUserId: "10000",
    type: 531,
    senderId: "2684354560",
    msgId: "team-without-provider-time",
    content: "{\"msgContent\":\"\",\"msgTitle\":\"\",\"msgMeta\":\"{\\\"k1\\\":531,\\\"credits\\\":1.0,\\\"bc\\\":1.0,\\\"ex\\\":-1,\\\"type\\\":99}\"}",
    timestamp: 0
  };

  assert.equal(await storeHelperSmsMessages(1, [row], {
    db: runtime.db as any,
    emitEvents: false,
    sendTelegram: false,
    collectTeamMessages: true
  }), 1);
  const firstReceivedAt = runtime.messages[0]?.receivedAt.getTime();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await storeHelperSmsMessages(1, [row], {
    db: runtime.db as any,
    emitEvents: false,
    sendTelegram: false,
    collectTeamMessages: true
  }), 0);

  assert.equal(runtime.messages.length, 1);
  assert.equal(runtime.messages[0]?.receivedAt.getTime(), firstReceivedAt);
});

test("does not move a repeated team message to a newer provider timestamp", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, appVariant: "dingdong", nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  const originalReceivedAt = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  runtime.messages.push({
    id: 1,
    accountId: 1,
    direction: MessageDirection.incoming,
    msgType: MessageType.system,
    fromNumber: "鍙挌鍥㈤槦",
    toNumber: null,
    content: "1涓彯鍜氬竵宸茬粡鍒颁綘璐︿笂銆傜幇鍦ㄥ幓鏌ョ湅浣欓銆?",
    rawInfo: "10000",
    rawK3: "stable-team-time",
    k5Flag: 531,
    isRead: true,
    telegramSent: false,
    telegramMsgId: null,
    receivedAt: originalReceivedAt,
    createdAt: new Date(Date.now() - 24 * 60 * 60_000)
  });

  assert.equal(await storeHelperSmsMessages(1, [{
    conversationType: 4,
    conversationId: "10000",
    conversationUserId: "10000",
    type: 531,
    senderId: "2684354560",
    msgId: "stable-team-time",
    content: "{\"msgContent\":\"\",\"msgTitle\":\"\",\"msgMeta\":\"{\\\"k1\\\":531,\\\"credits\\\":1.0,\\\"bc\\\":1.0,\\\"ex\\\":-1,\\\"type\\\":99}\"}",
    timestamp: Date.now()
  }], {
    db: runtime.db as any,
    emitEvents: false,
    sendTelegram: false,
    collectTeamMessages: true
  }), 0);

  assert.equal(runtime.messages[0]?.receivedAt.getTime(), originalReceivedAt.getTime());
});

test("repairs a team message time that was previously pushed past its import time", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, appVariant: "dingdong", nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  const createdAt = new Date(Date.now() - 60 * 60_000);
  runtime.messages.push({
    id: 1,
    accountId: 1,
    direction: MessageDirection.incoming,
    msgType: MessageType.system,
    fromNumber: "叮咚团队",
    toNumber: null,
    content: "1个叮咚币已经到你账上。现在去查看余额。",
    rawInfo: "10000",
    rawK3: "polluted-team-time",
    k5Flag: 531,
    isRead: true,
    telegramSent: false,
    telegramMsgId: null,
    receivedAt: new Date(createdAt.getTime() + 30 * 60_000),
    createdAt
  });

  assert.equal(await storeHelperSmsMessages(1, [{
    conversationType: 4,
    conversationId: "10000",
    conversationUserId: "10000",
    type: 531,
    senderId: "2684354560",
    msgId: "polluted-team-time",
    content: "{\"msgContent\":\"\",\"msgTitle\":\"\",\"msgMeta\":\"{\\\"k1\\\":531,\\\"credits\\\":1.0,\\\"bc\\\":1.0,\\\"ex\\\":-1,\\\"type\\\":99}\"}",
    timestamp: 0
  }], {
    db: runtime.db as any,
    emitEvents: false,
    sendTelegram: false,
    collectTeamMessages: true
  }), 0);

  assert.equal(runtime.messages[0]?.receivedAt.getTime(), createdAt.getTime());
});

test("does not import non-team system conversations into the team message list", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, appVariant: "dingdong", nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationType: 11,
        conversationId: "10001",
        msgId: "activity-center",
        content: "You have free credits to receive.",
        timestamp: 1_800_000_000_000
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false, collectTeamMessages: true }
  );

  assert.equal(imported, 0);
  assert.equal(runtime.messages.length, 0);
});

test("uses timestamp when helper time is zero", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  const timestamp = 1_700_000_000_000;

  await storeHelperSmsMessages(
    1,
    [
      {
        conversationType: 3,
        msgId: "timestamp-fallback",
        content: "System tips",
        time: 0,
        timestamp
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false, collectTeamMessages: true }
  );

  assert.equal(runtime.messages[0]?.receivedAt.getTime(), timestamp);
});

test("corrects historical helper timestamps encoded as local wall-clock time", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, appVariant: "dingdong", nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  const now = Date.now();
  const actualReceivedAt = now - 6 * 60 * 60_000;
  const localWallClockTimestamp = actualReceivedAt + 8 * 60 * 60_000;

  await storeHelperSmsMessages(
    1,
    [
      {
        conversationType: 4,
        conversationId: "10000",
        msgId: "future-local-wall-clock",
        content: "{\"msgContent\":\"\",\"msgTitle\":\"\",\"msgMeta\":\"{\\\"k1\\\":531,\\\"credits\\\":1.0,\\\"ex\\\":-1,\\\"type\\\":99}\"}",
        time: 0,
        timestamp: localWallClockTimestamp
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false, collectTeamMessages: true }
  );

  const receivedAt = runtime.messages[0]?.receivedAt.getTime() ?? 0;
  assert.ok(Math.abs(receivedAt - actualReceivedAt) <= 1_000);
});
test("infers direct SMS target from owned phones in raw push metadata", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  runtime.phones.set(1, [{ phoneNumber: "+33199000001" }]);

  const imported = await storeParsedSmsPushes(
    1,
    [
      {
        msgType: 561,
        fromNumber: "(202) 555-0102",
        toNumber: null,
        content: "Your verification code is 123456",
        rawInfo: Buffer.from("target=33199000001 dtId 170530439", "utf8").toString("base64"),
        rawK3: "direct-target-a"
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.toNumber, "+33199000001");
});

test("uses the unique purchased phone when the parser intentionally leaves an ambiguous target empty", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    nickname: null,
    email: "owner@example.com",
    phone: null,
    dtUserId: "test-owner-1",
    telegramNotify: false
  });
  runtime.phones.set(1, [{ phoneNumber: "+61415550123" }]);

  const imported = await storeParsedSmsPushes(
    1,
    [{
      msgType: 561,
      fromNumber: "(818) 555-0101",
      toNumber: null,
      content: "TEST_DIRECT_TARGET",
      rawInfo: Buffer.from("recipient=61415550123 extra=32465550199", "utf8").toString("base64"),
      rawK3: Buffer.from("recipient=61415550123", "utf8").toString("base64")
    }],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.accountId, 1);
  assert.equal(runtime.messages[0]?.toNumber, "+61415550123");
});

test("routes direct SMS pushes to the local account that owns the target phone", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    adminId: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "first@example.com",
    phone: null,
    dtUserId: "shared-user",
    telegramNotify: false
  });
  runtime.accounts.set(2, {
    id: 2,
    adminId: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "second@example.com",
    phone: null,
    dtUserId: "shared-user",
    telegramNotify: false
  });
  runtime.phones.set(1, [{ phoneNumber: "+12025550101" }]);
  runtime.phones.set(2, [{ phoneNumber: "+33199000001" }]);

  const imported = await storeParsedSmsPushes(
    1,
    [
      {
        msgType: 561,
        fromNumber: "SiliconFlow",
        toNumber: "33199000001",
        content: "Your code is 1087",
        rawK3: "cross-account-target"
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.accountId, 2);
  assert.equal(runtime.messages[0]?.toNumber, "+33199000001");
});
test("does not infer direct SMS target from sender-only raw metadata", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  runtime.phones.set(1, [{ phoneNumber: "+16695550102" }]);

  const imported = await storeParsedSmsPushes(
    1,
    [
      {
        msgType: 561,
        fromNumber: "(669) 555-0102",
        toNumber: null,
        content: "Your verification code is 654321",
        rawInfo: Buffer.from("who 16695550102", "utf8").toString("base64"),
        rawK3: "direct-sender-only-a"
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.toNumber, null);
});
test("does not infer helper SMS target from differently formatted sender", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  runtime.phones.set(1, [{ phoneNumber: "+12025550101" }]);

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationId: "12025550102|(202) 555-0102",
        senderId: "(202) 555-0102",
        msgId: "helper-sender-only",
        content: "Your verification code is 246810",
        time: 1_800_000_000_000
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.toNumber, null);
});

test("ignores outgoing helper rows whose sender is owned by the scanned account", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    adminId: 1,
    appVariant: "dingdong",
    nickname: null,
    email: "sender@example.com",
    phone: null,
    dtUserId: "sender-user",
    telegramNotify: false
  });
  runtime.accounts.set(2, {
    id: 2,
    adminId: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "receiver@example.com",
    phone: null,
    dtUserId: "receiver-user",
    telegramNotify: false
  });
  runtime.phones.set(1, [{ phoneNumber: "+447700900101" }]);
  runtime.phones.set(2, [{ phoneNumber: "+33612345678" }]);

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationId: "447700900101|33612345678",
        senderId: "447700900101",
        msgId: "outgoing-helper-row",
        content: "Outbound test marker 123456",
        time: 1_800_000_000_000
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 0);
  assert.equal(runtime.messages.length, 0);
});

test("routes direct SMS pushes across different dt_user_id accounts when the target phone is unique", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    adminId: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "first@example.com",
    phone: null,
    dtUserId: "user-one",
    telegramNotify: false
  });
  runtime.accounts.set(2, {
    id: 2,
    adminId: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "second@example.com",
    phone: null,
    dtUserId: "user-two",
    telegramNotify: false
  });
  runtime.phones.set(1, [{ phoneNumber: "+12025550101" }]);
  runtime.phones.set(2, [{ phoneNumber: "+33199000001" }]);

  const imported = await storeParsedSmsPushes(
    1,
    [
      {
        msgType: 561,
        fromNumber: "SiliconFlow",
        toNumber: "33199000001",
        content: "Your code is 1087",
        rawK3: "cross-dt-user-target"
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.accountId, 2);
  assert.equal(runtime.messages[0]?.toNumber, "+33199000001");
});

test("routes helper SMS messages across different dt_user_id accounts when the target phone is unique", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    adminId: 1,
    appVariant: "dingdong",
    nickname: null,
    email: "first@example.com",
    phone: null,
    dtUserId: "user-one",
    telegramNotify: false
  });
  runtime.accounts.set(2, {
    id: 2,
    adminId: 1,
    appVariant: "dingdong",
    nickname: null,
    email: "second@example.com",
    phone: null,
    dtUserId: "user-two",
    telegramNotify: false
  });
  runtime.phones.set(1, [{ phoneNumber: "+61415550123" }]);
  runtime.phones.set(2, [{ phoneNumber: "+447700900123" }]);

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationId: "447700900123|SiliconFlow",
        senderId: "SiliconFlow",
        msgId: "helper-cross-dt-user-target",
        content: "Your code is 224466",
        time: 1_800_000_000_000
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.accountId, 2);
  assert.equal(runtime.messages[0]?.toNumber, "+447700900123");
});
test("routes UK local-format owned numbers when direct pushes include country code", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    adminId: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "first@example.com",
    phone: null,
    dtUserId: "user-one",
    telegramNotify: false
  });
  runtime.accounts.set(2, {
    id: 2,
    adminId: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "second@example.com",
    phone: null,
    dtUserId: "user-two",
    telegramNotify: false
  });
  runtime.phones.set(1, [{ phoneNumber: "7700900124" }]);
  runtime.phones.set(2, [{ phoneNumber: "7700900123" }]);

  const imported = await storeParsedSmsPushes(
    1,
    [
      {
        msgType: 1,
        fromNumber: "SiliconFlow",
        toNumber: "+447700900123",
        content: "Your code is 118899",
        rawK3: "uk-local-direct"
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.accountId, 2);
  assert.equal(runtime.messages[0]?.toNumber, "7700900123");
});

test("routes France, Australia, and Mexico local-format numbers when direct pushes use international format", async () => {
  const scenarios = [
    { local: "0612345678", international: "+33612345678", rawK3: "fr-local-direct" },
    { local: "0412345678", international: "+61412345678", rawK3: "au-local-direct" },
    { local: "5512345678", international: "+525512345678", rawK3: "mx-local-direct" }
  ];

  for (const scenario of scenarios) {
    const runtime = createMessageRuntimeDb();
    runtime.accounts.set(1, {
      id: 1,
      adminId: 1,
      appVariant: "dingtone",
      nickname: null,
      email: "first@example.com",
      phone: null,
      dtUserId: "user-one",
      telegramNotify: false
    });
    runtime.accounts.set(2, {
      id: 2,
      adminId: 1,
      appVariant: "dingtone",
      nickname: null,
      email: "second@example.com",
      phone: null,
      dtUserId: "user-two",
      telegramNotify: false
    });
    runtime.phones.set(1, [{ phoneNumber: "2025550101" }]);
    runtime.phones.set(2, [{ phoneNumber: scenario.local }]);

    const imported = await storeParsedSmsPushes(
      1,
      [{
        msgType: 1,
        fromNumber: "Provider",
        toNumber: scenario.international,
        content: "Your code is 118899",
        rawK3: scenario.rawK3
      }],
      { db: runtime.db as any, emitEvents: false, sendTelegram: false }
    );

    assert.equal(imported, 1, scenario.international);
    assert.equal(runtime.messages[0]?.accountId, 2, scenario.international);
    assert.equal(runtime.messages[0]?.toNumber, scenario.local, scenario.international);
  }
});

test("routes UK local-format owned numbers when helper rows include country code", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, {
    id: 1,
    adminId: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "first@example.com",
    phone: null,
    dtUserId: "user-one",
    telegramNotify: false
  });
  runtime.accounts.set(2, {
    id: 2,
    adminId: 1,
    appVariant: "dingtone",
    nickname: null,
    email: "second@example.com",
    phone: null,
    dtUserId: "user-two",
    telegramNotify: false
  });
  runtime.phones.set(1, [{ phoneNumber: "7700900124" }]);
  runtime.phones.set(2, [{ phoneNumber: "7700900123" }]);

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationId: "447700900123|SiliconFlow",
        senderId: "SiliconFlow",
        msgId: "uk-local-helper",
        content: "Your code is 118899",
        time: 1_800_000_000_000
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.accountId, 2);
  assert.equal(runtime.messages[0]?.toNumber, "7700900123");
});
test("direct SMS storage emits local events before async telegram delivery", () => {
  const source = readFileSync(new URL("./message-runtime.ts", import.meta.url), "utf8");
  const storeStart = source.indexOf("async function storeParsedSmsPush");
  const storeEnd = source.indexOf("async function findDuplicateMessage", storeStart);
  assert.notEqual(storeStart, -1);
  assert.ok(storeEnd > storeStart);
  const block = source.slice(storeStart, storeEnd);
  const emitIndex = block.indexOf("eventBus.emitEvent");
  const notifyIndex = block.indexOf("void maybeSendTelegram");

  assert.notEqual(emitIndex, -1);
  assert.notEqual(notifyIndex, -1);
  assert.ok(emitIndex < notifyIndex);
  assert.doesNotMatch(block, /await maybeSendTelegram/);
});
test("repairs mojibake sender labels recovered from direct SMS content", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });

  const imported = await storeParsedSmsPushes(
    1,
    [{ msgType: 25, fromNumber: "纭呭熀娴佸姩", toNumber: "61415550123", content: "[纭呭熀娴佸姩]Verification code is: 306497", rawK3: "k3-mojibake-sender" }],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.fromNumber, "\u7845\u57fa\u6d41\u52a8");
  assert.equal(runtime.messages[0]?.content, "[\u7845\u57fa\u6d41\u52a8]Verification code is: 306497");
});
