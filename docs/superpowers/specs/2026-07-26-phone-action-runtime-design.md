# Reliable Phone Action Runtime Design

## Goal

Make every existing phone-number action in the management panel usable without ADB while preventing duplicate charges or destructive writes when the direct gateway disconnects.

The scope covers renewal, cancellation, pause, resume, label updates, SMS-filter repair, remote inventory confirmation, action status in the frontend, and restart recovery. Phone purchase remains governed by its existing dedicated design.

## Confirmed Failure Model

- TalkU and Dingdong use native phone RestCall identities for renewal (`2050`), phone settings (`2052`), and cancellation (`2132`).
- The current backend approximates cancellation and phone settings through a generic CommonRest action path.
- Some non-renewal calls omit `appVariant`, which can apply TalkU defaults to Dingdong accounts.
- Generic direct actions may rotate hosts or fall back to a captured template after a state-changing request has already been written.
- Resume can issue `reactivateGoogleVoiceNumber` after an unconfirmed `privateNumberSetting` write.
- Renewal duplicate protection is process-local and disappears after reconciliation or a backend restart.
- HTTP routes synchronously wait for action, inventory verification, and monitor restoration, causing long spinners and client timeouts.
- The setting builder can overwrite unrelated fields by forcing SMS reception and defaulting unknown primary or auto-renew state.
- An unknown `allowReceiveSMS` field is not proof that SMS reception is disabled. SMS delivery also depends on provider routing and the direct listener.

## Architecture

### Phone Action Operation

Add a persistent `PhoneActionOperation` record for every state-changing request.

Required fields:

- operation ID
- account ID and phone ID
- action type: renew, cancel, pause, resume, update label, enable SMS
- state: prepared, writing, awaiting confirmation, confirmed, failed, manual review
- idempotency key
- App variant
- baseline phone status and expiry
- balance and quoted price snapshots when applicable
- write-started and write-completed timestamps
- response classification and redacted error summary
- confirmation source and confirmed timestamp
- created and updated timestamps

Only one unresolved operation may exist for the same account, phone, and action family. Renewal remains blocked while any prior renewal has an unknown outcome.

### Protocol Adapters

Provide action-specific adapters instead of one generic mutation helper:

- `OrderPrivateNumberAdapter` for renewal RestCall `2050`
- `PrivateNumberSettingAdapter` for pause, resume, label, and SMS RestCall `2052`
- `DeletePrivateNumberAdapter` for cancellation RestCall `2132`

Every adapter receives the account variant explicitly and resolves variant-specific App identity, version, certificate, and device rules.

The request may use a byte-verified native frame or a captured variant-specific template. A generic CommonRest fallback is not allowed after the write boundary.

### Single-Write Boundary

Before a mutation:

1. Persist the operation and acquire its idempotency lock.
2. Pause the account monitor while preserving the saved monitor switch.
3. Establish and authenticate the direct session before marking the operation as `writing`.
4. Write the mutation exactly once.
5. Never rotate hosts, retry a template, or issue an alternative action after the write callback fires.
6. Restore the monitor in `finally`.

If the socket closes or the response cannot be decoded after the write, return an awaiting-confirmation result. This is not a failure and does not release the persistent lock.

### Read-Only Reconciliation

Confirmation performs only remote reads and never repeats the mutation.

- Renewal is confirmed only when expiry advances from the stored baseline.
- Cancellation is confirmed when the remote number is absent or explicitly cancelled.
- Pause and resume are confirmed by the remote suspend state.
- Label updates are confirmed by the returned display name.
- SMS enablement is confirmed only when the remote filter setting explicitly returns `allowReceiveSMS=true`.

Pending reconciliation survives process restarts. Startup scans unresolved operations and resumes bounded read-only checks. Exhausted checks move the operation to manual review without unlocking another paid or destructive write.

## Action-Specific Behavior

### Renewal

