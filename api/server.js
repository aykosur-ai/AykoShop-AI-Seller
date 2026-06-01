// AykoShop API Server v2.1
// Production-ready Express.js API for AykoShop AI Seller

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==================== DATABASE ====================
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'n8ndb',
  user: process.env.DB_USER || 'n8n',
  password: process.env.DB_PASSWORD || 'aykoshop2024'
});

// ==================== INIT TABLES ====================
async function initTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS aykoshop_settings (
    id SERIAL PRIMARY KEY, key VARCHAR(100) UNIQUE NOT NULL,
    value TEXT, updated_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`INSERT INTO aykoshop_settings (key,value) VALUES
    ('admin_password','ayko2026'),('store_email','Aykosur@gmail.com'),
    ('store_name','AykoShop'),('store_phone','212632588578')
    ON CONFLICT (key) DO NOTHING`);
}

// ==================== AUTH ====================
app.post('/api/auth/login', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='admin_password'");
    const savedPass = r.rows[0]?.value || 'ayko2026';
    if (req.body.password !== savedPass) return res.status(401).json({error:'كلمة المرور غلط!'});
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({role:'admin'}, process.env.JWT_SECRET || 'ayko_secret_2026', {expiresIn:'7d'});
    res.json({token, expires_in:'7 days'});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/auth/verify', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ','');
    if (!token || token.startsWith('local_token_')) return res.json({valid:true});
    const jwt = require('jsonwebtoken');
    jwt.verify(token, process.env.JWT_SECRET || 'ayko_secret_2026');
    res.json({valid:true});
  } catch(e) { res.status(401).json({error:'Invalid token'}); }
});

