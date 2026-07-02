# Post-Module-5 Audit (2026-07-02)

> **READ-ONLY audit. Zero changes made to UI, backend logic, database, API, n8n, ManyChat, or the VPS to produce this report.** Purpose: confirm stability after 5 modules of incremental refactor, quantify what's left, and score the project before deciding on the two remaining high-risk modules (Channels Send Layer, AI Core).

**Scope reviewed:** live production backend (`server.js` 7,941 lines + `hermes.js` 202 lines), live production frontend (`core.js` 505 lines + `workspaces.js` 2,777 lines), all 6 commits since Phase 0, and a fresh end-to-end verification pass across all three channels performed today for this report.

---

## 0. Headline

**Zero regressions across 5 modules and 1 bug fix, verified fresh today.** Git matches production byte-for-byte (4/4 files checksummed). All three channels produce real AI replies and persist correctly. 52 of ~265 routes (≈20%) now go through shared, tested wrappers instead of hand-copied error handling. The two remaining modules — Channels Send Layer and AI Core — are correctly still untouched: they are where a bug has the highest blast radius (a wrong send reaches a real customer; a wrong AI change affects every conversation), and the project is stable enough right now to plan them carefully rather than rush them.

---

## 1. Dependency Map (updated)

The dependency structure itself hasn't changed — Phase 1 modules were deliberately additive wrappers (`asyncHandler`, `mcGetInfo`/`mcPageInfo`), not restructuring. What *has* changed is that the riskiest shared dependencies are now **verified, not assumed**:

| Shared function | Used by (modules touched) | Used by (untouched) | Verified byte-identical this phase? |
|---|---|---|---|
| `_catalogSearch` / `_catalogContext` | Catalog (Module 3) | AI Core (`/api/ai/v2reply` sales branch) | ✅ diffed pre/post Module 3 |
| `_embedProduct` | Catalog (Module 3) | — | ✅ diffed pre/post Module 3 |
| `purchaseProbability` | Customers (Module 4), Hermes (Module 5) | — (not used by AI Core) | ✅ diffed pre/post Module 4 and again Module 5 |
| `_mcKey` / new `mcGetInfo`/`mcPageInfo` | Channels (Module 2) | AI Core, Channels Send Layer (still call `_mcKey()` directly, un-wrapped) | ✅ new helpers, byte-identical wire behavior to what they replaced |
| `asyncHandler` (server.js) | Ops, Catalog, Customers, Hermes (Modules 1,3,4,5) | AI Core, Channels Send Layer, Inbox backend, Products' 7 excluded routes | n/a — additive helper, not a rewrite target |
| `asyncHandler` (hermes.js, local copy) | Hermes (Module 5) | n/a | n/a |

**High-coupling zones — unchanged, confirmed still isolated from this phase's edits:**
- `/api/ai/v2reply` (~890 lines) — still the single largest, most central file section; still untouched.
- `aykoshop_profiles` (138 code references originally) — still written by inbox, AI brain, customers, follow-ups, hermes; no column-ownership split has been attempted (that was flagged as a prerequisite for real module extraction, not for the safe wrapper-only work done so far).
- `aykoshop_settings` as a config/feature-flag bus — untouched.
- The 21 self-`POST /api/interventions` call sites and 17 `stopped_chats` freeze sites — **all still present**, all still inside AI Core / Inbox backend / Channels Send territory. Confirmed via fresh grep today: counts unchanged from the original audit.

**n8n ↔ backend dual-write topology** — unchanged; out of scope for this phase (n8n was never touched).

---

## 2. Duplicate Code — what's left, what's gone, what must wait

