import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../../../..");
const realGatewaySource = readFileSync(path.join(testDir, "real-gateway.ts"), "utf8");
const helperSource = readFileSync(path.join(projectRoot, "backend/helper/frida_agent.js"), "utf8");

function functionBody(source: string, name: string, nextName: string) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test("real gateway forwards the stored phone renewal context to the native helper", () => {
  const start = realGatewaySource.indexOf("  async renewPhoneNumber(");
  const end = realGatewaySource.indexOf("  async updatePhoneNumberLabel(", start);
  const body = realGatewaySource.slice(start, end);

  assert.match(body, /phone\?: Partial<DingtonePhoneNumber>/);
  assert.match(body, /callBridge\("renew_phone_number", \{ account, phoneNumber, phone \}\)/);
});

test("native helper uses the App standard renewal method for a three-month phone", () => {
  const body = functionBody(helperSource, "handleRenewPhoneNumber", "handleRequestPhoneNumberViaActivity");

  assert.match(body, /resolveHelperPhoneRenewalMonths\(input, freshItem\)/);
  assert.match(body, /orderPrivateNumberForNewOrRenew\(freshItem, specialNumber, freshItem\.getOrderPrice\(\)\)/);
  assert.doesNotMatch(body, /orderPrivatePhoneExtendMonths\(freshItem, 12, freshItem\.getOrderPrice\(\), 0, 2\)/);
});

test("native helper keeps the App yearly extension method for a twelve-month phone", () => {
  const body = functionBody(helperSource, "handleRenewPhoneNumber", "handleRequestPhoneNumberViaActivity");

  assert.match(body, /extensionMonths === 12/);
  assert.match(
    body,
    /orderPrivatePhoneExtendMonths\(freshItem, 12, freshItem\.getOrderPrice\(\), MSG_TYPE_EXTEND_PRIVATE_PHONE_SUCCEED, 2\)/
  );
});
