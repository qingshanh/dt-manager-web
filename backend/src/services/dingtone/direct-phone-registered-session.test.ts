import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runSingleWritePhoneMutationForTest } from "./direct-gateway.js";

const source = readFileSync(new URL("./direct-gateway.ts", import.meta.url), "utf8");

function methodText(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

test("phone preview and purchase use a fully registered authenticated link", () => {
  const preview = methodText("  async requestPhoneNumber(", "  async purchasePhoneNumber(");
  const purchase = methodText("  async purchasePhoneNumber(", "  async renewPhoneNumber(");
  const registeredSession = methodText("  private async withRegisteredSession", "  private async withSession");

  assert.match(preview, /this\.withRegisteredSession\(runtime, account, async \(session\) => \{/);
  assert.match(preview, /\}, 1\);/);
  assert.match(purchase, /this\.withRegisteredSession\(runtime, account, async \(session\) => \{/);
  assert.match(purchase, /isNoResponseAfterPhoneActionWrite\(error\)/);

  const openLink = registeredSession.indexOf("await session.openLink(account)");
  const register = registeredSession.indexOf("runPushLinkRegistration(session, runtime, account)");
  assert.ok(openLink >= 0);
  assert.ok(register > openLink);
  assert.match(registeredSession, /if \(!registration\.ok\) \{/);
});

test("phone renewal uses the native order RPC once on a registered link", () => {
  const renew = methodText("  async renewPhoneNumberMutation(", "  async cancelPhoneNumber(");

  assert.match(renew, /this\.withSingleWriteRegisteredSession\(runtime, account,/);
  assert.match(renew, /session\.callOrderPrivateNumberJson\(/);
  assert.match(renew, /markWritten/);
  assert.doesNotMatch(renew, /callDirectPhoneAction|callCommonRestJson|dt_direct_template_renew_phone/);
});

test("does not try another host after a phone mutation write", async () => {
  const attempts: string[] = [];
  const result = await runSingleWritePhoneMutationForTest({
    hosts: ["primary", "backup"],
    execute: async (host, markWritten) => {
      attempts.push(host);
      markWritten();
      throw new Error("socket ended after write");
    }
  });

  assert.deepEqual(attempts, ["primary"]);
  assert.equal(result.outcome, "unknown_after_write");
});

test("may try a backup host when connection fails before the write", async () => {
  const attempts: string[] = [];
  const result = await runSingleWritePhoneMutationForTest({
    hosts: ["primary", "backup"],
    execute: async (host, markWritten) => {
      attempts.push(host);
      if (host === "primary") throw new Error("connect failed");
      markWritten();
      return { Result: 1 };
    }
  });

  assert.deepEqual(attempts, ["primary", "backup"]);
  assert.equal(result.outcome, "response");
});

test("all phone mutations use the single-write path without automatic reactivation or template fallback", () => {
  for (const method of [
    "cancelPhoneNumberMutation",
    "pausePhoneNumberMutation",
    "resumePhoneNumberMutation",
    "updatePhoneNumberLabelMutation",
    "enablePhoneNumberSmsReceptionMutation"
  ]) {
    const block = methodText(`  async ${method}(`, "\n  async ");
    assert.match(block, /callSingleWritePhoneAction/);
    assert.doesNotMatch(block, /callConfiguredPhoneTemplate|callDirectPhoneAction/);
  }
  const resume = methodText("  async resumePhoneNumberMutation(", "  async updatePhoneNumberLabel(");
  assert.doesNotMatch(resume, /reactivateGoogleVoiceNumber|buildReactivateGoogleVoiceNumberQuery/);
});
