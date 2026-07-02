# Phase 1 — Module 3: Catalog (Increment 1 — CRUD route asyncHandler de-dup)

**Date:** 2026-07-02. **Scope:** backend only, 10 product/catalog CRUD routes. **Behavior change:** none (verified below). **Modules touched outside scope:** none — specifically **zero lines inside `/api/ai/v2reply`, `/api/ai/generate`, Inbox, Hermes, or the ManyChat send layer were touched**, and the shared helpers `_catalogSearch`/`_catalogContext`/`_embedProduct` (used by both catalog routes AND the AI brain) are **byte-identical before and after this change** — verified directly, not assumed.

## Why "Increment 1" and not the full Catalog module at once

A full inventory of `/api/products*` and `/api/type-policies*` found **17 routes**. Split by risk, same discipline as Module 1 and Module 2:

| Category | Count | Included? | Why |
|---|---|---|---|
| Standard error shape (`{error: e.message}`), no LLM call, pure DB CRUD | **10** | **Yes — this increment** | Provably zero-behavior-change candidates |
| Different error shape (`{ok:false, error:...}`): `bulk`, `draft-dna`, `preview-ai`, `reembed`, `type-policies` (GET+PUT) | 6 | No | Converting would change the error response shape — a real behavior change |
| Calls an LLM directly (`draft-dna`, `preview-ai` call `_callClaude` for product-authoring copy) | 2 (overlaps above) | No | Any LLM-touching code stays out of this phase entirely, even product-authoring LLM use, per this phase's AI restriction |
| Extra side effect in the catch block (`suggest` logs via `console.error` before responding) | 1 | No | Removing the log call would itself be a (small) behavior change |

**The 10 converted routes:** `GET /api/products`, `POST /api/products/add`, `POST /api/products/gen-keywords`, `GET /api/products/validation-audit`, `PUT /api/products/:id`, `DELETE /api/products/:id`, `PATCH /api/products/:id/status`, `POST /api/products/embed`, `POST /api/products/vector-search`, `GET /api/products/embed-status`.

Two of these (`add`, `PUT /:id`) call `_embedProduct(id)` **fire-and-forget** (not awaited) after a successful write — this call is completely untouched; only the outer `try{...}catch(e){res.status(500)...}` wrapper around the whole route was replaced with `asyncHandler(...)`, exactly like Module 1. The shared AI-facing catalog functions were diffed line-for-line between the pre- and post-patch file and are **identical**.

## What changed

Same `asyncHandler(fn)` helper introduced in Module 1 (not redefined — reused). 10 routes converted from inline `try{...}catch(e){res.status(500).json({error:e.message})}` to `asyncHandler(async (req,res) => {...})`. **Net diff: 8 hunks, 47 lines** out of ~7,970 (0.6% of the file).

## Regression testing (evidence)

1. **Static verification before any deploy:** `_embedProduct`, `_catalogSearch`, `_catalogContext` function bodies extracted and diffed between pre- and post-patch files — **byte-identical**. `/api/ai/v2reply` and `/api/ai/generate` route bodies confirmed still using the original `async (req,res)=>{...}` signature (not asyncHandler), i.e. untouched.
2. **Pre-deploy baseline** — captured live JSON from the 3 externally-safe-to-poll GET routes (`/api/products`, `/api/products/validation-audit`, `/api/products/embed-status`) on production.
3. **Candidate isolation on :4001** — syntax-checked, all 3 GET routes diffed **structurally** against baseline → identical shapes.
4. **Functional CRUD test on the isolated candidate** (not production): created a test product (`__PHASE3_TEST_PRODUCT__`, draft status), updated its price, changed its status to `available`, confirmed via GET, then deleted it. All 4 operations returned the expected shapes and the DB state matched at each step — proves the write routes still work end-to-end, not just "doesn't 500".
5. **Promotion** — via `aykoshop-deploy-gate.sh backend <candidate>`: syntax → isolated boot+health → promote → post-deploy health → `stable` updated. `DEPLOY SUCCESS`, exit 0.
6. **Post-deploy verification** — same 3 GET routes re-called on live `:4000`, diffed against baseline → **3/3 identical, zero regression**.
7. **E2E across all 3 channels** — real WhatsApp, Messenger, and Instagram test messages sent through the production ManyChat webhook. All three produced real AI catalog-aware replies (e.g. WhatsApp got a real Free Fire account pitch at its real price), proving the AI's catalog search path — which depends on the untouched shared functions — still works correctly after this deploy.
8. **Real production CRUD test** — created and deleted a test product (`__PHASE3_PROD_TEST__`) directly on live production to confirm the write path works end-to-end for real, not just on the isolated candidate.
9. **Broad regression sweep** — Hermes, KPI, Orders, Interventions, Customers, `/api/ops/production-health`, and `/api/type-policies` (a route this patch deliberately did NOT touch) all returned `200`.

## Rollback mechanism

Reused `aykoshop-deploy-gate.sh`, whose two automatic abort paths were already proven with dedicated tests in Module 1 (`docs/phase1-ops-diagnostics-report.md`). Not re-tested here; the gate script itself is unchanged since Module 1.

## Result

- 10 of 17 catalog routes de-duplicated behind the shared `asyncHandler`, zero behavior change (confirmed structurally, functionally via full CRUD cycle, and by direct byte-diff of the AI-shared helper functions).
- Zero impact on AI, Inbox, Hermes, Channels/ManyChat send, or any of the three customer-facing channels — confirmed by E2E, live CRUD test, and the regression sweep.
- Git mirror (`production-current/backend/server.js`) updated and SHA-256 verified to match the live VPS post-deploy.

## Deferred (not started, per the agreed module order)

- The 6 excluded catalog routes (`bulk`, `draft-dna`, `preview-ai`, `reembed`, `type-policies` GET+PUT) — different error shape or LLM-adjacent; a possible Increment 2 for this module, lower priority than moving on to Module 4 (Customers) per the agreed order.
- Module 2 Increment 2 (ManyChat send layer) and Module 6/7 (AI, Inbox) remain explicitly deferred per prior agreement — not touched, not started.
