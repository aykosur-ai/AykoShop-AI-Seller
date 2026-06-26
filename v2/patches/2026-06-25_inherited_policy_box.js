// ===== Inherited-policy read-only box on the product form (kills warranty/delivery duplication) 2026-06-25 =====
// Matches a product to its Type-Contract (by product_type[+game]) and shows warranty/remedy/refund/script READ-ONLY.
// Warranty/delivery are edited ONLY in «سياسات الأنواع» — not per product. window._typePolicies is preloaded in catProducts.
function _pfInheritedBox(d){
  var pols=window._typePolicies||[]; var pt=String(d.product_type||'').toLowerCase(); var gm=d.game||''; var pol=null,i;
  for(i=0;i<pols.length;i++){ if(String(pols[i].match_product_type||'').toLowerCase()===pt && (pols[i].match_game||'')===gm){ pol=pols[i]; break; } }
  if(!pol) for(i=0;i<pols.length;i++){ if(String(pols[i].match_product_type||'').toLowerCase()===pt && !pols[i].match_game){ pol=pols[i]; break; } }
  if(!pol){ return '<div style="margin-top:12px;font-size:12px;padding:10px;border:1px dashed var(--border);border-radius:8px;color:var(--muted)">⚠ ماكاينش سياسة نوع لهاد المنتج بعد — الضمان/التسليم كيتعدّلو فـ«السلع ← 🛡️ سياسات الأنواع».</div>'; }
  var rem={replacement:'تبديل بنفس القيمة',redo:'إعادة الخدمة',compensate:'تعويض',none:'—'}[pol.remedy]||esc(pol.remedy||'');
  return '<div style="margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg2,rgba(0,0,0,.12))">'+
    '<div class="row between" style="align-items:center"><b style="font-size:13px">🛡️ الضمان والتسليم — موروث من النوع: '+esc(pol.display_name||pol.type_key)+'</b>'+
    '<button class="btn sm ghost" onclick="closeModal();_catTab=\'policies\';renderCatalog()">عدّل السياسة ›</button></div>'+
    '<div style="font-size:12px;margin-top:8px;color:var(--muted)">الضمان: <b style="color:var(--text,#fff)">'+(pol.warranty_days!=null?esc(pol.warranty_days)+' يوم':'—')+'</b> · الحل: <b style="color:var(--text,#fff)">'+rem+'</b> · استرجاع مال: <b style="color:var(--text,#fff)">'+(pol.refund_allowed?'نعم':'لا')+'</b></div>'+
    (pol.predelivery_script?'<div style="font-size:11px;margin-top:8px;white-space:pre-wrap;color:var(--muted)">📋 سكريبت ما قبل التسليم:\n'+esc(pol.predelivery_script)+'</div>':'')+
    '<div style="font-size:11px;margin-top:8px;opacity:.7;color:var(--muted)">هادي موروثة من سياسة النوع — مصدر وحيد، بلا تكرار. عدّلها هناك وتطبّق على كل منتجات هاد النوع.</div>'+
  '</div>';
}
// ===== END inherited-policy box =====
