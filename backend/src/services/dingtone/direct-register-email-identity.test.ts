import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";

import {
  buildRegisterEmailClientInfoForTest,
  buildRegisterEmailQueryAttemptsForTest,
  buildRegisterEmailTemplateParamsForTest,
  buildDirectRuntimeConfigForTest,
  buildTemplateSendFrameForTest,
  callDirectEmailVerificationSequenceForTest,
  patchQueryForTest,
  registerEmailIdentityAttemptsForVariant
} from "./direct-gateway.js";

function u32be(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

test("registerEmail defaults to the direct raw transport when no override is configured", () => {
  const runtime = buildDirectRuntimeConfigForTest({
    dt_server_port: "443",
    dt_direct_use_tls: "false"
  });

  assert.equal(runtime.port, 443);
  assert.equal(runtime.useTls, false);
  assert.equal(runtime.registerEmailPort, 443);
  assert.equal(runtime.registerEmailUseTls, false);
});

test("uses the single app identity encoded by the native registerEmail request", () => {
  const attempts = registerEmailIdentityAttemptsForVariant("dingdong");

  assert.deepEqual(attempts, [
    {
      appId: "me.dingtone.im",
      clientInfoAppId: "me.dingtone.app.im",
      includeTopLevelAppId: false
    }
  ]);
});

test("does not append top-level appType/appId fields absent from the native encoder", () => {
  const templateQuery = "deviceId=old&TrackCode=old&json=%7B%7D&clientInfo=%7B%7D";
  const params = buildRegisterEmailTemplateParamsForTest(
    "deviceId=next&appType=2&appId=me.dingtone.app.im&TrackCode=track&json=%7B%7D&clientInfo=%7B%7D"
  );

  const patched = patchQueryForTest(templateQuery, params);

  assert.doesNotMatch(patched, /(?:^|&)appType=/);
  assert.doesNotMatch(patched, /(?:^|&)appId=/);
});

test("preserves native registerCommon control fields while patching the compressed query", () => {
  const api = Buffer.from("registerCommon");
  const query = "deviceId=old&TrackCode=268451843&json=%7B%7D&clientInfo=%7B%7D";
  const compressed = zlib.deflateSync(Buffer.from(query));
  const body = Buffer.concat([
    Buffer.alloc(64),
    u32be(8),
    u32be(849),
    u32be(0),
    u32be(api.length),
    api,
    u32be(Buffer.byteLength(query)),
    u32be(compressed.length),
    compressed
  ]);
  const template = Buffer.alloc(22 + body.length);
  template.writeUInt32BE(template.length, 2);
  body.copy(template, 22);

  const frame = buildTemplateSendFrameForTest(template, {
    deviceId: "And.00000000000000000000000000000000",
    TrackCode: "7309027323748355",
    json: "{}",
    clientInfo: "{}"
  });
  const apiOffset = frame.indexOf(api);

  assert.ok(apiOffset > 16);
  assert.equal(frame.readUInt32BE(apiOffset - 16), 8);
  assert.equal(frame.readUInt32BE(apiOffset - 12), 849);
  assert.equal(frame.readUInt32BE(apiOffset - 8), 0);
  assert.equal(frame.readUInt32BE(apiOffset - 4), api.length);
});

test("registerEmail clientInfo matches the captured DTSystemContext field shape", () => {
  const clientInfo = JSON.parse(buildRegisterEmailClientInfoForTest(
    {
      appVariant: "dingtone",
      deviceId: "And.00000000000000000000000000000000.dttalk"
    } as any,
    {
      appVersion: "6.3.1",
      dingdongAppVersion: "6.5.0",
      apkCertificateSign: "unused"
    } as any,
    "me.talkyou.app.im"
  ));

  assert.equal(clientInfo.appId, "me.talkyou.app.im");
  assert.equal(clientInfo.deviceId, "And.00000000000000000000000000000000.dttalk");
  assert.equal(clientInfo.osVersion, "9");
  assert.equal(Object.hasOwn(clientInfo, "signMd5"), false);
  assert.equal(Object.hasOwn(clientInfo, "deviceOSVer"), false);
  assert.equal(Object.hasOwn(clientInfo, "deviceOSVersion"), false);
});

test("registerEmail always patches the captured resend counter to a fresh request", () => {
  const [query] = buildRegisterEmailQueryAttemptsForTest(
    {
      appVariant: "dingtone",
      deviceId: "And.00000000000000000000000000000000.dttalk",
      trackCode: "6701025728065539"
    } as any,
    {
      appVersion: "6.3.1",
      dingdongAppVersion: "6.5.0",
      apkCertificateSign: "unused"
    } as any,
    "placeholder@example.invalid"
  );

  assert.equal(new URLSearchParams(query).get("noCode"), "0");
});

test("registerEmail uses the captured ClientVersion for each app variant", () => {
  const runtime = {
    appVersion: "6.3.1",
    dingdongAppVersion: "6.5.0",
    apkCertificateSign: "unused"
  } as any;
  const talkuQuery = buildRegisterEmailQueryAttemptsForTest(
    {
      appVariant: "dingtone",
      deviceId: "And.00000000000000000000000000000000.dttalk",
      trackCode: "6701025728065539"
    } as any,
    runtime,
    "placeholder@example.invalid"
  )[0]!;
  const dingdongQuery = buildRegisterEmailQueryAttemptsForTest(
    {
      appVariant: "dingdong",
      deviceId: "And.00000000000000000000000000000000",
      trackCode: "6701025728065539"
    } as any,
    runtime,
    "placeholder@example.invalid"
  )[0]!;

  assert.equal(JSON.parse(new URLSearchParams(talkuQuery).get("json")!).ClientVersion, -1610218751);
  assert.equal(JSON.parse(new URLSearchParams(dingdongQuery).get("json")!).ClientVersion, -1610218240);
});

test("checkActivatedUser and registerEmail share one activation session", async () => {
  const calls: string[] = [];
  let clientInfoTrackCode: string | null = null;
  let lookupTrackCode: string | null = null;
  let lookupQuery: string | null = null;
  let registerTrackCode: string | null = null;
  const runtime = {
    primaryHost: "primary.example",
    backupHost: "backup.example",
    port: 443,
    useTls: false,
    appVersion: "6.3.1",
    dingdongAppVersion: "6.5.0",
    apkCertificateSign: "unused"
  } as any;
  const session = {
    async openActivation() {
      calls.push("open");
    },
    async callCommonRestJson(_label: string, apiName: string, query: string) {
      if (apiName === "clientInfo") {
        calls.push("clientInfo");
        clientInfoTrackCode = new URLSearchParams(query).get("TrackCode");
        return { Result: 1, TrackCode: clientInfoTrackCode };
      }
      calls.push("check");
      lookupQuery = query;
      lookupTrackCode = new URLSearchParams(query).get("TrackCode");
      return { Result: 1, UserID: "123" };
    },
    async callConfiguredRegisterEmailTemplate(_label: string, _deviceId: string, params: Record<string, unknown>) {
      calls.push("register");
      registerTrackCode = String(params.TrackCode);
      return { Result: 1 };
    },
    async close() {
      calls.push("close");
    }
  };

  const result = await callDirectEmailVerificationSequenceForTest(
    runtime,
    {
      loginType: "email_code",
      appVariant: "dingdong",
      email: "placeholder@example.invalid",
      deviceId: "And.00000000000000000000000000000000",
      trackCode: "6701025728065539"
    } as any,
    "placeholder@example.invalid",
    {
      hostCandidates: () => ["primary.example"],
      createSession: (selectedRuntime, host) => {
        assert.equal(selectedRuntime, runtime);
        assert.equal(host, "primary.example");
        return session as any;
      }
    }
  );

  assert.deepEqual(calls, ["open", "clientInfo", "check", "register", "close"]);
  assert.equal(clientInfoTrackCode, "6701025728057344");
  assert.equal(lookupTrackCode, "6701025728065539");
  const lookupParams = new URLSearchParams(lookupQuery!);
  assert.deepEqual([...lookupParams.keys()], ["deviceId", "TrackCode", "appId", "apiVersion", "json"]);
  assert.equal(lookupParams.get("deviceId"), "And.00000000000000000000000000000000");
  assert.equal(lookupParams.get("appId"), "me.dingtone.im");
  assert.equal(lookupParams.get("apiVersion"), "2");
  assert.equal(registerTrackCode, "6701025728069635");
  assert.equal(result.nextTrackCode, "6701025728073731");
  assert.equal(result.payload.Result, 1);
  assert.equal(result.activatedUser?.dtUserId, "123");
});