// ==================== STATS ====================
app.get('/api/stats', async (req, res) => {
  try {
    const [avail, sold, cust, msgs, cats, sales] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM aykoshop_products WHERE status='available'"),
      pool.query("SELECT COUNT(*) as count FROM aykoshop_products WHERE status='sold'"),
      pool.query("SELECT COUNT(*) as count FROM aykoshop_profiles"),
      pool.query("SELECT COUNT(*) as count FROM aykoshop_chat_history WHERE created_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT category, COUNT(*) as total FROM aykoshop_products WHERE status='available' GROUP BY category ORDER BY total DESC LIMIT 5"),
      pool.query("SELECT DATE(created_at) as date, COUNT(*) as count FROM aykoshop_chat_history WHERE created_at > NOW() - INTERVAL '10 days' GROUP BY DATE(created_at) ORDER BY date")
    ]);
    res.json({ available: avail.rows[0].count, sold: sold.rows[0].count, customers: cust.rows[0].count, messages_today: msgs.rows[0].count, top_categories: cats.rows, sales_by_day: sales.rows });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== PRODUCTS ====================
app.get('/api/products', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_products ORDER BY created_at DESC"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/products/add', async (req, res) => {
  try {
    const { product_name, price, description, image_url, whatsapp_url, instagram_url, category, status } = req.body;
    const r = await pool.query("INSERT INTO aykoshop_products (product_name,price,description,image_url,whatsapp_url,instagram_url,category,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [product_name, price, description||'', image_url||'', whatsapp_url||'', instagram_url||'', category||'', status||'available']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.put('/api/products/:id', async (req, res) => {
  try {
    const { product_name, price, description, image_url, whatsapp_url, instagram_url, category, status } = req.body;
    const r = await pool.query("UPDATE aykoshop_products SET product_name=COALESCE($1,product_name), price=COALESCE($2,price), description=COALESCE($3,description), image_url=COALESCE($4,image_url), whatsapp_url=COALESCE($5,whatsapp_url), instagram_url=COALESCE($6,instagram_url), category=COALESCE($7,category), status=COALESCE($8,status), updated_at=NOW() WHERE id=$9 RETURNING *",
      [product_name, price, description, image_url, whatsapp_url, instagram_url, category, status, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete('/api/products/:id', async (req, res) => {
  try { await pool.query("DELETE FROM aykoshop_products WHERE id=$1", [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});
app.patch('/api/products/:id/status', async (req, res) => {
  try { await pool.query("UPDATE aykoshop_products SET status=$1,updated_at=NOW() WHERE id=$2", [req.body.status, req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== CUSTOMERS ====================
app.get('/api/customers', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_profiles ORDER BY last_seen DESC LIMIT 500"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/customers/:id/history', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_chat_history WHERE subscriber_id=$1 ORDER BY created_at ASC LIMIT 200", [req.params.id]); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/customers/:id/timeline', async (req, res) => {
  try {
    const [history, orders, scores] = await Promise.all([
      pool.query("SELECT role,message,created_at FROM aykoshop_chat_history WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 100", [req.params.id]),
      pool.query("SELECT * FROM aykoshop_orders WHERE customer_name=(SELECT customer_name FROM aykoshop_profiles WHERE subscriber_id=$1 LIMIT 1) ORDER BY created_at DESC", [req.params.id]),
      pool.query("SELECT lead_score,sentiment,scored_at FROM aykoshop_lead_scores WHERE subscriber_id=$1", [req.params.id])
    ]);
    const events = [...history.rows.map(h=>({type:'message',role:h.role,content:h.message,date:h.created_at})), ...orders.rows.map(o=>({type:'order',status:o.status,product:o.product,price:o.price,date:o.created_at}))].sort((a,b)=>new Date(b.date)-new Date(a.date));
    res.json({events, score: scores.rows[0]||null});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== ORDERS ====================
app.get('/api/orders', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_orders ORDER BY created_at DESC LIMIT 500"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/orders', async (req, res) => {
  try {
    const r = await pool.query("INSERT INTO aykoshop_orders (subscriber_id,customer_name,phone,product,city,address,price,status,channel,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
      [req.body.subscriber_id||'', req.body.customer_name, req.body.phone||'', req.body.product, req.body.city||'digital', req.body.address||'', req.body.price||'', req.body.status||'new', req.body.channel||'whatsapp', req.body.notes||'']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.put('/api/orders/:id', async (req, res) => {
  try {
    const r = await pool.query("UPDATE aykoshop_orders SET customer_name=COALESCE($1,customer_name), phone=COALESCE($2,phone), product=COALESCE($3,product), city=COALESCE($4,city), address=COALESCE($5,address), price=COALESCE($6,price), status=COALESCE($7,status), channel=COALESCE($8,channel), notes=COALESCE($9,notes), updated_at=NOW() WHERE id=$10 RETURNING *",
      [req.body.customer_name, req.body.phone, req.body.product, req.body.city, req.body.address, req.body.price, req.body.status, req.body.channel, req.body.notes, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete('/api/orders/:id', async (req, res) => {
  try { await pool.query("DELETE FROM aykoshop_orders WHERE id=$1", [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== TRAINING & CONVERSATIONS ====================
app.get('/api/training', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_training ORDER BY created_at DESC LIMIT 200"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/training', async (req, res) => {
  try { const r = await pool.query("INSERT INTO aykoshop_training (question,correct_answer,category) VALUES ($1,$2,$3) RETURNING *", [req.body.question, req.body.correct_answer, req.body.category||'general']); res.json(r.rows[0]); } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete('/api/training/:id', async (req, res) => {
  try { await pool.query("DELETE FROM aykoshop_training WHERE id=$1", [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/conversations', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_conversation_examples ORDER BY created_at DESC LIMIT 200"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/conversations', async (req, res) => {
  try { const r = await pool.query("INSERT INTO aykoshop_conversation_examples (category,name,customer_message,correct_reply,source) VALUES ($1,$2,$3,$4,'manual') RETURNING *", [req.body.category||'general', req.body.name||'', req.body.customer_message, req.body.correct_reply]); res.json(r.rows[0]); } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete('/api/conversations/:id', async (req, res) => {
  try { await pool.query("DELETE FROM aykoshop_conversation_examples WHERE id=$1", [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== UNKNOWN QUESTIONS ====================
app.get('/api/unknown-questions', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_unknown_questions ORDER BY created_at DESC LIMIT 100"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/unknown-questions', async (req, res) => {
  try { const r = await pool.query("INSERT INTO aykoshop_unknown_questions (subscriber_id,customer_name,question,channel,manychat_link) VALUES ($1,$2,$3,$4,$5) RETURNING *", [req.body.subscriber_id||'', req.body.customer_name||'', req.body.question, req.body.channel||'', req.body.manychat_link||'']); res.json(r.rows[0]); } catch(e) { res.status(500).json({error: e.message}); }
});
app.patch('/api/unknown-questions/:id/answer', async (req, res) => {
  try {
    const q = await pool.query("SELECT * FROM aykoshop_unknown_questions WHERE id=$1", [req.params.id]);
    if (!q.rows.length) return res.status(404).json({error:'Not found'});
    await pool.query("UPDATE aykoshop_unknown_questions SET answer=$1,learned=true,category=$2 WHERE id=$3", [req.body.answer, req.body.category||'general', req.params.id]);
    await pool.query("INSERT INTO aykoshop_conversation_examples (category,customer_message,correct_reply,source,subscriber_id) VALUES ($1,$2,$3,'admin',$4) ON CONFLICT DO NOTHING", [req.body.category||'general', q.rows[0].question, req.body.answer, q.rows[0].subscriber_id||'']);
    res.json({success:true, learned:true});
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete('/api/unknown-questions/:id', async (req, res) => {
  try { await pool.query("DELETE FROM aykoshop_unknown_questions WHERE id=$1", [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== WAREHOUSE ====================
app.get('/api/warehouse/stats', async (req, res) => {
  try {
    const [total, byCategory, byPlatform, byResult, topCustomers] = await Promise.all([
      pool.query("SELECT COUNT(*) as total FROM aykoshop_warehouse"),
      pool.query("SELECT category, COUNT(*) as count FROM aykoshop_warehouse GROUP BY category ORDER BY count DESC LIMIT 10"),
      pool.query("SELECT platform, COUNT(*) as count FROM aykoshop_warehouse GROUP BY platform ORDER BY count DESC"),
      pool.query("SELECT result, COUNT(*) as count FROM aykoshop_warehouse GROUP BY result ORDER BY count DESC"),
      pool.query("SELECT customer_name, COUNT(*) as messages, SUM(CASE WHEN result='purchased' THEN 1 ELSE 0 END) as purchases FROM aykoshop_warehouse GROUP BY customer_name ORDER BY purchases DESC, messages DESC LIMIT 10")
    ]);
    res.json({ total: parseInt(total.rows[0].total), by_category: byCategory.rows, by_platform: byPlatform.rows, by_result: byResult.rows, top_customers: topCustomers.rows });
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/warehouse/search', async (req, res) => {
  try {
    const { q, category, platform, result, limit } = req.query;
    let conditions = [], params = [], idx = 1;
    if (q) { conditions.push(`(message ILIKE $${idx} OR customer_name ILIKE $${idx})`); params.push('%'+q+'%'); idx++; }
    if (category && category !== 'all') { conditions.push(`category=$${idx}`); params.push(category); idx++; }
    if (platform && platform !== 'all') { conditions.push(`platform=$${idx}`); params.push(platform); idx++; }
    if (result && result !== 'all') { conditions.push(`result=$${idx}`); params.push(result); idx++; }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim = Math.min(parseInt(limit)||100, 500);
    const r = await pool.query(`SELECT * FROM aykoshop_warehouse ${where} ORDER BY created_at DESC LIMIT ${lim}`, params);
    const count = await pool.query(`SELECT COUNT(*) as total FROM aykoshop_warehouse ${where}`, params);
    res.json({ data: r.rows, total: parseInt(count.rows[0].total) });
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/warehouse', async (req, res) => {
  try { const r = await pool.query("INSERT INTO aykoshop_warehouse (subscriber_id,customer_name,platform,message,ai_response,intent,category,result,tags,order_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *", [req.body.subscriber_id||'', req.body.customer_name||'', req.body.platform||'', req.body.message||'', req.body.ai_response||'', req.body.intent||'general', req.body.category||'general', req.body.result||'pending', req.body.tags||'', req.body.order_id||null]); res.json(r.rows[0]); } catch(e) { res.status(500).json({error: e.message}); }
});
app.patch('/api/warehouse/:id/result', async (req, res) => {
  try { await pool.query("UPDATE aykoshop_warehouse SET result=$1 WHERE id=$2", [req.body.result, req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== SEGMENTS & FOLLOW-UPS ====================
app.get('/api/segments', async (req, res) => {
  try {
    const [vip, hot, lost, newC] = await Promise.all([
      pool.query("SELECT p.subscriber_id,p.customer_name,p.channel,p.last_seen,COUNT(o.id) as order_count FROM aykoshop_profiles p JOIN aykoshop_orders o ON o.customer_name=p.customer_name WHERE o.status='delivered' GROUP BY p.subscriber_id,p.customer_name,p.channel,p.last_seen HAVING COUNT(o.id)>=2 ORDER BY order_count DESC LIMIT 50"),
      pool.query("SELECT subscriber_id,customer_name,channel,last_seen,interested_in,EXTRACT(EPOCH FROM (NOW()-last_seen))/3600 as hours_ago FROM aykoshop_profiles WHERE stage IN ('hot','warm') AND last_seen > NOW()-INTERVAL '7 days' ORDER BY last_seen DESC LIMIT 50"),
      pool.query("SELECT subscriber_id,customer_name,channel,last_seen,interested_in,EXTRACT(EPOCH FROM (NOW()-last_seen))/3600 as hours_ago FROM aykoshop_profiles WHERE stage IN ('hot','warm') AND last_seen < NOW()-INTERVAL '7 days' ORDER BY last_seen DESC LIMIT 50"),
      pool.query("SELECT subscriber_id,customer_name,channel,last_seen,stage FROM aykoshop_profiles WHERE created_at > NOW()-INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 50")
    ]);
    res.json({ vip: vip.rows, hot_not_purchased: hot.rows, lost: lost.rows, new_today: newC.rows });
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/follow-ups', async (req, res) => {
  try { const r = await pool.query("SELECT p.subscriber_id,p.customer_name,p.channel,p.last_seen,p.interested_in,p.stage,EXTRACT(EPOCH FROM (NOW()-p.last_seen))/3600 as hours_since,ls.lead_score FROM aykoshop_profiles p LEFT JOIN aykoshop_lead_scores ls ON ls.subscriber_id=p.subscriber_id WHERE p.stage IN ('hot','warm') AND p.last_seen < NOW()-INTERVAL '24 hours' AND p.last_seen > NOW()-INTERVAL '14 days' ORDER BY ls.lead_score DESC NULLS LAST, p.last_seen ASC LIMIT 100"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/follow-ups/bulk-send', async (req, res) => {
  try {
    const { message, target } = req.body;
    let q = "SELECT DISTINCT subscriber_id,customer_name,channel FROM aykoshop_profiles WHERE stage IN ('hot','warm') AND last_seen < NOW()-INTERVAL '24 hours' AND last_seen > NOW()-INTERVAL '14 days'";
    if (target==='lost') q += " AND last_seen < NOW()-INTERVAL '7 days'";
    if (target==='hot') q += " AND stage='hot'";
    q += " LIMIT 50";
    const profiles = await pool.query(q);
    const MANYCHAT_KEY = `Bearer ${process.env.MANYCHAT_API_KEY}`;
    let sent = 0, failed = 0;
    for (const p of profiles.rows) {
      try { await fetch('https://api.manychat.com/fb/sending/sendContent', { method:'POST', headers:{'Authorization':MANYCHAT_KEY,'Content-Type':'application/json'}, body: JSON.stringify({ subscriber_id: p.subscriber_id, data: { version:'v2', content:{ messages:[{type:'text',text:message}] } } }) }); sent++; await new Promise(r=>setTimeout(r,300)); } catch(e) { failed++; }
    }
    res.json({success:true, sent, failed, total: profiles.rows.length});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== AI INSIGHTS ====================
app.get('/api/ai-insights', async (req, res) => {
  try {
    const [topProducts, topQuestions, readyToBuy, convRate, bestChannel] = await Promise.all([
      pool.query("SELECT product, COUNT(*) as orders FROM aykoshop_orders WHERE status='delivered' GROUP BY product ORDER BY orders DESC LIMIT 5"),
      pool.query("SELECT question, COUNT(*) as count FROM aykoshop_unknown_questions GROUP BY question ORDER BY count DESC LIMIT 5"),
      pool.query("SELECT p.customer_name,p.channel,ls.lead_score,p.interested_in FROM aykoshop_profiles p JOIN aykoshop_lead_scores ls ON ls.subscriber_id=p.subscriber_id WHERE ls.lead_score>60 ORDER BY ls.lead_score DESC LIMIT 10"),
      pool.query("SELECT COUNT(DISTINCT p.subscriber_id) as total_leads, COUNT(DISTINCT o.customer_name) as converted FROM aykoshop_profiles p LEFT JOIN aykoshop_orders o ON o.customer_name=p.customer_name AND o.status='delivered'"),
      pool.query("SELECT channel, COUNT(*) as count FROM aykoshop_profiles GROUP BY channel ORDER BY count DESC LIMIT 1")
    ]);
    const cr = convRate.rows[0];
    const rate = cr.total_leads > 0 ? Math.round((cr.converted / cr.total_leads) * 100) : 0;
    res.json({ top_products: topProducts.rows, top_questions: topQuestions.rows, ready_to_buy: readyToBuy.rows, conversion_rate: { rate }, best_channel: bestChannel.rows[0] });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== SETTINGS ====================
app.get('/api/settings', async (req, res) => {
  try { const r = await pool.query("SELECT key,value FROM aykoshop_settings"); const s = {}; r.rows.forEach(row => s[row.key]=row.value); res.json(s); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/settings', async (req, res) => {
  try { await pool.query("INSERT INTO aykoshop_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()", [req.body.key, req.body.value]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/settings/change-password', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='admin_password'");
    const savedPass = r.rows[0]?.value || 'ayko2026';
    if (req.body.current_password !== savedPass) return res.status(401).json({error:'الباسورد الحالي غلط!'});
    await pool.query("UPDATE aykoshop_settings SET value=$1,updated_at=NOW() WHERE key='admin_password'", [req.body.new_password]);
    res.json({success:true});
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/settings/reset-password', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='store_email'");
    const savedEmail = r.rows[0]?.value || 'Aykosur@gmail.com';
    if (req.body.email.toLowerCase() !== savedEmail.toLowerCase()) return res.status(401).json({error:'الإيميل غلط!'});
    await pool.query("UPDATE aykoshop_settings SET value=$1,updated_at=NOW() WHERE key='admin_password'", [req.body.new_password]);
    res.json({success:true});
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/system-prompt', async (req, res) => {
  try { const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='system_prompt'"); res.json({prompt: r.rows[0]?.value || ''}); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/system-prompt', async (req, res) => {
  try { await pool.query("INSERT INTO aykoshop_settings (key,value) VALUES ('system_prompt',$1) ON CONFLICT (key) DO UPDATE SET value=$1,updated_at=NOW()", [req.body.prompt]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== BROADCASTS ====================
app.get('/api/broadcasts', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_broadcasts ORDER BY created_at DESC LIMIT 100"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/broadcasts', async (req, res) => {
  try { const r = await pool.query("INSERT INTO aykoshop_broadcasts (title,message,target_stage,status) VALUES ($1,$2,$3,'draft') RETURNING *", [req.body.title, req.body.message, req.body.target_stage||'all']); res.json(r.rows[0]); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/broadcasts/:id/send', async (req, res) => {
  try {
    const b = await pool.query("SELECT * FROM aykoshop_broadcasts WHERE id=$1", [req.params.id]);
    if (!b.rows.length) return res.status(404).json({error:'Not found'});
    const broadcast = b.rows[0];
    let query = "SELECT subscriber_id FROM aykoshop_profiles WHERE 1=1";
    if (broadcast.target_stage && broadcast.target_stage !== 'all') query += ` AND stage='${broadcast.target_stage}'`;
    const profiles = await pool.query(query + " LIMIT 100");
    const MANYCHAT_KEY = `Bearer ${process.env.MANYCHAT_API_KEY}`;
    let sent = 0;
    for (const p of profiles.rows) {
      try { await fetch('https://api.manychat.com/fb/sending/sendContent', { method:'POST', headers:{'Authorization':MANYCHAT_KEY,'Content-Type':'application/json'}, body: JSON.stringify({ subscriber_id: p.subscriber_id, data: { version:'v2', content:{ messages:[{type:'text',text:broadcast.message}] } } }) }); sent++; await new Promise(r=>setTimeout(r,200)); } catch(e) {}
    }
    await pool.query("UPDATE aykoshop_broadcasts SET status='sent', sent_count=$1, sent_at=NOW() WHERE id=$2", [sent, req.params.id]);
    res.json({success:true, sent});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== MISC ====================
app.get('/api/demands', async (req, res) => {
  try {
    const period = req.query.period || 'week';
    const interval = period === 'day' ? '24 hours' : period === 'month' ? '30 days' : '7 days';
    const r = await pool.query(`SELECT interested_in as product, COUNT(*) as count FROM aykoshop_profiles WHERE interested_in IS NOT NULL AND interested_in != '' AND last_seen > NOW() - INTERVAL '${interval}' GROUP BY interested_in ORDER BY count DESC LIMIT 10`);
    res.json({ demands: r.rows });
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/lead-scores', async (req, res) => {
  try { const r = await pool.query("SELECT ls.*, p.customer_name, p.channel, p.interested_in FROM aykoshop_lead_scores ls LEFT JOIN aykoshop_profiles p ON p.subscriber_id=ls.subscriber_id ORDER BY ls.lead_score DESC LIMIT 100"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/pipeline', async (req, res) => {
  try { const r = await pool.query("SELECT p.*, COALESCE(ls.lead_score,0) as score FROM aykoshop_profiles p LEFT JOIN aykoshop_lead_scores ls ON ls.subscriber_id=p.subscriber_id ORDER BY score DESC LIMIT 200"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/workflow-errors', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_workflow_errors ORDER BY started_at DESC LIMIT 100"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.patch('/api/workflow-errors/:id/resolve', async (req, res) => {
  try { await pool.query("UPDATE aykoshop_workflow_errors SET resolved=true WHERE id=$1", [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== EXPORT ====================
app.get('/api/export/customers', async (req, res) => {
  try {
    const r = await pool.query("SELECT p.customer_name,p.channel,p.stage,p.interested_in,p.total_messages,p.last_seen,COALESCE(ls.lead_score,0) as lead_score FROM aykoshop_profiles p LEFT JOIN aykoshop_lead_scores ls ON ls.subscriber_id=p.subscriber_id ORDER BY p.last_seen DESC");
    const csv = ['الاسم,القناة,المرحلة,مهتم بـ,الرسائل,آخر ظهور,Lead Score', ...r.rows.map(row => [row.customer_name||'',row.channel||'',row.stage||'',row.interested_in||'',row.total_messages||0,row.last_seen?new Date(row.last_seen).toLocaleDateString('ar'):'',row.lead_score||0].join(','))].join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename=customers.csv'); res.send('\uFEFF'+csv);
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/export/orders', async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM aykoshop_orders ORDER BY created_at DESC");
    const csv = ['ID,الزبون,الهاتف,المنتج,السعر,القناة,الحالة,التاريخ', ...r.rows.map(row => [row.id,row.customer_name||'',row.phone||'',row.product||'',row.price||'',row.channel||'',row.status||'',row.created_at?new Date(row.created_at).toLocaleDateString('ar'):''].join(','))].join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename=orders.csv'); res.send('\uFEFF'+csv);
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/export/conversations', async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM aykoshop_warehouse ORDER BY created_at DESC LIMIT 5000");
    const csv = ['الزبون,القناة,الفئة,الرسالة,رد AI,النتيجة,التاريخ', ...r.rows.map(row => [row.customer_name||'',row.platform||'',row.category||'',`"${(row.message||'').replace(/"/g,'""')}"`,`"${(row.ai_response||'').replace(/"/g,'""')}"`,row.result||'',row.created_at?new Date(row.created_at).toLocaleDateString('ar'):''].join(','))].join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename=conversations.csv'); res.send('\uFEFF'+csv);
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== START ====================
initTables().then(() => {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`AykoShop API v2.1 - port ${PORT}`));
});

module.exports = app;
