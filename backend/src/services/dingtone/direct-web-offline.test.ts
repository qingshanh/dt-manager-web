import assert from "node:assert/strict";
import test from "node:test";
import { isSocketClosedError, normalizeDirectWebOfflineMessages } from "./direct-gateway.js";

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
  assert.equal(rows[0]?.msgId, "web-team-1001");
  assert.equal(rows[0]?.senderId, "service-10001");
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

test("treats closed direct sockets as reconnectable failures instead of empty listens", () => {
  assert.equal(isSocketClosedError(new Error("Direct gateway socket closed while waiting for direct push frame")), true);
  assert.equal(isSocketClosedError(new Error("Cannot call write after a stream was destroyed")), true);
  assert.equal(isSocketClosedError(new Error("write ECONNABORTED")), true);
  assert.equal(isSocketClosedError(new Error("Timed out waiting for direct push frame")), false);
});
