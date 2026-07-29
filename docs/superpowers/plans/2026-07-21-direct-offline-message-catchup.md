# Direct Offline Message Catch-up Implementation Plan

**Goal:** Complete the authenticated offline-message request/receive/parse/store path for team and non-team inbound messages without increasing direct gateway connection count.

**Architecture:** Reuse each account's route-owning authenticated link. A catch-up transaction sends the configured native offline request, immediately calls `getUserOfflineMsg` on the same session, normalizes both team and ordinary inbound records, and delivers them through the existing helper-message storage path. Startup and notify-only signals remain immediate; the safety sweep runs every ten minutes with deterministic jitter, a process-wide concurrency cap of three accounts, per-account single flight, delivery batches of at most 100 records, and existing remote `msgId` deduplication.

**Filtering:** Keep DingTalk/TalkU team types `531`, `532`, and `3300`; keep ordinary inbound SMS, verification messages, and MMS-like text records; exclude type `29` offers and records without a usable sender or message body. Outgoing records remain rejected by `message-runtime` using the account identity and owned phone numbers.

**Verification:** Add normalization, deduplication, batching, scheduling, and same-session catch-up regression tests. Then run the focused direct tests, the full backend test suite, backend build, direct regression verification, and frontend build.
