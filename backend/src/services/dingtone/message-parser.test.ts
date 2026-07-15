import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { isOfflineMessageIndexPush, parseSmsPush } from "./message-parser.js";

test("direct push metadata identifies k1=8 offline-message index notifications", () => {
  const metadata = Buffer.from(JSON.stringify({ info: "index-notification", k1: 8 }), "utf8");
  const payload = Buffer.concat([
    Buffer.from("01070000", "hex"),
    zlib.deflateSync(metadata),
    Buffer.from("\u0004dtId\u0009123456789\u0003who\u0009123456789", "utf8"),
  ]);

  assert.equal(isOfflineMessageIndexPush(payload), true);
});

test("direct push metadata identifies plaintext k1=8 offline-message index notifications", () => {
  const metadata = Buffer.from(JSON.stringify({ info: "index-notification", k1: 8 }), "utf8");
  const payload = Buffer.concat([
    Buffer.from([0, 0, 0, metadata.length]),
    metadata,
    Buffer.from("\u0004dtId\u0009123456789\u0003who\u0009123456789", "utf8"),
  ]);

  assert.equal(isOfflineMessageIndexPush(payload), true);
});

test("direct push metadata does not classify k1=561 SMS frames as index notifications", () => {
  const metadata = Buffer.from(JSON.stringify({ info: "sms", k1: 561, k2: "SiliconFlow" }), "utf8");
  const payload = Buffer.concat([
    Buffer.from("01070000", "hex"),
    zlib.deflateSync(metadata),
    Buffer.from("Verification code is 246810", "utf8"),
  ]);

  assert.equal(isOfflineMessageIndexPush(payload), false);
});

test("direct SMS parser trims trailing push metadata from plaintext content", () => {
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(669) 999-8659", k3: "meta-regression" }), "utf8");
  const content = Buffer.from("Your verification code is 246810", "utf8");
  const metadata = Buffer.from(
    '\u0002\u0004dtId 100000001\u0003who 100000001 devfilter7{"only":"And.0123456789abcdef0123456789abcdef.dttalk"}\u0006orgsrc\u0017f3.79.00.00.01.01.54.cf{"statusOff":"0"}',
    "utf8"
  );
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), content, metadata]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.content, "Your verification code is 246810");
});
test("direct SMS parser does not use the sender number as the target phone", () => {
  const metadata = Buffer.from("sender=16699998659 target=33755520480", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(669) 999-8659", info: metadata, k3: "target-regression" }), "utf8");
  const content = Buffer.from("Your verification code is 135790", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), content]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.fromNumber, "(669) 999-8659");
  assert.equal(parsed?.toNumber, "33755520480");
});

test("direct SMS parser restores a truncated international sender from metadata", () => {
  const metadata = Buffer.from("sender=33199001234 target=61491570006", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(319) 900-1234", info: metadata, k3: metadata }), "utf8");
  const content = Buffer.from("7141352", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), content]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.fromNumber, "33199001234");
  assert.equal(parsed?.toNumber, "61491570006");
});

test("direct SMS parser leaves target empty when metadata only repeats the sender", () => {
  const metadata = Buffer.from("sender=16699998659", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(669) 999-8659", info: metadata, k3: "sender-only-regression" }), "utf8");
  const content = Buffer.from("Your verification code is 97531", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), content]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.toNumber, null);
});

test("direct SMS parser strips one-byte length prefix before provider text", () => {
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(833) 858-1657", k3: "length-prefix-regression" }), "utf8");
  const content = Buffer.from("?<SiliconFlow?> Verification code is: 552420, valid for 5 minutes.", "utf8");
  const metadata = Buffer.from("\u0004dtId\u0009170530439\u0003who\u000918188815435", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0, content.length]), content, metadata]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.content, "[硅基流动] Verification code is: 552420, valid for 5 minutes.");
});

test("direct SMS parser strips one-byte length prefix before Chinese provider text", () => {
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "Anster", k3: "length-prefix-chinese-regression" }), "utf8");
  const content = Buffer.from("[硅基流动]Verification code is: 521153, valid for 5 minutes.", "utf8");
  const metadata = Buffer.from("\u0004dtId\u0009170530439\u0003who\u0009447897076036", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0, content.length]), content, metadata]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.content, "[硅基流动]Verification code is: 521153, valid for 5 minutes.");
});
test("direct SMS parser does not use a UK sender when metadata repeats it without country code", () => {
  const metadata = Buffer.from("sender=7700900124", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "+447700900124", info: metadata, k3: "uk-sender-only-regression" }), "utf8");
  const content = Buffer.from("Your verification code is 246810", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), content]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.toNumber, null);
});
test("direct SMS parser recovers provider label when the gateway sender is Unverified", () => {
  const metadata = Buffer.from("target=61491570006", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "Unverified", info: metadata, k3: "unverified-provider-regression" }), "utf8");
  const content = Buffer.from("[SiliconFlow]Verification code is: 306497, valid for 5 minutes.", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), content]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.fromNumber, "SiliconFlow");
  assert.equal(parsed?.toNumber, "61491570006");
});
