/* ============================================================
   AykoShop v2 — core: auth · api · sse · icons · router · drawer · search · modal
   ============================================================ */
const API=''; // same-origin: served behind nginx (HTTPS aykoshoop.duckdns.org + :3002), proxied to backend :4000
const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];

/* ---------- auth ---------- */
let TOKEN=localStorage.getItem('ayko_v2_token')||'';
function authHeaders(extra){ const h=Object.assign({},extra||{}); if(TOKEN)h['Authorization']='Bearer '+TOKEN; return h; }
async function doLogin(){
  const pass=$('#login-pass').value, btn=$('#login-btn'); btn.disabled=true; $('#login-err').textContent='';
  try{
    const r=await fetch(API+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pass})});
    if(r.ok){ const d=await r.json(); TOKEN=d.token||d.access_token||''; localStorage.setItem('ayko_v2_token',TOKEN);
      $('#login-gate').classList.remove('show'); initApp(); }
    else { $('#login-err').textContent='كلمة المرور غير صحيحة'; btn.disabled=false; }
  }catch(e){ $('#login-err').textContent='تعذّر الاتصال بالخادم'; btn.disabled=false; }
}
function logout(){ if(!confirm('تسجيل الخروج؟'))return; TOKEN=''; localStorage.removeItem('ayko_v2_token'); if(_es)_es.close(); $('#login-gate').classList.add('show'); setTimeout(()=>$('#login-pass').focus(),80); }

/* ---------- fetch (token-aware) ---------- */
async function api(p,opt){ opt=opt||{}; opt.headers=authHeaders(opt.headers);
  try{const r=await fetch(API+p,opt); if(r.status===401){logout();return null;} if(!r.ok)return null; return await r.json();}catch(e){return null;} }
async function send(p,method,body){
  try{const r=await fetch(API+p,{method,headers:authHeaders({'Content-Type':'application/json'}),body:body?JSON.stringify(body):undefined});
    if(r.status===401){logout();return null;} return r.ok?(await r.json().catch(()=>({ok:1})))||{ok:1}:null;}catch(e){return null;} }

/* ---------- light cache ---------- */
const _cache={};
async function cached(key,fetcher,ttl){ ttl=ttl||15000; const c=_cache[key]; if(c&&Date.now()-c.t<ttl)return c.v; const v=await fetcher(); _cache[key]={t:Date.now(),v}; return v; }
function bust(k){ if(k)delete _cache[k]; else for(const x in _cache)delete _cache[x]; }
async function getOrder(id){ const o=await cached('orders',()=>api('/api/orders?limit=200')); return (o||[]).find(x=>String(x.id)===String(id)); }

/* ---------- helpers ---------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function money(n){n=parseInt(n||0);return n.toLocaleString('en-US');}
function priceNum(s){return parseInt(String(s||'').replace(/[^0-9]/g,''))||0;}
function initials(n){n=(n||'؟').trim();return n?n.slice(0,2):'؟';}
function timeAgo(ts){ if(!ts)return''; const d=(Date.now()-new Date(ts).getTime())/1000;
  if(d<60)return'الآن'; if(d<3600)return Math.floor(d/60)+' د'; if(d<86400)return Math.floor(d/3600)+' س';
  if(d<604800)return Math.floor(d/86400)+' ي'; return new Date(ts).toLocaleDateString('en-GB'); }
function dt(ts){ return ts?new Date(ts).toLocaleString('en-GB',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—'; }
function chanChip(c){ if(!c)return''; const m={instagram:'info',whatsapp:'ok',messenger:'acc',facebook:'acc'}; return `<span class="chip ${m[c]||'gray'}">${esc(c)}</span>`; }
function stageChip(s){ const m={paid:'ok',delivered:'ok',hot:'bad',interested:'warn',new:'gray',browsing:'gray',lost:'gray'}; return s?`<span class="chip ${m[s]||'gray'}">${esc(s)}</span>`:''; }

/* ---------- icons ---------- */
const ICONS={
  home:'M3 10.5 12 3l9 7.5M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5',
  inbox:'M21 14H3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5M21 14l-2.6-8.4A2 2 0 0 0 16.5 4h-9a2 2 0 0 0-1.9 1.6L3 14M8 14a4 4 0 0 0 8 0',
  dollar:'M12 2v20M17 5.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  package:'M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7 12 12l8.7-5M12 22V12',
  sliders:'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  menu:'M3 12h18M3 6h18M3 18h18',
  search:'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  bell:'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  user:'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  x:'M18 6 6 18M6 6l12 12',
  check:'M20 6 9 17l-5-5',
  truck:'M1 3h13v13H1zM14 8h4l3 3v5h-7V8M5.5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18.5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  alert:'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  zap:'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  trend:'M23 6 13.5 15.5 8.5 10.5 1 18M17 6h6v6',
  activity:'M22 12h-4l-3 9L9 3l-3 9H2',
  spark:'M12 2.5l2.3 6.9 6.9 2.3-6.9 2.3L12 21l-2.3-6.9L2.8 11.7l6.9-2.3L12 2.5z',
  spark2:'M12 2.5l2.3 6.9 6.9 2.3-6.9 2.3L12 21l-2.3-6.9L2.8 11.7l6.9-2.3L12 2.5z',
  ext:'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  refresh:'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  card:'M2 6h20v12H2zM2 10h20',
  msg:'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  send:'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  fire:'M12 2s4 4 4 8a4 4 0 0 1-8 0c0-1 .5-2 .5-2S6 11 6 14a6 6 0 0 0 12 0c0-5-6-12-6-12z',
  clock:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  cart:'M9 22a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM20 22a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6',
  chart:'M3 3v18h18M18 9l-5 5-3-3-4 4',
  heart:'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z',
  cpu:'M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM9 9h6v6H9z',
  power:'M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0',
  back:'M15 18l-6-6 6-6',
  eye:'M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  edit:'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  layers:'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  trash:'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6',
  logout:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'
};
function icon(name,cls){ const p=ICONS[name]||ICONS.home; return `<svg class="${cls||''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${p}"/></svg>`; }
function paintIcons(root){ (root||document).querySelectorAll('[data-ic]').forEach(e=>{e.innerHTML=icon(e.dataset.ic);e.removeAttribute('data-ic');}); }

/* ---------- toast ---------- */
function toast(msg,kind){ const t=document.createElement('div'); t.className='toast '+(kind||'ok');
  t.innerHTML=`<span class="ti">${icon(kind==='bad'?'x':'check')}</span> ${esc(msg)}`;
  $('#toasts').appendChild(t); setTimeout(()=>{t.style.opacity=0;setTimeout(()=>t.remove(),250);},2600); }

