# AykoShop — AI Sales Platform: the definitive 2026 architecture (5-year design)

**Scope it must serve:** 80+ digital products · 8 payment methods · thousands of convos/day · Arabic + Darija with typos/abbreviations/unclear messages · trust-critical (any error in product / price / bank / payment-method / order = money lost). Goal: a sales *specialist* that understands → persuades → **closes**, with near-zero errors on the money path, evolvable for years without a rewrite.

## The one principle everything derives from
**The LLM never DECIDES anything that costs money. It only UNDERSTANDS (messy Darija → structured intent) and PHRASES (writes the line). Every product, price, payment-method, order, and stage-transition is decided by deterministic CODE reading the DB.** Errors on money become *structurally impossible*, not "rare if the prompt is good."

This is the consensus behind reliable commerce/CX agents in 2026: **LLM proposes, code disposes; the model is the language layer, not the brain of record.**

## The shape: a deterministic Compound Pipeline (NOT a free agent)
Every inbound message runs a fixed 5-step pipeline (same order, every time — auditable, testable, model-swappable):

```
UNDERSTAND → DECIDE → COMPOSE → VERIFY → PERSIST
 (LLM)       (CODE)    (LLM)     (CODE)   (CODE)
```
1. **UNDERSTAND (LLM, structured output):** messy message → typed `SalesMemory` slots `{intent, game, product_type, budget, objection, payment_signal, confidence}`. The model returns a **schema-validated object** — invalid output is impossible.
2. **DECIDE (CODE, zero LLM):** a **declarative policy table** picks ONE next action from a bounded set `{ask_intent, ask_product, ask_budget, search&recommend, answer+advance, handle_objection, soft_close, OPEN_WIZARD, escalate}`. With 80 products, "which product" is **not** in the table — it's a `search_catalog` DB query (below). Buy-readiness = a **transparent signal-counting rule** (buy-verb + product-locked + budget-given + payment-word), not a learned gate.
3. **COMPOSE (LLM):** phrases the code-chosen action in warm Darija, from a SMALL engineered context (the slots + the DB candidate rows + 1-2 retrieved winning phrasings). It can only talk about the rows code handed it.
4. **VERIFY (CODE, fail-closed):** output guardrail scans the drafted reply — any product/price/payment token NOT in the DB-grounded candidate set → **block + regenerate or escalate**. Never sends an invented fact.
5. **PERSIST (CODE):** SalesMemory + transcript + a decision-trace event (the flywheel fuel).

When the LLM is fully down, UNDERSTAND/COMPOSE degrade to rule-based templates — **the funnel still advances and still closes**, because the brain (DECIDE) is code.

---

## Answers to your 12 questions

**1) Understand messy Darija / typos / abbreviations.** This is the LLM's strength — keep it as UNDERSTAND, but harden: (a) strict-schema extraction so output is always usable slots; (b) a deterministic **alias/lexicon map** (كونط=حساب=compte=acc, شدات=جواهر=diamonds, فري فاير=ff=freefire…) applied before+after so spelling variants normalize without an LLM call; (c) low extraction-confidence → ask **one** contextual clarifying question (never escalate); (d) voice → transcribe → same pipeline; (e) **RAG over your real past messages** so the model sees how YOUR customers actually write. Safety net: even a wrong understanding only produces *slots*, never a money action.

**2) Totally prevent invented prices / products / payment data.** Three locks: (i) **Grounding** — products come only from `search_catalog()` rows, price only from `get_price()`, payment only from `get_payment_methods()` (all DB). (ii) **The model is told it may only reference the rows it was given.** (iii) **Output Verifier (fail-closed)** — before send, regex/lookup every number + product name + payment term against the DB candidate set; any mismatch → block. Result: an invented price can't reach the customer even if the model hallucinates.

**3) All sensitive decisions by the system, not the model.** The DECIDE step is 100% code. Tools are the *only* way the model touches data, and **tools validate** (e.g. `create_order` checks product+price+stock+idempotency; `get_payment_methods` returns active rows only). The model has zero write authority on money/catalog/order.

**4) A sales specialist, not a Q&A assistant.** The DECIDE policy gives **every turn a commercial goal** (advance the funnel) via the stage table + objection handling + soft-close + the Wizard. "Answer the question" is itself an action that ends with "…واش نكمّل ليك؟". It never answers-and-stops.

**5) Guide to payment without human handoff (except necessity).** The **Purchase Wizard** — a deterministic, DB-driven, resumable state machine: product-confirm → variant → quantity → payment-method (from 8) → account/wallet detail → show + copy → screenshot → verify → **create_order (idempotent)** → deliver. Zero LLM in the money path. Handoff ONLY: product truly absent · customer asks for a human · technical error · stuck after N genuine attempts — each with full context to the operator.

**6) Why big-company systems don't collapse on a model change.** Because the model lives behind a **Model Gateway** and everything else is model-independent (contracts, policy, tools, data, eval). They don't "trust" a model — they **gate** it: a new model must pass the eval/replay suite before it's allowed in. Control flow is code, so a model regression degrades phrasing, not correctness.

**7) Make a future model change a config, not a rebuild.** One internal `llm()` gateway: provider-agnostic, failover (primary→secondary→tertiary→rule-floor), **strict structured-output normalized at the gateway** (so you're not coupled to one vendor's tool-calling dialect), model-routing (cheap model default, strong model only on flagged-hard turns), per-call cost/latency/trace. Swapping a model = change a config row + re-run evals.

