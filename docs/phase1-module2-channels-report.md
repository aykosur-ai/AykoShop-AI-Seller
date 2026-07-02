# Phase 1 — Module 2: Channels (Increment 1 — read-only ManyChat GET consolidation)

**Date:** 2026-07-02. **Scope:** backend only, 5 read-only ManyChat call sites. **Behavior change:** none (verified below). **Modules outside scope touched:** none — specifically, **zero lines inside `/api/ai/v2reply`, `/api/ai/generate`, `/api/inbox/ingest`, or `/api/customers/:id/message` were touched**, even though some of those routes also call ManyChat.

## Why "Increment 1" and not the whole Channels module at once

A full inventory of ManyChat integration in `server.js` found **~19 call sites**, not all equally risky:

| Category | Count | Where | Included in this increment? |
|---|---|---|---|
| Read-only `getInfo` / `page/getInfo` (diagnostics, health checks) | 5 | `_resolveWaPhone()` helper, `/api/_diag/mcinfo/:id`, `/api/_diag/mckey`, `/api/ops/status`, `/api/ops/health-center` | **Yes — this increment** |
| Message-sending (`sendContent`, `sendFlow`, `setCustomFieldByName`) | ~13 | `/api/customers/:id/message` (operator manual reply), `sendViaManyChat()` (the async outbox worker's core delivery function), `/api/inbox/ingest` (clearing stale `ai_reply` during takeover), `/api/send/manychat`, `/api/follow-ups/bulk-send`, `/api/broadcasts/:id/send`, `/api/followup-drafts/:id/send`, and one inside `/api/ai/v2reply` itself | **No — deliberately deferred** |

The excluded 13 sites directly cause a message, flow, or custom-field write to reach a real customer, or sit inside the AI reply path / the async outbox worker that was at the center of the incident this session started with. Consolidating them carries materially higher blast radius than the read-only diagnostic calls, and one of them (`/api/ai/v2reply`) is explicitly off-limits per this phase's rules. They are proposed as **Increment 2**, to be done as its own commit with its own dedicated test cycle — see "Next" below.

## What changed (Increment 1)

Added two shared helpers, `mcGetInfo(subscriberId, timeoutMs)` and `mcPageInfo(timeoutMs)`, that reproduce the exact ManyChat GET request each of the 5 call sites already made (same URL, same `Authorization: Bearer <key>` header, same per-site timeout value — `_resolveWaPhone` had no timeout, `_diag` routes used 8000ms, `ops/status` used 5000ms, `health-center` used 6000ms — all preserved exactly). Converted all 5 sites to call the helper instead of building the `fetch()` call inline. No route body logic, response handling, or error handling was touched.

**Net diff:** 5 call-site replacements + 1 helper block (13 new lines) — no route registration line changed, no `try/catch` structure changed.

## Regression testing (evidence)

1. **Pre-deploy baseline** — captured live JSON from all 4 externally-callable routes (`/api/_diag/mcinfo/:id`, `/api/_diag/mckey`, `/api/ops/status`, `/api/ops/health-center`) on production before any change. (`_resolveWaPhone` has no direct route — it's exercised indirectly via `/api/inbox/send-video`, not called in this test to avoid touching the video-send path unnecessarily.)
2. **Candidate isolation** — booted on port `:4001` (customers never touched it), syntax-checked, all 4 routes called and diffed **structurally** against baseline → all 4 identical shapes.
3. **Value-level spot check** — the actual field my patch touches (the `manychat`/`ManyChat API` entries) compared by value, not just shape: `status`, `detail`, and key set identical between baseline and candidate in both `/api/ops/status` and `/api/ops/health-center` (only `latency_ms`, which is expected to vary, differed).
4. **Promotion** — via `aykoshop-deploy-gate.sh backend <candidate>`: syntax gate → isolated boot+health gate → promote → post-deploy health gate → `stable` updated. `DEPLOY SUCCESS`, exit 0.
5. **Post-deploy verification** — same 4 routes re-called on live `:4000`. 3/4 matched the baseline shape exactly; `/api/ops/health-center` showed a structural "mismatch" that was investigated and found to be a **false positive**: its `circuit` array order comes from `Object.keys()` on an in-memory object populated by an `ORDER BY`-less SQL query at process boot — this order is not deterministic across restarts and would have changed on *any* `pm2 restart`, unrelated to this patch. The `ManyChat API` entry specifically (the only part this patch touches) was re-verified and is byte-identical in status/detail/keys.
6. **E2E across all 3 channels** — sent real WhatsApp, Messenger, and Instagram test messages through the production ManyChat webhook. All three produced real AI replies from the catalog and persisted correctly to `chat_history`.
7. **Broad regression sweep** — Hermes, Products, KPI, Orders, Interventions, Customers, and 2 other ops routes all returned expected codes; no new PM2 errors.

## Rollback mechanism

Reused the same `aykoshop-deploy-gate.sh`, whose two automatic abort paths (syntax failure, health-check failure) were already proven with dedicated tests during Phase 1 Module 1 (see `docs/phase1-ops-diagnostics-report.md`). Not re-tested here to avoid redundant load on production; the gate code itself was not modified between modules.

## Result

- 5 of the ~19 ManyChat call sites de-duplicated behind 2 shared helpers, zero behavior change (confirmed structurally and by value).
- Zero impact on AI, Inbox, Products, Hermes, Dashboard, n8n, or any of the three channels' customer-facing message flow — confirmed by E2E and the regression sweep.
- Git mirror (`production-current/backend/server.js`) updated and SHA-256 verified to match the live VPS post-deploy.

## Next (not started — needs a fresh go/no-go from the user before touching it)

**Increment 2 — the send-side.** Consolidating `sendContent`/`sendFlow`/`setCustomFieldByName` into a `mcSend()`/`mcSetField()` wrapper is the natural continuation of the Channels module, but every one of those ~13 call sites can cause a real WhatsApp/Messenger/Instagram message (or a ManyChat flow trigger) to reach an actual customer. Recommended staging, smallest-risk-first:
1. `/api/send/manychat` and `/api/broadcasts/:id/send` and `/api/followup-drafts/:id/send` — dedicated send endpoints, easiest to isolate and test.
2. `sendViaManyChat()` inside the outbox worker — higher risk (it's the guaranteed-delivery path); needs its own careful test with the outbox's held/pending semantics preserved exactly.
3. `/api/customers/:id/message` and the `setCustomFieldByName` clearing inside `/api/inbox/ingest` — these are operator-facing Inbox reply mechanics; per this session's repeated "don't touch Inbox" guidance, I'd want explicit confirmation before this sub-step even though it's not literally "Inbox UI".
4. The one call inside `/api/ai/v2reply` stays untouched — it is AI code and out of scope for this phase entirely.
