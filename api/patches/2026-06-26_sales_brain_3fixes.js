// ===== SALES BRAIN 3 FIXES — applied to live server.js 2026-06-26 =====
// All 3 fixes proven by E2E tests + smoke 5/5 PASS. node --check verified.
//
// ── FIX-1: Recharge blank prices ──────────────────────────────────────────
// ROOT CAUSE: recharge_packages JSONB stores {diamonds, price_dh, floor_dh}
//   but seller rendered with x.amount / x.price → blank bullets "• = "
// FIX: support both formats (diamonds/price_dh AND legacy amount/price).
//
// BEFORE (_v2Seller recharge block ~line 3212):
//   const _list=_pk.map(function(x){return '• '+(x.amount||'')+' = '+(x.price||'');}).join('\n');
//
// AFTER:
//   const _list=_pk.filter(function(x){return x&&(x.diamonds!=null||x.amount!=null)&&
//     (x.price_dh!=null||x.price!=null);}).map(function(x){var _rd=(x.diamonds!=null?x.diamonds:x.amount);
//     var _rp=(x.price_dh!=null?x.price_dh:x.price);return '• '+_rd+' 💎 = '+_rp+' درهم';}).join('\n');
//
// RESULT: "• 1045 💎 = 115 درهم" ✅ (was "• = " blank)
//
// ── FIX-2: Trust warranty (نصب/خايف/مضمون → 16-day warranty from policy) ─
// ROOT CAUSE: trust signals detected as TRUST_SEEKING personality (hint only)
//   but no deterministic routing + no policy lookup → LLM gave generic reply
// FIX: new routing branch (trust_warranty) + handler reads type_policy table.
//
// NEW routing (before غالي/send_channel check, no state guard):
//   else if(/نصب|خايف|مضمون|واش مضمون|واش صحيح|ثقة|وخيف|تنصب|تغدر|نصابو|نصابوني/i.test(lu))
//     next='trust_warranty';
//
// NEW handler (after oov_human handler):
//   - reads aykoshop_product_type_policies WHERE type_key=ff_account/ff_recharge/ff_code
//   - builds reply with real warranty_days, remedy, refund_allowed
//   - static fallback: "ضمان 16 يوم + official numbers"
//   - stage='sales', agent='Seller (ضمان)'
//
// RESULT: «واش مضمون» → «✅ ضمان 16 يوم — كنبدلو نفس الحساب... +212 632-588578» ✅
//
// ── FIX-3: «غالي» objection → floor/value reframe ─────────────────────────
// ROOT CAUSE: «غالي|ghali» included in send_channel regex → customer sent
//   to channel instead of getting cheaper option offered
// FIX: new routing branch (price_objection) before غالي/send_channel.
//   Captures: «غالي» alone, «غالي بزاف», «غالي عليا», «الثمن غالي» etc.
//
// NEW routing (no state guard):
//   else if(/^(غالي|غالية|ghali)[.!؟\s]*$|غالي بزاف|بزاف غالي|غالي عليا|
//     غالية عليا|كثير عليا|الثمن غالي|السعر غالي/i.test(lu.trim()))
//     next='price_objection';
//
// NEW handler:
//   - queries cheapest product of current service/game type
//   - offers floor: «أرخص حساب Free Fire عندنا: 800 درهم...»
//   - asks for budget if no specific floor available
//   - stage='sales', agent='Seller (ثمن)'
//
// RESULT: «غالي بزاف» → floor offer or budget ask ✅ (was channel redirect)
//
// ── DEPLOYMENT ────────────────────────────────────────────────────────────
// Applied via: patch_sales_brain_fixes.py + patch_state_fix.py
// Verified: node --check + pm2 restart online + smoke 5/5 PASS + E2E 4/4 PASS
// Backup: server.js.bak-2026-06-26-fixes + server.js.bak-2026-06-26-statefix
// Revert: pm2 stop aykoshop-api; cp /var/www/backend/server.js.bak-2026-06-26-fixes
//         /var/www/backend/server.js; pm2 start aykoshop-api
// ===== END SALES BRAIN 3 FIXES =====
