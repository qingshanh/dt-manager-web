import assert from "node:assert/strict";
import test from "node:test";
import {
  extractRtcServerHostsForTest,
  isExpectedTemplateJsonPayloadForTest
} from "./direct-gateway.js";

test("queryRtcServersEx rejects unrelated JSON payloads without a track code", () => {
  assert.equal(
    isExpectedTemplateJsonPayloadForTest("queryRtcServersEx", {
      ErrCode: 0,
      Result: 1,
      api_name: "update_client_link"
    }),
    false
  );
});

test("queryRtcServersEx accepts the real RTC response and extracts its hosts", () => {
  const payload = {
    ErrCode: 0,
    Result: 1,
    api_name: "query_rtc_servers_ex",
    server_list: [
      { addr: 12292, ip: "101.133.141.94" },
      { addr: 16403, ip: "18.167.161.7" }
    ]
  };

  assert.equal(isExpectedTemplateJsonPayloadForTest("queryRtcServersEx", payload), true);
  assert.deepEqual(extractRtcServerHostsForTest(payload), ["101.133.141.94", "18.167.161.7"]);
});

test("RTC host extraction ignores invalid addresses and removes duplicates", () => {
  assert.deepEqual(
    extractRtcServerHostsForTest({
      data: {
        server_list: [
          { ip: "18.167.161.7" },
          { server_ip: "18.167.161.7" },
          { host: "999.1.1.1" },
          { host: "not-an-ip" }
        ]
      }
    }),
    ["18.167.161.7"]
  );
});
