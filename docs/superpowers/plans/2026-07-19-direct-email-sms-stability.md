# Direct Email and SMS Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real native `registerEmail` path use the proven raw-TCP transport and restore SMS backup failover after authenticated link EOFs.

**Architecture:** Preserve configured native activation templates and only patch semantic query content; the frame builder must retain opaque `registerCommon` control bytes. Split activation-only TrackCode generation from the legacy general generator. Treat an authenticated link socket EOF as a governor failure while keeping ownership grace, so repeated failures open the circuit and permit the backup worker to claim the route.

**Tech Stack:** TypeScript, Node.js `node:test`, `tsx`, SQLite-backed runtime settings.

---

### Task 1: Separate activation TrackCodes from legacy generic TrackCodes

**Files:**
- Modify: `backend/src/utils/crypto.ts`
- Modify: `backend/src/utils/crypto.test.ts`
- Modify: `backend/src/routes/accounts.ts`
- Modify: `backend/src/routes/accounts-list-visibility.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("activation TrackCode matches the native 64-bit low-12-bit sequence", () => {
  const value = createActivationTrackCode();
  assert.match(value, /^\d{16}$/);
  assert.equal(BigInt(value) % 4096n, 3n);
});

test("generic TrackCode remains independent from activation sequencing", () => {
  const value = createTrackCode();
  assert.match(value, /^400511853\d{8}$/);
  assert.equal(isActivationTrackCode(value), false);
});
```

- [ ] **Step 2: Run the crypto and account selection tests and confirm the generic assertion fails**

Run: `node --import ./node_modules/tsx/dist/loader.mjs --test src/utils/crypto.test.ts src/routes/accounts-list-visibility.test.ts`

- [ ] **Step 3: Implement the minimal split**

```ts
export function createTrackCode() {
  const base = BigInt("40051185300000000");
  const randomTail = BigInt(Math.floor(100000 + Math.random() * 900000));
  return (base + randomTail).toString();
}

export function createActivationTrackCode() {
  // Current real server validation accepts the native low-12-bit sequence.
  return ((nextMonotonicActivationTimestamp() << 12n) | 3n).toString();
}
```

Use `createActivationTrackCode()` only for `email_code` and `phone_code` creation/fallback, leaving password-login and import callers on `createTrackCode()`.

- [ ] **Step 4: Re-run the two tests and confirm they pass**

### Task 2: Make registerEmail inherit the proven direct transport by default

**Files:**
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/dingtone/direct-register-email-identity.test.ts`

- [ ] **Step 1: Add a failing runtime-default test**

```ts
assert.equal(runtime.registerEmailPort, runtime.port);
assert.equal(runtime.registerEmailUseTls, runtime.useTls);
```

- [ ] **Step 2: Run the register-email identity test and confirm the default assertion fails**

Run: `node --import ./node_modules/tsx/dist/loader.mjs --test src/services/dingtone/direct-register-email-identity.test.ts`

- [ ] **Step 3: Implement inheritance without overwriting explicit settings**

```ts
const port = Number(settings.dt_server_port || config.DT_SERVER_PORT) || config.DT_SERVER_PORT;
const useTls = parseBooleanSetting(settings.dt_direct_use_tls, config.DT_DIRECT_USE_TLS);
// Explicit registerEmail settings still override these defaults.
registerEmailPort: parsePositiveIntSetting(settings.dt_direct_register_email_port, port, 1, 65535),
registerEmailUseTls: parseBooleanSetting(settings.dt_direct_register_email_use_tls, useTls),
```

- [ ] **Step 4: Re-run the identity test and confirm it passes**

### Task 3: Restore link EOF failover and stable heartbeat ordering

**Files:**
- Modify: `backend/src/services/dingtone/direct-gateway.ts`
- Modify: `backend/src/services/dingtone/direct-message-listener.test.ts`

- [ ] **Step 1: Replace the currently inverted EOF test with a failing failover assertion**

```ts
test("authenticated auxiliary link EOF records a link transport failure", () => {
  const eofCatch = source.slice(linkReadCatchStart, linkReadCatchEnd);
  assert.match(eofCatch, /isDirectTransportError\(error\)[\s\S]*recordFailure\(transportKey, "link"\)/);
});
```

Also assert `openLink()` invokes `startSocketKeepalive()` after its authenticated bootstrap/prime callback and assert Dingdong uses the normal 5-second session interval.

- [ ] **Step 2: Run the listener test and confirm the new assertions fail**

Run: `node --import ./node_modules/tsx/dist/loader.mjs --test src/services/dingtone/direct-message-listener.test.ts`

- [ ] **Step 3: Implement the minimal state-machine correction**

```ts
// In the authenticated link read catch, before closing the link:
if (!listener.preempted && isDirectTransportError(error)) {
  directTransportGovernor.recordFailure(transportKey, "link");
}

async openLink(account: DirectSessionAccount) {
  await this.openPrelogin(account);
  await this.bootstrapAuthenticatedSession(account, DIRECT_LINK_BOOTSTRAP_WAIT_MS, async () => {
    await this.primeLinkRegistration(account);
  });
  await this.startSocketKeepalive();
}
```

Set the Dingdong authenticated session heartbeat interval to `DIRECT_SESSION_KEEPALIVE_INTERVAL_MS`; retain route ownership grace so a transient EOF does not cause immediate primary/backup flapping.

- [ ] **Step 4: Re-run the listener test and confirm it passes**

### Task 4: Validate the formal production configuration and release gate

**Files:**
- No source file required unless a test exposes a missing contract.

- [ ] **Step 1: Start the formal backend and check `http://127.0.0.1:5174/health`**
- [ ] **Step 2: Trigger account `621` email verification using only the database template and record a redacted `Result=1` response**
- [ ] **Step 3: Validate SMS delivery on multiple country numbers after observing a primary EOF/backup takeover diagnostic**
- [ ] **Step 4: Run backend tests, backend build, frontend build, runtime bounds, direct regression, `git diff --check`, and sensitive-data scan**
- [ ] **Step 5: Only after all checks pass, bump both package versions to `0.2.12`, clean emulator/Frida/template artifacts, and prepare the commit**
