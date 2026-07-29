# requestPrivateNumber Native 607 Notes

## Status

- No phone purchase has been attempted from this investigation.
- The backend now reconstructs the authenticated native CommonRest query around the Java `RequestPrivateNumberEncoder.apiParams` value and sends it through the captured CommonRest wire template.
- Static serialization shows that `commandTag=607` is local callback correlation metadata. It is folded into an in-process request key but is not serialized into `ProxyRestCallRequestParam`, so a separate 607-specific wire template is not required.
- A 2026-07-23 plaintext TCP capture confirmed the serialized request context is `00 00 00 00 00 00 00 01`, not the local callback key `00 00 00 00 02 5f 01 01`.
- A live TalkU replay on account 446 opened the country list, selected Belgium, and stopped at the candidate-number preview page. The Continue/purchase action was not touched.

## Confirmed Live Java Shape

The App builds a `DTCommonRestCallCmd` with:

- `commandTag=607`
- `apiName=/pstn/share/requestPrivateNumber`
- `apiParams=&countryCode=32&providerList=2002&isoCountryCode=BE&clientversion=6.3.1&supportCA=1&useStateCity=0&apiVersion=5&forceCheckNearByType=0&needToPay=true`
- `bNeedLogin=true`

The Java `apiParams` string does not include `token`, `deviceId`, `userId`, `TrackCode`, or `apkCertificateSign`.

The replay path used for the second confirmation was:

1. Start `me.dingtone.app.im.phonenumber.buy.CountryListOfPhoneNumberActivity`.
2. Tap `比利时(+32)` in the international-number list.
3. Observe `RequestPrivateNumberEncoder.encode` and `TpClient.commonRestCall`.
4. Stop before selecting a concrete number or pressing Continue.

## Native Static Evidence

`_tmp/talku-native/lib/arm64-v8a/libtzim.so` exposes these useful symbols:

- `NativeTpClient::CommonRestCall(_JNIEnv*, _jobject*)` at `0x003b5b44`
- `dingtone::GetCommonRestCallCmd(_JNIEnv*, _jobject*, tagDTCommonRestCallCmd&)` at `0x003d2fdc`
- `dingtone::RequestPrivateNumber(_JNIEnv*, _jobject*, tagDTRequestPrivateNumberCmd&)` at `0x003ca8c8`
- `EncodeWebRequestPrivateNumberParams(unsigned int, Jeesu::RequestPrivateNumberParamCmd const&)` at `0x0046e954`
- `CRpcClientInst::CommonRestCall(...)` at `0x0050c678`
- `RtcClient::ProxyRestCall(...)` at `0x00767668`
- `ProxyRestCallRequestParam::SerializeTo(...)` at `0x00773960`

Native strings show a lower-level request-private-number formatter that does include account and balance metadata:

- `token=%s&deviceId=%s&userId=%lld&countryCode=%d&areaCode=%d&nearByAreaCode=%s&providerList=%s&isoCountryCode=%s&supportCA=%d&balance=%f&clientversion=%s`
- `token=%s&deviceId=%s&userId=%lld&countryCode=%d&areaCode=%d&npanxx=%d&nearByAreaCode=%s&providerList=%s&isoCountryCode=%s&supportCA=%d&balance=%f&clientversion=%s`

The live Java path uses `CommonRestCall`, not the separate exported `RequestPrivateNumber` RPC method. Static analysis of the live path proves this native query construction order:

1. `GetCommonRestCallCmd` reads `apiName` and `apiParams`.
2. An existing `&apkCertificateSign=` key is renamed to `&forgeCertificateSign=`.
3. Native appends `&appVersion=` when absent, then appends the real `&apkCertificateSign=`.
4. `CRpcClientInst::CommonRestCall` builds `deviceId=...&TrackCode=...&<apiParams>`.
5. For `bNeedLogin=true`, it appends `&userId=...&token=...` after `WebAPIWeakCheck`.
6. The request is sent as `ProxyRestCall(siteId, apiName, compressedQuery, emptyPayload)`.

The local correlation key is `(commandCookie << 32) | (commandTag << 16) | 0x101`. `RpcServiceCall` receives that value as callback context; `ProxyRestCallRequestParam::SerializeTo` serializes only site ID, API name, compressed query, and optional payload. This is why the captured `getPrivateNumber` template can safely carry `requestPrivateNumber` after its API name, query lengths, route, and compressed query are patched.

## 2026-07-23 Wire Capture Confirmation

An emulator-side TCP capture produced one complete `requestPrivateNumber` request and its same-socket response without selecting a candidate or pressing Continue.

- The request used the documented field order and `apiVersion=5`.
- The serialized eight-byte ProxyRest context was `00 00 00 00 00 00 00 01`.
- The response was zlib-compressed JSON with `Result=1` and 100 candidates.
- The current backend response extractor parsed that frame successfully, ruling out response decompression as the cause of the panel timeout.
- The captured App session shared a user ID with database account 455 but had a newer token/device pair, so its App-version and certificate values were not copied to account 440.

Before the fix, account 440 sent the local Java callback key `00 00 00 00 02 5f 01 01` on the wire. The server returned only a generic success acknowledgement and never delivered candidates. After changing only the wire context to the App-observed value, the direct helper and the management HTTP preview both returned 100 Belgium candidates, and the first candidate received a 900-credit quote. No purchase RPC was sent.

