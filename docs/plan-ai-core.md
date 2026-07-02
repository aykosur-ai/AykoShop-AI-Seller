# Plan — AI Core

> **This is a plan document only. Nothing in this module has been started.** This is deliberately the last module, and this plan proposes going *slower* here than every prior module, not faster.

## Why this is the highest-risk module in the whole project

`/api/ai/v2reply` (server.js, ~919 lines, lines 3743–4662) is the single function every customer message flows through, on all three channels. It is also where the `ctx is not defined` bug lived that caused the incident this entire engagement started from. Confirmed today: it remains untouched by all five completed modules — exactly as planned, and exactly why it's been reliable throughout.

## 1. Scope

**In scope:**

| Route | Lines (approx.) | Role |
|---|---|---|
| `POST /api/ai/v2reply` | 3743–4662 (~919 lines) | Primary customer-facing brain: router, seller, verifier, slot engine, payment layer, freeze gate, credentials guard, greeting debounce |
| `POST /api/ai/generate` | 4663–5052 (~389 lines) | Legacy/n8n entry path into the same brain machinery, duplicates several of v2reply's rule gates |
| `POST /api/ai/vision` | 5053–5083 | Image-understanding gate |
| `POST /api/ai/transcribe` | 5084+ | Voice-note transcription gate |
| The 21 self-`POST /api/interventions` call sites that live inside these functions | scattered through the above | Side-effect of nearly every gate |
| The 17 `stopped_chats` freeze-INSERT sites that live inside these functions | scattered through the above | Side-effect of the freeze/credentials/payment gates |
| The one `setCustomFieldByName` call inside v2reply | ~line 4665 area (confirmed in Module 3's report as explicitly untouched) | ManyChat field write, technically Channels-adjacent but embedded in AI logic |

**Explicitly out of scope:** the LLM-calling primitives themselves (`_callOpenAI`, `_callClaude`, `_callGemini`, the circuit breaker) — these were already identified in the original architecture audit as small, stable, and low-risk; touching them isn't necessary to reduce v2reply's duplication and isn't proposed here.

## 2. Why this module needs a different approach than Modules 1–5

Every module so far used the same safe pattern: convert a `try{...}catch(e){standard shape}` wrapper to `asyncHandler`, touching *only* the outer error-handling boilerplate, never the logic inside. That pattern doesn't apply well here, because:

- v2reply's actual duplication problem isn't a repeated error-wrapper — it's the **21 near-identical intervention-creation stanzas** and **17 near-identical freeze stanzas** *inside* the function body. Extracting those into `createIntervention()` / `freezeChat()` helpers is real logic refactoring, not wrapper de-duplication, even though the end behavior would be identical.
- A single dropped `await`, swapped argument order, or misread conditional inside a 919-line function is exactly the class of bug that caused the original incident. The margin for a transcription error (which the Python-literal-replace method used in Modules 1–5 protects against via exact-match anchors) is much higher here simply because of the volume of near-duplicate code with subtle per-site variations (different reason codes, different cooldown windows, different customer_message slicing).

**Proposed approach: extract-and-delegate, never rewrite-in-place.**

1. Write the new helper (`createIntervention(sub, reasonCode, detail, extra)`, `freezeChat(sub, reason)`) as a **pure addition** elsewhere in the file — fully unit-testable in isolation against the *existing* `aykoshop_interventions`/`aykoshop_stopped_chats` schemas, with zero connection to v2reply yet.
2. Verify the new helper produces **byte-identical SQL and side effects** to one specific existing call site, in isolation, before touching v2reply at all.
3. Replace **one call site at a time** inside v2reply with a call to the new helper — not all 21 at once. Each replacement is its own tiny diff (a multi-line stanza collapses to one line), independently diffable, independently revertible.
4. After each single-site replacement: full candidate-isolation test + structural diff + live E2E on the specific intent/flow that triggers that exact call site (e.g., if replacing the `PAYMENT_METHOD_UNKNOWN` stanza, the E2E test must actually trigger a payment-method-unknown reply, not just "any message").

This means AI Core is not "one increment" the way Ops/Catalog/Customers/Hermes were — it's proposed as **~10–20 micro-increments**, each touching one call site, each independently committed. Slower, but matches the stated goal: no rewrite, small isolated changes, easy to revert.

## 3. Baseline

This is the hard part for AI Core specifically: v2reply's output depends on live catalog data, live conversation history, and the LLM's own non-determinism (temperature > 0 in several calls). A structural-shape diff (which worked perfectly for GET routes returning DB rows) is not sufficient here.

**Proposed baseline strategy:**
- **Golden scenario replay**: the project already has `golden_suite.py` and `golden_content.py` (structural fingerprint + catalog-aware invariants) and `replay_engine.py` (replays real historical conversations, fails on >2% drift) sitting in `.work/` — these were built for exactly this purpose and are currently only wired into the deploy gate for *whole-file* deploys, not scoped to a single call-site change. Proposal: run the full golden suite + a replay-engine pass **before every single micro-increment**, not just at the end, since this is the one area where "the shape is right but the *decision* is wrong" is a real failure mode these tools are designed to catch.
- **Deterministic-path baseline**: for call sites that are pure rule-based (regex/keyword triggers, not LLM-decided), capture the exact trigger input and expected side effect (which table gets which row) as a literal before/after test — same rigor as the Module 4 PATCH functional test, but for a conversational turn instead of a REST call.

## 4. Candidate Environment

- Same isolated `:4001` pattern, but AI Core additionally needs the **circuit breaker and LLM provider keys** to behave identically to production for a real test to mean anything — confirm before starting whether `:4001` candidate boots share the same `.env`/circuit state as `:4000` (they have in every module so far, since `.env` is copied/shared) — if so, no new tooling needed here; if any drift is found, fix that first.
- **No test messages to real customers during iteration** — all v2reply/generate testing goes through synthetic `9994xxxx` subscribers exclusively, as already practiced.

## 5. Regression Tests

Per micro-increment:
- `node --check` + isolated boot (as always).
- Full `golden_suite.py` + `golden_content.py` run against the candidate on `:4001`.
- `replay_engine.py` against a sample of recent real (anonymized/synthetic) conversation turns, gated at the project's own existing >2% drift threshold.
- A **targeted** test that specifically exercises the one call site being changed (e.g., for the credentials-guard extraction: send a message containing what the guard is designed to catch, on a synthetic subscriber, and confirm the intervention + freeze both fire with the same reason code as before).

## 6. E2E Tests

- 3-channel sweep (WhatsApp/Messenger/Instagram) after every micro-increment, same as Modules 1–5 — cheap enough to run every time given the small blast radius per increment.
- At module completion: a broader intent-coverage pass — deliberately trigger each of the ~10–20 replaced gates once each (payment, credentials, vision handoff, greeting-repeat, slot-clarify, etc.) on synthetic subscribers, confirming each still produces its original reason code, freeze behavior, and customer-visible reply.

## 7. Rollback Plan

- `aykoshop-deploy-gate.sh` for every micro-increment, exactly as used for Modules 1–5 — proven with two deliberate-failure tests already; no new mechanism needed.
- Because each increment is a single call-site swap, a bad increment's `git revert` is a **one-line change**, which is the entire point of the extract-and-delegate, one-site-at-a-time approach — this is the actual risk-reduction this plan buys versus doing AI Core as one big increment.
- Given the history here (this exact function caused the original incident), propose an **extra safety net specific to this module**: after promoting each micro-increment, monitor `/api/ops/production-health` (`reply_rate_pct`, `errors.real_24h`) for a defined window (e.g., 15–30 minutes of real traffic) before starting the next micro-increment, not just the immediate post-deploy health check.

## 8. Exit Criteria

- All 21 intervention-creation stanzas route through one `createIntervention()` helper; all 17 freeze stanzas route through one `freezeChat()` helper.
- Every replaced call site individually verified to produce the same reason code, same table writes, same customer-visible behavior as before (not just "the file still compiles").
- Full golden suite + content suite + replay engine pass clean on the final combined state, not just per-increment.
- Full 3-channel E2E plus the standard cross-module regression sweep (Inbox/Catalog/Customers/Hermes/Products/Orders) at module completion.
- Independent git commit **per micro-increment**, each with the same before/after evidence discipline as Modules 1–5, plus the specific reason-code/behavior proof for that one call site.

## Open questions for you before this starts

1. Given the ~10–20 micro-increment structure, do you want to review/approve each one individually before it's promoted, or approve the whole extraction plan once and let them proceed with the same reporting-after-the-fact style used for Modules 1–5?
2. The `setCustomFieldByName` call embedded inside v2reply (ManyChat field write) — include it in AI Core's extraction, or hold it for Channels Send Layer once that module reaches maturity? It's one line, but touching it means editing inside v2reply either way.
3. Should the extra post-deploy monitoring window (§7) block the *next* micro-increment, or just be a passive dashboard check you do yourself? Proposing it as a hard gate by default, but flagging it since it would slow down the pace of this module considerably compared to Modules 1–5.
