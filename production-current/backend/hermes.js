
// hermes.js — AykoShop intelligence layer (A+). Copilot-grade output.
// Reads core tables (read-only intent), writes ONLY hermes_*, exposes ONLY /hermes/*.

async function priceMap(pool){
  const m={};
  try{ const r=await pool.query("SELECT LOWER(product_name) n, MIN(CASE WHEN REGEXP_REPLACE(price,'[^0-9]','','g') ~ '^[0-9]+$' THEN CAST(REGEXP_REPLACE(price,'[^0-9]','','g') AS INT) END) p FROM aykoshop_products WHERE status='available' GROUP BY LOWER(product_name)");
    for(const row of r.rows) if(row.p) m[row.n]=parseInt(row.p); }catch(e){}
  return m;
}
function estValue(interested, pm){ if(!interested) return 350; const k=String(interested).toLowerCase();
  for(const n of Object.keys(pm)){ if(k.includes(n)||n.includes(k.slice(0,5))) return pm[n]; } return 350; }
function clampPct(x){ return Math.max(5, Math.min(95, Math.round(x))); }

// Honest heuristic conversion probability (labelled as estimate in UI)
function convProb(stage, msgs, hrs){
  let p = stage==='payment'?80 : stage==='hot'?60 : stage==='warm'?40 : 25;
  p += Math.min(parseInt(msgs||0),10)*2;          // engagement
  if(hrs<1) p+=15; else if(hrs<3) p+=8; else if(hrs>6) p-=10; else if(hrs>24) p-=20;
  return clampPct(p);
}
function firstName(n){ return (n && n.indexOf('{{')===-1) ? n.split(' ')[0] : 'الزبون'; }

