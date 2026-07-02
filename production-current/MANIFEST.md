# Production Mirror — Source of Truth Snapshot

**Captured:** 2026-07-02 from the live VPS (`root@5.189.170.55`).

This directory is a **byte-exact mirror of what is currently deployed and serving customers.** It exists so the repository matches production 100% and any future restore comes from git, not from hand-made `.bak` files. Do not hand-edit these files; they are updated only by pulling from the deployed server.

## Deployed locations

| Mirror file | Live path on VPS | Served as |
|---|---|---|
| `backend/server.js` | `/var/www/backend/server.js` | PM2 `aykoshop-api` :4000 |
| `backend/hermes.js` | `/var/www/backend/hermes.js` | mounted into server.js |
| `backend/hermes-worker.js` | `/var/www/backend/hermes-worker.js` | PM2 `hermes-worker` |
| `frontend/core.js` | `/var/www/aykoshop-v2/core.js` | `core.js?v=38` |
| `frontend/workspaces.js` | `/var/www/aykoshop-v2/workspaces.js` | `workspaces.js?v=116` |
| `frontend/app.css` | `/var/www/aykoshop-v2/app.css` | `app.css?v=33` |
| `frontend/index.html` | `/var/www/aykoshop-v2/index.html` | dashboard shell |

## Integrity — SHA-256 (local mirror == live VPS, verified identical at each capture)

Captured 2026-07-02 (Phase 0 baseline):
```
0f4590e4b045adb76eb44fce8b0881820ca30cf9668aca471ef7285226233a81  backend/server.js
3b3752d853ffd92d35be557b6f0576fa623a0ff2f6f18a963af0397aaa90ae10  frontend/core.js
eb0b494cffb96c18979328362630ef19882ec8a6902c3b86a2cc4f9eb91f1606  frontend/workspaces.js
26efd2d73cd1c3b6d9a213fa54f4035a6adeb1e3faf052c03197e3d74a43160a  frontend/app.css
440fbcb446afc94c69fddb3f685e1661854c7b01959b3009d767e755cb05f85f  frontend/index.html
```

Updated 2026-07-02 (Phase 1 Module 1 — ops/diagnostics asyncHandler, backend only):
```
e20840d03e0c183850a333c54a135c24995c91e5ba65c0de44349a1325535430  backend/server.js
```

Updated 2026-07-02 (Phase 1 Module 2 Increment 1 — Channels read-only ManyChat GET wrapper, backend only):
```
1eb2224f41feba6e913efa47f7b5df8ddcaa80e791b78c47ab337b76e08ed774  backend/server.js
```

Updated 2026-07-02 (Phase 1 Module 3 Increment 1 — Catalog CRUD asyncHandler, backend only):
```
02e19c609e0c43787cfa76cd76af64dfc6c27719a4b107a651e49e8fda1a5137  backend/server.js
```

Updated 2026-07-02 (Inbox conversation-display bug fix — frontend only):
```
a27781a76013f932c71bdd350a1727012b7868888701a932b8b660aaa71d43bf  frontend/workspaces.js
70312de451b73a5902aa110851c18d6a0c2c361343086cdf8ca9de7cc889cb08  frontend/core.js
fdcff241a73d1a58ff1acecc843f9bff685d3d7bb4b1e092afc9440868ce7a6f  frontend/index.html
```
Backend unchanged by this fix (still matched Module 3 hash at that point).

Updated 2026-07-02 (Phase 1 Module 4 Increment 1 — Customers read/simple-write asyncHandler, backend only):
```
095c7b8455c85abfcbb3806820ae135d3315a9cd99661ea7dbee5e8767522605  backend/server.js
```

Updated 2026-07-02 (Phase 1 Module 5 Increment 1 — Hermes asyncHandler, backend only, both server.js and hermes.js):
```
358aba05ac2e6d015d3c38e8aa104b38cfe716efa0d0c9cbf84c4a05df8caaeb  backend/server.js
016fe5d8735a5bcb9805965e17fed0b17b78276ddccd4705a3a3eeb1f8a1bd67  backend/hermes.js
```
Frontend unchanged by this module (still matches the inbox-fix hashes above).

## Line counts

- `backend/server.js` — net change from asyncHandler de-duplication across Modules 1, 2, 3, 4, 5 — each conversion removes a `try{`/`}catch(e){...}` wrapper pair (was 7,944 lines before Phase 1)
- `backend/hermes.js` — +9 lines (local `asyncHandler` helper, Module 5)
- `frontend/core.js` — 505 lines
- `frontend/workspaces.js` — 2,777 lines

## Secrets

Verified **no hardcoded API keys/tokens** in any mirrored file. The backend loads all secrets from `/var/www/backend/.env` (git-ignored). Frontend enters provider keys at runtime via the admin UI (encrypted server-side).

## To re-verify repo == production at any time

```bash
ssh root@5.189.170.55 "cd /var/www && sha256sum backend/server.js aykoshop-v2/core.js aykoshop-v2/workspaces.js aykoshop-v2/app.css aykoshop-v2/index.html"
# compare against the block above
```
