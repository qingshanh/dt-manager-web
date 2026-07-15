# Emulator-Independent SMS Offline Catch-up Design

## Context

The backend normally receives SMS messages through the authenticated direct socket. Live testing showed that this path works for multiple countries, including France, the United Kingdom, Australia, and the United States. However, some messages remain on the provider until the official TalkU or DingDong app reconnects and requests offline messages.

The current backend attempts the native `requestAllOfflineMessage` operation and reports `offlineTemplate=sent`, but the built-in frame is malformed:

- The frame header declares 171 bytes while the buffer contains 174 bytes.
- A route string declares 23 bytes while containing 26 bytes.
- The malformed route field cannot be replaced reliably with the authenticated session route.
- Sending the frame therefore proves only that bytes were written to the socket, not that the server accepted the catch-up request.

This explains why real-time pushes often work while occasional messages are missed until the official app is opened.

## Goals

- Receive real-time and delayed SMS messages using backend account sessions only.
- Support both TalkU and DingDong without requiring an emulator in production.
- Use the official native offline-message request shape for each app variant.
- Detect malformed or stale templates before they are written to the socket.
- Preserve current push acknowledgement, deduplication, Telegram notification, and message parsing behavior.
- Validate the result with the official apps stopped.

## Non-Goals

- Running or controlling Android apps in production.
- Reading Android databases as a required production fallback.
- Changing SMS sender classification or country-prefix parsing.
- Replacing the complete direct protocol implementation.

## Considered Approaches

### A. Validated per-variant native templates

Capture one accepted `requestAllOfflineMessage` frame from TalkU and one from DingDong, store sanitized built-in templates, and patch only authenticated session fields at runtime.

This is the recommended approach because it follows the official client behavior while keeping the change small and testable.

### B. Build the binary frame entirely from a handwritten schema

This removes captured templates but requires assigning meaning to several native fields that are not yet fully understood. A plausible but incorrect field can recreate the current silent failure.

### C. Keep real-time push only

This preserves the current architecture but cannot recover messages that the provider withholds until an offline-message request. It does not meet the reliability requirement.

## Design

### Template model

Maintain separate TalkU and DingDong built-in offline templates. Each template must contain placeholders only for fields known to vary by account or connection:

- session identifier
- authenticated route, including its dotted representation
- device identifier
- any app-variant discriminator proven by capture

No captured user ID, token, email, device ID, or other account-specific value may remain in source control.

### Structural validation

Before a template can be used, validate:

- the outer frame length equals the actual buffer length
- the frame type and status match the expected native request
- every length-prefixed field fits inside the frame
- the route field has the expected eight-byte and dotted forms
- the device placeholder exists exactly once
- patching preserves a structurally valid frame

Invalid configured templates must fail with a clear diagnostic instead of returning `sent=true`.

### Runtime flow

1. Establish the authenticated direct session.
2. Select the offline template for the account's `appVariant`.
3. Patch the current session, route, device ID, and proven variant fields.
4. Validate the final frame.
5. Write the request and record `attempted` separately from `accepted`.
6. Continue reading push frames on both paired sockets.
7. Parse, acknowledge, deduplicate, and store returned SMS messages through the existing message runtime.
8. Retry catch-up at a bounded interval when the connection remains healthy and no SMS payload has arrived.

The Android database and UI fallback remain diagnostic tools only and must not be required for production correctness.

### Diagnostics

Replace the ambiguous `offlineTemplate=sent` meaning with diagnostics that distinguish:

- template selected
- frame validated
- frame written
- server response or resulting SMS observed
- retry count and last error

Sensitive frame contents must never be written to normal logs.

## Testing

### Automated tests

- A regression test must fail against the current malformed 174-byte template.
- TalkU and DingDong templates must pass structural validation.
- Runtime patching must preserve declared lengths and replace all route/device placeholders.
- Variant selection must choose the correct template.
- An invalid configured template must be rejected before socket write.
- Existing push acknowledgement and SMS parser tests must remain green.

### Live validation

1. Capture and compare the official TalkU and DingDong requests using the emulator only as a reverse-engineering instrument.
2. Stop both official apps.
3. Start backend listeners with App catch-up disabled.
4. Send verification messages to multiple existing accounts and countries.
5. Confirm messages arrive through the direct backend path, are stored once, show the target number, and trigger the expected Telegram notification.
6. Leave one message pending long enough to exercise offline catch-up rather than immediate push.

Success requires the backend to recover the delayed message while both official apps remain stopped.

## Risks And Mitigations

- **Variant protocol drift:** keep templates variant-specific and reject unknown shapes.
- **Silent server rejection:** separate write success from observed catch-up success in diagnostics.
- **Duplicate delivery:** retain existing message identity and content/time deduplication.
- **Sensitive capture leakage:** sanitize captured frames and add tests that reject known account identifiers.
- **Regression to real-time push:** run the full backend suite and live immediate-push tests in addition to offline recovery.

## Acceptance Criteria

- Production SMS monitoring has no emulator or ADB dependency.
- The malformed built-in offline template is removed.
- Both app variants use validated templates.
- Delayed SMS recovery succeeds with official apps stopped.
- Full backend tests, TypeScript build, and direct regression verification pass.