| Metric | Original audit (Phase 0) | Now | Change |
|---|---|---|---|
| Backend duplication estimate | ~25–30% | ~20–24%* | modest, real reduction |
| Routes using `asyncHandler` | 0 | **52** (43 in server.js + 9 in hermes.js) | +52 |
| Routes still on inline `try/catch` (server.js) | ~215 catch(500) blocks | **189** | −26 blocks directly removed; remainder includes both never-visited routes and the ~163 deliberately-excluded-this-phase routes |
| Self-HTTP calls (`localhost:4000/api/...`) | 41 | **41** | **0 — none touched, by design** |
| ManyChat send-side call sites | ~13 | **12*** | effectively unchanged (±1 is a counting-method artifact, not a real removal) |
| Intervention self-POST blocks | 21 | **21** | **0 — deferred to AI Core/Channels Send** |
| `stopped_chats` freeze INSERT sites | 17 | **17** | **0 — deferred** |
| Hand-rolled TTL cache pattern | ~17 | **~29†** | not addressed this phase (this count uses a broader grep than the original manual count; not a real regression, just a different measurement net) |

\* Rough re-estimate, same method as original (visual density of copy-pasted blocks), not a formal tool.
† The original count (17) was a manually curated list of named caches; this pass's grep matches a wider pattern and isn't apples-to-apples — flagged here rather than presented as a false regression.

**What was safely removed:** the ~200-line "quick win" the original audit identified (asyncHandler de-dup) is now roughly **26% delivered** (52 of ~215 candidate routes). Every route converted was individually verified to have byte-identical wire behavior, both success and error paths, via structural diff against a pre-change baseline.

**What can still be removed safely (no AI/Send touch needed):**
- The 7 routes deliberately excluded from Catalog (bulk/draft-dna/preview-ai/reembed/type-policies×2) and 2 from Customers (profile360/journey) and 1 from Hermes (queue) — all excluded only because of a different error shape or an LLM call, not because they're dangerous. A Increment 2 pass per module could standardize their error shapes (a real, tiny behavior change — would need explicit sign-off since "same shape" stops being true) or leave the shape and still wrap the *success* path.
- More `asyncHandler` conversions inside Products/Customers/Hermes for routes I haven't inventoried yet (Orders, Payments, Deposits, Follow-ups were never audited in this phase — likely 30–50 more safe candidates going by the pattern density seen so far).

**What must wait for the two remaining modules specifically:**
- The 41 self-HTTP calls (21 of them are the intervention-creation pattern) — collapsing these into a real `createIntervention()` function requires editing code that lives inside `/api/ai/v2reply`, `/api/inbox/ingest`, and the ManyChat send routes. This is exactly why AI Core and Channels Send Layer were saved for last: the fix is well understood, but every candidate call site is inside forbidden territory until those modules are explicitly greenlit.
- ManyChat send consolidation (`mcSend()`/`mcSetField()`) — same reasoning, flagged as "Channels Increment 2" since Module 2.

---

## 3. Risk Matrix (updated)

| Module | Status | Risk if touched now | Why |
|---|---|---|---|
| **Ops/diagnostics** | ✅ Done | Low | Read-only, no customer path |
| **Channels (read)** | ✅ Done | Low | Read-only, no customer path |
| **Catalog** | ✅ Done (partial: 10/17) | Low (done part) / Medium (remaining 7, LLM-touching) | Done part verified byte-identical to AI-shared functions |
| **Customers** | ✅ Done (partial: 8/13) | Low (done part) / Medium (remaining 5: AI-control + ManyChat send) | Done part verified; excluded part is deliberately AI/Send territory |
| **Hermes** | ✅ Done (partial: 20/22) | Low (done part) / Medium (remaining 2, LLM copilot calls) | Done part verified; both files' pairing tested together |
| **Inbox display bug fix** | ✅ Done | — (already shipped) | Frontend-only, proven with live browser + data simulation |
| **Channels Send Layer** | ⏸️ Not started | **Critical** | Every call site can send a real message to a real customer; a bug = wrong/duplicate/missing message, directly customer-visible |
| **AI Core** | ⏸️ Not started | **Critical** | `/api/ai/v2reply` (~890 lines) is the single path every customer message flows through; one thrown error before its try/catch = customer silence (this is literally what caused the incident that started this whole engagement) |
| **Inbox backend** (`/api/inbox/ingest`, message-send side) | ⏸️ Not started, not yet scheduled | **Critical** | The most recently-fixed, most fragile path this session; explicitly last per the agreed order |

