import assert from "node:assert/strict";
import test from "node:test";
import { MessageDirection, MessageType } from "@prisma/client";
import { serializeMessage } from "./serializers.js";

test("serializeMessage cleans stale direct SMS length-prefix bytes", () => {
  const base = {
    id: 1,
    accountId: 1,
    direction: MessageDirection.incoming,
    msgType: MessageType.verification,
    fromNumber: "Anster",
    toNumber: "18188815435",
    rawInfo: null,
    rawK3: null,
    k5Flag: null,
    isRead: false,
    telegramSent: false,
    telegramMsgId: null,
    receivedAt: new Date("2026-07-06T13:54:45.308Z"),
    createdAt: new Date("2026-07-06T13:54:45.308Z")
  };

  assert.equal(serializeMessage({ ...base, content: "C?<SiliconFlow?> Verification code is: 552420" }).content, "?<SiliconFlow?> Verification code is: 552420");
  assert.equal(serializeMessage({ ...base, content: "A[硅基流动]Verification code is: 521153" }).content, "[硅基流动]Verification code is: 521153");
});