async function computeAll(pool){
  const runStart=new Date();
  const run=await pool.query('INSERT INTO hermes_runs (started_at) VALUES ($1) RETURNING id',[runStart]);
  const runId=run.rows[0].id; const recs=[]; const alerts=[];
  try{
    const pm=await priceMap(pool);

    // 1) HOT LEADS → "Contact X now"
    try{
      const hot=await pool.query("SELECT p.subscriber_id,p.customer_name,p.channel,p.interested_in,p.total_messages,p.manychat_link,p.stage,ROUND(EXTRACT(EPOCH FROM (NOW()-p.last_seen))/3600) hrs FROM aykoshop_profiles p LEFT JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id WHERE p.stage IN ('hot','warm') AND o.id IS NULL AND p.last_seen > NOW()-INTERVAL '24 hours' AND p.subscriber_id ~ '^[0-9]+$' ORDER BY p.last_seen DESC LIMIT 40");
      for(const c of hot.rows){
        const hrs=parseInt(c.hrs||0); const cooling=hrs>=3;
        const val=estValue(c.interested_in,pm); const prob=convProb(c.stage,c.total_messages,hrs);
        recs.push({ type:'hot_lead', icon:'🔥', subscriber_id:c.subscriber_id, customer_name:c.customer_name, channel:c.channel,
          title:'Contact '+firstName(c.customer_name)+' now',
          reason:'Hot lead · interested in '+(c.interested_in||'a product')+' · '+(hrs<1?'active now':'quiet '+hrs+'h')+' · ~'+prob+'% conversion (est.)',
          suggested_action:cooling?'Message before it goes cold':'Engage and close',
          estimated_value:val, probability:prob,
          score:(val*prob/100)+(cooling?40:20),
          priority:cooling?'high':'medium',
          target:{workspace:'inbox', subscriber_id:c.subscriber_id, manychat_link:c.manychat_link} });
      }
    }catch(e){console.error('[hermes hot]',e.message);}

    // 2) PAYMENT CONFIRM → "Confirm payment — Order #N" (revenue on the table)
    try{
      const ords=await pool.query("SELECT o.id,o.subscriber_id,o.customer_name,o.channel,o.product_name,o.price, EXISTS(SELECT 1 FROM aykoshop_interventions i WHERE i.subscriber_id=o.subscriber_id AND i.reason_code IN ('PAYMENT_INTENT','PAYMENT_CONFUSION') AND i.status='pending') paysig FROM aykoshop_orders o WHERE o.status='new' AND o.created_at > NOW()-INTERVAL '7 days' ORDER BY o.created_at DESC LIMIT 20");
      for(const o of ords.rows){
        const val=parseInt(String(o.price||'').replace(/[^0-9]/g,''))||estValue(o.product_name,pm);
        recs.push({ type:'payment_confirm', icon:'💰', subscriber_id:o.subscriber_id, customer_name:o.customer_name, channel:o.channel,
          title:'Confirm payment — Order #'+o.id,
          reason:(o.paysig?'Payment intent detected · ':'')+'Order created, payment not confirmed — confirm + deliver to record revenue',
          suggested_action:'Verify the transfer, then ✓ Pay & Deliver',
          estimated_value:val, probability:null,
          score:val + (o.paysig?500:200),
          priority:o.paysig?'critical':'high',
          target:{workspace:'sales', tab:'orders', order_id:o.id, subscriber_id:o.subscriber_id} });
      }
    }catch(e){console.error('[hermes pay]',e.message);}

    // 3) LOST SALES → "Recover X"
    try{
      const lost=await pool.query("SELECT p.subscriber_id,p.customer_name,p.channel,p.interested_in,p.manychat_link,ROUND(EXTRACT(EPOCH FROM (NOW()-p.last_seen))/3600) hrs FROM aykoshop_profiles p LEFT JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id WHERE p.stage IN ('hot','warm','payment') AND o.id IS NULL AND p.last_seen < NOW()-INTERVAL '24 hours' AND p.last_seen > NOW()-INTERVAL '7 days' AND p.subscriber_id ~ '^[0-9]+$' ORDER BY p.last_seen DESC LIMIT 30");
      for(const c of lost.rows){
        const hrs=parseInt(c.hrs||0); const val=estValue(c.interested_in,pm);
        recs.push({ type:'lost_sale', icon:'💸', subscriber_id:c.subscriber_id, customer_name:c.customer_name, channel:c.channel,
          title:'Recover '+firstName(c.customer_name),
          reason:'Showed buyer intent for '+(c.interested_in||'a product')+' · went quiet '+(hrs<48?hrs+'h':Math.round(hrs/24)+'d')+' ago, no order',
          suggested_action:'Send a recovery follow-up',
          estimated_value:val, probability:null,
          score:(val*0.4)+(hrs<48?30:15), priority:hrs<48?'high':'medium',
          target:{workspace:'sales', tab:'recovery', subscriber_id:c.subscriber_id, manychat_link:c.manychat_link} });
      }
    }catch(e){console.error('[hermes lost]',e.message);}

    // 4) FOLLOW-UP DRAFTS → "Approve follow-up for X"
    try{
      const fu=await pool.query("SELECT subscriber_id,customer_name,channel,category,product_name FROM aykoshop_followup_drafts WHERE status='draft' ORDER BY created_at DESC LIMIT 15");
      for(const d of fu.rows){
        recs.push({ type:'follow_up', icon:'✉️', subscriber_id:d.subscriber_id, customer_name:d.customer_name, channel:d.channel,
          title:'Approve follow-up for '+firstName(d.customer_name),
          reason:'AI drafted a '+(d.category||'follow-up')+' message'+(d.product_name?' about '+d.product_name:'')+' — waiting for your approval',
          suggested_action:'Review & approve the draft',
          estimated_value:350, probability:null, score:120, priority:'medium',
          target:{workspace:'sales', tab:'recovery', subscriber_id:d.subscriber_id} });
      }
    }catch(e){console.error('[hermes fu]',e.message);}

    // 5) DEMAND TREND → "X demand rising" (business insight)
    try{
      const dem=await pool.query("SELECT interested_in, COUNT(*) n FROM aykoshop_profiles WHERE interested_in IS NOT NULL AND interested_in!='' AND last_seen > NOW()-INTERVAL '24 hours' GROUP BY interested_in ORDER BY n DESC LIMIT 2");
      for(const d of dem.rows){
        const n=parseInt(d.n||0); if(n<5) continue;
        recs.push({ type:'demand_trend', icon:'📈', subscriber_id:null, customer_name:null, channel:null,
          title:d.interested_in+' demand rising',
          reason:n+' inquiries in the last 24h — make sure stock and pricing are ready',
          suggested_action:'Check catalog stock & pricing',
          estimated_value:0, probability:null, score:60+n, priority:'low',
          target:{workspace:'catalog'} });
      }
    }catch(e){console.error('[hermes demand]',e.message);}

    // ALERTS — customer risk
    try{
      const risk=await pool.query("SELECT COUNT(*) n FROM aykoshop_profiles p LEFT JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id WHERE p.stage='hot' AND o.id IS NULL AND p.total_messages>=5 AND p.last_seen < NOW()-INTERVAL '24 hours' AND p.last_seen > NOW()-INTERVAL '72 hours'");
      const n=parseInt(risk.rows[0].n||0);
      if(n>0) alerts.push({category:'customer_risk', severity:'warning', icon:'⚠️', title:n+' engaged hot leads going cold', reason:'High-engagement customers with no order, quiet 1–3 days', count:n, target:{workspace:'sales', tab:'recovery'}});
    }catch(e){console.error('[hermes risk]',e.message);}
    // ALERTS — workflow health
    try{
      const wf=await pool.query("SELECT COUNT(*) n FROM aykoshop_workflow_errors WHERE severity='critical' AND (is_test=false OR is_test IS NULL) AND started_at > NOW()-INTERVAL '24 hours'");
      const n=parseInt(wf.rows[0].n||0);
      if(n>0) alerts.push({category:'workflow_health', severity:'critical', icon:'🔧', title:n+' critical workflow errors (24h)', reason:'Some customers may have received no reply — check System › Errors', count:n, target:{workspace:'system', tab:'errors'}});
    }catch(e){console.error('[hermes wf]',e.message);}

    // persist atomically; refresh active autos; respect dismissals
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("DELETE FROM hermes_recommendations WHERE source='auto' AND status='active'");
      for(const r of recs){
        await client.query("INSERT INTO hermes_recommendations (type,icon,subscriber_id,customer_name,channel,title,reason,suggested_action,estimated_value,probability,score,priority,target,status,source,updated_at) SELECT $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::int,$10::int,$11::float8,$12::text,$13::jsonb,'active','auto',NOW() WHERE NOT EXISTS (SELECT 1 FROM hermes_recommendations d WHERE d.subscriber_id IS NOT DISTINCT FROM $3::text AND d.type=$1::text AND d.status='dismissed' AND d.updated_at > NOW()-INTERVAL '24 hours')",
          [r.type,r.icon,r.subscriber_id,r.customer_name,r.channel,r.title,r.reason,r.suggested_action,r.estimated_value,r.probability,r.score,r.priority,JSON.stringify(r.target||{})]);
      }
      await client.query("DELETE FROM hermes_alerts WHERE source='auto' AND status='active'");
      for(const a of alerts){
        await client.query("INSERT INTO hermes_alerts (category,severity,icon,title,reason,count,target,status,source,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'active','auto',NOW())",
          [a.category,a.severity,a.icon,a.title,a.reason,a.count||1,JSON.stringify(a.target||{})]);
      }
      await client.query('COMMIT');
    }catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    await pool.query('UPDATE hermes_runs SET finished_at=NOW(), recommendations=$1, alerts=$2, ok=true WHERE id=$3',[recs.length,alerts.length,runId]);
    return {recommendations:recs.length, alerts:alerts.length};
  }catch(e){
    await pool.query('UPDATE hermes_runs SET finished_at=NOW(), ok=false, error=$1 WHERE id=$2',[String(e.message).slice(0,300),runId]).catch(()=>{});
    throw e;
  }
}

