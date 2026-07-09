import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./direct-gateway.ts", import.meta.url), "utf8");

test("direct message listener periodically requests offline messages during long listens", () => {
  assert.match(source, /DIRECT_OFFLINE_CATCHUP_INTERVAL_MS/);
  assert.match(source, /nextOfflineCatchupAt/);
  assert.match(source, /Date\.now\(\) >= nextOfflineCatchupAt/);
  assert.match(source, /offlineTemplateSendCount/);
});

test("direct message listener keeps selected static RTC hosts stable during normal refresh windows", () => {
  assert.match(source, /const hosts = baseHosts/);
  assert.match(source, /const assignedHosts = hosts\.slice\(0, workerCount\)/);
  assert.match(source, /while \(!listener\.preempted && Date\.now\(\) < deadline && pushes\.length < maxPushFrames\)/);
  assert.match(source, /const waitUntil = nextOfflineCatchupAt > 0 \? Math\.min\(deadline, nextOfflineCatchupAt\) : deadline/);
  assert.doesNotMatch(source, /const discoveredHosts = input\.listenSeconds >= 15 \? await discoverDirectPushHosts/);
  assert.doesNotMatch(source, /DIRECT_PUSH_HOST_LISTEN_SLICE_MS/);
  assert.doesNotMatch(source, /hostDeadline/);
});
test("direct message listener uses one stable host window per account", () => {
  const settingsSource = readFileSync(new URL("../settings.service.ts", import.meta.url), "utf8");
  assert.match(settingsSource, /\["dt_direct_listener_host_concurrency",\s*"1"/);
  assert.match(settingsSource, /\["dt_direct_listener_host_concurrency",\s*"6",\s*"1"\]/);
  assert.match(settingsSource, /\["dt_direct_listener_host_concurrency",\s*"1",/);
  assert.match(source, /listenHostConcurrency: parsePositiveIntSetting\(settings\.dt_direct_listener_host_concurrency, 1, 1, 1\)/);
  assert.match(source, /const workerCount = Math\.max\(1, Math\.min\(runtime\.listenHostConcurrency, hosts\.length\)\)/);
});

test("direct message listener fails the monitor cycle when no gateway session opens", () => {
  assert.match(source, /const hostErrors: unknown\[\] = \[\]/);
  assert.match(source, /attempts > 0 && trace\.length === 0 && pushes\.length === 0 && !offlineTemplateAttempted && hostErrors\.length > 0/);
  assert.match(source, /throw normalizeDirectError\(lastError \?\? hostErrors\[hostErrors\.length - 1\]\)/);
});
test("direct message listener enters push read loop without asset refresh prime calls", () => {
  assert.match(source, /listenPrime\.updateClientLink/);
  assert.match(source, /listenPrime\.queryRtcServersEx#flags9/);
  assert.doesNotMatch(source, /listenPrime\.getBalance/);
  assert.doesNotMatch(source, /listenPrime\.getNumberCountries/);
  assert.doesNotMatch(source, /listenPrime\.glbUserPropertites/);
  assert.doesNotMatch(source, /listenPrime\.gwebInfoBus/);
});
test("direct message listener confirms notify-only push frames so message details can be delivered", () => {
  assert.match(source, /acknowledgePushFrame\(parsed, true\)/);
  assert.doesNotMatch(source, /acknowledgePushFrame\(parsed, Boolean\(smsPush\)\)/);
});
test("direct message listener immediately requests offline catch-up only for notify-only message index frames", () => {
  assert.match(source, /reason: "startup" \| "interval" \| "notify-only"/);
  assert.match(source, /isNotifyOnlyMessageIndexPush\(push\)/);
  assert.match(source, /nextNotifyOnlyCatchupAt = Date\.now\(\) \+ DIRECT_NOTIFY_ONLY_CATCHUP_THROTTLE_MS/);
  assert.match(source, /requestOfflineCatchup\(session, host, "notify-only"\)/);
});
test("direct offline catch-up interval is conservative during long background listens", () => {
  assert.match(source, /const DIRECT_OFFLINE_CATCHUP_INTERVAL_MS = 5 \* 60_000/);
  assert.match(source, /const DIRECT_NOTIFY_ONLY_CATCHUP_THROTTLE_MS = 60_000/);
});
test("direct message listener reports offline catch-up attempts to monitor diagnostics", () => {
  assert.match(source, /onOfflineCatchup\?:/);
  assert.match(source, /await input\.onOfflineCatchup\?\.\(/);
  assert.match(source, /offlineTemplateSendCount/);
});

test("direct offline catch-up retries soon after a failed template send", () => {
  assert.match(source, /DIRECT_OFFLINE_CATCHUP_RETRY_MS/);
  assert.match(source, /offlineTemplateError \? DIRECT_OFFLINE_CATCHUP_RETRY_MS : DIRECT_OFFLINE_CATCHUP_INTERVAL_MS/);
});
test("direct message listener confirms every notify-only indexed message id", () => {
  assert.match(source, /extractNotifyMessageIds/);
  assert.match(source, /const deliveryMessageIds = notifyMessageIds\.length > 0 \? notifyMessageIds : \[undefined\]/);
  assert.match(source, /for \(const messageId of deliveryMessageIds\)/);
  assert.match(source, /buildPushDeliveryConfirmFrame\(frame, this\.account, this\.nextPushDeliveryConfirmSerial\(\), messageId\)/);
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
test("direct message listener confirms legacy notify frames with embedded dtId values", () => {
  assert.match(source, /extractLegacyNotifyMessageIds/);
  assert.match(source, /extractLengthPrefixedAsciiFieldValues\(frame\.body, \["dtId", "msgId", "msgid", "messageId", "message_id"\]\)/);
  assert.match(source, /\.filter\(\(value\) => !notifyIds\.has\(value\)\)/);
});
test("direct message listener primes Dingtone private-number state without blocking DingDong listeners", () => {
  assert.match(source, /const primeCalls[^=]*= \[/);
  assert.match(source, /if \(account\.appVariant === "dingtone"\) \{/);
  assert.match(source, /listenPrime\.getPrivateNumber/);
  assert.match(source, /primeCalls\.unshift\(\{ name: "listenPrime\.getPrivateNumber"/);
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
  assert.match(source, /if \(frame\.status !== 0x0103\) \{[\s\S]*await yieldToEventLoop\(\);[\s\S]*continue;[\s\S]*\}/);
  assert.match(source, /sms: tryParseSmsPush\(frame\.raw\) \?\? tryParseSmsPush\(frame\.body\)/);
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
  assert.match(source, /this\.clearJsonQueue\(\);\s*this\.beginJsonCapture\(this\.runtime\.ioTimeoutMs\);\s*await this\.write\(request\);/);
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
test("direct socket yields while draining large buffered frame batches", () => {
  assert.match(source, /const DIRECT_SOCKET_FRAME_BUDGET_PER_TICK = 20/);
  assert.match(source, /private bufferedConsumeScheduled = false/);
  assert.match(source, /private shouldYieldBufferedConsume\(processedFrames: number\)/);
  assert.match(source, /this\.scheduleBufferedConsume\(\)/);
  assert.match(source, /setImmediate\(\(\) => \{/);
  assert.match(source, /this\.consume\(Buffer\.alloc\(0\)\)/);
});