// ===== TYPE POLICIES + PAYMENT ACCOUNTS endpoints (injected into live server.js 2026-06-25) =====
// Reads/edits the spine tables: aykoshop_product_type_policies, aykoshop_payment_accounts.
// Auth: shadow (matches existing dashboard endpoints). Inserted before app.get('/api/settings'...).
// ===== TYPE POLICIES (Type-Contract inherited per product_type via type_key) =====
app.get('/api/type-policies', async (req,res)=>{ try{ const r=await pool.query('SELECT * FROM aykoshop_product_type_policies ORDER BY type_key'); res.json({ok:true, policies:r.rows}); }catch(e){ res.status(500).json({error:e.message}); } });
app.put('/api/type-policies/:type_key', async (req,res)=>{ try{ const k=String(req.params.type_key||''); const b=req.body||{};
  const jsonCols=['warranty_void_conditions','binding_methods','delivery_steps','forbidden_after_delivery','buyer_requirements','default_objections','allowed_payment_methods','sales_dna'];
  const cols=['display_name','warranty_days','warranty_covers','remedy','refund_allowed','predelivery_script','delivery_message','verify_before_delivered','notes'].concat(jsonCols);
  const sets=[]; const vals=[]; let i=1;
  for(const c of cols){ if(c in b){ sets.push(c+'=$'+i); vals.push(jsonCols.indexOf(c)>=0 ? JSON.stringify(b[c]) : b[c]); i++; } }
  if(!sets.length) return res.status(400).json({error:'no editable fields'});
  sets.push('policy_version=policy_version+1'); sets.push('updated_at=NOW()'); vals.push(k);
  const q='UPDATE aykoshop_product_type_policies SET '+sets.join(', ')+' WHERE type_key=$'+i+' RETURNING *';
  const r=await pool.query(q, vals); if(!r.rows.length) return res.status(404).json({error:'type_key not found'});
  res.json({ok:true, policy:r.rows[0]}); }catch(e){ res.status(500).json({error:e.message}); } });
// ===== PAYMENT ACCOUNTS (DB-only pay-to destinations; read by the Purchase Wizard) =====
app.get('/api/payment-accounts', async (req,res)=>{ try{ const r=await pool.query('SELECT * FROM aykoshop_payment_accounts ORDER BY sort_order, id'); res.json({ok:true, accounts:r.rows}); }catch(e){ res.status(500).json({error:e.message}); } });
app.put('/api/payment-accounts/:method_key', async (req,res)=>{ try{ const k=String(req.params.method_key||''); const b=req.body||{};
  const cols=['display_name','holder_name','currency','active','sort_order','notes']; const sets=[]; const vals=[]; let i=1;
  for(const c of cols){ if(c in b){ sets.push(c+'=$'+i); vals.push(b[c]); i++; } }
  if('fields' in b){ sets.push('fields=$'+i); vals.push(JSON.stringify(b.fields)); i++; }
  if(!sets.length) return res.status(400).json({error:'no editable fields'});
  sets.push('updated_at=NOW()'); vals.push(k);
  const q='UPDATE aykoshop_payment_accounts SET '+sets.join(', ')+' WHERE method_key=$'+i+' RETURNING *';
  const r=await pool.query(q, vals); if(!r.rows.length) return res.status(404).json({error:'method_key not found'});
  res.json({ok:true, account:r.rows[0]}); }catch(e){ res.status(500).json({error:e.message}); } });
// ===== END type-policy + payment-account endpoints =====
