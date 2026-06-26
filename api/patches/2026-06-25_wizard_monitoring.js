function _wizErrReason(err){ var m={product_not_found:'runtime_error', no_price_resolved:'missing_policy', no_active_payment_account:'missing_payment_account', order_failed:'order_failed', payment_verify_failed:'payment_verify_failed'}; return m[err]||'runtime_error'; }
async function _wizLog(ev){ try{ await pool.query('INSERT INTO aykoshop_wizard_events(session_key,subscriber_id,event,step,product_id,amount_centimes,payment_method,error_reason,is_test,meta) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[ev.session_key||null,ev.subscriber_id||null,ev.event,ev.step||null,ev.product_id||null,ev.amount_centimes||null,ev.payment_method||null,ev.error_reason||null,!!ev.is_test,JSON.stringify(ev.meta||{})]); }catch(e){} }
app.post('/api/wizard/sim', async (req,res)=>{ try{ var o=req.body||{}; var r=await _wizSim(o);
  if(o.log){ var sk='test:'+Date.now()+':'+Math.floor(Math.random()*100000); var sid=o.subscriber_id||'test'; var pid=o.product_id;
    await _wizLog({session_key:sk,subscriber_id:sid,event:'started',product_id:pid,is_test:true});
    if(!r.ok){ await _wizLog({session_key:sk,subscriber_id:sid,event:'error',error_reason:_wizErrReason(r.error),product_id:pid,is_test:true}); }
    else { var has=function(n){return r.steps.some(function(s){return s.step===n;});};
      if(has('confirm')) await _wizLog({session_key:sk,subscriber_id:sid,event:'step',step:'product',product_id:pid,is_test:true});
      if(has('payment')) await _wizLog({session_key:sk,subscriber_id:sid,event:'step',step:'payment_method',product_id:pid,payment_method:o.payment_method,is_test:true});
      if(o.screenshot_url){ await _wizLog({session_key:sk,subscriber_id:sid,event:'step',step:'payment_proof',is_test:true}); await _wizLog({session_key:sk,subscriber_id:sid,event:'payment_submitted',product_id:pid,is_test:true}); }
      if(has('verify')){ await _wizLog({session_key:sk,subscriber_id:sid,event:'step',step:'verify',is_test:true}); await _wizLog({session_key:sk,subscriber_id:sid,event:'payment_verified',product_id:pid,is_test:true}); }
      if(has('order')){ await _wizLog({session_key:sk,subscriber_id:sid,event:'step',step:'order',is_test:true}); await _wizLog({session_key:sk,subscriber_id:sid,event:'order_created',product_id:pid,is_test:true}); }
      if(has('deliver')){ await _wizLog({session_key:sk,subscriber_id:sid,event:'step',step:'delivery',is_test:true}); await _wizLog({session_key:sk,subscriber_id:sid,event:'delivery_completed',product_id:pid,is_test:true}); }
    }
  }
  res.json(r); }catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/wizard/stats', async (req,res)=>{ try{
  var scope=String(req.query.scope||'all'); var wt = scope==='real'?"AND is_test=false": scope==='test'?"AND is_test=true":"";
  var q=await pool.query("SELECT event, COALESCE(step,'') step, COALESCE(error_reason,'') err, count(DISTINCT session_key)::int sess, count(*)::int cnt FROM aykoshop_wizard_events WHERE ts >= date_trunc('day', NOW()) "+wt+" GROUP BY event, step, error_reason");
  var rows=q.rows;
  var evSess=function(e){ var s=0; rows.forEach(function(r){ if(r.event===e) s+=r.sess; }); return s; };
  var stepReached=function(st){ var s=0; rows.forEach(function(r){ if(r.event==='step'&&r.step===st) s+=r.sess; }); return s; };
  var funnelDefs=[['Wizard Started','started'],['Payment Submitted','payment_submitted'],['Payment Verified','payment_verified'],['Order Created','order_created'],['Delivery Completed','delivery_completed']];
  var prev=null; var funnel=funnelDefs.map(function(d){ var n=evSess(d[1]); var pct=prev==null?100:(prev>0?Math.round(n/prev*100):0); prev=n; return {stage:d[0], n:n, pct_of_prev:pct}; });
  var stepDefs=[['product','اختيار المنتج'],['payment_method','وسيلة الدفع'],['payment_proof','إثبات الدفع'],['verify','التحقق'],['order','إنشاء الطلب'],['delivery','التسليم']];
  var reached=stepDefs.map(function(d){ return {key:d[0],label:d[1],reached:stepReached(d[0])}; });
  var dropoff=reached.map(function(r,i){ var nx=reached[i+1]?reached[i+1].reached:r.reached; return {step:r.label, reached:r.reached, dropped:Math.max(0, r.reached-nx)}; });
  var errMap={}; rows.forEach(function(r){ if(r.event==='error'&&r.err){ errMap[r.err]=(errMap[r.err]||0)+r.cnt; } });
  var errors=Object.keys(errMap).map(function(k){ return {reason:k, n:errMap[k]}; });
  res.json({ok:true, scope:scope, started:evSess('started'), completed:evSess('delivery_completed'), funnel:funnel, dropoff:dropoff, errors:errors});
}catch(e){ res.status(500).json({error:e.message}); } });
