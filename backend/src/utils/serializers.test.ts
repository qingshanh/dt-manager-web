import assert from "node:assert/strict";
import test from "node:test";
import { MessageDirection, MessageType } from "@prisma/client";
import { repairUtf8Mojibake, serializeMessage } from "./serializers.js";

test("repairUtf8Mojibake restores UTF-8 Chinese text decoded as GBK", () => {
  assert.equal(repairUtf8Mojibake("璇撮亾鍥㈤槦绯荤粺娑堟伅"), "说道团队系统消息");
  assert.equal(repairUtf8Mojibake("鍙挌鍥㈤槦"), "叮咚团队");
  assert.equal(repairUtf8Mojibake("纭呭熀娴佸姩"), "硅基流动");
});

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
