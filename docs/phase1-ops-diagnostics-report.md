# Phase 1 — Module 1: ops/diagnostics (`asyncHandler` de-duplication)

**Date:** 2026-07-02. **Scope:** backend only, 15 read-only diagnostic GET routes. **Behavior change:** none (verified below). **Features touched:** none. **Modules outside scope touched:** none.

## What changed

Introduced one shared helper, `asyncHandler(fn)`, that reproduces the exact `catch(e){ res.status(500).json({error: e.message}) }` pattern already used by these routes, and converted 15 routes from an inline `try{...}catch(e){res.status(500).json({error:e.message})}` wrapper to `asyncHandler(async (req,res) => {...})`. No route body logic was touched — only the boilerplate around it. Net diff: 16 hunks, 85 lines, out of 7,972 total (0.4% of the file touched; 250 other routes untouched).

**Routes converted** (all GET, all read-only, all already had the identical standard error-response shape):
`/api/ops/errors`, `/api/ops/errors/incidents`, `/api/ops/errors/summary`, `/api/ops/production-health`, `/api/ops/backups`, `/api/ops/ai-status`, `/api/ops/funnel`, `/api/audit`, `/api/audit/stats`, `/api/audit/export`, `/api/ops/outbox/stats`, `/api/ops/outbox`, `/api/workflow-errors`, `/api/workflow-errors/leak-check`, `/api/ops/kpis-by-type`.

**Deliberately excluded from this pass** (kept 100% as-is, zero risk of behavior drift):
- Any route that mutates state (`pause-ai`, `resume-ai`, `circuit/:provider/reset`, `outbox/drain`, `outbox/:id/requeue`, `outbox/retry-all`, `errors/:id/resolve`, `errors/resolve-all`) — these can affect the AI pipeline and are out of a "zero behavior change" pass by definition.
- `/api/ops/circuit` — its catch block returns `200` with fallback data instead of `500` (different shape); converting it would be a behavior change.
- `/api/ops/frozen` — its catch block returns `{ok:false, error}` (different shape from the standard `{error}`).
- `/api/ops/status`, `/api/ops/health-center` — no outer try/catch today (errors are swallowed per-check internally); wrapping them would change an edge-case that currently isn't JSON at all.

## Regression testing (evidence)

1. **Pre-deploy baseline** — captured live JSON from all 15 routes on production before any change.
2. **Candidate isolation** — candidate booted on port `:4001` (customers never touched it); syntax-checked (`node --check`); all 15 routes called on `:4001` and diffed **structurally** (JSON key/type shape) against the baseline → **14/14 JSON routes identical**, CSV export header row identical.
3. **Promotion** — via `/usr/local/bin/aykoshop-deploy-gate.sh backend <candidate>`: syntax gate → isolated boot+health gate → promote → post-deploy health gate → `stable` updated. `DEPLOY SUCCESS`, exit 0.
4. **Post-deploy verification** — same 15 routes re-called on live `:4000`, diffed against the pre-deploy baseline → **14/14 structurally identical** (zero regression).
5. **E2E across all 3 channels** (the check that matters most, since `/api/ops/ai-status` is polled by n8n on *every* customer message): sent real WhatsApp, Messenger, and Instagram test messages through the production ManyChat webhook. All three produced real AI replies from the catalog (not the "ضغط تقني" fallback), and all three persisted correctly to `chat_history` (verified via `/api/customers/:id/history`).
6. **Broad regression sweep** — 12 other endpoints across Products, Orders, KPI, Customers, Hermes, Learning, Review, Interventions, Inbox, and the 4 excluded ops routes all still return `200`/expected codes. PM2 error log shows no new errors.

## Rollback mechanism — tested twice before the real deploy

- **Test A (syntax abort):** deployed a deliberately broken candidate → gate aborted at `node --check` (`exit 11`), production untouched (verified by unchanged `server.js` md5 and continued `200` health).
- **Test B (health abort):** deployed a syntactically valid candidate that never starts a listener → gate aborted at the isolated-port health check (`exit 12`), production untouched (verified the same way).

Both abort paths proved production is protected *before* promotion; only after both tests passed was the real candidate promoted.

## Result

- Backend duplication reduced by ~85 lines in this increment (part of the ~200-line `asyncHandler` opportunity identified in the architecture audit; the remaining ~185 lines are in routes intentionally excluded above, or in routes belonging to other modules and out of this phase's scope).
- Zero behavior change confirmed on the wire (structural diff, not just "looks fine").
- Zero impact on Inbox, Products, Hermes, AI replies, Dashboard, n8n, ManyChat, WhatsApp, Messenger, or Instagram — confirmed by the E2E and regression sweep above.
- Git mirror (`production-current/backend/server.js`) updated and SHA-256 verified to match the live VPS post-deploy.
