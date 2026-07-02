# Phase 1 — Module 4: Customers (Increment 1 — read/simple-write route asyncHandler de-dup)

**Date:** 2026-07-02. **Scope:** backend only, 8 customer routes. **Behavior change:** none (verified below). **Modules touched outside scope:** none — specifically **zero lines inside `/api/ai/v2reply`, `/api/ai/generate`, Inbox message-sending, Hermes routes, or the ManyChat send layer were touched**. The AI/Hermes-shared helper `purchaseProbability()` (used by both `/api/customers/:id/intelligence` and the Hermes routes `/api/intelligence/customers` + `/hermes/priority-queue`) is **byte-identical before and after this commit** — verified directly.

## Why "Increment 1" and not the full Customers module at once

A full inventory of `/api/customers*` + `/api/segments` + `/api/export/customers` found **13 routes**. Split by risk, same discipline as every prior module:

| Category | Count | Included? | Why |
|---|---|---|---|
| Standard error shape, no AI-control side effects, no extra logging | **8** | **Yes — this increment** | Provably zero-behavior-change candidates |
| AI control-plane actions (`takeover` POST/DELETE) | 2 | No | These write `stopped_chats`/`interventions`, broadcast `human_takeover`, and directly control whether the AI responds to a customer — out of scope for a "no behavior change" pass regardless of shape |
| ManyChat send route (`/message`) | 1 | No | Sends a real message to the customer — this is Channels Increment 2 territory, already explicitly deferred per the agreed module order |
| Extra `console.error(...)` side effect in the catch block (`profile360`, `journey`) | 2 | No | Converting would silently drop the logging call — a real (if small) behavior change, same exclusion rule used in Module 1 and Module 3 |

**The 8 converted routes:** `GET /api/customers`, `GET /api/customers/:id/ai-status`, `GET /api/customers/:id/history`, `GET /api/customers/:id/timeline`, `GET /api/customers/:id/intelligence`, `PATCH /api/customers/:id`, `GET /api/segments`, `GET /api/export/customers`.

One of these (`/api/customers/:id/ai-status`) is on the **critical path** — it is polled by n8n's `Check Stopped & Route` node on every single customer message, alongside the already-converted `/api/ops/ai-status` from Module 2. Treated with the same extra care: included only because its catch block matches the exact standard pattern, and verified with a live E2E message on all three channels post-deploy (see below).

## What changed

Same `asyncHandler(fn)` helper from Module 1 (reused, not redefined). 8 routes converted from inline `try{...}catch(e){res.status(500)...}` to `asyncHandler(async (req,res) => {...})`. **Net diff: 11 hunks, 44 lines** out of ~7,970 (0.55% of the file).

## Regression testing (evidence)

1. **Static verification before any deploy:** `purchaseProbability()` function body diffed byte-for-byte between pre- and post-patch files — **identical**. `/api/ai/v2reply`, `/api/ai/generate`, `/api/intelligence/customers`, and `/hermes/priority-queue` confirmed still using their original `async (req,res)=>{...}` signatures (not asyncHandler) — untouched.
2. **Pre-deploy baseline** — captured live JSON/CSV from all 7 externally-safe-to-poll routes on production.
3. **Candidate isolation on :4001** — syntax-checked, all 7 GET/CSV routes diffed **structurally** against baseline → identical shapes (CSV compared by header row).
4. **Functional write test on the isolated candidate**: `PATCH /api/customers/9994E2EWA` with new notes/tags — response returned the updated fields correctly, proving the write path works end-to-end, not just "doesn't 500".
5. **Promotion** — via `aykoshop-deploy-gate.sh backend <candidate>`: syntax → isolated boot+health → promote → post-deploy health → `stable` updated. `DEPLOY SUCCESS`, exit 0.
6. **Post-deploy verification** — same 7 routes re-called on live `:4000`, diffed against baseline → **7/7 identical, zero regression**.
7. **E2E across all 3 channels** — the check that matters most here, since `/api/customers/:id/ai-status` is hit by n8n on every message. Sent real WhatsApp, Messenger, and Instagram test messages through the production ManyChat webhook. All three produced real AI catalog-aware replies, proving the per-customer AI-stopped check still gates correctly. Verified via `/api/customers/:id/history`: alternating user/assistant pairs, correctly persisted.
8. **Real production write test** — `PATCH /api/customers/9994P4WA1` with test notes on live production, confirmed the response reflects the update.
9. **Broad regression sweep** — Hermes, Products, Orders, Interventions, `/api/ops/production-health`, and the two deliberately-excluded routes (`profile360`, `journey`) all returned `200`.

## Rollback mechanism

Reused `aykoshop-deploy-gate.sh`, whose two automatic abort paths were already proven with dedicated tests in Module 1 (`docs/phase1-ops-diagnostics-report.md`). Not re-tested here; the gate script itself is unchanged since Module 1.

## Result

- 8 of 13 customer routes de-duplicated behind the shared `asyncHandler`, zero behavior change (confirmed structurally, functionally via a real write cycle, and by direct byte-diff of the Hermes-shared helper function).
- Zero impact on AI, Inbox message-sending, Hermes, Channels/ManyChat send, or any of the three customer-facing channels — confirmed by E2E, a live write test, and the regression sweep.
- Git mirror (`production-current/backend/server.js`) updated and SHA-256 verified to match the live VPS post-deploy.

## Deferred (not started, per the agreed module order)

- `takeover` POST/DELETE, `/message` — AI-control and ManyChat-send routes; explicitly out of scope until Channels Increment 2 (deferred by prior agreement).
- `profile360`, `journey` — different catch-block behavior (extra logging); a possible future increment for this module.
- Next per the agreed order: **Module 5 (Hermes)** — classification, memory, intent, queue — behind Customers in the plan, ahead of AI/ManyChat-send/Inbox.
