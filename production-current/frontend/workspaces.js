/* ============================================================
   AykoShop v2 — native workspaces
   Cockpit · Inbox · Sales · Catalog · AI Studio · System
   ============================================================ */
function mount(html){const v=$('#view');v.innerHTML=html;paintIcons(v);}
let _salesTab='overview',_inboxTab='need',_aiTab='prompt',_sysTab='status',_inboxSearch='',_pqFilter='all';
let _ibxSel=null,_ibxFilter='need_reply',_ibxRoster=[],_ibxNeed=new Set(); // 2-pane inbox state (default = All Conversations, WhatsApp-style newest-first). Needs-reply count is SERVER-DERIVED (row.needs_reply_count from /api/customers) → cross-device/operator, tie-robust, clears on AI/operator reply.
function gotoSales(t){_salesTab=t||'overview';location.hash='#/sales';}
function gotoInbox(t){_inboxTab=t||'need';location.hash='#/inbox';}

/* ---------- Hermes rendering (shared) ---------- */
window._hRecs={};
const PRIO={critical:['bad','حرج'],high:['warn','عالٍ'],medium:['acc','متوسط'],low:['gray','عادي']};
function hCard(r){ window._hRecs[r.id]=r; const pc=PRIO[r.priority]||PRIO.medium;
  return `<div class="hcard p-${r.priority}" id="hc-${r.id}">
    <div class="hi">${r.icon||'•'}</div>
    <div class="hbody">
      <div class="htitle">${esc(r.title)} <span class="chip ${pc[0]}">${pc[1]}</span> ${r.probability?`<span class="hprob">${r.probability}%</span>`:''}</div>
      <div class="hreason">${esc(r.reason||'')}</div>
      <div class="hfoot"><button class="btn primary sm" onclick="hAction(${r.id})">${esc(r.suggested_action||'فتح')} ${icon('back')}</button>
        ${r.estimated_value?`<span class="hval">${money(r.estimated_value)} DH</span>`:''}</div>
    </div>
    <button class="hdismiss" onclick="event.stopPropagation();hDismiss(${r.id})">${icon('x')}</button>
  </div>`; }
function aCard(a){ const sev=a.severity==='critical'?'bad':(a.severity==='warning'?'warn':'acc');
  return `<div class="hcard p-${a.severity==='critical'?'critical':'high'}"><div class="hi">${a.icon||'⚠️'}</div>
    <div class="hbody"><div class="htitle">${esc(a.title)} <span class="chip ${sev}">${esc(a.category||'')}</span></div>
    <div class="hreason">${esc(a.reason||'')}</div></div></div>`; }
function hAction(id){ const r=window._hRecs[id]||{}; const t=r.target||{}; const sid=t.subscriber_id||r.subscriber_id;
  if(r.type==='payment_confirm'){ const oid=t.order_id; if(oid)getOrder(oid).then(o=>openPayModal(o||{id:oid,customer_name:r.customer_name})); else if(sid)openCustomer(sid,'orders'); return; }
  if(r.type==='demand_trend') location.hash='#/catalog';
  else if(r.type==='follow_up') gotoRecovery('followups');
  else if(sid) openCustomer(sid,'chat');
  else gotoSales('orders');
  send('/hermes/recommendations/'+id+'/actioned','POST',{});
  const el=$('#hc-'+id); if(el){el.style.opacity='.3';el.style.pointerEvents='none';setTimeout(()=>el.remove(),250);}
}
async function hDismiss(id){ const el=$('#hc-'+id); if(el){el.style.opacity=.25;el.style.pointerEvents='none';} await send('/hermes/recommendations/'+id+'/dismiss','POST',{}); if(el)el.remove(); toast('تم الإخفاء'); }

/* ============================================================ COCKPIT */
async function renderCockpit(){
  const hr=new Date().getHours(); const greet=hr<12?'صباح الخير':'مساء الخير';
  mount(phead(`${greet}، Ayko 👋`,`<span id="ck-line">Hermes يحلّل متجرك…</span>`,
    `<button class="btn ghost" onclick="renderCockpit()">${icon('refresh')} تحديث</button>`)+
    `<div id="exec-center">${skel()}</div>
     <div id="ck-health">${skel()}</div>
     <div class="split">
       <div class="panel hermes-panel"><div class="panel-h"><div class="hmark"><span data-ic="spark"></span></div>
         <div style="flex:1"><h2>يحتاج إجراء الآن</h2><div class="dim" style="font-size:12px" id="h-sub">مرتّبة حسب الأثر</div></div>
         <span class="chip gray" id="h-live"></span></div><div class="panel-b" id="hermes-cards">${skel()}</div></div>
       <div style="display:flex;flex-direction:column;gap:18px">
         <div class="panel"><div class="panel-h">${icon('chart')}<h2>ملخّص اليوم</h2></div><div class="panel-b" id="ck-digest">${skel()}</div></div>
         <div class="panel"><div class="panel-h">${icon('trend')}<h2>الاتجاهات (7 أيام)</h2></div><div class="panel-b" id="ck-trends">${skel()}</div></div></div></div>
     <div class="split" style="margin-top:18px">
       <div class="panel"><div class="panel-h">${icon('trend')}<h2 style="color:var(--ok)">رادار الفرص</h2></div><div id="ck-opp" style="padding:6px 14px">${skel()}</div></div>
       <div class="panel"><div class="panel-h">${icon('alert')}<h2 style="color:var(--bad)">رادار المخاطر</h2></div><div id="ck-risk" style="padding:6px 14px">${skel()}</div></div></div>
     <div class="panel" style="margin-top:18px"><div class="panel-h">${icon('activity')}<h2>النشاط المباشر</h2></div><div class="panel-b" style="padding:8px 14px"><div id="ck-feed">${skel()}</div></div></div>`);
  loadExecCenter(); loadCommandHealth(); loadCockpitHermes(); loadCommandDigest(); loadCommandTrends(); loadCommandRadars(); loadCockpitFeed();
}
async function loadExecCenter(){
  const [rev,sales,pq,hc,ph,ivc]=await Promise.all([api('/api/revenue'),api('/api/intelligence/sales'),api('/hermes/priority-queue'),cached('healthcenter',()=>api('/api/ops/health-center'),60000),api('/api/ops/production-health'),api('/api/interventions/counts')]);
  const el=$('#exec-center'); if(!el)return;
  const revToday=(rev&&rev.today)?rev.today.revenue:0;
  const oT=(sales&&sales.orders_today)||0, oY=(sales&&sales.orders_yesterday)||0;
  const growth = oY>0 ? Math.round((oT-oY)/oY*100) : (oT>0?100:0);
  const custToday=(ph&&ph.traffic)?ph.traffic.active_customers_24h:0;
  const hs=(hc&&hc.health_score!=null)?hc.health_score:0; const hsCls=hs>=90?'ok':(hs>=60?'warn':'bad');
  const counts=(pq&&pq.counts)||{buy_now:0,follow_today:0,warm:0,cold:0}; const totC=Math.max(1,counts.buy_now+counts.follow_today+counts.warm+counts.cold);
  const prods=(sales&&sales.products&&sales.products.length)?sales.products:[];
  const alerts=[];
  if(hc&&hc.critical&&hc.critical.length) alerts.push({t:'خدمات معطّلة: '+hc.critical.join(', '),c:'bad',ic:'alert',go:"_sysTab='health';location.hash='#/system'"});
  if(ivc&&ivc.pending) alerts.push({t:ivc.pending+' تدخّل بشري معلّق',c:'warn',ic:'inbox',go:"location.hash='#/inbox'"});
  if(sales&&sales.at_risk_count) alerts.push({t:sales.at_risk_count+' زبون معرّض للضياع',c:'warn',ic:'refresh',go:"location.hash='#/recovery'"});
  if(!alerts.length) alerts.push({t:'لا تنبيهات حرجة — كل شيء سليم',c:'ok',ic:'check'});
  const kpi=(ic,l,v,u,cls)=>`<div class="kpi a-${cls||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}${u?`<small>${u}</small>`:''}</div></div>`;
  const seg=(k,c,lbl)=>counts[c]?`<div class="seg seg-${k}" style="width:${Math.round(counts[c]/totC*100)}%" title="${lbl}: ${counts[c]}"></div>`:'';
  el.innerHTML=`<div class="panel exec-panel"><div class="panel-h">${icon('home')}<h2>مركز القيادة التنفيذي</h2><span class="chip ${hsCls}" style="margin-inline-start:auto">${icon('activity')} صحة النظام ${hs}%</span></div>
    <div class="panel-b">
      <div class="kpis">
        ${kpi('card','إيراد اليوم',money(revToday),' DH',revToday>0?'ok':'')}
        ${kpi('cart','طلبات اليوم',oT,'',oT>0?'ok':'')}
        ${kpi('cart','طلبات أمس',oY,'','')}
        ${kpi('trend','نمو الطلبات',(growth>0?'+':'')+growth,'%',growth>=0?'ok':'bad')}
        ${kpi('user','زبائن نشطون 24س',custToday,'','')}
        ${kpi('spark2','جاهزون للشراء',counts.buy_now,'',counts.buy_now>0?'ok':'')}
      </div>
      <div class="exec-row">
        <div class="exec-box"><div class="exec-t">توزيع احتمال الشراء</div>
          <div class="segbar">${seg('buy','buy_now','جاهز')}${seg('fol','follow_today','متابعة')}${seg('warm','warm','دافئ')}${seg('cold','cold','بارد')}</div>
          <div class="seg-legend"><span>🥇 ${counts.buy_now}</span><span>🥈 ${counts.follow_today}</span><span>🥉 ${counts.warm}</span><span>⚫ ${counts.cold}</span></div></div>
        <div class="exec-box"><div class="exec-t">أعلى المنتجات</div>
          ${prods.length?prods.slice(0,4).map(p=>`<div class="row between" style="padding:5px 0;font-size:12.5px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.product_name||'—')}</span><span class="chip gray">${p.orders} طلب</span></div>`).join(''):((sales&&sales.top_demand&&sales.top_demand.length)?sales.top_demand.slice(0,4).map(c=>`<div class="row between" style="padding:5px 0;font-size:12.5px"><span>${esc(c.category)}</span><span class="chip acc">${c.n} بحث</span></div>`).join(''):'<div class="dim">لا بيانات بعد</div>')}</div>
        <div class="exec-box"><div class="exec-t">تنبيهات حيّة</div>
          ${alerts.map(a=>`<div class="row gap8" style="padding:5px 0;font-size:12.5px;${a.go?'cursor:pointer':''}" ${a.go?`onclick="${a.go}"`:''}><span class="chip ${a.c}">${icon(a.ic)}</span><span>${esc(a.t)}</span></div>`).join('')}</div>
      </div></div></div>`;
  paintIcons(el);
}
async function loadCommandHealth(){
  const [rev,ph,ai,ret,rec]=await Promise.all([api('/api/revenue'),api('/api/ops/production-health'),api('/api/ai-analytics'),api('/api/retention/stats'),api('/hermes/recovery')]);
  const today=rev&&rev.today?rev.today.revenue:0; const paidCount=rev&&rev.all_time?rev.all_time.count:0;
  const unconf=rec&&rec.payment_discipline?rec.payment_discipline.unconfirmed_count:0;
  const aiS=ai&&ai.summary?(ai.summary.ai_success_rate||0):0;
  const reply=ph&&ph.traffic?(ph.traffic.reply_rate_pct||0):0, errs=ph&&ph.errors?(ph.errors.unresolved||0):0;
  const opsS=Math.max(0,Math.min(100,reply-errs*15));
  const capture=(paidCount+unconf)>0?Math.round(paidCount/(paidCount+unconf)*100):100;
  const retS=ret?(ret.retention_rate||0):0;
  const overall=Math.round((aiS+opsS+capture+retS)/4); const oc=overall>=70?'ok':(overall>=40?'warn':'bad');
  const sub=(label,ic,v,cls,note)=>`<div class="kpi a-${cls}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${label}</div></div><div class="val num">${v}<small>%</small></div><div class="sub">${note||''}</div></div>`;
  fill('#ck-health',`<div class="hero" style="cursor:default;margin-bottom:14px">
      <div class="hicon" style="background:var(--${oc}-soft);color:var(--${oc})">${icon('activity')}</div>
      <div><div class="hlbl">صحة المتجر (Business Health)</div><div class="hbig num" style="color:var(--${oc})">${overall}<small>/100</small></div></div>
      <div class="hmeta"><div class="hm"><div class="v num">${money(today)} DH</div><div class="k">إيراد اليوم</div></div>
        <div class="hm"><div class="v num">${unconf}</div><div class="k">بانتظار تأكيد</div></div></div></div>
    <div class="kpis">
      ${sub('الذكاء','cpu',aiS,aiS>=70?'ok':'warn','نجاح الردود')}
      ${sub('التشغيل','sliders',opsS,opsS>=70?'ok':'warn','رد '+reply+'%'+(errs?(' · '+errs+' خطأ'):''))}
      ${sub('التقاط الإيراد','dollar',capture,capture>=70?'ok':(capture>0?'warn':'bad'),unconf>0?(unconf+' طلب غير مؤكد'):'مكتمل')}
      ${sub('الاحتفاظ','heart',retS,retS>=50?'ok':'warn',retS===0?'يتفعّل مع المدفوعات':'')}</div>`);
}
async function loadCommandDigest(){ const d=await api('/api/reports/daily'); if(!d||!d.customers){fill('#ck-digest',empty('chart','لا بيانات'));return;}
  const row=(l,v)=>`<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--border)"><span class="muted" style="font-size:12.5px">${l}</span><b class="num">${v}</b></div>`;
  fill('#ck-digest',`<div class="dim" style="font-size:12px;margin-bottom:6px">${esc(d.date||'')}</div>
    ${row('زبائن جدد اليوم',d.customers.new_today)}${row('إيراد اليوم',money(d.orders.revenue_today_dh)+' DH')}${row('طلبات اليوم',d.orders.today)}
    ${row('Hot leads',d.customers.hot_leads)}${row('مبيعات مفقودة',d.customers.lost_sales)}${row('متابعات مستحقة',d.followups.due_soon)}
    ${row('نجاح الذكاء',(d.ai.success_rate||0)+'%')}${row('أخطاء حرجة',d.ai.critical_errors)}`);
}
async function loadCommandTrends(){ const [k,f]=await Promise.all([api('/api/kpi/trend'),api('/api/funnel')]);
  const num1=o=>{if(o==null)return 0;for(const key in o){if(/date|day|created|_at/i.test(key))continue;const n=+o[key];if(!isNaN(n))return n;}return 0;};
  const spark=(arr,key)=>{const a=(arr||[]).slice(-7);const vals=a.map(x=>key?(+x[key]||0):num1(x));const mx=Math.max(1,...vals);
    return vals.length?`<div class="row gap8" style="align-items:flex-end;height:40px;margin-top:4px">${vals.map(v=>`<div title="${v}" style="flex:1;min-width:6px;background:var(--accent-soft);border-radius:3px 3px 0 0;height:${Math.max(6,Math.round(v/mx*40))}px"></div>`).join('')}</div>`:'<div class="dim" style="font-size:12px">لا بيانات</div>';};
  const t=(l,arr,key)=>`<div style="margin-bottom:14px"><div class="muted" style="font-size:12px">${l}</div>${spark(arr,key)}</div>`;
  fill('#ck-trends', t('الطلبات',(k&&k.daily_orders))+t('زبائن جدد',(k&&k.daily_customers))+t('تحوّل لـ Hot',(f&&f.trend_7d),'became_hot'));
}
async function loadCommandRadars(){ const d=await api('/hermes/cockpit'); const recs=(d&&d.recommendations)||[]; const alerts=(d&&d.alerts)||[];
  window._hRecs=window._hRecs||{}; recs.forEach(r=>window._hRecs[r.id]=r);
  const oppT=['hot_lead','payment_confirm','follow_up','demand_trend','renewal','repeat'];
  const opp=recs.filter(r=>oppT.includes(r.type)), risk=recs.filter(r=>!oppT.includes(r.type));
  const mini=r=>`<div class="fitem" onclick="hAction(${r.id})" style="padding:10px 4px;border-bottom:1px solid var(--border)"><div class="fic">${r.icon||'•'}</div><div style="flex:1;min-width:0"><div class="ft">${esc(r.title)}</div><div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((r.reason||'').slice(0,46))}</div></div>${r.estimated_value?`<div class="hval">${money(r.estimated_value)} DH</div>`:''}</div>`;
  fill('#ck-opp', opp.length? opp.map(mini).join('') : empty('check','لا فرص عاجلة'));
  const riskHtml=risk.map(mini).join('')+alerts.map(a=>`<div class="fitem" style="padding:10px 4px;border-bottom:1px solid var(--border)"><div class="fic" style="color:var(--bad)">${icon('alert')}</div><div style="flex:1;min-width:0"><div class="ft">${esc(a.title)}</div><div class="fm">${esc((a.reason||'').slice(0,46))}</div></div></div>`).join('');
  fill('#ck-risk', (risk.length||alerts.length)? riskHtml : `<div class="row gap8" style="color:var(--ok);font-size:13px;padding:10px">${icon('check')} لا مخاطر — النظام مستقر</div>`);
}
async function loadCockpitHermes(){
  const [d,sum]=await Promise.all([api('/hermes/cockpit'),api('/hermes/summary')]);
  const recs=(d&&d.recommendations)||[], alerts=(d&&d.alerts)||[];
  const payN=sum?sum.payments:0, payVal=recs.filter(r=>r.type==='payment_confirm').reduce((s,r)=>s+(r.estimated_value||0),0);
  fill('#ck-line', recs.length? `رصد <b>${recs.length}</b> إجراء${payN?` — منها <b>${payN}</b> دفعة بانتظار التأكيد بقيمة <b class="ok">${money(payVal)} DH</b>`:''}` : 'كل شيء تحت السيطرة ✅ لا إجراءات عاجلة');
  if(sum&&sum.last_run) fill('#h-live',`<span class="dot-s ok"></span> ${timeAgo(sum.last_run)}`);
  fill('#hermes-cards', recs.length? recs.map(hCard).join('') : empty('check','لا إجراءات عاجلة','Hermes لم يرصد ما يتطلّب تدخلك الآن.'));
  fill('#hermes-alerts', alerts.length? alerts.map(aCard).join('') : `<div class="row" style="color:var(--ok);font-size:13px">${icon('check')} النظام مستقر</div>`);
}
async function loadCockpitFeed(){ const f=(await buildActivity()).slice(0,8); fill('#ck-feed', f.length?`<div class="feed">${f.map(feedRow).join('')}</div>`:empty('activity','لا نشاط')); }

/* ============================================================ INBOX */
/* ===== 2-PANE INBOX (ManyChat-style) — list + open conversation in one screen. Reuses the drawer chat block via shared ids (chatbox/reply-txt) + globals (window._cust/_chatMsgs) so sendReply/takeOver/resumeAI/suggestReply/fixAiReply/openMacros bind UNCHANGED. No backend change. onSSE re-renders the route → live updates. ===== */
async function renderInbox2(){
  try{
    mount(`<section class="split ibx2${localStorage.getItem('ibxSide')==='0'?' no-side':''}" style="height:calc(100vh - var(--topbar))">
        <aside class="panel" style="display:flex;flex-direction:column;min-height:0;overflow:hidden">
          <div style="padding:16px 16px 12px;flex-shrink:0">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:13px"><div style="display:flex;align-items:center;gap:8px"><button class="iconbtn" title="تحديث" onclick="bust('customers');bust('iv_pending');renderInbox2()" style="width:28px;height:28px;border-radius:7px;flex:none">${icon('spark2')}</button><span class="num" id="ibx2-convcount" style="font-size:11px;color:var(--text-3);font-weight:700"></span></div><h2 style="margin:0;font-size:17px;font-weight:800">صندوق التشغيل</h2></div>
            <div class="tabs" id="ibx2-tabs" style="flex-wrap:wrap;gap:6px">
              <div class="tab${_ibxFilter==='need_reply'?' active':''}" data-f="need_reply" onclick="ibxFilter('need_reply')">🔴 لم يُجب بعد <span class="tb num" id="ibx2-cnt-reply"></span></div>
              <div class="tab${_ibxFilter==='all'?' active':''}" data-f="all" onclick="ibxFilter('all')">💬 الكل <span class="tb num" id="ibx2-cnt-all"></span></div>
              <div class="tab${_ibxFilter==='answered'?' active':''}" data-f="answered" onclick="ibxFilter('answered')">✅ تمّ الرد <span class="tb num" id="ibx2-cnt-answered"></span></div>
              <div class="tab${_ibxFilter==='buy'?' active':''}" data-f="buy" onclick="ibxFilter('buy')">🛒 شراء <span class="tb num" id="ibx2-cnt-buy"></span></div>
              <div class="tab${_ibxFilter==='recharge'?' active':''}" data-f="recharge" onclick="ibxFilter('recharge')">💎 شحن <span class="tb num" id="ibx2-cnt-recharge"></span></div>
              <div class="tab${_ibxFilter==='payment'?' active':''}" data-f="payment" onclick="ibxFilter('payment')">💳 دفع <span class="tb num" id="ibx2-cnt-payment"></span></div>
              <div class="tab${_ibxFilter==='support'?' active':''}" data-f="support" onclick="ibxFilter('support')">🛟 دعم <span class="tb num" id="ibx2-cnt-support"></span></div>
              <div class="tab${_ibxFilter==='question'?' active':''}" data-f="question" onclick="ibxFilter('question')">❓ سؤال <span class="tb num" id="ibx2-cnt-question"></span></div>
              <div class="tab${_ibxFilter==='human'?' active':''}" data-f="human" onclick="ibxFilter('human')">🚨 تدخل <span class="tb num" id="ibx2-cnt-human"></span></div>
              <div class="tab${_ibxFilter==='frozen'?' active':''}" data-f="frozen" onclick="ibxFilter('frozen')">🧊 مجمدون <span class="tb num" id="ibx2-cnt-frozen"></span></div>
            </div>
            <div class="ibx-search"><span class="s-ic">${icon('search')}</span>
              <input class="inp" id="ibx2-q" placeholder="ابحث باسم، رسالة، أو معرّف…" value="${esc(_inboxSearch||'')}" oninput="ibxSearch(this.value)"></div>
            <span id="ibx2-restore" style="display:block;padding:8px 0 0;text-align:left"></span>
          </div>
          <div id="ibx2-rows" style="flex:1;overflow-y:auto;min-height:0">${skel()}</div>
        </aside>
        <section class="panel" id="ibx2-conv-pane" style="display:flex;flex-direction:column;min-height:0;overflow:hidden">
          ${empty('msg','اختر محادثة','اضغط على أي زبون لفتح المحادثة هنا')}
        </section>
        <aside class="panel ibx2-side" id="ibx2-side"></aside>
      </section>`);
    await loadInbox2();
    if(_ibxSel) await ibxOpen(_ibxSel);
    else { const first=(_ibxRoster||[]).slice().sort((a,b)=>new Date(b.last_seen||0)-new Date(a.last_seen||0))[0]; if(first) await ibxOpen(String(first.subscriber_id)); }
  }catch(e){ console.error('[inbox2]',e); if(typeof renderInbox==='function')renderInbox(); }
}
async function loadInbox2(){
  const c=await cached('customers',()=>api('/api/customers')); _ibxRoster=c||[];
  try{ const iv=await cached('iv_pending',()=>api('/api/interventions?status=pending&limit=80')); const rows=(iv&&(iv.interventions||iv.rows||iv.data))||[]; _ibxNeed=new Set(rows.map(x=>String(x.subscriber_id))); }catch(_e){}
  ibxRenderRows();
}
function _ibxWaiting(x){ return (x.needs_reply_count||0)>0; } // ManyChat parity + TIE-ROBUST: needs-reply = customer messages AFTER the last outbound (AI/operator) reply. The backend `waiting` flag (last row by created_at) was INFLATED by timestamp ties where the AI reply shares the customer msg's created_at → use needs_reply_count instead. Stays «لم يُجب بعد» until AI/operator replies; 24h window irrelevant.
function _ibxFrozenVisible(x){ return !!x.ai_stopped && !x.inbox_closed && !!(x.last_any_at||x.last_message); } // frozen COUNT + bulk-resume must match the VISIBLE frozen list (which already has the base close + has-conversation filters applied), else count/list drift + bulk-resume touches hidden chats
const _IBXCAT={buy:['🛒','شراء'],recharge:['💎','شحن'],payment:['💳','دفع'],support:['🛟','دعم'],question:['❓','سؤال'],human:['🚨','تدخل']};
function _ibxClassify(x){ const sd=x.session_data||{}; const mc=sd.manual_category; let c; // deterministic (no LLM): manual override wins, then state/service/stage signals
  if(mc==='none') return {cat:null,manual:true,none:true,e:'',l:'بدون تصنيف'}; // operator removed the tag (persisted server-side session_data.manual_category='none' → durable across reload + device)
  if(mc&&_IBXCAT[mc]) c=mc;
  else if(_ibxNeed.has(String(x.subscriber_id))||x.ai_stopped||x.convo_state==='human') c='human';
  else if(x.convo_state==='payment'||x.payment_method) c='payment';
  else if(x.service_type==='recharge') c='recharge';
  else if(x.service_type==='account'||x.service_type==='code'||['sales','discovery','browsing'].indexOf(x.convo_state)>=0||['hot','warm','buyer','interested'].indexOf(x.stage)>=0) c='buy';
  else if(x.convo_state==='support'||x.convo_state==='complaint') c='support';
  else c='question';
  return {cat:c,manual:!!(mc&&_IBXCAT[mc]),e:_IBXCAT[c][0],l:_IBXCAT[c][1]}; }
async function ibxSetCat(sid,cat){ sid=String(sid); if(cat==='none') return ibxClearCat(sid); const r=await send('/api/inbox/classify','POST',{subscriber_id:sid,category:cat}); if(r&&r.ok){ const row=(_ibxRoster||[]).filter(x=>String(x.subscriber_id)===sid)[0]; if(row){ row.session_data=row.session_data||{}; row.session_data.manual_category=cat; } toast('تصنيف محفوظ + تعلّم Hermes ✓'); ibxRenderRows(); if(String(_ibxSel)===sid){const hs=document.querySelector('#ibx2-conv-pane select');if(hs)hs.value=cat;} }else toast((r&&r.error)||'فشل','bad'); }
function _ibxTabCounts(){ // per-tab (customers / unanswered-messages), live + cross-channel (chat_history is channel-agnostic). Same base as the visible list: real, non-closed conversations only.
  const base=(_ibxRoster||[]).filter(x=>!x.inbox_closed && !!(x.last_any_at||x.last_message));
  const t={all:[0,0],need_reply:[0,0],answered:[0,0],buy:[0,0],recharge:[0,0],payment:[0,0],support:[0,0],question:[0,0],human:[0,0],frozen:[0,0]};
  base.forEach(x=>{ const nr=x.needs_reply_count||0; const w=nr>0; const cat=_ibxClassify(x).cat;
    t.all[0]++; t.all[1]+=nr;
    if(w){ t.need_reply[0]++; t.need_reply[1]+=nr; } else { t.answered[0]++; }
    if(cat&&t[cat]){ t[cat][0]++; t[cat][1]+=nr; }
    if(_ibxFrozenVisible(x)){ t.frozen[0]++; t.frozen[1]+=nr; }
  });
  const set=(id,pair)=>{ const e=$('#'+id); if(!e)return; const c=pair[0]; e.textContent = c ? (''+c) : ''; }; // tabs show CUSTOMER count only (per founder); the per-message count lives on each card's green badge
  set('ibx2-cnt-all',t.all,false); set('ibx2-cnt-reply',t.need_reply,true); set('ibx2-cnt-answered',t.answered,false);
  set('ibx2-cnt-buy',t.buy,true); set('ibx2-cnt-recharge',t.recharge,true); set('ibx2-cnt-payment',t.payment,true);
  set('ibx2-cnt-support',t.support,true); set('ibx2-cnt-question',t.question,true); set('ibx2-cnt-human',t.human,true);
  set('ibx2-cnt-frozen',t.frozen,false);
}
function ibxRenderRows(){
  let list=(_ibxRoster||[]).slice();
  list=list.filter(x=>!x.inbox_closed); // server-side close (session_data.inbox_closed_at, ManyChat-like): hidden until a NEW inbound auto-reopens it (backend recomputes inbox_closed)
  list=list.filter(x=>!!(x.last_any_at||x.last_message)); // ManyChat parity: inbox shows only real CONVERSATIONS (≥1 message) — hide contacts who never wrote (CRM/Ctrl+K still see all via shared cache)
  if(_ibxFilter==='need_reply') list=list.filter(_ibxWaiting);
  else if(_ibxFilter==='answered') list=list.filter(x=>!_ibxWaiting(x));
  else if(_ibxFilter==='frozen') list=list.filter(x=>!!x.ai_stopped);
  else if(['buy','recharge','payment','support','question','human'].indexOf(_ibxFilter)>=0) list=list.filter(x=>_ibxClassify(x).cat===_ibxFilter);
  const q=(_inboxSearch||'').toLowerCase();
  if(q) list=list.filter(x=>(x.customer_name||'').toLowerCase().includes(q)||String(x.subscriber_id).includes(q)||(x.last_message||'').toLowerCase().includes(q));
  list.sort((a,b)=>new Date(b.last_any_at||b.last_seen||0)-new Date(a.last_any_at||a.last_seen||0)); // WhatsApp: newest activity (last message) ALWAYS on top — every filter
  const cc2=$('#ibx2-convcount'); if(cc2)cc2.textContent=list.length+' محادثة';
  const cn=$('#ibx2-cnt-need'); if(cn)cn.textContent=_ibxNeed.size||'';
  const fzN=(_ibxRoster||[]).filter(_ibxFrozenVisible).length; _ibxTabCounts();
  const rb=$('#ibx2-restore'); if(rb){ let rbh=''; if(_ibxFilter==='frozen'&&fzN) rbh+=`<span onclick="ibxResumeAllFrozen()" style="cursor:pointer;padding:5px 11px;border-radius:8px;font-size:11.5px;font-weight:700;background:var(--accent-soft);color:var(--accent-2);border:1px solid var(--accent-line)">▶️ تشغيل الذكاء على الكل (${fzN})</span> `; const _closedN=(_ibxRoster||[]).filter(x=>x.inbox_closed).length; if(_closedN) rbh+=`<span onclick="ibxRestoreAll()" style="cursor:pointer;padding:5px 11px;border-radius:8px;font-size:11.5px;font-weight:700;background:var(--ok-soft);color:var(--ok);border:1px solid rgba(0,231,1,.25)">↺ ارجع الكل (${_closedN})</span>`; rb.innerHTML=rbh; }
  const _re=$('#ibx2-rows'); const _sc=_re?_re.scrollTop:0;
  fill('#ibx2-rows', list.slice(0,120).map(ibxRow).join('')||empty('msg', _ibxFilter==='need_reply'?'لا أحد ينتظر ردّاً ✓':'لا محادثات في هذا الفلتر'));
  if(_re)_re.scrollTop=_sc; // keep list scroll on incremental SSE re-render (no jump)
}
function _avColor(s){const p=['#1475E1','#6D5AE6','#0EA5A4','#E1306C','#F59E0B','#10B981','#EF4444','#3B82F6'];s=String(s||'');let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return p[h%p.length];}
function _chDot(c){c=String(c||'').toLowerCase();return c.indexOf('whats')>=0?'wa':(c.indexOf('insta')>=0?'ig':((c.indexOf('mess')>=0||c.indexOf('face')>=0)?'msgr':''));}
let _ibxMenuOpen=null; // inbox CLOSE (Done/Archive) + tag-removal are now SERVER-SIDE (aykoshop_profiles.session_data) → durable across reload + device + operator (ManyChat parity). Close stamps inbox_closed_at; a NEW inbound auto-reopens (backend recomputes inbox_closed).
async function ibxClearCat(sid){ sid=String(sid); _ibxMenuOpen=null; const r=await send('/api/inbox/classify','POST',{subscriber_id:sid,category:'none'}); if(r&&r.ok){ const row=(_ibxRoster||[]).filter(x=>String(x.subscriber_id)===sid)[0]; if(row){row.session_data=row.session_data||{};row.session_data.manual_category='none';} if(typeof toast==='function')toast('تمت إزالة التصنيف ✓'); ibxRenderRows(); if(String(_ibxSel)===sid){const hs=document.querySelector('#ibx2-conv-pane select');if(hs){hs.value='none';const no=hs.querySelector('option[value="none"]');if(no)no.textContent='بدون تصنيف';}} } else if(typeof toast==='function')toast((r&&r.error)||'فشل','bad'); }
function ibxResumeFrozen(sid){ sid=String(sid); _ibxMenuOpen=null; const row=(_ibxRoster||[]).filter(x=>String(x.subscriber_id)===sid)[0]; if(row){ row.ai_stopped=false; if(row.convo_state==='human')row.convo_state='sales'; } if(window._cust&&String(window._cust.sid)===sid)window._cust.aiStopped=false; if(typeof resumeAI==='function')resumeAI(sid); /* reuses DELETE /api/customers/:id/takeover (no new backend) */ ibxRenderRows(); if(String(_ibxSel)===sid)ibxRenderConv(sid); }
async function ibxResumeAllFrozen(){ const frozen=(_ibxRoster||[]).filter(_ibxFrozenVisible); if(!frozen.length){ if(typeof toast==='function')toast('لا مجمّدين'); return; } if(typeof confirm==='function'&&!confirm('تشغيل الذكاء على جميع المجمّدين ('+frozen.length+')؟'))return; _ibxMenuOpen=null; for(const x of frozen){ try{ await send('/api/customers/'+String(x.subscriber_id)+'/takeover','DELETE'); }catch(_e){} x.ai_stopped=false; if(x.convo_state==='human')x.convo_state='sales'; } if(window._cust&&frozen.some(x=>String(x.subscriber_id)===String(window._cust.sid)))window._cust.aiStopped=false; if(typeof bust==='function')bust('customers'); if(typeof toast==='function')toast('▶️ فُكّ التجميد عن '+frozen.length+' زبون'); ibxRenderRows(); if(_ibxSel)ibxRenderConv(String(_ibxSel)); }
function ibxHdrMenuToggle(){ const m=document.getElementById('ibx-hdr-menu'); if(!m)return; const open=(m.style.display==='none'||!m.style.display); m.style.display=open?'block':'none'; document.removeEventListener('click',ibxHdrMenuOutside); if(open)setTimeout(function(){document.addEventListener('click',ibxHdrMenuOutside);},0); }
function ibxHdrMenuClose(){ const m=document.getElementById('ibx-hdr-menu'); if(m)m.style.display='none'; document.removeEventListener('click',ibxHdrMenuOutside); }
function ibxHdrMenuOutside(e){ const m=document.getElementById('ibx-hdr-menu'); if(m&&!m.contains(e.target))ibxHdrMenuClose(); }
/* ===== Operator outgoing media (📎): pick → preview → upload (/api/inbox/upload-media) → send via ManyChat (/message {media}) → optimistic bubble. ===== */
window._ibxAttach=null;
function ibxPickFile(){ const f=document.getElementById('ibx-file'); if(f)f.click(); }
function ibxFileChosen(input){ const f=input&&input.files&&input.files[0]; if(!f)return; const ty=(f.type||''); const kind=ty.indexOf('video')===0?'video':(ty==='application/pdf'?'file':'image'); if(window._ibxAttach&&window._ibxAttach.previewUrl)try{URL.revokeObjectURL(window._ibxAttach.previewUrl)}catch(_e){} window._ibxAttach={file:f,kind:kind,name:f.name,previewUrl:(kind==='image'||kind==='video')?URL.createObjectURL(f):null,sid:(typeof _ibxSel!=='undefined'&&_ibxSel)?String(_ibxSel):null}; ibxRenderAttachPreview(); const t=document.getElementById('reply-txt'); if(t)t.focus(); }
function ibxClearAttach(){ if(window._ibxAttach&&window._ibxAttach.previewUrl)try{URL.revokeObjectURL(window._ibxAttach.previewUrl)}catch(_e){} window._ibxAttach=null; const f=document.getElementById('ibx-file'); if(f)f.value=''; ibxRenderAttachPreview(); }
function ibxRenderAttachPreview(){ const el=document.getElementById('ibx-attach-preview'); if(!el)return; const a=window._ibxAttach; if(!a){el.innerHTML='';el.style.display='none';return;} el.style.display='block'; const thumb=a.kind==='image'?`<img src="${a.previewUrl}" style="width:46px;height:46px;object-fit:cover;border-radius:8px">`:(a.kind==='video'?`<video src="${a.previewUrl}" style="width:46px;height:46px;object-fit:cover;border-radius:8px"></video>`:`<span style="width:46px;height:46px;border-radius:8px;background:var(--raised);display:inline-flex;align-items:center;justify-content:center;font-size:20px">📄</span>`); el.innerHTML=`<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--panel);border:1px solid var(--border);border-radius:10px;margin-bottom:8px">${thumb}<span style="flex:1;min-width:0;font-size:12.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</span><button class="iconbtn" onclick="ibxClearAttach()" title="إلغاء" style="width:28px;height:28px;border-radius:7px">${icon('x')}</button></div>`; }
function _ibxErr(jr,status){ if(!jr)return 'الخادم رجع '+(status||'?')+' (تحقّق من الاتصال)'; let m=jr.error||''; try{ const dm=jr.detail&&jr.detail.details&&jr.detail.details.messages; if(dm&&dm[0]&&dm[0].message)m+=(m?' — ':'')+dm[0].message; else if(jr.detail&&jr.detail.message&&jr.detail.message!==m)m+=(m?' — ':'')+jr.detail.message; }catch(_e){} if(/24|window|outside|allowed|session/i.test(m))m+=' (نافذة WhatsApp 24س — الزبون خاصو يراسلك أول)'; return m||('HTTP '+(status||'?')); }
async function ibxSendWithMedia(sid){ sid=String(sid); const a=window._ibxAttach; if(!a||!a.file)return; if(a.sid&&a.sid!==sid){ ibxClearAttach(); if(typeof toast==='function')toast('المرفق كان لمحادثة أخرى — اختر الملف من جديد','bad'); return; } if(a.file.size>95*1024*1024){ if(typeof toast==='function')toast('الملف كبير بزاف (الحد ~95MB)','bad'); return; } const t=document.getElementById('reply-txt'); const cap=t?t.value.trim():''; const cb=document.getElementById('chatbox');
  if(cb){ const prev=a.kind==='image'?`<img src="${a.previewUrl}" style="max-width:240px;border-radius:10px;display:block">`:(a.kind==='video'?`<video src="${a.previewUrl}" controls style="max-width:280px;border-radius:10px;display:block"></video>`:`📄 ${esc(a.name)}`); cb.insertAdjacentHTML('beforeend',`<div class="bubble operator" data-optimistic="1" style="opacity:.55;margin-left:auto;margin-right:0">${prev}${cap?'<div style="margin-top:5px">'+esc(cap)+'</div>':''}<div class="bt">يُرفع ويُرسل…</div></div>`); cb.scrollTop=cb.scrollHeight; }
  let up=null,ust=0; try{ const fd=new FormData(); fd.append('file',a.file); const rr=await fetch('/api/inbox/upload-media',{method:'POST',headers:(typeof authHeaders==='function'?authHeaders():{}),body:fd}); ust=rr.status; if(rr.ok)up=await rr.json(); }catch(_e){}
  if(!up||!up.url){ const o=cb&&cb.querySelector('[data-optimistic]'); if(o)o.remove(); ibxClearAttach(); if(typeof toast==='function')toast(ust===413?'الملف كبير على الخادم (413) — خاص رفع حد nginx':('فشل رفع الملف'+(ust?(' · '+ust):'')),'bad'); return; }
  const _opt={role:'operator',message:(cap||''),media_url:up.url,created_at:new Date().toISOString(),_optimistic:true}; /* canonical → survives any re-render */
  try{ if(window._cust&&String(window._cust.sid)===sid){ if(!Array.isArray(window._cust.chat))window._cust.chat=[]; window._cust.chat.unshift(_opt); if(!Array.isArray(window._chatMsgs))window._chatMsgs=[]; window._chatMsgs.push(_opt); } }catch(_e){}
  try{ await send('/api/customers/'+sid+'/takeover','POST',{active:true}); }catch(_e){}
  let r=null,rerr=''; try{ const resp=await fetch('/api/customers/'+sid+'/message',{method:'POST',headers:(typeof authHeaders==='function'?authHeaders({'Content-Type':'application/json'}):{'Content-Type':'application/json'}),body:JSON.stringify({media:{url:up.url,type:up.kind||a.kind},message:(cap||undefined)})}); const jr=await resp.json().catch(()=>null); if(resp.ok&&jr&&jr.success!==false)r=jr; else rerr=_ibxErr(jr,resp.status); }catch(e){ rerr=(e&&e.message)||'تعذّر الاتصال'; }
  if(r){ if(t)t.value=''; ibxClearAttach(); if(window._cust)window._cust.aiStopped=true; if(typeof bust==='function')bust('customers');
    /* media already in _cust.chat (above, with the uploaded URL) → NO destructive refetch; server version replaces it on next open */
    try{ if(typeof _ibxRoster!=='undefined'&&_ibxRoster){ const rw=_ibxRoster.filter(x=>String(x.subscriber_id)===sid)[0]; if(rw){rw.ai_stopped=true;rw.last_message=(cap||(a.kind==='video'?'🎬 فيديو':a.kind==='file'?'📄 ملف':'📷 صورة'));rw.last_seen=new Date().toISOString();rw.last_any_at=rw.last_seen;rw.waiting=false;rw.needs_reply_count=0;} } }catch(_e){}
    if(typeof ibxRenderRows==='function')ibxRenderRows(); if(typeof ibxRenderConv==='function')ibxRenderConv(sid); if(typeof toast==='function')toast('تم إرسال الملف ✓');
  } else { try{ if(window._cust&&Array.isArray(window._cust.chat))window._cust.chat=window._cust.chat.filter(function(x){return x!==_opt;}); if(Array.isArray(window._chatMsgs))window._chatMsgs=window._chatMsgs.filter(function(x){return x!==_opt;}); }catch(_e){} const o=cb&&cb.querySelector('[data-optimistic]'); if(o)o.remove(); ibxClearAttach(); if(typeof toast==='function')toast('فشل الإرسال — '+(rerr||'سبب غير معروف'),'bad'); } }
function ibxToggleMenu(sid){ sid=String(sid); _ibxMenuOpen=_ibxMenuOpen===sid?null:sid; ibxRenderRows(); }
function ibxMenuCat(sid,cat){ _ibxMenuOpen=null; ibxSetCat(String(sid),cat); }
async function ibxRestoreAll(){ _ibxMenuOpen=null; const closed=(_ibxRoster||[]).filter(x=>x.inbox_closed); closed.forEach(x=>{x.inbox_closed=false; if(x.session_data)x.session_data.inbox_closed_at=null;}); ibxRenderRows(); const r=await send('/api/inbox/reopen','POST',{all:true}); if(!(r&&r.ok)){ if(typeof toast==='function')toast('فشل الإرجاع','bad'); if(typeof loadInbox2==='function')loadInbox2(); } }
async function ibxDone(sid){ sid=String(sid); _ibxMenuOpen=null; const row=(_ibxRoster||[]).filter(x=>String(x.subscriber_id)===sid)[0]; if(row){row.inbox_closed=true; row.session_data=row.session_data||{}; row.session_data.inbox_closed_at=new Date().toISOString();} if(typeof toast==='function')toast('تم إنهاء المحادثة'); const wasSel=String(_ibxSel)===sid; ibxRenderRows(); if(wasSel){ const nx=(_ibxRoster||[]).filter(x=>!x.inbox_closed).sort((a,b)=>new Date(b.last_seen||0)-new Date(a.last_seen||0))[0]; if(nx)ibxOpen(String(nx.subscriber_id)); } const r=await send('/api/inbox/close','POST',{subscriber_id:sid}); if(!(r&&r.ok)){ if(row){row.inbox_closed=false; if(row.session_data)row.session_data.inbox_closed_at=null;} if(typeof toast==='function')toast('فشل الإنهاء','bad'); ibxRenderRows(); } }
function ibxRow(x){ const sid=String(x.subscriber_id); const un=x.needs_reply_count||0; const c=_ibxClassify(x); const waiting=_ibxWaiting(x); const menuOpen=_ibxMenuOpen===sid;
  return `<div class="fitem ${sid===String(_ibxSel)?'active':''}" id="ibxrow-${sid}" onclick="ibxOpen('${sid}')" style="position:relative;cursor:pointer;padding:11px 13px;border-radius:11px;margin:0 0 5px">
    <div class="row" style="gap:11px;align-items:flex-start">
      <div class="av-wrap" style="flex:none"><div class="avatar-sm" style="width:40px;height:40px;border-radius:50%;font-size:14px;background:${_avColor(sid)}">${esc(initials(x.customer_name))}</div><span class="av-dot ${_chDot(x.channel)}"></span></div>
      <div style="flex:1;min-width:0">
        <div class="row between" style="gap:8px">
          <div class="row" style="gap:4px;flex:none">
            <span onclick="event.stopPropagation();ibxToggleMenu('${sid}')" title="تصنيف الزبون" style="width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--text-3);font-size:18px;font-weight:800;line-height:1;background:${menuOpen?'var(--raised)':'transparent'}">⋮</span>
            <span onclick="event.stopPropagation();ibxDone('${sid}')" title="إنهاء — إزالة من الوارد" style="width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--text-3);background:var(--panel-2)">${icon('check')}</span>
          </div>
          <div class="row" style="gap:6px;flex:1;min-width:0;justify-content:flex-end">
            <b style="font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.customer_name||'زبون')}</b>
            ${waiting?'<span title="محتاج جواب" style="flex:none;width:9px;height:9px;border-radius:50%;background:var(--bad)"></span>':''}
          </div>
        </div>
        <div class="row between" style="gap:8px;margin-top:3px;align-items:flex-start">
          <span class="num" style="font-size:11px;color:var(--text-3);flex:none">${timeAgo(x.last_seen)}</span>
          <span class="fm" style="font-size:13px;flex:1;min-width:0;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(_msgPreview(x.last_message).slice(0,60))}</span>
          ${un?`<span class="num" title="${un} رسالة تحتاج رداً" style="flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--ok);color:#04210a;font-size:10px;font-weight:800;display:inline-flex;align-items:center;justify-content:center">${un}</span>`:''}
        </div>
        <div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">
          ${c.cat?`<span class="chip gray">${c.e} ${c.l}</span>`:''}${waiting?'<span class="chip bad">⏳ ينتظر</span>':(x.ai_stopped?'<span class="chip warn">بشري</span>':'')}${x.stage==='hot'?'<span class="chip acc">🔥</span>':''}${chanChip(x.channel)}
        </div>
      </div>
    </div>
    ${menuOpen?`<div onclick="event.stopPropagation()" style="position:absolute;top:42px;right:13px;z-index:40;width:202px;background:var(--panel-2);border:1px solid var(--border-2);border-radius:11px;padding:6px;box-shadow:0 16px 40px rgba(0,0,0,.6)">${x.ai_stopped?`<div style="font-size:10.5px;color:var(--text-3);font-weight:800;padding:6px 9px 5px;text-align:right">🧊 زبون مجمّد</div><div onclick="event.stopPropagation();ibxResumeFrozen('${sid}')" style="padding:7px 9px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:800;color:var(--ok);text-align:right">▶️ تشغيل الذكاء (فكّ التجميد)</div><div onclick="event.stopPropagation();_ibxMenuOpen=null;ibxOpen('${sid}')" style="padding:7px 9px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:700;color:var(--text);text-align:right">💬 فتح المحادثة</div><div onclick="event.stopPropagation();_ibxMenuOpen=null;ibxRenderRows()" style="padding:7px 9px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:700;color:var(--text-2);text-align:right">🧊 إبقاء مجمّد</div><div style="height:1px;background:var(--border);margin:4px 0"></div>`:''}<div style="font-size:10.5px;color:var(--text-3);font-weight:800;padding:6px 9px 5px;text-align:right">صنّف الزبون</div>${Object.keys(_IBXCAT).map(k=>`<div onclick="event.stopPropagation();ibxMenuCat('${sid}','${k}')" style="padding:7px 9px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:700;color:var(--text);text-align:right">${_IBXCAT[k][0]} ${_IBXCAT[k][1]}</div>`).join('')}<div onclick="event.stopPropagation();ibxMenuCat('${sid}','none')" style="padding:7px 9px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:700;color:var(--bad);text-align:right">❌ إزالة التصنيف</div><div style="height:1px;background:var(--border);margin:4px 0"></div><div onclick="event.stopPropagation();ibxDone('${sid}')" style="padding:7px 9px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:800;color:var(--ok);text-align:right">إنهاء وإزالة من الوارد</div></div>`:''}
  </div>`;
}
async function ibxOpen(sid){ sid=String(sid); if(window._ibxAttach&&window._ibxAttach.sid&&window._ibxAttach.sid!==sid){try{ibxClearAttach()}catch(_e){}} _ibxSel=sid; /* WhatsApp-parity: open conversation = Mark as Read → clears green immediately. Green returns on new SSE inbound. */ if(_ibxMenuOpen!==null){_ibxMenuOpen=null;ibxRenderRows();}
  try{document.querySelectorAll('#ibx2-rows .fitem.active').forEach(e=>e.classList.remove('active'));}catch(_e){} const r=$('#ibxrow-'+sid); if(r)r.classList.add('active');
  const pane=$('#ibx2-conv-pane'); if(pane)pane.innerHTML=skel(); const sp0=$('#ibx2-side'); if(sp0)sp0.innerHTML=skel();
  const [ais,intel,h,p3]=await Promise.all([api('/api/customers/'+sid+'/ai-status'),api('/api/customers/'+sid+'/intelligence'),api('/api/chat-history/'+sid),api('/api/customers/'+sid+'/profile360')]);
  window._cust={sid:sid,chat:h,aiStopped:!!(ais&&ais.ai_stopped),stoppedSince:ais&&ais.stopped_since,p:(p3&&p3.profile)||null,orders:(p3&&p3.orders)||[]};
  window._ibxCust={sid:sid,intel:(intel&&!intel.error?intel:null)};
  /* WhatsApp Mark-as-Read: clear green immediately + persist to DB (survives reload/cross-device). */
  try{ const _ur=(_ibxRoster||[]).filter(x=>String(x.subscriber_id)===sid)[0]; if(_ur&&(_ur.needs_reply_count||0)>0){ _ur.needs_reply_count=0; if(typeof ibxUpdateRow==='function'){ if(!ibxUpdateRow(sid)&&typeof ibxRenderRows==='function')ibxRenderRows(); } } }catch(_e){}
  send('/api/inbox/mark-read','POST',{subscriber_id:sid}).catch(()=>{}); /* persist read-state → survives reload */
  ibxRenderConv(sid); ibxRenderSide(sid);
}
function ibxRenderSide(sid){ sid=String(sid); const sp=$('#ibx2-side'); if(!sp)return;
  const intel=(window._ibxCust&&window._ibxCust.intel)||null; const p=(window._cust&&window._cust.p)||{}; const orders=(window._cust&&window._cust.orders)||[];
  const cust=(_ibxRoster||[]).filter(x=>String(x.subscriber_id)===sid)[0]||{};
  const prob=intel&&(intel.probability!=null?intel.probability:(intel.purchase_probability!=null?intel.purchase_probability:null));
  const tier=intel&&(intel.label||intel.tier||''); const nba=intel&&(intel.recommended_action||intel.next_best_action||intel.action); const reason=intel&&(intel.reason||'');
  const clv=(p.lifetime_value!=null?p.lifetime_value:(cust.lifetime_value||0));
  sp.innerHTML=`<div class="sdk">
    <div style="display:flex;flex-direction:column;align-items:center;text-align:center;margin-bottom:18px"><div class="avatar-sm" style="width:60px;height:60px;border-radius:50%;font-size:22px;background:${_avColor(sid)}">${esc(initials(cust.customer_name))}</div><div style="margin-top:11px;font-weight:800;font-size:17px">${esc(cust.customer_name||'زبون')}</div><div class="fm" style="margin-top:9px">${chanChip(cust.channel)} ${stageChip(cust.stage)}</div></div>
    ${prob!=null?`<div style="border-radius:13px;background:var(--panel-2);padding:16px;margin-bottom:13px"><div class="row between" style="margin-bottom:9px"><span class="num" style="font-size:18px;font-weight:800;color:var(--ok)">${prob}%</span><span class="fm" style="font-weight:700">احتمال الشراء${tier?(' · '+esc(tier)):''}</span></div><div style="height:7px;border-radius:5px;background:var(--raised);overflow:hidden;direction:ltr"><div style="height:100%;width:${Math.max(4,Math.min(100,prob))}%;border-radius:5px;background:linear-gradient(90deg,var(--accent),var(--ok))"></div></div>${reason?`<div class="fm" style="font-size:11.5px;margin-top:9px;text-align:right;line-height:1.5">${esc(String(reason).slice(0,130))}</div>`:''}</div>`:''}
    ${nba?`<div style="margin-bottom:16px;padding:15px;border:1px solid rgba(20,117,225,.3);border-radius:13px;background:rgba(20,117,225,.1)"><div style="font-size:11px;color:var(--accent-2);font-weight:800;text-align:right;margin-bottom:9px">الإجراء التالي الأفضل</div><div class="row" style="gap:10px;align-items:center"><button onclick="event.stopPropagation();var t=document.getElementById('reply-txt');if(t){t.focus();t.scrollIntoView({block:'nearest'});}" style="flex:none;padding:8px 14px;border-radius:8px;background:#1475E1;color:#fff;font-size:12.5px;font-weight:800;border:none;cursor:pointer;font-family:'Cairo'">نفّذ</button><span style="flex:1;font-size:13px;font-weight:700;text-align:right">✨ ${esc(nba)}</span></div></div>`:''}
    <div style="border-radius:13px;background:var(--panel-2);padding:6px 16px;margin-bottom:16px">
    <div class="sd-stat"><span>المرحلة</span><b>${esc(cust.stage||'—')}</b></div>
    <div class="sd-stat"><span>الطلبات</span><b>${orders.length}</b></div>
    <div class="sd-stat"><span>القيمة (CLV)</span><b>${typeof money==='function'?money(clv):clv} DH</b></div>
    <div class="sd-stat"><span>آخر ظهور</span><b>${timeAgo(cust.last_seen)}</b></div>
    <div class="sd-stat" style="border:none"><span>الوسوم</span><b>${(p.tags||cust.tags||'').split(',').filter(Boolean).slice(0,3).map(t=>esc(t.trim())).join('، ')||'—'}</b></div>
    </div>
    ${orders&&orders.length?`<div style="font-size:11px;font-weight:800;color:var(--text-3);text-align:right;margin:16px 0 7px">آخر الطلبات (${orders.length})</div>`+orders.slice(0,6).map(o=>`<div class="sd-stat"><span>${o.paid_at?'<span class="chip ok">مدفوع</span>':'<span class="chip gray">جديد</span>'}</span><span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:185px">${esc(String(o.product_name||('#'+o.id)))} · ${money(priceNum(o.price))} DH</span></div>`).join(''):'<div class="fm" style="text-align:center;padding:10px 0">لا طلبات بعد</div>'}
  </div>`;
  try{paintIcons(sp);}catch(_e){}
}
function ibxToggleSide(){ const sec=document.querySelector('.ibx2'); if(!sec)return; const hidden=sec.classList.toggle('no-side'); localStorage.setItem('ibxSide',hidden?'0':'1'); }
var _viewerMedia=[];var _viewerIdx=0;
function _ibxOpenViewer(url,mt){
  var msgs=window._chatMsgs||[];
  var all=[];
  msgs.forEach(function(m){
    var u=String(m.media_url||m.message||'').trim();
    if(!/^https?:\/\/\S+$/i.test(u))return;
    var t=String(m.media_type||'').toLowerCase();
    var isImg=t==='image'||/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|#|$)/i.test(u);
    var isVid=t==='video'||/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(u);
    if(isImg||isVid)all.push({url:u,type:isVid?'video':'image'});
  });
  if(!all.length)all=[{url:url,type:(mt||'image')}];
  _viewerMedia=all;
  _viewerIdx=Math.max(0,all.findIndex(function(m){return m.url===url;}));
  _ibxViewerRender();
}
function _ibxViewerRender(){
  var old=document.getElementById('ibx-viewer');if(old)old.remove();
  var m=_viewerMedia[_viewerIdx];if(!m)return;
  var total=_viewerMedia.length;
  var isVid=m.type==='video'||/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(m.url);
  var u=m.url.replace(/"/g,'%22');
  var mw='calc(100vw - 128px)';var mh='calc(100vh - 76px)';
  var mediaEl=isVid
    ?`<video src="${u}" controls autoplay style="width:${mw};height:${mh};object-fit:contain;border-radius:6px;display:block;outline:none;background:#000"></video>`
    :`<img id="ibx-vi" src="${u}" onerror="this.style.display='none'" style="max-width:${mw};max-height:${mh};object-fit:contain;border-radius:8px;display:block;cursor:zoom-in;transition:transform .2s;user-select:none" onclick="this._z=!this._z;this.style.transform=this._z?'scale(2.5)':'scale(1)';this.style.cursor=this._z?'zoom-out':'zoom-in'">`;
  var aS="border:none;cursor:pointer;width:48px;height:48px;min-width:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:background .15s;color:#fff;font-size:30px;font-weight:300;line-height:1";
  var prev=_viewerIdx>0
    ?`<button onclick="_ibxViewerNav(-1)" style="${aS};background:rgba(255,255,255,.18)">‹</button>`
    :`<div style="width:48px;min-width:48px"></div>`;
  var next=_viewerIdx<total-1
    ?`<button onclick="_ibxViewerNav(1)" style="${aS};background:rgba(255,255,255,.18)">›</button>`
    :`<div style="width:48px;min-width:48px"></div>`;
  var dl=`<a href="${u}" download style="color:rgba(255,255,255,.82);width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.13);display:inline-flex;align-items:center;justify-content:center;font-size:15px;text-decoration:none" title="تحميل">⬇</a>`;
  var ov=document.createElement('div');
  ov.id='ibx-viewer';
  ov.style.cssText='position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;user-select:none;direction:ltr';
  ov.innerHTML=
    `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:rgba(0,0,0,.7);flex-shrink:0;min-height:52px">`+
      `<span style="color:rgba(255,255,255,.85);font-size:13px;font-weight:600">${_viewerIdx+1} / ${total}</span>`+
      `<div style="display:flex;gap:8px;align-items:center">${dl}<button onclick="_ibxViewerClose()" style="background:rgba(255,255,255,.13);border:none;color:rgba(255,255,255,.85);font-size:16px;cursor:pointer;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center">✕</button></div>`+
    `</div>`+
    `<div style="flex:1;display:flex;align-items:center;gap:10px;min-height:0;padding:10px 10px">`+
      prev+
      `<div style="flex:1;display:flex;align-items:center;justify-content:center;min-width:0;height:100%;overflow:auto">${mediaEl}</div>`+
      next+
    `</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click',function(e){if(e.target===ov)_ibxViewerClose();});
  document._ibxVEsc=function(e){
    if(e.key==='Escape')_ibxViewerClose();
    else if(e.key==='ArrowLeft')_ibxViewerNav(-1);
    else if(e.key==='ArrowRight')_ibxViewerNav(1);
  };
  document.addEventListener('keydown',document._ibxVEsc);
  var _tx=null;
  ov.addEventListener('touchstart',function(e){_tx=e.touches[0].clientX;},{passive:true});
  ov.addEventListener('touchend',function(e){if(_tx===null)return;var dx=e.changedTouches[0].clientX-_tx;_tx=null;if(Math.abs(dx)>50)_ibxViewerNav(dx>0?-1:1);},{passive:true});
}
function _ibxViewerNav(d){_viewerIdx=Math.max(0,Math.min(_viewerMedia.length-1,_viewerIdx+d));_ibxViewerRender();}
function _ibxViewerClose(){var el=document.getElementById('ibx-viewer');if(el)el.remove();if(document._ibxVEsc){document.removeEventListener('keydown',document._ibxVEsc);delete document._ibxVEsc;}}
function _ibxIsImg(url,mt){return String(mt||'').toLowerCase()==='image'||/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|#|$)/i.test(String(url||''));}
function _ibxGroupMsgs(msgs,sid){
  const res=[];let i=0;
  while(i<msgs.length){
    const m=msgs[i];
    const url=String(m.media_url||m.message||'').trim();
    if(_ibxIsImg(url,m.media_type)){
      const grp=[{m,i}];let j=i+1;
      while(j<msgs.length){
        const nm=msgs[j];
        const nu=String(nm.media_url||nm.message||'').trim();
        const td=Math.abs(new Date(nm.created_at)-new Date(m.created_at));
        if(nm.role===m.role&&_ibxIsImg(nu,nm.media_type)&&td<90000&&grp.length<9){grp.push({m:nm,i:j});j++;}
        else break;
      }
      if(grp.length>=2){res.push({type:'grid',items:grp,role:m.role});i=j;}
      else{res.push({type:'single',m,i});i++;}
    }else{res.push({type:'single',m,i});i++;}
  }
  return res;
}
function _ibxMediaGrid(items,role,sid){
  const n=items.length;const MAX=4;const shown=items.slice(0,MAX);const extra=n-MAX;
  const cols=n===2?2:n===3?3:2;
  const rc=role==='user'?'user':(role==='operator'?'operator':'ai');
  const ms=rc==='user'?'margin-right:auto;margin-left:0':'margin-left:auto;margin-right:0';
  const ch=cols===2?136:90;
  const cells=shown.map(({m},idx)=>{
    const u=esc(String(m.media_url||m.message||'').trim());
    const isLast=idx===MAX-1&&extra>0;
    const ov=isLast?`<div style="position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:#fff;pointer-events:none">+${extra+1}</div>`:'';
    return `<div data-url="${u}" onclick="_ibxOpenViewer(this.dataset.url,'image')" style="cursor:pointer;overflow:hidden;border-radius:6px;background:#111827;position:relative;height:${ch}px"><img src="${u}" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.style.opacity:.15">${ov}</div>`;
  }).join('');
  return `<div class="bubble ${rc}" style="${ms};padding:4px;max-width:290px"><div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:3px">${cells}</div><div class="bt" style="padding:0 2px">${dt(items[items.length-1].m.created_at)}</div></div>`;
}
function _msgPreview(msg){ msg=String(msg||'').trim(); if(!msg)return ''; if(/^https?:\/\/\S+$/i.test(msg)){if(/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|#|$)/i.test(msg))return '🖼 صورة';if(/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(msg))return '📹 فيديو';if(/\.(mp3|wav|m4a|aac|oga|ogg)(\?|#|$)/i.test(msg))return '🎤 رسالة صوتية';if(/\.(pdf|doc|docx|xls|xlsx|ppt|zip|rar)(\?|#|$)/i.test(msg))return '📄 ملف';return '📎 وسائط';} return msg; }
function _ibxMediaHtml(msg,mediaType){ msg=String(msg||'').trim(); if(!/^https?:\/\/\S+$/i.test(msg))return null; const u=esc(msg); const mt=String(mediaType||'').toLowerCase(); if(mt==='audio'||/\.(mp3|wav|m4a|aac|oga)(\?|#|$)/i.test(msg)||(mt!=='video'&&/\.ogg(\?|#|$)/i.test(msg)))return `<audio controls preload="metadata" style="display:block;width:260px;max-width:100%;height:40px;margin:2px 0;border-radius:8px"><source src="${u}">🎤</audio>`; if(mt==='video'||/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(msg))return `<div data-murl='${u}' style='position:relative;display:inline-block;margin:2px 0'><video src="${u}" preload='metadata' style='max-width:300px;max-height:360px;border-radius:14px;display:block'></video><div onclick='_ibxOpenViewer(this.parentElement.dataset.murl,"video")' style='position:absolute;inset:0;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:14px;background:rgba(0,0,0,.25)'><div style='width:48px;height:48px;border-radius:50%;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px'>&#9654;</div></div></div>`; if(mt==='image'||/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|#|$)/i.test(msg))return `<img src="${u}" loading="lazy" onerror="this.outerHTML='🖼 صورة'" onclick="_ibxOpenViewer(this.src,'image')" style="max-width:320px;max-height:420px;border-radius:14px;object-fit:cover;cursor:pointer;display:block;margin:2px 0">`; if(mt==='document'||mt==='file'||/\.(pdf|doc|docx|xls|xlsx|ppt|zip|rar)(\?|#|$)/i.test(msg)){const name=u.split('/').pop().split('?')[0].slice(0,40)||'ملف';return `<a href="${u}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;padding:9px 12px;background:var(--raised);border-radius:10px;text-decoration:none;color:var(--text);font-size:13px;max-width:240px;margin:2px 0">📄 <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span></a>`;} return `<img src="${u}" loading="lazy" onerror="this.outerHTML='📎 ملف'" onclick="_ibxOpenViewer(this.src,'image')" style="max-width:320px;max-height:420px;border-radius:14px;object-fit:cover;cursor:pointer;display:block;margin:2px 0">`; }
function _ibxBubble(m,i,sid){ const role=m.role==='user'?'user':(m.role==='operator'?'operator':'ai'); const tag=m.role==='operator'?'<span class="bmeta">👤 مشغّل</span>':(role==='ai'?'<span class="bmeta">🤖 ذكاء</span>':''); const fix=role==='ai'?` <button class="iconbtn" style="opacity:.6;font-size:12px;padding:0 4px" title="صحّح وعلّم" onclick="event.stopPropagation();fixAiReply('${sid}',${i})">✏️</button>`:''; const mediaHtml=_ibxMediaHtml(m.media_url||m.message,m.media_type); const isUrl=s=>/^https?:\/\/\S+$/i.test(String(s||'').trim()); const hasCaption=mediaHtml&&m.message&&m.media_url&&m.message!==m.media_url&&!isUrl(m.message); const caption=hasCaption?`<div style="font-size:13px;padding:5px 2px 0;line-height:1.4">${esc(m.message)}</div>`:''; const body=mediaHtml?(mediaHtml+caption):esc(m.message); return `<div class="bubble ${role}" style="${role==='user'?'margin-right:auto;margin-left:0':'margin-left:auto;margin-right:0'}">${tag}${body}${fix}<div class="bt">${dt(m.created_at)}</div></div>`; } /* alignment ONLY (physical margins, dir-independent): customer(user)=LEFT, AI+operator=RIGHT — all message types (text/image/video/audio/file) share this bubble */
function ibxRenderConv(sid){ sid=String(sid); const pane=$('#ibx2-conv-pane'); if(!pane||!window._cust)return;
  const h=window._cust.chat||[]; const msgs=(h||[]).slice(-40); window._chatMsgs=msgs;
  const stopped=window._cust.aiStopped; const intel=(window._ibxCust&&window._ibxCust.intel)||null;
  const cust=(_ibxRoster||[]).filter(x=>String(x.subscriber_id)===sid)[0]||{}; const cc=_ibxClassify(cust);
  const prob=intel&&(intel.probability!=null?intel.probability:(intel.purchase_probability!=null?intel.purchase_probability:null));
  const nba=intel&&(intel.recommended_action||intel.next_best_action||intel.action);
  pane.innerHTML=`
    <div class="row between" style="padding:13px 22px;border-bottom:1px solid var(--line);flex-shrink:0;gap:12px">
      <div style="display:flex;align-items:center;gap:8px;position:relative">
        <button class="iconbtn" title="خيارات المحادثة" onclick="event.stopPropagation();ibxHdrMenuToggle()" style="width:34px;height:34px;border-radius:8px;background:var(--panel);font-size:20px;font-weight:800;line-height:1;color:var(--text-2)">⋮</button>
        <div id="ibx-hdr-menu" onclick="event.stopPropagation()" style="display:none;position:absolute;top:42px;right:0;z-index:50;width:236px;background:var(--panel-2);border:1px solid var(--border-2);border-radius:11px;padding:6px;box-shadow:0 16px 40px rgba(0,0,0,.6)">
          <div onclick="ibxHdrMenuClose();ibxToggleSide()" style="padding:8px 10px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:700;color:var(--text);text-align:right">👤 معلومات الزبون</div>
          <div style="height:1px;background:var(--border);margin:4px 0"></div>
          ${stopped?`<div onclick="ibxHdrMenuClose();resumeAI('${sid}')" style="padding:8px 10px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:800;color:var(--ok);text-align:right">▶️ إرجاع للذكاء (تشغيل)</div>`:`<div onclick="ibxHdrMenuClose();takeOver('${sid}')" style="padding:8px 10px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:800;color:var(--warn);text-align:right">🚨 تدخّل بشري (تجميد)</div>`}
          <div style="height:1px;background:var(--border);margin:4px 0"></div>
          <div style="font-size:10.5px;color:var(--text-3);font-weight:800;padding:5px 10px 4px;text-align:right">صنّف الزبون</div>
          ${['buy','recharge','payment','support','question','human'].map(k=>`<div onclick="ibxHdrMenuClose();ibxSetCat('${sid}','${k}')" style="padding:7px 10px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:700;color:${cc.cat===k?'var(--accent-2)':'var(--text)'};text-align:right">${_IBXCAT[k][0]} ${_IBXCAT[k][1]}${cc.cat===k?' ✓':''}</div>`).join('')}
          <div onclick="ibxHdrMenuClose();ibxSetCat('${sid}','none')" style="padding:7px 10px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:700;color:var(--bad);text-align:right">❌ إزالة التصنيف</div>
          <div style="height:1px;background:var(--border);margin:4px 0"></div>
          <div onclick="ibxHdrMenuClose();ibxDone('${sid}')" style="padding:8px 10px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:800;color:var(--text);text-align:right">${icon('check')} إنهاء المحادثة</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:11px;flex-direction:row-reverse;min-width:0">
        <div class="avatar-sm" style="width:42px;height:42px;border-radius:50%;font-size:15px;flex:none;background:${_avColor(sid)}">${esc(initials(cust.customer_name))}</div>
        <div style="text-align:right;min-width:0"><div style="display:flex;align-items:center;gap:8px;flex-direction:row-reverse"><b style="font-size:15px;font-weight:800">${esc(cust.customer_name||'زبون')}</b>${prob!=null?`<span style="padding:2px 9px;border-radius:6px;font-size:10.5px;font-weight:800;background:rgba(255,82,82,.16);color:#FF5252">🔥 شراء ${prob}%</span>`:''}</div><div class="num fm" style="font-size:11.5px;color:var(--text-3)">${chanChip(cust.channel)} · #${esc(sid)} · <span id="ibx2-aistatus">${aiStatusChip(stopped)}</span></div></div>
      </div></div>
    ${nba?`<div style="flex-shrink:0;display:flex;align-items:center;gap:10px;padding:11px 22px;background:rgba(20,117,225,.08);border-bottom:1px solid var(--line)"><span style="font-size:15px">✨</span><span style="font-size:13px;color:#dbe9ff;font-weight:600">${esc(nba)}</span></div>`:''}
    <div id="chatbox" style="flex:1;overflow-y:auto;min-height:0;padding:26px 30px">${msgs.length?_ibxGroupMsgs(msgs,sid).map(g=>g.type==='grid'?_ibxMediaGrid(g.items,g.role,sid):_ibxBubble(g.m,g.i,sid)).join(''):empty('msg','لا رسائل')}</div>
    <div class="dr-reply"><div id="ibx-attach-preview" style="display:none"></div><div class="dr-bar">
      <button class="btn primary" onclick="sendReply('${sid}')" title="إرسال">${icon('send')}</button>
      <textarea class="ta" id="reply-txt" rows="1" placeholder="رد (سيُفعّل التدخّل البشري)… Enter للإرسال" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendReply('${sid}')}"></textarea>
      <button class="btn ghost" onclick="ibxPickFile()" title="إرفاق صورة/فيديو/ملف">📎</button>
      <button class="btn ghost" onclick="suggestReply('${sid}')" title="اقتراح Hermes">${icon('spark2')}</button>
      <button class="btn ghost" onclick="openMacros('${sid}')" title="ردود جاهزة">${icon('msg')}</button>
    </div><input type="file" id="ibx-file" accept="image/*,video/*,application/pdf" style="display:none" onchange="ibxFileChosen(this)"></div>`;
  const cb=$('#chatbox'); if(cb)cb.scrollTop=cb.scrollHeight; try{paintIcons(pane);}catch(_e){}
  try{ if(window._ibxAttach&&window._ibxAttach.sid&&window._ibxAttach.sid!==sid){ibxClearAttach();} else if(typeof ibxRenderAttachPreview==='function'){ibxRenderAttachPreview();} }catch(_e){} // restore/clear pending attachment after any conv re-render (no ghost)
}
async function ibxRefreshThread(sid){ sid=String(sid); const cb=$('#chatbox'); if(!cb||!window._cust||String(window._cust.sid)!==sid)return; // update ONLY the messages in place (no full pane re-render → no flicker, composer + header stay, like WhatsApp)
  let h; try{ h=await api('/api/chat-history/'+sid); }catch(_e){ return; } if(!Array.isArray(h))return;
  const msgs=h.slice(-40); const prev=window._chatMsgs||[];
  if(msgs.length < prev.length) return; // server is BEHIND our live state (replication/SSE lag) → keep what's shown; never drop a just-arrived message
  const _tailSame = prev.length && msgs.length && msgs[msgs.length-1].role===prev[prev.length-1].role && (msgs[msgs.length-1].message||'')===(prev[prev.length-1].message||'') && (msgs[msgs.length-1].media_url||'')===(prev[prev.length-1].media_url||'');
  window._cust.chat=h; window._chatMsgs=msgs;
  const atBottom=(cb.scrollHeight-cb.scrollTop-cb.clientHeight)<140; const hasBubbles=!!cb.querySelector('.bubble');
  if(hasBubbles && msgs.length>prev.length){ for(let i=prev.length;i<msgs.length;i++) cb.insertAdjacentHTML('beforeend',_ibxBubble(msgs[i],i,sid)); } // append ONLY new messages → no rebuild, no flicker
  else if(!hasBubbles || !_tailSame){ cb.innerHTML=msgs.length?_ibxGroupMsgs(msgs,sid).map(g=>g.type==='grid'?_ibxMediaGrid(g.items,g.role,sid):_ibxBubble(g.m,g.i,sid)).join(''):empty('msg','لا رسائل'); } // rebuild only when the tail differs (catches the 40-cap roll-off where length is unchanged) — never on equal-length-same-tail
  if(atBottom)cb.scrollTop=cb.scrollHeight;
}
function ibxCloseConv(){ _ibxSel=null; const pane=$('#ibx2-conv-pane'); if(pane)pane.innerHTML=empty('msg','اختر محادثة','اضغط على أي زبون لفتح المحادثة هنا'); try{document.querySelectorAll('#ibx2-rows .fitem.active').forEach(e=>e.classList.remove('active'));}catch(_e){} }
/* ===== Pure realtime (WhatsApp Web): append ONE incoming bubble from SSE data — NO refetch, NO rebuild, keep scroll ===== */
function ibxAppendIncoming(sid,text,mediaUrl,role){ sid=String(sid); const cb=document.getElementById('chatbox'); if(!cb||!window._cust||String(window._cust.sid)!==sid)return; const m={role:(role||'user'),message:(text||''),media_url:(mediaUrl||null),created_at:new Date().toISOString()}; if(!Array.isArray(window._chatMsgs))window._chatMsgs=[]; const idx=window._chatMsgs.length; window._chatMsgs.push(m);
  try{ if(window._cust&&String(window._cust.sid)===sid){ if(!Array.isArray(window._cust.chat))window._cust.chat=[]; window._cust.chat.unshift(m); } }catch(_e){} /* keep _cust.chat (newest-first) in sync so a later re-render (AI toggle / resume / classify) NEVER drops an SSE-appended message */ const atBottom=(cb.scrollHeight-cb.scrollTop-cb.clientHeight)<170; if(!cb.querySelector('.bubble'))cb.innerHTML=''; cb.insertAdjacentHTML('beforeend',_ibxBubble(m,idx,sid)); if(atBottom)cb.scrollTop=cb.scrollHeight; }
/* Update ONLY one conversation row in place + move to top (no full list rebuild). Returns false → caller falls back to full render. */
function ibxUpdateRow(sid){ sid=String(sid); const rowsEl=document.getElementById('ibx2-rows'); if(!rowsEl)return false; if(['all','answered','need_reply'].indexOf(_ibxFilter)<0)return false; const data=(_ibxRoster||[]).filter(x=>String(x.subscriber_id)===sid)[0]; if(!data||data.inbox_closed)return false; if(_ibxFilter==='answered'&&_ibxWaiting(data))return false; if(_ibxFilter==='need_reply'&&!_ibxWaiting(data))return false; const tmp=document.createElement('div'); tmp.innerHTML=ibxRow(data); const fresh=tmp.firstElementChild; if(!fresh)return false; const old=document.getElementById('ibxrow-'+sid); if(old)old.remove(); rowsEl.insertBefore(fresh,rowsEl.firstChild); try{paintIcons(fresh);}catch(_e){} _ibxTabCounts(); return true; }
function ibxFilter(f){ _ibxFilter=f; document.querySelectorAll('#ibx2-tabs .tab').forEach(el=>el.classList.toggle('active',el.getAttribute('data-f')===f)); ibxRenderRows(); }
function ibxSearch(v){ _inboxSearch=v; clearTimeout(window._ibxT); window._ibxT=setTimeout(ibxRenderRows,200); }
async function renderInbox(){
  const valid=['need','priority','human','hot','all','snoozed','done'];
  if(!valid.includes(_inboxTab))_inboxTab='need';
  const counts=await api('/api/interventions/counts');
  const tabs=[['need','تحتاج تدخّل',counts&&counts.pending],['priority','الأولوية',''],['human','تحت تدخّل بشري',''],['hot','Hot',''],['all','الكل',''],['snoozed','مؤجّلة',''],['done','محلولة','']];
  const isRoster=['human','hot','all'].includes(_inboxTab);
  mount(phead('المحادثات','وحدة تشغيل مباشر · تدخّل بشري · رد بأقل عدد نقرات',`<button class="btn ghost" onclick="openMacros(null)">${icon('msg')} الردود الجاهزة</button>`)+
    `<div class="tabs">${tabs.map(t=>`<div class="tab ${t[0]===_inboxTab?'active':''}" onclick="_inboxTab='${t[0]}';_inboxSearch='';renderInbox()">${t[1]}${t[2]?`<span class="tb num">${t[2]}</span>`:''}</div>`).join('')}</div>
     ${isRoster?`<div class="ibx-search"><span class="s-ic">${icon('search')}</span><input class="inp" id="inbox-q" placeholder="ابحث باسم الزبون أو الرسالة أو المعرّف…" value="${esc(_inboxSearch||'')}" oninput="_inboxSearch=this.value;renderRoster()"></div>`:''}
     <div class="panel"><div id="inbox-list">${skel()}</div></div>`);
  loadInbox();
  if(isRoster){ const q=$('#inbox-q'); if(q){ q.focus(); q.setSelectionRange(q.value.length,q.value.length); } }
}
function renderRoster(){
  let rows=(window._roster||[]).slice(); const t=_inboxTab;
  if(t==='hot') rows=rows.filter(x=>x.stage==='hot');
  else if(t==='human') rows=rows.filter(x=>x.ai_stopped);
  const q=(_inboxSearch||'').trim().toLowerCase();
  if(q) rows=rows.filter(x=>((x.customer_name||'')+' '+(x.last_message||'')+' '+(x.interested_in||'')+' '+(x.subscriber_id||'')).toLowerCase().includes(q));
  rows=rows.sort((a,b)=>new Date(b.last_seen||0)-new Date(a.last_seen||0)).slice(0,80);
  fill('#inbox-list', rows.length? rows.map(custRow).join('') : empty('inbox', q?'لا نتائج مطابقة للبحث':(t==='human'?'لا زبائن تحت تدخّل بشري الآن':'لا محادثات هنا'),q?'جرّب كلمة أخرى.':'صندوق نظيف.'));
}
function slaChip(m){ m=Math.round(m||0); if(!m)return''; const txt=m>=60?(Math.floor(m/60)+'س'):(m+'د'); const cls=m<30?'ok':(m<120?'warn':'bad'); return `<span class="chip ${cls}">⏱ ${txt}</span>`; }
async function loadInbox(){
  const t=_inboxTab;
  if(t==='priority'){ renderPriorityQueue(); return; }
  if(t==='need'||t==='snoozed'||t==='done'){
    const st=t==='need'?'pending':(t==='snoozed'?'snoozed':'resolved');
    const d=await api('/api/interventions?status='+st+'&limit=80'); const rows=(d&&d.interventions)||[];
    fill('#inbox-list', rows.length? rows.map(ivRow).join('') : empty('inbox',t==='need'?'لا تدخّلات مفتوحة':(t==='snoozed'?'لا محادثات مؤجّلة':'لا محادثات محلولة'),'صندوق نظيف.'));
  } else {
    const c=await cached('customers',()=>api('/api/customers')); window._roster=(c||[]); renderRoster();
  }
}
async function renderPriorityQueue(){
  const d=await api('/hermes/priority-queue'); const tiers=(d&&d.tiers)||{}; const counts=(d&&d.counts)||{};
  const total=Math.max(1,(counts.buy_now||0)+(counts.follow_today||0)+(counts.warm||0)+(counts.cold||0));
  const meta={buy_now:['🥇','Buy Now','ok'],follow_today:['🥈','Follow Today','acc'],warm:['🥉','Warm','warn'],cold:['⚫','Cold','gray']};
  const keys=_pqFilter==='all'?['buy_now','follow_today','warm','cold']:[_pqFilter];
  let rows=[]; keys.forEach(k=>(tiers[k]||[]).forEach(c=>rows.push(Object.assign({tier:k},c))));
  fill('#inbox-list',`
    <div class="kpis" style="margin:14px 0">${Object.keys(meta).map(k=>`<div class="kpi ${_pqFilter===k?'a-'+meta[k][2]:''}" style="cursor:pointer" onclick="_pqFilter='${_pqFilter===k?'all':k}';renderPriorityQueue()"><div class="top"><div class="ic">${icon('user')}</div><div class="lbl">${meta[k][0]} ${meta[k][1]}</div></div><div class="val num">${counts[k]||0} <small>${Math.round((counts[k]||0)/total*100)}%</small></div></div>`).join('')}</div>
    <div class="filterbar">${[['all','الكل']].concat(Object.keys(meta).map(k=>[k,meta[k][0]+' '+meta[k][1]])).map(c=>`<button class="chipbtn ${c[0]===_pqFilter?'active':''}" onclick="_pqFilter='${c[0]}';renderPriorityQueue()">${esc(c[1])}</button>`).join('')}</div>
    <div class="panel"><div id="pq-list">${rows.length?rows.map(c=>`<div class="fitem" onclick="openCustomer('${c.subscriber_id}','chat')" style="padding:11px 16px;border-bottom:1px solid var(--border)"><div class="fic">${meta[c.tier][0]}</div>
      <div style="flex:1;min-width:0"><div class="row gap8 wrapf"><span class="ft">${esc(c.customer_name||'زبون')}</span> ${chanChip(c.channel)} <span class="chip ${meta[c.tier][2]}">${c.probability}%</span></div>
      <div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.reason||'')}</div></div>
      <div class="actions"><button class="btn primary sm" onclick="event.stopPropagation();openCustomer('${c.subscriber_id}','chat')">${icon('send')} فتح</button></div></div>`).join(''):empty('check','لا زبائن في هذه الفئة','جرّب فلتراً آخر.')}</div></div>`);
}
function ivRow(i){ const open=i.status==='pending';
  return `<div class="fitem" id="iv-${i.id}" onclick="openCustomer('${i.subscriber_id}','chat')" style="border-bottom:1px solid var(--border);padding:13px 16px">
  <div class="avatar-sm">${esc(initials(i.customer_name))}</div>
  <div style="flex:1;min-width:0"><div class="row gap8 wrapf"><span class="ft">${esc(i.customer_name||'زبون')}</span> ${chanChip(i.channel)} <span class="chip bad">${esc(({PAYMENT_INTENT:'نية دفع',HUMAN_REPEAT:'تكرار (حظر)',AI_LOOP_DETECTED:'تكرار AI',HUMAN_REQUESTED:'تدخل يدوي',UNKNOWN_QUESTION:'سؤال غير معروف',NO_CATALOG_MATCH:'لا منتج مطابق',CODE_SUBTYPE_UNAVAILABLE:'كود غير متوفر',SLOTS_COMPLETE:'معلومات مكتملة',SLOTS_STUCK:'معلومات متوقفة',CREDENTIALS:'معلومات حساسة',DELIVERY_REQUIRED:'تسليم مطلوب',PAYMENT_METHOD_HUMAN:'طريقة دفع',LOW_CONFIDENCE:'ثقة منخفضة',AI_REPLY_FAILED:'فشل AI',CUSTOMER_COMPLAINT:'شكاية',IMAGE_NOT_AVAILABLE:'صورة مفقودة',PRODUCT_MISMATCH:'رفض منتج',PRODUCT_NOT_FOUND:'منتج غير معروف',HOT_LEAD:'عميل حار',VISION_MATCH:'تطابق صورة'})[i.reason_code]||i.reason_code||'')}</span> ${open?slaChip(i.minutes_waiting):''}${i.status==='snoozed'&&i.snoozed_until?`<span class="chip gray">حتى ${dt(i.snoozed_until)}</span>`:''}</div>
  <div class="fm" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px">${esc(i.customer_message||i.reason_detail||'')}</div></div>
  <div class="actions">${i.status!=='resolved'?`<button class="btn ok sm" onclick="event.stopPropagation();resolveIv(${i.id})">${icon('check')} حلّ</button>`:'<span class="chip ok">محلول</span>'}
    ${open?`<button class="btn ghost sm" onclick="event.stopPropagation();snoozeIv(${i.id})">${icon('clock')}</button>`:''}</div></div>`; }
function custRow(x){ const hrs=x.hours_since_last!=null?parseFloat(x.hours_since_last):null; const stale=hrs!=null&&hrs>72; const stopped=x.ai_stopped; const sid=x.subscriber_id;
  return `<div class="fitem" id="cust-${sid}" onclick="openCustomer('${sid}','chat')" style="border-bottom:1px solid var(--border);padding:13px 16px">
  <div class="avatar-sm">${esc(initials(x.customer_name))}</div>
  <div style="flex:1;min-width:0"><div class="row gap8 wrapf"><span class="ft">${esc(x.customer_name||'زبون')}</span> ${chanChip(x.channel)} ${stageChip(x.stage)} ${aiStatusChip(stopped)} ${stale?'<span class="chip warn">راكد</span>':''}${stopped&&x.last_operator?`<span class="dim" style="font-size:11px">· ${esc(x.last_operator)}</span>`:''}</div>
  <div class="fm" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px">${esc(x.last_message||x.interested_in||'—')}</div></div>
  <div class="actions">${stopped?`<button class="btn ok sm" onclick="event.stopPropagation();resumeAI('${sid}')">${icon('spark2')} إرجاع للذكاء</button>`:`<button class="btn sm" onclick="event.stopPropagation();takeOver('${sid}')">${icon('user')} استلام</button>`}</div>
  <div class="fa">${timeAgo(x.last_seen)}</div></div>`; }
async function snoozeIv(id){ const el=$('#iv-'+id); const r=await send('/api/interventions/'+id+'/snooze','PATCH',{hours:4}); if(r){if(el){el.style.opacity=.3;setTimeout(()=>el.remove(),200);}refreshBadges();toast('أُجِّل 4 ساعات');}else toast('فشل','bad'); }
async function resolveIv(id){ const el=$('#iv-'+id); if(el)el.style.opacity=.3; const r=await send('/api/interventions/'+id+'/resolve','PATCH',{}); if(r){if(el)el.remove();refreshBadges();toast('تم وضع علامة محلول');}else{if(el)el.style.opacity=1;toast('فشل','bad');} }
async function dismissIv(id){ const el=$('#iv-'+id); if(el)el.style.opacity=.3; const r=await send('/api/interventions/'+id+'/dismiss','PATCH',{}); if(r){if(el)el.remove();refreshBadges();toast('تم التجاهل');}else{if(el)el.style.opacity=1;toast('فشل','bad');} }

/* ============================================================ SALES */
async function renderSales(){
  if(!['overview','warroom','claims','orders','insights','promos'].includes(_salesTab))_salesTab='overview';
  const tabs=[['overview','نظرة عامة'],['warroom','غرفة الحرب'],['claims','مطالبات الدفع'],['orders','الطلبات'],['insights','رؤى الإيراد'],['promos','العروض']];
  mount(phead('المبيعات','غرفة الحرب · مطالبات الدفع · الإيرادات · الطلبات',
    `<button class="btn ghost" onclick="window.open('${API}/api/export/orders','_blank')">${icon('ext')} تصدير</button>`)+
    `<div class="tabs">${tabs.map(t=>`<div class="tab ${t[0]===_salesTab?'active':''}" onclick="_salesTab='${t[0]}';renderSales()">${t[1]}</div>`).join('')}</div>
     <div id="sales-body">${skel()}</div>`);
  ({overview:salesOverview,warroom:salesWarRoom,claims:salesClaims,orders:salesOrders,insights:salesInsights,promos:salesPromos}[_salesTab]||salesOverview)();
}
async function salesClaims(){
  const [s,d]=await Promise.all([api('/api/payment-claims/stats'),api('/api/payment-claims?limit=200')]);
  const claims=(d&&d.claims)||[];
  const kpi=(ic,l,v,u,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}${u?` <small>${u}</small>`:''}</div></div>`;
  const stB=st=>st==='confirmed'?'<span class="chip ok">مؤكَّد</span>':(st==='rejected'?'<span class="chip bad">مرفوض</span>':'<span class="chip warn">معلّق</span>');
  fill('#sales-body',`
    <div class="kpis" style="margin-bottom:16px">
      ${kpi('card','معلّقة',(s&&s.pending)||0,'',((s&&s.pending)?'warn':''))}
      ${kpi('dollar','قيمة معلّقة',money((s&&s.pending_value)||0),'DH',((s&&s.pending_value)?'warn':''))}
      ${kpi('check','مؤكَّدة',(s&&s.confirmed)||0,'','ok')}
      ${kpi('x','مرفوضة',(s&&s.rejected)||0,'')}
    </div>
    <div class="panel"><div class="panel-h">${icon('card')}<h2>مطالبات الدفع</h2><span class="cnt">${claims.length}</span><span class="dim" style="font-size:11px;margin-inline-start:auto">القرار النهائي للبشر · سجل غير قابل للحذف</span></div>
      <div class="panel-b">${claims.length?`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>الزبون</th><th>المبلغ</th><th>بنك</th><th>صورة</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>${claims.map(c=>`<tr><td class="num" style="white-space:nowrap">${dt(c.created_at)}</td><td>${c.subscriber_id?`<span style="cursor:pointer;color:var(--accent)" onclick="openCustomer('${c.subscriber_id}','chat')">${esc(c.customer_name||'زبون')}</span>`:esc(c.customer_name||'—')}</td><td class="num">${c.amount?money(c.amount)+' '+esc(c.currency||'DH'):'—'}</td><td>${esc(c.bank||'—')}</td><td>${c.image_url&&String(c.image_url).startsWith('http')?`<a href="${esc(c.image_url)}" target="_blank">عرض</a>`:'—'}</td><td>${stB(c.status)}${c.confirmed_by?`<div class="dim" style="font-size:10.5px">${esc(c.confirmed_by)}</div>`:''}</td><td>${c.status==='pending'?`<div class="actions"><button class="btn ok sm" onclick="event.stopPropagation();pcConfirm(${c.id})">${icon('check')} تأكيد</button><button class="btn bad sm" onclick="event.stopPropagation();pcReject(${c.id})">${icon('x')}</button></div>`:'<span class="dim">—</span>'}</td></tr>`).join('')}</tbody></table></div>`:empty('card','لا مطالبات دفع','تظهر هنا عند ادّعاء زبون الدفع (تلقائياً من البوت لاحقاً، أو يدوياً) — مع سجل تدقيق غير قابل للحذف.')}</div></div>`);
}
async function pcConfirm(id){ if(!confirm('تأكيد استلام هذا الدفع نهائياً؟'))return; const r=await send('/api/payment-claims/'+id+'/confirm','PATCH',{confirmed_by:'operator'}); if(r){toast('تم تأكيد الدفع ✓');salesClaims();}else toast('فشل','bad'); }
async function pcReject(id){ const reason=prompt('سبب الرفض؟'); if(reason==null)return; const r=await send('/api/payment-claims/'+id+'/reject','PATCH',{reason:reason,actor:'operator'}); if(r){toast('تم رفض المطالبة');salesClaims();}else toast('فشل','bad'); }
async function salesWarRoom(){
  const [fn,kt,lost,pq,ords]=await Promise.all([api('/api/funnel'),api('/api/kpi/trend'),api('/api/lost-sales?hours=168'),api('/hermes/priority-queue'),cached('orders',()=>api('/api/orders?limit=12'))]);
  const num1=o=>{for(const k in o){if(/date|day/i.test(k))continue;const n=+o[k];if(!isNaN(n))return n}return 0};
  const spark=(arr,col)=>{const a=(arr||[]).slice(-10).map(num1);const mx=Math.max(1,...a);return a.length?`<div class="row" style="gap:3px;align-items:flex-end;height:40px;margin-top:6px">${a.map(v=>`<div title="${v}" style="flex:1;min-width:5px;background:${col||'var(--accent)'};opacity:.85;border-radius:3px 3px 0 0;height:${Math.max(4,Math.round(v/mx*40))}px"></div>`).join('')}</div>`:'<div class="dim" style="font-size:12px">لا بيانات</div>'};
  const stages=(fn&&fn.stages)||[]; const conv=(fn&&fn.overall_conversion_pct)||0; const drop=(fn&&fn.biggest_dropoff)||null;
  const byCh=(fn&&fn.by_channel)||[]; const byProd=(fn&&fn.by_product)||[]; const bestCh=(fn&&fn.best_channel)||null;
  const opps=(((pq&&pq.tiers&&pq.tiers.buy_now)||[]).concat((pq&&pq.tiers&&pq.tiers.follow_today)||[])).slice(0,6);
  const lostC=(lost&&lost.customers)||[]; const lostSum=(lost&&lost.summary)||{};
  const orders=(ords||[]).slice(0,8); const maxStage=Math.max(1,...stages.map(s=>s.count||0));
  fill('#sales-body',`
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px" class="warroom-trends">
      <div class="panel"><div class="panel-h">${icon('trend')}<h2>اتجاه الإيراد (مدفوعات)</h2></div><div class="panel-b">${spark((kt&&kt.daily_payments),'var(--ok)')}<div class="dim" style="font-size:11.5px;margin-top:4px">آخر 10 أيام</div></div></div>
      <div class="panel"><div class="panel-h">${icon('cart')}<h2>اتجاه الطلبات</h2></div><div class="panel-b">${spark((kt&&kt.daily_orders),'var(--accent)')}<div class="dim" style="font-size:11.5px;margin-top:4px">آخر 10 أيام</div></div></div>
      <div class="panel"><div class="panel-h">${icon('chart')}<h2>معدّل التحويل</h2></div><div class="panel-b"><div class="val num" style="font-size:30px">${conv}<small>%</small></div><div class="dim" style="font-size:12px">${drop?('أكبر تسرّب: '+esc(drop.label||drop.from||'')+(drop.dropoff_pct||drop.pct?(' ('+(drop.dropoff_pct||drop.pct)+'%)'):'')):'—'}</div></div></div>
    </div>
    <div class="panel" style="margin-bottom:16px"><div class="panel-h">${icon('chart')}<h2>قمع التحويل</h2><span class="dim" style="font-size:12px;margin-inline-start:auto">${(fn&&fn.data_period_days)||''} يوم</span></div><div class="panel-b">
      ${stages.length?stages.map(s=>`<div style="margin-bottom:11px"><div class="row between" style="font-size:12.5px;margin-bottom:4px"><span>${s.icon||''} ${esc(s.label||s.id)}</span><span class="num"><b>${s.count}</b> ${s.conv_to_next!=null?`<span class="dim">→ ${s.conv_to_next}%</span>`:''}</span></div><div class="funnel-bar"><span style="width:${Math.round((s.count||0)/maxStage*100)}%;background:${s.color||'var(--accent)'}"></span></div></div>`).join(''):empty('chart','لا بيانات قمع')}</div></div>
    <div class="split" style="margin-bottom:16px">
      <div class="panel"><div class="panel-h">${icon('package')}<h2>أعلى المنتجات (إيراد)</h2></div><div class="panel-b">${byProd.length?byProd.slice(0,6).map(p=>`<div class="row between mb16"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.product_name||p.product||'—')}</span><div class="row gap8"><span class="chip gray">${p.orders||0} طلب</span><b class="num">${money(parseInt(p.revenue_dh)||0)} DH</b></div></div>`).join(''):'<div class="dim">لا بيانات مبيعات بعد</div>'}</div></div>
      <div class="panel"><div class="panel-h">${icon('msg')}<h2>أعلى القنوات</h2>${bestCh?`<span class="chip ok" style="margin-inline-start:auto">الأفضل: ${esc(bestCh)}</span>`:''}</div><div class="panel-b">${byCh.length?byCh.slice(0,6).map(c=>`<div class="row between mb16"><span class="row gap8">${chanChip(c.channel||c.name)}<span>${esc(c.channel||c.name||'')}</span></span><div class="row gap8"><span class="chip gray">${c.customers||c.count||0}</span>${c.revenue_dh!=null?`<b class="num">${money(parseInt(c.revenue_dh)||0)} DH</b>`:''}</div></div>`).join(''):'<div class="dim">لا بيانات</div>'}</div></div>
    </div>
    <div class="split" style="margin-bottom:16px">
      <div class="panel"><div class="panel-h">${icon('trend')}<h2 style="color:var(--ok)">فرص البيع</h2><span class="cnt">${opps.length}</span></div><div class="panel-b">${opps.length?opps.map(o=>`<div class="fitem" onclick="openCustomer('${o.subscriber_id}','chat')" style="padding:9px 4px"><div class="fic">${icon('spark2')}</div><div style="flex:1;min-width:0"><div class="ft">${esc(o.customer_name||'زبون')} · ${o.probability}%</div><div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.reason||'')}</div></div></div>`).join(''):empty('check','لا فرص ساخنة الآن')}</div></div>
      <div class="panel"><div class="panel-h">${icon('alert')}<h2 style="color:var(--bad)">فرص ضائعة</h2><span class="cnt">${lostC.length}</span>${lostSum.total_est_revenue?`<span class="chip bad" style="margin-inline-start:auto">~${money(lostSum.total_est_revenue)} DH</span>`:''}</div><div class="panel-b">${lostC.length?lostC.slice(0,6).map(c=>`<div class="fitem" onclick="openCustomer('${c.subscriber_id}','chat')" style="padding:9px 4px"><div class="fic">${icon('refresh')}</div><div style="flex:1;min-width:0"><div class="ft">${esc(c.customer_name||'زبون')}</div><div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.interested_in||c.last_message||'')}</div></div><button class="btn ghost sm" onclick="event.stopPropagation();location.hash='#/recovery'">استرجاع</button></div>`).join(''):empty('check','لا فرص ضائعة')}</div></div>
    </div>
    <div class="panel"><div class="panel-h">${icon('activity')}<h2>تدفّق المبيعات المباشر</h2><span class="chip ok" style="margin-inline-start:auto">● حيّ</span></div><div class="panel-b">${orders.length?orders.map(o=>`<div class="fitem" ${o.subscriber_id?`onclick="openCustomer('${o.subscriber_id}','chat')"`:''} style="padding:9px 4px"><div class="fic">${icon(o.paid_at?'card':'cart')}</div><div style="flex:1;min-width:0"><div class="ft">#${o.id} ${esc(o.product_name||'')} ${o.paid_at?'<span class="chip ok">مدفوع</span>':'<span class="chip gray">جديد</span>'}</div><div class="fm">${esc(o.customer_name||'')} · ${money(priceNum(o.price))} DH</div></div><div class="fa">${timeAgo(o.created_at)}</div></div>`).join(''):empty('cart','لا طلبات بعد')}</div></div>`);
}
async function salesInsights(){
  const [rev,fn,kt,rec,lost]=await Promise.all([api('/api/revenue'),api('/api/funnel'),api('/api/kpi/trend'),api('/hermes/recovery'),api('/api/lost-sales?hours=168')]);
  const paid=rev&&rev.all_time?rev.all_time.count:0, paidRev=rev&&rev.all_time?rev.all_time.revenue:0;
  const pd=(rec&&rec.payment_discipline)||{}; const lockedRev=pd.unconfirmed_value||0, lockedN=pd.unconfirmed_count||0;
  const lostV=lost&&lost.summary?lost.summary.total_est_revenue:0;
  const drivers=(fn&&fn.by_product)||[]; const ch=(fn&&fn.by_channel)||[];
  const ordRev=drivers.reduce((s,p)=>s+(parseInt(p.revenue_dh)||0),0), ordN=drivers.reduce((s,p)=>s+(parseInt(p.orders)||0),0);
  const aovOrdered=ordN>0?Math.round(ordRev/ordN):0;
  const num1=o=>{for(const k in o){if(/date|day/i.test(k))continue;const n=+o[k];if(!isNaN(n))return n}return 0};
  const spark=arr=>{const a=(arr||[]).slice(-7).map(num1);const mx=Math.max(1,...a);return a.length?`<div class="row gap8" style="align-items:flex-end;height:36px;margin-top:4px">${a.map(v=>`<div title="${v}" style="flex:1;min-width:6px;background:var(--accent-soft);border-radius:3px 3px 0 0;height:${Math.max(6,Math.round(v/mx*36))}px"></div>`).join('')}</div>`:'<div class="dim" style="font-size:12px">لا بيانات</div>'};
  const card=(ic,l,v,u,a,sub)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}${u?` <small>${u}</small>`:''}</div>${sub?`<div class="sub">${sub}</div>`:''}</div>`;
  fill('#sales-body',`
    <div class="kpis" style="margin-bottom:18px">
      ${card('dollar','إيراد مؤكَّد',money(paidRev),'DH',paidRev>0?'ok':'',paid+' طلب مدفوع')}
      ${card('card','إيراد عالق غير مؤكَّد',money(lockedRev),'DH',lockedN>0?'warn':'',lockedN+' طلب — أكّدها')}
      ${card('cart','متوسط قيمة الطلب',money(aovOrdered),'DH','','من الطلبات المُنشأة')}
      ${card('trend','إيراد مفقود مقدّر',money(lostV),'DH',lostV>0?'bad':'','مبيعات لم تكتمل')}</div>
    <div class="split">
      <div class="panel"><div class="panel-h">${icon('trend')}<h2>اتجاهات الإيراد (7 أيام)</h2></div><div class="panel-b">
        <div class="muted" style="font-size:12px">الطلبات اليومية</div>${spark(kt&&kt.daily_orders)}
        <div class="muted" style="font-size:12px;margin-top:12px">المدفوعات المؤكَّدة اليومية</div>${spark(kt&&kt.daily_payments)}</div></div>
      <div class="panel"><div class="panel-h">${icon('alert')}<h2>تسرّب الإيراد (Funnel Leakage)</h2></div><div class="panel-b">
        ${fn&&fn.biggest_dropoff?`<div class="hcard" style="margin-bottom:10px"><div class="hi">⚠️</div><div class="hbody"><div class="htitle">${esc(fn.biggest_dropoff.label)} <span class="chip bad">-${fn.biggest_dropoff.dropoff_pct}%</span></div><div class="hreason">${fn.biggest_dropoff.from_count} → ${fn.biggest_dropoff.to_count} · أكبر نقطة تسرّب</div></div></div>`:''}
        ${kv('تحويل كلي',(fn?fn.overall_conversion_pct:0)+'%')}${kv('Hot → طلب',(fn?fn.hot_to_order_pct:0)+'%')}${kv('إيراد مفقود مقدّر',money(lostV)+' DH')}</div></div></div>
    <div class="split" style="margin-top:18px">
      <div class="panel"><div class="panel-h">${icon('dollar')}<h2>محرّكات الإيراد (حسب المنتج)</h2></div><div class="panel-b">
        ${drivers.length? drivers.map(p=>`<div class="row between mb16"><span>${esc(p.product_name)} <span class="dim">(${p.orders} طلب)</span></span><b class="num">${money(p.revenue_dh)} DH</b></div>`).join('') : empty('chart','لا بيانات')}</div></div>
      <div class="panel"><div class="panel-h">${icon('layers')}<h2>حسب القناة</h2></div><div class="panel-b">
        ${ch.length? ch.map(c=>`<div class="row between mb16"><span>${chanChip(c.channel)}</span><span class="dim num" style="font-size:12px">${c.total} زبون · ${c.order_rate}% طلب</span></div>`).join('') : empty('layers','—')}</div></div></div>
    <div class="panel" style="margin-top:18px"><div class="panel-b" style="font-size:13px"><b>📈 توقّع الإيراد (تقدير run-rate):</b>
      ${paid>0?` بناءً على وتيرة المدفوعات المؤكَّدة.`:` <span class="warn">0 DH — لا مدفوعات مؤكَّدة بعد.</span> خط الأنابيب الجاهز: <b class="ok">${money(lockedRev)} DH</b> بانتظار التأكيد + <b>${money(lostV)} DH</b> قابلة للاسترجاع. <span class="dim">يتحوّل لإيراد فعلي عند تأكيد المدفوعات.</span>`}</div></div>`);
}
async function salesPromos(){
  fill('#sales-body',`<div class="empty"><div class="ei">${icon('dollar')}</div><h3>العروض والكوبونات — مؤجّلة (Deferred)</h3>
    <p>إدارة العروض/الكوبونات تتطلب أن يتعرّف <b>البوت</b> على الأكواد ويطبّق الخصم داخل المحادثة. تحقّقنا: <b>0 منطق كوبونات في n8n</b> حالياً — لذا لن نعرضها كميزة عاملة.</p>
    <p class="dim">ستُفعَّل لاحقاً (بعد مرحلة الأمان) عبر: جدول أكواد + قراءة n8n للكود + تطبيق الخصم + تتبّع الأداء. نلتزم: لا ميزة تُعرض قبل ربطها فعلياً.</p></div>`);
}
async function salesOverview(){
  const [rev,fn]=await Promise.all([api('/api/revenue'),api('/api/funnel')]);
  const st=(l,v,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon('dollar')}</div><div class="lbl">${l}</div></div><div class="val num">${money(v)} <small>DH</small></div></div>`;
  const stages=(fn&&fn.stages)||[];
  fill('#sales-body',`
    <div class="kpis" style="margin-bottom:20px">${st('اليوم',rev&&rev.today?rev.today.revenue:0,'ok')}${st('هذا الشهر',rev&&rev.this_month?rev.this_month.revenue:0)}${st('الإجمالي',rev&&rev.all_time?rev.all_time.revenue:0)}
      <div class="kpi a-warn" style="cursor:pointer" onclick="_salesTab='orders';renderSales()"><div class="top"><div class="ic">${icon('card')}</div><div class="lbl">بانتظار التأكيد</div></div><div class="val num">${rev&&rev.by_status?rev.by_status.new:0}</div></div></div>
    <div class="split">
      <div class="panel"><div class="panel-h">${icon('chart')}<h2>قمع التحويل</h2><span class="cnt">${fn?fn.overall_conversion_pct:0}% تحويل</span></div>
        <div class="panel-b">${stages.map(s=>`<div class="mb16"><div class="row between" style="font-size:13px;margin-bottom:5px"><span>${s.icon||''} ${esc(s.label)}</span><b class="num">${s.count} <span class="dim">(${s.pct_of_top}%)</span></b></div><div class="bar"><i style="width:${Math.max(s.pct_of_top,2)}%"></i></div></div>`).join('')||empty('chart','لا بيانات')}</div></div>
      <div class="panel"><div class="panel-h">${icon('layers')}<h2>حسب القناة</h2></div><div class="panel-b">
        ${((fn&&fn.by_channel)||[]).map(c=>`<div class="row between mb16"><span>${chanChip(c.channel)}</span><span class="dim num" style="font-size:12px">${c.total} زبون · ${c.order_rate}% طلب</span></div>`).join('')||empty('layers','—')}
        ${fn&&fn.biggest_dropoff?`<div class="dr-sec">أكبر تسرّب</div><div class="chip bad">${esc(fn.biggest_dropoff.label)} · -${fn.biggest_dropoff.dropoff_pct}%</div>`:''}</div></div></div>`);
}
async function salesOrders(){
  const o=await cached('orders',()=>api('/api/orders?limit=200'),8000);
  fill('#sales-body',`<div class="panel tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>الزبون</th><th>المنتج</th><th>السعر</th><th>الحالة</th><th>التاريخ</th><th>إجراء</th></tr></thead>
    <tbody>${(o||[]).slice(0,100).map(x=>`<tr><td class="num dim">#${x.id}</td><td>${custLink(x.customer_name,x.subscriber_id)} ${chanChip(x.channel)}</td>
      <td>${esc(x.product_name||'—')}</td><td class="num"><b>${money(priceNum(x.price))}</b> DH</td><td>${stageChip(x.status)}</td><td class="dim num" style="font-size:12px">${dt(x.created_at)}</td>
      <td><div class="actions">${!x.paid_at?`<button class="btn ok sm" onclick="confirmPay(${x.id})">${icon('check')} دفع</button>`:(!x.delivered_at?`<button class="btn sm" onclick="deliverOrder(${x.id})">${icon('truck')} تسليم</button>`:`<span class="chip ok">${icon('check')} تم</span>`)}</div></td></tr>`).join('')||`<tr><td colspan="7">${empty('cart','لا طلبات')}</td></tr>`}</tbody></table></div>`);
}
/* ============================================================ RECOVERY & RETENTION */
let _recTab='overview';
function gotoRecovery(t){_recTab=t||'overview';location.hash='#/recovery';}
async function renderRecovery(){
  const tabs=[['center','المركز'],['overview','نظرة عامة'],['lost','مبيعات مفقودة'],['followups','المتابعات'],['renewals','التجديدات'],['repeat','التكرار'],['winback','الاسترجاع'],['churn','خطر التسرّب'],['broadcasts','الحملات']];
  if(!tabs.map(t=>t[0]).includes(_recTab))_recTab='center';
  mount(phead('الاسترجاع والاحتفاظ','مركز الاسترجاع · المبيعات المفقودة · التجديد · إعادة التفعيل')+
    `<div class="tabs">${tabs.map(t=>`<div class="tab ${t[0]===_recTab?'active':''}" onclick="_recTab='${t[0]}';renderRecovery()">${t[1]}</div>`).join('')}</div><div id="rec-body">${skel()}</div>`);
  ({center:recCenter,overview:recOverview,lost:recLost,followups:recFollowups,renewals:()=>recQueue('renewals'),repeat:()=>recQueue('repeat'),winback:()=>recQueue('winback'),churn:()=>recQueue('churn'),broadcasts:recBroadcasts}[_recTab]||recCenter)();
}
async function recOverview(){
  const [rec,rt,rc]=await Promise.all([api('/hermes/recovery'),api('/api/retention/stats'),api('/api/recovery/stats')]);
  const pd=(rec&&rec.payment_discipline)||{unconfirmed_count:0,unconfirmed_value:0}; const k=(rec&&rec.kpis)||{};
  const banner=pd.unconfirmed_count>0?`<div class="panel" style="border-color:rgba(255,176,32,.4);margin-bottom:18px"><div class="panel-b row between wrapf gap12">
      <div class="row gap12"><div style="width:42px;height:42px;border-radius:11px;background:var(--warn-soft);display:grid;place-items:center;color:var(--warn)">${icon('card')}</div>
      <div><div style="font-weight:700">${pd.unconfirmed_count} طلب بانتظار تأكيد الدفع · <span class="num">${money(pd.unconfirmed_value)}</span> DH</div>
      <div class="dim" style="font-size:12.5px">تأكيد المدفوعات هو ما يُشغّل محرك الإيراد والتجديد والاسترجاع بالكامل</div></div></div>
      <button class="btn primary" onclick="gotoSales('orders')">${icon('check')} أكّد الآن</button></div></div>`:'';
  const card=(ic,l,v,u,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}${u?` <small>${u}</small>`:''}</div></div>`;
  fill('#rec-body', banner+`
    <div class="kpis" style="margin-bottom:18px">
      ${card('dollar','CLV الإجمالي',money(k.clv_total),'DH',k.clv_total>0?'ok':'')}${card('user','زبائن دافعون',k.paying_customers||0)}
      ${card('refresh','تجديدات مستحقة',k.renewals_due||0,'',k.renewals_due>0?'warn':'')}${card('heart','مرشّحو التكرار',k.repeat||0)}
      ${card('trend','للاسترجاع',k.winback||0)}${card('alert','خطر تسرّب',k.churn_risk||0,'',k.churn_risk>0?'bad':'')}</div>
    ${(rec&&!rec.activated)?`<div class="panel" style="margin-bottom:18px"><div class="panel-b row gap12" style="align-items:flex-start">${icon('alert')}
      <div style="font-size:13px;color:var(--text-2)"><b style="color:var(--text)">محرك الاحتفاظ غير مفعّل بعد — لا توجد طلبات مدفوعة</b><br>التجديدات / التكرار / CLV / الاسترجاع تتفعّل <b>تلقائياً</b> بعد أول دفعة مؤكدة. الإجراء المطلوب: تأكيد المدفوعات.</div></div></div>`:''}
    <div class="split">
      <div class="panel"><div class="panel-h">${icon('refresh')}<h2>تحليلات الاسترجاع</h2></div><div class="panel-b">
        ${kv('طلبات بعد تدخّل',(rc&&rc.summary?rc.summary.orders_after_intervention:0))}${kv('إيراد مُسترَد',money(rc&&rc.summary?rc.summary.recovered_revenue_dh:0)+' DH')}${kv('تحويل بعد التدخّل',((rc&&rc.summary?rc.summary.conversion_rate:0))+'%')}</div></div>
      <div class="panel"><div class="panel-h">${icon('heart')}<h2>الاحتفاظ والمتابعات</h2></div><div class="panel-b">
        ${kv('معدل الاحتفاظ',((rt?rt.retention_rate:0))+'%')}${kv('متابعات أُرسلت',(rt&&rt.followup_conv?rt.followup_conv.total_sent:0))}${kv('أدّت لطلب',(rt&&rt.followup_conv?rt.followup_conv.led_to_order:0))}</div></div></div>`);
}
async function recCenter(){
  const [rescue,hrec,dr,lost]=await Promise.all([api('/api/rescue-queue'),api('/hermes/recovery'),cached('drafts',()=>api('/api/followup-drafts')),api('/api/lost-sales?hours=168&limit=60')]);
  const q=(rescue&&rescue.queue)||[]; const pd=(hrec&&hrec.payment_discipline)||{};
  const drafts=((dr&&dr.drafts)||[]).filter(x=>x.status==='draft'); const lc=(lost&&lost.customers)||[]; const ls=(lost&&lost.summary)||{};
  const kpi=(ic,l,v,u,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}${u?` <small>${u}</small>`:''}</div></div>`;
  fill('#rec-body',`
    <div class="kpis" style="margin-bottom:16px">
      ${kpi('trend','زبائن مفقودون',lc.length,'','bad')}
      ${kpi('dollar','إيراد مقدّر مفقود',money(ls.total_est_revenue||0),'DH','warn')}
      ${kpi('card','دفع غير مؤكَّد',money(pd.unconfirmed_value||0),'DH',(pd.unconfirmed_count?'warn':''))}
      ${kpi('alert','طابور الإنقاذ',(rescue&&rescue.total_pending)||0,'',((rescue&&rescue.total_critical)?'bad':''))}
      ${kpi('msg','مسودات متابعة',drafts.length,'',(drafts.length?'acc':''))}
    </div>
    <div class="split" style="margin-bottom:16px">
      <div class="panel"><div class="panel-h">${icon('alert')}<h2 style="color:var(--bad)">طابور الإنقاذ (أولوية)</h2><span class="cnt">${q.length}</span></div><div class="panel-b">
        ${q.length? q.slice(0,8).map(x=>`<div class="fitem" onclick="openCustomer('${x.subscriber_id}','chat')" style="padding:10px 4px;border-bottom:1px solid var(--border)"><div class="fic">${icon('refresh')}</div>
          <div style="flex:1;min-width:0"><div class="ft">${esc(x.customer_name||'زبون')} ${chanChip(x.channel)}${x.score?`<span class="chip ${x.score>=80?'bad':'warn'}">${x.score}</span>`:''}</div>
          <div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.trigger_type||'')} · ${esc((x.trigger_message||'').slice(0,40))}</div></div>
          <div class="actions"><button class="btn ok sm" onclick="event.stopPropagation();centerRescue(${x.id},'resolve')">${icon('check')}</button><button class="btn ghost sm" onclick="event.stopPropagation();centerRescue(${x.id},'dismiss')">${icon('x')}</button></div></div>`).join('') : empty('check','طابور الإنقاذ فارغ')}</div></div>
      <div class="panel"><div class="panel-h">${icon('msg')}<h2 style="color:var(--accent)">مسودات متابعة مقترحة</h2><span class="cnt">${drafts.length}</span></div><div class="panel-b">
        ${drafts.length? drafts.slice(0,8).map(x=>`<div class="hcard" style="margin-bottom:10px"><div class="hi">${icon('msg')}</div><div class="hbody"><div class="htitle">${custLink(x.customer_name,x.subscriber_id)} <span class="chip gray">${esc(x.category||'')}</span>${x.expected_revenue?`<span class="hval">${money(x.expected_revenue)} DH</span>`:''}</div>
          <div class="hreason" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.draft_message||'')}</div>
          <div class="hfoot"><button class="btn ok sm" onclick="centerDraft(${x.id},'approve')">${icon('check')} موافقة وإرسال</button><button class="btn bad sm" onclick="centerDraft(${x.id},'reject')">${icon('x')} رفض</button></div></div></div>`).join('') : empty('check','لا مسودات معلّقة','تُولَّد عبر الفحص الذكي (تبويب المتابعات).')}</div></div>
    </div>
    <div class="panel"><div class="panel-h">${icon('clock')}<h2>أهم الزبائن للاسترجاع (حسب القيمة)</h2><span class="cnt">${lc.length}</span><span class="chip ok" style="margin-inline-start:auto">● حيّ</span></div><div class="panel-b">
      ${lc.length? lc.slice(0,10).map(c=>`<div class="fitem" onclick="openCustomer('${c.subscriber_id}','chat')" style="padding:11px 4px;border-bottom:1px solid var(--border)"><div class="avatar-sm">${esc(initials(c.customer_name))}</div>
        <div style="flex:1;min-width:0"><div class="row gap8 wrapf"><b>${esc(c.customer_name||'زبون')}</b> ${chanChip(c.channel)} ${stageChip(c.stage)}</div><div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.interested_in||'')}${c.hours_inactive?(' · خامل '+esc(c.hours_inactive)+'س'):''}</div></div>
        <div class="row gap8"><div class="hval">${money(c.est_revenue)} DH</div><button class="btn primary sm" onclick="event.stopPropagation();openCustomer('${c.subscriber_id}','chat')">استرجاع</button></div></div>`).join('') : empty('check','لا زبائن مفقودين')}</div></div>`);
}
async function centerDraft(id,act){
  if(act==='approve'){ await send('/api/followup-drafts/'+id+'/approve','PATCH',{}); const r=await send('/api/followup-drafts/'+id+'/send','POST',{}); if(r){bust('drafts');toast('تمت الموافقة والإرسال ✓');refreshBadges();recCenter();}else toast('فشل الإرسال','bad'); }
  else { const r=await send('/api/followup-drafts/'+id+'/reject','PATCH',{}); if(r){bust('drafts');toast('تم الرفض');refreshBadges();recCenter();}else toast('فشل','bad'); }
}
async function centerRescue(id,act){ const r=await send('/api/rescue-queue/'+id+'/'+act,'PATCH',{}); if(r){toast(act==='resolve'?'تم الحل ✓':'تم التجاهل');refreshBadges();recCenter();}else toast('فشل','bad'); }
async function recLost(){
  const d=await api('/api/lost-sales?hours=48&limit=60'); const s=(d&&d.summary)||{};
  fill('#rec-body',`<div class="kpis" style="margin-bottom:18px">
      <div class="kpi a-bad" style="cursor:default"><div class="top"><div class="ic">${icon('trend')}</div><div class="lbl">إجمالي مفقود</div></div><div class="val num">${s.total||0}</div></div>
      <div class="kpi a-bad" style="cursor:default"><div class="top"><div class="ic">${icon('fire')}</div><div class="lbl">Hot مفقود</div></div><div class="val num">${s.hot||0}</div></div>
      <div class="kpi" style="cursor:default"><div class="top"><div class="ic">${icon('card')}</div><div class="lbl">دفع غير مكتمل</div></div><div class="val num">${s.payment||0}</div></div>
      <div class="kpi a-warn" style="cursor:default"><div class="top"><div class="ic">${icon('dollar')}</div><div class="lbl">إيراد مقدّر مفقود</div></div><div class="val num">${money(s.total_est_revenue)} <small>DH</small></div></div></div>
    <div class="panel"><div class="panel-h">${icon('clock')}<h2>زبائن للاسترداد</h2></div><div>${((d&&d.customers)||[]).map(c=>`<div class="fitem" onclick="openCustomer('${c.subscriber_id}','chat')" style="padding:13px 16px;border-bottom:1px solid var(--border)">
      <div class="avatar-sm">${esc(initials(c.customer_name))}</div><div style="flex:1"><div class="row gap8"><b>${esc(c.customer_name||'زبون')}</b> ${chanChip(c.channel)} ${stageChip(c.stage)}</div>
      <div class="fm">${esc(c.interested_in||'')} · خامل ${esc(c.hours_inactive)} ساعة</div></div><div class="hval">${money(c.est_revenue)} DH</div></div>`).join('')||empty('check','لا مبيعات مفقودة')}</div></div>`);
}
async function recFollowups(){
  const d=await cached('drafts',()=>api('/api/followup-drafts')); const drafts=(d&&d.drafts)||[]; const pend=drafts.filter(x=>x.status==='draft');
  fill('#rec-body',`<div class="panel"><div class="panel-h">${icon('msg')}<h2>مسودات المتابعة</h2><span class="cnt">${pend.length} بانتظار الموافقة</span></div>
    <div class="panel-b">${pend.length? pend.map(x=>`<div class="hcard" style="margin-bottom:12px"><div class="hi">${icon('msg')}</div>
      <div class="hbody"><div class="htitle">${custLink(x.customer_name,x.subscriber_id)} <span class="chip gray">${esc(x.category||'')}</span>${x.expected_revenue?`<span class="hval">${money(x.expected_revenue)} DH</span>`:''}</div>
      <div class="hreason">${esc(x.draft_message||'')}</div>
      <div class="hfoot"><button class="btn ok sm" onclick="draftAction(${x.id},'approve')">${icon('check')} موافقة وإرسال</button>
        <button class="btn bad sm" onclick="draftAction(${x.id},'reject')">${icon('x')} رفض</button></div></div></div>`).join('') : empty('check','لا مسودات معلّقة','تُولَّد المسودات يدوياً (الفحص الذكي).')}</div></div>`);
}
async function draftAction(id,act){
  if(act==='approve'){ await send('/api/followup-drafts/'+id+'/approve','PATCH',{}); const r=await send('/api/followup-drafts/'+id+'/send','POST',{}); if(r){bust('drafts');toast('تمت الموافقة والإرسال ✓');refreshBadges();recFollowups();}else toast('فشل الإرسال','bad'); }
  else { const r=await send('/api/followup-drafts/'+id+'/reject','PATCH',{}); if(r){bust('drafts');toast('تم الرفض');refreshBadges();recFollowups();}else toast('فشل','bad'); }
}
async function recQueue(type){
  const rec=await api('/hermes/recovery'); const q=(rec&&rec.queues&&rec.queues[type])||[]; const activated=rec&&rec.activated;
  const M={renewals:['التجديدات المستحقة','اشتراكات قاربت نهايتها — جدّدها قبل أن تنتهي','refresh'],
    repeat:['فرص الشراء المتكرر','زبائن سبق أن اشتروا وقد يعيدون الشراء','heart'],
    winback:['الاسترجاع (Win-Back)','زبائن دافعون توقّفوا — أعِد تفعيلهم','trend'],
    churn:['خطر التسرّب','زبائن دافعون بدأ تفاعلهم يتراجع','alert']}[type];
  if(!q.length){ fill('#rec-body',`<div class="panel"><div class="panel-h">${icon(M[2])}<h2>${M[0]}</h2></div><div class="panel-b">${
    activated? empty('check','لا شيء هنا الآن',M[1])
      : `<div class="empty"><div class="ei">${icon('card')}</div><h3>لا توجد طلبات مدفوعة بعد</h3><p>${esc(M[1])}.<br>تتفعّل هذه الوحدة تلقائياً بعد أول دفعة مؤكدة.</p><button class="btn primary" onclick="gotoSales('orders')">${icon('check')} اذهب لتأكيد المدفوعات</button></div>`}</div></div>`); return; }
  fill('#rec-body',`<div class="panel"><div class="panel-h">${icon(M[2])}<h2>${M[0]}</h2><span class="cnt">${q.length}</span></div><div>${
    q.map(c=>`<div class="fitem" onclick="openCustomer('${c.subscriber_id}','chat')" style="padding:13px 16px;border-bottom:1px solid var(--border)">
      <div class="avatar-sm">${esc(initials(c.customer_name))}</div><div style="flex:1"><div class="row gap8"><b>${esc(c.customer_name||'زبون')}</b> ${chanChip(c.channel)}</div>
      <div class="fm">${esc(c.product_name||c.interested_in||'')}${c.days!=null?' · منذ '+c.days+' يوم':''}</div></div>
      <button class="btn sm" onclick="event.stopPropagation();openCustomer('${c.subscriber_id}','chat')">${icon('send')} تواصل</button></div>`).join('')}</div></div>`);
}
async function recBroadcasts(){
  const list=await api('/api/broadcasts'); const bs=list||[];
  fill('#rec-body',`<div class="panel" style="margin-bottom:18px"><div class="panel-h">${icon('send')}<h2>حملة جديدة</h2></div><div class="panel-b">
      <label class="lbl-f">العنوان</label><input class="inp" id="bc-title" style="margin-bottom:10px" placeholder="عرض خاص">
      <label class="lbl-f">الرسالة</label><textarea class="ta" id="bc-msg" rows="3" style="margin-bottom:10px" placeholder="نص الحملة…"></textarea>
      <div class="row between wrapf gap12"><div style="flex:1;min-width:160px;max-width:220px"><label class="lbl-f">الفئة المستهدفة</label>
        <select class="inp" id="bc-target"><option value="all">الكل</option><option value="hot">Hot</option><option value="interested">مهتمون</option><option value="lost">مفقودون</option><option value="paid">دافعون</option></select></div>
        <button class="btn primary" onclick="createBroadcast()">${icon('send')} إنشاء وإرسال</button></div></div></div>
    <div class="panel"><div class="panel-h">${icon('msg')}<h2>الحملات السابقة</h2><span class="cnt">${bs.length}</span></div><div>${
      bs.length? bs.map(b=>`<div class="row between" style="padding:12px 16px;border-bottom:1px solid var(--border)"><div style="min-width:0"><b>${esc(b.title||'(بلا عنوان)')}</b> <span class="chip ${b.status==='sent'?'ok':'gray'}">${esc(b.status||'')}</span>
        <div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px">${esc((b.message||'').slice(0,70))} · ${esc(b.target_stage||'all')}</div></div>
        ${b.status!=='sent'?`<button class="btn sm" onclick="sendBroadcast(${b.id})">${icon('send')} إرسال</button>`:`<span class="dim num" style="font-size:12px">${dt(b.created_at)}</span>`}</div>`).join('') : empty('msg','لا حملات بعد')}</div></div>`);
}
async function createBroadcast(){ const title=$('#bc-title').value.trim(), message=$('#bc-msg').value.trim(), target_stage=$('#bc-target').value;
  if(!message){toast('اكتب نص الحملة','bad');return;}
  const b=await send('/api/broadcasts','POST',{title,message,target_stage}); if(!b||!b.id){toast('فشل إنشاء الحملة','bad');return;}
  if(confirm('إرسال الحملة الآن إلى فئة ('+target_stage+')؟')){ const s=await send('/api/broadcasts/'+b.id+'/send','POST',{}); toast(s?'تم إرسال الحملة ✓':'حُفظت كمسودة (تعذّر الإرسال)',s?'ok':'bad'); } else toast('حُفظت كمسودة');
  recBroadcasts(); }
async function sendBroadcast(id){ if(!confirm('إرسال هذه الحملة الآن؟'))return; const s=await send('/api/broadcasts/'+id+'/send','POST',{}); toast(s?'تم الإرسال ✓':'فشل الإرسال',s?'ok':'bad'); recBroadcasts(); }

/* ============================================================ CATALOG */
let _catTab='products', _catSearch='', _catCat='all'; window._prods={};
async function renderCatalog(){
  const tabs=[['products','المنتجات'],['intel','ذكاء المنتجات'],['requests','الطلبات']];
  mount(phead('السلع','إدارة المنتجات · الذكاء · الطلب',
    `<button class="btn primary" onclick="openProductForm(0)">${icon('package')} إضافة منتج</button> <button class="btn" onclick="openBulkPaste()">📋 لصق بالجملة</button> <button class="btn ghost" onclick="renderCatalog()">${icon('refresh')}</button>`)+
    `<div class="tabs">${tabs.map(t=>`<div class="tab ${t[0]===_catTab?'active':''}" onclick="_catTab='${t[0]}';renderCatalog()">${t[1]}</div>`).join('')}</div><div id="cat-body">${skel()}</div>`);
  ({products:catProducts,intel:catIntel,requests:catRequests}[_catTab]||catProducts)();
}
async function catProducts(){
  const p=await api('/api/products'); const prods=p||[]; window._prods={}; prods.forEach(x=>window._prods[x.id]=x);
  const catDefs=[['all','الكل'],['recharge','شحن'],['account','حسابات'],['subscription','اشتراكات'],['code','أكواد']];
  const filtered=prods.filter(p=>{
    const svcKey=_pfInferSvc(p);
    const pt=(_pfTpls()[svcKey]||{}).pt||p.product_type||'';
    const matchCat=_catCat==='all'||pt===_catCat||(p.category||'').toLowerCase().includes(_catCat);
    const q=_catSearch.trim().toLowerCase();
    return matchCat&&(!q||(p.product_name||'').toLowerCase().includes(q));
  });
  const pills=catDefs.map(([k,l])=>`<span class="pill${_catCat===k?' active':''}" onclick="_catCat='${k}';catProducts()">${l}</span>`).join('');
  fill('#cat-body',`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
      <div style="flex:1;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:var(--panel);border:1px solid var(--border-2);">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="2.4" stroke-linecap="round"><path d="M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4-4"/></svg>
        <input style="flex:1;border:none;background:transparent;color:var(--text);font-size:13.5px;font-family:inherit;outline:none;" placeholder="ابحث عن منتج…" value="${esc(_catSearch)}" oninput="_catSearch=this.value;catProducts()">
      </div>
      <div class="pills">${pills}</div>
    </div>
    <div class="grid g4">${filtered.map(prodCard).join('')||empty('package','لا منتجات','أضف أول منتج بزر «إضافة منتج».')}</div>
  `);
}
function _resCountdown(endsAt){ if(!endsAt) return '—'; var diff=new Date(endsAt)-Date.now(); if(diff<=0) return '⏰ انتهى'; var d=Math.floor(diff/86400000),h=Math.floor((diff%86400000)/3600000),m=Math.floor((diff%3600000)/60000); return (d>0?d+'ي ':'')+h+'س '+m+'د'; }
function _updateReservationCountdowns(){ document.querySelectorAll('[data-res-ends]').forEach(function(el){ el.textContent=_resCountdown(el.dataset.resEnds); }); }
setInterval(_updateReservationCountdowns,60000);
// ── Status helpers ────────────────────────────────────────────────────────────
var LC_STATUS={
  available:          {bg:'rgba(0,200,80,.18)',  color:'#00C850', txt:'🟢 متاح'},
  reserved:           {bg:'rgba(255,176,32,.22)',color:'#FFB020', txt:'🟡 محجوز'},
  deposit_paid:       {bg:'rgba(255,176,32,.22)',color:'#FFB020', txt:'🟠 العربون مدفوع'},
  waiting_full_payment:{bg:'rgba(255,140,0,.22)',color:'#FF8C00', txt:'🔒 انتظار الباقي'},
  pending_review:     {bg:'rgba(138,43,226,.22)',color:'#8A2BE2', txt:'📷 مراجعة الدفع'},
  waiting_customer_reply:{bg:'rgba(30,144,255,.22)',color:'#1E90FF',txt:'💬 انتظار الرد'},
  sold:               {bg:'rgba(255,60,60,.18)', color:'#FF5050', txt:'✅ مباع'},
  delivered:          {bg:'rgba(0,200,80,.22)',  color:'#00A040', txt:'📦 تم التسليم'},
  inactive:           {bg:'rgba(140,140,140,.18)',color:'var(--text-3)',txt:'⚫ مخفي'},
};
function _lcBadge(st){ var s=LC_STATUS[st]||LC_STATUS.inactive; return {badgeBg:s.bg,badgeColor:s.color,badgeTxt:s.txt}; }
var LC_ACTIVE_STATUSES=['reserved','deposit_paid','waiting_full_payment','pending_review','waiting_customer_reply'];

function prodCard(p){
  var st=p.status||'available';
  var isAvail=st==='available', isSold=st==='sold'||st==='delivered';
  var isActive=LC_ACTIVE_STATUSES.indexOf(st)!==-1;
  var bg=p.bg_color||_catBg(p);
  var svc=_pfInferSvc(p); var tpl=_pfTpls()[svc]||{};
  var b=_lcBadge(st); var badgeBg=b.badgeBg,badgeColor=b.badgeColor,badgeTxt=b.badgeTxt;
  var extraInfo='';
  if(isActive&&p.reservation_ends_at){
    var countdown=_resCountdown(p.reservation_ends_at);
    extraInfo='<div style="font-size:11px;background:rgba(255,176,32,.09);border-radius:7px;padding:8px 10px;margin-bottom:10px;">'
      +'<div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span style="color:var(--text-3)">الزبون</span><b>'+esc(p.reserved_by_name||p.reserved_by||'—')+'</b></div>'
      +(p.deposit_paid?'<div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span style="color:var(--text-3)">عربون</span><b>'+esc(String(p.deposit_paid))+' DH</b></div>':'')
      +(p.remaining_amount?'<div style="display:flex;justify-content:space-between;margin-bottom:3px;"><span style="color:var(--text-3)">متبقي</span><b>'+esc(String(p.remaining_amount))+' DH</b></div>':'')
      +'<div style="display:flex;justify-content:space-between;align-items:center;">'
        +'<span style="color:var(--text-3)">الوقت</span>'
        +'<b data-res-ends="'+esc(p.reservation_ends_at)+'" style="color:#FFB020;font-size:12px;">'+countdown+'</b>'
      +'</div></div>';
  }
  if(isSold&&p.sold_at){
    var sd=new Date(p.sold_at); var ds=sd.getDate()+'/'+(sd.getMonth()+1)+'/'+sd.getFullYear();
    extraInfo='<div style="font-size:11px;color:var(--text-3);background:rgba(255,60,60,.07);border-radius:7px;padding:6px 10px;margin-bottom:10px;">مباع: '+ds+'</div>';
  }
  var toggleBtn='';
  if(isAvail) toggleBtn='<span style="width:35px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:var(--panel-2);cursor:pointer;" onclick="toggleProduct('+p.id+',\'inactive\')" title="إخفاء"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10 10 0 0112 20c-7 0-11-8-11-8a18.5 18.5 0 015-5.94M1 1l22 22"/></svg></span>';
  else if(st==='inactive') toggleBtn='<span style="width:35px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:var(--panel-2);cursor:pointer;" onclick="toggleProduct('+p.id+',\'available\')" title="إظهار"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8"/><circle cx="12" cy="12" r="3"/></svg></span>';
  var detailsBigBtn='<span style="flex:1;text-align:center;padding:8px;border-radius:8px;background:'+badgeColor+';color:#fff;font-size:12.5px;font-weight:800;cursor:pointer;opacity:.9;" onclick="openProductDetail('+p.id+')">عرض التفاصيل ›</span>';
  var detailsSmBtn='<span style="width:35px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:var(--panel-2);cursor:pointer;font-size:15px;" onclick="openProductDetail('+p.id+')" title="عرض التفاصيل">👁</span>';
  var editBtn=isSold?'':(isActive?'<span style="width:35px;text-align:center;padding:8px;border-radius:8px;background:var(--accent);font-size:12.5px;font-weight:800;cursor:pointer;" onclick="openProductForm('+p.id+')">✏️</span>':'<span style="flex:1;text-align:center;padding:8px;border-radius:8px;background:var(--accent);font-size:12.5px;font-weight:800;cursor:pointer;" onclick="openProductForm('+p.id+')">تعديل</span>');
  return '<div class="prodcard" style="cursor:pointer">'
    +'<div style="position:relative;height:110px;background:'+bg+';display:flex;align-items:flex-end;padding:12px;overflow:hidden;">'
      +(p.image_url?'<img src="'+esc(p.image_url)+'" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;">':'')
      +(p.image_url?'<div style="position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.65) 0%,rgba(0,0,0,.15) 55%,rgba(0,0,0,.05) 100%);"></div>':'')
      +'<span style="position:absolute;top:9px;left:10px;font-size:10.5px;font-weight:800;padding:3px 8px;border-radius:6px;background:'+badgeBg+';color:'+badgeColor+'">'+badgeTxt+'</span>'
      +(p.enable_reservation&&isAvail?'<span style="position:absolute;top:9px;right:10px;font-size:10px;padding:2px 6px;border-radius:5px;background:rgba(0,0,0,.35);color:#FFB020;">🔒 قابل للحجز</span>':'')
      +'<span style="position:relative;font-size:14px;font-weight:800;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.5);white-space:pre-line;line-height:1.2;">'+esc(p.product_name)+'</span>'
    +'</div>'
    +'<div style="padding:13px 15px;">'
      +extraInfo
      +'<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:9px;">'
        +'<span style="font-size:11px;color:var(--text-3);font-weight:700;">'+esc(p.category||tpl.label||'')+'</span>'
        +'<span class="num" style="font-size:17px;font-weight:800;">'+esc(p.price||'—')+'</span>'
      +'</div>'
      +'<div style="display:flex;gap:10px;margin-bottom:12px;">'
        +'<span class="statline">👁 '+(p.view_count||0)+'</span>'
        +'<span class="statline">🛒 '+(p.order_count||0)+'</span>'
      +'</div>'
      +'<div style="display:flex;gap:7px;">'
        +(isSold?detailsBigBtn:(isActive?detailsBigBtn:editBtn))
        +(isSold||isActive?'':('<span style="width:35px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:var(--panel-2);cursor:pointer;font-size:14px;" onclick="duplicateProduct('+p.id+')" title="نسخ">📋</span>'))
        +(isSold?'':(isActive?editBtn:detailsSmBtn))
        +(!isSold&&!isActive?toggleBtn:'')
      +'</div>'
    +'</div>'
  +'</div>';
}
function _catBg(p){
  const svc=_pfInferSvc(p);
  return {game_topup_id:'linear-gradient(150deg,#1d4ed8,#0ea5e9)',game_topup_account:'linear-gradient(150deg,#1d4ed8,#0ea5e9)',ready_account:'linear-gradient(150deg,#ea580c,#dc2626)',digital_code:'linear-gradient(150deg,#db2777,#9d174d)',subscription:'linear-gradient(150deg,#7c3aed,#4f46e5)',social_growth:'linear-gradient(150deg,#7c3aed,#c026d3)',iptv:'linear-gradient(150deg,#0d9488,#155e75)',custom_service:'linear-gradient(150deg,#475569,#0f172a)'}[svc]||'linear-gradient(150deg,#1475E1,#3B86E8)';
}
function _pfTpls(){ return {
  game_topup_id:     {label:'🎮 شحن ألعاب بالـID', pt:'recharge', proven:true,  g:{game:1,pkg:1,req:1}, desc:'شحن مباشر بالـID ديال اللاعب — كيعطي الـID وكنشحنو', req:[{field:'player_id',label:'الـID ديال اللاعب',required:true},{field:'server_region',label:'السيرفر/المنطقة',required:false}]},
  game_topup_account:{label:'🎮 شحن بحساب (Login)', pt:'recharge', proven:false, g:{game:1,pkg:1,req:1,security:1}, desc:'شحن عبر تسجيل الدخول للحساب', req:[{field:'account_login',label:'إيميل/يوزر الحساب',required:true},{field:'account_password',label:'كلمة السر',required:true},{field:'twofa',label:'كود 2FA إذا مفعّل',required:false}]},
  ready_account:     {label:'👤 حسابات جاهزة', pt:'account', proven:true, g:{game:1,account:1}, desc:'بيع حساب جاهز (رتبة/سكينات) — تسليم الحساب', req:[]},
  social_growth:     {label:'📈 زيادة متابعين', pt:'social', proven:false, g:{social:1,pkg:1,req:1}, desc:'متابعين/لايكات/مشاهدات — كيعطي رابط البروفايل', req:[{field:'profile_url',label:'رابط البروفايل (لازم عمومي)',required:true},{field:'public_account',label:'الحساب عمومي؟',required:true}]},
  iptv:              {label:'📺 IPTV', pt:'iptv', proven:false, g:{iptv:1,pkg:1,req:1}, desc:'اشتراكات IPTV حسب المدة والأجهزة', req:[{field:'device_type',label:'نوع الجهاز',required:true}]},
  digital_code:      {label:'🎟️ أكواد رقمية', pt:'code', proven:true, g:{code:1,pkg:1}, desc:'كود رقمي (سكن/شحن/بطاقة) — تسليم كود', req:[]},
  subscription:      {label:'🔑 اشتراكات', pt:'subscription', proven:false, g:{sub:1,pkg:1,req:1}, desc:'Netflix/Spotify… حسب المدة', req:[{field:'account_email',label:'إيميل الحساب',required:true}]},
  custom_service:    {label:'🛠️ خدمة مخصصة', pt:'custom', proven:false, g:{req:1,pkg:1}, desc:'خدمة تحدد متطلباتها بنفسك', req:[]}
}; }
function _pfInferSvc(p){ if(p.service_type) return p.service_type; var m={account:'ready_account',code:'digital_code',recharge:'game_topup_id',digital:'digital_code'}; return m[String(p.product_type||'').toLowerCase()]||'game_topup_id'; }
function _pfOpts(arr,sel){ return '<option value=""></option>'+arr.map(function(o){return '<option value="'+o+'" '+(sel===o?'selected':'')+'>'+o+'</option>';}).join(''); }
function _pfReqQuickOpts(){ var d=[['player_id','الـID ديال اللاعب'],['account_login','إيميل/يوزر الحساب'],['account_password','كلمة السر'],['profile_url','رابط البروفايل'],['account_email','إيميل الحساب'],['server_region','السيرفر/المنطقة'],['device_type','نوع الجهاز']]; return d.map(function(x){return '<option value="'+x[0]+'">'+x[1]+'</option>';}).join(''); }
function _pfPkgRow(x){ x=x||{}; var e=function(s){return esc(s!=null?String(s):'');}; var nm=(x.amount!=null&&x.amount!=='')?x.amount:(x.name||''); return '<div class="row gap8 pkg-row" style="margin-bottom:6px;align-items:center"><input class="inp pkg-name" placeholder="الكمية/الاسم" value="'+e(nm)+'" style="flex:2"><input class="inp pkg-price" placeholder="الثمن" value="'+e(x.price)+'" style="flex:1"><input class="inp pkg-sale" placeholder="تخفيض" value="'+e(x.sale_price)+'" style="width:80px"><input class="inp pkg-stock" placeholder="مخزون" value="'+e(x.stock)+'" style="width:68px"><input class="inp pkg-badge" placeholder="badge" value="'+e(x.badge)+'" style="width:88px"><label style="font-size:11px;white-space:nowrap"><input type="checkbox" class="pkg-pop" '+(x.popular?'checked':'')+'> شائع</label><button class="btn sm" onclick="this.closest(\'.pkg-row\').remove();pfUpdateComplete()">✕</button></div>'; }
function _pfReqRow(x){ x=x||{}; var e=function(s){return esc(s!=null?String(s):'');}; return '<div class="row gap8 req-row" style="margin-bottom:6px;align-items:center"><input class="inp req-field" placeholder="key (player_id)" value="'+e(x.field)+'" style="flex:1"><input class="inp req-label" placeholder="السؤال للزبون" value="'+e(x.label)+'" style="flex:2"><label style="font-size:11px;white-space:nowrap"><input type="checkbox" class="req-required" '+(x.required?'checked':'')+'> إجباري</label><button class="btn sm" onclick="this.closest(\'.req-row\').remove();pfUpdateComplete()">✕</button></div>'; }
function pfPkgAdd(){ var c=document.getElementById('pf-pkg-rows'); if(c) c.insertAdjacentHTML('beforeend',_pfPkgRow({})); }
function pfReqAdd(key){ var c=document.getElementById('pf-req-rows'); if(!c) return; var P={player_id:'الـID ديال اللاعب',account_login:'إيميل/يوزر الحساب',account_password:'كلمة السر',profile_url:'رابط البروفايل',account_email:'إيميل الحساب',server_region:'السيرفر/المنطقة',device_type:'نوع الجهاز'}; c.insertAdjacentHTML('beforeend',_pfReqRow(key?{field:key,label:P[key]||key,required:(key!=='server_region')}:{})); }
function _pfCollectPkgs(){ var rows=document.querySelectorAll('#pf-pkg-rows .pkg-row'); var out=[]; rows.forEach(function(r){ var gv=function(c){var e=r.querySelector('.'+c);return e?e.value.trim():'';}; var nm=gv('pkg-name'),pr=gv('pkg-price'); if(!nm&&!pr) return; var o={amount:nm,name:nm,price:pr}; var s=gv('pkg-sale'); if(s)o.sale_price=s; var st=gv('pkg-stock'); if(st)o.stock=st; var bd=gv('pkg-badge'); if(bd)o.badge=bd; var pe=r.querySelector('.pkg-pop'); if(pe&&pe.checked)o.popular=true; out.push(o); }); if(!out.length){ var raw=document.getElementById('pf-pkgs-raw'); if(raw&&raw.value.trim()){ try{ var j=JSON.parse(raw.value.trim()); if(Array.isArray(j)) return j; }catch(e){} } } return out; }
function _pfCollectReqs(){ var rows=document.querySelectorAll('#pf-req-rows .req-row'); var out=[]; rows.forEach(function(r){ var gv=function(c){var e=r.querySelector('.'+c);return e?e.value.trim():'';}; var f=gv('req-field'); if(!f) return; var ce=r.querySelector('.req-required'); out.push({field:f,label:gv('req-label')||f,required:!!(ce&&ce.checked)}); }); return out; }
function _pfCollectAttr(){ var o={}; var ids={platform:'pf-attr-platform',service:'pf-attr-service',bouquet:'pf-attr-bouquet',device_count:'pf-attr-devcount',supported_devices:'pf-attr-devices',account_type:'pf-attr-acctype',app_type:'pf-attr-app',start_time:'pf-attr-start',completion_time:'pf-attr-completion',renewal_note:'pf-attr-renewal'}; Object.keys(ids).forEach(function(k){ var e=document.getElementById(ids[k]); if(e&&e.value.trim()) o[k]=e.value.trim(); }); return o; }
var _pfS={data:{}};
var _PF_FMAP={'pf-name':'product_name','pf-cat':'category','pf-game':'game','pf-img':'image_url','pf-price':'price','pf-minprice':'min_price','pf-sale':'max_discount','pf-usd':'price_usd','pf-eur':'price_eur','pf-cost':'cost_price','pf-desc':'description','pf-feat':'key_features','pf-benef':'key_benefits','pf-keywords':'keywords','pf-related':'related_products','pf-proof':'proof_str','pf-target':'target_customer','pf-angle':'selling_angle','pf-objections':'objections','pf-dnr':'do_not_recommend','pf-social':'social_proof','pf-guarantee':'guarantee_note','pf-dpromise':'delivery_promise','pf-risk':'risk_notes','pf-delivery':'delivery_time','pf-stock':'stock','pf-rank':'account_rank','pf-evo':'evo_count','pf-aplat':'account_platform','pf-link':'account_link_type','pf-codetype':'code_type','pf-code':'product_code','pf-wa':'whatsapp_url','pf-ig':'instagram_url','pf-fb':'facebook_url','pf-purl':'product_url'};
// pf-svc: type dropdown — handled separately in _pfSaveStep
function _pfNorm(p){ var d=Object.assign({},p); var pk=d.recharge_packages; if(typeof pk==='string'){try{pk=JSON.parse(pk);}catch(e){pk=[];}} d.recharge_packages=Array.isArray(pk)?pk:[]; var rq=d.buyer_requirements; if(typeof rq==='string'){try{rq=JSON.parse(rq);}catch(e){rq=[];}} d.buyer_requirements=Array.isArray(rq)?rq:[]; var at=d.attributes; if(typeof at==='string'){try{at=JSON.parse(at);}catch(e){at={};}} d.attributes=(at&&typeof at==='object')?at:{}; if(Array.isArray(d.proof_images)) d.proof_str=d.proof_images.join(', '); else if(typeof d.proof_images==='string') d.proof_str=d.proof_images; return d; }
function _pfTa(id,label,val,rows){ return '<label class="lbl-f">'+label+'</label><textarea class="ta" id="'+id+'" rows="'+(rows||2)+'" style="margin-bottom:10px">'+esc(val!=null?val:'')+'</textarea>'; }
function _pfMissing(d,svc){ var miss=[]; var a=d.attributes||{}; var hasPkg=(d.recharge_packages||[]).some(function(x){return x&&(x.amount||x.name)&&x.price;}); var has=function(v){return v!=null&&String(v).trim()!=='';};
  if(!has(d.product_name)) miss.push('الاسم');
  var R={game_topup_id:['game','pp'],game_topup_account:['game','pp'],ready_account:['game','price','feat','link'],digital_code:['price','codetype'],social_growth:['ap','as','pp'],iptv:['pp'],subscription:['price'],custom_service:['pp']};
  (R[svc]||[]).forEach(function(k){ if(k==='game'&&!has(d.game))miss.push('اللعبة'); else if(k==='price'&&!has(d.price))miss.push('السعر'); else if(k==='pp'&&!has(d.price)&&!hasPkg)miss.push('سعر أو باقة'); else if(k==='feat'&&!has(d.key_features))miss.push('المميزات'); else if(k==='link'&&!has(d.account_link_type))miss.push('نوع الربط'); else if(k==='codetype'&&!has(d.code_type))miss.push('نوع الكود'); else if(k==='ap'&&!has(a.platform))miss.push('المنصة'); else if(k==='as'&&!has(a.service))miss.push('الخدمة'); });
  return miss; }
function _pfSaveStep(){ var d=_pfS.data; Object.keys(_PF_FMAP).forEach(function(idv){ var e=document.getElementById(idv); if(e) d[_PF_FMAP[idv]]=e.value.trim(); }); var sv=document.getElementById('pf-svc'); if(sv&&sv.value) _pfS.svc=sv.value; if(document.getElementById('pf-pkg-rows')) d.recharge_packages=_pfCollectPkgs(); if(document.getElementById('pf-req-rows')) d.buyer_requirements=_pfCollectReqs(); var ap=_pfCollectAttr(); if(Object.keys(ap).length) d.attributes=Object.assign({},d.attributes||{},ap); var enR=document.getElementById('pf-res-enable'); if(enR){ d.enable_reservation=enR.checked; var dep=document.getElementById('pf-res-deposit'); if(dep) d.min_deposit=dep.value.trim()||null; var dur=document.getElementById('pf-res-duration'); if(dur) d.reservation_duration_days=parseInt(dur.value)||5; var ref=document.getElementById('pf-res-refundable'); if(ref) d.deposit_refundable=ref.checked; var aft=document.querySelector('input[name="pf-res-after"]:checked'); if(aft) d.after_expiration=aft.value; var msg=document.getElementById('pf-res-msg'); if(msg) d.reservation_message=msg.value.trim()||null; } }
var _PF_STEPS=[{k:'basics',l:'الأساسيات',ic:'📦'},{k:'dna',l:'DNA البيع',ic:'🧬'},{k:'payment',l:'الدفع',ic:'💳'},{k:'reservation',l:'الحجز',ic:'🔒'},{k:'review',l:'مراجعة ونشر',ic:'🚀'}];
function openProductForm(id){
  var p=(id&&window._prods[id])?window._prods[id]:{}; var d=_pfNorm(p); var svc=_pfInferSvc(p);
  _pfS={id:id||0,isEdit:!!id,svc:svc||'game_topup_id',step:0,data:d,pays:{},payAccounts:null};
  if(!id&&!_pfS.data.buyer_requirements){var t=_pfTpls()[svc]||{};_pfS.data.buyer_requirements=(t.req||[]).slice();}
  _loadPayPrices(id||0);
}
async function _loadPayPrices(pid){
  try{ var ar=await fetch(API+'/api/payment-accounts',{headers:authHeaders()}); var aj=await ar.json().catch(function(){return {};}); if(aj.ok&&aj.accounts) _pfS.payAccounts=aj.accounts; }catch(e){}
  if(pid){ try{ var r=await fetch(API+'/api/product-payment-prices/'+pid,{headers:authHeaders()}); var j=await r.json().catch(function(){return {};}); if(j.ok&&j.data){ j.data.forEach(function(row){ _pfS.pays[row.method_key]=_pfS.pays[row.method_key]||{}; _pfS.pays[row.method_key].on=!!row.enabled; _pfS.pays[row.method_key].fee=String(row.price_value||''); _pfS.pays[row.method_key].unit=row.currency||'MAD'; _pfS.pays[row.method_key].reason=row.note||''; }); } }catch(e){} }
  _pfRenderWizard();
}
function pfPickType(svc){ _pfSaveStep(); _pfS.svc=svc; var t=_pfTpls()[svc]||{}; if(!(_pfS.data.buyer_requirements&&_pfS.data.buyer_requirements.length)){ _pfS.data.buyer_requirements=(t.req||[]).slice(); } _pfRenderWizard(); }
function pfGo(target){ _pfSaveStep(); if(target==='next')_pfS.step++; else if(target==='prev')_pfS.step--; else _pfS.step=parseInt(target,10)||0; _pfS.step=Math.max(0,Math.min(_pfS.step,_PF_STEPS.length-1)); _pfRenderWizard(); }
function _pfRenderWizard(){
  var svc=_pfS.svc; var t=_pfTpls()[svc]||{}; var d=_pfS.data;
  var si=_pfS.step;
  var sideHTML=_PF_STEPS.map(function(s,i){
    var cls=i===si?'pf-active':(i<si?'pf-done':'');
    return '<div class="pf-step-item '+cls+'" onclick="_pfSaveStep();_pfS.step='+i+';_pfRenderWizard()">'
      +'<div class="pf-step-n">'+(i<si?'✓':(i+1))+'</div>'
      +'<div><div class="pf-step-lbl">'+s.l+'</div></div>'
      +'</div>';
  }).join('');
  var prevName=esc(d.product_name||'اسم المنتج');
  var prevPrice=(d.recharge_packages&&d.recharge_packages[0]&&d.recharge_packages[0].price)?d.recharge_packages[0].price:(d.price||'—');
  var prevBg=d.image_url?('url('+esc(d.image_url)+')'):'linear-gradient(135deg,var(--accent),#8B8DF7)';
  var side='<div class="pf-side">'
    +'<div style="font-size:10.5px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.08em;padding:2px 12px;margin-bottom:10px;">الخطوات</div>'
    +sideHTML
    +'<div class="pf-prev-card" style="margin-top:auto;">'
    +'<div class="pf-prev-banner" style="background:'+prevBg+';background-size:cover;">'
    +'<span id="pf-prev-name" style="font-size:12px;font-weight:800;color:#fff;text-shadow:0 2px 6px rgba(0,0,0,.5);">'+prevName+'</span>'
    +'</div>'
    +'<div style="padding:10px 13px;">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'
    +'<span id="pf-prev-type" style="font-size:11px;color:var(--text-3);">'+esc(t.label||svc)+'</span>'
    +'<span id="pf-prev-price" class="num" style="font-size:15px;font-weight:800;">'+esc(String(prevPrice))+'</span>'
    +'</div>'
    +'<div style="font-size:10.5px;color:var(--text-3);">معاينة حية</div>'
    +'</div>'
    +'</div>'
    +'</div>';
  var last=(si===_PF_STEPS.length-1);
  var footHTML='<div style="display:flex;gap:10px;margin-top:28px;border-top:1px solid var(--border);padding-top:20px;">'
    +(si>0?'<button class="btn ghost" onclick="pfGo(\'prev\')">‹ السابق</button>':'')
    +'<div style="flex:1;"></div>'
    +'<button class="btn" onclick="saveProduct(\'draft\')">💾 مسودة</button>'
    +(last?'<button class="btn primary" onclick="saveProduct(\'publish\')">🚀 نشر المنتج</button>'
         :'<button class="btn primary" onclick="pfGo(\'next\')">التالي ›</button>')
    +'</div>';
  var main='<div class="pf-main" oninput="pfUpdateComplete();_pfSyncPreview()">'
    +'<div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">'
    +'<span style="font-size:18px;">'+_PF_STEPS[si].ic+'</span>'
    +'<h2 style="margin:0;font-size:16px;font-weight:800;">'+_PF_STEPS[si].l+'</h2>'
    +'<div style="flex:1;"></div>'
    +'<div id="pf-complete" style="font-size:12px;"></div>'
    +'</div>'
    +_pfStepBody4(_PF_STEPS[si].k)
    +footHTML
    +'</div>';
  mount('<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0;padding:14px 20px 12px;border-bottom:1px solid var(--border);background:var(--panel);margin:-24px -30px 0;">'
    +'<button class="btn ghost sm" onclick="_pfSaveStep();renderCatalog()">‹ المنتجات</button>'
    +'<span style="font-size:15px;font-weight:800;">'+(_pfS.isEdit?'تعديل المنتج':'إضافة منتج جديد')+'</span>'
    +'<span style="font-size:12px;color:var(--text-3);font-weight:600;">'+esc(t.label||'')+'</span>'
    +'</div>'
    +'<div class="pf-wizard">'+side+main+'</div>');
  pfUpdateComplete();
}
function pfUpdateComplete(){ _pfSaveStep(); var miss=_pfMissing(_pfS.data,_pfS.svc); var el=document.getElementById('pf-complete'); if(el) el.innerHTML=miss.length?('<span class="chip warn">ناقص: '+miss.join('، ')+'</span>'):'<span class="chip ok">✓ كامل</span>'; var big=document.getElementById('pf-complete-big'); if(big) big.innerHTML=miss.length?('<div class="chip warn">ناقص قبل النشر: '+miss.join('، ')+'</div>'):'<div class="chip ok">✓ كامل وجاهز للنشر</div>'; }
function _pfSyncPreview(){
  var d=_pfS.data; var svc=_pfS.svc; var t=_pfTpls()[svc]||{};
  var n=document.getElementById('pf-name'); if(n){d.product_name=n.value;} var p2=document.getElementById('pf-prev-name'); if(p2) p2.textContent=d.product_name||'اسم المنتج';
  var pr=document.getElementById('pf-price'); if(pr)d.price=pr.value; var p3=document.getElementById('pf-prev-price'); if(p3) p3.textContent=d.price||'—';
  var pl=document.getElementById('pf-prev-type'); if(pl) pl.textContent=t.label||svc;
}

/* ================================================================
   M2: 4-STEP PRODUCT WIZARD BODY
   Steps: basics | dna | payment | review
================================================================ */
function _pfStepBody4(k){
  var d=_pfS.data; var svc=_pfS.svc; var t=_pfTpls()[svc]||{}; var G=t.g||{}; var a=d.attributes||{}; var H='';

  /* ── STEP 0: الأساسيات ──────────────────────────── */
  if(k==='basics'){
    // Type selector
    var TPL=_pfTpls(); var typeOpts=Object.keys(TPL).map(function(k2){var tt=TPL[k2]; return '<option value="'+k2+'"'+(k2===svc?' selected':'')+'>'+tt.label+'</option>';}).join('');
    H+='<div class="pf-grid2"><div><label class="lbl-f">اسم المنتج *</label><input class="inp" id="pf-name" value="'+esc(d.product_name||'')+'" placeholder="مثلا: شحن 580 جوهرة Free Fire"></div>'
      +'<div><label class="lbl-f">نوع المنتج *</label><select class="inp" id="pf-svc" onchange="pfPickType(this.value)">'+typeOpts+'</select></div></div>';
    // Category + SKU row
    H+='<div class="pf-grid2"><div><label class="lbl-f">الفئة</label><input class="inp" id="pf-cat" value="'+esc(d.category||'')+'" placeholder="شحن / حسابات / اشتراكات"></div>'
      +'<div><label class="lbl-f">SKU (اختياري)</label><input class="inp" id="pf-stock" value="'+esc(d.stock!=null?d.stock:'')+'" placeholder="مخزون متاح"></div></div>';
    // Dynamic fields per type
    if(G.game) H+='<div style="margin-bottom:12px;"><label class="lbl-f">اللعبة *</label><input class="inp" id="pf-game" value="'+esc(d.game||'')+'" placeholder="Free Fire, PUBG…"></div>';
    else H+='<input type="hidden" id="pf-game" value="'+esc(d.game||'')+'">';
    if(G.social) H+='<div class="pf-grid2"><div><label class="lbl-f">المنصة *</label><select class="inp" id="pf-attr-platform">'+_pfOpts(['instagram','tiktok','facebook','youtube','twitter'],a.platform)+'</select></div><div><label class="lbl-f">الخدمة *</label><select class="inp" id="pf-attr-service">'+_pfOpts(['followers','likes','views','comments','subscribers'],a.service)+'</select></div></div>';
    if(G.iptv) H+='<div class="pf-grid2"><div><label class="lbl-f">الباقة</label><input class="inp" id="pf-attr-bouquet" value="'+esc(a.bouquet||'')+'"></div><div><label class="lbl-f">التطبيق</label><input class="inp" id="pf-attr-app" value="'+esc(a.app_type||'')+'"></div></div>';
    if(G.sub) H+='<div class="pf-grid2"><div><label class="lbl-f">المنصة</label><input class="inp" id="pf-attr-platform" value="'+esc(a.platform||'')+'" placeholder="Netflix, Spotify…"></div><div><label class="lbl-f">نوع الحساب</label><select class="inp" id="pf-attr-acctype">'+_pfOpts(['shared','private','family'],a.account_type)+'</select></div></div>';
    if(G.account) H+='<div class="pf-grid2"><div><label class="lbl-f">الرتبة</label><input class="inp" id="pf-rank" value="'+esc(d.account_rank||'')+'"></div><div><label class="lbl-f">الإيفو</label><input class="inp" id="pf-evo" value="'+esc(d.evo_count||'')+'"></div></div>'
      +'<div class="pf-grid2"><div><label class="lbl-f">المنصة</label><input class="inp" id="pf-aplat" value="'+esc(d.account_platform||'')+'"></div><div><label class="lbl-f">نوع الربط *</label><input class="inp" id="pf-link" value="'+esc(d.account_link_type||'')+'" placeholder="فيسبوك / جيميل / إيميل"></div></div>';
    if(G.code) H+='<div class="pf-grid2"><div><label class="lbl-f">نوع الكود *</label><input class="inp" id="pf-codetype" value="'+esc(d.code_type||'')+'" placeholder="سكن / بطاقة شحن"></div><div><label class="lbl-f">الكود (اختياري)</label><input class="inp" id="pf-code" value="'+esc(d.product_code||'')+'"></div></div>';
    // Pricing
    H+='<div style="border-top:1px solid var(--border);margin:16px 0 14px;padding-top:14px;font-size:13px;font-weight:800;color:var(--accent-2);">💰 التسعير</div>';
    if(G.pkg){
      var rows=(d.recharge_packages||[]).map(function(x){return _pfPkgRow(x);}).join('')||_pfPkgRow({});
      H+='<div style="margin-bottom:10px;"><label class="lbl-f">الباقات / الكميات</label><div id="pf-pkg-rows">'+rows+'</div>'
        +'<button class="btn sm" style="margin-top:6px;" onclick="pfPkgAdd()">➕ إضافة كمية</button></div>';
    }
    H+='<div class="pf-grid3"><div><label class="lbl-f">السعر الأساسي'+(G.pkg?' (أو عبر الباقات)':' *')+'</label><input class="inp" id="pf-price" value="'+esc(d.price||'')+'" placeholder="120 DH"></div>'
      +'<div><label class="lbl-f">سعر التخفيض</label><input class="inp" id="pf-sale" value="'+esc(d.max_discount||'')+'" placeholder="100 DH"></div>'
      +'<div><label class="lbl-f">سعر التكلفة 🔒</label><input class="inp" id="pf-cost" value="'+esc(d.cost_price||'')+'" placeholder="80 DH"></div></div>';
    if(d.price&&d.cost_price){
      var prof=parseFloat(d.price)-parseFloat(d.cost_price);
      H+='<div style="padding:10px 14px;border-radius:8px;background:var(--ok-soft);color:var(--ok);font-size:13px;font-weight:700;margin-bottom:12px;">الربح: '+prof.toFixed(0)+' DH ≈ '+Math.round(prof/parseFloat(d.price)*100)+'%</div>';
    }
    // Buyer requirements (collapsible)
    H+='<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:13px;font-weight:700;color:var(--text-2);padding:8px 0;">📋 ما يطلبه AI من الزبون ('+(d.buyer_requirements||[]).length+' حقول)</summary>'
      +'<div style="margin-top:10px;"><div id="pf-req-rows">'+((d.buyer_requirements||[]).map(function(x){return _pfReqRow(x);}).join(''))+'</div>'
      +'<div class="row gap8" style="margin-top:8px;"><select class="inp" id="pf-req-quick" style="max-width:220px" onchange="if(this.value){pfReqAdd(this.value);this.value=\'\'}"><option value="">+ حقل سريع…</option>'+_pfReqQuickOpts()+'</select><button class="btn sm" onclick="pfReqAdd(\'\')">➕ حقل فارغ</button></div></div></details>';
    // Image
    H+='<div style="margin-top:14px;"><label class="lbl-f">صورة المنتج</label><div class="row gap8">'
      +'<input class="inp" id="pf-img" value="'+esc(d.image_url||'')+'" placeholder="رابط الصورة أو ارفع" style="flex:1;" oninput="var v=this.value;var pv=document.getElementById(\'pf-prev\');pv.src=v;pv.style.display=v?\'block\':\'none\'">'
      +'<label class="btn sm" style="cursor:pointer;">📷 رفع<input type="file" accept="image/*" onchange="pfUpload(this)" style="display:none;"></label></div>'
      +'<img id="pf-prev" src="'+esc(d.image_url||'')+'" style="'+(d.image_url?'':'display:none;')+'max-height:120px;border-radius:8px;margin-top:8px;border:1px solid var(--border);" onerror="this.style.display=\'none\'"></div>';

  /* ── STEP 1: DNA البيع ──────────────────────────── */
  } else if(k==='dna'){
    H+='<div class="row gap8" style="margin-bottom:14px;flex-wrap:wrap;">'
      +'<button class="btn sm" onclick="pfDistribute()" title="وزّع الوصف بدون ذكاء — قواعد فقط">🔀 وزّع الوصف</button>'
      +'<button class="btn sm primary" id="pf-dna-btn" onclick="pfDraftDNA()">✨ اقترح DNA بالذكاء</button>'
      +'<button class="btn sm" onclick="pfPreview()">👁 معاينة كيفاش يبيع</button></div>';
    H+='<div style="background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px;">'
      +'<div style="font-size:12px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">🎯 الجمهور المستهدف</div>'
      +'<div class="pf-grid2"><div><label class="lbl-f">الزبون المستهدف</label><input class="inp" id="pf-target" value="'+esc(d.target_customer||'')+'" placeholder="لاعبين Free Fire 16-25 سنة…"></div>'
      +'<div><label class="lbl-f">زاوية البيع</label><input class="inp" id="pf-angle" value="'+esc(d.selling_angle||'')+'" placeholder="سرعة التسليم / أمان الحساب…"></div></div></div>';
    H+='<div style="background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px;">'
      +'<div style="font-size:12px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">💬 نقاط البيع</div>'
      +_pfTa('pf-feat','المميزات (فصل بـ ·)',d.key_features,2)
      +_pfTa('pf-benef','الفوائد للزبون',d.key_benefits,2)+'</div>';
    H+='<div style="background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px;">'
      +'<div style="font-size:12px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">❓ الاعتراضات + الردود</div>'
      +_pfTa('pf-objections','اعتراض ← الرد | اعتراض ← الرد…',d.objections,3)+'</div>';
    H+='<div class="pf-grid2"><div><label class="lbl-f">الكلمات المفتاحية</label><input class="inp" id="pf-keywords" value="'+esc(d.keywords||'')+'" placeholder="شحن، جواهر، free fire…"></div>'
      +'<div><label class="lbl-f">منتجات مرتبطة (upsell)</label><input class="inp" id="pf-related" value="'+esc(d.related_products||'')+'" placeholder="اسم منتج آخر…"></div></div>';
    H+='<div class="pf-grid2"><div><label class="lbl-f">دليل اجتماعي</label><input class="inp" id="pf-social" value="'+esc(d.social_proof||'')+'" placeholder="+500 بيعة…"></div>'
      +'<div><label class="lbl-f">وعد التسليم</label><input class="inp" id="pf-dpromise" value="'+esc(d.delivery_promise||'')+'" placeholder="خلال 10 دقائق…"></div></div>';
    H+='<div class="pf-grid2"><div><label class="lbl-f">ضمان</label><input class="inp" id="pf-guarantee" value="'+esc(d.guarantee_note||'')+'" placeholder="ضمان استرداد 24 ساعة…"></div>'
      +'<div><label class="lbl-f">لا تنصح به متى</label><input class="inp" id="pf-dnr" value="'+esc(d.do_not_recommend||'')+'"></div></div>';
    H+=_pfTa('pf-desc','الوصف الكامل',d.description,3);
    H+='<div id="pf-preview-out"></div>';

  /* ── STEP 2: الدفع ──────────────────────────────── */
  } else if(k==='payment'){
    H+='<div style="font-size:12.5px;color:var(--text-2);margin-bottom:16px;">فعّل طرق الدفع التي تقبلها لهذا المنتج وأضف رسوم إن وجدت.</div>';
    H+='<div id="pf-pay-container">'+_pfPaymentHTML()+'</div>';

  /* ── STEP 3: الحجز ─────────────────────────────── */
  } else if(k==='reservation'){
    var resEn=d.enable_reservation||false;
    H+='<div style="padding:14px;border-radius:10px;background:var(--panel-2);border:1px solid var(--border);margin-bottom:18px;">';
    H+='<label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-weight:800;font-size:14px;">';
    H+='<input type="checkbox" id="pf-res-enable" '+(resEn?'checked':'')+' onchange="var s=this.checked;document.getElementById(\'pf-res-body\').style.display=s?\'block\':\'none\';">';
    H+='تفعيل الحجز (Reservation) لهذا المنتج</label>';
    H+='<div style="font-size:12px;color:var(--text-3);margin-top:6px;margin-right:26px;">مخصص للمنتجات الفريدة (حسابات) — يمنع بيع نفس الحساب لزبونين</div>';
    H+='</div>';
    H+='<div id="pf-res-body" style="display:'+(resEn?'block':'none')+';">';
    H+='<div class="pf-grid2" style="margin-bottom:14px;">';
    H+='<div><label class="lbl-f">الحد الأدنى للعربون (MAD) *</label><input class="inp" id="pf-res-deposit" type="number" min="0" value="'+esc(String(d.min_deposit||''))+'"></div>';
    H+='<div><label class="lbl-f">مدة الحجز (أيام) *</label><input class="inp" id="pf-res-duration" type="number" min="1" max="30" value="'+esc(String(d.reservation_duration_days||5))+'"></div>';
    H+='</div>';
    H+='<div style="margin-bottom:14px;padding:12px 14px;border-radius:8px;background:var(--panel-2);border:1px solid var(--border);">';
    H+='<div style="font-size:12px;font-weight:700;color:var(--text-3);margin-bottom:10px;">العربون قابل للاسترداد؟</div>';
    H+='<label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;font-size:13px;"><input type="checkbox" id="pf-res-refundable" '+(d.deposit_refundable?'checked':'')+'>نعم، العربون قابل للاسترداد</label>';
    H+='</div>';
    H+='<div style="margin-bottom:14px;padding:12px 14px;border-radius:8px;background:var(--panel-2);border:1px solid var(--border);">';
    H+='<div style="font-size:12px;font-weight:700;color:var(--text-3);margin-bottom:10px;">بعد انتهاء المهلة</div>';
    var af=d.after_expiration||'auto_return';
    H+='<label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;font-size:13px;"><input type="radio" name="pf-res-after" value="auto_return" '+(af==='auto_return'?'checked':'')+'>العودة تلقائياً للبيع (Automatic)</label>';
    H+='<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;"><input type="radio" name="pf-res-after" value="manual_review" '+(af==='manual_review'?'checked':'')+'>مراجعة يدوية</label>';
    H+='</div>';
    H+='<div style="margin-bottom:14px;"><label class="lbl-f">رسالة الحجز (تُرسل للزبون بعد دفع العربون)</label>';
    H+='<textarea class="inp" id="pf-res-msg" rows="3" style="resize:vertical">'+esc(d.reservation_message||'تم حجز الحساب لمدة '+esc(String(d.reservation_duration_days||5))+' أيام بعد دفع العربون.')+'</textarea></div>';
    H+='<div style="padding:10px 14px;border-radius:8px;background:rgba(255,176,32,.1);border:1px solid rgba(255,176,32,.3);font-size:12.5px;color:#a07000;">';
    H+='ℹ️ عند تفعيل الحجز يظهر المنتج في Dashboard بشارة 🟡 <b>محجوز</b> مع عداد تنازلي. بعد انتهاء المهلة يعود تلقائياً للبيع.';
    H+='</div>';
    H+='</div>';

  /* ── STEP 4: مراجعة ونشر ───────────────────────── */
  } else if(k==='review'){
    var miss=_pfMissing(d,svc);
    var pkgN=(d.recharge_packages||[]).length;
    var reqN=(d.buyer_requirements||[]).length;
    var payOn=Object.values(_pfS.pays||{}).filter(function(x){return x.on;}).length;
    H+=(miss.length?'<div class="chip warn" style="margin-bottom:14px;display:block;font-size:13px;">ناقص قبل النشر: '+miss.join('، ')+'</div>':'<div class="chip ok" style="margin-bottom:14px;display:block;font-size:13px;">✓ المنتج كامل وجاهز للنشر</div>');
    H+='<div id="pf-complete-big" style="margin-bottom:14px;"></div>';
    H+='<div class="grid g2" style="gap:14px;margin-bottom:16px;">';
    // Card 1: المنتج
    H+='<div class="panel"><div class="panel-h">📦 <h2>المنتج</h2><button class="btn sm ghost" onclick="pfGo(0)">تعديل</button></div><div class="panel-b"><div class="row between mb16"><span style="color:var(--text-2);">الاسم</span><b>'+esc(d.product_name||'—')+'</b></div><div class="row between mb16"><span style="color:var(--text-2);">النوع</span><b>'+esc(t.label||svc)+'</b></div><div class="row between"><span style="color:var(--text-2);">السعر</span><b class="num">'+esc(d.price||(pkgN?pkgN+' باقات':'—'))+'</b></div></div></div>';
    // Card 2: الربح
    var pr2=parseFloat(d.price||0), co=parseFloat(d.cost_price||0), prof2=pr2-co;
    H+='<div class="panel"><div class="panel-h">💰 <h2>الربح</h2></div><div class="panel-b"><div class="row between mb16"><span style="color:var(--text-2);">السعر</span><b class="num">'+esc(String(d.price||'—'))+' DH</b></div><div class="row between mb16"><span style="color:var(--text-2);">التكلفة</span><b class="num">'+esc(String(d.cost_price||'—'))+' DH</b></div><div class="row between"><span style="color:var(--text-2);">الربح</span><b class="num" style="color:var(--ok)">'+esc(d.cost_price&&d.price?prof2.toFixed(0)+' DH':'—')+'</b></div></div></div>';
    // Card 3: DNA
    var featN=(d.key_features||'').split('·').filter(Boolean).length;
    var kwN=(d.keywords||'').split(',').filter(Boolean).length;
    H+='<div class="panel"><div class="panel-h">🧬 <h2>DNA البيع</h2><button class="btn sm ghost" onclick="pfGo(1)">تعديل</button></div><div class="panel-b"><div class="row between mb16"><span style="color:var(--text-2);">نقاط البيع</span><b>'+featN+' نقطة</b></div><div class="row between mb16"><span style="color:var(--text-2);">كلمات مفتاحية</span><b>'+kwN+'</b></div><div class="row between"><span style="color:var(--text-2);">اعتراضات</span><b>'+(d.objections?'✓':'—')+'</b></div></div></div>';
    // Card 4: الدفع
    var payOnNames=Object.keys(_pfS.pays||{}).filter(function(k){return _pfS.pays[k]&&_pfS.pays[k].on;});
    H+='<div class="panel"><div class="panel-h">💳 <h2>الدفع</h2><button class="btn sm ghost" onclick="pfGo(2)">تعديل</button></div><div class="panel-b"><div class="row between mb16"><span style="color:var(--text-2);">طرق فعّالة</span><b>'+payOn+'</b></div><div class="row between"><span style="color:var(--text-2);">الطرق</span><b style="font-size:11px">'+esc(payOnNames.join(' · ')||'—')+'</b></div></div></div>';
    H+='</div>';
    H+='<div style="margin-top:8px;"><button class="btn sm" onclick="pfPreview()">👁 شوف كيفاش الذكاء كيبيع هاد المنتج</button></div><div id="pf-preview-out"></div>';
  }
  return H;
}

/* ================================================================
   M2: PAYMENT STEP HELPERS  (accounts loaded from DB — no hardcoded keys)
================================================================ */
function _payIcon(k){ return {cashplus:'💸',wafacash:'💸',cih:'🏦',attijari:'🏦',barid:'📮',binance:'₿',usdt:'₮',orange:'🟠',paypal:'💳'}[k]||'💳'; }
function _pfPaymentHTML(){
  var pays=_pfS.pays||{}; var accts=_pfS.payAccounts; var H='';
  if(!accts){ return '<div class="dim" style="padding:20px;text-align:center;">⏳ جاري تحميل طرق الدفع…</div>'; }
  if(!accts.length){ return '<div class="chip warn">لا توجد طرق دفع مضافة — أضف من إعدادات الدفع أولاً.</div>'; }
  accts.forEach(function(m){
    var k=m.method_key;
    var s=pays[k]||{on:false,fee:'',unit:m.currency||'MAD',reason:''};
    var isOn=!!s.on;
    var fields=Array.isArray(m.fields)?m.fields:[];
    H+='<div class="pay-row'+(isOn?' pay-on':'')+'" onclick="pfPayToggle(\''+k+'\',event)">'
      +'<div style="display:flex;align-items:center;gap:12px;">'
      +'<div class="pay-row pi">'+_payIcon(k)+'</div>'
      +'<div><div style="font-size:14px;font-weight:700;">'+esc(m.display_name)+'</div>'
      +(m.holder_name?'<div style="font-size:11px;color:var(--text-3);">'+esc(m.holder_name)+'</div>':'')
      +'</div>'
      +'</div>'
      +'<div style="display:flex;align-items:center;gap:10px;">'
      +(isOn?'<span class="chip ok" style="font-size:12px;">مفعّل</span>':'<span class="chip gray" style="font-size:12px;">معطّل</span>')
      +'<div class="toggle'+(isOn?' on':'')+'" onclick="pfPayToggle(\''+k+'\',event)"></div>'
      +'</div>'
      +'</div>';
    if(isOn){
      H+='<div class="pay-panel">';
      H+='<div class="pf-grid2" style="margin-bottom:10px;"><div><label class="lbl-f">رسوم إضافية (0 = لا رسوم)</label><input class="inp" value="'+esc(s.fee||'')+'" placeholder="0" oninput="_pfPayField(\''+k+'\',\'fee\',this.value)"></div>'
        +'<div><label class="lbl-f">سبب الرسوم (اختياري)</label><input class="inp" value="'+esc(s.reason||'')+'" placeholder="عمولة…" oninput="_pfPayField(\''+k+'\',\'reason\',this.value)"></div></div>';
      if(fields.length){
        H+='<div style="font-size:11px;color:var(--text-3);margin-top:6px;">'+fields.map(function(f){ return esc(f.label||'')+': <b>'+esc(f.value||'')+'</b>'; }).join(' · ')+'</div>';
      }
      H+='</div>';
    }
  });
  return H;
}
function pfPayToggle(key,e){
  if(e) e.stopPropagation();
  _pfS.pays=_pfS.pays||{}; _pfS.pays[key]=_pfS.pays[key]||{}; _pfS.pays[key].on=!_pfS.pays[key].on;
  var container=document.getElementById('pf-pay-container');
  if(container) container.innerHTML=_pfPaymentHTML();
  else _pfRenderWizard();
}
function _pfPayField(key,field,val){ _pfS.pays=_pfS.pays||{}; _pfS.pays[key]=_pfS.pays[key]||{}; _pfS.pays[key][field]=val; }
// Rule-based (NO AI per ADR-0018) distributor: merchant dumps everything in الوصف → recognizes structured specs
// (rank/evo/platform/link/stock/delivery/game) into their OWN fields + splits the rest into المميزات/الفوائد/الوصف.
// RE-RUN = full refresh: a field is OVERWRITTEN when the new الوصف names it; it is NEVER cleared if not mentioned.
// Price/min_price are deliberately NOT extracted (pricing firewall + ambiguity) → stay manual. Heuristic (~80%), merchant reviews.
// Best results with comma/newline-separated specs (e.g. "رتبة Heroic، 8 إيفو، +50 سكين، أندرويد، ربط فيسبوك").
function pfDistribute(){ var dd=document.getElementById('pf-desc'); var txt=(dd?dd.value:'').trim(); if(!txt){toast('اكتب مواصفات المنتج فخانة الوصف أولاً','bad');return;}
  var ff=document.getElementById('pf-feat'), bf=document.getElementById('pf-benef');
  if(((ff&&ff.value.trim())||(bf&&bf.value.trim()))&&!confirm('غادي نعيد توزيع الحقول من الوصف الحالي (المميزات/الفوائد + الرتبة/الإيفو/المنصة/الربط/المخزون/التسليم/اللعبة). نكمّل؟')) return;
  var VAL=/مباشر|فوري|فورية|جاهز|آمن|أمان|امان|ضمان|مضمون|بلا مشاكل|بلا باند|نظيف|تلعب|استمتع|احترافي|سريع|دعم\b|ثقة|راحة|توصل|أصلي|original/i;
  var SPEC=/\d|رتبة|رانك|rank|سكين|skin|سكن|مستوى|level|\blvl\b|جوهر|diamond|\buc\b|شدة|باقة|كود|code|بندل|bundle|عدد|نقاط|points/i;
  var d=_pfS.data, g={}, set=function(k,v){ if(v!=null&&String(v).trim()!==''){ d[k]=String(v).trim(); g[k]=1; } };
  // per-segment recognizer: a matched structured spec sets its OWN field + is CONSUMED (kept out of المميزات/الفوائد text)
  function recog(s){ var m;
    if((m=s.match(/(\d+)\s*(?:إيفو|ايفو|evo)/i))){ set('evo_count',m[1]+' إيفو'); return true; }
    if((m=s.match(/رتبة\s*[:：]?\s*(\S+(?:\s\S+)?)/i))){ set('account_rank',m[1].replace(/\s*(?:فقط|only|غير)\s*$/i,'')); return true; }
    if((m=s.match(/\b(grand ?master|grandmaster|heroic|diamond|platinum|gold|master|elite|إليت|غراند ?ماستر|هيروك|دايموند)\b/i))){ set('account_rank',m[1]); return true; }
    if((m=s.match(/(?:المخزون|مخزون|الكمية|stock)\s*[:：]?\s*(\d+)/i))){ set('stock',m[1]); return true; }
    if(/تسليم|توصيل|delivery/i.test(s)&&(m=s.match(/(\d+(?:\s*[-–]\s*\d+)?\s*(?:دقيقة|دقائق|ساعة|ساعات|يوم|أيام|mins?|hours?|hrs?|h))/i))){ set('delivery_time',m[1].replace(/\s+/g,' ')); return true; }
    if((m=s.match(/(?:اللعبة|لعبة|game)\s*[:：]?\s*([^\n،؛.]{2,30})/i))){ set('game',m[1]); return true; }
    if(/android|أندرويد|اندرويد|ios|iphone|آيفون|ايفون/i.test(s)){ set('account_platform',((/android|أندرويد|اندرويد/i.test(s))?'Android':'')+((/ios|iphone|آيفون|ايفون/i.test(s))?((/android|أندرويد|اندرويد/i.test(s))?'+iOS':'iOS'):'')); return true; }
    if(/ربط|link|حساب|account/i.test(s)&&(m=s.match(/(فيسبوك|facebook|جيميل|gmail|google|إيميل|ايميل|e-?mail)/i))){ set('account_link_type',m[1]); return true; }
    return false;
  }
  var segs=txt.split(/[\n،؛•·]+|\s[-–]\s/).map(function(s){return s.trim();}).filter(Boolean);
  var feats=[],bens=[],desc=[]; segs.forEach(function(s){ if(recog(s)) return; if(VAL.test(s)) bens.push(s); else if(SPEC.test(s)) feats.push(s); else desc.push(s); });
  if(ff) ff.value=feats.join(' · '); if(bf) bf.value=bens.join(' · '); if(dd) dd.value=desc.join('. ');
  pfUpdateComplete();
  var LBL={account_rank:'الرتبة',evo_count:'الإيفو',account_platform:'المنصة',account_link_type:'الربط',stock:'المخزون',delivery_time:'التسليم',game:'اللعبة'};
  var ex=Object.keys(g).map(function(k){return LBL[k]||k;});
  var cnt=[]; if(feats.length)cnt.push(feats.length+' مميزات'); if(bens.length)cnt.push(bens.length+' فوائد');
  toast('🔀 توزيع (قواعد بلا ذكاء): '+(cnt.join('، ')||'بلا تصنيف نصي')+(ex.length?(' · حقول: '+ex.join('، ')):'')+' — راجع وعدّل. الأثمنة يدوية 🔒');
}
async function pfDraftDNA(){ _pfSaveStep(); var d=_pfS.data; if(!d.product_name){toast('دخّل اسم المنتج فخطوة الأساسيات أولاً','bad');return;} var btn=document.getElementById('pf-dna-btn'); if(btn){btn.disabled=true;btn.textContent='⏳ كيقترح…';} toast('⏳ الذكاء كيقترح DNA… (~20 ثانية)');
  try{ var r=await fetch(API+'/api/products/draft-dna',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({product_name:d.product_name,service_type:_pfS.svc,game:d.game,category:d.category,key_features:d.key_features,description:d.description})}); var j=await r.json().catch(function(){return {};});
    if(!j.ok){toast((j.error||'فشل الاقتراح'),'bad');} else { var M={target_customer:'pf-target',selling_angle:'pf-angle',key_benefits:'pf-benef',objections:'pf-objections',guarantee_note:'pf-guarantee',delivery_promise:'pf-dpromise',do_not_recommend:'pf-dnr',related_products:'pf-related'}; Object.keys(M).forEach(function(key){ if(j.dna&&j.dna[key]){ var e=document.getElementById(M[key]); if(e)e.value=j.dna[key]; d[key]=j.dna[key]; } }); toast('✨ تعمّرو حقول DNA — راجعهم وصادق'); } }catch(e){toast('فشل الاتصال بالذكاء','bad');}
  if(btn){btn.disabled=false;btn.textContent='✨ اقترح DNA بالذكاء';} }
async function pfPreview(){ _pfSaveStep(); var out=document.getElementById('pf-preview-out'); if(out)out.innerHTML='<div class="dim" style="font-size:12px;padding:8px">⏳ كنجهّز المعاينة…</div>'; var d=_pfS.data; var body=Object.assign({},d,{service_type:_pfS.svc,proof_images:(d.proof_str?d.proof_str.split(',').map(function(s){return s.trim();}).filter(Boolean):null)});
  try{ var r=await fetch(API+'/api/products/preview-ai',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)}); var j=await r.json().catch(function(){return {};}); if(!j.ok){if(out)out.innerHTML='<div class="chip warn">فشل المعاينة</div>';return;}
    if(out)out.innerHTML='<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin:10px 0;background:var(--accent-soft)"><div style="font-weight:700;font-size:12px;margin-bottom:4px">👁 كيفاش الذكاء كيشوف المنتج:</div><div class="dim" style="font-size:12px;margin-bottom:8px">'+esc(j.ai_sees&&j.ai_sees.embed_text||'')+'</div><div style="font-weight:700;font-size:12px;margin-bottom:4px">💬 نموذج رد البيع:</div><div style="font-size:13px;margin-bottom:8px">'+esc(j.sample_pitch||'')+'</div>'+((j.will_collect&&j.will_collect.length)?('<div style="font-weight:700;font-size:12px;margin-bottom:4px">📋 غادي يطلب من الزبون:</div><div class="dim" style="font-size:12px">'+esc(j.will_collect.join('، '))+'</div>'):'')+'<div style="font-size:10px;color:var(--dim,#888);margin-top:6px">🔒 cost_price و risk_notes ما كيوصلوش للذكاء</div></div>'; }catch(e){if(out)out.innerHTML='<div class="chip warn">فشل الاتصال</div>';} }
async function pfUpload(input){ const f=input.files&&input.files[0]; if(!f)return; toast('جاري رفع الصورة…');
  try{const fd=new FormData();fd.append('image',f);const r=await fetch(API+'/api/upload',{method:'POST',headers:authHeaders(),body:fd});const d=await r.json();
    if(d&&d.url){$('#pf-img').value=d.url;const pv=$('#pf-prev');pv.src=d.url;pv.style.display='block';if(_pfS&&_pfS.data)_pfS.data.image_url=d.url;toast('تم رفع الصورة ✓');}else toast('فشل الرفع','bad');}catch(e){toast('فشل الرفع','bad');} }
async function saveProduct(mode){ _pfSaveStep(); var d=_pfS.data; var svc=_pfS.svc; var t=_pfTpls()[svc]||{};
  var status=(mode==='publish')?'available':'inactive';
  if(status==='available'&&t.proven===false){ status='inactive'; toast('ℹ️ '+(t.label||svc)+' كيتسجّل Draft حتى نوصل الذكاء بيه (P4)'); }
  var body={ product_name:d.product_name||'', price:d.price||'', category:d.category||'', description:d.description||'', image_url:d.image_url||'', whatsapp_url:d.whatsapp_url||'', instagram_url:d.instagram_url||'', status:status, service_type:svc, product_type:(t.pt||null), game:d.game||null, min_price:d.min_price||null, delivery_time:d.delivery_time||null, key_features:d.key_features||null, keywords:d.keywords||null, account_rank:d.account_rank||null, evo_count:d.evo_count||null, account_platform:d.account_platform||null, account_link_type:d.account_link_type||null, code_type:d.code_type||null, product_code:d.product_code||null, recharge_packages:((d.recharge_packages&&d.recharge_packages.length)?d.recharge_packages:null), price_usd:d.price_usd||null, price_eur:d.price_eur||null, max_discount:d.max_discount||null, key_benefits:d.key_benefits||null, related_products:d.related_products||null, stock:d.stock||null, proof_images:(d.proof_str?d.proof_str.split(',').map(function(s){return s.trim();}).filter(Boolean):null), target_customer:d.target_customer||null, selling_angle:d.selling_angle||null, objections:d.objections||null, do_not_recommend:d.do_not_recommend||null, social_proof:d.social_proof||null, guarantee_note:d.guarantee_note||null, delivery_promise:d.delivery_promise||null, risk_notes:d.risk_notes||null, cost_price:d.cost_price||null, facebook_url:d.facebook_url||null, product_url:d.product_url||null, buyer_requirements:((d.buyer_requirements&&d.buyer_requirements.length)?d.buyer_requirements:[]), attributes:((d.attributes&&Object.keys(d.attributes).length)?d.attributes:{}), enable_reservation:!!d.enable_reservation, min_deposit:d.min_deposit||null, reservation_duration_days:d.reservation_duration_days||5, deposit_refundable:!!d.deposit_refundable, after_expiration:d.after_expiration||'auto_return', reservation_message:d.reservation_message||null };
  if(!body.product_name){toast('اسم المنتج مطلوب','bad');_pfS.step=0;_pfRenderWizard();return;}
  var id=_pfS.id;
  try{ var resp=await fetch(API+(id?'/api/products/'+id:'/api/products/add'),{method:id?'PUT':'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)});
    if(resp.status===401){logout();return;} var j=await resp.json().catch(function(){return {};});
    if(!resp.ok){ if(j&&j.error==='PRODUCT_INCOMPLETE'){toast('⚠️ '+(j.message||('ناقص: '+(j.missing||[]).join('، '))),'bad');} else {toast((j&&(j.message||j.error))||'فشل الحفظ','bad');} return; }
    bust('orders');
    var savedId=j.id||id;
    // Save per-product payment prices if any methods toggled
    if(savedId&&_pfS.pays){
      var payPs=Object.keys(_pfS.pays).filter(function(k){return _pfS.pays[k]&&_pfS.pays[k].on;});
      await Promise.all(payPs.map(function(k){
        var s=_pfS.pays[k];
        return fetch(API+'/api/product-payment-prices',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:JSON.stringify({product_id:savedId,method_key:k,price_value:parseFloat(s.fee||0)||0,currency:s.unit||'DH',enabled:true,note:s.reason||null})}).catch(function(){});
      }));
    }
    toast(id?'تم حفظ التعديل ✓':(status==='available'?'تم النشر ✓':'تم الحفظ كمسودة ✓'));
    renderCatalog();
  }catch(e){toast('فشل الحفظ — تحقق من الاتصال','bad');} }
async function deleteProduct(id){ const p=window._prods[id]||{}; if(!confirm('حذف المنتج "'+(p.product_name||'')+'"؟ لا يمكن التراجع.'))return;
  const r=await send('/api/products/'+id,'DELETE'); if(r){toast('تم حذف المنتج');renderCatalog();}else toast('فشل الحذف','bad'); }
async function toggleProduct(id,status){ const r=await send('/api/products/'+id+'/status','PATCH',{status}); if(r){toast('تم تحديث الحالة');renderCatalog();}else toast('فشل','bad'); }
async function cancelReservation(id){ if(!confirm('إلغاء الحجز وإرجاع المنتج للبيع؟')) return; const r=await send('/api/products/'+id+'/lifecycle','POST',{event_type:'CANCEL_RESERVATION'}); if(r&&r.success){toast('تم إلغاء الحجز ✓');renderCatalog();}else toast(r&&r.error||'فشل','bad'); }
async function completeSale(id){ if(!confirm('تأكيد قبول الدفع؟ المنتج سيتحول إلى مباع.')) return; const r=await send('/api/products/'+id+'/lifecycle','POST',{event_type:'PAYMENT_ACCEPTED'}); if(r&&r.success){toast('تم قبول الدفع ✓');renderCatalog();}else toast(r&&r.error||'فشل','bad'); }

// ── Product Detail Page ───────────────────────────────────────────────────────
var _pdId=null;
async function openProductDetail(id){
  _pdId=id;
  mount('<div style="padding:24px;text-align:center;color:var(--text-3)">جاري التحميل…</div>');
  var d=await api('/api/products/'+id+'/detail');
  if(!d||!d.product){toast('فشل تحميل التفاصيل','bad');renderCatalog();return;}
  _renderProductDetail(d);
}
function _renderProductDetail(d){
  var p=d.product, tl=d.timeline||[], cust=d.customer;
  var st=p.status||'available';
  var b=_lcBadge(st);
  var bg=p.bg_color||_catBg(p);
  var isActiveCycle=LC_ACTIVE_STATUSES.indexOf(st)!==-1;
  var isSoldDone=st==='sold'||st==='delivered';
  var hasActiveCycle=isActiveCycle||isSoldDone;
  // Stepper
  var STEPS=[
    {k:'reserved',           lbl:'محجوز'},
    {k:'deposit_paid',       lbl:'العربون مدفوع'},
    {k:'waiting_full_payment',lbl:'انتظار الباقي'},
    {k:'pending_review',     lbl:'الإثبات وصل'},
    {k:'pending_review_act', lbl:'مراجعة الدفع'},
    {k:'sold',               lbl:'مباع'},
    {k:'delivered',          lbl:'تم التسليم'},
  ];
  var statusOrder=['reserved','deposit_paid','waiting_full_payment','pending_review','pending_review','sold','delivered'];
  var curIdx=statusOrder.indexOf(st); if(curIdx<0)curIdx=0;
  var stepperH='<div style="display:flex;align-items:flex-start;gap:0;margin-bottom:24px;overflow-x:auto;padding-bottom:6px;">';
  STEPS.forEach(function(s,i){
    var done=i<curIdx, active=i===curIdx;
    var circ=done?'<div style="width:30px;height:30px;border-radius:50%;background:var(--ok);display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;flex-shrink:0;">✓</div>'
      :active?'<div style="width:30px;height:30px;border-radius:50%;background:'+b.badgeColor+';display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:800;flex-shrink:0;">'+(i+1)+'</div>'
      :'<div style="width:30px;height:30px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:11px;flex-shrink:0;">'+(i+1)+'</div>';
    // find date from timeline
    var stepDate=''; var tlMap={reserved:'RESERVE',deposit_paid:'DEPOSIT_PAID',waiting_full_payment:'WAITING_FULL_PAYMENT',pending_review:'PROOF_SUBMITTED',sold:'PAYMENT_ACCEPTED',delivered:'DELIVERED'};
    var tlKey=tlMap[s.k]||tlMap[STEPS[i>0?i-1:0].k]||'';
    var tlRow=tl.find(function(r){return r.event_type===tlKey;});
    if(tlRow&&tlRow.created_at){var td=new Date(tlRow.created_at);stepDate=(td.getDate()+'/'+(td.getMonth()+1)+' '+String(td.getHours()).padStart(2,'0')+':'+String(td.getMinutes()).padStart(2,'0'));}
    stepperH+='<div style="display:flex;flex-direction:column;align-items:center;min-width:88px;position:relative;">'
      +(i>0?'<div style="position:absolute;top:15px;right:calc(50% + 15px);left:calc(-50% + 15px);height:2px;background:'+(done||active?b.badgeColor:'var(--border)')+'"></div>':'')
      +circ
      +'<div style="font-size:10px;font-weight:'+(active?'800':'600')+';color:'+(active?b.badgeColor:(done?'var(--text-1)':'var(--text-3)'))+';margin-top:6px;text-align:center;white-space:nowrap;">'+s.lbl+'</div>'
      +(stepDate?'<div style="font-size:9px;color:var(--text-3);margin-top:2px;">'+stepDate+'</div>':'')
      +'</div>';
  });
  stepperH+='</div>';
  // Timeline rows
  var tlH=''; var tlIcons={RESERVE:'🔒',DEPOSIT_PAID:'💵',WAITING_FULL_PAYMENT:'⏳',PROOF_SUBMITTED:'📷',PAYMENT_ACCEPTED:'✅',PAYMENT_FAILED:'❌',CONTACT_SENT:'💬',CUSTOMER_REPLIED:'↩️',DELIVERED:'📦',CANCEL_RESERVATION:'🔓',RESERVATION_EXPIRED:'⏰',EXTEND_RESERVATION:'🕐',ADMIN_NOTE:'📝',STATUS_CHANGED:'🔄',RESERVATION_CREATED:'🔒',RESERVATION_CANCELLED:'🔓',SALE_COMPLETED:'✅'};
  var tlLabels={RESERVE:'محجوز',DEPOSIT_PAID:'العربون مدفوع',WAITING_FULL_PAYMENT:'انتظار الدفع الكامل',PROOF_SUBMITTED:'وصل إثبات الدفع',PAYMENT_ACCEPTED:'تم قبول الدفع',PAYMENT_FAILED:'الدفع مرفوض',CONTACT_SENT:'تواصل مع الزبون',CUSTOMER_REPLIED:'رد الزبون',DELIVERED:'تم التسليم',CANCEL_RESERVATION:'تم إلغاء الحجز',RESERVATION_EXPIRED:'انتهت مدة الحجز',EXTEND_RESERVATION:'تمديد الحجز',ADMIN_NOTE:'ملاحظة',STATUS_CHANGED:'تغيير الحالة',RESERVATION_CREATED:'محجوز',RESERVATION_CANCELLED:'إلغاء الحجز',SALE_COMPLETED:'تم البيع'};
  tl.forEach(function(r){
    var d=new Date(r.created_at); var ds=d.getDate()+'/'+(d.getMonth()+1)+'/'+d.getFullYear()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    var ic=tlIcons[r.event_type]||'•'; var lbl=tlLabels[r.event_type]||r.event_type;
    var byMap={customer:'Customer (AI)','admin':'Admin','cron':'System','system':'System'};
    var by=byMap[r.triggered_by]||r.triggered_by||'System';
    var isNote=r.event_type==='ADMIN_NOTE';
    var noteText=isNote&&r.payload?(typeof r.payload==='string'?JSON.parse(r.payload):r.payload).note||'':'';
    tlH+='<div style="display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">'
      +'<div style="width:28px;height:28px;border-radius:50%;background:var(--panel-2);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;">'+ic+'</div>'
      +'<div style="flex:1;min-width:0;">'
        +'<div style="font-size:13px;font-weight:700;">'+esc(lbl)+'</div>'
        +(isNote?'<div style="font-size:12px;color:var(--text-2);margin-top:2px;">'+esc(noteText)+'</div>':'')
      +'</div>'
      +'<div style="text-align:right;flex-shrink:0;">'
        +'<div style="font-size:11px;color:var(--text-3);">'+ds+'</div>'
        +'<div style="font-size:10px;color:var(--text-3);">'+esc(by)+'</div>'
      +'</div>'
    +'</div>';
  });
  if(!tlH) tlH='<div style="color:var(--text-3);font-size:12px;padding:12px 0;">لا أحداث بعد</div>';
  // Actions
  var canAccept=['pending_review','waiting_customer_reply'].indexOf(st)!==-1;
  var canFail=['pending_review','waiting_customer_reply'].indexOf(st)!==-1;
  var canDeliver=st==='sold';
  var canExtend=LC_ACTIVE_STATUSES.indexOf(st)!==-1;
  var canCancel=LC_ACTIVE_STATUSES.indexOf(st)!==-1;
  var actionsH='';
  if(canAccept) actionsH+='<button class="btn" style="background:#16a34a;color:#fff;padding:14px;font-size:14px;font-weight:800;border-radius:10px;border:none;cursor:pointer;width:100%;margin-bottom:10px;" onclick="pdAction(\'PAYMENT_ACCEPTED\')">✅ قبول الدفع<br><small style="font-weight:400;opacity:.8;">الدفع صحيح، تسليم المنتج للزبون</small></button>';
  if(canFail) actionsH+='<button class="btn" style="background:#dc2626;color:#fff;padding:14px;font-size:14px;font-weight:800;border-radius:10px;border:none;cursor:pointer;width:100%;margin-bottom:10px;" onclick="pdAction(\'PAYMENT_FAILED\')">❌ الدفع خاطئ<br><small style="font-weight:400;opacity:.8;">الدفع ناقص أو مزور، إرجاع للبيع</small></button>';
  if(canDeliver) actionsH+='<button class="btn" style="background:#7c3aed;color:#fff;padding:14px;font-size:14px;font-weight:800;border-radius:10px;border:none;cursor:pointer;width:100%;margin-bottom:10px;" onclick="pdAction(\'DELIVERED\')">📦 تم التسليم<br><small style="font-weight:400;opacity:.8;">المنتج وصل للزبون</small></button>';
  if(canExtend) actionsH+='<div style="margin-bottom:10px;"><div style="font-size:12px;color:var(--text-3);margin-bottom:6px;">⏰ تمديد الحجز</div><div style="display:flex;gap:7px;">'
    +'<button class="btn ghost sm" style="flex:1" onclick="pdExtend(24)">+24س</button>'
    +'<button class="btn ghost sm" style="flex:1" onclick="pdExtend(72)">+3أيام</button>'
    +'<button class="btn ghost sm" style="flex:1" onclick="pdExtend(120)">+5أيام</button>'
    +'</div></div>';
  if(canCancel) actionsH+='<button class="btn ghost" style="width:100%;padding:10px;color:var(--bad);border-color:var(--bad);margin-top:4px;" onclick="pdAction(\'CANCEL_RESERVATION\')">🔓 إلغاء الحجز وإرجاع للبيع</button>';
  // Proof section
  var proofUrl=p.payment_proof_url||'';
  var proofImgH=proofUrl
    ?('<div style="position:relative;border-radius:10px;overflow:hidden;background:#111;margin-bottom:12px;cursor:pointer;" onclick="pdProofOpen(\''+esc(proofUrl)+'\')">'
        +'<img id="pd-proof-img" src="'+esc(proofUrl)+'" style="width:100%;max-height:320px;object-fit:contain;display:block;" onerror="this.style.display=\'none\';document.getElementById(\'pd-proof-broken\').style.display=\'flex\'">'
        +'<div id="pd-proof-broken" style="display:none;height:180px;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--text-3)"><div style="font-size:32px;">🖼️</div><div style="font-size:12px;">تعذّر تحميل الصورة</div><a href="'+esc(proofUrl)+'" target="_blank" style="color:var(--accent);font-size:11px;">فتح الرابط مباشرة ›</a></div>'
        +'<div style="position:absolute;bottom:8px;right:8px;display:flex;gap:6px;">'
          +'<a href="'+esc(proofUrl)+'" download target="_blank" style="padding:5px 10px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;text-decoration:none;">⬇️ تحميل</a>'
          +'<a href="'+esc(proofUrl)+'" target="_blank" style="padding:5px 10px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;text-decoration:none;">🔍 فتح</a>'
        +'</div>'
      +'</div>')
    :'<div style="height:140px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;background:var(--panel-2);border-radius:10px;margin-bottom:12px;color:var(--text-3);"><div style="font-size:28px;">📷</div><div style="font-size:12px;">لم يتم إرسال إثبات دفع بعد</div></div>';
  var proofH='<div class="panel" style="margin-bottom:18px;"><div class="panel-h">📷 <h3 style="margin:0">إثبات الدفع</h3></div>'
    +'<div class="panel-b">'
    +proofImgH
    +'<div style="display:flex;gap:24px;flex-wrap:wrap;">'
      +'<div><div style="font-size:11px;color:var(--text-3)">البنك / الطريقة</div><b>'+esc(p.payment_method||'—')+'</b></div>'
      +'<div><div style="font-size:11px;color:var(--text-3)">المبلغ المُرسَل</div><b>'+esc(String(p.payment_amount_claimed||'—'))+' DH</b></div>'
      +(p.payment_proof_received_at?'<div><div style="font-size:11px;color:var(--text-3)">وقت الإرسال</div><b>'+new Date(p.payment_proof_received_at).toLocaleString('fr-MA')+'</b></div>':'')
      +'<div><div style="font-size:11px;color:var(--text-3)">الحالة</div><span style="padding:3px 8px;border-radius:6px;background:'+b.badgeBg+';color:'+b.badgeColor+';font-weight:800;font-size:12px;">'+b.badgeTxt+'</span></div>'
    +'</div>'
    +(p.customer_message?'<div style="margin-top:12px;"><div style="font-size:11px;color:var(--text-3);margin-bottom:4px;">رسالة الزبون</div><div style="background:var(--panel-2);border-radius:8px;padding:10px;font-size:13px;">'+esc(p.customer_message)+'</div></div>':'')
    +'</div></div>';
  // Customer info
  var hasCustLink=!!(p.reserved_by);
  var inboxBtn=hasCustLink
    ?'<button style="margin-top:12px;width:100%;padding:10px;border-radius:8px;background:#2563eb;color:#fff;font-size:13px;font-weight:700;border:none;cursor:pointer;" onclick="pdOpenInbox(\''+esc(p.reserved_by||'')+'\')">💬 فتح المحادثة في Inbox ›</button>'
    :'<button style="margin-top:12px;width:100%;padding:10px;border-radius:8px;background:var(--panel-2);color:var(--text-3);font-size:13px;border:none;cursor:not-allowed;" disabled>💬 لا يوجد زبون مرتبط بهذا المنتج</button>';
  var custH=cust?('<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-3)">الاسم</span><b>'+esc(cust.customer_name||p.reserved_by_name||'—')+'</b></div>'
    +'<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-3)">الهاتف</span><b>'+esc(cust.wa_phone||'—')+'</b></div>'
    +'<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-3)">الطلبات</span><b>'+esc(String(cust.total_orders||0))+'</b></div>'
    +'<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-3)">المجموع</span><b>'+esc(String(cust.total_spent||0))+' DH</b></div>'
    +inboxBtn)
    :(inboxBtn+(hasCustLink?'<div style="color:var(--text-3);font-size:11px;margin-top:6px;">Youssef El — لم يُسجّل في النظام بعد</div>':'<div style="color:var(--text-3);font-size:12px;margin-top:8px;">لا توجد عملية بيع أو حجز حالياً</div>'));

  mount('<div style="padding:0 4px;">'
    +'<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">'
      +'<button class="btn ghost sm" onclick="renderCatalog()">‹ المنتجات</button>'
      +'<h2 style="margin:0;flex:1;">'+esc(p.product_name)+'</h2>'
      +'<span style="padding:5px 12px;border-radius:8px;background:'+b.badgeBg+';color:'+b.badgeColor+';font-weight:800;font-size:13px;">'+b.badgeTxt+'</span>'
    +'</div>'
    // Progress stepper (only for products with active lifecycle)
    +(hasActiveCycle?'<div class="panel" style="margin-bottom:18px;"><div class="panel-b">'+stepperH+'</div></div>':'<div class="panel" style="margin-bottom:18px;"><div class="panel-b" style="text-align:center;padding:16px 0;"><div style="font-size:28px;margin-bottom:8px;">🏷️</div><div style="font-size:13px;color:var(--text-3);">لا توجد عملية بيع أو حجز نشط حالياً</div></div></div>')
    // Proof (always shown — placeholder if no image)
    +(hasActiveCycle?proofH:'')
    // Main split
    +'<div class="split" style="align-items:flex-start;">'
      // Left: timeline
      +'<div class="panel">'
        +'<div class="panel-h">📅 <h3 style="margin:0;">Timeline</h3></div>'
        +'<div class="panel-b">'+tlH+'</div>'
      +'</div>'
      // Right: info + actions + notes
      +'<div style="display:flex;flex-direction:column;gap:14px;">'
        // Status info
        +'<div class="panel"><div class="panel-h"><h3 style="margin:0;">معلومات الحجز</h3></div><div class="panel-b">'
          +'<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-3)">الحالة الحالية</span><b>'+b.badgeTxt+'</b></div>'
          +(p.reserved_at?'<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-3)">محجوز منذ</span><b>'+new Date(p.reserved_at).toLocaleDateString('fr-MA')+'</b></div>':'')
          +(p.reservation_ends_at?'<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-3)">ينتهي</span><b id="pd-countdown">'+_resCountdown(p.reservation_ends_at)+'</b></div>':'')
          +(p.payment_method?'<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-3)">طريقة الدفع</span><b>'+esc(p.payment_method)+'</b></div>':'')
          +'<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-3)">السعر</span><b>'+esc(String(p.price||'—'))+' DH</b></div>'
          +(p.deposit_paid?'<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-3)">العربون</span><b style="color:var(--ok)">'+esc(String(p.deposit_paid))+' DH ✓</b></div>':'')
        +'</div></div>'
        // Customer info
        +'<div class="panel"><div class="panel-h">👤 <h3 style="margin:0;">معلومات الزبون</h3></div><div class="panel-b">'+custH+'</div></div>'
        // Actions
        +'<div class="panel"><div class="panel-h">✏️ <h3 style="margin:0;">الإجراءات (أنت تقرر)</h3></div><div class="panel-b">'+actionsH+'</div></div>'
        // Admin notes
        +'<div class="panel"><div class="panel-h">📝 <h3 style="margin:0;">ملاحظاتك (خاصة)</h3></div><div class="panel-b">'
          +'<textarea id="pd-note" class="ta" rows="3" placeholder="اكتب ملاحظة حول هذا الطلب…" style="margin-bottom:8px;"></textarea>'
          +'<button class="btn primary sm" onclick="pdSaveNote()">حفظ الملاحظة</button>'
        +'</div></div>'
      +'</div>'
    +'</div>'
  +'</div>');
  // update countdown every minute
  if(p.reservation_ends_at) setInterval(function(){ var el=document.getElementById('pd-countdown'); if(el) el.textContent=_resCountdown(p.reservation_ends_at); },60000);
}

async function pdAction(eventType){
  if(!_pdId) return;
  var confirmMsgs={PAYMENT_ACCEPTED:'تأكيد قبول الدفع؟ المنتج سيتحول إلى مباع.',PAYMENT_FAILED:'رفض الدفع وإرجاع المنتج للبيع؟',CONTACT_SENT:'تحويل الحالة إلى "انتظار رد الزبون"؟',DELIVERED:'تأكيد تسليم المنتج للزبون؟',CANCEL_RESERVATION:'إلغاء الحجز نهائياً وإرجاع المنتج للبيع؟'};
  if(!confirm(confirmMsgs[eventType]||('تنفيذ: '+eventType+'؟'))) return;
  var r=await send('/api/products/'+_pdId+'/lifecycle','POST',{event_type:eventType});
  if(r&&r.success){ toast('تم ✓'); openProductDetail(_pdId); }
  else toast((r&&r.error)||'فشل','bad');
}

async function pdExtend(hours){
  if(!_pdId) return;
  var r=await send('/api/products/'+_pdId+'/lifecycle/extend','POST',{hours:hours});
  if(r&&r.success){ toast('تم تمديد الحجز ✓'); openProductDetail(_pdId); }
  else toast((r&&r.error)||'فشل','bad');
}

async function pdSaveNote(){
  if(!_pdId) return;
  var ta=document.getElementById('pd-note'); if(!ta||!ta.value.trim()) return;
  var r=await send('/api/products/'+_pdId+'/admin-note','POST',{note:ta.value.trim()});
  if(r&&r.success){ toast('تم حفظ الملاحظة ✓'); ta.value=''; openProductDetail(_pdId); }
  else toast('فشل','bad');
}
function pdProofOpen(url){
  var ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
  ov.onclick=function(){document.body.removeChild(ov);};
  ov.innerHTML='<img src="'+esc(url)+'" style="max-width:92vw;max-height:92vh;border-radius:8px;object-fit:contain;" onclick="event.stopPropagation()">'
    +'<a href="'+esc(url)+'" download target="_blank" onclick="event.stopPropagation()" style="position:absolute;bottom:28px;right:28px;padding:8px 18px;border-radius:8px;background:rgba(255,255,255,.15);color:#fff;font-size:13px;text-decoration:none;">⬇️ تحميل</a>'
    +'<button onclick="document.body.removeChild(this.parentElement)" style="position:absolute;top:20px;right:20px;background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:50%;width:36px;height:36px;font-size:18px;cursor:pointer;">✕</button>';
  document.body.appendChild(ov);
}
function pdOpenInbox(sid){
  if(!sid){toast('لا يوجد زبون مرتبط بهذا المنتج','bad');return;}
  location.hash='#/inbox';
  setTimeout(function(){if(typeof ibxOpen==='function')ibxOpen(String(sid));},500);
}
// ===== Duplicate Product (clone → Wizard prefilled → Save As New; reuses add, ZERO AI) =====
function duplicateProduct(id){
  var p=(window._prods&&window._prods[id]); if(!p){toast('المنتج غير موجود','bad');return;}
  var clone=_pfNorm(Object.assign({},p)); delete clone.id; delete clone.created_at; delete clone.updated_at;
  clone.product_name=((clone.product_name||'')+' (نسخة)').trim(); clone.status='inactive';
  _pfS={ id:0, isEdit:false, svc:_pfInferSvc(p), step:0, data:clone, pays:{bank:{on:false,fee:'',unit:'DH',reason:''},orange:{on:false,fee:'',unit:'DH',reason:''},usdt:{on:false,fee:'1',unit:'USDT',reason:'',network:'TRC20',wallet:''},paypal:{on:false,fee:'',unit:'DH',reason:''}}, payAccounts:null };
  _pfRenderWizard(); toast('نسخة جاهزة — بدّل اللي بغيتي واحفظ كمنتج جديد ✏️');
}
// ===== Bulk Paste (catalog entry — ZERO AI; rule-based compose via backend /api/products/bulk) =====
function openBulkPaste(){
  window._bpFMT={ready_account:'الاسم | الثمن | أقل ثمن | الرتبة | الإيفو | المنصة | نوع الربط | المميزات', game_topup_id:'الاسم | الكمية=الثمن, الكمية=الثمن, ...', digital_code:'الاسم | نوع الكود | الثمن | المخزون'};
  window._bpEX={ready_account:'حساب فري فاير Grandmaster | 1500 | 1300 | Grandmaster | 8 | Android+iOS | فيسبوك+إيميل | +50 سكين نادر، نظيف', game_topup_id:'شحن جواهر فري فاير | 110=15, 580=60, 1080=120', digital_code:'كود سكن MAC10 | سكن | 100 | 15'};
  var types=[['ready_account','حسابات جاهزة'],['game_topup_id','شحن بالـID'],['digital_code','أكواد رقمية']];
  var H='<div class="modal-h"><span>📋 لصق بالجملة — بلا ذكاء (قوالب فقط)</span><button class="iconbtn" onclick="closeModal()">'+icon('x')+'</button></div>'
   +'<div class="modal-b">'
   +'<div class="pf-grid2"><div><label class="lbl-f">نوع المنتج</label><select class="inp" id="bp-type" onchange="bpFmt()">'+types.map(function(t){return '<option value="'+t[0]+'">'+t[1]+'</option>';}).join('')+'</select></div><div><label class="lbl-f">اللعبة</label><input class="inp" id="bp-game" value="free fire"></div></div>'
   +'<div class="dim" id="bp-fmt" style="font-size:11px;margin:8px 0;line-height:1.7"></div>'
   +'<label class="lbl-f">الصق سطر واحد لكل منتج:</label><textarea class="ta" id="bp-paste" rows="9" style="font-family:monospace;font-size:12px" oninput="var c=document.getElementById(\'bp-import\');if(c)c.disabled=true"></textarea>'
   +'<div id="bp-preview" style="margin-top:10px"></div></div>'
   +'<div class="modal-f"><div id="bp-count" style="flex:1;font-size:12px"></div><button class="btn ghost" style="flex:0 0 auto" onclick="closeModal()">إلغاء</button><button class="btn ghost" style="flex:0 0 auto" onclick="bulkPreview()">👁 معاينة</button><button class="btn primary" id="bp-import" style="flex:0 0 auto" onclick="bulkImport()" disabled>🚀 استيراد الكل</button></div>';
  openModal(H,'wide'); bpFmt();
}
function bpFmt(){ var s=document.getElementById('bp-type'); var t=s?s.value:'ready_account'; var e=document.getElementById('bp-fmt'); var p=document.getElementById('bp-paste'); if(e&&window._bpFMT)e.innerHTML='الصيغة: <b>'+esc(window._bpFMT[t]||'')+'</b><br>مثال: '+esc((window._bpEX||{})[t]||''); if(p&&window._bpEX)p.placeholder=window._bpEX[t]||''; }
function _bpBody(dry){ var g=function(x){var e=document.getElementById(x);return e?e.value:'';}; return JSON.stringify({service_type:g('bp-type'),game:(g('bp-game')||'').trim(),paste:(g('bp-paste')||'').trim(),dry_run:!!dry}); }
async function bulkPreview(){
  var paste=(document.getElementById('bp-paste')||{}).value||''; if(!paste.trim()){toast('الصق المنتجات أولاً','bad');return;}
  var out=document.getElementById('bp-preview'); if(out)out.innerHTML='<div class="dim" style="font-size:12px;padding:6px">⏳ معاينة…</div>';
  try{ var r=await fetch(API+'/api/products/bulk',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:_bpBody(true)}); var d=await r.json().catch(function(){return {};});
    if(!d.ok){toast(d.error||'فشل المعاينة','bad'); if(out)out.innerHTML=''; return;}
    var rows=(d.items||[]).map(function(it){ return '<tr style="border-bottom:1px solid var(--border)"><td style="padding:5px">'+(it.valid?'✅':'❌')+'</td><td style="padding:5px">'+esc(it.name||'(بلا اسم)')+'</td><td style="padding:5px;white-space:nowrap">'+esc(String(it.price||'-'))+'</td><td style="padding:5px;font-size:11px;color:var(--dim,#999)">'+esc(it.key_features||'')+'</td><td style="padding:5px;font-size:11px;color:var(--bad)">'+(it.valid?'':esc('ناقص: '+(it.missing||[]).join('، ')))+'</td></tr>'; }).join('');
    if(out)out.innerHTML='<div style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:8px"><table style="width:100%;border-collapse:collapse;font-size:12px"><tr class="dim"><th style="padding:5px"></th><th style="padding:5px;text-align:start">الاسم</th><th style="padding:5px;text-align:start">الثمن</th><th style="padding:5px;text-align:start">المميزات (تلقائي)</th><th style="padding:5px;text-align:start">ملاحظات</th></tr>'+rows+'</table></div>';
    var cnt=document.getElementById('bp-count'); if(cnt)cnt.innerHTML='<span class="chip '+(d.valid===d.total?'ok':'warn')+'">'+d.valid+' صالح / '+d.total+'</span>'+(d.valid<d.total?' <span class="dim" style="font-size:11px">(الصالح فقط يتزاد)</span>':'');
    var imp=document.getElementById('bp-import'); if(imp)imp.disabled=(d.valid===0);
  }catch(e){ if(out)out.innerHTML='<div class="chip warn">فشل الاتصال</div>'; }
}
async function bulkImport(){
  var paste=(document.getElementById('bp-paste')||{}).value||''; if(!paste.trim())return;
  var imp=document.getElementById('bp-import'); if(imp){imp.disabled=true;imp.textContent='⏳ استيراد…';}
  try{ var r=await fetch(API+'/api/products/bulk',{method:'POST',headers:authHeaders({'Content-Type':'application/json'}),body:_bpBody(false)}); var d=await r.json().catch(function(){return {};});
    if(!d.ok){ toast(d.error||'فشل الاستيراد','bad'); }
    else { toast('✅ تزادو '+d.created+'/'+d.total+(d.failed?(' · فشل '+d.failed):''), d.failed?'bad':'good');
      var fails=(d.results||[]).filter(function(x){return !x.ok;}); var out=document.getElementById('bp-preview');
      if(fails.length){ if(out)out.innerHTML='<div class="chip warn" style="margin-bottom:6px">فشل '+fails.length+' (الباقي تزاد):</div>'+fails.map(function(f){return '<div style="font-size:11px;color:var(--bad)">• '+esc(f.name||'')+': '+esc(f.error||'')+'</div>';}).join(''); }
      else { closeModal(); }
      renderCatalog(); bust('orders');
    }
  }catch(e){ toast('فشل الاتصال','bad'); }
  if(imp){imp.disabled=false;imp.textContent='🚀 استيراد الكل';}
}
async function catIntel(){
  const [p,o,dm]=await Promise.all([api('/api/products'),cached('orders',()=>api('/api/orders?limit=500'),8000),api('/api/demands')]);
  const prods=p||[], orders=o||[]; const reqMap={}; ((dm&&dm.demands)||[]).forEach(d=>reqMap[(d.product||'').toLowerCase()]=d.count);
  const rows=prods.map(pr=>{ const po=orders.filter(x=>(x.product_name||'')===pr.product_name); const rev=po.filter(x=>x.paid_at).reduce((s,x)=>s+priceNum(x.price),0);
    const views=pr.view_count||0, ords=pr.order_count||po.length, conv=views>0?Math.round(ords/views*100):0;
    return {name:pr.product_name,cat:pr.category,rev,ords,views,conv,req:reqMap[(pr.product_name||'').toLowerCase()]||0,status:pr.status}; }).sort((a,b)=>b.rev-a.rev);
  const maxRev=Math.max(1,...rows.map(r=>r.rev));
  fill('#cat-body',`<div class="panel tbl-wrap"><table class="tbl"><thead><tr><th>المنتج</th><th>الإيراد</th><th>طلبات</th><th>مشاهدات</th><th>التحويل</th><th>طلبات ناقصة</th><th>الحالة</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td><b>${esc(r.name)}</b> <span class="dim" style="font-size:12px">${esc(r.cat||'')}</span></td>
      <td class="num" style="min-width:120px"><b>${money(r.rev)}</b> DH<div class="bar" style="margin-top:4px"><i style="width:${Math.round(r.rev/maxRev*100)}%"></i></div></td>
      <td class="num">${r.ords}</td><td class="num">${r.views}</td>
      <td><span class="chip ${r.conv>=20?'ok':(r.conv>0?'warn':'gray')}">${r.conv}%</span></td>
      <td class="num">${r.req||'—'}</td><td>${r.status==='available'?'<span class="chip ok">متاح</span>':'<span class="chip gray">مخفي</span>'}</td></tr>`).join('')||`<tr><td colspan="7">${empty('chart','لا بيانات')}</td></tr>`}</tbody></table></div>`);
}
async function catRequests(){
  const dm=await api('/api/demands'); const reqs=(dm&&dm.demands)||[];
  fill('#cat-body',`<div class="panel"><div class="panel-h">${icon('trend')}<h2>طلبات المنتجات (Demand)</h2><span class="cnt">${reqs.length}</span></div>
    <div class="panel-b">${reqs.length? reqs.map(d=>`<div class="row between mb16"><b>${esc(d.product)}</b><div class="row gap8"><span class="chip acc">${d.count} طلب</span>
      <button class="btn sm" onclick="openProductForm(0)">${icon('package')} أضف كمنتج</button></div></div>`).join('') : empty('check','لا طلبات غير ملبّاة','عندما يطلب زبون منتجاً غير متوفّر يظهر هنا تلقائياً.')}</div></div>`);
}

/* ============================================================ AI BRAIN */
async function renderAI(){
  if(!['prompt','quality','learning','advisor','patterns','demand','memory','decisions'].includes(_aiTab))_aiTab='prompt';
  const tabs=[['prompt','الموجّه'],['quality','الجودة'],['learning','التعلّم'],['advisor','🧠 المستشار'],['patterns','📊 الحركات'],['demand','📦 الطلب'],['memory','الذاكرة'],['decisions','🔍 القرارات']];
  mount(phead('🧠 AI Brain','تطوير البائع الذكي · حلقة التعلّم · جودة البيع')+
    `<div class="tabs">${tabs.map(t=>`<div class="tab ${t[0]===_aiTab?'active':''}" onclick="_aiTab='${t[0]}';renderAI()">${t[1]}</div>`).join('')}</div><div id="ai-body">${skel()}</div>`);
  ({prompt:aiPrompt,quality:aiQuality,learning:aiLearning,advisor:aiAdvisor,patterns:aiPatterns,demand:aiDemand,memory:aiMemory,decisions:aiDecisions}[_aiTab]||aiPrompt)();
}
/* ===== Hermes PROJECT ADVISOR — unified view (read-only). Mirrors GET /api/hermes/advisor. ===== */
async function aiAdvisor(){
  const x=await api('/api/hermes/advisor?days=90'); const a=(x&&x.advisor)||null;
  if(!a){ fill('#ai-body',`<div class="panel"><div class="panel-b">${empty('cpu','تعذّر تحميل المستشار')}</div></div>`); return; }
  const t=a.traffic||{}, rc=t.reached||{}, op=a.operations||{}, g=a.gaps||{}, dm=a.demand||{};
  const bcol=a.bottleneck==='TRAFFIC'?'var(--warn)':(a.bottleneck==='CONVERSION'?'var(--bad)':'var(--ok)');
  let body=`<div class="alert alert-info" style="margin-bottom:14px">${esc(a.banner||'')}</div>`;
  body+=`<div class="panel" style="margin-bottom:14px"><div class="panel-h">${icon('cpu')}<h2>الحكم</h2></div><div class="panel-b">
    <div style="font-size:18px;font-weight:700;color:${bcol}">🚦 العائق: ${esc(a.bottleneck||'?')}</div>
    <div class="fm" style="margin-top:6px">${esc(a.verdict||'')}</div></div></div>`;
  const ls=a.lead_stages||{}; const lsTot=(ls.buyer||0)+(ls.hot||0)+(ls.warm||0)+(ls.cold||0);
  const lscard=(n,lbl,bg,fg)=>`<div style="flex:1;min-width:90px;background:${bg};color:${fg};border-radius:10px;padding:10px;text-align:center"><div style="font-size:22px;font-weight:700">${n}</div><div class="fm">${lbl}</div></div>`;
  body+=`<div class="panel" style="margin-bottom:14px"><div class="panel-h">${icon('msg')}<h2>🌡️ مراحل الزبناء (Lead Scoring)</h2><span class="cnt">${lsTot}</span></div><div class="panel-b">
    <div class="row gap8" style="flex-wrap:wrap">${lscard(ls.buyer||0,'🛒 buyer','var(--ok-soft)','var(--ok)')}${lscard(ls.hot||0,'🔥 hot','var(--bad-soft)','var(--bad)')}${lscard(ls.warm||0,'🌤️ warm','var(--warn-soft)','var(--warn)')}${lscard(ls.cold||0,'❄️ cold','var(--panel-2)','var(--text-3)')}</div>
    <div class="fm" style="margin-top:8px">100% تغطية · حيّ من funnel+orders+ميزانية+حداثة (بلا cron)</div></div></div>`;
  const stat=(lbl,val,sub)=>`<div style="flex:1;min-width:120px;background:var(--panel-2);border:1px solid var(--border);border-radius:10px;padding:10px"><div class="fm">${lbl}</div><div style="font-size:20px;font-weight:700">${val}</div>${sub?('<div class="fm" style="font-size:11px">'+sub+'</div>'):''}</div>`;
  body+=`<div class="row gap8" style="flex-wrap:wrap;margin-bottom:14px">
    ${stat('زبناء حقيقيين',a.real_customers||0,'ثقة '+(a.confidence||'?'))}
    ${stat('وصلو للبيع',rc.sales||0,'بشري '+(rc.human||0))}
    ${stat('مبيعات مسدودة',t.closed_orders||0,'')}
    ${stat('فجوات الطلب',dm.gaps||0,'خسارة~'+(dm.total_lost_revenue||0)+'DH')}
    ${stat('مايتباعش',(a.not_selling||[]).length+' منتج','')}
    ${stat('تدخّلات معلّقة',op.pending_interventions||0,'مجمّدين '+(op.frozen||0))}</div>`;
  body+=`<div class="split" style="margin-bottom:14px">
    <div class="panel"><div class="panel-h">${icon('msg')}<h2>قمع الزبناء (funnel)</h2></div><div class="panel-b">
      ${['greeting','discovery','browsing','sales','payment','human'].map(k=>`<div class="row between mb16"><b>${({greeting:'ترحيب',discovery:'اكتشاف',browsing:'تصفّح',sales:'بيع',payment:'دفع',human:'بشري'})[k]}</b><span class="chip ${k==='sales'||k==='payment'?'acc':'gray'}">${rc[k]||0}</span></div>`).join('')}
      <div class="row between mb16"><b>القنوات</b><span class="fm">${(t.by_channel||[]).map(c=>esc(c.ch)+':'+c.n).join(' · ')}</span></div>
      ${(function(){var ca=t.channel_attribution||{},cc=ca.by_channel||{};return '<div class="row between"><b>تغطية القناة</b><span class="chip '+((ca.coverage_pct!=null&&ca.coverage_pct<70)?'warn':'gray')+'">'+(ca.coverage_pct!=null?ca.coverage_pct+'%':'—')+' · مجهول '+(cc.unknown||0)+'</span></div>';})()}</div></div>
    <div class="panel"><div class="panel-h">${icon('cpu')}<h2>الثغرات + العمليات</h2></div><div class="panel-b">
      <div class="row between mb16"><b>lead-score (حقيقي)</b><span class="chip ${(g.lead_score_real_coverage||'').startsWith('0')?'warn':'gray'}">${esc(g.lead_score_real_coverage||'?')}</span></div>
      <div class="row between mb16"><b>clarify turns</b><span class="chip gray">${g.clarify_turns||0}</span></div>
      <div class="row between mb16"><b>seller→بشري</b><span class="chip gray">${g.seller_to_human||0}</span></div>
      <div class="row between mb16"><b>نداءات دكاء 24س</b><span class="chip gray">${op.ai_calls_24h||0}</span></div>
      <div class="row between"><b>circuit مفتوح</b><span class="chip ${op.open_circuits!=='ok'?'warn':'gray'}">${esc(op.open_circuits||'ok')}</span></div></div></div></div>`;
  if((dm.top||[]).length){ const r=dm.top[0]; const ws=r.waitlist_stages||{}; const wsStr=(ws.hot||ws.warm||ws.cold||ws.buyer)?(' — منهم '+[ws.buyer?ws.buyer+'🛒':'',ws.hot?ws.hot+'🔥':'',ws.warm?ws.warm+'🌤️':'',ws.cold?ws.cold+'❄️':''].filter(Boolean).join(' ')):'';
    body+=`<div class="alert" style="background:var(--warn-soft);color:var(--warn);border:0">💡 أكبر فرصة: <b>${esc(r.product||'')}</b> — ${r.requested_count} زبناء طلبوه${wsStr} (${r.budget_min}-${r.budget_max}DH)، مخزون ${r.available_inventory}، أرخص ${r.cheapest_available||'?'}DH → <b>زيد مخزون فهاد الرينج</b> (خسارة~${r.est_lost_revenue}DH).</div>`; }
  const rec=a.recommendations||{}; const rs=rec.by_status||{}; const stColor={open:'gray',inventory_added:'acc',converted:'',stale:'gray'}; const stLbl={open:'مفتوحة (لم تُعالج)',inventory_added:'زدنا المخزون',converted:'✅ تحوّلت لبيعة',stale:'قديمة'};
  if((rec.opportunities||[]).length){
    body+=`<div class="panel" style="margin-bottom:14px"><div class="panel-h">${icon('cpu')}<h2>🎯 تتبّع الفرص → البيع (صحة توصيات Hermes)</h2><span class="cnt">${rec.recommendation_health_pct!=null?rec.recommendation_health_pct+'%':'—'}</span></div><div class="panel-b" style="overflow-x:auto">
      <div class="fm" style="margin-bottom:8px">مفتوحة ${rs.open||0} · زدنا المخزون ${rs.inventory_added||0} · تحوّلت لبيعة ${rs.converted||0} — صحة التوصيات = البيعات ÷ اللي عالجناها${rec.recommendation_health_pct==null?' (مازال ماعالجنا حتى فرصة)':''}</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:right;color:var(--text-3)"><th style="padding:6px">الفرصة</th><th>طلبوه</th><th>🔥hot</th><th>خسارة</th><th>الحالة</th></tr></thead><tbody>
      ${rec.opportunities.map(o=>`<tr style="border-top:1px solid var(--border)"><td style="padding:6px"><b>${esc((o.game||'?')+' '+(o.type||''))}</b></td><td>${o.requested_count||0}</td><td>${o.hot_count||0}</td><td>${o.est_lost_revenue||0}DH</td><td><span class="chip ${stColor[o.status]||'gray'}">${stLbl[o.status]||o.status}</span></td></tr>`).join('')}
      </tbody></table></div></div>`;
  }
  const cat=a.catalog||{};
  if((cat.products||[]).length){
    const clsLbl={winner:'✅ رابح',demanded_unsold:'⚠️ مطلوب وماتباعش',quiet_seller:'باع بهدوء',dead:'❄️ راكد'}, clsChip={winner:'',demanded_unsold:'warn',quiet_seller:'acc',dead:'gray'};
    body+=`<div class="panel" style="margin-bottom:14px"><div class="panel-h">${icon('package')}<h2>📚 ذكاء الكاطالوغ (V2)</h2></div><div class="panel-b" style="overflow-x:auto">
      ${(cat.to_add||[]).length?`<div class="alert" style="background:var(--ok-soft);color:var(--ok);border:0;margin-bottom:10px">➕ <b>زيد:</b> ${cat.to_add.map(x=>esc(x.product)+' ('+x.requested+' طلبوه'+(x.hot?' · '+x.hot+'🔥':'')+')').join(' · ')}</div>`:''}
      <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:right;color:var(--text-3)"><th style="padding:6px">المنتج</th><th>طُلب</th><th>باع</th><th>الحالة</th></tr></thead><tbody>
      ${cat.products.map(p=>`<tr style="border-top:1px solid var(--border)"><td style="padding:6px">${esc(p.product)}</td><td>${p.demanded}</td><td>${p.sold}</td><td><span class="chip ${clsChip[p.cls]||'gray'}">${clsLbl[p.cls]||p.cls}</span></td></tr>`).join('')}
      </tbody></table>
      ${cat.remove_note?`<div class="fm" style="margin-top:8px;color:var(--warn)">${esc(cat.remove_note)}</div>`:''}</div></div>`;
  }
  fill('#ai-body', body);
}
/* ===== Hermes Product Advisor — 📦 Demand vs Inventory (read-only). Mirrors GET /api/hermes/demand. ===== */
async function aiDemand(){
  const d=await api('/api/hermes/demand?days=90');
  if(!d||!d.ok){ fill('#ai-body',`<div class="panel"><div class="panel-b">${empty('package','تعذّر تحميل الطلب')}</div></div>`); return; }
  const tname={account:'حساب',recharge:'شحن',code:'كود',subscription:'اشتراك'};
  const gapBadge=(g)=>g==='NO_PRODUCT'?'<span class="chip" style="background:var(--bad-soft);color:var(--bad)">❌ ماكاينش</span>':(g==='PRICE_GAP'?'<span class="chip" style="background:var(--warn-soft);color:var(--warn)">⚠️ غالي</span>':'<span class="chip" style="background:var(--ok-soft);color:var(--ok)">✅ متوفر</span>');
  const rows=(d.rows||[]).slice().sort((a,b)=>(b.est_lost_revenue-a.est_lost_revenue)||(b.requested_count-a.requested_count));
  let body=`<div class="alert alert-info" style="margin-bottom:14px">${esc(d.banner||'')}<div class="fm" style="margin-top:6px">💸 إجمالي الخسارة المقدّرة: <b>${d.total_lost_revenue||0} DH</b> · فجوات: ${d.gaps||0} · نافذة ${d.window_days} يوم</div></div>`;
  body+=`<div class="panel"><div class="panel-h">${icon('package')}<h2>الطلب مقابل المخزون</h2><span class="cnt">${rows.length}</span></div><div class="panel-b" style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:right;color:var(--text-3)">
      <th style="padding:6px">المنتج</th><th>طلبوه</th><th>الميزانية</th><th>المخزون</th><th>أرخص متوفر</th><th>الحالة</th><th>خسارة مقدّرة</th></tr></thead><tbody>
    ${rows.length?rows.map(r=>`<tr style="border-top:1px solid var(--border)"><td style="padding:6px"><b>${esc((r.game||'؟')+' '+(tname[r.type]||r.type||''))}</b><div class="fm" style="font-size:11px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((r.samples||[]).join(' · '))}</div></td>
      <td><b>${r.requested_count}</b></td><td>${r.budget_min!=null?(r.budget_min+'–'+r.budget_max+' DH'):'—'}</td><td>${r.available_inventory}</td><td>${r.cheapest_available!=null?(r.cheapest_available+' DH'):'—'}</td><td>${gapBadge(r.gap)}</td><td><b>${r.est_lost_revenue||0} DH</b></td></tr>`).join(''):`<tr><td colspan="7" style="padding:10px">${empty('package','لا طلب بعد')}</td></tr>`}
    </tbody></table></div></div>`;
  body+=`<div class="fm" style="text-align:center;margin-top:8px">مبني على ${d.real_customers} زبون حقيقي · نفس التقرير فـTelegram: <b>/demand</b></div>`;
  fill('#ai-body', body);
}
/* ===== Outcome Learning V4 — Pattern Performance by Funnel State (READ-ONLY observatory). Empty unless ff_outcome_v4_observe=on. ===== */
async function aiPatterns(){
  const d=await api('/api/patterns/performance');
  if(!d||!d.enabled){ fill('#ai-body', `<div class="panel"><div class="panel-b">${empty('cpu','مرصد الحركات مطفّأ','فعّل ff_outcome_v4_observe باش يبان أداء الحركات حسب حالة الزبون (observe-only).')}</div></div>`); return; }
  const cells=d.cells||[];
  const tname={qualification:'تأهيل',trust_building:'بناء ثقة',price_objection:'اعتراض/ثمن',closing:'إغلاق',offer:'عرض',greeting:'ترحيب',reengage:'إعادة ربط',discovery:'اكتشاف',handoff:'تحويل بشري',other:'أخرى'};
  const states=[['hot','🔥 حار'],['warm','🌤️ دافئ'],['cold','❄️ بارد'],['customer','⭐ زبون']];
  const byState={}; cells.forEach(c=>{ (byState[c.state_bucket]=byState[c.state_bucket]||[]).push(c); });
  const liftChip=(c)=>{ const l=Number(c.lift)||0; if(!c.gate_pass) return '<span class="chip gray">أدلة قليلة</span>'; if(l>0) return '<span class="chip" style="background:var(--ok-soft);color:var(--ok)">↑ '+l.toFixed(2)+'</span>'; if(l<0) return '<span class="chip" style="background:var(--bad-soft);color:var(--bad)">↓ '+l.toFixed(2)+' anti</span>'; return '<span class="chip gray">0</span>'; };
  let body='<div class="alert alert-info" style="margin-bottom:14px">'+esc(d.banner||'')+(d.note?('<div class="fm" style="margin-top:6px">'+esc(d.note)+'</div>'):'')+'</div>';
  const present=states.filter(s=>byState[s[0]]&&byState[s[0]].length);
  if(!present.length){ body+=`<div class="panel"><div class="panel-b">${empty('cpu','لا بيانات بعد','شغّل Night Coach أو انتظر تراكم المحادثات المربوطة بنتيجة.')}</div></div>`; }
  present.forEach(s=>{
    const rows=byState[s[0]].slice().sort((a,b)=>(Number(b.lift)||0)-(Number(a.lift)||0));
    body+=`<div class="panel" style="margin-bottom:14px"><div class="panel-h">${icon('cpu')}<h2>${s[1]}</h2><span class="cnt">${rows.length}</span></div><div class="panel-b" style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:right;color:var(--text-3)">
        <th style="padding:6px">الحركة</th><th>استعمالات</th><th>مبيعات</th><th>baseline</th><th>تقدير [مجال]</th><th>lift</th></tr></thead><tbody>
      ${rows.map(c=>`<tr style="border-top:1px solid var(--border)"><td style="padding:6px"><b>${esc(tname[c.tactic_category]||c.tactic_category)}</b><div class="fm" style="font-size:11px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.sample_patterns||'')}</div></td>
        <td>${c.n_trials}</td><td>${c.successes_weighted}</td><td>${(Number(c.base_rate)||0).toFixed(2)}</td>
        <td>${(Number(c.posterior_mean)||0).toFixed(2)} <span class="fm">[${(Number(c.ci_low)||0).toFixed(2)}–${(Number(c.ci_high)||0).toFixed(2)}]</span></td>
        <td>${liftChip(c)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  });
  body+='<div class="fm" style="text-align:center;margin-top:8px">آخر تحليل: '+esc(String(d.last_scored||'—'))+' · يتحدّث ليلياً (Night Coach · observe-only)</div>';
  fill('#ai-body', body);
}
async function aiDecisions(){
  if(!window._decFilter)window._decFilter='all';
  fill('#ai-body','<div class="panel"><div class="panel-b" style="text-align:center;padding:24px;color:var(--text-3)">جاري التحميل...</div></div>');
  const d=await api('/api/decisions?limit=150');
  if(!d||d.error){fill('#ai-body',`<div class="panel"><div class="panel-b">${empty('cpu','تعذّر التحميل','')}</div></div>`);return;}
  const _tAgo=function(dt){ const s=Math.floor((Date.now()-new Date(dt))/1000);
    if(s<60)return s+'ث'; const m=Math.floor(s/60); if(m<60)return m+'د';
    const h=Math.floor(m/60); if(h<24)return h+'س'; return Math.floor(h/24)+'ي'; };
  const _DCOLORS={topic_change:'acc',price_block:'bad',ai_loop:'warn',freeze:'warn',other:'gray'};
  const _DLABELS={topic_change:'تبديل موضوع',price_block:'حجب',ai_loop:'توقف لوب',freeze:'تجميد',other:'قرار'};
  const decs=(d.decisions||[]).map(r=>{
    const p=r.parsed||{}; const tp=p.type||'other';
    return {sub:r.subscriber_id,name:String(r.customer_name||r.subscriber_id||'').slice(0,22),t:r.created_at,
      _type:tp,_color:_DCOLORS[tp]||'gray',_label:_DLABELS[tp]||'قرار',
      _old:p.old||r.from_stage||'',_new:p.new||r.to_stage||'',
      _conf:p.confidence,_action:p.action||'',_msg:r.user_msg||''};
  });
  const blks=(d.blocks||[]).map(b=>({
    sub:b.subscriber_id,name:String(b.customer_name||b.subscriber_id||'').slice(0,22),t:b.created_at,
    _type:'price_block',_color:'bad',_label:'حجب',_old:'',_new:'',_conf:1,
    _action:String(b.blocked_game||'').slice(0,40),_msg:b.user_msg||''}));
  const all=[...decs,...blks].sort((a,b)=>new Date(b.t)-new Date(a.t)).slice(0,150);
  const summary={total:all.length,
    tc:all.filter(x=>x._type==='topic_change').length,
    pb:all.filter(x=>x._type==='price_block').length,
    fr:all.filter(x=>x._type==='freeze'||x._type==='ai_loop').length};
  const filtered=window._decFilter&&window._decFilter!=='all'?all.filter(x=>x._type===window._decFilter):all;
  const tFilters=[['all','الكل'],['topic_change','تبديل موضوع'],['price_block','حجب'],['freeze','تجميد'],['ai_loop','لوب']];
  let html='<div class="kpis" style="margin-bottom:14px">'
    +'<div class="kpi"><div class="top"><div class="ic">📊</div><div class="lbl">إجمالي القرارات</div></div><div class="val num">'+summary.total+'</div></div>'
    +'<div class="kpi a-acc"><div class="top"><div class="ic">🔄</div><div class="lbl">تبديل موضوع</div></div><div class="val num">'+summary.tc+'</div></div>'
    +'<div class="kpi a-bad"><div class="top"><div class="ic">🛡️</div><div class="lbl">حجب</div></div><div class="val num">'+summary.pb+'</div></div>'
    +'<div class="kpi a-warn"><div class="top"><div class="ic">🧊</div><div class="lbl">توقف/تجميد</div></div><div class="val num">'+summary.fr+'</div></div>'
    +'</div>';
  html+='<div class="row gap8 wrapf mb12">'+tFilters.map(function(t){
    return '<button class="btn sm '+(window._decFilter===t[0]?'primary':'ghost')+'" onclick="window._decFilter=\''+t[0]+'\';aiDecisions()">'+t[1]+'</button>';
  }).join('')+'</div>';
  if(!filtered.length){html+=`<div class="panel"><div class="panel-b">${empty('cpu','لا قرارات من هاد النوع بعد','ستظهر هنا بعد أول تغيير موضوع أو حجب.')}</div></div>`;fill('#ai-body',html);return;}
  html+=filtered.map(function(r){
    const ago=r.t?_tAgo(r.t):'';
    const confStr=r._conf?Math.round(r._conf*100)+'%':'';
    const arrow=(r._old&&r._new)?'<span style="color:var(--text-3)">'+esc(r._old)+'</span><span style="opacity:.6;margin:0 4px">→</span><span style="color:var(--ok)">'+esc(r._new)+'</span>':'';
    return '<div class="panel" style="margin-bottom:7px"><div class="panel-b" style="padding:9px 13px">'
      +'<div style="display:flex;align-items:flex-start;gap:10px">'
      +'<div style="flex:1;min-width:0">'
      +'<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">'
      +'<span class="chip '+r._color+'">'+esc(r._label)+'</span>'
      +(confStr?'<span class="chip gray">'+confStr+'</span>':'')
      +'<span class="dim" style="font-size:11px;margin-right:auto">'+ago+'</span>'
      +'</div>'
      +'<div style="font-weight:700;font-size:13px;margin-bottom:2px">'+esc(r.name)+'</div>'
      +(arrow?'<div style="font-size:12px;margin-bottom:2px">'+arrow+'</div>':'')
      +(r._action?'<div class="dim" style="font-size:11.5px">📋 '+esc(r._action)+'</div>':'')
      +(r._msg?'<div class="dim" style="font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px">💬 '+esc(String(r._msg).slice(0,80))+'</div>':'')
      +'</div></div></div></div>';
  }).join('');
  fill('#ai-body',html);
}
/* ===== AI Control Center (C0/C1 — read-only visibility of EVERY AI service) ===== */

const _AI_REGISTRY=[
 {n:'V2 Router ⭐',r:'النية/الخدمة/المنتج/الميزانية — دماغ القرار',m:'claude-haiku-4-5 (+gpt-4o-mini)',src:'HARDCODED',pr:'inline :2357',live:'حيّ',log:0,cat:'مسار البيع الحيّ'},
 {n:'Intent Normalizer',r:'تطبيع الدارجة→EN للبحث',m:'gpt-4o-mini',src:'HARDCODED',pr:'inline :1936',live:'حيّ',log:0,cat:'مسار البيع الحيّ'},
 {n:'Embedding',r:'متجهات الكاطالوغ/KB',m:'text-embedding-3-small',src:'HARDCODED',pr:'—',live:'حيّ',log:0,cat:'مسار البيع الحيّ'},
 {n:'V2 Seller',r:'عرض 3 الأقرب (قاعدة بلا LLM)',m:'rule',src:'RULE',pr:'—',live:'حيّ',log:0,cat:'مسار البيع الحيّ'},
 {n:'Catalog/KB Search',r:'بحث pgvector',m:'rule (embeddings)',src:'RULE',pr:'—',live:'حيّ',log:'kb',cat:'مسار البيع الحيّ'},
 {n:'Slot Extractor',r:'جمع buyer-requirements',m:'claude-haiku-4-5',src:'HARDCODED',pr:'inline :2914',live:'نائم (flag off)',log:0,cat:'مسار البيع الحيّ'},
 {n:'Product Request',r:'خارج الكاطالوغ→discovery',m:'rule',src:'RULE',pr:'—',live:'حيّ',log:1,cat:'مسار البيع الحيّ'},
 {n:'Output Verifier 🛡️',r:'منع منتج خارج الكاطالوغ',m:'rule',src:'settings=shadow',pr:'—',live:'حيّ',log:'verifier_log',cat:'الحماية'},
 {n:'Payment Verify',r:'تأكيد الدفع→إنسان',m:'rule',src:'RULE',pr:'—',live:'حيّ',log:1,cat:'الحماية'},
 {n:'Escalation',r:'متى يحوّل لإنسان',m:'rule',src:'RULE',pr:'—',live:'حيّ',log:0,cat:'الحماية'},
 {n:'Vision Classifier',r:'نوع الصورة',m:'gpt-4o-mini',src:'HARDCODED',pr:'inline :2871',live:'صورة',log:0,cat:'الرؤية (صور)'},
 {n:'Vision Analyzer',r:'تحليل صورة منتج',m:'gpt-4o',src:'HARDCODED',pr:'inline :2878',live:'صورة',log:1,cat:'الرؤية (صور)'},
 {n:'Vision Fraud',r:'كشف احتيال الدفع',m:'gpt-4o-mini',src:'HARDCODED',pr:'inline :2865',live:'صورة',log:0,cat:'الرؤية (صور)'},
 {n:'Whisper',r:'تفريغ الصوت',m:'whisper-1',src:'DB(agents.audio)',pr:'inline :3045',live:'صوت',log:1,cat:'الصوت'},
 {n:'Voice Coherence',r:'فحص التفريغ',m:'gpt-4o-mini',src:'HARDCODED',pr:'inline :3052',live:'صوت',log:1,cat:'الصوت'},
 {n:'Hermes Ops',r:'مساعد عمليات NL',m:'gpt-4o',src:'HARDCODED',pr:'inline :1404',live:'عمليات',log:0,cat:'العمليات'},
 {n:'Hermes Suggest',r:'اقتراح رد للمشغّل',m:'gpt-4o',src:'HARDCODED',pr:'inline :1574',live:'عمليات',log:0,cat:'العمليات'},
 {n:'Follow-up Draft',r:'مسودّات متابعة (يدوي)',m:'rule',src:'RULE',pr:'—',live:'يدوي',log:0,cat:'العمليات'},
 {n:'Product DNA Draft',r:'زاوية البيع/الاعتراضات',m:'claude-sonnet-4-6',src:'HARDCODED',pr:'inline :420',live:'استوديو',log:0,cat:'الاستوديو'},
 {n:'Preview-AI',r:'نموذج pitch',m:'claude-sonnet-4-6',src:'HARDCODED',pr:'inline :439',live:'استوديو',log:0,cat:'الاستوديو'},
 {n:'Intent (legacy)',r:'تصنيف نية — مسار قديم',m:'gemini→haiku→mini',src:'DB(agents+config)',pr:'DB',live:'قديم (معطّل)',log:0,cat:'قديم/ظل'},
 {n:'Pipeline Shadow',r:'gatekeeper ظل (ما يغيّر الرد)',m:'claude-haiku-4-5',src:'HARDCODED',pr:'inline :2187',live:'ظل',log:'pipeline_log',cat:'قديم/ظل'},
 {n:'Health Pings ⚠️',r:'فحص حيوية المزوّدين (watchdog)',m:'haiku/mini/gemini',src:'HARDCODED',pr:'inline :1794',live:'cron ~745/يوم',log:0,cat:'خلفية'}
];
function _aiRegistryHtml(st){
  const c=(st&&st.cost)||{}; const byModel=(c.by_model||[]).slice(); const lay=(st.routing&&st.routing.by_layer)||{};
  const srcChip=s=>{const cls=/HARDCODED/.test(s)?'bad':(/RULE/.test(s)?'gray':'acc');return `<span class="chip ${cls}">${esc(s)}</span>`;};
  const logChip=l=>l?(l===1?'<span class="chip ok">مسجّل ✓</span>':`<span class="chip acc">${esc(l)}</span>`):'<span class="chip warn">غير مسجّل</span>';
  const liveChip=v=>`<span class="chip ${/حيّ/.test(v)?'ok':(/صورة|صوت|عمليات|استوديو|يدوي/.test(v)?'acc':'gray')}">${esc(v)}</span>`;
  const card=(l,v,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon('zap')}</div><div class="lbl">${l}</div></div><div class="val num">${v}</div></div>`;
  const cats=[...new Set(_AI_REGISTRY.map(s=>s.cat))];
  const tables=cats.map(cat=>{const items=_AI_REGISTRY.filter(s=>s.cat===cat);
    return `<div class="dr-sec">${esc(cat)} <span class="chip gray">${items.length}</span></div>
    <table class="tbl" style="margin-bottom:16px"><thead><tr><th>الذكاء</th><th>الموديل</th><th>المصدر</th><th>البرومبت</th><th>الحالة</th><th>التسجيل</th></tr></thead><tbody>
    ${items.map(s=>`<tr><td><b>${esc(s.n)}</b><div class="dim" style="font-size:11.5px">${esc(s.r)}</div></td><td class="num" style="font-size:12px">${esc(s.m)}</td><td>${srcChip(s.src)}</td><td class="dim" style="font-size:11.5px">${esc(s.pr)}</td><td>${liveChip(s.live)}</td><td>${logChip(s.log)}</td></tr>`).join('')}
    </tbody></table>`;}).join('');
  return `
    <div class="panel" style="margin-bottom:16px"><div class="panel-b row gap8" style="font-size:13px;align-items:flex-start">${icon('alert')}<span><b>رؤية فقط (C0/C1).</b> جرد كل ذكاء فالنظام — حتى المخبي فالكود. التحكّم الحيّ (تبديل موديل/برومبت/تشغيل-إيقاف) = <b>C2 بعد مراجعتك</b>. التكلفة دابا <b>لكل موديل</b> (مشتركة) — تسجيل كل خدمة كيتكمّل فـC0.</span></div></div>
    <div class="kpis" style="margin-bottom:18px">
      ${card('تكلفة AI — الكل','$'+(c.total_usd!=null?c.total_usd:'—'),'acc')}
      ${card('اليوم','$'+(c.today_usd!=null?c.today_usd:'—'))}
      ${card('هذا الشهر','$'+(c.month_usd!=null?c.month_usd:'—'))}
      ${card('عدد الذكاءات',_AI_REGISTRY.length)}
    </div>
    <div class="panel" style="margin-bottom:16px"><div class="panel-h">${icon('cpu')}<h2>جميع الذكاءات</h2><span class="cnt">${_AI_REGISTRY.length}</span></div><div class="panel-b">${tables}</div></div>
    <div class="split">
      <div class="panel"><div class="panel-h">${icon('dollar')}<h2>التكلفة حسب الموديل</h2></div><div class="panel-b">
        <table class="tbl"><thead><tr><th>الموديل</th><th>رسائل</th><th>توكنز</th><th>التكلفة</th></tr></thead><tbody>
        ${byModel.length?byModel.sort((a,b)=>b.cost_usd-a.cost_usd).map(m=>`<tr><td class="num" style="font-size:12px">${esc(m.model)}</td><td class="num">${m.messages}</td><td class="num">${((m.tokens_in||0)+(m.tokens_out||0)).toLocaleString()}</td><td class="num"><b>$${m.cost_usd}</b></td></tr>`).join(''):'<tr><td colspan="4" class="dim">لا بيانات بعد</td></tr>'}
        </tbody></table></div></div>
      <div class="panel"><div class="panel-h">${icon('layers')}<h2>الاستعمال حسب الطبقة</h2></div><div class="panel-b">
        ${Object.keys(lay).length?Object.entries(lay).sort((a,b)=>b[1]-a[1]).slice(0,14).map(([k,v])=>`<div class="row between mb16"><span class="num" style="font-size:12px">${esc(k)}</span><span class="chip gray">${v}</span></div>`).join(''):'<div class="dim">لا بيانات</div>'}
      </div></div>
    </div>`;
}
async function aiControl(){
  var _tabs=[['brain','🧠 Brain'],['policies','🛡️ السياسات'],['monitoring','📈 المراقبة'],['alerts','🚨 التنبيهات'],['actions','🔧 الإجراءات']];
  var _fns={brain:'_mcGoBrain',policies:'_mcGoPolicies',monitoring:'_mcGoMonitor',alerts:'_mcGoAlerts',actions:'_mcGoActions'};
  fill('#ai-body','<div class="tabs" style="border-bottom:1px solid var(--border)">'+
    _tabs.map(function(t){ return '<div class="tab '+(_aiHubTab===t[0]?'active':'')+'" onclick="'+_fns[t[0]]+'()">'+t[1]+'</div>'; }).join('')+
    '</div><div id="ai-hub-body">'+skel()+'</div>');
  ({brain:mcBrain,policies:mcPolicies,monitoring:mcMonitoring,alerts:mcAlerts,actions:mcActions}[_aiHubTab]||mcBrain)();
}
async function aiPrompt(){
  const [d,v]=await Promise.all([api('/api/system-prompt'),api('/api/system-prompt/versions')]);
  const versions=(v&&v.versions)||[]; window._pversions=versions;
  fill('#ai-body',`<div class="panel"><div class="panel-h">${icon('cpu')}<h2>الموجّه الأساسي للنظام</h2>
    <button class="btn primary sm" style="margin-right:auto" onclick="savePrompt()">${icon('check')} حفظ</button></div>
    <div class="panel-b"><textarea class="ta" id="prompt-ta" rows="15" style="font-family:Inter,monospace;font-size:13px;line-height:1.7">${esc(d?d.prompt:'')}</textarea>
    <div class="dim row gap8" style="font-size:12px;margin-top:10px;align-items:flex-start">${icon('alert')}<span>يُحفظ كنسخة مؤرّخة في السجل عند كل حفظ (يمكن استرجاع أي نسخة). تفعيل الموجّه في ردود البوت الحيّة يتمّ عبر نشر workflow في n8n.</span></div></div></div>
    <div class="panel" style="margin-top:16px"><div class="panel-h">${icon('activity')}<h2>سجل نُسخ الموجّه (Version History)</h2><span class="cnt">${versions.length}</span></div><div class="panel-b">
      ${versions.length? versions.map(x=>`<div class="row between mb16"><div style="flex:1;min-width:0"><div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((x.prompt||'').slice(0,100))||'(فارغ)'}</div><div class="dim" style="font-size:11px">${esc(x.actor||'')} · ${dt(x.created_at)}</div></div><button class="btn ghost sm" onclick="restorePromptVersion(${x.id})">إدراج</button></div>`).join('') : empty('activity','لا نُسخ محفوظة بعد','كل حفظ للموجّه يُنشئ نسخة قابلة للاسترجاع هنا.')}</div></div>`);
}
function restorePromptVersion(id){ const v=(window._pversions||[]).find(x=>x.id===id); const ta=$('#prompt-ta'); if(v&&ta){ta.value=v.prompt||''; ta.focus(); toast('أُدرجت النسخة في المحرّر — اضغط «حفظ» لاعتمادها');} }
async function savePrompt(){ const v=$('#prompt-ta').value; const r=await send('/api/system-prompt','POST',{prompt:v}); if(r){toast('تم حفظ الموجّه ✓ وأُضيفت نسخة للسجل');aiPrompt();}else toast('فشل الحفظ','bad'); }
async function aiQuality(){
  const d=await api('/api/ai-analytics'); const s=(d&&d.summary)||{}; const conf=Math.round((s.avg_confidence||0)*100);
  const card=(ic,l,v,u,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}${u?`<small>${u}</small>`:''}</div></div>`;
  fill('#ai-body',`<div class="kpis" style="margin-bottom:18px">
      ${card('cpu','نجاح الذكاء',s.ai_success_rate||0,'%',(s.ai_success_rate||0)>70?'ok':'warn')}
      ${card('check','حلّ التدخّلات',s.resolution_rate||0,'%',(s.resolution_rate||0)>50?'ok':'warn')}
      ${card('chart','متوسط الثقة',conf,'%',conf>=50?'ok':(conf>0?'warn':''))}
      ${card('alert','تدخّلات',s.total_interventions||0)}</div>
    <div class="split">
      <div class="panel"><div class="panel-h">${icon('alert')}<h2>تحليل الفشل / الاعتراضات</h2></div><div class="panel-b">
        ${((d&&d.by_reason)||[]).map(r=>`<div class="row between mb16"><span>${esc(({PAYMENT_INTENT:'نية دفع',HUMAN_REPEAT:'تكرار (حظر)',AI_LOOP_DETECTED:'تكرار AI',HUMAN_REQUESTED:'تدخل يدوي',UNKNOWN_QUESTION:'سؤال غير معروف',NO_CATALOG_MATCH:'لا منتج مطابق',LOW_CONFIDENCE:'ثقة منخفضة',AI_REPLY_FAILED:'فشل AI',CUSTOMER_COMPLAINT:'شكاية',PRODUCT_MISMATCH:'رفض منتج',PRODUCT_NOT_FOUND:'منتج غير معروف',HOT_LEAD:'عميل حار',CREDENTIALS:'معلومات حساسة'})[r.reason_code]||r.reason_code||'')}</span><div class="row gap8"><b class="num">${r.count}</b>${r.avg_conf!=null?`<span class="chip gray">ثقة ${Math.round((r.avg_conf||0)*100)}%</span>`:''}</div></div>`).join('')||empty('check','لا تدخّلات')}</div></div>
      <div class="panel"><div class="panel-h">${icon('trend')}<h2>جودة التوصية بالمنتجات</h2></div><div class="panel-b">
        <div class="dr-sec">الأكثر ذكراً</div>${((d&&d.top_products)||[]).slice(0,5).map(p=>`<div class="row between mb16"><span>${esc(p.product)}</span><span class="chip acc">${p.mentions}</span></div>`).join('')||'<div class="dim">—</div>'}
        ${((d&&d.low_confidence_products)||[]).length?`<div class="dr-sec">ثقة منخفضة</div>${d.low_confidence_products.map(p=>`<div class="row between mb16"><span>${esc(p.product_name)}</span><span class="chip warn">${p.misses} إخفاق</span></div>`).join('')}`:''}</div></div></div>
    ${(conf>0&&conf<50)?`<div class="panel" style="margin-top:16px"><div class="panel-b row gap8" style="color:var(--warn);font-size:13px">${icon('alert')} متوسط ثقة الذكاء ${conf}% — منخفض. راجع «التعلّم» وأضف أمثلة لرفع الجودة والتحويل.</div></div>`:''}`);
}
function _liAgo(ts){ try{ const d=(Date.now()-new Date(ts).getTime())/60000; if(d<1)return 'الآن'; if(d<60)return Math.round(d)+'د'; if(d<1440)return Math.round(d/60)+'س'; return Math.round(d/1440)+'يوم'; }catch(e){ return ''; } }
async function aiLearning(){
  const [inb,beh,q]=await Promise.all([api('/api/learning/inbox?limit=40'),api('/api/learning/behaviors?limit=40'),api('/api/unknown-questions')]);
  const feed=(inb&&inb.inbox)||[]; const behaviors=(beh&&beh.behaviors)||[]; const bstats=(beh&&beh.stats)||{}; const qs=q||[];
  window._liFeed={}; feed.forEach(x=>{ window._liFeed[x.id]={sub:x.subscriber_id,cm:x.customer_message||'',ar:x.ai_reply||'',ch:x.channel||''}; });
  window._uq={}; qs.forEach(x=>window._uq[x.id]=x.question||x.text||'');
  const card=x=>`<div class="panel-b" style="border-top:1px solid var(--line);padding:12px 14px">
    <div class="row between" style="margin-bottom:6px"><div class="fm">${esc(x.customer_name||x.subscriber_id||'زبون')} ${chanChip(x.channel)} ${x.agent?`<span class="chip gray">${esc(x.agent)}</span>`:''}</div><span class="fm">${_liAgo(x.created_at)}</span></div>
    <div style="margin-bottom:4px"><span class="fm">الزبون:</span> <b>${esc((x.customer_message||'—').slice(0,160))}</b></div>
    <div style="margin-bottom:8px"><span class="fm">الذكاء:</span> ${esc((x.ai_reply||'').slice(0,220))}</div>
    <div class="actions"><button class="btn primary sm" onclick="approveLi(${x.id})">✅ صحيح</button>
      <button class="btn sm" onclick="editLi(${x.id})">✏️ صحّح</button>
      <button class="btn ghost sm" onclick="takeoverLi(${x.id})">👤 تدخّل</button></div></div>`;
  fill('#ai-body',`
    <div class="panel" style="margin-bottom:16px"><div class="panel-h">${icon('msg')}<h2>📥 صندوق التعلّم — ردود الذكاء الأخيرة</h2><span class="cnt">${feed.length}</span></div>
      ${feed.length? feed.map(card).join('') : `<div class="panel-b">${empty('check','لا ردود حديثة','هنا تبان كل ردود الذكاء على الزبناء الحقيقيين — صحّح، علّم، ولا تدخّل.')}</div>`}</div>
    <div class="panel" style="margin-bottom:16px"><div class="panel-h">${icon('cpu')}<h2>📚 مكتبة السلوك — القواعد المتعلَّمة</h2><span class="cnt">${bstats.total||0}</span><span class="chip acc" style="margin-right:auto">${bstats.total_uses||0} استعمال</span></div><div class="panel-b">
      ${behaviors.length? behaviors.map(bv=>`<div class="row between mb16"><div style="flex:1;min-width:0"><b>${esc((bv.customer_message||'—').slice(0,64))}</b><div class="fm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:520px">→ ${esc((bv.correct_reply||'').slice(0,130))}</div></div>
        <div class="actions"><span class="chip gray">${esc(bv.entry_type||bv.category||'')}</span><span class="chip acc">${bv.uses||0}×</span></div></div>`).join('') : empty('cpu','لا سلوكات بعد','كل ما تصحّح ردّاً، تتسجّل قاعدة سلوك هنا (بدمج ذكي للمكرّر — يرفع العدّاد بدل نسخة جديدة).')}</div></div>
    <div class="panel"><div class="panel-h">${icon('search')}<h2>أسئلة بلا إجابة</h2><span class="cnt">${qs.length}</span></div><div class="panel-b">
      ${qs.length? qs.map(x=>`<div class="row between mb16"><div style="flex:1;min-width:0"><b>${esc(x.question||x.text||'')}</b><div class="fm">${esc(x.customer_name||'')} ${chanChip(x.channel)}</div></div>
        <button class="btn primary sm" onclick="answerQuestion(${x.id})">${icon('check')} أجب وعلّم</button></div>`).join('') : empty('check','لا أسئلة معلّقة')}</div></div>`);
}
async function approveLi(id){ const f=window._liFeed&&window._liFeed[id]; if(!f)return; const r=await send('/api/learning/feedback','POST',{subscriber_id:f.sub,customer_message:f.cm,reply:f.ar,action:'approve',channel:f.ch}); if(r&&r.ok){toast(r.merged?('تعزَّز السلوك ✓ '+(r.uses?('('+r.uses+'×)'):'')):'تسجّل كسلوك صحيح ✓');}else toast((r&&r.error)||'فشل','bad'); }
function editLi(id){ const f=window._liFeed&&window._liFeed[id]; if(!f)return;
  openModal(`<div class="modal-h"><span>✏️ صحّح الرد وعلّم</span><button class="iconbtn" onclick="closeModal()">${icon('x')}</button></div>
    <div class="modal-b"><div class="dim" style="margin-bottom:8px">الزبون: ${esc(f.cm)}</div>
      <label class="lbl-f">الرد المصحَّح</label><textarea class="ta" id="li-edit" rows="4" style="margin-bottom:10px">${esc(f.ar)}</textarea>
      <label class="row gap8" style="cursor:pointer;user-select:none"><input type="checkbox" id="li-send"> صيفط الرد المصحَّح للزبون دابا</label></div>
    <div class="modal-f"><button class="btn ghost" onclick="closeModal()">إلغاء</button><button class="btn primary" onclick="saveLiEdit(${id})">${icon('check')} حفظ وتعلّم</button></div>`); }
async function saveLiEdit(id){ const f=window._liFeed&&window._liFeed[id]; if(!f)return; const txt=($('#li-edit')&&$('#li-edit').value||'').trim(); if(!txt){toast('اكتب الرد','bad');return;}
  const doSend=$('#li-send')&&$('#li-send').checked;
  const r=await send('/api/learning/feedback','POST',{subscriber_id:f.sub,customer_message:f.cm,reply:txt,action:'edit',channel:f.ch});
  if(doSend){ const s=await send('/api/customers/'+encodeURIComponent(f.sub)+'/message','POST',{message:txt,channel:f.ch}); if(s&&(s.success||s.delivered)) toast('تصحّح + تصيفط للزبون ✓'); else toast('تعلّم ✓ لكن الإرسال فشل','bad'); }
  else { if(r&&r.ok) toast('تعلّم من التصحيح ✓'); else toast((r&&r.error)||'فشل','bad'); }
  closeModal(); }
async function takeoverLi(id){ const f=window._liFeed&&window._liFeed[id]; if(!f)return; if(!confirm('توقف الذكاء وتدخل بشري مع هاد الزبون؟'))return;
  const r=await send('/api/customers/'+encodeURIComponent(f.sub)+'/takeover','POST',{}); if(r){toast('تم التدخل — الذكاء متوقف لهاد الزبون');location.hash='#/inbox';}else toast('فشل','bad'); }
function answerQuestion(id){ const question=(window._uq&&window._uq[id])||'';
  openModal(`<div class="modal-h"><span>أجب وعلّم الذكاء</span><button class="iconbtn" onclick="closeModal()">${icon('x')}</button></div>
    <div class="modal-b"><div class="dim" style="margin-bottom:10px">${esc(question)}</div>
      <label class="lbl-f">الإجابة الصحيحة</label><textarea class="ta" id="ans-txt" rows="4" style="margin-bottom:10px"></textarea>
      <label class="lbl-f">الفئة</label><input class="inp" id="ans-cat" value="general"></div>
    <div class="modal-f"><button class="btn ghost" onclick="closeModal()">إلغاء</button><button class="btn primary" onclick="submitAnswer(${id})">${icon('check')} حفظ كتعليم</button></div>`); }
async function submitAnswer(id){ const a=$('#ans-txt').value.trim(); if(!a){toast('اكتب الإجابة','bad');return;}
  const r=await send('/api/unknown-questions/'+id+'/answer','PATCH',{answer:a,category:$('#ans-cat').value||'general'}); if(r){closeModal();toast('تم التعليم ✓ — أُضيفت كمثال');aiLearning();}else toast('فشل','bad'); }
async function mapKeyword(id){ const p=prompt('اربط الكلمة بأي منتج؟ (اسم المنتج)'); if(p==null)return; const r=await send('/api/unknown-keywords/'+id+'/map','PATCH',{product:p}); if(r){toast('تم الربط');aiLearning();}else toast('فشل','bad'); }
async function ignoreKeyword(id){ const r=await send('/api/unknown-keywords/'+id+'/ignore','PATCH',{}); if(r){toast('تم التجاهل');aiLearning();}else toast('فشل','bad'); }
function openTrainingForm(){ openModal(`<div class="modal-h"><span>مثال تدريب جديد</span><button class="iconbtn" onclick="closeModal()">${icon('x')}</button></div>
    <div class="modal-b"><label class="lbl-f">سؤال/رسالة الزبون</label><textarea class="ta" id="tr-q" rows="2" style="margin-bottom:10px"></textarea>
      <label class="lbl-f">الرد الصحيح</label><textarea class="ta" id="tr-a" rows="3" style="margin-bottom:10px"></textarea>
      <label class="lbl-f">الفئة</label><input class="inp" id="tr-cat" value="general"></div>
    <div class="modal-f"><button class="btn ghost" onclick="closeModal()">إلغاء</button><button class="btn primary" onclick="addTraining()">${icon('check')} إضافة</button></div>`); }
async function addTraining(){ const q=$('#tr-q').value.trim(),a=$('#tr-a').value.trim(); if(!q||!a){toast('املأ السؤال والرد','bad');return;}
  const r=await send('/api/training','POST',{question:q,correct_answer:a,category:$('#tr-cat').value||'general'}); if(r){closeModal();toast('تمت إضافة مثال التدريب ✓');aiLearning();}else toast('فشل','bad'); }
async function deleteTraining(id){ if(!confirm('حذف مثال التدريب؟'))return; const r=await send('/api/training/'+id,'DELETE'); if(r){toast('تم الحذف');aiLearning();}else toast('فشل','bad'); }
async function aiMemory(){
  const [emb,tr,sp]=await Promise.all([api('/api/products/embed-status'),api('/api/training'),api('/api/system-prompt')]);
  const training=tr||[]; const e=emb||{}; const promptLen=(sp&&sp.prompt)?sp.prompt.length:0;
  const card=(ic,l,v,u,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}${u?` <small>${u}</small>`:''}</div></div>`;
  fill('#ai-body',`
    <div class="kpis" style="margin-bottom:18px">
      ${card('package','منتجات مفهرسة دلالياً',(e.embedded||0)+'/'+(e.total||0),'',(e.embedded>0)?'ok':'warn')}
      ${card('cpu','أمثلة التدريب',training.length)}
      ${card('msg','حجم الموجّه',(Math.round(promptLen/100)/10),'k حرف')}</div>
    <div class="panel"><div class="panel-h">${icon('activity')}<h2>سجل التعلّم (Learning Timeline)</h2></div><div class="panel-b">
      ${training.length? `<div class="tline">${training.slice(0,20).map(t=>`<div class="tev"><div class="tt">تعلّم: ${esc((t.customer_message||'').slice(0,55))}</div><div class="td">${esc((t.correct_answer||'').slice(0,70))} · ${dt(t.created_at)}</div></div>`).join('')}</div>` : empty('activity','لا أحداث تعلّم بعد','كل إجابة سؤال أو مثال تدريب يظهر هنا زمنياً.')}</div></div>
    <div class="panel" style="margin-top:16px"><div class="panel-b row gap12" style="align-items:flex-start">${icon('alert')}
      <div style="font-size:13px;color:var(--text-2)"><b style="color:var(--text)">قاعدة معرفة RAG قابلة للتحرير (تُغذّي البوت)</b><br>معرفة البوت حالياً = المنتجات المفهرسة دلالياً + الموجّه + أمثلة التدريب. قاعدة معرفة منفصلة قابلة للتحرير تتطلب توسعة backend + n8n — مرحلة لاحقة (بعد إكمال الأمان).</div></div></div>`);
}

/* ============================================================ SYSTEM */
async function renderSystem(){
  const tabs=[['health','الصحة'],['status','الحالة'],['delivery','التسليم'],['security','الأمان'],['backup','النسخ'],['errors','الأخطاء'],['sessions','الجلسات'],['activity','السجل'],['audit','التدقيق']];
  if(!tabs.map(t=>t[0]).includes(_sysTab))_sysTab='health';
  mount(phead('⚙️ النظام والإعدادات','مركز الصحة · المراقبة · التسليم · الأمان · السجل · التدقيق')+
    `<div class="tabs">${tabs.map(t=>`<div class="tab ${t[0]===_sysTab?'active':''}" onclick="_sysTab='${t[0]}';renderSystem()">${t[1]}</div>`).join('')}</div><div id="sys-body">${skel()}</div>`);
  ({health:sysHealth,status:sysStatus,delivery:sysDelivery,security:sysSecurity,backup:sysBackup,errors:sysErrors,sessions:sysSessions,activity:sysActivity,audit:sysAudit,pay_accounts:sysPayAccounts,wizard:sysWizard}[_sysTab]||sysHealth)();
}
async function sysStatus(){
  const [st,ph,ai]=await Promise.all([api('/api/ops/status'),api('/api/ops/production-health'),api('/api/ops/ai-status')]);
  const svc=(name,o)=>{const up=o&&(o.status==='ok'||o.status==='up'||o.status==='healthy');return `<div class="panel" style="padding:14px"><div class="row between"><div class="row gap8"><span class="dot-s ${up?'ok':'bad'}"></span><b>${name}</b></div><span class="dim num" style="font-size:12px">${o&&o.latency_ms!=null?o.latency_ms:'—'} ms</span></div></div>`;};
  const t=(ph&&ph.traffic)||{};
  fill('#sys-body',`
    <div class="panel" style="margin-bottom:18px"><div class="panel-h">${icon('power')}<h2>محرّك الذكاء</h2>
      <div class="row gap8" style="margin-right:auto"><span class="${ai&&ai.ai_paused?'bad':'ok'}" style="font-size:13px;font-weight:700">${ai&&ai.ai_paused?'موقوف':'نشط'}</span>
      <div class="toggle ${ai&&ai.ai_paused?'':'on'}" onclick="toggleAI(${!!(ai&&ai.ai_paused)})"></div></div></div></div>
    <div class="grid g2" style="margin-bottom:18px">${svc('OpenAI',st&&st.openai)}${svc('ManyChat',st&&st.manychat)}${svc('PostgreSQL',st&&st.postgres)}${svc('Dashboard',st&&st.dashboard)}</div>
    <div class="kpis"><div class="kpi" style="cursor:default"><div class="top"><div class="ic">${icon('user')}</div><div class="lbl">زبائن نشطون 24س</div></div><div class="val num">${t.active_customers_24h||0}</div></div>
      <div class="kpi" style="cursor:default"><div class="top"><div class="ic">${icon('msg')}</div><div class="lbl">رسائل مستلمة</div></div><div class="val num">${t.messages_received||0}</div></div>
      <div class="kpi a-ok" style="cursor:default"><div class="top"><div class="ic">${icon('send')}</div><div class="lbl">ردود الذكاء</div></div><div class="val num">${t.ai_replies_sent||0} <small>${t.reply_rate_pct||0}%</small></div></div>
      <div class="kpi a-${(ph&&ph.errors?ph.errors.unresolved:0)>0?'bad':'ok'}" style="cursor:pointer" onclick="_sysTab='errors';renderSystem()"><div class="top"><div class="ic">${icon('alert')}</div><div class="lbl">أخطاء غير محلولة</div></div><div class="val num">${ph&&ph.errors?ph.errors.unresolved:0}</div></div></div>`);
}
async function toggleAI(paused){ const r=await send('/api/ops/'+(paused?'resume-ai':'pause-ai'),'POST',{}); if(r){toast(paused?'تم تشغيل الذكاء':'تم إيقاف الذكاء');renderSystem();}else toast('فشل','bad'); }
async function sysErrors(){
  const [we,sum]=await Promise.all([api('/api/workflow-errors'),api('/api/ops/errors/summary')]);
  const real=(we||[]).filter(e=>!e.is_test);
  fill('#sys-body',`<div class="row gap12" style="margin-bottom:16px"><span class="chip ${(sum&&sum.real_unresolved)>0?'bad':'ok'}">${(sum&&sum.real_unresolved)||0} غير محلول</span>
    <span class="chip gray">${(sum&&sum.real_errors)||0} حقيقي</span><span class="chip gray">${(sum&&sum.test_errors_total)||0} اختبار</span></div>
    <div class="panel tbl-wrap"><table class="tbl"><thead><tr><th>النوع</th><th>العقدة</th><th>الرسالة</th><th>الخطورة</th><th>الوقت</th><th></th></tr></thead><tbody>
    ${real.slice(0,40).map(e=>`<tr><td><b>${esc(e.error_type||'خطأ')}</b></td><td class="dim">${esc(e.node_name||'')}</td>
      <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.error_message||'')}</td>
      <td>${e.severity==='critical'?'<span class="chip bad">حرج</span>':`<span class="chip warn">${esc(e.severity||'')}</span>`}</td>
      <td class="dim num" style="font-size:12px">${dt(e.started_at)}</td>
      <td>${e.resolved?`<span class="chip ok">محلول</span>`:`<button class="btn sm" onclick="resolveErr(${e.id})">${icon('check')} حلّ</button>`}</td></tr>`).join('')||`<tr><td colspan="6">${empty('check','لا أخطاء حقيقية','كل العمليات تعمل بسلاسة.')}</td></tr>`}</tbody></table></div>`);
}
async function resolveErr(id){ const r=await send('/api/workflow-errors/'+id+'/resolve','PATCH',{}); if(r){toast('تم وضع علامة محلول');sysErrors();}else toast('فشل','bad'); }
async function sysSessions(){
  const s=await api('/api/sessions/health');
  const card=(ic,l,v,u,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}${u?`<small>${u}</small>`:''}</div></div>`;
  fill('#sys-body',`<div class="kpis">
    ${card('user','إجمالي الملفات',s?s.total_profiles:0)}${card('check','جلسات مُنشأة',s?s.sessions_established:0,'',(s&&s.session_coverage_pct||0)>80?'ok':'warn')}
    ${card('clock','جلسات معلّقة',s?s.sessions_pending:0)}${card('chart','تغطية الجلسات',(s?s.session_coverage_pct:0)+'%',(s&&s.session_coverage_pct||0)>80?'':'warn')}
    ${card('alert','فشل كتابة 24س',s?s.write_failures_24h:0,'',(s&&s.write_failures_24h||0)>0?'bad':'ok')}${card('alert','أخطاء قراءة 24س',s?s.read_errors_24h:0,'',(s&&s.read_errors_24h||0)>0?'bad':'ok')}</div>`);
}
async function sysSecurity(){
  const s=await api('/api/settings'); const https=location.protocol==='https:';
  const sec=(ok,label,note)=>`<div class="row between" style="padding:9px 0;border-bottom:1px solid var(--border)"><div class="row gap8"><span class="dot-s ${ok?'ok':'warn'}"></span><span style="font-size:13px">${label}</span></div><span class="chip ${ok?'ok':'warn'}">${note}</span></div>`;
  fill('#sys-body',`<div class="split">
    <div style="display:flex;flex-direction:column;gap:18px">
      <div class="panel"><div class="panel-h">${icon('sliders')}<h2>إعدادات المتجر</h2><button class="btn primary sm" style="margin-right:auto" onclick="saveStoreSettings()">${icon('check')} حفظ</button></div>
        <div class="panel-b"><label class="lbl-f">اسم المتجر</label><input class="inp" id="set-name" value="${esc(s?s.store_name:'')}" style="margin-bottom:12px">
          <label class="lbl-f">البريد الإلكتروني</label><input class="inp" id="set-email" value="${esc(s?s.store_email:'')}" style="margin-bottom:12px">
          <label class="lbl-f">الهاتف</label><input class="inp" id="set-phone" value="${esc(s?s.store_phone:'')}"></div></div>
      <div class="panel"><div class="panel-h">${icon('user')}<h2>تغيير كلمة المرور</h2></div>
        <div class="panel-b"><label class="lbl-f">الحالية</label><input type="password" class="inp" id="pw-cur" style="margin-bottom:12px" autocomplete="current-password">
          <label class="lbl-f">الجديدة</label><input type="password" class="inp" id="pw-new" style="margin-bottom:12px" autocomplete="new-password">
          <button class="btn primary" onclick="changePassword()">${icon('check')} تحديث كلمة المرور</button></div></div></div>
    <div class="panel"><div class="panel-h">${icon('alert')}<h2>نظرة أمنية (Security Overview)</h2></div><div class="panel-b">
      ${sec(https,'HTTPS / تشفير الاتصال',https?'مفعّل':'غير مفعّل')}
      ${sec(true,'قاعدة البيانات مقفلة عن الإنترنت','مؤمّنة')}
      ${sec(true,'نسخ احتياطي مشفّر off-box','يعمل')}
      ${sec(false,'فرض المصادقة على الـ API (JWT)','مرحلة لاحقة')}
      ${sec(true,'تدوير مفاتيح الذكاء + إدارة الأسرار (AES-256 مشفّر)','مفعّل')}
      <div class="dim" style="font-size:12px;margin-top:10px">🔑 إدارة مفاتيح مزوّدي الذكاء (OpenAI / Claude / Gemini) مفعّلة ومخزّنة <b>مشفّرة (AES-256 at rest)</b> — المصدر الوحيد للمفاتيح. اذهب: <b>System → AI Studio → 🔑 المفاتيح</b>. الحفظ يطبّق فوراً على كامل الـ backend بلا restart وبلا SSH.</div></div></div></div>`);
}
async function saveStoreSettings(){
  const fields=[['store_name',$('#set-name').value],['store_email',$('#set-email').value],['store_phone',$('#set-phone').value]];
  let ok=true; for(const f of fields){ const r=await send('/api/settings','POST',{key:f[0],value:f[1]}); if(!r)ok=false; }
  toast(ok?'تم حفظ الإعدادات ✓':'فشل حفظ بعض الحقول',ok?'ok':'bad'); }
async function changePassword(){ const cur=$('#pw-cur').value,nw=$('#pw-new').value; if(!cur||!nw){toast('املأ الحقلين','bad');return;}
  if(nw.length<6){toast('كلمة المرور قصيرة (6+ أحرف)','bad');return;}
  const r=await send('/api/settings/change-password','POST',{current_password:cur,new_password:nw});
  if(r&&r.success){toast('تم تغيير كلمة المرور ✓');$('#pw-cur').value='';$('#pw-new').value='';}else toast('كلمة المرور الحالية غير صحيحة','bad'); }
async function sysBackup(){
  const b=await api('/api/ops/backups');
  const card=(ic,l,v,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}</div></div>`;
  const sizeMB=b?(Math.round((b.total_size||0)/104857.6)/10):0;
  fill('#sys-body',`<div class="kpis" style="margin-bottom:18px">
      ${card('layers','نسخ محلية',b?b.count:0,(b&&b.count>0)?'ok':'warn')}
      ${card('check','off-box مشفّرة',b?b.offbox_encrypted:0,(b&&b.offbox_encrypted>0)?'ok':'warn')}
      ${card('clock','آخر نسخة',b&&b.latest?timeAgo(b.latest.mtime):'—')}
      ${card('package','الحجم',sizeMB+' MB')}</div>
    <div class="panel"><div class="panel-h">${icon('layers')}<h2>النسخ الاحتياطية</h2></div><div>${
      (b&&b.files&&b.files.length)? b.files.map(f=>`<div class="row between" style="padding:11px 16px;border-bottom:1px solid var(--border)"><span class="num">${esc(f.name)}</span><span class="dim num" style="font-size:12px">${Math.round(f.size/1024)} KB · ${dt(f.mtime)}</span></div>`).join('') : empty('layers','لا نسخ')}</div></div>
    <div class="panel" style="margin-top:16px"><div class="panel-b row gap8" style="color:var(--ok);font-size:13px">${icon('check')} النسخ تلقائية يومياً (3ص محلي · 3:10ص مشفّرة إلى Google Drive). الاستعادة تتم عبر الخادم عند الحاجة.</div></div>`);
}
/* ---------- Delivery / Outbox (System → التسليم) — المصدر الرسمي لتتبّع التسليم ---------- */
async function sysDelivery(){
  const [s,d]=await Promise.all([api('/api/ops/outbox/stats'),api('/api/ops/outbox?limit=150')]);
  const rows=(d&&d.outbox)||[];
  const kpi=(ic,l,v,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}</div></div>`;
  const stB=st=>st==='sent'?'<span class="chip ok">مُسلَّم</span>':st==='pending'?'<span class="chip warn">قيد الإرسال</span>':st==='failed'?'<span class="chip warn">فشل (إعادة)</span>':st==='dead'?'<span class="chip bad">ميّت</span>':`<span class="chip gray">${esc(st)}</span>`;
  fill('#sys-body',`
    <div class="row gap12 wrapf" style="align-items:center;margin-bottom:14px">
      <span class="chip ${s&&s.worker?'ok':'bad'}">${icon(s&&s.worker?'check':'x')} العامل ${s&&s.worker?'يعمل':'متوقّف'}${s&&s.tick_ms?` · كل ${Math.round(s.tick_ms/1000)}ث`:''}</span>
      <button class="btn ghost sm" onclick="ocDrain()">${icon('refresh')} تفريغ الآن</button>
      <button class="btn ghost sm" onclick="sysDelivery()">${icon('refresh')} تحديث</button></div>
    <div class="kpis" style="margin-bottom:16px">
      ${kpi('clock','قيد الإرسال',(s&&s.pending)||0,((s&&s.pending)?'warn':''))}
      ${kpi('refresh','فشل (إعادة)',(s&&s.failed)||0,((s&&s.failed)?'warn':''))}
      ${kpi('alert','ميّت (تدخّل)',(s&&s.dead)||0,((s&&s.dead)?'bad':''))}
      ${kpi('check','مُسلَّم',(s&&s.sent)||0,'ok')}
    </div>
    <div class="panel"><div class="panel-h">${icon('send')}<h2>سجلّ التسليم (Outbox)</h2><span class="cnt">${rows.length}</span><span class="dim" style="font-size:11px;margin-inline-start:auto">المصدر الرسمي لتتبّع التسليم · ضمان عدم فقد أي رسالة</span></div>
      <div class="panel-b">${rows.length?`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>الزبون</th><th>القناة</th><th>الردّ</th><th>الحالة</th><th>محاولات</th><th>الخطأ</th><th>إجراء</th></tr></thead><tbody>${rows.map(o=>`<tr><td class="num" style="white-space:nowrap">${dt(o.created_at)}</td><td><span style="cursor:pointer;color:var(--accent)" onclick="openCustomer('${esc(o.subscriber_id)}','chat')">${esc(o.subscriber_id||'—')}</span></td><td>${esc(o.channel||'—')}</td><td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((o.reply_text||'').slice(0,90))}</td><td>${stB(o.status)}</td><td class="num">${o.attempts||0}/${o.max_attempts||6}</td><td class="dim" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${esc((o.last_error||'').slice(0,60))}</td><td>${(o.status==='failed'||o.status==='dead')?`<button class="btn sm" onclick="ocRequeue(${o.id})">${icon('refresh')} إعادة</button>`:'<span class="dim">—</span>'}</td></tr>`).join('')}</tbody></table></div>`:empty('send','لا سجلّ تسليم بعد','تظهر هنا كل ردود البوت مع حالة تسليمها — أي ردّ لم يصل يُعاد إرساله تلقائياً.')}</div></div>`);
  clearTimeout(window._delT); window._delT=setTimeout(()=>{ if(_sysTab==='delivery'&&(location.hash.replace('#/','')||'').split('/')[0]==='system') sysDelivery(); },20000);
}
async function ocRequeue(id){ const r=await send('/api/ops/outbox/'+id+'/requeue','PATCH',{}); if(r){toast('أُعيد للطابور ✓');sysDelivery();}else toast('فشل','bad'); }
async function ocDrain(){ const r=await send('/api/ops/outbox/drain','POST',{}); if(r){toast('تم التفريغ'+(r.sent!=null?` (${r.sent})`:''));sysDelivery();}else toast('فشل','bad'); }
let _atFilter='all';
async function sysActivity(){
  const d=await api('/api/events?limit=150'); const evs=(d&&d.events)?d.events:(Array.isArray(d)?d:[]); window._atEvents=evs;
  const types=[['all','الكل'],['customer','محادثات + ردود'],['order','طلبات'],['payment','مدفوعات'],['intervention','تدخّلات']];
  fill('#sys-body',`
    <div class="filterbar">${types.map(t=>`<button class="chipbtn ${t[0]===_atFilter?'active':''}" onclick="_atFilter='${t[0]}';renderTimeline()">${esc(t[1])}</button>`).join('')}
      <button class="btn ghost sm" style="margin-inline-start:auto" onclick="sysActivity()">${icon('refresh')} تحديث</button></div>
    <div class="panel"><div class="panel-h">${icon('activity')}<h2>الخط الزمني للنشاط</h2><span class="cnt" id="at-cnt">${evs.length}</span><span class="chip ok" style="margin-inline-start:8px">● مباشر</span></div>
      <div class="panel-b" id="at-body">${skel()}</div></div>`);
  renderTimeline();
}
function atMeta(t){ return {customer:['msg','رسالة + ردّ'],order:['cart','اهتمام/طلب شراء'],payment:['card','دفع'],intervention:['alert','تدخّل بشري'],order_paid:['card','دفعة مؤكدة'],order_delivered:['truck','تسليم']}[t]||['activity',t||'حدث']; }
function renderTimeline(){
  let evs=(window._atEvents||[]).slice();
  if(_atFilter!=='all') evs=evs.filter(e=>e.type===_atFilter);
  const cnt=$('#at-cnt'); if(cnt)cnt.textContent=evs.length;
  document.querySelectorAll('.filterbar .chipbtn').forEach(b=>b.classList.toggle('active', b.getAttribute('onclick').includes("'"+_atFilter+"'")));
  fill('#at-body', evs.length? `<div class="tline2">${evs.map(timelineRow).join('')}</div>` : empty('activity', _atFilter==='all'?'لا أحداث بعد':'لا أحداث من هذا النوع','تظهر هنا المحادثات والردود والطلبات والمدفوعات والتدخّلات لحظيًّا.'));
}
function timelineRow(e){ const m=atMeta(e.type); const parts=(e.message||'').split(' → '); const cm=parts[0]||''; const ai=parts.length>1?parts.slice(1).join(' → '):'';
  const tone=e.type==='payment'?'ok':(e.type==='intervention'?'warn':(e.type==='order'?'acc':''));
  return `<div class="tl-ev" ${e.subscriber_id?`onclick="openCustomer('${e.subscriber_id}','chat')"`:''}>
    <div class="tl-dot ${tone}">${icon(m[0])}</div>
    <div class="tl-c"><div class="row gap8 wrapf"><b class="ft">${esc(e.customer_name||'النظام')}</b>${e.channel?' '+chanChip(e.channel):''} <span class="chip gray">${esc(m[1])}</span><span class="fa" style="margin-inline-start:auto">${timeAgo(e.created_at)}</span></div>
      ${cm?`<div class="tl-msg user">${esc(cm.slice(0,200))}</div>`:''}
      ${ai?`<div class="tl-msg ai">${icon('spark2')} ${esc(ai.slice(0,200))}</div>`:''}</div></div>`; }

/* ---------- Health Center (System → الصحة) ---------- */
async function sysHealth(){
  const d=await api('/api/ops/health-center');
  if(!d){ fill('#sys-body',empty('alert','تعذّر تحميل مركز الصحة','أعد المحاولة')); return; }
  const sc=d.health_score, scCls=sc>=90?'ok':(sc>=60?'warn':'bad');
  const sIcon=s=>s==='up'?'🟢':s==='idle'?'🟡':s==='stale'?'🟠':'🔴';
  const cmap={'OpenAI':'openai','Telegram Bot':'telegram','n8n':'n8n','ManyChat→n8n':'manychat','WhatsApp':'whatsapp'};
  const cState=p=>{const x=(d.circuit||[]).find(c=>c.provider===p);return x?x.state:null;};
  const cBadge=name=>{const st=cState(cmap[name]); if(st==='open')return `<span class="chip bad" title="قاطع الدائرة مفتوح — يُتخطّى المزوّد مؤقتاً">⛔ دائرة مفتوحة</span>`; if(st==='half_open')return `<span class="chip warn" title="تجربة تعافٍ">🟡 نصف-مفتوحة</span>`; return '';};
  const openCir=(d.circuit||[]).filter(c=>c.state==='open').map(c=>c.provider);
  fill('#sys-body',`
    <div class="row gap12 wrapf" style="align-items:center;margin-bottom:16px">
      <div class="kpi a-${scCls}" style="cursor:default;min-width:150px"><div class="top"><div class="ic">${icon('activity')}</div><div class="lbl">Health Score</div></div><div class="val num">${sc}<small>%</small></div></div>
      ${d.critical.length?`<span class="chip bad">${icon('alert')} معطّل: ${esc(d.critical.join(', '))}</span>`:`<span class="chip ok">${icon('check')} كل الخدمات تعمل</span>`}
      ${openCir.length?`<span class="chip bad" title="قاطع الدائرة فتح بعد أعطال متتالية">⛔ دائرة مفتوحة: ${esc(openCir.join(', '))}</span>`:''}
      <button class="btn ghost sm" style="margin-inline-start:auto" onclick="sysHealth()">${icon('refresh')} تحديث</button></div>
    <div class="panel"><div class="panel-h">${icon('sliders')}<h2>حالة الخدمات (Latency حيّ + قاطع الدائرة)</h2><span class="cnt">${d.services.length}</span></div><div class="panel-b">
      ${d.services.map(s=>`<div class="row between mb16"><div class="row gap8" style="min-width:0"><span style="font-size:15px">${sIcon(s.status)}</span><b>${esc(s.name)}</b><span class="dim" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.detail||'')}</span></div>
        <div class="actions">${cBadge(s.name)}<span class="chip ${s.status==='up'?'ok':(s.status==='down'?'bad':'warn')}">${esc(s.status)}</span><span class="chip gray num">${s.latency_ms}ms</span></div></div>`).join('')}</div></div>
    <div class="dim" style="font-size:11.5px;margin-top:10px">آخر فحص: ${dt(d.checked_at)} · زمن الفحص ${d.took_ms}ms · تحديث تلقائي كل 30 ثانية</div>`);
  clearTimeout(window._healthT); window._healthT=setTimeout(()=>{ if(_sysTab==='health'&&(location.hash.replace('#/','')||'').split('/')[0]==='system') sysHealth(); },30000);
}

/* ---------- Audit Log (System → التدقيق) ---------- */
let _auFilter={entity:'',method:'',q:''};
async function sysAudit(){
  const stats=await api('/api/audit/stats');
  fill('#sys-body',`
    <div class="kpis" style="margin-bottom:16px">${((stats&&stats.by_entity)||[]).slice(0,6).map(s=>`<div class="kpi" style="cursor:pointer" onclick="_auFilter.entity='${esc(s.entity)}';loadAudit()"><div class="top"><div class="ic">${icon('activity')}</div><div class="lbl">${esc(s.entity)}</div></div><div class="val num">${s.n}</div></div>`).join('')||`<div class="dim">لا بيانات تدقيق بعد</div>`}</div>
    <div class="filterbar">
      <div class="ibx-search" style="margin:0;flex:1;max-width:320px"><span class="s-ic">${icon('search')}</span><input id="au-q" placeholder="بحث في المسار / المنفّذ / التفاصيل…" value="${esc(_auFilter.q)}" oninput="_auFilter.q=this.value;clearTimeout(window._auT);window._auT=setTimeout(loadAudit,350)"></div>
      <select class="inp" onchange="_auFilter.method=this.value;loadAudit()" style="max-width:140px;height:42px">${['','POST','PATCH','PUT','DELETE'].map(m=>`<option value="${m}" ${_auFilter.method===m?'selected':''}>${m||'كل العمليات'}</option>`).join('')}</select>
      ${_auFilter.entity?`<button class="chipbtn active" onclick="_auFilter.entity='';loadAudit()">${esc(_auFilter.entity)} ✕</button>`:''}
      <button class="btn ghost sm" style="margin-inline-start:auto" onclick="window.open(API+'/api/audit/export','_blank')">${icon('ext')} تصدير CSV</button>
      <button class="btn ghost sm" onclick="loadAudit()">${icon('refresh')} تحديث</button></div>
    <div class="panel"><div class="panel-h">${icon('sliders')}<h2>سجل التدقيق (Audit Trail)</h2><span class="cnt" id="au-cnt">—</span></div><div class="panel-b" id="au-body">${skel()}</div></div>`);
  loadAudit();
}
async function loadAudit(){
  const p=new URLSearchParams(); if(_auFilter.q)p.set('q',_auFilter.q); if(_auFilter.method)p.set('method',_auFilter.method); if(_auFilter.entity)p.set('entity',_auFilter.entity); p.set('limit','300');
  const d=await api('/api/audit?'+p.toString()); const rows=(d&&d.entries)||[]; const c=$('#au-cnt'); if(c)c.textContent=rows.length;
  const mcls=m=>({POST:'ok',PATCH:'acc',PUT:'acc',DELETE:'bad'}[m]||'gray');
  fill('#au-body', rows.length? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>الوقت</th><th>العملية</th><th>الكيان</th><th>المسار</th><th>المنفّذ</th><th>الحالة</th></tr></thead><tbody>${rows.map(r=>`<tr><td class="num" style="white-space:nowrap">${dt(r.created_at)}</td><td><span class="chip ${mcls(r.method)}">${esc(r.method)}</span></td><td>${esc(r.entity||'')}</td><td class="dim" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.detail||'')}">${esc(r.path||'')}</td><td>${esc(r.actor||'')}</td><td><span class="chip ${r.status<400?'ok':'bad'}">${r.status}</span></td></tr>`).join('')}</tbody></table></div>` : empty('sliders',(_auFilter.q||_auFilter.method||_auFilter.entity)?'لا نتائج مطابقة':'لا سجلات تدقيق بعد','كل إجراء تعديل (إنشاء/تحديث/حذف/تغيير الموجّه) يُسجَّل هنا تلقائياً.'));
}

/* ============================================================ CRM (Customers) */
let _crmSeg='all',_crmSort='recent',_crmQ='';
function custHealth(c){ const h=c.hours_since_last!=null?parseFloat(c.hours_since_last):null;
  if(h==null)return{l:'—',c:'gray'}; if(h<24)return{l:'نشط',c:'ok'}; if(h<72)return{l:'يبرد',c:'warn'}; if(h<336)return{l:'معرّض',c:'warn'}; return{l:'خامل',c:'gray'}; }
async function renderCRM(){
  mount(phead('الزبائن (CRM)','إدارة العملاء · الصحة · التركيز على الأهم',
    `<button class="btn ghost" onclick="window.open('${API}/api/export/customers','_blank')">${icon('ext')} تصدير</button>`)+`<div id="crm-body">${skel()}</div>`);
  const c=await cached('customers',()=>api('/api/customers')); window._crmAll=c||[];
  try{ const iv=await api('/api/interventions?status=pending'); const rows=(iv&&(iv.interventions||iv.rows||iv.data))||[]; window._crmNeed=new Set(rows.map(x=>String(x.subscriber_id))); window._crmNeedR={}; rows.forEach(x=>{ window._crmNeedR[String(x.subscriber_id)]=x.reason_detail||x.reason_code||'تدخّل'; }); }catch(_e){ window._crmNeed=window._crmNeed||new Set(); }
  renderCRMBody();
}
function renderCRMBody(){
  let list=(window._crmAll||[]).slice(); const seg=_crmSeg;
  if(seg==='vip') list=list.filter(c=>(c.lifetime_value||0)>0);
  else if(seg==='highvalue') list=list.filter(c=>(c.lifetime_value||0)>0);
  else if(seg==='atrisk') list=list.filter(c=>{const h=parseFloat(c.hours_since_last||0);return h>=72&&h<336&&(c.total_messages||0)>=3;});
  else if(seg==='recent') list=list.filter(c=>parseFloat(c.hours_since_last!=null?c.hours_since_last:1e9)<48);
  else if(seg==='dormant') list=list.filter(c=>parseFloat(c.hours_since_last||0)>336);
  else if(seg==='needhuman') list=list.filter(c=>window._crmNeed&&window._crmNeed.has(String(c.subscriber_id)));
  if(_crmQ){const q=_crmQ.toLowerCase();list=list.filter(c=>(c.customer_name||'').toLowerCase().includes(q)||String(c.subscriber_id).includes(q)||(c.tags||'').toLowerCase().includes(q));}
  if(_crmSort==='ltv') list.sort((a,b)=>(b.lifetime_value||0)-(a.lifetime_value||0));
  else if(_crmSort==='messages') list.sort((a,b)=>(b.total_messages||0)-(a.total_messages||0));
  else list.sort((a,b)=>new Date(b.last_seen||0)-new Date(a.last_seen||0));
  const _needN=(window._crmNeed&&window._crmNeed.size)||0;
  const segs=[['all','الكل'],['needhuman','🔴 تدخّل'+(_needN?(' '+_needN):'')],['vip','VIP'],['highvalue','قيمة عالية'],['atrisk','معرّض للخطر'],['recent','نشط حديثاً'],['dormant','خامل']];
  const shown=list.slice(0,150);
  fill('#crm-body',`
    <div class="row gap8 wrapf mb16">${segs.map(s=>`<button class="btn sm ${s[0]===_crmSeg?'primary':'ghost'}" onclick="_crmSeg='${s[0]}';renderCRMBody()">${s[1]}</button>`).join('')}</div>
    <div class="row gap12 wrapf mb16">
      <input class="inp" style="flex:1;max-width:320px" placeholder="بحث بالاسم/المعرّف/الوسم…" value="${esc(_crmQ)}" oninput="_crmQ=this.value;clearTimeout(window._crmT);window._crmT=setTimeout(renderCRMBody,250)">
      <select class="inp" style="max-width:190px" onchange="_crmSort=this.value;renderCRMBody()">
        <option value="recent" ${_crmSort==='recent'?'selected':''}>الأحدث نشاطاً</option><option value="ltv" ${_crmSort==='ltv'?'selected':''}>الأعلى قيمة (CLV)</option><option value="messages" ${_crmSort==='messages'?'selected':''}>الأكثر رسائل</option></select>
      <span class="dim" style="align-self:center;font-size:12.5px">${list.length} زبون</span></div>
    <div class="panel tbl-wrap"><table class="tbl"><thead><tr><th>الزبون</th><th>القناة</th><th>المرحلة</th><th>الصحة</th><th>CLV</th><th>رسائل</th><th>آخر ظهور</th><th>الوسوم</th></tr></thead><tbody>
    ${shown.map(c=>{const hh=custHealth(c);return `<tr class="clickrow" onclick="openCustomer('${c.subscriber_id}')">
      <td><div class="row gap8"><div class="avatar-sm">${esc(initials(c.customer_name))}</div><b>${esc(c.customer_name||'زبون')}</b></div></td>
      <td>${chanChip(c.channel)}</td><td>${stageChip(c.stage)}${window._crmNeed&&window._crmNeed.has(String(c.subscriber_id))?' <span class="chip bad" title="محتاج تدخّل بشري">تدخّل</span>':''}</td><td><span class="chip ${hh.c}">${hh.l}</span></td>
      <td class="num">${money(c.lifetime_value)} <span class="dim">DH</span></td><td class="num">${c.total_messages||0}</td>
      <td class="dim num" style="font-size:12px">${timeAgo(c.last_seen)}</td>
      <td>${(c.tags||'').split(',').filter(Boolean).slice(0,3).map(t=>`<span class="chip gray">${esc(t.trim())}</span>`).join(' ')||'<span class="dim">—</span>'}</td></tr>`;}).join('')||`<tr><td colspan="8">${empty('user','لا زبائن في هذا الفلتر')}</td></tr>`}
    </tbody></table></div>${list.length>150?`<div class="dim" style="text-align:center;padding:10px;font-size:12px">يُعرض أول 150 — استخدم البحث/الفلاتر للتضييق</div>`:''}`);
}

/* ============================================================ FROZEN CUSTOMERS */
async function renderFrozen(){
  mount(phead('المجمّدون / الانتظار','الزبائن المجمّدون حسب السبب — الحالات التي تحتاج استئنافاً يدوياً',
    `<button class="btn ghost" onclick="renderFrozen()">${icon('refresh')} تحديث</button>`)+
    `<div id="frozen-body">${skel()}</div>`);
  loadFrozen();
}
async function loadFrozen(){
  const d=await api('/api/ops/frozen');
  if(!d){fill('#frozen-body',`<div class="chip bad" style="font-size:13px;padding:10px 16px">${icon('alert')} تعذّر جلب البيانات — تحقق من الخادم</div>`);return;}

  /* badge in sidebar */
  const nb=$('#nb-frozen');
  if(nb){if(d.total>0){nb.textContent=d.total;nb.style.display='';}else nb.style.display='none';}

  /* reason codes that self-expire */
  const AUTO_EXPIRE=new Set(['ai_loop']);

  /* KPI cards by reason */
  const reasonHtml=(d.by_reason||[]).map(r=>{
    const cls=r.auto_expire?'warn':(r.count>0?'bad':'gray');
    return `<div class="kpi a-${cls}" style="cursor:default;min-width:130px">
      <div class="top"><div class="ic">${icon('clock')}</div><div class="lbl">${esc(r.label||r.reason)}</div></div>
      <div class="val num">${r.count}${r.auto_expire?`<small style="font-size:11px;margin-right:4px">⏱ تلقائي</small>`:''}</div>
    </div>`;
  }).join('');

  /* per-customer table */
  const custs=(d.customers||[]);
  const rowsHtml=custs.length?`
    <div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th>الزبون</th><th>القناة</th><th>السبب</th><th>مدة التجميد</th><th>ملاحظة</th><th>إجراء</th>
    </tr></thead><tbody>
    ${custs.map(c=>{
      const isAuto=AUTO_EXPIRE.has(c.reason);
      const hrs=parseFloat(c.hours_frozen||0);
      const durTxt=hrs>=1?Math.round(hrs)+'س':(Math.round(hrs*60)||'<1')+'د';
      const durCls=hrs>=24?'bad':(hrs>=4?'warn':'gray');
      const mcLink=c.manychat_url&&String(c.manychat_url).startsWith('http')?
        `<a href="${esc(c.manychat_url)}" target="_blank" rel="noopener" style="font-size:12px">${icon('ext')} ManyChat</a>`:'';
      const autoNote=isAuto?`<span class="chip warn" title="ينتهي تلقائياً بعد 1 ساعة">⏱ auto 1h</span>`:'';
      return `<tr>
        <td><div class="row gap8"><div class="avatar-sm">${esc(initials(c.customer_name))}</div>
          <span style="cursor:pointer;color:var(--accent)" onclick="openCustomer('${esc(c.subscriber_id)}','chat')">${esc(c.customer_name||'زبون')}</span></div></td>
        <td>${chanChip(c.channel)}</td>
        <td><span class="chip ${isAuto?'warn':'bad'}">${esc(c.label||c.reason||'—')}</span></td>
        <td><span class="chip ${durCls}">${durTxt}</span></td>
        <td class="dim" style="font-size:12px">${autoNote}${mcLink}</td>
        <td>${isAuto?`<span class="dim" style="font-size:11px;margin-left:6px">⏱ تلقائي 1h</span><button class="btn ok sm" onclick="resumeFrozen('${esc(c.subscriber_id)}',this)">${icon('spark2')} استئناف الآن</button>`:
          `<button class="btn ok sm" onclick="resumeFrozen('${esc(c.subscriber_id)}',this)">${icon('spark2')} استئناف</button>`}</td>
      </tr>`;
    }).join('')}
    </tbody></table></div>`:empty('check','لا زبائن مجمّدون الآن','عند تجميد محادثة (تأكيد دفع / تدخّل يدوي / حبس تردد) تظهر هنا.');

  fill('#frozen-body',`
    <div class="kpis" style="margin-bottom:18px">${reasonHtml||`<div class="dim">لا أسباب</div>`}</div>
    <div class="chip gray" style="margin-bottom:12px;font-size:12px;display:inline-flex;gap:6px;align-items:center">
      ${icon('alert')} تنبيه: <b>ai_loop</b> يستأنف تلقائياً بعد ساعة — الباقي يحتاج استئناف يدوي
    </div>
    <div class="panel"><div class="panel-h">${icon('clock')}<h2>قائمة المجمّدين</h2><span class="cnt">${d.total}</span></div>
      <div class="panel-b">${rowsHtml}</div></div>`);
}
async function resumeFrozen(sid,btn){
  if(btn){btn.disabled=true;btn.textContent='…';}
  const r=await send('/api/customers/'+sid+'/takeover','DELETE');
  if(r){toast('تم استئناف الذكاء ✓');loadFrozen();}
  else{toast('فشل الاستئناف','bad');if(btn){btn.disabled=false;btn.innerHTML=icon('spark2')+' استئناف';}}
}

/* ============================================================
   PHASE-1 CONSOLIDATION — new workspace wrappers
   All OLD render functions are preserved above; these wrappers
   delegate to them so nothing is deleted.
   ============================================================ */

/* ---------- 3. ORDERS workspace (was "sales", analytics sub-tabs moved to analytics) ---------- */
let _ordTab='overview';
function gotoOrders(t){_ordTab=t||'overview';location.hash='#/orders';}
async function renderOrders(){
  /* Expose only order-centric sub-tabs here; analytics live in renderAnalytics */
  if(!['overview','warroom','claims','orders','promos'].includes(_ordTab))_ordTab='overview';
  const tabs=[['overview','نظرة عامة'],['warroom','غرفة الحرب'],['claims','مطالبات الدفع'],['orders','الطلبات'],['promos','العروض']];
  mount(phead('الطلبات والدفع','غرفة الحرب · مطالبات الدفع · الطلبات',
    `<button class="btn ghost" onclick="window.open('${API}/api/export/orders','_blank')">${icon('ext')} تصدير</button>`)+
    `<div class="tabs">${tabs.map(t=>`<div class="tab ${t[0]===_ordTab?'active':''}" onclick="_ordTab='${t[0]}';renderOrders()">${t[1]}</div>`).join('')}</div>
     <div id="sales-body">${skel()}</div>`);
  ({overview:salesOverview,warroom:salesWarRoom,claims:salesClaims,orders:salesOrders,promos:salesPromos}[_ordTab]||salesOverview)();
}

/* ---------- 6. HERMES workspace (was "recovery" + the old Hermes center) ---------- */
let _hermTab='center';
function gotoHermes(t){_hermTab=t||'center';location.hash='#/hermes';}
/* Keep old helper aliases so any existing onclick="gotoRecovery('followups')" still works */
function gotoRecovery(t){
  /* Map recovery sub-tabs → hermes sub-tabs */
  const MAP={center:'center',overview:'overview',lost:'lost',followups:'followups',renewals:'renewals',
             repeat:'repeat',winback:'winback',churn:'churn',broadcasts:'broadcasts'};
  _hermTab=MAP[t]||'center';
  location.hash='#/hermes';
}
async function renderHermes(){
  /* All sub-tabs from old renderRecovery, plus legacy cockpit hermes center is "center" */
  const tabs=[['center','المركز'],['overview','نظرة عامة'],['lost','مبيعات مفقودة'],
              ['followups','المتابعات'],['renewals','التجديدات'],['repeat','التكرار'],
              ['winback','الاسترجاع'],['churn','خطر التسرّب'],['broadcasts','الحملات']];
  const valid=tabs.map(t=>t[0]);
  if(!valid.includes(_hermTab))_hermTab='center';
  mount(phead('المتابعة والاسترجاع','مركز الاسترجاع · المبيعات المفقودة · التجديد · الحملات')+
    `<div class="tabs">${tabs.map(t=>`<div class="tab ${t[0]===_hermTab?'active':''}" onclick="_hermTab='${t[0]}';renderHermes()">${t[1]}</div>`).join('')}</div><div id="rec-body">${skel()}</div>`);
  ({center:recCenter,overview:recOverview,lost:recLost,followups:recFollowups,
    renewals:()=>recQueue('renewals'),repeat:()=>recQueue('repeat'),
    winback:()=>recQueue('winback'),churn:()=>recQueue('churn'),
    broadcasts:recBroadcasts}[_hermTab]||recCenter)();
}

/* ---------- 7. ANALYTICS workspace (NEW — consolidates existing renders) ---------- */
let _anaTab='overview';
function gotoAnalytics(t){_anaTab=t||'overview';location.hash='#/analytics';}
async function renderAnalytics(){
  const tabs=[
    ['overview','نظرة عامة'],   /* cockpit exec-center KPIs  */
    ['revenue','الإيراد'],        /* salesInsights               */
    ['funnel','القمع'],            /* salesWarRoom                */
    ['lost','المفقودة'],           /* recLost                    */
    ['retention','الاحتفاظ'],     /* recOverview                 */
    ['aicost','تكلفة AI']          /* aiQuality                  */
  ];
  if(!tabs.map(t=>t[0]).includes(_anaTab))_anaTab='overview';
  mount(phead('التقارير والتحليلات','نظرة عامة · الإيراد · قمع التحويل · مبيعات مفقودة · الاحتفاظ · تكلفة AI')+
    `<div class="tabs">${tabs.map(t=>`<div class="tab ${t[0]===_anaTab?'active':''}" onclick="_anaTab='${t[0]}';renderAnalytics()">${t[1]}</div>`).join('')}</div>
     <div id="ana-body">${skel()}</div>`);
  if(_anaTab==='overview')      anaOverview();
  else if(_anaTab==='revenue')  anaSalesInsights();
  else if(_anaTab==='funnel')   anaFunnel();
  else if(_anaTab==='lost')     anaLost();
  else if(_anaTab==='retention')anaRetention();
  else if(_anaTab==='aicost')   anaAiCost();
}

/* Analytics sub-tab: overview — cockpit KPI cards + exec summary */
async function anaOverview(){
  /* Reuse cockpit loaders but render into #ana-body */
  const [rev,sales,ph,hc,ivc]=await Promise.all([api('/api/revenue'),api('/api/intelligence/sales'),api('/api/ops/production-health'),cached('healthcenter',()=>api('/api/ops/health-center'),60000),api('/api/interventions/counts')]);
  const el=$('#ana-body'); if(!el)return;
  const revToday=(rev&&rev.today)?rev.today.revenue:0;
  const oT=(sales&&sales.orders_today)||0, oY=(sales&&sales.orders_yesterday)||0;
  const growth=oY>0?Math.round((oT-oY)/oY*100):(oT>0?100:0);
  const custToday=(ph&&ph.traffic)?ph.traffic.active_customers_24h:0;
  const hs=(hc&&hc.health_score!=null)?hc.health_score:0; const hsCls=hs>=90?'ok':(hs>=60?'warn':'bad');
  const counts=(ivc&&{})||{}; // counts from priority-queue not available here; use ivc for alerts
  const prods=(sales&&sales.products&&sales.products.length)?sales.products:[];
  const kpi=(ic,l,v,u,cls)=>`<div class="kpi a-${cls||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}${u?`<small>${u}</small>`:''}</div></div>`;
  el.innerHTML=`
    <div class="panel exec-panel" style="margin-bottom:18px"><div class="panel-h">${icon('home')}<h2>ملخّص الأعمال</h2><span class="chip ${hsCls}" style="margin-inline-start:auto">${icon('activity')} صحة النظام ${hs}%</span></div>
      <div class="panel-b">
        <div class="kpis">
          ${kpi('card','إيراد اليوم',money(revToday),' DH',revToday>0?'ok':'')}
          ${kpi('cart','طلبات اليوم',oT,'',oT>0?'ok':'')}
          ${kpi('cart','طلبات أمس',oY,'','')}
          ${kpi('trend','نمو الطلبات',(growth>0?'+':'')+growth,'%',growth>=0?'ok':'bad')}
          ${kpi('user','زبائن نشطون 24س',custToday,'','')}
          ${kpi('alert','تدخّلات معلّقة',(ivc&&ivc.pending)||0,'',(ivc&&ivc.pending)?'warn':'')}
        </div>
        <div class="exec-row">
          <div class="exec-box"><div class="exec-t">أعلى المنتجات</div>
            ${prods.length?prods.slice(0,4).map(p=>`<div class="row between" style="padding:5px 0;font-size:12.5px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.product_name||'—')}</span><span class="chip gray">${p.orders} طلب</span></div>`).join(''):'<div class="dim">لا بيانات بعد</div>'}
          </div>
        </div>
      </div></div>`;
  paintIcons(el);
}
/* Analytics sub-tab: revenue — reuses salesInsights render logic (body container renamed) */
async function anaSalesInsights(){
  /* salesInsights writes into #sales-body; we need it in #ana-body.
     We temporarily swap the container id, call salesInsights, then restore. */
  const el=$('#ana-body'); if(!el)return;
  el.id='sales-body';
  await salesInsights();
  el.id='ana-body';
}
/* Analytics sub-tab: funnel — reuses salesWarRoom */
async function anaFunnel(){
  const el=$('#ana-body'); if(!el)return;
  el.id='sales-body';
  await salesWarRoom();
  el.id='ana-body';
}
/* Analytics sub-tab: lost — reuses recLost */
async function anaLost(){
  const el=$('#ana-body'); if(!el)return;
  el.id='rec-body';
  await recLost();
  el.id='ana-body';
}
/* Analytics sub-tab: retention — reuses recOverview */
async function anaRetention(){
  const el=$('#ana-body'); if(!el)return;
  el.id='rec-body';
  await recOverview();
  el.id='ana-body';
}
/* Analytics sub-tab: aicost — reuses aiQuality */
async function anaAiCost(){
  const el=$('#ana-body'); if(!el)return;
  el.id='ai-body';
  await aiQuality();
  el.id='ana-body';
}

/* ---------- 8. SYSTEM — extended to absorb the AI workspace as a section group ---------- */
/* The existing renderSystem already handles health/status/delivery/security/backup/errors/sessions/activity/audit.
   We extend _sysTab to also accept AI sub-tab keys via a prefix 'ai_'.
   renderAI is still callable standalone for backward-compat. */
// ===== Payment-Accounts editor (System ops tab «حسابات الدفع») — injected into live workspaces.js 2026-06-25 =====
// Reads/edits aykoshop_payment_accounts via /api/payment-accounts. Structured field rows (NOT raw JSON) — safer for money data.
function _paFieldRow(f){ f=f||{}; var e=function(s){return esc(s!=null?String(s):'');}; var warn=(f.status==='needs_confirmation');
  return '<div class="row gap8 pa-field" data-status="'+e(f.status||'ok')+'" data-note="'+e(f.note||'')+'" style="margin-bottom:6px;align-items:center">'+
   '<input class="inp pa-flabel" placeholder="الوصف (مثلاً RIB)" value="'+e(f.label)+'" style="flex:2">'+
   '<input class="inp pa-fvalue" placeholder="القيمة (الرقم/RIB/الحساب)" value="'+e(f.value)+'" style="flex:3'+(warn?';border:1px solid var(--warn,#e0a800)':'')+'">'+
   (warn?'<span class="chip warn" title="'+e(f.note)+'">⚠ تأكيد</span>':'')+
   '<button class="btn sm" onclick="this.closest(\'.pa-field\').remove()">✕</button></div>'; }
async function sysPayAccounts(){
  var r=await api('/api/payment-accounts'); var accs=(r&&r.accounts)||[];
  fill('#sys-body',
   '<div class="dim" style="margin-bottom:12px">💳 هاد الحسابات كيقراهم الـPurchase Wizard مباشرة من القاعدة. عدّل بحذر — أي رقم غلط = فلوس الزبون كتمشي لبلاصة خاطئة. (مصدر وحيد، بلا اختراع من الذكاء)</div>'+
   (accs.length?accs.map(function(a){ var k=esc(a.method_key);
     var flds=Array.isArray(a.fields)?a.fields:(function(){try{return JSON.parse(a.fields||'[]');}catch(e){return [];}})();
    return '<div style="border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px;background:var(--card)">'+
     '<div class="row between" style="margin-bottom:10px"><b style="font-size:15px">'+esc(a.display_name||k)+' <span class="dim" style="font-size:12px">'+k+'</span></b>'+
       '<label class="row" style="align-items:center;gap:6px;font-size:12px"><input type="checkbox" id="pa-'+k+'-active" '+(a.active?'checked':'')+'> مُفعّل</label></div>'+
     '<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px">'+
       '<label style="font-size:12px;color:var(--muted)">صاحب الحساب<input class="inp" id="pa-'+k+'-holder" value="'+esc(a.holder_name||'')+'"></label>'+
       '<label style="font-size:12px;color:var(--muted)">العملة<input class="inp" id="pa-'+k+'-currency" value="'+esc(a.currency||'MAD')+'"></label>'+
       '<label style="font-size:12px;color:var(--muted)">الترتيب<input class="inp" id="pa-'+k+'-sort" value="'+esc(a.sort_order!=null?a.sort_order:0)+'"></label>'+
     '</div>'+
     '<div style="margin-top:12px;font-size:12px;color:var(--muted)">الأرقام / RIB (كل سطر = حقل يبان للزبون)</div>'+
     '<div id="pa-'+k+'-fields">'+flds.map(_paFieldRow).join('')+'</div>'+
     '<button class="btn sm" onclick="document.getElementById(\'pa-'+k+'-fields\').insertAdjacentHTML(\'beforeend\',_paFieldRow({}))">+ حقل</button>'+
     '<div class="row between" style="margin-top:12px"><span class="dim" style="font-size:11px">⚠ تأكيد = رقم مقنّع، خاص تأكدو قبل ما يبان للزبون</span><button class="btn primary" onclick="savePayAccount(\''+k+'\')">✓ حفظ الحساب</button></div>'+
    '</div>'; }).join(''):'<div class="dim" style="padding:30px;text-align:center">لا حسابات دفع.</div>'));
}
async function savePayAccount(k){
  var g=function(id){ var e=document.getElementById('pa-'+k+'-'+id); return e?e.value:undefined; };
  var active=(function(){var e=document.getElementById('pa-'+k+'-active');return e?!!e.checked:true;})();
  var fields=[]; var cont=document.getElementById('pa-'+k+'-fields');
  if(cont){ Array.prototype.forEach.call(cont.querySelectorAll('.pa-field'),function(row){
    var l=row.querySelector('.pa-flabel'), v=row.querySelector('.pa-fvalue');
    var lab=l?l.value.trim():'', val=v?v.value.trim():''; if(!lab&&!val) return;
    var o={label:lab,value:val,status:row.getAttribute('data-status')||'ok'}; var nt=row.getAttribute('data-note'); if(nt)o.note=nt; fields.push(o); }); }
  var body={ holder_name:g('holder'), currency:g('currency'), active:active, sort_order:parseInt(g('sort')||'0',10), fields:fields };
  var r=await send('/api/payment-accounts/'+encodeURIComponent(k),'PUT',body);
  if(r&&r.ok){ toast('تحفظ حساب '+k+' ✓'); sysPayAccounts(); } else toast((r&&r.error)||'فشل الحفظ','bad');
}
// ===== END Payment-Accounts editor =====

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
  if(!accs.length) accs=[{method_key:'',display_name:'تعذر تحميل قائمة البنوك — راجع الإعدادات'}];
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
  var r=await send('/api/wizard/sim','POST',body); closeModal(); _wizScope='all';
  await sysWizard();
  var out=document.getElementById('wiz-test-out'); if(!out) return;
  if(r&&r.ok){ out.innerHTML='<div class="panel"><div class="panel-h">🧪<h2>نتيجة المحاكاة — '+esc(r.status||'')+(r.warranty_days?(' · ضمان '+r.warranty_days+' يوم'):'')+'</h2></div><div class="panel-b">'+
    (r.steps||[]).map(function(s){return '<div style="padding:8px 0;border-bottom:1px solid var(--border)"><b style="font-size:12px;color:var(--acc,#4ea1ff)">'+esc(s.step)+'</b><div class="dim" style="font-size:12px;white-space:pre-wrap;margin-top:3px">'+esc(s.message||JSON.stringify(s))+'</div></div>';}).join('')+'</div></div>';
    toast('المحاكاة تمت ✓ — الأرقام تحدّثت'); }
  else { out.innerHTML='<div class="panel"><div class="panel-b"><b style="color:var(--bad,#e74c3c)">المحاكاة: خطأ — '+esc((r&&r.error)||'فشل')+'</b></div></div>'; toast('المحاكاة: خطأ','bad'); }
}
// ===== END Wizard monitor UI =====

const _sysTabs_ai=['ai_control','ai_prompt','ai_quality','ai_learning','ai_advisor','ai_patterns','ai_demand','ai_memory','ai_keys'];
const _sysTabs_ops=['health','status','delivery','security','backup','errors','sessions','activity','audit','pay_accounts','wizard'];
const _renderSystem_orig=renderSystem; // save ref before override
async function renderSystem(){
  if(_sysTabs_ai.includes(_sysTab)){
    /* AI Studio section inside system workspace */
    const aiTabMap={'ai_control':'control','ai_prompt':'prompt','ai_quality':'quality','ai_learning':'learning','ai_advisor':'advisor','ai_patterns':'patterns','ai_demand':'demand','ai_memory':'memory','ai_keys':'keys'};
    const aiTabsNav=[['ai_control','🧠 مركز الذكاء'],['ai_prompt','الموجّه'],['ai_quality','الجودة'],['ai_learning','التعلّم'],['ai_advisor','🧠 المستشار'],['ai_patterns','📊 الحركات'],['ai_demand','📦 الطلب'],['ai_memory','الذاكرة'],['ai_keys','🔑 المفاتيح']];
    const opsTabsNav=[['pay_accounts','💳 حسابات الدفع'],['wizard','🧪 Wizard'],['health','الصحة'],['status','الحالة'],['delivery','التسليم'],['security','الأمان'],['backup','النسخ'],['errors','الأخطاء'],['sessions','الجلسات'],['activity','السجل'],['audit','التدقيق']];
    const allTabs=[...aiTabsNav,...opsTabsNav];
    mount(phead('⚙️ النظام والإعدادات','AI Studio · مركز الصحة · المراقبة · التسليم · الأمان · السجل · التدقيق')+
      `<div class="tabs">
        <div class="tab" style="font-weight:700;opacity:.5;cursor:default;font-size:11px">▸ AI Studio</div>
        ${aiTabsNav.map(t=>`<div class="tab ${t[0]===_sysTab?'active':''}" onclick="_sysTab='${t[0]}';renderSystem()">${t[1]}</div>`).join('')}
        <div class="tab" style="font-weight:700;opacity:.5;cursor:default;font-size:11px">▸ Ops</div>
        ${opsTabsNav.map(t=>`<div class="tab ${t[0]===_sysTab?'active':''}" onclick="_sysTab='${t[0]}';renderSystem()">${t[1]}</div>`).join('')}
      </div><div id="ai-body">${skel()}</div>`);
    _aiTab=aiTabMap[_sysTab];
    ({control:aiControl,prompt:aiPrompt,quality:aiQuality,learning:aiLearning,advisor:aiAdvisor,patterns:aiPatterns,demand:aiDemand,memory:aiMemory,decisions:aiDecisions,keys:sysKeys}[_aiTab]||aiPrompt)();
    return;
  }
  /* Normal ops tab — rebuild tabs with AI Studio prefix tabs visible too */
  const opsTabsNav=[['pay_accounts','💳 حسابات الدفع'],['wizard','🧪 Wizard'],['health','الصحة'],['status','الحالة'],['delivery','التسليم'],['security','الأمان'],['backup','النسخ'],['errors','الأخطاء'],['sessions','الجلسات'],['activity','السجل'],['audit','التدقيق']];
  const aiTabsNav=[['ai_control','🧠 مركز الذكاء'],['ai_prompt','الموجّه'],['ai_quality','الجودة'],['ai_learning','التعلّم'],['ai_advisor','🧠 المستشار'],['ai_patterns','📊 الحركات'],['ai_demand','📦 الطلب'],['ai_memory','الذاكرة'],['ai_keys','🔑 المفاتيح']];
  if(!_sysTabs_ops.includes(_sysTab))_sysTab='health';
  mount(phead('⚙️ النظام والإعدادات','AI Studio · مركز الصحة · المراقبة · التسليم · الأمان · السجل · التدقيق')+
    `<div class="tabs">
      <div class="tab" style="font-weight:700;opacity:.5;cursor:default;font-size:11px">▸ AI Studio</div>
      ${aiTabsNav.map(t=>`<div class="tab ${t[0]===_sysTab?'active':''}" onclick="_sysTab='${t[0]}';renderSystem()">${t[1]}</div>`).join('')}
      <div class="tab" style="font-weight:700;opacity:.5;cursor:default;font-size:11px">▸ Ops</div>
      ${opsTabsNav.map(t=>`<div class="tab ${t[0]===_sysTab?'active':''}" onclick="_sysTab='${t[0]}';renderSystem()">${t[1]}</div>`).join('')}
    </div><div id="sys-body">${skel()}</div>`);
  ({health:sysHealth,status:sysStatus,delivery:sysDelivery,security:sysSecurity,backup:sysBackup,
    errors:sysErrors,sessions:sysSessions,activity:sysActivity,audit:sysAudit,pay_accounts:sysPayAccounts,wizard:sysWizard}[_sysTab]||sysHealth)();
}

/* ---------- renderAI: still callable (used by gotoAI helpers + renderSystem AI sections) ---------- */
/* renderAI is defined above and remains untouched — the function body is the same as before.
   We just ensure the nav alias works: #/ai → system AI Studio */

/* ============================================================ routes + boot */

/* Helper to open AI studio from anywhere */
function gotoAI(t){_sysTab='ai_'+(t||'prompt');location.hash='#/system';}

/* ---------- AI Provider Key Manager (single source of truth; backend store is AES-256 encrypted, Stage 1a/1b) ---------- */
async function sysKeys(){
  const d=await api('/api/ai/keys'); if(!d){ fill('#ai-body',empty('alert','تعذّر تحميل المفاتيح')); return; }
  let h='<div class="dim" style="font-size:12px;margin-bottom:12px">🔑 <b>مفاتيح مزوّدي الذكاء — المصدر الوحيد.</b> مخزّنة <b>مشفّرة (AES-256 at rest)</b>. «حفظ + تطبيق» كيطبّق فوراً على V2 · Embeddings · Vision · Transcribe · Hermes · AI-Status — بلا restart وبلا SSH. «اختبار» كيدير نداء حقيقي للموديل (ماشي تصوّر).</div>';
  h+='<div class="panel"><div class="panel-b">';
  h+='<div class="row gap8" style="margin-bottom:14px;align-items:center"><span class="dim" style="font-size:12px;min-width:130px">كلمة مرور الأدمين:</span><input id="kpw" class="inp" type="password" placeholder="ضرورية للحفظ" style="flex:1"></div>';
  (d.providers||[]).forEach(function(p){
    h+='<div style="border-top:1px solid var(--border);padding:12px 0">'
      +'<div class="row between" style="align-items:center"><b>'+esc(p.name)+'</b>'+(p.set?'<span class="chip ok num">'+esc(p.masked)+'</span>':'<span class="chip bad">غير مضبوط</span>')+'</div>'
      +'<div class="row gap8" style="margin-top:8px"><input id="key-'+p.id+'" class="inp" type="password" placeholder="مفتاح جديد (Paste)..." style="flex:1">'
      +'<button class="btn primary sm" onclick="saveKey(\''+p.id+'\')">'+icon('check')+' حفظ + تطبيق</button>'
      +'<button class="btn ghost sm" onclick="testKey(\''+p.id+'\')">🧪 اختبار</button></div>'
      +'<div id="kr-'+p.id+'" class="dim" style="font-size:12px;margin-top:6px"></div></div>';
  });
  if((d.secrets||[]).length){
    h+='<div class="dim" style="font-size:12px;margin:18px 0 4px;border-top:1px solid var(--border);padding-top:14px">🔐 <b>أسرار أخرى (Telegram / ManyChat)</b> — نفس التخزين المشفّر (AES-256). تتقرا server-side عبر resolver مع fallback آمن لـ.env.</div>';
    (d.secrets||[]).forEach(function(p){
      h+='<div style="border-top:1px solid var(--border);padding:12px 0">'
        +'<div class="row between" style="align-items:center"><b>'+esc(p.name)+'</b>'+(p.set?'<span class="chip ok num">'+esc(p.masked)+'</span>':'<span class="chip bad">غير مضبوط</span>')+'</div>'
        +'<div class="row gap8" style="margin-top:8px"><input id="key-'+p.id+'" class="inp" type="password" placeholder="توكن جديد (Paste)..." style="flex:1">'
        +'<button class="btn primary sm" onclick="saveKey(\''+p.id+'\')">'+icon('check')+' حفظ + تطبيق</button></div>'
        +'<div id="kr-'+p.id+'" class="dim" style="font-size:12px;margin-top:6px"></div></div>';
    });
  }
  h+='</div></div>';
  fill('#ai-body',h);
}
async function saveKey(id){ const key=(($('#key-'+id)||{}).value||'').trim(); const pw=(($('#kpw')||{}).value||''); if(!key){toast('دخل المفتاح','warn');return;} if(!pw){toast('دخل كلمة مرور الأدمين','warn');return;} const r=await send('/api/ai/keys','POST',{provider:id,key:key,admin_password:pw}); if(r&&r.ok){toast('تسجّل وتطبّق فوراً ✓ '+r.masked,'ok');sysKeys();}else toast((r&&r.error)||'فشل','bad'); }
async function testKey(id){ const pw=(($('#kpw')||{}).value||''); if(!pw){toast('دخل كلمة مرور الأدمين','warn');return;} const el=document.getElementById('kr-'+id); if(el)el.textContent='⏳ كنختبر بنداء حقيقي...'; const r=await send('/api/ai/keys/test','POST',{provider:id,admin_password:pw}); if(el){ if(r&&r.ok)el.innerHTML='<span style="color:var(--ok)">✅ '+esc(r.detail)+' ('+r.ms+'ms)</span>'; else el.innerHTML='<span style="color:var(--'+((r&&r.status==='quota')?'warn':'bad')+')">'+((r&&r.status==='quota')?'⚠️ ':'❌ ')+esc((r&&r.detail)||'فشل')+'</span>'; } }

/* ============================================================ HOME (الرئيسية) — screen 03, composed from existing endpoints (read-only) */
async function renderHome(){
  mount(phead('أهلاً 👋','نظرة سريعة على اليوم',
    `<button class="btn ghost" onclick="location.hash='#/hermes'">${icon('spark2')} اسأل Hermes</button> <button class="btn ghost" onclick="window.open('${API}/api/export/orders','_blank')">${icon('ext')} تصدير</button>`)
    +`<div id="home-body">${skel()}</div>`);
  let rev={},fn={},ivc={},kt={},pq={},ords=[];
  try{[rev,fn,ivc,kt,pq,ords]=await Promise.all([
    api('/api/revenue').catch(()=>({})),api('/api/funnel').catch(()=>({})),
    api('/api/interventions/counts').catch(()=>({})),api('/api/kpi/trend').catch(()=>({})),
    api('/hermes/priority-queue').catch(()=>({})),cached('orders',()=>api('/api/orders?limit=10')).catch(()=>[])]);
  }catch(_e){}
  const el=$('#home-body'); if(!el)return;
  const revToday=(rev&&rev.today&&rev.today.revenue)||0;
  const ordToday=(rev&&rev.today&&(rev.today.count||rev.today.orders))||0;
  const stages=(fn&&fn.stages)||[];
  const hotS=stages.filter(s=>/hot|حار|ساخن/i.test(String(s.label||'')+String(s.id||'')))[0];
  const hot=hotS?hotS.count:0;
  const pending=(ivc&&ivc.pending)||0;
  const kpi=(ic,l,v,u,a)=>`<div class="kpi a-${a||''}" style="cursor:default"><div class="top"><div class="ic">${icon(ic)}</div><div class="lbl">${l}</div></div><div class="val num">${v}${u?` <small>${u}</small>`:''}</div></div>`;
  const num1=o=>{for(const k in o){if(/date|day/i.test(k))continue;const n=+o[k];if(!isNaN(n))return n}return 0};
  const days=(kt&&(kt.daily_payments||kt.daily_orders))||[];
  const bars=days.slice(-7).map(num1); const mx=Math.max(1,...bars);
  const barEls=bars.length?bars.map((v,i)=>`<div title="${v}" style="flex:1;min-width:8px;background:${i===bars.length-1?'var(--ok)':'var(--accent)'};opacity:.9;border-radius:4px 4px 0 0;height:${Math.max(6,Math.round(v/mx*120))}px"></div>`).join(''):'<div class="dim" style="font-size:12px">لا بيانات بعد</div>';
  const acts=(ords||[]).slice(0,7);
  const opps=(((pq&&pq.tiers&&pq.tiers.buy_now)||[]).concat((pq&&pq.tiers&&pq.tiers.follow_today)||[])).slice(0,4);
  const maxStage=Math.max(1,...stages.map(s=>s.count||0));
  el.innerHTML=`
    <div class="kpis" style="margin-bottom:16px">
      ${kpi('dollar','إيراد اليوم',money(revToday),'DH',revToday>0?'ok':'')}
      ${kpi('cart','طلبات اليوم',ordToday,'',ordToday>0?'ok':'')}
      ${kpi('trend','Hot Leads',hot,'',hot>0?'warn':'')}
      ${kpi('alert','تدخّلات معلّقة',pending,'',pending>0?'bad':'')}</div>
    <div class="split" style="margin-bottom:16px">
      <div class="panel"><div class="panel-h">${icon('trend')}<h2>الإيراد المباشر</h2><span class="dim" style="font-size:12px;margin-inline-start:auto">آخر 7 أيام</span></div>
        <div class="panel-b"><div class="row" style="gap:6px;align-items:flex-end;height:168px">${barEls}</div></div></div>
      <div class="panel"><div class="panel-h">${icon('spark2')}<h2>أولويات Hermes اليوم</h2><span class="cnt">${opps.length}</span></div>
        <div class="panel-b">${opps.length?opps.map(o=>`<div class="hcard p-medium" style="margin-bottom:8px"><div class="hi">${icon('spark2')}</div><div class="hbody"><div class="htitle">${esc(o.customer_name||'زبون')} ${o.probability!=null?`<span class="hprob">${o.probability}%</span>`:''}</div><div class="hreason">${esc(o.reason||'')}</div></div><button class="btn primary sm" onclick="event.stopPropagation();_ibxSel='${o.subscriber_id}';location.hash='#/inbox'">نفّذ</button></div>`).join(''):empty('check','لا أولويات عاجلة الآن')}</div></div></div>
    <div class="split">
      <div class="panel"><div class="panel-h">${icon('activity')}<h2>النشاط الحيّ</h2><span class="chip ok" style="margin-inline-start:auto">● حيّ</span></div>
        <div class="panel-b">${acts.length?acts.map(o=>`<div class="fitem" ${o.subscriber_id?`onclick="_ibxSel='${o.subscriber_id}';location.hash='#/inbox'"`:''} style="padding:8px 4px"><div class="fic">${icon(o.paid_at?'card':'cart')}</div><div style="flex:1;min-width:0"><div class="ft">#${o.id} ${esc(o.product_name||'')} ${o.paid_at?'<span class="chip ok">مدفوع</span>':'<span class="chip gray">جديد</span>'}</div><div class="fm">${esc(o.customer_name||'')} · ${money(priceNum(o.price))} DH</div></div><div class="fa">${timeAgo(o.created_at)}</div></div>`).join(''):empty('cart','لا نشاط بعد')}</div></div>
      <div class="panel"><div class="panel-h">${icon('chart')}<h2>قمع التحويل · اليوم</h2></div>
        <div class="panel-b">${stages.length?stages.map(s=>`<div style="margin-bottom:11px"><div class="row between" style="font-size:12.5px;margin-bottom:4px"><span>${s.icon||''} ${esc(s.label||s.id)}</span><span class="num"><b>${s.count}</b></span></div><div class="funnel-bar"><span style="width:${Math.round((s.count||0)/maxStage*100)}%;background:${s.color||'var(--accent)'}"></span></div></div>`).join(''):empty('chart','لا بيانات قمع')}</div></div></div>`;
  paintIcons(el);
}

// ===== ⭐ Mission Control Workspace =====
var _aiHubTab='brain';
// Tab-setter helpers (navigate into System AI Hub)
function _mcGoBrain(){_aiHubTab='brain';_sysTab='ai_control';renderSystem();}
function _mcGoPolicies(){_aiHubTab='policies';_sysTab='ai_control';renderSystem();}
function _mcGoMonitor(){_aiHubTab='monitoring';_sysTab='ai_control';renderSystem();}
function _mcGoAlerts(){_aiHubTab='alerts';_sysTab='ai_control';renderSystem();}
function _mcGoActions(){_aiHubTab='actions';_sysTab='ai_control';renderSystem();}
// ── Brain tab ──
async function mcBrain(){
  var [d,ph,ls,tg]=await Promise.all([api('/api/mc/brain-status'),api('/api/ops/production-health'),api('/api/mc/live-sales'),api('/api/mc/truth-gate-stats')]);
  d=d||{}; ph=ph||{}; ls=ls||{}; tg=tg||{};
  var prov=d.providers||{}; var active=d.active_brain||'openai';
  var pc=function(name,key,status,detail){
    var isActive=(key===active); var cls=status==='ok'?'ok':status==='degraded'?'bad':'gray';
    return '<div class="panel" style="flex:1;min-width:160px"><div class="panel-b">'+
      '<div class="row between" style="margin-bottom:5px"><b style="font-size:13px">'+(isActive?'✅ ':'')+esc(name)+'</b><span class="chip '+cls+'">'+esc(status||'ok')+'</span></div>'+
      (detail?'<div class="dim" style="font-size:11px">'+esc(detail)+'</div>':'')+'</div></div>';
  };
  var hsCls=ph.status==='healthy'?'ok':ph.status==='warning'?'warn':'bad';
  var kn=function(ic,l,v,cl){ return '<div class="kpi a-'+(cl||'')+'"><div class="top"><div class="ic">'+icon(ic)+'</div><div class="lbl">'+l+'</div></div><div class="val num">'+v+'</div></div>'; };
  fill('#ai-hub-body',
    // ── Row 1: Live Sales AI ──
    '<div class="panel" style="margin-bottom:16px"><div class="panel-h">'+icon('zap')+'<h2>📊 Live Sales AI — اليوم</h2><button class="btn sm ghost" onclick="mcBrain()" style="margin-inline-start:auto">🔄</button></div>'+
      '<div class="kpis" style="margin:0">'+
        kn('cpu','🤖 AI جاوب',ls.ai_answered||0,'ok')+
        kn('sliders','📜 Rule-Based',ls.rule_based||0,'')+
        kn('user','👤 Human جاوب',ls.human_esc||0,ls.human_esc>10?'bad':'')+
        kn('fire','💰 محادثات بيع',ls.sales_conv||0,'ok')+
        kn('cart','🛒 طلبات',ls.orders_today||0,ls.orders_today>0?'ok':'')+
      '</div></div>'+
    // ── Row 2: Active Brain + providers ──
    '<div class="panel" style="margin-bottom:16px"><div class="panel-h">'+icon('cpu')+'<h2>الـBrain النشط</h2><span class="chip ok" style="margin-inline-start:auto;font-size:15px;font-weight:900">'+esc(active)+'</span></div>'+
      '<div class="panel-b"><div class="row gap10 wrapf">'+
        pc('OpenAI (GPT-4o)','openai',prov.openai||'ok',d.last_success&&d.last_success.openai?'آخر نجاح: '+timeAgo(d.last_success.openai):'Default')+
        pc('Mini (mini)','mini',prov.mini||'ok',d.last_success&&d.last_success.mini?timeAgo(d.last_success.mini):'Router')+
        pc('Claude','anthropic',prov.anthropic||'unknown',d.last_success&&d.last_success.anthropic?timeAgo(d.last_success.anthropic):'الـcredits ناقصة')+
        pc('Gemini','gemini',prov.gemini||'unknown',d.last_success&&d.last_success.gemini?timeAgo(d.last_success.gemini):'Fallback')+
      '</div><button class="btn sm ghost" onclick="_mcGoActions()" style="margin-top:10px">⚡️ بدّل الـProvider ↗</button></div></div>'+
    // ── Row 3: Truth Gate detailed + System health ──
    '<div class="split">'+
      '<div class="panel"><div class="panel-h">'+icon('check')+'<h2>🛡 Truth Gate — اليوم</h2></div><div class="panel-b">'+
        '<div class="kpis" style="grid-template-columns:1fr 1fr;margin:0">'+
          kn('dollar','💵 أسعار صُحِّحت',tg.prices_corrected||0,tg.prices_corrected>0?'warn':'')+
          kn('sliders','📋 سياسات',tg.policy_corrected||0,tg.policy_corrected>0?'warn':'')+
          kn('alert','🚫 حجب رد نقدي',tg.refund_blocked||0,tg.refund_blocked>0?'bad':'')+
          kn('check','المجموع اليوم',tg.total||0,tg.total>0?'warn':'ok')+
        '</div>'+
        '<div class="chip '+(tg.total>0?'warn':'ok')+'" style="margin-top:10px">'+(tg.total>0?('✓ تدخّل '+tg.total+' مرة — الحماية تشتغل'):'✓ لا تصحيحات — الذكاء دقيق اليوم')+'</div>'+
        '<button class="btn sm ghost" onclick="_mcGoMonitor()" style="margin-top:8px">📋 السجل الكامل</button>'+
      '</div></div>'+
      '<div class="panel"><div class="panel-h">'+icon('activity')+'<h2>صحة النظام</h2></div><div class="panel-b">'+
        '<div style="font-size:36px;font-weight:900;color:var(--'+(hsCls==='ok'?'ok':hsCls==='warn'?'warn':'bad')+')">'+esc(ph.status||'unknown')+'</div>'+
        '<div class="dim">'+(ph.unresolved_real?ph.unresolved_real+' مشكلة غير محلولة':'النظام مستقر ✓')+'</div>'+
        '<div class="chip '+hsCls+'" style="margin-top:10px">'+esc(ph.status||'?')+'</div>'+
      '</div></div>'+
    '</div>'
  );
}

// ── Policies tab ──
async function mcPolicies(){
  var r=await api('/api/mc/policies');
  var pols=(r&&r.policies)||[];
  var LABELS={warranty_ff:'ضمان Free Fire',warranty_social:'ضمان السوشيال',refund_policy:'سياسة الاسترجاع',payment_methods:'طرق الدفع'};
  var HINTS={warranty_ff:'مثلاً: 16 يوم استبدال',warranty_social:'مثلاً: 10 أيام استبدال',refund_policy:'مثلاً: استبدال فقط، لا استرجاع نقدي',payment_methods:'مثلاً: CIH,Barid Bank,Binance'};
  fill('#ai-hub-body',
    '<div class="panel" style="margin-bottom:14px"><div class="panel-b" style="font-size:13px">'+icon('alert')+' هاد السياسات كيقراهم الـTruth Gate قبل كل رد. الذكاء ما يقدرش يخالفهم — يتصحّح تلقائياً.</div></div>'+
    pols.map(function(p){
      var lbl=esc(LABELS[p.key]||p.key), hint=esc(HINTS[p.key]||''), k=esc(p.key);
      return '<div class="panel" style="margin-bottom:12px"><div class="panel-h">'+icon('sliders')+'<h2>'+lbl+'</h2><span class="dim" style="font-size:11px;margin-inline-start:auto">'+dt(p.updated_at)+'</span></div>'+
        '<div class="panel-b"><div class="row gap10">'+
          '<input class="inp" id="pol-'+k+'" value="'+esc(p.value||'')+'" placeholder="'+hint+'" style="flex:1">'+
          '<button class="btn primary" onclick="mcSavePolicy(\''+k+'\')">حفظ ✓</button>'+
        '</div></div></div>';
    }).join('')+
    (pols.length===0?'<div class="panel"><div class="panel-b dim">لا سياسات — شغّل migration</div></div>':'')+
    '<div style="margin-top:18px;padding:14px;border:1px dashed var(--border-2);border-radius:10px">'+
      '<div class="row gap8 wrapf" style="margin-bottom:10px"><b style="font-size:13px">إضافة سياسة جديدة</b></div>'+
      '<div class="row gap10">'+
        '<input class="inp" id="pol-new-key" placeholder="المفتاح (مثلا: vip_warranty)" style="flex:1">'+
        '<input class="inp" id="pol-new-val" placeholder="القيمة" style="flex:2">'+
        '<button class="btn ghost" onclick="mcAddPolicy()">+ إضافة</button>'+
      '</div>'+
    '</div>'
  );
}
async function mcSavePolicy(key){
  var inp=document.getElementById('pol-'+key); if(!inp)return;
  var r=await send('/api/mc/policies/'+encodeURIComponent(key),'PUT',{value:inp.value});
  if(r&&r.ok){toast('تحفظت السياسة ✓');} else toast('فشل الحفظ','bad');
}
async function mcAddPolicy(){
  var k=(document.getElementById('pol-new-key')||{}).value||'';
  var v=(document.getElementById('pol-new-val')||{}).value||'';
  if(!k.trim()||!v.trim()){toast('المفتاح والقيمة مطلوبين','bad');return;}
  var r=await send('/api/mc/policies/'+encodeURIComponent(k.trim()),'PUT',{value:v.trim()});
  if(r&&r.ok){toast('أضيفت السياسة ✓');mcPolicies();} else toast('فشل الإضافة','bad');
}

// ── Monitoring tab ──
async function mcMonitoring(){
  var [stats, tg] = await Promise.all([api('/api/ai/stats'), api('/api/mc/truth-gate-logs')]);
  var per=(stats&&stats.per_provider)||[];
  var logs=(tg&&tg.logs)||[];
  var reasonLabels={price_hallucination:'سعر مختلق',cash_refund_blocked:'رد نقدي ممنوع'};
  var _regHtml=_aiRegistryHtml(stats);
  fill('#ai-hub-body', _regHtml+
    '<div class="split" style="margin-bottom:18px">'+
      '<div class="panel"><div class="panel-h">'+icon('chart')+'<h2>استخدام الـAI — كل الوقت</h2></div><div class="panel-b">'+
        '<table style="width:100%;font-size:12.5px;border-collapse:collapse">'+
          '<tr style="color:var(--text-3);font-size:11px"><td style="padding:5px 0">Provider</td><td>نجاح</td><td>فشل</td><td>tokens_in</td><td>tokens_out</td><td>avg ms</td></tr>'+
          per.map(function(p){ return '<tr style="border-top:1px solid var(--border)"><td style="padding:6px 0"><b>'+esc(p.provider||'?')+'</b></td><td class="num ok">'+p.ok+'</td><td class="num '+(p.total-p.ok>0?'bad':'dim')+'">'+((p.total||0)-(p.ok||0))+'</td><td class="num">'+esc(p.tin)+'</td><td class="num">'+esc(p.tout)+'</td><td class="num">'+esc(p.avg_ms)+'ms</td></tr>'; }).join('')+
        '</table>'+
      '</div></div>'+
      '<div class="panel"><div class="panel-h">'+icon('check')+'<h2>Truth Gate — آخر 50</h2><span class="chip ok" style="margin-inline-start:auto">'+logs.length+'</span></div><div class="panel-b">'+
        (logs.length?logs.slice(0,20).map(function(l){
          var reason=(l.detail||'');
          var reasonKey=reason.split(':')[0];
          var label=reasonLabels[reasonKey]||esc(reasonKey)||'—';
          var priceMatch=reason.match(/(\d+)->(\d+)/);
          var detail=priceMatch?('سعر '+priceMatch[1]+' → صُحِّح لـ'+priceMatch[2]+' DH'):label;
          return '<div style="padding:7px 0;border-bottom:1px solid var(--border)">'+
            '<div class="row between"><span class="chip warn">'+esc(label)+'</span><span class="dim" style="font-size:11px">'+timeAgo(l.created_at)+'</span></div>'+
            '<div class="dim" style="font-size:11.5px;margin-top:3px">'+esc(detail)+(l.user_msg?' · "'+esc(String(l.user_msg).slice(0,50))+'"':'')+'</div>'+
          '</div>';
        }).join(''):'<div class="dim" style="padding:20px;text-align:center">لا تصحيحات بعد — Truth Gate جاهز</div>')+
      '</div></div>'+
    '</div>'
  );
}

// ── Alerts tab ──
async function mcAlerts(){
  var d=await api('/api/mc/alerts')||{};
  var summary=d.summary||[], recent=d.recent||[];
  var REASON_AR={'AI_LOOP_DETECTED':'تكرار AI','HUMAN_REQUESTED':'تدخل يدوي','PAYMENT_INTENT':'نية دفع','HUMAN_REPEAT':'تكرار (حظر)','HOT_LEAD':'زبون حار','RESERVATION':'حجز','PAYMENT_METHOD_UNKNOWN':'طريقة دفع غير رسمية','TOKEN_LOCK':'حبس (Token)','VIP_RECHARGE':'شحن VIP','PAYMENT_CLAIM_AUTO':'مطالبة دفع'};
  fill('#ai-hub-body',
    '<div class="split" style="margin-bottom:18px">'+
      '<div class="panel"><div class="panel-h">'+icon('alert')+'<h2>تصنيف 24 ساعة</h2></div><div class="panel-b">'+
        (summary.length?summary.map(function(r){
          var lbl=REASON_AR[r.reason_code]||r.reason_code; var isAlarm=(r.reason_code==='AI_LOOP_DETECTED'||r.reason_code==='TOKEN_LOCK');
          return '<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--border)">'+
            '<div class="row gap8"><span class="chip '+(isAlarm?'bad':'gray')+'">'+esc(r.reason_code)+'</span><span>'+esc(lbl)+'</span></div>'+
            '<b class="num">'+r.n+'</b></div>';
        }).join(''):'<div class="dim" style="padding:20px;text-align:center">لا تنبيهات في 24 ساعة ✓</div>')+
      '</div></div>'+
      '<div class="panel"><div class="panel-h">'+icon('bell')+'<h2>آخر التنبيهات</h2></div><div class="panel-b">'+
        (recent.length?recent.map(function(r){
          var lbl=REASON_AR[r.reason_code]||r.reason_code; var isAlarm=(r.reason_code==='AI_LOOP_DETECTED'||r.reason_code==='TOKEN_LOCK');
          return '<div style="padding:7px 0;border-bottom:1px solid var(--border)">'+
            '<div class="row between"><span class="chip '+(isAlarm?'bad':'gray')+'">'+esc(lbl)+'</span><span class="dim" style="font-size:11px">'+timeAgo(r.created_at)+'</span></div>'+
            '<div class="dim" style="font-size:11.5px;margin-top:2px">'+esc(r.customer_name||r.subscriber_id||'')+(r.channel?' · '+r.channel:'')+'</div>'+
          '</div>';
        }).join(''):'<div class="dim" style="padding:20px;text-align:center">لا تنبيهات ✓</div>')+
      '</div></div>'+
    '</div>'
  );
}

// ── Actions tab ──
async function mcActions(){
  var bs=await api('/api/mc/brain-status')||{};
  var cur=bs.active_brain||'openai';
  var provs=[['openai','OpenAI (GPT-4o)','GPT-4o — الـDefault — نتائج ممتازة'],['mini','GPT-4o-mini','mini — سريع ورخيص — للـRouter'],['anthropic','Anthropic (Claude)','Claude Sonnet — عميق — يحتاج credits'],['gemini','Gemini','Gemini 2.0 Flash — مجاني إذا كاين key']];
  fill('#ai-hub-body',
    // ── Provider Switch ──
    '<div class="panel" style="margin-bottom:18px"><div class="panel-h">'+icon('cpu')+'<h2>⚡️ Provider Switch</h2><span class="chip ok" style="margin-inline-start:auto">نشط: '+esc(cur)+'</span></div>'+
      '<div class="panel-b">'+
        '<div class="dim" style="font-size:12.5px;margin-bottom:14px">اختار الـProvider ديال الـBrain، دوز وزر "تطبيق" — التغيير فوري بلا restart</div>'+
        provs.map(function(p){
          var isActive=(p[0]===cur);
          return '<label class="row gap10" style="padding:10px 12px;border:1px solid var('+(isActive?'--ok':'--border')+');border-radius:10px;margin-bottom:8px;cursor:pointer;background:var('+(isActive?'--ok-soft':'--card')+')">' +
            '<input type="radio" name="mc-brain" value="'+p[0]+'" '+(isActive?'checked':'')+' style="accent-color:var(--ok)">'+
            '<div><b style="font-size:14px">'+esc(p[1])+'</b>'+
              (isActive?'<span class="chip ok" style="margin-inline-start:8px;font-size:11px">✅ نشط</span>':'')+
              '<div class="dim" style="font-size:12px">'+esc(p[2])+'</div>'+
            '</div></label>';
        }).join('')+
        '<div class="row gap10" style="margin-top:14px">'+
          '<button class="btn primary" onclick="mcApplyBrain()">✅ تطبيق</button>'+
          '<span id="mc-brain-status" class="dim" style="font-size:12.5px;align-self:center"></span>'+
        '</div>'+
      '</div></div>'+
    // ── Golden Tests + Circuit ──
    '<div class="row gap14 wrapf">'+
      '<div class="panel" style="flex:1;min-width:220px"><div class="panel-h">'+icon('zap')+'<h2>Golden Tests</h2></div>'+
        '<div class="panel-b"><div class="dim" style="font-size:12.5px;margin-bottom:10px">تشغيل golden_content — التحقق أن الذكاء لا يزال يعمل صح</div>'+
          '<button class="btn ghost" onclick="mcRunGolden()">▶️ شغّل</button>'+
          '<div id="mc-golden-out" style="margin-top:10px"></div>'+
        '</div></div>'+
      '<div class="panel" style="flex:1;min-width:220px"><div class="panel-h">'+icon('refresh')+'<h2>Circuit Breaker</h2></div>'+
        '<div class="panel-b"><div class="dim" style="font-size:12.5px;margin-bottom:10px">إعادة تهيئة بعد رجوع الـcredits</div>'+
          '<button class="btn ghost" onclick="mcClearCircuit()">🔄 إعادة</button>'+
          '<div id="mc-circuit-out" style="margin-top:10px"></div>'+
        '</div></div>'+
    '</div>'
  );
}
async function mcApplyBrain(){
  var sel=document.querySelector('input[name="mc-brain"]:checked');
  var st=document.getElementById('mc-brain-status');
  if(!sel){if(st)st.textContent='اختار provider أولاً';return;}
  var brain=sel.value;
  if(!confirm('تأكيد: تبديل الـBrain إلى "'+brain+'"؟\nالتغيير فوري وكيؤثر على ردود الذكاء.')){return;}
  if(st)st.textContent='جاري التطبيق...';
  var r=await send('/api/mc/set-brain','POST',{brain:brain});
  if(r&&r.ok){
    if(st)st.innerHTML='<span class="chip ok">✅ Brain: '+esc(r.brain)+'</span>';
    setTimeout(function(){mcActions();},1200);
  } else {
    if(st)st.innerHTML='<span class="chip bad">خطأ: '+esc((r&&r.error)||'فشل')+'</span>';
  }
}

async function mcRunGolden(){
  var out=document.getElementById('mc-golden-out'); if(out) out.innerHTML='<span class="chip gray">جاري الاختبار...</span>';
  var r=await api('/api/qa/run-golden?scope=mini');
  if(out){
    if(r&&r.ok){ out.innerHTML='<span class="chip ok">✓ '+esc(r.passed||0)+'/'+esc(r.total||0)+' نجح</span>'; }
    else if(r){ out.innerHTML='<span class="chip bad">'+esc(r.failed||0)+' فشل — '+esc(r.error||'خطأ')+'</span>'; }
    else { out.innerHTML='<span class="chip warn">endpoint غير متوفر بعد</span>'; }
  }
}
async function mcClearCircuit(){
  var out=document.getElementById('mc-circuit-out'); if(out) out.innerHTML='<span class="chip gray">جاري...</span>';
  var r=await send('/api/ops/circuit-reset','POST',{});
  if(out){
    if(r&&r.ok){ out.innerHTML='<span class="chip ok">✓ تمّ إعادة الـCircuit</span>'; }
    else { out.innerHTML='<span class="chip warn">endpoint غير متوفر بعد — أعد تشغيل الـAPI يدوياً</span>'; }
  }
}
function mcCopyBrainEnv(){
  var sel=document.getElementById('mc-brain-sel'); if(!sel) return;
  var txt='AI_BRAIN='+sel.value;
  navigator.clipboard.writeText(txt).then(function(){toast('نُسخ: '+txt+' — الصق في .env');}).catch(function(){toast(txt,'ok');});
}
// ===== END Mission Control Workspace =====

window.ROUTES={
  /* ---- PRIMARY 8 nav routes ---- */
  home:       renderHome,
  inbox:      renderInbox2, inbox_old: renderInbox,
  frozen:     renderFrozen,
  orders:     renderOrders,
  crm:        renderCRM,
  catalog:    renderCatalog,
  hermes:     renderHermes,
  analytics:  renderAnalytics,
  system:     renderSystem,

  /* ---- BACKWARD-COMPAT aliases (old bookmarks / onclick references) ---- */
  cockpit:    ()=>{location.replace('#/analytics');},   /* cockpit → analytics */
  sales:      ()=>{location.replace('#/orders');},      /* sales → orders */
  recovery:   ()=>{location.replace('#/hermes');},      /* recovery → hermes */
  ai:         ()=>{_sysTab='ai_prompt';renderSystem();} /* ai → system AI Studio */
};

async function boot(){ go(); refreshBadges(); }
window.boot=boot;
startApp();
