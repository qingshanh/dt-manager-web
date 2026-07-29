import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as directGatewayModule from "./direct-gateway.js";
import {
  calculateDirectPairedKeepaliveDelayForTest,
  createDirectTrackCodeGeneratorForTest,
  createDirectCallbackErrorForTest,
  createDirectRouteCoordinatorForTest,
  directTrackCodesMatchForTest,
  findDirectBootstrapErrorForTest,
  isDirectTransportErrorForTest
} from "./direct-gateway.js";

const source = readFileSync(new URL("./direct-gateway.ts", import.meta.url), "utf8");

test("direct message listener sends startup offline catch-up only after the route is registered", () => {
  const ensureStart = source.indexOf("const ensureLinkSession = async () =>");
  const ensureEnd = source.indexOf("const handlePairedFrame = async", ensureStart);
  const ensureText = ensureStart >= 0 && ensureEnd > ensureStart ? source.slice(ensureStart, ensureEnd) : "";
  const registration = ensureText.indexOf("linkOwnsRoute = await ensureRouteRegistration(linkSession)");
  const ownerGuard = ensureText.indexOf("if (!linkOwnsRoute)");
  const startupCatchup = ensureText.indexOf('requestOfflineCatchup(linkSession, host, "startup")');
  const maintenance = ensureText.indexOf("runPushMaintenanceCalls(linkSession, runtime, input.account)");
  assert.ok(registration >= 0);
  assert.ok(ownerGuard > registration);
  assert.ok(startupCatchup > registration);
  assert.ok(startupCatchup > ownerGuard);
  assert.ok(maintenance > startupCatchup);
  assert.match(ensureText, /if \(!linkOwnsRoute\) \{\s*return linkSession;\s*\}/);
  assert.match(ensureText, /if \(linkOwnsRoute && !startupOfflineCatchupCompleted && Date\.now\(\) >= nextOfflineCatchupAt\)/);
  assert.match(ensureText, /startupOfflineCatchupCompleted = offlineTemplateError === null && offlineTemplateSent/);
  assert.doesNotMatch(ensureText, /offlineTemplateSendCount \+= 1/);
  assert.match(source, /nextOfflineCatchupAt/);
  assert.match(source, /reason: "startup"/);
  assert.match(source, /offlineTemplateSendCount/);
});

