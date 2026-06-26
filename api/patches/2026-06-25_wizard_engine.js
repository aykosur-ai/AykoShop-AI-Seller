// ===== PURCHASE WIZARD engine (deterministic money rails, ZERO-LLM) — test-first, no customer wiring yet =====
// Resolve a product -> inherited Type-Contract + price + packages + allowed payment accounts (all from DB).
// _wizSim walks the full money flow with scripted inputs (test harness). Real order INSERT stays DRY here
// (committed:false) — never auto-delivers, never shows a needs_confirmation account field. Inserted before /api/settings.
async function _wizResolve(productId){
  const pr=await pool.query('SELECT * FROM aykoshop_products WHERE id=$1',[productId]);
  if(!pr.rows.length) return {ok:false, error:'product_not_found'};
  const p=pr.rows[0]; const pt=String(p.product_type||'').toLowerCase(); const gm=p.game||'';
  const tp=await pool.query('SELECT * FROM aykoshop_product_type_policies');
  const ms=function(x){ return String(x.match_product_type||'').toLowerCase()===pt; };
  let pol=tp.rows.find(function(x){return ms(x)&&(x.match_game||'')===gm;}) || tp.rows.find(function(x){return ms(x)&&!x.match_game;}) || null;
  let packages=[]; try{ packages=Array.isArray(p.recharge_packages)?p.recharge_packages:JSON.parse(p.recharge_packages||'[]'); }catch(e){ packages=[]; }
  const allowed=(pol&&Array.isArray(pol.allowed_payment_methods))?pol.allowed_payment_methods.map(function(s){return String(s).toLowerCase();}):['all'];
  const pa=await pool.query("SELECT method_key,display_name,holder_name,fields,currency FROM aykoshop_payment_accounts WHERE active=true ORDER BY sort_order,id");
  const accounts=pa.rows.filter(function(a){ return allowed.indexOf('all')>=0 || allowed.indexOf(String(a.display_name||'').toLowerCase())>=0 || allowed.indexOf(String(a.method_key).toLowerCase())>=0; });
  return {ok:true, product:{id:p.id,name:p.product_name,product_type:p.product_type,game:p.game,price:p.price,price_value:p.price_value,min_price:p.min_price,stock:p.stock}, policy:pol, packages:packages, payment_accounts:accounts};
}
function _wizPrice(p,pkg){ if(pkg&&pkg.price_dh!=null) return Number(pkg.price_dh); if(p.price_value!=null&&p.price_value!=='') return Number(p.price_value); const m=String(p.price||'').match(/[0-9]+(\.[0-9]+)?/); return m?Number(m[0]):null; }
function _wizFloor(p,pkg){ if(pkg){ return pkg.floor_dh!=null?Number(pkg.floor_dh):null; } return p.min_price!=null?Number(p.min_price):null; }
async function _wizSim(opts){
  opts=opts||{}; const r=await _wizResolve(opts.product_id); if(!r.ok) return r;
  const p=r.product, pol=r.policy, steps=[];
  let pkg=null;
  if(r.packages&&r.packages.length){ pkg=r.packages.find(function(x){return String(x.diamonds)===String(opts.package_diamonds);})||r.packages[0]; steps.push({step:'package', chosen:pkg, options:r.packages.length}); }
  const price=_wizPrice(p,pkg), floor=_wizFloor(p,pkg);
  const label=pkg?(p.name+' — '+pkg.diamonds+' 💎'):p.name;
  if(price==null) return {ok:false, error:'no_price_resolved', note:'product/package has no price in DB'};
  steps.push({step:'confirm', label:label, price_dh:price, floor_dh:floor, message:'المنتج: '+label+' · الثمن: '+price+' درهم. واش نكمّل؟'});
  const reqs=(pol&&Array.isArray(pol.buyer_requirements))?pol.buyer_requirements:[];
  if(reqs.length) steps.push({step:'collect', requirements:reqs, message:'باش نكمّل خاصني: '+reqs.map(function(x){return x.label;}).join(' · ')});
  const acct=r.payment_accounts.find(function(a){return String(a.method_key)===String(opts.payment_method);})||r.payment_accounts[0];
  if(!acct) return {ok:false, error:'no_active_payment_account'};
  let flds=[]; try{ flds=Array.isArray(acct.fields)?acct.fields:JSON.parse(acct.fields||'[]'); }catch(e){ flds=[]; }
  const okFlds=flds.filter(function(f){return f.status!=='needs_confirmation';});
  steps.push({step:'payment', method:acct.display_name, holder:acct.holder_name||null, account_lines:okFlds.map(function(f){return f.label+': '+f.value;}), hidden_unconfirmed:flds.length-okFlds.length,
    message:'خلّص '+price+' درهم عبر '+acct.display_name+(acct.holder_name?(' ('+acct.holder_name+')'):'')+':\n'+okFlds.map(function(f){return '• '+f.label+': '+f.value;}).join('\n')+'\nمن بعد صيفط ليا سكرين التحويل 📸'});
  if(!opts.screenshot_url){ steps.push({step:'await_screenshot', message:'كنتسناو سكرين الدفع 📸'}); return {ok:true, status:'awaiting_payment', steps:steps}; }
  steps.push({step:'verify', requires_manual:true, message:'توصلنا بالسكرين، كنأكدو الدفع قبل التسليم...'});
  const idem='sim:'+p.id+':'+(opts.subscriber_id||'test')+':'+opts.screenshot_url;
  steps.push({step:'order', committed:false, idempotency_key:idem, price_centimes:Math.round(price*100), product_id:p.id, message:'طلب جاهز للتأكيد: '+label+' بـ'+price+' درهم. (DRY — ما تكتب حتى يتأكد الدفع)'});
  steps.push({step:'deliver', predelivery_script:(pol&&pol.predelivery_script)||'', message:(pol&&pol.delivery_message)||((pol&&pol.predelivery_script)||'سيتم التسليم بعد تأكيد الدفع.')});
  return {ok:true, status:'ready_after_payment_verify', warranty_days:(pol&&pol.warranty_days)||null, remedy:(pol&&pol.remedy)||null, steps:steps};
}
app.get('/api/wizard/resolve/:id', async (req,res)=>{ try{ res.json(await _wizResolve(parseInt(req.params.id,10))); }catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/wizard/sim', async (req,res)=>{ try{ res.json(await _wizSim(req.body||{})); }catch(e){ res.status(500).json({error:e.message}); } });
// ===== END Purchase Wizard engine =====
