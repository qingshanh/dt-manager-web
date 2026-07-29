# Pure Backend Phone Purchase Design

> **Paused status:** Live App-layer evidence superseded the dedicated-RPC-only assumption below. The current blocker and safe resume point are recorded in
> `docs/superpowers/specs/2026-07-23-phone-purchase-paused-status.md`.

## Goal

The deployed management panel must preview, quote, purchase, and confirm phone numbers without ADB, an emulator, or a running Dingtone/TalkU App.

## Protocol Boundaries

- `requestPrivateNumber` remains an authenticated CommonRest request carried by the captured `0107` CommonRest envelope.
- `getNumberPrice` remains a CommonRest request and supplies the exact credit price for a concrete candidate.
- `orderPrivateNumber` is not sent through CommonRest. The App calls `TpClientForJNI.nativeRestCall(..., DTRESTCALL_TYPE_ORDER_PRIVATE_NUMBER, cmd)`, so the backend must encode the dedicated native RPC request and decode `DTOrderPrivateNumberResponse`.
- A successful purchase is not persisted until a subsequent remote phone inventory call contains the purchased number.

## Area Code Behavior

- Country configuration owns the area-code policy.
- US and CA default to a randomly selected area code from their configured pools when the request does not contain an explicit area code.
- A refresh chooses a new random area code.
- An explicit area code remains supported as an advanced override.
- Empty inventory is reported as sold out; it is not reported as a missing-area-code error.
- The selected or returned area code is carried into quote and purchase requests.

## Backend Flow

1. Establish the normal direct authenticated session from the account token and device ID.
2. Resolve the country configuration and effective area code.
3. Send `requestPrivateNumber` through the CommonRest envelope.
4. Quote each selected candidate with `getNumberPrice` before enabling purchase.
5. Validate the submitted candidate, price, country, provider, package, and area code.
6. Send one dedicated `orderPrivateNumber` RPC request.
7. Decode the native response. Treat socket close, timeout, KYC, sold-out, insufficient-credit, and price-change results as distinct failures.
8. Poll direct phone inventory and persist only after the candidate is present remotely.

## Safety

- `confirm=true` remains mandatory.
- One account may have only one in-flight purchase.
- A purchase request is never retried after the write boundary unless remote inventory proves that no purchase happened.
- Logs redact tokens, device IDs, email addresses, full phone numbers, and raw authenticated frames.
- Development captures may use an App or native analysis, but no runtime production code may import ADB services.

## Verification

- Unit tests cover random area-code selection, explicit overrides, request field order, dedicated RPC encoding, native response decoding, and duplicate-submit locking.
- Regression tests prove the purchase route does not call helper or ADB fallbacks.
- Read-only live verification covers preview and price only.
- A future paid live test is required only after the dedicated RPC request is byte-verified; this design does not authorize another purchase.