- Fetch or reuse a recent balance snapshot and an exact renewal quote before confirmation.
- Require the user to confirm the duration, price, current balance, and resulting expected balance.
- Use the App yearly-renewal fields already identified: `payYears=1`, `extraChargeMonthsCount=12`, and `commandTag=2`.
- Record balance before the write and refresh balance only after confirmation or during read-only reconciliation.
- Never report success until expiry advances.

### Cancellation

- Require a second confirmation because the action is destructive.
- Use cancellation RestCall `2132` exactly once.
- Keep the local phone row and mark it cancelled after remote confirmation; do not delete history automatically.
- An unconfirmed cancellation blocks another cancellation attempt and is shown as manual review.

### Pause And Resume

- Use phone-setting RestCall `2052` and change only `suspendFlag` plus fields required by the native DTO.
- Preserve primary, forwarding, voicemail, auto-reply, auto-renew, label, and filter values from the latest remote record.
- Reject the operation if required preserved fields are unavailable instead of inventing unsafe defaults.
- Do not call `reactivateGoogleVoiceNumber` as an automatic fallback. Reactivation is a separate explicitly confirmed action for supported suspended-number types.

### Label Update

- Use the same state-preserving `2052` adapter.
- Change only the display name.
- Return quickly with an operation state and update the displayed row after confirmation.

### SMS Reception

Separate four independent states in the panel:

- App filter: allowed, blocked, or not returned
- provider routing metadata: complete or incomplete
- panel listener: active, starting, disabled, or unhealthy
- delivery evidence: received before or not yet verified

Automatic repair targets only explicitly blocked filters. A force-enable action for an unknown filter requires a separate confirmation and must preserve all unrelated settings.

Listener restart and phone-inventory refresh are separate non-destructive repair actions. The UI must not claim that changing the App filter guarantees carrier delivery.

## API And Frontend

Mutation endpoints return an operation envelope instead of holding the request open for full verification:

- `confirmed`: the remote result is already proven
- `awaiting_confirmation`: one write occurred and read-only checks continue
- `failed_before_write`: no mutation was written and a retry is safe
- `manual_review`: outcome is unknown and another mutation is blocked

Expose an operation-status endpoint and include unresolved operation state with each phone row.

The frontend disables conflicting actions, displays the operation state, and polls status with bounded backoff. It must not show an endless spinner or translate `awaiting_confirmation` into success or failure.

## Startup And Runtime

- Keep the current start supervisor and stale-process recovery behavior.
- On backend startup, recover unresolved phone operations before normal automatic refresh work.
- Account monitors may resume independently, but the operation coordinator must pause them around each direct mutation and read-only verification session.
- Logs contain operation IDs, action types, state transitions, timings, and masked account/phone identifiers only.

## Verification Strategy

Test-driven implementation must add failing tests before production changes for:

- one write only after socket EOF, timeout, host failure, or template failure
- no alternative resume/reactivation write after an unconfirmed setting request
- persistent duplicate blocking across backend restart
- TalkU and Dingdong variant identity propagation for every action
- action-specific native RestCall identity and response classification
- state-preserving phone-setting payloads
- rejection when required preserved settings are unavailable
- renewal balance and expiry audit fields
- cancellation retention of local history
- SMS unknown, blocked, routing, listener, and delivery states
- fast HTTP responses and frontend awaiting-confirmation behavior
- unresolved-operation startup recovery

Run targeted tests, the complete backend suite, backend and frontend builds, the start-script contract tests, and live health checks.

Live writes are not authorized by this design. Read-only verification may use current accounts. Renewal, cancellation, reactivation, or SMS-setting writes require a separately specified test account and phone number, and each write may run only once after explicit confirmation.

## Rollout Order

1. Add the persistent operation model and pure state machine.
2. Add the action coordinator and single-write enforcement.
3. Introduce variant-aware native adapters.
4. Migrate renewal to the coordinator.
5. Migrate cancellation and phone settings.
6. Split SMS diagnosis and repair actions.
7. Add frontend operation state and polling.
8. Run full non-destructive verification and restart recovery checks.
9. Perform separately authorized single-write live tests, one action at a time.
