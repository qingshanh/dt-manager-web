import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildPrivateNumberSettingJson } from "./direct-gateway.js";

const accountsRouteSource = readFileSync(new URL("../../routes/accounts.ts", import.meta.url), "utf8");

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
        callForwardFlag: false,
        filterSetting: {
          useBlock: 1,
          callBlockSetting: 2,
          callBlockHandle: 3,
          allowReceiveSMS: false,
          blockNumberList: ["encrypted-number"]
        }
      })
    },
    0
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

test("SMS reception repair also targets numbers whose remote switch is unknown", () => {
  assert.match(accountsRouteSource, /phone\.allowReceiveSms !== true/);
});