/* ---------- router ---------- */
/* Alias map: old route → which nav-item to highlight in the new sidebar */
const _NAV_ALIAS={cockpit:'analytics',sales:'orders',recovery:'hermes',ai:'system'};
/* Routes that live under the More menu (not primary nav items) */
const _MORE_ROUTES=new Set(['system']);
function setActiveNav(r){
  const display=_NAV_ALIAS[r]||r;
  $$('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.route===display));
  /* If the active route is inside More, highlight the More toggle button */
  const moreBtn=$('#nav-more-btn');
  if(moreBtn){
    if(_MORE_ROUTES.has(display)){
      moreBtn.classList.add('active');
      /* Keep sub-item highlighted too */
      $$('.nav-sub-item').forEach(n=>n.classList.toggle('active',n.dataset.route===display));
    } else {
      moreBtn.classList.remove('active');
      $$('.nav-sub-item').forEach(n=>n.classList.remove('active'));
    }
  }
}
function go(){ const r=(location.hash.replace('#/','')||'inbox'); setActiveNav(r); document.body.classList.remove('side-open'); window.scrollTo(0,0);
  (window.ROUTES&&window.ROUTES[r]||window.ROUTES.inbox)(); paintIcons($('#view')); }
window.addEventListener('hashchange',go);
function toggleSidebar(){ document.body.classList.toggle('side-open'); }
/* More menu: expand/collapse; pass false to force-close */
function toggleMoreMenu(forceState){
  const m=$('#nav-more-menu'); if(!m)return;
  const open=forceState===false?false:(forceState===true?true:(m.style.display==='none'));
  m.style.display=open?'block':'none';
  const btn=$('#nav-more-btn'); if(btn)btn.classList.toggle('more-open',open);
  if(open)paintIcons(m);
}

/* ---------- shared render helpers ---------- */
function phead(title,sub,actions){ return `<div class="phead"><div class="pt"><h1>${title}</h1>${sub?`<div class="sub">${sub}</div>`:''}</div>${actions?`<div class="pa">${actions}</div>`:''}</div>`; }
function empty(ic,title,desc){ return `<div class="empty"><div class="ei">${icon(ic)}</div><h3>${title}</h3>${desc?`<p>${desc}</p>`:''}</div>`; }
function skel(){ return `<div class="skel">${icon('refresh','spin')} جاري التحميل…</div>`; }
function custLink(name,sid){ return `<span class="cust-link" onclick="openCustomer('${sid}')">${esc(name||sid)}</span>`; }

/* ---------- modal ---------- */
function openModal(html, modalCls){ $('#modal-mount').innerHTML=`<div class="modal-scrim" onclick="if(event.target===this)closeModal()"><div class="modal ${modalCls||''}">${html}</div></div>`; paintIcons($('#modal-mount')); }
function closeModal(){ $('#modal-mount').innerHTML=''; }
/* safe payment confirm — screenshot preview + delayed-commit undo (confirm-payment is irreversible server-side) */
async function confirmPay(id){ const o=await getOrder(id)||{id}; openPayModal(o); }
function openPayModal(o){
  const shot=o.payment_screenshot;
  openModal(`<div class="modal-h"><span>تأكيد الدفع — طلب <span class="num">#${o.id}</span></span><button class="iconbtn" onclick="closeModal()">${icon('x')}</button></div>
    <div class="modal-b">
      <div class="row between mb16"><span class="muted">${esc(o.customer_name||'زبون')} ${chanChip(o.channel)}</span><b class="num" style="font-size:18px">${money(priceNum(o.price))} DH</b></div>
      <div class="dim" style="font-size:12.5px">${esc(o.product_name||'')}</div>
      <div class="dr-sec">إثبات التحويل</div>
      ${shot?`<a href="${esc(shot)}" target="_blank"><img class="pay-shot" src="${esc(shot)}" onerror="this.parentNode.innerHTML='<div class=&quot;dim&quot;>تعذّر تحميل الصورة — افتح الرابط يدويًا</div>'"></a>`
        :`<div class="row gap8" style="color:var(--warn);font-size:13px">${icon('alert')} لا توجد صورة إثبات — تأكّد من التحويل يدويًا قبل التأكيد.</div>`}
    </div>
    <div class="modal-f"><button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn ok" onclick="commitPay(${o.id})">${icon('check')} تأكيد وتسجيل الإيراد</button></div>`);
}
function commitPay(id){ closeModal(); delayedCommit('/api/orders/'+id+'/confirm-payment','جاري تأكيد الدفع…','تم تأكيد الدفع — سُجّل الإيراد ✓'); }
function delayedCommit(path,pending,okMsg){
  const t=document.createElement('div'); t.className='toast';
  t.innerHTML=`<span class="ti">${icon('clock')}</span> ${esc(pending)} <button class="btn ghost undo-btn">تراجع</button>`;
  $('#toasts').appendChild(t); paintIcons(t);
  const timer=setTimeout(async()=>{ t.remove(); const r=await send(path,'PATCH',{}); if(r){bust('orders');toast(okMsg);go();}else toast('فشل العملية','bad'); },5000);
  t.querySelector('.undo-btn').onclick=()=>{ clearTimeout(timer); t.remove(); toast('تم التراجع'); };
}

/* ============================================================ Customer 360 drawer */
let _drawerSid=null,_drawerTab='overview';
async function openCustomer(sid,tab){ _drawerSid=sid; _drawerTab=tab||'overview'; document.body.classList.remove('side-open');
  $('#scrim').classList.add('open'); const d=$('#drawer'); d.classList.add('open'); d.innerHTML=`<div class="dr-body">${skel()}</div>`; paintIcons(d);
  const [p360,ctx,ais,intel]=await Promise.all([api('/api/customers/'+sid+'/profile360'),api('/hermes/context/customer/'+sid),api('/api/customers/'+sid+'/ai-status'),api('/api/customers/'+sid+'/intelligence')]);
  if(!p360||!p360.profile){ d.innerHTML=`<div class="dr-body">${empty('user','تعذّر تحميل الزبون')}</div>`; paintIcons(d); return; }
  window._cust={p:p360.profile,orders:p360.orders||[],ctx,sid,journey:null,chat:null,intel:intel&&!intel.error?intel:null,aiStopped:!!(ais&&ais.ai_stopped),stoppedSince:ais&&ais.stopped_since}; renderDrawer();
}
function renderDrawer(){
  const {p,orders,ctx}=window._cust; const recs=(ctx&&ctx.recommendations)||[];
  const tabs=[['overview','نظرة'],['orders','الطلبات ('+orders.length+')'],['journey','الرحلة'],['chat','المحادثة']];
  $('#drawer').innerHTML=`
   <div class="dr-head"><div class="dr-av">${esc(initials(p.customer_name))}</div>
     <div style="flex:1"><div class="nm">${esc(p.customer_name||'زبون')}</div>
       <div class="mt">${chanChip(p.channel)} ${stageChip(p.stage)} ${aiStatusChip(window._cust.aiStopped)} <span class="dim num">#${esc(p.subscriber_id)}</span></div></div>
     <button class="iconbtn dr-close" onclick="closeDrawer()">${icon('x')}</button></div>
   <div class="dr-body">
     <div class="dr-stats">
       <div class="dr-stat"><div class="v num">${money(p.lifetime_value)} <small>DH</small></div><div class="l">القيمة الدائمة</div></div>
       <div class="dr-stat"><div class="v num">${orders.length}</div><div class="l">الطلبات</div></div>
       <div class="dr-stat"><div class="v num">${p.total_messages||0}</div><div class="l">الرسائل</div></div>
       <div class="dr-stat"><div class="v">${timeAgo(p.last_seen)||'—'}</div><div class="l">آخر ظهور</div></div></div>
     ${window._cust.intel?(()=>{const x=window._cust.intel;return `<div class="intel-card">
       <div class="row between"><div class="row gap8" style="min-width:0"><span class="intel-emoji">${x.emoji}</span><div style="min-width:0"><div class="ft">احتمال الشراء ${x.probability}% · ${esc(x.label)}</div><div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.reason)}</div></div></div>${x.recovery_score?`<span class="chip warn" title="نقاط الاسترجاع">↺ ${x.recovery_score}</span>`:''}</div>
       <div class="prob-bar"><span style="width:${x.probability}%"></span></div>
       <div class="intel-sum">${icon('spark2')} ${esc(x.summary)}</div>
       <div class="intel-act">${icon('check')} <b>${esc(x.recommended_action)}</b></div></div>`;})():''}
     ${recs.length?`<div class="dr-sec">${icon('spark')} توصيات Hermes</div>${recs.map(r=>`
        <div class="hcard p-${r.priority}" style="margin-bottom:9px"><div class="hi">${r.icon||'•'}</div>
          <div class="hbody"><div class="htitle">${esc(r.title)}</div><div class="hreason">${esc(r.reason||'')}</div></div></div>`).join('')}`:''}
     <div class="tabs" style="margin:16px 0 14px">${tabs.map(t=>`<div class="tab ${t[0]===_drawerTab?'active':''}" onclick="_drawerTab='${t[0]}';renderDrawer()">${t[1]}</div>`).join('')}</div>
     <div id="dr-tab">${skel()}</div></div>`;
  paintIcons($('#drawer')); renderDrawerTab();
}
async function renderDrawerTab(){
  const {p,orders,sid}=window._cust; const s=p.session_data||{}; const box=$('#dr-tab');
  if(_drawerTab==='overview'){
    const stages=[...new Set(['new','browsing','interested','warm','hot','paid','lost'].concat(p.stage?[p.stage]:[]))];
    box.innerHTML=`<div class="dr-sec">إدارة (CRM)</div>
      <label class="lbl-f">المرحلة</label><select class="inp" id="cr-stage" style="margin-bottom:10px">${stages.map(st=>`<option value="${esc(st)}" ${p.stage===st?'selected':''}>${esc(st)}</option>`).join('')}</select>
      <label class="lbl-f">الوسوم (مفصولة بفاصلة)</label><input class="inp" id="cr-tags" value="${esc(p.tags||'')}" placeholder="VIP, مهم, متابعة" style="margin-bottom:10px">
      <label class="lbl-f">ملاحظات داخلية</label><textarea class="ta" id="cr-notes" rows="3" placeholder="ملاحظات عن الزبون…" style="margin-bottom:10px">${esc(p.notes||'')}</textarea>
      <button class="btn primary sm" onclick="saveCustomerCRM('${p.subscriber_id}')">${icon('check')} حفظ</button>
      <div class="dr-sec">معلومات</div>
      ${kv('مهتم بـ',p.interested_in||'—')}${kv('الميزانية',(s.last_budget?s.last_budget+' DH':(p.budget||'—')))}${kv('آخر منتج',s.last_product_name||'—')}${kv('مرات الرفض',s.rejection_count||0)}${kv('انضم',dt(p.created_at))}`;
  } else if(_drawerTab==='orders'){
    box.innerHTML=orders.length?orders.map(orderRow360).join(''):empty('cart','لا طلبات');
  } else if(_drawerTab==='journey'){
    box.innerHTML=skel(); const j=window._cust.journey||await api('/api/customers/'+sid+'/journey'); window._cust.journey=j; const ev=(j&&j.events)||[];
    box.innerHTML=ev.length?`<div class="tline">${ev.map(e=>`<div class="tev"><div class="tt">${esc(e.label||e.type||'')}</div><div class="td">${esc(e.detail||'')}${e.detail?' · ':''}${dt(e.ts)}</div></div>`).join('')}</div>`:empty('activity','لا أحداث');
  } else if(_drawerTab==='chat'){
    box.innerHTML=skel(); const h=window._cust.chat||await api('/api/chat-history/'+sid); window._cust.chat=h; const msgs=(h||[]).slice().reverse().slice(-40);
    const stopped=window._cust.aiStopped;
    box.innerHTML=`<div class="row between" style="margin-bottom:10px;gap:8px">
      <div class="row gap8">${aiStatusChip(stopped)}${stopped&&window._cust.stoppedSince?`<span class="dim" style="font-size:11.5px">منذ ${timeAgo(window._cust.stoppedSince)}</span>`:''}</div>
      ${stopped?`<button class="btn ok sm" onclick="resumeAI('${sid}')">${icon('spark2')} إرجاع للذكاء</button>`:`<button class="btn sm" onclick="takeOver('${sid}')">${icon('user')} استلام المحادثة</button>`}</div>
      <div id="chatbox" style="max-height:42vh;overflow-y:auto">${(window._chatMsgs=msgs,msgs.length)?msgs.map((m,i)=>{/* role-default-fix 2026-07-02 */ const role=m.role==='assistant'?'ai':(m.role==='operator'?'operator':'user');const tag=m.role==='operator'?'<span class="bmeta">👤 مشغّل</span>':(role==='ai'?'<span class="bmeta">🤖 ذكاء</span>':'');const fix=role==='ai'?` <button class="iconbtn" style="opacity:.65;font-size:12px;padding:0 4px" title="صحّح وعلّم الذكاء" onclick="event.stopPropagation();fixAiReply('${sid}',${i})">✏️</button>`:'';return `<div class="bubble ${role}">${tag}${esc(m.message)}${fix}<div class="bt">${dt(m.created_at)}</div></div>`;}).join(''):empty('msg','لا رسائل')}</div>
      <div class="dr-reply"><textarea class="ta" id="reply-txt" rows="1" placeholder="رد (سيُفعّل التدخّل البشري)… Enter للإرسال" style="min-height:40px" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendReply('${sid}')}"></textarea>
      <button class="btn ghost" onclick="suggestReply('${sid}')" title="اقتراح Hermes (ردّ ذكي)">${icon('spark2')}</button>
      <button class="btn ghost" onclick="openMacros('${sid}')" title="ردود جاهزة">${icon('msg')}</button>
      <button class="btn primary" onclick="sendReply('${sid}')">${icon('send')}</button></div>`;
    const cb=$('#chatbox'); if(cb)cb.scrollTop=cb.scrollHeight;
  }
  paintIcons(box);
}
function kv(k,v){ return `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--border)"><span class="muted" style="font-size:12.5px">${k}</span><span style="font-size:13px;font-weight:600">${esc(v)}</span></div>`; }
async function saveCustomerCRM(sid){ const g=x=>{const e=$('#'+x);return e?e.value:'';};
  const r=await send('/api/customers/'+sid,'PATCH',{stage:g('cr-stage'),tags:g('cr-tags'),notes:g('cr-notes')});
  if(r){ toast('تم حفظ بيانات الزبون ✓'); if(window._cust&&window._cust.p){window._cust.p.stage=r.stage;window._cust.p.tags=r.tags;window._cust.p.notes=r.notes;} bust('customers'); }
  else toast('فشل الحفظ','bad'); }
