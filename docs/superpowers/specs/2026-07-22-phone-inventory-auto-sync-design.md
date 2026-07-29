# Phone Inventory Auto-Sync Design

## Goal

Make the account page reliably load the same purchasable-country list as the App, automatically reconcile numbers bought in the App, and prove the panel purchase path with one Belgian number on account 446.

## Design

- Country loading remains lazy. The backend always passes the account variant into the native request and falls back to the verified 26-country App list when the upstream session closes. The frontend must show the actual API error instead of converting every failure into an empty list.
- Direct monitor sessions remain the primary SMS path. Phone inventory reconciliation runs only after a direct listen cycle has ended, never concurrently with its link socket. A purchase-team message marks the runner for immediate reconciliation; otherwise a bounded 15-minute safety interval applies.
- Opening an account detail page performs a silent remote reconciliation only when the stored phone data is missing or older than five minutes.
- Manual/page reconciliation temporarily pauses the account monitor, prefers the direct list, falls back to the App helper/ADB path when the direct socket fails, and restores the monitor in `finally`.
- Phone-page synchronization is single-flight per account and uses an account generation guard so stale responses cannot overwrite a later navigation.
- The Belgian purchase test uses account 446, the first live Belgian candidate returned by the panel request, and the existing `confirm=true` purchase guard. Success requires remote-list confirmation, Prisma persistence, page visibility, and a stored team purchase message. Upstream KYC or balance rejection is reported as a real blocker and must not create a local number.

## Pressure and Safety

- At most one reconciliation is added per completed monitor runner cycle and per account every 15 minutes unless a purchase message is observed.
- Existing direct-session operation locks remain authoritative.
- Empty or failed remote lists never delete local numbers.
- Purchase is performed once only after preview returns a concrete candidate and price.

## Verification

- Unit tests for purchase-message detection and refresh timing.
- Source/API regression tests for account variant propagation, visible country errors, and stale-page synchronization.
- Full backend tests, backend build, frontend build, direct regression, live country preview, one Belgian purchase, DB inventory check, and team-message check.
