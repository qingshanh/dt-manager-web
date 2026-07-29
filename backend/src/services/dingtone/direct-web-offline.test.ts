import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGetWebOfflineMessageFrameForTest,
  buildGetWebOfflineMessageQuery,
  createDirectWebOfflineDeliveryTrackerForTest,
  deliverDirectWebOfflineMessagesForTest,
  directOfflineCatchupDelayMsForTest,
  isSocketClosedError,
  normalizeDirectWebOfflineMessages,
  withDirectOfflineCatchupPermitForTest
} from "./direct-gateway.js";
import { parseTeamMessageMeta, renderTeamMessageContent } from "../team-message-normalizer.js";
import zlib from "node:zlib";

test("builds the native getUserOfflineMsg query with the device flag enabled", () => {
  assert.equal(
    buildGetWebOfflineMessageQuery(
      {
        dtUserId: "10001",
        token: "token value",
        deviceId: "device.id"
      },
      "40051185300123456"
    ),
    "deviceId=device.id&userId=10001&token=token%20value&TrackCode=40051185300123456&bDevice=1"
  );
});

test("keeps the native REST payload length in sync after patching account fields", () => {
  const frame = buildGetWebOfflineMessageFrameForTest({
    deviceId: "And.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dttalk",
    userId: "123456789012345",
    token: "abcdef0123456789abcdef0123456789",
    TrackCode: "40051185300999999",
    bDevice: 1
  });
  const api = Buffer.from("getUserOfflineMsg");
  const apiIndex = frame.indexOf(api);
  const zlibOffset = frame.findIndex(
    (value, index) => value === 0x78 && [0x01, 0x9c, 0xda].includes(frame[index + 1] ?? -1)
  );

  assert.ok(apiIndex > 13);
  assert.ok(zlibOffset > apiIndex);
  const compressedLength = frame.readUInt32BE(zlibOffset - 4);
  assert.equal(frame.readUInt32BE(apiIndex - 13), api.length + compressedLength + 21);
  assert.match(zlib.inflateSync(frame.subarray(zlibOffset)).toString("utf8"), /userId=123456789012345/);
});

test("normalizes APK web-offline records into stable secretary messages", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    aOfflineMessagse: [
      {
        msgContent: "Your number order has completed.",
        msgId: "web-team-1001",
        msgMeta: "campaign=number-order",
        msgSenderID: "service-10001",
        msgTimeStamp: 1_800_000_000,
        msgTitle: "Dingtone Team",
        msgType: 17
      }
    ]
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.conversationType, 4);
  assert.equal(rows[0]?.conversationId, "10000");
  assert.equal(rows[0]?.msgId, "web-team-1001");
  assert.equal(rows[0]?.senderId, "叮咚团队");
  assert.equal(rows[0]?.content, "Dingtone Team\nYour number order has completed.");
  assert.equal(rows[0]?.timestamp, 1_800_000_000);
  assert.equal(rows[0]?.data2, "campaign=number-order");
  assert.equal(rows[0]?.data3, "direct-web-offline");
});

test("deduplicates nested web-offline records by remote message id", () => {
  const message = {
    msgContent: "Account notice",
    msgId: "web-team-1002",
    msgSenderID: "TalkU Team",
    msgTimeStamp: 1_800_000_100_000
  };
  const rows = normalizeDirectWebOfflineMessages({
    data: {
      offlineMessages: [message, { ...message }]
    }
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.content, "Account notice");
});

test("normalizes the singular Message array returned by the real TalkU endpoint", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        content: JSON.stringify({
          content: "Redeem completed",
          args: { type: 34, params: { credits: 1 } }
        }),
        msgId: "web-team-1003",
        from: "100000000000001",
        msgType: 3300,
        msgTimeStamp: 1_800_000_200
      }
    ]
  }, "dingtone");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.msgId, "web-team-1003");
  assert.equal(rows[0]?.content, "Redeem completed");
  assert.equal(rows[0]?.senderId, "说道团队");
  assert.equal(rows[0]?.conversationId, "10000");
  assert.equal(rows[0]?.data1, "说道团队");
  assert.match(rows[0]?.data2 ?? "", /"type":34/);
});

