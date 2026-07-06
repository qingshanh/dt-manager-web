import assert from "node:assert/strict";
import test from "node:test";
import { MessageDirection, MessageType } from "@prisma/client";
import { storeHelperSmsMessages, storeParsedSmsPushes } from "./message-runtime.js";

function createMessageRuntimeDb() {
  const accounts = new Map<number, { id: number; nickname: string | null; email: string | null; phone: string | null; dtUserId: string | null; telegramNotify: boolean }>();
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
        findMany: async ({ where }: { where: { accountId: number } }) => phones.get(where.accountId) ?? []
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
      { msgType: 25, fromNumber: "SiliconFlow", toNumber: "18188815435", content: "Your code is 1087", rawK3: "k3-a" },
      { msgType: 25, fromNumber: "SiliconFlow", toNumber: "33755520480", content: "Your code is 1087", rawK3: "k3-b" }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 2);
  assert.deepEqual(runtime.messages.map((message) => message.toNumber), ["18188815435", "33755520480"]);
});

test("does not treat an unknown helper target as a duplicate of a confirmed target", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  runtime.phones.set(1, [{ phoneNumber: "18188815435" }, { phoneNumber: "33755520480" }]);

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationId: "18188815435|SiliconFlow",
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
test("infers direct SMS target from owned phones in raw push metadata", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  runtime.phones.set(1, [{ phoneNumber: "+33755520480" }]);

  const imported = await storeParsedSmsPushes(
    1,
    [
      {
        msgType: 561,
        fromNumber: "(669) 999-8659",
        toNumber: null,
        content: "Your verification code is 123456",
        rawInfo: Buffer.from("target=33755520480 dtId 170530439", "utf8").toString("base64"),
        rawK3: "direct-target-a"
      }
    ],
    { db: runtime.db as any, emitEvents: false, sendTelegram: false }
  );

  assert.equal(imported, 1);
  assert.equal(runtime.messages[0]?.toNumber, "+33755520480");
});

test("does not infer direct SMS target from sender-only raw metadata", async () => {
  const runtime = createMessageRuntimeDb();
  runtime.accounts.set(1, { id: 1, nickname: null, email: "owner@example.com", phone: null, dtUserId: "u1", telegramNotify: false });
  runtime.phones.set(1, [{ phoneNumber: "+16699998659" }]);

  const imported = await storeParsedSmsPushes(
    1,
    [
      {
        msgType: 561,
        fromNumber: "(669) 999-8659",
        toNumber: null,
        content: "Your verification code is 654321",
        rawInfo: Buffer.from("who 16699998659", "utf8").toString("base64"),
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
  runtime.phones.set(1, [{ phoneNumber: "+16699998659" }]);

  const imported = await storeHelperSmsMessages(
    1,
    [
      {
        conversationId: "16699998659|(669) 999-8659",
        senderId: "(669) 999-8659",
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
