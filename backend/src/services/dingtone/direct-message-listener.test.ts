import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDirectRouteCoordinatorForTest } from "./direct-gateway.js";

const source = readFileSync(new URL("./direct-gateway.ts", import.meta.url), "utf8");

test("direct message listener records the primed offline request and waits for notify-only catch-up", () => {
  assert.match(source, /await this\.sendConfiguredTemplate\("dt_direct_template_offline_messages"/);
  assert.match(source, /nextOfflineCatchupAt/);
  assert.match(source, /nextOfflineCatchupAt = deadline/);
  assert.match(source, /reason: "startup"/);
  assert.match(source, /offlineTemplateSendCount/);
});

test("direct message listener keeps two paired gateway workers active within a window", () => {
  assert.match(source, /const discoveredHosts = input\.shouldContinue/);
  assert.match(source, /discoverDirectPushHostsForListener\(discoverySession, runtime, input\.account\)/);
  assert.match(source, /const hosts = uniqueHosts\(\[baseHosts\[0\] \?\? runtime\.primaryHost, \.\.\.discoveredHosts, \.\.\.baseHosts\]\)/);
  assert.match(source, /const DIRECT_PUSH_HOST_CONCURRENCY = 2/);
  assert.match(source, /const workerHosts = hosts\.slice\(0, DIRECT_PUSH_HOST_CONCURRENCY\)/);
  assert.match(source, /await Promise\.allSettled\(workerHosts\.map\(runPairedHostWorker\)\)/);
  assert.match(source, /const runPairedHostWorker = async \(host: string/);
  assert.match(source, /const isWithinCurrentListenWindow = \(\) => Date\.now\(\) < deadline/);
  assert.match(source, /await pushSession\.openPush\(input\.account\)/);
  assert.match(source, /await linkSession\.openLink\(input\.account\)/);
  assert.match(source, /runPushLinkRegistration\(linkSession, runtime, input\.account\)/);
  assert.match(source, /pushSession\.waitForPushes/);
  assert.match(source, /currentLinkSession\.waitForPushes/);
  assert.match(source, /while \(!listener\.preempted && hasRemainingListenWindow\(\) && pushes\.length < maxPushFrames\)/);
  assert.match(source, /const waitUntil = Math\.min\([\s\S]*nextOfflineCatchupAt[\s\S]*nextWebOfflinePollAt/);
  assert.doesNotMatch(source, /discoverDirectPushHostsOnSession/);
  assert.doesNotMatch(source, /Direct account RTC host discovery completed/);
  assert.doesNotMatch(source, /DIRECT_RTC_DISCOVERY_TIMEOUT_MS/);
  assert.doesNotMatch(source, /listenPrime\.queryRtcServersEx/);
  assert.doesNotMatch(source, /DIRECT_PUSH_HOST_LISTEN_SLICE_MS/);
  assert.doesNotMatch(source, /hostDeadline/);
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
  assert.match(source, /const registrationOwnerHost = workerHosts\[0\] \?\? runtime\.primaryHost/);
  assert.match(source, /const routeCoordinator = createDirectRouteCoordinator\(registrationOwnerHost\)/);
  assert.match(source, /if \(!routeCoordinator\.shouldClaim\(host\)\)/);
  assert.match(source, /routeCoordinator\.markPrimaryUnavailable\(\)/);
  assert.match(source, /calls\.push\(await runPushLinkRegistration/);
  assert.match(source, /const registration = calls\[calls\.length - 1\]/);
  assert.match(source, /secondary paired workers stay authenticated without replacing the primary SMS route/);
});

test("route ownership fails over to backup and ignores stale releases", () => {
  const coordinator = createDirectRouteCoordinatorForTest("primary");
  assert.equal(coordinator.shouldClaim("backup"), false);
  coordinator.markPrimaryUnavailable();
  assert.equal(coordinator.shouldClaim("backup"), true);
  const backupEpoch = coordinator.claim("backup");
  assert.equal(coordinator.ownerHost(), "backup");
  assert.equal(coordinator.shouldClaim("other"), false);
  assert.equal(coordinator.shouldClaim("primary"), true);
  const primaryEpoch = coordinator.claim("primary");
  assert.equal(coordinator.ownerHost(), "primary");
  coordinator.release("backup", backupEpoch);
  assert.equal(coordinator.ownerHost(), "primary");
  coordinator.release("primary", primaryEpoch);
  assert.equal(coordinator.ownerHost(), null);
  assert.equal(coordinator.shouldClaim("backup"), true);
});

test("authenticated link reconnects keep the established SMS route sticky", () => {
  const closeStart = source.indexOf("const closeLinkSession = async () =>");
  const closeEnd = source.indexOf("const ensureRouteRegistration = async", closeStart);
  const closeText = closeStart >= 0 && closeEnd > closeStart ? source.slice(closeStart, closeEnd) : "";
  assert.doesNotMatch(closeText, /routeCoordinator\.release/);

  const registerStart = source.indexOf("const ensureRouteRegistration = async");
  const registerEnd = source.indexOf("const ensureLinkSession = async", registerStart);
  const registerText = registerStart >= 0 && registerEnd > registerStart ? source.slice(registerStart, registerEnd) : "";
  assert.match(registerText, /routeCoordinator\.release\(host, reservedEpoch\)/);
  assert.match(registerText, /routeCoordinator\.markPrimaryUnavailable\(\)/);
});

test("preempted listeners cannot create or register replacement sessions", () => {
  assert.match(source, /function isActiveDirectPushListener\(listener: ActiveDirectPushListener\)/);
  assert.match(source, /if \(active\.preempted\) \{\s*await active\.done;\s*return true;/);
  assert.match(source, /if \(!isActiveDirectPushListener\(listener\)\) \{\s*await pushSession\.close/);
  assert.match(source, /await linkSession\.openLink\(input\.account\);\s*if \(!isActiveDirectPushListener\(listener\)\)/);
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

test("direct message listener prioritizes gateways that delivered SMS", () => {
  assert.match(source, /"20\.97\.117\.109"/);
  assert.match(source, /"206\.189\.228\.89"/);
  assert.match(source, /const directSmsHostAffinity = new Map/);
  assert.match(source, /rememberDirectSmsHost\(input\.account, frameHost\)/);
  assert.match(source, /getPrioritizedDirectPushHosts\(runtime, input\.account\)/);
  assert.match(source, /uniqueHosts\(\[\.\.\.preferredHosts, \.\.\.APP_DIRECT_PUSH_HOSTS, runtime\.primaryHost, runtime\.backupHost\]\)/);
});

test("direct message listener fails the monitor cycle when no gateway session opens", () => {
  assert.match(source, /const hostErrors: unknown\[\] = \[\]/);
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
test("direct message listener re-registers the paired link after reconnects", () => {
  assert.match(source, /calls\.push\(await runPushLinkRegistration\(linkSession, runtime, input\.account\)\)/);
  assert.match(source, /attempts \+= 1/);
});
test("direct message listener repairs the link without closing a healthy push socket", () => {
  const start = source.indexOf("const ensureLinkSession = async");
  const end = source.indexOf("try {\n        await pushSession.openPush", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.match(text, /linkSession\?\.isOpen\(\)/);
  assert.match(text, /await linkSession\.openLink\(input\.account\)/);
  assert.match(text, /await ensureRouteRegistration\(linkSession\)/);
  assert.doesNotMatch(text, /pushSession\.close/);
  assert.match(source, /await pushSession\.waitForPushes/);
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
test("direct message listener delivery-confirms only parsed SMS or structured index notifications", () => {
  assert.match(source, /const offlineMessageIndexPush = parsed\.type === 0x8107 && parsed\.status === 0x0103/);
  assert.match(source, /acknowledgePushFrame\(parsed, Boolean\(smsPush\) \|\| offlineMessageIndexPush\)/);
  assert.match(source, /await this\.write\(ack\);[\s\S]*if \(!shouldConfirmDelivery \|\| !this\.account\) \{/);
});
test("direct message listener immediately requests offline catch-up only for notify-only message index frames", () => {
  assert.match(source, /reason: "startup" \| "interval" \| "notify-only"/);
  assert.match(source, /isNotifyOnlyMessageIndexPush\(push\)/);
  assert.match(source, /nextNotifyOnlyCatchupAt = Date\.now\(\) \+ DIRECT_NOTIFY_ONLY_CATCHUP_THROTTLE_MS/);
  assert.match(source, /const currentLinkSession = await ensureLinkSession\(\)/);
  assert.match(source, /requestOfflineCatchup\(currentLinkSession, host, "notify-only"\)/);
});
test("direct offline catch-up interval is conservative during long background listens", () => {
  assert.match(source, /const DIRECT_OFFLINE_CATCHUP_INTERVAL_MS = 30_000/);
  assert.match(source, /const DIRECT_NOTIFY_ONLY_CATCHUP_THROTTLE_MS = 60_000/);
});
test("direct message listener reports offline catch-up attempts to monitor diagnostics", () => {
  assert.match(source, /onOfflineCatchup\?:/);
  assert.match(source, /await input\.onOfflineCatchup\?\.\(/);
  assert.match(source, /offlineTemplateSendCount/);
});

test("direct offline catch-up retries soon after a failed template send", () => {
  assert.match(source, /DIRECT_OFFLINE_CATCHUP_RETRY_MS/);
  assert.match(source, /offlineTemplateError \? Date\.now\(\) \+ DIRECT_OFFLINE_CATCHUP_RETRY_MS : deadline/);
});

test("direct message listener polls team messages on the paired authenticated link", () => {
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
  assert.match(source, /requestWebOfflineMessages\(currentLinkSession, host\)/);
  assert.match(source, /nextWebOfflinePollAt/);
  assert.doesNotMatch(source, /const webOfflinePollTimer = setInterval/);
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
  assert.ok(registration > maintenance, "private-number state must refresh before route registration");
});
test("direct SMS push socket skips the short-session bootstrap batch", () => {
  const start = source.indexOf("  async openPush(account: DirectSessionAccount)");
  const end = source.indexOf("  async openLink(account: DirectSessionAccount)", start);
  const text = start >= 0 && end > start ? source.slice(start, end) : "";
  assert.match(text, /await this\.openPrelogin\(account\)/);
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
  const linkRegistration = text.indexOf("runPushLinkRegistration(linkSession, runtime, input.account)");
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
test("paired direct sockets use the app's delayed five-second heartbeat", () => {
  assert.match(source, /const DIRECT_PAIRED_KEEPALIVE_INTERVAL_MS = 5_000/);
  const openStart = source.indexOf("  async openPush(account: DirectSessionAccount)");
  const openEnd = source.indexOf("  private async openPrelogin", openStart);
  const openText = openStart >= 0 && openEnd > openStart ? source.slice(openStart, openEnd) : "";
  assert.match(openText, /await this\.openPrelogin\(account\);\s*this\.startPairedKeepalive\(\)/);
  assert.match(openText, /async openLink\(account: DirectSessionAccount\)[\s\S]*await this\.openPrelogin\(account\);[\s\S]*await this\.bootstrapAuthenticatedSession\(account\);[\s\S]*this\.startPairedKeepalive\(\)/);
  const keepaliveStart = source.indexOf("  private startPairedKeepalive()");
  const keepaliveEnd = source.indexOf("  private async startSocketKeepalive", keepaliveStart);
  const keepaliveText = keepaliveStart >= 0 && keepaliveEnd > keepaliveStart ? source.slice(keepaliveStart, keepaliveEnd) : "";
  assert.match(keepaliveText, /setInterval/);
  assert.match(keepaliveText, /DIRECT_PAIRED_KEEPALIVE_INTERVAL_MS/);
  assert.doesNotMatch(keepaliveText, /await this\.write/);
});
test("direct link session reproduces the app's pre-registration initialization order", () => {
  const openStart = source.indexOf("  async openLink(account: DirectSessionAccount)");
  const openEnd = source.indexOf("  private async openPrelogin", openStart);
  const openText = openStart >= 0 && openEnd > openStart ? source.slice(openStart, openEnd) : "";
  const bootstrap = openText.indexOf("await this.bootstrapAuthenticatedSession(account)");
  const prime = openText.indexOf("await this.primeLinkRegistration(account)");
  const keepalive = openText.indexOf("this.startPairedKeepalive()");
  assert.ok(bootstrap >= 0);
  assert.ok(prime > bootstrap);
  assert.ok(keepalive > prime);

  const primeStart = source.indexOf("  private async primeLinkRegistration(");
  const primeEnd = source.indexOf("  private async openPrelogin", primeStart);
  const primeText = primeStart >= 0 && primeEnd > primeStart ? source.slice(primeStart, primeEnd) : "";
  const orderedCalls = [
    '"followerListInfo"',
    '"getFriendList"',
    '"infoBus"',
    '"requestAllOfflineMessage"',
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
  assert.match(primeText, /const offlineTemplateSent = await this\.sendConfiguredTemplate/);
  assert.match(primeText, /if \(!offlineTemplateSent\)[\s\S]*Direct offline message template is unavailable/);
});
test("direct frame wait yields while draining queued frames", () => {
  assert.match(source, /function yieldToEventLoop\(\)/);
  assert.match(source, /await yieldToEventLoop\(\)/);
  assert.match(source, /const parsed = parseFrame\(raw\);\s*if \(predicate\(parsed\)\) \{/);
  assert.doesNotMatch(source, /predicate\(parseFrame\(raw\)\)/);
});
test("direct listener avoids expensive decoders when no JSON or SMS payload is needed", () => {
  assert.match(source, /const shouldExtractJsonPayload = parsed\.type === 0x8107 && parsed\.status === 0x0102 && \(this\.jsonResolvers\.length > 0 \|\| Date\.now\(\) <= this\.jsonCaptureUntil\)/);
  assert.match(source, /const jsonPayload = shouldExtractJsonPayload \? extractJsonPayload\(parsed\.raw\) : null/);
  assert.match(source, /const smsPush = parsed\.type === 0x8107 && parsed\.status === 0x0103 \? tryParseSmsPush\(parsed\.raw\) \?\? tryParseSmsPush\(parsed\.body\) : null/);
  assert.match(source, /const candidatePush = frameToDirectPush\(frame\)/);
  assert.match(source, /sms: tryParseSmsPush\(frame\.raw\) \?\? tryParseSmsPush\(frame\.body\)/);
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
  assert.match(source, /const nonSmsFrame = frame\.status === 0x0103 \? candidatePush : frameToDirectFrameSummary\(frame\);[\s\S]*await onFrame\?\.\(nonSmsFrame, this\.host\)/);
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
  assert.match(source, /this\.resolvers\.length > 0/);
  assert.match(source, /if \(shouldQueueRawFrame\) \{\s*this\.queue\.push\(frame\);\s*this\.flushWaiters\(\);\s*\}/);
});
test("direct socket keeps handshake frames while dropping only idle non-SMS data frames", () => {
  assert.match(source, /const shouldQueueRawFrame =/);
  assert.match(source, /parsed\.status === 0x0101/);
  assert.match(source, /parsed\.status === 0x0103/);
  assert.match(source, /this\.resolvers\.length > 0/);
  assert.doesNotMatch(source, /parsed\.type === 0x8107 && parsed\.status !== 0x0103\) \{\s*continue;/);
});

test("direct JSON capture is armed before request writes to avoid fast-response races", () => {
  assert.match(source, /private jsonCaptureUntil = 0/);
  assert.match(source, /private beginJsonCapture\(timeoutMs: number\)/);
  assert.match(source, /const shouldExtractJsonPayload = parsed\.type === 0x8107 && parsed\.status === 0x0102 && \(this\.jsonResolvers\.length > 0 \|\| Date\.now\(\) <= this\.jsonCaptureUntil\)/);
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
  assert.match(source, /if \(!shouldTraceFrame\) \{[\s\S]*this\.pauseIdleSocketAfterDroppedFrame\(parsed\);[\s\S]*this\.shouldYieldBufferedConsume\(processedFrames\)[\s\S]*continue;[\s\S]*\}/);
  const consumeStart = source.indexOf("private consume(chunk: Buffer)");
  const traceIndex = source.indexOf("this.trace.push", consumeStart);
  const dropIndex = source.indexOf("if (!shouldTraceFrame)", consumeStart);
  assert.ok(dropIndex > consumeStart);
  assert.ok(traceIndex > dropIndex);
});
test("direct socket applies socket backpressure while dropping idle non-SMS frames", () => {
  assert.match(source, /const DIRECT_IDLE_NON_SMS_FRAME_PAUSE_BATCH = 3/);
  assert.match(source, /const DIRECT_IDLE_NON_SMS_FRAME_PAUSE_MS = 750/);
  assert.match(source, /private idleDroppedNonSmsFrameCount = 0/);
  assert.match(source, /private pauseIdleSocketAfterDroppedFrame\(parsed: ParsedFrame\)/);
  assert.match(source, /this\.socket\.pause\(\)/);
  assert.match(source, /this\.socket\?\.resume\(\)/);
  assert.match(source, /this\.pauseIdleSocketAfterDroppedFrame\(parsed\);[\s\S]*this\.shouldYieldBufferedConsume\(processedFrames\)[\s\S]*continue;/);
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
test("direct listener keeps the authenticated socket alive with an in-session keepalive frame", () => {
  assert.match(source, /const DIRECT_SESSION_KEEPALIVE_INTERVAL_MS = 5_000/);
  assert.match(source, /const DINGDONG_SESSION_KEEPALIVE_INTERVAL_MS = 2_000/);
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
  assert.match(source, /async open\(account: DirectSessionAccount\) \{\s*await this\.openPrelogin\(account\);\s*await this\.startSocketKeepalive\(\);\s*await this\.bootstrapAuthenticatedSession\(account\)/);
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
  assert.match(source, /if \(isNotifyOnlyMessageIndexPush\(push\)/);
});
test("direct socket yields while draining large buffered frame batches", () => {
  assert.match(source, /const DIRECT_SOCKET_FRAME_BUDGET_PER_TICK = 20/);
  assert.match(source, /private bufferedConsumeScheduled = false/);
  assert.match(source, /private shouldYieldBufferedConsume\(processedFrames: number\)/);
  assert.match(source, /this\.scheduleBufferedConsume\(\)/);
  assert.match(source, /setImmediate\(\(\) => \{/);
  assert.match(source, /this\.consume\(Buffer\.alloc\(0\)\)/);
});
