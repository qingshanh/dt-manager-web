import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("./adb-session.ts", import.meta.url), "utf8");
const previewSource = readFileSync(new URL("./adb-phone-preview.ts", import.meta.url), "utf8");
const databaseSource = readFileSync(new URL("./adb-database.ts", import.meta.url), "utf8");

test("ADB phone readers reject a local App session owned by another account", () => {
  assert.match(sessionSource, /export function assertAdbSessionMatchesExpectedUser/);
  assert.match(sessionSource, /session\.dtUserId !== expectedDtUserId/);
  assert.match(sessionSource, /does not match the requested account/);

  assert.match(previewSource, /expectedDtUserId: string/);
  assert.match(previewSource, /assertAdbAppSessionMatchesExpectedUser\(variant, expectedDtUserId\)/);

  assert.match(databaseSource, /listPhoneNumbersFromAdb\([\s\S]*?expectedDtUserId: string/);
  assert.match(databaseSource, /assertAdbAppSessionMatchesExpectedUser\(variant, expectedDtUserId\)/);
});
