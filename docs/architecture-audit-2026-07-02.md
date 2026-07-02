# AykoShop — Architecture Audit (2026-07-02)

> **READ-ONLY audit. Zero changes were made to UI, backend logic, database, API, n8n, ManyChat, or the VPS during this audit.** This document is analysis and a proposed roadmap only. No refactor has been started. You decide what to apply.

**Scope reviewed:** live production backend (`server.js`, 7,944 lines), live production frontend (v2: `core.js` + `workspaces.js` + `app.css`, served from `/var/www/aykoshop-v2`), 10 live n8n workflows + ManyChat contracts, PostgreSQL (65 tables), and existing project docs + git history.

**Method:** four parallel read-only analysis passes (backend, frontend, integration, docs/history), each quoting file:line evidence, cross-checked against the live system.

---

## 0. Executive Summary

The instability you experienced (pages disappearing, features breaking unrelated features, ghost bugs, a rollback that restored an ancient backend) is **not caused by the AI and not caused by any single file being "too big" in isolation.** It is caused by the **way changes are shipped**: a large monolith edited in place on the server, dozens of manual `.bak` files acting as a shadow version-control system, no git discipline, and two independent systems (the backend and n8n) both writing to the same database tables. The code itself is more organized than expected — the v2 frontend is genuinely well-factored, and one backend module (`hermes.js`) is a clean boundary to copy. The problem is process and coupling, not talent.

| Score | Value | Rationale |
|---|---|---|
| **Architecture Score** | **48 / 100** | Clear layering intent and one clean module, but 265 routes in one process, dual-write to shared tables, 41 internal HTTP self-calls, and n8n owning business logic drag it down. |
| **Maintainability Score** | **38 / 100** | ~25–30% duplication in the backend, a 2,777-line single-scope frontend script, and **the deploy process is the main risk multiplier**. |
| **Change-safety Score** | **25 / 100** | 15 git commits vs a month of production evolution; 85 uncommitted working-tree entries; 144 `.bak` files on the VPS; production is edited by hand ahead of the repo. This is the number that must go up first. |

**The single most important finding:** production is currently the *only* complete copy of both the backend (7,944 lines, ~600 ahead of repo) and the frontend (`workspaces.js` 2,777 lines, ~780 ahead of repo). Any restore-from-backup silently deletes days of work — which is exactly the class of incident that started this whole investigation.

---

## 1. Dependency Map

### 1.1 Backend — highest fan-in (the files/helpers everything depends on)

| Helper | Call sites | Blast radius if changed |
|---|---|---|
| `pool` / `pool.query` | **672** | Every domain. The true god-object. |
| `_broadcast` (SSE) | 22 | Interventions, orders, inbox, payments — **and it triggers Hermes recompute**, so an SSE helper mutates Hermes state. |
| `circuitRecord` / `circuitAllows` | 30 | All 3 LLM callers + health. |
| `_ff` (feature flags) | 24 | AI brain, inbox, memory, follow-ups. |
| `_mcKey` / `getSecret` | 21 | Every ManyChat call site. |
| `getAiConfig` | 10 | Brain, router, interventions (emergency mode), ops. |

**Shared-table coupling (most-referenced tables):** `aykoshop_profiles` **138 refs** (written by inbox, AI brain session state, customers, follow-ups, hermes — the worst coupling point), then `orders` 70, `products` 68, `interventions` 60, `chat_history` 44, `settings` 43 (used as a runtime config *and* feature-flag *and* auth-mode bus), `stopped_chats` 28 (written from ≥17 distinct places).

### 1.2 Frontend (v2) — clean two-layer split

`core.js` (505 lines) = infrastructure (router, auth, `api`/`send`, `toast`, `openModal`, `esc`, SSE, drawer, notifications). `workspaces.js` (2,777 lines) = 9 workspace render functions. Cross-layer calls are **`typeof`-guarded** (a missing function degrades to a no-op instead of crashing) — this is genuinely good defensive design.

### 1.3 Integration — the dual-write topology (key risk)

Both the backend **and** n8n write directly to the same tables:

| Table | Written by n8n | Written by backend |
|---|---|---|
| `aykoshop_profiles` | `Save Customer Profile` (upsert) | 10 INSERT / 30 UPDATE sites |
| `aykoshop_chat_history` | `Save Chat History` (2 rows/turn) | 7 INSERT sites (backend carries 2–5-min dedup windows *only* to survive this collision) |
| `aykoshop_stopped_chats` | `Handle Chat Control` | 17 INSERT / 3 DELETE |
| `aykoshop_products` | `/sold`, `/delete`, `/clearall` (raw SQL) | full CRUD |
| `aykoshop_conversation_examples` | Learning System | `/api/conversations`, `/api/knowledge` |

