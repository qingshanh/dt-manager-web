# Phone Inventory Auto-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably load App countries, automatically reconcile App-purchased numbers, and validate one Belgian purchase through the panel.

**Architecture:** Keep native country and phone calls in `DirectDingtoneGateway`; add pure refresh-policy helpers and invoke reconciliation only after monitor listening completes. The account page performs a five-minute stale check, while the backend performs a fifteen-minute safety check and reacts to purchase-team messages.

**Tech Stack:** TypeScript, Express, Prisma, React, Node test runner, ADB/TalkU test environment.

---

### Task 1: Country loading and visible errors

**Files:**
- Modify: `backend/src/routes/accounts.ts`
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `frontend/src/pages/AccountDetail.tsx`
- Test: `backend/src/routes/account-detail-lazy-load.test.ts`
- Test: `backend/src/services/dingtone/direct-phone-country.test.ts`

- [x] Add failing assertions that the route passes `appVariant`, the gateway accepts it, and the frontend reports the caught API error.
- [x] Run the two tests and confirm they fail on the missing behavior.
- [x] Add `appVariant` to the country identity and replace the empty-list catch with a visible error plus preserved empty return.
- [x] Run the two tests and confirm they pass.

### Task 2: Purchase-triggered and periodic inventory reconciliation

**Files:**
- Create: `backend/src/services/phone-inventory-refresh.ts`
- Create: `backend/src/services/phone-inventory-refresh.test.ts`
- Modify: `backend/src/services/account-monitor.ts`
- Modify: `backend/src/services/account-monitor.test.ts`

- [x] Write failing tests for a 15-minute refresh interval and recognition of type `1048578` or a team `number:price` purchase notice.
- [x] Run the tests and confirm the helper is missing.
- [x] Implement the pure policy helper.
- [x] Add failing monitor assertions for pending purchase refresh and post-listen reconciliation.
- [x] Extend runner state and reconcile with `listPhoneNumbers` plus `syncPhoneNumbers` only after direct polling completes; failures remain non-fatal.
- [x] Run the focused tests and confirm they pass.

Follow-up review fixes also stop dedicated listen renewal when refresh is due, prevent stopped runners from committing in-flight results, propagate live `msgType`, and preserve `appVariant`.

### Task 3: Stale account-page synchronization

**Files:**
- Modify: `frontend/src/pages/AccountDetail.tsx`
- Test: `backend/src/routes/account-detail-lazy-load.test.ts`

- [x] Add a failing assertion that missing or older-than-five-minute phone data triggers one silent `syncPhoneNumbers` call after the local list loads.
- [x] Implement a small staleness helper and update `fetchPhones` without changing initial country lazy-loading.
- [x] Run the focused regression test and frontend build.

The page now uses account-scoped single-flight plus an account generation guard, so concurrent requests and A-B-A navigation cannot commit stale phone state. Empty cached inventory stays loading while the silent sync is running.

### Task 4: Runtime and Belgian purchase validation

**Files:**
- No production files unless live evidence exposes a separate protocol defect.

- [x] Run focused tests, all backend tests, backend build, frontend build, and direct regression.
- [x] Restart the backend and verify `/health` reports the new process start time.
- [ ] Confirm account 446 returns 26 countries including `BE` and returns at least one Belgian candidate.
- [ ] Purchase the first Belgian candidate once with `confirm=true`.
- [ ] Verify remote list confirmation, Prisma persistence, account-page visibility, balance change when available, and the TalkU team purchase message.
- [ ] Remove diagnostic files and scan the diff for captured tokens, device IDs, emails, and live candidate numbers.

Current live status:

- The panel returned 26 countries including Belgium and 12 masked Belgian candidates once during this session.
- After repeated App/direct session preemption, the final current-process replay returned an empty App candidate list even with the monitor pre-stopped. Treat candidate availability as an upstream/session blocker until a fresh TalkU session reproduces it again.
- Phone inventory synchronization succeeded through the new direct-to-helper fallback with four stored rows before and after; no local rows were deleted.
- No candidate was selected and no purchase request was sent.

Git commit and push are intentionally deferred because the shared worktree already contains user-approved uncommitted changes and this request did not authorize publishing.
