# Production Mirror — Source of Truth Snapshot

**Captured:** 2026-07-02 from the live VPS (`root@5.189.170.55`).

This directory is a **byte-exact mirror of what is currently deployed and serving customers.** It exists so the repository matches production 100% and any future restore comes from git, not from hand-made `.bak` files. Do not hand-edit these files; they are updated only by pulling from the deployed server.

## Deployed locations

| Mirror file | Live path on VPS | Served as |
|---|---|---|
| `backend/server.js` | `/var/www/backend/server.js` | PM2 `aykoshop-api` :4000 |
| `backend/hermes.js` | `/var/www/backend/hermes.js` | mounted into server.js |
| `backend/hermes-worker.js` | `/var/www/backend/hermes-worker.js` | PM2 `hermes-worker` |
| `frontend/core.js` | `/var/www/aykoshop-v2/core.js` | `core.js?v=37` |
| `frontend/workspaces.js` | `/var/www/aykoshop-v2/workspaces.js` | `workspaces.js?v=114` |
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
Frontend files unchanged by Phase 1 (still match the hashes above).

## Line counts

- `backend/server.js` — 7,968 lines (7,944 before Phase 1; +13 Module 1 asyncHandler; +13 Module 2 Inc.1 mcGetInfo/mcPageInfo; -2 Module 3 Inc.1 asyncHandler on 10 catalog routes)
- `frontend/core.js` — 505 lines
- `frontend/workspaces.js` — 2,777 lines

## Secrets

Verified **no hardcoded API keys/tokens** in any mirrored file. The backend loads all secrets from `/var/www/backend/.env` (git-ignored). Frontend enters provider keys at runtime via the admin UI (encrypted server-side).

## To re-verify repo == production at any time

```bash
ssh root@5.189.170.55 "cd /var/www && sha256sum backend/server.js aykoshop-v2/core.js aykoshop-v2/workspaces.js aykoshop-v2/app.css aykoshop-v2/index.html"
# compare against the block above
```