function orderRow360(o){ const paid=o.paid_at,del=o.delivered_at;
  return `<div class="panel" style="padding:13px;margin-bottom:10px"><div class="row between"><div><b class="num">#${o.id}</b> · ${esc(o.product_name||'منتج')}</div><b class="num">${money(priceNum(o.price))} DH</b></div>
    <div class="row between mt8"><div>${stageChip(o.status)} <span class="dim" style="font-size:11.5px">${dt(o.created_at)}</span></div>
    <div class="actions">${!paid?`<button class="btn ok sm" onclick="confirmPay(${o.id})">${icon('check')} تأكيد الدفع</button>`:(!del?`<button class="btn sm" onclick="deliverOrder(${o.id})">${icon('truck')} تسليم</button>`:`<span class="chip ok">${icon('check')} مكتمل</span>`)}</div></div></div>`; }
async function sendReply(sid){ if(window._ibxAttach&&window._ibxAttach.file&&typeof ibxSendWithMedia==='function')return ibxSendWithMedia(sid); const t=$('#reply-txt'); if(!t||!t.value.trim())return; const msg=t.value.trim();
  const _opt={role:'operator',message:msg,media_url:null,created_at:new Date().toISOString(),_optimistic:true}; /* canonical optimistic msg so a re-render (AI toggle/classify) NEVER drops it */
  try{ if(window._cust&&String(window._cust.sid)===String(sid)){ if(!Array.isArray(window._cust.chat))window._cust.chat=[]; window._cust.chat.unshift(_opt); if(!Array.isArray(window._chatMsgs))window._chatMsgs=[]; window._chatMsgs.push(_opt); } }catch(_e){}
  const cb=$('#chatbox'); if(cb){cb.insertAdjacentHTML('beforeend',`<div class="bubble operator" data-optimistic="1" style="opacity:.55;margin-left:auto;margin-right:0">${esc(msg)}<div class="bt">يُرسل…</div></div>`);cb.scrollTop=cb.scrollHeight;}
  await send('/api/customers/'+sid+'/takeover','POST',{active:true});
  let r=null,rerr=''; try{ const resp=await fetch('/api/customers/'+sid+'/message',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({message:msg})}); const jr=await resp.json().catch(()=>null); if(resp.ok&&jr&&jr.success!==false)r=jr; else rerr=(typeof _ibxErr==='function')?_ibxErr(jr,resp.status):((jr&&jr.error)||('HTTP '+resp.status)); }catch(e){ rerr=(e&&e.message)||'تعذّر الاتصال'; }
  if(r){ t.value=''; window._cust.aiStopped=true; window._cust.stoppedSince=new Date().toISOString(); bust('customers'); toast('تم الإرسال — الذكاء متوقف لهذا الزبون');
    if(document.getElementById('ibx2-rows')){ /* v2 inbox: update row + status. The message is already in _cust.chat (above) → NO destructive refetch (which could drop a mid-send SSE message); the server version replaces it on the next open. */
      try{ if(typeof _ibxRoster!=='undefined'&&_ibxRoster){ var rw=_ibxRoster.filter(function(x){return String(x.subscriber_id)===String(sid);})[0]; if(rw){rw.ai_stopped=true;rw.last_message=msg;rw.last_seen=new Date().toISOString();rw.last_any_at=rw.last_seen;rw.waiting=false;rw.needs_reply_count=0;} } }catch(_e){}
      try{ if(typeof ibxRenderRows==='function')ibxRenderRows(); if(typeof ibxRenderConv==='function')ibxRenderConv(sid); }catch(_e){} }
    else { window._cust.chat=null; renderDrawer(); }
  } else { try{ if(window._cust&&Array.isArray(window._cust.chat))window._cust.chat=window._cust.chat.filter(function(x){return x!==_opt;}); if(Array.isArray(window._chatMsgs))window._chatMsgs=window._chatMsgs.filter(function(x){return x!==_opt;}); }catch(_e){} const o=cb&&cb.querySelector('[data-optimistic]'); if(o)o.remove(); toast('فشل الإرسال — '+(rerr||'لم تُفقد رسالتك'),'bad'); } }