test("keeps metadata-only TalkU credit messages from numeric senders", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        msgTitle: "",
        msgContent: "",
        msgMeta: JSON.stringify({ k1: 531, credits: 20, bc: 20, adType: 0, ex: 90, type: 34 }),
        msgSenderID: "2684354560",
        msgId: "direct-credit-531",
        msgType: 531,
        msgTimeStamp: 1_800_000_000
      }
    ]
  }, "dingtone");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.type, 531);
  assert.equal(rows[0]?.senderId, "说道团队");
  assert.equal(rows[0]?.conversationId, "10000");
  assert.equal(rows[0]?.msgId, "direct-credit-531");
  assert.match(rows[0]?.data2 ?? "", /"credits":20/);
  assert.doesNotThrow(() => JSON.parse(rows[0]!.content));
});

test("keeps metadata-only DingDong task credits from numeric senders", () => {
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

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.type, 532);
  assert.equal(rows[0]?.senderId, "叮咚团队");
  assert.equal(rows[0]?.conversationId, "10000");
  assert.match(rows[0]?.data2 ?? "", /"credits":0.5/);
  assert.doesNotThrow(() => JSON.parse(rows[0]!.content));
});

test("promotes common-event credit metadata to its inner secretary type", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        content: JSON.stringify({
          content: "",
          args: { type: 99, params: { k1: 531, credits: 4, ex: -1 } }
        }),
        from: "2684354560",
        msgId: "direct-credit-3300",
        msgType: 3300,
        msgTimeStamp: 1_800_000_002
      }
    ]
  }, "dingtone");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.type, 531);
  assert.equal(rows[0]?.senderId, "说道团队");
  assert.match(rows[0]?.data2 ?? "", /"credits":4/);
  assert.doesNotThrow(() => JSON.parse(rows[0]!.content));
});

test("keeps ordinary inbound SMS records outside the team conversation", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        conversationType: 1,
        conversationId: "+12065550111|+120655507371",
        msgContent: "Your verification code is 246810",
        msgId: "offline-sms-1001",
        msgReceiverID: "+120655507371",
        msgSenderID: "+12065550111",
        msgTimeStamp: 1_800_000_003,
        msgType: 25
      }
    ]
  }, "dingdong");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.conversationType, 1);
  assert.equal(rows[0]?.conversationId, "+12065550111|+120655507371");
  assert.equal(rows[0]?.senderId, "+12065550111");
  assert.equal(rows[0]?.msgId, "offline-sms-1001");
  assert.equal(rows[0]?.content, "Your verification code is 246810");
  assert.equal(rows[0]?.type, 25);
  assert.equal(rows[0]?.data1, "+12065550111");
  assert.equal(rows[0]?.data3, "direct-web-offline");
});

test("extracts the usable text from non-team JSON and MMS-like envelopes", () => {
  const rows = normalizeDirectWebOfflineMessages({
    data: {
      offlineMessages: [
        {
          content: JSON.stringify({ content: "Photo received", mediaUrl: "https://invalid.example/image.jpg" }),
          from: "+447700900123",
          id: "offline-mms-1002",
          timestamp: 1_800_000_004,
          type: 26
        }
      ]
    }
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.conversationType, 1);
  assert.equal(rows[0]?.senderId, "+447700900123");
  assert.equal(rows[0]?.msgId, "offline-mms-1002");
  assert.equal(rows[0]?.content, "Photo received");
  assert.equal(rows[0]?.type, 26);
});

test("renders TalkU secretary boss-push envelopes as readable team messages", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        content: JSON.stringify({
          schemaType: 4,
          pushContent: "Please verify your identity",
          body: { showStyle: 1 }
        }),
        from: "2684354560",
        msgId: "boss-push-schema-4",
        msgType: 3300,
        msgTimeStamp: 1_800_000_005
      }
    ]
  }, "dingtone");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.conversationType, 4);
  assert.equal(rows[0]?.conversationId, "10000");
  assert.equal(rows[0]?.senderId, "说道团队");
  assert.equal(rows[0]?.content, "Please verify your identity");
  assert.equal(rows[0]?.type, 3300);
});