**8) Monitor quality BEFORE shipping any update.** The **Eval harness**: (a) a labeled set of real conversations (seed it from your lost-buy turns), (b) **simulation** — LLM-played Darija customer personas (price-sensitive, distrustful, ready-buyer, time-waster, fake-screenshot) run multi-turn convos in CI, (c) an LLM-judge rubric (advanced-the-sale / catalog-safe / price-correct / payment-safe / didn't-over-escalate) **+ hard deterministic asserts** (price==DB, no off-catalog product), (d) a **regression gate** in the deploy script + canary/shadow with auto-rollback. Nothing ships unless it beats baseline.

**9) Improve continuously WITHOUT thousands of convos or huge token burn.** (a) **Simulation** = unlimited cheap test cases (you don't wait for real traffic); (b) the eval set is **small but high-signal** (dozens of labeled real turns); (c) **RAG over winning conversations** (few-shot) lifts quality with **no fine-tuning**; (d) iterate prompt/policy, gated by the cheap eval; (e) **no fine-tuning early** — context-engineering + RAG + the deterministic policy carry you far. The flywheel runs on a small labeled set + simulation, not on volume.

**10) Minimum data to start improving correctly.** ~**30-50 labeled real conversations** (you already have 48h of them — label the lost-buy turns first) is enough to build the first eval set + measure regressions. Conversion-rate *learning* needs more (hundreds of outcomes), but quality *evaluation* starts at dozens. Start now.

**11) Learn from operator interventions + winning conversations automatically.** Every successful close (operator or AI) → **genericise** (strip PII/numbers) → add to the **RAG library** (winning phrasings + objection refutes). The Learning Loop is **retrieval-first, not generation** (never invents). Tune the DECIDE policy from outcomes only after **hundreds of stratified outcomes** (observe-only until then). **Pricing is never learned — forever.**

**12) Daily KPIs (is it improving or regressing?).**
- **North Star:** Conversion rate (convos → paid orders) + **money-error rate** (off-catalog/price/payment caught by the verifier — target ≈0).
- **Funnel:** stage drop-off (where it leaks), objection-handled %, soft-close→wizard %, wizard completion %.
- **Reliability:** escalation rate + by-reason, router/extraction success %, p50/p95 latency, cost/conversation, provider-failover events.
- **Offline:** the eval-judge score trend per release (must not regress).

---

## KEEP / REBUILD / OUTDATED — honest

**KEEP (already 2026-correct):** code-decides-transitions · price-from-DB · catalog-only / payment-sacred firewalls + output verifier · the Purchase-Wizard instinct · feature-flag discipline (OFF=byte-identical) · SSE event-driven inbox · the gateway idea (`_callClaude/_callOpenAI/_callGemini`) · the recently-fixed structured router.

**REBUILD:** the mega-prompt + `_v2ParseJSON` regex brain → strict-schema structured outputs · the AI orchestrated *inside n8n* (canary node + image branch w/ hardcoded key) → backend-owned pipeline, **n8n = transport only** · the if/else transition thicket → a **declarative policy table** · provider handling → a real **gateway with working failover** (Gemini is currently broken) · product matching → a real **`search_catalog` (structured + semantic) tool** (mandatory at 80 products — a 2-product shortcut won't scale).

**OUTDATED in 2026:** mega-prompts as the brain · regex/manual JSON parsing · hand-drawn conversation flowcharts · autonomous multi-agent swarms for serving one customer · learned probability gates before you have data · orchestrating the reasoning core inside an automation tool · early fine-tuning (RAG + context-engineering first).

**Current best practice (what the big labs/agent companies actually do):** small deterministic core + LLM as a swappable language layer · tools as the only data interface, tools validate · grounding + output verification for zero hallucinated facts · **evals + simulation as a first-class, day-1 system** · model gateway + structured outputs · narrow, well-instrumented human handoff · a data flywheel (trace → label → eval → flagged/canary ship).

---

## The 80-product / 8-payment specifics (what changes from a tiny catalog)
- **Product selection = retrieval, not memory.** `search_catalog(game, type, budget, keywords)` = structured SQL filter + (optionally) semantic rank over product embeddings → returns ≤3 candidate **rows**; the LLM presents only those. This is how you sell 80 products without ever naming a wrong one.
- **8 payment methods = pure DB-driven Wizard step** (`get_payment_methods()` → active rows → buttons/numbered list). Add a 9th in the DB → it appears, zero code.
- **Catalog/price are the most-changing data → they MUST be DB-authoritative + verifier-checked**, never in prompt or model memory.

## Build order (strangler-fig, flag-gated, never breaks prod)
0. **Stop the bleed (now):** raise the early-handoff cap; flip ON the built objection/memory flags; **founder: restore a strong provider**. + fix the `POST /api/orders` idempotency bug (duplicate-order risk).
1. **Contracts (the 5-year constitution):** freeze the schemas — catalog/price/payment tables, tool interfaces, SalesMemory, Wizard FSM, verifier contract, decision-trace log, eval rubric.
2. **Model Gateway** (failover + strict structured output + routing; fix Gemini).
3. **Eval + Trace + Simulation harness** (seed from the real 48h; regression gate in deploy).
4. **`search_catalog` retrieval tool** (the 80-product enabler) + grounding + output verifier hardening.
5. **Purchase Wizard** (idempotent money rails, 8 methods, resumable, cross-channel).
6. **Declarative DECIDE policy** (replaces if/else; n8n → transport).
7. **Learning loop** (RAG over winning convos; outcome-tuning last, observe-only). Pricing never learned.

**This core survives 5 years because the durable parts — contracts, data authority, deterministic money path, eval flywheel — are independent of any model; only the swappable edge (model/prompt) changes, behind the gateway, gated by evals.**