async function suggestReply(sid){ const t=$('#reply-txt'); const old=t?t.value:''; if(t){t.value='';t.placeholder='Hermes يقترح ردّاً…';}
  const r=await send('/hermes/suggest-reply','POST',{subscriber_id:sid});
  if(r&&r.suggested_reply&&t){ t.value=r.suggested_reply; t.focus(); toast('💡 اقتراح Hermes — راجعه ثم أرسل'); }
  else { if(t){t.value=old;t.placeholder='رد (سيُفعّل التدخّل البشري)… Enter للإرسال';} toast('تعذّر الاقتراح','bad'); } }
/* ---------- Operator: human takeover / resume AI (Hermes Operator UI) ---------- */
function aiStatusChip(stopped){ return stopped?`<span class="chip warn">${icon('user')} تدخّل بشري</span>`:`<span class="chip ok">${icon('spark2')} الذكاء يردّ</span>`; }
async function takeOver(sid){ const r=await send('/api/customers/'+sid+'/takeover','POST',{active:true}); if(r){toast('تم استلام المحادثة — الذكاء متوقف');afterAiToggle(sid,true);}else toast('فشل الاستلام','bad'); }
async function resumeAI(sid){ const r=await send('/api/customers/'+sid+'/takeover','DELETE'); if(r){toast('عاد الذكاء للردّ ✓');afterAiToggle(sid,false);}else toast('فشل الإرجاع','bad'); }
/* Learn-in-context: correct an AI reply right inside the customer conversation (One Customer = One Workspace). */
function fixAiReply(sid,i){ const msgs=window._chatMsgs||[]; const m=msgs[i]; if(!m)return; let cm=''; for(let j=i-1;j>=0;j--){ if(msgs[j].role==='user'){ cm=msgs[j].message||''; break; } }
  window._fixCtx={sid:sid,cm:cm,ar:m.message||''};
  openModal(`<div class="modal-h"><span>✏️ صحّح الرد وعلّم الذكاء</span><button class="iconbtn" onclick="closeModal()">${icon('x')}</button></div>
    <div class="modal-b">${cm?`<div class="dim" style="margin-bottom:8px">الزبون: ${esc(cm)}</div>`:''}
      <label class="lbl-f">الرد المصحَّح</label><textarea class="ta" id="fix-txt" rows="4" style="margin-bottom:10px">${esc(m.message||'')}</textarea>
      <label class="row gap8" style="cursor:pointer;user-select:none"><input type="checkbox" id="fix-send"> صيفط الرد المصحَّح للزبون دابا</label></div>
    <div class="modal-f"><button class="btn ghost" onclick="closeModal()">إلغاء</button><button class="btn primary" onclick="saveFixReply()">${icon('check')} حفظ وتعلّم</button></div>`); }
async function saveFixReply(){ const c=window._fixCtx; if(!c)return; const txt=($('#fix-txt')&&$('#fix-txt').value||'').trim(); if(!txt){toast('اكتب الرد','bad');return;}
  const doSend=$('#fix-send')&&$('#fix-send').checked;
  const r=await send('/api/learning/feedback','POST',{subscriber_id:c.sid,customer_message:c.cm,reply:txt,action:'edit'});
  if(doSend){ const s=await send('/api/customers/'+encodeURIComponent(c.sid)+'/message','POST',{message:txt}); if(s&&(s.success||s.delivered)){toast('تصحّح + تصيفط للزبون ✓'); if(window._cust)window._cust.chat=null; if(typeof renderDrawerTab==='function')renderDrawerTab();} else toast('تعلّم ✓ لكن الإرسال فشل','bad'); }
  else { if(r&&r.ok) toast(r.merged?('تعزَّز السلوك ✓'):'تعلّم من التصحيح ✓'); else toast((r&&r.error)||'فشل','bad'); }
  closeModal(); }
