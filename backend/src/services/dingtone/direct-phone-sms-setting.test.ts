import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildPrivateNumberSettingJson } from "./direct-gateway.js";

const accountsRouteSource = readFileSync(new URL("../../routes/accounts.ts", import.meta.url), "utf8");
const accountDetailSource = readFileSync(new URL("../../../../frontend/src/pages/AccountDetail.tsx", import.meta.url), "utf8");

test("private number setting enables SMS without discarding existing filter settings", () => {
  const setting = buildPrivateNumberSettingJson(
    {
      phoneNumber: "12025550101",
      displayName: "US",
      status: "active",
      isPrimary: false,
      autoRenew: true,
      rawJson: JSON.stringify({
        faxEnabled: 1,
        slientFlag: 1,
        suspendFlag: 0,
        callForwardFlag: false,
        forwardNumber: "",
        forwardCountryCode: 0,
        forwardDestCode: 0,
        autoSMSReply: 0,
        useVoicemail: 0,
        voicemailId: "",
        autoSMSContent: "",
        defaultGreetings: 0,
        filterSetting: {
          useBlock: 1,
          callBlockSetting: 2,
          callBlockHandle: 3,
          allowReceiveSMS: false,
          blockNumberList: ["encrypted-number"]
        }
      })
    },
    { allowReceiveSms: true }
  );

  assert.equal(setting.phoneNumber, "12025550101");
  assert.equal(setting.primaryFlag, 0);
  assert.equal(setting.faxEnabled, 1);
  assert.equal(setting.slientFlag, 1);
  assert.equal("silentFlag" in setting, false);
  assert.equal(setting.suspendFlag, 0);
  assert.deepEqual(setting.filterSetting, {
    useBlock: 1,
    callBlockSetting: 2,
    callBlockHandle: 3,
    allowReceiveSMS: true,
    blockNumberList: ["encrypted-number"]
  });
});

test("SMS reception repair only targets numbers explicitly confirmed as disabled", () => {
  assert.match(accountsRouteSource, /phone\.allowReceiveSms === false/);
  assert.doesNotMatch(accountsRouteSource, /phone\.allowReceiveSms !== true/);
});

test("SMS reception repair queues durable operations and returns split diagnostics", () => {
  const handler = accountsRouteSource.slice(
    accountsRouteSource.indexOf('accountsRouter.post("/:id/phone-numbers/enable-sms-reception"'),
    accountsRouteSource.indexOf('accountsRouter.post("/:id/phone-numbers/:phoneId/force-enable-sms"')
  );
  assert.match(handler, /phoneActionCoordinator\.execute/);
  assert.match(handler, /operations,/);
  assert.match(handler, /diagnostics,/);
  assert.doesNotMatch(handler, /refreshDirectPhoneSmsSettings|monitor_restarted/);
  assert.match(accountsRouteSource, /routing_status: diagnostic\.routingStatus/);
  assert.match(accountsRouteSource, /listener_status: diagnostic\.listenerStatus/);
  assert.match(accountsRouteSource, /delivery_evidence: diagnostic\.deliveryEvidence/);
});

test("frontend labels the App filter separately from actual delivery diagnostics", () => {
  assert.match(accountDetailSource, /短信过滤项未返回/);
  assert.match(accountDetailSource, /不等同于服务商短信通道状态/);
  assert.match(accountDetailSource, /短信接收诊断\/修复/);
  assert.doesNotMatch(accountDetailSource, /短信设置未确认/);
});