test("keeps purchased-number credit deductions inside the TalkU team conversation", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [{
      msgContent: "+61 4800000123:1500",
      msgSenderID: "2684354560",
      msgId: "purchase-secretary-au",
      msgType: 1048578,
      msgTimeStamp: 1_800_000_006
    }]
  }, "dingtone");

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.conversationId, "10000");
  assert.equal(rows[0]?.senderId, "说道团队");
  assert.equal(rows[0]?.content, "+61 4800000123:1500");
  assert.equal(rows[0]?.type, 1048578);
});

test("does not mix non-secretary web offer messages into the team conversation", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        content: JSON.stringify({ OfName: "offer", content: "Free credits available", credits: 4 }),
        from: "100000000000002",
        msgId: "offer-1001",
        msgType: 29,
        timestamp: 1_800_000_300
      }
    ]
  }, "dingtone");

  assert.equal(rows.length, 0);
});

test("hard-excludes type 29 offers even when they use a known team name and credit metadata", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        msgTitle: "TalkU Team",
        content: JSON.stringify({ content: "Free credits available", credits: 4 }),
        msgMeta: JSON.stringify({ k1: 531, credits: 4, type: 99 }),
        from: "TalkU Team",
        msgId: "offer-team-name-1002",
        msgType: 29,
        timestamp: 1_800_000_301
      }
    ]
  }, "dingtone");

  assert.deepEqual(rows, []);
});

test("prioritizes envelope msgMeta then data2 then args and params per metadata field", () => {
  const preferred = parseTeamMessageMeta(
    JSON.stringify({
      msgMeta: JSON.stringify({ k1: 531, credits: 20, type: 34 }),
      args: { type: 99, params: { k1: 532, credits: 4, ex: -1, type: 5 } }
    }),
    JSON.stringify({ k1: 532, credits: 10, ex: 90, type: 5 })
  );

  assert.equal(preferred.k1, 531);
  assert.equal(preferred.actionType, 34);
  assert.equal(preferred.credits, 20);
  assert.equal(preferred.expiryDays, 90);

  const fallback = parseTeamMessageMeta(
    JSON.stringify({
      msgMeta: JSON.stringify({ k1: 531 }),
      args: { type: 34, params: { k1: 532, credits: 4, ex: -1, type: 5 } }
    }),
    JSON.stringify({ credits: 10 })
  );

  assert.equal(fallback.k1, 531);
  assert.equal(fallback.actionType, 34);
  assert.equal(fallback.credits, 10);
  assert.equal(fallback.expiryDays, -1);
});

test("safely bounds deeply nested, cyclic, and malformed team metadata", () => {
  const deep: Record<string, unknown> = { k1: 531, credits: 4, type: 99 };
  let cursor = deep;
  for (let index = 0; index < 20_000; index += 1) {
    const params: Record<string, unknown> = {};
    cursor.params = params;
    cursor = params;
  }

  const parseDeepMeta = () => parseTeamMessageMeta(deep);
  assert.doesNotThrow(parseDeepMeta);
  const deepMeta = parseDeepMeta();
  assert.equal(deepMeta.k1, 531);
  assert.equal(deepMeta.credits, 4);

  const cyclic: Record<string, unknown> = { k1: 532, credits: 0.5, type: 5 };
  cyclic.args = cyclic;
  const parseCyclicMeta = () => parseTeamMessageMeta(cyclic);
  assert.doesNotThrow(parseCyclicMeta);
  const cyclicMeta = parseCyclicMeta();
  assert.equal(cyclicMeta.k1, 532);
  assert.equal(cyclicMeta.credits, 0.5);

  assert.doesNotThrow(() => parseTeamMessageMeta("{bad-json", "{also-bad"));
  assert.equal(parseTeamMessageMeta("{bad-json").credits, null);
});

test("rejects negative and implausibly large team credit amounts", () => {
  for (const credits of [-0.01, 1_000_000.01]) {
    assert.equal(parseTeamMessageMeta({ k1: 531, credits, type: 99 }).credits, null);
    assert.equal(renderTeamMessageContent({
      content: JSON.stringify({ msgMeta: JSON.stringify({ k1: 531, credits, type: 99 }) }),
      type: 531
    }, "dingtone"), null);
  }
});