function afterAiToggle(sid,stopped){ sid=String(sid);
  if(window._cust&&String(window._cust.sid)===sid){window._cust.aiStopped=stopped;window._cust.stoppedSince=stopped?new Date().toISOString():null;}
  /* v2 inbox (renderInbox2) live update — patch roster + re-render list + open conversation INSTANTLY, no reload (fixes freeze/unfreeze needing F5) */
  var v2=false;
  try{ if(typeof _ibxRoster!=='undefined'&&_ibxRoster){ var row=_ibxRoster.filter(function(x){return String(x.subscriber_id)===sid;})[0]; if(row){ row.ai_stopped=stopped; if(stopped)row.convo_state='human'; else if(row.convo_state==='human')row.convo_state='sales'; } } }catch(e){}
  try{ if(document.getElementById('ibx2-rows')&&typeof ibxRenderRows==='function'){ v2=true; ibxRenderRows(); if(typeof _ibxSel!=='undefined'&&String(_ibxSel)===sid&&typeof ibxRenderConv==='function')ibxRenderConv(sid); } }catch(e){}
  if(!v2){ if(window._cust&&String(window._cust.sid)===sid&&typeof renderDrawer==='function')renderDrawer(); var rt=(location.hash.replace('#/','')||'').split('/')[0]; if(rt==='inbox'&&typeof loadInbox==='function')loadInbox(); }
  bust('customers'); }
async function deliverOrder(id){ const r=await send('/api/orders/'+id+'/deliver','PATCH',{}); if(r){bust('orders');toast('تم التسليم');refreshDrawerOrders();go();}else toast('فشل','bad'); }
async function refreshDrawerOrders(){ if(!_drawerSid)return; const p=await api('/api/customers/'+_drawerSid+'/profile360'); if(p){window._cust.orders=p.orders||[];window._cust.p=p.profile;renderDrawer();} }
function closeDrawer(){ $('#scrim').classList.remove('open'); $('#drawer').classList.remove('open'); _drawerSid=null; }

/* ---------- macros / saved replies ---------- */
async function openMacros(sid){ const m=await api('/api/macros')||[]; window._macros=m;
  openModal(`<div class="modal-h"><span>الردود الجاهزة (Macros)</span><button class="iconbtn" onclick="closeModal()">${icon('x')}</button></div>
   <div class="modal-b">
     ${m.length? m.map(x=>`<div class="row between" style="padding:9px 0;border-bottom:1px solid var(--border)"><div style="flex:1;min-width:0;${sid?'cursor:pointer':''}" ${sid?`onclick="insertMacro(${x.id})"`:''}><b>${esc(x.title||'(بلا عنوان)')}</b><div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.content||'')}</div></div>${sid?`<button class="btn sm" onclick="insertMacro(${x.id})">إدراج</button>`:''}<button class="btn bad sm" onclick="delMacro(${x.id})">${icon('trash')}</button></div>`).join('') : '<div class="dim">لا ردود جاهزة بعد — أضف أول رد.</div>'}
     <div class="dr-sec">إضافة رد جاهز</div>
     <input class="inp" id="mc-title" placeholder="العنوان (اختياري)" style="margin-bottom:8px">
     <textarea class="ta" id="mc-content" rows="2" placeholder="نص الرد الجاهز…" style="margin-bottom:8px"></textarea>
     <button class="btn primary sm" onclick="addMacro('${sid||''}')">${icon('check')} إضافة</button>
   </div>`); }
function insertMacro(id){ const m=(window._macros||[]).find(x=>x.id===id); const t=$('#reply-txt'); if(m&&t){t.value=(t.value?t.value+' ':'')+m.content; closeModal(); t.focus();} else closeModal(); }
async function addMacro(sid){ const c=$('#mc-content').value.trim(); if(!c){toast('اكتب نص الرد','bad');return;} const r=await send('/api/macros','POST',{title:($('#mc-title').value.trim()||c.slice(0,24)),content:c}); if(r){toast('أُضيف الرد ✓');openMacros(sid||null);}else toast('فشل','bad'); }
async function delMacro(id){ const r=await send('/api/macros/'+id,'DELETE'); if(r){toast('حُذف');openMacros(_drawerSid||null);}else toast('فشل','bad'); }

/* ============================================================ Activity drawer */
/* ---------- Notification Center (Phase 2): live · channel-based · deep-linked · unread ---------- */
let _notifs=[], _unread=0, _audioReady=false;
const NOTIF_TYPES={
  customer_event:['msg','رسالة جديدة','info','customer'], new_customer:['user','زبون جديد','info','customer'],
  order_created:['cart','طلب جديد','success','sales'], order:['cart','طلب جديد','success','sales'],
  order_paid:['card','دفعة مؤكدة','success','sales'], order_delivered:['truck','تم التسليم','success','sales'],
  intervention:['alert','تدخّل مطلوب','warn','inbox'], human_takeover:['user','استلام بشري','info','inbox'],
  ai_error:['alert','خطأ ذكاء','critical','errors'], workflow_error:['alert','خطأ Workflow','warn','errors'],
  recovery:['refresh','حدث استرجاع','info','recovery'], system_warning:['alert','تحذير نظام','warn','system'],
  critical:['alert','تنبيه حرج','critical','system'] };
function notifMeta(t){ return NOTIF_TYPES[t]||['activity','حدث جديد','info','']; }
function armAudio(){ if(_audioReady)return; _audioReady=true; try{ const AC=window.AudioContext||window.webkitAudioContext; if(AC){ window._ac=window._ac||new AC(); if(window._ac.state==='suspended')window._ac.resume(); } }catch(e){} }
document.addEventListener('click',armAudio); document.addEventListener('keydown',armAudio);
function playTone(kind){ try{ if(!_audioReady||!window._ac)return; const ac=window._ac;
  const beep=(f,t0,dur)=>{ const o=ac.createOscillator(),g=ac.createGain(); o.connect(g);g.connect(ac.destination); o.type='sine'; o.frequency.value=f;
    g.gain.setValueAtTime(0.0001,ac.currentTime+t0); g.gain.exponentialRampToValueAtTime(0.12,ac.currentTime+t0+0.02); g.gain.exponentialRampToValueAtTime(0.0001,ac.currentTime+t0+dur); o.start(ac.currentTime+t0); o.stop(ac.currentTime+t0+dur+0.02); };
  const seq=({info:[660],success:[784,988],warn:[523],critical:[330,330,330]})[kind]||[660]; seq.forEach((f,i)=>beep(f,i*0.16,0.3)); }catch(e){} }
function updateBell(){ const bd=$('#bell-dot'); if(!bd)return; if(_unread>0){bd.textContent=_unread>99?'99+':_unread;bd.style.display='grid';}else bd.style.display='none'; }
function markAllRead(){ _notifs.forEach(n=>n.read=true); _unread=0; updateBell(); }
function pushNotif(n){ n.read=false; _notifs.unshift(n); if(_notifs.length>80)_notifs.pop(); _unread++; updateBell(); playTone(n.tone||'info');
  const dot=$('#live-dot'); if(dot){dot.style.boxShadow='0 0 0 4px var(--ok-soft)';setTimeout(function(){dot.style.boxShadow='';},700);}
  if($('#drawer').classList.contains('open')&&$('#notif-feed')) renderNotifFeed(); }
