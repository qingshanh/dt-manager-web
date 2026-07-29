# Pure Backend Phone Purchase Implementation Plan

> **Paused:** Do not continue paid candidate rotation from this checklist. Resume from
> `docs/superpowers/specs/2026-07-23-phone-purchase-paused-status.md`, which records the live App query, unchanged balance/inventory, and the unresolved lower transport boundary.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete phone preview, quote, purchase, and confirmation in the deployed panel without ADB or an App runtime.

**Architecture:** Keep candidate preview and price lookup on authenticated CommonRest. Replace the current CommonRest purchase approximation with a dedicated `orderPrivateNumber` RPC codec, then confirm purchases through direct inventory before persistence.

**Tech Stack:** TypeScript, Node.js `Buffer`, zlib, Prisma, Express, React, Node test runner.

---

### Task 1: Default Random Area Codes

**Files:**
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/dingtone/direct-phone-country.test.ts`
- Modify: `frontend/src/pages/AccountDetail.tsx`

- [x] Add a failing test proving a US request without `areaCode` contains one configured random US area code.
- [x] Add a failing test proving a CA request without `areaCode` contains one configured random CA area code.
- [x] Add a failing test proving an explicit area code is preserved.
- [x] Change `buildRequestPrivateNumberQueryAttempts` to resolve one effective area code per request and pass it into `buildRequestPrivateNumberQuery`.
- [x] Keep manual area code as an advanced override while making the UI label state that blank means automatic random selection.
- [x] Run `node --test backend/src/services/dingtone/direct-phone-country.test.ts` and confirm all focused tests pass.

### Task 2: Dedicated Order RPC Evidence

**Files:**
- Create: `docs/superpowers/specs/2026-07-23-order-private-number-rpc-notes.md`
- Inspect: `_tmp/jadx-dingdong/sources/me/dingtone/app/im/tp/TpClient.java`
- Inspect: `_tmp/jadx-dingdong/sources/me/dingtone/app/im/datatype/DTOrderPrivateNumberCmd.java`
- Inspect: `_tmp/dingdong-native/lib/arm64-v8a/libtzim.so` or the available equivalent

- [x] Record the numeric `DTRESTCALL_TYPE_ORDER_PRIVATE_NUMBER` value.
- [x] Record the native encoder symbol, request context, field order, string encoding, and frame route requirements.
- [x] Record the response callback and `DTOrderPrivateNumberResponse` field layout.
- [x] Compare the dedicated RPC layout with the existing ProxyRest framing in `direct-gateway.ts`.
- [x] Preserve unknown server error mappings instead of inventing sold-out, KYC, or credit codes.

### Task 3: Order RPC Codec

**Files:**
- Create: `backend/src/services/dingtone/order-private-number-rpc.ts`
- Create: `backend/src/services/dingtone/order-private-number-rpc.test.ts`
- Modify: `backend/src/services/dingtone/direct-gateway.ts`

- [x] Write a failing test for the complete first-purchase payload field order: `token`, `deviceId`, `userId`, `countryCode`, `areaCode`, `phoneNumber`, `type`, `payFlag`, `payYears`, `coupon`, `specialNumber`, `callplanId`, `providerId`, `packageServiceId`, `simCC`, `simu`, `extraChargeMonthsCount`, `apiVersion`, `buyCredit`.
- [x] Write a failing test for dedicated ProxyRest context, session, route, API, and payload.
- [ ] Write failing response tests for success, sold out, KYC required, insufficient credits, and malformed response.
- [x] Implement the pure `Buffer` context encoder with no Prisma, socket, ADB, or logger dependency.
- [x] Integrate the codec into `DirectSession` with a single-write purchase method.
- [x] Remove the CommonRest `orderPrivateNumber` path from `purchasePhoneNumber`.
- [x] Run the focused order RPC and purchase-query tests.

### Task 4: Purchase Route Safety and Confirmation

**Files:**
- Modify: `backend/src/routes/accounts.ts`
- Modify: `backend/src/routes/phone-preview-fallback.test.ts`
- Create: `backend/src/routes/phone-purchase-direct-only.test.ts`

- [x] Write a failing source regression test proving the purchase route never calls helper or ADB purchase paths.
- [x] Add an account-scoped in-flight purchase lock and a regression test for HTTP 409 on concurrent purchase.
- [x] Preserve `confirm=true` validation.
- [x] Confirm the purchased number through direct inventory before the database upsert.
- [ ] Return distinct sanitized errors for sold out, KYC, insufficient credits, price changes, timeout-before-write, and uncertain-after-write.
- [ ] Run focused route and direct regression tests.

### Task 5: Frontend Quote and Confirmation

**Files:**
- Modify: `frontend/src/pages/AccountDetail.tsx`
- Modify: `frontend/src/api/accounts.ts` or the existing account request module
- Modify: relevant frontend tests under `frontend/src`

- [ ] Add candidate-specific quote loading and error state.
- [ ] Disable the purchase confirmation button until the selected candidate has a verified price.
- [ ] Re-quote when the candidate changes.
- [x] Display automatic-random-area behavior for configured countries without requiring input.
- [x] Preserve the explicit area-code override as an advanced control.
- [ ] Run frontend typecheck and build.

### Task 6: Verification

**Files:**
- Modify: `backend/src/scripts/verify-direct-regression.ts`

- [x] Add regression checks for random area-code requests and direct-only purchase routing.
- [x] Run the full backend test suite.
- [x] Run backend and frontend builds/typechecks.
- [ ] Run a read-only live preview and quote against the authenticated account.
- [x] Verify the purchase route does not call `adb-phone-preview.ts`, `adb-session.ts`, or helper purchase actions.
- [ ] Do not perform another paid purchase without a separate explicit instruction.

No Git commit is created unless the user explicitly requests it.