n8n also carries `CREATE TABLE IF NOT EXISTS` DDL — it is a **second, unversioned migration system**. This is the deepest architectural problem: two owners for one dataset, so a change on either side can silently corrupt the other.

---

## 2. Module Boundaries (proposed target)

| Module | Owns (routes) | Owns (tables) |
|---|---|---|
| **shared/db** | — | `settings` (one config service, replacing 17 raw reads + 17 caches) |
| **shared/llm** | `/api/ai/keys` | `ai_usage`, `circuit_state` |
| **shared/sse** | `/api/events*` | — (emit via an event bus, not direct calls) |
| **channels** (ManyChat + Telegram) | `/api/send/*`, `/api/telegram/webhook`, `/api/outbox/*` | `outbox` |
| **catalog** | `/api/products*`, `/api/type-policies` | `products`, `type_policies` |
| **ai-brain** | `/api/ai/v2reply\|generate\|route\|vision\|transcribe`, `/api/mc/*` | `agent_trail`, `agents`, `verifier_log`, `profiles(session cols)` |
| **interventions (HITL)** | `/api/interventions*`, `/api/macros`, rescue-queue | `interventions`, `stopped_chats`, `rescue_queue` |
| **inbox** | `/api/inbox/*`, `/api/chat-history`, uploads | `chat_history`, `image_logs`, `profiles(inbox cols)` |
| **customers** | `/api/customers*`, segments | `profiles`, `lead_scores`, `events` |
| **orders + payments** | `/api/orders*`, `/api/payment-*`, `/api/deposits*` | `orders`, `payment_claims`, `deposits`, `payment_audit` |
| **follow-ups/recovery** (consolidate 4 systems → 1) | `/api/followup-drafts*` | `followup_drafts`, `followups` |
| **hermes** (extend the existing clean module) | `/hermes/*`, `/api/hermes/*` | `hermes_*` (read-only on core tables) |
| **ops** | `/api/ops/*`, workflow-errors, audit, kpi | `workflow_errors`, `audit_log` |
| **learning** | `/api/knowledge*`, unknown-*, training | `conversation_examples`, `unknown_*` |

**The 3 hardest entanglements to cut (do these first, they unlock everything else):**
1. **`aykoshop_profiles` is everyone's scratchpad** — split its columns by owner (identity vs conversation-session vs sales-stage) before any real module extraction.
2. **Intervention creation has hidden side-effects** — today creating one intervention implies `stopped_chats` writes + Telegram + SSE + Hermes recompute, copy-pasted across 21 self-HTTP calls. Must become one `createIntervention()` function.
3. **`aykoshop_settings` is used as a message bus** — polled by 17 raw queries with 17 independent caches, so config changes propagate inconsistently. Needs one config service.

---

## 3. Duplicate Code Audit

| Area | Finding | Evidence |
|---|---|---|
| Backend error wrappers | **112** identical `}catch(e){ res.status(500)...` one-liners (566 try-blocks total) | one `asyncHandler` deletes ~200 lines |
| **Backend self-HTTP calls** | **41** `fetch('http://localhost:4000/api/...')` — the server calling its own API instead of a function | `/api/interventions` 21×, vision 4×, hermes 4× |
| Intervention blocks | 21 near-identical create stanzas; 11 copies of the dedup-guard with hand-varied windows | L3788, 4714–4763 |
| stopped_chats freeze | 17 copies of the same UPSERT | |
| Hand-rolled TTL caches | ~17 copies of the `{t,v}` idiom | `_ffCache`, `_shopCache`, … |
| ManyChat fetch blocks | 19 sites, 4 different key variables | should be one `mcFetch()` |
| **Backend duplication** | **~25–30%** | |
| **Frontend (v2) duplication** | **~6–10%** (much better — `esc(` used 351×, `alert(` 0×, single `api`/`toast`/`openModal`) | residual is 867 inline styles + small repeated tab scaffolds |

---

## 4. Coupling Report

