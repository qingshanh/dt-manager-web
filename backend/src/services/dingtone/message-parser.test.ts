import assert from "node:assert/strict";
import test from "node:test";
import { parseSmsPush } from "./message-parser.js";

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

test("direct SMS parser leaves target empty when metadata only repeats the sender", () => {
  const metadata = Buffer.from("sender=16699998659", "latin1").toString("base64");
  const json = Buffer.from(JSON.stringify({ k1: 561, k2: "(669) 999-8659", info: metadata, k3: "sender-only-regression" }), "utf8");
  const content = Buffer.from("Your verification code is 97531", "utf8");
  const payload = Buffer.concat([Buffer.from([1, 7, 0, 0]), json, Buffer.from([0]), content]);

  const parsed = parseSmsPush(payload);

  assert.equal(parsed?.toNumber, null);
});
