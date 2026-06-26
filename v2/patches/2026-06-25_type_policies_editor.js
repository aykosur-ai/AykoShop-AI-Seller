// ===== Type-Policies editor (Catalog tab «سياسات الأنواع») — injected into live workspaces.js 2026-06-25 =====
// Reads/edits aykoshop_product_type_policies via /api/type-policies. Reuses helpers: api, send, esc, toast, fill.
async function catPolicies(){
  const r=await api('/api/type-policies'); const pols=(r&&r.policies)||[];
  if(!pols.length){ fill('#cat-body','<div class="dim" style="padding:30px;text-align:center">لا سياسات أنواع محمّلة بعد.</div>'); return; }
  const J=function(v){ try{ return esc(JSON.stringify(typeof v==='string'?JSON.parse(v):v,null,1)); }catch(e){ return esc(v==null?'[]':String(v)); } };
  const remedyOpts=function(sel){ return ['replacement','redo','compensate','none'].map(function(o){return '<option '+(o===sel?'selected':'')+'>'+o+'</option>';}).join(''); };
  const ta=function(k,id,rows,val,mono){ return '<label style="display:block;margin-top:10px;font-size:12px;color:var(--muted)">'+id+(mono?' (JSON)':'')+'<textarea class="inp" id="tp-'+k+'-'+id+'" rows="'+rows+'"'+(mono?' style="font-family:monospace;font-size:12px"':'')+'>'+val+'</textarea></label>'; };
  fill('#cat-body',
   '<div class="dim" style="margin-bottom:12px">🛡️ السياسة كتتكتب <b>مرة لكل نوع</b>، وكل منتج كيورّثها تلقائياً. الثمن والـ<b>floor</b> كيبقاو فالمنتج. (مصدر وحيد — بلا تكرار)</div>'+
   pols.map(function(p){ var k=esc(p.type_key);
    return '<div style="border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px;background:var(--card)">'+
     '<div class="row between" style="margin-bottom:10px"><b style="font-size:15px">'+esc(p.display_name||k)+' <span class="dim" style="font-size:12px">'+k+' · '+esc(p.match_product_type||'')+(p.match_game?'/'+esc(p.match_game):'')+'</span></b><span class="chip gray">v'+(p.policy_version||1)+'</span></div>'+
     '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'+
       '<label style="font-size:12px;color:var(--muted)">مدة الضمان (يوم، فارغ=بلا)<input class="inp" id="tp-'+k+'-warranty_days" value="'+(p.warranty_days==null?'':esc(p.warranty_days))+'"></label>'+
       '<label style="font-size:12px;color:var(--muted)">الحل (remedy)<select class="inp" id="tp-'+k+'-remedy">'+remedyOpts(p.remedy)+'</select></label>'+
       '<label class="row" style="align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="tp-'+k+'-refund_allowed" '+(p.refund_allowed?'checked':'')+'> استرجاع مال مسموح</label>'+
       '<label class="row" style="align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="tp-'+k+'-verify_before_delivered" '+(p.verify_before_delivered?'checked':'')+'> تحقق 100% قبل التسليم</label>'+
     '</div>'+
     ta(k,'predelivery_script',4,esc(p.predelivery_script||''),false)+
     ta(k,'delivery_message',2,esc(p.delivery_message||''),false)+
     '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'+
       ta(k,'buyer_requirements',4,J(p.buyer_requirements),true)+
       ta(k,'delivery_steps',4,J(p.delivery_steps),true)+
       ta(k,'warranty_void_conditions',3,J(p.warranty_void_conditions),true)+
       ta(k,'forbidden_after_delivery',3,J(p.forbidden_after_delivery),true)+
       ta(k,'default_objections',3,J(p.default_objections),true)+
       ta(k,'allowed_payment_methods',3,J(p.allowed_payment_methods),true)+
     '</div>'+
     ta(k,'notes',2,esc(p.notes||''),false)+
     '<div class="row between" style="margin-top:12px"><span class="dim" style="font-size:11px">remedy: replacement=تبديل · redo=إعادة · compensate=تعويض · none=بلا</span><button class="btn primary" onclick="saveTypePolicy(\''+k+'\')">✓ حفظ السياسة</button></div>'+
    '</div>'; }).join(''));
}
async function saveTypePolicy(k){
  var g=function(id){ var e=document.getElementById('tp-'+k+'-'+id); return e?e.value:undefined; };
  var gc=function(id){ var e=document.getElementById('tp-'+k+'-'+id); return e?!!e.checked:false; };
  var body={}; var wd=g('warranty_days'); body.warranty_days=(wd===''||wd==null)?null:parseInt(wd,10);
  body.remedy=g('remedy'); body.refund_allowed=gc('refund_allowed'); body.verify_before_delivered=gc('verify_before_delivered');
  body.predelivery_script=g('predelivery_script'); body.delivery_message=g('delivery_message'); body.notes=g('notes');
  var jcols=['buyer_requirements','delivery_steps','warranty_void_conditions','forbidden_after_delivery','default_objections','allowed_payment_methods'];
  for(var i=0;i<jcols.length;i++){ var v=g(jcols[i]); if(v===undefined) continue; try{ body[jcols[i]]=JSON.parse(v||'[]'); }catch(e){ toast('JSON غير صالح فـ '+jcols[i],'bad'); return; } }
  var r=await send('/api/type-policies/'+encodeURIComponent(k),'PUT',body);
  if(r&&r.ok){ toast('تحفظت سياسة '+k+' ✓'); catPolicies(); } else toast((r&&r.error)||'فشل الحفظ','bad');
}
// ===== END Type-Policies editor =====