test("only the current route owner can run paired-link catch-up and web-offline work", () => {
  const workerStart = source.indexOf("const runPairedHostWorker = async");
  const workerEnd = source.indexOf("await Promise.allSettled(workerHosts.map(runPairedHostWorker))", workerStart);
  const workerText = workerStart >= 0 && workerEnd > workerStart ? source.slice(workerStart, workerEnd) : "";
  assert.match(workerText, /let linkOwnsRoute = false/);

  const closeStart = workerText.indexOf("const closeLinkSession = async () =>");
  const closeEnd = workerText.indexOf("const ensureRouteRegistration = async", closeStart);
  const closeText = closeStart >= 0 && closeEnd > closeStart ? workerText.slice(closeStart, closeEnd) : "";
  assert.match(closeText, /linkOwnsRoute = false/);

  const ensureStart = workerText.indexOf("const ensureLinkSession = async () =>");
  const ensureEnd = workerText.indexOf("const handlePairedFrame = async", ensureStart);
  const ensureText = ensureStart >= 0 && ensureEnd > ensureStart ? workerText.slice(ensureStart, ensureEnd) : "";
  assert.match(ensureText, /linkOwnsRoute = await ensureRouteRegistration\(linkSession\)/);
  assert.match(ensureText, /if \(!linkOwnsRoute\) \{\s*return linkSession;\s*\}/);
  assert.match(ensureText, /if \(linkOwnsRoute && !startupOfflineCatchupCompleted/);

  const handleStart = workerText.indexOf("const handlePairedFrame = async");
  const handleEnd = workerText.indexOf("const pushTransportPermit", handleStart);
  const handleText = handleStart >= 0 && handleEnd > handleStart ? workerText.slice(handleStart, handleEnd) : "";
  assert.match(handleText, /linkSession\?\.isOpen\(\)[\s\S]*&& linkOwnsRoute/);
  assert.doesNotMatch(handleText, /await ensureLinkSession\(\)/);
  assert.match(handleText, /requestOfflineCatchup\(currentLinkSession, host, "notify-only"\)/);

  const listenLoopStart = workerText.indexOf("while (!listener.preempted && isWithinCurrentListenWindow()", ensureEnd);
  const listenLoopText = listenLoopStart >= 0 ? workerText.slice(listenLoopStart) : "";
  assert.match(listenLoopText, /linkOwnsRoute = await ensureRouteRegistration\(currentLinkSession\)/);
  assert.match(listenLoopText, /if \(Date\.now\(\) >= nextOfflineCatchupAt && currentLinkSession && linkOwnsRoute\)/);
  assert.doesNotMatch(listenLoopText, /nextWebOfflinePollAt/);
});

test("push and link transports share a preemptible governor and clear only after stable route ownership", () => {
  assert.match(source, /import \{ buildDirectTransportKey, DirectTransportGovernor, type DirectTransportPermit, type DirectTransportRole \} from "\.\/direct-transport-governor\.js"/);
  assert.match(source, /const directTransportGovernor = new DirectTransportGovernor\(\)/);
  assert.match(source, /async function waitForDirectTransportPermit/);
  assert.match(source, /const transportKey = buildDirectTransportKey\(\{[\s\S]*host,[\s\S]*port: runtime\.port,[\s\S]*proxyUrl: runtime\.proxyUrl,[\s\S]*accountScope: directTransportAccountScope\(input\.account\)[\s\S]*\}\)/);
  assert.match(source, /const transportProbeOwner = \{\}/);

  const workerStart = source.indexOf("const runPairedHostWorker = async");
  const workerEnd = source.indexOf("await Promise.allSettled(workerHosts.map(runPairedHostWorker))", workerStart);
  const workerText = workerStart >= 0 && workerEnd > workerStart ? source.slice(workerStart, workerEnd) : "";
  const pushPermit = workerText.indexOf('role: "push"');
  const pushOpen = workerText.indexOf("await pushSession.openPush(input.account)");
  const linkPermit = workerText.indexOf('role: "link"');
  const linkOpen = workerText.indexOf("await linkSession.openLink(input.account)");
  assert.ok(pushPermit >= 0 && pushPermit < pushOpen);
  assert.ok(linkPermit >= 0 && linkPermit < linkOpen);
  const linkPermitText = workerText.slice(Math.max(0, linkPermit - 240), linkOpen);
  assert.match(linkPermitText, /allowLinkProbe: pushSession\.isOpen\(\)/);
  assert.equal((workerText.match(/probeOwner: transportProbeOwner/g) ?? []).length, 2);
  assert.match(source, /return permit;/);
  assert.match(source, /return null;/);
  assert.match(workerText, /let transportProbeAcquired = false/);
  assert.match(workerText, /transportProbeAcquired \|\|= .*\.probe/);
  assert.match(workerText, /finally \{[\s\S]*if \(transportProbeAcquired\) \{\s*directTransportGovernor\.abandonProbe\(transportKey, transportProbeOwner\);\s*\}/);
  assert.match(workerText, /directTransportGovernor\.recordFailure\(transportKey, "push"\)/);
  assert.match(workerText, /directTransportGovernor\.recordFailure\(transportKey, "link"\)/);

  const stableStart = workerText.indexOf("const stableNow = Date.now()");
  const stableEnd = workerText.indexOf("await reportHostStatus(host, \"connected\", null)", stableStart);
  const stableText = stableStart >= 0 && stableEnd > stableStart ? workerText.slice(stableStart, stableEnd) : "";
  assert.match(stableText, /routeCoordinator\.isOwner\(host, routeLeaseEpoch\)/);
  assert.match(stableText, /linkOwnsRoute/);
  assert.match(stableText, /currentLinkSession\?\.isOpen\(\)/);
  assert.match(stableText, /const stableNow = Date\.now\(\)/);
  assert.match(stableText, /isDirectLinkStable\(pushOpenedAt, stableNow\)/);
  assert.match(stableText, /isDirectLinkStable\(linkOpenedAt, stableNow\)/);
  assert.match(stableText, /directTransportGovernor\.recordSuccess\(transportKey, "push"\)/);
  assert.match(stableText, /directTransportGovernor\.recordSuccess\(transportKey, "link"\)/);
  assert.doesNotMatch(workerText.slice(0, stableStart), /directTransportGovernor\.recordSuccess/);
});

test("outer push worker records each real socket failure once and ignores normal preemption", () => {
  const workerStart = source.indexOf("const runPairedHostWorker = async");
  const workerEnd = source.indexOf("await Promise.allSettled(workerHosts.map(runPairedHostWorker))", workerStart);
  const workerText = workerStart >= 0 && workerEnd > workerStart ? source.slice(workerStart, workerEnd) : "";
  const pushOpenStart = workerText.indexOf("await pushSession.openPush(input.account)");
  const pushOpenEnd = workerText.indexOf("pushOpenedAt = Date.now()", pushOpenStart);
  const pushOpenText = pushOpenStart >= 0 && pushOpenEnd > pushOpenStart ? workerText.slice(pushOpenStart, pushOpenEnd) : "";
  assert.doesNotMatch(pushOpenText, /recordFailure\(transportKey, "push"\)/);

  const outerCatchStart = workerText.lastIndexOf("} catch (error) {");
  const outerFinallyStart = workerText.indexOf("} finally {", outerCatchStart);
  const outerCatchText = outerCatchStart >= 0 && outerFinallyStart > outerCatchStart
    ? workerText.slice(outerCatchStart, outerFinallyStart)
    : "";
  assert.match(outerCatchText, /if \(!listener\.preempted && isDirectTransportError\(error\)\) \{\s*directTransportGovernor\.recordFailure\(transportKey, "push"\);\s*\}/);
  assert.equal((workerText.match(/directTransportGovernor\.recordFailure\(transportKey, "push"\)/g) ?? []).length, 1);
});

test("authenticated auxiliary link EOF records a shared link transport failure", () => {
  const workerStart = source.indexOf("const runPairedHostWorker = async");
  const workerEnd = source.indexOf("await Promise.allSettled(workerHosts.map(runPairedHostWorker))", workerStart);
  const workerText = workerStart >= 0 && workerEnd > workerStart ? source.slice(workerStart, workerEnd) : "";
  const readLogStart = workerText.indexOf('logger.info("Direct auxiliary link read ended; releasing SMS route for immediate failover"');
  const readCatchStart = workerText.lastIndexOf("catch (error) {", readLogStart);
  const readCatchEnd = workerText.indexOf("pairedFailureReported = false", readCatchStart);
  const readCatchText = readCatchStart >= 0 && readCatchEnd > readCatchStart
    ? workerText.slice(readCatchStart, readCatchEnd)
    : "";
  assert.match(readCatchText, /if \(!listener\.preempted && isDirectTransportError\(error\)\) \{\s*directTransportGovernor\.recordFailure\(transportKey, "link"\);\s*\}/);
  assert.equal((workerText.match(/recordFailure\(transportKey, "link"\)/g) ?? []).length, 2);
  assert.match(readCatchText, /if \(linkSession === currentLinkSession\) \{\s*releaseRouteOwnership\(\);\s*await closeLinkSession\(\);/);
  assert.match(readCatchText, /await closeLinkSession\(\)/);
});

test("transport classifier accepts connection failures but rejects polling, auth, route, and callback errors", () => {
  const reset = Object.assign(new Error("read failed"), { code: "ECONNRESET" });
  assert.equal(isDirectTransportErrorForTest(reset), true);
  assert.equal(isDirectTransportErrorForTest(new Error("Direct proxy CONNECT timed out: gateway:80")), true);
  assert.equal(isDirectTransportErrorForTest(new Error("Direct TLS connection timed out through proxy: gateway:80")), true);
  assert.equal(isDirectTransportErrorForTest(new Error("socket ended while waiting for direct push frame")), true);

  assert.equal(isDirectTransportErrorForTest(new Error("Timed out waiting for direct push frame")), false);
  assert.equal(isDirectTransportErrorForTest(new Error("Direct session bootstrap failed: authen failed")), false);
  assert.equal(isDirectTransportErrorForTest(new Error("Direct paired link registration failed")), false);
  assert.equal(isDirectTransportErrorForTest(createDirectCallbackErrorForTest(reset)), false);
  const waitStart = source.indexOf("  async waitForPushes(");
  const waitEnd = source.indexOf("  async close()", waitStart);
  const waitText = waitStart >= 0 && waitEnd > waitStart ? source.slice(waitStart, waitEnd) : "";
  assert.match(waitText, /invokeDirectListenerCallback\(onFrame/);
  assert.match(waitText, /invokeDirectListenerCallback\(onPush/);
});

test("link health timestamp resets on close and starts only after authenticated link open", () => {
  const workerStart = source.indexOf("const runPairedHostWorker = async");
  const workerEnd = source.indexOf("await Promise.allSettled(workerHosts.map(runPairedHostWorker))", workerStart);
  const workerText = workerStart >= 0 && workerEnd > workerStart ? source.slice(workerStart, workerEnd) : "";
  assert.match(workerText, /let linkOpenedAt = 0/);
  const closeStart = workerText.indexOf("const closeLinkSession = async () =>");
  const closeEnd = workerText.indexOf("const ensureRouteRegistration = async", closeStart);
  assert.match(workerText.slice(closeStart, closeEnd), /linkOpenedAt = 0/);
  const ensureStart = workerText.indexOf("const ensureLinkSession = async () =>");
  const ensureEnd = workerText.indexOf("const handlePairedFrame = async", ensureStart);
  assert.match(workerText.slice(ensureStart, ensureEnd), /await linkSession\.openLink\(input\.account\);\s*linkOpenedAt = Date\.now\(\)/);
});

test("direct message listener keeps two paired workers active and rotates failed gateway hosts", () => {
  assert.match(source, /const discoveredHosts = input\.shouldContinue/);
  assert.match(source, /discoverDirectPushHostsForListener\(discoverySession, runtime, input\.account\)/);
  assert.match(source, /const hosts = uniqueHosts\(\[baseHosts\[0\] \?\? runtime\.primaryHost, \.\.\.discoveredHosts, \.\.\.baseHosts\]\)/);
  assert.match(source, /const DIRECT_PUSH_HOST_CONCURRENCY = 2/);
  assert.match(source, /const workerHosts = hosts\.slice\(0, DIRECT_PUSH_HOST_CONCURRENCY\)/);
  assert.match(source, /const activeWorkerHosts = new Set<string>\(\)/);
  assert.match(source, /const acquireWorkerHost = \(\) =>/);
  assert.match(source, /if \(activeWorkerHosts\.has\(candidate\)\) \{\s*continue;\s*\}/);
  assert.match(source, /activeWorkerHosts\.add\(candidate\)/);
  assert.match(source, /const host = acquireWorkerHost\(\)/);
  assert.match(source, /finally \{\s*activeWorkerHosts\.delete\(host\);\s*\}/);
  assert.match(source, /await Promise\.allSettled\(workerHosts\.map\(runPairedHostWorker\)\)/);
  assert.match(source, /const runPairedHostWorker = async \(_initialHost: string\)/);
  assert.match(source, /const isWithinCurrentListenWindow = \(\) => Date\.now\(\) < deadline/);
  assert.match(source, /await pushSession\.openPush\(input\.account\)/);
  assert.match(source, /await linkSession\.openLink\(input\.account\)/);
  assert.match(source, /runPushLinkRegistration\(\s*linkSession,\s*runtime,\s*input\.account/);
  assert.match(source, /pushSession\.waitForPushes/);
  assert.match(source, /currentLinkSession\.waitForPushes/);
  assert.match(source, /while \(!listener\.preempted && hasRemainingListenWindow\(\) && diagnostics\.totalPushes\(\) < maxPushFrames\)/);
  assert.match(source, /const waitUntil = Math\.min\([\s\S]*nextOfflineCatchupAt/);
  assert.doesNotMatch(source, /nextWebOfflinePollAt/);
  assert.doesNotMatch(source, /discoverDirectPushHostsOnSession/);
  assert.doesNotMatch(source, /Direct account RTC host discovery completed/);
  assert.doesNotMatch(source, /DIRECT_RTC_DISCOVERY_TIMEOUT_MS/);
  assert.doesNotMatch(source, /listenPrime\.queryRtcServersEx/);
  assert.doesNotMatch(source, /DIRECT_PUSH_HOST_LISTEN_SLICE_MS/);
  assert.doesNotMatch(source, /hostDeadline/);
});

test("an unconfirmed paired route leaves the current host so another candidate can register", () => {
  const workerStart = source.indexOf("const runPairedHostWorker = async");
  const workerEnd = source.indexOf("await Promise.allSettled(workerHosts.map(runPairedHostWorker))", workerStart);
  const workerText = workerStart >= 0 && workerEnd > workerStart ? source.slice(workerStart, workerEnd) : "";
  const failureStart = workerText.indexOf('logger.warn("Direct paired link registration failed; rotating SMS gateway"');
  const failureEnd = workerText.indexOf("const remainingFrames", failureStart);
  const failureText = failureStart >= 0 && failureEnd > failureStart ? workerText.slice(failureStart, failureEnd) : "";
  assert.match(failureText, /await delay\(Math\.min\(DIRECT_RECONNECT_BACKOFF_MAX_MS, 500\)\);\s*break;/);
  assert.doesNotMatch(failureText, /continue;/);
});

test("an ineligible standby host yields when no route owner exists", () => {
  const workerStart = source.indexOf("const runPairedHostWorker = async");
  const workerEnd = source.indexOf("await Promise.allSettled(workerHosts.map(runPairedHostWorker))", workerStart);
  const workerText = workerStart >= 0 && workerEnd > workerStart ? source.slice(workerStart, workerEnd) : "";
  assert.match(workerText, /const routeReserved = reserveRouteRegistration\(\)/);
  assert.match(workerText, /if \(!routeReserved && routeCoordinator\.ownerHost\(\) === null\) \{[\s\S]*Direct standby gateway yielded because no route owner can promote it[\s\S]*break;/);
  assert.match(workerText, /if \(routeReserved\) \{\s*currentLinkSession = await ensureLinkSession\(\);\s*\}/);
});

test("direct message listener discovers account-specific gateways without overwriting the SMS route", () => {
  const start = source.indexOf("async function discoverDirectPushHostsForListener");
  const end = source.indexOf("async function runPushMaintenanceCalls", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.match(text, /await session\.openLink\(account\)/);
  assert.match(text, /session\.callJsonFromTemplate\(\s*"queryRtcServersEx",\s*TEMPLATES\.queryRtcServersEx/);
  assert.match(text, /extractRtcServerHosts\(payload\)/);
  assert.doesNotMatch(text, /runPushLinkRegistration|updateClientLink/);
  assert.match(source, /listener\.sessions\?\.add\(discoverySession\)/);
  assert.match(source, /listener\.sessions\?\.delete\(discoverySession\)/);
});

test("primary routing is deterministic and backup registration requires promotion", () => {
  assert.match(source, /const registrationOwnerHost = hosts\[0\] \?\? runtime\.primaryHost/);
  assert.match(source, /const routeCoordinator = createDirectRouteCoordinator\(registrationOwnerHost\)/);
  assert.match(source, /if \(!routeCoordinator\.shouldClaim\(host, now\)\)/);
  assert.match(source, /routeCoordinator\.markPrimaryUnavailable\(\)/);
  assert.match(source, /const registration = await runPushLinkRegistration/);
  assert.match(source, /diagnostics\.recordCall\(registration\)/);
  assert.match(source, /secondary paired workers stay authenticated without replacing the primary SMS route/);
});

test("route ownership fails over without letting a reconnecting primary preempt the active backup", () => {
  const coordinator = createDirectRouteCoordinatorForTest("primary");
  assert.equal(coordinator.shouldClaim("backup"), false);
  coordinator.markPrimaryUnavailable();
  assert.equal(coordinator.shouldClaim("primary"), false);
  assert.equal(coordinator.shouldClaim("backup"), true);
  const backupEpoch = coordinator.claim("backup");
  assert.equal(coordinator.ownerHost(), "backup");
  assert.equal(coordinator.shouldClaim("other"), false);
  assert.equal(coordinator.shouldClaim("primary"), false);
  coordinator.release("primary", backupEpoch);
  assert.equal(coordinator.ownerHost(), "backup");
  coordinator.release("backup", backupEpoch);
  assert.equal(coordinator.ownerHost(), null);
  assert.equal(coordinator.shouldClaim("primary"), true);
  const primaryEpoch = coordinator.claim("primary");
  assert.equal(coordinator.ownerHost(), "primary");
  coordinator.release("primary", primaryEpoch);
  assert.equal(coordinator.ownerHost(), null);
  assert.equal(coordinator.shouldClaim("backup"), true);
});

test("sticky route survives auxiliary link churn without backup takeover", () => {
  const coordinator = createDirectRouteCoordinatorForTest("primary");
  const primaryEpoch = coordinator.claim("primary");
  coordinator.beginOwnerGrace("primary", primaryEpoch, 1_000, 15_000);

  assert.equal(coordinator.ownerHost(), "primary");
  assert.equal(coordinator.shouldClaim("backup", 15_999), false);
  assert.equal(coordinator.shouldClaim("backup", 16_000), true);
  const backupEpoch = coordinator.claim("backup");
  coordinator.release("primary", primaryEpoch);
  assert.equal(coordinator.isOwner("backup", backupEpoch), true);
});

test("an expired owner cannot renew grace before the backup claims", () => {
  const coordinator = createDirectRouteCoordinatorForTest("primary");
  const primaryEpoch = coordinator.claim("primary");
  coordinator.beginOwnerGrace("primary", primaryEpoch, 1_000, 15_000);

  assert.equal(coordinator.renewOwner("primary", primaryEpoch, 16_000), false);
  assert.equal(coordinator.ownerHost(), null);
  assert.equal(coordinator.shouldClaim("backup", 16_000), true);
  const backupEpoch = coordinator.claim("backup");
  coordinator.release("primary", primaryEpoch);
  assert.equal(coordinator.isOwner("backup", backupEpoch, 16_000), true);
});

test("repeated owner grace begins do not extend the deadline but renew allows a new grace", () => {
  const expiring = createDirectRouteCoordinatorForTest("primary");
  const expiringEpoch = expiring.claim("primary");
  expiring.beginOwnerGrace("primary", expiringEpoch, 1_000, 15_000);
  expiring.beginOwnerGrace("primary", expiringEpoch, 5_000, 15_000);
  assert.equal(expiring.shouldClaim("backup", 16_000), true);

  const renewed = createDirectRouteCoordinatorForTest("primary");
  const renewedEpoch = renewed.claim("primary");
  renewed.beginOwnerGrace("primary", renewedEpoch, 1_000, 15_000);
  assert.equal(renewed.renewOwner("primary", renewedEpoch, 15_000), true);
  renewed.beginOwnerGrace("primary", renewedEpoch, 20_000, 15_000);
  assert.equal(renewed.shouldClaim("backup", 34_999), false);
  assert.equal(renewed.shouldClaim("backup", 35_000), true);
});

test("a rebuilt owner link cancels grace while stale epochs cannot change ownership", () => {
  const coordinator = createDirectRouteCoordinatorForTest("primary");
  const primaryEpoch = coordinator.claim("primary");
  coordinator.beginOwnerGrace("primary", primaryEpoch, 1_000, 15_000);
  assert.equal(coordinator.renewOwner("primary", primaryEpoch, 15_999), true);

  assert.equal(coordinator.shouldClaim("backup", 16_000), false);
  coordinator.beginOwnerGrace("primary", primaryEpoch - 1, 16_000, 1);
  assert.equal(coordinator.shouldClaim("backup", 16_001), false);
  assert.equal(coordinator.isOwner("primary", primaryEpoch), true);
});

test("expired backup grace promotes the primary without allowing a stale release", () => {
  const coordinator = createDirectRouteCoordinatorForTest("primary");
  coordinator.markPrimaryUnavailable();
  const backupEpoch = coordinator.claim("backup");
  coordinator.beginOwnerGrace("backup", backupEpoch, 2_000, 15_000);

  assert.equal(coordinator.shouldClaim("primary", 16_999), false);
  assert.equal(coordinator.shouldClaim("primary", 17_000), true);
  const primaryEpoch = coordinator.claim("primary");
  coordinator.release("backup", backupEpoch);
  assert.equal(coordinator.isOwner("primary", primaryEpoch), true);
});

test("authenticated link registration failures release the reserved SMS route", () => {
  const registerStart = source.indexOf("const ensureRouteRegistration = async");
  const registerEnd = source.indexOf("const ensureLinkSession = async", registerStart);
  const registerText = registerStart >= 0 && registerEnd > registerStart ? source.slice(registerStart, registerEnd) : "";
  assert.match(registerText, /catch \(error\) \{\s*releaseRouteOwnership\(\)/);
  assert.match(registerText, /routeCoordinator\.markPrimaryUnavailable\(\)/);
});

test("failed owner link rebuilds keep the lease while pending reservations are released", () => {
  const ensureStart = source.indexOf("const ensureLinkSession = async");
  const ensureEnd = source.indexOf("const handlePairedFrame = async", ensureStart);
  const ensureText = ensureStart >= 0 && ensureEnd > ensureStart ? source.slice(ensureStart, ensureEnd) : "";
  assert.match(ensureText, /catch \(error\) \{[\s\S]*if \(linkReservationEpoch !== null\) \{\s*releaseRouteOwnership\(\);\s*\}/);
  assert.match(ensureText, /if \(!linkTransportReady && isDirectTransportError\(error\)\) \{\s*directTransportGovernor\.recordFailure\(transportKey, "link"\);\s*\}/);
  assert.doesNotMatch(ensureText, /catch \(error\) \{\s*collectPairTrace\(\);\s*releaseRouteOwnership\(\)/);
});

test("paired push socket shutdown releases only its current route epoch", () => {
  const workerStart = source.indexOf("const runPairedHostWorker = async");
  const workerEnd = source.indexOf("await Promise.allSettled(workerHosts.map(runPairedHostWorker))", workerStart);
  const workerText = workerStart >= 0 && workerEnd > workerStart ? source.slice(workerStart, workerEnd) : "";
  assert.match(workerText, /const releaseRouteOwnership = \(\) =>/);
  assert.match(workerText, /finally \{[\s\S]*releaseRouteOwnership\(\)/);
});

test("preempted listeners cannot create or register replacement sessions", () => {
  assert.match(source, /function isActiveDirectPushListener\(listener: ActiveDirectPushListener\)/);
  assert.match(source, /if \(active\.preempted\) \{\s*await active\.done;\s*return true;/);
  assert.match(source, /if \(!isActiveDirectPushListener\(listener\)\) \{\s*await pushSession\.close/);
  assert.match(source, /await linkSession\.openLink\(input\.account\);\s*linkOpenedAt = Date\.now\(\);\s*if \(!isActiveDirectPushListener\(listener\)\)/);
  assert.match(source, /if \(!isActiveDirectPushListener\(listener\)\) \{\s*throw new Error\("Direct listener was preempted before route registration"\)/);
});
test("direct message listener keeps host concurrency internal and bounded", () => {
  const settingsSource = readFileSync(new URL("../settings.service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(settingsSource, /\["dt_direct_listener_host_concurrency",\s*"[1236]"/);
  assert.match(settingsSource, /obsoleteSettingKeys = \["dt_direct_listener_host_concurrency"\]/);
  assert.match(settingsSource, /key: \{ in: \[\.\.\.obsoleteSettingKeys\] \}/);
  assert.doesNotMatch(source, /listenHostConcurrency/);
  assert.match(source, /const DIRECT_PUSH_HOST_CONCURRENCY = 2/);
  assert.doesNotMatch(source, /DIRECT_PUSH_HOST_CONCURRENCY = [3-9]/);
  assert.doesNotMatch(source, /runDirectKeepaliveWorker/);
  assert.doesNotMatch(source, /openKeepalive/);
});

test("direct message listener reports paired gateway lifecycle before frames arrive", () => {
  assert.match(source, /onHostStatus\?: \(status: \{/);
  assert.match(source, /state: "connecting" \| "connected" \| "failed"/);
  assert.match(source, /await input\.onHostStatus\?\.\(\{ host, state, error \}\)/);
  assert.match(source, /await reportHostStatus\(host, "connecting", null\)/);
  assert.match(source, /await reportHostStatus\(host, "connected", null\)/);
  assert.match(source, /await reportHostStatus\(host, "failed", error instanceof Error \? error\.message : String\(error\)\)/);
  const monitorSource = readFileSync(new URL("../account-monitor.ts", import.meta.url), "utf8");
  assert.match(monitorSource, /onHostStatus: async \(status\) =>/);
  assert.match(monitorSource, /pairedHosts/);
  assert.match(monitorSource, /connectingHosts/);
  assert.match(monitorSource, /failedHosts/);
});

test("direct route owners become healthy only after a stable push read window", () => {
  assert.match(source, /const DIRECT_LINK_HEALTHY_AFTER_MS = 15_000/);
  assert.match(source, /isDirectLinkStable\(pushOpenedAt, stableNow\)/);
  assert.match(source, /isDirectLinkStable\(linkOpenedAt, stableNow\)/);
  assert.match(source, /routeCoordinator\.isOwner\(host, routeLeaseEpoch\)/);
  assert.match(source, /reportHostStatus\(host, "failed",/);
  assert.match(source, /stablePairs \+= 1/);
});

test("direct listener clears the last error only after a stable route-owning push read", () => {
  const registrationStart = source.indexOf("let currentLinkSession: DirectSession;");
  const registrationEnd = source.indexOf("const remainingFrames", registrationStart);
  const registrationText = registrationStart >= 0 && registrationEnd > registrationStart
    ? source.slice(registrationStart, registrationEnd)
    : "";
  assert.doesNotMatch(registrationText, /lastError = undefined/);

  const readStart = source.indexOf("const nextPushes: DirectProbePushResult[]", registrationEnd);
  const readEnd = source.indexOf("if (listener.preempted", readStart);
  const readText = readStart >= 0 && readEnd > readStart ? source.slice(readStart, readEnd) : "";
  assert.match(readText, /let pushReadSucceeded = false/);
  assert.match(readText, /pushSession\.waitForPushes[\s\S]*pushReadSucceeded = true/);
  assert.match(readText, /if \(pushReadSucceeded && pushReportedHealthy\) \{\s*lastError = undefined;\s*\}/);
});

test("fatal paired link failures are not reported again by the worker catch", () => {
  assert.match(source, /let pairedFailureReported = false/);
  assert.match(source, /const reportPairedHostFailure = async \(error: unknown\) => \{\s*pairedFailureReported = true;\s*await reportHostStatus\(host, "failed",/);
  assert.match(source, /if \(!pairedFailureReported\) \{\s*await reportHostStatus\(host, "failed",/);
});

test("direct message listener keeps the official control gateway first and then uses SMS affinity", () => {
  assert.match(source, /"20\.97\.117\.109"/);
  assert.match(source, /"206\.189\.228\.89"/);
  assert.match(source, /const directSmsHostAffinity = new TtlLruCache/);
  assert.match(source, /rememberDirectSmsHost\(input\.account, frameHost\)/);
  assert.match(source, /getPrioritizedDirectPushHosts\(runtime, input\.account\)/);
  assert.match(source, /uniqueHosts\(\[runtime\.primaryHost, \.\.\.preferredHosts, \.\.\.APP_DIRECT_PUSH_HOSTS, runtime\.backupHost\]\)/);
});

test("direct message listener fails the monitor cycle when no gateway session opens", () => {
  assert.match(source, /diagnostics\.recordHostError\(host, error\)/);
  assert.match(source, /if \(attempts === 0 && lastError\)/);
  assert.match(source, /throw normalizeDirectError\(lastError\)/);
});
test("direct message listener does not wait forever for a stuck account operation", () => {
  assert.match(source, /const DIRECT_SESSION_OPERATION_IDLE_WAIT_MS = 5_000/);
  assert.match(source, /waitForDirectSessionOperationIdle\(input\.account, DIRECT_SESSION_OPERATION_IDLE_WAIT_MS\)/);
  assert.match(source, /Direct session operation remained busy; starting SMS listener anyway/);
  assert.match(source, /Promise\.race\(\[\s*active\.then\(\(\) => true/);
});
test("direct message listener enters push read loop without asset refresh prime calls", () => {
  assert.match(source, /listenPrime\.updateClientLink/);
  assert.doesNotMatch(source, /runPushListenPrimeCalls\(session/);
  assert.doesNotMatch(source, /listenPrime\.queryRtcServersEx#flags9/);
  assert.doesNotMatch(source, /listenPrime\.getBalance/);
  assert.doesNotMatch(source, /listenPrime\.getNumberCountries/);
  assert.doesNotMatch(source, /listenPrime\.glbUserPropertites/);
  assert.doesNotMatch(source, /listenPrime\.gwebInfoBus/);
});
test("direct message listener re-registers the SMS route on every rebuilt owner link", () => {
  const registerStart = source.indexOf("const ensureRouteRegistration = async");
  const registerEnd = source.indexOf("const ensureLinkSession = async", registerStart);
  const registerText = registerStart >= 0 && registerEnd > registerStart ? source.slice(registerStart, registerEnd) : "";
  assert.match(registerText, /const renewingLease = routeLeaseEpoch !== null && routeCoordinator\.renewOwner\(host, routeLeaseEpoch\)/);
  assert.match(registerText, /if \(renewingLease && linkOwnsRoute\) \{\s*return true;\s*\}/);
  assert.doesNotMatch(registerText, /if \(renewingLease\) \{\s*return true;\s*\}/);
  assert.match(registerText, /const registrationEpoch = renewingLease \? routeLeaseEpoch : linkReservationEpoch/);
  assert.ok(registerText.indexOf("renewOwner") < registerText.indexOf("runPushLinkRegistration"));
});
test("paired route ownership requires the server confirmation for the current route", () => {
  const isConfirmation = (directGatewayModule as Record<string, unknown>)
    .isDirectRouteRegistrationConfirmationForTest;
  assert.equal(typeof isConfirmation, "function");
  if (typeof isConfirmation !== "function") {
    return;
  }

  const route = Buffer.from("ec87000300503c2e", "hex");
  const otherRoute = Buffer.from("ec87000300503c2f", "hex");
  const invoke = isConfirmation as (
    frame: { type: number; status?: number; body: Buffer },
    expectedRoute: Buffer
  ) => boolean;
  assert.equal(invoke({ type: 0x8107, status: 0x0102, body: Buffer.concat([route, route, Buffer.alloc(77)]) }, route), true);
  assert.equal(invoke({ type: 0x8107, status: 0x0102, body: Buffer.concat([route, Buffer.alloc(8), Buffer.alloc(77)]) }, route), false);
  assert.equal(invoke({ type: 0x8107, status: 0x0102, body: Buffer.concat([otherRoute, otherRoute]) }, route), false);
  assert.equal(invoke({ type: 0x8107, status: 0x0103, body: Buffer.concat([route, route]) }, route), false);
  assert.equal(invoke({ type: 0x8106, status: 0x0102, body: Buffer.concat([route, route]) }, route), false);
});
test("route registration waits for confirmation without swallowing SMS pushes", () => {
  const registrationStart = source.indexOf("  async registerClientLink(");
  const registrationEnd = source.indexOf("  async callCommonRestJson", registrationStart);
  const registrationText = registrationStart >= 0 && registrationEnd > registrationStart
    ? source.slice(registrationStart, registrationEnd)
    : "";
  const captureArmed = registrationText.indexOf("this.routeRegistrationCaptureUntil = deadline");
  const registrationWrite = registrationText.indexOf('await this.sendJson("updateClientLink", params)');
  assert.ok(captureArmed >= 0 && captureArmed < registrationWrite, "confirmation capture must be armed before the request write");
  assert.match(registrationText, /await this\.sendJson\("updateClientLink", params\)/);
  assert.match(registrationText, /isDirectRouteRegistrationConfirmation\(frame, this\.route\)/);
  assert.match(registrationText, /const push = frameToDirectPush\(frame\);\s*if \(push\.sms \|\| isNotifyOnlyMessageIndexPush\(push\)\) \{\s*this\.pendingPushes\.push\(push\);\s*\}/);
  assert.match(registrationText, /finally \{\s*this\.routeRegistrationCaptureUntil = 0;\s*\}/);
  assert.match(source, /parsed\.status === 0x0102 && Date\.now\(\) <= this\.routeRegistrationCaptureUntil/);

  const runStart = source.indexOf("async function runPushLinkRegistration");
  const runEnd = source.indexOf("async function sendPushTemplateCall", runStart);
  const runText = runStart >= 0 && runEnd > runStart ? source.slice(runStart, runEnd) : "";
  assert.match(runText, /await session\.registerClientLink\(/);
  assert.match(runText, /payload: \{ confirmed: true \}/);
  assert.doesNotMatch(runText, /sendPushTemplateCall/);
});
test("direct message listener repairs the link without closing a healthy push socket", () => {
  const start = source.indexOf("const ensureLinkSession = async");
  const end = source.indexOf("await pushSession.openPush(input.account)", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.match(text, /linkSession\?\.isOpen\(\)/);
  assert.match(text, /await linkSession\.openLink\(input\.account\)/);
  assert.match(text, /await ensureRouteRegistration\(linkSession\)/);
  assert.doesNotMatch(text, /pushSession\.close/);
  assert.match(source, /await pushSession\.waitForPushes/);
});
test("auxiliary link closure starts grace without releasing the worker route lease", () => {
  const closeStart = source.indexOf("const closeLinkSession = async () =>");
  const closeEnd = source.indexOf("const ensureRouteRegistration = async", closeStart);
  const closeText = closeStart >= 0 && closeEnd > closeStart ? source.slice(closeStart, closeEnd) : "";
  assert.match(closeText, /routeCoordinator\.beginOwnerGrace\(host, routeLeaseEpoch, Date\.now\(\), DIRECT_ROUTE_OWNER_GRACE_MS\)/);
  assert.doesNotMatch(closeText, /routeCoordinator\.release/);
  assert.doesNotMatch(closeText, /routeLeaseEpoch = null/);
  assert.match(source, /const releaseRouteOwnership = \(\) =>/);
  assert.match(source, /let currentLinkSession = linkSession as DirectSession \| null/);
  assert.match(source, /if \(currentLinkSession && !currentLinkSession\.isOpen\(\)\) \{\s*await closeLinkSession\(\);\s*currentLinkSession = null/);
  assert.match(source, /if \(!currentLinkSession\) \{\s*const routeReserved = reserveRouteRegistration\(\)/);
});
test("direct message listener reserves one route owner before opening an authenticated link", () => {
  const workerStart = source.indexOf("const runPairedHostWorker = async");
  const workerEnd = source.indexOf("await Promise.allSettled(workerHosts.map(runPairedHostWorker))", workerStart);
  const workerText = workerStart >= 0 && workerEnd > workerStart ? source.slice(workerStart, workerEnd) : "";
  assert.match(workerText, /let linkReservationEpoch: number \| null = null/);
  assert.match(workerText, /let routeLeaseEpoch: number \| null = null/);
  assert.match(workerText, /const reserveRouteRegistration = \(\) => \{[\s\S]*routeCoordinator\.shouldClaim\(host, now\)[\s\S]*routeCoordinator\.claim\(host\)/);
  const ensureStart = workerText.indexOf("const ensureLinkSession = async");
  const ensureEnd = workerText.indexOf("const handlePairedFrame = async", ensureStart);
  const ensureText = ensureStart >= 0 && ensureEnd > ensureStart ? workerText.slice(ensureStart, ensureEnd) : "";
  const reserve = ensureText.indexOf("reserveRouteRegistration()");
  const create = ensureText.indexOf("new DirectSession(runtime, host)");
  assert.ok(reserve >= 0);
  assert.ok(create > reserve);
  assert.match(workerText, /if \(routeReserved\) \{\s*currentLinkSession = await ensureLinkSession\(\);\s*\}/);
  assert.match(ensureText, /if \(!reserveRouteRegistration\(\)\) \{\s*return null;\s*\}/);
  assert.doesNotMatch(workerText, /Direct SMS route is reserved by another paired worker/);
});
test("paired listeners consume SMS frames from the registered link and prelogin socket", () => {
  const listenerStart = source.indexOf("export async function listenDirectSessionPushes");
  const probeStart = source.indexOf("export async function probeDirectPushSocket", listenerStart);
  const listenerText = listenerStart >= 0 && probeStart > listenerStart ? source.slice(listenerStart, probeStart) : "";
  const probeEnd = source.indexOf("export async function fetchDirectWebOfflineMessages", probeStart);
  const probeText = probeStart >= 0 && probeEnd > probeStart ? source.slice(probeStart, probeEnd) : "";
  assert.match(listenerText, /currentLinkSession\.waitForPushes/);
  assert.match(listenerText, /pushSession\.waitForPushes/);
  assert.match(probeText, /linkSession\.waitForPushes/);
  assert.match(probeText, /pushSession\.waitForPushes/);
});
test("paired route registration uses the authenticated client's current link address", () => {
  assert.match(source, /runPushLinkRegistration\(currentLinkSession, runtime, input\.account\)/);
  assert.match(source, /runPushLinkRegistration\(linkSession, runtime, input\.account\)/);
  assert.doesNotMatch(source, /pushSession\.getRouteQueryParams/);
});
test("direct message listener delivery-confirms only parsed SMS or structured index notifications", () => {
  assert.match(source, /const offlineMessageIndexPush = parsed\.type === 0x8107 && parsed\.status === 0x0103/);
  assert.match(source, /acknowledgePushFrame\(parsed, Boolean\(smsPush\) \|\| offlineMessageIndexPush\)/);
  assert.match(source, /await this\.write\(ack\);[\s\S]*if \(!shouldConfirmDelivery \|\| !this\.account\) \{/);
});
test("direct message listener immediately requests offline catch-up only for notify-only message index frames", () => {
  assert.match(source, /reason: "startup" \| "interval" \| "notify-only"/);
  assert.match(source, /isNotifyOnlyMessageIndexPush\(push\)/);
  assert.match(source, /nextNotifyOnlyCatchupAt = Date\.now\(\) \+ DIRECT_NOTIFY_ONLY_CATCHUP_THROTTLE_MS/);
  assert.match(source, /const currentLinkSession = linkSession/);
  assert.match(source, /requestOfflineCatchup\(currentLinkSession, host, "notify-only"\)/);
});
test("direct offline catch-up interval is conservative during long background listens", () => {
  assert.match(source, /const DIRECT_OFFLINE_CATCHUP_INTERVAL_MS = 10 \* 60_000/);
  assert.match(source, /const DIRECT_NOTIFY_ONLY_CATCHUP_THROTTLE_MS = 60_000/);
  assert.match(source, /const DIRECT_OFFLINE_CATCHUP_MAX_CONCURRENCY = 3/);
  assert.match(source, /withDirectOfflineCatchupPermit/);
});
test("direct message listener reports offline catch-up attempts to monitor diagnostics", () => {
  assert.match(source, /onOfflineCatchup\?:/);
  assert.match(source, /await input\.onOfflineCatchup\?\.\(/);
  assert.match(source, /offlineTemplateSendCount/);
});

test("direct offline catch-up retries soon after a failed template send", () => {
  assert.match(source, /DIRECT_OFFLINE_CATCHUP_RETRY_MS/);
  assert.match(source, /responseReceived\s*\? Date\.now\(\) \+ directOfflineCatchupDelayMs\(input\.account\)\s*:\s*Date\.now\(\) \+ DIRECT_OFFLINE_CATCHUP_RETRY_MS/);
});

test("direct message listener pulls all offline messages on the paired authenticated link", () => {
  assert.match(source, /onWebOfflineMessages\?:/);
  assert.match(source, /function pollWebOfflineMessagesOnGatewayHosts/);
  assert.match(source, /uniqueHosts\(\[runtime\.primaryHost, runtime\.backupHost\]\)/);
  assert.match(source, /const session = new DirectSession\(runtime, host\)/);
  assert.match(source, /getWebOfflineMessage: Buffer\.from/);
  assert.match(source, /session\.callJsonFromTemplate\("getWebOfflineMessage", TEMPLATES\.getWebOfflineMessage/);
  assert.match(source, /bDevice: 1/);
  assert.match(source, /normalizeDirectWebOfflineMessages\(payload, account\.appVariant\)/);
  assert.match(source, /await deliverDirectWebOfflineMessages\(messages, host, onMessages, deliveryTracker\)/);
  assert.match(source, /getDirectWebOfflineDeliveryTracker\(input\.account\)/);
  assert.match(source, /requestWebOfflineMessages\(session, host\)/);
  assert.doesNotMatch(source, /nextWebOfflinePollAt/);
  assert.doesNotMatch(source, /const webOfflinePollTimer = setInterval/);
});
test("direct native catch-up completes request receive normalize and delivery on the same authenticated link", () => {
  const start = source.indexOf("  const requestOfflineCatchup = async");
  const end = source.indexOf("\n  try {", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.match(text, /session\.sendConfiguredTemplate\("dt_direct_template_offline_messages"/);
  assert.match(text, /requestWebOfflineMessages\(session, host\)/);
  assert.match(text, /normalizeDirectWebOfflineMessages/);
  assert.match(text, /deliverDirectWebOfflineMessages/);
  assert.doesNotMatch(text, /new DirectSession/);
});
test("direct message listener leaves unknown non-SMS frames unconfirmed", () => {
  assert.match(source, /const smsPush = parsed\.type === 0x8107 && parsed\.status === 0x0103 \? tryParseSmsPush\(parsed\.raw\) \?\? tryParseSmsPush\(parsed\.body\) : null/);
  assert.match(source, /isOfflineMessageIndexPush\(parsed\.raw\) \|\| isOfflineMessageIndexPush\(parsed\.body\)/);
  assert.match(source, /acknowledgePushFrame\(parsed, Boolean\(smsPush\) \|\| offlineMessageIndexPush\)/);
  assert.doesNotMatch(source, /acknowledgePushFrame\(parsed, true\)/);
});
test("direct message listener uses DingDong app version for DingDong push sessions", () => {
  assert.match(source, /listenDirectSessionPushes\(input:[\s\S]*appVariant\?: "dingtone" \| "dingdong"/);
  assert.match(source, /const appVersion = resolveDirectAppVersion\(account, runtime\);[\s\S]*clientVersion: appVersion,[\s\S]*appVersion/);
  assert.match(source, /appVersion: resolveDirectAppVersion\(input\.account, input\.runtime\)/);
  const sharedParams = source.slice(source.indexOf("function buildSharedTemplateParams"), source.indexOf("function extractBootstrapPhoneCountryKeys"));
  assert.match(sharedParams, /clientVersion: resolveDirectAppVersion\(account, runtime\)/);
  assert.match(sharedParams, /appVersion: resolveDirectAppVersion\(account, runtime\)/);
  assert.doesNotMatch(sharedParams, /runtime\.appVersion/);
});
test("direct message listener sends delivery confirmation only for accepted push classes", () => {
  assert.match(source, /if \(!shouldConfirmDelivery \|\| !this\.account\) \{/);
  assert.match(source, /buildPushDeliveryConfirmFrame\(frame, this\.account, this\.nextPushDeliveryConfirmSerial\(\)\)/);
  assert.match(source, /Boolean\(smsPush\) \|\| offlineMessageIndexPush/);
  assert.doesNotMatch(source, /extractLegacyNotifyMessageIds/);
});
test("direct message listener primes Dingtone private-number state without blocking DingDong listeners", () => {
  assert.match(source, /async function runPushMaintenanceCalls/);
  assert.match(source, /account\.appVariant !== "dingtone"/);
  assert.match(source, /listenPrime\.getPrivateNumber/);
  assert.match(source, /sendPushTemplateCall\([\s\S]*"getPrivateNumber"/);
  const start = source.indexOf("const ensureLinkSession = async () =>");
  const end = source.indexOf("const handlePairedFrame = async", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  const maintenance = text.indexOf("runPushMaintenanceCalls(linkSession, runtime, input.account)");
  const registration = text.indexOf("ensureRouteRegistration(linkSession)");
  assert.ok(maintenance >= 0, "paired link must refresh private-number state");
  assert.ok(registration >= 0, "paired link must register its SMS route");
  assert.ok(registration < maintenance, "route registration must finish before private-number maintenance");
});
test("direct SMS push socket skips the short-session bootstrap batch", () => {
  const start = source.indexOf("  async openPush(account: DirectSessionAccount)");
  const end = source.indexOf("  async openLink(account: DirectSessionAccount)", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.match(text, /await this\.openPrelogin\(account\);\s*this\.startPairedKeepalive\(\s*this\.socketConnectedAt \+ DIRECT_PAIRED_KEEPALIVE_INTERVAL_MS,\s*DIRECT_PAIRED_KEEPALIVE_INTERVAL_MS\s*\)/);
  assert.doesNotMatch(text, /bootstrapAuthenticatedSession/);
});
test("short maintenance sessions never overwrite the dedicated SMS route", () => {
  assert.match(source, /async function runPushLinkRegistration/);
  assert.match(source, /async function runPushMaintenanceCalls/);
  const start = source.indexOf("async function runPushMaintenanceCalls");
  const end = source.indexOf("async function runPushLinkRegistration", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.doesNotMatch(text, /updateClientLink/);
});
test("direct push socket probe mirrors the app's paired connection order", () => {
  const start = source.indexOf("export async function probeDirectPushSocket");
  const end = source.indexOf("export async function fetchDirectWebOfflineMessages", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  const pushOpen = text.indexOf("await pushSession.openPush(input.account)");
  const linkOpen = text.indexOf("await linkSession.openLink(input.account)");
  const linkRegistration = text.indexOf("runPushLinkRegistration(");
  assert.ok(pushOpen >= 0);
  assert.ok(linkOpen > pushOpen);
  assert.ok(linkRegistration > linkOpen);
  assert.match(text, /pushSession\.waitForPushes/);
  assert.match(text, /annotatePairedSocketError\("push", caught\)/);
  assert.match(text, /linkSession\.waitForPushes/);
  assert.match(text, /annotatePairedSocketError\("link", caught\)/);
  assert.doesNotMatch(text, /runPushLinkRegistration\(pushSession/);
  assert.doesNotMatch(text, /runPushMaintenanceCalls/);
});
test("authenticated link heartbeat starts only after bootstrap registration completes", () => {
  assert.match(source, /const DIRECT_LINK_BOOTSTRAP_WAIT_MS = 1_250/);
  assert.match(source, /const DIRECT_PAIRED_KEEPALIVE_INTERVAL_MS = 5_000/);
  const openStart = source.indexOf("  async openPush(account: DirectSessionAccount)");
  const openEnd = source.indexOf("  private async openPrelogin", openStart);
  const openText = openStart >= 0 && openEnd > openStart ? source.slice(openStart, openEnd) : "";
  assert.match(openText, /await this\.openPrelogin\(account\);\s*this\.startPairedKeepalive\(\s*this\.socketConnectedAt \+ DIRECT_PAIRED_KEEPALIVE_INTERVAL_MS,\s*DIRECT_PAIRED_KEEPALIVE_INTERVAL_MS\s*\)/);
  const linkStart = openText.indexOf("  async openLink(account: DirectSessionAccount)");
  const linkText = linkStart >= 0 ? openText.slice(linkStart) : "";
  assert.match(linkText, /await this\.openPrelogin\(account\);\s*await this\.bootstrapAuthenticatedSession\(account, DIRECT_LINK_BOOTSTRAP_WAIT_MS, async \(\) => \{\s*await this\.primeLinkRegistration\(account\);\s*\}\);\s*await this\.startSocketKeepalive\(\);/);
  assert.doesNotMatch(linkText, /startPairedKeepalive/);
  const preloginStart = source.indexOf("  private async openPrelogin(");
  const preloginEnd = source.indexOf("  async openActivation", preloginStart);
  const preloginText = preloginStart >= 0 && preloginEnd > preloginStart ? source.slice(preloginStart, preloginEnd) : "";
  assert.doesNotMatch(preloginText, /startPairedKeepalive/);
  const keepaliveStart = source.indexOf("  private startPairedKeepalive(");
  const keepaliveEnd = source.indexOf("  private async startSocketKeepalive", keepaliveStart);
  const keepaliveText = keepaliveStart >= 0 && keepaliveEnd > keepaliveStart ? source.slice(keepaliveStart, keepaliveEnd) : "";
  assert.match(keepaliveText, /firstHeartbeatAtMs: number/);
  assert.match(keepaliveText, /intervalMs: number/);
  assert.match(keepaliveText, /const firstDelayMs = Date\.now\(\) >= firstHeartbeatAtMs\s*\? 250\s*: Math\.max\(250, firstHeartbeatAtMs - Date\.now\(\)\)/);
  assert.match(keepaliveText, /setTimeout\(startRecurringKeepalive, firstDelayMs\)/);
  assert.match(keepaliveText, /setInterval\(sendPairedKeepalive, intervalMs\)/);
  assert.doesNotMatch(keepaliveText, /await this\.write/);
});
test("paired heartbeat delay stays aligned after one or more elapsed intervals", () => {
  assert.equal(calculateDirectPairedKeepaliveDelayForTest(0), 5_000);
  assert.equal(calculateDirectPairedKeepaliveDelayForTest(4_900), 250);
  assert.equal(calculateDirectPairedKeepaliveDelayForTest(5_000), 250);
  assert.equal(calculateDirectPairedKeepaliveDelayForTest(5_100), 4_900);
  assert.equal(calculateDirectPairedKeepaliveDelayForTest(12_000), 3_000);
});
test("short link bootstrap continues through the final partial timeout window", () => {
  const start = source.indexOf("  private async drainBootstrapFrames(");
  const end = source.indexOf("  private async waitForFrame(", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.match(text, /if \(error instanceof AppError && error\.statusCode === 504\) \{\s*if \(Date\.now\(\) < deadline\) \{\s*continue;\s*\}\s*break;/);
});
test("bootstrap ignores unrelated prime failures but preserves login and explicit auth failures", () => {
  assert.equal(
    findDirectBootstrapErrorForTest([
      { Result: 0, Reason: "REST call failed", TrackCode: "prime-track" }
    ], "login-track"),
    undefined
  );
  assert.match(
    findDirectBootstrapErrorForTest([
      { Result: 0, Reason: "REST call failed", trackCode: "login-track" }
    ], "login-track") ?? "",
    /REST call failed/
  );
  assert.match(
    findDirectBootstrapErrorForTest([
      { Result: 0, ErrCode: 60014, Reason: "token is not correct", TrackCode: "prime-track" }
    ], "login-track") ?? "",
    /token is not correct|60014/i
  );
  assert.match(
    findDirectBootstrapErrorForTest([
      { Result: 0, Reason: "authen failed" }
    ], "login-track") ?? "",
    /authen failed/i
  );
  assert.match(
    findDirectBootstrapErrorForTest([
      { Result: 0, ErrCode: 60011, Reason: "session auth rejected" }
    ], "login-track") ?? "",
    /60011|session auth rejected/i
  );
  assert.match(
    findDirectBootstrapErrorForTest([
      { Result: 0, Reason: "deviceID not find" }
    ], "login-track") ?? "",
    /deviceID not find/i
  );
});
test("bootstrap TrackCode matching handles rounded JSON numbers without admitting another counter", () => {
  const expected = "40051186651013123";
  const nextCounter = (BigInt(expected) + 4096n).toString();
  assert.equal(directTrackCodesMatchForTest(expected, expected), true);
  assert.equal(directTrackCodesMatchForTest(Number(expected), expected), true);
  assert.equal(directTrackCodesMatchForTest(nextCounter, expected), false);
  assert.equal(directTrackCodesMatchForTest(Number(nextCounter), expected), false);
});
test("session TrackCode generator advances by the native low-12-bit stride", () => {
  const nextTrackCode = createDirectTrackCodeGeneratorForTest("track-code-test-seed");
  const first = nextTrackCode();
  const second = nextTrackCode();
  assert.equal(BigInt(second) - BigInt(first), 4096n);
  assert.notEqual(Number(first), Number(second));
  assert.equal(directTrackCodesMatchForTest(Number(first), first), true);
  assert.equal(directTrackCodesMatchForTest(Number(second), first), false);
  assert.equal(directTrackCodesMatchForTest(first, first), true);
  assert.equal(directTrackCodesMatchForTest(second, first), false);
});
test("registerEmail uses standard PKCS7 padding for non-block-aligned email addresses", () => {
  const start = source.indexOf("function buildRegisterEmailJson(");
  const end = source.indexOf("function buildActivationClientInfo", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.match(text, /EmailEncrypt: encryptActivationTarget\(lowerEmail\)/);
  assert.doesNotMatch(text, /extraPaddingBlock/);
});
test("authenticated bootstrap correlates ordinary errors with its login TrackCode", () => {
  const start = source.indexOf("  private async bootstrapAuthenticatedSession(");
  const end = source.indexOf("  private async drainBootstrapFrames(", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.match(text, /const loginTrackCode = this\.nextTrackCode\(\)/);
  assert.match(text, /loginTrackCode,/);
  assert.match(text, /this\.findBootstrapError\(loginTrackCode\)/);
});
test("bootstrap drain keeps notify-only message indexes for the normal push handler", () => {
  const start = source.indexOf("  private async drainBootstrapFrames(");
  const end = source.indexOf("  private async waitForFrame(", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.match(text, /const push = frameToDirectPush\(frame\);\s*if \(push\.sms \|\| isNotifyOnlyMessageIndexPush\(push\)\) \{\s*this\.pendingPushes\.push\(push\);\s*\}/);
  assert.match(source, /if \(\s*isNotifyOnlyMessageIndexPush\(push\)[\s\S]*requestOfflineCatchup\(currentLinkSession, host, "notify-only"\)/);
});
test("direct link session reproduces the app's pre-registration initialization order", () => {
  const openStart = source.indexOf("  async openLink(account: DirectSessionAccount)");
  const openEnd = source.indexOf("  private async openPrelogin", openStart);
  const openText = openStart >= 0 && openEnd > openStart ? source.slice(openStart, openEnd) : "";
  const prelogin = openText.indexOf("await this.openPrelogin(account)");
  const bootstrap = openText.indexOf("await this.bootstrapAuthenticatedSession(account, DIRECT_LINK_BOOTSTRAP_WAIT_MS");
  const prime = openText.indexOf("await this.primeLinkRegistration(account)");
  const keepaliveArmed = openText.indexOf("await this.startSocketKeepalive()");
  assert.ok(prelogin >= 0);
  assert.ok(bootstrap > prelogin);
  assert.ok(keepaliveArmed > bootstrap);
  assert.ok(prime > bootstrap);

  const bootstrapStart = source.indexOf("  private async bootstrapAuthenticatedSession(");
  const bootstrapEnd = source.indexOf("  private findBootstrapError", bootstrapStart);
  const bootstrapText = bootstrapStart >= 0 && bootstrapEnd > bootstrapStart ? source.slice(bootstrapStart, bootstrapEnd) : "";
  const loginWrite = bootstrapText.indexOf("await this.write(packet)");
  const onStarted = bootstrapText.indexOf("await onStarted?.()");
  const drain = bootstrapText.indexOf("await this.drainBootstrapFrames(waitMs)");
  assert.match(bootstrapText, /onStarted\?: \(\) => Promise<void> \| void/);
  assert.ok(loginWrite >= 0);
  assert.ok(onStarted > loginWrite);
  assert.ok(drain > onStarted);

  const primeStart = source.indexOf("  private async primeLinkRegistration(");
  const primeEnd = source.indexOf("  private async openPrelogin", primeStart);
  const primeText = primeStart >= 0 && primeEnd > primeStart ? source.slice(primeStart, primeEnd) : "";
  const orderedCalls = [
    '"followerListInfo"',
    '"getFriendList"',
    '"infoBus"',
    '"getBalance"',
    '"glb/userPropertites"',
    '"gwebsvr/infoBus"',
    '"clientInfo"'
  ];
  let previous = -1;
  for (const call of orderedCalls) {
    const index = primeText.indexOf(call);
    assert.ok(index > previous, `${call} should follow the captured app order`);
    previous = index;
  }
  assert.equal((primeText.match(/"queryRtcServersEx"/g) ?? []).length, 2);
  assert.match(primeText, /buildDirectSessionClientInfoQuery/);
  assert.doesNotMatch(primeText, /dt_direct_template_offline_messages|requestAllOfflineMessage|sendConfiguredTemplate/);
});
test("gateway discovery and paired probes never request offline messages implicitly", () => {
  const discoveryStart = source.indexOf("async function discoverDirectPushHostsForListener");
  const discoveryEnd = source.indexOf("async function runPushMaintenanceCalls", discoveryStart);
  const discoveryText = discoveryStart >= 0 && discoveryEnd > discoveryStart ? source.slice(discoveryStart, discoveryEnd) : "";
  const probeStart = source.indexOf("export async function probeDirectPushSocket");
  const probeEnd = source.indexOf("export async function fetchDirectWebOfflineMessages", probeStart);
  const probeText = probeStart >= 0 && probeEnd > probeStart ? source.slice(probeStart, probeEnd) : "";
  assert.doesNotMatch(discoveryText, /requestOfflineCatchup|dt_direct_template_offline_messages|requestAllOfflineMessage/);
  assert.doesNotMatch(probeText, /requestOfflineCatchup|dt_direct_template_offline_messages|requestAllOfflineMessage/);
});
test("direct frame wait yields while draining queued frames", () => {
  assert.match(source, /function yieldToEventLoop\(\)/);
  assert.match(source, /await yieldToEventLoop\(\)/);
  assert.match(source, /const parsed = parseFrame\(raw\);\s*if \(predicate\(parsed\)\) \{/);
  assert.doesNotMatch(source, /predicate\(parseFrame\(raw\)\)/);
});
test("direct listener avoids expensive decoders when no JSON or SMS payload is needed", () => {
  assert.match(source, /const shouldExtractJsonPayload = parsed\.type === 0x8107 && parsed\.status === 0x0102 && \(this\.jsonWaiters\.size > 0 \|\| Date\.now\(\) <= this\.jsonCaptureUntil\)/);
  assert.match(source, /const jsonPayload = shouldExtractJsonPayload \? extractJsonPayload\(parsed\.raw\) : null/);
  assert.match(source, /const smsPush = parsed\.type === 0x8107 && parsed\.status === 0x0103 \? tryParseSmsPush\(parsed\.raw\) \?\? tryParseSmsPush\(parsed\.body\) : null/);
  assert.match(source, /const candidatePush = frameToDirectPush\(frame\)/);
  assert.match(source, /const sms = tryParseSmsPush\(frame\.raw\) \?\? tryParseSmsPush\(frame\.body\)/);
  assert.match(source, /jsonPayload: sms \? null : extractJsonPayload\(frame\.raw\)/);
});
test("active direct push readers parse SMS payloads before classifying 8107 response statuses", () => {
  const start = source.indexOf("  async waitForPushes(");
  const end = source.indexOf("  async close()", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  const parseIndex = text.indexOf("const candidatePush = frameToDirectPush(frame)");
  const statusGateIndex = text.indexOf("if (frame.status !== 0x0103)");
  assert.ok(parseIndex >= 0);
  assert.ok(statusGateIndex < 0 || parseIndex < statusGateIndex);
  assert.match(text, /if \(candidatePush\.sms\)/);
});
test("direct listener reports lightweight non-SMS frames for diagnostics and app catch-up", () => {
  assert.match(source, /const nonSmsFrame = frame\.status === 0x0103 \? candidatePush : frameToDirectFrameSummary\(frame\);[\s\S]*await invokeDirectListenerCallback\(onFrame, nonSmsFrame, this\.host\)/);
  const summaryStart = source.indexOf("function frameToDirectFrameSummary");
  const summaryEnd = source.indexOf("function frameToDirectPush", summaryStart);
  const summaryText = summaryStart >= 0 && summaryEnd > summaryStart ? source.slice(summaryStart, summaryEnd) : "";
  assert.match(summaryText, /sms: null/);
  assert.match(summaryText, /jsonPayload: null/);
  assert.doesNotMatch(summaryText, /tryParseSmsPush|extractJsonPayload/);
});
test("direct push wait throttles non-SMS frame floods", () => {
  assert.match(source, /const DIRECT_PUSH_NON_SMS_FRAME_BATCH_LIMIT = 5/);
  assert.match(source, /const DIRECT_PUSH_NON_SMS_FRAME_PAUSE_MS = 1_000/);
  assert.match(source, /nonSmsPushFrameCount >= DIRECT_PUSH_NON_SMS_FRAME_BATCH_LIMIT/);
  assert.match(source, /await delay\(DIRECT_PUSH_NON_SMS_FRAME_PAUSE_MS\)/);
  assert.match(source, /return pushes/);
});
test("direct socket queue keeps handshake frames and active waiters while dropping idle data floods", () => {
  assert.match(source, /const shouldQueueRawFrame =/);
  assert.match(source, /parsed\.status === 0x0101/);
  assert.match(source, /parsed\.status === 0x0103/);
  assert.match(source, /this\.rawWaiters\.size > 0/);
  assert.match(source, /const enqueueResult = enqueueDirectRawFrame\(this\.queue, frame, this\.queueBytes\)/);
  assert.match(source, /directResourceCounters\.rawQueueDrops \+= enqueueResult\.dropped;\s*this\.flushWaiters\(\)/);
});
test("direct socket keeps handshake frames while dropping only idle non-SMS data frames", () => {
  assert.match(source, /const shouldQueueRawFrame =/);
  assert.match(source, /parsed\.status === 0x0101/);
  assert.match(source, /parsed\.status === 0x0103/);
  assert.match(source, /this\.rawWaiters\.size > 0/);
  assert.doesNotMatch(source, /parsed\.type === 0x8107 && parsed\.status !== 0x0103\) \{\s*continue;/);
});

test("direct JSON capture is armed before request writes to avoid fast-response races", () => {
  assert.match(source, /private jsonCaptureUntil = 0/);
  assert.match(source, /private beginJsonCapture\(timeoutMs: number\)/);
  assert.match(source, /const shouldExtractJsonPayload = parsed\.type === 0x8107 && parsed\.status === 0x0102 && \(this\.jsonWaiters\.size > 0 \|\| Date\.now\(\) <= this\.jsonCaptureUntil\)/);
  assert.match(source, /this\.clearJsonQueue\(\);\s*this\.beginJsonCapture\(timeoutMs\);\s*await this\.write\(request\);/);
  assert.match(source, /async callJsonFromTemplate\([\s\S]*timeoutMs = this\.runtime\.ioTimeoutMs[\s\S]*this\.beginJsonCapture\(timeoutMs\)[\s\S]*this\.waitForJsonPayload\(timeoutMs/);
});
test("direct listener throttles repeated non-SMS skip logs per socket", () => {
  assert.match(source, /private skippedNonSmsLogCount = 0/);
  assert.match(source, /private shouldLogSkippedNonSmsFrame\(\)/);
  assert.match(source, /this\.skippedNonSmsLogCount >= 5/);
  assert.match(source, /this\.skippedNonSmsLogCount \+= 1/);
  assert.match(source, /if \(this\.shouldLogSkippedNonSmsFrame\(\)\) \{/);
  assert.doesNotMatch(source, /if \(nonSmsPushFrameCount <= 5\) \{/);
});
test("direct socket drops idle non-SMS data frames before trace work", () => {
  assert.match(source, /const shouldTraceFrame =/);
  assert.match(source, /if \(!shouldTraceFrame\) \{[\s\S]*this\.shouldYieldBufferedConsume\(processedFrames\)[\s\S]*continue;[\s\S]*\}/);
  const consumeStart = source.indexOf("private consume(chunk: Buffer)");
  const traceIndex = source.indexOf("this.trace.push", consumeStart);
  const dropIndex = source.indexOf("if (!shouldTraceFrame)", consumeStart);
  assert.ok(dropIndex > consumeStart);
  assert.ok(traceIndex > dropIndex);
});
test("direct socket never pauses authenticated reads while dropping idle non-SMS frames", () => {
  assert.doesNotMatch(source, /this\.socket(?:\?)?\.pause\(\)/);
  assert.doesNotMatch(source, /this\.socket(?:\?)?\.resume\(\)/);
  assert.doesNotMatch(source, /DIRECT_IDLE_NON_SMS_FRAME_PAUSE_/);
  assert.match(source, /if \(!shouldTraceFrame\) \{[\s\S]*this\.shouldYieldBufferedConsume\(processedFrames\)[\s\S]*continue;[\s\S]*\}/);
});
test("direct socket destroys remote-ended connections", () => {
  assert.match(source, /this\.socket\.on\("end", \(\) => \{/);
  assert.match(source, /this\.socket\?\.destroy\(\)/);
  assert.match(source, /Direct gateway socket ended/);
});
test("direct listener reconnects after a closed socket instead of treating it as an empty push wait", () => {
  const waitForPushes = source.slice(source.indexOf("async waitForPushes("), source.indexOf("async close()", source.indexOf("async waitForPushes(")));

  assert.match(waitForPushes, /if \(isSocketClosedError\(error\)\) \{\s*throw error;\s*\}/);
  assert.match(source, /if \(!socket \|\| this\.closed \|\| socket\.destroyed \|\| !socket\.writable\) \{/);
});
test("direct common sessions start the keepalive only after authenticated bootstrap", () => {
  assert.match(source, /const DIRECT_SESSION_KEEPALIVE_INTERVAL_MS = 5_000/);
  assert.match(source, /const DINGDONG_SESSION_KEEPALIVE_INTERVAL_MS = 5_000/);
  assert.match(source, /function directSessionKeepaliveIntervalMs\(account/);
  assert.match(source, /account\?\.appVariant === "dingdong"\s*\? DINGDONG_SESSION_KEEPALIVE_INTERVAL_MS\s*:\s*DIRECT_SESSION_KEEPALIVE_INTERVAL_MS/);
  assert.match(source, /private keepaliveWriteCount = 0/);
  assert.match(source, /function buildDirectSessionKeepaliveFrame\(session: Buffer\)/);
  assert.match(source, /frame\.writeUInt32BE\(17, 2\)/);
  assert.match(source, /frame\.writeUInt16BE\(0x8107, 6\)/);
  assert.match(source, /session\.copy\(frame, 8, 0, 4\)/);
  assert.match(source, /frame\.writeUInt32BE\(1, 12\)/);
  assert.match(source, /frame\[16\] = 0xff/);
  assert.match(source, /private async startSocketKeepalive\(\)/);
  assert.match(source, /await this\.write\(buildDirectSessionKeepaliveFrame\(this\.sessionId\)\)/);
  assert.match(source, /void this\.write\(buildDirectSessionKeepaliveFrame\(this\.sessionId\)\)/);
  assert.match(source, /directSessionKeepaliveIntervalMs\(this\.account\)/);
  assert.match(source, /this\.keepaliveWriteCount \+= 1/);
  assert.match(source, /keepaliveWrites=\$\{this\.keepaliveWriteCount\}/);
  assert.match(source, /async open\(account: DirectSessionAccount\) \{\s*await this\.openPrelogin\(account\);\s*await this\.bootstrapAuthenticatedSession\(account\);\s*await this\.startSocketKeepalive\(\)/);
  assert.match(source, /this\.route = Buffer\.from\(preloginResp\.body\.subarray\(8, 16\)\)/);
  assert.match(source, /this\.stopSocketKeepalive\(\)/);
  assert.match(source, /while \(this\.buffer\[0\] === 0xff\)/);
  assert.doesNotMatch(source, /runDirectKeepaliveWorker/);
  assert.doesNotMatch(source, /openKeepalive/);
  assert.doesNotMatch(source, /keepaliveTask/);
});
test("direct reconnects quickly and keeps SMS plus web-offline catch-up available", () => {
  assert.match(source, /const DIRECT_RECONNECT_BACKOFF_MAX_MS = 1_000/);
  assert.match(source, /Math\.min\(DIRECT_RECONNECT_BACKOFF_MAX_MS, 250 \+ Math\.min\(attempts, 3\) \* 250\)/);
  assert.match(source, /sendConfiguredTemplate\("dt_direct_template_offline_messages"/);
  assert.match(source, /callJsonFromTemplate\("getWebOfflineMessage", TEMPLATES\.getWebOfflineMessage/);
});
test("direct offline catch-up patches the captured device identity", () => {
  assert.match(source, /const CAPTURED_OFFLINE_FIELDS = \{[\s\S]*deviceId: "And\.11111111111111111111111111111111\.dttalk"/);
  assert.match(source, /\[CAPTURED_OFFLINE_FIELDS\.deviceId, params\.deviceId\]/);
});
test("direct listener treats legacy dtId phone notifications as immediate catch-up signals", () => {
  assert.match(source, /isOfflineMessageIndexPush/);
  assert.match(source, /const offlineMessageIndexPush = parsed\.type === 0x8107 && parsed\.status === 0x0103/);
  assert.match(source, /acknowledgePushFrame\(parsed, Boolean\(smsPush\) \|\| offlineMessageIndexPush\)/);
  assert.match(source, /if \(\s*isNotifyOnlyMessageIndexPush\(push\)/);
});
test("direct socket yields while draining large buffered frame batches", () => {
  assert.match(source, /const DIRECT_SOCKET_FRAME_BUDGET_PER_TICK = 20/);
  assert.match(source, /private bufferedConsumeScheduled = false/);
  assert.match(source, /private shouldYieldBufferedConsume\(processedFrames: number\)/);
  assert.match(source, /this\.scheduleBufferedConsume\(\)/);
  assert.match(source, /setImmediate\(\(\) => \{/);
  assert.match(source, /this\.consume\(Buffer\.alloc\(0\)\)/);
});