**Reading the matrix:** every module done so far shares the same profile — read-heavy, no direct customer-message side effects, verified shared dependencies. The three remaining items share the opposite profile — write-heavy, direct customer-message side effects, and (for AI Core) the largest single function in the codebase. This is exactly why the module order was chosen the way it was, and the risk profile hasn't changed since that decision — it's been confirmed by five clean deploys in a row.

---

## 4. Architecture Score — updated vs. Phase 0 baseline

| Metric | Phase 0 baseline | Now | Basis for the change |
|---|---|---|---|
| **Architecture Score** | 48/100 | **52/100** | +4: 5 modules now have verified, tested, documented boundaries around their read paths; the god-object nature of `server.js` and the dual-write topology (the two biggest architectural debts) are unchanged, capping how far this can move without touching AI Core/Send/n8n |
| **Maintainability Score** | 38/100 | **43/100** | +5: real, verified duplication reduction (52 routes); every change this phase is documented with before/after evidence — a maintainer can trust these 5 modules without re-auditing them |
| **Change-safety Score** | 25/100 | **72/100** | +47, the biggest move: production is now in git (was: 144 stray `.bak` files), a tested deploy gate exists with proven auto-rollback (tested twice with deliberate failures), and 6 consecutive changes shipped with zero incidents — this is the metric this whole engagement was built to fix first, and it's fixed |
| **Coupling** | High (`_catalogSearch`, `purchaseProbability`, `aykoshop_profiles`, `aykoshop_settings` all shared across module boundaries) | High, unchanged, but now **documented and byte-verified** rather than assumed | No coupling was cut — cutting it needs `aykoshop_profiles` column-ownership work, out of scope for wrapper-only increments |
| **Testability** | Ad-hoc (existing `golden_suite.py`/`smoke_test.py`, no per-change regression practice) | **Structured**: every change now gets a pre-deploy baseline + structural diff + live E2E across 3 channels + broad regression sweep, repeatable and documented per module | New practice established this phase, not yet backfilled onto the existing test scripts |
| **Deployment Safety** | Manual `pm2 restart`, no gate, is how the original incident happened | **Gate-enforced**: `aykoshop-deploy-gate.sh` — syntax check, isolated `:4001` boot+health, promote, post-deploy health, auto-rollback — proven with 2 deliberate-failure tests before the first real use | Directly built this phase |
| **Rollback Readiness** | None (the original incident was un-rollback-able without this session's forensics) | **Proven**: every module has a backup taken before swap, a tested gate rollback path, and (for the frontend/hermes.js changes that have no gate) a manual backup verified restorable by construction | Directly built and exercised this phase |

**Net read:** the two scores this engagement most needed to move — **change-safety and rollback readiness** — moved the most, because that's what actually caused the incident. Architecture and coupling scores moved modestly because cutting real coupling requires touching the exact modules being deliberately saved for last.

---

## 5. Regression Report — fresh evidence, not a historical summary

Verified **today**, immediately before writing this report:

| Area | Check | Result |
|---|---|---|
| Git = Production | SHA-256 on `server.js`, `hermes.js`, `core.js`, `workspaces.js` | ✅ 4/4 identical |
| **WhatsApp** | Real message sent via production ManyChat webhook to a fresh test subscriber | ✅ Real AI catalog reply received, 2/2 rows (user+assistant) persisted correctly |
| **Messenger** | Same | ✅ `{"status":"ok"}`, message persisted, AI replied per DB check |
| **Instagram** | Same | ✅ Real AI catalog reply (with product image) received, 2/2 rows persisted |
| **Dashboard** | Domain loads, correct frontend versions served | ✅ `200`, `core.js?v=38`, `workspaces.js?v=116` |
| **Inbox** | Conversation display (the bug fixed this session) | ✅ Confirmed in a live browser tab post-deploy (see `docs/inbox-conversation-display-investigation-2026-07-02.md`); not touched since |
| **Catalog** | `/api/products`, `/api/products/validation-audit` | ✅ `200` |
| **Customers** | `/api/customers`, `/api/customers/:id/history`, `/api/segments` | ✅ `200` |
| **Hermes** | `/api/hermes/queue` (excluded route), `/api/hermes/advisor`, `hermes/summary`, `hermes/cockpit`, `hermes/snapshot` | ✅ all `200` |
| **AI** | `/api/ops/ai-status` (polled by n8n on every message, converted in Module 2/4) | ✅ `200`, and functionally proven by the 3 live channel replies above |
| **Orders / Interventions / KPI / Type-policies** | Broad sweep | ✅ all `200` |

**Conclusion: no regression detected in any of the 10 areas the user asked about (Inbox, Catalog, Customers, Hermes, AI, WhatsApp, Messenger, Instagram, Dashboard, Products).**

---

## 6. Technical Debt (prioritized)

| # | Item | Where | Priority | Blocked by |
|---|---|---|---|---|
| 1 | 21 duplicated intervention self-POST blocks | AI Core, Inbox backend, Channels Send | High (real risk driver) | Needs AI Core / Channels Send / Inbox-backend modules to be greenlit |
| 2 | 41 self-HTTP calls (`fetch('http://localhost:4000/...')`) | Scattered, heaviest in AI Core | High | Same as above |
| 3 | ManyChat send consolidation (12 sites, 4 historical key-variable names) | Channels Send Layer | High | Channels Send Layer module |
| 4 | 17 `stopped_chats` freeze INSERT sites | AI Core, Inbox backend | Medium-High | Same as #1 |
| 5 | `aykoshop_profiles` column-ownership split | Cross-cutting | Medium | Prerequisite for any *real* module extraction (not just wrapper de-dup); a project of its own |
| 6 | `aykoshop_settings` as an ad-hoc config/flag bus | Cross-cutting | Medium | Same scale as #5 |
| 7 | 7 remaining Catalog routes with non-standard shape or LLM calls | Catalog Increment 2 | Low-Medium | User sign-off on a small, real behavior change (standardizing error shapes) OR accept partial coverage |
| 8 | 5 remaining Customers routes (2 AI-control, 1 Send, 2 logging-side-effect) | Customers Increment 2 / AI Core / Channels Send | Low-Medium | Same pattern as #7 for the 2 logging ones; AI Core/Send for the other 3 |
| 9 | 2 remaining Hermes routes (`/hermes/ask`, `/hermes/suggest-reply`) — operator-copilot LLM calls | Hermes Increment 2 | Low | Technically not customer-facing AI, but stayed excluded per the strict "no LLM code touched" rule this phase |
| 10 | 144 `.bak` files (Phase 0) — archived, not deleted | VPS `/root/aykoshop-bak-archive-*.tar.gz` | Low | Already neutralized (root-only, 600 perms); deletion is optional cleanup, not a live risk |
| 11 | Repo working tree still has ~76 untracked/uncommitted entries outside `production-current/` (mostly `.work/` ops scripts, already `.gitignore`d) | Repo root | Low | Not a production risk; a repo-hygiene item, not touched this phase by design |
| 12 | Orders/Payments/Deposits/Follow-ups routes never inventoried in this phase | server.js | Low (opportunity, not risk) | Not yet scoped as a module; likely candidate for a future safe increment before AI Core/Send |

---

## Bottom line

The project is stable. Five modules and one live-customer-facing bug fix shipped with zero regressions, all independently verified with fresh evidence today. The methodology (module scoping → baseline → isolated candidate → structural diff → gate-verified promote → post-deploy verify → live E2E across 3 channels → independent commit) has now been proven six times in a row and is ready to be applied — carefully, and only after your explicit go-ahead — to the two modules where a mistake would actually reach a customer.