async function seedNotifs(){ try{ const a=await buildActivity(); _notifs=a.map(f=>({ic:f.ic,title:f.t,msg:f.m,sid:f.sid,at:f.at,tone:(f.ic==='card'||f.ic==='cart'||f.ic==='truck')?'success':(f.ic==='alert'?'warn':'info'),target:(f.ic==='card'||f.ic==='cart'||f.ic==='truck')?'sales':(f.ic==='alert'?'inbox':'customer'),read:true})); _unread=0; updateBell(); }catch(e){} }
function notifClick(i){ const n=_notifs[i]; if(!n)return; n.read=true; _unread=_notifs.filter(x=>!x.read).length; updateBell(); closeDrawer();
  if(n.sid){ openCustomer(n.sid,'chat'); return; }
  const t=n.target;
  /* sales → orders workspace */
  if(t==='sales'){ if(typeof gotoOrders==='function')gotoOrders('orders'); else location.hash='#/orders'; }
  else if(t==='errors'){ if(typeof _sysTab!=='undefined')_sysTab='errors'; location.hash='#/system'; setTimeout(()=>{if(typeof renderSystem==='function')renderSystem();},80); }
  else if(t==='inbox'){ location.hash='#/inbox'; }
  /* recovery → hermes workspace */
  else if(t==='recovery'){ location.hash='#/hermes'; }
  else if(t==='system'){ location.hash='#/system'; } }
function notifRow(n,i){ const ch=n.channel?(' '+chanChip(n.channel)):'';
  return `<div class="fitem nrow ${n.read?'':'unread'} tone-${n.tone||'info'}" onclick="notifClick(${i})" style="padding:11px 16px;border-bottom:1px solid var(--border)"><div class="fic">${icon(n.ic||'activity')}</div>
    <div style="flex:1;min-width:0"><div class="ft">${n.read?'':'<span class="ndot"></span>'}${esc(n.title||'')}${ch}</div><div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.msg||'')}</div></div><div class="fa">${timeAgo(n.at)}</div></div>`; }
function renderNotifFeed(){ const el=$('#notif-feed'); if(!el)return; el.innerHTML=_notifs.length?`<div class="feed">${_notifs.map((n,i)=>notifRow(n,i)).join('')}</div>`:empty('bell','لا إشعارات بعد'); paintIcons(el);
  const sub=$('#notif-sub'); if(sub)sub.textContent='مباشر · '+_notifs.filter(n=>!n.read).length+' غير مقروء'; }
async function openActivityDrawer(){ document.body.classList.remove('side-open'); armAudio();
  $('#scrim').classList.add('open'); const d=$('#drawer'); d.classList.add('open');
  if(!_notifs.length) await seedNotifs();
  d.innerHTML=`<div class="dr-head"><div class="dr-av" style="background:linear-gradient(135deg,var(--accent),#3B86E8)">${icon('bell')}</div>
    <div style="flex:1"><div class="nm">الإشعارات</div><div class="mt muted" id="notif-sub">مباشر · ${_notifs.filter(n=>!n.read).length} غير مقروء</div></div>
    <button class="btn ghost sm" onclick="markAllRead();renderNotifFeed()">تعليم الكل مقروء</button>
    <button class="iconbtn dr-close" onclick="closeDrawer()">${icon('x')}</button></div>
    <div class="dr-body" id="notif-feed"></div>`;
  paintIcons(d); renderNotifFeed();
}
/* ---------- Hermes Copilot (Dashboard) — conversational ops assistant on /hermes/ask ---------- */
let _hermesChat=[], _hermesCopilot=null;
function hermesRender(){ const d=$('#drawer'); if(!d.classList.contains('open'))return;
  const cp=_hermesCopilot||{recommendations:[],alerts:[]}; const recs=(cp.recommendations||[]).slice(0,5); const alerts=(cp.alerts||[]).slice(0,4);
  const card=(o,risk)=>`<div class="hcard p-${risk?(o.severity==='critical'?'high':'medium'):(o.priority||'medium')}" ${(!risk&&o.subscriber_id)?`onclick="closeDrawer();openCustomer('${o.subscriber_id}','chat')" style="cursor:pointer;margin-bottom:8px"`:'style="margin-bottom:8px"'}><div class="hi">${o.icon||(risk?'⚠️':'•')}</div><div class="hbody"><div class="htitle">${esc(o.title||'')}${(!risk&&o.estimated_value)?` <span class="hval">${money(o.estimated_value)} DH</span>`:''}</div><div class="hreason">${esc((risk?o.reason:(o.suggested_action||o.reason))||'')}</div></div></div>`;
  d.innerHTML=`<div class="dr-head"><div class="dr-av" style="background:linear-gradient(135deg,var(--accent),#3B86E8)">${icon('spark2')}</div>
    <div style="flex:1"><div class="nm">Hermes Copilot</div><div class="mt muted">إجراءات · رادارات · محادثة</div></div>
    ${_hermesChat.length?`<button class="btn ghost sm" onclick="_hermesChat=[];hermesRender()">مسح</button>`:''}
    <button class="iconbtn dr-close" onclick="closeDrawer()">${icon('x')}</button></div>
    <div class="dr-body">
      <div class="dr-sec">${icon('spark')} الإجراء التالي الأفضل (NBA)</div>
      ${recs.length?recs.map(r=>card(r,false)).join(''):(_hermesCopilot?'<div class="dim" style="font-size:12px;padding:2px 0">لا توصيات الآن</div>':skel())}
      ${alerts.length?`<div class="dr-sec">${icon('alert')} رادار المخاطر</div>${alerts.map(a=>card(a,true)).join('')}`:''}
      <div class="dr-sec">${icon('msg')} اسأل Hermes (تحليل بالأدلة)</div>
      <div id="hermes-msgs" style="display:flex;flex-direction:column;gap:10px;max-height:36vh;overflow-y:auto">${_hermesChat.length?_hermesChat.map(m=>`<div class="bubble ${m.role==='user'?'user':'ai'}">${esc(m.content)}</div>`).join(''):'<div class="dim" style="font-size:12px;padding:2px 0">أمثلة: علاش نقصو المبيعات؟ · شكون خاصو متابعة اليوم؟ · شنو أكبر خطر؟</div>'}</div>
      <div class="dr-reply" style="margin-top:10px"><textarea class="ta" id="hermes-q" rows="1" placeholder="اسأل Hermes بلغتك… Enter" style="min-height:40px" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();askHermes()}"></textarea>
        <button class="btn primary" onclick="askHermes()">${icon('send')}</button></div></div>`;
  paintIcons(d); const mb=$('#hermes-msgs'); if(mb)mb.scrollTop=mb.scrollHeight; }
async function openHermesChat(){ document.body.classList.remove('side-open'); if(typeof armAudio==='function')armAudio(); $('#scrim').classList.add('open'); $('#drawer').classList.add('open'); hermesRender();
  try{ const c=await api('/hermes/cockpit'); _hermesCopilot=c||{recommendations:[],alerts:[]}; if($('#drawer').classList.contains('open'))hermesRender(); }catch(e){} }
async function askHermes(){ const t=$('#hermes-q'); if(!t||!t.value.trim())return; const q=t.value.trim();
  _hermesChat.push({role:'user',content:q}); _hermesChat.push({role:'ai',content:'… يحلّل'}); hermesRender();
  const r=await send('/hermes/ask','POST',{question:q,chat_id:'dashboard'}); _hermesChat.pop();
  _hermesChat.push({role:'ai',content:(r&&r.answer)||'تعذّر الحصول على إجابة — حاول مجدداً'}); hermesRender(); }
