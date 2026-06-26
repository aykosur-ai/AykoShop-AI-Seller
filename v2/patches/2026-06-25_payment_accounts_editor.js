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
