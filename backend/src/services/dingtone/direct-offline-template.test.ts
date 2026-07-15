import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./direct-gateway.ts", import.meta.url), "utf8");

function currentOfflineTemplate() {
  const match = source.match(
    /requestAllOfflineMessage:\s*Buffer\.from\(\s*"([0-9a-f]+)"/i
  );
  assert.ok(match?.[1], "requestAllOfflineMessage template should exist");
  return Buffer.from(match[1], "hex");
}

test("built-in offline-message template has internally consistent frame lengths", () => {
  const frame = currentOfflineTemplate();

  assert.equal(frame.length, 171);
  assert.equal(frame.readUInt32BE(2), frame.length);
  assert.equal(frame.readUInt32BE(12), frame.length - 16);
  assert.equal(frame.readUInt32BE(18), frame.length - 16);
});

test("built-in offline-message template keeps fixed-width route and device fields", () => {
  const frame = currentOfflineTemplate();
  const body = frame.subarray(22);
  const dottedRoute = Buffer.from("e3.af.00.03.00.50.4b.0f", "utf8");
  const deviceId = Buffer.from("And.11111111111111111111111111111111.dttalk", "utf8");

  const routeIndex = body.indexOf(dottedRoute);
  const deviceIndex = body.indexOf(deviceId);
  assert.ok(routeIndex >= 4, "captured dotted route should exist");
  assert.ok(deviceIndex >= 4, "captured device id should exist");
  assert.equal(body.readUInt32BE(routeIndex - 4), dottedRoute.length);
  assert.equal(body.readUInt32BE(deviceIndex - 4), deviceId.length);
});