| Hotspot | Level | Why |
|---|---|---|
| AI brain ↔ interventions ↔ stopped_chats | **HIGH** | The 890-line `/api/ai/v2reply` inlines ≥15 gates that write stopped_chats + self-POST interventions. |
| AI brain ↔ catalog | **HIGH** | Catalog search/embeddings compiled into seller prompts; product writes trigger re-embeds. |
| Ops ↔ everything | **HIGH** | `settings` is the shared switchboard (ai_paused, emergency, auth_mode, ff_*). |
| Backend self-HTTP (41 sites) | **HIGH** | Function-call-by-HTTP inside one process — no transactionality, runs auth middleware on internal calls. |
| Global mutable state | **HIGH** | 27 module-level `let`s + in-memory circuit/SSE state → **cannot run more than one instance** (horizontal scaling impossible today). |
| n8n ↔ backend (dual-write) | **HIGH** | See §1.3. |
| Frontend workspaces | **MEDIUM** | Shared-scope globals + shared DOM ids (inbox & drawer deliberately share `chatbox`/`reply-txt`), but `typeof`-guards contain the damage. |
| **hermes.js** | **LOW** | The one clean boundary: reads core tables, writes only `hermes_*`, exposes only `/hermes/*`. **Copy this pattern.** |

---

## 5. Biggest Risk Files (ranked)

1. **`/api/ai/v2reply` (server.js, ~890 lines) — CRITICAL.** Every customer message flows through it; contains payment layer, freeze gate, slots, credentials, vision, router, seller, verifier. Highest change frequency. One throw before its try/catch = customer silence. *(This is where the `ctx is not defined` bug lived that started the outage.)*
2. **`/api/ai/generate` — HIGH.** Duplicates v2reply's rule gates with slightly different regexes → guaranteed behavioral drift between the two paths.
3. **interventions POST — HIGH.** 21 internal callers + n8n; a regression here silently disables human takeover.
4. **`workspaces.js` (frontend, 2,777 lines) — HIGH.** One non-module script = one failure domain: a single stray backtick fails to parse the whole file → **every workspace goes blank** (the "pages disappeared" mechanism).
5. **`aykoshop_settings` / `getAiConfig` / `_ff` — HIGH.** The runtime behavior switchboard with 5+ independent caches → inconsistent propagation.

**Dead/legacy code to retire (after log-confirming zero use):** `/api/follow-ups/bulk-send` (superseded by collect-only queue, ADR-0010), `/api/recommendations*` (superseded by `hermes_recommendations`), duplicate `/hermes/*` handlers that exist in both `server.js` and `hermes.js`, the entire 4,683-line monolith `dashboard/index.html` (not served — v2 replaced it), the frontend's unreachable `renderCockpit/renderSales/renderRecovery` bodies, and 3 orphaned n8n workflows (Get History, Learning webhooks, VOICE_DEBUG_TEST).

---

## 6. Risk Matrix

| Likelihood ↓ / Impact → | Low | Medium | High |
|---|---|---|---|
| **High** | inline-style bloat | 60s Embedder re-billing OpenAI on write-fail | **repo↔prod drift (restore deletes days of work)**; **workspaces.js parse-failure blanks whole UI** |
| **Medium** | legacy dead code confusion | dual-write dedup window drift | **dual-write to shared tables corrupting state**; ManyChat 10s timeout vs 13–15s AI latency dropping WA/IG replies |
| **Low** | — | `typeof`-guard silently no-oping a feature | **exposed secrets** (144 `.bak` with live OpenAI keys; Telegram bot token leaked in product image URLs; keys in n8n Code nodes) |

---

## 7. Technical Debt (quantified)

- 265 backend routes in one process; 672 direct DB queries; 41 internal HTTP self-calls; ~25–30% backend duplication.
- 27 module-level mutable globals → single-instance-only deployment.
- 5 background timers running *inside* the web server process (rate-limit 60s, media archive 90s, outbox drain, AI-brain DB poll 30s, SSE heartbeat).
- **Change management:** 15 git commits total; last commit 2026-06-26; **85 uncommitted working-tree entries**; production ~600 (backend) and ~780 (frontend) lines ahead of the repo; 144 world-readable `.bak` files on the VPS as the de-facto version control.
- **Security (from prior audit, still open):** `auth_mode='shadow'` → routes answer unauthenticated; PII exposed via `/api/customers`; plaintext secrets in `.bak` files, n8n nodes, and ops scripts; Anthropic credit exhausted (no LLM failover).
- **Interventions:** 138+ pending, historically ~0 resolved (generation automated, closure manual-only).

---

## 8. Refactor Roadmap (incremental, each step independently rollbackable)

> Not a rewrite. Each phase is shippable alone, behind a flag or a single revert, with no behavior change unless stated.

