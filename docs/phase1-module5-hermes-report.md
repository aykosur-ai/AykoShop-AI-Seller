# Phase 1 — Module 5: Hermes (Increment 1 — classification/memory/queue asyncHandler de-dup)

**Date:** 2026-07-02. **Scope:** backend only, 20 Hermes-domain routes across **two files** (`server.js` and `hermes.js`). **Behavior change:** none (verified below). **Modules touched outside scope:** none — specifically **zero lines inside `/api/ai/v2reply`, `/api/ai/generate`, `/hermes/ask`, `/hermes/suggest-reply`, or any Channels-send/Catalog/Customers/Inbox code were touched**.

## Why this module spans two files

Hermes exists in two forms in this codebase: a clean, self-contained module (`hermes.js`, 9 routes, states its own contract in its header comment — "reads core tables... writes ONLY hermes_*, exposes ONLY /hermes/*") and a second, ad-hoc set of Hermes/intelligence routes that grew directly inside `server.js` (13 routes: `/api/intelligence/*`, `/api/hermes/*`, plus 3 more `/hermes/*` routes). Both are genuinely "Hermes" from the user's perspective (classification, memory, priority queues) and were audited together.

`hermes.js` is loaded via `require('./hermes')` — a **separate JS module scope**. The `asyncHandler` helper already defined in `server.js` (Module 1) is not visible inside it. Rather than change the require/export contract, `hermes.js` got its **own small local `asyncHandler`** (same 4-line implementation) — preserving the file's stated self-containment instead of adding a new coupling to `server.js` internals.

## Why "Increment 1" and not every Hermes route at once

Full inventory: **22 Hermes-domain routes** (13 in `server.js`, 9 in `hermes.js`). Split by risk, same discipline as every prior module:

| Category | Count | Included? | Why |
|---|---|---|---|
| Standard `{error: e.message}` shape, no LLM call | **20** | **Yes — this increment** | 11 in `server.js` + 9 in `hermes.js` |
| Different error shape (`{ok:false,...}`) | 1 | No | `/api/hermes/queue` — converting would change the error response shape |
| Calls an LLM directly | 2 | No | `/hermes/ask` (via `hermesAnswer()` → OpenAI) and `/hermes/suggest-reply` (OpenAI inline) — both are operator-facing "copilot" features, not the customer sales AI, but any LLM-touching code stays out of this phase entirely per the agreed rule |

**The 20 converted routes:**
- `server.js` (11 replacements covering 10 routes — `/api/hermes/demand`'s large body needed a head+tail split): `GET /hermes/snapshot`, `GET /api/intelligence/customers`, `GET /hermes/priority-queue`, `GET /api/intelligence/sales`, `GET /api/hermes/demand`, `GET /api/hermes/advisor`, `GET /api/hermes/catalog`, `POST /api/hermes/signals/scan`, `GET /api/hermes/signals`, `GET /api/hermes/opportunities`.
- `hermes.js` (9 routes): `GET /hermes/summary`, `GET /hermes/cockpit`, `GET /hermes/recommendations`, `GET /hermes/alerts`, `GET /hermes/context/customer/:id`, `POST /hermes/recommendations/:id/dismiss`, `POST /hermes/recommendations/:id/actioned`, `GET /hermes/health`, `GET /hermes/recovery`.

`purchaseProbability()` — already verified byte-identical in Module 4, since it's shared between `/api/customers/:id/intelligence` and two of this module's routes (`/api/intelligence/customers`, `/hermes/priority-queue`) — was **not touched again** in this pass; re-confirmed still identical.

## What changed

`server.js`: reused Module 1's `asyncHandler`, converted 10 routes. Net diff: **11 hunks, 36 lines**.
`hermes.js`: added a local `asyncHandler` (7 new lines) + converted all 9 routes. Net diff: **3 hunks, 42 lines**.
Combined: ~7,970-line file + ~200-line file, 78 lines touched total — none inside AI/Channels-send/Catalog/Customers/Inbox code.

## Regression testing (evidence)

1. **Static verification before any deploy:** `/api/hermes/queue`, `/hermes/ask`, `/hermes/suggest-reply`, `/api/ai/v2reply`, `/api/ai/generate` confirmed still using their original `async (req,res)=>{...}` signatures (not asyncHandler) — untouched.
2. **Pre-deploy baseline** — captured live JSON from all 15 externally-safe-to-poll GET routes across both files.
3. **Paired candidate isolation** — because `server.js` requires `./hermes.js` at boot, both candidates were tested together in one isolated test directory (symlinked `node_modules`, copied `.env`, both candidate files renamed to their real names) booted on `:4001`. Confirmed via the boot log that `hermes.js`'s own routes registered (`[hermes] /hermes/* routes registered`). All 15 routes diffed **structurally** against baseline → identical shapes.
4. **Functional write test on the isolated candidate**: `POST /api/hermes/signals/scan` (real signal-detection logic, unchanged internals — ran normally, `inserted:0` because of the existing 3-day dedup cooldown, no duplicate spam) and `POST /hermes/recommendations/999999999/dismiss` + `/actioned` (nonexistent id — exercises the UPDATE SQL path without touching real data) — all returned the expected success shape.
5. **Promotion** — `hermes.js` was swapped in place first (backed up, syntax-checked) since the deploy-gate script only manages `server.js`; then `server.js` was promoted via `aykoshop-deploy-gate.sh backend <candidate>`, which re-verified the pairing by booting the new `server.js` on `:4001` against the already-swapped new `hermes.js` — syntax → isolated boot+health → promote → post-deploy health → `stable` updated. `DEPLOY SUCCESS`, exit 0. A single combined rollback path was prepared (`hermes.js.pre-phase5.bak` + the gate's own `server.js.stable`) in case the gate had failed.
6. **Post-deploy verification** — same 15 routes re-called on live `:4000`, diffed against baseline → **15/15 identical, zero regression**.
7. **E2E across all 3 channels** — real WhatsApp, Messenger, and Instagram test messages sent through the production ManyChat webhook. All three produced real AI catalog-aware replies, proving the untouched AI path still works and confirming this module's changes have zero effect on customer conversations.
8. **Broad regression sweep** — the excluded `/api/hermes/queue`, plus Customers/Products/Orders/Interventions/`ops/production-health`/Segments all returned `200`.

## Rollback mechanism

Reused `aykoshop-deploy-gate.sh` for `server.js` (already proven with dedicated abort tests in Module 1). `hermes.js` has no separate gate mechanism (it's a small required module, not a standalone server) — its rollback is the manual backup taken before the swap (`hermes.js.pre-phase5.bak`, still on the VPS), verified restorable by construction (byte-for-byte copy of the pre-change file).

## Result

- 20 of 22 Hermes-domain routes de-duplicated behind `asyncHandler` (one shared instance in `server.js`, one small local instance in `hermes.js`), zero behavior change (confirmed structurally, functionally via real write-path tests, and by direct verification that the LLM-touching and different-shape routes were left untouched).
- Zero impact on AI, Channels-send, Catalog, Customers, Inbox, or any of the three customer-facing channels — confirmed by E2E and the regression sweep.
- Git mirror (`production-current/backend/server.js` and `hermes.js`) updated and SHA-256 verified to match the live VPS post-deploy.

## Deferred (not started, per the agreed module order)

- `/api/hermes/queue` (different error shape), `/hermes/ask`, `/hermes/suggest-reply` (LLM calls) — could be a future increment for this module.
- Next per the agreed order: **Channels Send Layer** (`sendContent`/`sendFlow`/`setCustomFieldByName`) and **AI Core** remain explicitly deferred — the two highest-risk modules, saved for last as agreed.
