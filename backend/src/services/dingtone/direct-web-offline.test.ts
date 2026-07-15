import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGetWebOfflineMessageFrameForTest,
  buildGetWebOfflineMessageQuery,
  createDirectWebOfflineDeliveryTrackerForTest,
  deliverDirectWebOfflineMessagesForTest,
  isSocketClosedError,
  normalizeDirectWebOfflineMessages
} from "./direct-gateway.js";
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

test("does not mix non-secretary web offer messages into the team conversation", () => {
  const rows = normalizeDirectWebOfflineMessages({
    Result: 1,
    Message: [
      {
        content: JSON.stringify({ OfName: "offer" }),
        from: "100000000000002",
        msgId: "offer-1001",
        msgType: 29,
        timestamp: 1_800_000_300
      }
    ]
  }, "dingtone");

  assert.equal(rows.length, 0);
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

test("treats closed direct sockets as reconnectable failures instead of empty listens", () => {
  assert.equal(isSocketClosedError(new Error("Direct gateway socket closed while waiting for direct push frame")), true);
  assert.equal(isSocketClosedError(new Error("Cannot call write after a stream was destroyed")), true);
  assert.equal(isSocketClosedError(new Error("write ECONNABORTED")), true);
  assert.equal(isSocketClosedError(new Error("Timed out waiting for direct push frame")), false);
});
