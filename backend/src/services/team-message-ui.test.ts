import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./adb-message-ui.ts", import.meta.url), "utf8");

test("ADB UI message scraping keeps TalkU and Dingdong team conversations", () => {
  assert.match(source, /function isLikelySmsConversation/);
  assert.match(source, /talku team\|dingtone team\|dingdong team/i);
  assert.match(source, /private number order\|number order succeeded\|will expire/i);
});