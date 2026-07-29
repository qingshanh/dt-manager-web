# Phone Purchase Paused Status

## Status

Phone purchase work is paused while local startup is repaired. The deployed path must remain backend-only and must not require ADB, an emulator, Frida, or a running App.

The panel preview, quote, confirmation guard, account-scoped purchase lock, direct-only route guard, and post-order remote-inventory confirmation are present. A purchase is never written to the local database until the remote phone list contains the returned number.

## Live Evidence

- Brazil preview and quote returned multiple candidates.
- Three different masked Brazil candidates were tested, so the failure is not isolated to one number.
- Candidate lock returned a successful business acknowledgement.
- The App-layer order capture used `pstn/share/orderPrivateNumber` with:
  `countryCode`, `areaCode`, `phoneNumber`, `type`, `payFlag`, `payYears`,
  `specialNumber`, `packageServiceId`, `providerId`, `simCC`, `simu`,
  `apiVersion`, `buyCredit`, and `productId`.
- The App request timeout was 60 seconds. The backend now uses the same order timeout.
- The backend order write still produced no typed business response, and the remote inventory remained unchanged.
- The account balance and local phone inventory did not change after the failed confirmations.

Full phone numbers, tokens, device IDs, product IDs, authenticated frames, and verification codes must remain out of committed documentation and logs.

## Current Blocker

Matching the App-layer query is not sufficient. The unresolved difference is below `DtHttpUtil.edgeRequest`: the App may use an HTTP edge client or additional outer request metadata that the backend CommonRest/ProxyRest approximation does not reproduce.

The earlier dedicated-RPC-only design is therefore a static-analysis hypothesis, not a completed live protocol. Do not continue by rotating through random paid candidates.

## Resume Point

1. Trace the network call below `DtHttpUtil.edgeRequest`, including transport, URL, headers, cookies/session context, body, timeout, and callback path.
2. Compare that outer request with `DirectSession.callEdgeOrderPrivateNumberJson`.
3. Add a failing transport-level test for the first confirmed difference.
4. Implement the smallest backend-only fix.
5. Run preview and quote read-only verification.
6. Perform another paid test only after explicit instruction, then require remote inventory confirmation before local persistence.

## Relevant Files

- `backend/src/services/dingtone/direct-gateway.ts`
- `backend/src/services/dingtone/order-private-number-rpc.ts`
- `backend/src/services/dingtone/direct-phone-purchase-query.test.ts`
- `backend/src/services/dingtone/direct-order-private-number-frame.test.ts`
- `backend/src/routes/phone-purchase-direct-only.test.ts`
- `frontend/src/pages/AccountDetail.tsx`

## Last Focused Verification

- 29 focused backend tests passed.
- Backend build passed.
- The 60-second order timeout regression passed.
- No successful paid purchase has been confirmed.