async function buildActivity(){
  const [ords,iv,drafts]=await Promise.all([cached('orders',()=>api('/api/orders?limit=20')),api('/api/interventions'),cached('drafts',()=>api('/api/followup-drafts'))]);
  const items=[];
  (ords||[]).forEach(o=>items.push({ic:o.paid_at?'card':'cart',t:o.paid_at?`دفعة مؤكدة · ${esc(o.product_name||'')}`:`طلب جديد · ${esc(o.product_name||'')}`,m:(o.customer_name||'')+' · '+money(priceNum(o.price))+' DH',at:o.paid_at||o.created_at,sid:o.subscriber_id}));
  ((iv&&iv.interventions)||[]).forEach(i=>items.push({ic:'alert',t:`تدخّل: ${esc(i.reason_code||'')}`,m:(i.customer_name||'')+' · '+esc((i.customer_message||'').slice(0,46)),at:i.created_at,sid:i.subscriber_id}));
  ((drafts&&drafts.drafts)||[]).filter(d=>d.status==='draft').slice(0,6).forEach(d=>items.push({ic:'msg',t:'مسودة متابعة بانتظار الموافقة',m:esc(d.customer_name||'')+' · '+esc((d.draft_message||'').slice(0,46)),at:d.created_at,sid:d.subscriber_id}));
  items.sort((a,b)=>new Date(b.at||0)-new Date(a.at||0)); return items.slice(0,40);
}
function feedRow(f){ return `<div class="fitem" ${f.sid?`onclick="openCustomer('${f.sid}')"`:''}><div class="fic">${icon(f.ic)}</div><div style="flex:1"><div class="ft">${f.t}</div><div class="fm">${f.m||''}</div></div><div class="fa">${timeAgo(f.at)}</div></div>`; }
function fill(sel,html){const e=typeof sel==='string'?$(sel):sel;if(e){e.innerHTML=html;paintIcons(e);}return e;}

/* ============================================================ Command palette — keyboard-first */
let _cmdActions=[],_cmdSel=0;
async function openCmd(){ document.body.classList.remove('side-open'); $('#cmd').classList.add('open'); const i=$('#cmd-input'); i.value=''; setTimeout(()=>i.focus(),40);
  renderCmd(navGroups()); if(!_cache.cmd){ const[c,o,p]=await Promise.all([api('/api/customers'),api('/api/orders?limit=200'),api('/api/products')]); _cache.cmd={t:Date.now(),v:{c:c||[],o:o||[],p:p||[]}}; } }
function closeCmd(){ $('#cmd').classList.remove('open'); }
function navGroups(){ const nav=[
    ['home','home','الرئيسية'],
    ['inbox','inbox','المحادثات'],
    ['frozen','clock','المجمّدون'],
    ['orders','dollar','الطلبات والدفع'],
    ['crm','user','الزبناء'],
    ['catalog','package','المنتجات'],
    ['hermes','send','المتابعة'],
    ['analytics','chart','التقارير']];
  const more=[['system','sliders','النظام']];
  return [
    {sec:'انتقال سريع',rows:nav.map(n=>({ic:n[1],label:n[2],meta:'صفحة',act:()=>{location.hash='#/'+n[0];closeCmd();}}))},
    {sec:'المزيد',rows:more.map(n=>({ic:n[1],label:n[2],meta:'صفحة',act:()=>{location.hash='#/'+n[0];closeCmd();}}))}
  ]; }
function renderCmd(groups){ _cmdActions=[]; let html='',idx=0;
  groups.forEach(g=>{ if(!g.rows.length)return; html+=`<div class="cmd-sec">${g.sec}</div>`;
    g.rows.forEach(r=>{ const i=idx++; _cmdActions.push(r.act);
      html+=`<div class="cmd-row" data-i="${i}" onmouseenter="cmdSel(${i})" onclick="cmdRun(${i})"><div class="ci">${icon(r.ic)}</div><span>${esc(r.label)}</span>${r.meta?`<span class="cm">${esc(r.meta)}</span>`:''}</div>`; }); });
  $('#cmd-res').innerHTML=html||`<div class="skel">لا نتائج</div>`; paintIcons($('#cmd-res')); _cmdSel=0; highlightCmd(); }
function highlightCmd(){ $$('#cmd-res .cmd-row').forEach((e,i)=>e.classList.toggle('sel',i===_cmdSel)); const s=$('#cmd-res .cmd-row.sel'); if(s)s.scrollIntoView({block:'nearest'}); }
function cmdSel(i){ _cmdSel=i; highlightCmd(); }
function cmdRun(i){ const a=_cmdActions[i]; if(a)a(); }
function cmdSearch(q){ q=q.trim().toLowerCase(); if(!q){ renderCmd(navGroups()); return; }
  const d=(_cache.cmd&&_cache.cmd.v)||{c:[],o:[],p:[]}; const groups=[];
  const cust=d.c.filter(x=>(x.customer_name||'').toLowerCase().includes(q)||String(x.subscriber_id).includes(q)).slice(0,6);
  const ords=d.o.filter(x=>String(x.id).includes(q)||(x.customer_name||'').toLowerCase().includes(q)||(x.product_name||'').toLowerCase().includes(q)).slice(0,5);
  const prods=d.p.filter(x=>(x.product_name||'').toLowerCase().includes(q)).slice(0,5);
  if(cust.length)groups.push({sec:'الزبائن',rows:cust.map(c=>({ic:'user',label:c.customer_name||c.subscriber_id,meta:(c.channel||'')+' '+(c.stage||''),act:()=>{openCustomer(c.subscriber_id);closeCmd();}}))});
  if(ords.length)groups.push({sec:'الطلبات',rows:ords.map(o=>({ic:'cart',label:'طلب #'+o.id+' · '+(o.product_name||''),meta:money(priceNum(o.price))+' DH',act:()=>{openCustomer(o.subscriber_id,'orders');closeCmd();}}))});
  if(prods.length)groups.push({sec:'السلع',rows:prods.map(p=>({ic:'package',label:p.product_name,meta:p.price,act:()=>{location.hash='#/catalog';closeCmd();}}))});
  renderCmd(groups.length?groups:[{sec:'لا نتائج',rows:[]}]); }
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#cmd').classList.contains('open')?closeCmd():openCmd();return;}
  if($('#cmd').classList.contains('open')){
    if(e.key==='ArrowDown'){e.preventDefault();_cmdSel=Math.min(_cmdActions.length-1,_cmdSel+1);highlightCmd();}
    else if(e.key==='ArrowUp'){e.preventDefault();_cmdSel=Math.max(0,_cmdSel-1);highlightCmd();}
    else if(e.key==='Enter'){e.preventDefault();cmdRun(_cmdSel);}
    else if(e.key==='Escape'){closeCmd();}
    return;
  }
  if(e.key==='Escape')closeDrawer();
});

/* ============================================================ SSE realtime */
let _es=null,_sseT=null;
function connectSSE(){ try{ if(_es)_es.close(); _es=new EventSource(API+'/api/events/stream');
  ['order_paid','order_delivered','intervention','customer_event','human_takeover','order_created','workflow_error','ai_reply'].forEach(ev=>_es.addEventListener(ev,e=>onSSE(ev,e)));
  }catch(e){} }