test("delivers each web-offline message only once after a successful callback", async () => {
  const tracker = createDirectWebOfflineDeliveryTrackerForTest(3);
  const delivered: string[][] = [];
  const callback = async (messages: Array<{ msgId?: string }>) => {
    delivered.push(messages.map((message) => message.msgId ?? "missing"));
  };
  const firstBatch = [
    { msgId: "team-1", content: "First", timestamp: 1 },
    { msgId: "team-2", content: "Second", timestamp: 2 }
  ];

  await deliverDirectWebOfflineMessagesForTest(firstBatch, "host-a", callback, tracker);
  await deliverDirectWebOfflineMessagesForTest(firstBatch, "host-a", callback, tracker);
  await deliverDirectWebOfflineMessagesForTest(
    [...firstBatch, { msgId: "team-3", content: "Third", timestamp: 3 }],
    "host-a",
    callback,
    tracker
  );

  assert.deepEqual(delivered, [["team-1", "team-2"], ["team-3"]]);
});

test("retries web-offline messages when the delivery callback fails", async () => {
  const tracker = createDirectWebOfflineDeliveryTrackerForTest();
  const batch = [{ msgId: "team-retry", content: "Retry", timestamp: 4 }];
  let attempts = 0;
  const callback = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("store failed");
    }
  };

  await assert.rejects(
    deliverDirectWebOfflineMessagesForTest(batch, "host-a", callback, tracker),
    /store failed/
  );
  await deliverDirectWebOfflineMessagesForTest(batch, "host-a", callback, tracker);

  assert.equal(attempts, 2);
});

test("bounds the web-offline delivery cache and falls back to a stable signature", async () => {
  const tracker = createDirectWebOfflineDeliveryTrackerForTest(2);
  const delivered: string[][] = [];
  const callback = async (messages: Array<{ content: string }>) => {
    delivered.push(messages.map((message) => message.content));
  };

  await deliverDirectWebOfflineMessagesForTest(
    [
      { content: "First", senderId: "team", timestamp: 1 },
      { content: "Second", senderId: "team", timestamp: 2 }
    ],
    "host-a",
    callback,
    tracker
  );
  await deliverDirectWebOfflineMessagesForTest(
    [{ content: "Third", senderId: "team", timestamp: 3 }],
    "host-a",
    callback,
    tracker
  );
  await deliverDirectWebOfflineMessagesForTest(
    [{ content: "First", senderId: "team", timestamp: 1 }],
    "host-a",
    callback,
    tracker
  );

  assert.deepEqual(delivered, [["First", "Second"], ["Third"], ["First"]]);
});

test("delivers large offline responses in bounded batches", async () => {
  const tracker = createDirectWebOfflineDeliveryTrackerForTest(500);
  const batchSizes: number[] = [];
  const messages = Array.from({ length: 205 }, (_, index) => ({
    msgId: `offline-${index}`,
    content: `Message ${index}`,
    timestamp: index + 1
  }));

  await deliverDirectWebOfflineMessagesForTest(messages, "host-a", async (batch) => {
    batchSizes.push(batch.length);
  }, tracker);

  assert.deepEqual(batchSizes, [100, 100, 5]);
});

test("bounds concurrent account catch-up work and deterministically staggers safety sweeps", async () => {
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 9 }, async () => {
    await withDirectOfflineCatchupPermitForTest(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
  }));

  assert.equal(maximum, 3);
  const first = directOfflineCatchupDelayMsForTest("100000000000002");
  assert.equal(first, directOfflineCatchupDelayMsForTest("100000000000002"));
  assert.ok(first >= 10 * 60_000);
  assert.ok(first < 11 * 60_000);
});

test("treats closed direct sockets as reconnectable failures instead of empty listens", () => {
  assert.equal(isSocketClosedError(new Error("Direct gateway socket closed while waiting for direct push frame")), true);
  assert.equal(isSocketClosedError(new Error("Cannot call write after a stream was destroyed")), true);
  assert.equal(isSocketClosedError(new Error("write ECONNABORTED")), true);
  assert.equal(isSocketClosedError(new Error("Timed out waiting for direct push frame")), false);
});
