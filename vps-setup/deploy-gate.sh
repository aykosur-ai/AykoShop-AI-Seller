#!/bin/bash
# AykoShop Deploy Gate (Phase 0) — safe promotion of a candidate server.js with:
#   1) node --check (syntax) on the backend candidate  -> ABORT if broken (prod untouched)
#   2) boot the candidate on an isolated port :4001     -> ABORT if it doesn't come up healthy
#   3) promote (cp -> server.js) + pm2 restart          -> post-deploy health on :4000
#   4) AUTO-ROLLBACK to server.js.stable if unhealthy   -> restore + restart + verify
#   5) frontend guard: node --check on workspaces.js/core.js before any nginx swap
#
# It does NOT modify application logic. It only gates promotion. Read /var/log/aykoshop-deploy-gate.log.
#
# Usage:
#   deploy-gate.sh backend <candidate.js>     validate+promote a backend candidate
#   deploy-gate.sh frontend <file.js> ...      node --check one or more frontend JS files (no deploy)
#   deploy-gate.sh verify                      just run health + syntax checks on what's live now
set -uo pipefail
B=/var/www/backend
SRV="$B/server.js"; STABLE="$B/server.js.stable"; ENVF="$B/.env"
TPORT=4001; LIVE="http://localhost:4000/api/ops/ai-status"; TEST="http://localhost:$TPORT/api/ops/ai-status"
LOG=/var/log/aykoshop-deploy-gate.log
log(){ echo "[$(date '+%F %T')] gate: $*" | tee -a "$LOG"; }

health(){ local url=$1 i; for i in $(seq 1 25); do
  [ "$(curl -s -m5 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" = "200" ] && return 0; sleep 1; done; return 1; }

frontend_check(){
  local rc=0
  for f in "$@"; do
    if node --check "$f" 2>/tmp/fecheck.err; then log "  frontend node --check OK: $f"
    else log "  frontend node --check FAIL: $f -> $(tail -1 /tmp/fecheck.err)"; rc=1; fi
  done
  return $rc
}

case "${1:-}" in
  frontend)
    shift; log "===== FRONTEND SYNTAX GATE ====="
    frontend_check "$@" && { log "FRONTEND GATE PASS"; exit 0; } || { log "FRONTEND GATE FAIL — do NOT deploy"; exit 21; } ;;

  verify)
    log "===== VERIFY LIVE ====="
    node --check "$SRV" && log "backend syntax OK" || log "backend syntax BROKEN"
    health "$LIVE" && log "backend :4000 healthy" || log "backend :4000 UNHEALTHY"
    for f in /var/www/aykoshop-v2/workspaces.js /var/www/aykoshop-v2/core.js; do
      node --check "$f" && log "  ok: $f" || log "  BROKEN: $f"; done
    exit 0 ;;

  backend)
    CAND="${2:-}"; [ -f "$CAND" ] || { log "ABORT: candidate '$CAND' not found"; exit 10; }
    log "===== BACKEND DEPLOY GATE (candidate=$CAND) ====="
    node --check "$CAND" || { log "ABORT[11]: node --check failed — prod untouched"; exit 11; }
    log "node --check: OK"
    [ -f "$STABLE" ] || { cp -f "$SRV" "$STABLE"; log "initialized server.js.stable"; }

    ORIG="$(grep -E '^PORT=' "$ENVF" | head -1)"; ORIG="${ORIG:-PORT=4000}"; CPID=""
    trap 'sed -i "s/^PORT=.*/$ORIG/" "$ENVF" 2>/dev/null; [ -n "$CPID" ] && kill $CPID 2>/dev/null' EXIT
    sed -i "s/^PORT=.*/PORT=$TPORT/" "$ENVF"
    ( cd "$B" && setsid node "$CAND" >/tmp/candidate.log 2>&1 & echo $! >/tmp/candidate.pid )
    CPID="$(cat /tmp/candidate.pid)"
    if health "$TEST"; then log "candidate healthy on :$TPORT (customers never saw it)"
    else log "ABORT[12]: candidate not healthy on :$TPORT — prod untouched"; tail -5 /tmp/candidate.log | sed 's/^/    /' | tee -a "$LOG"; exit 12; fi
    kill $CPID 2>/dev/null; CPID=""; sed -i "s/^PORT=.*/$ORIG/" "$ENVF"; trap - EXIT

    TS=$(date +%s); cp -f "$SRV" "$B/server.js.pre-deploy-$TS.bak"
    cp -f "$CAND" "$SRV"; log "promoted candidate -> server.js (backup: server.js.pre-deploy-$TS.bak)"
    pm2 restart aykoshop-api --update-env >/dev/null 2>&1
    if health "$LIVE"; then
      cp -f "$SRV" "$STABLE"; log "POST-DEPLOY HEALTH OK -> stable updated. DEPLOY SUCCESS"
      curl -s -m5 -o /dev/null -w '  ingest probe: %{http_code}\n' -X POST http://localhost:4000/api/inbox/ingest -H 'Content-Type: application/json' -d '{}' | tee -a "$LOG"
      exit 0
    else
      log "POST-DEPLOY UNHEALTHY -> AUTO-ROLLBACK to server.js.stable"
      cp -f "$STABLE" "$SRV"; pm2 restart aykoshop-api >/dev/null 2>&1
      health "$LIVE" && log "ROLLBACK OK — prod restored to stable" || log "ROLLBACK health still failing — MANUAL ATTENTION"
      exit 20
    fi ;;

  *) echo "usage: deploy-gate.sh {backend <candidate.js>|frontend <file.js>...|verify}"; exit 1 ;;
esac