## Current Emulator Limitation

The current emulator shows `libtzim.so` in `/proc/<pid>/maps` under the App arm64 library directory, but Frida inside the attached process reports `Process.findModuleByName("libtzim.so") == null`. This matches an x86/native-bridge style runtime where direct Frida symbol hooks against the arm64 `libtzim.so` are not reliable.

Observed effect:

- Java hooks can capture `DTCommonRestCallCmd` before the native boundary.
- `TpClientForJNI.nativeRestCall` and `nativeRestCall_impl` see only an opaque native pointer and do not expose the populated Java command fields.
- Socket/BIO hooks see encrypted write activity, but not a plaintext `/pstn/share/requestPrivateNumber` frame in this environment.

Because of that, direct Frida hooks remain unsuitable on this emulator, but they are no longer required to reconstruct the CommonRest request payload. A real arm64 hook would still be useful as an independent byte-for-byte confirmation.

## 2026-07-22 Live Fallback Verification

- Direct phone inventory ended with an upstream socket EOF against both configured gateways while the local HTTP proxy was enabled.
- Repeating the same read-only inventory probe with `dt_proxy_url` temporarily cleared produced the same EOF behavior, and the setting was restored in `finally`. The local proxy is therefore not the current direct-session root cause.
- With account monitoring paused, the TalkU country list loaded normally and Belgium opened `PrivatePhoneSearchActivity` with 12 distinct candidates.
- The management API preview then returned 12 candidates through the `adb-ui` fallback on its first UI-dump attempt. A later identity audit proved that the emulator was logged into account 440, not the requested account 446, so this result must not be treated as an account-446 preview.
- No candidate was selected, Continue was not pressed, and no purchase request was sent.

## Cross-account Fallback Finding

A sanitized `coreconfigex.bin` audit found that its user, token, and device fingerprints all matched database account 440 and none matched account 446. The old PCAP session had the same user as account 446 but a different token/device pair. That captured pair still completed `updateClientLink` and returned all four active phone records, while the former database pair closed after link registration. Cross-combinations also showed explicit token/device binding behavior through `60014` authentication rejections.

The backend now rejects App/helper/ADB phone fallback when the active App `dtUserId` differs from the requested account. This guard covers:

- candidate preview;
- phone inventory synchronization;
- helper-backed purchase;
- purchase confirmation through the App database;
- renew, label, cancel, pause, and resume helper actions.

Live verification against account 446 while the emulator remained on account 440 returned HTTP `409` for both preview and inventory sync. The App stayed stopped and account 446 retained its four stored phone records.

The validated captured token/device pair was then persisted through `validateThenPersistDirectSession`. A management API inventory sync completed with four records, no refresh error, and `cached=false`, restoring account 446's standalone direct inventory path.

The earlier preview failure was query-construction-specific:

- the Java-shaped edge request returns `60009` because the server sees null user, device, and token fields;
- a controlled request that added identity fields in a generic app-context order timed out against both gateways and was reverted;
- static analysis later showed the exact native order and enrichment rules, including `deviceId/TrackCode` before Java `apiParams`, `appVersion/apkCertificateSign` enrichment, and `userId/token` after the API parameters.

The backend now uses that exact authenticated CommonRest query. Focused tests verify the complete Australia and dynamic-country strings, including the native double-ampersand boundary produced when Java `apiParams` already starts with `&`.

Read-only account-446 verification after this change produced:

- direct inventory: four stored upstream phones, all active;
- first preview run: a parseable response with zero candidates;
- two later preview runs: intermittent gateway timeout/EOF before a response could be summarized;
- monitor state restored through the running management API, with a new active listener session.

The first parseable response occurred before the temporary probe exposed sanitized `Result/ErrCode/Reason`, so it cannot yet be classified as a normal empty result or an application error. No candidate was selected and no purchase call was made.

Current conclusion: account 446 direct inventory and monitoring have a valid restored session, and the native CommonRest identity/query gap is implemented. Candidate preview still needs one stable gateway response with sanitized status fields before it can be considered end-to-end verified. The App request-private-number path remains account-bound and cannot be borrowed across accounts.

## Native Purchase Query Shape

Static analysis of `EncodeWebOrderPrivateNumberParams` confirms that a normal first purchase uses one fixed `/pstn/share/orderPrivateNumber` query shape:

`token, deviceId, userId, countryCode, areaCode, phoneNumber, type, payFlag, payYears, coupon, specialNumber, callplanId, providerId, packageServiceId, simCC, simu, extraChargeMonthsCount, apiVersion, buyCredit`

The native formatter always emits empty `coupon` and `simCC` keys when no value is present, and emits `extraChargeMonthsCount` when there is no former number. It does not serialize `productId`. When `formerPhoneNumber` is present, native emits `oldPhoneNum` and omits `extraChargeMonthsCount`.

The backend purchase builder now follows that branch exactly and sends one query instead of trying variants without `apiVersion`, with a `privateNumber` alias, or with a leading ampersand. Focused tests cover both first purchase and former-number renewal shapes. This is protocol validation only; no purchase was sent.

## Next Verification Target

The read-only panel preview and quote path is now live-verified. A paid order still requires separate explicit confirmation. When authorized, capture sanitized order acknowledgement, direct inventory confirmation, and the matching database insertion; do not treat a successful write acknowledgement alone as proof of purchase.
