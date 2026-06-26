// ===== Wizard monitoring + test tab (System «🧪 Wizard») — injected into live workspaces.js 2026-06-25 =====
// Live KPIs from /api/wizard/stats + a Test-Wizard simulator (zero customer impact). Reuses helpers.
var _wizScope='all';
async function sysWizard(){
  var d=await api('/api/wizard/stats?scope='+_wizScope)||{};
  var kpi=function(ic,l,v,a){ return '<div class="kpi a-'+(a||'')+'" style="cursor:default"><div class="top"><div class="ic">'+icon(ic)+'</div><div class="lbl">'+l+'</div></div><div class="val num">'+v+'</div></div>'; };
  var funnelRows=(d.funnel||[]).map(function(f,i){ var w=Math.max(4,Math.min(100,f.pct_of_prev||0)); return '<div style="margin-bottom:10px"><div class="row between" style="font-size:13px"><span>'+esc(f.stage)+'</span><b class="num">'+f.n+(i>0?' <span class="dim" style="font-size:11px">('+f.pct_of_prev+'%)</span>':'')+'</b></div><div style="height:10px;background:var(--border);border-radius:5px;overflow:hidden;margin-top:4px"><div style="height:100%;width:'+w+'%;background:var(--ok,#2ecc71)"></div></div></div>'; }).join('');
  var dropRows=(d.dropoff||[]).map(function(x){ var dc=x.dropped>0?'var(--warn,#e0a800)':'var(--muted)'; return '<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--border);font-size:13px"><span>'+esc(x.step)+'</span><span class="dim">وصل <b class="num" style="color:var(--text,#fff)">'+x.reached+'</b> · توقف <b class="num" style="color:'+dc+'">'+x.dropped+'</b></span></div>'; }).join('');
  var errMap={payment_verify_failed:'فشل التحقق من الدفع',order_failed:'فشل إنشاء الطلب',missing_policy:'سياسة ناقصة',missing_payment_account:'حساب دفع ناقص',runtime_error:'خطأ تشغيل'};
  var errRows=((d.errors||[]).length)?(d.errors).map(function(e){ return '<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--border);font-size:13px"><span>🔴 '+esc(errMap[e.reason]||e.reason)+'</span><b class="num">'+e.n+'</b></div>'; }).join(''):'<div class="dim" style="padding:10px">لا أخطاء ✓</div>';
  var totErr=(d.errors||[]).reduce(function(a,b){return a+b.n;},0);
  var sb=function(k,l){ return '<div class="tab '+(_wizScope===k?'active':'')+'" onclick="_wizScope=\''+k+'\';sysWizard()" style="font-size:12px">'+l+'</div>'; };
  fill('#sys-body',
   '<div class="row between" style="margin-bottom:14px;flex-wrap:wrap;gap:10px"><div class="tabs" style="margin:0">'+sb('all','الكل')+sb('real','حقيقي')+sb('test','اختبار')+'</div>'+
     '<button class="btn primary" onclick="wizTestOpen()">🧪 اختبار الـWizard</button></div>'+
   '<div class="kpis" style="margin-bottom:18px">'+kpi('cart','Wizard Started اليوم',d.started||0,'ok')+kpi('check','اكتملت بنجاح',d.completed||0,'ok')+kpi('alert','أخطاء اليوم',totErr,totErr?'bad':'ok')+'</div>'+
   '<div class="split"><div class="panel"><div class="panel-h">💰<h2>قمع التحويل</h2></div><div class="panel-b">'+(funnelRows||'<div class="dim">لا بيانات لليوم — شغّل اختبار.</div>')+'</div></div>'+
     '<div style="display:flex;flex-direction:column;gap:18px">'+
       '<div class="panel"><div class="panel-h">🟡<h2>التوقف حسب الخطوة</h2></div><div class="panel-b">'+(dropRows||'<div class="dim">لا بيانات</div>')+'</div></div>'+
       '<div class="panel"><div class="panel-h">🔴<h2>الأخطاء</h2></div><div class="panel-b">'+errRows+'</div></div>'+
     '</div></div>'+
   '<div id="wiz-test-out" style="margin-top:16px"></div>');
}
async function wizTestOpen(){
  var prods=await api('/api/products')||[]; var pa=await api('/api/payment-accounts'); var accs=(pa&&pa.accounts)||[];
  openModal('<div class="modal-h"><span>🧪 اختبار الـWizard — محاكاة (بلا أي زبون حقيقي)</span><button class="iconbtn" onclick="closeModal()">'+icon('x')+'</button></div>'+
   '<div class="modal-b"><label class="lbl-f">المنتج</label><select class="inp" id="wt-prod" style="margin-bottom:10px">'+prods.map(function(p){return '<option value="'+p.id+'">'+esc(p.product_name)+' (#'+p.id+')</option>';}).join('')+'</select>'+
   '<label class="lbl-f">باقة الشحن (diamonds — للشحن فقط)</label><input class="inp" id="wt-pkg" placeholder="مثلا 1045" style="margin-bottom:10px">'+
   '<label class="lbl-f">وسيلة الدفع</label><select class="inp" id="wt-pay" style="margin-bottom:10px">'+accs.map(function(a){return '<option value="'+esc(a.method_key)+'">'+esc(a.display_name)+'</option>';}).join('')+'</select>'+
   '<label class="row gap8" style="cursor:pointer;user-select:none"><input type="checkbox" id="wt-ss" checked> أرسل سكرين الدفع (فلو كامل ناجح — حيّدها باش تختبر التوقف فالدفع)</label></div>'+
   '<div class="modal-f"><button class="btn ghost" onclick="closeModal()">إلغاء</button><button class="btn primary" onclick="wizTestRun()">🚀 شغّل المحاكاة</button></div>','wide');
}
async function wizTestRun(){
  var gv=function(id){ var e=document.getElementById(id); return e?e.value:''; };
  var body={product_id:parseInt(gv('wt-prod')||'0',10), payment_method:gv('wt-pay'), log:true};
  var pk=gv('wt-pkg'); if(pk&&pk.trim())body.package_diamonds=pk.trim();
  var ss=document.getElementById('wt-ss'); if(ss&&ss.checked) body.screenshot_url='test://screenshot.jpg';
  var r=await send('/api/wizard/sim','POST',body); closeModal();
  await sysWizard();
  var out=document.getElementById('wiz-test-out'); if(!out) return;
  if(r&&r.ok){ out.innerHTML='<div class="panel"><div class="panel-h">🧪<h2>نتيجة المحاكاة — '+esc(r.status||'')+(r.warranty_days?(' · ضمان '+r.warranty_days+' يوم'):'')+'</h2></div><div class="panel-b">'+
    (r.steps||[]).map(function(s){return '<div style="padding:8px 0;border-bottom:1px solid var(--border)"><b style="font-size:12px;color:var(--acc,#4ea1ff)">'+esc(s.step)+'</b><div class="dim" style="font-size:12px;white-space:pre-wrap;margin-top:3px">'+esc(s.message||JSON.stringify(s))+'</div></div>';}).join('')+'</div></div>';
    toast('المحاكاة تمت ✓ — الأرقام تحدّثت'); }
  else { out.innerHTML='<div class="panel"><div class="panel-b"><b style="color:var(--bad,#e74c3c)">المحاكاة: خطأ — '+esc((r&&r.error)||'فشل')+'</b></div></div>'; toast('المحاكاة: خطأ','bad'); }
}
// ===== END Wizard monitor UI =====