**Phase 0 — Stop the bleeding (change-safety). Highest value, lowest risk.**
- Commit the live production files (backend `server.js`, frontend `core.js`/`workspaces.js`/`app.css`) into git verbatim (secrets stripped via deploy-time injection). Deploy *from git* thereafter. This alone kills the "restore deleted my features" incident class.
- Add `node --check` on both `server.js` and `workspaces.js` to the deploy gate (the existing `aykoshop-deploy.sh` already does candidate-on-:4001 + golden tests + auto-rollback — extend it, don't replace it).

**Phase 1 — Kill the highest-risk duplication (backend, no behavior change).**
- `asyncHandler` wrapper (removes ~200 lines). One `createIntervention()`, `freezeChat()`, `mcFetch()`, `ttlCache()` — replace the 41 self-HTTP calls with direct function calls, starting with the 21 intervention ones.
- Wrap the frontend `go()` in try/catch (one blank view → one error panel, not whole-app-blank).

**Phase 2 — Cut the dual-write (integration). One table at a time.**
- Make the backend the single writer for `chat_history`, then `profiles`, then `stopped_chats`. Disable the corresponding n8n SQL nodes one at a time (backend dedup already tolerates the transition). Rollback = re-enable the node.
- Demote n8n to pure transport: it terminates the ManyChat webhook, returns the channel-shaped block the backend hands it, and does no SQL, no OpenAI, no business rules. (The `Hermes Forward` node already models the correct thin pattern.)

**Phase 3 — Extract modules behind the seams unlocked in Phase 1–2.**
- Split `profiles` columns by owner; introduce one config service over `settings`; then lift `express.Router()` per domain (products, ops, interventions, payments) with zero logic change.
- Split frontend `workspaces.js` along its existing `/* ==== ==== */` banners into `ws-catalog.js`, `ws-inbox.js`, … loaded as ordered `<script>` tags (keeps the global-function + inline-onclick contract, so a parse error in one file no longer blanks the others).

**Phase 4 — Consolidate & retire.**
- Merge the 4 follow-up subsystems into one. Delete confirmed-dead endpoints and workflows. Absorb the n8n Embedder/Scoring/Daily-Report satellites into backend jobs.

---

## 9. Regression Protection (target gate for every future deploy)

The good news: **substantial test tooling already exists** and is partly wired into `aykoshop-deploy.sh` — `golden_suite.py` (route/stage fingerprint), `golden_content.py` (catalog-aware selling invariants), `smoke_test.py` (5 critical scenarios on :4001), `e2e_buyintent.py`, `production_qa_suite.py`, `replay_engine.py` (fails on >2% regression), plus hourly watchdogs. What's missing is making them a **mandatory, uniform gate** that every change passes, plus adding: `node --check` on both big files, a per-channel E2E (WhatsApp + Messenger + Instagram → DB → dashboard → real AI reply, the exact check used to verify this week's fixes), and a frontend smoke check (each of the 9 routes renders without throwing).

---

## 10. Quick Wins (safe now, high value, no rewrite)

1. **Put production under git (Phase 0).** The single highest-value action.
2. **Add `node --check workspaces.js` + `node --check server.js` to the deploy gate.** Prevents the "whole UI blank" and "server won't boot" classes.
3. **Rotate the exposed secrets** (144 `.bak` files, n8n Code nodes, the Telegram token leaked inside product image URLs) and move them to credentials/env.
4. **Delete the dead `aykoshop-check-stopped` n8n call** — it's served by nothing, its `catch{}` fails open, and it runs on every message's critical path.
5. **Disable the Embedder's 60-second schedule** (keep the webhook) — stops re-billing OpenAI every minute on a write failure.
6. **`asyncHandler` wrapper** — removes ~200 duplicated backend lines with identical behavior.
7. **Guard the frontend `go()` router** — turns a single-workspace crash into a contained error panel.

---

## 11. Long-term Improvements

- Move the AI brain to schema-enforced structured outputs (the docs already recommend this; a 51% router parse-failure rate reached production historically).
- One event bus inside the backend so interventions/SSE/Hermes stop being wired by copy-paste.
- A single config service with change notification, ending the `settings`-as-message-bus pattern.
- Split the in-process background timers into the existing `hermes-worker` process (or a dedicated jobs process) so the web server does only request/response.
- Add the AI-provider failover drill and top up Anthropic so the LLM chain has real redundancy.

---

## Appendix — corrections made during this audit

- The live frontend is **v2** (`/var/www/aykoshop-v2`, hash router), *not* the 4,683-line `dashboard/index.html` monolith (dead code). The plaintext OpenAI key and duplicate `api()` bug reported early belong to that dead monolith, not production.
- An early alarm that "all text conversations hit a 404 fallback because n8n calls `/api/hermes/process`" was traced to the **stale** `api/server.js` (2,778-line Hermes-pipeline lineage). The **deployed** server (7,944 lines) uses `/api/ai/generate`, which exists and — after this week's `ctx` fix — returns real replies (verified by live E2E on all three channels).

*Prepared 2026-07-02. No production system was modified to produce this report.*
