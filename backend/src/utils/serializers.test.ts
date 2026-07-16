import assert from "node:assert/strict";
import test from "node:test";
import { MessageDirection, MessageType, PhoneStatus, type AccountSnapshot } from "@prisma/client";
import {
  repairUtf8Mojibake,
  serializeMessage,
  serializePhoneNumber,
  serializeSnapshot,
} from "./serializers.js";

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

  assert.equal(serializeMessage({ ...base, content: "C?<SiliconFlow?> Verification code is: 552420" }).content, "[硅基流动] Verification code is: 552420");
  assert.equal(serializeMessage({ ...base, content: "A[硅基流动]Verification code is: 521153" }).content, "[硅基流动]Verification code is: 521153");
  assert.equal(
    serializeMessage({ ...base, fromNumber: "TWVerify", content: "��������������916128" }).content,
    "您的验证代码是：916128"
  );
  assert.equal(
    serializeMessage({ ...base, fromNumber: "OPENAI", content: "���� OpenAI ���������:924582" }).content,
    "您的 OpenAI 验证代码是：924582"
  );
});

test("serializeMessage normalizes legacy SiliconFlow provider wrappers", () => {
  const serialized = serializeMessage({
    id: 1,
    accountId: 1,
    direction: "incoming",
    msgType: "verification",
    fromNumber: "(833) 858-1657",
    toNumber: "16125550123",
    content: "C?<SiliconFlow?> Verification code is: 791461, valid for 5 minutes.",
    rawInfo: null,
    rawK3: null,
    k5Flag: null,
    isRead: false,
    telegramSent: false,
    telegramMsgId: null,
    receivedAt: new Date("2026-07-14T10:24:05.869Z"),
    createdAt: new Date("2026-07-14T10:24:05.869Z")
  });

  assert.equal(serialized.content, "[硅基流动] Verification code is: 791461, valid for 5 minutes.");
});

test("serializePhoneNumber exposes the per-number SMS receive switch", () => {
  const serialized = serializePhoneNumber({
    id: 1,
    accountId: 2,
    phoneNumber: "525500000001",
    countryCode: 52,
    providerId: 1,
    displayName: "Mexico",
    status: PhoneStatus.active,
    purchaseType: null,
    payType: null,
    validPeriodDays: null,
    gainTime: null,
    expiredTime: null,
    autoRenew: true,
    isPrimary: false,
    isGoodNumber: false,
    portoutInfo: null,
    rawJson: JSON.stringify({
      filterSetting: JSON.stringify({
        useBlock: 1,
        callBlockSetting: 2,
        allowReceiveSMS: false
      })
    }),
    createdAt: new Date("2026-07-12T00:00:00.000Z"),
    updatedAt: new Date("2026-07-12T00:00:00.000Z")
  });

  assert.equal(serialized.allow_receive_sms, false);
});

function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    id: 1,
    accountId: 1,
    dtDingtoneId: null,
    fullName: null,
    avatarUrl: null,
    gender: null,
    birthday: null,
    email: null,
    phone: null,
    aboutMe: null,
    feeling: null,
    company: null,
    school: null,
    country: null,
    state: null,
    city: null,
    primaryBalance: null,
    userGrade: null,
    validPoint: null,
    progressPoint: null,
    membershipType: null,
    membershipExpireAt: null,
    profileVerCode: null,
    rawJson: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

test("serializeSnapshot prefers a positive public progress target", () => {
  const result = serializeSnapshot(snapshot({
    userGrade: 4,
    rawJson: JSON.stringify({
      publicPoint: {
        progressPointTotal: 5000,
        gradeInfo: { nextGradePoint: 6000 },
        historyPoint: 3178.2,
      },
    }),
  }));

  assert.equal(result?.progress_point_total, 5000);
});

test("serializeSnapshot uses nested synonyms after non-positive public values", () => {
  const result = serializeSnapshot(snapshot({
    rawJson: JSON.stringify({
      publicPoint: {
        progressPointTotal: 0,
        gradeInfo: { nextLevelPoint: 4200 },
        userInfo: { nextGradePoint: 4300 },
      },
    }),
  }));

  assert.equal(result?.progress_point_total, 4200);
});

test("serializeSnapshot checks all grade info before user info synonyms", () => {
  const result = serializeSnapshot(snapshot({
    rawJson: JSON.stringify({
      publicPoint: {
        progressPointTotal: 0,
        gradeInfo: {},
      },
      gradeInfo: { next_grade_point: 4100 },
      userInfo: { next_level_point: 4300 },
    }),
  }));

  assert.equal(result?.progress_point_total, 4100);
});

test("serializeSnapshot derives the V4 progress target", () => {
  const result = serializeSnapshot(snapshot({ userGrade: 4, rawJson: JSON.stringify({ publicPoint: {} }) }));

  assert.equal(result?.progress_point_total, 5000);
});

test("history and current points are never accepted as the progress target", () => {
  const result = serializeSnapshot(snapshot({
    userGrade: 3,
    rawJson: JSON.stringify({
      publicPoint: { historyPoint: 3178.2, validPoint: 1442.2, progressPoint: 1234 },
    }),
  }));

  assert.equal(result?.progress_point_total, null);
});
