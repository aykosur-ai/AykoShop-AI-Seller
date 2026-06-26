# AykoShop Dashboard + System Audit — 2026-06-26 (pre-live-Wizard stabilization)

**Method (honest):** no authed-browser/computer-use access to the dashboard. Audited via (1) static analysis of the live frontend code (`workspaces.js` v=88 / `core.js` v=37 / `index.html`), (2) live API health test of 80+ endpoints, (3) real customer E2E through `/api/ai/v2reply` + the Wizard sim. This finds bugs/duplicates/dead-code more thoroughly than clicking — but **final visual confirmation is the founder's**.

---

## ✅ Production-ready (working today)
- **Backend: 100% healthy.** All 80+ dashboard GET endpoints → HTTP 200 with sane data. Zero 500s, zero 404s. Production-health = healthy (50 active customers/24h, 137 AI replies, 45% reply rate), backups running (off-box encrypted, latest today), outbox 946 sent / 0 dead, workflow-error leak-check = 0.
- **Visible dashboard = 8 clean workspaces** (Home/Inbox/Frozen/Orders/CRM/Catalog/Hermes/Analytics + System). No duplicate *visible* pages in the sidebar.
- **Sales brain — discovery + offer half WORKS:** greeting, structured catalog, qualifying question, real product offer with **correct price (800 DH)** + close question. Gibberish → graceful clarify. No wrong human-escalation in any scenario (the old 0-sales/171-escalations bug is NOT reproduced).
- **Model Gateway works:** `/api/llm/test` routes via config chain, auto-skips Anthropic (circuit open) → mini. `ff_gateway=on` proven on the live router.
- **Wizard engine (sim) works perfectly standalone:** confirm→payment(CIH RIB)→verify→order(idempotent, dry)→deliver(16-day warranty script). Type-policies + payment-accounts + monitoring all live + correct.

## ⚠ Bugs (real, found in E2E)
1. **🔴 Recharge prices render BLANK.** "بغيت نشحن 1045 جوهرة" → reply shows 10 empty bullets `• = ` instead of "1045 جوهرة = 115 درهم". Root cause: the conversational seller doesn't read the per-package tiers from `aykoshop_products.recharge_packages` (product 39 `price_value="حسب الباقة"`). The data exists (we loaded it); the seller's recharge reply doesn't join it. **Customer sees blank prices.**
2. **🔴 Objection «غالي» regresses to discovery.** Instead of value/floor reframe (floor 750 exists), the brain drops back to "شنو نوع كيهمّك؟". Objection stage effectively absent.
3. **🔴 Trust «نصب/خايف» not handled.** Treated as gibberish/reject; the **16-day replacement warranty is never surfaced** (it exists in the policy + Wizard script). The #1 real objection gets no reassurance.
4. **🟠 Pay-intent «فين نخلص؟» re-pitches** instead of giving payment details (CIH RIB etc.). Does NOT wrongly escalate (good), but stalls one step before payment. The correct payment flow exists in the Wizard — it's just not invoked by the brain.
5. **🟠 Close stalls** — buy-intent re-pitches the product instead of advancing toward order.
- *(infra, known)* Anthropic circuit OPEN (credit out); only paid OpenAI backstops — **Gemini failover not configured** (`gemini=false`). 126 historical unresolved errors (stale; 0 real in last 24h).

## 🔁 Duplicates (all are DEAD CODE — not visible to users)
- `renderSystem` **defined twice** (workspaces.js:1269 dead + :1797 live) + dead var `_renderSystem_orig` (assigned, never read).
- **Orphan workspaces** (defined, never routed — reached only by redirect aliases to the live ones): `renderCockpit`, `renderSales`, `renderRecovery`, `renderAI`, and the old `renderInbox`/`renderRoster`/`renderPriorityQueue` (live inbox = `renderInbox2`).
- `renderAnalytics` sub-tabs are thin wrappers that re-render other workspaces' panels (salesInsights/salesWarRoom/recLost/recOverview/aiQuality) — same panels appear in Orders/Hermes/System-AI. (Intentional reuse, but overlapping.)
- Cockpit / Home / Analytics-overview render the same KPI set.
→ **These don't show as duplicate pages in the UI** (orphans aren't in the sidebar). They're internal dead code = code hygiene, not a user-facing problem.

## ❌ Remove or hide
- **Dead code (safe to delete, invisible to users, low priority):** the first `renderSystem` (1269) + `_renderSystem_orig`; orphan renderers `renderCockpit/renderSales/renderRecovery/renderAI` + old `renderInbox/renderRoster/renderPriorityQueue` + the `inbox_old` route — *after* confirming no bookmarks rely on `#/cockpit|#/sales|#/recovery|#/ai|#/inbox_old`. ⚠ `renderSales` has an `insights` (رؤى الإيراد) tab the live Orders dropped — confirm not a lost feature first.
- **Wizard test simulator** (System→🧪 Wizard «اختبار») is operator dev-tooling visible in prod — keep (it's how you test safely) but it's not a customer feature.
- No placeholder/"قريباً"/TODO text found anywhere.

## 💡 Missing (the real gaps)
- **The brain's CLOSING half** — objection handler, trust/warranty reassurance, close→payment hand-off. The logic + data EXIST (policies, floor, warranty, payment accounts, the Wizard) but are **NOT wired into the conversational seller**. This is the single biggest gap.
- **Recharge package-price rendering** in the seller reply.
- **Gemini failover** (so the brain isn't 100% dependent on paid OpenAI while Anthropic is down).
- Dashboard UI to edit `llm_chains` (today API-only).

## ⭐ Highest-priority fixes BEFORE the live Wizard
1. **Fix recharge blank-prices** (concrete bug, customer-facing) — seller must render `recharge_packages` tiers (price + floor) + ask Player ID.
2. **Surface the 16-day warranty on trust objections** («نصب/خايف/واش مضمون») — cite the real policy (it exists). Cheap, high-trust win.
3. **Objection «غالي» → value/floor reframe** (don't regress to discovery).
4. **Configure a working Gemini key** (or refill Anthropic) so the brain has a real failover, not just paid OpenAI.
5. *(hygiene, optional)* delete the dead renderers.

**Verdict:** The dashboard is clean (no visible duplicate pages) and the backend is production-healthy. The audit confirms the real blocker is **the sales brain's closing half is disconnected** — which is exactly what the **live-Wizard wiring** fixes. So the cleanup is done (mostly code hygiene + 4 concrete bugs); the #1 next step toward selling is wiring the closing stages / Wizard into the brain.
