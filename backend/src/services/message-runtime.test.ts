import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MessageDirection, MessageType } from "@prisma/client";
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
        update: async () => null
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

test("extracts a TalkU team credit message from its real secretary envelope", async () => {
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
  assert.equal(runtime.messages[0]?.content, "积分变动：20");
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
  const timestamp = 1_800_000_000_000;

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
  runtime.phones.set(1, [{ phoneNumber: "+12025550102" }]);

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
  runtime.phones.set(1, [{ phoneNumber: "+61491570006" }]);
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
    [{ msgType: 25, fromNumber: "纭呭熀娴佸姩", toNumber: "61491570006", content: "[纭呭熀娴佸姩]Verification code is: 306497", rawK3: "k3-mojibake-sender" }],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.fromNumber, "\u7845\u57fa\u6d41\u52a8");
  assert.equal(runtime.messages[0]?.content, "[\u7845\u57fa\u6d41\u52a8]Verification code is: 306497");
});