function registerRoutes(app, pool){
  // Phase 1 Module 5 (2026-07-02): local asyncHandler — pure de-duplication of the `catch(e){res.status(500).json({error:e.message})}`
  // pattern already used by every route below. Byte-identical output to the inline try/catch it replaces.
  function asyncHandler(fn) {
    return function(req, res, next) {
      Promise.resolve(fn(req, res)).catch(function(e) { res.status(500).json({ error: e.message }); });
    };
  }
  const ORDER="ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, score DESC";
  app.get('/hermes/summary', asyncHandler(async (req,res)=>{
      const [counts,run,top]=await Promise.all([
        pool.query("SELECT COUNT(*) FILTER (WHERE type='hot_lead') hot_leads, COUNT(*) FILTER (WHERE type='lost_sale') lost_sales, COUNT(*) FILTER (WHERE type='follow_up') follow_ups, COUNT(*) FILTER (WHERE type='payment_confirm') payments FROM hermes_recommendations WHERE status='active'"),
        pool.query('SELECT finished_at,ok FROM hermes_runs ORDER BY id DESC LIMIT 1'),
        pool.query("SELECT id,type,icon,customer_name,channel,title,reason,suggested_action,estimated_value,probability,priority,target FROM hermes_recommendations WHERE status='active' "+ORDER+" LIMIT 5")
      ]);
      const al=await pool.query("SELECT COUNT(*) FILTER (WHERE category='customer_risk') risks, COUNT(*) FILTER (WHERE category='workflow_health') workflow_issues FROM hermes_alerts WHERE status='active'");
      res.json({ hot_leads:+counts.rows[0].hot_leads||0, lost_sales:+counts.rows[0].lost_sales||0, follow_ups:+counts.rows[0].follow_ups||0, payments:+counts.rows[0].payments||0, risks:+al.rows[0].risks||0, workflow_issues:+al.rows[0].workflow_issues||0, last_run:run.rows[0]?run.rows[0].finished_at:null, last_run_ok:run.rows[0]?run.rows[0].ok:null, top_recommendations:top.rows });
  }));
  app.get('/hermes/cockpit', asyncHandler(async (req,res)=>{
      const [recs,al]=await Promise.all([
        pool.query("SELECT id,type,icon,subscriber_id,customer_name,channel,title,reason,suggested_action,estimated_value,probability,priority,target FROM hermes_recommendations WHERE status='active' "+ORDER+" LIMIT 12"),
        pool.query("SELECT id,category,severity,icon,title,reason,count,target FROM hermes_alerts WHERE status='active' ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, created_at DESC LIMIT 8")
      ]);
      res.json({recommendations:recs.rows, alerts:al.rows});
  }));
  app.get('/hermes/recommendations', asyncHandler(async (req,res)=>{
      const {type,limit=50}=req.query;
      const where=type?"status='active' AND type=$1":"status='active'"; const params=type?[type,+limit]:[+limit];
      const r=await pool.query("SELECT id,type,icon,subscriber_id,customer_name,channel,title,reason,suggested_action,estimated_value,probability,priority,target FROM hermes_recommendations WHERE "+where+" "+ORDER+" LIMIT $"+(type?2:1),params);
      res.json({recommendations:r.rows});
  }));
  app.get('/hermes/alerts', asyncHandler(async (req,res)=>{ const r=await pool.query("SELECT id,category,severity,icon,title,reason,count,target FROM hermes_alerts WHERE status='active' ORDER BY created_at DESC"); res.json({alerts:r.rows}); }));
  app.get('/hermes/context/customer/:id', asyncHandler(async (req,res)=>{ const r=await pool.query("SELECT id,type,icon,title,reason,suggested_action,estimated_value,probability,priority FROM hermes_recommendations WHERE subscriber_id=$1 AND status='active' "+ORDER,[req.params.id]); res.json({subscriber_id:req.params.id, recommendations:r.rows}); }));
  app.post('/hermes/recommendations/:id/dismiss', asyncHandler(async (req,res)=>{ await pool.query("UPDATE hermes_recommendations SET status='dismissed', updated_at=NOW() WHERE id=$1",[req.params.id]); res.json({success:true}); }));
  app.post('/hermes/recommendations/:id/actioned', asyncHandler(async (req,res)=>{ await pool.query("UPDATE hermes_recommendations SET status='actioned', updated_at=NOW() WHERE id=$1",[req.params.id]); res.json({success:true}); }));
  app.get('/hermes/health', asyncHandler(async (req,res)=>{ const r=await pool.query('SELECT started_at,finished_at,recommendations,alerts,ok,error FROM hermes_runs ORDER BY id DESC LIMIT 1'); res.json({last_run:r.rows[0]||null}); }));
  app.get('/hermes/recovery', asyncHandler(async (req,res)=>{
      const num = s => parseInt(String(s||'').replace(/[^0-9]/g,''))||0;
      const [paying,clv,unconf,renew,rep,wbk,chn]=await Promise.all([
        pool.query("SELECT COUNT(DISTINCT subscriber_id)::int n FROM aykoshop_orders WHERE paid_at IS NOT NULL"),
        pool.query("SELECT COALESCE(SUM(lifetime_value),0)::int clv, COUNT(*) FILTER (WHERE lifetime_value>0)::int payers FROM aykoshop_profiles"),
        pool.query("SELECT COUNT(*)::int n, COALESCE(SUM(NULLIF(regexp_replace(COALESCE(price,''),'[^0-9]','','g'),'')::int),0)::int val FROM aykoshop_orders WHERE paid_at IS NULL AND status='new'"),
        pool.query("SELECT subscriber_id,customer_name,channel,product_name,price,ROUND(EXTRACT(epoch FROM now()-paid_at)/86400)::int days FROM aykoshop_orders WHERE paid_at IS NOT NULL AND (product_name ILIKE '%netflix%' OR product_name ILIKE '%spotify%' OR product_name ILIKE '%subscri%') AND paid_at < now()-INTERVAL '25 days' ORDER BY paid_at ASC LIMIT 50"),
        pool.query("SELECT p.subscriber_id,p.customer_name,p.channel,MAX(o.paid_at) last_paid,COUNT(o.id)::int orders FROM aykoshop_profiles p JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id AND o.paid_at IS NOT NULL GROUP BY p.subscriber_id,p.customer_name,p.channel HAVING MAX(o.paid_at) < now()-INTERVAL '14 days' AND MAX(p.last_seen) > now()-INTERVAL '30 days' ORDER BY MAX(o.paid_at) ASC LIMIT 50"),
        pool.query("SELECT DISTINCT p.subscriber_id,p.customer_name,p.channel,p.last_seen,ROUND(EXTRACT(epoch FROM now()-p.last_seen)/86400)::int days FROM aykoshop_profiles p JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id AND o.paid_at IS NOT NULL WHERE p.last_seen < now()-INTERVAL '21 days' ORDER BY days DESC LIMIT 50"),
        pool.query("SELECT DISTINCT p.subscriber_id,p.customer_name,p.channel,p.total_messages,ROUND(EXTRACT(epoch FROM now()-p.last_seen)/86400)::int days FROM aykoshop_profiles p JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id AND o.paid_at IS NOT NULL WHERE p.last_seen BETWEEN now()-INTERVAL '21 days' AND now()-INTERVAL '5 days' ORDER BY days DESC LIMIT 50")
      ]);
      const renewals=renew.rows, repeats=rep.rows, winback=wbk.rows, churn=chn.rows;
      res.json({
        activated: paying.rows[0].n>0,
        payment_discipline:{ unconfirmed_count:unconf.rows[0].n, unconfirmed_value:unconf.rows[0].val },
        kpis:{ clv_total:clv.rows[0].clv, paying_customers:paying.rows[0].n, renewals_due:renewals.length, winback:winback.length, repeat:repeats.length, churn_risk:churn.length },
        queues:{ renewals, repeat:repeats, winback, churn },
        forecast:{ renewals_due_value:renewals.reduce((a,r)=>a+num(r.price),0), repeat_candidates:repeats.length }
      });
  }));
  console.log('[hermes] /hermes/* routes registered');
}
module.exports = { computeAll, registerRoutes };
