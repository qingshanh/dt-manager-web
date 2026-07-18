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
  const metadata = Buffer.from("sender=16699998659 target=33199000001", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(669) 999-8659", info: metadata, k3: "target-regression" }), "utf8");
  const content = Buffer.from("Your verification code is 135790", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), content]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.fromNumber, "(669) 999-8659");
  assert.equal(parsed?.toNumber, "33199000001");
});

test("direct SMS parser restores a truncated international sender from metadata", () => {
  const metadata = Buffer.from("sender=33199001234 target=61415550123", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(319) 900-1234", info: metadata, k3: metadata }), "utf8");
  const content = Buffer.from("7141352", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), content]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.fromNumber, "33199001234");
  assert.equal(parsed?.toNumber, "61415550123");
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
  const metadata = Buffer.from("\u0004dtId\u0009170530439\u0003who\u000918185550123", "utf8");
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
  const metadata = Buffer.from("target=61415550123", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "Unverified", info: metadata, k3: "unverified-provider-regression" }), "utf8");
  const content = Buffer.from("[SiliconFlow]Verification code is: 306497, valid for 5 minutes.", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), content]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.fromNumber, "SiliconFlow");
  assert.equal(parsed?.toNumber, "61415550123");
});

test("direct SMS parser prefers the binary envelope recipient over a trailing numeric id", () => {
  const lp = (value: string) => {
    const body = Buffer.from(value, "latin1");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    return Buffer.concat([length, body]);
  };
  const sender = "18185550101";
  const target = "61415550123";
  const unrelatedId = "32465550199";
  const prefix = Buffer.from("06000000af2c3d6a00000800001102", "hex");
  const control = Buffer.from("02040000000000000000", "hex");
  const info = Buffer.concat([prefix, lp(sender), lp(target), control, lp(unrelatedId), Buffer.alloc(16)]).toString("base64");
  const k3 = Buffer.concat([prefix, lp(sender), lp(target), control, Buffer.alloc(16)]).toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(818) 555-0101", info, k3, k5: 0 }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("PLAIN_AU_ROUTE_TEST")]);

  assert.equal(parseSmsPush(payload)?.toNumber, target);
});

test("direct SMS parser leaves target empty when binary info and k3 recipients disagree", () => {
  const envelope = (target: string) => {
    const lp = (value: string) => {
      const body = Buffer.from(value, "latin1");
      const length = Buffer.alloc(4);
      length.writeUInt32LE(body.length);
      return Buffer.concat([length, body]);
    };
    const prefix = Buffer.from("06000000af2c3d6a00000800001102", "hex");
    return Buffer.concat([prefix, lp("18185550101"), lp(target), Buffer.alloc(16)]).toString("base64");
  };
  const json = Buffer.from(JSON.stringify({
    k1: 561,
    k2: "(818) 555-0101",
    info: envelope("61415550123"),
    k3: envelope("32465550199")
  }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("CONFLICTING_TARGET")]);

  assert.equal(parseSmsPush(payload)?.toNumber, null);
});

test("direct SMS parser leaves target empty when binary info conflicts with an explicit k3 recipient", () => {
  const lp = (value: string) => {
    const body = Buffer.from(value, "latin1");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    return Buffer.concat([length, body]);
  };
  const prefix = Buffer.from("06000000af2c3d6a00000800001102", "hex");
  const info = Buffer.concat([prefix, lp("18185550101"), lp("61415550123"), Buffer.alloc(16)]).toString("base64");
  const k3 = Buffer.from("recipient=32465550199", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(818) 555-0101", info, k3 }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("MIXED_TARGET_CONFLICT")]);

  assert.equal(parseSmsPush(payload)?.toNumber, null);
});

test("direct SMS parser leaves target empty when explicit info conflicts with a binary k3 recipient", () => {
  const lp = (value: string) => {
    const body = Buffer.from(value, "latin1");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    return Buffer.concat([length, body]);
  };
  const prefix = Buffer.from("06000000af2c3d6a00000800001102", "hex");
  const info = Buffer.from("target=61415550123", "latin1").toString("base64");
  const k3 = Buffer.concat([prefix, lp("18185550101"), lp("32465550199"), Buffer.alloc(16)]).toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(818) 555-0101", info, k3 }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("REVERSED_MIXED_TARGET_CONFLICT")]);

  assert.equal(parseSmsPush(payload)?.toNumber, null);
});

test("direct SMS parser leaves target empty when metadata has no explicit recipient label", () => {
  const info = Buffer.from("sender=18185550101 alpha=61415550123 beta=32465550199", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(818) 555-0101", info }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("AMBIGUOUS_TARGET")]);

  assert.equal(parseSmsPush(payload)?.toNumber, null);
});

test("direct SMS parser does not treat the end of photo as an explicit to label", () => {
  const info = Buffer.from("photo=61415550123", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(818) 555-0101", info }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("FALSE_TO_LABEL")]);

  assert.equal(parseSmsPush(payload)?.toNumber, null);
});

test("direct SMS parser does not treat notrecipient as an explicit recipient label", () => {
  const info = Buffer.from("notrecipient=32465550199", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(818) 555-0101", info }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("FALSE_RECIPIENT_LABEL")]);

  assert.equal(parseSmsPush(payload)?.toNumber, null);
});

test("direct SMS parser rejects a 16-digit explicit target instead of truncating it", () => {
  const info = Buffer.from("target=6141555012345678", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(818) 555-0101", info }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("OVERSIZED_TARGET")]);

  assert.equal(parseSmsPush(payload)?.toNumber, null);
});

test("direct SMS parser rejects a longer explicit recipient instead of truncating it", () => {
  const info = Buffer.from("recipient=32465550199123456789", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(818) 555-0101", info }));
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), Buffer.from("LONG_OVERSIZED_TARGET")]);

  assert.equal(parseSmsPush(payload)?.toNumber, null);
});