function onSSE(type,e){ let d={}; try{d=JSON.parse(e.data);}catch(_){}
  const meta=notifMeta(type); let title=meta[1], tone=meta[2], target=meta[3];
  if(type==='workflow_error'){ const crit=d.severity==='critical'; tone=crit?'critical':'warn'; title=crit?'تنبيه حرج':'خطأ Workflow'; target='errors'; }
  const sid=d.subscriber_id||(d.target&&d.target.subscriber_id)||(d.order&&d.order.subscriber_id);
  if(type!=='ai_reply')pushNotif({type,ic:meta[0],title,tone,target,channel:d.channel,msg:((d.customer_name?d.customer_name+': ':'')+(d.message||d.title||d.node||(d.order&&d.order.product_name)||'')).slice(0,90),sid,at:new Date().toISOString()}); /* ai_reply = silent realtime update (not an alert) */
  bust('orders'); bust('drafts'); bust('customers'); refreshBadges();
  // IMMEDIATE inbox incremental (per-event, NOT debounced → a burst of messages never collapses to only the last one). Touches message/row state only — never a full re-render.
  try{
    var _mmI=$('#modal-mount'); var _modalI=_mmI&&_mmI.children.length>0;
    if(((location.hash.replace('#/','')||'cockpit').split('/')[0])==='inbox' && !_modalI){
      var _sidS=sid?String(sid):'';
      var _row=(_sidS&&typeof _ibxRoster!=='undefined'&&_ibxRoster)?_ibxRoster.filter(function(x){return String(x.subscriber_id)===_sidS;})[0]:null;
      var _isMsg=(type==='customer_event' && d && d.message); // ONLY a real incoming customer message (with text) promotes/appends
      if(_row && _isMsg){ /* PURE INCREMENTAL (WhatsApp Web): append ONE bubble + update ONLY this row + move to top. */
        try{ if(_row.inbox_closed){ _row.inbox_closed=false; if(_row.session_data)_row.session_data.inbox_closed_at=null; } }catch(_e){} /* ManyChat parity: a NEW inbound auto-reopens a closed chat */
        _row.last_message=d.message; _row.waiting=true; _row.last_seen=new Date().toISOString(); _row.last_any_at=_row.last_seen; _row.hours_since_last=0;
        _row.needs_reply_count=(_row.needs_reply_count||0)+1; /* new inbound = +1 unanswered → card green */
        if(_sidS===String(typeof _ibxSel!=='undefined'?_ibxSel:null)) _row.needs_reply_count=0; /* WhatsApp: conversation open = auto-read */
        var _ok=(typeof ibxUpdateRow==='function')?ibxUpdateRow(_sidS):false; if(!_ok&&typeof ibxRenderRows==='function')ibxRenderRows();
        if(_sidS===String(_ibxSel)&&typeof ibxAppendIncoming==='function')ibxAppendIncoming(_sidS,d.message,d.media_url);
      } else if(!_row && _isMsg){ if(typeof loadInbox2==='function')loadInbox2(); } /* unknown subscriber → refetch the LIST only; do NOT refresh the open thread (its history is unchanged + a lagging refetch could drop a just-shown message) */
      var _isAi=(type==='ai_reply' && d && d.message); /* AI replied → append AI bubble + mark answered (card → dark) */
      if(_row && _isAi){
        _row.last_message=d.message; _row.last_seen=new Date().toISOString(); _row.last_any_at=_row.last_seen; _row.hours_since_last=0; _row.needs_reply_count=0; _row.waiting=false;
        var _oka=(typeof ibxUpdateRow==='function')?ibxUpdateRow(_sidS):false; if(!_oka&&typeof ibxRenderRows==='function')ibxRenderRows();
        if(_sidS===String(_ibxSel)&&typeof ibxAppendIncoming==='function')ibxAppendIncoming(_sidS,d.message,null,'assistant');
      } else if(!_row && _isAi){ if(typeof loadInbox2==='function')loadInbox2(); }
    }
  }catch(_e){}
  clearTimeout(_sseT); _sseT=setTimeout(()=>{
    const drawerOpen=$('#drawer').classList.contains('open');
    const mm=$('#modal-mount'); const modalOpen=mm&&mm.children.length>0;
    // live Customer360 refresh when a message/intervention arrives for the open customer
    if(_drawerSid&&sid&&sid===_drawerSid&&drawerOpen&&window._cust){ window._cust.chat=null; if(typeof renderDrawerTab==='function')renderDrawerTab(); }
    if(modalOpen||drawerOpen)return; // don't disrupt open editor/drawer
    const r=(location.hash.replace('#/','')||'cockpit').split('/')[0];
    if(r==='inbox')return; /* inbox handled IMMEDIATELY above (not debounced) */
    /* new primary routes + backward-compat aliases */
    if(['orders','crm','hermes','analytics',
        'cockpit','sales','recovery'].includes(r))go();
    else if(r==='system'&&typeof _sysTab!=='undefined'&&(_sysTab==='activity'||_sysTab==='health')&&typeof renderSystem==='function')renderSystem();
  },1400); }

/* ============================================================ boot ---------- */
async function refreshBadges(){
  const [ic,seg,es,sum]=await Promise.all([api('/api/interventions/counts'),api('/api/followups/segments'),api('/api/ops/errors/summary'),api('/hermes/summary')]);
  const set=(id,v,cls)=>{const e=$(id);if(!e)return; if(v&&parseInt(v)>0){e.textContent=v;e.style.display='inline-block';if(cls)e.className='nb '+cls;}else e.style.display='none';};
  set('#nb-inbox',ic&&ic.pending,'hot'); set('#nb-recovery',seg&&seg.pending_drafts,'acc'); set('#nb-system',es&&es.real_unresolved,'hot');
  const n=sum?(sum.hot_leads||0)+(sum.lost_sales||0)+(sum.follow_ups||0)+(sum.payments||0):0;
  if($('#pill-n'))$('#pill-n').textContent=n?'· '+n:'';
}
/* ---------- AI-status header indicator ---------- */
let _aiStatusTimer=null;
async function refreshAIStatus(){
  try{
    const d=await api('/api/ops/ai-status');
    const paused=d&&d.ai_paused;
    const dot=$('#ai-status-dot'); const lbl=$('#ai-status-lbl');
    if(dot){dot.className='dot-s '+(paused?'bad':'ok');}
    if(lbl){lbl.textContent=paused?'موقوف':'نشط';}
    const pill=$('#ai-status-pill'); if(pill){pill.title=(paused?'الذكاء موقوف — انقر للإعدادات':'الذكاء نشط — انقر للإعدادات');}
  }catch(e){}
  clearTimeout(_aiStatusTimer); _aiStatusTimer=setTimeout(refreshAIStatus,60000);
}
function initApp(){ paintIcons(document); connectSSE(); seedNotifs(); refreshAIStatus(); if(window.boot)window.boot(); }
function startApp(){
  ['brand-spark','pill-spark','foot-spark','login-spark'].forEach(id=>{const e=$('#'+id);if(e)e.innerHTML=icon('spark');});
  $('#sb-ico').innerHTML=icon('search'); $('#cmd-ico').innerHTML=icon('search'); $('#bell-ico').innerHTML=icon('bell');
  $('#cmd-input').addEventListener('input',ev=>cmdSearch(ev.target.value));
  $('#login-pass').addEventListener('keydown',ev=>{if(ev.key==='Enter')doLogin();});
  paintIcons(document);
  if(TOKEN){ $('#login-gate').classList.remove('show'); initApp(); }
  else { $('#login-gate').classList.add('show'); setTimeout(()=>$('#login-pass').focus(),120); }
}
