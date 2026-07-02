# Plan — Channels Send Layer (Module 2, Increment 2)

> **This is a plan document only. Nothing in this module has been started.** Execution requires explicit go-ahead, module by module (or even site by site) as laid out below.

## Why this is the riskiest module after AI Core

Every route in this module can cause a real WhatsApp, Messenger, or Instagram message to reach a real customer. Unlike every module done so far (read-heavy, or simple single-row writes), a mistake here is not "a 500 error" — it's a wrong message sent, a message sent twice, or a message silently never sent. All three are customer-visible and none are reversible after the fact.

## 1. Scope

**Full inventory (from the Module 2 report, re-confirmed in this audit — 12 call sites, unchanged):**

| Site | Location | What it sends |
|---|---|---|
| `/api/send/manychat` | server.js, dedicated endpoint | `sendContent` — direct text/media send |
| `/api/broadcasts/:id/send` | server.js | `sendContent` — bulk send to a stage-filtered list |
| `/api/followup-drafts/:id/send` | server.js | `sendContent` — one approved follow-up draft |
| `/api/follow-ups/bulk-send` | server.js | `sendContent` — bulk (marked in code comments as superseded by the collect-only queue, ADR-0010 — **candidate for deletion, not just wrapping**, pending confirmation it's truly dead) |
| `sendViaManyChat()` (used by `drainOutbox()`) | server.js, the outbox worker | `sendContent` — the **guaranteed-delivery** path; every message that goes through `aykoshop_outbox` |
| `/api/customers/:id/message` | server.js | `setCustomFieldByName` + `sendFlow` — operator manual reply from the Inbox |
| `setCustomFieldByName` clearing (`ai_reply`/`ai_image2`) | inside `/api/inbox/ingest` | clears stale ManyChat fields during takeover — not a "send" itself, but part of the send contract |
| One `setCustomFieldByName` call | inside `/api/ai/v2reply` | **stays out of scope for this module** — it's inside AI Core, will only move if/when AI Core is refactored |

**Proposed increment order** (safest → riskiest, each its own commit with full verification before moving to the next):

1. **`/api/send/manychat`** — dedicated, isolated endpoint, no other logic around it. Best first target: wrap in a new `mcSend(subscriberId, {text, imageUrl})` helper with byte-identical wire behavior (same URL, same headers, same body shape), same pattern as `mcGetInfo`/`mcPageInfo` from Module 2 Increment 1.
2. **`/api/broadcasts/:id/send`** and **`/api/followup-drafts/:id/send`** — same `mcSend()` helper, slightly more surrounding logic (stage filtering, status updates) but still isolated endpoints.
3. **`sendViaManyChat()` / outbox worker** — highest-value target (it's the *guaranteed-delivery* path and the most duplicated shape) but also the highest risk: it's called both from the 20-second interval worker and from `/api/ops/outbox/drain`. Requires careful behavior-preservation of the `circuitRecord`/`held`/`SKIP LOCKED` semantics — the helper extraction must not change retry/backoff behavior.
4. **`/api/customers/:id/message`** — the operator manual-reply path. This is functionally "Inbox," even though it lives in the Channels-send code. Flag explicitly for a fresh go/no-go before starting, since "don't touch Inbox" has been a standing instruction all session even when not restated every turn.
5. **`ai_reply`/`ai_image2` clearing inside `/api/inbox/ingest`** — smallest, most isolated of the Inbox-adjacent sites; likely folds naturally into whichever `mcSend`/`mcSetField` helper is built for step 1–2.
6. **`/api/follow-ups/bulk-send`** — investigate first whether it's actually dead (zero real executions in a recent window, per the ADR-0010 comment already in the code); if confirmed dead, propose deletion instead of wrapping, as its own explicit ask.

**Explicitly out of scope for this module:** the `setCustomFieldByName` call inside `/api/ai/v2reply` (AI Core), and any n8n-side ManyChat sending (the `Send Reply` node) — n8n was never touched this phase and stays that way unless separately agreed.

## 2. Baseline

For each increment:
- Snapshot the **exact current wire request** each site makes (URL, headers, body shape) by reading the live code, not assuming — same rigor as Module 2 Increment 1.
- Where possible, capture a **real historical delivery** (e.g., the last few rows in `aykoshop_outbox` with `status='sent'`) to compare shapes against, since these routes don't have a clean "baseline JSON response" the way GET routes do — the meaningful baseline is *what ManyChat actually received*.

## 3. Candidate Environment

- Same isolated `:4001` pattern used throughout Phase 1 — **but** sending routes cannot be safely exercised against the *real* ManyChat API with a *real* customer during candidate testing (unlike GET routes, a candidate-environment send would actually deliver).
- Required addition for this module specifically: a **dry-run / mock mode** for the candidate boot — either (a) point the candidate's ManyChat base URL at a mock endpoint that logs the exact outgoing request without delivering it, or (b) use ManyChat's own sandbox/test-subscriber mechanism if one exists, or (c) restrict live-send testing to the existing synthetic `9994xxxx` test subscribers *only*, with explicit confirmation before each live-send test that the target is a synthetic id, never a real customer.
- This is the one genuinely new piece of tooling this module needs beyond what Modules 1–5 already built. Proposal: build the mock-logging option (a) first, since it lets the whole helper-extraction be verified with zero real sends at all, then do exactly one confirmatory real send to a synthetic test subscriber per increment as the final live-E2E step (matching what was already done for read-only Channels work).

## 4. Regression Tests

- Structural diff of the **outgoing request** (not a response, since these are often fire-and-forget or return a thin ManyChat ack) between old code path and new helper, using the mock-logging mode from §3.
- For the outbox worker specifically: verify `circuitRecord()` calls still fire on the same success/failure conditions, `held`/`SKIP LOCKED` behavior unchanged, retry timing unchanged.

## 5. E2E Tests

- One confirmatory real send per increment to a synthetic `9994xxxx` subscriber, checked against ManyChat's own delivery confirmation where available.
- Full 3-channel sweep (WhatsApp/Messenger/Instagram) only at the *end* of the whole module, once all increments are merged — not per-increment, to avoid unnecessary real-send volume during iteration.

## 6. Rollback Plan

- Same `aykoshop-deploy-gate.sh` mechanism as every prior module for `server.js` changes.
- Explicit rule for this module: if a post-deploy send-path check shows **any** unexpected duplicate or malformed outgoing request (checked via the mock-logging harness or ManyChat's own send log if accessible), roll back immediately — don't wait for a customer complaint.

## 7. Exit Criteria

- All in-scope call sites (steps 1–5 above) route through 1–2 shared helpers (`mcSend`, `mcSetField`) with byte-identical wire behavior, verified via the mock-logging harness.
- Zero change to `circuitRecord`/retry/backoff semantics in the outbox worker (explicitly tested, not just "same shape").
- One confirmatory live send per increment succeeds against a synthetic test subscriber.
- Full 3-channel E2E at module completion, plus the standard regression sweep across Inbox/Catalog/Customers/Hermes/Products/Orders.
- `/api/follow-ups/bulk-send` either confirmed dead and proposed for deletion, or wrapped like the rest — not left ambiguous.
- Independent git commit(s), same evidence-in-commit-message discipline as Modules 1–5.

## Open question for you before this starts

Step 4 (`/api/customers/:id/message`) is functionally the Inbox operator-reply feature living inside Channels-send code. Do you want it included in "Channels Send Layer," or held back explicitly for the separate "Inbox backend" module at the very end? Either is defensible — flagging so the scope boundary is your call, not an assumption.
