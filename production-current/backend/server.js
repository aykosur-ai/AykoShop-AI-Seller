require('dotenv').config({ path: __dirname + '/.env', override: true });
;(function(){var _req=['DB_PASSWORD','DB_NAME','DB_USER','JWT_SECRET','SERVICE_TOKEN'];var _miss=_req.filter(function(k){return !process.env[k]||typeof process.env[k]!=='string'||!String(process.env[k]).trim();});if(_miss.length){console.error('[FATAL '+new Date().toISOString()+'] Missing/invalid required env: '+_miss.join(', ')+' -- refusing to start (prevents DB SASL crash-loop). Fix '+__dirname+'/.env then: pm2 restart aykoshop-api');process.exit(1);}console.log('[startup] env validation OK ('+_req.length+' required keys present)');})();
// AykoShop API Server v2.1
// Production-ready Express.js API for AykoShop AI Seller

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const app = express();

app.use(cors({origin:function(o,cb){if(!o||/^https?:\/\/(ayko\.store|localhost|127\.0\.0\.1|5\.189\.170\.55)/.test(o))cb(null,true);else cb(null,false);}, credentials:true}));
app.use(express.json({ limit: '10mb' }));
// ===== In-memory rate limiter (no npm) =====
const _rl=new Map();
setInterval(()=>{ const n=Date.now(); for(const[k,v] of _rl.entries()) if(v.r<n) _rl.delete(k); },60000);
function _checkRL(key,max,ms){ const n=Date.now(),b=_rl.get(key)||{c:0,r:n+ms}; if(n>b.r){b.c=0;b.r=n+ms;} b.c++; _rl.set(key,b); return b.c>max; }

// ===== Audit Log middleware (auto-captures operator/content mutations) =====
const AUDIT_SKIP = ['/api/auth','/api/events','/api/warehouse','/api/workflow-errors','/api/sessions','/api/recommendations'];
app.use((req, res, next) => {
  try {
    if (req.method === 'GET' || req.method === 'OPTIONS' || !req.path.startsWith('/api/')) return next();
    if (AUDIT_SKIP.some(p => req.path.startsWith(p))) return next();
    res.on('finish', () => {
      try {
        const em = req.path.match(/^\/api\/([a-z0-9-]+)(?:\/([^\/]+))?/i);
        const entity = em ? em[1] : 'api';
        const entity_id = (em && em[2] && !/^[a-z-]+$/i.test(em[2])) ? em[2] : null;
        const actor = (req.headers['x-operator'] || (req.ip || '').replace('::ffff:', '') || 'system').slice(0, 80);
        const detail = JSON.stringify(req.body || {}).slice(0, 800);
        pool.query("INSERT INTO aykoshop_audit_log (method,path,entity,entity_id,status,actor,detail,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())",
          [req.method, req.path, entity, entity_id, res.statusCode, actor, detail]).catch(() => {});
      } catch (e) {}
    });
  } catch (e) {}
  next();
});

// ==================== IMAGE UPLOAD ====================
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const UPLOAD_DIR = '/var/www/uploads/products';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `product-${Date.now()}-${Math.random().toString(36).slice(2,7)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    ['.jpg','.jpeg','.png','.webp','.gif'].includes(path.extname(file.originalname).toLowerCase())
      ? cb(null, true) : cb(new Error('نوع الملف غير مدعوم'));
  }
});

// ===== AUTH SHADOW (ADR-0005) — shadow-first; never blocks unless auth_mode='enforce:<tier>' includes the route's tier =====
const _AUTH_PUBLIC = new Set(['POST /api/auth/login','GET /api/auth/verify','GET /api/ops/status','GET /api/health']);
// sensitive WRITES → ADMIN (role=admin JWT only; service token rejected). GET system-prompt stays SERVICE (n8n reads it).
const _AUTH_ADMIN_RE = [/^\/api\/settings/, /^\/api\/ai\/keys/, /^\/api\/ai-config/, /^\/api\/ai\/agents/, /^\/api\/broadcasts/, /^\/api\/export/, /^\/api\/ops\/circuit/, /^\/api\/system-prompt$/];
// SACRED human-only (payment/delivery/outbound) → OPERATOR, NEVER service (the n8n token must not confirm a payment).
const _AUTH_SACRED_RE = [/^\/api\/orders\/[^/]+\/(confirm-payment|deliver)$/, /^\/api\/orders\/[^/]+$/, /^\/api\/payment-claims\/[^/]+\/(confirm|reject)$/, /^\/api\/customers\/[^/]+\/message$/];
// the 25 endpoints n8n calls → SERVICE (service-token OR JWT).
const _AUTH_SERVICE_RE = [/^\/api\/ai\/(generate|vision)$/, /^\/api\/chat-history/, /^\/api\/customers(\/[^/]+\/ai-status)?$/, /^\/api\/demands/, /^\/api\/events/, /^\/api\/inbox\/ingest/, /^\/api\/interventions/, /^\/api\/ops\/ai-status/, /^\/api\/orders$/, /^\/api\/outbox/, /^\/api\/products(\/(add|embed|vector-search))?$/, /^\/api\/recommendations/, /^\/api\/sessions/, /^\/api\/stats/, /^\/api\/system-prompt$/, /^\/api\/unknown-(keywords|questions)/, /^\/api\/warehouse/, /^\/api\/workflow-errors/];
// routes that authenticate via their OWN token (not a JWT) — middleware must not gate them (e.g. payment-claims /act = Telegram-button approve_token)
const _AUTH_SELFAUTH_RE = [/^\/api\/payment-claims\/[^/]+\/act$/];
function _authTier(method, p){
  if (_AUTH_PUBLIC.has(method + ' ' + p)) return 'PUBLIC';
  if (_AUTH_SELFAUTH_RE.some(r => r.test(p))) return 'PUBLIC';
  if (method === 'GET' && ['/api/settings','/api/ai/keys','/api/ai-config'].includes(p)) return 'ADMIN';
  if (method !== 'GET' && _AUTH_ADMIN_RE.some(r => r.test(p))) return 'ADMIN';
  if (method !== 'GET' && _AUTH_SACRED_RE.some(r => r.test(p))) return 'OPERATOR';
  if (_AUTH_SERVICE_RE.some(r => r.test(p))) return 'SERVICE';
  return 'OPERATOR'; // deny-by-default
}
let _authMode = 'off', _authModeTs = 0;
async function _getAuthMode(){ if (Date.now() - _authModeTs < 30000) return _authMode; _authModeTs = Date.now(); try { const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='auth_mode'"); _authMode = (r.rows[0]||{}).value || 'off'; } catch(e){} return _authMode; }
function _authPrincipal(req){
  const st = req.headers['x-service-token'];
  if (st && process.env.SERVICE_TOKEN && st === process.env.SERVICE_TOKEN) return { kind:'service', id:'n8n-service' };
  const m = String(req.headers['authorization']||'').match(/^Bearer (.+)$/);
  if (m){ try { const jwt = require('jsonwebtoken'); const d = jwt.verify(m[1], process.env.JWT_SECRET); return { kind:'admin', id: d.role||'admin' }; } catch(e){ return { kind:'invalid', id:null }; } }
  return { kind:'none', id:null };
}
app.use(async (req, res, next) => {
  let mode='off'; try { mode = await _getAuthMode(); } catch(e){}
  if (mode === 'off' || !req.path.startsWith('/api/')) return next();
  try {
    const tier = _authTier(req.method, req.path);
    if (tier === 'PUBLIC') return next();
    const pr = _authPrincipal(req);
    const ok = (tier === 'SERVICE') ? (pr.kind === 'service' || pr.kind === 'admin') : (pr.kind === 'admin'); // ADMIN+OPERATOR require a valid JWT today
    const stages = mode.startsWith('enforce') ? mode.replace('enforce:','').split(',') : [];
    const enforced = stages.includes('all') || stages.includes(tier.toLowerCase());
    const actor = (pr.id || req.headers['x-operator'] || (req.ip||'').replace('::ffff:','') || 'anon');
    pool.query("INSERT INTO aykoshop_auth_shadow(method,path,required_tier,principal,decision,reason,actor,ip) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [req.method, req.path.slice(0,300), tier, pr.kind, ok?'allow':'would-block', enforced?'ENFORCED':'shadow', String(actor).slice(0,80), String(req.ip||'').slice(0,45)]).catch(()=>{});
    if (enforced && !ok) return res.status(pr.kind === 'none' || pr.kind === 'invalid' ? 401 : 403).json({ error:'unauthorized', tier });
  } catch(e){ /* fail-OPEN in shadow/never-block design; enforce-time errors above already returned */ }
  next();
});
// ===== end AUTH SHADOW =====

app.use('/uploads', express.static('/var/www/uploads'));
// Phase 1 (2026-07-02): asyncHandler — pure de-duplication of the
// `catch(e){ res.status(500).json({error: e.message}) }` pattern.
// Byte-identical output to the inline try/catch it replaces.
function asyncHandler(fn) {
  return function(req, res, next) {
    Promise.resolve(fn(req, res)).catch(function(e) { res.status(500).json({ error: e.message }); });
  };
}

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'لم يتم رفع الصورة' });
  res.json({ success: true, url: `https://n8n.ayko.store/uploads/products/${req.file.filename}`, filename: req.file.filename });
});
// ===== Inbox operator media upload (images + video + pdf) → public URL for ManyChat sendContent. Additive; does not touch /api/upload. =====
const INBOX_UPLOAD_DIR = '/var/www/uploads/inbox';
try { if (!fs.existsSync(INBOX_UPLOAD_DIR)) fs.mkdirSync(INBOX_UPLOAD_DIR, { recursive: true }); } catch(_e){}
const _inboxMediaStorage = multer.diskStorage({
  destination: INBOX_UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname).toLowerCase())
});
const _inboxMediaExt = ['.jpg','.jpeg','.png','.webp','.gif','.mp4','.mov','.webm','.m4v','.pdf'];
const _inboxUpload = multer({
  storage: _inboxMediaStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { const ok = _inboxMediaExt.includes(path.extname(file.originalname).toLowerCase()); cb(ok ? null : new Error('نوع ملف غير مدعوم'), ok); }
});
app.post('/api/inbox/upload-media', (req, res) => {
  _inboxUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message || 'فشل الرفع' });
    if (!req.file) return res.status(400).json({ success: false, error: 'لا ملف' });
    const ext = path.extname(req.file.filename).toLowerCase();
    const kind = ['.mp4','.mov','.webm','.m4v'].includes(ext) ? 'video' : (ext === '.pdf' ? 'file' : 'image');
    res.json({ success: true, url: `https://n8n.ayko.store/uploads/inbox/${req.file.filename}`, kind, filename: req.file.filename });
  });
});
// ======================================================

// ===== Inbound media ARCHIVAL: customer media arrives as ManyChat S3 / Meta CDN URLs that EXPIRE. Download the bytes → re-host on OUR disk (/var/www/uploads/inbox) → permanent URL. Best-effort + non-blocking; on any failure the original URL is kept (never breaks the pipeline). =====
const _MEDIA_CT_EXT = {'image/jpeg':'.jpg','image/jpg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm','audio/ogg':'.ogg','audio/opus':'.ogg','audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/x-m4a':'.m4a','audio/wav':'.wav','audio/aac':'.aac','application/pdf':'.pdf'};
function _mediaKind(ext){ ext=String(ext||'').toLowerCase(); if(['.jpg','.jpeg','.png','.webp','.gif'].includes(ext))return 'image'; if(['.mp4','.mov','.webm','.m4v'].includes(ext))return 'video'; if(['.ogg','.opus','.mp3','.m4a','.wav','.aac'].includes(ext))return 'audio'; return 'file'; }
// SSRF guard: re-host ONLY from known ManyChat/Meta/WhatsApp/S3 media CDNs (a customer message URL is attacker-controlled → never let the server fetch internal/metadata/loopback hosts).
const _MEDIA_HOST_ALLOW = [/(^|\.)fbcdn\.net$/i, /(^|\.)cdninstagram\.com$/i, /(^|\.)fbsbx\.com$/i, /(^|\.)manychat\.com$/i, /\.s3[.-][a-z0-9-]+\.amazonaws\.com$/i, /(^|\.)whatsapp\.net$/i, /(^|\.)scontent\./i, /(^|\.)akamaihd\.net$/i];
function _mediaHostAllowed(u){ try{ const h=(new URL(u)).hostname.toLowerCase(); return _MEDIA_HOST_ALLOW.some(function(r){return r.test(h);}); }catch(_e){ return false; } }
async function _archiveMedia(srcUrl){
  try{
    if(!/^https?:\/\/\S+$/i.test(srcUrl||'')) return null;
    if(String(srcUrl).includes('n8n.ayko.store/uploads/inbox/')){ const e=path.extname(srcUrl.split(/[?#]/)[0]).toLowerCase(); return { url:srcUrl, kind:_mediaKind(e) }; } // already ours → idempotent
    if(!_mediaHostAllowed(srcUrl)) return null; // SSRF: only known media CDNs
    const resp=await fetch(srcUrl,{signal:AbortSignal.timeout(20000), redirect:'error'}); if(!resp.ok) return null; // redirect:'error' → block 30x to an internal host
    const ct=(resp.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    const buf=Buffer.from(await resp.arrayBuffer());
    if(!buf.length || buf.length > 100*1024*1024) return null;
    let ext=_MEDIA_CT_EXT[ct] || path.extname(srcUrl.split(/[?#]/)[0]).toLowerCase();
    if(!ext || ext.length>6) ext = ct.startsWith('image/')?'.jpg':ct.startsWith('video/')?'.mp4':ct.startsWith('audio/')?'.ogg':(ct==='application/pdf'?'.pdf':'.bin');
    const fname=Date.now()+'-'+Math.round(Math.random()*1e9)+ext;
    await fs.promises.writeFile(path.join(INBOX_UPLOAD_DIR, fname), buf);
    return { url:'https://n8n.ayko.store/uploads/inbox/'+fname, kind:_mediaKind(ext), bytes:buf.length };
  }catch(_e){ return null; }
}
// Periodic archival sweep (decoupled from the ingest request path → no latency, no dup): re-host recent external customer-media URLs (whoever saved them: n8n voice rows, takeover rows) onto OUR disk before the ManyChat/Meta CDN URL expires. Idempotent + SSRF-guarded via _archiveMedia. Non-overlapping.
let _archiveSweepRunning=false;
async function _archiveSweep(){
  if(_archiveSweepRunning) return; _archiveSweepRunning=true;
  try{
    const r=await pool.query("SELECT id, message FROM aykoshop_chat_history WHERE role='user' AND message ~* '^https?://\\S+$' AND message NOT LIKE '%n8n.ayko.store/uploads/inbox/%' AND created_at > NOW() - interval '2 hours' ORDER BY id DESC LIMIT 20");
    for(const row of r.rows){ try{ const a=await _archiveMedia(row.message); if(a&&a.url) await pool.query("UPDATE aykoshop_chat_history SET message=$1, media_url=$2, media_type=$3 WHERE id=$4",[a.url, a.url, a.kind, row.id]); }catch(_e){} }
  }catch(_e){}finally{ _archiveSweepRunning=false; }
}
setInterval(function(){ _archiveSweep().catch(function(){}); }, 90000);

// ==================== VIDEO PIPELINE (SCAFFOLD) ====================
// Independent path: Dashboard -> POST /api/inbox/send-video -> SendVideoService -> validation -> logger -> VideoProvider -> CloudApiProvider.
// SCAFFOLD ONLY: does NOT use ManyChat and does NOT yet call Meta. Text sending, image sending, and ManyChat flows are untouched.
// When phone_number_id + access_token are available, implement CloudApiProvider.send() (the TODO block) — nothing else changes.

// Provider interface: every video provider implements async send({ toPhone, mediaUrl, caption }) -> { sent:boolean, ... }
const _videoProviders = {
  cloud_api: {
    name: 'CloudApiProvider',
    async send({ toPhone, mediaUrl, caption }) {
      // TODO: Send via WhatsApp Cloud API
      //   const PHONE_NUMBER_ID = getSecret('wa_phone_number_id','WA_PHONE_NUMBER_ID');
      //   const TOKEN = getSecret('wa_cloud_token','WA_CLOUD_TOKEN');
      //   const r = await fetch('https://graph.facebook.com/v21.0/' + PHONE_NUMBER_ID + '/messages', {
      //     method:'POST', headers:{ 'Authorization':'Bearer ' + TOKEN, 'Content-Type':'application/json' },
      //     body: JSON.stringify({ messaging_product:'whatsapp', to: toPhone, type:'video', video:{ link: mediaUrl, caption: caption||undefined } }) });
      //   const j = await r.json().catch(()=>({})); return { sent: (r.ok && !!(j.messages && j.messages[0])), http:r.status, meta:j };
      return { sent:false, stub:true, reason:'CloudApiProvider not implemented yet (awaiting phone_number_id + access_token)' };
    }
  }
};
function _selectVideoProvider(/* channel */){ return _videoProviders.cloud_api; }

// Service layer
async function _sendVideoService({ conversation_id, toPhone, mediaUrl, caption }) {
  const provider = _selectVideoProvider();
  try{ console.log('[VIDEO_PROVIDER_SELECTED]', JSON.stringify({ conversation_id, provider: provider.name })); }catch(_e){}
  const result = await provider.send({ toPhone, mediaUrl, caption });
  try{ console.log('[VIDEO_READY]', JSON.stringify({ conversation_id, toPhone:String(toPhone||'').slice(0,7)+'…', mediaUrl, provider: provider.name, result }).slice(0,800)); }catch(_e){}
  return { provider: provider.name, ...result };
}

// Resolve the customer WhatsApp phone (E.164) from the subscriber if not supplied (read-only getInfo; NOT a ManyChat send)
async function _resolveWaPhone(conversation_id, supplied) {
  let p = String(supplied||'').trim();
  if (p) return p.replace(/[^\d+]/g,'');
  try {
    const r = await mcGetInfo(conversation_id);
    const j = await r.json().catch(()=>({}));
    p = String((j && j.data && j.data.whatsapp_phone) || '').trim();
  } catch(_e){}
  return p.replace(/[^\d+]/g,'');
}

// Route + Controller (validation)
app.post('/api/inbox/send-video', async (req, res) => {
  try {
    const { conversation_id, phone, media_url, caption } = req.body || {};
    try{ console.log('[VIDEO_REQUEST]', JSON.stringify({ conversation_id, has_phone: !!phone, media_url, has_caption: !!caption })); }catch(_e){}
    const errors = [];
    if (!conversation_id) errors.push('conversation_id required');
    if (!media_url || !/^https?:\/\/\S+\.(mp4|mov|webm|m4v|ogg)(\?|#|$)/i.test(String(media_url))) errors.push('valid video media_url (mp4/mov/webm/m4v) required');
    const toPhone = await _resolveWaPhone(conversation_id, phone);
    if (!toPhone || toPhone.replace(/\D/g,'').length < 8) errors.push('valid customer phone required (not found for this conversation)');
    if (errors.length) {
      try{ console.log('[VIDEO_VALIDATION_FAILED]', JSON.stringify({ conversation_id, errors })); }catch(_e){}
      return res.status(400).json({ success:false, errors });
    }
    try{ console.log('[VIDEO_VALIDATED]', JSON.stringify({ conversation_id, toPhone: toPhone.slice(0,7)+'…', media_url })); }catch(_e){}
    const out = await _sendVideoService({ conversation_id, toPhone, mediaUrl: media_url, caption: caption||'' });
    // SCAFFOLD: CloudApiProvider is a stub -> report pipeline-ready, NOT delivered. Wire CloudApiProvider.send to actually deliver.
    return res.json({ success:true, scaffold:true, delivered: !!out.sent, provider: out.provider, detail: out });
  } catch(e) { try{ console.log('[VIDEO_ERROR]', e.message); }catch(_e){} res.status(500).json({ success:false, error: e.message }); }
});
// ===================================================================

// ==================== DATABASE ====================
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'n8ndb',
  user: process.env.DB_USER || 'n8n',
  password: process.env.DB_PASSWORD || '',
  max: parseInt(process.env.PG_POOL_MAX) || 25,        // was default 10; Postgres max_connections=100, ~10 used -> safe headroom for burst
  connectionTimeoutMillis: 5000,                        // fail-fast if pool exhausted (don't hang the request)
  idleTimeoutMillis: 30000
});

// ==================== INIT TABLES ====================
async function initTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS aykoshop_settings (
    id SERIAL PRIMARY KEY, key VARCHAR(100) UNIQUE NOT NULL,
    value TEXT, updated_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`INSERT INTO aykoshop_settings (key,value) VALUES
    ('store_email','Aykosur@gmail.com'),
    ('store_name','AykoShop'),('store_phone','212632588578')
    ON CONFLICT (key) DO NOTHING`);
  if (process.env.ADMIN_PASSWORD) await pool.query("INSERT INTO aykoshop_settings (key,value) VALUES ('admin_password',$1) ON CONFLICT (key) DO NOTHING", [process.env.ADMIN_PASSWORD]);
  // Phase 0 Task 3 — Events Center table
  await pool.query(`CREATE TABLE IF NOT EXISTS aykoshop_events (
    id            SERIAL PRIMARY KEY,
    type          VARCHAR(50)  NOT NULL,
    title         TEXT,
    message       TEXT,
    subscriber_id VARCHAR(100),
    customer_name VARCHAR(200),
    channel       VARCHAR(50),
    intent        VARCHAR(50),
    stage         VARCHAR(50),
    manychat_link TEXT,
    ai_reply      TEXT,
    wa_phone      VARCHAR(50),
    created_at    TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_type       ON aykoshop_events(type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_created_at ON aykoshop_events(created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_subscriber ON aykoshop_events(subscriber_id)`);
  // Phase 0 Task 4 — Workflow Errors table
  await pool.query(`CREATE TABLE IF NOT EXISTS aykoshop_workflow_errors (
    id            SERIAL PRIMARY KEY,
    node_name     VARCHAR(100),
    subscriber_id VARCHAR(100),
    error_type    VARCHAR(100),
    error_message TEXT,
    resolved      BOOLEAN DEFAULT false,
    started_at    TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_errors_started ON aykoshop_workflow_errors(started_at DESC)`);
}

// ==================== KPI CARDS ====================
// Phase 1 Task 3 — Dashboard live KPI metrics
// Returns: customers_today, orders_today, payment_intents_today, revenue_today,
//          top_product, top_channel, conversion_rate
app.get('/api/kpi', async (req, res) => {
  try {
    const [
      customersToday,
      ordersToday,
      paymentsToday,
      revenueToday,
      topProduct,
      topChannel,
      conversionRate
    ] = await Promise.all([
      // Customers Today: new profiles seen in last 24h
      pool.query(`
        SELECT COUNT(DISTINCT subscriber_id) as count
        FROM aykoshop_profiles
        WHERE last_seen > NOW() - INTERVAL '24 hours'
      `),
      // Orders Today: new orders created in last 24h
      pool.query(`
        SELECT COUNT(*) as count
        FROM aykoshop_orders
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `),
      // Payment Intents Today: events with type='payment' in last 24h
      pool.query(`
        SELECT COUNT(*) as count
        FROM aykoshop_events
        WHERE type = 'payment'
          AND created_at > NOW() - INTERVAL '24 hours'
      `),
      // Revenue Today: sum of delivered orders price in last 24h
      pool.query(`
        SELECT COALESCE(SUM(
          CAST(REGEXP_REPLACE(COALESCE(price,'0'), '[^0-9.]', '', 'g') AS NUMERIC)
        ), 0) as total
        FROM aykoshop_orders
        WHERE paid_at IS NOT NULL AND status IN ('paid','delivered')
          AND created_at > NOW() - INTERVAL '24 hours'
      `),
      // Top Product: most requested category from warehouse last 7 days
      pool.query(`
        SELECT category as name, COUNT(*) as count
        FROM aykoshop_warehouse
        WHERE category IS NOT NULL AND category != '' AND category != 'general'
          AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY category
        ORDER BY count DESC
        LIMIT 1
      `),
      // Top Channel: highest volume channel in last 7 days
      pool.query(`
        SELECT channel, COUNT(*) as count
        FROM aykoshop_profiles
        WHERE last_seen > NOW() - INTERVAL '7 days'
          AND channel IS NOT NULL AND channel NOT LIKE '{{%}}'
        GROUP BY channel
        ORDER BY count DESC
        LIMIT 1
      `),
      // Conversion Rate: delivered orders / total profiles with interaction
      pool.query(`
        SELECT
          COUNT(DISTINCT o.subscriber_id) as converted,
          COUNT(DISTINCT p.subscriber_id) as total
        FROM aykoshop_profiles p
        LEFT JOIN aykoshop_orders o
          ON o.subscriber_id = p.subscriber_id AND o.paid_at IS NOT NULL AND o.status IN ('paid','delivered')
        WHERE p.stage IN ('hot','warm','payment','cold')
      `)
    ]);

    const total = parseInt(conversionRate.rows[0].total) || 1;
    const converted = parseInt(conversionRate.rows[0].converted) || 0;

    res.json({
      customers_today:       parseInt(customersToday.rows[0].count) || 0,
      orders_today:          parseInt(ordersToday.rows[0].count) || 0,
      payment_intents_today: parseInt(paymentsToday.rows[0].count) || 0,
      revenue_today:         parseFloat(revenueToday.rows[0].total) || 0,
      top_product:           topProduct.rows[0] || { name: '-', count: 0 },
      top_channel:           topChannel.rows[0] || { channel: '-', count: 0 },
      conversion_rate: {
        rate: Math.round((converted / total) * 100),
        converted,
        total
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// KPI history — last 7 days trend data for charts
app.get('/api/kpi/trend', async (req, res) => {
  try {
    const [daily_customers, daily_orders, daily_payments] = await Promise.all([
      pool.query(`
        SELECT DATE(last_seen) as date, COUNT(DISTINCT subscriber_id) as count
        FROM aykoshop_profiles
        WHERE last_seen > NOW() - INTERVAL '7 days'
        GROUP BY DATE(last_seen) ORDER BY date
      `),
      pool.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM aykoshop_orders
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at) ORDER BY date
      `),
      pool.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM aykoshop_events
        WHERE type='payment' AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at) ORDER BY date
      `)
    ]);
    res.json({
      daily_customers: daily_customers.rows,
      daily_orders:    daily_orders.rows,
      daily_payments:  daily_payments.rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== AUTH ====================
app.post('/api/auth/login', async (req, res) => {
  const _rlKey='auth_'+String(req.ip||'').replace('::ffff:','').slice(0,40);
  if(_checkRL(_rlKey,10,60000)) return res.status(429).json({error:'محاولات كثيرة. انتظر دقيقة.'});
  try {
    const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='admin_password'");
    const savedPass = r.rows[0]?.value || '';
    if (!savedPass || req.body.password !== savedPass) return res.status(401).json({error:'كلمة المرور غلط!'});
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({role:'admin'}, process.env.JWT_SECRET, {expiresIn:'365d'});
    res.json({token, expires_in:'7 days'});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/auth/verify', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ','');
    if (!token) return res.status(401).json({error:'No token'});
    const jwt = require('jsonwebtoken');
    jwt.verify(token, process.env.JWT_SECRET);
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
// Phase 1 Module 3 (2026-07-02): catalog routes use asyncHandler
app.get('/api/products', asyncHandler(async (req, res) => { const r = await pool.query("SELECT * FROM aykoshop_products ORDER BY created_at DESC"); res.json(r.rows); }));
app.post('/api/products/add', asyncHandler(async (req, res) => {
    _composeListing(req.body);
    const { product_name, price, description, image_url, whatsapp_url, instagram_url, category, status, min_price, account_link_type, key_features, delivery_time, product_type, game, recharge_type, recharge_amount, vip_recharge, product_code, evo_count, account_rank, account_platform, recharge_packages, code_type, price_usd, price_eur, key_benefits, max_discount, related_products, proof_images, stock, target_customer, selling_angle, objections, do_not_recommend, social_proof, guarantee_note, delivery_promise, risk_notes, facebook_url, product_url, cost_price, service_type, buyer_requirements, attributes } = req.body;
    const _pv = price? (parseInt(String(price).replace(/[^0-9]/g,''))||null) : null;
    const _vip = (typeof vip_recharge!=='undefined' && vip_recharge!==null && vip_recharge!=='') ? (vip_recharge===true||vip_recharge==='true'||vip_recharge==='Yes'||vip_recharge==='yes') : (!!recharge_amount && (parseInt(String(recharge_amount).replace(/[^0-9]/g,''))||0)>=5000);
    const _pv0=_validateProduct(req.body); if((status||'available')==='available' && !_pv0.ok){ try{ console.warn('[product-validation] BLOCK new active missing='+_pv0.missing.join(',')); }catch(_e){} return res.status(400).json({ok:false,error:'PRODUCT_INCOMPLETE',missing:_pv0.missing,score:_pv0.score,message:'⚠️ منتج ناقص للنشر — كمّل: '+_pv0.missing.join('، ')+'. تقدر تحفظو كـ Draft (مخفي).'}); }
        const _kw=(req.body.keywords&&String(req.body.keywords).trim())?String(req.body.keywords).trim():_genKeywords(req.body);
    const r = await pool.query("INSERT INTO aykoshop_products (product_name,price,price_value,description,image_url,whatsapp_url,instagram_url,category,status,min_price,account_link_type,key_features,delivery_time,product_type,game,recharge_type,recharge_amount,vip_recharge,product_code,evo_count,account_rank,account_platform,recharge_packages,code_type,price_usd,price_eur,keywords,key_benefits,max_discount,related_products,proof_images,stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,$25,$26,$27,$28,$29,$30,$31::jsonb,$32) RETURNING *",
      [product_name, price, _pv, description||'', image_url||'', whatsapp_url||'', instagram_url||'', category||'', status||'available', (min_price||null), (account_link_type||null), (key_features||null), (delivery_time||null), (product_type||null), (game||null), (recharge_type||null), (recharge_amount||null), _vip, (product_code||null), (evo_count||null), (account_rank||null), (account_platform||null), (recharge_packages?JSON.stringify(recharge_packages):null), (code_type||null), (price_usd||null), (price_eur||null), _kw, (key_benefits||null), ((max_discount===''||max_discount===undefined||max_discount===null)?null:(parseFloat(String(max_discount).replace(/[^0-9.]/g,''))||null)), (related_products||null), (proof_images?JSON.stringify(proof_images):null), ((stock===''||stock===undefined||stock===null)?null:(parseInt(String(stock).replace(/[^0-9]/g,''))||null))]);
    if(r&&r.rows&&r.rows[0]&&r.rows[0].id){ _embedProduct(r.rows[0].id); await pool.query("UPDATE aykoshop_products SET target_customer=COALESCE($2,target_customer),selling_angle=COALESCE($3,selling_angle),objections=COALESCE($4,objections),do_not_recommend=COALESCE($5,do_not_recommend),social_proof=COALESCE($6,social_proof),guarantee_note=COALESCE($7,guarantee_note),delivery_promise=COALESCE($8,delivery_promise),risk_notes=COALESCE($9,risk_notes),facebook_url=COALESCE($10,facebook_url),product_url=COALESCE($11,product_url),cost_price=COALESCE($12,cost_price),service_type=COALESCE($13,service_type),buyer_requirements=COALESCE($14::jsonb,buyer_requirements),attributes=COALESCE($15::jsonb,attributes) WHERE id=$1",[r.rows[0].id,(target_customer||null),(selling_angle||null),(objections||null),(do_not_recommend||null),(social_proof||null),(guarantee_note||null),(delivery_promise||null),(risk_notes||null),(facebook_url||null),(product_url||null),((cost_price===''||cost_price===undefined||cost_price===null)?null:(parseFloat(String(cost_price).replace(/[^0-9.]/g,''))||null)),(service_type||null),(buyer_requirements?JSON.stringify(buyer_requirements):null),(attributes?JSON.stringify(attributes):null)]).catch(function(){}); } res.json(r.rows[0]);
}));
// ===== PRODUCT VALIDATION LAYER — incomplete products can't go ACTIVE (Seller/Router/CatalogSearch need complete data) =====
// ===== AUTO KEYWORDS — make any product searchable/sellable even if keywords left blank (bilingual AR<->EN aliases) =====
function _composeListing(p){
  try{
    if(!p||typeof p!=='object') return p;
    var hv=function(v){ return v!==undefined&&v!==null&&String(v).trim()!==''; };
    var t=String(p.service_type||p.product_type||'').toLowerCase();
    var isAcct=/account|حساب/.test(t), isRech=/recharge|topup|شحن/.test(t), isCode=/code|كود/.test(t);
    var game=String(p.game||p.platform||'').trim();
    if(!hv(p.category)){ p.category = isAcct?('حسابات'+(game?(' '+game):'')) : isRech?('شحن'+(game?(' '+game):'')) : isCode?('أكواد'+(game?(' '+game):'')) : (game||t||''); }
    var facts=[];
    if(hv(p.account_rank)) facts.push('رتبة '+String(p.account_rank).trim());
    if(hv(p.evo_count)){ var e=String(p.evo_count).trim(); facts.push(/إيفو|evo/i.test(e)?e:(e+' إيفو')); }
    if(hv(p.account_platform)) facts.push(String(p.account_platform).trim());
    if(isCode && hv(p.code_type)) facts.push(String(p.code_type).trim());
    if(hv(p.key_features)){ var kf=String(p.key_features).trim(); var add=facts.filter(function(f){ return kf.indexOf(f)<0; }); p.key_features=(add.length?(add.join(' · ')+' · '):'')+kf; }
    else if(facts.length){ p.key_features=facts.join(' · '); }
    if(!hv(p.description)){
      var dd = isAcct?('حساب '+game+(hv(p.account_rank)?(' رتبة '+String(p.account_rank).trim()):'')+(hv(p.key_features)?('، '+String(p.key_features).slice(0,90)):'')) : isRech?('شحن '+game+' مباشر بالـID') : isCode?('كود '+(hv(p.code_type)?String(p.code_type).trim()+' ':'')+game) : String(p.product_name||'').trim();
      dd=String(dd).replace(/\s+/g,' ').trim(); if(dd) p.description=dd;
    }
    if(!hv(p.key_benefits) && isAcct) p.key_benefits='حساب جاهز تلعب بيه مباشرة بلا ما تبني من الصفر';
    if(!hv(p.delivery_time)) p.delivery_time = (isRech?'فوري 5-15 دقيقة':'5-15 دقيقة');
    if(!hv(p.stock) && isAcct) p.stock=1;
    return p;
  }catch(e){ return p; }
}
function _parseBulk(serviceType, game, paste){
  var st=String(serviceType||'').toLowerCase(); var lines=String(paste||'').split(/\r?\n/).map(function(l){return l.trim();}).filter(Boolean); var items=[];
  lines.forEach(function(line){
    var c=line.split('|').map(function(x){return x.trim();});
    if(/account/.test(st)){
      items.push({ service_type:'ready_account', product_type:'account', game:game||null, product_name:c[0]||'', price:c[1]||'', min_price:c[2]||null, account_rank:c[3]||null, evo_count:c[4]||null, account_platform:c[5]||null, account_link_type:c[6]||null, key_features:c[7]||null, status:'available' });
    } else if(/topup|recharge|game_topup/.test(st)){
      var pkgs=String(c[1]||'').split(',').map(function(s){return s.trim();}).filter(Boolean).map(function(seg){ var kv=seg.split('='); return {amount:(kv[0]||'').trim(), name:(kv[0]||'').trim(), price:(kv[1]||'').trim()}; }).filter(function(x){return x.amount&&x.price;});
      items.push({ service_type:'game_topup_id', product_type:'recharge', game:game||null, product_name:c[0]||'', recharge_packages:pkgs, status:'available' });
    } else if(/code/.test(st)){
      items.push({ service_type:'digital_code', product_type:'code', game:game||null, product_name:c[0]||'', code_type:c[1]||null, price:c[2]||'', stock:c[3]||null, status:'available' });
    }
  });
  return items;
}
app.post('/api/products/bulk', async (req,res)=>{
  try{
    var b=req.body||{};
    var items = Array.isArray(b.items)? b.items : _parseBulk(b.service_type, b.game, b.paste);
    if(!items.length) return res.status(400).json({ok:false,error:'no items parsed'});
    if(items.length>200) return res.status(400).json({ok:false,error:'max 200 per batch'});
    if(b.dry_run){ var prev=items.map(function(it){ var c=_composeListing(Object.assign({},it)); var v=_validateProduct(c); return {name:c.product_name||'', price:(c.price||(c.recharge_packages&&c.recharge_packages.length?('باقات: '+c.recharge_packages.length):'')), key_features:String(c.key_features||'').slice(0,90), category:c.category||'', valid:!!v.ok, missing:v.missing||[]}; }); return res.json({ok:true,dry_run:true,total:items.length,valid:prev.filter(function(x){return x.valid;}).length,items:prev}); }
    var results=[];
    for(var i=0;i<items.length;i++){
      var it=items[i];
      try{
        var r=await fetch('http://localhost:4000/api/products/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(it)});
        var j=await r.json().catch(function(){return {};});
        results.push({ name:it.product_name||'', ok:!!r.ok, id:(j&&j.id)||null, error:(r.ok?null:((j&&(j.error||j.message))||('HTTP '+r.status))) });
      }catch(e){ results.push({ name:it.product_name||'', ok:false, error:String(e.message||e).slice(0,120) }); }
    }
    var okN=results.filter(function(x){return x.ok;}).length;
    res.json({ ok:true, total:items.length, created:okN, failed:items.length-okN, results });
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
function _genKeywords(p){
  try{
    const AL={'free fire':'فري فاير freefire ff','فري فاير':'free fire ff','freefire':'فري فاير ff','account':'حساب كونط compte','حساب':'account compte','كونط':'account','recharge':'شحن جواهر دياموند topup','شحن':'recharge diamonds topup','جواهر':'diamonds recharge','code':'كود','كود':'code','skin':'سكن','سكن':'skin','weapon':'سلاح','سلاح':'weapon','emote':'رقصة dance','رقصة':'emote dance','dance':'رقصة emote','netflix':'نتفليكس','نتفليكس':'netflix','spotify':'سبوتيفاي','subscription':'اشتراك','اشتراك':'subscription','pubg':'ببجي','ببجي':'pubg','pes':'efootball بيس','bundle':'باقة'};
    const src=[p.product_name,p.game,p.platform,p.product_type,p.code_type,p.key_features].filter(Boolean).join(' ').toLowerCase();
    const clean=src.replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
    const set=new Set(); clean.split(' ').forEach(function(w){ if(w.length>=2) set.add(w); });
    Object.keys(AL).forEach(function(k){ if(clean.indexOf(k)>=0){ AL[k].split(' ').forEach(function(a){ set.add(a); }); } });
    return Array.from(set).join(' ').slice(0,400);
  }catch(e){ return String((p&&p.product_name)||''); }
}
app.post('/api/products/gen-keywords', asyncHandler((req,res)=>{ res.json({ keywords:_genKeywords(req.body||{}) }); }));
// ===== P3: AI Product DNA assistant (draft-only; prose-only; PRICE-FIREWALLED — never emits a price) =====
// ── Hermes DNA Engine — builds Product DNA from rules + DB (zero LLM). Called by draft-dna endpoint.
async function _hermesDNA(b){
  var pt=String(b.product_type||b.service_type||'').toLowerCase().trim();
  var game=String(b.game||b.platform||'').trim();
  var name=String(b.product_name||'').trim();
  var rank=String(b.account_rank||'').trim();
  var evo=String(b.evo_count||'').trim();
  var codeType=String(b.code_type||'').trim();
  var dt=String(b.delivery_time||'').trim();
  var isFF=/free.?fire|\bff\b/i.test(game);
  var isAcct=pt==='account'; var isRech=pt==='recharge'; var isCode=pt==='code'; var isSub=pt==='subscription';
  var gL=game||name;
  // 1. guarantee_note from aykoshop_policies
  var guarantee_note='';
  try{
    var _pol=await pool.query("SELECT key,value FROM aykoshop_policies WHERE key IN ('warranty_ff','warranty_social')");
    var _pols={}; _pol.rows.forEach(function(r){_pols[r.key]=r.value;});
    var _wFF=_pols.warranty_ff||'16 يوم'; var _wSoc=_pols.warranty_social||'10 أيام';
    if(isAcct&&isFF) guarantee_note='ضمان استبدال '+_wFF+' حسب سياسة المتجر';
    else if(isAcct) guarantee_note='ضمان استبدال '+_wSoc+' حسب سياسة المتجر';
    else if(isRech) guarantee_note='في حال خطأ من طرف المتجر — إعادة الشحن مضمونة';
    else if(isCode) guarantee_note='الكود مفحوص — في حال إشكال، استبدال أو تعويض حسب الحالة';
    else guarantee_note='حسب سياسة الضمان العامة للمتجر';
  }catch(e){ guarantee_note='حسب سياسة الضمان للمتجر'; }
  // 2. delivery_promise from delivery_time
  var delivery_promise='';
  if(dt) delivery_promise='التسليم غالباً خلال '+dt;
  else if(isRech) delivery_promise='شحن فوري عبر Player ID بعد التأكيد';
  else if(isAcct) delivery_promise='تسليم الحساب مباشرة بعد التأكيد والدفع';
  else if(isCode) delivery_promise='الكود يتسلم فور التأكيد';
  else if(isSub) delivery_promise='تفعيل الاشتراك خلال دقائق بعد الدفع';
  else delivery_promise='التسليم بعد تأكيد الدفع';
  // 3. key_features from product fields
  var featParts=[];
  if(rank) featParts.push('رتبة '+rank);
  if(evo) featParts.push(/إيفو|evo/i.test(evo)?evo:evo+' إيفو');
  if(codeType) featParts.push(codeType);
  if(b.key_features&&String(b.key_features).trim()){
    var _kf=String(b.key_features).trim();
    var _add=featParts.filter(function(f){return _kf.indexOf(f)<0;});
    featParts=_add.length?_add.concat([_kf]):[_kf];
  }
  var key_features=featParts.join(' · ');
  // 4. related_products from DB
  var related_products='';
  try{
    if(pt&&game){
      var _rp=await pool.query("SELECT product_name FROM aykoshop_products WHERE status='available' AND product_type=$1 AND (game ILIKE $2 OR product_name ILIKE $2) AND product_name!=$3 ORDER BY id DESC LIMIT 3",[pt,'%'+game+'%',name]);
      related_products=_rp.rows.map(function(r){return r.product_name;}).join(' · ');
    }
  }catch(e){}
  // 5. do_not_recommend rules
  var do_not_recommend='';
  if(isRech) do_not_recommend='ما ينصح به لمن ما عندوش Player ID صحيح ديال حسابو';
  else if(isAcct) do_not_recommend='ما ينصح به لمن ما يقدرش يحافظ على بيانات الاسترجاع (Recovery)';
  else if(isCode) do_not_recommend='ما ينصح به إذا اللعبة ما كتدعمش هاد النوع من الكود';
  else if(isSub) do_not_recommend='ما ينصح به لمن محتاج حساب شخصي حصري';
  // 6. Templates: selling_angle, target_customer, objections
  var selling_angle='',target_customer='',objections='';
  if(isAcct){
    if(isFF){
      target_customer='لاعبين Free Fire باغيين حساب جاهز'+(rank?' رتبة '+rank:'')+' بدون بناء من صفر';
      selling_angle='حساب Free Fire'+(rank?' '+rank:'')+' جاهز للعب مباشرة — بدون انتظار ولا تعب';
      objections='غالي عليا ← الحساب فيه'+(rank?' '+rank:'')+(evo?' · '+evo+' إيفو':'')+' — تبنيه كيكلفك أكثر | واش مضمون؟ ← ضمان '+(_pols&&_pols.warranty_ff||'16 يوم')+' استبدال حسب سياسة المتجر';
    } else {
      target_customer='لاعبين '+gL+' باغيين حساب جاهز'+(rank?' رتبة '+rank:'');
      selling_angle='حساب '+gL+(rank?' '+rank:'')+' جاهز مباشرة';
      objections='واش مضمون؟ ← ضمان استبدال حسب سياسة المتجر | ما وثقتش ← عندنا ضمان مكتوب وتاريخ مبيعات';
    }
  } else if(isRech){
    target_customer='لاعبين '+gL+' باغيين يشحنو بسرعة وأمان';
    selling_angle='شحن '+gL+' فوري عبر Player ID — أمان وضمان';
    objections='واش فوري؟ ← في الغالب من دقيقة لـ5 دقائق | واش آمن؟ ← نشحنو عبر Player ID من المزود الرسمي';
  } else if(isCode){
    var _ct=codeType||'الكود';
    target_customer='لاعبين '+gL+' باغيين '+_ct+' بثمن مناسب';
    selling_angle=_ct+' '+gL+' — مفحوص ومضمون';
    objections='واش الكود شغال؟ ← يتفحص قبل التسليم | شنو إيلا ما خدمش؟ ← استبدال فوري';
  } else if(isSub){
    target_customer='من باغي يستمتع بـ'+gL+' بسعر مناسب بدون اشتراك سنوي غالي';
    selling_angle='اشتراك '+gL+' رسمي وكامل — بأمان وضمان';
    objections='واش شرعي؟ ← اشتراك من مزود معتمد | واش يشتغل؟ ← نأكد التوافق قبل التسليم';
  } else {
    target_customer='من باغي '+(name||gL);
    selling_angle=(name||gL)+' — جودة وأمان';
    objections='واش مضمون؟ ← حسب سياسة الضمان للمتجر';
  }
  return { target_customer:target_customer, selling_angle:selling_angle, key_features:key_features, key_benefits:key_features, objections:objections, guarantee_note:guarantee_note, delivery_promise:delivery_promise, do_not_recommend:do_not_recommend, related_products:related_products };
}
app.post('/api/products/draft-dna', async (req,res)=>{
  try{
    const b=req.body||{}; const name=String(b.product_name||'').slice(0,140);
    if(!name) return res.status(400).json({ok:false,error:'product_name required'});
    const st=String(b.service_type||b.product_type||'').slice(0,40);
    const hermes=await _hermesDNA(b); const out=Object.assign({},hermes);
    let _useLLM=false; try{_useLLM=await _ff('llm_dna');}catch(e){}
    if(_useLLM){
      const st=String(b.service_type||b.product_type||'').slice(0,40);
      const ctx=[ 'الاسم: '+name, b.game?('اللعبة/المنصة: '+b.game):'', st?('النوع: '+st):'', b.category?('الفئة: '+b.category):'', hermes.key_features?('المميزات: '+String(hermes.key_features).slice(0,300)):'', b.description?('الوصف: '+String(b.description).slice(0,300)):'' ].filter(Boolean).join('\n');
      const sys='أنت خبير marketing لمنتجات رقمية وألعاب فمتجر مغربي. حسّن فقط: target_customer وselling_angle وobjections. أرجع JSON بهاد الحقول فقط (بالدارجة المغربية/العربية): {"target_customer":"","selling_angle":"","objections":""}. objections = 2-3 اعتراضات بصيغة "اعتراض ← الرد | ...". ممنوع تذكر ثمن أو سعر أو درهم.';
      const r=await _callClaude([{role:'system',content:sys},{role:'user',content:ctx}],{model:'claude-haiku-4-5',max_tokens:400,temperature:0.6,timeout:15000});
      if(r.ok){ var llm=_v2ParseJSON(String(r.text||'').replace(/[\r\n\t]+/g,' '))||{}; const _s=function(s){if(!s)return '';s=String(s);s=s.replace(/\b\d+[\d.,]*\s*(dh|dhs|mad|درهم|درهماً|euros?|dollars?|usd|eur|دولار|يورو)\b/gi,'');return s.replace(/\s{2,}/g,' ').trim();}; if(llm.selling_angle)out.selling_angle=_s(llm.selling_angle); if(llm.target_customer)out.target_customer=_s(llm.target_customer); if(llm.objections)out.objections=_s(llm.objections); }
    }
    res.json({ok:true, source:_useLLM?'hermes+llm':'hermes', target_customer:out.target_customer, selling_angle:out.selling_angle, key_features:out.key_features, key_benefits:out.key_benefits, objections:out.objections, guarantee_note:out.guarantee_note, delivery_promise:out.delivery_promise, do_not_recommend:out.do_not_recommend, related_products:out.related_products, note:'مولّد بـHermes'+(_useLLM?' + تحسين LLM':' (قواعد محلية)')+' — راجع وعدّل قبل الحفظ.'});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
// ===== P3: Preview — exactly what the AI ingests + a SAMPLE pitch (isolated; no DB/profile/ManyChat writes) =====
app.post('/api/products/preview-ai', async (req,res)=>{
  try{
    const p=req.body||{};
    const embed=_productEmbedText(p);
    var br=p.buyer_requirements; try{ if(typeof br==='string') br=JSON.parse(br); }catch(e){ br=[]; } if(!Array.isArray(br)) br=[];
    const collects=br.map(function(x){ return (x&&(x.label||x.field)||'')+((x&&x.required)?' (إجباري)':' (اختياري)'); }).filter(function(s){return s.trim().length>3;});
    var pitch='';
    const dnaCtx=[ 'المنتج: '+String(p.product_name||''), p.price?('الثمن المعطى: '+p.price):'', p.selling_angle?('زاوية البيع: '+p.selling_angle):'', p.key_benefits?('الفوائد: '+String(p.key_benefits).slice(0,250)):'', p.target_customer?('الزبون المستهدف: '+p.target_customer):'', p.guarantee_note?('الضمان: '+p.guarantee_note):'', p.delivery_promise?('التسليم: '+p.delivery_promise):'' ].filter(Boolean).join('\n');
    try{ const pr=await _callClaude([{role:'system',content:'أنت بائع AykoShop بالدارجة المغربية. اكتب جملة افتتاحية وحدة قصيرة (جملة ولا جوج) كتبيع هاد المنتج باستعمال المعطيات المعطاة فقط، بلا ما تخترع أي ثمن جديد (استعمل الثمن المعطى كيف ما هو إلا لزم الأمر). ودّية وبإيموجي خفيف.'},{role:'user',content:dnaCtx}],{model:'claude-sonnet-4-6',max_tokens:150,temperature:0.6,timeout:13000}); if(pr.ok) pitch=pr.text; }catch(e){}
    res.json({ ok:true, ai_sees:{ embed_text:embed, excluded:['cost_price','risk_notes'] }, will_collect:collects, sample_pitch:pitch||'(عمّر حقول DNA باش تشوف نموذج رد البيع)', sample_slot_question:(collects.length?('غادي نسولك على: '+collects.join('، ')):'') });
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
function _validateProduct(p){
  const has=function(v){ return v!==null && v!==undefined && String(v).trim()!==''; };
  var _pkA=p.recharge_packages; try{ if(typeof _pkA==='string') _pkA=JSON.parse(_pkA); }catch(e){ _pkA=null; } var _hasPkgA=Array.isArray(_pkA)&&_pkA.some(function(x){return x&&(x.amount!=null&&String(x.amount).trim()!==''||x.name!=null&&String(x.name).trim()!=='')&&x.price!=null&&String(x.price).trim()!=='';});
  const miss=[]; const soft=[]; let score=100; const pt=String(p.product_type||'').toLowerCase(); const st=String(p.service_type||'').toLowerCase(); const isSub=(pt==='subscription'||st==='subscription');
  if(!has(p.product_name)) miss.push('product_name');
  if(!has(p.price)&&!has(p.price_value)&&!_hasPkgA) miss.push('price');
  if(!pt) miss.push('product_type');
  if(!has(p.game)&&!has(p.platform)) miss.push(isSub?'platform':'game');
  if(pt==='code' && !has(p.code_type)) miss.push('code_type');
  if(pt==='account'){ if(!has(p.key_features)) miss.push('key_features'); if(!has(p.account_link_type)) miss.push('delivery_type'); }
  if(pt==='recharge'){ var pk=p.recharge_packages; try{ if(typeof pk==='string') pk=JSON.parse(pk); }catch(e){ pk=null; } if(!Array.isArray(pk)||!pk.some(function(x){return x&&has(x.amount)&&has(x.price);})) miss.push('recharge_packages'); }
  if(isSub){ if(!has(p.delivery_time)) miss.push('duration'); if(!has(p.account_link_type)) miss.push('delivery_type'); }
  if(pt==='account'){ if(!has(p.account_rank)){ soft.push('account_rank'); score-=6; } if(!has(p.evo_count)){ soft.push('evo_count'); score-=4; } }
  if(st){ var _pk2=p.recharge_packages; try{ if(typeof _pk2==='string') _pk2=JSON.parse(_pk2); }catch(e){ _pk2=null; } var _hasPkg=Array.isArray(_pk2)&&_pk2.some(function(x){return x&&has(x.amount||x.name)&&has(x.price);}); var _attr=p.attributes; try{ if(typeof _attr==='string') _attr=JSON.parse(_attr); }catch(e){ _attr=null; } _attr=_attr||{};
    if(st==='social_growth'){ if(!has(_attr.platform)) miss.push('platform'); if(!has(_attr.service)) miss.push('service'); if(!_hasPkg&&!has(p.price)) miss.push('packages'); }
    else if(st==='iptv'){ if(!_hasPkg&&!has(p.price)) miss.push('packages'); }
    else if(st==='game_topup_account'){ if(!_hasPkg&&!has(p.price)) miss.push('packages'); }
    else if(st==='custom_service'){ if(!_hasPkg&&!has(p.price)&&!has(p.description)) miss.push('price_or_packages'); }
  }
  var sw={keywords:15,description:8,image_url:10,price_usd:4,price_eur:4}; Object.keys(sw).forEach(function(f){ if(!has(p[f])){ soft.push(f); score-=sw[f]; } });
  var missD=miss.filter(function(x,i){return miss.indexOf(x)===i;});
  score-=missD.length*18; if(score<0)score=0; if(score>100)score=100;
  return { ok:missD.length===0, score:Math.round(score), missing:missD, soft:soft };
}
app.get('/api/products/validation-audit', asyncHandler(async (req,res)=>{ const r=await pool.query('SELECT * FROM aykoshop_products ORDER BY id'); const items=r.rows.map(function(p){ const v=_validateProduct(p); return {id:p.id,name:p.product_name,status:p.status,type:p.product_type,score:v.score,ok:v.ok,missing:v.missing,soft:v.soft}; }); const complete=items.filter(function(x){return x.ok;}).length; const activeBad=items.filter(function(x){return !x.ok && x.status==='available';}); res.json({ total:items.length, complete:complete, incomplete:items.length-complete, active_incomplete:activeBad.length, avg_score:Math.round(items.reduce(function(a,b){return a+b.score;},0)/(items.length||1)), products:items }); }));
app.put('/api/products/:id', asyncHandler(async (req, res) => {
    const { product_name, price, description, image_url, whatsapp_url, instagram_url, category, status, min_price, account_link_type, key_features, delivery_time, product_type, game, recharge_type, recharge_amount, vip_recharge, product_code, evo_count, account_rank, account_platform, recharge_packages, code_type, price_usd, price_eur, key_benefits, max_discount, related_products, proof_images, stock, target_customer, selling_angle, objections, do_not_recommend, social_proof, guarantee_note, delivery_promise, risk_notes, facebook_url, product_url, cost_price, service_type, buyer_requirements, attributes } = req.body;
    const _pv = price? (parseInt(String(price).replace(/[^0-9]/g,''))||null) : null;
    const _vip = (typeof vip_recharge==='undefined'||vip_recharge===null||vip_recharge==='') ? (recharge_amount?((parseInt(String(recharge_amount).replace(/[^0-9]/g,''))||0)>=5000):null) : (vip_recharge===true||vip_recharge==='true'||vip_recharge==='Yes'||vip_recharge==='yes');
    const _exr=await pool.query('SELECT * FROM aykoshop_products WHERE id=$1',[req.params.id]); const _ex=_exr.rows[0]||{}; const _merged=Object.assign({},_ex,req.body); const _finalStatus=(typeof status!=='undefined'&&status)?status:_ex.status; const _pv0=_validateProduct(_merged); if(_finalStatus==='available' && !_pv0.ok){ try{ console.warn('[product-validation] BLOCK update active id='+req.params.id+' missing='+_pv0.missing.join(',')); }catch(_e){} return res.status(400).json({ok:false,error:'PRODUCT_INCOMPLETE',missing:_pv0.missing,score:_pv0.score,message:'⚠️ منتج ناقص للنشر — كمّل: '+_pv0.missing.join('، ')+'. تقدر تحفظو كـ Draft (مخفي).'}); }
        const _kw=(req.body.keywords&&String(req.body.keywords).trim())?String(req.body.keywords).trim():((_ex&&_ex.keywords&&String(_ex.keywords).trim())?null:_genKeywords(_merged));
    const r = await pool.query("UPDATE aykoshop_products SET product_name=COALESCE($1,product_name), price=COALESCE($2,price), price_value=COALESCE($3,price_value), description=COALESCE($4,description), image_url=COALESCE($5,image_url), whatsapp_url=COALESCE($6,whatsapp_url), instagram_url=COALESCE($7,instagram_url), category=COALESCE($8,category), status=COALESCE($9,status), min_price=COALESCE($10,min_price), account_link_type=COALESCE($11,account_link_type), key_features=COALESCE($12,key_features), delivery_time=COALESCE($13,delivery_time), product_type=COALESCE($15,product_type), game=COALESCE($16,game), recharge_type=COALESCE($17,recharge_type), recharge_amount=COALESCE($18,recharge_amount), vip_recharge=COALESCE($19,vip_recharge), product_code=COALESCE($20,product_code), evo_count=COALESCE($21,evo_count), account_rank=COALESCE($22,account_rank), account_platform=COALESCE($23,account_platform), recharge_packages=COALESCE($24::jsonb,recharge_packages), code_type=COALESCE($25,code_type), price_usd=COALESCE($26,price_usd), price_eur=COALESCE($27,price_eur), keywords=COALESCE($28,keywords), key_benefits=COALESCE($29,key_benefits), max_discount=COALESCE($30,max_discount), related_products=COALESCE($31,related_products), proof_images=COALESCE($32::jsonb,proof_images), stock=COALESCE($33,stock), updated_at=NOW() WHERE id=$14 RETURNING *",
      [product_name, price, _pv, description, image_url, whatsapp_url, instagram_url, category, status, (min_price||null), (account_link_type||null), (key_features||null), (delivery_time||null), req.params.id, (product_type||null), (game||null), (recharge_type||null), (recharge_amount||null), _vip, (product_code||null), (evo_count||null), (account_rank||null), (account_platform||null), (recharge_packages?JSON.stringify(recharge_packages):null), (code_type||null), (price_usd||null), (price_eur||null), _kw, (key_benefits||null), ((max_discount===''||max_discount===undefined||max_discount===null)?null:(parseFloat(String(max_discount).replace(/[^0-9.]/g,''))||null)), (related_products||null), (proof_images?JSON.stringify(proof_images):null), ((stock===''||stock===undefined||stock===null)?null:(parseInt(String(stock).replace(/[^0-9]/g,''))||null))]);
    if(r&&r.rows&&r.rows[0]&&r.rows[0].id){ _embedProduct(r.rows[0].id); await pool.query("UPDATE aykoshop_products SET target_customer=COALESCE($2,target_customer),selling_angle=COALESCE($3,selling_angle),objections=COALESCE($4,objections),do_not_recommend=COALESCE($5,do_not_recommend),social_proof=COALESCE($6,social_proof),guarantee_note=COALESCE($7,guarantee_note),delivery_promise=COALESCE($8,delivery_promise),risk_notes=COALESCE($9,risk_notes),facebook_url=COALESCE($10,facebook_url),product_url=COALESCE($11,product_url),cost_price=COALESCE($12,cost_price),service_type=COALESCE($13,service_type),buyer_requirements=COALESCE($14::jsonb,buyer_requirements),attributes=COALESCE($15::jsonb,attributes) WHERE id=$1",[r.rows[0].id,(target_customer||null),(selling_angle||null),(objections||null),(do_not_recommend||null),(social_proof||null),(guarantee_note||null),(delivery_promise||null),(risk_notes||null),(facebook_url||null),(product_url||null),((cost_price===''||cost_price===undefined||cost_price===null)?null:(parseFloat(String(cost_price).replace(/[^0-9.]/g,''))||null)),(service_type||null),(buyer_requirements?JSON.stringify(buyer_requirements):null),(attributes?JSON.stringify(attributes):null)]).catch(function(){}); } res.json(r.rows[0]);
}));
app.delete('/api/products/:id', asyncHandler(async (req, res) => { await pool.query("DELETE FROM aykoshop_products WHERE id=$1", [req.params.id]); res.json({success:true}); }));
app.patch('/api/products/:id/status', asyncHandler(async (req, res) => { await pool.query("UPDATE aykoshop_products SET status=$1,updated_at=NOW() WHERE id=$2", [req.body.status, req.params.id]); res.json({success:true}); }));

// ==================== VECTOR EMBEDDING (pgvector) ====================
app.post('/api/products/embed', asyncHandler(async (req, res) => {
    const { id, embedding, embed_text } = req.body;
    if (!id || !embedding) return res.status(400).json({ error: 'id and embedding required' });
    await pool.query(
      "UPDATE aykoshop_products SET embedding=$1::vector, embed_text=$2, embedded_at=NOW() WHERE id=$3",
      [embedding, embed_text || '', id]
    );
    res.json({ success: true, id });
}));

app.post('/api/products/vector-search', asyncHandler(async (req, res) => {
    const { embedding, limit = 5 } = req.body;
    if (!embedding) return res.status(400).json({ error: 'embedding required' });
    const r = await pool.query(`
      SELECT id, product_name, category, description, price, image_url,
             whatsapp_url, instagram_url, stock, tags,
             1 - (embedding <=> $1::vector) AS similarity
      FROM aykoshop_products
      WHERE status = 'available' AND stock > 0 AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `, [embedding, Math.min(parseInt(limit) || 5, 10)]);
    res.json({ products: r.rows, count: r.rows.length });
}));

app.get('/api/products/embed-status', asyncHandler(async (req, res) => {
    const r = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(embedding) as embedded,
        COUNT(*) - COUNT(embedding) as pending,
        MAX(embedded_at) as last_embedded
      FROM aykoshop_products WHERE status='available'
    `);
    res.json(r.rows[0]);
}));

// ==================== TYPE POLICIES API ====================
// GET — returns all rows from aykoshop_product_type_policies
app.get('/api/type-policies', async (req,res)=>{
  try{
    const r=await pool.query('SELECT * FROM aykoshop_product_type_policies ORDER BY id');
    res.json({ok:true, policies:r.rows});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
// PUT — update one type policy by type_key
app.put('/api/type-policies/:key', async (req,res)=>{
  try{
    const k=req.params.key; const b=req.body||{};
    const _wDays=(b.warranty_days===''||b.warranty_days===null||b.warranty_days===undefined)?null:(parseInt(b.warranty_days)||null);
    const _refund=b.refund_allowed===true||String(b.refund_allowed).toLowerCase()==='true';
    const _verify=b.verify_before_delivered===true||String(b.verify_before_delivered).toLowerCase()==='true';
    const _jArr=function(v){ if(!v) return null; try{ return JSON.stringify(typeof v==='string'?JSON.parse(v):v); }catch(e){ return null; } };
    const r=await pool.query(
      `UPDATE aykoshop_product_type_policies SET
        display_name=COALESCE($2,display_name),
        warranty_days=$3,
        warranty_covers=COALESCE($4,warranty_covers),
        remedy=COALESCE($5,remedy),
        refund_allowed=$6,
        delivery_steps=COALESCE($7::jsonb,delivery_steps),
        predelivery_script=COALESCE($8,predelivery_script),
        delivery_message=COALESCE($9,delivery_message),
        buyer_requirements=COALESCE($10::jsonb,buyer_requirements),
        default_objections=COALESCE($11::jsonb,default_objections),
        verify_before_delivered=$12,
        forbidden_after_delivery=COALESCE($13::jsonb,forbidden_after_delivery),
        warranty_void_conditions=COALESCE($14::jsonb,warranty_void_conditions),
        notes=COALESCE($15,notes),
        updated_at=NOW(),
        policy_version=policy_version+1
      WHERE type_key=$1 RETURNING *`,
      [k, b.display_name||null, _wDays, b.warranty_covers||null, b.remedy||null, _refund,
       _jArr(b.delivery_steps), b.predelivery_script||null, b.delivery_message||null,
       _jArr(b.buyer_requirements), _jArr(b.default_objections), _verify,
       _jArr(b.forbidden_after_delivery), _jArr(b.warranty_void_conditions), b.notes||null]
    );
    if(!r.rows.length) return res.status(404).json({ok:false,error:'type_key not found: '+k});
    _tpCache={t:0,v:[]}; // invalidate cache on write
    res.json({ok:true, policy:r.rows[0]});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
// ==================== CUSTOMERS ====================
app.get('/api/customers', asyncHandler(async (req, res) => {
    const r = await pool.query(`
      SELECT
        p.*,
        h.message AS last_message,
        h.created_at AS last_message_at,
        ROUND(EXTRACT(EPOCH FROM (NOW() - p.last_seen)) / 3600, 1) AS hours_since_last,
        sc.subscriber_id IS NOT NULL AS ai_stopped,
        (lr.role = 'user') AS waiting,
        lr.created_at AS last_any_at,
        (p.session_data->>'inbox_closed_at') AS inbox_closed_at,
        ((p.session_data->>'inbox_closed_at') IS NOT NULL AND (p.session_data->>'inbox_closed_at')::timestamptz >= COALESCE(h.created_at, to_timestamp(0))) AS inbox_closed,
        (SELECT count(*) FROM aykoshop_chat_history c WHERE c.subscriber_id = p.subscriber_id AND c.role = 'user' AND c.created_at > GREATEST(COALESCE((SELECT max(c2.created_at) FROM aykoshop_chat_history c2 WHERE c2.subscriber_id = p.subscriber_id AND c2.role <> 'user'), to_timestamp(0)),COALESCE(NULLIF(p.session_data->>'inbox_last_read_at','')::timestamptz, to_timestamp(0))))::int AS needs_reply_count,
        COALESCE(rq.status, 'none') AS rescue_status,
        rq.priority_score AS rescue_score
      FROM aykoshop_profiles p
      LEFT JOIN LATERAL (
        SELECT message, created_at FROM aykoshop_chat_history
        WHERE subscriber_id = p.subscriber_id AND role = 'user'
        ORDER BY created_at DESC LIMIT 1
      ) h ON true
      LEFT JOIN LATERAL (
        SELECT role, created_at FROM aykoshop_chat_history
        WHERE subscriber_id = p.subscriber_id
        ORDER BY created_at DESC LIMIT 1
      ) lr ON true
      LEFT JOIN aykoshop_stopped_chats sc ON sc.subscriber_id = p.subscriber_id
      LEFT JOIN aykoshop_rescue_queue rq
        ON rq.subscriber_id = p.subscriber_id AND rq.status = 'pending'
      ORDER BY p.last_seen DESC LIMIT 500
    `);
    res.json(r.rows);
}));

// Take Over — stop AI for a specific subscriber (adds to stopped_chats)
app.post('/api/customers/:id/takeover', async (req, res) => {
  try {
    const sid = req.params.id;
    const { customer_name, channel, wa_phone, manychat_link, last_message } = req.body || {};
    await pool.query(
      `INSERT INTO aykoshop_stopped_chats (subscriber_id, reason, stopped_at)
       VALUES ($1, 'manual_takeover', NOW())
       ON CONFLICT (subscriber_id) DO UPDATE SET reason='manual_takeover', stopped_at=NOW()`,
      [sid]
    );
    // Create HUMAN_REQUESTED intervention so Dashboard shows WHY AI stopped
    if (!isTestSubscriber(sid)) {
      await pool.query(
        `INSERT INTO aykoshop_interventions
           (subscriber_id, customer_name, channel, wa_phone, manychat_link,
            reason_code, reason_detail, customer_message, priority, status, created_at)
         VALUES ($1,$2,$3,$4,$5,'HUMAN_REQUESTED','Operator manually stopped AI via Dashboard',
                 $6,'medium','pending',NOW())`,
        [sid, customer_name||null, channel||null, wa_phone||null, manychat_link||null, last_message||null]
      ).catch(() => {});
    }
    _broadcast('human_takeover', { subscriber_id: sid, customer_name: customer_name||null, channel: channel||null });
    res.json({ success: true, stopped: true, subscriber_id: sid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Resume AI — remove from stopped_chats
app.delete('/api/customers/:id/takeover', async (req, res) => {
  try {
    const _id=req.params.id;
    let _rsn=null, _stoppedAt=null;
    try{ const _rr=await pool.query("SELECT reason, stopped_at FROM aykoshop_stopped_chats WHERE subscriber_id=$1 LIMIT 1",[_id]); _rsn=(_rr.rows[0]||{}).reason||null; _stoppedAt=(_rr.rows[0]||{}).stopped_at||null; }catch(_e){}
    await pool.query("DELETE FROM aykoshop_stopped_chats WHERE subscriber_id=$1", [_id]);
    // Resume AI: reset token-lock counter; if stop was a fulfillment (payment/recharge), mark completed so next greeting is fresh
    if(/payment_verification|human_recharge|emergency/.test(String(_rsn))){ await pool.query("UPDATE aykoshop_profiles SET attempts=0, convo_state='completed', service_type=NULL, budget=NULL, payment_method=NULL WHERE subscriber_id=$1",[_id]).catch(()=>{}); }
    else { await pool.query("UPDATE aykoshop_profiles SET attempts=0, convo_state=NULL, clarify_count=0 WHERE subscriber_id=$1",[_id]).catch(()=>{}); }
    res.json({ success: true, resumed: true, subscriber_id: _id });
    // Resume Summary Engine: fire-and-forget after response — no latency added
    if(_stoppedAt && !/payment_verification|human_recharge|emergency/.test(String(_rsn))){
      _buildHandoffSummary(_id, _stoppedAt).then(function(sum){ if(sum){ pool.query("UPDATE aykoshop_profiles SET session_data=jsonb_set(COALESCE(session_data,'{}'::jsonb),'{handoff_summary}',to_jsonb($2::text)) WHERE subscriber_id=$1",[_id,sum]).catch(function(){}); } }).catch(function(){});
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Check if AI is stopped for a subscriber
app.get('/api/customers/:id/ai-status', asyncHandler(async (req, res) => {
    const r = await pool.query("SELECT stopped_at FROM aykoshop_stopped_chats WHERE subscriber_id=$1", [req.params.id]);
    res.json({ ai_stopped: r.rows.length > 0, stopped_since: r.rows[0]?.stopped_at || null });
}));

// [DIAG read-only] ManyChat subscriber getInfo — channel + last_interaction (audit WhatsApp vs Messenger send window). Remove after diagnosis.
app.get('/api/_diag/mcinfo/:id', async (req,res)=>{ try{ const r=await mcGetInfo(req.params.id, 8000); const j=await r.json().catch(()=>({})); res.json(j); }catch(e){ res.status(500).json({error:e.message}); } });
// [DIAG read-only] which ManyChat API key the backend is actually using (source + masked) + the page it belongs to. Confirms key change took effect.
app.get('/api/_diag/mckey', async (req,res)=>{ try{
  var src='NONE'; try{ if(_aiSecrets && _aiSecrets['manychat_api'] && String(_aiSecrets['manychat_api']).trim()) src='key-manager(_aiSecrets)'; else if(process.env.MANYCHAT_API_KEY) src='env(MANYCHAT_API_KEY)'; }catch(_e){ src='err'; }
  var k=_mcKey()||''; var masked = k ? (k.slice(0,5)+'…'+k.slice(-5)+' (len '+k.length+')') : 'EMPTY';
  var page=null; try{ const r=await mcPageInfo(8000); page=await r.json().catch(()=>({})); }catch(e){ page={error:e.message}; }
  res.json({ key_source:src, key_masked:masked, page });
}catch(e){ res.status(500).json({error:e.message}); } });
// [DIAG TEMP] flow-delivery test — HARDCODED to ONLY the authorized test sub 366643236. Runs the AI's WhatsApp mechanism (operator_reply custom field + sendFlow) to prove whether the flow actually DELIVERS out-of-window. Remove after the test.
app.get('/api/_diag/flowsend', async (req, res) => {
  try {
    const sid = '366643236';
    const msg = String(req.query.msg || 'AYKO flow delivery test');
    const MC = 'Bearer ' + (_mcKey()||'');
    const r1 = await fetch('https://api.manychat.com/fb/subscriber/setCustomFieldByName', { method:'POST', headers:{'Authorization':MC,'Content-Type':'application/json'}, body: JSON.stringify({ subscriber_id: sid, field_name:'operator_reply', field_value: msg }) });
    let j1={}; try{ j1=await r1.json(); }catch(_e){}
    const r2 = await fetch('https://api.manychat.com/fb/sending/sendFlow', { method:'POST', headers:{'Authorization':MC,'Content-Type':'application/json'}, body: JSON.stringify({ subscriber_id: sid, flow_ns: (process.env.MC_OPERATOR_FLOW_NS || 'content20260624210306_487835') }) });
    let j2={}; try{ j2=await r2.json(); }catch(_e){}
    res.json({ sub: sid, msg, setField:{ http:r1.status, mc:j1 }, sendFlow:{ http:r2.status, mc:j2 } });
  } catch(e){ res.status(500).json({ error: e.message }); }
});
// Send Message directly to customer via ManyChat
app.post('/api/customers/:id/message', async (req, res) => {
  try {
    const { message, channel, media } = req.body;
    const _hasMedia = media && typeof media.url === 'string' && media.url.indexOf('http') === 0;
    if (!message && !_hasMedia) return res.status(400).json({ error: 'message or media required' });
    const MC_KEY = 'Bearer ' + (_mcKey()||'');
    // ManyChat uses /fb/sending/sendContent for ALL channels (WhatsApp/Instagram/Messenger)
    const endpoint = 'https://api.manychat.com/fb/sending/sendContent';
    const _msgs = [];
    if (_hasMedia) { const _mt = (media.type || media.kind || 'image'); _msgs.push({ type: (_mt === 'video' ? 'video' : (_mt === 'file' || _mt === 'document' ? 'file' : 'image')), url: media.url }); }
    if (message) _msgs.push({ type: 'text', text: message });
    const _send = async (tag) => {
      const _b = { subscriber_id: req.params.id, data: { version: 'v2', content: { messages: _msgs } } };
      if (tag) _b.message_tag = tag;
      const _r = await fetch(endpoint, { method: 'POST', headers: { 'Authorization': MC_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(_b) });
      let _j = {}; try { _j = await _r.json(); } catch(_e){}
      return { ok: (_r.ok && _j.status === 'success'), http: _r.status, j: _j };
    };
    // free-form sendContent (works INSIDE the 24h window for Messenger/IG; ManyChat's WhatsApp API rejects out-of-window free-form with 3011 → handler returns an honest 400 below, baseline behavior)
    let _a = await _send(null);
    // FALLBACK for WhatsApp + Instagram via SEPARATE single-block flows. ManyChat sends EVERY block in a flow AND ignores setCustomFieldByName with an empty value (proven 2026-06-25: operator_media never clears) — so one flow per content-type is the only clean way. Channel via getInfo (optin_whatsapp / ig_id); type from the operator's selection (text/image/video). Route to the matching single-block flow and set ONLY the needed field (text→operator_reply, media→operator_media). No clearing (ManyChat ignores empty). text+caption media → media flow THEN text flow (two messages).
    if (!_a.ok && _a.j && _a.j.code === 3011 && (message || _hasMedia)) {
      let _gd = {};
      try { const _gi = await fetch('https://api.manychat.com/fb/subscriber/getInfo?subscriber_id='+encodeURIComponent(req.params.id), { headers:{'Authorization':MC_KEY} }); const _gj = await _gi.json().catch(()=>({})); _gd = (_gj && _gj.data) || {}; } catch(_e){}
      const _ch = _gd.optin_whatsapp ? 'wa' : (_gd.ig_id ? 'ig' : null);
      const _F = { wa:{ text:(process.env.MC_WA_TEXT_FLOW||'content20260624210306_487835'), image:(process.env.MC_WA_IMAGE_FLOW||'content20260625121650_720489'), video:(process.env.MC_WA_VIDEO_FLOW||'content20260625121650_720489') }, ig:{ text:(process.env.MC_IG_TEXT_FLOW||'content20260625132519_223776'), image:(process.env.MC_IG_IMAGE_FLOW||'content20260625033737_022437'), video:(process.env.MC_IG_VIDEO_FLOW||'content20260625033737_022437') } };
      if (_ch) try {
        let _curReply=null, _curMedia=null;
        const _sf = async (n,v) => { if(n==='operator_reply')_curReply=v; if(n==='operator_media')_curMedia=v; try{ await fetch('https://api.manychat.com/fb/subscriber/setCustomFieldByName', { method:'POST', headers:{'Authorization':MC_KEY,'Content-Type':'application/json'}, body: JSON.stringify({ subscriber_id: req.params.id, field_name:n, field_value:v }) }); }catch(_e){} };
        const _sendFlow = async (ns,why) => { try{ console.log('[MS-FLOW]', JSON.stringify({ sub:req.params.id, ch:_ch, why:why, flow:ns, set_operator_reply:_curReply, set_operator_media:_curMedia })); }catch(_e){} const _r = await fetch('https://api.manychat.com/fb/sending/sendFlow', { method:'POST', headers:{'Authorization':MC_KEY,'Content-Type':'application/json'}, body: JSON.stringify({ subscriber_id: req.params.id, flow_ns: ns }) }); let _j={}; try{ _j=await _r.json(); }catch(_e){} return { ok:(_r.ok && _j.status==='success'), http:_r.status, j:_j, ns:ns }; };
        const _mt = (_hasMedia && ((media.type||media.kind)==='video')) ? 'video' : 'image';
        let _r1;
        if (_hasMedia) {
          await _sf('operator_media', media.url);
          _r1 = await _sendFlow(_F[_ch][_mt], 'media:'+_mt);
          if (message) { await _sf('operator_reply', String(message)); await _sendFlow(_F[_ch].text, 'caption'); }
        } else {
          await _sf('operator_reply', String(message));
          _r1 = await _sendFlow(_F[_ch].text, 'text');
        }
        if (_r1 && _r1.ok) _a = { ok:true, http:200, j:{ status:'success', via:'flow' } };
        try{ console.log('[MANUAL-SEND-FLOW]', JSON.stringify({ sub:req.params.id, ch:_ch, type:(_hasMedia?_mt:'text'), flow:(_r1&&_r1.ns), http:(_r1&&_r1.http), mc:(_r1&&_r1.j) }).slice(0,600)); }catch(_e){}
      } catch(_e){ try{ console.log('[MANUAL-SEND-FLOW] err', _e.message); }catch(__e){} }
    }
    const result = _a.j;
    try{ console.log('[MANUAL-SEND]', JSON.stringify({sub:req.params.id, channel:channel||null, types:_msgs.map(function(m){return m.type;}), http:_a.http, ok:_a.ok, mc:result}).slice(0,1000)); }catch(_e){}
    if (_a.ok) {
      try {
        if (_hasMedia) await pool.query("INSERT INTO aykoshop_chat_history (subscriber_id,role,message,created_at) VALUES ($1,'operator',$2,NOW())", [req.params.id, media.url]);
        if (message) await pool.query("INSERT INTO aykoshop_chat_history (subscriber_id,role,message,created_at) VALUES ($1,'operator',$2,NOW())", [req.params.id, message]);
      } catch(_e){}
      res.json({ success: true, delivered: true });
    } else {
      res.status(400).json({ success: false, error: result.message || 'ManyChat rejected', detail: result });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== RESCUE QUEUE ====================
// Priority score computation
function computeRescueScore({ urgency, minutes_in_queue, amount, channel, buyer_messages }) {
  const base = urgency === 'critical' ? 80 : urgency === 'high' ? 55 : 35;
  const timeBonus = minutes_in_queue < 30 ? 20 : minutes_in_queue < 120 ? 15
    : minutes_in_queue < 360 ? 10 : minutes_in_queue < 1440 ? 5 : 0;
  const amountBonus = (amount || 0) > 500 ? 10 : (amount || 0) > 200 ? 5 : (amount || 0) > 0 ? 2 : 0;
  const channelBonus = channel === 'whatsapp' ? 3 : channel === 'instagram' ? 1 : 0;
  const depthBonus = (buyer_messages || 0) >= 6 ? 10 : (buyer_messages || 0) >= 4 ? 5 : (buyer_messages || 0) >= 3 ? 2 : 0;
  return Math.min(base + timeBonus + amountBonus + channelBonus + depthBonus, 110);
}

app.get('/api/rescue-queue', async (req, res) => {
  try {
    const { status = 'pending', limit = 50 } = req.query;
    const r = await pool.query(
      `SELECT rq.*, p.session_data
       FROM aykoshop_rescue_queue rq
       LEFT JOIN aykoshop_profiles p ON p.subscriber_id = rq.subscriber_id
       WHERE rq.status = $1
       ORDER BY rq.priority_score DESC, rq.entered_queue_at ASC
       LIMIT $2`,
      [status, Math.min(parseInt(limit)||50, 100)]
    );
    const [pending, critical] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM aykoshop_rescue_queue WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM aykoshop_rescue_queue WHERE status='pending' AND urgency='critical'")
    ]);
    res.json({
      queue: r.rows,
      total_pending:  parseInt(pending.rows[0].count),
      total_critical: parseInt(critical.rows[0].count)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rescue-queue', async (req, res) => {
  try {
    const { subscriber_id, customer_name, channel, trigger_type, trigger_message,
            ai_last_reply, product_name, amount, urgency = 'high',
            last_message_at, manychat_link, wa_phone, meta = {} } = req.body;
    if (!subscriber_id || !trigger_type) return res.status(400).json({ error: 'subscriber_id and trigger_type required' });
    // Duplicate prevention
    const existing = await pool.query(
      "SELECT id FROM aykoshop_rescue_queue WHERE subscriber_id=$1 AND trigger_type=$2 AND status='pending'",
      [subscriber_id, trigger_type]
    );
    if (existing.rows.length) return res.json({ id: existing.rows[0].id, duplicate: true });
    const mins_in_queue = 0;
    const score = computeRescueScore({ urgency, minutes_in_queue: mins_in_queue, amount, channel });
    const r = await pool.query(
      `INSERT INTO aykoshop_rescue_queue
         (subscriber_id, customer_name, channel, wa_phone, manychat_link,
          trigger_type, trigger_message, ai_last_reply, product_name, amount,
          urgency, priority_score, last_message_at, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, priority_score`,
      [subscriber_id, customer_name||null, channel||null, wa_phone||null, manychat_link||null,
       trigger_type, trigger_message||null, ai_last_reply||null, product_name||null, amount||null,
       urgency, score, last_message_at||null, JSON.stringify(meta)]
    );
    res.json({ id: r.rows[0].id, priority_score: r.rows[0].priority_score, created: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/rescue-queue/:id/resolve', async (req, res) => {
  try {
    await pool.query(
      "UPDATE aykoshop_rescue_queue SET status='resolved', resolved_at=NOW(), notes=$1 WHERE id=$2",
      [req.body.notes||null, req.params.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/rescue-queue/:id/dismiss', async (req, res) => {
  try {
    await pool.query(
      "UPDATE aykoshop_rescue_queue SET status='dismissed', dismissed=true, resolved_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Auto-populate Rescue Queue from existing data (buyer intent signals)
app.post('/api/rescue-queue/auto-scan', async (req, res) => {
  try {
    // Find customers with ≥3 buyer messages in last 48h, no order
    const candidates = await pool.query(`
      SELECT h.subscriber_id, p.customer_name, p.channel, p.wa_phone,
             COUNT(*) as buyer_msgs,
             MAX(h.created_at) as last_msg,
             MIN(h.message) as sample_msg,
             ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(h.created_at)))/60) as mins_ago
      FROM aykoshop_chat_history h
      JOIN aykoshop_profiles p ON p.subscriber_id = h.subscriber_id
      LEFT JOIN aykoshop_orders o ON o.subscriber_id = h.subscriber_id
      WHERE h.role = 'user'
        AND h.created_at > NOW() - INTERVAL '48 hours'
        AND h.subscriber_id ~ '^[0-9]+$'
        AND o.id IS NULL
        AND (h.message ILIKE '%بغيت%' OR h.message ILIKE '%بغيتي%'
          OR h.message ILIKE '%كنبغي%' OR h.message ILIKE '%نشري%'
          OR h.message ILIKE '%باغي%')
      GROUP BY h.subscriber_id, p.customer_name, p.channel, p.wa_phone
      HAVING COUNT(*) >= 3
    `);
    let added = 0, skipped = 0;
    for (const c of candidates.rows) {
      const minsAgo = parseInt(c.mins_ago);
      if (minsAgo > 1440) { skipped++; continue; } // skip > 24h
      const urgency = c.buyer_msgs >= 5 ? 'high' : 'medium';
      const score = computeRescueScore({
        urgency, minutes_in_queue: 0,
        channel: c.channel, buyer_messages: parseInt(c.buyer_msgs)
      });
      const existing = await pool.query(
        "SELECT id FROM aykoshop_rescue_queue WHERE subscriber_id=$1 AND trigger_type='buyer_no_conversion' AND status='pending'",
        [c.subscriber_id]
      );
      if (existing.rows.length) { skipped++; continue; }
      const link = `https://app.manychat.com/fb4538388/chat/${c.subscriber_id}`;
      await pool.query(
        `INSERT INTO aykoshop_rescue_queue
           (subscriber_id, customer_name, channel, wa_phone, manychat_link,
            trigger_type, trigger_message, urgency, priority_score, last_message_at)
         VALUES ($1,$2,$3,$4,$5,'buyer_no_conversion',$6,$7,$8,$9)`,
        [c.subscriber_id, c.customer_name, c.channel, c.wa_phone, link,
         c.sample_msg, urgency, score, c.last_msg]
      );
      added++;
    }
    res.json({ scanned: candidates.rows.length, added, skipped });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/customers/:id/history', asyncHandler(async (req, res) => { const r = await pool.query("SELECT * FROM aykoshop_chat_history WHERE subscriber_id=$1 ORDER BY created_at ASC LIMIT 200", [req.params.id]); res.json(r.rows); }));
app.get('/api/customers/:id/timeline', asyncHandler(async (req, res) => {
    const sid = req.params.id;
    const [history, orders, events] = await Promise.all([
      pool.query("SELECT role,message,created_at FROM aykoshop_chat_history WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 100", [sid]),
      pool.query("SELECT id,product_name,price,status,created_at,paid_at,delivered_at FROM aykoshop_orders WHERE subscriber_id=$1 ORDER BY created_at DESC", [sid]),
      pool.query("SELECT type,title,message,created_at FROM aykoshop_events WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 50", [sid])
    ]);
    const events_out = [
      ...history.rows.map(h => ({ type:'message', role:h.role, content:h.message, date:h.created_at })),
      ...orders.rows.map(o => ({ type:'order', status:o.status, product:o.product_name, price:o.price, date:o.created_at })),
      ...events.rows.map(e => ({ type:e.type, content:e.message, date:e.created_at }))
    ].sort((a,b) => new Date(b.date) - new Date(a.date));
    res.json({ events: events_out });
}));

// ==================== ORDERS ====================
app.get('/api/orders', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_orders ORDER BY created_at DESC LIMIT 500"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/orders', async (req, res) => {
  try {
    const { subscriber_id, customer_name, channel, product_name, product_id, price, status } = req.body;
    const r = await pool.query(
      "INSERT INTO aykoshop_orders (subscriber_id,customer_name,channel,product_name,product_id,price,status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [subscriber_id||'', customer_name||'', channel||'whatsapp',
       product_name||req.body.product||'', product_id||null,
       price||'', status||'new']
    );
    _broadcast('order_created', { order: r.rows[0], subscriber_id: r.rows[0] && r.rows[0].subscriber_id, customer_name: r.rows[0] && r.rows[0].customer_name });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({error: e.message}); }
});
// PUT /api/orders/:id — general update (column names fixed)
app.put('/api/orders/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE aykoshop_orders SET
        customer_name = COALESCE($1, customer_name),
        product_name  = COALESCE($2, product_name),
        price         = COALESCE($3, price),
        status        = COALESCE($4, status),
        channel       = COALESCE($5, channel)
       WHERE id = $6 RETURNING *`,
      [req.body.customer_name||null, req.body.product_name||null,
       req.body.price||null, req.body.status||null, req.body.channel||null,
       req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'order not found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/orders/:id/confirm-payment — operator confirms payment received
app.patch('/api/orders/:id/confirm-payment', async (req, res) => {
  try {
    const { price, payment_method } = req.body;
    const r = await pool.query(
      `UPDATE aykoshop_orders
       SET status = 'paid',
           paid_at = NOW(),
           price   = COALESCE($1, price)
       WHERE id = $2 RETURNING *`,
      [price || null, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'order not found' });
    // Broadcast revenue event via SSE
    _broadcast('order_paid', {
      order: r.rows[0],
      ts: new Date().toISOString()
    });
    try{ const _o=r.rows[0]; await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:_o.subscriber_id,customer_name:_o.customer_name,channel:_o.channel,reason_code:'DELIVERY_REQUIRED',reason_detail:'دفع مؤكّد — التسليم مطلوب (بشري فقط)',product_name:_o.product_name})}); }catch(_e){}
    res.json({ success: true, order: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/orders/:id/deliver — operator marks product delivered
app.patch('/api/orders/:id/deliver', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE aykoshop_orders
       SET status = 'delivered',
           delivered_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'order not found' });
    _broadcast('order_delivered', { order: r.rows[0], ts: new Date().toISOString() });
    res.json({ success: true, order: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/orders/:id', async (req, res) => {
  try { await pool.query("DELETE FROM aykoshop_orders WHERE id=$1", [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== TRAINING & CONVERSATIONS ====================
app.get('/api/training', async (req, res) => {
  try { const r = await pool.query("SELECT * FROM aykoshop_training ORDER BY created_at DESC LIMIT 200"); res.json(r.rows); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/training', async (req, res) => {
  try { const r = await pool.query("INSERT INTO aykoshop_training (customer_message,correct_answer,category) VALUES ($1,$2,$3) RETURNING *", [req.body.question||req.body.customer_message, req.body.correct_answer, req.body.category||'general']); res.json(r.rows[0]); } catch(e) { res.status(500).json({error: e.message}); }
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

// ==================== OPERATIONS CENTER ====================

// Module 1 — Recent Errors (default: real errors only, hide test noise)
app.get('/api/ops/errors', asyncHandler(async (req, res) => {
    const { resolved, limit = 50, node, show_test = 'false' } = req.query;
    let conditions = [], params = [], idx = 1;
    // By default exclude test errors — pass ?show_test=true to include them
    if (show_test !== 'true') {
      conditions.push(`is_test=false`);
    }
    if (resolved !== undefined) {
      conditions.push(`resolved=$${idx}`); params.push(resolved === 'true'); idx++;
    }
    if (node) { conditions.push(`node_name=$${idx}`); params.push(node); idx++; }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim = Math.min(parseInt(limit) || 50, 200);
    const r = await pool.query(
      `SELECT * FROM aykoshop_workflow_errors ${where} ORDER BY started_at DESC LIMIT ${lim}`,
      params
    );
    res.json({ errors: r.rows, total: r.rows.length });
}));

// Deduplicated incidents view: same subscriber + same error type + 15-min window = 1 incident
app.get('/api/ops/errors/incidents', asyncHandler(async (req, res) => {
    const { hours = 24 } = req.query;
    const r = await pool.query(`
      SELECT
        MIN(id)          as id,
        node_name,
        subscriber_id,
        error_type,
        MIN(error_message) as error_message,
        severity,
        is_test,
        COUNT(*)         as raw_count,
        MIN(started_at)  as first_seen,
        MAX(started_at)  as last_seen,
        BOOL_OR(resolved) as resolved,
        DATE_TRUNC('hour', started_at)
          + (FLOOR(EXTRACT(MINUTE FROM started_at) / 15) * INTERVAL '15 minutes') as window_start
      FROM aykoshop_workflow_errors
      WHERE started_at > NOW() - INTERVAL '${parseInt(hours)} hours'
        AND is_test = false
      GROUP BY node_name, subscriber_id, error_type, severity, is_test,
        DATE_TRUNC('hour', started_at)
          + (FLOOR(EXTRACT(MINUTE FROM started_at) / 15) * INTERVAL '15 minutes')
      ORDER BY first_seen DESC
    `);
    res.json({ incidents: r.rows, total_incidents: r.rows.length });
}));

app.get('/api/ops/errors/summary', asyncHandler(async (req, res) => {
    const [byType, byNode, trend, realUnresolved, testTotal, realTotal] = await Promise.all([
      pool.query(`
        SELECT error_type, severity, COUNT(*) as count
        FROM aykoshop_workflow_errors
        WHERE started_at > NOW() - INTERVAL '24 hours' AND is_test = false
        GROUP BY error_type, severity ORDER BY count DESC LIMIT 10
      `),
      pool.query(`
        SELECT node_name, COUNT(*) as count
        FROM aykoshop_workflow_errors
        WHERE started_at > NOW() - INTERVAL '24 hours' AND is_test = false
        GROUP BY node_name ORDER BY count DESC LIMIT 5
      `),
      pool.query(`
        SELECT DATE_TRUNC('hour', started_at) as hour, COUNT(*) as count
        FROM aykoshop_workflow_errors
        WHERE started_at > NOW() - INTERVAL '24 hours' AND is_test = false
        GROUP BY hour ORDER BY hour
      `),
      pool.query(`SELECT COUNT(*) as count FROM aykoshop_workflow_errors WHERE resolved=false AND is_test=false`),
      pool.query(`SELECT COUNT(*) as count FROM aykoshop_workflow_errors WHERE is_test=true`),
      pool.query(`SELECT COUNT(*) as count FROM aykoshop_workflow_errors WHERE is_test=false`)
    ]);
    res.json({
      real_errors:       parseInt(realTotal.rows[0].count),
      real_unresolved:   parseInt(realUnresolved.rows[0].count),
      test_errors_total: parseInt(testTotal.rows[0].count),
      by_type: byType.rows,
      by_node: byNode.rows,
      trend:   trend.rows
    });
}));

// Production Health Card — single endpoint for the main status card
app.get('/api/ops/production-health', asyncHandler(async (req, res) => {
    const [
      realErrors24h, criticalErrors24h, unresolvedReal,
      customers24h, messages24h, aiReplies24h,
      sessionHealth, ordersToday
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM aykoshop_workflow_errors WHERE is_test=false AND started_at > NOW() - INTERVAL '24 hours'`),
      pool.query(`SELECT COUNT(*) FROM aykoshop_workflow_errors WHERE is_test=false AND severity='critical' AND resolved=false AND started_at > NOW() - INTERVAL '24 hours'`),
      pool.query(`SELECT COUNT(*) FROM aykoshop_workflow_errors WHERE is_test=false AND resolved=false`),
      pool.query(`SELECT COUNT(DISTINCT subscriber_id) FROM aykoshop_profiles WHERE last_seen > NOW() - INTERVAL '24 hours' AND subscriber_id ~ '^[0-9]+$'`),
      pool.query(`SELECT COUNT(*) FROM aykoshop_chat_history WHERE role='user' AND created_at > NOW() - INTERVAL '24 hours'`),
      pool.query(`SELECT COUNT(*) FROM aykoshop_chat_history WHERE role='assistant' AND created_at > NOW() - INTERVAL '24 hours'`),
      pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN session_data IS NOT NULL AND session_data != '{}' THEN 1 END) as with_session FROM aykoshop_profiles WHERE subscriber_id ~ '^[0-9]+$'`),
      pool.query(`SELECT COUNT(*) FROM aykoshop_orders WHERE created_at > NOW() - INTERVAL '24 hours'`)
    ]);

    const msgTotal = parseInt(messages24h.rows[0].count);
    const msgReplied = parseInt(aiReplies24h.rows[0].count);
    const totalProfiles = parseInt(sessionHealth.rows[0].total) || 1;
    const withSession   = parseInt(sessionHealth.rows[0].with_session);

    res.json({
      status: parseInt(criticalErrors24h.rows[0].count) > 0 ? 'degraded' :
              parseInt(unresolvedReal.rows[0].count) > 0 ? 'warning' : 'healthy',
      errors: {
        real_24h:     parseInt(realErrors24h.rows[0].count),
        critical:     parseInt(criticalErrors24h.rows[0].count),
        unresolved:   parseInt(unresolvedReal.rows[0].count)
      },
      traffic: {
        active_customers_24h: parseInt(customers24h.rows[0].count),
        messages_received:    msgTotal,
        ai_replies_sent:      msgReplied,
        reply_rate_pct:       msgTotal > 0 ? Math.round(msgReplied / msgTotal * 100) : 100
      },
      orders_today:   parseInt(ordersToday.rows[0].count),
      session_coverage_pct: Math.round(withSession / totalProfiles * 100),
      checked_at: new Date().toISOString()
    });
}));

app.patch('/api/ops/errors/:id/resolve', async (req, res) => {
  try {
    await pool.query("UPDATE aykoshop_workflow_errors SET resolved=true WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/ops/errors/resolve-all', async (req, res) => {
  try {
    // By default only resolve real errors; pass ?include_test=true to also clear test noise
    const { include_test = 'false' } = req.query;
    const where = include_test === 'true' ? 'resolved=false' : 'resolved=false AND is_test=false';
    const r = await pool.query(`UPDATE aykoshop_workflow_errors SET resolved=true WHERE ${where} RETURNING id`);
    res.json({ success: true, resolved: r.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Module 2 — Service Status (OpenAI / ManyChat / Dashboard / PostgreSQL)
let statusCache = { data: null, at: 0 };
app.get('/api/ops/backups', asyncHandler(async (req, res) => {
    const fs=require('fs'); const dir='/var/backups/aykoshop';
    let files=[]; try{ files=fs.readdirSync(dir).filter(f=>f.endsWith('.sql.gz')).map(f=>{const st=fs.statSync(dir+'/'+f);return {name:f,size:st.size,mtime:st.mtime};}).sort((a,b)=>new Date(b.mtime)-new Date(a.mtime)); }catch(e){}
    let offbox=0; try{ offbox=fs.readdirSync(dir+'/offbox').filter(f=>f.endsWith('.enc')).length; }catch(e){}
    res.json({ count:files.length, latest:files[0]||null, total_size:files.reduce((a,f)=>a+f.size,0), offbox_encrypted:offbox, files:files.slice(0,8) });
}));
app.get('/api/ops/status', async (req, res) => {
  // Cache for 30 seconds to avoid hammering external APIs
  if (statusCache.data && (Date.now() - statusCache.at) < 30000) {
    return res.json(statusCache.data);
  }
  const OPENAI_KEY = 'Bearer ' + _OPENAI_KEY;
  const MC_KEY = 'Bearer ' + (_mcKey()||'');

  const check = async (fn) => {
    const t0 = Date.now();
    try { await fn(); return { status: 'ok', latency_ms: Date.now() - t0 }; }
    catch(e) { return { status: 'error', error: String(e).slice(0,80), latency_ms: Date.now() - t0 }; }
  };

  const [openai, manychat, database] = await Promise.all([
    check(() => fetch('https://api.openai.com/v1/models', { headers:{'Authorization':OPENAI_KEY}, signal: AbortSignal.timeout(5000) })),
    check(() => mcPageInfo(5000)),
    check(() => pool.query('SELECT 1'))
  ]);

  const result = {
    openai,
    manychat,
    dashboard: { status: 'ok', latency_ms: 0 },  // self-check
    postgres: database,
    checked_at: new Date().toISOString()
  };
  statusCache = { data: result, at: Date.now() };
  res.json(result);
});

// Module 3 — Pause AI / Resume AI
app.post('/api/ops/pause-ai', async (req, res) => {
  try {
    await pool.query(
      "INSERT INTO aykoshop_settings (key,value) VALUES ('ai_paused','true') ON CONFLICT (key) DO UPDATE SET value='true',updated_at=NOW()"
    );
    res.json({ success: true, ai_paused: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ops/frozen', async (req, res) => {
  try {
    const r = await pool.query("SELECT s.subscriber_id, s.reason, s.stopped_at, p.customer_name, p.channel, ROUND((EXTRACT(EPOCH FROM (NOW()-s.stopped_at))/3600)::numeric,1) AS hours_frozen FROM aykoshop_stopped_chats s LEFT JOIN aykoshop_profiles p ON p.subscriber_id=s.subscriber_id ORDER BY s.stopped_at ASC");
    const LABELS={human_handoff:'تحويل للبشري',payment_verification:'تأكيد الدفع',payment_method:'طريقة الدفع',manual_takeover:'تدخّل يدوي',token_lock:'حبس (تردد)',ai_loop:'لوب (auto-expire 1h)',credentials:'معلومات حساسة',human_recharge:'شحن بشري',emergency:'طوارئ'};
    const by={}; r.rows.forEach(function(x){ by[x.reason]=(by[x.reason]||0)+1; });
    const reasons=Object.keys(by).map(function(k){ return {reason:k, label:LABELS[k]||k, count:by[k], auto_expire:(k==='ai_loop')}; }).sort(function(a,b){return b.count-a.count;});
    res.json({ ok:true, total:r.rows.length, by_reason:reasons, customers:r.rows, resume_via:'DELETE /api/customers/:id/takeover' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.post('/api/ops/resume-ai', async (req, res) => {
  try {
    await pool.query(
      "INSERT INTO aykoshop_settings (key,value) VALUES ('ai_paused','false') ON CONFLICT (key) DO UPDATE SET value='false',updated_at=NOW()"
    );
    res.json({ success: true, ai_paused: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ops/ai-status', asyncHandler(async (req, res) => {
    const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='ai_paused'");
    res.json({ ai_paused: r.rows[0]?.value === 'true' });
}));

// Module 4 — Funnel Analytics
app.get('/api/ops/funnel', asyncHandler(async (req, res) => {
    const period = req.query.period || '7d';
    const interval = period === '24h' ? '24 hours' : period === '30d' ? '30 days' : '7 days';

    const [stages, daily, byChannel] = await Promise.all([
      pool.query(`
        SELECT result, COUNT(*) as count,
               COUNT(DISTINCT subscriber_id) as unique_customers
        FROM aykoshop_warehouse
        WHERE created_at > NOW() - INTERVAL '${interval}'
          AND result IS NOT NULL
        GROUP BY result
        ORDER BY CASE result
          WHEN 'browsing'       THEN 1
          WHEN 'interested'     THEN 2
          WHEN 'payment_intent' THEN 3
          WHEN 'purchased'      THEN 4
          ELSE 5 END
      `),
      pool.query(`
        SELECT DATE(created_at) as date,
          COUNT(*) FILTER (WHERE result='browsing')       as browsing,
          COUNT(*) FILTER (WHERE result='interested')     as interested,
          COUNT(*) FILTER (WHERE result='payment_intent') as payment_intent
        FROM aykoshop_warehouse
        WHERE created_at > NOW() - INTERVAL '${interval}'
        GROUP BY DATE(created_at) ORDER BY date
      `),
      pool.query(`
        SELECT platform, result, COUNT(*) as count
        FROM aykoshop_warehouse
        WHERE created_at > NOW() - INTERVAL '${interval}'
        GROUP BY platform, result ORDER BY platform, count DESC
      `)
    ]);

    // Calculate conversion rates between stages
    const counts = {};
    stages.rows.forEach(r => { counts[r.result] = parseInt(r.count); });
    const browsing       = counts.browsing || 0;
    const interested     = counts.interested || 0;
    const payment_intent = counts.payment_intent || 0;
    const purchased      = counts.purchased || 0;
    const total          = browsing + interested + payment_intent + purchased;

    res.json({
      period,
      stages: stages.rows,
      conversions: {
        browsing_to_interested:        browsing     > 0 ? Math.round(interested     / (browsing + interested + payment_intent + purchased) * 100) : 0,
        interested_to_payment:         interested   > 0 ? Math.round(payment_intent / Math.max(interested, 1) * 100) : 0,
        payment_to_purchased:          payment_intent > 0 ? Math.round(purchased    / Math.max(payment_intent, 1) * 100) : 0,
        overall_conversion:            total        > 0 ? Math.round(purchased      / total * 100) : 0
      },
      daily,
      by_channel: byChannel.rows
    });
}));

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
app.get('/api/segments', asyncHandler(async (req, res) => {
    const [vip, hot, lost, newC] = await Promise.all([
      pool.query("SELECT p.subscriber_id,p.customer_name,p.channel,p.last_seen,COUNT(o.id) as order_count FROM aykoshop_profiles p JOIN aykoshop_orders o ON o.customer_name=p.customer_name WHERE o.status='delivered' GROUP BY p.subscriber_id,p.customer_name,p.channel,p.last_seen HAVING COUNT(o.id)>=2 ORDER BY order_count DESC LIMIT 50"),
      pool.query("SELECT subscriber_id,customer_name,channel,last_seen,interested_in,EXTRACT(EPOCH FROM (NOW()-last_seen))/3600 as hours_ago FROM aykoshop_profiles WHERE stage IN ('hot','warm') AND last_seen > NOW()-INTERVAL '7 days' ORDER BY last_seen DESC LIMIT 50"),
      pool.query("SELECT subscriber_id,customer_name,channel,last_seen,interested_in,EXTRACT(EPOCH FROM (NOW()-last_seen))/3600 as hours_ago FROM aykoshop_profiles WHERE stage IN ('hot','warm') AND last_seen < NOW()-INTERVAL '7 days' ORDER BY last_seen DESC LIMIT 50"),
      pool.query("SELECT subscriber_id,customer_name,channel,last_seen,stage FROM aykoshop_profiles WHERE created_at > NOW()-INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 50")
    ]);
    res.json({ vip: vip.rows, hot_not_purchased: hot.rows, lost: lost.rows, new_today: newC.rows });
}));
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
    const MANYCHAT_KEY = `Bearer ${_mcKey()}`;
    let sent = 0, failed = 0;
    for (const p of profiles.rows) {
      try { await fetch('https://api.manychat.com/fb/sending/sendContent', { method:'POST', headers:{'Authorization':MANYCHAT_KEY,'Content-Type':'application/json'}, body: JSON.stringify({ subscriber_id: p.subscriber_id, data: { version:'v2', content:{ messages:[{type:'text',text:message}] } } }) }); sent++; await new Promise(r=>setTimeout(r,300)); } catch(e) { failed++; }
    }
    res.json({success:true, sent, failed, total: profiles.rows.length});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ===== Hermes Follow-up Queue — COLLECT-ONLY (10h-24h window). NO auto-send. Operator writes+sends manually. (ADR-0010 Phase 5) =====
app.get('/api/hermes/queue', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.subscriber_id, p.customer_name, p.channel,
         COALESCE(NULLIF(p.active_product,''), NULLIF(p.interested_in,'')) AS last_product,
         p.interested_in, p.budget, p.stage,
         ROUND((EXTRACT(EPOCH FROM (NOW()-p.last_seen))/3600)::numeric,1) AS hours_since,
         ROUND((24 - EXTRACT(EPOCH FROM (NOW()-p.last_seen))/3600)::numeric,1) AS hours_remaining,
         (p.session_data->>'had_offer')='true' AS had_offer,
         (p.session_data->>'channel_visited')='true' AS channel_visited,
         (SELECT h.message FROM aykoshop_chat_history h WHERE h.subscriber_id=p.subscriber_id AND h.role='user' ORDER BY h.created_at DESC LIMIT 1) AS last_message
       FROM aykoshop_profiles p
       WHERE p.last_seen <= NOW() - INTERVAL '10 hours'
         AND p.last_seen >  NOW() - INTERVAL '24 hours'
         AND ( COALESCE(p.interested_in,'')<>'' OR (p.session_data->>'had_offer')='true' OR p.stage IN ('hot','warm') )
         AND NOT EXISTS (SELECT 1 FROM aykoshop_orders o WHERE o.subscriber_id=p.subscriber_id AND o.status IN ('paid','delivered'))
       ORDER BY p.last_seen ASC LIMIT 100`
    );
    res.json({ ok:true, collect_only:true, auto_send:false, window:'10h-24h', count:r.rows.length, queue:r.rows });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/ai/customer-memory/:sub', async (req,res)=>{ try{ const m=await _customerMemory(req.params.sub); res.json({ok:true, flag_on:(await _ff('memory_v6')), memory:m}); }catch(e){ res.status(500).json({ok:false,error:e.message}); } });

// ==================== AI INSIGHTS ====================
app.get('/api/ai-insights', async (req, res) => {
  try {
    const [topProducts, topQuestions, readyToBuy, convRate, bestChannel] = await Promise.all([
      pool.query("SELECT product_name, COUNT(*) as orders FROM aykoshop_orders WHERE paid_at IS NOT NULL AND status IN ('paid','delivered') GROUP BY product_name ORDER BY orders DESC LIMIT 5"),
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
  try { const r = await pool.query("SELECT key,value FROM aykoshop_settings"); const s = {}; r.rows.forEach(row => s[row.key] = /password|secret|token|jwt|deploy|api_key|_key$|^key$/i.test(row.key) ? '***REDACTED***' : row.value); res.json(s); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/settings', async (req, res) => {
  try { await pool.query("INSERT INTO aykoshop_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()", [req.body.key, req.body.value]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/settings/change-password', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='admin_password'");
    const savedPass = r.rows[0]?.value || '';
    if (!savedPass || req.body.current_password !== savedPass) return res.status(401).json({error:'الباسورد الحالي غلط!'});
    await pool.query("UPDATE aykoshop_settings SET value=$1,updated_at=NOW() WHERE key='admin_password'", [req.body.new_password]);
    res.json({success:true});
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/settings/reset-password', async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='store_email'");
    const savedEmail = r.rows[0]?.value || 'Aykosur@gmail.com';
    if (req.body.email.toLowerCase() !== savedEmail.toLowerCase()) return res.status(401).json({error:'الإيميل غلط!'});

    // SECURITY (H3): require the CURRENT admin password too — closes the email-only takeover chain (GET /api/settings leaked store_email → reset). The dashboard's legit change uses /api/settings/change-password; this endpoint now also needs the existing password.
    const _pr = await pool.query("SELECT value FROM aykoshop_settings WHERE key='admin_password'");
    const _curPw = _pr.rows[0]?.value || '';
    if (!req.body.current_password || String(req.body.current_password) !== String(_curPw)) return res.status(401).json({error:'كلمة السر الحالية مطلوبة'});
    await pool.query("UPDATE aykoshop_settings SET value=$1,updated_at=NOW() WHERE key='admin_password'", [req.body.new_password]);
    res.json({success:true});
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/system-prompt', async (req, res) => {
  try { const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='system_prompt'"); res.json({prompt: r.rows[0]?.value || ''}); } catch(e) { res.status(500).json({error: e.message}); }
});
app.post('/api/system-prompt', async (req, res) => {
  try {
    await pool.query("INSERT INTO aykoshop_settings (key,value) VALUES ('system_prompt',$1) ON CONFLICT (key) DO UPDATE SET value=$1,updated_at=NOW()", [req.body.prompt]);
    const actor = (req.headers['x-operator'] || 'operator').slice(0,80);
    await pool.query("INSERT INTO aykoshop_prompt_versions (prompt,actor) VALUES ($1,$2)", [req.body.prompt||'', actor]).catch(()=>{});
    res.json({success:true});
  } catch(e) { res.status(500).json({error: e.message}); }
});
// ===== Audit Log API =====
app.get('/api/audit', asyncHandler(async (req, res) => {
    const { entity, method, q } = req.query; const cond = [], args = []; let i = 1;
    if (entity) { cond.push(`entity=$${i++}`); args.push(entity); }
    if (method) { cond.push(`method=$${i++}`); args.push(method); }
    if (q) { cond.push(`(path ILIKE $${i} OR actor ILIKE $${i} OR detail ILIKE $${i})`); args.push('%' + q + '%'); i++; }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const lim = Math.min(parseInt(req.query.limit) || 200, 500);
    const r = await pool.query(`SELECT * FROM aykoshop_audit_log ${where} ORDER BY created_at DESC LIMIT ${lim}`, args);
    res.json({ entries: r.rows });
}));
app.get('/api/audit/stats', asyncHandler(async (req, res) => { const r = await pool.query("SELECT entity, count(*)::int AS n FROM aykoshop_audit_log GROUP BY entity ORDER BY n DESC"); res.json({ by_entity: r.rows, total: r.rows.reduce((s,x)=>s+x.n,0) }); }));
app.get('/api/audit/export', asyncHandler(async (req, res) => {
    const r = await pool.query("SELECT created_at,method,entity,path,status,actor,detail FROM aykoshop_audit_log ORDER BY created_at DESC LIMIT 5000");
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/[\r\n]/g, ' ') + '"';
    const csv = 'time,method,entity,path,status,actor,detail\n' + r.rows.map(x => [x.created_at, x.method, x.entity, x.path, x.status, x.actor, x.detail].map(esc).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=audit_log.csv');
    res.send(csv);
}));
// ===== Prompt version history =====
app.get('/api/system-prompt/versions', async (req, res) => {
  try { const r = await pool.query("SELECT id,LEFT(prompt,4000) AS prompt,actor,created_at FROM aykoshop_prompt_versions ORDER BY created_at DESC LIMIT 50"); res.json({ versions: r.rows }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===================== Telegram Hermes Command Center + Conversational =====================
const HTG_TOKEN = process.env.HTG_TOKEN || '';
const HTG_ADMINS = (process.env.TG_ADMIN_CHATS || '-1002660175997,6990881479').split(',').map(s=>s.trim());
const HTG_OPENAI = () => 'Bearer ' + _OPENAI_KEY;
const HDASH = 'https://aykoshoop.duckdns.org';
async function hTgSend(chatId, text){
  try{ await fetch('https://api.telegram.org/bot'+_tgTok()+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:text,parse_mode:'HTML',disable_web_page_preview:true})}); }catch(e){ console.error('[hermes-tg] send:',e.message); }
}
// ===== TEST/PROD Telegram routing — test alerts (golden/regression/QA) -> "Ayko QA Lab"; real customers -> production bot. =====
// Test identity = explicit is_test flag (PRIMARY) OR known synthetic sub ranges (BACKSTOP). Fail-closed: if test & test-creds missing -> DROP (never hits prod).
function _isTestRoute(subscriber_id, flag){
  if(flag===true||flag==='1'||flag===1||flag==='true') return true;
  return /^(9993\d{6}|9994\d{6}|9995\d{6}|9997\d{3,6}|9999\d{3,6})$/.test(String(subscriber_id||''));
}
// Environment resolver: explicit body.environment (prod|qa|test) wins; else is_test flag / test-range -> 'test'; else 'prod'.
// DEFAULT 'prod' so a real customer (no signal) is NEVER hidden from the Inbox; only positively-detected test is hidden. Inbox = allowlist (environment='prod').
function _envOf(body, sub){
  var e = body && body.environment;
  if(e==='prod'||e==='qa'||e==='test') return e;
  return _isTestRoute(sub, body && body.is_test) ? 'test' : 'prod';
}
// classify a provider error string into a typed bucket (for the failover-event log)
function _errType(s){ s=String(s||'').toLowerCase(); if(!s) return null; if(/timeout|abort|etimedout|timed ?out/.test(s)) return 'timeout'; if(/quota|429|rate.?limit|insufficient|billing|exceeded/.test(s)) return 'quota'; if(/5\d\d|server error|overload|unavailable|bad gateway/.test(s)) return 'server'; if(/parse|json|unexpected/.test(s)) return 'parse'; return 'other'; }
function _tgRoute(isTest){
  if(isTest){ const t=process.env.TEST_TG_TOKEN, c=process.env.TEST_TG_CHAT; return (t&&c)?{token:t,chat:c,test:true}:null; }
  return { token:(process.env.TG_TOKEN||_tgTok()), chat:(process.env.TG_CHAT||'6990881479'), test:false };
}
// ===== DB POOL ERROR MONITOR (TECHNICAL -> Ayko QA Lab, 10-min dedup). Catches idle-client / connection-loss errors that were otherwise SILENT (no pool.on('error') before). =====
let _poolErrAt=0, _poolErrN=0;
async function _poolErrAlert(err){
  _poolErrN++; const now=Date.now(); if(now-_poolErrAt<600000) return; _poolErrAt=now; // 10-min dedup
  const ep=_tgRoute(true); if(!ep) return; // technical -> QA Lab (fail-closed if no QA creds)
  const detail=String((err&&((err.code?('['+err.code+'] '):'')+(err.message||'')))||'unknown').slice(0,280);
  const msg='🛑 DB POOL ERROR (#'+_poolErrN+')\n'+detail+'\n'+new Date().toISOString();
  try{ await fetch('https://api.telegram.org/bot'+ep.token+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:ep.chat,text:msg})}); }catch(_e){}
}
pool.on('error', (err)=>{ try{ console.error('[pool] idle client error:', err&&err.message); _poolErrAlert(err); }catch(_e){} });
// Compact Project-Advisor brief (M1-M5) for the conversational Hermes — cached 60s so chat doesn't hammer the advisor.
let _advBriefCache={t:0,v:null};
async function _advisorBrief(){
  if(_advBriefCache.v && (Date.now()-_advBriefCache.t)<60000) return _advBriefCache.v;
  let v=null;
  try{ const a=((await (await fetch('http://localhost:4000/api/hermes/advisor?days=90')).json())||{}).advisor||{};
    v={ real_customers:a.real_customers, confidence:a.confidence, bottleneck:a.bottleneck, verdict:a.verdict,
      lead_stages:a.lead_stages, funnel:(a.traffic||{}).reached,
      channel_coverage_pct:((a.traffic||{}).channel_attribution||{}).coverage_pct,
      demand_top_gaps:(a.demand||{}).top, total_lost_revenue:(a.demand||{}).total_lost_revenue,
      recommendations:(a.recommendations?{by_status:a.recommendations.by_status,health_pct:a.recommendations.recommendation_health_pct}:null),
      catalog_to_add:(a.catalog||{}).to_add, catalog_dead_candidates:(a.catalog||{}).dead_candidates, catalog_remove_confidence:(a.catalog||{}).remove_confidence,
      operations:a.operations }; }catch(_e){}
  _advBriefCache={t:Date.now(),v:v}; return v;
}
async function hermesSnapshot(){
  const [cust,ords,paid,iv,err,cats,hot,drafts,aip] = await Promise.all([
    pool.query("SELECT count(*)::int n FROM aykoshop_profiles"),
    pool.query("SELECT count(*)::int n, count(*) FILTER (WHERE created_at::date=CURRENT_DATE)::int today FROM aykoshop_orders"),
    pool.query("SELECT count(*)::int n FROM aykoshop_orders WHERE paid_at IS NOT NULL"),
    pool.query("SELECT count(*)::int n FROM aykoshop_interventions WHERE status='pending' AND is_test IS NOT TRUE"),
    pool.query("SELECT count(*)::int n FROM aykoshop_workflow_errors WHERE started_at>NOW()-INTERVAL '24 hours'").catch(()=>({rows:[{n:0}]})),
    pool.query("SELECT category, count(*)::int n FROM aykoshop_warehouse WHERE created_at>NOW()-INTERVAL '7 days' AND category IS NOT NULL GROUP BY category ORDER BY n DESC LIMIT 6").catch(()=>({rows:[]})),
    pool.query("SELECT customer_name, interested_in, round(EXTRACT(EPOCH FROM (NOW()-last_seen))/3600)::int quiet_hrs FROM aykoshop_profiles WHERE stage='hot' ORDER BY last_seen DESC NULLS LAST LIMIT 8"),
    pool.query("SELECT count(*)::int n FROM aykoshop_followup_drafts WHERE status='draft'").catch(()=>({rows:[{n:0}]})),
    pool.query("SELECT value FROM aykoshop_settings WHERE key='ai_paused'").catch(()=>({rows:[]}))
  ]);
  let rev=null; try{ const rv=await getRevenue(null,null); rev=(rv&&rv.total!=null)?rv.total:rv; }catch(e){}
  let proj=null; try{ proj=await _advisorBrief(); }catch(_e){}
  return { customers:cust.rows[0].n, orders_total:ords.rows[0].n, orders_today:ords.rows[0].today, paid_orders:paid.rows[0].n,
    revenue_total_dh:rev, pending_interventions:iv.rows[0].n, errors_24h:err.rows[0].n, pending_followup_drafts:drafts.rows[0].n,
    ai_paused:(aip.rows[0]?aip.rows[0].value==='true':false), top_demand_categories_7d:cats.rows, hot_leads:hot.rows,
    project_advisor:proj };
}
async function hermesAnswer(question, chatId){
  const snap=await hermesSnapshot(); let hist=[];
  try{ const h=await pool.query("SELECT role,content FROM aykoshop_telegram_context WHERE chat_id=$1 ORDER BY id DESC LIMIT 6",[String(chatId)]); hist=h.rows.reverse(); }catch(e){}
  const sys="أنت Hermes، مستشار مشروع AykoShop الذكي (ماشي غير عمليات). أجب على المشغّل اعتماداً فقط على لقطة البيانات الحيّة (JSON). بنفس لغة السؤال (دارجة/عربية/إنجليزية)، موجز وعملي. ممنوع تختلق أرقاماً؛ إن لم تكفِ البيانات قلها بصراحة.\n"+
    "حقل project_advisor فيه ذكاء المشروع (M1-M5): bottleneck (TRAFFIC/CONVERSION)، verdict، lead_stages (cold/warm/hot/buyer = شكون قريب يشري)، demand_top_gaps (شنو مطلوب وماكاينش + شحال hot)، catalog_to_add/dead_candidates (شنو تزيد/تحيّد)، recommendations.health (صحة توصياتك)، channel_coverage، operations. استعملو للأسئلة التجارية: شنو نزيد فالمخزون؟ ترافيك ولا تحويل؟ شكون الزبناء الحارّين؟ شنو مايتباعش؟.\n"+
    "احترم الثقة: إذا real_customers صغير (<30) نبّه أن الإشارة اتجاه ماشي قرار نهائي، وماتنصحش بحذف منتجات. ملي يسأل 'شنو ندير؟' أعطِ أهم 3 إجراءات مرتّبة بالأثر مع الأرقام.\n\nLIVE DATA:\n"+JSON.stringify(snap);
  const messages=[{role:'system',content:sys}].concat(hist.map(h=>({role:(h.role==='user'?'user':'assistant'),content:h.content}))).concat([{role:'user',content:question}]);
  let answer='';
  if(!circuitAllows('openai')) return '⚠️ محرّك التحليل متوقّف مؤقتاً (الدائرة مفتوحة بعد أعطال متتالية في OpenAI). حاول بعد دقيقة.';
  try{
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':HTG_OPENAI(),'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o',max_tokens:450,temperature:0.4,messages})});
    circuitRecord('openai', r.ok, 'hermesAnswer HTTP '+r.status);
    const j=await r.json(); answer=(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||('تعذّر التحليل: '+(j.error?j.error.message:'no response'));
  }catch(e){ circuitRecord('openai', false, 'hermesAnswer '+e.message); answer='خطأ في الاتصال بمحرّك التحليل: '+e.message; }
  try{ await pool.query("INSERT INTO aykoshop_telegram_context (chat_id,role,content) VALUES ($1,'user',$2),($1,'assistant',$3)",[String(chatId),question.slice(0,1000),answer.slice(0,2000)]); }catch(e){}
  return answer;
}
async function hermesCommand(cmd, chatId){
  const snap=await hermesSnapshot();
  if(cmd==='/status'||cmd==='/start'||cmd==='/help'){
    return "🤖 <b>Hermes — مركز العمليات</b>\n"+
      "الحالة: "+(snap.ai_paused?'⏸️ الذكاء متوقف':'🟢 الذكاء يعمل')+"\n"+
      "👥 الزبائن: "+snap.customers+" · 🛒 طلبات: "+snap.orders_total+" (اليوم "+snap.orders_today+") · مدفوعة: "+snap.paid_orders+"\n"+
      "💰 الإيراد: "+(snap.revenue_total_dh!=null?snap.revenue_total_dh+" DH":"—")+"\n"+
      "🔔 تدخّلات: "+snap.pending_interventions+" · ⚠️ أخطاء 24س: "+snap.errors_24h+" · 📝 مسودات: "+snap.pending_followup_drafts+"\n\n"+
      "<b>الأوامر:</b> /status /advisor /signals /demand /stock /audit /customers /orders /revenue /alerts /pause /resume\n"+
      "أو اكتب سؤالاً بلغتك (مثال: شكون أهم الزبائن اليوم؟ · علاش نقصو المبيعات؟)\n"+
      "🔗 "+HDASH+"/#/cockpit";
  }
  if(cmd==='/pause'){ await pool.query("INSERT INTO aykoshop_settings (key,value) VALUES ('ai_paused','true') ON CONFLICT (key) DO UPDATE SET value='true',updated_at=NOW()"); return "⏸️ تم إيقاف الذكاء. البوت لن يردّ تلقائياً حتى /resume."; }
  if(cmd==='/resume'){ await pool.query("INSERT INTO aykoshop_settings (key,value) VALUES ('ai_paused','false') ON CONFLICT (key) DO UPDATE SET value='false',updated_at=NOW()"); return "🟢 تم تشغيل الذكاء. البوت يردّ تلقائياً الآن."; }
  if(cmd==='/customers'){
    const r=await pool.query("SELECT customer_name,stage,interested_in FROM aykoshop_profiles ORDER BY last_seen DESC NULLS LAST LIMIT 8");
    return "👥 <b>آخر الزبائن:</b>\n"+r.rows.map(c=>'• '+(c.customer_name||'زبون')+' ['+(c.stage||'-')+']'+(c.interested_in?' · '+c.interested_in:'')).join('\n')+"\n🔗 "+HDASH+"/#/crm";
  }
  if(cmd==='/orders'){
    const r=await pool.query("SELECT id,customer_name,product_name,price,paid_at FROM aykoshop_orders ORDER BY created_at DESC LIMIT 8");
    return "🛒 <b>آخر الطلبات:</b>\n"+(r.rows.length?r.rows.map(o=>'• #'+o.id+' '+(o.customer_name||'')+' — '+(o.product_name||'')+' '+(o.price||'')+' '+(o.paid_at?'✅':'⏳')).join('\n'):'لا طلبات')+"\n🔗 "+HDASH+"/#/sales";
  }
  if(cmd==='/demand'||cmd==='/stock'){
    try{ const d=await (await fetch('http://localhost:4000/api/hermes/demand?days=30')).json();
      const gaps=(d.rows||[]).filter(r=>r.gap!=='OK').slice(0,8);
      let s='📦 <b>الطلب vs المخزون</b> — '+(d.real_customers||0)+' زبون حقيقي'+((d.real_customers||0)<10?' (عيّنة صغيرة)':'')+'\n\n';
      if(!gaps.length) s+='✅ ماكاين فجوات واضحة دابا.';
      else s+='<b>المنتجات المطلوبة وماكايناش/غالية:</b>\n'+gaps.map(r=>'• <b>'+r.product+'</b> — طلبوه '+r.requested_count+' زبون · ميزانية '+(r.budget_min||'?')+'-'+(r.budget_max||'?')+'DH · مخزون '+r.available_inventory+(r.gap==='NO_PRODUCT'?' ❌':' ⚠️ غالي')+' · خسارة~'+r.est_lost_revenue+'DH').join('\n');
      s+='\n\n💸 إجمالي الخسارة المقدّرة: '+(d.total_lost_revenue||0)+'DH\n🔗 '+HDASH+'/#/system';
      return s;
    }catch(e){ return 'تعذّر حساب الطلب: '+e.message; }
  }
  if(cmd==='/audit'){
    try{ require('child_process').exec('/usr/bin/python3 /usr/local/bin/aykoshop-daily-audit.py >/dev/null 2>&1 &'); }catch(_e){}
    return '🔍 Audit الكامل بدا (Golden routing + Content + E2E على LLM الحقيقي). النتيجة (✅/🚨) + استهلاك 24س غادي توصل هنا فـQA Lab بعد ~3-4 دقايق.';
  }
  if(cmd==='/advisor'||cmd==='/ai'||cmd==='/sales'){
    try{ const x=await (await fetch('http://localhost:4000/api/hermes/advisor?days=30')).json(); const a=x.advisor||{}; const t=a.traffic||{}; const rc=t.reached||{};
      let s='🧠 <b>مستشار المشروع</b> ('+(a.real_customers||0)+' زبون حقيقي · ثقة '+(a.confidence||'?')+(a.real_customers<30?' — عيّنة صغيرة':'')+')\n\n';
      s+='🚦 <b>العائق: '+(a.bottleneck||'?')+'</b>\n'+(a.verdict||'')+'\n\n';
      const lsx=a.lead_stages||{}; s+='🌡️ المراحل: 🛒buyer '+(lsx.buyer||0)+' · 🔥hot '+(lsx.hot||0)+' · 🌤️warm '+(lsx.warm||0)+' · ❄️cold '+(lsx.cold||0)+'\n';
      s+='👥 الوصول: ترحيب '+(rc.greeting||0)+' · اكتشاف '+(rc.discovery||0)+' · بيع '+(rc.sales||0)+' · بشري '+(rc.human||0)+' · مبيعات مسدودة '+(t.closed_orders||0)+'\n';
      s+='📦 فجوات الطلب: '+((a.demand&&a.demand.gaps)||0)+' · خسارة~'+((a.demand&&a.demand.total_lost_revenue)||0)+'DH\n';
      const rec=a.recommendations||{}; s+='🎯 فرص متتبّعة: '+(rec.tracked||0)+' · عولجت '+(rec.addressed||0)+' · صحة التوصيات '+(rec.recommendation_health_pct!=null?rec.recommendation_health_pct+'%':'—')+'\n';
      const ca=(t.channel_attribution)||{}, cc=ca.by_channel||{}; s+='📡 القنوات: IG '+(cc.instagram||0)+' · WA '+(cc.whatsapp||0)+' · FB '+(cc.facebook||0)+' · مجهول '+(cc.unknown||0)+' (تغطية '+(ca.coverage_pct!=null?ca.coverage_pct+'%':'—')+')\n';
      const cat=a.catalog||{}; s+='📚 الكاطالوغ: زيد '+((cat.to_add||[]).length)+' · مايتباعش '+((cat.not_selling||[]).length)+' · مرشّح حذف '+((cat.dead_candidates||[]).length)+(cat.remove_confidence==='low'?' (ثقة الحذف ضعيفة)':'')+'\n';
      s+='🛑 مايتباعش: '+((a.not_selling||[]).length)+' منتج · ⚙️ تدخّلات معلّقة '+((a.operations&&a.operations.pending_interventions)||0)+' · circuit '+((a.operations&&a.operations.open_circuits)||'?')+'\n';
      s+='🔧 ثغرات: lead-score '+((a.gaps&&a.gaps.lead_score_real_coverage)||'?')+' · clarify-turns '+((a.gaps&&a.gaps.clarify_turns)||0)+'\n🔗 '+HDASH+'/#/system';
      return s;
    }catch(e){ return 'تعذّر المستشار: '+e.message; }
  }
  if(cmd==='/signals'){
    try{ const x=await (await fetch('http://localhost:4000/api/hermes/signals')).json(); const sg=(x.signals||[]).slice(0,8);
      if(!sg.length) return '🔕 ماكاين إشارات دابا.';
      return '🛰️ <b>إشارات Hermes</b> (آخر '+sg.length+'):\n\n'+sg.map(s=>(s.severity==='opportunity'?'💡':'⚠️')+' <b>'+s.title+'</b>'+(s.status==='sent'?' ✓':' (shadow)')+'\n'+s.what+'\n→ '+s.suggest).join('\n\n')+'\n\n🔗 '+HDASH+'/#/system';
    }catch(e){ return 'تعذّر جلب الإشارات: '+e.message; }
  }
  if(cmd==='/revenue'){
    let total=null,today=null; try{ const a=await getRevenue(null,null); total=(a&&a.total!=null)?a.total:a; const t=new Date();t.setHours(0,0,0,0); const b=await getRevenue(t.toISOString(),null); today=(b&&b.total!=null)?b.total:b; }catch(e){}
    return "💰 <b>الإيرادات:</b>\nالكل: "+(total!=null?total:'—')+" DH\nاليوم: "+(today!=null?today:'—')+" DH\nطلبات مدفوعة: "+snap.paid_orders+"\n🔗 "+HDASH+"/#/sales";
  }
  if(cmd==='/alerts'){
    const er=await pool.query("SELECT node_name,error_message FROM aykoshop_workflow_errors WHERE started_at>NOW()-INTERVAL '24 hours' ORDER BY started_at DESC LIMIT 5").catch(()=>({rows:[]}));
    return "🔔 <b>التنبيهات:</b>\nتدخّلات معلّقة: "+snap.pending_interventions+" · أخطاء 24س: "+snap.errors_24h+"\n"+(er.rows.length?er.rows.map(e=>'⚠️ '+(e.node_name||'')+': '+String(e.error_message||'').slice(0,60)).join('\n'):'لا أخطاء حديثة')+"\n🔗 "+HDASH+"/#/system";
  }
  return null;
}
// ==================== OPERATOR CAPTURE LOOP (SHADOW) ====================
// When AYKO replies (in Telegram) to an escalation alert → store a GENERICIZED Training Example
// in our own DB (model-agnostic KB). SHADOW: stores only, does NOT send to the customer.
// Knowledge stays inside AykoShop (Postgres/pgvector), reusable by ANY future model.
const _CAPTURE_REASONS = new Set(['UNKNOWN_QUESTION','HUMAN_REQUESTED','CUSTOMER_COMPLAINT','LOW_CONFIDENCE','HOT_LEAD','AI_LOOP_DETECTED','PRODUCT_NOT_FOUND','PRODUCT_MISMATCH','AI_REPLY_FAILED']);
// NEVER learn from sensitive/transactional escalations:
//   PAYMENT_INTENT, PAYMENT_METHOD_UNKNOWN, FRAUD_REVIEW, DELIVERY_REQUIRED, HUMAN_RECHARGE, VIP_RECHARGE, AI_UNAVAILABLE

// Behaviour-only: strip prices, products, banks, account numbers, emails — keep the SELLING BEHAVIOUR.
function _ocGenericize(text){
  return String(text||'')
    .replace(/([0-9]{1,6})\s*(درهم|dh|dirham|dhs|dollar|\$|€|euro|mad)/gi,'[الثمن من الكاطالوج]')
    .replace(/\b(cih|barid\s?bank|barid|binance|wafa\s?cash|wafacash|cash\s?plus|cashplus|paypal|payoneer|rib|iban)\b/gi,'[طريقة الدفع الرسمية]')
    .replace(/[\w.\-]+@[\w.\-]+\.\w{2,}/g,'[إيميل محذوف]')
    .replace(/\b[0-9]{6,}\b/g,'[رقم محذوف]')
    .trim();
}
// abort capture if credentials survive genericize (safety hard-stop)
function _ocHasSensitive(text){ return /\b(rib|iban)\b|[0-9]{10,}|كود التفعيل|رمز الحساب|\bpassword\b|mot de passe/i.test(String(text||'')); }

// intent label from escalation reason + customer wording (behaviour category, NOT product)
function _ocIntent(reason, customerMsg){
  const m=String(customerMsg||'').toLowerCase();
  if(reason==='CUSTOMER_COMPLAINT') return 'complaint';
  if(/غالي|ghali|كثير بزاف|نفكر|expensive|too much|مكناش/.test(m)) return 'objection';
  if(reason==='PRODUCT_NOT_FOUND'||reason==='PRODUCT_MISMATCH') return 'product_question';
  if(reason==='HOT_LEAD') return 'closing';
  return 'faq';
}

// Core capture. intervention = row from aykoshop_interventions. SHADOW (no customer send).
async function _ocCapture(intervention, operatorText){
  try{
    if(!intervention || !operatorText) return {skip:'empty'};
    const sub = intervention.subscriber_id;
    const reason = intervention.reason_code;
    if(!_CAPTURE_REASONS.has(reason)) return {skip:'reason_not_learnable:'+reason};
    const opGeneric = _ocGenericize(operatorText);
    if(!opGeneric || opGeneric.length<3) return {skip:'reply_too_short'};
    if(_ocHasSensitive(opGeneric)) return {skip:'sensitive_blocked'};
    // last 6 messages (context, metadata for review)
    let ctx=[];
    try{ const h=await pool.query("SELECT role,message FROM aykoshop_chat_history WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 10",[String(sub)]); ctx=h.rows.reverse().map(r=>({role:r.role,message:String(r.message||'').slice(0,300)})); }catch(e){}
    const customerRaw = intervention.customer_message || (ctx.filter(x=>x.role==='user').slice(-1)[0]||{}).message || '';
    const customerGeneric = _ocGenericize(customerRaw);
    const intent = _ocIntent(reason, customerRaw);
    // outcome is a FORWARD signal (did they buy AFTER) → unknown now; tentatively flag prior purchase
    let outcome='pending';
    try{ const o=await pool.query("SELECT 1 FROM aykoshop_orders WHERE subscriber_id=$1 AND created_at>now()-interval '7 days' LIMIT 1",[String(sub)]); if(o.rows.length) outcome='prior_buyer'; }catch(e){}
    // store as Training Example — pending review (approved=false); retrieval only uses approved=true
    const ins=await pool.query(
      "INSERT INTO aykoshop_conversation_examples (category,customer_message,correct_reply,source,subscriber_id,approved,channel,entry_type,objection_category,context_json,outcome,review_flag) VALUES ('operator_capture',$1,$2,'telegram_operator',$3,false,$4,$5,$6,$7::jsonb,$8,true) RETURNING id",
      [customerGeneric.slice(0,500), opGeneric.slice(0,1000), String(sub), intervention.channel||null, intent, (intent==='objection'?'price':null), JSON.stringify(ctx), outcome]
    );
    await pool.query("UPDATE aykoshop_interventions SET operator_reply=$2, operator_replied_at=now(), outcome=$3 WHERE id=$1",[intervention.id, String(operatorText).slice(0,1000), outcome]).catch(()=>{});
    return {ok:true, example_id:ins.rows[0].id, intent, outcome, generic:opGeneric.slice(0,140), ctx_n:ctx.length};
  }catch(e){ return {error:e.message}; }
}
// ==================== END OPERATOR CAPTURE LOOP ====================

// ==================== LEARNING INBOX (dashboard) — AI-replies feed + Approve/Edit→BEHAVIOR + Behavior Library ====================
// Builds on the existing pieces: _ocGenericize (save BEHAVIOUR not text), _ocHasSensitive (credential hard-stop),
// _embed (semantic Smart-Dedup), aykoshop_conversation_examples (the behaviour store + RAG), and the EXISTING
// /api/customers/:id/message (ManyChat send) + /api/customers/:id/takeover (the dashboard already wires these).
// Real customers only (PSID 15+). No new send path; no blind text saving — every learned row is genericised + deduped.

// FEED — recent AI replies (customer message → AI reply) + light context, newest first.
app.get('/api/learning/inbox', async (req,res)=>{
  try{
    const lim=Math.min(parseInt(req.query.limit)||40,120);
    const r=await pool.query(
      "SELECT a.id, a.subscriber_id, a.message AS ai_reply, a.created_at,"+
      " (SELECT u.message FROM aykoshop_chat_history u WHERE u.subscriber_id=a.subscriber_id AND u.role='user' AND u.created_at<=a.created_at ORDER BY u.created_at DESC LIMIT 1) AS customer_message,"+
      " p.customer_name, p.channel, p.convo_state, p.favorite_game, p.service_type,"+
      " (SELECT t.agent FROM aykoshop_agent_trail t WHERE t.subscriber_id=a.subscriber_id AND t.created_at<=a.created_at ORDER BY t.created_at DESC LIMIT 1) AS agent"+
      " FROM aykoshop_chat_history a LEFT JOIN aykoshop_profiles p ON p.subscriber_id=a.subscriber_id"+
      " WHERE a.role='assistant' AND a.subscriber_id ~ '^[0-9]{15,}$'"+
      " ORDER BY a.created_at DESC LIMIT $1",[lim]);
    res.json({ inbox:r.rows });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// FEEDBACK — approve a good reply OR store an edited correction as a genericised BEHAVIOUR with SEMANTIC SMART-DEDUP.
// body: { subscriber_id, customer_message, reply, action:'approve'|'edit', channel? }
app.post('/api/learning/feedback', async (req,res)=>{
  try{
    const b=req.body||{};
    const action=(b.action==='edit')?'edit':'approve';
    const cust=_ocGenericize(b.customer_message||'');
    const reply=_ocGenericize(b.reply||'');
    if(!reply || reply.length<3) return res.status(400).json({error:'reply too short'});
    if(_ocHasSensitive(reply)||_ocHasSensitive(cust)) return res.status(400).json({error:'sensitive content blocked (credentials/IBAN) — not learnable'});
    const _src=(action==='edit')?'dashboard_edit':'dashboard_approve';
    const _intent=_ocIntent(null,b.customer_message||'');
    // SMART-DEDUP: embed the customer message; if a near-identical behaviour exists → bump uses (one BEHAVIOUR, many uses) instead of a duplicate.
    let emb=null; try{ emb=await _embed(cust||reply); }catch(_e){}
    if(emb){
      const v='['+emb.join(',')+']';
      const dup=await pool.query("SELECT id, COALESCE(usage_count,0) usage_count, 1-(embedding <=> $1::vector) sim FROM aykoshop_conversation_examples WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 1",[v]);
      if(dup.rows.length && parseFloat(dup.rows[0].sim)>=0.93){
        await pool.query("UPDATE aykoshop_conversation_examples SET usage_count=COALESCE(usage_count,0)+1, last_used=NOW(), approved=true WHERE id=$1",[dup.rows[0].id]);
        return res.json({ ok:true, merged:true, behavior_id:dup.rows[0].id, sim:parseFloat(dup.rows[0].sim), uses:(parseInt(dup.rows[0].usage_count)||0)+1 });
      }
      const ins=await pool.query("INSERT INTO aykoshop_conversation_examples (category,customer_message,correct_reply,source,subscriber_id,approved,channel,entry_type,context_json,outcome,review_flag,embedding,usage_count) VALUES ('learning_inbox',$1,$2,$3,$4,true,$5,$6,'[]'::jsonb,'pending',false,$7::vector,1) RETURNING id",[cust.slice(0,500),reply.slice(0,1000),_src,String(b.subscriber_id||''),b.channel||null,_intent,v]);
      return res.json({ ok:true, merged:false, behavior_id:ins.rows[0].id });
    }
    // OpenAI/embeddings down → exact-text dedup fallback (never block learning on a provider outage)
    const dup2=await pool.query("SELECT id FROM aykoshop_conversation_examples WHERE correct_reply=$1 LIMIT 1",[reply.slice(0,1000)]);
    if(dup2.rows.length){ await pool.query("UPDATE aykoshop_conversation_examples SET usage_count=COALESCE(usage_count,0)+1, last_used=NOW(), approved=true WHERE id=$1",[dup2.rows[0].id]); return res.json({ok:true, merged:true, behavior_id:dup2.rows[0].id, no_embed:true}); }
    const ins2=await pool.query("INSERT INTO aykoshop_conversation_examples (category,customer_message,correct_reply,source,subscriber_id,approved,channel,entry_type,context_json,outcome,review_flag,usage_count) VALUES ('learning_inbox',$1,$2,$3,$4,true,$5,$6,'[]'::jsonb,'pending',false,1) RETURNING id",[cust.slice(0,500),reply.slice(0,1000),_src,String(b.subscriber_id||''),b.channel||null,_intent]);
    res.json({ ok:true, merged:false, behavior_id:ins2.rows[0].id, no_embed:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// BEHAVIOR LIBRARY — the learned rules (genericised), ranked by uses. Smart-dedup ⇒ each row = ONE behaviour with a uses count.
app.get('/api/learning/behaviors', async (req,res)=>{
  try{
    const lim=Math.min(parseInt(req.query.limit)||60,200);
    const r=await pool.query("SELECT id, customer_message, correct_reply, category, entry_type, objection_category, source, COALESCE(usage_count,0) uses, outcome, created_at, last_used FROM aykoshop_conversation_examples WHERE approved=true ORDER BY COALESCE(usage_count,0) DESC, created_at DESC LIMIT $1",[lim]);
    const st=await pool.query("SELECT count(*)::int total, COALESCE(SUM(usage_count),0)::int total_uses FROM aykoshop_conversation_examples WHERE approved=true");
    res.json({ behaviors:r.rows, stats:st.rows[0]||{} });
  }catch(e){ res.status(500).json({error:e.message}); }
});
// ==================== END LEARNING INBOX ====================

// ==================== INBOX CLASSIFICATION — manual override + learning capture ====================
// The category itself is computed CLIENT-SIDE (deterministic, free) from convo_state/service/stage/intervention.
// This endpoint only PERSISTS an operator's manual correction (session_data.manual_category) AND captures it as a
// genericised intent-classification training row → so the classifier/Hermes can learn the operator's labels over time.
app.post('/api/inbox/classify', async (req,res)=>{
  try{
    const b=req.body||{}; const sub=String(b.subscriber_id||''); const cat=String(b.category||'');
    if(!sub || ['buy','recharge','payment','support','question','human','none'].indexOf(cat)<0) return res.status(400).json({error:'bad input'});
    await pool.query("INSERT INTO aykoshop_profiles(subscriber_id,session_data) VALUES($1,jsonb_build_object('manual_category',$2::text)) ON CONFLICT(subscriber_id) DO UPDATE SET session_data=COALESCE(aykoshop_profiles.session_data,'{}')::jsonb || jsonb_build_object('manual_category',$2::text)",[sub,cat]);
    if(cat!=='none') try{ const lm=await pool.query("SELECT message FROM aykoshop_chat_history WHERE subscriber_id=$1 AND role='user' ORDER BY created_at DESC LIMIT 1",[sub]); const msg=_ocGenericize((lm.rows[0]||{}).message||''); if(msg && msg.length>2 && !_ocHasSensitive(msg)) await pool.query("INSERT INTO aykoshop_conversation_examples(category,customer_message,correct_reply,source,subscriber_id,approved,entry_type,outcome,review_flag,usage_count) VALUES('intent_classification',$1,$2,'dashboard_classify',$3,true,'classification','pending',false,1)",[msg.slice(0,500),cat,sub]); }catch(_e){}
    res.json({ok:true, category:cat});
  }catch(e){ res.status(500).json({error:e.message}); }
});
// ==================== END INBOX CLASSIFICATION ====================

// ==================== INBOX CLOSE (Done/Archive) — server-side, cross-device + reload durable (ManyChat parity) ====================
// Closing stamps session_data.inbox_closed_at=NOW(). /api/customers computes inbox_closed = (inbox_closed_at >= last INBOUND msg)
// → a NEW customer message AUTOMATICALLY reopens the chat (no write needed). Reopen clears the stamp (one sid, or all).
app.post('/api/inbox/close', async (req,res)=>{
  try{ const sub=String((req.body||{}).subscriber_id||''); if(!sub) return res.status(400).json({error:'subscriber_id required'});
    await pool.query("INSERT INTO aykoshop_profiles(subscriber_id,session_data) VALUES($1,jsonb_build_object('inbox_closed_at',to_jsonb(NOW()))) ON CONFLICT(subscriber_id) DO UPDATE SET session_data=COALESCE(aykoshop_profiles.session_data,'{}')::jsonb || jsonb_build_object('inbox_closed_at',to_jsonb(NOW()))",[sub]);
    res.json({ok:true, closed:true, subscriber_id:sub});
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/inbox/reopen', async (req,res)=>{
  try{ const b=req.body||{};
    if(b.all===true){ await pool.query("UPDATE aykoshop_profiles SET session_data=(COALESCE(session_data,'{}')::jsonb - 'inbox_closed_at') WHERE (session_data->>'inbox_closed_at') IS NOT NULL"); return res.json({ok:true, reopened:'all'}); }
    const sub=String(b.subscriber_id||''); if(!sub) return res.status(400).json({error:'subscriber_id or all required'});
    await pool.query("UPDATE aykoshop_profiles SET session_data=(COALESCE(session_data,'{}')::jsonb - 'inbox_closed_at') WHERE subscriber_id=$1",[sub]);
    res.json({ok:true, reopened:sub});
  }catch(e){ res.status(500).json({error:e.message}); }
});
// ==================== END INBOX CLOSE ====================
app.post('/api/inbox/mark-read', async (req,res)=>{
  try{
    const sub=String((req.body||{}).subscriber_id||'');
    if(!sub) return res.status(400).json({error:'subscriber_id required'});
    await pool.query(
      "UPDATE aykoshop_profiles SET session_data=jsonb_set(COALESCE(session_data,'{}')::jsonb,'{inbox_last_read_at}',to_jsonb(NOW()::text)) WHERE subscriber_id=$1",
      [sub]
    );
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});


// Persist an AI reply generated OUTSIDE the backend (the n8n image branch calls OpenAI directly + never writes chat_history) → keeps IMAGE-conversation history complete (role='assistant'). Light dedup: skip if the identical reply was saved in the last 2 min (n8n retries / double-fire safe).
app.post('/api/inbox/log-ai-reply', async (req,res)=>{
  try{ const b=req.body||{}; const sub=String(b.subscriber_id||''); const reply=String(b.reply||'').trim(); const img=String(b.image_url||'').trim();
    if(!sub || (!reply && !img)) return res.status(400).json({error:'subscriber_id + (reply or image_url) required'});
    let _si=false, _sr=false;
    // customer IMAGE turn (image arrives via n8n attachments, not in message → never reaches chat_history otherwise). Save role='user'; the _archiveSweep then re-hosts it permanently. Dedup within 5 min (message OR media_url, since the sweep rewrites both to our URL).
    if(/^https?:\/\/\S+$/.test(img)){
      const _di=await pool.query("SELECT 1 FROM aykoshop_chat_history WHERE subscriber_id=$1 AND role='user' AND (message=$2 OR media_url=$2) AND created_at > NOW() - interval '5 minutes' LIMIT 1",[sub, img.slice(0,1500)]);
      if(!_di.rows.length){ await pool.query("INSERT INTO aykoshop_chat_history (subscriber_id, role, message, media_url) VALUES ($1,'user',$2,$2)",[sub, img.slice(0,1500)]); _si=true; }
    }
    if(reply){
      const _dr=await pool.query("SELECT 1 FROM aykoshop_chat_history WHERE subscriber_id=$1 AND role='assistant' AND message=$2 AND created_at > NOW() - interval '2 minutes' LIMIT 1",[sub, reply.slice(0,2000)]);
      if(!_dr.rows.length){ await pool.query("INSERT INTO aykoshop_chat_history (subscriber_id, role, message) VALUES ($1,'assistant',$2)",[sub, reply.slice(0,2000)]); _sr=true; }
    }
    // realtime: push the AI reply to the dashboard (append the assistant bubble + mark the chat answered → card goes dark) — only on a NEW save (no double-append on n8n retries)
    if(_sr) try{ _broadcast('ai_reply', { subscriber_id:sub, message:reply, image_url:(/^https?:\/\/\S+$/.test(img)?img:null) }); }catch(_e){}
    res.json({ok:true, saved_image:_si, saved_reply:_sr});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/telegram/webhook', async (req,res)=>{
  res.json({ok:true});
  try{
    const m=req.body&&req.body.message; if(!m||!m.text)return;
    const chatId=String(m.chat.id);
    if(!HTG_ADMINS.includes(chatId)) return;
    const text=String(m.text).trim(); let reply;
    if(m.reply_to_message && m.reply_to_message.message_id){
      const _iv=await pool.query("SELECT * FROM aykoshop_interventions WHERE tg_message_id=$1 ORDER BY id DESC LIMIT 1",[String(m.reply_to_message.message_id)]).catch(()=>({rows:[]}));
      if(_iv.rows.length){ const _r=await _ocCapture(_iv.rows[0], text);
        let _c; if(_r.ok)_c='✅ تسجّل كتعلّم بشري (shadow)\nنية: '+_r.intent+' · نتيجة: '+_r.outcome+' · آخر '+_r.ctx_n+' رسائل\n📝 مجنرَك: '+_r.generic+'\n⚠️ shadow — ماتصيفطش للزبون';
        else if(_r.skip)_c='ℹ️ ماتسجلاتش: '+_r.skip; else _c='⚠️ خطأ: '+(_r.error||'?');
        await hTgSend(chatId, _c); return; }
    }
    if(text.startsWith('/')){ const cmd=text.split(/\s+/)[0].toLowerCase().replace(/@.*$/,''); reply=await hermesCommand(cmd,chatId); if(reply==null) reply="أمر غير معروف. اكتب /help للأوامر أو اطرح سؤالاً بلغتك."; }
    else { reply=await hermesAnswer(text,chatId); }
    await hTgSend(chatId, reply);
  }catch(e){ console.error('[telegram webhook]',e.message); }
});
app.post('/hermes/ask', async (req,res)=>{
  try{ const q=String((req.body&&req.body.question)||'').trim(); if(!q)return res.status(400).json({error:'question required'}); const a=await hermesAnswer(q,(req.body&&req.body.chat_id)||'dashboard'); res.json({answer:a}); }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/hermes/snapshot', async (req,res)=>{ try{ res.json(await hermesSnapshot()); }catch(e){ res.status(500).json({error:e.message}); } });

// ===================== Intelligence + Health Center + Event-driven Hermes =====================
let _hermesDebounce=null;
function triggerHermesRecompute(){ if(_hermesDebounce)return; _hermesDebounce=setTimeout(async()=>{ _hermesDebounce=null; try{ const hermes=require('./hermes'); await hermes.computeAll(pool); }catch(e){ console.error('[hermes recompute]',e.message); } }, 4000); }

// Transparent, explainable purchase-probability (0-100) + priority tier
function purchaseProbability(c){
  const s=c.session_data||{}; const factors=[];
  const base=({paid:100,hot:55,warm:42,interested:32,browsing:18,new:12,lost:6})[c.stage]||15;
  let p=base; factors.push('مرحلة '+(c.stage||'?')+' ('+base+')');
  const hrs = c.last_seen ? (Date.now()-new Date(c.last_seen).getTime())/3600000 : 999;
  const rec = hrs<1?20:hrs<6?12:hrs<24?6:hrs<72?0:-10; p+=rec; if(rec) factors.push((rec>0?'+':'')+rec+' حداثة');
  const msgs=c.total_messages||0; const eng=msgs>=8?12:msgs>=4?6:0; p+=eng; if(eng) factors.push('+'+eng+' تفاعل');
  if(c.interested_in){ p+=8; factors.push('+8 اهتمام محدد'); }
  if((s.last_budget&&s.last_budget>0)||s.asked_for_budget){ p+=10; factors.push('+10 إشارة ميزانية'); }
  const rej=s.rejection_count||0; if(rej){ const d=Math.min(rej*5,15); p-=d; factors.push('-'+d+' اعتراضات'); }
  p=Math.max(0,Math.min(100,Math.round(p)));
  let tier,emoji,label;
  if(p>=70&&hrs<24){ tier='buy_now'; emoji='🥇'; label='Buy Now'; }
  else if(p>=45){ tier='follow_today'; emoji='🥈'; label='Follow Today'; }
  else if(p>=25){ tier='warm'; emoji='🥉'; label='Warm Lead'; }
  else { tier='cold'; emoji='⚫'; label='Cold Lead'; }
  return { probability:p, tier, emoji, label, reason:factors.join(' · ') };
}
app.get('/api/intelligence/customers', async (req,res)=>{ try{
  const r=await pool.query("SELECT subscriber_id,customer_name,channel,stage,interested_in,total_messages,last_seen,session_data,lifetime_value FROM aykoshop_profiles ORDER BY last_seen DESC NULLS LAST LIMIT 300");
  const out=r.rows.map(c=>{ const pp=purchaseProbability(c); return { subscriber_id:c.subscriber_id, customer_name:c.customer_name, channel:c.channel, stage:c.stage, interested_in:c.interested_in, total_messages:c.total_messages, last_seen:c.last_seen, lifetime_value:c.lifetime_value, probability:pp.probability, tier:pp.tier, emoji:pp.emoji, label:pp.label, reason:pp.reason }; });
  out.sort((a,b)=>b.probability-a.probability);
  res.json({ customers:out });
}catch(e){ res.status(500).json({error:e.message}); } });
app.get('/hermes/priority-queue', async (req,res)=>{ try{
  const r=await pool.query("SELECT subscriber_id,customer_name,channel,stage,interested_in,total_messages,last_seen,session_data FROM aykoshop_profiles WHERE (stage IS NULL OR stage NOT IN ('paid','lost')) ORDER BY last_seen DESC NULLS LAST LIMIT 200");
  const tiers={buy_now:[],follow_today:[],warm:[],cold:[]};
  r.rows.forEach(c=>{ const pp=purchaseProbability(c); tiers[pp.tier].push({ subscriber_id:c.subscriber_id, customer_name:c.customer_name, channel:c.channel, interested_in:c.interested_in, probability:pp.probability, reason:pp.reason }); });
  Object.keys(tiers).forEach(k=>tiers[k].sort((a,b)=>b.probability-a.probability));
  res.json({ tiers, counts:{ buy_now:tiers.buy_now.length, follow_today:tiers.follow_today.length, warm:tiers.warm.length, cold:tiers.cold.length } });
}catch(e){ res.status(500).json({error:e.message}); } });
app.post('/hermes/suggest-reply', async (req,res)=>{ try{
  const sid=req.body&&req.body.subscriber_id; if(!sid) return res.status(400).json({error:'subscriber_id required'});
  const [prof,hist,prods]=await Promise.all([
    pool.query("SELECT customer_name,stage,interested_in FROM aykoshop_profiles WHERE subscriber_id=$1",[sid]),
    pool.query("SELECT role,message FROM aykoshop_chat_history WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 8",[sid]),
    pool.query("SELECT product_name,price FROM aykoshop_products WHERE status='available' LIMIT 12")
  ]);
  const p=prof.rows[0]||{}; const h=hist.rows.reverse();
  const sys="أنت Hermes، مساعد مبيعات AykoShop. اقترح ردّاً واحداً قصيراً (جملتين كحد أقصى) بالدارجة المغربية، احترافياً ومقنعاً يقرّب الزبون للشراء بناءً على سياق المحادثة. المنتجات المتاحة: "+prods.rows.map(x=>x.product_name+' ب'+x.price).join('، ')+". لا روابط. أعطِ نص الردّ المقترح فقط بلا مقدمات أو شرح.";
  const messages=[{role:'system',content:sys}].concat(h.map(m=>({role:(m.role==='user'?'user':'assistant'),content:m.message||''})));
  if(!circuitAllows('openai')) return res.json({ suggested_reply:'⚠️ محرّك الذكاء متوقّف مؤقتاً (الدائرة مفتوحة) — جرّب بعد قليل أو اكتب الردّ يدوياً.', customer:p.customer_name||null, circuit_open:true });
  const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':HTG_OPENAI(),'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o',max_tokens:160,temperature:0.6,messages})});
  circuitRecord('openai', r.ok, 'suggestReply HTTP '+r.status);
  const j=await r.json(); const reply=(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||('تعذّر الاقتراح: '+(j.error?j.error.message:'no response'));
  res.json({ suggested_reply:reply, customer:p.customer_name||null });
}catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/intelligence/sales', async (req,res)=>{ try{
  const [demand,loss,prods,atRisk,bt,ordCmp]=await Promise.all([
    pool.query("SELECT category, count(*)::int n FROM aykoshop_warehouse WHERE created_at>NOW()-INTERVAL '14 days' AND category IS NOT NULL GROUP BY category ORDER BY n DESC LIMIT 6").catch(()=>({rows:[]})),
    pool.query("SELECT reason_code, count(*)::int n FROM aykoshop_interventions GROUP BY reason_code ORDER BY n DESC LIMIT 6").catch(()=>({rows:[]})),
    pool.query("SELECT product_name, count(*)::int orders, count(*) FILTER (WHERE paid_at IS NOT NULL)::int paid FROM aykoshop_orders GROUP BY product_name ORDER BY orders DESC LIMIT 8").catch(()=>({rows:[]})),
    pool.query("SELECT count(*)::int n FROM aykoshop_profiles WHERE stage IN ('hot','warm') AND last_seen < NOW()-INTERVAL '24 hours' AND last_seen > NOW()-INTERVAL '7 days'").catch(()=>({rows:[{n:0}]})),
    pool.query("SELECT EXTRACT(HOUR FROM created_at)::int h, count(*)::int n FROM aykoshop_events WHERE type='customer' GROUP BY h ORDER BY n DESC LIMIT 3").catch(()=>({rows:[]})),
    pool.query("SELECT count(*) FILTER (WHERE created_at::date=CURRENT_DATE)::int today, count(*) FILTER (WHERE created_at::date=CURRENT_DATE-1)::int yesterday FROM aykoshop_orders").catch(()=>({rows:[{today:0,yesterday:0}]}))
  ]);
  res.json({ top_demand:demand.rows, loss_reasons:loss.rows, products:prods.rows, at_risk_count:atRisk.rows[0].n, best_hours:bt.rows.map(x=>x.h), orders_today:ordCmp.rows[0].today, orders_yesterday:ordCmp.rows[0].yesterday });
}catch(e){ res.status(500).json({error:e.message}); } });
// Unified Health Center — live probes with latency + weighted health score
// ===================== Circuit Breaker (provider health -> active fallback) =====================
const CB_THRESHOLD=3, CB_COOLDOWN_MS=60000;
const _circuit={}; // provider -> {state,fail_count,opened_at,cooldown_until,last_ok_at,last_fail_at,last_detail}
function _cb(p){ if(!_circuit[p])_circuit[p]={state:'closed',fail_count:0,opened_at:null,cooldown_until:null,last_ok_at:null,last_fail_at:null,last_detail:null}; return _circuit[p]; }
function circuitAllows(provider){ const c=_cb(provider); if(c.state==='open'){ if(c.cooldown_until&&Date.now()>=new Date(c.cooldown_until).getTime()){ c.state='half_open'; return true; } return false; } return true; }
function circuitRecord(provider, ok, detail){
  const c=_cb(provider); const now=new Date().toISOString(); let _trans=false;
  if(ok){ const wasOpen=c.state!=='closed'; c.state='closed'; c.fail_count=0; c.opened_at=null; c.cooldown_until=null; c.last_ok_at=now; c.last_detail=detail||null; if(wasOpen){_trans=true;try{_broadcast('circuit',{provider,state:'closed',detail});}catch(e){}} }
  else { c.fail_count++; c.last_fail_at=now; c.last_detail=detail||null; if(c.fail_count>=CB_THRESHOLD){ const wasClosed=c.state==='closed'; c.state='open'; c.opened_at=c.opened_at||now; c.cooldown_until=new Date(Date.now()+CB_COOLDOWN_MS).toISOString(); if(wasClosed){_trans=true;try{_broadcast('circuit',{provider,state:'open',detail,severity:'critical'});}catch(e){}} } }
  pool.query("INSERT INTO aykoshop_circuit_state (provider,state,fail_count,opened_at,cooldown_until,last_ok_at,last_fail_at,last_detail,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT (provider) DO UPDATE SET state=$2,fail_count=$3,opened_at=$4,cooldown_until=$5,last_ok_at=$6,last_fail_at=$7,last_detail=$8,updated_at=NOW()",[provider,c.state,c.fail_count,c.opened_at,c.cooldown_until,c.last_ok_at,c.last_fail_at,c.last_detail]).catch(()=>{});
  if(_trans && (provider==='openai'||provider==='anthropic')){ _maybeAutoEmergency().catch(()=>{}); }
}
// Auto Emergency / Auto Recovery — driven by seller-circuit transitions (anti-spam via emergency flags)
async function _maybeAutoEmergency(){
  try{
    const oaOpen=_cb('openai').state==='open', anOpen=_cb('anthropic').state==='open'; const bothDown=oaOpen&&anOpen;
    const cfg=await getAiConfig();
    if(bothDown && !cfg.emergency_mode){
      const nx=Object.assign({},cfg,{emergency_mode:true,_emergency_auto:true});
      await pool.query("INSERT INTO aykoshop_settings(key,value) VALUES('ai_config',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[JSON.stringify(nx)]);
      try{_broadcast('ai_config',nx);}catch(e){}
      try{_broadcast('circuit',{provider:'AUTO-EMERGENCY',state:'open',detail:'GPT-4o + Claude down',severity:'critical'});}catch(e){}
      hTgSend('6990881479','\u{1F534} AUTO-EMERGENCY مُفعّل تلقائياً — GPT-4o و Claude بجوج طاحو (circuit open). كل المحادثات \u2190 رد احتياطي + تدخّل بشري. '+HDASH);
    } else if(!bothDown && cfg.emergency_mode && cfg._emergency_auto){
      const nx=Object.assign({},cfg,{emergency_mode:false,_emergency_auto:false});
      await pool.query("INSERT INTO aykoshop_settings(key,value) VALUES('ai_config',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[JSON.stringify(nx)]);
      let rc=0; try{ const rr=await pool.query("DELETE FROM aykoshop_stopped_chats WHERE reason='emergency'"); rc=rr.rowCount||0; }catch(e){}
      try{_broadcast('ai_config',nx);}catch(e){}
      try{_broadcast('circuit',{provider:'AUTO-RECOVERY',state:'closed',detail:'service recovered'});}catch(e){}
      hTgSend('6990881479','\u{1F7E2} AUTO-RECOVERY — رجعات الخدمة ('+(!oaOpen?'GPT-4o':'Claude')+'). الطوارئ مُطفأة + استئناف '+rc+' محادثة (emergency فقط). حالات الدفع ماتمسّاش. '+HDASH);
    }
  }catch(e){}
}
function circuitSnapshot(){ return Object.keys(_circuit).map(p=>Object.assign({provider:p},_circuit[p])); }
pool.query("SELECT * FROM aykoshop_circuit_state").then(r=>{ r.rows.forEach(x=>{ _circuit[x.provider]={state:x.state,fail_count:x.fail_count,opened_at:x.opened_at,cooldown_until:x.cooldown_until,last_ok_at:x.last_ok_at,last_fail_at:x.last_fail_at,last_detail:x.last_detail}; }); }).catch(()=>{});
app.get('/api/ops/circuit', async (req,res)=>{ try{ const r=await pool.query("SELECT * FROM aykoshop_circuit_state ORDER BY provider"); res.json({ memory:circuitSnapshot(), persisted:r.rows }); }catch(e){ res.json({ memory:circuitSnapshot(), persisted:[] }); } });
app.post('/api/ops/circuit/:provider/reset', async (req,res)=>{ try{ const p=req.params.provider; const c=_cb(p); c.state='closed'; c.fail_count=0; c.opened_at=null; c.cooldown_until=null; c.last_ok_at=new Date().toISOString(); c.last_detail='manual reset'; await pool.query("UPDATE aykoshop_circuit_state SET state='closed',fail_count=0,opened_at=NULL,cooldown_until=NULL,last_ok_at=NOW(),last_detail='manual reset',updated_at=NOW() WHERE provider=$1",[p]).catch(()=>{}); res.json({ok:true, provider:p, state:'closed'}); }catch(e){ res.status(500).json({error:e.message}); } });

// ===================== Outbox Worker (guaranteed delivery -> Zero Message Loss) =====================
const MANYCHAT_SEND_KEY = 'Bearer ' + (_mcKey() || '');
const OUTBOX_WORKER_ON = (process.env.OUTBOX_WORKER || 'off') === 'on';
const OUTBOX_TICK_MS = parseInt(process.env.OUTBOX_TICK_MS) || 20000;
async function sendViaManyChat(row){
  const msgs=[];
  if(row.image_url && String(row.image_url).startsWith('http')) msgs.push({type:'image',url:row.image_url});
  msgs.push({type:'text',text:row.reply_text||''});
  const r=await fetch('https://api.manychat.com/fb/sending/sendContent',{method:'POST',headers:{'Authorization':MANYCHAT_SEND_KEY,'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:row.subscriber_id,data:{version:'v2',content:{messages:msgs}}}),signal:AbortSignal.timeout(15000)});
  let j={}; try{ j=await r.json(); }catch(e){}
  if(!r.ok || (j && j.status && j.status!=='success')) throw new Error('manychat HTTP '+r.status+' '+JSON.stringify(j).slice(0,140));
  return j;
}
async function drainOutbox(){
  const client=await pool.connect(); let processed=0;
  try{
    await client.query('BEGIN');
    const due=await client.query("SELECT * FROM aykoshop_outbox WHERE status IN ('pending','failed') AND next_attempt_at<=NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10");
    for(const row of due.rows){
      const _stp=await client.query("SELECT reason FROM aykoshop_stopped_chats WHERE subscriber_id=$1 LIMIT 1",[row.subscriber_id]);
      if(_stp.rows.length){ await client.query("UPDATE aykoshop_outbox SET status='held', last_error=$2 WHERE id=$1",[row.id,'held: chat under '+_stp.rows[0].reason]); continue; }
      if(!circuitAllows('manychat')) continue;
      try{
        await sendViaManyChat(row);
        await client.query("UPDATE aykoshop_outbox SET status='sent', sent_at=NOW(), attempts=attempts+1, last_error=NULL WHERE id=$1",[row.id]);
        circuitRecord('manychat', true, 'outbox ok'); processed++;
      }catch(e){
        const att=(row.attempts||0)+1; const msg=String(e.message||e).slice(0,300);
        if(att>=(row.max_attempts||6)){
          await client.query("UPDATE aykoshop_outbox SET status='dead', attempts=$2, last_error=$3 WHERE id=$1",[row.id,att,msg]);
          try{_broadcast('outbox_dead',{id:row.id,subscriber_id:row.subscriber_id,error:msg,severity:'critical'});}catch(_){}
          try{ HTG_ADMINS.forEach(a=>hTgSend(a,'⛔ <b>Outbox DEAD</b>\nتعذّر تسليم ردّ للزبون <code>'+row.subscriber_id+'</code> بعد '+att+' محاولات.\nالخطأ: '+msg+'\nيتطلّب تدخّلاً يدوياً.')); }catch(_){}
        } else {
          const backoff=Math.min(60*Math.pow(2,att-1),900);
          await client.query("UPDATE aykoshop_outbox SET status='failed', attempts=$2, last_error=$3, next_attempt_at=NOW()+($4||' seconds')::interval WHERE id=$1",[row.id,att,msg,String(backoff)]);
        }
        circuitRecord('manychat', false, msg.slice(0,90));
      }
    }
    await client.query('COMMIT');
  }catch(e){ try{ await client.query('ROLLBACK'); }catch(_){} }
  finally{ client.release(); }
  return processed;
}
if(OUTBOX_WORKER_ON){ setInterval(()=>{ drainOutbox().catch(()=>{}); }, OUTBOX_TICK_MS); console.log('[outbox] worker ON tick='+OUTBOX_TICK_MS+'ms'); } else { console.log('[outbox] worker OFF (set OUTBOX_WORKER=on)'); }
app.get('/api/ops/outbox/stats', asyncHandler(async (req,res)=>{ const r=await pool.query("SELECT status,count(*)::int n FROM aykoshop_outbox GROUP BY status"); const by={}; r.rows.forEach(x=>by[x.status]=x.n); res.json({by_status:by, pending:by.pending||0, failed:by.failed||0, sent:by.sent||0, dead:by.dead||0, worker:OUTBOX_WORKER_ON, tick_ms:OUTBOX_TICK_MS}); }));
app.get('/api/ops/outbox', asyncHandler(async (req,res)=>{ const lim=Math.min(parseInt(req.query.limit)||100,500); const st=req.query.status; const r=await pool.query("SELECT * FROM aykoshop_outbox "+(st?"WHERE status=$1 ":"")+"ORDER BY created_at DESC LIMIT "+lim, st?[st]:[]); res.json({outbox:r.rows}); }));
app.post('/api/ops/outbox/drain', async (req,res)=>{ try{ const n=await drainOutbox(); res.json({ok:true, sent:n}); }catch(e){ res.status(500).json({error:e.message}); } });
app.patch('/api/ops/outbox/:id/requeue', async (req,res)=>{ try{ const r=await pool.query("UPDATE aykoshop_outbox SET status='pending', attempts=0, next_attempt_at=NOW(), last_error=NULL WHERE id=$1 RETURNING *",[req.params.id]); res.json(r.rows[0]||{}); }catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/ops/outbox/retry-all', async (req,res)=>{ try{ const r=await pool.query("UPDATE aykoshop_outbox SET status='pending', attempts=0, next_attempt_at=NOW(), last_error=NULL WHERE status IN ('failed','dead','held') RETURNING id"); const n=await drainOutbox().catch(()=>0); res.json({ok:true, requeued:r.rowCount, drained:n}); }catch(e){ res.status(500).json({error:e.message}); } });

// ===================== Inbox/Outbox ingest API (consumed by n8n thin nodes) =====================
const _crypto = require('crypto');
app.post('/api/inbox/ingest', async (req,res)=>{ try{
  const b=req.body||{}; const sub=String(b.subscriber_id||''); const msg=String(b.message||'');
  if(!sub) return res.status(400).json({error:'subscriber_id required', is_new:true});
  const idem = b.message_id ? ('mid:'+b.message_id)
    : (sub+'|'+_crypto.createHash('md5').update(msg).digest('hex')+'|'+Math.floor(Date.now()/120000));
  const r=await pool.query(
    "WITH ins AS (INSERT INTO aykoshop_inbox(idem_key,subscriber_id,channel,message,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(idem_key) DO NOTHING RETURNING id) "+
    "SELECT COALESCE((SELECT id FROM ins),(SELECT id FROM aykoshop_inbox WHERE idem_key=$1)) AS inbox_id, (SELECT id FROM ins) IS NOT NULL AS is_new",
    [idem, sub, b.channel||null, msg.slice(0,2000), b.payload||null]);
  const _isNew=r.rows[0].is_new, _inboxId=r.rows[0].inbox_id;
  // Bug#4 fix: during Human Takeover the n8n active path (Save Chat History) is skipped; persist
  // the customer's message here + broadcast live so the operator sees it (WhatsApp-like). No dup:
  // on the active path this is skipped (not stopped) and Save Chat History records it instead.
  if(_isNew && msg){ try{
    const _stp=await pool.query("SELECT 1 FROM aykoshop_stopped_chats WHERE subscriber_id=$1 LIMIT 1",[sub]);
    if(_stp.rows.length){
      // Bug fix: clear ManyChat ai_reply/ai_image2 so ManyChat cannot send a STALE cached reply during takeover.
      const _mck='Bearer ' + (_mcKey() || '');
      for(const _fn of ['ai_reply','ai_image2']){ try{ await fetch('https://api.manychat.com/fb/subscriber/setCustomFieldByName',{method:'POST',headers:{'Authorization':_mck,'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:sub,field_name:_fn,field_value:null}),signal:AbortSignal.timeout(5000)}); }catch(_e){} }
      await pool.query("INSERT INTO aykoshop_chat_history (subscriber_id, role, message) VALUES ($1,'user',$2)",[sub, msg.slice(0, /^https?:\/\/\S+$/.test(msg)?1500:500)]);
      await pool.query("UPDATE aykoshop_inbox SET status='processed', processed_at=NOW() WHERE id=$1",[_inboxId]).catch(()=>{});
    }
    // Media archival is handled by the decoupled _archiveSweep (every 90s) → no dup with n8n's Save Chat History, no ingest-path latency. ALWAYS broadcast live (active AND stopped) so the inbox updates incrementally — WhatsApp-style.
    const _cn=(b.payload && (b.payload.customer_name||b.payload.first_name))||null;
    const _isUrlMsg=/^https?:\/\/\S+$/.test(msg);
    _broadcast('customer_event', { type:'customer', subscriber_id:sub, customer_name:_cn, channel:b.channel||null, message:_isUrlMsg?'📷 وسائط':msg.slice(0,200), media_url:_isUrlMsg?msg.slice(0,1500):null, title:'رسالة الزبون', ts:new Date().toISOString() });
  }catch(_e){} }
  // profile-sync root fix 2026-07-02: keep profiles.channel matching the live message channel
  // (badge was frozen at first insert / NULL) and resolve real names — IG flows send literal
  // {{first_name}}; ManyChat getInfo exposes ig_username. Fire-and-forget: no ingest latency.
  (async()=>{ try{
    const _chRaw=String(b.channel||'').trim().toLowerCase();
    const _ch=(['whatsapp','messenger','instagram','telegram'].indexOf(_chRaw)>=0)?_chRaw:'';
    let _nm=String((b.payload&&(b.payload.customer_name||b.payload.first_name))||'').trim();
    if(_nm.indexOf('{')>=0||_nm==='\u0632\u0628\u0648\u0646') _nm='';
    const _pr=await pool.query("SELECT customer_name, channel FROM aykoshop_profiles WHERE subscriber_id=$1",[sub]);
    const _cur=_pr.rows[0];
    const _badCur=!_cur||!_cur.customer_name||_cur.customer_name==='\u0632\u0628\u0648\u0646'||String(_cur.customer_name).indexOf('{')>=0;
    if(!_nm && _badCur && /^\d{5,}$/.test(sub)){
      try{
        const _r=await fetch('https://api.manychat.com/fb/subscriber/getInfo?subscriber_id='+encodeURIComponent(sub),{headers:{'Authorization':'Bearer '+(_mcKey()||'')},signal:AbortSignal.timeout(6000)});
        const _j=await _r.json().catch(()=>({})); const _d=(_j&&_j.data)||{};
        _nm=String(_d.name||(((_d.first_name||'')+' '+(_d.last_name||'')).trim())||_d.ig_username||_d.whatsapp_username||'').trim();
        if(_nm.indexOf('{')>=0) _nm='';
      }catch(_e){}
    }
    if(!_cur){
      if(_nm||_ch) await pool.query("INSERT INTO aykoshop_profiles (subscriber_id, customer_name, channel) VALUES ($1,$2,$3) ON CONFLICT (subscriber_id) DO NOTHING",[sub,_nm||'\u0632\u0628\u0648\u0646',_ch||null]);
    } else {
      const _sets=[]; const _vals=[sub]; let _i=2;
      if(_nm&&_badCur){ _sets.push('customer_name=$'+_i); _vals.push(_nm.slice(0,80)); _i++; }
      if(_ch&&_cur.channel!==_ch){ _sets.push('channel=$'+_i); _vals.push(_ch); _i++; }
      if(_sets.length) await pool.query('UPDATE aykoshop_profiles SET '+_sets.join(', ')+' WHERE subscriber_id=$1',_vals);
    }
  }catch(_e){} })();
  res.json({ inbox_id:_inboxId, is_new:_isNew, idem_key:idem });
}catch(e){ res.status(500).json({error:e.message, is_new:true}); } });
app.post('/api/outbox/enqueue', async (req,res)=>{ try{
  const b=req.body||{}; if(!b.inbox_id) return res.status(400).json({error:'inbox_id required'});
  const status=(b.status==='sent')?'sent':'pending';
  const r=await pool.query(
    "INSERT INTO aykoshop_outbox(inbox_id,subscriber_id,channel,reply_text,image_url,status,sent_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(inbox_id) DO NOTHING RETURNING id,status",
    [b.inbox_id, b.subscriber_id||null, b.channel||null, b.reply_text||null, b.image_url||null, status, status==='sent'?new Date():null]);
  await pool.query("UPDATE aykoshop_inbox SET status='processed', processed_at=NOW() WHERE id=$1",[b.inbox_id]).catch(()=>{});
  res.json({ outbox_id:(r.rows[0]&&r.rows[0].id)||null, status:(r.rows[0]&&r.rows[0].status)||'exists', queued:!!r.rows.length });
}catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/outbox/mark-sent', async (req,res)=>{ try{
  const b=req.body||{}; if(!b.inbox_id) return res.json({ok:false,reason:'no inbox_id'});
  if(b.delivered===false) return res.json({ok:true, marked:false});
  const r=await pool.query("UPDATE aykoshop_outbox SET status='sent', sent_at=NOW() WHERE inbox_id=$1 AND status='pending' RETURNING id",[b.inbox_id]);
  res.json({ ok:true, marked:r.rows.length>0 });
}catch(e){ res.status(500).json({error:e.message}); } });

// ===================== Deposit System (special orders) =====================
app.get('/api/deposits/tiers', async (req,res)=>{ try{ const r=await pool.query("SELECT * FROM aykoshop_deposit_tiers ORDER BY min_amount"); res.json({tiers:r.rows}); }catch(e){res.status(500).json({error:e.message});} });
app.get('/api/deposits/compute', async (req,res)=>{ try{ const b=parseFloat(req.query.budget)||0; const r=await pool.query("SELECT deposit_amount FROM aykoshop_deposit_tiers WHERE $1>=min_amount AND $1<=max_amount ORDER BY min_amount LIMIT 1",[b]); res.json({budget:b, deposit:(r.rows[0]?Number(r.rows[0].deposit_amount):null)}); }catch(e){res.status(500).json({error:e.message});} });
app.get('/api/deposits', async (req,res)=>{ try{ const r=await pool.query("SELECT * FROM aykoshop_deposits ORDER BY created_at DESC LIMIT 200"); res.json({deposits:r.rows}); }catch(e){res.status(500).json({error:e.message});} });
app.get('/api/deposits/stats', async (req,res)=>{ try{ const r=await pool.query("SELECT status,count(*)::int n,COALESCE(SUM(deposit_amount),0) val FROM aykoshop_deposits GROUP BY status"); const by={}; let pv=0; r.rows.forEach(x=>{by[x.status]=x.n; if(x.status==='pending')pv=Number(x.val)||0;}); res.json({by_status:by,pending:by.pending||0,paid:by.paid||0,pending_value:pv}); }catch(e){res.status(500).json({error:e.message});} });
app.post('/api/deposits', async (req,res)=>{ try{ const b=req.body||{}; const r=await pool.query("INSERT INTO aykoshop_deposits (subscriber_id,customer_name,channel,requested_product,budget,deposit_amount,status) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *",[b.subscriber_id||null,b.customer_name||null,b.channel||null,b.requested_product||null,b.budget||null,b.deposit_amount||null]); res.json(r.rows[0]); }catch(e){res.status(500).json({error:e.message});} });
app.patch('/api/deposits/tiers/:id', async (req,res)=>{ try{ const b=req.body||{}; const r=await pool.query("UPDATE aykoshop_deposit_tiers SET min_amount=COALESCE($2,min_amount),max_amount=COALESCE($3,max_amount),deposit_amount=COALESCE($4,deposit_amount) WHERE id=$1 RETURNING *",[req.params.id,b.min_amount,b.max_amount,b.deposit_amount]); res.json(r.rows[0]||{}); }catch(e){res.status(500).json({error:e.message});} });
app.patch('/api/deposits/:id', async (req,res)=>{ try{ const b=req.body||{}; const r=await pool.query("UPDATE aykoshop_deposits SET status=COALESCE($2,status) WHERE id=$1 RETURNING *",[req.params.id,b.status]); res.json(r.rows[0]||{}); }catch(e){res.status(500).json({error:e.message});} });

// ===================== Image Logs (GPT-4o Vision) =====================
app.post('/api/image-logs', async (req,res)=>{ try{ const b=req.body||{}; const r=await pool.query("INSERT INTO aykoshop_image_logs (subscriber_id,customer_name,channel,image_url,analysis_type,is_payment,found_match,matched_product,ai_reply) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",[b.subscriber_id||null,b.customer_name||null,b.channel||null,b.image_url||null,b.analysis_type||null,!!b.is_payment,(b.found_match==null?null:!!b.found_match),b.matched_product||null,b.ai_reply?String(b.ai_reply).slice(0,500):null]); res.json(r.rows[0]); }catch(e){res.status(500).json({error:e.message});} });
app.get('/api/image-logs', async (req,res)=>{ try{ const r=await pool.query("SELECT * FROM aykoshop_image_logs ORDER BY created_at DESC LIMIT 200"); res.json({logs:r.rows}); }catch(e){res.status(500).json({error:e.message});} });
app.get('/api/image-logs/stats', async (req,res)=>{ try{ const r=await pool.query("SELECT analysis_type,count(*)::int n FROM aykoshop_image_logs GROUP BY analysis_type"); const by={}; let tot=0,pay=0; r.rows.forEach(x=>{by[x.analysis_type||'unknown']=x.n; tot+=x.n;}); const p=await pool.query("SELECT count(*)::int n FROM aykoshop_image_logs WHERE is_payment=true"); pay=(p.rows[0]||{}).n||0; res.json({by_type:by,total:tot,payments:pay}); }catch(e){res.status(500).json({error:e.message});} });

// ===================== AI Provider Layer (Failover: OpenAI primary, Claude fallback) =====================
const _fsAI = require('fs');
const _kmCrypto = require('crypto');
let _masterKey = null;
try { const _mk = _fsAI.readFileSync('/root/.ayko_master_key','utf8').trim(); if(/^[0-9a-fA-F]{64}$/.test(_mk)) _masterKey = Buffer.from(_mk,'hex'); } catch(_e) {}
function _encSecret(v){ try{ if(!_masterKey || !v || typeof v!=='string' || v.indexOf('enc:v1:')===0) return v; const iv=_kmCrypto.randomBytes(12); const c=_kmCrypto.createCipheriv('aes-256-gcm',_masterKey,iv); const ct=Buffer.concat([c.update(v,'utf8'),c.final()]); const tag=c.getAuthTag(); return 'enc:v1:'+iv.toString('base64')+':'+tag.toString('base64')+':'+ct.toString('base64'); }catch(_e){ return v; } }
function _decSecret(v){ try{ if(typeof v!=='string' || v.indexOf('enc:v1:')!==0) return v; if(!_masterKey){ console.error('[keys] enc secret but no master key'); return ''; } const p=v.split(':'); const iv=Buffer.from(p[2],'base64'); const tag=Buffer.from(p[3],'base64'); const ct=Buffer.from(p[4],'base64'); const d=_kmCrypto.createDecipheriv('aes-256-gcm',_masterKey,iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct),d.final()]).toString('utf8'); }catch(_e){ console.error('[keys] decrypt fail',_e.message); return ''; } }
let _aiSecrets = {};
try { _aiSecrets = JSON.parse(_fsAI.readFileSync('/var/www/backend/.ai-secrets.json','utf8')); } catch(e) { console.error('[ai] secrets load fail', e.message); }
try{ for(const _sk of Object.keys(_aiSecrets)){ _aiSecrets[_sk]=_decSecret(_aiSecrets[_sk]); } }catch(_e){ console.error('[keys] decrypt-load fail',_e.message); }
let _OPENAI_KEY = (_aiSecrets.openai || process.env.OPENAI_API_KEY || '').replace(/^Bearer /,'');
let _ANTHROPIC_KEY = _aiSecrets.anthropic || process.env.ANTHROPIC_API_KEY || '';
const AI_DEFAULTS = { primary:'openai', fallback:'anthropic', emergency_mode:false, providers:{ openai:true, anthropic:true, mini:true, gemini:false, vision:true }, models:{ openai:'gpt-4o', anthropic:'claude-sonnet-4-6' }, roles:{ sales:'openai', failover:'anthropic', intent:'mini', support:'openai', vision:'openai' }, profit_router:true, mini_classifier:true, gemini_classify:true, product_search:true };
const AI_COST={ 'gpt-4o':{in:2.5,out:10}, 'claude-sonnet-4-6':{in:3,out:15}, 'claude-haiku-4-5':{in:1,out:5}, 'gpt-4o-mini':{in:0.15,out:0.6}, 'text-embedding-3-small':{in:0.02,out:0}, 'whisper-1':{in:0,out:0}, 'gemini-2.0-flash':{in:0.1,out:0.4}, 'gemini-flash-latest':{in:0.1,out:0.4}, 'gemini':{in:0.1,out:0.4} };
async function getAiConfig(){
  try { const r = await pool.query("SELECT value FROM aykoshop_settings WHERE key='ai_config'");
    if(r.rows.length){ let v=r.rows[0].value; if(typeof v==='string'){ try{v=JSON.parse(v);}catch(e){v={};} }
      return Object.assign({}, AI_DEFAULTS, v, { providers:Object.assign({},AI_DEFAULTS.providers,(v&&v.providers)||{}), models:Object.assign({},AI_DEFAULTS.models,(v&&v.models)||{}), roles:Object.assign({},AI_DEFAULTS.roles,(v&&v.roles)||{}) }); }
  } catch(e){}
  return Object.assign({}, AI_DEFAULTS, {providers:Object.assign({},AI_DEFAULTS.providers), models:Object.assign({},AI_DEFAULTS.models), roles:Object.assign({},AI_DEFAULTS.roles)});
}
// ==================== AI KEY MANAGER (dashboard-managed, no n8n) ====================
// Set / mask / LIVE-TEST provider API keys from the Dashboard. Hot-reload (no restart). Persists to .ai-secrets.json.
function _maskKey(k){ k=String(k||''); if(!k) return ''; if(k.length<=8) return '••••'; return k.slice(0,4)+'…'+k.slice(-4); }
function _saveSecrets(){ try{ var _enc={}; for(var _sk in _aiSecrets){ _enc[_sk]=_encSecret(_aiSecrets[_sk]); } _fsAI.writeFileSync('/var/www/backend/.ai-secrets.json', JSON.stringify(_enc,null,2)); return true; }catch(e){ console.error('[keys] save fail', e.message); return false; } }
async function _keysAdminOk(req){ try{ const r=await pool.query("SELECT value FROM aykoshop_settings WHERE key='admin_password'"); const want=(r.rows[0]||{}).value||''; return String((req.body&&req.body.admin_password)||'')===String(want) && want!==''; }catch(e){ return false; } }
const _KEY_PROVIDERS={ openai:'OpenAI (GPT)', anthropic:'Anthropic (Claude)', gemini:'Google (Gemini)' };
// Non-LLM secrets also centralised in the same encrypted KM store (Telegram bot token, ManyChat API key).
const _KEY_SECRETS={ telegram_bot:'Telegram Bot Token', manychat_api:'ManyChat API Key' };
// SINGLE-SOURCE resolver: encrypted KM (hot-reload, decrypted in-memory) first, then .env bootstrap fallback. Server-side only — never returned to a client. fn-declaration => hoisted (safe to call from earlier-defined senders).
function getSecret(name, envName){ try{ var v=_aiSecrets[name]; if(v && String(v).trim()) return String(v).trim(); }catch(_e){} return (envName && process.env[envName]) ? String(process.env[envName]) : ''; }
function _tgTok(){ return getSecret('telegram_bot','HTG_TOKEN'); }
function _mcKey(){ return getSecret('manychat_api','MANYCHAT_API_KEY'); }
// Phase 1 Module 2 (2026-07-02): mcGetInfo/mcPageInfo — pure de-duplication of the
// read-only ManyChat getInfo/page-getInfo fetch pattern. Byte-identical wire
// behavior (same URL, same Authorization header, optional per-call timeout).
function mcGetInfo(subscriberId, timeoutMs) {
  var opts = { headers: { 'Authorization': 'Bearer ' + (_mcKey()||'') } };
  if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);
  return fetch('https://api.manychat.com/fb/subscriber/getInfo?subscriber_id=' + encodeURIComponent(subscriberId), opts);
}
function mcPageInfo(timeoutMs) {
  var opts = { headers: { 'Authorization': 'Bearer ' + (_mcKey()||'') } };
  if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);
  return fetch('https://api.manychat.com/fb/page/getInfo', opts);
}
// ===== PHASE B: SEND PROXY — n8n/scripts call these with x-service-token; the actual tokens stay server-side in the KM (zero secrets in n8n). =====
function _serviceOk(req){ try{ const st=req&&req.headers&&req.headers['x-service-token']; return !!(st && process.env.SERVICE_TOKEN && String(st)===String(process.env.SERVICE_TOKEN)); }catch(_e){ return false; } }
app.post('/api/send/telegram', async (req,res)=>{ try{
  if(!_serviceOk(req)) return res.status(401).json({ok:false,error:'service token required'});
  const b=req.body||{}; const chat=String(b.chat_id||'').trim(); const text=String(b.text||'').trim();
  if(!chat||!text) return res.status(400).json({ok:false,error:'chat_id + text required'});
  const tok=_tgTok(); if(!tok) return res.status(503).json({ok:false,error:'telegram token unset'});
  const r=await fetch('https://api.telegram.org/bot'+tok+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text:text,parse_mode:(b.parse_mode||'HTML'),disable_web_page_preview:true}),signal:AbortSignal.timeout(8000)});
  const j=await r.json().catch(()=>null);
  return res.json({ ok:!!(j&&j.ok), message_id:(j&&j.result&&j.result.message_id)||null, detail:(j&&!j.ok)?j.description:undefined });
}catch(e){ res.status(500).json({ok:false,error:e.message}); } });
app.post('/api/send/manychat', async (req,res)=>{ try{
  if(!_serviceOk(req)) return res.status(401).json({ok:false,error:'service token required'});
  const b=req.body||{}; const sub=String(b.subscriber_id||'').trim();
  if(!sub) return res.status(400).json({ok:false,error:'subscriber_id required'});
  const messages=Array.isArray(b.messages)?b.messages:(b.text?[{type:'text',text:String(b.text)}]:null);
  if(!messages||!messages.length) return res.status(400).json({ok:false,error:'messages or text required'});
  const key=_mcKey(); if(!key) return res.status(503).json({ok:false,error:'manychat key unset'});
  const r=await fetch('https://api.manychat.com/fb/sending/sendContent',{method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:sub,data:{version:'v2',content:{messages:messages}}}),signal:AbortSignal.timeout(12000)});
  const j=await r.json().catch(()=>null);
  return res.json({ ok:!!(j&&j.status==='success'), status:r.status, detail:(j&&j.status!=='success')?(j.message||j.status):undefined });
}catch(e){ res.status(500).json({ok:false,error:e.message}); } });

// list providers + masked key (never returns the full key)
app.get('/api/ai/keys', async (req,res)=>{ try{
  const out=Object.keys(_KEY_PROVIDERS).map(id=>({ id, name:_KEY_PROVIDERS[id], set:!!(_aiSecrets[id]&&String(_aiSecrets[id]).trim()), masked:_maskKey(_aiSecrets[id]) }));
  const sec=Object.keys(_KEY_SECRETS).map(id=>({ id, name:_KEY_SECRETS[id], set:!!(_aiSecrets[id]&&String(_aiSecrets[id]).trim()), masked:_maskKey(_aiSecrets[id]) }));
  res.json({ providers:out, secrets:sec });
}catch(e){ res.status(500).json({error:e.message}); } });

// set a provider key (admin-password gated) → hot-reload in-memory + persist to file
app.post('/api/ai/keys', async (req,res)=>{ try{
  const b=req.body||{}; const p=String(b.provider||'');
  if(!_KEY_PROVIDERS[p] && !_KEY_SECRETS[p]) return res.json({ok:false,error:'مزوّد غير معروف'});
  if(!(await _keysAdminOk(req))) return res.json({ok:false,error:'كلمة مرور الأدمين غير صحيحة'});
  const key=String(b.key||'').trim(); if(key.length<10) return res.json({ok:false,error:'مفتاح قصير/فارغ'});
  _aiSecrets[p]=key;
  if(p==='openai') _OPENAI_KEY=key.replace(/^Bearer /,'');
  if(p==='anthropic') _ANTHROPIC_KEY=key;
  const saved=_saveSecrets();
  res.json({ ok:true, persisted:saved, provider:p, masked:_maskKey(key) });
}catch(e){ res.status(500).json({error:e.message}); } });

// LIVE test — makes a real 1-token call so the dashboard proves the key actually works (not a mockup)
app.post('/api/ai/keys/test', async (req,res)=>{ try{
  if(!(await _keysAdminOk(req))) return res.status(401).json({ok:false,error:'كلمة مرور الأدمين مطلوبة'});
  const b=req.body||{}; const p=String(b.provider||''); if(!_KEY_PROVIDERS[p]) return res.status(400).json({error:'مزوّد غير معروف'});
  if(!(_aiSecrets[p]&&String(_aiSecrets[p]).trim())) return res.json({ ok:false, status:'unset', detail:'ماكاينش مفتاح' });
  const t=Date.now(); let r;
  try{
    if(p==='openai') r=await _callOpenAI([{role:'user',content:'ping'}],{model:'gpt-4o-mini',max_tokens:2,temperature:0,timeout:10000});
    else if(p==='anthropic') r=await _callClaude([{role:'user',content:'ping'}],{model:'claude-haiku-4-5',max_tokens:2,timeout:10000});
    else r=await _callGemini([{role:'user',content:'ping'}],{model:'gemini-flash-latest',max_tokens:8,timeout:15000});
  }catch(e){ r={ok:false, error:String(e.message||e)}; }
  const ms=Date.now()-t;
  if(r && (r.ok || r.status===200)) return res.json({ ok:true, status:'working', ms, detail:'الموديل جاوب — المفتاح خدّام ✅' });
  const err=String((r&&r.error)||'').toLowerCase();
  let status='error', detail=(r&&r.error)||'فشل';
  if(/quota|exceeded|billing|insufficient|429/.test(err)){ status='quota'; detail='المفتاح صالح لكن الحصة (quota) منتهية'; }
  else if(/timeout|abort/.test(err)){ status='timeout'; detail='الموديل بطيء (timeout) — عاود'; }
  else if(/401|invalid|unauthor|api[_ ]?key|authentication|permission/.test(err)){ status='invalid'; detail='المفتاح غير صالح'; }
  res.json({ ok:false, status, ms, detail });
}catch(e){ res.status(500).json({error:e.message}); } });
// ==================== END AI KEY MANAGER ====================

// ===== Decision Trace API =====
app.get('/api/decisions', async (req,res)=>{
  try{
    const limit=Math.min(parseInt(req.query.limit)||150,500);
    const sub=req.query.subscriber_id||null;
    let q="SELECT at.id, at.subscriber_id, COALESCE(p.customer_name,at.subscriber_id::text) customer_name, at.from_stage, at.to_stage, at.agent, at.reason, at.user_msg, at.created_at FROM aykoshop_agent_trail at LEFT JOIN aykoshop_profiles p ON p.subscriber_id=at.subscriber_id WHERE at.reason LIKE '{%'";
    const vals=[];
    if(sub){ q+=" AND at.subscriber_id=$1"; vals.push(String(sub)); }
    q+=" ORDER BY at.id DESC LIMIT "+limit;
    const dec=await pool.query(q,vals).catch(()=>({rows:[]}));
    let vq="SELECT v.id, v.subscriber_id, COALESCE(p.customer_name,v.subscriber_id::text) customer_name, v.user_msg, v.blocked_game, v.mode, v.created_at FROM aykoshop_verifier_log v LEFT JOIN aykoshop_profiles p ON p.subscriber_id=v.subscriber_id";
    const vvals=[];
    if(sub){ vq+=" WHERE v.subscriber_id=$1"; vvals.push(String(sub)); }
    vq+=" ORDER BY v.id DESC LIMIT 100";
    const blk=await pool.query(vq,vvals).catch(()=>({rows:[]}));
    const parsed=dec.rows.map(r=>{ let p=null; try{p=JSON.parse(r.reason);}catch(e){} return Object.assign({},r,{parsed:p}); });
    res.json({ok:true, decisions:parsed, blocks:blk.rows});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/ai-config', async (req,res)=>{ try{ res.json(await getAiConfig()); }catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/ai-config', async (req,res)=>{ try{
  const cur = await getAiConfig(); const b = req.body||{}; const next = Object.assign({}, cur, b);
  if(b.providers) next.providers = Object.assign({}, cur.providers, b.providers);
  if(b.models) next.models = Object.assign({}, cur.models, b.models);
  if(b.roles) next.roles = Object.assign({}, cur.roles, b.roles);
  if(b.roles && b.roles.sales) next.primary = b.roles.sales;
  if(b.roles && b.roles.failover) next.fallback = b.roles.failover;
  if(b.primary) next.roles = Object.assign({}, next.roles, {sales:b.primary});
  if(b.fallback) next.roles = Object.assign({}, next.roles, {failover:b.fallback});
  // SELLER GUARD: only GPT-4o/Claude may sell or failover — Mini/Gemini auto-revert (sales rule)
  const _SELLERS=['openai','anthropic']; next.roles=next.roles||{};
  const _o={p:next.primary,f:next.fallback,s:next.roles.sales,fo:next.roles.failover};
  if(!_SELLERS.includes(next.roles.sales)) next.roles.sales='openai';
  if(!_SELLERS.includes(next.roles.failover)) next.roles.failover='anthropic';
  next.primary=next.roles.sales; next.fallback=next.roles.failover;
  const _aiWarn=(_o.p!==next.primary||_o.f!==next.fallback||_o.s!==next.roles.sales||_o.fo!==next.roles.failover)?'Mini/Gemini غير مسموح لهم بالبيع/الاحتياطي — تم الإرجاع تلقائياً لمزوّد بيع صالح (GPT-4o/Claude)':null;
  await pool.query("INSERT INTO aykoshop_settings(key,value) VALUES('ai_config',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[JSON.stringify(next)]);
  try{ _broadcast('ai_config', next); }catch(_e){}
  res.json(_aiWarn?Object.assign({},next,{_warning:_aiWarn}):next);
}catch(e){ res.status(500).json({error:e.message}); } });
async function _callOpenAI(messages, opt){ opt=opt||{};
  const r = await fetch('https://api.openai.com/v1/chat/completions',{ method:'POST', headers:{'Authorization':'Bearer '+_OPENAI_KEY,'Content-Type':'application/json'}, body:JSON.stringify(Object.assign({ model:opt.model||'gpt-4o', max_tokens:opt.max_tokens||300, temperature:(opt.temperature==null?0.9:opt.temperature), messages }, opt.response_format?{response_format:opt.response_format}:{})), signal:AbortSignal.timeout(opt.timeout||6000) });
  if(!r.ok){ const t=await r.text().catch(()=>''); return { ok:false, status:r.status, error:('HTTP '+r.status+' '+t).slice(0,200) }; }
  const d = await r.json(); const text=(((d.choices||[])[0]||{}).message||{}).content||''; const _u={ in:(d.usage||{}).prompt_tokens||0, out:(d.usage||{}).completion_tokens||0 };
  if(opt.log!==false){ try{ _logAiUsage({provider:'openai',model:opt.model||'gpt-4o',mode:'call',role:(opt.log&&opt.log.role)||'system',route_layer:(opt.log&&opt.log.rl)||('svc:'+(opt.model||'gpt-4o')),tokens_in:_u.in,tokens_out:_u.out,success:!!text.trim()}); }catch(e){} }
  return { ok:!!text.trim(), text:text.trim(), usage:_u, status:200 };
}
function _toClaude(messages){
  let system=''; const msgs=[];
  for(const m of (messages||[])){ const c = typeof m.content==='string'?m.content:JSON.stringify(m.content);
    if(m.role==='system'){ system += (system?'\n\n':'')+c; continue; }
    const role = m.role==='assistant'?'assistant':'user';
    if(msgs.length && msgs[msgs.length-1].role===role){ msgs[msgs.length-1].content += '\n'+c; } else { msgs.push({ role, content:c }); } }
  if(msgs.length && msgs[0].role!=='user'){ msgs.unshift({ role:'user', content:'(متابعة)' }); }
  if(!msgs.length){ msgs.push({ role:'user', content:'سلام' }); }
  return { system, msgs };
}
async function _callClaude(messages, opt){ opt=opt||{};
  const { system, msgs } = _toClaude(messages);
  const body = { model:opt.model||'claude-sonnet-4-6', max_tokens:opt.max_tokens||400, messages:msgs };
  if(system) body.system=system;
  if(opt.temperature!=null) body.temperature=opt.temperature;
  const r = await fetch('https://api.anthropic.com/v1/messages',{ method:'POST', headers:{'x-api-key':_ANTHROPIC_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(opt.timeout||6000) });
  if(!r.ok){ const t=await r.text().catch(()=>''); return { ok:false, status:r.status, error:('HTTP '+r.status+' '+t).slice(0,200) }; }
  const d = await r.json(); const text=((d.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('')||''); const _u={ in:(d.usage||{}).input_tokens||0, out:(d.usage||{}).output_tokens||0 };
  if(opt.log!==false){ try{ _logAiUsage({provider:'anthropic',model:opt.model||'claude-sonnet-4-6',mode:'call',role:(opt.log&&opt.log.role)||'system',route_layer:(opt.log&&opt.log.rl)||('svc:'+(opt.model||'claude')),tokens_in:_u.in,tokens_out:_u.out,success:!!text.trim()}); }catch(e){} }
  return { ok:!!text.trim(), text:text.trim(), usage:_u, status:200 };
}
const _AI_CALL = { openai:_callOpenAI, anthropic:_callClaude };
async function _callGemini(messages, opt){ opt=opt||{};
  const key=_aiSecrets.gemini||process.env.GEMINI_API_KEY||''; if(!key) return {ok:false,status:0,error:'no_gemini_key'};
  const model=opt.model||'gemini-2.0-flash'; let sys=''; const contents=[];
  for(const m of (messages||[])){ const c=typeof m.content==='string'?m.content:JSON.stringify(m.content); if(m.role==='system'){sys+=(sys?'\n':'')+c;continue;} contents.push({role:(m.role==='assistant'?'model':'user'),parts:[{text:c}]}); }
  if(!contents.length) contents.push({role:'user',parts:[{text:'سلام'}]});
  const body={contents, generationConfig:{maxOutputTokens:opt.max_tokens||300}}; if(sys) body.systemInstruction={parts:[{text:sys}]};
  const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent?key='+key,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(opt.timeout||6000)});
  if(!r.ok){ const t=await r.text().catch(()=>''); return {ok:false,status:r.status,error:('HTTP '+r.status+' '+t).slice(0,160)}; }
  const d=await r.json(); const cand=(d.candidates||[])[0]; const text=(cand&&cand.content&&cand.content.parts)?cand.content.parts.map(p=>p.text||'').join(''):''; const um=d.usageMetadata||{}; const _u={in:um.promptTokenCount||0,out:um.candidatesTokenCount||0};
  if(opt.log!==false){ try{ _logAiUsage({provider:'gemini',model:opt.model||'gemini-2.0-flash',mode:'call',role:(opt.log&&opt.log.role)||'system',route_layer:(opt.log&&opt.log.rl)||('svc:'+(opt.model||'gemini')),tokens_in:_u.in,tokens_out:_u.out,success:!!text.trim()}); }catch(e){} }
  return {ok:!!text.trim(),text:text.trim(),usage:_u,status:200};
}
_AI_CALL.mini = async (m,o)=> _callOpenAI(m, Object.assign({},o||{},{model:'gpt-4o-mini'}));
_AI_CALL.gemini = _callGemini;
// ── Brain Gateway ── dynamic provider switch (reads DB every 30s, no restart needed)
// AI_BRAIN env = default at startup; POST /api/mc/set-brain overrides live from dashboard
let _AI_BRAIN_LIVE = process.env.AI_BRAIN || 'openai';
setInterval(async function(){ try{ const _r=await pool.query("SELECT value FROM aykoshop_settings WHERE key='ai_brain'"); if(_r.rows[0]&&_r.rows[0].value) _AI_BRAIN_LIVE=_r.rows[0].value; }catch(_e){} },30000);
function _callBrain(m, o){ return (_AI_CALL[_AI_BRAIN_LIVE] || _AI_CALL.openai)(m, o); }

// ── Truth Packet ── query DB for real policy + real catalog prices
async function _buildTruthPacket(sub, intent, ctx) {
  var tp = { prices:[], warranty_ff:null, warranty_social:null, refund_policy:null, payment_methods:null };
  try { var _pol=await pool.query("SELECT key,value FROM aykoshop_policies"); for(var _pi=0;_pi<_pol.rows.length;_pi++){ tp[_pol.rows[_pi].key]=_pol.rows[_pi].value; } } catch(_pe){}
  try {
    var _game=(ctx&&ctx.product)||null;
    var _pq="SELECT price_value FROM aykoshop_products WHERE status='available' AND price_value IS NOT NULL";
    var _pp=[];
    if(_game){ _pq+=" AND (game=$1 OR product_name ILIKE '%'||$1||'%')"; _pp.push(_game); }
    var _pr=await pool.query(_pq,_pp);
    tp.prices=_pr.rows.map(function(r){return Number(r.price_value);}).filter(function(n){return n>0;});
    if(!tp.prices.length){ var _all=await pool.query("SELECT price_value FROM aykoshop_products WHERE status='available' AND price_value IS NOT NULL"); tp.prices=_all.rows.map(function(r){return Number(r.price_value);}).filter(function(n){return n>0;}); }
  } catch(_pe2){}
  return tp;
}

// ── Truth Gate ── block policy violations + hallucinated prices before reply is sent
function _truthGate(reply, tp) {
  if(!reply||!tp){ return {blocked:false,corrected:reply,reason:""}; }
  if(/نرجعو?[\s ]*ليك[\s ]*(الفلوس|المال|الثمن)|استرجاع[\s ]*نقدي/i.test(reply)){
    var _cor=reply.replace(/نرجعو?[\s ]*ليك[\s ]*(الفلوس|المال|الثمن)/gi,"نعوضوك بمنتج مماثل");
    return {blocked:true,corrected:_cor,reason:"cash_refund_blocked"};
  }
  if(tp.prices&&tp.prices.length>=1){
    var _ments=(reply.match(/\b(\d{3,5})\b/g)||[]).map(Number).filter(function(n){return n>=100&&n<=9999;});
    for(var _mi=0;_mi<_ments.length;_mi++){
      var _p=_ments[_mi];
      var _cl=tp.prices.reduce(function(a,b){return Math.abs(b-_p)<Math.abs(a-_p)?b:a;},tp.prices[0]);
      if(Math.abs(_cl-_p)>25){
        var _rc=reply.replace(new RegExp("\\b"+_p+"\\b","g"),String(_cl));
        return {blocked:true,corrected:_rc,reason:"price_hallucination:"+_p+"->"+_cl};
      }
    }
  }
  return {blocked:false,corrected:reply,reason:""};
}

function _modelOf(p,cfg){ return (cfg&&cfg.models&&cfg.models[p]) || ({mini:'gpt-4o-mini',gemini:'gemini-2.0-flash',openai:'gpt-4o',anthropic:'claude-sonnet-4-6'}[p]) || p; }
// Profit Router intent detection (rules; sales-intents -> seller, lightweight -> mini, default -> seller)
function _detectIntent(text){
  const t=(text||'').toString().toLowerCase().trim();
  const payConfirm=/خلصت|دفعت|دفعتك|حولت|حوّلت|صفطت|صيفط|سيفط|عطيتك|بعتلك|sent|payé|screenshot|سكرين|تم التحويل|تم الدفع|دازت ليك/.test(t);
  const buy=/شري|نشري|اشتر|نشتري|بغيت حساب|بغيت اشتراك|بغيت منتج|بغيت نشري|بغيت نشحن|الثمن|ثمن|السعر|سعر|بشحال|شحال|شحن|كود|توب اب|topup|top up|دفع|نخلص|نخلّص|ميزانية|طلب|prix|acheter|achat|اشتراك|حساب|account|recharge/.test(t);
  const browse=/شنو عندكم|شنو كاين|واش عندكم|اش عندكم|عندكم شي|عندكم منتج|المنتجات|المتوفر|كاطالوك|كتالوك|catalog|liste|منتجاتكم/.test(t);
  const greet=/^(سلام|سالو|السلام|أهلا|اهلا|اهلين|مرحبا|salam|salut|bonjour|labas|hi|hello|cv|coucou)([\s!،.]|$)/.test(t) || ['سلام','اهلا','مرحبا','salam','hi','hello','labas'].includes(t);
  const thanks=/شكرا|شكرن|متشكر|merci|thanks|thank you|بسلامة|الله يخليك|تبارك الله|بالتوفيق/.test(t);
  if(payConfirm) return {intent:'payment', cls:'sales'};
  if(buy) return {intent:'buy', cls:'sales'};
  if(browse) return {intent:'browse', cls:'sales'};
  if(thanks) return {intent:'thanks', cls:'light'};
  if(greet) return {intent:'greeting', cls:'light'};
  return {intent:'general', cls:'sales'};
}
function _routeDecision(text, cfg){
  const it=_detectIntent(text); const SELLERS=['openai','anthropic']; let role,primary,fallback,reason;
  if(it.cls==='light' && cfg.profit_router!==false && cfg.providers && cfg.providers.mini!==false){
    role='support'; primary=(cfg.roles&&cfg.roles.intent)||'mini'; fallback='openai';
    if(!['mini','gemini','openai'].includes(primary)) primary='mini';
    reason=it.intent+' = تواصل خفيف (ماشي بيع) → '+primary+' لتوفير التكلفة، fallback GPT-4o';
  } else {
    role='sales'; primary=cfg.primary||'openai'; fallback=cfg.fallback||'anthropic';
    reason=(it.intent==='payment'?'تأكيد/نية دفع':it.intent==='buy'?'نية شراء واضحة':it.intent==='browse'?'استكشاف منتجات':'افتراضي آمن (في الشك)')+' → بائع GPT-4o، فشل→Claude';
  }
  if(role==='sales'){ if(!SELLERS.includes(primary))primary='openai'; if(!SELLERS.includes(fallback))fallback='anthropic'; }
  return {intent:it.intent, cls:it.cls, role, primary, fallback, reason};
}
let _agentsCache={t:0,v:null};
async function getAgents(){ if(_agentsCache.v && Date.now()-_agentsCache.t<30000) return _agentsCache.v; try{ const r=await pool.query("SELECT * FROM aykoshop_agents"); const o={}; r.rows.forEach(a=>o[a.name]=a); _agentsCache={t:Date.now(),v:o}; return o; }catch(e){ return _agentsCache.v||{}; } }
async function _classifyMini(text){
  const _ag=await getAgents(); const _cfg=await getAiConfig();
  const _ip=(_ag.intent&&_ag.intent.prompt)||'صنّف رسالة الزبون لفئة وحدة فقط وجاوب بكلمة وحدة بالإنجليزية من: sales support payment browse greeting thanks takeover';
  const _model=(_ag.intent&&_ag.intent.model)||'gpt-4o-mini';
  const _msgs=[{role:'system',content:_ip},{role:'user',content:String(text||'').slice(0,300)}];
  const _parse=(t)=>{ const lab=(t||'').toLowerCase().replace(/[^a-z]/g,''); return ['sales','support','payment','browse','greeting','thanks','takeover'].includes(lab)?lab:null; };
  // Gemini-first (free) for classification, circuit-protected
  if(_cfg.gemini_classify && _cfg.providers && _cfg.providers.gemini!==false && _AI_CALL.gemini && circuitAllows('gemini')){
    try{ const g=await _callGemini(_msgs,{model:'gemini-2.0-flash',max_tokens:8,timeout:4000});
      if(g.ok){ circuitRecord('gemini',true,'classify ok'); const l=_parse(g.text); if(l) return l; }
      else { circuitRecord('gemini',false,(g.error||'no_text').slice(0,80)); }
    }catch(e){ circuitRecord('gemini',false,String(e.message||e).slice(0,80)); }
  }
  // F4: Haiku primary (replaces quota'd gpt-4o-mini), mini = secondary fallback only
  try{ const _hr=await _callClaude(_msgs,{model:'claude-haiku-4-5',max_tokens:4,temperature:0,timeout:5000});
    if(_hr.ok){ const l=_parse(_hr.text); if(l) return l; }
  }catch(_he){}
  // gpt-4o-mini: secondary fallback (kept for resilience)
  try{ const r=await _callOpenAI(_msgs, {model:_model, max_tokens:4, temperature:0, timeout:4000});
    if(!r.ok) return null; return _parse(r.text);
  }catch(e){ return null; }
}
async function _productSearch(text){
  try{ const products=((await (await fetch('http://localhost:4000/api/products')).json())||[]).filter(p=>p.status==='available');
    const t=(text||'').toLowerCase(); const hits=[];
    for(const p of products){ const name=(p.product_name||'').toLowerCase(); const cat=(p.category||'').toLowerCase(); const kw=((p.keywords||p.tags||'')+'').toLowerCase();
      const words=name.split(/[^a-z0-9؀-ۿ]+/).filter(w=>w.length>=3);
      const hit = words.some(w=>t.includes(w)) || (cat.length>=3 && t.includes(cat)) || (kw && kw.split(/[ ,]+/).some(k=>k.length>=3 && t.includes(k)));
      if(hit) hits.push(p); }
    return hits;
  }catch(e){ return []; }
}
app.get('/api/ai/product-search', async (req,res)=>{ try{ const hits=await _productSearch(req.query.q||''); res.json({ q:req.query.q||'', count:hits.length, products:hits.map(p=>({id:p.id,product_name:p.product_name,price:p.price,category:p.category,status:p.status})) }); }catch(e){ res.status(500).json({error:e.message}); } });
// ==================== HITL LEARNING (RAG over approved knowledge) ====================
async function _normForEmbed(text){
  try{
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':'Bearer '+_OPENAI_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',max_tokens:24,temperature:0,messages:[{role:'system',content:'Output ONLY a short canonical ENGLISH intent phrase (3-8 words) for this customer message. English only, no Arabic, no extra text.'},{role:'user',content:String(text||'').slice(0,500)}]}),signal:AbortSignal.timeout(6000)});
    if(!r.ok) return null; const j=await r.json(); const t=(((j.choices||[])[0]||{}).message||{}).content||''; return t.trim()||null;
  }catch(e){ return null; }
}
async function _embed(text){
  try{
    const r=await fetch('https://api.openai.com/v1/embeddings',{method:'POST',headers:{'Authorization':'Bearer '+_OPENAI_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:'text-embedding-3-small',input:String(text||'').slice(0,800)}),signal:AbortSignal.timeout(7000)});
    if(!r.ok) return null; const j=await r.json(); const e=((j.data||[])[0]||{}).embedding; return Array.isArray(e)?e:null;
  }catch(e){ return null; }
}
async function _kbMatch(text){
  try{
    const nq=await _normForEmbed(text); const emb=await _embed(nq||text); if(!emb) return null;
    const v='['+emb.join(',')+']';
    const r=await pool.query("SELECT id, correct_reply, customer_message, entry_type, source, 1-(embedding <=> $1::vector) AS sim FROM aykoshop_conversation_examples WHERE approved=true AND embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT 5",[v]);
    if(!r.rows.length) return null; let best=r.rows[0];
    if(best.entry_type==='objection'){ const close=r.rows.filter(function(x){return x.entry_type==='objection' && (parseFloat(best.sim)-parseFloat(x.sim))<=0.08;}); if(close.length>1){ best=close[Math.floor(Math.random()*close.length)]; } }
    return { id:best.id, reply:best.correct_reply, question:best.customer_message, sim:parseFloat(best.sim), entry_type:best.entry_type, source:best.source };
  }catch(e){ return null; }
}
// Rich embed text from catalog fields (name+game+category+type+code_type+keywords+features+desc+package amounts).
function _productEmbedText(p){ try{ var amts=''; try{ var rp=p.recharge_packages; if(typeof rp==='string') rp=JSON.parse(rp); if(Array.isArray(rp)) amts=rp.map(function(x){return (x.amount||'')+' '+(x.price||'');}).join(' '); }catch(e){} return [p.product_name,p.game,p.category,p.subcategory,p.platform,p.product_type,p.code_type,p.recharge_type,p.account_rank,p.keywords,p.key_features,p.key_benefits,p.description,amts].filter(Boolean).join(' ').replace(/\s+/g,' ').trim().slice(0,800); }catch(e){ return String((p&&p.product_name)||''); } }
async function _embedProduct(id){ try{ const r=await pool.query('SELECT * FROM aykoshop_products WHERE id=$1',[id]); if(!r.rows.length) return false; const et=_productEmbedText(r.rows[0]); const emb=await _embed(et); if(!emb) return false; await pool.query('UPDATE aykoshop_products SET embedding=$1::vector, embed_text=$2, embedded_at=NOW() WHERE id=$3',['['+emb.join(',')+']',et,id]); return true; }catch(e){ return false; } }
// Strip markdown so replies render clean on Messenger/WhatsApp/IG (no **bold**, ---, >, #, `code`).
function _stripMd(t){ try{ if(typeof t!=='string') return t; return t.replace(/\*\*|__|`/g,'').replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/^\s{0,3}>\s?/gm,'').replace(/^\s*-{3,}\s*$/gm,'').replace(/\n{3,}/g,'\n\n').trim(); }catch(e){ return t; } }
// ===== CATALOG META (what the store sells — derived from DB, cached). Aliases come from each product's own game/keywords/category (catalog-driven, no hardcoded game list). =====
let _cmCache={t:0,data:null};
async function _catalogMeta(){
  if(_cmCache.data && Date.now()-_cmCache.t<60000) return _cmCache.data;
  const d={lines:[], types:[], salesList:''};
  try{
    const norm=function(x){ return String(x||'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim(); };
    const r=await pool.query("SELECT game, string_agg(DISTINCT lower(coalesce(keywords,'')||' '||coalesce(category,'')||' '||coalesce(product_name,'')),' ') blob FROM aykoshop_products WHERE status='available' AND game IS NOT NULL AND trim(game)<>'' GROUP BY game");
    r.rows.forEach(function(row){ const toks=norm(String(row.game).toLowerCase()+' '+(row.blob||'')).split(' ').filter(function(w){return w.length>=3;}); d.lines.push({proper:row.game, aliases:Array.from(new Set([norm(row.game)].concat(toks))).filter(Boolean)}); });
    const ng=await pool.query("SELECT coalesce(nullif(trim(category),''),product_name) line, string_agg(DISTINCT lower(coalesce(keywords,'')||' '||coalesce(product_name,'')),' ') blob FROM aykoshop_products WHERE status='available' AND (game IS NULL OR trim(game)='') GROUP BY 1");
    ng.rows.forEach(function(row){ if(!row.line) return; const toks=norm(String(row.line).toLowerCase()+' '+(row.blob||'')).split(' ').filter(function(w){return w.length>=3;}); d.lines.push({proper:row.line, aliases:Array.from(new Set([norm(row.line)].concat(toks))).filter(Boolean)}); });
    const t=await pool.query("SELECT DISTINCT lower(trim(product_type)) t FROM aykoshop_products WHERE status='available' AND product_type IS NOT NULL AND trim(product_type)<>''");
    d.types=t.rows.map(function(x){return x.t;}).filter(Boolean);
    try{ const _tg=await pool.query("SELECT lower(trim(game)) g, array_agg(DISTINCT product_type) t FROM aykoshop_products WHERE status='available' AND game IS NOT NULL AND trim(game)<>'' AND product_type IS NOT NULL GROUP BY lower(trim(game))"); d.typesByGame={}; _tg.rows.forEach(function(r){ d.typesByGame[r.g]=(r.t||[]).filter(Boolean); }); }catch(e){ d.typesByGame={}; }
    d.salesList=Array.from(new Set(d.lines.map(function(l){return l.proper;}))).join(' \u00b7 ');
  }catch(e){}
  _cmCache={t:Date.now(),data:d}; return d;
}
// ===== CATALOG-DRIVEN SEMANTIC SEARCH (no hardcoded game/product — reads aykoshop_products embeddings) =====
async function _catalogSearch(query, opt){
  opt=opt||{};
  try{
    const nq=await _normForEmbed(query); const emb=await _embed(nq||query); if(!emb) return {ok:false, rows:[], nq:(nq||null)};
    const v='['+emb.join(',')+']'; const params=[v];
    let q="SELECT id, product_name, COALESCE(game,'') game, COALESCE(category,'') category, COALESCE(product_type,'') product_type, price, price_value, min_price, COALESCE(code_type,'') code_type, COALESCE(key_features,'') key_features, COALESCE(key_benefits,'') key_benefits, COALESCE(delivery_time,'') delivery_time, COALESCE(related_products,'') related_products, COALESCE(price_usd,'') price_usd, COALESCE(price_eur,'') price_eur, COALESCE(account_rank,'') account_rank, COALESCE(evo_count,'') evo_count, COALESCE(guarantee_note,'') guarantee_note, image_url, recharge_packages, 1-(embedding <=> $1::vector) AS sim FROM aykoshop_products WHERE status='available' AND embedding IS NOT NULL";
    if(opt.type){ params.push(opt.type); q+=' AND product_type=$'+params.length; }
    q+=' ORDER BY embedding <=> $1::vector LIMIT '+(Math.min(parseInt(opt.limit)||8,20));
    const r=await pool.query(q, params); let rows=r.rows;
    rows.forEach(function(p){ p.pv=parseInt(p.price_value)||parseInt(String(p.price).replace(/[^0-9]/g,''))||0; p.sim=parseFloat(p.sim); });
    if(opt.budget){ const bud=parseInt(opt.budget)||0; rows=rows.slice().sort(function(a,b){ return Math.abs(a.pv-bud)-Math.abs(b.pv-bud); }); }
    return {ok:true, rows:rows, nq:(nq||null)};
  }catch(e){ return {ok:false, rows:[], err:e.message}; }
}
// Capture an UNKNOWN_QUESTION when the AI's own reply signals uncertainty (non-sensitive only). Fire-and-forget.
function _maybeCaptureUnknown(sub,b,lu,reply,role,intent,kbSim){
  try{
    if(!sub || !lu || !reply) return;
    if(['sales','support','light'].indexOf(role)<0) return;
    if(['payment','takeover','trade_request','payment_claim','payment_method_unknown'].indexOf(intent)>=0) return;
    if(kbSim>=0.55) return;
    var _unc=/ما\s?عرفتش|ماكنعرفش|ما\s?كنعرفش|ما\s?عنديش\s?هاد\s?المعلوم|ما\s?عنديش\s?المعلوم|نتأكد.{0,15}نرجع|نسولو.{0,15}نرجع|نتحقق.{0,15}نرجع|غادي\s?نرجع\s?ليك|نشوف(ها)?.{0,15}نرجع|ماكنقدرش\s?نجاوب|لست متأكد|لا أعرف|not sure|i.?m not sure|don.?t know|ماباينش|ماوضحش/i;
    if(!_unc.test(reply)) return;
    (async()=>{ try{
      const _d=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code='UNKNOWN_QUESTION' AND created_at>now()-interval '6 hours' LIMIT 1",[String(sub)]);
      if(!_d.rows.length){ await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),customer_name:b.first_name||null,channel:b.channel||null,reason_code:'UNKNOWN_QUESTION',reason_detail:'سؤال جديد / AI ماعندوش ثقة — جاوب ولا صحّح باش يتعلّم',customer_message:String(lu).slice(0,400),ai_last_reply:String(reply).slice(0,400)})}); }
    }catch(_e){} })();
  }catch(e){}
}

// Live catalog context for the selling AI — Dashboard = source of truth (prices/binding/features/floor). Cached 60s.
let _catCache={t:0,v:null};
async function _catalogContext(q){
  try{
    let _rows;
    if(_catCache.rows && (Date.now()-_catCache.t)<60000){ _rows=_catCache.rows; }
    else { const r=await pool.query("SELECT product_name,price,price_value,min_price,max_discount,account_link_type,key_features,delivery_time,stock,category,product_type,game,recharge_type,recharge_amount,vip_recharge,evo_count,account_rank,account_platform,product_code,recharge_packages,code_type,price_usd,price_eur,order_count FROM aykoshop_products WHERE status='available' ORDER BY price_value NULLS LAST LIMIT 60"); _rows=r.rows; _catCache={t:Date.now(),rows:_rows}; }
    if(!_rows.length) return null;
    var _q=String(q||'').toLowerCase();
    var _browse=/شنو عندكم|شنو كاين|واش عندكم|كاطالوك|كتالوك|المنتجات|catalog|liste|كلشي|عندكم شنو/.test(_q);
    function _score(p){ var sc=0; var nm=((p.product_name||'')+' '+(p.game||'')+' '+(p.category||'')+' '+(p.code_type||'')+' '+(p.product_type||'')+' '+(p.key_features||'')).toLowerCase();
      if(/free ?fire|فري ?فاير|فاير|\bff\b/.test(_q) && /free ?fire|فري|freefire/.test(nm)) sc+=5;
      if(/pubg|ببجي/.test(_q) && /pubg|ببجي/.test(nm)) sc+=6;
      if(/tiktok|تيك ?توك/.test(_q) && /tiktok|تيك/.test(nm)) sc+=6;
      if(/instagram|انستغرام|انستا/.test(_q) && /instagram|انستا/.test(nm)) sc+=6;
      if(/شحن|جوهر|diamond|\buc\b|recharge|كوينز|شدات/.test(_q) && p.product_type==='recharge') sc+=5;
      if(/كود|code|سكن|سيارة|سلاح|رقصة/.test(_q) && p.product_type==='code') sc+=5;
      if(/حساب|كونط|account|كونت/.test(_q) && p.product_type==='account') sc+=4;
      var bm=_q.match(/(\d{2,5})/); if(bm){ var b=parseInt(bm[1]); var pv=parseFloat(p.price_value)||0; if(pv>0&&b>0) sc+=Math.max(0,3-Math.abs(pv-b)/b*3); }
      sc+=(parseInt(p.order_count)||0)*0.05; return sc;
    }
    var _ranked=(_rows.length<=5)?_rows.slice():_rows.slice().sort(function(a,b){return _score(b)-_score(a);});
    var _top=_browse?_ranked.slice(0,8):_ranked.slice(0,5);
    const lines=_top.map(function(p){
      const pv=parseFloat(p.price_value)||0, mp=parseFloat(p.min_price)||0, md=parseFloat(p.max_discount)||0;
      let neg='';
      if(mp>0 && pv>0 && mp<pv) neg=' | أقل ثمن للتفاوض: '+mp;
      else if(md>0 && pv>0) neg=' | أقل ثمن للتفاوض: '+Math.max(pv-md,0);
      var _t=''; // product_type tag removed — code_type in same line carries the detail
      var _g=p.game?(' '+p.game):'';
      var _pkg=(Array.isArray(p.recharge_packages)&&p.recharge_packages.length)?(' | الباقات: '+p.recharge_packages.map(function(x){return (x.amount||'')+'='+(x.price||'')+'درهم';}).join(' · ')):(p.recharge_amount?(' | كمية: '+p.recharge_amount):'');
      var _rech=(p.product_type==='recharge')?(_pkg+(p.recharge_type?(' | الشحن: '+(p.recharge_type==='login_required'?'يحتاج Login → تحويل بشري':'بالـID مباشرة')):'')+(p.vip_recharge?' | ⭐VIP':'')):'';
      var _acct=(p.product_type==='account')?((p.evo_count?(' | EVO: '+p.evo_count):'')+(p.account_rank?(' | رانك: '+p.account_rank):'')+(p.account_platform?(' | جهاز: '+p.account_platform):'')):'';
      var _code=(p.product_type==='code'&&p.code_type)?(' | نوع الكود: '+p.code_type):'';
      return '• '+(p.product_name||'')+_t+_g+' — '+(p.price||p.price_value||'')+(p.price_usd?(' / '+p.price_usd+'$'):'')+(p.price_eur?(' / '+p.price_eur+'€'):'')+neg
        +_rech+_acct+_code
        +(p.key_features?(' · '+String(p.key_features).slice(0,50)):'');
    });
    const v='📦 الكاطالوج المتوفّر الآن (مصدر الحقيقة الوحيد — استعمل غير هاد المعطيات، ماتخترعش سلعة/ثمن/ميزة):\nقواعد القرار: [حساب]=بيع عادي · [شحن بالـID]=بيع مباشر بعد ما تاخد الـID ديال اللعبة · [شحن يحتاج Login]=ماتكملش الشحن، حوّل للبشري · [⭐VIP]=طلب كبير نبّه · [كود]=بيع مباشر، الكود كيتفعّل مباشرة بلا حساب/ID · العملات: عطي الثمن بالعملة لي طلب الزبون (درهم/$/€) من الكاطالوج بلا ما تحوّل من راسك · إيلا الكمية المطلوبة ماكايناش اعرض أقرب باقتين (الأصغر والأكبر).\n'+lines.join('\n');
    return v;
  }catch(e){ return null; }
}

// ==================== BUYER CONTEXT LAYER (unified type + memory + personality) ====================
function _detectBuyerSignals(msg){
  const m=String(msg||''); const o={};
  if(/\bUC\b|diamonds?|جواهر|جوهر|شحن|top.?up|recharge|coins?|شدات|كوينز/i.test(m)) o.buyer_type='RECHARGE_BUYER';
  else if(/واجد ندفع|واجد نخلص|بغيت نخلص|عطيني طريقة الدفع|نخلص دابا|ready to pay/i.test(m)) o.buyer_type='READY_TO_PAY';
  else if(/نجمع الفلوس|غادي نرجع|من بعد|نحجز|حجز ليا|ماعنديش دابا/i.test(m)) o.buyer_type='RESERVATION_BUYER';
  else if(/تبديل|نبدل|نبيع|trade|échange/i.test(m)) o.buyer_type='TRADE_BUYER';
  else if(/مشكل|مشكلة|استرجاع|شكاية|ماخدامش|support/i.test(m)) o.buyer_type='SUPPORT_BUYER';
  else if(/بغيت حساب|حساب فري فاير|كونط|account|انستغرام|انستا|instagram|tiktok|pubg/i.test(m)) o.buyer_type='ACCOUNT_BUYER';
  else if(/شنو عندكم|شنو كاين|واش عندكم|كاطالوك|المنتجات|نشوف/i.test(m)) o.buyer_type='BROWSING_BUYER';
  if(/غالي|بزاف عليا|نقص|رخيص|تخفيض|بلا فلوس|قليل/i.test(m)) o.personality_type='PRICE_SENSITIVE';
  else if(/أحسن حساب|الأقوى|مهيب|بريميوم|premium|أعلى/i.test(m)) o.personality_type='PREMIUM';
  else if(/دابا|دغيا|بسرعة|واجد|فيسع|الآن/i.test(m)) o.personality_type='FAST_BUYER';
  else if(/نفكر|غادي نرجع|من بعد|مازال|نشوف/i.test(m)) o.personality_type='HESITANT';
  else if(/مضمون|ضمان|ثقة|خايف|نصب|واش صحيح/i.test(m)) o.personality_type='TRUST_SEEKING';
  if(/فري فاير|free ?fire|freefire|\bff\b/i.test(m)) o.favorite_game='Free Fire';
  else if(/ببجي|pubg/i.test(m)) o.favorite_game='PUBG';
  else if(/تيك ?توك|tiktok|tik tok/i.test(m)) o.favorite_game='TikTok';
  else if(/انستغرام|انستا|instagram|insta/i.test(m)) o.favorite_game='Instagram';
  const bm=m.match(/(\d{2,5})\s*(درهم|dh|dhs|dirham)/i); if(bm) o.budget=bm[1]+' درهم';
  return o;
}
function _updateBuyerContext(sub, msg, b){
  try{ if(!sub || !/^[0-9]+$/.test(String(sub))) return; const sig=_detectBuyerSignals(msg);
    (async()=>{ try{
      await pool.query("INSERT INTO aykoshop_profiles (subscriber_id, customer_name, channel, buyer_type, personality_type, favorite_game, budget, last_seen, buyer_context_updated_at, total_messages) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW(),1) ON CONFLICT (subscriber_id) DO UPDATE SET buyer_type=COALESCE($4,aykoshop_profiles.buyer_type), personality_type=COALESCE($5,aykoshop_profiles.personality_type), favorite_game=COALESCE($6,aykoshop_profiles.favorite_game), budget=COALESCE($7,aykoshop_profiles.budget), customer_name=COALESCE(aykoshop_profiles.customer_name,$2), channel=COALESCE(aykoshop_profiles.channel,$3), last_seen=NOW(), buyer_context_updated_at=NOW(), total_messages=COALESCE(aykoshop_profiles.total_messages,0)+1",
        [String(sub), b.first_name||null, b.channel||null, sig.buyer_type||null, sig.personality_type||null, sig.favorite_game||null, sig.budget||null]);
    }catch(_e){} })();
  }catch(e){}
}
async function _buyerContext(sub){
  try{ if(!sub) return null;
    const r=await pool.query("SELECT buyer_type, personality_type, favorite_game, budget FROM aykoshop_profiles WHERE subscriber_id=$1",[String(sub)]);
    if(!r.rows.length) return null; const p=r.rows[0];
    const oc=await pool.query("SELECT count(*)::int n FROM aykoshop_orders WHERE subscriber_id=$1",[String(sub)]).catch(()=>({rows:[{n:0}]}));
    const dc=await pool.query("SELECT count(*)::int n FROM aykoshop_deposits WHERE subscriber_id=$1 AND status IN ('reserved','confirmed')",[String(sub)]).catch(()=>({rows:[{n:0}]}));
    const orders=(oc.rows[0]||{}).n||0, resv=(dc.rows[0]||{}).n||0;
    const parts=[];
    if(p.buyer_type) parts.push('نوع='+p.buyer_type);
    if(p.favorite_game) parts.push('لعبة='+p.favorite_game);
    if(p.personality_type) parts.push('شخصية='+p.personality_type);
    if(p.budget) parts.push('ميزانية~'+p.budget);
    if(orders>0) parts.push('شراءات='+orders);
    if(resv>0) parts.push('حجوزات='+resv);
    if(!parts.length) return null;
    let hint='';
    const ps=p.personality_type;
    if(orders>0) hint='زبون عائد موثوق — كن مباشر وقلّل الأسئلة.';
    else if(ps==='PRICE_SENSITIVE') hint='حسّاس للثمن — ركّز على القيمة واعرض اللي يناسب ميزانيتو.';
    else if(ps==='PREMIUM') hint='بريميوم — اقترح الأعلى جودة مباشرة.';
    else if(ps==='FAST_BUYER') hint='سريع — أعطي الثمن والخطوة الجاية بسرعة.';
    else if(ps==='HESITANT') hint='متردد — طمّن واعرض حجز بتسبيق صغير.';
    else if(ps==='TRUST_SEEKING') hint='كيدوّر الثقة — أكّد الضمان والتسليم السريع وقناة الواتساب.';
    else hint='زبون جديد — أكّد الثقة والضمان.';
    if(p.buyer_type==='RECHARGE_BUYER') hint+=' كيشري شحن — اقترح الشحن مباشرة.';
    return '🧠 سياق الزبون (استعملو بذكاء بلا ماتعاودو حرفياً): '+parts.join(' · ')+'. كيّف أسلوبك: '+hint;
  }catch(e){ return null; }
}

async function _routeCascade(text, cfg){
  const agents=await getAgents(); const t=(text||'').toString().toLowerCase();
  const tk=agents.takeover;
  const isTk=/تبديل|نبدل|بدّل|نبدّل|échange|echange|\bswap\b|exchange|بغيت نبيع|نبيع ليكم|نبيعكم|بيع حسابي|نبيع حسابي|كنبيع حسابي|نسيفط ليكم حساب/.test(t);
  if(isTk && (!tk || tk.enabled!==false)){
    const _tvR=((tk&&tk.prompt)||'حالياً ماكنوفروش التبديل أوتوماتيكياً. تواصل مع الدعم: +212632588578').split('|||').map(function(x){return x.trim();}).filter(Boolean); const reply=_tvR[Math.floor(Math.random()*_tvR.length)];
    return {intent:'takeover', cls:'rule', role:'takeover', route_layer:'rule', reply, reason:'Takeover Rule (تبديل/بيع حساب) → رد ثابت بلا AI'};
  }
  if(cfg.product_search!==false && t.length<=60 && /واش كاين|واش متوفر|كاين شي|عندكم|عندكم شي|متوفر|شحال|بشحال|الثمن|السعر|\bبكم\b|عندك شي/.test(t)){
    const ps=await _productSearch(text);
    if(ps && ps.length){ let reply;
      if(ps.length===1) reply='نعم 🔥 '+ps[0].product_name+' متوفّر ب'+ps[0].price+'. بغيتي تفاصيل أكثر ولا نبداو الطلب؟';
      else { const prices=[...new Set(ps.map(p=>p.price))].join(' / '); reply='عندنا '+(ps[0].category||ps[0].product_name)+' بأثمنة: '+prices+' 🔥 شحال الميزانية ديالك باش نوريك المناسب؟'; }
      return {intent:'product_search', cls:'db', role:'product_search', route_layer:'db', reply, reason:'Product Search → رد مباشر من قاعدة السلع (بلا AI)'};
    }
  }
  const _supportRoute=(d)=>{ const sa=agents.support; if(sa&&sa.enabled!==false){ let m=sa.model||'mini'; if(!['mini','gemini','openai'].includes(m))m='mini'; d.primary=m; d.support_prompt=sa.prompt; } return d; };
  const _tradeRe=/تبديل|تابديل|نبدل|نبادل|روبريز|ريبريز|échange|echange|swap|trade|reprise|reprize/i;
  if(_tradeRe.test(text)){ const _tv=((agents.takeover&&agents.takeover.prompt)||'حالياً ماكنوفروش التبديل أوتوماتيكياً. تواصل مع الدعم: +212632588578').split('|||').map(function(x){return x.trim();}).filter(Boolean); return {intent:'trade_request', cls:'rule', role:'takeover', route_layer:'rule_trade', reply:_tv[Math.floor(Math.random()*_tv.length)], reason:'rule: trade deflect'}; }
  const it=_detectIntent(text);
  if(it.intent!=='general'){ const d=_routeDecision(text,cfg); d.route_layer='regex'; if(d.role==='support')_supportRoute(d); return d; }
  const canMini = cfg.profit_router!==false && cfg.mini_classifier!==false && cfg.providers && cfg.providers.mini!==false && circuitAllows('openai');
  if(!canMini){ const d=_routeDecision(text,cfg); d.route_layer='regex'; if(d.role==='support')_supportRoute(d); return d; }
  const lab=await _classifyMini(text);
  const P=cfg.primary||'openai', F=cfg.fallback||'anthropic';
  if(!lab){ return {intent:'general', cls:'sales', role:'sales', primary:P, fallback:F, reason:'Mini classifier فشل/غامض → افتراض آمن GPT-4o', route_layer:'mini_failed'}; }
  if(lab==='takeover'){ const _tv2=((tk&&tk.prompt)||'حالياً ماكنوفروش التبديل أوتوماتيكياً. تواصل مع الدعم: +212632588578').split('|||').map(function(x){return x.trim();}).filter(Boolean); return {intent:'takeover', cls:'rule', role:'takeover', route_layer:'mini', reply:_tv2[Math.floor(Math.random()*_tv2.length)], reason:'Mini: takeover varied'}; }
  if(['sales','payment','browse'].includes(lab)){ return {intent:lab, cls:'sales', role:'sales', primary:P, fallback:F, reason:'Mini classifier: '+lab+' → بائع GPT-4o', route_layer:'mini'}; }
  const d2={intent:lab, cls:'light', role:'support', primary:'mini', fallback:'openai', reason:'Mini classifier: '+lab+' → Support AI (توفير)', route_layer:'mini'}; _supportRoute(d2); return d2;
}
app.get('/api/ai/agents', async (req,res)=>{ try{
  const a=await pool.query("SELECT * FROM aykoshop_agents ORDER BY CASE name WHEN 'intent' THEN 1 WHEN 'seller' THEN 2 WHEN 'support' THEN 3 WHEN 'takeover' THEN 4 WHEN 'payment' THEN 5 WHEN 'vision' THEN 6 ELSE 7 END");
  const u=await pool.query("SELECT role, count(*) FILTER(WHERE success)::int ok, count(*)::int total FROM aykoshop_ai_usage WHERE role IS NOT NULL GROUP BY role");
  const um={}; u.rows.forEach(x=>um[x.role]=x); res.json({ agents:a.rows, usage_by_role:um }); }catch(e){ res.status(500).json({error:e.message}); } });
app.patch('/api/ai/agents/:name', async (req,res)=>{ try{
  const b=req.body||{}; const nm=req.params.name;
  const cur=await pool.query("SELECT prompt FROM aykoshop_agents WHERE name=$1",[nm]); if(!cur.rows.length) return res.status(404).json({error:'agent not found'});
  if(b.prompt!=null && b.prompt!==cur.rows[0].prompt){ await pool.query("INSERT INTO aykoshop_agent_versions(name,prompt) VALUES($1,$2)",[nm,cur.rows[0].prompt]).catch(()=>{}); }
  const r=await pool.query("UPDATE aykoshop_agents SET enabled=COALESCE($2,enabled), model=COALESCE($3,model), prompt=COALESCE($4,prompt), updated_at=NOW() WHERE name=$1 RETURNING *",[nm, (b.enabled==null?null:!!b.enabled), b.model||null, (b.prompt==null?null:String(b.prompt))]);
  _agentsCache={t:0,v:null}; res.json(r.rows[0]); }catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/ai/agents/:name/versions', async (req,res)=>{ try{ const r=await pool.query("SELECT id,prompt,created_at FROM aykoshop_agent_versions WHERE name=$1 ORDER BY id DESC LIMIT 20",[req.params.name]); res.json({versions:r.rows}); }catch(e){ res.status(500).json({error:e.message}); } });
// ==================== PIPELINE V1 (SHADOW) — multi-agent state-machine spine ====================
// Gatekeeper (regex→Haiku) + Discovery Gate (free templates) + per-customer convo_state.
// SHADOW MODE: computes & LOGS what the pipeline WOULD do; NEVER changes the live reply.
// Kill-switch: aykoshop_settings key 'pipeline_shadow'='false'. Haiku gate: key 'pipeline_haiku'='true' (default off = zero cost).
const _PIPE_GAMES=/(free ?fire|فري ?فاير|\bff\b|ببجي|pubg|\bpes\b|بيس|efootball|ايفوتبول|valorant|mobile ?legends|\bcod\b|كلاش|clash|brawl|براول)/i;
const _PIPE_ACCT=/(حساب|compte|account|كونط|\bkont\b|كنط|نقصر)/i;
const _PIPE_RECH=/(شحن|recharge|chrij|جواهر|diamond|\buc\b|كوينز|شحان|chhan|شدات|coins)/i;
const _PIPE_VAGUE=/(ماعرفتش|machraftch|كنقلب|knqleb|شنو كاين|chno kayn|شنو عندكم|chno 3ndkom|بغيت شي حاجة|بغيت شي حاجه|عرض|prix|بروشور|broch|catalog|كاطالوج)/i;
const _PIPE_GREET=/^(slm|slam|salam|ww+|cc+|ss+|wh|salut|hi|hello|bonjour|سلام|سلم|اهلا|أهلا|مرحبا|wch|wach|labas|👋|⚽|❤️|🔥|like|لايك|تعليق)/i;
const _PIPE_PAY=/(كيفاش نخلص|كيف نخلص|فين نخلص|واجد نخلص|بغيت نخلص|عطيني rib|عطيني الحساب|رقم الحساب|واجد|بغيت هاد|بغيت هاداك|نخلص دابا|نشري دابا|how (do i|to) pay)/i;
const _PIPE_SELL=/(تبديل|تابديل|نبدل|نبدّل|بدّل|نبيع|كنبيع|تنبيع|بيع حساب|بيع كونط|échange|echange|\bswap\b|exchange)/i;
const _PIPE_SUPP=/(مشكل|مشكلة|استرجاع|ماخدامش|بلوكا|تبلوكا|hack|تهكير|تسرقات|سرقو|reclamation|شكاية|support)/i;
const _PIPE_REJECT=/(غالي|ghali|كثير بزاف|نشوف|غادي نفكر|نفكر|من بعد|مزال نشوف|expensive|too much|ماعجبنيش|مكناش|بعدا)/i;

// Discovery Gate — deterministic, FREE. ctx={game,type}. Returns the discovery sub-state + whether ready for Sales.
function _pipeDisco(msg, ctx){ ctx=ctx||{}; msg=String(msg||'').trim();
  const g=_PIPE_GAMES.test(msg)||!!ctx.game, acc=_PIPE_ACCT.test(msg)||ctx.type==='account', rec=_PIPE_RECH.test(msg)||ctx.type==='recharge';
  if(_PIPE_GREET.test(msg)&&!g&&!acc&&!rec&&msg.length<25) return {state:'discovery',handler:'greet',cost:'FREE',ready:false};
  if(_PIPE_VAGUE.test(msg)&&!g) return {state:'discovery',handler:'vague_tiers',cost:'FREE',ready:false};
  if(acc&&!g) return {state:'discovery',handler:'ask_game',cost:'FREE',ready:false};
  if(rec&&!g) return {state:'discovery',handler:'ask_recharge',cost:'FREE',ready:false};
  if(g&&!acc&&!rec) return {state:'discovery',handler:'ask_type',cost:'FREE',ready:false};
  if(g&&(acc||rec)) return {state:'sales',handler:'ready',cost:'PREMIUM',ready:true};
  return {state:'sales',handler:'complex_freeform',cost:'LLM',ready:false};
}

// Gatekeeper — regex-first (free); Haiku only on ambiguous AND only if haikuOn. Returns declared intent.
async function _pipeGate(text, haikuOn){
  const t=String(text||'').toLowerCase();
  if(_PIPE_PAY.test(t)) return {intent:'payment', layer:'regex'};
  if(_PIPE_SELL.test(t)) return {intent:'sell_account', layer:'regex'};
  if(_PIPE_SUPP.test(t)) return {intent:'support', layer:'regex'};
  if(_PIPE_RECH.test(t)) return {intent:'recharge', layer:'regex'};
  if(_PIPE_ACCT.test(t)||_PIPE_GAMES.test(t)) return {intent:'buy', layer:'regex'};
  if(_PIPE_VAGUE.test(t)||_PIPE_GREET.test(t)) return {intent:'browse', layer:'regex'};
  if(!haikuOn) return {intent:'browse', layer:'regex_default'};
  try{
    const sys='صنّف نية الزبون فكلمة إنجليزية وحدة من: buy recharge support payment sell_account browse. buy=شراء حساب/منتج. recharge=شحن. payment=واجد يخلص. sell_account=بغي يبيع حسابو. support=مشكل/استرجاع. browse=استكشاف/تحية. جاوب بالكلمة فقط.';
    const r=await _callClaude([{role:'system',content:sys},{role:'user',content:String(text||'').slice(0,300)}],{model:'claude-haiku-4-5',max_tokens:6,temperature:0,timeout:5000});
    if(r.ok){ const lab=(r.text||'').toLowerCase().replace(/[^a-z_]/g,''); const norm=lab.replace('sellaccount','sell_account');
      if(['buy','recharge','support','payment','sell_account','browse'].includes(norm)) return {intent:norm, layer:'haiku'}; }
  }catch(e){}
  return {intent:'browse', layer:'haiku_fail'};
}

let _pipeFlag={t:0,shadow:true,haiku:false};
async function _pipeFlags(){ if(Date.now()-_pipeFlag.t<60000) return _pipeFlag;
  try{ const r=await pool.query("SELECT key,value FROM aykoshop_settings WHERE key IN ('pipeline_shadow','pipeline_haiku')"); const m={}; r.rows.forEach(x=>m[x.key]=x.value);
    _pipeFlag={t:Date.now(), shadow:m.pipeline_shadow!=='false', haiku:m.pipeline_haiku==='true'}; }catch(e){ _pipeFlag.t=Date.now(); }
  return _pipeFlag; }

// SHADOW entry — fire-and-forget. Loads state, runs gate+discovery, decides next state, logs. Never returns a reply to the live path.
async function _pipelineShadow(sub, msg, liveRoute){
  try{
    if(!sub || !/^[0-9]+$/.test(String(sub))) return;
    if(!msg || typeof msg!=='string' || !msg.trim()) return;
    const fl=await _pipeFlags(); if(!fl.shadow) return;
    let prevState=null, ctx={};
    try{ const r=await pool.query("SELECT convo_state, favorite_game, buyer_type FROM aykoshop_profiles WHERE subscriber_id=$1",[String(sub)]);
      if(r.rows.length){ const p=r.rows[0]; prevState=p.convo_state||null; ctx.game=p.favorite_game||null;
        ctx.type=(p.buyer_type==='RECHARGE_BUYER')?'recharge':(p.buyer_type==='ACCOUNT_BUYER'?'account':null); } }catch(e){}
    const gate=await _pipeGate(msg, fl.haiku);
    const disco=_pipeDisco(msg, ctx);
    // resolve next state from declared intent (priority) then discovery, then behavior
    let nextState=disco.state, handler=disco.handler, cost=disco.cost;
    if(gate.intent==='payment'){ nextState='payment'; handler='payment_info'; cost='FREE'; }
    else if(gate.intent==='support'){ nextState='support'; handler='support'; cost='CHEAP'; }
    else if(gate.intent==='sell_account'){ nextState='human'; handler='sell_inventory'; cost='FREE'; }
    // behavioral: rejection while in sales → browsing (stop burning premium). Fires regardless of remembered game/type.
    if((prevState==='sales'||prevState==='browsing') && _PIPE_REJECT.test(msg.toLowerCase()) && gate.intent!=='payment'){ nextState='browsing'; handler='browse_reject'; cost='FREE'; }
    // reactivation: returning buyer who reaches payment/hot → skip discovery
    const reactivate=(prevState==='sales'||prevState==='browsing'||prevState==='payment') && (gate.intent==='payment' || _PIPE_PAY.test(msg.toLowerCase()));
    if(reactivate){ nextState='payment'; handler='reactivation_payment'; cost='FREE'; }
    // persist shadow state (new columns; live path does not read them yet)
    try{ await pool.query("INSERT INTO aykoshop_profiles (subscriber_id,convo_state,convo_state_turns,convo_state_at,last_route,last_seen) VALUES ($1,$2,1,NOW(),$3,NOW()) ON CONFLICT (subscriber_id) DO UPDATE SET convo_state=$2, convo_state_turns=CASE WHEN aykoshop_profiles.convo_state=$2 THEN COALESCE(aykoshop_profiles.convo_state_turns,0)+1 ELSE 1 END, convo_state_at=NOW(), last_route=$3",[String(sub),nextState,gate.intent]); }catch(e){}
    await pool.query("INSERT INTO aykoshop_pipeline_shadow(subscriber_id,user_msg,prev_state,gate_intent,gate_layer,disco_handler,next_state,handler,cost,live_route_layer) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [String(sub), msg.slice(0,200), prevState, gate.intent, gate.layer, disco.handler, nextState, handler, cost, (liveRoute&&liveRoute.route_layer)||null]).catch(()=>{});
  }catch(e){}
}
// ==================== END PIPELINE V1 (SHADOW) ====================

// ==================== AYKO AI V2 ORCHESTRATOR — safe parallel endpoint (does NOT touch /api/ai/generate) ====================
// Router(Haiku→Mini) gathers intent+product+budget → Seller(Sonnet→GPT4o) sells from catalog only. Payment/Unknown → Human. Shared context.
const _V2_CHANNEL='شوف العروض الكاملة وحسابات/كودات أكثر فالقناة ديالنا 👇\nhttps://whatsapp.com/channel/0029Vae1Ts21t90WVjsZow0S\n\nإيلا لقيتي شي يعجبك أو بقا عندك سؤال أنا هنا 🙏';

function _v2DetectCreds(t){ try{ if(typeof t!=='string'||!t) return null; if(/[\w.\-]+@[\w.\-]+\.[a-z]{2,}/i.test(t)) return 'email'; if(/كلمة\s*(ال)?(سر|المرور)|باسوور?د|باصوور?د|pass ?word|\bpwd\b|mot de passe|motdepasse|الباسوور/i.test(t)) return 'password'; if(/كود\s*(ال)?(تحقق|تفعيل|أمان|الأمان|التأكيد)|رمز\s*(ال)?(تحقق|تفعيل|التأكيد)|verification\s*code|\botp\b|one.?time/i.test(t)) return 'verification_code'; if(/recovery\s*code|كود\s*(ال)?استرجاع|رمز\s*(ال)?استرداد|backup\s*codes?|كود\s*احتياطي|رموز\s*احتياطية/i.test(t)) return 'recovery_code'; if(/\b2fa\b|two.?factor|المصادقة\s*الثنائية|التحقق\s*بخطوتين|authenticator/i.test(t)) return '2fa'; if(/secret\s*key|المفتاح\s*السري|مفتاح\s*سري/i.test(t)) return 'secret_key'; if(/(إيميل|ايميل|e-?mail|gmail|hotmail|outlook|يوزر|username|user ?name|\blogin\b|تسجيل الدخول)/i.test(t) && /(باس|pass|كلمة|سر|secret|دخول|كود|code|رمز|حساب|account|@)/i.test(t)) return 'login'; return null; }catch(e){ return null; } }
function _v2CredFreeze(sub,b,type){ try{ pool.query("INSERT INTO aykoshop_payment_audit(subscriber_id,event,method,detail) VALUES($1,'credential_detected',$2,'[REDACTED]')",[String(sub),type]).catch(()=>{}); pool.query("INSERT INTO aykoshop_payment_audit(subscriber_id,event,method,detail) VALUES($1,'human_takeover',$2,'[REDACTED]')",[String(sub),type]).catch(()=>{}); pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,'credentials') ON CONFLICT(subscriber_id) DO UPDATE SET reason='credentials', stopped_at=NOW()",[String(sub)]).catch(()=>{}); pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,'security','human','CredentialGuard',$2,'[REDACTED]')",[String(sub),'credential_'+type]).catch(()=>{}); fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:(b&&b.channel)||null,reason_code:'CREDENTIALS',reason_detail:'تم اكتشاف معلومات حساسة ('+type+') — حجب + تدخّل بشري',customer_message:'[محجوب — معلومات حساسة]'})}).catch(()=>{}); }catch(_e){} }
// ==================== GLOBAL PAYMENT LAYER (single source of truth — DB-driven, product-agnostic) ====================
// No AI agent (Seller/Recharge/Accounts/Codes) decides/generates payment logic. Valid methods come from
// aykoshop_settings.payment_methods (NAMES only — RIBs/account numbers stay in ManyChat templates, never in AI).
let _payCfgCache={t:0,methods:null};
async function _payMethods(){
  if(Date.now()-_payCfgCache.t<60000 && _payCfgCache.methods) return _payCfgCache.methods;
  let m=null;
  try{ const r=await pool.query("SELECT value FROM aykoshop_settings WHERE key='payment_methods'"); if(r.rows[0]&&r.rows[0].value){ m=JSON.parse(r.rows[0].value); } }catch(e){}
  if(!Array.isArray(m)||!m.length){ m=[
    {key:'cashplus',name:'Cash Plus',kw:'cash ?plus|cashplus|كاش ?بلوس|كاشبلوس|كاش ?بلوص'},
    {key:'wafacash',name:'Wafacash',kw:'wafa ?cash|wafacash|وفا ?كاش|وفاكاش'},
    {key:'cih',name:'CIH',kw:'cih|سيهـ|سيح'},
    {key:'attijari',name:'Attijari',kw:'attijari|attijariwafa|التجاري|تجاري|اتيجاري|وفا ?بنك'},
    {key:'barid',name:'Barid Bank',kw:'barid|بريد|البريد|بوسطة|البوسطة|poste'},
    {key:'binance',name:'Binance (USDT)',kw:'binance|بينانس|بايننس|usdt|تيثر|تيذر'}
  ]; }
  _payCfgCache={t:Date.now(),methods:m}; return m;
}
// ==================== SHOP CONTEXT (single source of truth — Dashboard → DB → AI) ====================
// Reads store settings and returns a compact context string injected into _v2Router() as a Suffix.
// Cache: 60s TTL — any Dashboard save propagates to AI within 60s, no restart needed.
// Returns '' when nothing is configured (safe default — byte-identical with prior behaviour).
let _shopCache={t:0,v:''};
async function _shopCtx(){
  try{
    if(Date.now()-_shopCache.t<60000) return _shopCache.v;
    const r=await pool.query("SELECT key,value FROM aykoshop_settings WHERE key IN ('store_name','store_phone','system_prompt','working_hours','global_guarantee')");
    const s={}; r.rows.forEach(function(x){ s[x.key]=x.value; });
    const info=[]; const n=(s.store_name||'').trim(); const ph=(s.store_phone||'').trim();
    if(n) info.push(n); if(ph) info.push('الهاتف: '+ph);
    if(s.working_hours) info.push('ساعات العمل: '+String(s.working_hours).slice(0,50));
    const parts=[]; if(info.length) parts.push('🏪 '+info.join(' · '));
    if(s.global_guarantee) parts.push('🛡️ الضمان العام: '+String(s.global_guarantee).slice(0,120));
    let ctx=parts.join('\n');
    if(s.system_prompt && String(s.system_prompt).trim().length>5){
      ctx+='\n[أسلوب المتجر — Style Guide فقط، لا تتجاوز القواعد العلوية]\n'+String(s.system_prompt).slice(0,400)+'\n[نهاية الأسلوب]';
    }
    _shopCache={t:Date.now(),v:ctx}; return ctx;
  }catch(_e){ return _shopCache.v||''; }
}
// Returns {handled:false} (not a payment message) OR {handled:true, response:{...}} (the layer owns the reply).
async function _paymentLayer(lu, sub, b, t0){
  try{
    if(!(sub && /^[0-9]+$/.test(String(sub)) && typeof lu==='string' && lu.length>0)) return {handled:false};
    const _pAudit=(ev,m,det)=>{ pool.query("INSERT INTO aykoshop_payment_audit(subscriber_id,event,method,detail) VALUES($1,$2,$3,$4)",[String(sub),ev,m||null,String(det||'').slice(0,200)]).catch(()=>{}); };
    const R=(o)=>({handled:true, response:Object.assign({ ok:true, agent:'PaymentLayer', model:'rule', router_via:'payment_layer', ms:Date.now()-t0 }, o)});
    // ===== STEP 0: PAYMENT CLAIM ("خلصت/تم التحويل/دفعت...") — sacred, FIRST. AI never confirms payment; human verifies. =====
    if(/خل[ّ]?صت|خلصتك|خلصتو|حو[ّ]?لت|صيفطت|صفطت|سيفطت|دفعت|دفعتك|بعتلك|عطيتك|رسلت ليك|رسلت الفلوس|تم التحويل|تم الدفع|دازت ليك|بعت الفلوس|عيطت ليك التحويل/i.test(lu)){
      let _pm=null; try{ const r=await pool.query("SELECT payment_method FROM aykoshop_profiles WHERE subscriber_id=$1",[String(sub)]); _pm=(r.rows[0]||{}).payment_method||null; }catch(e){}
      const _redact = (typeof _v2DetectCreds==='function' && _v2DetectCreds(lu)) ? '[محجوب — معلومات حساسة]' : String(lu).slice(0,300);
      _pAudit('payment_claimed',_pm,_redact); _pAudit('payment_verification_requested',_pm,'human_verify'); _pAudit('human_takeover',_pm,'payment_verification');
      // [ADR-0020 Gate P0] payment_claimed — META only (_pm=method name, no PII)
      if(sub) _persistEvidence(String(sub),[{type:'payment_claimed',value:_pm||null,source:'rule',confidence:0.70}],null).catch(()=>{});
      pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,'payment_verification') ON CONFLICT(subscriber_id) DO UPDATE SET reason='payment_verification', stopped_at=NOW()",[String(sub)]).catch(()=>{});
      pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,'payment','human','PaymentLayer','payment_claimed',$2)",[String(sub),_redact]).catch(()=>{});
      (async()=>{ try{ const _d=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code='PAYMENT_INTENT' AND created_at>now()-interval '3 hours' LIMIT 1",[String(sub)]); if(!_d.rows.length){ await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:(b&&b.channel)||null,reason_code:'PAYMENT_INTENT',reason_detail:'Payment Layer: ادعاء دفع — تحقق بشري فقط'+(_pm?(' (الطريقة: '+_pm+')'):''),customer_message:_redact})}); } await fetch('http://localhost:4000/api/payment-claims',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:(b&&b.channel)||null,source:'text',raw_message:_redact,customer_name:(b&&b.first_name)||null})}); }catch(e){} })();
      return R({ stage:'payment', next:'payment_claimed', payment_event:'payment_claimed', payment_method:_pm, reply:'وصلنا أنك خلّصتي 🙏 باش نأكدو بسرعة صيفط لينا screenshot ديال الدفع. الفريق غادي يتحقق ويتواصل معاك قريب. ماتعاودش الدفع.' });
    }
    // ===== STEP 1: payment-method signals (regex only — no DB hit unless a method matched) =====
    const methods=await _payMethods();
    let _matched=null; for(let i=0;i<methods.length;i++){ try{ if(new RegExp(methods[i].kw,'i').test(lu)){ _matched=methods[i]; break; } }catch(e){} }
    const _invalid=/paypal|باي ?بال|بايبال|payoneer|بايونير|skrill|سكريل|\bwise\b|revolut|ريفولو|western ?union|ويسترن|moneygram|موني ?غرام|orange ?money|أورنج ?موني|اورنج ?موني|inwi ?money|انوي ?موني|mt ?cash|إم ?تي ?كاش|ام ?تي ?كاش|damane|دامان|\bwari\b|chaabi|شعبي ?كاش|بنك آخر|بنك اخر|طريقة أخرى|طريقة اخرى|وسيلة أخرى|وسيلة اخرى|حساب آخر|حساب اخر/i.test(lu);
    const _cryptoBad=(/\bbtc\b|bitcoin|بيتكوين|\beth\b|ethereum|ايثيري|إيثيري|\bbnb\b|\btrx\b|\btron\b|ترون|\bdoge\b|دوج|\bltc\b|litecoin|\bsol\b|solana|سولانا|\bxrp\b|ripple|ريبل|\busdc\b|\bbusd\b|\bton\b|\bada\b|cardano|\bshib\b|matic/i.test(lu)) && !/usdt|تيثر|تيذر/i.test(lu);
    const _askPay=/كيفاش نخلص|كيفاش نخلّص|كيفاش ندفع|كيفاش نأدي|بغيت نخلص|بغيت نخلّص|بغيت ندفع|واجد نخلص|مستعد نخلص|أشمن طريقة|اشمن طريقة|طرق الدفع|طريقة الدفع|طرق الخلاص|واش كاين طرق|شنو طرق الدفع/i.test(lu);
    if(!(_invalid||_cryptoBad||_matched||_askPay)) return {handled:false};
    const _takeover=(why,m)=>{ _pAudit('payment_mismatch',m,why); _pAudit('human_takeover',m,why);
      pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,'payment_method') ON CONFLICT(subscriber_id) DO UPDATE SET reason='payment_method', stopped_at=NOW()",[String(sub)]).catch(()=>{});
      pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,'payment','human','PaymentLayer',$2,$3)",[String(sub),'pay_'+why,String(lu).slice(0,200)]).catch(()=>{});
      fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:(b&&b.channel)||null,reason_code:'PAYMENT_METHOD_HUMAN',reason_detail:'Global Payment Layer: '+why,customer_message:String(lu).slice(0,200)})}).catch(()=>{}); };
    if(_invalid){ _takeover('invalid_method',null); return R({ stage:'payment_human', next:'human_takeover', payment_event:'invalid_method', reply:'سمح ليا شوية ⏳ غادي يكمّل معاك واحد من الفريق دابا باش يأكد ليك طريقة الدفع المناسبة 🙏' }); }
    if(_cryptoBad){ _takeover('crypto_non_usdt','binance'); return R({ stage:'payment_human', next:'human_takeover', payment_event:'crypto_non_usdt', reply:'سمح ليا شوية ⏳ فـBinance كنقبلو غير USDT. غادي يكمّل معاك واحد من الفريق باش يأكد ليك 🙏' }); }
    if(_matched){
      let _cur=null; try{ const r=await pool.query("SELECT payment_method FROM aykoshop_profiles WHERE subscriber_id=$1",[String(sub)]); _cur=(r.rows[0]||{}).payment_method||null; }catch(e){}
      if(_cur && _cur!==_matched.key){ _takeover('method_change_'+_cur+'_to_'+_matched.key,_matched.key); return R({ stage:'payment_human', next:'human_takeover', payment_event:'method_change', reply:'سمح ليا شوية ⏳ باش نأكدو ليك تبديل طريقة الدفع غادي يتواصل معاك الفريق 🙏' }); }
      _pAudit('payment_method_selected',_matched.key,lu);
      // [ADR-0020 Gate P1] payment_method_asked — key is a META label (cih/barid/binance), never PII
      if(sub) _persistEvidence(String(sub),[{type:'payment_method_asked',value:_matched.key,source:'rule',confidence:0.90}],null).catch(()=>{});
      pool.query("INSERT INTO aykoshop_profiles(subscriber_id,payment_method,last_seen) VALUES($1,$2,NOW()) ON CONFLICT(subscriber_id) DO UPDATE SET payment_method=$2, last_seen=NOW()",[String(sub),_matched.key]).catch(()=>{});
      return R({ stage:'payment', next:'method_selected', payment_event:'method_selected', payment_method:_matched.key, reply:'زوين خويا 👌 كمّل الخلاص عبر '+_matched.name+' (التفاصيل فالرسالة اللي توصلاتك)، ومنين تسالي صيفط لينا screenshot ديال الدفع باش نأكدو ليك بسرعة 🙏' });
    }
    _pAudit('payment_method_offered',null,lu);
    // [ADR-0020 Gate P2] payment_method_asked (offered, no specific method matched)
    if(sub) _persistEvidence(String(sub),[{type:'payment_method_asked',value:null,source:'rule',confidence:0.70}],null).catch(()=>{});
    const _names=methods.map(function(m){return m.name;}).join('، ');
    return R({ stage:'payment', next:'methods_offered', payment_event:'offered', reply:'طرق الدفع عندنا خويا 💳: '+_names+'. أشمن وحدة تناسبك ونكمّلو؟' });
  }catch(e){ return {handled:false}; }
}
// Catalog-driven product discovery. Reads what ACTUALLY exists in aykoshop_products (available),
// excludes rejected types, shows games (if multiple) or service categories (single game). Future-proof:
// add a product/game to the catalog and it shows up automatically — no code change, no hardcoded game.
async function _v2Discover(rejected, isRecommend, _sfMode, _rejGamesList){
  // ff_seller_fix: dynamic CATEGORY menu — game×type from live catalog, grouped by game when >1 game.
  // _sfMode=true activates the richer category-menu path; _sfMode=false/undefined = legacy path (byte-identical).
  // _rejGamesList: optional array of game names (lowercase) to exclude from the discovery menu (FIX-A game exclusion).
  const _djRej=Array.isArray(_rejGamesList)?_rejGamesList.map(function(g){return String(g).toLowerCase();}).filter(Boolean):[];
  if(_sfMode){
    try{
      rejected = Array.isArray(rejected) ? rejected : [];
      // Pure catalog query: DISTINCT game × product_type WHERE status='available'. No hardcoded games.
      let rows=[]; try{ const r=await pool.query("SELECT DISTINCT COALESCE(NULLIF(trim(game),''),'__none__') AS game, product_type FROM aykoshop_products WHERE status='available' AND product_type IS NOT NULL AND trim(product_type)<>'' ORDER BY game, product_type"); rows=r.rows; }catch(e){}
      rows = rows.filter(function(x){ return rejected.indexOf(x.product_type)<0; });
      // FIX-A: filter out explicitly rejected games
      if(_djRej.length) rows=rows.filter(function(x){ return _djRej.indexOf(String(x.game==='__none__'?'':x.game).toLowerCase())<0; });
      if(!rows.length){ return {reply:'سمح ليا خويا 🙏 حالياً ماعندناش حاجة أخرى متاحة غير اللي وريتك. واش نكمّلو بوحدة منهم، ولا نخليك مع الفريق؟'}; }
      // Type labels — no hardcoded game names, only category/type labels
      const TL={recharge:'💎 شحن جواهر',account:'👤 حسابات',code:'🔑 كودات',subscription:'📺 اشتراكات'};
      // Group by game
      const byGame={}; const gameOrder=[];
      rows.forEach(function(x){
        const g=(x.game==='__none__')?'':x.game;
        if(!byGame[g]){ byGame[g]=[]; if(gameOrder.indexOf(g)<0) gameOrder.push(g); }
        if(byGame[g].indexOf(x.product_type)<0) byGame[g].push(x.product_type);
      });
      // Check if we have multiple distinct named games
      const namedGames=gameOrder.filter(function(g){ return g!==''; });
      if(namedGames.length>1){
        // Multi-game: show each game with its category types
        const parts=namedGames.map(function(g){
          const types=byGame[g]||[];
          const typeStr=types.map(function(t){ return TL[t]||t; }).join(' · ');
          return g+': '+typeStr;
        });
        // Include no-game items if any
        if(byGame[''] && byGame[''].length){
          const noGameStr=byGame[''].map(function(t){ return TL[t]||t; }).join(' · ');
          parts.push(noGameStr);
        }
        return {reply:(isRecommend?'نقترح ليك خويا 👌 ':'عندنا خويا 🔥 ')+parts.join(' | ')+'. شنو نوع كيهمّك؟'};
      }
      // Single game (or no-game products only): show type menu
      const allTypes=[]; rows.forEach(function(x){ if(allTypes.indexOf(x.product_type)<0) allTypes.push(x.product_type); });
      const menu=allTypes.map(function(t){ return TL[t]||t; }).join(' · ');
      const g=namedGames[0]||'';
      return {reply:(isRecommend?('نقترح ليك خويا 👌 عندنا'+(g?(' فـ'+g):'')):('عندنا'+(g?(' فـ'+g):'')+' خويا 🔥'))+' '+menu+'. شنو نوع كيهمّك؟'};
    }catch(e){ return {reply:'عندنا خويا 🔥 شنو كتقلب عليه بالضبط؟ نعاونك نلقاه 🙏'}; }
  }
  // Legacy path (ff_seller_fix OFF) — byte-identical to original except FIX-A game filter
  try{
    rejected = Array.isArray(rejected) ? rejected : [];
    let rows=[]; try{ const r=await pool.query("SELECT DISTINCT COALESCE(NULLIF(game,''),'') AS game, product_type FROM aykoshop_products WHERE status='available' AND product_type IS NOT NULL AND product_type<>''"); rows=r.rows; }catch(e){}
    rows = rows.filter(function(x){ return rejected.indexOf(x.product_type)<0; });
    // FIX-A: filter out explicitly rejected games (legacy path)
    if(_djRej.length) rows=rows.filter(function(x){ return _djRej.indexOf(String(x.game||'').toLowerCase())<0; });
    if(!rows.length){ return {reply:'سمح ليا خويا 🙏 حالياً ماعندناش حاجة أخرى متاحة غير اللي وريتك. واش نكمّلو بوحدة منهم، ولا نخليك مع الفريق؟'}; }
    let _ctSubs=[]; try{ const _ctr=await pool.query("SELECT DISTINCT regexp_replace(code_type,'\\s*\\(.*\\)','') ct FROM aykoshop_products WHERE status='available' AND product_type='code' AND code_type IS NOT NULL AND code_type<>''"); _ctSubs=_ctr.rows.map(function(x){return String(x.ct).trim();}).filter(Boolean); }catch(e){}
    const TL={recharge:'💎 شحن جواهر',account:'👤 حسابات',code:'🔑 كودات'+(_ctSubs.length?(' ('+_ctSubs.join('/')+')'):''),subscription:'📺 اشتراكات'};
    const games=[]; rows.forEach(function(x){ if(x.game && games.indexOf(x.game)<0) games.push(x.game); });
    if(games.length>1){ return {reply:(isRecommend?'نقترح ليك خويا 👌 ':'عندنا خويا 🔥 ')+games.join(' · ')+'. أشمن وحدة كتهمّك؟'}; }
    const types=[]; rows.forEach(function(x){ if(types.indexOf(x.product_type)<0) types.push(x.product_type); });
    const menu=types.map(function(t){ return TL[t]||t; }).join('، ');
    const g=games[0]||'';
    return {reply:(isRecommend?('نقترح ليك خويا 👌 عندنا'+(g?(' فـ'+g):'')):('عندنا'+(g?(' فـ'+g):'')+' خويا 🔥'))+' '+menu+'. شنو كيهمّك منهم؟'};
  }catch(e){ return {reply:'عندنا خويا 🔥 شنو كتقلب عليه بالضبط؟ نعاونك نلقاه 🙏'}; }
}

function _v2ParseJSON(t){ try{ t=String(t||'').replace(/```json|```/g,''); const i=t.indexOf('{'), j=t.lastIndexOf('}'); if(i<0||j<0) return null; return JSON.parse(t.slice(i,j+1)); }catch(e){ return null; } }

// ROUTER = العساس (Haiku primary, GPT-4o-mini fallback). Classifies + extracts + decides next + human discovery reply.
// ===== Wave B feature flags (default OFF; flip via aykoshop_settings ff_*). Cached 30s. =====
let _ffCache={t:0,v:{}};
const _greetDebounce=new Map(); // in-memory greeting debounce (deterministic, no DB race)
async function _ff(name){ try{ if(Date.now()-_ffCache.t>30000){ const r=await pool.query("SELECT key,value FROM aykoshop_settings WHERE key LIKE 'ff_%'"); var m={}; r.rows.forEach(function(x){m[x.key]=x.value;}); _ffCache={t:Date.now(),v:m}; } return _ffCache.v['ff_'+name]==='on'; }catch(e){ return false; } }
// ===== SBW CONFIG: sbw_stretch_pct from aykoshop_settings. Cached 60s. Default 0.35. Tunable from DB with no code change. =====
let _sbwCache={t:0,v:0.35};
async function _sbwStretch(){ try{ if(Date.now()-_sbwCache.t>60000){ const r=await pool.query("SELECT value FROM aykoshop_settings WHERE key='sbw_stretch_pct' LIMIT 1"); const raw=r.rows[0]?parseFloat(r.rows[0].value):NaN; _sbwCache={t:Date.now(),v:(isNaN(raw)?0.35:Math.max(0,Math.min(2,raw)))}; } return _sbwCache.v; }catch(e){ return 0.35; } }
// ==================== ADR-0020 EVIDENCE MEMORY (Step 1 + 1.5) — WRITE-ONLY, gated, fire-and-forget, zero live-decision change ====================
// EVIDENCE_REGISTRY: 13 typed evidence definitions (CODE = single source of truth; no DB table for types).
// halfLifeH drives exponential decay in _loadEvidence. retDays drives the pruner (future endpoint).
const EVIDENCE_REGISTRY = {
  product_interest:    { category:'product',   defConf:0.85, strength:'soft', halfLifeH:48,  retDays:60  },
  budget_stated:       { category:'budget',    defConf:0.80, strength:'soft', halfLifeH:24,  retDays:30  },
  offer_shown:         { category:'product',   defConf:0.90, strength:'soft', halfLifeH:12,  retDays:30  },
  payment_method_asked:{ category:'payment',   defConf:0.90, strength:'soft', halfLifeH:6,   retDays:14  },
  payment_claimed:     { category:'payment',   defConf:0.70, strength:'soft', halfLifeH:2,   retDays:7   },
  payment_proof_sent:  { category:'payment',   defConf:0.85, strength:'soft', halfLifeH:4,   retDays:14  },
  order_completed:     { category:'outcome',   defConf:1.00, strength:'hard', halfLifeH:120, retDays:365 },
  objection:           { category:'objection', defConf:0.75, strength:'soft', halfLifeH:12,  retDays:30  },
  rejection:           { category:'objection', defConf:0.80, strength:'soft', halfLifeH:24,  retDays:30  },
  problem_reported:    { category:'problem',   defConf:0.85, strength:'soft', halfLifeH:48,  retDays:90  },
  sell_intent:         { category:'sell',      defConf:0.85, strength:'soft', halfLifeH:48,  retDays:90  },
  channel_visited:     { category:'channel',   defConf:0.90, strength:'soft', halfLifeH:24,  retDays:30  },
  stage_transition:    { category:'stage',     defConf:0.95, strength:'soft', halfLifeH:12,  retDays:30  }
};
// In-memory dedup: (sub|type|value) keyed, 5-minute window. Prevents loop-spam without a DB trigger. Pruned at 5000 entries.
const _evDedup = new Map();
// _persistEvidence — gated ff_evidence_memory, registry-validated, PII-backstopped, batched fire-and-forget INSERT.
// NEVER awaited in the response path. All errors silently swallowed (.catch(()=>{})). Zero latency impact.
async function _persistEvidence(sub, evidenceList, turn_id){
  try{
    if(!Array.isArray(evidenceList) || !evidenceList.length) return;
    if(!/^[0-9]+$/.test(String(sub))) return;
    if(!(await _ff('evidence_memory'))) return;
    const rows=[]; const now=Date.now();
    for(const ev of evidenceList){
      const def=EVIDENCE_REGISTRY[ev.type];
      if(!def) continue;
      const val=(ev.value==null)?null:String(ev.value).slice(0,120);
      // PII backstop: reject email patterns or 12+ consecutive digits (credentials/card numbers)
      if(val && /[\w.\-]+@[\w.\-]+\.[a-z]{2,}|\d{12,}/i.test(val)) continue;
      const k=String(sub)+'|'+ev.type+'|'+(val||'');
      if(_evDedup.has(k) && (now-_evDedup.get(k)<5*60*1000)) continue;
      _evDedup.set(k,now);
      const conf=(typeof ev.confidence==='number')?Math.max(0,Math.min(1,ev.confidence)):def.defConf;
      rows.push([String(sub),ev.type,def.category,ev.source||'code',val,conf,def.strength,turn_id||null]);
    }
    if(!rows.length) return;
    const vals=rows.map(function(_,i){ return '($'+(i*8+1)+',$'+(i*8+2)+',$'+(i*8+3)+',$'+(i*8+4)+',$'+(i*8+5)+',$'+(i*8+6)+',$'+(i*8+7)+',$'+(i*8+8)+')'; }).join(',');
    pool.query(
      "INSERT INTO aykoshop_evidence(subscriber_id,evidence_type,category,source,evidence_value,stored_confidence,strength_class,turn_id) VALUES "+vals,
      rows.flat()
    ).catch(()=>{});
    if(_evDedup.size>5000){ _evDedup.clear(); }
  }catch(_e){}
}
// _loadEvidence — pure projection (no side-effects, no LLM, no locks). Dormant in Step 1 (built+unit-tested, not called live).
// Returns belief-state with per-dimension and overall effective_confidence after exponential decay.
// Cold-start safe: always returns a valid belief object even if DB is empty or down.
async function _loadEvidence(sub){
  const belief={
    current_product:null,buyer_stage:null,budget:null,last_price_seen:null,
    payment_method_asked:null,payment_proof:null,problem:null,
    rejections:[],temperature:'cold',
    dim_conf:{},overall_conf:0,evidence_count:0
  };
  try{
    if(!/^[0-9]+$/.test(String(sub))) return belief;
    const r=await pool.query(
      "SELECT evidence_type,category,source,evidence_value,stored_confidence,strength_class,created_at "+
      "FROM aykoshop_evidence WHERE subscriber_id=$1 AND superseded_by IS NULL "+
      "AND created_at > NOW() - INTERVAL '30 days' ORDER BY created_at DESC LIMIT 200",
      [String(sub)]
    );
    const now=Date.now();
    const best={};
    for(const row of r.rows){
      const def=EVIDENCE_REGISTRY[row.evidence_type]; if(!def) continue;
      const ageH=(now-new Date(row.created_at).getTime())/3600000;
      const decay=Math.pow(0.5,ageH/def.halfLifeH);
      const eff=Number(row.stored_confidence)*decay;
      if(eff<0.01) continue;
      if(row.evidence_type==='rejection' && row.evidence_value){ belief.rejections.push(row.evidence_value); }
      const c=row.category;
      if(!best[c]||eff>best[c].eff){ best[c]={type:row.evidence_type,value:row.evidence_value,eff:eff}; }
    }
    if(best.product){ belief.current_product=best.product.value; if(best.product.type==='offer_shown') belief.last_price_seen=best.product.value; }
    if(best.budget){ belief.budget=best.budget.value; }
    if(best.stage){ belief.buyer_stage=best.stage.value; }
    if(best.payment){
      if(best.payment.type==='payment_method_asked') belief.payment_method_asked=best.payment.value;
      if(best.payment.type==='payment_proof_sent') belief.payment_proof={has_proof:true,method:best.payment.value};
    }
    if(best.problem){ belief.problem=best.problem.value; }
    belief.dim_conf=Object.fromEntries(Object.entries(best).map(function(e){ return [e[0],Math.round(e[1].eff*100)/100]; }));
    const effs=Object.values(best).map(function(v){ return v.eff; });
    belief.overall_conf=effs.length?Math.round((effs.reduce(function(a,b){return a+b;},0)/effs.length)*100)/100:0;
    belief.evidence_count=r.rows.length;
    if(best.outcome&&best.outcome.type==='order_completed') belief.temperature='customer';
    else if(belief.overall_conf>=0.6) belief.temperature='hot';
    else if(belief.overall_conf>=0.4) belief.temperature='warm';
  }catch(_e){}
  return belief;
}
// _invalidateEvidence — marks evidence superseded on terminal events (order_completed, etc.).
// Supersede NOT delete: preserves audit trail. Fire-and-forget, gated, never blocks reply path.
async function _invalidateEvidence(sub,types,bySupersedingType){
  try{
    if(!/^[0-9]+$/.test(String(sub))||!Array.isArray(types)||!types.length) return;
    if(!(await _ff('evidence_memory'))) return;
    pool.query(
      "UPDATE aykoshop_evidence SET superseded_by=$3 WHERE subscriber_id=$1 AND evidence_type=ANY($2) AND superseded_by IS NULL",
      [String(sub),types,String(bySupersedingType).slice(0,50)]
    ).catch(()=>{});
  }catch(_e){}
}
// _persistShadowDecision — Step 1.5 shadow-decision log. Gated ff_evidence_shadow.
// Calls _loadEvidence (read-only), derives the would-be decision from the belief-state,
// then INSERTs into aykoshop_evidence_shadow. NEVER modifies live variables. Fire-and-forget.
async function _persistShadowDecision(sub, liveDecision, turn_id){
  try{
    if(!/^[0-9]+$/.test(String(sub))) return;
    if(!(await _ff('evidence_shadow'))) return;
    const belief=await _loadEvidence(sub);
    // Derive shadow decision from belief-state (what evidence memory WOULD have chosen without LLM)
    let shadow_decision='unknown';
    if(belief.payment_proof) shadow_decision='payment';
    else if(belief.payment_method_asked) shadow_decision='payment';
    else if(belief.buyer_stage){
      const s=String(belief.buyer_stage); const arrow=s.indexOf('→');
      shadow_decision=(arrow>=0)?s.slice(arrow+1).trim():s;
    } else if(belief.current_product && belief.budget) shadow_decision='sales';
    else if(belief.current_product) shadow_decision='discovery';
    else if(belief.temperature==='customer') shadow_decision='sales';
    else shadow_decision='discovery';
    const match=(shadow_decision===String(liveDecision.stage||''));
    pool.query(
      "INSERT INTO aykoshop_evidence_shadow(subscriber_id,turn_id,live_stage,live_next,shadow_belief,shadow_decision,shadow_confidence,match) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [String(sub),turn_id||null,String(liveDecision.stage||''),String(liveDecision.next||''),JSON.stringify(belief),shadow_decision,belief.overall_conf,match]
    ).catch(()=>{});
  }catch(_e){}
}
// ==================== END ADR-0020 EVIDENCE MEMORY ====================
// ==================== PHASE 1 BELIEF SHADOW LOGGER ====================
// _persistBeliefShadow — Phase 1 counterfactual gap logger. Gated ff_belief_shadow.
// Reads belief via _loadEvidence (read-only), derives shadow_next from gap-fill transitions only,
// classifies IMPROVE/RISK/SAME, then INSERTs into aykoshop_belief_shadow.
// CRITICAL: NEVER reads or writes reply / stage / next / p.next / res / ctx.
// Fire-and-forget (.catch(()=>{}), never awaited from callers).
async function _persistBeliefShadow(sub, liveNext, liveSlots, userMsg, turn_id, isTestFlag){
  try{
    if(!/^[0-9]+$/.test(String(sub))) return;
    if(!(await _ff('belief_shadow'))) return;
    const belief = await _loadEvidence(sub); // pure read, no side-effects
    // --- belief_fills: slots that belief would supply but live code has null ---
    const fills = [];
    const liveNewProd  = liveSlots.newProd  || null;
    const liveNewBudget= liveSlots.newBudget|| null;
    const liveRejected = Array.isArray(liveSlots.rejected) ? liveSlots.rejected : [];
    const liveService  = liveSlots.service  || null;
    if(!liveNewProd   && belief.current_product) fills.push('product:'+String(belief.current_product).slice(0,40));
    if(!liveNewBudget && belief.budget)           fills.push('budget:'+String(belief.budget).slice(0,20));
    const beliefRejExtra = (belief.rejections||[]).filter(function(r){ return liveRejected.indexOf(r)<0; });
    if(beliefRejExtra.length) fills.push('rejections:'+beliefRejExtra.join('/').slice(0,40));
    const belief_fills = fills.join(' | ').slice(0,200) || null;
    // --- shadow_next: recompute ONLY gap-fill transitions ---
    // Identical logic to live state machine but using belief to fill missing slots.
    // Does NOT touch any live variable. Only upgrades next when belief supplies the missing slot.
    const effProd    = liveNewProd   || belief.current_product || null;
    const effBudget  = liveNewBudget || belief.budget          || null;
    const effService = liveService;
    let shadow_next  = liveNext; // default: same as live
    if(liveNext==='ask_product' && belief.current_product){
      // belief fills the product gap — advance past ask_product
      if(!effService)       shadow_next = 'ask_service';
      else if(effService==='account' && !effBudget) shadow_next = 'ask_budget';
      else                  shadow_next = 'to_seller';
    } else if(liveNext==='ask_budget' && belief.budget){
      // belief fills the budget gap — advance to seller
      shadow_next = 'to_seller';
    } else if(liveNext==='greet' && belief.current_product){
      // belief knows product from prior sessions — skip generic greeting
      if(!effService)       shadow_next = 'ask_service';
      else                  shadow_next = 'to_seller';
    }
    // --- classification ---
    // IMPROVE: shadow_next advances further toward a sale compared to live_next
    const _advanceSet = ['ask_service','ask_budget','to_seller'];
    const _staleSet   = ['ask_product','greet'];
    let classification = 'SAME';
    const _isAdvance = _advanceSet.indexOf(shadow_next)>=0 && _staleSet.indexOf(liveNext)>=0;
    const _isStaleOverride = (
      belief.current_product && liveNewProd && liveNewProd!==belief.current_product &&
      typeof userMsg==='string' && userMsg.length>=3
    );
    if(_isAdvance){
      // shadow fills a real gap
      if(belief.overall_conf < 0.4 && fills.length>0){
        classification = 'RISK'; // low-confidence belief would fill — stale/unreliable
      } else {
        classification = 'IMPROVE';
      }
    } else if(_isStaleOverride){
      // belief points at a DIFFERENT product than what user just named — stale-override risk
      classification = 'RISK';
    }
    // --- is_test detection (no live customer ever affected) ---
    const _isTest = (isTestFlag===true)
      || /^(9993|9994|9995|9997|9999|8800|8801|8809)/.test(String(sub))
      || String(sub)==='6628294';
    // --- fire-and-forget INSERT — NEVER awaited, NEVER modifies reply/stage/next/p.next/res ---
    pool.query(
      'INSERT INTO aykoshop_belief_shadow(subscriber_id,turn_id,user_msg,live_next,shadow_next,belief_fills,classification,overall_conf,is_test,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())',
      [
        String(sub),
        turn_id   || null,
        typeof userMsg==='string' ? userMsg.slice(0,200) : null,
        liveNext  || null,
        shadow_next,
        belief_fills,
        classification,
        belief.overall_conf,
        _isTest
      ]
    ).catch(function(){});
  }catch(_e){}
}
// ==================== END PHASE 1 BELIEF SHADOW LOGGER ====================
// ===== Memory V6 (ADR-0007 §9) — tiered customer memory accessor. Permanent(no decay)/Behavior(med)/Non-buy-intent(fast decay).
// Returns a derived <100-tok snapshot. CONTEXT ONLY — the live turn's intent always overrides this (caller enforces). =====
async function _customerMemory(sub){
  if(!sub || !/^[0-9]+$/.test(String(sub))) return null;
  try{
    const pr=await pool.query("SELECT interested_in,budget,favorite_game,service_type,rejected_services,payment_method,convo_state,lifetime_value,session_data FROM aykoshop_profiles WHERE subscriber_id=$1",[String(sub)]);
    if(!pr.rows.length) return null;
    const p=pr.rows[0]; const sd=p.session_data||{}; const now=Date.now();
    let od={n:0,last:null}; try{ const _o=await pool.query("SELECT count(*)::int n, max(created_at) last FROM aykoshop_orders WHERE subscriber_id=$1 AND status IN ('paid','delivered')",[String(sub)]); od=_o.rows[0]||od; }catch(e){}
    let nbi=null; try{ const _n=sd.last_non_buy_intent; if(_n && _n.type && _n.ts){ const ageH=(now-Number(_n.ts))/3600000; if(ageH<72) nbi={type:_n.type, age_h:Math.round(ageH), weight:Number(Math.exp(-ageH/48).toFixed(2))}; } }catch(e){}
    const mem={
      permanent:{ language:sd.customer_language||null, game:p.favorite_game||null, usual_budget:p.budget||null, bought_before:((od.n||0)>0), order_count:od.n||0, last_purchase:od.last||null },
      behavior:{ wanted:p.interested_in||null, rejected:String(p.rejected_services||'').split(',').filter(Boolean), shown:(Array.isArray(sd.shown_products)?sd.shown_products:[]), channel_visited:!!sd.channel_visited, had_offer:!!sd.had_offer, payment_method:p.payment_method||null, state:p.convo_state||null },
      non_buy_intent:nbi
    };
    const parts=[];
    if(mem.permanent.language) parts.push(mem.permanent.language);
    if(mem.permanent.game) parts.push(String(mem.permanent.game));
    if(mem.permanent.usual_budget) parts.push('ميزانية~'+mem.permanent.usual_budget);
    if(mem.permanent.bought_before) parts.push('شرا '+mem.permanent.order_count+' قبل');
    if(mem.behavior.wanted) parts.push('بغا:'+mem.behavior.wanted);
    if(mem.behavior.rejected.length) parts.push('رفض:'+mem.behavior.rejected.join('/'));
    if(mem.behavior.channel_visited) parts.push('دخل القناة');
    if(mem.behavior.had_offer) parts.push('شاف عرض');
    if(nbi) parts.push('نية غير-شرائية سابقة:'+nbi.type+'('+nbi.age_h+'h, خفيفة)');
    mem.snapshot=parts.join(' | ');
    return mem;
  }catch(e){ return null; }
}
// ===== ff_seller_brief — builds a SHORT Darija "customer card" from data the seller already touches
// (convo_state + agent_trail + profile) + one read-only catalog gap check. Gives the seller AWARENESS
// (temp · returning · last product · budget · product/price gap) so it continues from where the customer
// stopped and adds the right tactic — WITHOUT reciting data or sounding robotic. Returns a compact
// ' · '-joined line, or null. The flag is read at the call site; brief is null when OFF → byte-identical. =====


// ===== Topic Change Detection helpers =====
const _GAME_ALIAS={'Free Fire':['free fire','freefire','فري فاير','فري','ff','garena','بويا'],'PES':['pes','efootball','efoot','بيس'],'PUBG':['pubg','ببجي','بابجي'],'COD':['call of duty','كول أوف'],'Fortnite':['fortnite','فورتنايت'],'Valorant':['valorant','فالورانت'],'FIFA':['fifa','فيفا'],'Minecraft':['minecraft','ماينكرافت'],'Roblox':['roblox','روبلوكس'],'PSN':['psn','ps4','ps5','بلاي ستيشن'],'Steam':['steam','ستيم'],'Xbox':['xbox','اكس بوكس']};
function _extractGame(msg){ if(!msg||typeof msg!=='string')return null; const l=' '+msg.toLowerCase().replace(/[^\u0600-\u06FFa-z0-9 ]/g,' ')+' '; const found=[]; for(const[g,al] of Object.entries(_GAME_ALIAS)){ for(const a of al){ if(l.indexOf(' '+a+' ')>=0){ if(!found.includes(g))found.push(g); break; } } } return found.length===1?found[0]:null; }
// ===== Resume Summary Engine: summarise what the human operator+customer said during takeover.
// Called after AI resumes (DELETE /takeover). Fire-and-forget, result stored in session_data.handoff_summary.
// Injected into _sbBrief → system prompt on next AI turn, then consumed (one-shot). =====
async function _buildHandoffSummary(sub, since_ts){
  try{
    const h=await pool.query(
      "SELECT role, message FROM aykoshop_chat_history WHERE subscriber_id=$1 AND created_at >= $2 AND role IN ('user','operator') ORDER BY created_at ASC LIMIT 30",
      [String(sub), since_ts]
    );
    if(!h.rows.length) return null;
    const transcript=h.rows.map(r=>(r.role==='user'?'🧑':' 👤')+': '+String(r.message||'').slice(0,200)).join('\n');
    const r=await _callOpenAI([
      {role:'system', content:'أنت مساعد ملخّص. لخّص المحادثة التالية بين الزبون والمشغّل في جملتين بالدارجة المغربية. ركّز على: شنو طلب الزبون، شنو وعد المشغّل، الاتفاقيات/الأسعار، والخطوة التالية. جاوب بالدارجة فقط، بدون تكرار، بدون مقدمة.'},
      {role:'user', content:transcript}
    ],{model:'gpt-4o-mini', max_tokens:120, temperature:0, timeout:8000, log:false});
    if(r.ok && r.text) return String(r.text).trim().slice(0,500);
    return null;
  }catch(e){ return null; }
}

async function _sellerBrief(ctx, trail, sub){
  try{
    trail=trail||[];
    const reachedPay=(trail.indexOf('payment')>=0)||ctx.state==='payment';
    const reachedSales=(trail.indexOf('sales')>=0)||ctx.state==='sales'||ctx.had_offer;
    const reachedDisc=(trail.indexOf('discovery')>=0)||ctx.state==='discovery'||ctx.state==='browsing';
    const temp=reachedPay?'🔥 حار جداً (وصل مرحلة الدفع)':reachedSales?'🔥 حار (شاف عرض)':reachedDisc?'🌤️ دافئ':'❄️ بارد';
    let returning='', tot=0;
    try{ const r=await pool.query("SELECT total_messages, EXTRACT(EPOCH FROM (NOW()-last_seen))/3600 AS hrs, personality_type FROM aykoshop_profiles WHERE subscriber_id=$1",[String(sub)]);
      if(r.rows.length){ tot=parseInt(r.rows[0].total_messages)||0; const hrs=Math.round(parseFloat(r.rows[0].hrs)||0);
        if(tot>3||trail.length>1){ returning='زبون راجع'+(hrs>0?(' (آخر مرة من '+(hrs<24?(hrs+'س'):(Math.round(hrs/24)+'يوم'))+')'):''); } }
        if(r.rows[0].personality_type==='TRUST_SEEKING') ctx.trust_seeking=true; }catch(_e){}
    const _sv=(ctx.service==='recharge')?'شحن جواهر':(ctx.service==='code')?'كود':(ctx.service==='account')?'حساب':'';
    const _gm=ctx.game?String(ctx.game):(ctx.product==='freefire'?'Free Fire':'');
    const lastProd=[_sv,_gm].filter(Boolean).join(' ');
    let gap=''; const bud=parseInt(ctx.budget)||0;
    if(_gm && bud>0){
      try{ const g=await pool.query("SELECT MIN(price_value) AS mn FROM aykoshop_products WHERE status='available' AND COALESCE(price_value,0)>0 AND lower(COALESCE(game,''))=lower($1)"+(ctx.service?" AND product_type=$2":""), ctx.service?[_gm,ctx.service]:[_gm]);
        const mn=(g.rows[0]&&g.rows[0].mn!=null)?parseFloat(g.rows[0].mn):null;
        if(mn==null) gap='⚠️ Product Gap: هاد المنتج ماكاينش فالكاطالوج — عرض الأقرب واحجز اهتمامو';
        else if(mn>bud*1.15) gap='⚠️ Price Gap: أرخص متوفر '+Math.round(mn)+'DH فوق ميزانيتو — قرّب بلطف';
        else gap='✅ متوفر فميزانيتو';
      }catch(_e){}
    }
    const parts=[temp]; if(returning)parts.push(returning); if(lastProd)parts.push('آخر طلب: '+lastProd); if(bud>0)parts.push('ميزانية ~'+bud+'DH'); if(gap)parts.push(gap);
    return parts.length>1?parts.join(' · '):temp;
  }catch(_e){ return null; }
}
// ── Type Policy Cache — 60s TTL, all rows loaded at once, matched in JS ──
var _tpCache={t:0,v:[]};
async function _getTypePolicy(pt,game){
  try{
    if(Date.now()-_tpCache.t>60000){
      const r=await pool.query('SELECT * FROM aykoshop_product_type_policies ORDER BY id');
      _tpCache={t:Date.now(),v:r.rows};
    }
    var pols=_tpCache.v; var _pt=String(pt||'').toLowerCase().trim(); var _gm=String(game||'').toLowerCase().trim();
    // Specific match (type + game) first, then fallback to type-only
    for(var i=0;i<pols.length;i++){ if(String(pols[i].match_product_type||'').toLowerCase()===_pt && String(pols[i].match_game||'').toLowerCase()===_gm && _gm) return pols[i]; }
    for(var j=0;j<pols.length;j++){ if(String(pols[j].match_product_type||'').toLowerCase()===_pt && !pols[j].match_game) return pols[j]; }
    return null;
  }catch(e){ return null; }
}

// ==================== AYKO SALES BRAIN V3 — Sprint S1 ====================
// _normalize · _hybridIntent · _detectEmotion · _buildConvObject
// ADDITIVE ONLY — not wired to live path yet (Sprint S1-B will wire them)
// =========================================================================

// S1-1: Normalizer — cleans input text before intent analysis
function _normalize(text){
  if(!text||typeof text!=='string') return '';
  var t=text.trim();
  // Collapse 3+ repeated chars: "slmmmm"→"slm", "خووويا"→"خويا"
  t=t.replace(/(.)\1{2,}/g,'$1$1');
  // Normalize amount formats: "200dh"→"200", "200درهم"→"200"
  t=t.replace(/(\d+)\s*(dh|درهم|دراهم|ريال|د\.م)/gi,'$1');
  // Remove Arabic Tatweel
  t=t.replace(/ـ+/g,'');
  return t.trim();
}

// S1-2: Hybrid Intent Engine — Regex → Context-aware → Entity extraction
// Returns: {intent, confidence, entities:{game,budget}, layer}
function _hybridIntent(text, conv){
  var raw=(text||'').toString().trim();
  var lu=_normalize(raw).toLowerCase();
  var result={intent:'general',confidence:0.45,entities:{},layer:'default'};

  // ── Layer 1: High-confidence Regex ──

  // Greeting — expanded (Slm · 5oya · khoya · cc, old _detectIntent missed these)
  var _grRe=/^\s*(سلام|سلامو|السلام|اهلا|أهلا|اهلين|مرحبا|مرحبتين|صباح|مسا|مساء|labas|labass|salam|salut|bonjour|cava|hi|hello|hey|slm|slam|cc|ww+|hh+|كيداير|كي داير|كيف داير|اش خبارك|أش خبارك|5oya|khoya|khouya|khay|akhoya|akhi|خويا|خي|اخويا|يا هلا|اهلين)/i.test(lu);
  if(_grRe && lu.length<45 && !/*S1-hotfix-excl*/(/حساب|شحن|كود|بغيت|شري|نشري|ثمن|درهم|bghit|brit|b4it|baghi/.test(lu)||/\b\d{2,}\b/.test(lu))){
    return {intent:'greeting',confidence:0.95,entities:{},layer:'regex'};
  }

  // Payment confirmation
  if(/خلصت|دفعت|حولت|صيفطت|سيفطت|عطيتك|بعتلك|screenshot|سكرين|تم الدفع|تم التحويل/.test(lu)){
    return {intent:'payment_confirm',confidence:0.95,entities:{},layer:'regex'};
  }

  // Sell intent (customer selling TO AykoShop)
  if(/\b(nbi3|lbi3|brit nbi3|baghi nbi3|bghit nbi3|ana nbi3)\b|بغيت نبيع|كنبيع|بيع حساب|نبيع كونط/.test(lu)){
    var _sg=(_extractGame&&_extractGame(lu))||(conv&&conv.game)||null;
    return {intent:'sell',confidence:0.92,entities:{game:_sg},layer:'regex'};
  }

  // Trade/exchange/reprise
  if(/تبديل|نبدل|روبريز|reprise|échange|echange|\bswap\b|\btrade\b/.test(lu)){
    return {intent:'trade',confidence:0.90,entities:{},layer:'regex'};
  }

  // Payment question
  if(/كيفاش نخلص|كيف الدفع|طريقة الدفع|نسبة الدفع|نسبة دفع|واش كاين cih|barid bank|binance|وفاكاش|wafacash/.test(lu)){
    return {intent:'payment_question',confidence:0.90,entities:{},layer:'regex'};
  }

  // Buy intent
  var _buyRe=/بغيت.*(نشري|نشحن|حساب|كونط|كود|اشتراك)|\b(bghit|b4it|baghi|brit)\b|\bnshri\b/.test(lu);
  var _game=(_extractGame&&_extractGame(lu))||((conv&&conv.game)||null);
  var _bm=lu.match(/(\d{2,5})\s*(dh|درهم|ريال)?/);
  var _budget=_bm?parseInt(_bm[1]):((conv&&conv.budget)||null);
  if(_buyRe){
    return {intent:'buy',confidence:0.88,entities:{game:_game,budget:_budget},layer:'regex'};
  }

  // Support / complaint
  if(/مشكل|مشكلة|استرجاع|\bhack\b|تهكير|ماخدامش|بلوكا|تبلوكا/.test(lu)){
    return {intent:'support',confidence:0.85,entities:{},layer:'regex'};
  }

  // Thanks
  if(/شكرا|شكراً|متشكر|\bmerci\b|\bthanks\b|يسلمو|بارك الله/.test(lu)){
    return {intent:'thanks',confidence:0.88,entities:{},layer:'regex'};
  }

  // ── Layer 2: Context-aware (uses conv state from Memory Object) ──
  if(conv){
    // Number reply while in ASK_BUDGET stage → budget
    if((conv.last_next==='ask_budget'||conv.stage==='ASK_BUDGET')&&/^\s*\d{2,5}\s*(dh|درهم|ريال)?\s*$/.test(lu)){ // S2-B: last_bot_next
      var _cb=parseInt(lu.match(/\d{2,5}/)[0]);
      return {intent:'budget_reply',confidence:0.93,entities:{budget:_cb},layer:'context'};
    }
    // Game name reply while in ASK_GAME stage
    if((conv.last_next==='ask_product'||conv.last_next==='ask_service'||conv.stage==='ASK_GAME')&&_game){
      return {intent:'game_reply',confidence:0.91,entities:{game:_game},layer:'context'};
    }
    // Short rejection after OFFER_SHOWN
    if((conv.had_offer||conv.stage==='OFFER_SHOWN')&&lu.length<25&&/غالي|كثير|معجبنيش|مبغيتش|\bla\b|لا\b/.test(lu)){
      return {intent:'reject',confidence:0.85,entities:{},layer:'context'};
    }
    // Budget addition: "زيد 50" while budget already known
    if(conv.budget&&/زيد|زد|nzid|زيادة/.test(lu)){
      var _extra=lu.match(/(\d{2,4})/);
      if(_extra) return {intent:'budget_add',confidence:0.88,entities:{budget_add:parseInt(_extra[1])},layer:'context'};
    }
  }

  // ── Layer 3: Entity extraction for general messages ──
  if(_game||_budget){
    result.entities={game:_game,budget:_budget};
    if(_game&&_budget) result.confidence=0.72;
    else result.confidence=0.55;
    result.layer='entities';
  }

  return result;
}

// S1-3: Emotion Engine — detects emotional state from message text
// Returns: {emotion: 'frustrated'|'urgent'|'worried'|'happy'|'normal', intensity: 'high'|'medium'|'low'}
function _detectEmotion(text){
  var t=(text||'').toString().toLowerCase();
  if(/وخا تجاوبي|مجاوبتيهش|فينك راه|داست سيمانة|فين كنتي|علاش ما رديتيش|صيفطلك.{0,20}ما رد/.test(t)){
    return {emotion:'frustrated',intensity:'high'};
  }
  if(/شباليك|وجاوب|جاوبني|؟{2,}|ما رديتيش|مجاوبش/.test(t)){
    return {emotion:'frustrated',intensity:'medium'};
  }
  if(/3afak|عافاك|jawbni|بسرعة|بزربة|ضروري|urgent/.test(t)){
    return {emotion:'urgent',intensity:'medium'};
  }
  if(/خايف|مضمون|واش موثوق|مخافة|كيسرق|تنسرق/.test(t)){
    return {emotion:'worried',intensity:'medium'};
  }
  if(/شكرا|ممتاز|زوين بزاف|عجباتني|يعجبني/.test(t)){
    return {emotion:'happy',intensity:'low'};
  }
  return {emotion:'normal',intensity:'low'};
}

// S1-4: Conv Memory Object — reads DB state into a structured in-memory object
// Returns: {stage, game, budget, goal, rejected[], img_count, had_offer, sell_mode}
// P0-A: dead code removed — _buildConvObject() was defined in Sprint S1 but never called anywhere
// ==================== END AYKO SALES BRAIN V3 Sprint S1 ====================

async function _v2Router(messages, ctx, kbCtx, turn_id, sub, brief){
  // Haiku EXTRACTS slots + writes a warm human reply asking for the next missing info. Code decides the transition (reliable).
const _rmeta=await _catalogMeta();
    let sys='نتا العساس ديال AykoShop (ماشي البائع). من المحادثة استخرج المعلومات وكتب رد بشري دافئ متنوّع بالدارجة. عندنا فالكاطالوج هاد المنتجات/الألعاب فقط: '+(_rmeta.salesList||'حسب الكاطالوج')+'.\n'
    +'افهم المعنى ماشي الكلمات. استخرج: intent (buy=بغي يشري، reject=رافض/مبغيش الخدمة، sell=بغي يبيع حسابو، payment=خلّص، support=مشكل، browse=كيتفرج، greeting=تحية)، service (الخدمة اللي بغيها دابا: recharge=شحن/جواهر، account=حساب/كونط، code=كود/سكن/سلاح، subscription=اشتراك/نتفليكس/سبوتيفاي، ولا null)، rejected_service (الخدمة اللي رافضها/مبغيهاش/غالية عليه/قال عليها لا — مثال: مبغيتش شحن، بلا شحن، ماشي الشحن، الشحن غالي عليا، ماعنديش فلوس للشحن، forget recharge، non recharge، mabghitch recharge → recharge؛ مبغيش حساب → account؛ بلا كود → code — ولا null)، product (freefire/null)، budget (رقم/null).\n'
    +'reply = جملة-جوج دارجة بشرية: إلا ماعرفناش اللعبة → رحّب وسول أشمن لعبة. إلا عرفنا اللعبة (Free Fire) وماعرفناش الميزانية → سول شحال الميزانية بالرقم. إلا عرفنا الجوج → كلمة إيجابية قصيرة. ماتعطيش ثمن، ماتخترعش، ماتقترحش رخيص/متوسط/غالي.\n'
    +'رجّع JSON فقط: {"intent":"...","service":"recharge|account|code|subscription|null","rejected_service":"recharge|account|code|subscription|null","product":"freefire|<لعبة>|null","budget":"رقم|null","reply":"..."}\nالسياق المعروف: '+JSON.stringify(ctx);
  let _tp=null; // P0-B: hoisted so _v2Router can return it — eliminates double DB call
  try{
    _tp=await _buildTruthPacket(sub,null,ctx);
    const _pm=await _payMethods();
    const _wFF=(_tp&&_tp.warranty_ff)||'16 يوم';
    const _wSoc=(_tp&&_tp.warranty_social)||'10 أيام';
    const _pmNames=(_pm&&_pm.length)?_pm.map(function(m){return m.name;}).join(' / '):'CIH / Barid Bank / Binance USDT';
    sys += '\nسياسة الضمان والدفع (حقائق ثابتة — أجب عليها بدقة):\n- حسابات Free Fire: ضمان '+_wFF+' استبدال. حسابات السوشيال ميديا: ضمان '+_wSoc+'.\n- الضمان = استبدال بمنتج بنفس القيمة — ماكاينش استرداد نقدي.\n- طرق الدفع المقبولة فقط: '+_pmNames+'. غير هاد الطرق مرفوضة.';
  }catch(_de){ sys += '\nسياسة الضمان والدفع (حقائق ثابتة — أجب عليها بدقة):\n- الضمان = استبدال بمنتج بنفس القيمة — ماكاينش استرداد نقدي.'; }
  // ── Type Policy injection: if service known → add operational facts from DB ──
  try{
    var _tpSvc=ctx&&(ctx.service||null); var _tpGame=ctx&&(ctx.product||null);
    if(_tpSvc){
      var _tpl=await _getTypePolicy(_tpSvc,_tpGame);
      if(_tpl){
        var _tparts=[];
        if(Array.isArray(_tpl.delivery_steps)&&_tpl.delivery_steps.length){ _tparts.push('خطوات التسليم: '+_tpl.delivery_steps.map(function(s){return String(s).slice(0,120);}).join(' | ').slice(0,400)); }
        if(_tpl.predelivery_script&&String(_tpl.predelivery_script).trim()){ _tparts.push('تعليمات ما قبل التسليم للزبون: '+String(_tpl.predelivery_script).slice(0,300)); }
        if(Array.isArray(_tpl.buyer_requirements)&&_tpl.buyer_requirements.length){ var _brq=_tpl.buyer_requirements.map(function(r){return String(r.label||r)+(r.required?' (مطلوب)':' (اختياري)');}).join('، '); _tparts.push('المعلومات المطلوب جمعها من الزبون: '+_brq); }
        if(_tparts.length){ sys+='\n[سياسة نوع '+(_tpl.display_name||_tpSvc)+' — حقائق تشغيلية]\n'+_tparts.join('\n')+'\n[نهاية السياسة]'; }
      }
    }
  }catch(_tpe){}
  if(kbCtx){ sys += '\n📚 خبرة متعلمة من ردود ناجحة سابقة (للأسلوب + جواب الأسئلة العامة/الاعتراضات فقط — ممنوع للأثمنة/المنتجات/الدفع، هادوك من الكاطالوج/القواعد الحتمية): '+kbCtx+'\nإيلا الزبون طرح سؤال عام (FAQ) ولا اعتراض، جاوبو معتمداً على هاد الخبرة، من بعد كمّل عادي.'; }
  // ===== ff_seller_brief: a SHORT internal "customer card" — awareness only, NOT to be recited. Keeps the seller a natural human who simply knows more. brief is null when the flag is OFF → this whole block is skipped → byte-identical. =====
  if(brief){ sys += '\n🎯 بطاقة الزبون (وعي داخلي فقط — ماتسردهاش وماتبانش روبو): '+brief+'\nوظّف هاد الوعي باش: تكمّل من فين وقف الزبون وتربط بآخر منتج طلب · تزيد إلحاح خفيف مهذّب للحار (وصل عرض/دفع) وطمأنة للبارد · إيلا كان Gap اقترح الأقرب بلطف. بقى بائع طبيعي قصير، بلا سرد المعطيات.'; }
  // ===== SHOP CONTEXT (Suffix — always after LOCKED rules, never overrides them) =====
  try{ const _sCtx=await _shopCtx(); if(_sCtx) sys+='\n[سياق المتجر]\n'+_sCtx; }catch(_e){}
  const msgs=[{role:'system',content:sys}].concat(messages.slice(-14)); // raised from 8 (Resume Summary Engine needs more history)
  const _rt0=Date.now(); let _hErr=null;
  // ===== ff_circuit_skip: RESILIENCE-ONLY. When the Anthropic circuit is OPEN (provider proven down — e.g. credit out),
  // skip the dead Haiku call (no wasted timeout) and go straight to gpt-4o-mini. circuitAllows() keeps a half-open probe
  // every cooldown → Haiku resumes AUTOMATICALLY the moment credit is refilled (no manual step). The router ONLY extracts
  // slots; CODE still decides — ZERO change to routing/catalog/product-lock/SBW/clarify/handoff. OFF=byte-identical. =====
  let _ffCS=false; try{ _ffCS=await _ff('circuit_skip'); }catch(_e){}
  let r, via;
  if(_ffCS && !circuitAllows('anthropic')){
    _hErr='anthropic_circuit_open'; r=await _callOpenAI(msgs,{model:'gpt-4o-mini',max_tokens:200,temperature:0.5,timeout:8000,log:false,response_format:{type:'json_object'}}); via='mini';
    circuitRecord('openai', !!r.ok, (r.ok?'router skip-haiku ok':'router '+(r.error||'no_text')).slice(0,90));
  } else {
    r=await _callClaude(msgs,{model:'claude-haiku-4-5',max_tokens:200,temperature:0.5,timeout:8000,log:false}); via='haiku';
    circuitRecord('anthropic', !!r.ok, (r.ok?'router ok':'router '+(r.error||'no_text')).slice(0,90));
    if(!r.ok){ _hErr=r.error||'no_text'; r=await _callOpenAI(msgs,{model:'gpt-4o-mini',max_tokens:200,temperature:0.5,timeout:8000,log:false,response_format:{type:'json_object'}}); via='mini'; circuitRecord('openai', !!r.ok, (r.ok?'router fallback ok':'router '+(r.error||'no_text')).slice(0,90)); }
  }
  const p = r.ok ? _v2ParseJSON(r.text) : null; const _pOk=!!p;
  // FAILOVER-EVENT (one row per turn, keyed by turn_id): none=Haiku ok · silent-degrade=fell to mini OR unparseable (weaker slots) · blocked=both down
  const _imp = !r.ok ? 'blocked' : (!_pOk ? 'silent-degrade' : (via==='mini'?'silent-degrade':'none'));
  const _et  = !r.ok ? _errType(r.error||_hErr) : (!_pOk ? 'parse' : (via==='mini'? _errType(_hErr) : null));
  try{ _logAiUsage({subscriber_id:sub, provider:(!r.ok?'none':(via==='mini'?'openai':'anthropic')), model:(!r.ok?'-':(via==='mini'?'gpt-4o-mini':'claude-haiku-4-5')), mode:'router', role:'router', route_layer:'v2_router', turn_id:turn_id, customer_impact:_imp, error_type:_et, tokens_in:(r.usage&&r.usage.in)||0, tokens_out:(r.usage&&r.usage.out)||0, latency_ms:Date.now()-_rt0, success:!!(r.ok&&_pOk), detail:(via==='mini'?('haiku→mini: '+String(_hErr||'').slice(0,50)):(r.error||(!_pOk?'unparseable':null))), user_msg:((messages.filter(function(m){return m.role==='user';}).slice(-1)[0]||{}).content||'').slice(0,160)}); }catch(_e){}
  if(!r.ok) return {ok:false, via:'none', parsed:{intent:'unknown',product:null,budget:null,reply:''}, tp:_tp}; // P0-B
  return {ok:true, via, parsed:(p||{intent:'unknown',product:null,budget:null,reply:''}), usage:r.usage, tp:_tp}; // P0-B
}

// SELLER = البائع (Sonnet→GPT-4o). 100% CATALOG-DRIVEN, ZERO hardcoded game/service. query=customer words, service=product_type|null, game=matched catalog line|null.
async function _v2Seller(query, budget, service, kbCtx, game, preFound, shownIds, trustSeeking){
  const bud=parseInt(budget)||0;
  // ===== ff_smart_seller: Smart Budget Window (SBW) — gated. OFF=byte-identical to legacy path. =====
  var _ffSS=false; try{ _ffSS=await _ff('smart_seller'); }catch(e){}
  // ===== ff_floor_offer: Honest floor message in sbw_none (genuine-empty window). OFF=byte-identical. =====
  var _ffFO=false; try{ _ffFO=await _ff('floor_offer'); }catch(e){}
  // ===== SBW: ACCOUNT path — game-locked window when ff_smart_seller ON =====
  if(_ffSS && service==='account' && bud>0){
    try{
      const _stretch=await _sbwStretch();
      const _maxP=Math.round(bud*(1+_stretch));
      const _gl=game?String(game).toLowerCase():null;
      const _shown=(Array.isArray(shownIds)?shownIds:[]).map(Number);
      // query: same game, price in window, exclude shown, nearest-first
      let _sbwQ="SELECT id, product_name, price, price_value, COALESCE(game,'') game, COALESCE(key_features,'') key_features, COALESCE(account_rank,'') account_rank, COALESCE(evo_count,'') evo_count, COALESCE(delivery_time,'') delivery_time, COALESCE(guarantee_note,'') guarantee_note, image_url FROM aykoshop_products WHERE status='available' AND product_type='account' AND COALESCE(price_value,0)>0 AND COALESCE(price_value,0)<=$1";
      const _sbwP=[_maxP];
      if(_gl){ _sbwP.push(_gl); _sbwQ+=' AND lower(game)=$'+_sbwP.length; }
      if(_shown.length){ _sbwQ+=' AND id != ALL($'+(_sbwP.length+1)+'::int[])'; _sbwP.push(_shown); }
      _sbwQ+=' ORDER BY abs(price_value-$1) ASC LIMIT 3';
      const _sbwR=await pool.query(_sbwQ,_sbwP);
      const _sbwRows=_sbwR.rows;
      const _gameLabel=game||'Free Fire';
      const _ch=_V2_CHANNEL;
      if(!_sbwRows.length){
        // Rule 3/4: main query returned 0 rows (shown excluded). Check if there were in-window products at all.
        if(_shown.length>0){
          // COUNT query: same window+game+type, NO shown exclusion — tells us if everything was already shown
          try{
            let _cntQ="SELECT COUNT(*)::int n FROM aykoshop_products WHERE status='available' AND product_type='account' AND COALESCE(price_value,0)>0 AND COALESCE(price_value,0)<=$1";
            const _cntP=[_maxP];
            if(_gl){ _cntP.push(_gl); _cntQ+=' AND lower(game)=$'+_cntP.length; }
            const _cntR=await pool.query(_cntQ,_cntP);
            const _inWindowTotal=parseInt((_cntR.rows[0]||{}).n)||0;
            if(_inWindowTotal>0){
              // Everything in-window was already shown → only-shown message, not "none in window"
              const _onlyReply=(_inWindowTotal===1)
                ? ('حالياً هادا هو الحساب '+_gameLabel+' الوحيد المتوفر فهاد الميزانية خويا 🙏 شوف القناة كنزيدو حسابات باستمرار 👇\n'+_ch)
                : ('شفتي گاع الحسابات '+_gameLabel+' المتوفرة فهاد الميزانية خويا 🙏 شوف القناة كنزيدو جداد باستمرار 👇\n'+_ch);
              return {reply:_onlyReply, via:'sbw_only_shown', service:'account', products:[], shown_ids:[]};
            }
          }catch(_cnterr){
            // COUNT failed — fall through to sbw_none (safe)
          }
        }
        // No products in window at all (or COUNT failed) → stay in category, offer channel
        // ===== ff_floor_offer: genuine-empty window → honest MIN floor message (game-scoped). =====
        if(_ffFO){
          try{
            let _floorMin=0;
            if(_gl){
              const _flrG=await pool.query("SELECT MIN(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mn FROM aykoshop_products WHERE status='available' AND product_type='account' AND lower(game)=$1",[_gl]);
              _floorMin=Math.round((_flrG.rows[0]||{}).mn||0);
            }
            if(!_floorMin){
              const _flrA=await pool.query("SELECT MIN(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mn FROM aykoshop_products WHERE status='available' AND product_type='account'");
              _floorMin=Math.round((_flrA.rows[0]||{}).mn||0);
            }
            if(_floorMin>0){
              const _flrReply='أقل حساب '+_gameLabel+' عندنا بـ'+_floorMin+' درهم خويا 🙏 واش توصل؟ وإيلا غالي عليك دابا شوف القناة كنزيدو عروض باستمرار 👇\n'+_ch;
              return {reply:_flrReply, via:'sbw_none', service:'account', products:[], shown_ids:[]};
            }
          }catch(_flre){}
        }
        return {reply:'حالياً ماكاينش حساب '+_gameLabel+' قريب لهاد الميزانية فهاد الفئة 🙏 شوف القناة ديالنا كنزيدو حسابات جداد باستمرار، وإيلا عجبك شي حساب صيفطو ليا هنا 👇\n'+_ch, via:'sbw_none', service:'account', products:[], shown_ids:[]};
      }
      // Normal SBW offer
      function _sbwCard(p, opts){ var gn=String(p.guarantee_note||''); var showG=(opts&&opts.showGuarantee)||/lifetime|مدى الحياة|مضمون للأبد/i.test(gn); var f=[]; if(p.account_rank)f.push('رتبة '+p.account_rank); if(p.evo_count)f.push(p.evo_count+' إيفو'); var kf=String(p.key_features||'').replace(/\s+/g,' ').trim(); if(kf)f.push(kf.slice(0,60)); return '🔹 '+(p.product_name||'')+'\n💰 '+(p.price||p.price_value||'')+(f.length?('\n✨ '+f.join(' · ')):'')+(showG&&gn?('\n🛡️ '+gn):'')+(p.delivery_time?('\n🚚 التسليم: '+p.delivery_time):''); }
      const _sbwCards=_sbwRows.map(function(p){return _sbwCard(p,{showGuarantee:!!trustSeeking});}).join('\n\n');
      const _sbwIntro=(_sbwRows.length===1)?('هذا هو المنتج الأنسب لميزانيتك ('+bud+' درهم) خويا 🔥'):('عندنا '+_sbwRows.length+' حسابات '+_gameLabel+' قريبة لميزانيتك ('+bud+' درهم) خويا 🔥');
      const _sbwImg=(_sbwRows[0]&&_sbwRows[0].image_url&&String(_sbwRows[0].image_url).startsWith('http'))?_sbwRows[0].image_url:null;
      return {reply:_sbwIntro+'\n\n'+_sbwCards+'\n\nواش عجبك شي واحد منهم؟ 🙏', via:'sbw', service:'account', products:_sbwRows, image_url:_sbwImg, shown_ids:_sbwRows.map(function(p){return p.id;})};
    }catch(_sbwe){
      // FIX 2 (HIGH): SBW query threw — do NOT fall through to the unbounded legacy path.
      // Return sbw_none with channel so the customer is never shown a product above budget*(1+stretch).
      const _gameLabel2=game||'Free Fire';
      return {reply:'حالياً ماكاينش حساب '+_gameLabel2+' قريب لهاد الميزانية فهاد الفئة 🙏 شوف القناة ديالنا كنزيدو حسابات جداد باستمرار، وإيلا عجبك شي حساب صيفطو ليا هنا 👇\n'+_V2_CHANNEL, via:'sbw_none', service:'account', products:[], shown_ids:[]};
    }
    // (never reached — SBW block always returns above when ff_smart_seller+account+budget>0)
  }
  if(service==='recharge'){
    let _pk=[], _g=game||'', _br=[], _pname=null; try{ const _r=await pool.query("SELECT game, recharge_packages, buyer_requirements, product_name FROM aykoshop_products WHERE product_type='recharge' AND status='available' AND recharge_packages IS NOT NULL LIMIT 1"); if(_r.rows[0]){ _g=_r.rows[0].game||_g; _br=(_r.rows[0].buyer_requirements||_br); _pname=(_r.rows[0].product_name||_pname); let _rp=_r.rows[0].recharge_packages; if(typeof _rp==='string') _rp=JSON.parse(_rp); if(Array.isArray(_rp)) _pk=_rp; } }catch(e){}
    const _gl=_g?(' '+_g):'';
    if(_pk.length){ const _list=_pk.map(function(x){return '• '+(x.amount||'')+' = '+(x.price||'');}).join('\n'); return {reply:'شحن'+_gl+' بالـID مباشرة خويا 🔥 هاهي الباقات والأثمنة:\n'+_list+'\n\nقول ليا أشمن باقة بغيتي وعطيني الـID ديالك ونكمّلو ليك 🙏', via:'recharge', service:'recharge', products:_pk, buyer_requirements:_br, product_name:_pname}; }
    return {reply:'شحن'+_gl+' كاين خويا 🔥 كنشحنو مباشرة بالـID ديالك. شحال باغي تشحن؟ وعطيني الـID ديالك باش نكمّلو ليك.', via:'recharge', service:'recharge', products:[], buyer_requirements:_br, product_name:_pname};
  }
  let cands=[]; if(Array.isArray(preFound)&&preFound.length){ cands=preFound.slice(); } else { try{ const cs=await _catalogSearch((query||'')+' '+(game||'')+' '+(service||''), {type:(service||null), budget:(bud||null), limit:12}); cands=(cs&&cs.rows)||[]; }catch(e){} }
  if(game){ const gl=String(game).toLowerCase(); const scoped=cands.filter(function(p){ return String(p.game||'').toLowerCase()===gl || String(p.category||'').toLowerCase().indexOf(gl)>=0; }); if(scoped.length) cands=scoped; }
  if(!cands.length && (service||game)){ // semantic search empty (embedding outage?) -> direct catalog query so selling never breaks
    let _q="SELECT product_name, price, price_value, COALESCE(min_price,0) min_price, COALESCE(game,'') game, COALESCE(category,'') category, COALESCE(code_type,'') code_type, COALESCE(key_features,'') key_features, COALESCE(price_usd,'') price_usd, COALESCE(price_eur,'') price_eur, COALESCE(account_rank,'') account_rank, COALESCE(evo_count,'') evo_count, COALESCE(guarantee_note,'') guarantee_note, image_url FROM aykoshop_products WHERE status='available'"; const _pr=[];
    if(service){ _pr.push(service); _q+=' AND product_type=$'+_pr.length; }
    if(game){ _pr.push(String(game).toLowerCase()); _q+=' AND lower(game)=$'+_pr.length; }
    try{ const _r2=await pool.query(_q,_pr); cands=_r2.rows; cands.forEach(function(p){ p.pv=parseInt(p.price_value)||parseInt(String(p.price).replace(/[^0-9]/g,''))||0; p.sim=1; }); if(bud) cands=cands.slice().sort(function(a,b){ return Math.abs(a.pv-bud)-Math.abs(b.pv-bud); }); }catch(e){}
  }
  if(service==='code'){ var _cs=null; if(/رقص|dance|emote|إيموت/i.test(query||'')) _cs='رقص'; else if(/سكن|skin|سياره|سيارة|بدل|ملابس|عباي/i.test(query||'')) _cs='سكن'; else if(/سلاح|weapon|بندقي|مسدس|\bmac\b|\bak\b|\bm4\b|سكار/i.test(query||'')) _cs='سلاح';
    if(_cs){ var _subc=cands.filter(function(p){ return String(p.code_type||'').indexOf(_cs)>=0; }); if(_subc.length){ cands=_subc; } else { var _av=[]; try{ var _avr=await pool.query("SELECT DISTINCT regexp_replace(code_type,'\\s*\\(.*\\)','') ct FROM aykoshop_products WHERE status='available' AND product_type='code' AND code_type IS NOT NULL AND code_type<>''"); _av=_avr.rows.map(function(x){return x.ct;}).filter(Boolean); }catch(e){} return {reply:'سمح ليا خويا 🙏 دابا ماعندناش '+(_cs==='رقص'?'كود رقصة':_cs==='سكن'?'كود سكن':'كود سلاح')+' متاح. اللي متوفر دابا: '+(_av.length?_av.join('، '):'كودات أخرى')+'. واش نوريك منهم، ولا نخليك مع الفريق باش يوفّرها ليك؟', via:'none', products:[], escalate:'CODE_SUBTYPE_UNAVAILABLE'}; } } }
    const _top=cands[0];
  const carried=(Array.isArray(preFound)&&preFound.length>0)||(!!game)||(!!service)||(_top && parseFloat(_top.sim)>=0.45);
  // F2: cross-category down-sell — when no in-budget match in asked category, broaden to ALL categories
  // F2 trigger: (a) no cands / not carried (original), OR (b) budget set + ALL cands above budget (new)
  const _allAboveBudget=bud>0 && cands.length>0 && cands.every(function(p){return (p.pv||0)>bud;});
  // 💰 NEGOTIATOR (flag ff_negotiator; OFF=unchanged): same-type products exist but ALL above budget →
  // offer the NEAREST same-type + a gap-aware ask-to-stretch, instead of category-pivot or dead-end.
  // 100% catalog-true (price/product from the real row; zero invention). Verifier stays the backstop.
  var _negOn=false; try{ _negOn=await _ff('negotiator'); }catch(e){}
  if(_negOn && _allAboveBudget && carried && service){
    var _near=cands.slice().sort(function(a,b){return (a.pv||0)-(b.pv||0);})[0];
    if(_near && (_near.pv||0)>0){
      var _gap=(_near.pv||0)-bud; var _pct=bud>0?_gap/bud:1;
      var _typAr={account:'حساب',code:'كود',recharge:'شحن'}[service]||service;
      var _ask=(_pct<=0.30)
        ? ('الفرق غير '+_gap+' درهم على ميزانيتك — واش نحجزو ليك؟ 🙏')
        : ('ميزانيتك '+bud+' درهم، وهادا أرخص '+_typAr+' متوفر دابا. واش تقدر توصل لـ'+_near.pv+' درهم، ولا نوريك بدائل بميزانيتك؟ 🙏');
      var _negReply='ماكايناش '+_typAr+' بـ'+bud+' درهم دابا خويا 🙏 ولكن أقرب واحد عندنا:\n\n'+_wdCard(_near,{showGuarantee:!!trustSeeking})+'\n\n'+_ask;
      return {reply:_negReply, via:'negotiator', service:service, products:[_near], image_url:((_near.image_url&&String(_near.image_url).startsWith('http'))?_near.image_url:null)};
    }
  }
  if(!cands.length || !carried || _allAboveBudget){
    // F2: try cross-category if we know budget and a specific service was requested
    // ff_smart_seller: DISABLE cross-category jump — stay in locked category (Rule 1)
    if(!_ffSS && bud && service){
      try{
        const _dsR=await pool.query(
          "SELECT product_name, price, price_value, product_type, COALESCE(game,'') game, COALESCE(code_type,'') code_type, COALESCE(key_features,'') key_features, COALESCE(key_benefits,'') key_benefits, COALESCE(delivery_time,'') delivery_time, image_url FROM aykoshop_products WHERE status='available' AND product_type<>$1 AND COALESCE(price_value,0)>0 AND COALESCE(price_value,0)<=$2 ORDER BY price_value DESC LIMIT 3",
          [service, bud]
        );
        if(_dsR.rows.length){
          const _dsTop=_dsR.rows[0];
          const _dsList=_dsR.rows.map(function(p){
            const _ct=p.code_type?' ('+p.code_type+')':''; const _f=(p.key_features||p.key_benefits)?String(p.key_features||p.key_benefits).replace(/\s+/g,' ').slice(0,70):'';
            const _pr=p.price?' — '+p.price:'';
            return '• '+(p.product_name||'')+_pr+(p.delivery_time?(' | 🚚 '+p.delivery_time):'');
          }).join('\n');
          const _dsTypAr={account:'حساب',code:'كود',recharge:'شحن'};
          const _dsAsked=_dsTypAr[service]||service;
          const _dsOffered=_dsTypAr[_dsTop.product_type]||_dsTop.product_type;
          const _dsReply='ما عندناش '+_dsAsked+' بهاد الميزانية دابا خويا 🙏 ولكن عندنا '+_dsOffered+' كيدير عليك بالميزانية ديالك 🔥\n'+_dsList+'\n\nواش كيهمّك شي واحد منهم؟';
          return {reply:_dsReply, via:'cross_downsell', service:(_dsTop.product_type||null), products:_dsR.rows, image_url:((_dsTop.image_url&&String(_dsTop.image_url).startsWith('http'))?_dsTop.image_url:null)};
        }
      }catch(_dse){}
    }
    return {reply:'سمح ليا خويا 🙏 هاد الحاجة مازال ماكايناش عندنا دابا. واش نوريك اللي متوفر عندنا، ولا نخليك مع الفريق باش يشوف ليك؟', via:'none', products:[], escalate:'NO_CATALOG_MATCH'};
  }
  const top3=cands.slice(0,3);
  // FIX #2 — DETERMINISTIC offer. Catalog = ONLY source of truth; NO AI decides price/count/discount/features/products.
  var _shown=(Array.isArray(shownIds)?shownIds:[]).map(Number);
  var _fit=cands.filter(function(p){
    if(!String(p.product_name||'').trim()) return false;
    if(_shown.indexOf(Number(p.id))>=0) return false;
    if(bud>0){ var _floor=parseInt(p.min_price)||parseInt(p.price_value)||0; if(_floor>0 && _floor>bud) return false; }
    return true;
  });
  if(!_fit.length){ return {reply:'سمح ليا خويا 🙏 هادشي اللي كان متوفر بهاد الميزانية. تقدر تشوف منتجات أخرى فالقناة ديالنا، ولا نخليك مع الفريق؟', via:'none', products:[], escalate:'NO_CATALOG_MATCH'}; }
  var _off=_fit.slice(0,3);
  var _leadImg=(_off[0]&&_off[0].image_url&&String(_off[0].image_url).startsWith('http'))?_off[0].image_url:null;
  function _wdFeat(p){ var f=[]; if(p.account_rank)f.push('رتبة '+p.account_rank); if(p.evo_count)f.push(p.evo_count+' إيفو'); if(String(p.product_type)==='code'&&p.code_type)f.push(String(p.code_type)); var kf=String(p.key_features||p.key_benefits||'').replace(/\s+/g,' ').trim(); if(kf)f.push(kf.slice(0,60)); return f.slice(0,3); }
  function _wdCard(p, opts){ var ff=_wdFeat(p); var gn=String(p.guarantee_note||''); var showG=(opts&&opts.showGuarantee)||/lifetime|مدى الحياة|مضمون للأبد/i.test(gn); return '🔹 '+(p.product_name||'')+'\n💰 '+(p.price||p.price_value||'')+(ff.length?('\n✨ '+ff.join(' · ')):'')+(showG&&gn?('\n🛡️ '+gn):'')+(p.delivery_time?('\n🚚 التسليم: '+p.delivery_time):''); }
  var _cards=_off.map(function(p){return _wdCard(p,{showGuarantee:!!trustSeeking});}).join('\n\n');
  var _intro=(_off.length===1)?('هذا هو المنتج الوحيد المتوفر بميزانيتك'+(bud?(' ('+bud+' درهم)'):'')+' خويا 🔥'):('عندنا '+_off.length+' اللي يناسبو ميزانيتك'+(bud?(' ('+bud+' درهم)'):'')+' خويا 🔥');
  return {reply:_intro+'\n\n'+_cards+'\n\nواش عجبك شي واحد منهم؟ 🙏', via:'catalog', service:(service||null), products:_off, image_url:_leadImg, shown_ids:_off.map(function(p){return p.id;})};
}

app.post('/api/ai/v2reply', async (req,res)=>{
  const t0=Date.now(); const b=req.body||{}; const sub=b.subscriber_id||null; const messages=(b.messages||[]).slice(-10);
  const turn_id='t'+Date.now().toString(36)+Math.random().toString(36).slice(2,7); // correlation id: one customer turn -> all its AI hops
  try{
    let lu=(messages.filter(m=>m.role==='user').slice(-1)[0]||{}).content||'';
    // ===== GLOBAL PAYMENT LAYER — single owner of the entire payment flow (claim + method + offer); runs FIRST (sacred, never bypassed) =====
    { const _pl=await _paymentLayer(lu, sub, b, t0); if(_pl && _pl.handled) return res.json(_pl.response); }
    // ===== GLOBAL AI PAUSE (kill-switch): if ai_paused=true the live seller stays SILENT (operator handles manually). Payment claims above still escalate. Zero effect when ai_paused=false. =====
    try{ const _ap=await pool.query("SELECT value FROM aykoshop_settings WHERE key='ai_paused'"); if(_ap.rows[0] && String(_ap.rows[0].value)==='true'){ _logAiUsage({subscriber_id:sub,provider:'rule',model:'-',mode:'paused',role:'system',route_layer:'ai_paused',user_msg:(typeof lu==='string'?lu:'[media]').slice(0,120),success:true}); return res.json({ ok:true, stage:'paused', agent:'Human', model:'-', frozen:true, paused:true, next:'paused', reply:null, ms:Date.now()-t0 }); } }catch(_e){}
    // ===== HUMAN-CONTROL FREEZE GATE (AFTER payment — payment is never bypassed): customer in stopped_chats => AI SILENT (mirrors n8n "Check Stopped & Route"->Silent Response). =====
    if(sub && /^[0-9]+$/.test(String(sub))){ try{ const _fz=await pool.query("SELECT reason, stopped_at FROM aykoshop_stopped_chats WHERE subscriber_id=$1 LIMIT 1",[String(sub)]); if(_fz.rows.length){ var _frz=_fz.rows[0]; var _expAiLoop=(_frz.reason==='ai_loop' && _frz.stopped_at && (Date.now()-new Date(_frz.stopped_at).getTime())>3600000); if(_expAiLoop){ pool.query("DELETE FROM aykoshop_stopped_chats WHERE subscriber_id=$1 AND reason='ai_loop'",[String(sub)]).catch(()=>{}); pool.query("UPDATE aykoshop_profiles SET reply_repeat=0, customer_hash_repeat=0, attempts=0 WHERE subscriber_id=$1",[String(sub)]).catch(()=>{}); } else { return res.json({ ok:true, stage:'frozen', agent:'Human', model:'-', frozen:true, freeze_reason:(_frz.reason||null), next:'frozen', reply:null, ms:Date.now()-t0 }); } } }catch(_e){} }
    // ===== P4 GENERIC SLOT ENGINE (flag ff_slot_engine: off|shadow|on; OFF by default = zero live change) =====
    if(sub && /^[0-9]+$/.test(String(sub))){ try{ var _smode=await _slotsMode(); if(_smode!=='off'){
      var _psr=await pool.query("SELECT session_data FROM aykoshop_profiles WHERE subscriber_id=$1",[String(sub)]);
      var _psd=(_psr.rows[0]||{}).session_data||{}; var _ps=_psd.pending_slots;
      if(_ps && Array.isArray(_ps.reqs) && _ps.reqs.length){
        var _slr=await _v2Slots(_ps.reqs, _ps.collected||{}, lu);
        if(_smode==='shadow'){ pool.query("UPDATE aykoshop_profiles SET session_data = COALESCE(session_data,'{}')::jsonb || jsonb_build_object('pending_slots',$2::jsonb) WHERE subscriber_id=$1",[String(sub),JSON.stringify(Object.assign({},_ps,{collected:_slr.collected}))]).catch(function(){}); }
        else if(_slr.done){
          var _sum=Object.keys(_slr.collected).map(function(k){return k+': '+_slr.collected[k];}).join(' | ');
          pool.query("UPDATE aykoshop_profiles SET session_data = (COALESCE(session_data,'{}')::jsonb - 'pending_slots') WHERE subscriber_id=$1",[String(sub)]).catch(function(){});
          pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,'human_recharge') ON CONFLICT(subscriber_id) DO UPDATE SET reason='human_recharge', stopped_at=NOW()",[String(sub)]).catch(function(){});
          fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:b.channel||null,reason_code:'SLOTS_COMPLETE',reason_detail:'معلومات الطلب كاملة ('+(_ps.product_name||_ps.service_type||'')+'): '+_sum,customer_message:String(lu).slice(0,300)})}).catch(function(){});
          return res.json({ ok:true, stage:'human', agent:'Slots→Human', model:'slots', next:'slots_complete', collected:_slr.collected, reply:'صافي خويا 🙏 توصلنا المعلومات ديالك كاملة، الفريق غادي يكمّل ليك دابا ويتواصل معاك بسرعة 🔥', ms:Date.now()-t0 });
        } else {
          var _asks=(parseInt(_ps.asks)||0)+1;
          if(_asks>=3){ pool.query("UPDATE aykoshop_profiles SET session_data = (COALESCE(session_data,'{}')::jsonb - 'pending_slots') WHERE subscriber_id=$1",[String(sub)]).catch(function(){}); pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,'human_handoff') ON CONFLICT(subscriber_id) DO NOTHING",[String(sub)]).catch(function(){}); fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:b.channel||null,reason_code:'SLOTS_STUCK',reason_detail:'الزبون ما كمّلش المعلومات المطلوبة بعد 3 محاولات',customer_message:String(lu).slice(0,300)})}).catch(function(){}); return res.json({ ok:true, stage:'human', agent:'Slots→Human', model:'slots', next:'slots_stuck', reply:'سمح ليا خويا 🙏 غادي نخليك مع الفريق باش يكمّل معاك مباشرة 👤', ms:Date.now()-t0 }); }
          pool.query("UPDATE aykoshop_profiles SET session_data = COALESCE(session_data,'{}')::jsonb || jsonb_build_object('pending_slots',$2::jsonb) WHERE subscriber_id=$1",[String(sub),JSON.stringify(Object.assign({},_ps,{collected:_slr.collected,asks:_asks}))]).catch(function(){});
          return res.json({ ok:true, stage:'sales', agent:'Slots', model:'slots', next:'slot_ask', reply:_slr.ask, ms:Date.now()-t0 });
        }
      }
    } }catch(_e){} }
    // ff_human_welcome flag (read EARLY — used by the greeting debounce nudge below; must precede first use to avoid let-TDZ)
    let _ffHW=false; try{ _ffHW=await _ff('human_welcome'); }catch(_e){}
    // ===== BOT-QUESTION INTERCEPTOR: "واش نت بوت؟" → warm identity reply, NO LLM, NO AI mention. =====
    // Rule: identify as AykoShop assistant ONLY when directly asked. Never volunteer AI/bot status.
    if(typeof lu==='string' && lu.length>2 && lu.length<120){
      const _botQRx=/واش\s*نت\s*(بوت|روبوت|robot|bot|ai|ذكاء|آلي|آلة|machine)|مع\s*من\s*كنهدر|نت\s*إنسان\s*ولا|نت\s*بشري|واش\s*نت\s*إنسان|هادشي\s*(ai|bot|بوت)|إيكو\s*ولا|ايكو\s*ولا|أنت\s*بوت|نتا\s*بوت|واش\s*كنهدر\s*مع\s*بوت|نت\s*ريال|واش\s*ريال|كنهدر\s*مع\s*شخص|واش\s*نت\s*(حقيقي|حقيقية)/i;
      if(_botQRx.test(lu)){
        // Two warm variants (alternated by turn parity — no Math.random needed)
        const _isTurnOdd = (turn_id||'').charCodeAt(0) % 2 === 1;
        const _botReply = _isTurnOdd
          ? 'أنا المساعد ديال AykoShop 😊 كنعاونك تلقى المنتج بسرعة. وإيلا حتاجتي واحد من الفريق نرتبها ليك 🙏 كيفاش نخدمك؟'
          : 'أنا هنا نعاونك فالطلبات والاستفسارات ديال AykoShop 😊 وإيلا بغيتي تتواصل مع الفريق مباشرة نحولك ليهم. واش بغيتي شي حاجة؟';
        if(sub && /^[0-9]+$/.test(String(sub))){ pool.query("INSERT INTO aykoshop_chat_history (subscriber_id,role,message) VALUES ($1,'assistant',$2)",[String(sub),_botReply]).catch(()=>{}); }
        pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,$2,'sales','BotQuestion','identity_question',$3)",[String(sub||''),'early',String(lu).slice(0,200)]).catch(()=>{});
        return res.json({ ok:true, stage:'sales', agent:'BotQuestion', model:'rule', router_via:'rule', next:'identity_reply', reply:_botReply, ms:Date.now()-t0 });
      }
    }
    // ===== DARIJA PING INTERCEPTOR: "سلتك/وجاوب/اهداني/وصلك/هنا؟" = customer pinging bot (checking if alive).
    // These are short ambiguous phrases that mean "did you get it?" / "respond" / "are you there?".
    // Current behavior: Router says "ما فهمتش" — wrong. Correct: warm acknowledgement + open question.
    // Guard: must be short (<30 chars) and contain NO product/price/buy keywords (else treat as buy request).
    if(typeof lu==='string' && lu.trim().length>1 && lu.trim().length<30){
      const _noProduct=/حساب|كونط|account|شحن|recharge|كود|code|سكن|skin|سلاح|weapon|درهم|drhm|dh|بغيت|bghit|shri|شري|نشري|ثمن|سعر|price|[0-9]|free\s*fire|فري\s*فاير|netflix|نتفليكس/i;
      const _pingRx=/^(سلتك|سلطك|slthk|seltek|وجاوب|wjaawb|wjawb|wajaawb|اهداني|هداني|هدني|hhdani|hdani|هناك|هنا واحد|راجك|rajk|rajek|وصلك|wasslk|wslk|كاين|كاينة|هنا|hnaa|hna\??|ولا لا|عاود|عاودو|كمّل|kml|tkml|زعما|mzyan|mazal\??|mzl|ah|آه|ويلي|wili|ya|يا|aa|aaah|oui|ouii|واو|نعام|na3am|ayeh|أيه|إيه|طيب|wakha|واخا|وخا|صح|s7|sah|ok|okay)\s*[!.؟?]*$/i;
      if(_pingRx.test(lu.trim()) && !_noProduct.test(lu)){
        const _pingReply = 'وصلني خويا 😊 كيفاش نقدر نعاونك؟';
        if(sub && /^[0-9]+$/.test(String(sub))){ pool.query("INSERT INTO aykoshop_chat_history (subscriber_id,role,message) VALUES ($1,'assistant',$2)",[String(sub),_pingReply]).catch(()=>{}); }
        pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,$2,'greeting','PingReply','darija_ping',$3)",[String(sub||''),'early',String(lu).slice(0,100)]).catch(()=>{});
        return res.json({ ok:true, stage:'greeting', agent:'PingReply', model:'rule', router_via:'rule', next:'ping_reply', reply:_pingReply, ms:Date.now()-t0 });
      }
    }
    // FIX #1 — greeting debounce: rapid duplicate bare-greetings within 30s -> one reply only.
    if(sub && /^[0-9]+$/.test(String(sub)) && typeof lu==='string'){ var _gt=lu.trim().toLowerCase(); if(_gt.length<25 && /^(s+l+m|smm|sa?lam|salut|cc|hi|hello|bonjour|سلام|سلم|السلام|اهلا|أهلا|هاي|صباح|مساء)/.test(_gt) && !/حساب|شحن|كود|بغيت|شري|نشري|ثمن|درهم|[0-9]/.test(_gt)){ try{ var _lgPrev=_greetDebounce.get(String(sub)); if(_lgPrev && (Date.now()-_lgPrev)<30000){ return res.json({ ok:true, stage:'greet_debounce', agent:'Greeting-Debounce', model:'rule', suppress:true, reply:(_ffHW?'أنا هنا خويا 😊 كيفاش نقدر نعاونك؟':''), ms:Date.now()-t0 }); } _greetDebounce.set(String(sub),Date.now()); if(_greetDebounce.size>5000) _greetDebounce.clear(); }catch(_e){} } }
    // ===== CREDENTIALS SAFETY V2 (text/transcript): email/password/codes/2FA/secret => REDACT + Human Takeover (AI never echoes/stores/learns) =====
    if(sub && /^[0-9]+$/.test(String(sub)) && typeof lu==='string' && lu.indexOf('http')!==0){ const _ct=_v2DetectCreds(lu); if(_ct){ _v2CredFreeze(sub,b,_ct); return res.json({ ok:true, stage:'credentials_human', agent:'CredentialGuard', model:'rule', router_via:'rule', next:'human_takeover', credential_type:_ct, reply:'شوية ⏳ غادي يكمّل معاك واحد من الفريق دابا 🙏 وللأمان عافاك ماتكتبش معلومات حساسة (إيميل/باسوورد/كود) هنا، البشري غادي ياخدها بأمان.', ms:Date.now()-t0 }); } }
    // ===== VISION GATE: صورة → GPT-4o Vision (وصف فقط) → Catalog Search → Seller/Human. Vision ماكيبيعش؛ الكاطالوج هو المصدر؛ ممنوع التخمين. =====
    if(typeof lu==='string' && lu.indexOf('http')===0 && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(lu)){
      let _vr={}; try{ _vr=await (await fetch('http://localhost:4000/api/ai/vision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image_url:lu,message:'',subscriber_id:sub,channel:b.channel||null})})).json(); }catch(e){}
      let _vst,_vag,_vreply,_vesc=false;
      if(_vr && _vr.is_payment){ _vst='payment'; _vag='Vision→Payment(Human)'; _vreply=_vr.reply||'وصلنا سكرين الدفع 🙏 غادي نتحقّقو ونأكّدو ليك. ماتعاودش الدفع.'; _vesc='PAYMENT_INTENT'; }
      else if(_vr && (_vr.match_level==='strong'||_vr.match_level==='medium')){ let _s={}; try{ _s=await _v2Seller(_vr.query||'', null, _vr.service||null, null, (_vr.game_in_catalog?_vr.game:null), (_vr.products||[]), ctx.shown); }catch(e){} if(_s&&_s.escalate){ _vst='human'; _vag='Vision→Human'; _vreply=_s.reply||'شوية ⏳ غادي نخليك مع الفريق 🙏'; _vesc=_s.escalate; } else { _vst='sales'; _vag='Vision→Seller'; _vreply=(_s&&_s.reply)||'شفنا الصورة 👀 عندنا هادشي قريب ليها، واش مهتم؟'; } }
      else { _vst='human'; _vag='Vision→Human'; _vreply='شوية ⏳ غادي يشوف الصورة واحد من الفريق ويرجع ليك بسرعة 🙏'; _vesc='HUMAN_REQUESTED'; }
      if(sub && /^[0-9]+$/.test(String(sub))){
        pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,'image',$2,$3,$4,'[صورة]')",[String(sub),_vst,_vag,'vision:'+((_vr&&_vr.match_level)||'?')+' sim:'+((_vr&&_vr.top_sim)||0)]).catch(()=>{}); if(_vst==='human'||_vst==='payment'){ pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,$2) ON CONFLICT(subscriber_id) DO NOTHING",[String(sub),(_vst==='payment'?'payment_verification':'human_handoff')]).catch(()=>{}); }
        if(_vst==='human' && _vesc!=='PAYMENT_INTENT'){ fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:b.channel||null,reason_code:(_vesc||'HUMAN_REQUESTED'),reason_detail:'Vision→Catalog: match='+((_vr&&_vr.match_level)||'none')+' sim='+((_vr&&_vr.top_sim)||0)+' | q='+String((_vr&&_vr.query)||'').slice(0,100),customer_message:'[صورة]'})}).catch(()=>{}); }
      }
      _logAiUsage({subscriber_id:sub,provider:'v2',model:'gpt-4o',mode:'v2',role:_vst,route_layer:'v2_vision',user_msg:'[image] '+String((_vr&&_vr.query)||'').slice(0,90),success:true});
      return res.json({ ok:true, stage:_vst, agent:_vag, model:'gpt-4o', router_via:'vision', next:'vision_result', vision_match:((_vr&&_vr.match_level)||'none'), vision_sim:((_vr&&_vr.top_sim)||0), vision_query:((_vr&&_vr.query)||''), products:((_vr&&_vr.products)||[]), reply:_stripMd(_vreply), ms:Date.now()-t0 });
    }
    // ===== PENDING IMAGE → تحليل Vision (gpt-4o) بعد ما الزبون يحدد النية =====
    if(sub && /^[0-9]+$/.test(String(sub)) && typeof lu==='string' && lu.indexOf('http')!==0){
      let _pi=null; try{ const _r=await pool.query("SELECT pending_image FROM aykoshop_profiles WHERE subscriber_id=$1",[String(sub)]); _pi=(_r.rows[0]||{}).pending_image; }catch(e){}
      if(_pi){
        pool.query("UPDATE aykoshop_profiles SET pending_image=NULL WHERE subscriber_id=$1",[String(sub)]).catch(()=>{});
        if(/تبيع|نبيع|نسيفط ليكم|بيع/i.test(lu)){ pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,'vision_intake','human','Vision→Human','sell_image',$2)",[String(sub),String(lu).slice(0,200)]).catch(()=>{}); pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,'human_handoff') ON CONFLICT(subscriber_id) DO NOTHING",[String(sub)]).catch(()=>{}); fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:b.channel||null,reason_code:'HUMAN_REQUESTED',reason_detail:'V2 Vision: زبون بغى يبيع بصورة — بشري',customer_message:'[صورة بيع]'})}).catch(()=>{}); return res.json({ ok:true, stage:'human', agent:'Vision→Human', model:'-', router_via:'vision', next:'to_human', reply:'فهمت خويا، بغيتي تبيع 🙏 نخليك مع الفريق باش يشوف الصورة ويعطيك التفاصيل. غادي نرجعو ليك بسرعة.', ms:Date.now()-t0 }); }
        let _vr={}; try{ _vr=await (await fetch('http://localhost:4000/api/ai/vision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image_url:_pi,message:lu,subscriber_id:sub,channel:b.channel||null})})).json(); }catch(e){}
        let _st,_ag; if(_vr.is_payment){ _st='payment'; _ag='Vision→Payment(Human)'; } else if(_vr.found_match){ _st='sales'; _ag='Vision→Seller'; } else { _st='human'; _ag='Vision→Human'; }
        if(_vr && _vr.reply && _v2DetectCreds(_vr.reply)){ const _ct=_v2DetectCreds(_vr.reply); _v2CredFreeze(sub,b,_ct); return res.json({ ok:true, stage:'credentials_human', agent:'Vision-CredentialGuard', model:'rule', router_via:'vision', next:'human_takeover', credential_type:_ct, reply:'شوية ⏳ الفريق غادي يشوف الصورة ويكمّل معاك بأمان 🙏', ms:Date.now()-t0 }); }
        pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,'vision_intake',$2,$3,'vision_analyzed',$4)",[String(sub),_st,_ag,String(lu).slice(0,200)]).catch(()=>{}); if(_st==='human'||_st==='payment'){ pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,$2) ON CONFLICT(subscriber_id) DO NOTHING",[String(sub),(_st==='payment'?'payment_verification':'human_handoff')]).catch(()=>{}); }
        return res.json({ ok:true, stage:_st, agent:_ag, model:'gpt-4o', router_via:'vision', next:'vision_result', vision_type:_vr.type, vision_payment:!!_vr.is_payment, reply:_vr.reply||'صافي خويا 🙏 الفريق غادي يشوف الصورة ويرجع ليك.', ms:Date.now()-t0 });
      }
    }
    // ===== AUDIO GATE: صوت → تحويل لنص فقط → العساس. إلا فشل → طلب نص (Audio ماكيقررش/ماكيبيعش) =====
    if(typeof lu==='string' && /audioclip|\.(ogg|m4a)(\?|$)|cdn\.fbsbx[^\s]*\.(mp4|ogg|m4a)|lookaside[^\s]*ig_messaging_cdn/i.test(lu)){
      let _txt=null;
      try{ const _tr=await (await fetch('http://localhost:4000/api/ai/transcribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audio_url:lu,subscriber_id:sub})})).json(); if(_tr && _tr.ok && _tr.text) _txt=_tr.text; }catch(e){}
      if(!_txt){ return res.json({ ok:true, stage:'audio_intake', agent:'Audio→Router', model:'rule', router_via:'rule', next:'ask_text', reply:'🎤 سمعت إنك صيفطي صوت، ولكن ماقدرتش نفهمو مزيان دابا 🙏 عافاك كتب لينا اللي بغيتي بالنص ونكملو معاك 😊', ms:Date.now()-t0 }); }
      lu=_txt; for(let _k=messages.length-1;_k>=0;_k--){ if(messages[_k]&&messages[_k].role==='user'){ messages[_k]=Object.assign({},messages[_k],{content:_txt}); break; } }
      { const _pl=await _paymentLayer(lu, sub, b, t0); if(_pl && _pl.handled) return res.json(_pl.response); }
      { const _ct=_v2DetectCreds(lu); if(_ct){ _v2CredFreeze(sub,b,_ct); return res.json({ ok:true, stage:'credentials_human', agent:'Audio-CredentialGuard', model:'rule', router_via:'audio', next:'human_takeover', credential_type:_ct, reply:'شوية ⏳ غادي يكمّل معاك واحد من الفريق دابا 🙏', ms:Date.now()-t0 }); } }
    }
    let ctx={product:null,budget:null,state:null,service:null,game:null,attempts:0,payment_method:null,rejected:[],rejected_games:[],last_reply_hash:null,reply_repeat:0,convo_state_turns:0,last_customer_hash:null,customer_hash_repeat:0,channel_visited:false,had_offer:false,shown:[],buy_intent_active:false,budget_confirmed:false};
    if(sub){ try{ const r=await pool.query("SELECT convo_state,favorite_game,budget,service_type,attempts,payment_method,rejected_services,last_reply_hash,reply_repeat,clarify_count,convo_state_turns,last_customer_hash,customer_hash_repeat,session_data FROM aykoshop_profiles WHERE subscriber_id=$1",[String(sub)]); if(r.rows.length){ const p=r.rows[0]; ctx.state=p.convo_state; ctx.product=p.favorite_game?String(p.favorite_game).toLowerCase():null; ctx.game=p.favorite_game||null; ctx.budget=p.budget; ctx.service=p.service_type; ctx.attempts=parseInt(p.attempts)||0; ctx.payment_method=p.payment_method||null; ctx.rejected=String(p.rejected_services||'').split(',').filter(Boolean); ctx.last_reply_hash=p.last_reply_hash||null; ctx.reply_repeat=parseInt(p.reply_repeat)||0; ctx.clarify_count=parseInt(p.clarify_count)||0; ctx.convo_state_turns=parseInt(p.convo_state_turns)||0; ctx.last_customer_hash=p.last_customer_hash||null; ctx.customer_hash_repeat=parseInt(p.customer_hash_repeat)||0; const _sd=p.session_data||{}; ctx.channel_visited=!!(_sd.channel_visited); ctx.had_offer=!!(_sd.had_offer); ctx.shown=Array.isArray(_sd.shown_products)?_sd.shown_products:[]; ctx.buy_intent_active=!!(_sd.buy_intent_active); ctx.budget_confirmed=!!(_sd.budget_confirmed); ctx.awaiting_confirm=_sd.awaiting_confirm||null; ctx.product_confirmed=!!(_sd.product_confirmed); // ff_clarify_engine V2: product-confirm state. FIX-A: load persisted rejected games from session_data
      ctx.rejected_games=Array.isArray(_sd.rejected_games)?_sd.rejected_games:[]; ctx.handoff_summary=_sd.handoff_summary||null; ctx.last_bot_next=_sd.last_bot_next||null; } }catch(e){} }
    // (Global Payment Layer moved to the top of the handler — single owner)

    // Shared Memory: recent agent trail (شكون دخل قبل + علاش تحول)
    let trail=[]; let _prevAgent=null; if(sub){ try{ const tr=await pool.query("SELECT to_stage,agent FROM aykoshop_agent_trail WHERE subscriber_id=$1 ORDER BY id DESC LIMIT 6",[String(sub)]); if(tr.rows.length)_prevAgent=tr.rows[0].agent||null; trail=tr.rows.reverse().map(x=>x.to_stage); }catch(e){} }
    // ===== ff_answer_last: answer the customer's last message FIRST; broaden discovery detection; prevent identical-reply repeat =====
    let _ffAL=false; try{ _ffAL=await _ff('answer_last'); }catch(_e){}
    // ===== ff_seller_fix: Fix1(dynamic discover menu) + Fix2(objection path) + Fix3(anti-loop hardening). OFF=byte-identical. =====
    let _ffSF=false; try{ _ffSF=await _ff('seller_fix'); }catch(_e){}
    // ===== ff_smart_seller: Category-Locked Smart Budget Window. OFF=byte-identical to current. =====
    let _ffSSmain=false; try{ _ffSSmain=await _ff('smart_seller'); }catch(_e){}
    // ===== ff_qualify_complete: Metadata-driven progressive slot-filling gate. OFF=byte-identical. =====
    let _ffQC=false; try{ _ffQC=await _ff('qualify_complete'); }catch(_e){}
    // ===== ff_clarify: Intent-Clarification layer. OFF=byte-identical (clear paths NEVER touched). =====
    let _ffClarify=false; try{ _ffClarify=await _ff('clarify'); }catch(_e){}
    // ===== ff_clarify_engine: deterministic Intent-Clarification arbiter — ambiguous/short messages get a context-linked or general clarifying question (clarify-before-handoff), NEVER a guess/channel-dump/human for ambiguity. Human only for legit reasons OR N=3 failed clarifies. OFF=byte-identical. =====
    let _ffCE=false; try{ _ffCE=await _ff('clarify_engine'); }catch(_e){}
    // ===== ff_freeze_handoff: when the bot hands a chat to a human (escalate + stage='human'), FREEZE it
    // (stopped_chats) so it (a) goes silent next turn and (b) appears in the frozen dashboard for manual resume. OFF=identical. =====
    let _ffFH=false; try{ _ffFH=await _ff('freeze_handoff'); }catch(_e){}
    // ===== ff_price_answer: FIX-A (ask_budget always states real price) + FIX-B (price-inquiry intercept before ask_budget). OFF=byte-identical. Composes with ff_smart_seller/qualify/clarify/anti-spam/freeze-handoff. =====
    let _ffPA=false; try{ _ffPA=await _ff('price_answer'); }catch(_e){}
    // ===== ff_memory_continuity: returning customer after handoff (convo_state='human') recalls the REAL last topic (game+service) and re-engages in discovery, instead of greeting as a brand-new customer. Also fixes the _gl hardcoded-'Free Fire' bug (uses the real game). OFF=byte-identical. =====
    let _ffMC=false; try{ _ffMC=await _ff('memory_continuity'); }catch(_e){}
        // S1-B: Build conv object from ctx + run Hybrid Intent + Emotion (wired to live path)
    var _conv={stage:ctx.state||'INIT',last_next:ctx.last_bot_next||null,game:ctx.game||null,budget:ctx.budget?(parseInt(String(ctx.budget).replace(/[^0-9]/g,''))||null):null,goal:ctx.service||null,rejected:ctx.rejected||[],had_offer:!!ctx.had_offer,sell_mode:ctx.state==='sell_mode'};
    var _normLu=(typeof lu==='string')?_normalize(lu):'';
    var _hiRes=_hybridIntent(_normLu||String(lu||'')||''  ,_conv);
    var _emotion=_detectEmotion(typeof lu==='string'?lu:'');
// ===== ff_human_welcome: flag read moved earlier (before greeting debounce, see above) to avoid TDZ =====
        // ===== RETURNING-CUSTOMER bare greeting => state-aware recall (deterministic, human, ZERO LLM). New customers fall through to Haiku warm greeting. =====
    if(sub && /^[0-9]+$/.test(String(sub))){
      const _bg=/^\s*(سلام|سلامو|السلام|اهلا|أهلا|اهلين|مرحبا|مرحبتين|صباح الخير|صباح|مسا|مساء الخير|مساء|labas|labass|salam|salut|bonjour|cava|hi|hello|hey|slm|slam|cc|كيداير|كي داير|كيف داير|اش خبارك|أش خبارك|واش كلشي مزيان)/i.test(lu) && !/حساب|كونط|شري|نشري|بغيت|شحن|نشحن|جواهر|دياموند|كود|سكن|سلاح|مشكل|بيع|نبيع|خلصت|حولت|دفعت|صيفطت|[0-9]/.test(lu) && (lu.length<45)||(_hiRes&&_hiRes.intent==='greeting'&&_hiRes.confidence>=0.90);
      const _hasState=(ctx.state==='browsing')||((ctx.state==='sales'||ctx.state==='discovery'||ctx.state==='payment'||(_ffMC&&ctx.state==='human'))&&(ctx.product||ctx.service||ctx.game));
      if(_bg && ctx.state==='completed'){ pool.query("UPDATE aykoshop_profiles SET convo_state=NULL, last_seen=NOW() WHERE subscriber_id=$1",[String(sub)]).catch(()=>{}); pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,'completed','greeting','Router (fresh)','completed_greeting',$2)",[String(sub),String(lu).slice(0,200)]).catch(()=>{}); return res.json({ ok:true, stage:'greeting', agent:'Router (fresh)', model:'rule', router_via:'rule', intent:'completed_greeting', next:'greet_fresh', reply:'مرحبا بيك خويا 👋 كيفاش نقدر نعاونك اليوم؟', ms:Date.now()-t0 }); }
      if(_bg && _hasState){
        const _gl=_ffMC?(ctx.game?String(ctx.game):''):((ctx.product==='freefire'||ctx.game)?'Free Fire':'');
        const _sv=(ctx.service==='recharge')?'تشحن جواهر':(ctx.service==='code')?'كودات':(ctx.service==='account')?'حساب':'';
        let _gr;
        if(_ffHW){
          // SKILL 2 — ff_human_welcome: non-pushy recall (mentioning last topic, open question)
          const _topic=_ffMC?(([_sv,_gl].filter(Boolean).join(' '))||'آخر محادثة'):((_sv||(_gl?_gl:''))||'آخر محادثة');
          _gr='مرحبا خويا 😊 آخر مرة تكلمنا على '+_topic+'، واش مازال مهتم بها ولا كاين شي حاجة أخرى نعاونك فيها؟';
        } else {
          if(ctx.state==='browsing'){ _gr='مرحبا بيك مجدداً خويا 👋 واش مازال مهتم باللي كنتي كتقلب عليه'+(_gl?(' فـ'+_gl):'')+'، ولا بغيتي شي حاجة أخرى نوريهالك؟'; } else { _gr='مرحبا بيك مجدداً خويا 👋 آخر مرة كنتي باغي '+(_sv||'تشري')+(_gl?(' '+_gl):'')+'. مازال باغي نكمّلو ليك؟'; }
        }
        // ff_memory_continuity: customer handed to human then returned (after operator resume) → re-engage in discovery instead of leaving stage='human'. OFF keeps original stage (byte-identical).
        var _recallStage=(_ffMC&&ctx.state==='human')?'discovery':ctx.state;
        pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,$2,$3,'Router (recall)','greet_recall',$4)",[String(sub),ctx.state,_recallStage,String(lu).slice(0,200)]).catch(()=>{});
        if(_ffMC&&ctx.state==='human'){ pool.query("UPDATE aykoshop_profiles SET convo_state='discovery', clarify_count=0, last_seen=NOW() WHERE subscriber_id=$1",[String(sub)]).catch(()=>{}); }
        else { pool.query("UPDATE aykoshop_profiles SET last_seen=NOW() WHERE subscriber_id=$1",[String(sub)]).catch(()=>{}); }
        return res.json({ ok:true, stage:_recallStage, agent:'Router (recall)', model:'rule', router_via:'rule', intent:'returning_greeting', next:'greet_recall', reply:_gr, ms:Date.now()-t0 });
      }
      // SKILL 1 — ff_human_welcome: pure greeting, no prior context (new/unknown customer) → warm welcome, STOP (never fall through to ask_product/discover)
      if(_ffHW && _bg && !_hasState && ctx.state!=='completed'){
        pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,'new','greeting','Router (welcome)','human_welcome',$2)",[String(sub),String(lu).slice(0,200)]).catch(()=>{});
        pool.query("UPDATE aykoshop_profiles SET last_seen=NOW() WHERE subscriber_id=$1",[String(sub)]).catch(()=>{});
        return res.json({ ok:true, stage:'greeting', agent:'Router (welcome)', model:'rule', router_via:'rule', intent:'new_greeting', next:'greet_welcome', reply:'وعليكم السلام خويا 😊 مرحبا بك فـAykoShop، كيفاش نقدر نعاونك اليوم؟', ms:Date.now()-t0 });
      }
    }
        // ===== HUMAN-STATE SILENCE: customer was handed to human (convo_state='human'), non-greeting msg → bot stays silent.
    // Greetings are handled by memory_continuity/human_welcome paths above (they return early).
    // Non-greeting messages (سس, random chars, etc.) from 'human' state would otherwise cycle through
    // the LLM router → clarify_intent → clarify_count++ → clarify_human again (repeat loop).
    // Silence = correct: the human operator will handle it. Bot re-activates only after operator resumes.
    if(ctx.state==='human'){
      var _bgEarly=/^\s*(سلام|سلامو|السلام|اهلا|أهلا|اهلين|مرحبا|مرحبتين|صباح|مسا|مساء|labas|labass|salam|salut|bonjour|cava|hi|hello|hey|slm|slam|cc)/i.test(String(lu||'')) && String(lu||'').length<45;
      if(!_bgEarly){ return res.json({ok:true,stage:'human',agent:'Human (silent)',model:'-',frozen:true,next:'frozen',reply:null,ms:Date.now()-t0}); }
    }
    // ===== KB/RAG retrieval — style/knowledge/objection ONLY, NEVER prices/products/payment/lock. After all deterministic gates. =====
    let _km=null, _kbCtx=null;
    if(sub && typeof lu==='string' && lu.length>=6 && lu.indexOf('http')!==0 && !/^\s*[0-9]+\s*$/.test(lu)){ try{ _km=await _kbMatch(lu); if(_km && _km.sim>=0.55){ _kbCtx=_km.reply; } }catch(_e){} }
    // ===== ff_seller_brief: compute the compact customer card (temp/returning/last-product/budget/gap) from ctx+trail (already loaded) + 1 read-only catalog check, and pass it to the router as internal awareness. OFF → _sbBrief=null → router unchanged → byte-identical. =====
    // ===== Topic Change Detection: detect game switch mid-session =====
    // Resets product slots, keeps customer profile (name/channel/LTV/buyer_type)
    if(sub && ctx.game && lu && typeof lu==='string' && lu.trim().length>1 && !ctx.awaiting_confirm){
      const _newG=_extractGame(lu);
      if(_newG && _newG!==ctx.game){
        const _oldG=ctx.game;
        const _addStr=' '+lu+' ';
        const _isAdd=(/ و | مع |زد |زيد|أيضا|كذلك| add | and /).test(_addStr);
        if(!_isAdd){
          const _tcLog=JSON.stringify({type:'topic_change',old:_oldG,new:_newG,confidence:0.95,action:'reset_slots'});
          pool.query('INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,$2,$3,$4,$5,$6)',[String(sub),_oldG,_newG,'TopicChange',_tcLog,String(lu).slice(0,200)]).catch(()=>{});
          pool.query("UPDATE aykoshop_profiles SET interested_in=NULL, service_type=NULL, budget=NULL, session_data=(COALESCE(session_data,'{}')::jsonb - 'shown_products' - 'awaiting_confirm') WHERE subscriber_id=$1",[String(sub)]).catch(()=>{});
          ctx.game=_newG; ctx.product=null; ctx.budget=null; ctx.service=null; ctx.shown=[]; ctx.buy_intent_active=false; ctx.budget_confirmed=false; ctx.awaiting_confirm=null;
        }
      }
    }

    let _sbBrief=null; try{ if(await _ff('seller_brief')) _sbBrief=await _sellerBrief(ctx, trail, sub); }catch(_e){}
    // S1-B: Inject detected emotion into seller brief (LLM context enrichment)
    if(_emotion&&_emotion.emotion!=='normal'){ _sbBrief=(_sbBrief||'')+'\n[حالة الزبون: '+_emotion.emotion+' | شدة: '+_emotion.intensity+']'; }
    // S1-B: Log hybrid intent result to pipeline_shadow for observation
    if(sub&&_hiRes&&/^[0-9]+$/.test(String(sub))){ pool.query('INSERT INTO aykoshop_pipeline_shadow(subscriber_id,user_msg,gate_intent,gate_layer,next_state) VALUES($1,$2,$3,$4,$5)',[String(sub),String(lu||'').slice(0,200),_hiRes.intent,_hiRes.layer,ctx.state||'INIT']).catch(function(){}); }
    // Resume Summary Engine: inject handoff summary (one-shot — cleared after first use)
    if(sub && ctx.handoff_summary){ _sbBrief=('📋 ملخص التدخل البشري: '+ctx.handoff_summary+'\n')+(_sbBrief||''); pool.query("UPDATE aykoshop_profiles SET session_data=session_data - 'handoff_summary' WHERE subscriber_id=$1",[String(sub)]).catch(()=>{}); }
    const rt=await _v2Router(messages, ctx, _kbCtx, turn_id, sub, _sbBrief); const p=rt.parsed;
    const _haikuRej=(['recharge','account','code'].indexOf(p&&p.rejected_service)>=0)?p.rejected_service:null;
    const _haikuSvc=(['recharge','account','code'].indexOf(p&&p.service)>=0)?p.service:null;
    // [ADR-0020 Gate G1] router_intent — fire-and-forget, after decision vars set, never changes them
    if(sub && p && p.intent){ const _g1ev=[]; if(p.intent) _g1ev.push({type:'product_interest',value:(p.product&&p.product!=='null'?p.product:null),source:(rt.via==='haiku'?'haiku':'mini'),confidence:(rt.via==='haiku'?0.85:0.70)}); if(p.budget&&p.budget!=='null') _g1ev.push({type:'budget_stated',value:String(p.budget).replace(/[^0-9]/g,''),source:(rt.via==='haiku'?'haiku':'mini'),confidence:(rt.via==='haiku'?0.80:0.65)}); if(_haikuRej) _g1ev.push({type:'rejection',value:_haikuRej,source:(rt.via==='haiku'?'haiku':'mini'),confidence:(rt.via==='haiku'?0.80:0.65)}); _persistEvidence(String(sub),_g1ev.filter(function(e){return e.value!=null;}),turn_id).catch(()=>{}); }
    // ===== DETERMINISTIC STATE MACHINE — slots from Haiku + regex backstops, transition decided by CODE (reliable, not LLM) =====
    // ===== CATALOG-DRIVEN product/game match (NO hardcoded game): match Haiku's product + the message against ACTUAL catalog lines (game+keywords+category aliases) =====
    let prod=null, nonCat=null;
    // FIX-A: hoisted vars so the game-exclusion block (after try) can access them
    let _pnOuter='';      // Haiku's product slot
    let _gamExclName=null; // proper-cased name of the game that was excluded this turn (null = no exclusion)
    try{
      const _cm=await _catalogMeta();
      const _pn=(p.product && String(p.product)!=='null')?String(p.product):'';
      _pnOuter=_pn;
      const _hay=' '+(_pn+' '+String(lu)).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim()+' ';
      // service/category vocabulary (universal commerce words) — these must NOT identify a GAME even if they
      // appear in a product's name/keywords (e.g. 'حساب' is in id21 product_name "حساب Free Fire", which would
      // otherwise make EVERY "حساب ..." message match Free Fire and beat the real game token).
      const _gameStop=new Set(['حساب','كونط','account','compte','kont','كود','كودات','code','codes','codat','شحن','شحان','recharge','topup','جواهر','دياموند','diamond','diamonds','شدات','سكن','skin','سلاح','weapon','رقص','dance','emote','اشتراك','subscription','سلعة','حاجة','منتج','game','jeu','shop','جاهز','ready','dispo','disponible']);
      function _prodMatch(h,stop){ let b=null; (_cm.lines||[]).forEach(function(ln){ const hits=(ln.aliases||[]).filter(function(a){ return a && a.length>=3 && (!stop||!stop.has(a)) && h.indexOf(' '+a+' ')>=0; }); if(hits.length && (!b || hits.length>b.n)) b={name:ln.proper,n:hits.length}; }); return b; }
      let _best=null;
      if(_ffQC){
        // ff_qualify_complete: the customer's OWN words decide the product/game (catalog-alias match on lu alone,
        // service words excluded). The LLM product (_pn) is only a fallback hint — a hallucinated _pn must never
        // override an explicit game in the message (e.g. degraded gpt-4o-mini returning 'free fire' for 'حساب pes').
        const _hayLu=' '+String(lu).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim()+' ';
        _best=_prodMatch(_hayLu,_gameStop);
        if(!_best) _best=_prodMatch(_hay,_gameStop);
      } else {
        _best=_prodMatch(_hay,null);
      }
      if(_best) prod=_best.name;
      else if(_pn && _pn.length>=3 && !/account|recharge|code|subscription|حساب|كونط|شحن|شحان|كود|سكن|سلاح|رقص|جواهر|دياموند|سلعة|حاجة|منتج|اشتراك|game|jeu/i.test(_pn)) nonCat='other';
      if(!prod && !nonCat){ const _oovRx=/\bfifa\b|فيفا|\bpubg\b|ببجي|fortnite|فورتنايت|roblox|\bnetflix\b|نتفليكس|shahid|شاهد|spotify|سبوتيفاي|disney|ديزني|canva|chatgpt|\bvps\b|prime ?video|valorant|gta|قراند/i; if(_oovRx.test(lu)){ const _inCat=(_cm.lines||[]).some(function(ln){ return (ln.aliases||[]).some(function(a){ return a && a.length>=3 && _hay.indexOf(' '+a+' ')>=0; }); }); if(!_inCat) nonCat='other'; } }
      // ===== FIX-A: GAME EXCLUSION GUARD (gated ff_qualify_complete) =====
      // Detect "من غير X / ماشي X / بلا X / ماعدا X / بدون X" around a catalog game alias,
      // OR generic "حاجة أخرى / شي حاجة أخرى / فئة أخرى / لعبة أخرى / نوع آخر / شي آخر".
      // DARIJA CARE: bare "غير" alone (e.g. "بغيت غير فري فاير" = ONLY FF) is NOT exclusion.
      // Only "من غير" (two words) counts; "ماشي/بلا/ماعدا/بدون" each count on their own.
      // This block ONLY runs under ff_qualify_complete (prod already set from _prodMatch above).
      if(_ffQC && prod){
        const _exclPfxRx=/(?:من\s+غير|ماشي|ماعدا|بدون|\bبلا\b)\s*/i;
        const _exclGenRx=/حاجة\s*أخرى|حاجة\s*اخرى|شي\s*حاجة\s*أخرى|شي\s*حاجة\s*اخرى|فئة\s*أخرى|فئة\s*اخرى|لعبة\s*أخرى|لعبة\s*اخرى|نوع\s*آخر|نوع\s*اخر|شي\s*آخر|شي\s*اخر/i;
        let _gamExcl=false;
        if(_exclGenRx.test(lu)){
          // Generic "something else" — if a game is locked from context but NOT named this turn with a
          // positive request, treat it as exclusion of the locked/carried game.
          _gamExcl=true;
        } else {
          // Check each alias of the matched game: is it preceded by an exclusion marker in _hayLu?
          const _matchedLine=(_cm.lines||[]).find(function(ln){ return ln.proper===prod; });
          if(_matchedLine){
            const _mAliases=(_matchedLine.aliases||[]).filter(function(a){ return a && a.length>=3; });
            for(let _ai=0;_ai<_mAliases.length;_ai++){
              const _a=_mAliases[_ai];
              // Build a regex: (exclusion_prefix)\s*(optional article)\s*(alias)
              // "من غير" must be two words; "ماشي/بلا/ماعدا/بدون" one word each.
              const _testRx=new RegExp('(?:من\\s+غير|ماشي|ماعدا|بدون|\\bبلا\\b)\\s*(?:ال)?\\s*'+_a.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
              if(_testRx.test(lu)){ _gamExcl=true; break; }
            }
          }
        }
        if(_gamExcl){
          // Game is being excluded — do NOT lock to it this turn; carry it into rejected list
          _gamExclName=prod; // capture the proper-cased name before clearing
          prod=null;
        }
      }
    }catch(e){}
    // ===== FIX-A: build _rejectedGames — persisted + this-turn exclusion =====
    // _rejectedGames holds proper-cased game names (from catalog ln.proper).
    // It is separate from _rejected (service types) so existing service logic is byte-identical.
    let _rejectedGames=(ctx.rejected_games||[]).slice();
    if(_ffQC){
      try{
        // _gamExclName is set (inside try above) when the exclusion guard fires.
        // Use it to populate _rejectedGames and prevent ctx.product from re-locking.
        if(_gamExclName){
          // Alias-match exclusion: _gamExclName is the proper-cased game (e.g. "Free Fire")
          if(_rejectedGames.map(function(g){return String(g).toLowerCase();}).indexOf(String(_gamExclName).toLowerCase())<0){
            _rejectedGames.push(_gamExclName);
          }
        } else if(!prod && ctx.game){
          // Generic phrase ("حاجة أخرى" etc.) without a specific game alias in the message.
          // The previously-locked game is what they're rejecting.
          const _exclGenRx3=/حاجة\s*أخرى|حاجة\s*اخرى|شي\s*حاجة\s*أخرى|شي\s*حاجة\s*اخرى|فئة\s*أخرى|فئة\s*اخرى|لعبة\s*أخرى|لعبة\s*اخرى|نوع\s*آخر|نوع\s*اخر|شي\s*آخر|شي\s*اخر/i;
          // Only treat as game rejection if there's actually a locked game context; otherwise
          // it's a service-level "show me something else" handled by _rejGeneric above.
          if(_exclGenRx3.test(lu) && _rejectedGames.map(function(g){return String(g).toLowerCase();}).indexOf(String(ctx.game).toLowerCase())<0){
            _rejectedGames.push(ctx.game);
          }
        }
        // Carry-through guard: if ctx.product/ctx.game is now in _rejectedGames, clear it
        // so newProd (= prod || ctx.product) doesn't re-lock to the excluded game.
        if(ctx.game && _rejectedGames.map(function(g){return String(g).toLowerCase();}).indexOf(String(ctx.game).toLowerCase())>=0){
          ctx.product=null; ctx.game=null;
        }
        // Final guard: if prod (positive match this turn) is in rejected list, clear it
        if(prod && _rejectedGames.map(function(g){return String(g).toLowerCase();}).indexOf(String(prod).toLowerCase())>=0){
          prod=null;
        }
      }catch(_rge){}
    }
    const newProd = prod || ctx.product;
    // FIX-A: _gameExclThisTurn — true when a game was explicitly excluded THIS turn (prod cleared by guard).
    // Used below to route to discover and suppress the old lock. Only meaningful under ff_qualify_complete.
    const _gameExclThisTurn = _ffQC && !prod && (_rejectedGames.length > (ctx.rejected_games||[]).length);
    let budg=(p.budget&&p.budget!=='null')?String(p.budget).replace(/[^0-9]/g,''):null;
    if(!budg){ const _mm=lu.match(/\b([0-9]{2,5})\b/); if(_mm) budg=_mm[1]; }
    // S2-A: Hybrid intent entity backstop — catches budgets LLM + regex both miss
    if(!budg && _hiRes && _hiRes.entities && _hiRes.entities.budget && _hiRes.confidence>=0.55){ budg=String(_hiRes.entities.budget); }
    const newBudget = budg || ctx.budget;
    // ===== PHANTOM-BUDGET: budget is "confirmed this session" only if stated THIS TURN (budg!=null) or already confirmed
    // (session_data.budget_confirmed). A carried ctx.budget from an old profile is NOT confirmed until the customer
    // restates it. This prevents silently consuming a stale budget from months ago. =====
    const _budgetStatedNow = (budg != null && budg !== '');
    const _budgetConfirmedThisSession = _budgetStatedNow || ctx.budget_confirmed;
    // ===== ff_clarify_engine V2 — PRODUCT-CONFIRM (mirror of budget_confirmed): a game from RECALL (ctx.product, NO catalog match `prod` this turn) is NOT "confirmed" until the customer names a game OR affirms a Context-Lock question. Blocks offering a stale/wrong recalled game. =====
    const _gameNamedNow = !!prod;
    const _affirmYes = _ffCE && !!ctx.awaiting_confirm && /^\s*(نعم|اه|ايه|أيه|إيه|واخا|اوكي|أوكي|تمام|بغيت|بغيتو|هو|هي|واه|wah|oui|yes|صافي|ممكن|نعم بغيت|هاداك|هو هاداك)\b/i.test(lu) && !/^\s*لا\b|ماشي|بدّل|بدل|حاجة أخرى|لله/i.test(lu);
    const _productConfirmedThisSession = _gameNamedNow || _affirmYes || !!ctx.product_confirmed;
    // SERVICE detection — 3 خدمات Free Fire: recharge (شحن جواهر بـID) / code (كودات سكن/سلاح) / account (حساب)
    // negation guards: "مبغيش نشحن" / "ما بغيتش حساب" must NOT be read as a request for that service
    const _negR=/(لا\s*)?(م\s?ا?\s?ن?\s?با?غي[تي]?ش|بلا|ماشي|ماخصنيش|ما ?خصنيش|ما ?عجبني)\s*(ال)?(نشحن|شحن|شحان|جواهر|دياموند|recharge)/i.test(lu);
    const _negA=/(لا\s*)?(م\s?ا?\s?ن?\s?با?غي[تي]?ش|بلا|ماشي|ماخصنيش|ما ?عجبني)\s*(ال)?(حساب|كونط|account)/i.test(lu);
    const _negC=/(لا\s*)?(م\s?ا?\s?ن?\s?با?غي[تي]?ش|بلا|ماشي|ماخصنيش|ما ?عجبني)\s*(ال)?(كود|كودات|code)/i.test(lu);
    let service=ctx.service||null;
    if(!_negR && /شحن|نشحن|كنشحن|جواهر|دياموند|diamond|recharge|top.?up|شحان|توب ?اب|شدات/i.test(lu)) service='recharge';
    else if(!_negC && /كود|كودات|\bcode\b|سكن|skin|سلاح|weapon|رقص|dance|emote|إيموت|mac ?10/i.test(lu)) service='code';
    else if(!_negA && /حساب|كونط|account|compte|\bkont\b/i.test(lu)) service='account';
    else if(/اشتراك|نتفليكس|سبوتيفاي|netflix|spotify|iptv|شراك/i.test(lu)) service='subscription';
    if(!service && _haikuSvc && _haikuSvc!==_haikuRej) service=_haikuSvc;
    const _codeSub=(service==='code')?(/رقص|dance|emote|إيموت/i.test(lu)?'رقص':/سكن|skin|سياره|سيارة|بدل|ملابس|عباي/i.test(lu)?'سكن':/سلاح|weapon|بندقي|مسدس|\bmac\b|\bak\b|\bm4\b|سكار/i.test(lu)?'سلاح':null):null;
    if(!service && newProd){ try{ const _cmST=await _catalogMeta(); const _gtST=(_cmST.typesByGame||{})[String(newProd).toLowerCase()]||[]; if(_gtST.length===1){ service=_gtST[0]; } }catch(e){} }
    const _intent=(p.intent||'').toLowerCase();
    // ===== BUY-INTENT BACKSTOP (FLOOR, not primary) — LLM intent=buy stays primary; a clear buy-verb raises to buy ONLY when the LLM did not classify a safety/handoff intent (degraded-router safety net so a clear buy is NEVER lost). Negation-guarded. Persists across turns via session_data.buy_intent_active. Never overrides sell/payment/support/reject. =====
    const _buyVerb = /نشري|نشتري|نطلب/i.test(lu) && !/ما\s*(بغيت|نشري|نشتري|نطلب)|مبغيت|ماشي باغي|بلا ما نشري/i.test(lu);
    const _nonBuyHard = (_intent==='sell'||_intent==='payment'||_intent==='support'||_intent==='reject');
    const _buyIntent = (_intent==='buy') || ((_buyVerb || ctx.buy_intent_active) && !_nonBuyHard);
    // ===== ENGAGEMENT FLOOR (deterministic, provider-independent) — interest/availability/price-ask/demonstrative markers keep an engaged customer in the funnel (discovery) even when a degraded LLM mislabels the turn as greeting. Raises ENGAGEMENT (a discovery question), NOT a precise buy; NEVER escalates; guarded by _nonBuyHard so it never overrides safety/handoff. Independent of Anthropic/OpenAI. =====
    const _engage = !_nonBuyHard && (
      /مهتم|عجبني|عجبتني|يعجبني|بغيت نعرف|واخا نشوف|نشوف شنو/i.test(lu) ||
      /متوفر|توفر|دسبونيبل|باقي كاين|واش كاين|عندكم|عندك شي|واش عندك|واش باقي/i.test(lu) ||
      /شحال|بشحال|الثمن|ثمن|كلفة/i.test(lu) ||
      /هاداك|هاديك|داكشي|هادوك/i.test(lu)
    );
    // ===== DISCOVERY / REJECTION / RECOMMENDATION (catalog-driven, anti-repetition) =====
    const _rejExcl = _haikuRej || ((_negR||/من غير شحن|بلا شحن|ماشي شحن|من غير الشحن|بلا الشحن/i.test(lu))?'recharge':(_negA||/من غير حساب|بلا حساب|ماشي حساب/i.test(lu))?'account':(_negC||/من غير كود|بلا كود|ماشي كود/i.test(lu))?'code':null);
    const _rejGeneric = /سلعة خرا|سلعة أخرى|سلعة اخرى|شي حاجة أخرى|شي حاجة اخرى|حاجة اخرى|حاجة أخرى|شي خرى|عرض آخر|عرض اخر|بدلها|بدّلها|بدل ليا|م\s?ا?\s?ن?\s?با?غي[تي]?ش\s*هاد|ماباغيش هاد|ماشي هادي|ماشي هاد|وريني أخرى|وريني اخرى|شي نوع اخر|نوع اخر/i.test(lu);
    if(_rejExcl && service===_rejExcl) service=null;
    if(_rejGeneric && service && service===ctx.service) service=null;
    const _isReject = !!_rejExcl || _rejGeneric || _intent==='reject' || _gameExclThisTurn;
    let _rejected=(ctx.rejected||[]).slice();
    const _rejThis = _rejExcl || ((_rejGeneric||_intent==='reject') ? (/كود|كودات|سكن|سلاح/i.test(lu)?'code':/حساب|كونط/i.test(lu)?'account':/شحن|جواهر|دياموند/i.test(lu)?'recharge':(ctx.service||null)) : null);
    if(_rejThis && _rejected.indexOf(_rejThis)<0) _rejected.push(_rejThis);
    // [ADR-0020 Gate G2] rejection confirmed by CODE
    if(sub && _rejThis){ _persistEvidence(String(sub),[{type:'rejection',value:_rejThis,source:'code',confidence:0.90}],turn_id).catch(()=>{}); }
    // ff_answer_last: broadened catalog-ask regex catches plural عندكم + discovery verbs قولي/وريني/بين/عرض
    const _isDiscoverBase = /شنو عندك|شنو كاين|عندك سلعة|عندك سلع|عندك شي|عندك شي حاجة|قول ليا عندك|عطيني عندك|شنو كاتبيع|واش عندك|اشنو كاين|شنو المتوفر|عندك منتج|شي حاجة ديال لعبة|حاجة ديال لعبة|بغيت لعبة|شي لعبة/i.test(lu);
    // ff_seller_fix Fix1 + ff_answer_last: catalog-ask routes to discover (قولي اش عندكم / وريني / شنو عندكم / etc)
    const _isCatalogAsk = (_ffAL || _ffSF) && /عندكم|عندكم شنو|شنو عندكم|قولي اش|قولي ماعندكم|وريني|بين ليا|عرض ليا|شنو كاين|اش كاين|شنو تبيعو|عندكم شنو|شنو المتوفر|شنو الكاتالوج|عندكم لعبة|لعبة عندكم/i.test(lu);
    const _isDiscover = _isDiscoverBase || _isCatalogAsk;
    // FIX-A (ff_qualify_complete): ambiguous discovery / "want something else" — no category named THIS turn.
    // Phrases like "اش عندكم","ممكن تساعدني","شنو كاين","وريني العروض","بغيت حاجة أخرى" must route to _v2Discover
    // and MUST NOT resume a stale ctx.service/ctx.budget qualify (stale slots must not hijack).
    const _isAmbigDiscover = _ffQC && /اش عندكم|ممكن تساعدني|شنو كاين|شنو عندكم|وريني العروض|بغيت حاجة أخرى|بغيت حاجة آخر|حاجة اخرى|حاجة أخرى|شي حاجة أخرى|آخر\/اخر|بغيت شي آخر|بغيت شي اخر/i.test(lu);
    // When _isAmbigDiscover fires: clear any service that came ONLY from stale ctx (not named this turn)
    // so the stale service cannot trigger ask_budget or ask_service on a fresh discovery question.
    if(_isAmbigDiscover){
      const _svcNamedThisTurn = (!_negR && /شحن|نشحن|كنشحن|جواهر|دياموند|diamond|recharge|top.?up|شحان|توب ?اب|شدات/i.test(lu)) ||
                                (!_negC && /كود|كودات|\bcode\b|سكن|skin|سلاح|weapon|رقص|dance|emote|إيموت|mac ?10/i.test(lu)) ||
                                (!_negA && /حساب|كونط|account|compte|\bkont\b/i.test(lu));
      if(!_svcNamedThisTurn) service=null;
    }
    const _isRecommend = /قترح|اقترح|تنصح|نصحني|عقلك|شنو الأحسن|شنو تنصحني|أحسن حاجة|نصيحة|واش تنصحني/i.test(lu);
    // ff_seller_fix Fix2: objection detector — customer says "is that all you have?" after discovery/offer
    const _isObjection = _ffSF && /عندكم غا|غا هاد|والو ?آخر|ماكثرش|ما ?كثر|ماعندكمش غير|غير هاد|بس هاد|فقط هاد|شي ?حاجة ?(خرى|أخرى)|ما ?كاين ?غير/i.test(lu) && (ctx.state==='discovery'||ctx.state==='sales'||ctx.had_offer);
    // FIX-B: detect 'explain more' request on last shown offer
    const _isClarifyOffer = /وضح|اشرح|شرح|ما فهمت|ما فهمتش|فهمتش|فهمتيش|ماعرفتش|ماعرفت|كيفاش|آش هو|آش هي|علاش|explain|plus de d/i.test(lu) && (ctx.state==='sales'||ctx.state==='browsing'||ctx.had_offer);
    // FIX-A: when a game was excluded this turn, also clear the stale service so the lock fully releases
    if(_gameExclThisTurn) service=null;
    let next;
    if(_isClarifyOffer) next='clarify_offer';
    else if(/تبديل|تبادل|نبيع|كنبيع|بيع حساب|بيع كونط|نسيفط ليكم حساب|nbi3|lbi3|brit nbi3|baghi nbi3|bghit nbi3|b9a l bi3|ana nbi3/i.test(lu)) next='to_human';
    else if(/مشكل|مشكلة|استرجاع|تبلوكا|بلوكا|ماخدامش|متهكر|تسرق|شكاية/i.test(lu)) next='to_human';
    else if(nonCat) next='oov_human';
    else if((ctx.state==='sales'||ctx.state==='browsing'||ctx.had_offer) && /غالي|ghali|نشوف|نفكر|مزال|بعدا|ماعجبني|ماعجبنيش|خليها|من بعد|غير كنقلب|نتسنا/i.test(lu) && !(_ffCE && (/أرا|ارا|وريني|ورّيني|وري ?ليا|نشوفو|نشوفهم|بينهم/i.test(lu) || /نشوف.{0,8}(حساب|كونط|كود|شحن|عرض|عروض|متوفر|اللي عندك|لي عندك|شنو)/i.test(lu) || /(بغيت|بغينا)\s+نشوف/i.test(lu)))) next='send_channel';
    // FIX-A: explicit game exclusion this turn → route to discovery (OTHER games), BEFORE objection handling
    // (an explicit "I want a different game / something else" must not be swallowed by generic objection routing)
    else if(_ffQC && _gameExclThisTurn) next='discover';
    else if(_isObjection) next='discover_objection';
    else if(_isAmbigDiscover && !service) next='discover';
    else if(ctx.had_offer && (_isReject||_isDiscover) && !service) next='discover_offer';
    else if(_isReject && !service) next='discover';
    else if(_isDiscover && !service) next='discover';
    else if(_isRecommend) next='recommend';
    else if((ctx.channel_visited||ctx.state==='browsing') && /عجبني|بغيت ه[اذ]ا|عجبني واحد|بغيت هاد|هادا اللي|بغيتو/i.test(lu) && !budg && !newProd) next='ask_which';
    else if(ctx.state==='browsing' && (budg || /بغيت هاد|عجبني|هاد الحساب|هاد الثمن|هادا/i.test(lu))) next='to_seller';
    else if(!newProd) next=_buyIntent?'ask_product':(((_intent==='greeting')&&!/حساب|شري|نشري|بغيت|شحن|كود/i.test(lu))?'greet':'ask_product');
    else if(!service) next='ask_service';
    else if(service==='recharge') next=(/\b[0-9]{7,}\b/.test(lu))?'recharge_human':(_ffSSmain&&!newBudget)?'ask_recharge_amount':'to_seller';
    else if(service==='code' && !_codeSub) next='ask_codesub';
    else if(_ffPA && service==='account' && !newBudget && /قولي\s*شحال|بشحال|\bشحال\b|\bبكم\b|كم\s*الثمن|\bالثمن\b|\bالسعر\b|\bتمنو\b|\bتمن\b|\bكيسوا\b|\bكيساوي\b|شحال\s*كيسوا/i.test(lu) && newProd) next='price_answer';
    else if(service==='account' && !newBudget) next='ask_budget';
    else next='to_seller';
    // ENGAGEMENT FLOOR: an engaged-but-no-product-named turn lands in discovery (ask what they want) instead of greeting-looping. Only upgrades the 'greet' outcome; never escalates, never overrides safety/handoff (already guarded in _engage).
    if(next==='greet' && _engage) next='ask_product';
    // ===== ff_clarify_engine: AMBIGUITY ARBITER (CODE, deterministic, no LLM). A turn that carries engagement but is under-specified gets a clarifying question instead of a generic ask/greet. Only RECLAIMS weak fall-through outcomes (ask_product/greet) — never overrides specific handlers (to_seller/discover/ask_which/price_answer) or safety handoffs (to_human/oov/payment ran earlier). _ambig is reused by the anti-loop guards below. OFF → all `_ffCE &&` guards are false → nothing changes (byte-identical). =====
    const _showMe = _ffCE && (/(?:^|\s)(أرا|ارا|وريني|ورّيني|وري ?ليا)\b/i.test(lu) || /نشوفو|نشوفهم|بينهم/i.test(lu));
    const _deictic = _ffCE && /هادا|هاداك|هاديك|هادوك|الأول|الثاني|لي وريتيني|لي وريتي|هاداك لي/i.test(lu);
    const _shortConfirm = _ffCE && /^\s*([اأإ]ه|[اأإ]ها|[اأإ]يه|نعم|واخا|اوا|أوكي|اوكي|أوك|تمام|زوين|مزيان|صافي|بغيتو|بغيتها|مهم بها|نخدمو|واش كاين|واش باقي|عندك|بشحال|بكم|نقدر|يالاه|يلا)\s*[؟?]*\s*$/i.test(lu);
    const _affirmBuy = _ffCE && /^\s*([اأإ]يه|[اأإ]ه|نعم|واخا|واخّا|اوا|أوكي|اوكي|تمام|صافي|بغيتو|بغيتها|مزيان|يالاه|يلا|نكمل|كمل|نكمّل)\s*[؟?]*\s*$/i.test(lu); // bare affirmation (NOT a question) — used to advance after an offer
    const _ambigSignal = _ffCE && !_nonBuyHard && (_showMe || _deictic || _shortConfirm);          // raw ambiguity — used by the anti-loop guards so an ambiguous turn NEVER escalates to human
    const _ambig = _ambigSignal && !service && !newProd && !newBudget;                              // under-specified THIS turn — used by the arbiter routing
    if(_ambig && (next==='ask_product' || next==='greet')){
      if(_showMe && (ctx.game||ctx.product)) next='to_seller';                                      // "وريني" + لعبة معروفة → ورّيها
      else if(Array.isArray(ctx.shown) && ctx.shown.length) next='clarify_context';                 // إشارة لآخر منتج مَعروض
      else if(ctx.had_offer && (ctx.game||ctx.product)) next='clarify_context';                      // كان عرض → عاود ربطو
      else next='clarify_intent';                                                                    // مجهول تماماً → سؤال نية عام
    }
    // ambiguous confirmation/deictic that would RE-SHOW the same offer (slots already in ctx) → ONE context question instead → never loops into an identical-reply→human escalation.
    else if(_ambigSignal && !_showMe && next==='to_seller' && ctx.had_offer && Array.isArray(ctx.shown) && ctx.shown.length) next='clarify_context';
    // ===== ff_clarify_engine V2 SLOT-COMPLETION / Context-Lock: NEVER head to an OFFER (to_seller) or budget-ask with a game that is ONLY from a stale recall (prod null) and not confirmed this session → confirm the game FIRST with ONE question. After _affirmYes (or naming a game), _productConfirmedThisSession is true so this skips → the normal slot flow proceeds (→ ask_budget → offer the CORRECT game). =====
    let _awaitGame;
    if(_ffCE && !_gameNamedNow && ctx.product && !_productConfirmedThisSession && (next==='to_seller' || next==='ask_budget')){
      next='clarify_context'; _awaitGame=ctx.game||ctx.product;
    }
    // ===== ff_clarify_engine V2: AFFIRMATION after an offer ("واش نكمّل؟" → "إيه/نعم/واخا") = purchase confirmation → advance toward payment, do NOT re-ask budget / re-show / escalate. (Questions like "واش كاين/بكم" are NOT _affirmBuy → handled by clarify, not this.) The payment layer at the top of the handler still catches an explicit "بغيت نخلّص" first. =====
    if(_ffCE && _affirmBuy && ctx.had_offer && (ctx.game||ctx.product) && (next==='ask_budget' || next==='to_seller' || next==='clarify_context')) next='confirm_buy';
    // ===== ff_clarify: INTENT CLARIFICATION — fires ONLY when no clear signal was detected (no service/product/budget/buy-intent, not a greeting, and no earlier branch already handled the turn). Clear requests NEVER reach this block because they set next='to_seller'/'ask_budget'/'ask_codesub' etc. above. OFF=byte-identical. =====
    // RCA-fix: _bg is block-scoped to the greeting section (out of scope here → was a ReferenceError 500).
    // Use an in-scope greeting-word check on lu instead (exclude real greetings from the clarify gate).
    var _clGreet=/^\s*(سلام|سلامو|السلام|اهلا|أهلا|اهلين|مرحبا|مرحبتين|صباح|مسا|مساء|سلامات|labas|labass|salam|salut|bonjour|cava|hi|hello|hey|slm|slam|cc|كيداير|كي داير|كيف داير|اش خبارك|أش خبارك)/i.test(lu);
    if(_ffClarify && (next==='ask_product'||next==='greet') && !service && !newProd && !newBudget && !_buyIntent && !_clGreet && !_engage){ next='clarify_intent'; }
    let _clarVal=(ctx.clarify_count||0);
    { const _asksC=['ask_product','ask_service','ask_codesub','ask_budget','clarify_intent'].concat(_ffCE?['clarify_context']:[]); const _advC=(newProd&&newProd!==ctx.product)||(service&&service!==ctx.service)||(!!_codeSub)||(newBudget&&newBudget!==ctx.budget)|| _buyIntent || (_ffAL?false:_engage) || (_ffQC && next==='to_seller'); if(_asksC.indexOf(next)>=0){ _clarVal=_advC?1:((ctx.clarify_count||0)+1); if(_clarVal>=3) next='clarify_human'; } else { _clarVal=0; } }
    // ===== ff_qualify_complete: COMPLETENESS GATE — blocks ALL reveal paths until required slots filled.
    // Required slots per category come from LIVE catalog metadata (NO hardcoded names).
    // Priority: category → game → sub-type → budget. Slot-ask advances clarify_count normally (fills→resets).
    // PHANTOM-BUDGET: for 'account' category, budget is required but only counts as filled if confirmed this session.
    // Slot-ask turns reset clarify_count like any other advancement (slot-ask = progress, not stall). =====
    let _qcMissing=null; // the next required ask_* state, or null if complete
    if(_ffQC && (next==='to_seller' || next==='ask_budget')){ // only re-check when heading toward reveal or budget ask
      try{
        const _qcCm=await _catalogMeta();
        // Derive which game slot is required: only if the category spans >1 game in the catalog
        const _qcSvc=service||(newProd ? ((_qcCm.typesByGame||{})[String(newProd).toLowerCase()]||[])[0]||null : null);
        if(!newProd && (_buyIntent || service || _engage)){
          _qcMissing='ask_product'; // category not resolved yet
        } else if(newProd && !_qcSvc){
          // product known but service (category/type) unknown
          const _qcTypes=(_qcCm.typesByGame||{})[String(newProd).toLowerCase()]||[];
          if(_qcTypes.length!==1) _qcMissing='ask_service'; // >1 type or unknown
        } else if(_qcSvc){
          // Check if game slot is required: does this product_type span >1 game?
          const _qcGamesForType=Object.keys(_qcCm.typesByGame||{}).filter(function(g){ return ((_qcCm.typesByGame||{})[g]||[]).indexOf(_qcSvc)>=0; });
          const _gameRequired = _qcGamesForType.length > 1;
          if(_gameRequired && !newProd){
            _qcMissing='ask_product'; // need a game
          } else if(_qcSvc==='code'){
            // Sub-type required only if >1 code_type in catalog
            let _qcCodeTypes=[]; try{ const _qccr=await pool.query("SELECT DISTINCT regexp_replace(code_type,'\\s*\\(.*\\)','') ct FROM aykoshop_products WHERE status='available' AND product_type='code' AND code_type IS NOT NULL AND code_type<>''"); _qcCodeTypes=_qccr.rows.map(function(x){return String(x.ct).trim();}).filter(Boolean); }catch(e){}
            if(_qcCodeTypes.length>1 && !_codeSub) _qcMissing='ask_codesub';
            // budget for code: only re-ask if phantom (ctx.budget carried from old profile, unconfirmed)
            else if(ctx.budget && !_budgetConfirmedThisSession) _qcMissing='ask_budget';
          } else if(_qcSvc==='account'){
            // Budget always required; phantom-budget: must be confirmed this session
            if(!_budgetConfirmedThisSession) _qcMissing='ask_budget';
          } else if(_qcSvc==='recharge'){
            // recharge: budget = recharge amount. If ff_smart_seller is ON, ask_recharge_amount handles it.
            // If ff_smart_seller is OFF, route to ask_recharge_amount when no budget.
            if(!_budgetConfirmedThisSession && !_ffSSmain) _qcMissing='ask_recharge_amount';
          } else {
            // Unknown/new product_type (e.g. 'subscription'): budget always required for priced items
            if(!_budgetConfirmedThisSession && ctx.budget) _qcMissing='ask_budget';
          }
        }
        if(_qcMissing && _qcMissing!==next){
          // Routing to a missing slot is ALWAYS advancement (slot-fill progress, never stall)
          next=_qcMissing; p.next=_qcMissing; _clarVal=1;
        } else {
          _qcMissing=null; // already on the right track or complete
        }
      }catch(_qce){ _qcMissing=null; } // on error: let existing routing stand
    }
    p.next=next;
    // ===== TOKEN-LOCK: each hesitation (send_channel) burns an attempt; 3rd strike => human lock (freeze all AI). Engagement (to_seller/to_payment) resets. =====
    let _newAttempts=(ctx.attempts||0);
    if(next==='send_channel'){ _newAttempts=_newAttempts+1; if(_newAttempts>=3){ next='human_lock'; p.next='human_lock'; } }
    else if(next==='to_seller'||next==='to_payment'){ _newAttempts=0; }
    let stage, agent, model, reply, escalate=false, _lockNow=false, _setHadOfferNow=false, _offerImg='NO_IMAGE', _shownNow=null;
    if(p.next==='clarify_offer'){
      // FIX-B: re-explain the same products in simpler words — never repeat verbatim
      let _replyClr=''; let _clrVia='rule'; const _srv2=service||ctx.service;
      if(_srv2){
        try{
          const _clrR=await pool.query('SELECT product_name, price, code_type, key_features FROM aykoshop_products WHERE status=$1 AND product_type=$2 ORDER BY price_value ASC LIMIT 3',['available',_srv2]);
          if(_clrR.rows.length){
            const _clrList=_clrR.rows.map(function(rr){
              const _feat=rr.key_features?' — '+String(rr.key_features).slice(0,60):'';
              const _ct=rr.code_type?' ('+rr.code_type+')':'';
              return '• '+rr.product_name+_ct+' — '+rr.price+_feat;
            }).join('\n');
            const _clrSys='نتا بائع AykoShop. الزبون طلب توضيح للمنتجات. اشرح ليه هادو بجمل بسيطة بالدارجة: شنو هي، كيفاش تتسلم، علاش مزيانة. ماتكررش نفس الكلام اللي قيل من قبل.\nالمنتجات:\n'+_clrList;
            let _rClr=await _callClaude([{role:'system',content:_clrSys},{role:'user',content:'وضح ليا أكتر'}],{model:'claude-sonnet-4-6',max_tokens:220,temperature:0.7,timeout:8000});
            if(_rClr.ok){ _replyClr=_rClr.text; _clrVia='sonnet'; }
            else { _replyClr='خويا هادو بكلام بسيط:\n'+_clrList+'\n\nكل واحد منهم كيتسلم مباشرة بعد الخلاص. واش عجبك شي واحد؟'; _clrVia='floor'; }
          }
        }catch(_e){}
      }
      if(!_replyClr){ _replyClr='خويا قول ليا أكتر شنو ما فهمتيه باش نوضح ليك 🙏'; _clrVia='rule'; }
      stage='sales'; agent='Seller (clarify)'; model=_clrVia; reply=_replyClr;
    } else     if(p.next==='to_seller'){ const s=await _v2Seller(lu,newBudget,service,_kbCtx,newProd,null,ctx.shown); if(s && s.escalate){ if(!ctx.channel_visited && (s.escalate==='NO_CATALOG_MATCH'||s.escalate==='CODE_SUBTYPE_UNAVAILABLE')){ stage='browsing'; agent='Seller→القناة'; model='-'; reply=_V2_CHANNEL; if(sub && /^[0-9]+$/.test(String(sub))){ pool.query("UPDATE aykoshop_profiles SET session_data=COALESCE(session_data,'{}')::jsonb || jsonb_build_object('channel_visited',true) WHERE subscriber_id=$1",[String(sub)]).catch(()=>{}); } } else { stage='human'; agent='Seller→Human'; model='-'; reply=s.reply; escalate=s.escalate; } } else { stage='sales'; agent=(service==='recharge'?'Seller (شحن)':'Seller'); model=s.via; reply=s.reply; _setHadOfferNow=true; if(s.image_url) _offerImg=s.image_url; if(s.shown_ids) _shownNow=s.shown_ids; if(s.buyer_requirements&&s.buyer_requirements.length&&sub&&/^[0-9]+$/.test(String(sub))&&(await _slotsMode())!=='off'){ pool.query("UPDATE aykoshop_profiles SET session_data = COALESCE(session_data,'{}')::jsonb || jsonb_build_object('pending_slots',$2::jsonb) WHERE subscriber_id=$1",[String(sub),JSON.stringify({reqs:s.buyer_requirements,collected:{},service_type:(service||null),product_name:(s.product_name||null),asks:0})]).catch(function(){}); } } }
    else if(p.next==='to_payment'){ stage='payment'; agent='Payment (Rule+Human)'; model='rule'; reply='وصلنا أنك خلّصتي 🙏 الفريق غادي يتحقق ويأكد ليك. ماتعاودش الدفع.'; escalate='PAYMENT_INTENT'; }
    else if(p.next==='ask_which'){ stage='browsing'; agent='Channel-Return'; model='rule'; reply='زوين خويا 🔥 أشمن واحد بالضبط عجبك من القناة؟ صيفط ليا الصورة ديالو ولا گول ليا الاسم/الثمن باش نكمل معاك عليه مباشرة 🙏'; }
    else if(p.next==='oov_human'){ stage='human'; agent='OutOfCatalog→Human'; model='-'; reply='سمح ليا خويا 🙏 هاد المنتج مازال ماعندناش فيه دابا. غادي نخليك مع واحد من الفريق باش يشوف واش نقدرو نوفّروه ليك، وغادي نرجعو ليك بسرعة.'; escalate='OUT_OF_CATALOG'; }
    else if(p.next==='to_human'){ stage='human'; agent='Human'; model='-'; if(sub && /^[0-9]+$/.test(String(sub))){ var _nbt=/تبديل|تبادل/i.test(lu)?'swap':(/نبيع|بيع حساب|بيع كونط|نسيفط ليكم حساب/i.test(lu)?'sell_account':(/مشكل|شكاية|استرجاع|بلوكا|متهكر|تسرق/i.test(lu)?'complaint':'other')); pool.query("INSERT INTO aykoshop_profiles (subscriber_id,session_data,last_seen) VALUES ($1, jsonb_build_object('last_non_buy_intent', jsonb_build_object('type',$2::text,'ts',$3::text)), NOW()) ON CONFLICT (subscriber_id) DO UPDATE SET session_data = COALESCE(aykoshop_profiles.session_data,'{}')::jsonb || jsonb_build_object('last_non_buy_intent', jsonb_build_object('type',$2::text,'ts',$3::text))",[String(sub),_nbt,String(Date.now())]).catch(()=>{});
      // [ADR-0020 Gate G4] sell_intent / problem_reported — _nbt already computed, META only
      const _g4t=(_nbt==='sell_account'||_nbt==='swap')?'sell_intent':((_nbt==='complaint')?'problem_reported':null); if(_g4t) _persistEvidence(String(sub),[{type:_g4t,value:_nbt,source:'haiku',confidence:0.85}],turn_id).catch(()=>{});
      } reply=(p.reply&&p.reply.length>3)?p.reply:'سمح ليا خويا 🙏 نخليك مع الفريق باش يعاونك مزيان، غادي نرجعو ليك بسرعة.'; escalate='HUMAN_REQUESTED'; }
    else if(p.next==='send_channel'){
      if(!ctx.channel_visited){
        stage='browsing'; agent='Router→القناة'; model=rt.via; reply=_V2_CHANNEL;
        if(sub && /^[0-9]+$/.test(String(sub))){
          pool.query("UPDATE aykoshop_profiles SET session_data=COALESCE(session_data,'{}')::jsonb || jsonb_build_object('channel_visited',true) WHERE subscriber_id=$1",[String(sub)]).catch(()=>{});
          // [ADR-0020 Gate G3] channel_visited
          _persistEvidence(String(sub),[{type:'channel_visited',value:'true',source:'code',confidence:0.90}],turn_id).catch(()=>{});
        }
      } else {
        stage='human'; agent='Channel→Human'; model='-';
        reply='خويا شكراً على صبرك 🙏 غادي نخليك مع واحد من الفريق باش يعاونك بشكل شخصي، غادي يتواصل معاك قريب 👤';
        escalate='HUMAN_AFTER_CHANNEL';
      }
    }    else if(p.next==='human_lock'){ stage='human'; agent='Human (Token-Lock)'; model='-'; reply='خويا شكراً بزاف على اهتمامك 🙏 باش نعاونك بشكل أحسن غادي نوصلك مع واحد من الفريق ديالنا، غادي يتواصل معاك قريب إن شاء الله 👤'; _lockNow=true; }
    else if(p.next==='recharge_human'){ stage='human'; agent='Recharge→Human'; model='-'; reply='صافي خويا 🙏 توصلنا المعلومات ديالك، الفريق غادي يكمّل ليك الشحن دابا ويتواصل معاك بسرعة 🔥'; escalate='HUMAN_RECHARGE'; if(sub&&/^[0-9]+$/.test(String(sub))) pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,'human_recharge') ON CONFLICT(subscriber_id) DO UPDATE SET reason='human_recharge', stopped_at=NOW()",[String(sub)]).catch(()=>{}); }
    else if(p.next==='discover_objection'){
      // ff_seller_fix Fix2: Objection path — customer says "is that all?" after discovery/offer.
      // Give DEEPER detail: per-game category breakdown WITH price ranges, NOT the same discover menu.
      try{
        const _objRows=await pool.query(
          "SELECT COALESCE(NULLIF(trim(game),''),'__none__') AS game, product_type, "+
          "MIN(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mn, "+
          "MAX(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mx, "+
          "COUNT(*) cnt "+
          "FROM aykoshop_products WHERE status='available' AND product_type IS NOT NULL AND trim(product_type)<>'' "+
          "GROUP BY 1,2 ORDER BY game, product_type"
        );
        const _objTL={recharge:'💎 شحن',account:'👤 حسابات',code:'🔑 كودات',subscription:'📺 اشتراكات'};
        if(_objRows.rows.length){
          const _objByGame={}; const _objOrder=[];
          _objRows.rows.forEach(function(r){
            const g=(r.game==='__none__')?'':r.game;
            if(!_objByGame[g]){ _objByGame[g]=[]; if(_objOrder.indexOf(g)<0) _objOrder.push(g); }
            _objByGame[g].push(r);
          });
          const _objParts=_objOrder.filter(function(g){return g!=='';}).map(function(g){
            const _gtypes=_objByGame[g]||[];
            const _tstr=_gtypes.map(function(r){
              const _lbl=_objTL[r.product_type]||r.product_type;
              const _mn=Math.round(r.mn||0); const _mx=Math.round(r.mx||0);
              return _lbl+(_mn&&_mx&&_mn!==_mx?' ('+_mn+'–'+_mx+' درهم)':(_mn?' ('+_mn+' درهم)':''));
            }).join(' · ');
            return g+': '+_tstr;
          });
          if(_objByGame[''] && _objByGame[''].length){
            const _noG=_objByGame[''].map(function(r){
              const _lbl=_objTL[r.product_type]||r.product_type;
              const _mn=Math.round(r.mn||0); const _mx=Math.round(r.mx||0);
              return _lbl+(_mn&&_mx&&_mn!==_mx?' ('+_mn+'–'+_mx+' درهم)':(_mn?' ('+_mn+' درهم)':''));
            }).join(' · ');
            _objParts.push(_noG);
          }
          reply='واه خويا 🔥 عندنا أكتر من هادشي. هادو كاملين اللي عندنا دابا:\n'+_objParts.join('\n')+'\n\nكل نوع فيهم عنده خيارات زوينة. أشمن واحد يناسبك باش نوريك التفاصيل؟';
        } else {
          reply='سمح ليا خويا 🙏 حالياً ماعندناش حاجة أخرى متاحة. واش نخليك مع الفريق باش يشوف ليك؟';
        }
        stage='discovery'; agent='Router (objection)'; model='rule';
      }catch(_oe){
        // fallback: use discover menu
        const _od=await _v2Discover(_rejected, false, _ffSF, _rejectedGames);
        reply=_od.reply; stage='discovery'; agent='Router (objection-fallback)'; model='rule';
      }
    }
    else if(p.next==='discover_offer'){
      // Customer said "عندك سلعة أخرى / بدل ليا / وريني بديل" after seeing an offer.
      // ===== ff_qualify_complete: completeness gate for the discover_offer reveal path.
      // The customer is already in sales/browsing (had_offer=true), so category+game+subtype are confirmed.
      // Only budget needs re-checking here (phantom-budget guard). If not confirmed, ask_budget first. =====
      if(_ffQC && (ctx.service==='account'||ctx.service==='code') && !_budgetConfirmedThisSession){
        // Budget not confirmed this session — re-ask with pre-fill hint from ctx.budget
        const _doqBt=ctx.service; let _doqMn=0,_doqMx=0;
        try{
          if(newProd||ctx.product){ const _doqRg=await pool.query("SELECT MIN(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mn, MAX(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mx FROM aykoshop_products WHERE status='available' AND product_type=$1 AND lower(game)=$2",[_doqBt,String(newProd||ctx.product||'').toLowerCase()]); _doqMn=Math.round((_doqRg.rows[0]||{}).mn||0); _doqMx=Math.round((_doqRg.rows[0]||{}).mx||0); }
          if(!_doqMn){ const _doqRa=await pool.query("SELECT MIN(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mn, MAX(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mx FROM aykoshop_products WHERE status='available' AND product_type=$1",[_doqBt]); _doqMn=Math.round((_doqRa.rows[0]||{}).mn||0); _doqMx=Math.round((_doqRa.rows[0]||{}).mx||0); }
        }catch(_doqE){}
        const _doqLbl={'account':'حساب','code':'كود'}[_doqBt]||_doqBt;
        // FIX-C: plain budget ask — never reference stale ctx.budget. Same fix as ask_budget handler.
        const _doqReply=(_doqMn&&_doqMx&&_doqMx>_doqMn)?('عندنا '+_doqLbl+' من '+_doqMn+' إلى '+_doqMx+' درهم 🔥 شحال الميزانية ديالك باش نقترح ليك الأنسب؟'):('شحال الميزانية ديالك خويا؟');
        stage='discovery'; agent='Router (ask_budget)'; model='rule'; reply=_doqReply; p.next='ask_budget'; _clarVal=1;
      } else {
      // ===== ff_smart_seller INTENT-LOCK: when flag ON and ctx.service is set, STAY in the locked
      // category — call _v2Seller with ctx.service so SBW/sbw_only_shown/sbw_none fire correctly.
      // When flag OFF or ctx.service is null → EXISTING cross-category _doSvc logic runs byte-identical.
      var _ffSSdo=false; try{ _ffSSdo=await _ff('smart_seller'); }catch(e){}
      if(_ffSSdo && ctx.service){
        // Intent-locked path: re-call _v2Seller inside the locked category, carry budget + game
        try{
          const _dos=await _v2Seller(lu,(newBudget||ctx.budget||null),ctx.service,_kbCtx,(newProd||ctx.product||null),null,ctx.shown,ctx.trust_seeking||false);
          if(_dos && !_dos.escalate){
            stage='sales'; agent='Seller (intent-locked)'; model=_dos.via; reply=_dos.reply; _setHadOfferNow=true;
            if(_dos.image_url) _offerImg=_dos.image_url; if(_dos.shown_ids) _shownNow=_dos.shown_ids;
          } else if(_dos && (_dos.escalate==='NO_CATALOG_MATCH'||_dos.escalate==='CODE_SUBTYPE_UNAVAILABLE') && !ctx.channel_visited){
            stage='browsing'; agent='Seller (intent-locked)→القناة'; model='-'; reply=_V2_CHANNEL;
            if(sub && /^[0-9]+$/.test(String(sub))){ pool.query("UPDATE aykoshop_profiles SET session_data=COALESCE(session_data,'{}')::jsonb || jsonb_build_object('channel_visited',true) WHERE subscriber_id=$1",[String(sub)]).catch(()=>{}); }
          } else {
            // sbw_none / sbw_only_shown / other — use the _v2Seller reply directly (already category-safe)
            stage='sales'; agent='Seller (intent-locked)'; model=(_dos&&_dos.via)||'sbw'; reply=(_dos&&_dos.reply)||''; _setHadOfferNow=true;
          }
        }catch(_de){
          // on error stay in category with a safe floor
          const _dosSvcLabel={'account':'حساب','code':'كود','recharge':'شحن'}[ctx.service]||ctx.service;
          reply='سمح ليا خويا 🙏 وقع مشكل بسيط، نحاول نوريك بدائل '+_dosSvcLabel+' دابا. ولا قول ليا واش بغيت خدمة أخرى.';
          stage='discovery'; agent='Seller (intent-locked-err)'; model='rule';
        }
      } else {
        // Flag OFF or no locked category: EXISTING cross-category logic — byte-identical to original
        const _doRej=[..._rejected]; if(ctx.service && _doRej.indexOf(ctx.service)<0) _doRej.push(ctx.service);
        const _doSvc=['account','code','recharge'].filter(function(t){ return _doRej.indexOf(t)<0; })[0]||null;
        if(_doSvc){
          try{
            const _dos=await _v2Seller(lu,newBudget,_doSvc,_kbCtx,newProd,null,ctx.shown,ctx.trust_seeking||false);
            if(_dos && !_dos.escalate){ stage='sales'; agent='Seller (alternatives)'; model=_dos.via; reply=_dos.reply; _setHadOfferNow=true; if(_dos.image_url) _offerImg=_dos.image_url; if(_dos.shown_ids) _shownNow=_dos.shown_ids; }
            else { const _dd=await _v2Discover(_doRej, false, _ffSF, _rejectedGames); stage='discovery'; agent='Router (discovery)'; model='rule'; reply=_dd.reply; }
          }catch(_de){ const _dd=await _v2Discover(_doRej, false, _ffSF, _rejectedGames); stage='discovery'; agent='Router (discovery)'; model='rule'; reply=_dd.reply; }
        } else { const _dd=await _v2Discover(_doRej, false, _ffSF, _rejectedGames); stage='discovery'; agent='Router (discovery)'; model='rule'; reply=_dd.reply; }
      }
      } // end ff_qualify_complete else block for discover_offer
    }
    else if(p.next==='discover'||p.next==='recommend'){ const _d=await _v2Discover(_rejected, p.next==='recommend', _ffSF, _rejectedGames); stage='discovery'; agent='Router (discovery)'; model='rule'; reply=_d.reply; }
    else if(p.next==='clarify_human'){ stage='human'; agent='Clarify\u2192Human'; model='-'; reply='سمح ليا خويا 🙏 باش نفهمك مزيان ونعاونك بسرعة، غادي نخليك مع واحد من الفريق، غادي يتواصل معاك قريب 👤'; escalate='HUMAN_CLARIFY'; }
    else if(p.next==='ask_service'){ let _svcMenu=''; try{ const _cmS=await _catalogMeta(); const _ord=['recharge','code','account','subscription','service']; const _TLs={recharge:'💎 شحن جواهر (بـID)',code:'🎟️ كودات (سكن/سلاح/رقصات)',account:'👤 حساب',subscription:'📺 اشتراك',service:'🛠️ خدمة'}; let _gtS=(_cmS.typesByGame||{})[String(newProd||'').toLowerCase()]; if(!_gtS||!_gtS.length) _gtS=(_cmS.types||[]); _gtS=_ord.filter(function(t){return _gtS.indexOf(t)>=0;}); const _lblS=_gtS.map(function(t){return _TLs[t]||t;}); _svcMenu=(_lblS.length>1)?(_lblS.slice(0,-1).join('، ')+'، ولا '+_lblS[_lblS.length-1]):(_lblS[0]||''); }catch(e){} stage='discovery'; agent='Router (ask_service)'; model='rule'; const _glS=newProd?(' فـ'+String(newProd).replace(/\b[a-z]/g,function(c){return c.toUpperCase();})):''; reply='زوين خويا 🔥 شنو بغيتي'+_glS+': '+(_svcMenu||'💎 شحن جواهر، 🎟️ كودات، 👤 حساب')+'؟'; }
    else if(p.next==='ask_codesub'){ let _subsK=[]; try{ const _srK=await pool.query("SELECT DISTINCT regexp_replace(code_type,'\\s*\\(.*\\)','') ct FROM aykoshop_products WHERE status='available' AND product_type='code' AND code_type IS NOT NULL AND code_type<>''"); _subsK=_srK.rows.map(function(x){return String(x.ct).trim();}).filter(Boolean); }catch(e){} stage='discovery'; agent='Router (ask_codesub)'; model='rule'; reply='أي نوع كود خويا 🔑🔥 '+(_subsK.length?_subsK.join('، '):'سلاح/سكن/رقصة')+'؟ قول ليا وغانجيب ليك المتوفر.'; }
    else if(p.next==='ask_recharge_amount'){
      // ff_smart_seller Rule 5 (recharge): ASK amount/budget FIRST — no package dump. Data-driven range from catalog.
      let _rmn=0,_rmx=0,_rgl=newProd||(ctx&&ctx.product)||'';
      try{
        if(_rgl){ const _rrg=await pool.query("SELECT MIN(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mn, MAX(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mx FROM aykoshop_products WHERE status='available' AND product_type='recharge' AND lower(game)=$1",[String(_rgl).toLowerCase()]); _rmn=Math.round((_rrg.rows[0]||{}).mn||0); _rmx=Math.round((_rrg.rows[0]||{}).mx||0); }
        if(!_rmn){ const _rrA=await pool.query("SELECT MIN(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mn, MAX(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mx FROM aykoshop_products WHERE status='available' AND product_type='recharge'"); _rmn=Math.round((_rrA.rows[0]||{}).mn||0); _rmx=Math.round((_rrA.rows[0]||{}).mx||0); }
      }catch(_re){}
      const _rg=_rgl||'Free Fire';
      stage='discovery'; agent='Router (ask_recharge_amount)'; model='rule';
      reply=(_rmn&&_rmx&&_rmx>_rmn)?('عندنا شحن '+_rg+' من '+_rmn+' إلى '+_rmx+' درهم خويا 🔥 شحال باغي تشحن ولا شحال الميزانية ديالك باش نعطيك أنسب عرض؟'):('عندنا شحن '+_rg+' خويا 🔥 شحال باغي تشحن ولا شحال الميزانية ديالك باش نعطيك أنسب عرض؟');
    }
    // ===== ff_price_answer FIX-B: price-inquiry with game+service known → answer with real catalog price + card. NEVER re-asks budget. NEVER escalates to human. =====
    else if(p.next==='price_answer'){
      let _paMn=0,_paMx=0; let _paRows=[]; const _paGame=newProd||ctx.product||'';
      try{
        const _paR=await pool.query(
          "SELECT id,product_name,price,price_value,key_features,account_rank,evo_count,delivery_time,image_url FROM aykoshop_products WHERE status='available' AND product_type='account' AND lower(game)=$1 ORDER BY price_value ASC",
          [String(_paGame).toLowerCase()]
        );
        _paRows=_paR.rows;
        if(_paRows.length){
          _paMn=Math.round((_paRows[0].price_value)||0);
          _paMx=Math.round((_paRows[_paRows.length-1].price_value)||0);
        }
      }catch(_pae){}
      if(_paRows.length===0){
        // Game known but no products available → fall back to ask_budget reply
        reply='شحال الميزانية ديالك خويا؟';
      } else if(_paMn===_paMx){
        // Single price point → show card + direct answer
        const _paP=_paRows[0];
        function _paFeat(p){ var f=[]; if(p.account_rank)f.push('رتبة '+p.account_rank); if(p.evo_count)f.push(p.evo_count+' إيفو'); var kf=String(p.key_features||'').replace(/\s+/g,' ').trim(); if(kf)f.push(kf.slice(0,60)); return f.slice(0,2); }
        const _paFeats=_paFeat(_paP); const _paCard='🔹 '+(_paP.product_name||'')+'\n💰 '+(_paP.price||_paP.price_value||'')+(_paFeats.length?('\n✨ '+_paFeats.join(' · ')):'')+((_paP.delivery_time)?('\n🚚 التسليم: '+_paP.delivery_time):'');
        reply='هاهو حساب '+_paGame+' عندنا بـ'+_paMn+' درهم خويا 🔥\n\n'+_paCard+'\n\nواش عجبك ونكمّلو؟';
      } else {
        // Range — cheapest first + range
        const _paP0=_paRows[0];
        function _paFeat2(p){ var f=[]; if(p.account_rank)f.push('رتبة '+p.account_rank); if(p.evo_count)f.push(p.evo_count+' إيفو'); var kf=String(p.key_features||'').replace(/\s+/g,' ').trim(); if(kf)f.push(kf.slice(0,60)); return f.slice(0,2); }
        const _paFeats2=_paFeat2(_paP0); const _paCard2='🔹 '+(_paP0.product_name||'')+'\n💰 '+(_paP0.price||_paP0.price_value||'')+(_paFeats2.length?('\n✨ '+_paFeats2.join(' · ')):'')+((_paP0.delivery_time)?('\n🚚 التسليم: '+_paP0.delivery_time):'');
        reply='عندنا حسابات '+_paGame+' من '+_paMn+' إلى '+_paMx+' درهم، أرخص واحد بـ'+_paMn+' 🔥\n\n'+_paCard2+'\n\nشحال الميزانية ديالك باش نوريك الأنسب؟';
      }
      stage='discovery'; agent='Router (price_answer)'; model='rule';
    }
    else if(p.next==='ask_budget'){
      const _bt=(service==='code')?'code':(service==='subscription')?'subscription':'account'; let _mn=0,_mx=0;
      try{
        // ff_smart_seller Bug1 fix: game-filtered range so label + range are scoped to asked game, not cross-catalog
        if(_ffSSmain && newProd){
          const _brG=await pool.query("SELECT MIN(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mn, MAX(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mx FROM aykoshop_products WHERE status='available' AND product_type=$1 AND lower(game)=$2",[_bt,String(newProd).toLowerCase()]);
          _mn=Math.round((_brG.rows[0]||{}).mn||0); _mx=Math.round((_brG.rows[0]||{}).mx||0);
        }
        if(!_mn){ const _br=await pool.query("SELECT MIN(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mn, MAX(COALESCE(price_value, NULLIF(regexp_replace(price,'[^0-9]','','g'),'')::numeric)) mx FROM aykoshop_products WHERE status='available' AND product_type=$1",[_bt]); _mn=Math.round((_br.rows[0]||{}).mn||0); _mx=Math.round((_br.rows[0]||{}).mx||0); }
      }catch(_e){}
      const _btLbl={account:'حساب',code:'كود',subscription:'اشتراك'}; let _bl=(_ffSSmain&&newProd)?(newProd+' ('+(_btLbl[_bt]||_bt)+')'):(_bt==='subscription'?'اشتراك':'حسابات Free Fire');
      if(_bt==='code'){ let _cs2=[]; try{ const _cr2=await pool.query("SELECT DISTINCT regexp_replace(code_type,'\\s*\\(.*\\)','') ct FROM aykoshop_products WHERE status='available' AND product_type='code' AND code_type IS NOT NULL AND code_type<>''"); _cs2=_cr2.rows.map(function(x){return String(x.ct).trim();}).filter(Boolean); }catch(e){} _bl=(_ffSSmain&&newProd?(newProd+' '):'')+' كودات'+(_cs2.length?(' ('+_cs2.join('/')+')'):''); }
      // ff_qualify_complete: ask budget plainly — never reference a stale ctx.budget (phantom-budget fix).
      // FIX-C: removed "آخر مرة X، مازال؟" pre-fill; plain question avoids the loop where a stale budget
      // was echoed back every turn until the customer confirmed it. If the customer states a number it is
      // captured; if not, FIX-B (hard anti-spam) prevents re-sending the same ask twice.
      let _budReply;
      {
        // ff_price_answer FIX-A: always state the real price; single point (min==max) → 'بـX درهم', range → 'من X إلى Y'. OFF=byte-identical ('بأثمنة مناسبة' fallback preserved).
        if(_ffPA){
          const _gameLabel=(_ffSSmain&&newProd)?newProd:null;
          if(_mn&&_mx&&_mx>_mn){ _budReply='عندنا '+(_gameLabel?('حساب '+_gameLabel):_bl)+' خويا 🔥 من '+_mn+' إلى '+_mx+' درهم حسب المستوى. شحال الميزانية ديالك باش نقترح ليك الأنسب؟'; }
          else if(_mn){ _budReply='عندنا '+(_gameLabel?('حساب '+_gameLabel):_bl)+' خويا 🔥 بـ'+_mn+' درهم. واش نكمّل ليك؟'; }
          else { _budReply='شحال الميزانية ديالك خويا؟'; }
        } else {
          _budReply=(_mn&&_mx&&_mx>_mn)?('عندنا '+_bl+' خويا 🔥 من '+_mn+' إلى '+_mx+' درهم حسب المستوى. شحال الميزانية ديالك باش نقترح ليك الأنسب؟'):(_mn?('عندنا '+_bl+' خويا 🔥 بأثمنة مناسبة. شحال الميزانية ديالك باش نقترح ليك الأنسب؟'):'شحال الميزانية ديالك خويا؟');
        }
      }
      stage='discovery'; agent='Router (ask_budget)'; model='rule'; reply=_budReply;
    }
    // ===== ff_clarify: clarify_intent — totally vague turn, no service/product/budget/buy-intent. Reply lists available top categories from _catalogMeta (catalog-driven, NOT hardcoded). Counts toward clarify_count; at >=3 stalls → clarify_human (handled above in routing). =====
    // ===== ff_clarify_engine: clarify_context — ambiguous turn WITH a remembered offer → ONE context-linked question naming the last shown product (reuses ctx.shown, single by-id read, fail-soft to general Q). Counts toward clarify_count (N=3 → clarify_human). =====
    else if(p.next==='confirm_buy'){ stage='sales'; agent='Confirm→Buy'; model='rule';
      reply='واخا خويا 🔥 باش نكمّلو ونوجدو ليك الحساب، گوليا واش راك مستعد تخلّص دابا؟ 🙏'; }
    else if(p.next==='clarify_context'){ stage='discovery'; agent='Clarify (context)'; model='rule';
      const _svL=(ctx.service==='recharge')?'شحن ':(ctx.service==='code')?'كود ':(ctx.service==='account')?'حساب ':'';
      let _lbl=ctx.game||null;  // prefer the recalled game (Context-Lock), else the last shown product
      if(!_lbl){ try{ if(Array.isArray(ctx.shown)&&ctx.shown.length){ const _cr=await pool.query("SELECT product_name, COALESCE(game,'') game FROM aykoshop_products WHERE id=$1",[ctx.shown[ctx.shown.length-1]]); if(_cr.rows.length) _lbl=_cr.rows[0].product_name||_cr.rows[0].game; } }catch(_e){} }
      reply = _lbl ? ('واش كتقصد '+_svL+_lbl+' لي تكلمنا عليه قبل خويا؟ 🙏') : ('ممكن توضح ليا أكثر خويا؟ 😊 واش باغي تشري، تشحن، ولا عندك طلب آخر؟'); }
    else if(p.next==='clarify_intent'){
      let _ciCats=[]; try{ const _ciMeta=await _catalogMeta(); const _ciTL={recharge:'💎 شحن',account:'👤 حساب',code:'🎟️ كودات',subscription:'📺 اشتراك',service:'🛠️ خدمة'}; const _ciOrd=['recharge','code','account','subscription','service']; const _ciTypes=Array.isArray(_ciMeta.types)?_ciMeta.types:[]; _ciCats=_ciOrd.filter(function(t){return _ciTypes.indexOf(t)>=0;}).map(function(t){return _ciTL[t]||t;}); }catch(_cie){} const _ciList=_ciCats.length?(_ciCats.slice(0,-1).join('، ')+(_ciCats.length>1?'، ولا ':'')+_ciCats[_ciCats.length-1]):'حساب، شحن، ولا شي حاجة أخرى';
      // E4 Support phone interceptor — if customer asks for support/phone, answer directly
      const _askPhone = /رقم.*دعم|دعم.*رقم|رقم.*تليفون|تليفون.*دعم|رقم.*واتس|رقم.*وتس|رقم.*خدمة|كيف.*تواصل|تواصل.*معكم|رقم.*للتواصل|phone.*support|support.*phone|رقم.*مستخدم|رقم.*معكم|رقم.*ديالكم|رقم.*عندكم|ارقام.*ديالكم/i.test(String(lu||''));
      if(_askPhone){ stage='support'; agent='Phone-Interceptor'; model='rule'; reply='رقم الدعم الرسمي ديالنا خويا: 📞 0632-588578 و 0620-685987 — هاد الأرقام فقط، ما كاين غيرهم 🙏 واش كاين شي مشكل آخر؟'; }
      else { stage='discovery'; agent='Router (clarify_intent)'; model='rule'; reply='ما وضحاتليش مزيان خويا 🙏 توضح ليا أكثر باش نعاونك بسرعة. واش بغيتي '+_ciList+'؟'; }
    }
    else { stage=(p.next==='greet'?'greeting':'discovery'); agent='Router'; model=rt.via;
      if(_ffClarify && p.next==='ask_product' && service && !(p.reply&&p.reply.length>3)){
        // ff_clarify: service KNOWN but game missing → ask the GAME specifically (catalog game list), NOT the full
        // menu. Priority over the ff_seller_fix menu below so "بغيت كونط/حساب" → "شنو اللعبة؟" (no menu re-spam).
        let _clGames=[]; try{ const _clMeta=await _catalogMeta(); const _clSvc=String(service); _clGames=(_clMeta.lines||[]).filter(function(l){ const _lTypes=(_clMeta.typesByGame||{})[String(l.proper).toLowerCase()]||[]; return _lTypes.indexOf(_clSvc)>=0; }).map(function(l){return l.proper;}); if(!_clGames.length) _clGames=Array.from(new Set((_clMeta.lines||[]).map(function(l){return l.proper;}))); }catch(_cge){}
        const _clList=_clGames.length?_clGames.join('، '):'';
        reply='شنو اللعبة اللي بغيتي خويا؟'+(_clList?' '+_clList+'،':'')+' ولا لعبة أخرى؟'; stage='discovery'; agent='Router (clarify_game)'; model='rule';
      } else if((_ffAL||_ffSF) && p.next==='ask_product' && !(p.reply&&p.reply.length>3)){
        // ff_answer_last / ff_seller_fix: catalog-ask or engaged discovery with no service named → catalog menu
        try{ const _dd=await _v2Discover(_rejected||[], false, _ffSF, _rejectedGames); reply=_dd.reply; agent='Router (discovery)'; model='rule'; stage='discovery'; }catch(_de){ reply='مرحبا خويا 👋 أشمن لعبة بغيتي؟'; }
      } else {
        var _fb=(p.next==='ask_budget')?'مزيان خويا 👌 شحال الميزانية ديالك بالدرهم؟':(p.next==='ask_product')?'مرحبا خويا 👋 أشمن لعبة بغيتي؟':'سلام خويا 👋 كيفاش نعاونك؟'; reply=(!(p.reply&&p.reply.length>3))?_fb:p.reply;
      }
    }
    // ===== P6: never leave the customer without a reply (all-AI-fail safe floor) =====
    if(!reply || String(reply).trim().length<3){ reply='سمح ليا خويا 🙏 وقع مشكل تقني بسيط، غادي نخليك مع واحد من الفريق باش يعاونك دابا.'; stage='human'; agent='AI-Fail→Human'; escalate=escalate||'AI_REPLY_FAILED'; }
    // ===== P2: ANTI-LOOP (F3 enhanced) — 3 signals: exact-reply hash (original), state-turns, customer-msg hash =====
    let _rhash=''; let _replyRepeat=(ctx.reply_repeat||0); let _loopBreak=false;
    // Signal A (original): exact bot-reply md5 — rarely trips because AI rephrases each turn
    // ff_seller_fix Fix3: NEVER escalate from greeting or discovery; remove _ffAL relaxation (was _ffAL?true:!_engage).
    // ff_answer_last: original !_engage guard was already removed (kept as-is when ff_seller_fix OFF).
    try{ if(reply && String(reply).length>5){
      // FIX-B: normalize before hashing so case-variants ("Free Fire" vs "free fire") are caught as repeats.
      // Normalize = lowercase + collapse all whitespace. Stored hash is always normalized.
      const _replyNorm=String(reply).toLowerCase().replace(/\s+/g,' ').trim();
      _rhash=_crypto.createHash('md5').update(_replyNorm).digest('hex').slice(0,12); _replyRepeat=(_rhash===ctx.last_reply_hash)?((ctx.reply_repeat||0)+1):0;
      // FIX-B + FIX-D (ff_qualify_complete): HARD no-spam — a normalized-identical reply MUST escalate regardless of
      // _buyIntent. The general anti-loop (below) still keeps !_buyIntent for non-identical-text loops;
      // this block is for normalized-identical repeat ONLY. "Cannot advance → give customer a human" is absolute.
      const _hardRepeat = _ffQC && _replyRepeat>=1 && _rhash===ctx.last_reply_hash && stage!=='human' && stage!=='payment' && stage!=='payment_human' && stage!=='frozen' && !(_ffCE && _ambigSignal) && !ctx.had_offer;
      if(_hardRepeat){ reply='سمح ليا خويا 🙏 باش نعاونك مزيان غادي نخليك مع واحد من الفريق، غادي يجاوبك قريب 👤'; stage='human'; agent='Anti-Spam→Human'; escalate='HUMAN_REPEAT'; _loopBreak=true; }
      // Original Signal A (non-QC path, keeps !_buyIntent exemption for general loops when flag OFF):
      else if(_replyRepeat>=2 && !_buyIntent && (_ffSF ? (!_engage) : (_ffAL?true:!_engage)) && stage!=='human' && stage!=='payment' && stage!=='payment_human' && stage!=='frozen' && stage!=='greeting' && (_ffSF?stage!=='discovery':true)){ reply='سمح ليا خويا 🙏 باش نعاونك بشكل أحسن غادي نخليك مع واحد من الفريق، غادي يتواصل معاك قريب 👤'; stage='human'; agent='Anti-Loop→Human'; escalate='AI_LOOP_DETECTED'; _loopBreak=true; }
      // ===== LOOP STRATEGY SWITCH: hot buyer (_buyIntent=true) in loop → pivot strategy, never let loop continue =====
      // Gap closed: _hardRepeat needs !ctx.had_offer AND Signal A needs !_buyIntent → both disabled for ISMAIL-type loops.
      // Fix: when reply repeats 2x with _buyIntent ON → switch to budget clarification (turn 3) → escalate (turn 4+).
      else if(!_loopBreak && _replyRepeat>=2 && _buyIntent && stage!=='human' && stage!=='payment' && stage!=='payment_human' && stage!=='frozen'){
        if(_replyRepeat===2){
          // Turn 3: first loop detection with buying intent — pivot to budget/confirm
          var _pivotR=ctx.budget
            ? ('خويا الحساب لقينا ليك بـ'+(ctx.budget||'')+'DH — واش نحجزو ليك دابا؟ 🙏 ولا عندك سؤال آخر؟')
            : ('گوليا الميزانية ديالك بالدرهم خويا باش نوريك الأنسب ليك 💰');
          reply=_pivotR; stage='sales'; agent='Loop-Pivot→Budget';
          // Reset counter so pivot reply doesn't itself trigger a new loop on the same hash
          var _pivotNorm=String(_pivotR).toLowerCase().replace(/\s+/g,' ').trim();
          _rhash=_crypto.createHash('md5').update(_pivotNorm).digest('hex').slice(0,12); _replyRepeat=0;
        } else {
          // Turn 4+: still looping after pivot → clean escalation with human
          reply='غادي نخليك مع واحد من الفريق باش يكمّل معاك مباشرة خويا 🙏 هو غادي يوجد ليك أحسن عرض'; stage='human'; agent='Loop-Pivot→Human'; escalate='AI_LOOP_DETECTED'; _loopBreak=true;
        }
      }
    } }catch(_e){}
    // F3 Signal B + C: state-turns stall + customer-msg repetition
    let _cuhash=null; let _cuRepeat=(ctx.customer_hash_repeat||0);
    // ff_seller_fix Fix3: NEVER escalate from greeting or discovery; remove _ffAL relaxation.
    // ff_answer_last: original !_engage guard was already removed (kept as-is when ff_seller_fix OFF).
    try{ if(!_loopBreak && !_buyIntent && (_ffSF ? (!_engage) : (_ffAL?true:!_engage)) && stage!=='human' && stage!=='payment' && stage!=='payment_human' && stage!=='frozen' && stage!=='greeting' && (_ffSF?stage!=='discovery':true) && !(_ffCE && _ambigSignal)){
      // Signal B: stuck in sales/discovery >= 4 turns with no advancement toward purchase
      // FIX-C: still-buying customer (wants alternatives) → channel first, human only after
      const _stillBuying = _rejGeneric || _isClarifyOffer || ctx.had_offer || /بغيت شي|كاين شي|عطيني|عندك ف|شوف|نشوف|غالي|خفضلي|بغيت أقل|نقصلي|رخيص/i.test(lu);
      if((stage==='sales'||stage==='discovery') && (ctx.convo_state_turns||0)>=4 && next!=='to_seller' && next!=='to_payment' && next!=='recharge_human'){
        if(_stillBuying && stage!=='human'){
          next='send_channel'; p.next='send_channel'; _newAttempts=_newAttempts+1;
          if(_newAttempts>=3){ next='human_lock'; p.next='human_lock'; }
        } else {
          reply='سمح ليا خويا 🙏 باش نعاونك بشكل أحسن غادي نخليك مع واحد من الفريق، غادي يتواصل معاك قريب 👤'; stage='human'; agent='Anti-Loop (turns)→Human'; escalate='AI_LOOP_DETECTED'; _loopBreak=true;
        }
      }
      // Signal C: customer repeating the same ask >= 3 times (normalized msg hash)
      if(!_loopBreak && typeof lu==='string' && lu.length>=4){
        const _norm=lu.toLowerCase().replace(/\s/g,'').replace(/[^a-z\u0600-\u06ff0-9]/g,'').slice(0,60);
        _cuhash=_crypto.createHash('md5').update(_norm).digest('hex').slice(0,12);
        _cuRepeat=(_cuhash===ctx.last_customer_hash)?((ctx.customer_hash_repeat||0)+1):0;
        const _cuLimit=(ctx.had_offer && stage==='sales')?5:2; // negotiation gets 5 retries, others get 2
        if(_cuRepeat>=_cuLimit){ reply='سمح ليا خويا 🙏 باش نعاونك بشكل أحسن غادي نخليك مع واحد من الفريق، غادي يتواصل معاك قريب 👤'; stage='human'; agent='Anti-Loop (cust)→Human'; escalate='AI_LOOP_DETECTED'; _loopBreak=true; }
      }
    } }catch(_e2){}
    // ===== ff_answer_last: IDENTICAL-REPLY DEDUPE — if the reply we just computed is the same as the last reply sent AND stage is greeting/discovery, replace with a real catalog menu instead of re-emitting the same text =====
    if(_ffAL && !_loopBreak && reply && String(reply).length>5 && (stage==='greeting'||stage==='discovery')){
      try{
        // FIX-B: use normalized hash to match the stored normalized hash
        const _dedupeHash=_crypto.createHash('md5').update(String(reply).toLowerCase().replace(/\s+/g,' ').trim()).digest('hex').slice(0,12);
        if(_dedupeHash===ctx.last_reply_hash){
          const _dd=await _v2Discover(_rejected||[], false, _ffSF, _rejectedGames);
          reply=_dd.reply; stage='discovery'; agent='Router (dedupe-discover)'; model='rule';
        }
      }catch(_de){}
    }
    // ===== CLOSE PUSH: offer shown + customer confirms → push to payment =====
    // Placed AFTER P2 so _loopBreak is defined. Only fires when all conditions met.
    if(!_loopBreak && !escalate && ctx.had_offer && stage!=='human' && stage!=='payment' && stage!=='payment_human' && stage!=='frozen'){
      var _closeSignal=/واخا|وخا|wakha|\bok\b|okay|اوكي|أوكي|مزيان|نشري|شريتو|حجزو|باغي نشري|مقبول|متفق|\bنعم\b|\bايه\b|na3am|ابغي نشري|بالضبط|عطيها|دبر|دبرو|كمّل|تمام|parfait|nickel/i.test(String(lu||''));
      var _alreadyPayReply=(String(reply||'').indexOf('خلص')>=0)||(String(reply||'').indexOf('CIH')>=0)||(String(reply||'').indexOf('دفع')>=0);
      if(_closeSignal && !_alreadyPayReply && next!=='to_payment' && next!=='recharge_human'){
        reply='واخا خويا 🔥 باش نكمّلو ليك، گوليا الطريقة لي بغيتي تخلص بيها 💳 CIH / بريد بنك / Binance USDT — ونكمّلو ليك دابا 🙏';
        stage='sales'; agent='Close→Payment'; next='to_payment';
      }
    }
    const trailStr=trail.concat([stage]).join(' → ');
    if(sub && /^[0-9]+$/.test(String(sub))){
      pool.query("INSERT INTO aykoshop_agent_trail(subscriber_id,from_stage,to_stage,agent,reason,user_msg) VALUES($1,$2,$3,$4,$5,$6)",[String(sub),ctx.state||'new',stage,agent,p.next,String(lu).slice(0,200)]).catch(()=>{});
      // [ADR-0020 Gate G5] stage_transition — after agent_trail (stage is final), never changes it
      _persistEvidence(String(sub),[{type:'stage_transition',value:(ctx.state||'new')+'→'+stage,source:'code',confidence:0.95},{type:'product_interest',value:(newProd||null),source:'code',confidence:0.85}].filter(function(e){return e.value!=null;}),turn_id).catch(()=>{});
      if(newBudget) _persistEvidence(String(sub),[{type:'budget_stated',value:String(newBudget),source:'code',confidence:0.85}],turn_id).catch(()=>{});
      var _persistState=((p.next==='greet'||p.next==='human_lock') && ctx.state && /^(sales|discovery|browsing|payment)$/.test(ctx.state))?ctx.state:stage;
      pool.query("INSERT INTO aykoshop_profiles (subscriber_id,convo_state,favorite_game,budget,service_type,attempts,last_seen) VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (subscriber_id) DO UPDATE SET convo_state=$2, favorite_game=COALESCE($3,aykoshop_profiles.favorite_game), budget=COALESCE($4,aykoshop_profiles.budget), service_type=COALESCE($5,aykoshop_profiles.service_type), attempts=$6, last_seen=NOW()",[String(sub),_persistState,(newProd||null),(newBudget||null),(service||null),_newAttempts]).catch(()=>{});
      if(p.next==='discover'||p.next==='recommend'){ pool.query("UPDATE aykoshop_profiles SET service_type=$2, rejected_services=$3, convo_state='discovery' WHERE subscriber_id=$1",[String(sub),(service||null),_rejected.join(',')]).catch(()=>{}); }
      else if(p.next==='to_seller'||p.next==='to_payment'){ pool.query("UPDATE aykoshop_profiles SET rejected_services=$2 WHERE subscriber_id=$1",[String(sub),(ctx.rejected||[]).filter(function(x){return x!==service;}).join(',')]).catch(()=>{}); }
      else if(p.next==='ask_budget'){ pool.query("UPDATE aykoshop_profiles SET rejected_services=$2 WHERE subscriber_id=$1",[String(sub),_rejected.filter(function(x){return x!==service;}).join(',')]).catch(()=>{}); }
      pool.query("UPDATE aykoshop_profiles SET last_reply_hash=$2, reply_repeat=$3, active_product=$4, clarify_count=$5, last_customer_hash=$6, customer_hash_repeat=$7 WHERE subscriber_id=$1",[String(sub),_rhash,_replyRepeat,(service||null),(stage==='human'?0:(typeof _clarVal!=='undefined'?_clarVal:0)),(_cuhash||null),_cuRepeat]).catch(()=>{});
      // CONSOLIDATED session_data merge — ONE atomic jsonb merge so concurrent fire-and-forget writes can't
      // clobber each other (buy_intent_active / budget_confirmed / had_offer / shown_products previously raced
      // as 4 separate UPDATEs: each read the pre-update session_data and last-write-won, silently dropping keys).
      // UPSERT (self-sufficient) so it lands even if the profile-row INSERT above hasn't committed on turn 1.
      { var _sd={ buy_intent_active:(!!_buyIntent && stage!=='payment' && stage!=='payment_human' && stage!=='human' && !_nonBuyHard), last_bot_next:(p&&p.next)||next||null }; // S2-B: persist routing decision for next turn's _hybridIntent context
        if(_ffQC && _budgetStatedNow && newBudget && stage!=='payment') _sd.budget_confirmed=true;
        else if(_ffQC && (stage==='greeting' || p.next==='greet_fresh')) _sd.budget_confirmed=false;
        // ff_clarify_engine V2: persist the product-confirm state machine. awaiting_confirm holds the game pending a Context-Lock answer (set this turn, consumed next); product_confirmed locks the game once named/affirmed so we don't re-confirm before the offer.
        if(_ffCE){ if(_awaitGame && p.next==='clarify_context') _sd.awaiting_confirm=_awaitGame; else _sd.awaiting_confirm=null;
          if(_productConfirmedThisSession && stage!=='greeting' && p.next!=='greet_fresh') _sd.product_confirmed=true; else if(stage==='greeting' || p.next==='greet_fresh') _sd.product_confirmed=false; }
        if(_setHadOfferNow) _sd.had_offer=true;
        if(_shownNow && _shownNow.length) _sd.shown_products=Array.from(new Set((ctx.shown||[]).concat(_shownNow))).slice(-20);
        // FIX-A: persist rejected games so exclusion survives across turns (stored in session_data, no schema change)
        if(_ffQC && _rejectedGames.length) _sd.rejected_games=_rejectedGames.slice(0,20);
        pool.query("INSERT INTO aykoshop_profiles (subscriber_id,session_data) VALUES ($1,$2::jsonb) ON CONFLICT (subscriber_id) DO UPDATE SET session_data=COALESCE(aykoshop_profiles.session_data,'{}')::jsonb || $2::jsonb",[String(sub),JSON.stringify(_sd)]).catch(()=>{}); }
      if(_loopBreak){ pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,'ai_loop') ON CONFLICT(subscriber_id) DO UPDATE SET reason='ai_loop', stopped_at=NOW()",[String(sub)]).catch(()=>{}); }
      if(_lockNow){ pool.query("INSERT INTO aykoshop_stopped_chats (subscriber_id, reason) VALUES ($1,'token_lock') ON CONFLICT (subscriber_id) DO UPDATE SET reason='token_lock', stopped_at=NOW()",[String(sub)]).catch(()=>{}); const _l10=messages.slice(-10).map(function(m){return (m&&m.role==='user'?'🧑 ':'🤖 ')+String((m&&m.content)||'').slice(0,120);}).join('\n'); const _audit='🔒 سبب الحبس: 3 محاولات تردد بلا قرار شراء (Token-Lock)\n📊 عدد المحاولات: '+_newAttempts+'\n👤 آخر وكيل جاوب: '+(_prevAgent||'—')+'\n🔗 مسار المحادثة: '+trailStr+'\n\n📝 آخر الرسائل:\n'+_l10; fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:b.channel||null,reason_code:'TOKEN_LOCK',reason_detail:_audit.slice(0,1800),customer_message:String(lu).slice(0,300),intent:'token_lock'})}).catch(()=>{}); }
      if(escalate){ fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:b.channel||null,reason_code:escalate,reason_detail:'V2 → '+stage+' | السلسلة: '+trailStr,customer_message:String(lu).slice(0,300)})}).catch(()=>{}); }
      // ff_freeze_handoff: every human handoff → freeze (stopped_chats) so the bot goes silent + the chat shows in the
      // frozen dashboard for manual resume. ON CONFLICT DO NOTHING preserves more-specific reasons (credentials/payment/ai_loop/token_lock).
      // freeze on ANY human handoff (stage==='human') — not all handoff paths set `escalate` (e.g. sell→human),
      // but ALL should freeze so the chat goes silent + appears in the frozen dashboard for manual resume.
      if(_ffFH && stage==='human' && sub && /^[0-9]+$/.test(String(sub))){ pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,'human_handoff') ON CONFLICT(subscriber_id) DO NOTHING",[String(sub)]).catch(()=>{}); }
    }
        let _kbUsed=false;
    if(_km && _kbCtx && (stage==='sales'||stage==='discovery')){ _kbUsed=true; pool.query('UPDATE aykoshop_conversation_examples SET usage_count=usage_count+1, last_used=NOW() WHERE id=$1',[_km.id]).catch(()=>{}); if(sub && /^[0-9]+$/.test(String(sub))) _logAiUsage({subscriber_id:sub,provider:'kb',model:'kb',mode:'kb_ctx',role:stage,intent:p.intent,route_layer:'v2_kb',user_msg:String(lu).slice(0,200),success:true}); }
reply=_stripMd(reply);
    if((stage==='human'||stage==='payment') && sub && /^[0-9]+$/.test(String(sub))){ pool.query("INSERT INTO aykoshop_stopped_chats(subscriber_id,reason) VALUES($1,$2) ON CONFLICT(subscriber_id) DO NOTHING",[String(sub),(stage==='payment'?'payment_verification':'human_handoff')]).catch(()=>{}); }
    let _vblk=false; if(stage==='sales'){ try{ const _vv=await _applyVerifier(reply, sub, b, p.intent, 'sales', lu); if(_vv&&typeof _vv.reply!=='undefined'){ reply=_vv.reply; } _vblk=!!(_vv&&_vv.blocked); }catch(_e){} }
    // [ADR-0020 Gate G6] offer_shown — stage='sales' + _shownNow set; fires after verifier (reply final), never changes stage/reply
    if(sub && /^[0-9]+$/.test(String(sub)) && stage==='sales' && _shownNow && _shownNow.length){
      _persistEvidence(String(sub),[{type:'offer_shown',value:String(_shownNow[0]),source:'code',confidence:0.90}],turn_id).catch(()=>{});
    }
    // [ADR-0020 Step 1.5] shadow-decision log — gated ff_evidence_shadow, fire-and-forget, NEVER touches res.json payload
    if(sub && /^[0-9]+$/.test(String(sub))){ _persistShadowDecision(String(sub),{stage:stage,next:p.next,budget:newBudget,product:newProd},turn_id).catch(()=>{}); }
    // [Phase 1 Belief Shadow] counterfactual gap logger — gated ff_belief_shadow, fire-and-forget, NEVER reads/writes reply/stage/next/p.next/res
    if(sub && /^[0-9]+$/.test(String(sub))){ _persistBeliefShadow(String(sub),p.next,{newProd:newProd,newBudget:newBudget,service:service,rejected:_rejected},lu,turn_id,(b.is_test===true)).catch(function(){}); }
    // [Truth Gate] validate reply against real catalog prices + policy before sending
    if((stage==='sales'||stage==='discovery'||stage==='browsing')&&sub&&/^[0-9]+$/.test(String(sub))){ try{ var _tp2=rt.tp||await _buildTruthPacket(sub,p.intent,ctx); /* P0-B+C */ var _tg2=_truthGate(reply,_tp2); if(_tg2.blocked){ reply=_tg2.corrected; _logAiUsage({subscriber_id:sub,provider:'rule',model:'truth_gate',mode:'gate',role:'sales',intent:p.intent,route_layer:'truth_gate',user_msg:String(lu).slice(0,200),success:true,detail:String(_tg2.reason).slice(0,100)}); } }catch(_tge2){} }

        res.json({ ok:true, stage, agent, model, verifier_blocked:_vblk, router_via:rt.via, intent:p.intent, product:newProd, budget:newBudget, next:p.next, trail:trailStr, image_url:((stage==='sales')?_offerImg:'NO_IMAGE'), kb_used:_kbUsed, kb_id:(_km?_km.id:null), kb_sim:(_km&&_km.sim?Number(Number(_km.sim).toFixed(3)):null), kb_entry_type:(_km?_km.entry_type:null), kb_source:(_km?_km.source:null), reply, ms:Date.now()-t0 });
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
// ==================== END V2 ORCHESTRATOR ====================
app.post('/api/ai/route', async (req,res)=>{ try{ const cfg=await getAiConfig(); const txt=(req.body&&req.body.message)||''; const d=await _routeCascade(txt,cfg); res.json({ message:txt, intent:d.intent, cls:d.cls, role:d.role, provider:d.primary, fallback:d.fallback, mode:'primary', route_layer:d.route_layer, decision_reason:d.reason, emergency:!!cfg.emergency_mode }); }catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/products/reembed', async (req,res)=>{ try{ const r=await pool.query("SELECT id FROM aykoshop_products WHERE status='available'"); let ok=0,fail=0; for(const row of r.rows){ const d=await _embedProduct(row.id); if(d) ok++; else fail++; } res.json({ok:true, reembedded:ok, failed:fail, total:r.rows.length}); }catch(e){ res.status(500).json({ok:false,error:e.message}); } });
app.post('/api/ai/catalog-search', async (req,res)=>{ try{ const b=req.body||{}; const r=await _catalogSearch(b.q||'', {type:b.type||null, budget:b.budget||null, limit:b.limit||8}); res.json({ ok:r.ok, nq:(r.nq||null), err:(r.err||null), count:r.rows.length, products:r.rows.map(function(p){return {id:p.id,name:p.product_name,game:p.game,type:p.product_type,price:p.price,pv:p.pv,sim:Number(Number(p.sim).toFixed(3))};}) }); }catch(e){ res.status(500).json({ok:false,error:e.message}); } });
function _logAiUsage(o){ try{ pool.query("INSERT INTO aykoshop_ai_usage(subscriber_id,provider,model,mode,role,tokens_in,tokens_out,latency_ms,success,detail,intent,route_layer,user_msg,turn_id,error_type,customer_impact) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",[o.subscriber_id||null,o.provider||null,o.model||null,o.mode||null,o.role||'sales',o.tokens_in||0,o.tokens_out||0,o.latency_ms||0,!!o.success,o.detail?String(o.detail).slice(0,120):null,o.intent||null,o.route_layer||null,o.user_msg?String(o.user_msg).slice(0,200):null,o.turn_id||null,o.error_type||null,o.customer_impact||null]).catch(()=>{}); }catch(e){} }
// ===== V2 CANARY — route a deterministic slice of REAL traffic to the V2 orchestrator =====
// Safe by design: if V2 isn't eligible or fails for ANY reason → returns null → caller falls through to the legacy engine
// (a real customer is NEVER lost). Slice % from aykoshop_settings.v2_canary_pct (0=off kill-switch, 100=all). Deterministic per subscriber.
let _v2CanCache={t:0,pct:0,force:[]};
async function _v2CanaryTry(sub, messages, b, lu, t0){
  try{
    if(!sub || !/^[0-9]+$/.test(String(sub))) return null;
    if(Date.now()-_v2CanCache.t>30000){ try{ const r=await pool.query("SELECT key,value FROM aykoshop_settings WHERE key IN ('v2_canary_pct','v2_force_subs')"); const m={}; r.rows.forEach(x=>m[x.key]=x.value); _v2CanCache={t:Date.now(),pct:Math.max(0,Math.min(100,parseInt(m.v2_canary_pct)||0)),force:String(m.v2_force_subs||'').split(',').map(x=>x.trim()).filter(Boolean)}; }catch(e){ _v2CanCache.t=Date.now(); } }
    const _forced=_v2CanCache.force.indexOf(String(sub))>=0;
    if(!_forced){
      if(_v2CanCache.pct<=0) return null;
      if(_v2CanCache.pct<100){ let h=0; const s=String(sub); for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))>>>0; } if((h%100)>=_v2CanCache.pct) return null; }
    }
    const it=(typeof lu==='string' && /audioclip|\.(ogg|m4a)(\?|$)|cdn\.fbsbx[^\s]*\.(mp4|ogg|m4a)|lookaside[^\s]*ig_messaging_cdn/i.test(lu))?'audio':(typeof lu==='string' && lu.indexOf('http')===0 && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(lu))?'image':'text';
    let v2=null; try{ v2=await (await fetch('http://localhost:4000/api/ai/v2reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:sub,messages:messages,channel:(b&&b.channel)||null})})).json(); }catch(e){}
    if(v2 && v2.suppress){ return { ok:true, mode:'suppressed', provider:'rule', role:'greet', reply:'NO_SEND', suppress:true, ms:Date.now()-t0 }; }
    if(v2 && v2.frozen){ pool.query("INSERT INTO aykoshop_v2_canary(subscriber_id,channel,input_type,stage,agent,model,error) VALUES($1,$2,$3,'frozen','Human','-',false)",[String(sub),(b&&b.channel)||null,it]).catch(()=>{}); return { ok:true, mode:'frozen', provider:'human', role:'human', reply:'', frozen:true, ms:Date.now()-t0 }; }
    if(v2 && v2.ok && v2.reply){
      try{ const _mck='Bearer '+(_mcKey()|| ''); var _v2img=(typeof v2.image_url==='string'&&v2.image_url.indexOf('http')===0)?v2.image_url:null; fetch('https://api.manychat.com/fb/subscriber/setCustomFieldByName',{method:'POST',headers:{'Authorization':_mck,'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),field_name:'ai_image2',field_value:_v2img}),signal:AbortSignal.timeout(4000)}).catch(()=>{}); }catch(_e){}
      pool.query("INSERT INTO aykoshop_v2_canary(subscriber_id,channel,input_type,stage,agent,model,error) VALUES($1,$2,$3,$4,$5,$6,false)",[String(sub),(b&&b.channel)||null,it,v2.stage||null,v2.agent||null,v2.model||null]).catch(()=>{});
      _logAiUsage({subscriber_id:sub,provider:'v2',model:v2.model||'v2',mode:'v2',role:v2.stage||'v2',route_layer:'v2_'+(v2.stage||''),user_msg:(typeof lu==='string'?lu:'[media]').slice(0,200),success:true});
      return { ok:true, mode:'v2', provider:'v2', role:v2.stage||'v2', intent:v2.intent||null, route_layer:'v2_'+(v2.stage||''), decision_reason:'V2 canary', reply:v2.reply, image_url:(v2.image_url||'NO_IMAGE'), ms:Date.now()-t0 };
    }
    pool.query("INSERT INTO aykoshop_v2_canary(subscriber_id,channel,input_type,error) VALUES($1,$2,$3,true)",[String(sub),(b&&b.channel)||null,it]).catch(()=>{});
    return null; // V2 failed → legacy handles it (customer never lost)
  }catch(e){ return null; }
}
let _aiInFlight=0; const _AI_CAP=parseInt(process.env.AI_CONCURRENCY_CAP)||40; // load-shed cap — graceful degrade under burst (protects providers + DB pool from a 1000-customer melt)
app.post('/api/ai/generate', async (req,res)=>{
  { const _rip=((req.socket&&req.socket.remoteAddress)||'').replace('::ffff:',''); if(!(_rip==='127.0.0.1'||_rip==='::1'||/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(_rip))) return res.status(403).json({ok:false,error:'forbidden'}); }
  const t0=Date.now(); const b=req.body||{}; const messages=(b.messages||[]).slice(-14); const opt={ max_tokens:b.max_tokens, temperature:b.temperature }; const sub=b.subscriber_id||null;
  if(_aiInFlight >= _AI_CAP){ try{ _logAiUsage({subscriber_id:sub,provider:'rule',model:'-',mode:'shed',role:'system',route_layer:'load_shed',success:false,customer_impact:'degraded',detail:'concurrency cap '+_AI_CAP,user_msg:'[load_shed]'}); }catch(_e){} return res.json({ ok:true, mode:'busy', reply:'شوية ⏳ كاين ضغط بزاف دابا، عاود صيفط رسالتك من بعد دقيقة 🙏', ms:Date.now()-t0 }); }
  _aiInFlight++; res.on('finish',()=>{ _aiInFlight=Math.max(0,_aiInFlight-1); });
  try {
    const cfg = await getAiConfig();
    if(cfg.emergency_mode){ _logAiUsage({subscriber_id:sub,mode:'emergency',success:false,detail:'emergency_mode'}); return res.json({ ok:false, mode:'emergency' }); }
    let _lu=(messages.filter(m=>m.role==='user').slice(-1)[0]||{}).content||'';
    { const _cv2=await _v2CanaryTry(sub,messages,b,_lu,t0); if(_cv2) return res.json(_cv2); }
    // AUDIO-ROUTE: لو الرسالة رابط صوت (Meta CDN) → نسخ Whisper ثم نكمّل بالنص
    if(typeof _lu==='string' && /cdn\.fbsbx\.com[^\s]*audioclip|audioclip[^\s]*\.mp4|fbcdn[^\s]*\.(mp4|ogg|m4a)|lookaside[^\s]*audio|lookaside\.fbsbx\.com[^\s]*ig_messaging_cdn|\.(ogg|m4a)(\?|$)/i.test(_lu)){
      try{ const _tr=await (await fetch('http://localhost:4000/api/ai/transcribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audio_url:_lu,subscriber_id:sub})})).json();
        if(_tr && _tr.ok && _tr.text){ _lu=_tr.text; for(let _k=messages.length-1;_k>=0;_k--){ if(messages[_k] && messages[_k].role==='user'){ messages[_k]=Object.assign({},messages[_k],{content:_lu}); break; } } }
        else { return res.json({ ok:true, mode:'audio', provider:'rule', role:'support', reply:(_tr&&_tr.disabled)?'🎤 عافاك كتب لينا اللي بغيتي كنص ونكمّلو معاك ✍️':'🎤 ماقدرتش نسمع الصوت دابا 🙏 عافاك كتب لينا اللي بغيتي كنص ونكمّلو ✍️' }); }
      }catch(_e){ return res.json({ ok:true, mode:'audio', provider:'rule', role:'support', reply:'🎤 عافاك كتب لينا اللي بغيتي كنص ونكمّلو معاك ✍️' }); }
    }
    // IMAGE-ROUTE: image url -> Vision Agent (classify + reply by content)
    if(typeof _lu==='string' && _lu.indexOf('http')===0 && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(_lu)){
      try{ const _vr=await (await fetch('http://localhost:4000/api/ai/vision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image_url:_lu,subscriber_id:sub,channel:b.channel||null,message:''})})).json();
        if(_vr && _vr.reply){ _logAiUsage({subscriber_id:sub,provider:_vr.provider||'openai',model:'gpt-4o',mode:'vision',role:'vision',route_layer:'vision',user_msg:'[image]',success:true}); return res.json({ ok:true, mode:'vision', provider:_vr.provider||'openai', role:'vision', type:_vr.type, is_payment:_vr.is_payment, reply:_vr.reply, ms:Date.now()-t0 }); }
      }catch(_e){ return res.json({ ok:true, mode:'vision', provider:'rule', role:'vision', reply:'وصلتنا الصورة 😊 شنو بغيتي بالضبط؟' }); }
    }
    const _route=await _routeCascade(typeof _lu==='string'?_lu:'', cfg);
    _updateBuyerContext(sub,_lu,b);
    try{ _pipelineShadow(sub, (typeof _lu==='string'?_lu:''), _route); }catch(_pe){}
    // CATALOG-MISS: customer references a product from the FB group/external (not in catalog) -> hold + escalate (no guessing)
    if(sub && typeof _lu==='string' && /group|قروب|كروب|جروب|گروب|فالقروب|فالجروب|فالكروب|البوست|فالبوست|بوست|الصفحة\s*ديالكم/i.test(_lu)){
      (async()=>{ try{ const _gd=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code='PRODUCT_NOT_FOUND' AND created_at>now()-interval '3 hours' LIMIT 1",[String(sub)]); if(!_gd.rows.length){ await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),customer_name:b.first_name||null,channel:b.channel||null,reason_code:'PRODUCT_NOT_FOUND',reason_detail:'الزبون كيشير لمنتج من الجروب/خارج الكاطالوج — جاوبو ولا زيد المنتج للداشبورد',customer_message:_lu.slice(0,400)})}); } }catch(_e){} })();
      var _gmReply='صحّ خويا 🙏 نتأكد لك من هاد المنتج مع الفريق ونرجع ليك بسرعة. عطيني شوية ديال الوقت 😊';
      _logAiUsage({subscriber_id:sub,provider:'rule',model:'rule',mode:'rule',role:'support',intent:'catalog_miss',route_layer:'rule_catalogmiss',user_msg:_lu.slice(0,200),success:true});
      return res.json({ ok:true, mode:'rule', provider:'rule', role:'support', intent:'catalog_miss', route_layer:'rule_catalogmiss', reply:_gmReply, ms:Date.now()-t0 });
    }
    // RECHARGE INTELLIGENCE: (1) account-credentials safety -> human; (2) recharge hot-lead; (3) VIP large orders
    if(sub && typeof _lu==='string'){
      var _luR=_lu;
      var _hasCred=/الإيميل\s*و(ال)?باس|ايميل\s*و(ال)?باس|كلمة السر|باسوورد|password|[\w.\-]+@[\w.\-]+\.\w{2,}/i.test(_luR);
      var _rechCtx=/شحن|recharge|top.?up|\bUC\b|diamonds?|جواهر|جوهر|coins?|شدات|كوينز/i.test(_luR);
      var _giveAcct=/نعطيك[مو]?\s*(ال)?حساب|خود\s*(ال)?حساب|دخل[ويو]?\s*(ل|في|للـ)?\s*(ال)?حساب|شحنو?\s*ليا?\s*ف(ال)?حساب|حسابي.*شحن|دير[وو]?\s*ليا?\s*الشحن.*حساب/i.test(_luR);
      if(_hasCred || (_giveAcct && _rechCtx)){
        (async()=>{ try{ await pool.query("INSERT INTO aykoshop_stopped_chats (subscriber_id, reason) VALUES ($1,'human_recharge') ON CONFLICT (subscriber_id) DO NOTHING",[String(sub)]).catch(function(){});
          var _dup=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code='HUMAN_RECHARGE' AND created_at>now()-interval '3 hours' LIMIT 1",[String(sub)]);
          if(!_dup.rows.length){ await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),customer_name:b.first_name||null,channel:b.channel||null,reason_code:'HUMAN_RECHARGE',reason_detail:'الزبون عرض معلومات الحساب للشحن — تدخّل بشري (المعلومات محجوبة للأمان)',customer_message:'[محجوب — معلومات حساب حساسة]'})}); }
        }catch(_e){} })();
        var _raReply='خويا للأمان ماتصيفطش معلومات الحساب (الإيميل/الباس) هنا 🙏 الفريق غادي يتواصل معاك مباشرة باش يدير ليك الشحن بأمان. ولا إيلا بغيتي نشحنو ليك بالـID، عطينا غير المعرف/الـID ديال اللعبة.';
        _logAiUsage({subscriber_id:sub,provider:'rule',model:'rule',mode:'rule',role:'recharge',intent:'recharge_account',route_layer:'rule_recharge_acct',user_msg:'[redacted]',success:true});
        return res.json({ ok:true, mode:'rule', provider:'rule', role:'recharge', intent:'recharge_account', route_layer:'rule_recharge_acct', reply:_raReply, ms:Date.now()-t0 });
      }
      if(/\bUC\b|diamonds?|جواهر|جوهر[ةت]?|شحن|top.?up|recharge|coins?|كوينز|شدات|دياموند/i.test(_luR)){
        var _qtyR=(_luR.match(/(\d{3,7})/)||[])[1]; var _isV=!!_qtyR && parseInt(_qtyR)>=5000; var _rc=_isV?'VIP_RECHARGE':'HOT_LEAD';
        (async()=>{ try{ var _rdup=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code=$2 AND created_at>now()-interval '2 hours' LIMIT 1",[String(sub),_rc]);
          if(!_rdup.rows.length){ await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),customer_name:b.first_name||null,channel:b.channel||null,reason_code:_rc,reason_detail:_isV?'طلب شحن كبير (VIP) — مراجعة بشرية':'نية شحن (Recharge) — Buyer Hot',customer_message:_luR.slice(0,300)})}); }
        }catch(_e){} })();
      }
    }
    // PAYMENT-METHOD SAFETY: customer named a non-official method -> never agree, steer to official + flag human
    if(sub && typeof _lu==='string' && /paypal|باي\s?بال|بايبال|payoneer|بايونير|skrill|سكريل|western\s?union|ويسترن\s?يونيون|moneygram|orange\s?money|أورنج\s?موني|اورنج\s?موني|inwi\s?money|انوي\s?موني|m-?t\s?cash|mtcash|إم\s?تيكاش|ام\s?تيكاش|damane\s?cash|دامان\s?كاش|wari\s?cash|واري\s?كاش|chaabi\s?cash/i.test(_lu)){
      (async()=>{ try{ const _mdup=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code='PAYMENT_METHOD_UNKNOWN' AND created_at>now()-interval '6 hours' LIMIT 1",[String(sub)]);
        if(!_mdup.rows.length){ await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),customer_name:b.first_name||null,channel:b.channel||null,reason_code:'PAYMENT_METHOD_UNKNOWN',reason_detail:'الزبون ذكر طريقة دفع غير رسمية — تأكيد بشري (ممنوع يخلّص بها)',customer_message:_lu.slice(0,300)})}); } }catch(_e){} })();
      var _pm2=await _payMethods();
      var _pmNames2=(_pm2&&_pm2.length)?_pm2.map(function(m){return m.name;}).join(' / '):'CIH / Barid Bank / Binance USDT';
      var _pmReply='الطرق المضمونة عندنا هي: '+_pmNames2+' 🔒 فقط. هاد الطريقة لي ذكرتي ما كاينة عندنا — حيد ماتخلّصش بها باش مايضيعش ليك والو. أشمن واحدة من الطرق الرسمية تناسبك؟';
      _logAiUsage({subscriber_id:sub,provider:'rule',model:'rule',mode:'rule',role:'payment',intent:'payment_method_unknown',route_layer:'rule_paymethod',user_msg:_lu.slice(0,200),success:true});
      return res.json({ ok:true, mode:'rule', provider:'rule', role:'payment', intent:'payment_method_unknown', route_layer:'rule_paymethod', reply:_pmReply, ms:Date.now()-t0 });
    }
    if(sub && typeof _lu==='string' && /خلّصت|خلصت|صيفطت التحويل|صيفطت ليك|صفطت التحويل|صفطت ليك|سيفطت التحويل|حولت ليك|حولت لك|حوّلت ليك|رسلت الفلوس|رسلت ليك الفلوس|دفعت ليك|خلصتك|عيطت ليك التحويل/i.test(_lu)){
      (async()=>{ try{ const _pdup=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code='PAYMENT_INTENT' AND created_at>now()-interval '3 hours' LIMIT 1",[String(sub)]);
        if(!_pdup.rows.length){ await fetch('http://localhost:4000/api/payment-claims',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),customer_name:b.first_name||null,channel:b.channel||null,source:'text',raw_message:_lu.slice(0,300),is_test:(b.is_test===true||b.is_test==='1'||b.is_test===1||b.is_test==='true')})}).catch(function(){});
          await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),customer_name:b.first_name||null,channel:b.channel||null,reason_code:'PAYMENT_INTENT',reason_detail:'الزبون قال إنه خلّص/صيفط التحويل (نص) — تحقّق بشري فقط',customer_message:_lu.slice(0,300)})}); } }catch(_e){} })();
      var _payReply='وصلنا أنك صيفطي التحويل 🙏 باش نأكدو بسرعة عافاك صيفط لينا screenshot ديال الدفع. الفريق غادي يتحقّق ويتواصل معاك قريباً 😊';
      _logAiUsage({subscriber_id:sub,provider:'rule',model:'rule',mode:'rule',role:'payment',intent:'payment_claim',route_layer:'rule_payment',user_msg:_lu.slice(0,200),success:true});
      return res.json({ ok:true, mode:'rule', provider:'rule', role:'payment', intent:'payment_claim', route_layer:'rule_payment', reply:_payReply, ms:Date.now()-t0 });
    }
    var _lastAsst=(messages.filter(function(m){return m.role==='assistant';}).slice(-1)[0]||{}).content||'';
    var _offeredResv=/نحجز|نحجزو|نحجزه|نحجزها|الحجز|تسبيق|نحجزو ليك/i.test(_lastAsst);
    var _affirmYes=(typeof _lu==='string' && _lu.trim().length<=30 && /(^|[\s،,.!])(نعم|ايه|إيه|اه|آه|واخا|واخّا|موافق|أوكي|اوكي|اوكاي|أوكاي|ok|okay|oui|yes|safi|صافي|wakha|d'accord)([\s،,.!]|$)/i.test(_lu.trim()));
    if(_route.role==='sales' && sub && typeof _lu==='string' && (/موافق نحجز|واخا نحجز|واخا احجز|نعم احجز|احجزها ليا|احجزها|بغيت تحجزها|دير ليا الحجز|نحجزها|واخا الحجز/i.test(_lu) || (_offeredResv && _affirmYes))){ (async()=>{ try{ const _rdup=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code='RESERVATION' AND created_at>now()-interval '6 hours' LIMIT 1",[String(sub)]); if(!_rdup.rows.length){ await pool.query("INSERT INTO aykoshop_deposits (subscriber_id, customer_name, channel, requested_product, status, created_at) VALUES ($1,$2,$3,$4,'reserved',NOW())",[String(sub), b.first_name||null, b.channel||null, _lu.slice(0,200)]).catch(function(){}); await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),customer_name:b.first_name||null,channel:b.channel||null,reason_code:'RESERVATION',reason_detail:'الزبون وافق على الحجز — سجّل/أكّد بشرياً',customer_message:_lu.slice(0,300)})}); } }catch(_e){} })(); }
    if(_route.role==='sales' && sub && typeof _lu==='string' && (['payment','buy','buyer_hot'].includes(_route.intent) || /عطيني طريقة الدفع|كيفاش نخلص|كيفاش نخلّص|واجد نخلص|واجد نخلّص|مستعد نخلص|باغي نخلص|بغيت نخلص|نحجز ليا|حجز ليا|موافق نشري/i.test(_lu)) && !/\bUC\b|diamonds?|جواهر|جوهر[ةت]?|شحن|top.?up|recharge|coins?|كوينز|شدات|دياموند/i.test(_lu)){ (async()=>{ try{ const _dup=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code='HOT_LEAD' AND created_at>now()-interval '2 hours' LIMIT 1",[String(sub)]); if(!_dup.rows.length){ await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),channel:b.channel||null,reason_code:'HOT_LEAD',reason_detail:'الزبون جاهز للشراء أو الدفع',customer_message:_lu.slice(0,300)})}); } }catch(_e){} })(); }
    var _isGreetRC = (typeof _lu==='string') && _lu.trim().length<=18 && /^\s*(سلام|السلام|صباح|مسا|اهلا|أهلا|اهلين|هاي|سالام|hi|hello|hey|salam|slm|bonjour|cava|cv)(\s|$)/i.test(_lu.trim());
    var _BCTX = (sub && (_route.role==='sales'||_route.role==='support') && !_route.reply) ? await _buyerContext(sub) : null;
    if(_isGreetRC && _BCTX && /نوع=|شراءات=|لعبة=|حجوزات=/.test(_BCTX) && _route.role!=='sales'){ _route.role='sales'; _route.primary=(cfg.roles&&cfg.roles.sales)||'openai'; _route.fallback=(cfg.roles&&cfg.roles.failover)||'anthropic'; _route.support_prompt=undefined; _route.intent='returning_greeting'; _route.route_layer='returning_greeting'; }
    const primary = b.primary || _route.primary; const fallback = b.fallback || _route.fallback; const _role=_route.role; const _intent=_route.intent; const _rl=_route.route_layer||'regex'; const _msg=(typeof _lu==='string'?_lu:'').slice(0,200);
    if(_route.reply){ _logAiUsage({subscriber_id:sub,provider:'rule',model:'rule',mode:'rule',role:_role,intent:_intent,route_layer:_rl,user_msg:_msg,success:true}); return res.json({ ok:true, mode:'rule', provider:'rule', role:_role, intent:_intent, route_layer:_rl, decision_reason:_route.reason, reply:_route.reply, ms:Date.now()-t0 }); }
    // HITL RAG: search learned knowledge (non-sensitive only)
    let _kbCtx=null, _kbSim=0;
    if(sub && typeof _lu==='string' && _lu.length>=6 && ['sales','support'].indexOf(_role)>=0 && ['payment','takeover','trade_request'].indexOf(_intent)<0){
      try{ const _km=await _kbMatch(_lu);
        if(_km){ _kbSim=_km.sim;
          if(_km.sim>=0.70){ pool.query('UPDATE aykoshop_conversation_examples SET usage_count=usage_count+1, last_used=NOW() WHERE id=$1',[_km.id]).catch(function(){}); _logAiUsage({subscriber_id:sub,provider:'kb',model:'kb',mode:'kb',role:_role,intent:_intent,route_layer:'kb_high',user_msg:_msg,success:true}); return res.json({ ok:true, mode:'kb', provider:'kb', role:_role, intent:_intent, route_layer:'kb_high', kb_sim:_km.sim, reply:_km.reply, ms:Date.now()-t0 }); }
          else if(_km.sim>=0.55){ _kbCtx=_km.reply; pool.query('UPDATE aykoshop_conversation_examples SET usage_count=usage_count+1, last_used=NOW() WHERE id=$1',[_km.id]).catch(function(){}); }
        }
      }catch(_e){}
    }
    let _genMsgs = messages;
    if(_route.support_prompt){ _genMsgs = [{role:'system',content:_route.support_prompt}].concat(messages.filter(m=>m.role!=='system')); if(_BCTX){ _genMsgs=[{role:'system',content:_BCTX}].concat(_genMsgs); } }
    else if(_route.role==='sales'){ try{ const _ag=await getAgents(); const _sp=_ag.seller; if(_sp && _sp.enabled!==false && _sp.prompt && _sp.prompt.length>40){ _genMsgs=[{role:'system',content:_sp.prompt}].concat(messages); } const _cat=await _catalogContext(_lu); if(_cat){ _genMsgs=[{role:'system',content:_cat}].concat(_genMsgs); } if(_BCTX){ _genMsgs=[{role:'system',content:_BCTX}].concat(_genMsgs); } }catch(e){} }
    if(_kbCtx){ _genMsgs=[{role:'system',content:'📚 معرفة معتمدة (جواب صحيح لسؤال مشابه سابق — استعملها إيلا كانت مناسبة، بلا أثمنة): '+_kbCtx}].concat(_genMsgs); }
    const tried=[];
    const pEnabled = cfg.providers[primary]!==false && _AI_CALL[primary] && circuitAllows(primary);
    if(pEnabled){
      const a0=Date.now();
      try{ const r = await _AI_CALL[primary](_genMsgs, Object.assign({}, opt, { model:_modelOf(primary,cfg), timeout:9000, log:false }));
        tried.push({provider:primary, ok:r.ok, status:r.status, error:r.error});
        _logAiUsage({subscriber_id:sub,provider:primary,model:_modelOf(primary,cfg),mode:'primary',role:_role,intent:_intent,route_layer:_rl,user_msg:_msg,tokens_in:(r.usage&&r.usage.in)||0,tokens_out:(r.usage&&r.usage.out)||0,latency_ms:Date.now()-a0,success:r.ok,detail:r.error});
        if(r.ok){ circuitRecord(primary,true,'ai/generate ok'); _maybeCaptureUnknown(sub,b,_lu,r.text,_role,_intent,_kbSim); const _vv=await _applyVerifier(r.text,sub,b,_intent,_role,_lu); return res.json({ ok:true, mode:'primary', provider:primary, model:_modelOf(primary,cfg), role:_role, intent:_intent, route_layer:(_vv.blocked?'verifier_block':_rl), decision_reason:_route.reason, reply:_vv.reply, verifier_blocked:!!_vv.blocked, usage:r.usage, ms:Date.now()-t0, tried }); }
        circuitRecord(primary,false,(r.error||'no_text').slice(0,90));
      }catch(e){ tried.push({provider:primary, ok:false, error:String(e.message||e).slice(0,120)}); _logAiUsage({subscriber_id:sub,provider:primary,model:_modelOf(primary,cfg),mode:'primary',role:_role,intent:_intent,route_layer:_rl,user_msg:_msg,latency_ms:Date.now()-a0,success:false,detail:String(e.message||e)}); circuitRecord(primary,false,String(e.message||e).slice(0,90)); }
    } else { tried.push({provider:primary, ok:false, error:'disabled_or_circuit_open'}); }
    const elapsed=Date.now()-t0;
    const fEnabled = fallback && fallback!==primary && cfg.providers[fallback]!==false && _AI_CALL[fallback] && circuitAllows(fallback);
    if(fEnabled){
      const a1=Date.now();
      try{ const r = await _AI_CALL[fallback](_genMsgs, Object.assign({}, opt, { model:_modelOf(fallback,cfg), timeout:8000, max_tokens:Math.min(opt.max_tokens||260,260), log:false }));
        tried.push({provider:fallback, ok:r.ok, status:r.status, error:r.error});
        _logAiUsage({subscriber_id:sub,provider:fallback,model:_modelOf(fallback,cfg),mode:'fallback',role:_role,intent:_intent,route_layer:_rl,user_msg:_msg,tokens_in:(r.usage&&r.usage.in)||0,tokens_out:(r.usage&&r.usage.out)||0,latency_ms:Date.now()-a1,success:r.ok,detail:r.error});
        if(r.ok){ circuitRecord(fallback,true,'ai/generate fallback ok'); _maybeCaptureUnknown(sub,b,_lu,r.text,_role,_intent,_kbSim); const _vv=await _applyVerifier(r.text,sub,b,_intent,_role,_lu); return res.json({ ok:true, mode:'fallback', provider:fallback, model:_modelOf(fallback,cfg), role:_role, intent:_intent, route_layer:(_vv.blocked?'verifier_block':_rl), decision_reason:_route.reason, reply:_vv.reply, verifier_blocked:!!_vv.blocked, usage:r.usage, ms:Date.now()-t0, tried }); }
        circuitRecord(fallback,false,(r.error||'no_text').slice(0,90));
      }catch(e){ tried.push({provider:fallback, ok:false, error:String(e.message||e).slice(0,120)}); _logAiUsage({subscriber_id:sub,provider:fallback,model:_modelOf(fallback,cfg),mode:'fallback',role:_role,intent:_intent,route_layer:_rl,user_msg:_msg,latency_ms:Date.now()-a1,success:false,detail:String(e.message||e)}); circuitRecord(fallback,false,String(e.message||e).slice(0,90)); }
    } else if(fEnabled){ tried.push({provider:fallback, ok:false, error:'no_budget_elapsed_'+elapsed}); }
    _logAiUsage({subscriber_id:sub,mode:'failed',role:_role,success:false,detail:'all_failed'});
    // SAFE-FLOOR: never leave the customer with an empty reply — deterministic holding reply + Telegram escalation
    if(sub){ (async()=>{ try{ const _sfd=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code='AI_REPLY_FAILED' AND created_at>now()-interval '1 hour' LIMIT 1",[String(sub)]); if(!_sfd.rows.length){ await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),customer_name:b.first_name||null,channel:b.channel||null,reason_code:'AI_REPLY_FAILED',reason_detail:'فشل الذكاء (primary+fallback) — رد احتياطي للزبون + تدخّل بشري عاجل',customer_message:(typeof _lu==='string'?_lu:'').slice(0,300)})}); } }catch(_e){} })(); }
    return res.json({ ok:true, mode:'safe_floor', provider:'safe_floor', role:_role, intent:_intent, route_layer:'safe_floor', reply:'سمح ليا خويا 🙏 وقع ضغط شوية دابا. وصلني سؤالك وغادي يتواصل معاك الفريق ديالنا بسرعة. ولا عاود صيفط رسالتك من بعد شوية ونكملو 😊', ms:Date.now()-t0, tried });
  } catch(e){ return res.status(500).json({ ok:false, mode:'error', error:e.message }); }
});
async function _visionFraud(url){
  try{
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':'Bearer '+_OPENAI_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',max_tokens:140,temperature:0,messages:[{role:'system',content:'You assess a payment/transfer screenshot for FRAUD SIGNALS ONLY. You DO NOT confirm or reject the payment. Return STRICT JSON: {\"score\":\"low|medium|high\",\"reasons\":[]} where each reason is one of: edited_screenshot, old_screenshot, missing_details, suspicious_amount, not_a_bank, low_quality, duplicate_screenshot. If it does NOT clearly look like a real bank/transfer/payment screenshot, use score high with reason not_a_bank. If it looks normal, score low with empty reasons.'},{role:'user',content:[{type:'text',text:'Assess this screenshot. JSON only.'},{type:'image_url',image_url:{url:url}}]}]}),signal:AbortSignal.timeout(9000)});
    const j=await r.json(); let t=(((j.choices||[])[0]||{}).message||{}).content||''; t=t.replace(/```json|```/g,'').trim();
    const o=JSON.parse(t); return {score:(['low','medium','high'].indexOf(o.score)>=0?o.score:'low'), reasons:Array.isArray(o.reasons)?o.reasons.slice(0,6):[]};
  }catch(e){ return {score:'low', reasons:[]}; }
}
async function _visionClassify(url, prompt){
  try{ const r=await _callOpenAI([{role:'user',content:[{type:'text',text:(prompt||'صنّف الصورة، أرجع كلمة وحدة: PAYMENT PRODUCT ACCOUNT OTHER')},{type:'image_url',image_url:{url}}]}], {model:'gpt-4o-mini', max_tokens:5, temperature:0, timeout:7000});
    if(!r.ok) return {label:null,usage:r.usage||{}}; const lab=(r.text||'').toUpperCase().replace(/[^A-Z]/g,'');
    return {label:(['PAYMENT','PRODUCT','ACCOUNT','OTHER'].includes(lab)?lab:null), usage:r.usage||{}}; }catch(e){ return {label:null,usage:{}}; }
}
// VISION = DESCRIBE ONLY (structured), never match/sell. Returns {is_payment,game,product_type,items,visible_text}.
async function _visionExtractStruct(url){
  const prompt='حلّل هاد الصورة وصفياً فقط، ماتطابقش مع أي منتج. رجّع JSON فقط: {"is_payment": true إيلا صورة دفع/تحويل بنكي/سكرين خلاص (تطبيق بنكي فيه مبلغ مدفوع/محوّل: CIH/Barid/Wafacash/Cash Plus/Binance/RIB) — ماشي صورة منتج ولا لعبة ولا جواهر ولا سكنات ولا عرض. وإلا false, "game":"اسم اللعبة/المنصة الباينة فالصورة أو null", "product_type":"account|skin|weapon|bundle|membership|code|recharge|service|other أو null", "items":"أهم العناصر الباينة (سكنات/أسلحة/رتبة/جواهر/عدد)", "visible_text":"النص المكتوب فالصورة"}';
  try{ const r=await _callOpenAI([{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:url}}]}],{model:'gpt-4o',max_tokens:320,temperature:0.2,timeout:9000,log:false});
    if(!r.ok) return null; let an={}; try{ an=JSON.parse(String(r.text||'').replace(/```json|```/g,'').trim()); }catch(e){ an={}; }
    an._in=(r.usage&&r.usage.in)||0; an._out=(r.usage&&r.usage.out)||0; return an;
  }catch(e){ return null; }
}
function _visionTypeToService(t){ t=String(t||'').toLowerCase(); if(/account|كونط|حساب/.test(t)) return 'account'; if(/skin|weapon|bundle|code|سكن|سلاح|كود|رقص/.test(t)) return 'code'; if(/member|recharge|sub|شحن|اشتراك|جواهر|diamond/.test(t)) return 'recharge'; return null; }
async function _visionExtract(url, prompt, products){
  const pl=(products||[]).map(p=>p.product_name+' - '+p.price+(p.category?' ('+p.category+')':'')).join('\n');
  const full=(prompt||'حلّل الصورة')+'\n\nالكاطالوج المتوفّر:\n'+pl+'\n\nرجّع JSON فقط: {"specs":"وصف قصير","found_match":true,"matched_product":"","matched_price":""}';
  try{ const r=await _callOpenAI([{role:'user',content:[{type:'text',text:full},{type:'image_url',image_url:{url}}]}], {model:'gpt-4o', max_tokens:300, temperature:0.4, timeout:8000, log:false});
    if(!r.ok) return null; let an={specs:'',found_match:false,matched_product:'',matched_price:''};
    try{ an=JSON.parse((r.text||'').replace(/```json|```/g,'').trim()); }catch(e){}
    an._in=(r.usage&&r.usage.in)||0; an._out=(r.usage&&r.usage.out)||0; return an; }catch(e){ return null; }
}
// ==================== STRICT GATES — Output Verifier + Vision discovery + Protection ====================
// Deterministic anti-invention guard. Catalog = source of truth. Any non-catalog product offered affirmatively → BLOCK + escalate.
let _catGamesCache={t:0,v:['free fire']};
async function _catalogGames(){ if(Date.now()-_catGamesCache.t<60000) return _catGamesCache.v;
  try{ const r=await pool.query("SELECT DISTINCT lower(game) g FROM aykoshop_products WHERE game IS NOT NULL AND status='available'");
    const g=r.rows.map(x=>(x.g||'').trim()).filter(Boolean); _catGamesCache={t:Date.now(), v:(g.length?g:['free fire'])};
  }catch(e){ _catGamesCache.t=Date.now(); }
  return _catGamesCache.v;
}
let _catUniCache={t:0,v:['free fire']};
async function _catalogUniverse(){ if(Date.now()-_catUniCache.t<60000) return _catUniCache.v;
  try{ const r=await pool.query("SELECT DISTINCT lower(trim(x)) g FROM (SELECT game x FROM aykoshop_products WHERE status='available' AND game IS NOT NULL UNION ALL SELECT attributes->>'platform' FROM aykoshop_products WHERE status='available' AND attributes->>'platform' IS NOT NULL UNION ALL SELECT attributes->>'service' FROM aykoshop_products WHERE status='available' AND attributes->>'service' IS NOT NULL) q WHERE x IS NOT NULL AND trim(x)<>''");
    const g=r.rows.map(function(x){return (x.g||'').trim();}).filter(Boolean); _catUniCache={t:Date.now(), v:(g.length?g:['free fire'])};
  }catch(e){ _catUniCache.t=Date.now(); }
  return _catUniCache.v;
}
let _slotModeCache={t:0,v:'off'};
async function _slotsMode(){ if(Date.now()-_slotModeCache.t<30000) return _slotModeCache.v; try{ const r=await pool.query("SELECT value FROM aykoshop_settings WHERE key='ff_slot_engine'"); const v=(r.rows[0]||{}).value; _slotModeCache={t:Date.now(), v:(['off','shadow','on'].indexOf(v)>=0?v:'off')}; }catch(e){ _slotModeCache.t=Date.now(); } return _slotModeCache.v; }
async function _v2Slots(reqs, collected, lu){
  reqs=Array.isArray(reqs)?reqs:[]; collected=collected||{};
  if(reqs.length && String(lu||'').trim()){
    try{
      var fieldList=reqs.map(function(r){return r.field+' ('+(r.label||r.field)+')';}).join(', ');
      var sys='استخرج من رسالة الزبون القيم لهاد الحقول إلى وُجدت: '+fieldList+'. رجّع JSON فقط بهاد المفاتيح: {'+reqs.map(function(r){return '"'+r.field+'":"<القيمة أو فارغ>"';}).join(',')+'}. لا تخترع؛ إلى ما عطاهاش القيمة خليها فارغة.';
      var r=await _callClaude([{role:'system',content:sys},{role:'user',content:String(lu).slice(0,400)}],{model:'claude-haiku-4-5',max_tokens:200,temperature:0,timeout:8000});
      if(r.ok){ var ex=_v2ParseJSON(r.text)||{}; reqs.forEach(function(rq){ var v=ex[rq.field]; if(v!=null && String(v).trim()!=='' && String(v).toLowerCase()!=='null') collected[rq.field]=String(v).trim(); }); }
    }catch(e){}
  }
  var missing=reqs.filter(function(r){ return r.required && !collected[r.field]; });
  if(missing.length){ var nx=missing[0]; return {done:false, collected:collected, missing:missing.map(function(m){return m.field;}), ask:('باش نكمّل ليك خويا 🙏 عطيني '+(nx.label||nx.field))}; }
  return {done:true, collected:collected, missing:[]};
}
// Universe of offerings customers mention. A match that is NOT in the catalog, offered without negation → invention.
const _KNOWN_OFFERINGS=[
  ['Free Fire',/free ?fire|فري ?فاير|freefire|\bff\b/i],
  ['FIFA/FC',/\bfifa\b|فيفا|\bfc ?2[0-9]\b/i],
  ['PUBG',/\bpubg\b|ببجي|بوبجي/i],
  ['eFootball/PES',/efootball|e-?football|\bpes\b|ايفوتبول|\bبيس\b/i],
  ['Fortnite',/fortnite|فورتنايت|فورت ?نايت/i],
  ['Roblox',/roblox|روبلوكس|روبلوك/i],
  ['Valorant',/valorant|فالورانت|فالورنت/i],
  ['Call of Duty',/call ?of ?duty|\bcodm?\b|كود ?موبايل/i],
  ['Mobile Legends',/mobile ?legends|\bmlbb\b|موبايل ?ليجندز/i],
  ['Clash',/clash ?of ?clans|clash ?royale|كلاش ?اوف|كلاش ?رويال/i],
  ['Brawl Stars',/brawl ?stars|براول ?ستارز/i],
  ['GTA',/\bgta\b|قراند|جي ?تي ?ايه/i],
  ['Minecraft',/minecraft|ماين ?كرافت/i],
  ['Genshin',/genshin|جينشن/i],
  ['iTunes',/itunes|اي ?تيونز|ايتونز/i],
  ['Google Play',/google ?play|جوجل ?بلاي|كوكل ?بلاي/i],
  ['Netflix',/netflix|نتفليكس|نيتفليكس/i],
  ['Spotify',/spotify|سبوتيفاي/i],
  ['Discord Nitro',/discord ?nitro|ديسكورد ?نيترو/i],
];
const _STRICT_NEG=/ماعندنا|ما ?عندنا|عندناش|ماكاين|ما ?كاين|كاينش|مالقيت|ما ?لقيت|لقيتش|ماشي ?عندنا|ماكنوفرو|ما ?كنوفرو|كنوفروش|للأسف|حالي?اً ?ما|دابا ?ما|مازال ?ما|ماتوفرش|ما ?متوفر|غير ?فري ?فاير|بطلب ?خاص|نتأكد|نرجع ?ليك/i;

// returns {ok:true} or {ok:false, item} if reply affirmatively offers a non-catalog product
async function _outputVerify(reply){
  const text=String(reply||''); if(!text) return {ok:true};
  const catGames=await _catalogUniverse();
  const inCatalog=(re)=> catGames.some(cg=>re.test(cg));
  const hasNeg=_STRICT_NEG.test(text);
  for(const [label,re] of _KNOWN_OFFERINGS){
    if(inCatalog(re)) continue;            // it IS in the catalog → allowed
    if(re.test(text) && !hasNeg) return {ok:false, item:label};  // affirmative offer of a non-catalog product
  }
  return {ok:true};
}

let _verModeCache={t:0,v:'enforce'};
async function _verifierMode(){ if(Date.now()-_verModeCache.t<30000) return _verModeCache.v;
  try{ const r=await pool.query("SELECT value FROM aykoshop_settings WHERE key='output_verifier'"); const v=(r.rows[0]||{}).value; _verModeCache={t:Date.now(), v:(['off','shadow','enforce'].indexOf(v)>=0?v:'enforce')}; }catch(e){ _verModeCache.t=Date.now(); }
  return _verModeCache.v;
}
const _VERIFIER_BLOCK_REPLY='سمح ليا خويا 🙏 خصني نتأكد ليك من هاد المنتج مع الفريق قبل ما نأكد ليك حتى حاجة. نرجع ليك بسرعة 😊';

// Price floor gate: blocks AI replies quoting below min_price for the active product
async function _priceClamp(reply, ctx){
  try{
    const product=String(ctx&&(ctx.product||ctx.interested_in)||'').toLowerCase().trim();
    if(!product) return {ok:true};
    // Extract 2-4 digit prices from reply (DH / درهم / بـXX patterns)
    const rtext=String(reply||'');
    const priceRe=/(?:بـ?|ب\s+)(\d{2,4})(?:\s*(?:درهم?|dh))?|\b(\d{2,4})\s*(?:درهم?|dh)\b/gi;
    const nums=[]; let m;
    while((m=priceRe.exec(rtext))!==null){ const n=parseInt(m[1]||m[2]); if(n>=50&&n<=9999) nums.push(n); }
    if(!nums.length) return {ok:true};
    const pr=await pool.query("SELECT min_price,price_value FROM aykoshop_products WHERE status='available' AND LOWER(product_name) ILIKE $1 LIMIT 1",['%'+product+'%']).catch(()=>({rows:[]}));
    if(!pr.rows.length) return {ok:true};
    const minP=parseFloat(pr.rows[0].min_price)||parseFloat(pr.rows[0].price_value)||0;
    if(!minP) return {ok:true};
    const below=nums.filter(p=>p<minP);
    if(below.length) return {ok:false,item:'price_below_floor',quoted:below[0],min_price:minP,product};
    return {ok:true};
  }catch(e){ return {ok:true}; }
}

// post-generation gate: returns {reply, blocked}. shadow=log only; enforce=replace+escalate.
async function _applyVerifier(reply, sub, b, intent, role, lu, ctx={}){
  try{
    const mode=await _verifierMode();
    if(mode==='off') return {reply, blocked:false};
    if(['takeover','payment'].indexOf(role)>=0) return {reply, blocked:false};
    const v=await _outputVerify(reply);
    if(!v.ok){
      pool.query("INSERT INTO aykoshop_verifier_log (subscriber_id,user_msg,ai_reply,blocked_game,mode) VALUES ($1,$2,$3,$4,$5)",[sub?String(sub):null,String(lu||'').slice(0,300),String(reply).slice(0,500),v.item,mode]).catch(()=>{});
      if(mode==='shadow') return {reply, blocked:false, shadow:true, item:v.item};
      if(sub && /^[0-9]+$/.test(String(sub))){ (async()=>{ try{ const d=await pool.query("SELECT 1 FROM aykoshop_interventions WHERE subscriber_id=$1 AND reason_code='AI_INVENTED' AND created_at>now()-interval '2 hours' LIMIT 1",[String(sub)]); if(!d.rows.length){ await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:String(sub),customer_name:(b&&b.first_name)||null,channel:(b&&b.channel)||null,reason_code:'AI_INVENTED',reason_detail:'الـVerifier حجب رد فيه منتج خارج الكاطالوج ('+v.item+') — تدخّل بشري',customer_message:String(lu||'').slice(0,300),ai_last_reply:String(reply).slice(0,300)})}); } }catch(_e){} })(); }
      return {reply:_VERIFIER_BLOCK_REPLY, blocked:true, item:v.item};
    }
    // Price floor gate: AI must not quote below min_price
    const pc=await _priceClamp(reply, ctx);
    if(!pc.ok){
      pool.query("INSERT INTO aykoshop_verifier_log (subscriber_id,user_msg,ai_reply,blocked_game,mode) VALUES ($1,$2,$3,$4,$5)",[sub?String(sub):null,String(lu||'').slice(0,300),String(reply).slice(0,500),'price_below_floor:'+pc.quoted+'<'+pc.min_price,mode]).catch(()=>{});
      if(mode==='shadow') return {reply, blocked:false, shadow:true, item:'price_below_floor', detail:pc};
      return {reply:_VERIFIER_BLOCK_REPLY, blocked:true, item:'price_below_floor', detail:pc};
    }
    return {reply, blocked:false};
  }catch(e){ return {reply, blocked:false}; }
}

// Vision: structured discovery (buy/sell + where-seen) for non-payment images with no clear intent
function _visionAskReply(){ return 'وصلاتني الصورة 🙏 باش نعاونك مزيان: واش باغي تشري ولا تبيع؟ وفين شفتي هاد السلعة — واتساب، ستوري واتساب، فيسبوك، ولا إنستغرام؟'; }

// Protection status (dashboard)
app.get('/api/ai/protection', async (req,res)=>{ try{
  const mode=await _verifierMode();
  const cnt=await pool.query("SELECT count(*)::int n, count(*) FILTER(WHERE created_at>now()-interval '24 hours')::int d FROM aykoshop_verifier_log").catch(()=>({rows:[{n:0,d:0}]}));
  const recent=await pool.query("SELECT subscriber_id,left(user_msg,60) user_msg,blocked_game,mode,created_at FROM aykoshop_verifier_log ORDER BY id DESC LIMIT 15").catch(()=>({rows:[]}));
  const games=await _catalogGames();
  res.json({ output_verifier:mode, total_blocks:(cnt.rows[0]||{}).n||0, blocks_24h:(cnt.rows[0]||{}).d||0, recent:recent.rows, catalog_games:games, telegram_learning_msgs:10 });
}catch(e){ res.status(500).json({error:e.message}); } });

app.post('/api/ai/protection', async (req,res)=>{ try{
  const b=req.body||{};
  if(b.output_verifier && ['off','shadow','enforce'].indexOf(b.output_verifier)>=0){ await pool.query("INSERT INTO aykoshop_settings(key,value) VALUES('output_verifier',$1) ON CONFLICT(key) DO UPDATE SET value=$1",[b.output_verifier]); _verModeCache={t:0,v:b.output_verifier}; }
  res.json({ ok:true, output_verifier:(await _verifierMode()) });
}catch(e){ res.status(500).json({error:e.message}); } });
// ==================== AI REVIEW CENTER ====================
// Unified audit/inspection endpoint — no duplicate of aiQuality/aiControl/aiLearning
// Sections: summary | safety | decisions | financial | bugs | replay
app.get('/api/review/center', async (req,res)=>{
  try{
    const section=String(req.query.section||'summary');
    const limit=Math.min(parseInt(req.query.limit)||50,200);
    const q=String(req.query.q||'').trim().toLowerCase();
    const from=req.query.from?new Date(req.query.from):null;
    const to=req.query.to?new Date(req.query.to):null;
    const isExport=req.query.export==='csv';

    const dateFilter=(col)=>{
      const parts=[]; const vals=[];
      if(from){ parts.push(col+' >= $'+(vals.length+1)); vals.push(from); }
      if(to){ parts.push(col+' <= $'+(vals.length+1)); vals.push(to); }
      return {where:parts.length?'AND '+parts.join(' AND '):'', vals};
    };

    if(section==='summary'){
      const [safe,dec,interv]=await Promise.all([
        pool.query("SELECT COUNT(*)::int total, COUNT(*) FILTER(WHERE created_at>now()-interval '24h')::int last24h, COUNT(*) FILTER(WHERE blocked_game LIKE 'price%')::int price_blocks, COUNT(*) FILTER(WHERE blocked_game NOT LIKE 'price%')::int game_blocks FROM aykoshop_verifier_log").catch(()=>({rows:[{total:0,last24h:0,price_blocks:0,game_blocks:0}]})),
        pool.query("SELECT COUNT(*)::int total, COUNT(*) FILTER(WHERE success=true)::int ok, COUNT(*) FILTER(WHERE created_at>now()-interval '24h')::int last24h, COUNT(*) FILTER(WHERE success=false)::int failed FROM aykoshop_ai_usage WHERE created_at>now()-interval '7 days'").catch(()=>({rows:[{total:0,ok:0,last24h:0,failed:0}]})),
        pool.query("SELECT COUNT(*)::int total, COUNT(*) FILTER(WHERE created_at>now()-interval '24h')::int last24h FROM aykoshop_interventions WHERE created_at>now()-interval '7 days'").catch(()=>({rows:[{total:0,last24h:0}]}))
      ]);
      // Read replay results file if exists
      let replaySummary={replayed:0,regressions:0,rate:0,last_run:null};
      let pqaSummary={total:0,pass:0,fail:0,last_run:null};
      try{
        const fs=require('fs');
        if(fs.existsSync('/var/www/backend/replay_results.json')){
          const rr=JSON.parse(fs.readFileSync('/var/www/backend/replay_results.json','utf8'));
          if(Array.isArray(rr)){ const regressions=rr.filter(x=>x.regression).length; replaySummary={replayed:rr.length,regressions,rate:rr.length?Math.round(regressions/rr.length*100*10)/10:0,last_run:rr.length&&rr[0].ts?rr[0].ts:null}; }
          else if(rr.replayed!=null){ replaySummary={replayed:rr.replayed||0,regressions:rr.regressions||0,rate:rr.rate||0,last_run:rr.ts||null}; }
        }
        if(fs.existsSync('/var/www/backend/pqa_baseline.json')){
          const pqa=JSON.parse(fs.readFileSync('/var/www/backend/pqa_baseline.json','utf8'));
          const keys=Object.keys(pqa); const fail=keys.filter(k=>!pqa[k].assertion_ok).length;
          pqaSummary={total:keys.length,pass:keys.length-fail,fail,last_run:null};
        }
      }catch(_fe){}
      const sd=safe.rows[0]||{}; const dd=dec.rows[0]||{}; const id=interv.rows[0]||{};
      return res.json({ok:true,section:'summary',
        safety:{total:sd.total||0,last24h:sd.last24h||0,price_blocks:sd.price_blocks||0,game_blocks:sd.game_blocks||0},
        decisions:{total:dd.total||0,ok:dd.ok||0,failed:dd.failed||0,last24h:dd.last24h||0,success_rate:dd.total?Math.round(dd.ok/dd.total*100*10)/10:0},
        interventions:{total:id.total||0,last24h:id.last24h||0},
        replay:replaySummary, pqa:pqaSummary
      });
    }

    if(section==='safety'||section==='financial'||section==='bugs'){
      let where='WHERE 1=1'; const vals=[];
      if(section==='financial'){ where+=" AND blocked_game LIKE 'price%'"; }
      else if(section==='bugs'){ where+=" AND (blocked_game NOT LIKE 'price%' OR mode='shadow')"; }
      if(q){ vals.push('%'+q+'%'); where+=' AND (LOWER(blocked_game) LIKE $'+vals.length+' OR LOWER(user_msg) LIKE $'+vals.length+' OR LOWER(subscriber_id::text) LIKE $'+vals.length+')'; }
      const df=dateFilter('created_at'); where+=df.where; const allVals=vals.concat(df.vals);
      const limitVal=allVals.length+1;
      const rows=await pool.query('SELECT id,subscriber_id,left(user_msg,120) user_msg,left(ai_reply,200) ai_reply,blocked_game,mode,created_at FROM aykoshop_verifier_log '+where+' ORDER BY id DESC LIMIT $'+limitVal,[...allVals,limit]).catch(()=>({rows:[]}));
      const cnt=await pool.query('SELECT COUNT(*)::int n FROM aykoshop_verifier_log '+where,allVals).catch(()=>({rows:[{n:0}]}));
      if(isExport){
        const csv=['id,subscriber_id,blocked_game,mode,user_msg,created_at'].concat(rows.rows.map(r=>[r.id,r.subscriber_id||'','"'+(r.blocked_game||'').replace(/"/g,'""')+'"',r.mode||'','"'+(r.user_msg||'').replace(/"/g,'""')+'"',r.created_at].join(','))).join('\n');
        res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename="review_'+section+'_'+Date.now()+'.csv"'); return res.send(csv);
      }
      return res.json({ok:true,section,total:(cnt.rows[0]||{}).n||0,rows:rows.rows});
    }

    if(section==='decisions'){
      let where='WHERE created_at>now()-interval \'7 days\''; const vals=[];
      if(q){ vals.push('%'+q+'%'); where+=' AND (LOWER(intent) LIKE $'+vals.length+' OR LOWER(role) LIKE $'+vals.length+' OR LOWER(provider) LIKE $'+vals.length+' OR LOWER(subscriber_id::text) LIKE $'+vals.length+')'; }
      const df=dateFilter('created_at'); where+=df.where; const allVals=vals.concat(df.vals);
      const limitVal=allVals.length+1;
      const rows=await pool.query('SELECT id,subscriber_id,provider,model,mode,role,intent,route_layer,tokens_in,tokens_out,latency_ms,success,detail,created_at FROM aykoshop_ai_usage '+where+' ORDER BY id DESC LIMIT $'+limitVal,[...allVals,limit]).catch(()=>({rows:[]}));
      const cnt=await pool.query('SELECT COUNT(*)::int n FROM aykoshop_ai_usage '+where,allVals).catch(()=>({rows:[{n:0}]}));
      if(isExport){
        const csv=['id,subscriber_id,provider,model,intent,role,success,latency_ms,tokens_in,tokens_out,created_at'].concat(rows.rows.map(r=>[r.id,r.subscriber_id||'',r.provider||'',r.model||'',r.intent||'',r.role||'',r.success,r.latency_ms||0,r.tokens_in||0,r.tokens_out||0,r.created_at].join(','))).join('\n');
        res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename="review_decisions_'+Date.now()+'.csv"'); return res.send(csv);
      }
      return res.json({ok:true,section,total:(cnt.rows[0]||{}).n||0,rows:rows.rows});
    }

    if(section==='replay'){
      try{
        const fs=require('fs');
        let replay=[],pqa={};
        if(fs.existsSync('/var/www/backend/replay_results.json')) replay=JSON.parse(fs.readFileSync('/var/www/backend/replay_results.json','utf8'));
        if(fs.existsSync('/var/www/backend/pqa_baseline.json')) pqa=JSON.parse(fs.readFileSync('/var/www/backend/pqa_baseline.json','utf8'));
        const pqaRows=Object.entries(pqa).map(([label,v])=>({label,skill:v.skill,fp:v.fp,assertion_ok:v.assertion_ok}));
        const replayArr=Array.isArray(replay)?replay:(replay.rows||[]);
        const filtered=q?replayArr.filter(r=>JSON.stringify(r).toLowerCase().includes(q)):replayArr;
        return res.json({ok:true,section:'replay',replay:{total:replayArr.length,rows:filtered.slice(0,limit)},pqa:{total:pqaRows.length,pass:pqaRows.filter(r=>r.assertion_ok).length,fail:pqaRows.filter(r=>!r.assertion_ok).length,rows:pqaRows}});
      }catch(fe){ return res.json({ok:true,section:'replay',replay:{total:0,rows:[]},pqa:{total:0,pass:0,fail:0,rows:[]},note:'files not yet generated'}); }
    }

    return res.status(400).json({ok:false,error:'unknown section: '+section});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
// ==================== END AI REVIEW CENTER ====================
// ==================== END STRICT GATES ====================
app.post('/api/ai/vision', async (req,res)=>{
  const t0=Date.now(); const b=req.body||{}; const url=b.image_url||''; const msg=b.message||''; const sub=b.subscriber_id||null; const channel=b.channel||null;
  if(!url) return res.json({ ok:true, type:'NO_URL', is_payment:false, match_level:'none', reply:'وصلتنا الصورة 😊 شنو تبغي؟', provider:'rule' });
  try{
    const ex=await _visionExtractStruct(url);
    _logAiUsage({subscriber_id:sub,provider:'openai',model:'gpt-4o',mode:'vision_extract',role:'vision',intent:(ex&&ex.product_type)||'?',route_layer:'vision',user_msg:'[image]',tokens_in:(ex&&ex._in)||0,tokens_out:(ex&&ex._out)||0,success:!!ex});
    const _gameRaw=(ex&&ex.game&&String(ex.game)!=='null')?String(ex.game):'';
    const _isPay=!!(ex&&ex.is_payment) || (_detectIntent(msg).intent==='payment');
    if(_isPay){
      const reply='وصلنا سكرين الدفع، شكراً 🙏 غادي نتحقّقو منه يدوياً ونأكّدو ليك. ماتعاودش الدفع.';
      let _fraud={score:'low',reasons:[]}; try{ _fraud=await _visionFraud(url); }catch(_e){}
      try{ const _dupc=await pool.query('SELECT count(*)::int n FROM aykoshop_payment_claims WHERE image_url=$1',[url]); if(_dupc.rows[0].n>0){ if(_fraud.score!=='high')_fraud.score='medium'; if(_fraud.reasons.indexOf('duplicate_screenshot')<0)_fraud.reasons.push('duplicate_screenshot'); } }catch(_e){}
      const _fr=(_fraud.reasons||[]).join(',');
      try{ await fetch('http://localhost:4000/api/payment-claims',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:sub,channel:channel,image_url:url,source:'vision',raw_message:'صورة دفع — مراجعة بشرية (Vision)',fraud_score:_fraud.score,fraud_reasons:_fr})}); }catch(e){}
      try{ await fetch('http://localhost:4000/api/interventions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:sub,channel:channel,reason_code:'FRAUD_REVIEW',reason_detail:'درجة الاحتيال: '+_fraud.score+(_fr?(' — '+_fr):' — بلا إشارات')+' — البشري يقرر (Vision ماكيأكّدش)',customer_message:'[صورة دفع]',ai_confidence:(_fraud.score==='high'?0.9:_fraud.score==='medium'?0.6:0.3)})}); }catch(e){}
      try{ await fetch('http://localhost:4000/api/image-logs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:sub,channel:channel,image_url:url,analysis_type:'PAYMENT',is_payment:true,found_match:false,matched_product:null,ai_reply:reply})}); }catch(e){}
      return res.json({ ok:true, type:'PAYMENT', is_payment:true, match_level:'payment', found_match:false, fraud_score:_fraud.score, reply:reply, vision_desc:(ex&&(ex.visible_text||ex.items))||'', provider:'gpt-4o', ms:Date.now()-t0 });
    }
    const _svc=_visionTypeToService(ex&&ex.product_type);
    const _q=[_gameRaw, ex&&ex.product_type, ex&&ex.items, ex&&ex.visible_text].filter(function(x){return x&&String(x)!=='null';}).join(' ').slice(0,300);
    let rows=[]; try{ const cs=await _catalogSearch(_q||'product', {type:_svc||null, limit:6}); rows=(cs&&cs.rows)||[]; }catch(e){}
    const _top=rows[0]; const _sim=_top?parseFloat(_top.sim):0;
    let _gic=true; if(_gameRaw){ try{ const _cm=await _catalogMeta(); const _h=' '+_gameRaw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim()+' '; _gic=(_cm.lines||[]).some(function(ln){ return (ln.aliases||[]).some(function(a){ return a.length>=3 && _h.indexOf(' '+a+' ')>=0; }); }); }catch(e){} }
    let match_level='none';
    if(_gameRaw && !_gic) match_level='none'; else if(_sim>=0.42) match_level='strong'; else if(_sim>=0.30) match_level='medium'; else if(_gameRaw && _gic) match_level='medium'; else match_level='none';
    const found=(match_level!=='none');
    const reply=found?'شفنا الصورة 👀 عندنا قريب ليها فالكاطالوج.':'شفنا الصورة 👀 ولكن هاد النوع مازال ماكايناش عندنا دابا.';
    try{ await fetch('http://localhost:4000/api/image-logs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:sub,channel:channel,image_url:url,analysis_type:(ex&&ex.product_type)||'PRODUCT',is_payment:false,found_match:found,matched_product:(_top?_top.product_name:null),ai_reply:reply})}); }catch(e){}
    return res.json({ ok:true, type:(ex&&ex.product_type)||'PRODUCT', is_payment:false, match_level:match_level, found_match:found, top_sim:Number(_sim.toFixed(3)), query:_q, game:_gameRaw, service:_svc, game_in_catalog:_gic, products:rows.slice(0,3).map(function(p){return {product_name:p.product_name,price:p.price,price_value:p.price_value,min_price:p.min_price,product_type:p.product_type,code_type:p.code_type,game:p.game,key_features:p.key_features,image_url:p.image_url,sim:Number(parseFloat(p.sim).toFixed(3))};}), vision_desc:(ex&&(ex.items||ex.visible_text||ex.product_type))||'', reply:reply, provider:'gpt-4o', ms:Date.now()-t0 });
  }catch(e){ return res.json({ ok:false, type:'ERROR', is_payment:false, match_level:'none', reply:'وصلتنا الصورة 📸 غادي نشوفوها ونرجعو ليك.', error:e.message }); }
});
app.post('/api/ai/transcribe', async (req,res)=>{
  { const _rip=((req.socket&&req.socket.remoteAddress)||'').replace('::ffff:',''); if(!(_rip==='127.0.0.1'||_rip==='::1'||/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(_rip))) return res.status(403).json({ok:false,error:'forbidden'}); }
  const b=req.body||{}; const url=b.audio_url||''; if(!url) return res.status(400).json({ok:false,error:'audio_url required'});
  try{
    const agents=await getAgents(); const aa=agents.audio;
    if(aa && aa.enabled===false) return res.json({ ok:false, disabled:true, text:'', note:'Audio agent disabled' });
    const model=(aa&&aa.model)||'whisper-1';
    const ar=await fetch(url,{signal:AbortSignal.timeout(8000)}); if(!ar.ok) return res.json({ ok:false, error:'fetch audio HTTP '+ar.status });
    const buf=Buffer.from(await ar.arrayBuffer());
    var _uu=url.split('?')[0].toLowerCase(); var ext;
    if(_uu.indexOf('audioclip')!==-1||_uu.indexOf('lookaside')!==-1||_uu.indexOf('ig_messaging')!==-1||_uu.indexOf('fbsbx')!==-1||/\.(mp4|m4a)$/.test(_uu)) ext='mp4';
    else if(/\.ogg$/.test(_uu)||_uu.indexOf('manybot')!==-1) ext='ogg';
    else { ext=(_uu.split('.').pop()||'mp3'); if(ext.length>4) ext='mp3'; }
    const fd=new FormData(); fd.append('file', new Blob([new Uint8Array(buf)]), 'audio.'+ext); fd.append('model', model); fd.append('prompt', 'AykoShop: game accounts, codes, top-up (Free Fire). Customers speak Moroccan Darija, Arabic, or English. متجر AykoShop لبيع حسابات وأكواد وشحن الألعاب بالدرهم.');
    const r=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{'Authorization':'Bearer '+_OPENAI_KEY},body:fd,signal:AbortSignal.timeout(20000)});
    const j=await r.json().catch(()=>({})); if(!r.ok) return res.json({ ok:false, error:('HTTP '+r.status+' '+JSON.stringify(j)).slice(0,200) });
    const text=(j.text||'').trim();
    var _hallu=['اشتراك في القناة','الاشتراك في القناة','اشتركوا في القناة','اشترك في القناة','المرجو الاشتراك','لا تنسوا الاشتراك','مرحبا بكم في القناة','مرحبا بكم في قناتي','شكرا للمشاهدة','شكرا على المشاهدة','أراكم في الفيديو','ترجمة نانسي','subscribe','thanks for watching','thank you for watching','please subscribe','merci d','aimez et abonnez','abonnez-vous'];
    var _lt=text.toLowerCase(); var _isHallu=!!text && text.length<80 && _hallu.some(function(h){return _lt.indexOf(h.toLowerCase())!==-1;});
    if(!text || _isHallu){ _logAiUsage({subscriber_id:b.subscriber_id||null,provider:'openai',model,mode:'transcribe',role:'audio',route_layer:'audio',user_msg:(_isHallu?'[hallucination] ':'[empty] ')+text.slice(0,150),success:false,detail:_isHallu?'hallucination_filtered':'empty_transcript'}); return res.json({ ok:false, text:'', hallucination:_isHallu, bytes:buf.length }); }
    if(text && text.length<70){ try{ const _cj=await _callOpenAI([{role:'system',content:'أنت مدقق رسائل زبائن متجر ألعاب. هل هذه الرسالة مفهومة وذات معنى (طلب/سؤال/رد/تحية) قد تكون بالدارجة المغربية أو العربية أو الفرنسية أو الإنجليزية؟ إذا كانت كلمات غير مترابطة إطلاقاً أو حروف عشوائية بلا معنى واضح = أجب GARBLED. إذا فيها أي معنى ولو بسيط = أجب CLEAR. أجب بكلمة واحدة فقط.'},{role:'user',content:text}],{model:'gpt-4o-mini',max_tokens:4,temperature:0,timeout:5000});
      if(_cj && _cj.ok && /GARBLED/i.test(_cj.text)){ _logAiUsage({subscriber_id:b.subscriber_id||null,provider:'openai',model:'gpt-4o-mini',mode:'transcribe',role:'audio',route_layer:'coherence',user_msg:'[low_coherence] '+text.slice(0,150),success:false,detail:'low_coherence'}); return res.json({ ok:false, text:'', low_coherence:true, raw:text }); }
    }catch(_e){} }
    _logAiUsage({subscriber_id:b.subscriber_id||null,provider:'openai',model,mode:'transcribe',role:'audio',route_layer:'audio',user_msg:text.slice(0,200),success:true});
    res.json({ ok:true, text, model, bytes:buf.length });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// ===== Mission Control API endpoints (/api/mc/*) =====
app.get('/api/mc/brain-status', async (req,res)=>{ try{
  const brain=process.env.AI_BRAIN||'openai';
  const tg=await pool.query("SELECT COUNT(*)::int n FROM aykoshop_ai_usage WHERE model='truth_gate' AND created_at>NOW()-INTERVAL '24 hours'");
  const errs=await pool.query("SELECT provider,COUNT(*)::int n FROM aykoshop_ai_usage WHERE success=false AND created_at>NOW()-INTERVAL '1 hour' AND provider IS NOT NULL GROUP BY provider");
  const em={}; errs.rows.forEach(function(r){em[r.provider]=r.n;});
  const prov={openai:em.openai>3?'degraded':'ok',anthropic:em.anthropic>3?'degraded':'unknown',gemini:em.gemini>3?'degraded':'unknown',mini:em.mini>3?'degraded':'ok'};
  const circuit=await pool.query("SELECT provider,MAX(created_at) last_ok FROM aykoshop_ai_usage WHERE success=true AND created_at>NOW()-INTERVAL '6 hours' GROUP BY provider");
  const circMap={}; circuit.rows.forEach(function(r){circMap[r.provider]=r.last_ok;});
  res.json({ok:true,active_brain:brain,truth_gate_today:tg.rows[0].n,providers:prov,last_success:circMap});
}catch(e){res.status(500).json({ok:false,error:e.message});} });

app.get('/api/mc/policies', async (req,res)=>{ try{
  const r=await pool.query("SELECT key,value,updated_at FROM aykoshop_policies ORDER BY key");
  res.json({ok:true,policies:r.rows});
}catch(e){res.status(500).json({ok:false,error:e.message});} });

app.put('/api/mc/policies/:key', async (req,res)=>{ try{
  const k=req.params.key; const v=(req.body&&req.body.value)||'';
  if(!v.trim())return res.status(400).json({ok:false,error:'value required'});
  const r=await pool.query("INSERT INTO aykoshop_policies(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW() RETURNING *",[k,v.trim()]);
  res.json({ok:true,policy:r.rows[0]});
}catch(e){res.status(500).json({ok:false,error:e.message});} });

app.get('/api/mc/truth-gate-logs', async (req,res)=>{ try{
  const r=await pool.query("SELECT id,subscriber_id,detail,user_msg,created_at FROM aykoshop_ai_usage WHERE model='truth_gate' ORDER BY id DESC LIMIT 50");
  res.json({ok:true,logs:r.rows});
}catch(e){res.status(500).json({ok:false,error:e.message});} });

app.get('/api/mc/alerts', async (req,res)=>{ try{
  const summary=await pool.query("SELECT reason_code,COUNT(*)::int n,MAX(created_at) last_at FROM aykoshop_interventions WHERE created_at>NOW()-INTERVAL '24 hours' GROUP BY reason_code ORDER BY n DESC LIMIT 15");
  const recent=await pool.query("SELECT id,subscriber_id,customer_name,channel,reason_code,reason_detail,created_at FROM aykoshop_interventions ORDER BY id DESC LIMIT 20");
  res.json({ok:true,summary:summary.rows,recent:recent.rows});
}catch(e){res.status(500).json({ok:false,error:e.message});} });
// ===== END Mission Control API =====
// ===== Mission Control — Live Sales + Truth Gate stats + Provider Switch =====
app.get('/api/mc/live-sales', async (req,res)=>{ try{
  const today=await pool.query("SELECT COUNT(*) FILTER (WHERE model NOT IN ('rule','-','truth_gate','kb') AND model IS NOT NULL)::int ai_answered, COUNT(*) FILTER (WHERE model IN ('rule','-'))::int rule_based, COUNT(*) FILTER (WHERE stage='human')::int human_esc, COUNT(*) FILTER (WHERE stage='sales')::int sales_conv, COUNT(*) FILTER (WHERE stage='payment')::int payment_stage FROM aykoshop_v2_canary WHERE created_at>date_trunc('day',NOW())");
  const orders=await pool.query("SELECT COUNT(*)::int n FROM aykoshop_orders WHERE created_at>date_trunc('day',NOW())").catch(()=>({rows:[{n:0}]}));
  const d=today.rows[0]||{}; res.json({ok:true,ai_answered:d.ai_answered||0,rule_based:d.rule_based||0,human_esc:d.human_esc||0,sales_conv:d.sales_conv||0,payment_stage:d.payment_stage||0,orders_today:orders.rows[0].n||0});
}catch(e){res.status(500).json({ok:false,error:e.message});} });

app.get('/api/mc/truth-gate-stats', async (req,res)=>{ try{
  const r=await pool.query("SELECT detail,COUNT(*)::int n FROM aykoshop_ai_usage WHERE model='truth_gate' AND created_at>date_trunc('day',NOW()) GROUP BY detail");
  var stats={prices_corrected:0,refund_blocked:0,policy_corrected:0,total:0};
  r.rows.forEach(function(row){ var d=row.detail||''; stats.total+=row.n; if(d.startsWith('price_hallucination')) stats.prices_corrected+=row.n; else if(d==='cash_refund_blocked') stats.refund_blocked+=row.n; else stats.policy_corrected+=row.n; });
  res.json({ok:true,...stats,rows:r.rows});
}catch(e){res.status(500).json({ok:false,error:e.message});} });

app.post('/api/mc/set-brain', async (req,res)=>{ try{
  const brain=(req.body&&req.body.brain)||'openai';
  const valid=['openai','mini','anthropic','gemini'];
  if(!valid.includes(brain))return res.status(400).json({ok:false,error:'invalid provider: use openai|mini|anthropic|gemini'});
  _AI_BRAIN_LIVE=brain;
  await pool.query("INSERT INTO aykoshop_settings(key,value) VALUES('ai_brain',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=NOW()",[brain]);
  res.json({ok:true,brain:_AI_BRAIN_LIVE,msg:'Brain switched to '+brain+' (immediate, persisted)'});
}catch(e){res.status(500).json({ok:false,error:e.message});} });
// ===== END Mission Control additions =====

app.get('/api/ai/stats', async (req,res)=>{ try{
  const cfg=await getAiConfig();
  const per=await pool.query("SELECT provider, count(*) FILTER(WHERE success)::int ok, count(*)::int total, COALESCE(SUM(tokens_in),0)::int tin, COALESCE(SUM(tokens_out),0)::int tout, COALESCE(ROUND(AVG(latency_ms)),0)::int avg_ms FROM aykoshop_ai_usage WHERE provider IS NOT NULL GROUP BY provider ORDER BY provider");
  const today=await pool.query("SELECT provider, count(*) FILTER(WHERE success)::int ok, count(*)::int total FROM aykoshop_ai_usage WHERE created_at>=date_trunc('day',now()) AND provider IS NOT NULL GROUP BY provider");
  const lf=await pool.query("SELECT provider,created_at,detail FROM aykoshop_ai_usage WHERE mode='fallback' AND success ORDER BY id DESC LIMIT 1");
  const le=await pool.query("SELECT provider,created_at,detail FROM aykoshop_ai_usage WHERE success=false AND provider IS NOT NULL ORDER BY id DESC LIMIT 1");
  const cir=await pool.query("SELECT provider,state,fail_count,last_ok_at,last_fail_at,last_detail FROM aykoshop_circuit_state ORDER BY provider");
  const lr=cir.rows.filter(c=>c.last_ok_at && c.last_fail_at && new Date(c.last_ok_at)>new Date(c.last_fail_at)).sort((a,b)=>new Date(b.last_ok_at)-new Date(a.last_ok_at))[0]||null;
  const _rate=(m)=>AI_COST[m]||AI_COST['gpt-4o'];
  const costRows=await pool.query("SELECT model, COALESCE(SUM(tokens_in),0)::bigint tin, COALESCE(SUM(tokens_out),0)::bigint tout, count(*)::int n, COALESCE(SUM(CASE WHEN created_at>=date_trunc('day',now()) THEN tokens_in ELSE 0 END),0)::bigint d_in, COALESCE(SUM(CASE WHEN created_at>=date_trunc('day',now()) THEN tokens_out ELSE 0 END),0)::bigint d_out, COALESCE(SUM(CASE WHEN created_at>=date_trunc('month',now()) THEN tokens_in ELSE 0 END),0)::bigint m_in, COALESCE(SUM(CASE WHEN created_at>=date_trunc('month',now()) THEN tokens_out ELSE 0 END),0)::bigint m_out FROM aykoshop_ai_usage WHERE model IS NOT NULL GROUP BY model");
  let cost_total=0,cost_today=0,cost_month=0; const cost_by=[];
  costRows.rows.forEach(r=>{ const rt=_rate(r.model); const c=(Number(r.tin)/1e6*rt.in)+(Number(r.tout)/1e6*rt.out); const cd=(Number(r.d_in)/1e6*rt.in)+(Number(r.d_out)/1e6*rt.out); const cm=(Number(r.m_in)/1e6*rt.in)+(Number(r.m_out)/1e6*rt.out); cost_total+=c;cost_today+=cd;cost_month+=cm; cost_by.push({model:r.model,messages:r.n,tokens_in:Number(r.tin),tokens_out:Number(r.tout),cost_usd:Math.round(c*1000)/1000}); });
  const fo=await pool.query("SELECT count(*)::int n FROM aykoshop_ai_usage WHERE mode='fallback' AND success");
  const rstat=await pool.query("SELECT route_layer, count(*)::int n FROM aykoshop_ai_usage WHERE route_layer IS NOT NULL GROUP BY route_layer");
  const istat=await pool.query("SELECT intent, count(*)::int n FROM aykoshop_ai_usage WHERE intent IS NOT NULL GROUP BY intent");
  const _byLayer={}; rstat.rows.forEach(r=>_byLayer[r.route_layer]=r.n); const _byIntent={}; istat.rows.forEach(r=>_byIntent[r.intent]=r.n);
  const _rTot=rstat.rows.reduce((s,r)=>s+r.n,0)||1;
  const _g4=cost_by.find(m=>m.model==='gpt-4o')||{messages:0,cost_usd:0}; const _mn=cost_by.find(m=>m.model==='gpt-4o-mini')||{messages:0,cost_usd:0};
  const _g4avg=_g4.messages?_g4.cost_usd/_g4.messages:0; const _mnavg=_mn.messages?_mn.cost_usd/_mn.messages:0;
  const _saved=Math.round((_mn.messages||0)*Math.max(0,_g4avg-_mnavg)*1000)/1000;
  const _routing={ by_layer:_byLayer, by_intent:_byIntent, regex_pct:Math.round((_byLayer.regex||0)*100/_rTot), mini_pct:Math.round(((_byLayer.mini||0)+(_byLayer.mini_failed||0))*100/_rTot), mini_routed_msgs:(_mn.messages||0), est_savings_usd:_saved };
  res.json({ config:cfg, per_provider:per.rows, today:today.rows, last_failover:lf.rows[0]||null, last_error:le.rows[0]||null, last_recovery:lr?{provider:lr.provider,at:lr.last_ok_at,detail:lr.last_detail}:null, circuit:cir.rows, failover_count:(fo.rows[0]||{}).n||0, cost:{ total_usd:Math.round(cost_total*1000)/1000, today_usd:Math.round(cost_today*1000)/1000, month_usd:Math.round(cost_month*1000)/1000, by_model:cost_by }, routing:_routing });
}catch(e){ res.status(500).json({error:e.message}); } });

app.get('/api/ops/health-center', async (req,res)=>{
  const t0=Date.now();
  const svc=async(name,weight,fn)=>{ const s=Date.now(); try{ const r=await fn(); return {name,status:r.status,latency_ms:Date.now()-s,detail:r.detail||null,weight}; }catch(e){ return {name,status:'down',latency_ms:Date.now()-s,detail:String(e.message||e).slice(0,90),weight}; } };
  const checks=await Promise.all([
    svc('PostgreSQL',2,async()=>{ await pool.query('SELECT 1'); return {status:'up'}; }),
    svc('Dashboard API',2,async()=>({status:'up',detail:'uptime '+Math.round(process.uptime()/60)+'m'})),
    svc('SSE',1,async()=>({status:_sseClients.size>0?'up':'idle',detail:_sseClients.size+' clients'})),
    svc('OpenAI',2,async()=>{ const r=await fetch('https://api.openai.com/v1/models',{headers:{'Authorization':HTG_OPENAI()},signal:AbortSignal.timeout(6000)}); return {status:r.ok?'up':'down',detail:'HTTP '+r.status}; }),
    svc('Telegram Bot',1,async()=>{ const r=await fetch('https://api.telegram.org/bot'+_tgTok()+'/getMe',{signal:AbortSignal.timeout(6000)}); const j=await r.json(); return {status:j.ok?'up':'down',detail:j.ok?('@'+j.result.username):'unauthorized'}; }),
    svc('n8n',2,async()=>{ const r=await fetch('http://localhost:5678/healthz',{signal:AbortSignal.timeout(6000)}); return {status:r.ok?'up':'down',detail:'HTTP '+r.status}; }),
    svc('ManyChat→n8n',2,async()=>{ const q=await pool.query("SELECT max(created_at) m FROM aykoshop_chat_history"); const m=q.rows[0].m; const mins=m?Math.round((Date.now()-new Date(m).getTime())/60000):null; return {status:(mins!=null&&mins<60)?'up':(mins!=null?'stale':'unknown'),detail:m?('آخر رسالة قبل '+mins+'د'):'لا رسائل'}; }),
    svc('Claude (Anthropic)',2,async()=>{ const r=await fetch('https://api.anthropic.com/v1/models',{headers:{'x-api-key':_ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},signal:AbortSignal.timeout(6000)}); return {status:r.ok?'up':'down',detail:'HTTP '+r.status}; }),
    svc('GPT-4o Vision',1,async()=>{ const cfg=await getAiConfig(); if(cfg.providers&&cfg.providers.vision===false) return {status:'idle',detail:'معطّل'}; const q=await pool.query("SELECT max(created_at) m FROM aykoshop_image_logs").catch(()=>({rows:[{m:null}]})); const m=q.rows[0].m; return {status:'up',detail:m?('آخر صورة قبل '+Math.round((Date.now()-new Date(m).getTime())/60000)+'د'):'مفعّل'}; }),
    svc('Outbox',2,async()=>{ const q=await pool.query("SELECT status,count(*)::int n FROM aykoshop_outbox GROUP BY status"); const by={}; q.rows.forEach(x=>by[x.status]=x.n); const dead=by.dead||0,pend=by.pending||0; return {status: OUTBOX_WORKER_ON?((dead>0||pend>20)?'stale':'up'):'down', detail:(OUTBOX_WORKER_ON?'worker on':'worker OFF')+' · pending '+pend+' · dead '+dead}; }),
    svc('ManyChat API',1,async()=>{ const k=_mcKey()||''; if(!k) return {status:'unknown',detail:'no key'}; const r=await mcPageInfo(6000); return {status:r.ok?'up':'down',detail:'HTTP '+r.status}; }),
    svc('WhatsApp',1,async()=>{ const q=await pool.query("SELECT max(created_at) m FROM aykoshop_events WHERE channel='whatsapp'").catch(()=>({rows:[{m:null}]})); const m=q.rows[0].m; const mins=m?Math.round((Date.now()-new Date(m).getTime())/60000):null; return {status:(mins!=null&&mins<120)?'up':(mins!=null?'stale':'unknown'),detail:m?('آخر واتساب قبل '+mins+'د'):'—'}; })
  ]);
  const _HLINKS={'OpenAI':'https://status.openai.com','Claude (Anthropic)':'https://status.anthropic.com','Telegram Bot':'https://api.telegram.org','n8n':'https://n8n.ayko.store','ManyChat→n8n':'https://app.manychat.com','ManyChat API':'https://app.manychat.com','Outbox':'#/system','GPT-4o Vision':'#/ai','WhatsApp':null,'PostgreSQL':null,'Dashboard API':null,'SSE':null};
  checks.forEach(c=>{ c.link=_HLINKS[c.name]||null; });
  const totW=checks.reduce((a,c)=>a+c.weight,0);
  const upW=checks.reduce((a,c)=>a+((c.status==='up'||c.status==='idle')?c.weight:(c.status==='stale'?c.weight*0.4:0)),0);
  const _cmap={'OpenAI':'openai','Claude (Anthropic)':'anthropic','Telegram Bot':'telegram','n8n':'n8n','ManyChat→n8n':'manychat','WhatsApp':'whatsapp'};
  checks.forEach(c=>{ const pk=_cmap[c.name]; if(!pk)return; if(c.status==='up'||c.status==='idle')circuitRecord(pk,true,c.detail); else if(c.status==='down')circuitRecord(pk,false,c.detail); });
  res.json({ health_score:Math.round(upW/totW*100), services:checks, circuit:circuitSnapshot(), critical:checks.filter(c=>c.status==='down').map(c=>c.name), checked_at:new Date().toISOString(), took_ms:Date.now()-t0 });
});

// Per-customer intelligence — Customer360 Ultimate
app.get('/api/customers/:id/intelligence', asyncHandler(async (req,res)=>{
  const q=await pool.query("SELECT subscriber_id,customer_name,channel,stage,interested_in,total_messages,last_seen,session_data,lifetime_value FROM aykoshop_profiles WHERE subscriber_id=$1",[req.params.id]);
  if(!q.rows.length) return res.status(404).json({error:'not found'});
  const c=q.rows[0]; const s=c.session_data||{}; const pp=purchaseProbability(c);
  const budget = (s.last_budget&&s.last_budget>0) ? s.last_budget : null;
  const hrs = c.last_seen ? (Date.now()-new Date(c.last_seen).getTime())/3600000 : null;
  let recovery=0;
  if(['hot','warm','interested'].includes(c.stage)){ recovery=Math.min(100, Math.round((c.lifetime_value>0?30:18)+(c.interested_in?18:0)+(hrs!=null&&hrs>24&&hrs<168?20:0)+Math.min((c.total_messages||0)*2,14))); }
  const action = pp.tier==='buy_now'?'أرسل عرض الإغلاق الآن — الزبون جاهز للشراء':pp.tier==='follow_today'?'تابعه اليوم — اهتمام واضح بلا طلب':pp.tier==='warm'?'سخّنه: أرسل صورة/قيمة منتج مناسب':'أضفه لحملة استرجاع لاحقاً';
  const summary='زبون '+(c.stage||'?')+(c.interested_in?(' مهتم بـ '+c.interested_in):'')+'، '+(c.total_messages||0)+' رسالة'+(budget?('، ميزانية '+budget+'DH'):'، بلا ميزانية محددة')+(s.rejection_count?('، '+s.rejection_count+' اعتراض'):'')+'، احتمال شراء '+pp.probability+'%.';
  res.json({ probability:pp.probability, tier:pp.tier, emoji:pp.emoji, label:pp.label, reason:pp.reason, recommended_action:action, summary, recovery_score:recovery, budget, value:c.lifetime_value||0, interests:c.interested_in||null, last_product:s.last_product_name||null, rejections:s.rejection_count||0 });
}));



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
    const _qp = [];
    if (broadcast.target_stage && broadcast.target_stage !== 'all') { _qp.push(broadcast.target_stage); query += ` AND stage=$${_qp.length}`; }
    const profiles = await pool.query(query + " LIMIT 100", _qp);
    const MANYCHAT_KEY = `Bearer ${_mcKey()}`;
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
app.get('/api/workflow-errors', asyncHandler(async (req, res) => { const r = await pool.query("SELECT * FROM aykoshop_workflow_errors ORDER BY started_at DESC LIMIT 100"); res.json(r.rows); }));
app.patch('/api/workflow-errors/:id/resolve', async (req, res) => {
  try { await pool.query("UPDATE aykoshop_workflow_errors SET resolved=true WHERE id=$1", [req.params.id]); res.json({success:true}); } catch(e) { res.status(500).json({error: e.message}); }
});

// ==================== EXPORT ====================
app.get('/api/export/customers', asyncHandler(async (req, res) => {
    const r = await pool.query("SELECT p.customer_name,p.channel,p.stage,p.interested_in,p.total_messages,p.last_seen,COALESCE(ls.lead_score,0) as lead_score FROM aykoshop_profiles p LEFT JOIN aykoshop_lead_scores ls ON ls.subscriber_id=p.subscriber_id ORDER BY p.last_seen DESC");
    const csv = ['الاسم,القناة,المرحلة,مهتم بـ,الرسائل,آخر ظهور,Lead Score', ...r.rows.map(row => [row.customer_name||'',row.channel||'',row.stage||'',row.interested_in||'',row.total_messages||0,row.last_seen?new Date(row.last_seen).toLocaleDateString('ar'):'',row.lead_score||0].join(','))].join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename=customers.csv'); res.send('\uFEFF'+csv);
}));
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

// ==================== EVENTS CENTER ====================
// Receives structured events from n8n Build & Call OpenAI (L26, L231)
// Stores: payment_intent, order_intent, customer_activity, AI interactions
app.get('/api/events', async (req, res) => {
  try {
    const { type, channel, subscriber_id, limit = 200 } = req.query;
    let conditions = [], params = [], idx = 1;
    if (type)          { conditions.push(`type=$${idx}`);          params.push(type);          idx++; }
    if (channel)       { conditions.push(`channel=$${idx}`);       params.push(channel);       idx++; }
    if (subscriber_id) { conditions.push(`subscriber_id=$${idx}`); params.push(subscriber_id); idx++; }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim   = Math.min(parseInt(limit) || 200, 1000);
    const r = await pool.query(
      `SELECT * FROM aykoshop_events ${where} ORDER BY created_at DESC LIMIT ${lim}`,
      params
    );
    res.json({ events: r.rows, total: r.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events', async (req, res) => {
  try {
    const { type, title, message, data = {} } = req.body;
    if (!type) return res.status(400).json({ error: 'type is required' });
    const {
      subscriber_id = null, customer_name = null, channel = null,
      intent = null, stage = null, manychat_link = null,
      ai_reply = null, wa_phone = null
    } = data;
    await pool.query(
      `INSERT INTO aykoshop_events
        (type, title, message, subscriber_id, customer_name, channel,
         intent, stage, manychat_link, ai_reply, wa_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [type, title||null, message||null, subscriber_id, customer_name,
       channel, intent, stage, manychat_link, ai_reply, wa_phone]
    );
    // Broadcast payment/buyer events to Dashboard in real-time
    if (type === 'customer' || type === 'payment' || type === 'buyer') {
      const _sseMsg = (type==='customer' && message && message.includes(' → ')) ? message.split(' → ')[0] : message;
      _broadcast('customer_event', {
        type, title, message: _sseMsg,
        subscriber_id, customer_name, channel, intent, stage,
        manychat_link, wa_phone,
        ts: new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/events/stats', async (req, res) => {
  try {
    const [byType, byChannel, today] = await Promise.all([
      pool.query(`SELECT type, COUNT(*) as count FROM aykoshop_events
                  WHERE created_at > NOW() - INTERVAL '7 days'
                  GROUP BY type ORDER BY count DESC`),
      pool.query(`SELECT channel, COUNT(*) as count FROM aykoshop_events
                  WHERE created_at > NOW() - INTERVAL '24 hours' AND channel IS NOT NULL
                  GROUP BY channel ORDER BY count DESC`),
      pool.query(`SELECT
          COUNT(*) FILTER (WHERE type='customer') as customers_today,
          COUNT(*) FILTER (WHERE type='payment')  as payments_today,
          COUNT(*) FILTER (WHERE type='order')    as orders_today
        FROM aykoshop_events
        WHERE created_at > NOW() - INTERVAL '24 hours'`)
    ]);
    res.json({
      by_type: byType.rows,
      by_channel_today: byChannel.rows,
      today: today.rows[0]
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== SESSION MEMORY (Phase 2A) ====================
// Read session_data for a subscriber — used by Build & Call OpenAI at start
app.get('/api/sessions/health', async (req, res) => {
  try {
    const [total, withSession, writeFails, readErrors] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM aykoshop_profiles"),
      pool.query("SELECT COUNT(*) FROM aykoshop_profiles WHERE session_data IS NOT NULL AND session_data != '{}'::jsonb"),
      pool.query("SELECT COUNT(*) FROM aykoshop_workflow_errors WHERE error_type='session_write_failed' AND started_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*) FROM aykoshop_workflow_errors WHERE error_type='session_read_error' AND started_at > NOW() - INTERVAL '24 hours'")
    ]);
    const totalN       = parseInt(total.rows[0].count);
    const sessionN     = parseInt(withSession.rows[0].count);
    const writeFailN   = parseInt(writeFails.rows[0].count);
    const readErrN     = parseInt(readErrors.rows[0].count);
    const healthPct    = totalN > 0 ? Math.round(sessionN / totalN * 100) : 0;
    res.json({
      total_profiles:        totalN,
      sessions_established:  sessionN,
      sessions_pending:      totalN - sessionN,
      session_coverage_pct:  healthPct,
      write_failures_24h:    writeFailN,
      read_errors_24h:       readErrN,
      status: writeFailN === 0 && readErrN === 0 ? 'healthy' : 'degraded'
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/:subscriber_id', async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT session_data FROM aykoshop_profiles WHERE subscriber_id=$1",
      [req.params.subscriber_id]
    );
    const session_data = r.rows[0]?.session_data || null;
    res.json({ session_data, found: !!r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sessions/:subscriber_id', async (req, res) => {
  try {
    // UPSERT: works on first message (profile created by session write, then Save Customer Profile
    // adds full details via ON CONFLICT DO UPDATE)
    const r = await pool.query(
      `INSERT INTO aykoshop_profiles (subscriber_id, session_data, last_seen)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (subscriber_id)
       DO UPDATE SET session_data = COALESCE(aykoshop_profiles.session_data, '{}'::jsonb) || EXCLUDED.session_data
       RETURNING subscriber_id`,
      [req.params.subscriber_id, JSON.stringify(req.body)]
    );
    const created = !!(r.rowCount && r.rows[0]);
    res.json({ success: true, upserted: req.params.subscriber_id, created });
  } catch(e) {
    console.error('[session write]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== WORKFLOW ERRORS ====================
// Receives structured error logs from n8n (Phase 0 Task 4)

// Permanent safeguard: safely serialize any value to a string, preventing [object Object]
function safeErrorStr(val, maxLen = 300) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') {
    // Catch residual [object Object] strings that slipped through at the source
    if (val === '[object Object]') return 'serialization_error: HTTP request failed (object not stringified at source)';
    return val.slice(0, maxLen);
  }
  // For actual objects: JSON stringify
  try { return JSON.stringify(val).slice(0, maxLen); }
  catch(e) { return '[unserializable object]'; }
}

// Auto-detect test subscribers: real ManyChat subscriber IDs are always purely numeric
function isTestSubscriber(subscriber_id) {
  if (!subscriber_id) return true;
  return !/^\d+$/.test(String(subscriber_id));
}

// Classify error severity for real errors
function classifyErrorSeverity(errorType, errorMsg) {
  if (!errorType) return 'info';
  const t = errorType.toLowerCase();
  if (t === 'ai_reply_set') return 'critical';   // customer got no response
  if (t.includes('openai') || (errorMsg && errorMsg.includes('401'))) return 'critical';
  if (t === 'ai_image2_set') return 'warning';    // image failed but text may have sent
  if (t.includes('session')) return 'info';        // session fallback active
  if (t.includes('warehouse') || t.includes('event')) return 'info';
  return 'warning';
}

app.post('/api/workflow-errors', async (req, res) => {
  try {
    const { node, subscriber_id, errors = [] } = req.body;
    const isTest = isTestSubscriber(subscriber_id);
    let logged = 0;
    for (const err of errors) {
      const nodeName  = safeErrorStr(node || err.fn || 'unknown', 100);
      const errorType = safeErrorStr(err.fn || 'unknown', 100);
      const errorMsg  = safeErrorStr(err.error || 'no message', 300);
      const subId     = subscriber_id ? String(subscriber_id).slice(0, 100) : null;
      const severity  = isTest ? 'info' : classifyErrorSeverity(errorType, errorMsg);
      await pool.query(
        `INSERT INTO aykoshop_workflow_errors
           (node_name, subscriber_id, error_type, error_message, is_test, severity, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [nodeName, subId, errorType, errorMsg, isTest, severity]
      );
      logged++;
    }
    if (!isTest && logged>0) { try{ const _sev = classifyErrorSeverity(safeErrorStr(node||'unknown',100), safeErrorStr((errors[0]&&errors[0].error)||'',300)); _broadcast('workflow_error', { node: node||'unknown', severity: _sev, count: logged, subscriber_id: subscriber_id||null }); }catch(_e){} }
    res.json({ success: true, logged, is_test: isTest });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Leak detection endpoint — returns count of [object Object] leaks in DB
app.get('/api/workflow-errors/leak-check', asyncHandler(async (req, res) => {
    const r = await pool.query(
      "SELECT COUNT(*) as leaks FROM aykoshop_workflow_errors WHERE error_message LIKE '%[object Object]%'"
    );
    const leaks = parseInt(r.rows[0].leaks);
    if (leaks > 0) {
      // Auto-warn: insert a warning entry if not already present today
      const existing = await pool.query(
        "SELECT id FROM aykoshop_workflow_errors WHERE error_type='object_leak_detected' AND started_at > NOW() - INTERVAL '24 hours'"
      );
      if (!existing.rows.length) {
        await pool.query(
          "INSERT INTO aykoshop_workflow_errors (node_name, subscriber_id, error_type, error_message) VALUES ('system','system','object_leak_detected',$1)",
          [`${leaks} rows contain [object Object] in error_message — fix error serialization at source`]
        );
      }
    }
    res.json({ leaks, status: leaks === 0 ? 'clean' : 'leak_detected' });
}));


// ==================== HUMAN INTERVENTION CENTER ====================

const INTERVENTION_PRIORITY = {
  PRODUCT_MISMATCH:   'high',
  PAYMENT_INTENT:     'critical',
  HOT_LEAD:           'critical',
  RESERVATION:        'critical',
  DELIVERY_REQUIRED:  'critical',
  PAYMENT_METHOD_UNKNOWN: 'critical',
  FRAUD_REVIEW:        'critical',
  UNKNOWN_QUESTION:    'critical',
  HUMAN_RECHARGE:      'critical',
  VIP_RECHARGE:        'critical',
  AI_UNAVAILABLE:     'critical',
  AI_REPLY_FAILED:    'critical',
  PAYMENT_CONFUSION:  'critical',
  AI_LOOP_DETECTED:   'high',
  PRODUCT_NOT_FOUND:  'critical',
  CUSTOMER_COMPLAINT: 'high',
  LOW_CONFIDENCE:     'high',
  IMAGE_NOT_AVAILABLE:'medium',
  HUMAN_REQUESTED:    'medium',
  TAKEOVER_ACTIVE:    'info'
};

// POST /api/interventions
app.post('/api/interventions', async (req, res) => {
  try {
    const {
      subscriber_id, customer_name, channel,
      wa_phone, manychat_link,
      reason_code, reason_detail,
      customer_message, ai_last_reply,
      product_name, ai_confidence, intent, vector_sim
    } = req.body;

    if (!subscriber_id || !reason_code) {
      return res.status(400).json({ error: 'subscriber_id and reason_code required' });
    }
    if (isTestSubscriber(subscriber_id)) {
      return res.json({ success: true, skipped: true, reason: 'test_subscriber' });
    }

    const priority = INTERVENTION_PRIORITY[reason_code] || 'high';
    const _env = _envOf(req.body, subscriber_id);

    const r = await pool.query(`
      INSERT INTO aykoshop_interventions
        (subscriber_id, customer_name, channel, wa_phone, manychat_link,
         reason_code, reason_detail, customer_message, ai_last_reply,
         product_name, ai_confidence, intent, vector_sim, priority, is_test, environment, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',NOW())
      RETURNING *`,
      [
        String(subscriber_id), customer_name||null, channel||null,
        wa_phone||null, manychat_link||null,
        reason_code, reason_detail||null,
        customer_message ? String(customer_message).slice(0,500) : null,
        ai_last_reply   ? String(ai_last_reply).slice(0,500) : null,
        product_name||null, ai_confidence||null, intent||null, vector_sim||null,
        priority, ((_env!=='prod') || !/^[0-9]{15,}$/.test(String(subscriber_id))), _env
      ]
    );

    if (reason_code === 'PAYMENT_INTENT') {
      // Human Takeover on payment confirmation — stop AI until operator verifies (security)
      await pool.query("INSERT INTO aykoshop_stopped_chats (subscriber_id, reason) VALUES ($1,'payment_verification') ON CONFLICT (subscriber_id) DO NOTHING",[String(subscriber_id)]).catch(()=>{});
      try{ _broadcast('human_takeover',{subscriber_id:String(subscriber_id),customer_name:customer_name||null,channel:channel||null,reason:'payment_verification'}); }catch(_e){}
    }
    if (reason_code === 'AI_UNAVAILABLE') {
      try{ const _c=await getAiConfig(); if(_c.emergency_mode){ await pool.query("INSERT INTO aykoshop_stopped_chats (subscriber_id, reason) VALUES ($1,'emergency') ON CONFLICT (subscriber_id) DO NOTHING",[String(subscriber_id)]).catch(()=>{}); try{ _broadcast('human_takeover',{subscriber_id:String(subscriber_id),customer_name:customer_name||null,channel:channel||null,reason:'emergency'}); }catch(_e){} } }catch(_e){}
    }
    if (priority === 'critical' || _CAPTURE_REASONS.has(reason_code)) {
      // TEST/PROD routing: test (flag or sub-range) -> QA Lab; real -> prod bot; null = fail-closed DROP (never prod).
      const _ep = _tgRoute(_isTestRoute(subscriber_id, req.body && req.body.is_test));
      const TG_TOKEN = _ep ? _ep.token : null;
      const TG_CHAT  = _ep ? _ep.chat  : null;
      const channelEmoji = channel === 'instagram' ? '📸' : channel === 'messenger' ? '💬' : '📱';
      const msg = `🔴 تدخل عاجل مطلوب\n${channelEmoji} ${customer_name||subscriber_id} — ${(channel||'').toUpperCase()}\nالسبب: ${reason_code}\nالمنتج: ${product_name||'غير محدد'}\nرسالة الزبون: ${customer_message||'—'}\n\nhttps://app.manychat.com/fb4538388/chat/${subscriber_id}`;
      if(TG_TOKEN) try {
        const _tgRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: TG_CHAT, text: msg + (_CAPTURE_REASONS.has(reason_code)?'\n\n↩️ جاوب على هاد الرسالة (Reply) باش يتسجّل كتعلّم بشري':'') })
        });
        const _tgJson = await _tgRes.json().catch(()=>null);
        if(_tgJson && _tgJson.ok && _tgJson.result && _tgJson.result.message_id){ await pool.query("UPDATE aykoshop_interventions SET tg_message_id=$2 WHERE id=$1",[r.rows[0].id, String(_tgJson.result.message_id)]).catch(()=>{}); }
      } catch(tgErr) { console.error('[interventions] Telegram error:', tgErr.message); }
    }

    // Broadcast to all SSE clients
    const pendingR = await pool.query("SELECT COUNT(*) as n FROM aykoshop_interventions WHERE status='pending' AND is_test IS NOT TRUE AND created_at > NOW() - INTERVAL '24 hours'").catch(()=>({rows:[{n:0}]}));
    _broadcast('intervention', {
      intervention: r.rows[0],
      pending: parseInt(pendingR.rows[0].n || 0),
      priority: priority
    });

    res.json({ success: true, intervention: r.rows[0] });
  } catch(e) {
    console.error('[interventions create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/interventions
app.get('/api/interventions', async (req, res) => {
  try {
    const { status = 'pending', reason_code, channel, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const vals = [];
    let i = 1;

    if (status !== 'all') { conditions.push(`status = $${i++}`); vals.push(status); }
    if (reason_code)       { conditions.push(`reason_code = $${i++}`); vals.push(reason_code); }
    if (channel)           { conditions.push(`channel = $${i++}`); vals.push(channel); }

    if (!req.query.include_test) conditions.push("environment='prod'"); // ALLOWLIST: Inbox shows ONLY prod (test/qa/unknown hidden) unless ?include_test=1
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await pool.query(
      `SELECT *, EXTRACT(EPOCH FROM (NOW()-created_at))/60 AS minutes_waiting
       FROM aykoshop_interventions
       ${where}
       ORDER BY
         CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...vals, parseInt(limit), parseInt(offset)]
    );

    const counts = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending') AS pending,
        COUNT(*) FILTER (WHERE status='pending' AND priority='critical') AS critical,
        COUNT(*) FILTER (WHERE status='pending' AND priority='high') AS high,
        COUNT(*) FILTER (WHERE reason_code='PRODUCT_NOT_FOUND' AND status='pending') AS product_not_found,
        COUNT(*) FILTER (WHERE reason_code='LOW_CONFIDENCE' AND status='pending') AS low_confidence,
        COUNT(*) FILTER (WHERE reason_code='AI_LOOP_DETECTED' AND status='pending') AS ai_loop,
        COUNT(*) FILTER (WHERE reason_code='CUSTOMER_COMPLAINT' AND status='pending') AS complaints,
        COUNT(*) FILTER (WHERE reason_code='AI_REPLY_FAILED' AND status='pending') AS ai_failed,
        COUNT(*) FILTER (WHERE reason_code='PAYMENT_CONFUSION' AND status='pending') AS payment_confusion
      FROM aykoshop_interventions
      WHERE environment='prod' AND created_at > NOW() - INTERVAL '24 hours'`
    );

    res.json({ interventions: rows.rows, counts: counts.rows[0], total: rows.rowCount });
  } catch(e) {
    console.error('[interventions list]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/interventions/counts — badge count
app.get('/api/interventions/counts', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending') AS pending,
        COUNT(*) FILTER (WHERE status='pending' AND priority IN ('critical','high')) AS urgent
      FROM aykoshop_interventions
      WHERE environment='prod' AND created_at > NOW() - INTERVAL '24 hours'`
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/interventions/:id/resolve
app.patch('/api/interventions/:id/snooze', async (req, res) => {
  try { const hours=parseInt(req.body.hours)||4;
    await pool.query("UPDATE aykoshop_interventions SET status='snoozed', snoozed_until=NOW()+($1||' hours')::interval WHERE id=$2",[String(hours),req.params.id]);
    res.json({success:true}); } catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/macros', async (req,res)=>{ try{ const r=await pool.query("SELECT * FROM aykoshop_macros ORDER BY created_at DESC"); res.json(r.rows); }catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/macros', async (req,res)=>{ try{ const r=await pool.query("INSERT INTO aykoshop_macros (title,content,category) VALUES ($1,$2,$3) RETURNING *",[req.body.title||'',req.body.content||'',req.body.category||'general']); res.json(r.rows[0]); }catch(e){ res.status(500).json({error:e.message}); } });
app.delete('/api/macros/:id', async (req,res)=>{ try{ await pool.query("DELETE FROM aykoshop_macros WHERE id=$1",[req.params.id]); res.json({success:true}); }catch(e){ res.status(500).json({error:e.message}); } });
app.patch('/api/interventions/:id/resolve', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE aykoshop_interventions SET status='resolved', resolved_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ success: true, intervention: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/interventions/:id/dismiss
app.patch('/api/interventions/:id/dismiss', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE aykoshop_interventions SET status='dismissed', resolved_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/interventions/resolve-all
app.patch('/api/interventions/resolve-all', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE aykoshop_interventions SET status='resolved', resolved_at=NOW() WHERE status='pending' RETURNING id`
    );
    res.json({ success: true, resolved: r.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ==================== AI ANALYTICS & UNKNOWN KEYWORDS ====================

// GET /api/ai-analytics — comprehensive AI performance metrics
app.get('/api/ai-analytics', async (req, res) => {
  try {
    const [
      intervByReason, intervByChannel, intervTrend,
      totalCustomers, totalInterv, resolvedInterv,
      avgConf, lowConfProducts, topProducts
    ] = await Promise.all([
      pool.query(`
        SELECT reason_code, COUNT(*) as count, AVG(ai_confidence) as avg_conf
        FROM aykoshop_interventions
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY reason_code ORDER BY count DESC`),
      pool.query(`
        SELECT channel, COUNT(*) as count
        FROM aykoshop_interventions
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY channel ORDER BY count DESC`),
      pool.query(`
        SELECT DATE(created_at) as day, COUNT(*) as count
        FROM aykoshop_interventions
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY day ORDER BY day`),
      pool.query(`SELECT COUNT(DISTINCT subscriber_id) as n FROM aykoshop_profiles`),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_interventions WHERE created_at > NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_interventions WHERE status='resolved' AND created_at > NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT AVG(vector_sim) as avg FROM aykoshop_interventions WHERE vector_sim IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'`),
      pool.query(`
        SELECT product_name, COUNT(*) as misses
        FROM aykoshop_interventions
        WHERE reason_code IN ('PRODUCT_NOT_FOUND','LOW_CONFIDENCE') AND product_name IS NOT NULL
        GROUP BY product_name ORDER BY misses DESC LIMIT 10`),
      pool.query(`
        SELECT interested_in as product, COUNT(*) as mentions
        FROM aykoshop_profiles
        WHERE interested_in IS NOT NULL AND interested_in != ''
        GROUP BY interested_in ORDER BY mentions DESC LIMIT 10`)
    ]);

    const total = parseInt(totalInterv.rows[0].n || 0);
    const resolved = parseInt(resolvedInterv.rows[0].n || 0);
    const customers = parseInt(totalCustomers.rows[0].n || 0);
    const aiSuccessRate = customers > 0
      ? Math.max(0, Math.round((1 - total / Math.max(customers, 1)) * 100))
      : 100;

    res.json({
      summary: {
        total_interventions: total,
        resolved_interventions: resolved,
        resolution_rate: total > 0 ? Math.round(resolved / total * 100) : 0,
        avg_confidence: parseFloat((avgConf.rows[0].avg || 0).toFixed(3)),
        ai_success_rate: aiSuccessRate,
        total_customers: customers
      },
      by_reason: intervByReason.rows,
      by_channel: intervByChannel.rows,
      trend_7d: intervTrend.rows,
      low_confidence_products: lowConfProducts.rows,
      top_products: topProducts.rows
    });
  } catch(e) {
    console.error('[ai-analytics]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/unknown-keywords — list tracked unknown keywords
app.get('/api/unknown-keywords', async (req, res) => {
  try {
    const { action = 'all', limit = 100 } = req.query;
    const where = action !== 'all' ? `WHERE action = '${action.replace(/'/g,'')}'` : '';
    const r = await pool.query(
      `SELECT * FROM aykoshop_unknown_keywords ${where} ORDER BY occurrences DESC, last_seen DESC LIMIT $1`,
      [parseInt(limit)]
    );
    const counts = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE action='pending') as pending,
        COUNT(*) FILTER (WHERE action='mapped') as mapped,
        COUNT(*) FILTER (WHERE action='ignored') as ignored
      FROM aykoshop_unknown_keywords`
    );
    res.json({ keywords: r.rows, counts: counts.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/unknown-keywords — add or increment keyword (called from n8n)
app.post('/api/unknown-keywords', async (req, res) => {
  try {
    const { keyword, channel, subscriber_id, customer_name } = req.body;
    if (!keyword || !keyword.trim()) return res.status(400).json({ error: 'keyword required' });
    const kw = keyword.trim().slice(0, 200);
    const r = await pool.query(`
      INSERT INTO aykoshop_unknown_keywords (keyword, channel, last_subscriber_id, last_customer_name, last_seen, occurrences)
      VALUES ($1, $2, $3, $4, NOW(), 1)
      ON CONFLICT (lower(keyword)) DO UPDATE SET
        occurrences = aykoshop_unknown_keywords.occurrences + 1,
        last_seen = NOW(),
        channel = EXCLUDED.channel,
        last_subscriber_id = EXCLUDED.last_subscriber_id,
        last_customer_name = EXCLUDED.last_customer_name
      RETURNING *`, [kw, channel||null, subscriber_id||null, customer_name||null]
    );
    res.json({ success: true, keyword: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/unknown-keywords/:id/map — map to product
app.patch('/api/unknown-keywords/:id/map', async (req, res) => {
  try {
    const { product } = req.body;
    const r = await pool.query(
      `UPDATE aykoshop_unknown_keywords SET action='mapped', suggested_product=$1 WHERE id=$2 RETURNING *`,
      [product||null, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ success: true, keyword: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/unknown-keywords/:id/ignore
app.patch('/api/unknown-keywords/:id/ignore', async (req, res) => {
  try {
    await pool.query(`UPDATE aykoshop_unknown_keywords SET action='ignored' WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ==================== LOST SALES CENTER ====================

// Price extractor helper
function extractPrice(priceStr) {
  if (!priceStr) return 0;
  const n = String(priceStr).replace(/[^0-9]/g, '');
  return parseInt(n || '0');
}

// GET /api/lost-sales — customers who showed intent but never ordered
app.get('/api/lost-sales', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours || '24');
    const limit = parseInt(req.query.limit || '100');

    // Get average product price for revenue estimation
    const avgR = await pool.query(`
      SELECT AVG(
        CASE WHEN REGEXP_REPLACE(price,'[^0-9]','','g') ~ '^[0-9]+$'
             THEN CAST(REGEXP_REPLACE(price,'[^0-9]','','g') AS INTEGER)
             ELSE NULL END
      ) as avg_price FROM aykoshop_products WHERE status='available' AND stock>0`);
    const avgPrice = Math.round(parseFloat(avgR.rows[0].avg_price || 500));

    // Product price lookup by name
    const prodR = await pool.query(`
      SELECT LOWER(product_name) as name,
        MIN(CAST(REGEXP_REPLACE(price,'[^0-9]','','g') AS INTEGER)) as min_price
      FROM aykoshop_products
      WHERE status='available' AND REGEXP_REPLACE(price,'[^0-9]','','g') ~ '^[0-9]+$'
      GROUP BY LOWER(product_name)`);
    const priceMap = {};
    for (const r of prodR.rows) {
      if (r.min_price > 0) priceMap[r.name] = r.min_price;
    }

    const r = await pool.query(`
      SELECT p.subscriber_id, p.customer_name, p.channel, p.stage,
             p.interested_in, p.last_seen, p.total_messages,
             p.wa_phone, p.manychat_link,
             ROUND(EXTRACT(EPOCH FROM (NOW()-p.last_seen))/3600) as hours_inactive,
             rq.trigger_message as last_rescue_msg,
             rq.status as rescue_status
      FROM aykoshop_profiles p
      LEFT JOIN aykoshop_orders o ON o.subscriber_id = p.subscriber_id
      LEFT JOIN aykoshop_rescue_queue rq ON rq.subscriber_id = p.subscriber_id
        AND rq.entered_queue_at = (
          SELECT MAX(entered_queue_at) FROM aykoshop_rescue_queue
          WHERE subscriber_id = p.subscriber_id
        )
      WHERE p.stage IN ('hot','warm','buyer','payment')
        AND o.id IS NULL
        AND p.last_seen < NOW() - ($1 || ' hours')::INTERVAL
        AND p.last_seen > NOW() - INTERVAL '30 days'
      ORDER BY p.last_seen DESC
      LIMIT $2`,
      [hours, limit]
    );

    // Attach revenue estimates
    const customers = r.rows.map(c => {
      const interested = (c.interested_in || '').toLowerCase();
      let estPrice = avgPrice;
      for (const [name, price] of Object.entries(priceMap)) {
        if (interested.includes(name) || name.includes(interested.replace(/\s+/g,'').slice(0,5))) {
          estPrice = price; break;
        }
      }
      return { ...c, est_revenue: estPrice };
    });

    const totalEstRevenue = customers.reduce((s, c) => s + (c.est_revenue || 0), 0);

    const counts = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE stage='hot') as hot,
        COUNT(*) FILTER (WHERE stage='warm') as warm,
        COUNT(*) FILTER (WHERE stage='payment') as payment
      FROM aykoshop_profiles p
      LEFT JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id
      WHERE p.stage IN ('hot','warm','buyer','payment') AND o.id IS NULL
        AND p.last_seen < NOW() - ($1 || ' hours')::INTERVAL
        AND p.last_seen > NOW() - INTERVAL '30 days'`,
      [hours]
    );

    res.json({
      customers,
      summary: {
        total: customers.length,
        hot: parseInt(counts.rows[0].hot||0),
        warm: parseInt(counts.rows[0].warm||0),
        payment: parseInt(counts.rows[0].payment||0),
        total_est_revenue: totalEstRevenue,
        avg_price: avgPrice,
        hours_threshold: hours
      }
    });
  } catch(e) {
    console.error('[lost-sales]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== FOLLOW-UP QUEUE ====================

// GET /api/followups
app.get('/api/followups', async (req, res) => {
  try {
    const { status = 'pending', limit = 50 } = req.query;
    const where = status === 'all' ? '' : `WHERE f.status = '${status.replace(/'/g,'')}'`;
    const r = await pool.query(`
      SELECT f.*,
        EXTRACT(EPOCH FROM (f.due_at - NOW()))/60 AS due_in_mins,
        CASE WHEN f.due_at < NOW() THEN true ELSE false END AS overdue
      FROM aykoshop_followups f
      ${where}
      ORDER BY
        CASE f.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        f.due_at ASC
      LIMIT $1`,
      [parseInt(limit)]
    );
    const counts = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='pending' AND due_at <= NOW()) AS overdue,
        COUNT(*) FILTER (WHERE status='pending' AND due_at > NOW()) AS upcoming,
        COUNT(*) FILTER (WHERE status='done') AS done_today
      FROM aykoshop_followups
      WHERE created_at > NOW() - INTERVAL '24 hours' OR status='pending'`);
    res.json({ followups: r.rows, counts: counts.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/followups — create manually
app.post('/api/followups', async (req, res) => {
  try {
    const { subscriber_id, customer_name, channel, wa_phone, manychat_link,
            type, due_at, priority, product_name, est_revenue, notes, intervention_id, rescue_id } = req.body;
    if (!subscriber_id || !type) return res.status(400).json({ error: 'subscriber_id and type required' });
    const r = await pool.query(`
      INSERT INTO aykoshop_followups
        (subscriber_id, customer_name, channel, wa_phone, manychat_link,
         type, due_at, priority, product_name, est_revenue, notes, intervention_id, rescue_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (subscriber_id, type) WHERE status='pending'
      DO UPDATE SET due_at=EXCLUDED.due_at, notes=EXCLUDED.notes
      RETURNING *`,
      [subscriber_id, customer_name||null, channel||null, wa_phone||null, manychat_link||null,
       type, due_at||new Date(Date.now()+2*3600000).toISOString(), priority||'medium',
       product_name||null, est_revenue||0, notes||null, intervention_id||null, rescue_id||null]
    );
    res.json({ success: true, followup: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/followups/auto-scan — auto-create followups for hot customers
app.post('/api/followups/auto-scan', async (req, res) => {
  try {
    let created = 0;

    // 1. Hot/warm customers with no order, inactive 24h+
    const hotR = await pool.query(`
      SELECT p.subscriber_id, p.customer_name, p.channel, p.wa_phone, p.manychat_link,
             p.interested_in, p.stage
      FROM aykoshop_profiles p
      LEFT JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id
      LEFT JOIN aykoshop_followups f ON f.subscriber_id=p.subscriber_id
        AND f.type='hot_no_order' AND f.status='pending'
      WHERE p.stage IN ('hot','warm')
        AND o.id IS NULL AND f.id IS NULL
        AND p.last_seen > NOW() - INTERVAL '7 days'
        AND p.last_seen < NOW() - INTERVAL '20 hours'`
    );
    for (const c of hotR.rows) {
      await pool.query(`
        INSERT INTO aykoshop_followups
          (subscriber_id, customer_name, channel, wa_phone, manychat_link,
           type, due_at, priority, product_name, est_revenue)
        VALUES ($1,$2,$3,$4,$5,'hot_no_order',NOW() + INTERVAL '1 hour','high',$6,350)
        ON CONFLICT DO NOTHING`,
        [c.subscriber_id, c.customer_name, c.channel, c.wa_phone, c.manychat_link, c.interested_in]
      );
      created++;
    }

    // 2. Rescue queue pending >4h
    const rescueR = await pool.query(`
      SELECT rq.subscriber_id, rq.customer_name, rq.channel, rq.wa_phone, rq.manychat_link,
             rq.product_name, rq.id as rescue_id, rq.amount
      FROM aykoshop_rescue_queue rq
      LEFT JOIN aykoshop_followups f ON f.subscriber_id=rq.subscriber_id
        AND f.type='rescue_unresolved' AND f.status='pending'
      WHERE rq.status='pending'
        AND rq.entered_queue_at < NOW() - INTERVAL '4 hours'
        AND f.id IS NULL`
    );
    for (const c of rescueR.rows) {
      await pool.query(`
        INSERT INTO aykoshop_followups
          (subscriber_id, customer_name, channel, wa_phone, manychat_link,
           type, due_at, priority, product_name, est_revenue, rescue_id)
        VALUES ($1,$2,$3,$4,$5,'rescue_unresolved',NOW(),'critical',$6,$7,$8)
        ON CONFLICT DO NOTHING`,
        [c.subscriber_id, c.customer_name, c.channel, c.wa_phone, c.manychat_link,
         c.product_name, c.amount||0, c.rescue_id]
      );
      created++;
    }

    // 3. PAYMENT_INTENT interventions pending >2h
    const payR = await pool.query(`
      SELECT i.subscriber_id, i.customer_name, i.channel, i.product_name, i.id as interv_id
      FROM aykoshop_interventions i
      LEFT JOIN aykoshop_followups f ON f.subscriber_id=i.subscriber_id
        AND f.type='payment_abandoned' AND f.status='pending'
      WHERE i.reason_code IN ('PAYMENT_INTENT','PAYMENT_CONFUSION')
        AND i.status='pending'
        AND i.created_at < NOW() - INTERVAL '2 hours'
        AND f.id IS NULL`
    );
    for (const c of payR.rows) {
      await pool.query(`
        INSERT INTO aykoshop_followups
          (subscriber_id, customer_name, channel, type, due_at, priority, product_name, est_revenue, intervention_id)
        VALUES ($1,$2,$3,'payment_abandoned',NOW(),'critical',$4,500,$5)
        ON CONFLICT DO NOTHING`,
        [c.subscriber_id, c.customer_name, c.channel, c.product_name, c.interv_id]
      );
      created++;
    }

    res.json({ success: true, created });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/followups/:id/done
app.patch('/api/followups/:id/done', async (req, res) => {
  try {
    await pool.query(`UPDATE aykoshop_followups SET status='done' WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/followups/:id/snooze
app.patch('/api/followups/:id/snooze', async (req, res) => {
  try {
    const hours = parseInt(req.body.hours || '24');
    const snoozeUntil = new Date(Date.now() + hours * 3600000).toISOString();
    await pool.query(
      `UPDATE aykoshop_followups SET status='snoozed', snoozed_until=$1, due_at=$1 WHERE id=$2`,
      [snoozeUntil, req.params.id]
    );
    res.json({ success: true, snoozed_until: snoozeUntil });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/followups/:id/to-intervention — escalate to intervention
app.post('/api/followups/:id/to-intervention', async (req, res) => {
  try {
    const fR = await pool.query(`SELECT * FROM aykoshop_followups WHERE id=$1`, [req.params.id]);
    if (!fR.rows.length) return res.status(404).json({ error: 'not found' });
    const f = fR.rows[0];
    const iv = await pool.query(`
      INSERT INTO aykoshop_interventions
        (subscriber_id, customer_name, channel, wa_phone, manychat_link,
         reason_code, reason_detail, product_name, priority, status, created_at)
      VALUES ($1,$2,$3,$4,$5,'HUMAN_REQUESTED','Escalated from Follow-Up Queue',$6,'high','pending',NOW())
      RETURNING *`,
      [f.subscriber_id, f.customer_name, f.channel, f.wa_phone, f.manychat_link, f.product_name]
    );
    await pool.query(`UPDATE aykoshop_followups SET status='done' WHERE id=$1`, [req.params.id]);
    // Broadcast to SSE
    const pendingR = await pool.query("SELECT COUNT(*) as n FROM aykoshop_interventions WHERE status='pending' AND is_test IS NOT TRUE").catch(()=>({rows:[{n:0}]}));
    _broadcast('intervention', { intervention: iv.rows[0], pending: parseInt(pendingR.rows[0].n||0), priority:'high' });
    res.json({ success: true, intervention: iv.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reports/sales-audit — rich conversation-quality audit (last N hours). ?store=1 persists for comparison.
app.get('/api/reports/sales-audit', async (req,res)=>{
  try{
    const hrs = Math.min(168, Math.max(1, parseInt(req.query.hours)||24));
    const since = "now() - interval '"+hrs+" hours'";
    const ROBO = ["كيف يمكنني مساعدتك","كيف أستطيع مساعدتك","شنو تبغي بالضبط","شنو بغيتي بالضبط","راني هنا","بالتوفيق","كيف يمكنني خدمتك"];
    const OBJ  = [["غالي","غالي/ثمن"],["معنديش","ماعنديش الفلوس"],["ما عنديش","ماعنديش الفلوس"],["نجمع","نجمع الفلوس"],["من بعد","من بعد/لاحقاً"],["منبعد","من بعد/لاحقاً"],["نرجع","غادي نرجع"],["مضمون","واش مضمون"],["خايف","خوف/ثقة"]];
    const ch = await pool.query("SELECT subscriber_id, role, message, created_at FROM aykoshop_chat_history WHERE created_at > "+since+" ORDER BY subscriber_id, created_at");
    const rows = ch.rows;
    const roboEx=[]; let roboN=0; const seen={}; const repEx=[]; let repN=0; const objEx=[]; let objN=0; const objBy={};
    for(const r of rows){ const m=(r.message||'');
      if(r.role==='assistant'){
        if(ROBO.some(x=>m.indexOf(x)>=0)){ roboN++; if(roboEx.length<8) roboEx.push({subscriber_id:r.subscriber_id,reply:m.slice(0,180)}); }
        const key=r.subscriber_id+'|'+m.trim(); seen[key]=(seen[key]||0)+1;
        if(seen[key]===2){ repN++; if(repEx.length<8) repEx.push({subscriber_id:r.subscriber_id,reply:m.slice(0,180)}); }
      } else if(r.role==='user'){
        for(const o of OBJ){ if(m.indexOf(o[0])>=0){ objN++; objBy[o[1]]=(objBy[o[1]]||0)+1; if(objEx.length<10) objEx.push({subscriber_id:r.subscriber_id,type:o[1],msg:m.slice(0,160)}); break; } }
      }
    }
    let budgetN=0; const budgetEx=[];
    for(const r of rows){ if(r.role==='user' && /([0-9]{2,5})\s*(درهم|dh|dirham|درام|dhs)/i.test(r.message||'')){ budgetN++; if(budgetEx.length<6) budgetEx.push({subscriber_id:r.subscriber_id,msg:(r.message||'').slice(0,120)}); } }
    const iv = await pool.query("SELECT reason_code, status, count(*)::int n FROM aykoshop_interventions WHERE created_at > "+since+" GROUP BY reason_code,status");
    const ivBy={}; iv.rows.forEach(x=>{ ivBy[x.reason_code]=ivBy[x.reason_code]||{}; ivBy[x.reason_code][x.status]=x.n; });
    const sum=rc=> ivBy[rc]?Object.values(ivBy[rc]).reduce((a,b)=>a+b,0):0;
    const hll = await pool.query("SELECT count(*)::int n FROM aykoshop_interventions i WHERE i.reason_code='HOT_LEAD' AND i.created_at > "+since+" AND NOT EXISTS (SELECT 1 FROM aykoshop_orders o WHERE o.subscriber_id=i.subscriber_id AND o.created_at>=i.created_at)");
    const conv = await pool.query("SELECT count(DISTINCT u.subscriber_id)::int n FROM aykoshop_ai_usage u WHERE u.created_at > "+since+" AND u.intent IN ('buy','payment') AND u.subscriber_id ~ '^[0-9]+$' AND NOT EXISTS (SELECT 1 FROM aykoshop_orders o WHERE o.subscriber_id=u.subscriber_id AND o.created_at > "+since+")");
    const lost = await pool.query("SELECT count(*)::int n FROM aykoshop_profiles p LEFT JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id WHERE p.stage IN ('hot','warm') AND o.id IS NULL AND p.last_seen > "+since);
    const claimsPending = await pool.query("SELECT count(*)::int n FROM aykoshop_payment_claims WHERE status='pending' AND is_test IS NOT TRUE");
    const report = {
      window_hours: hrs, generated_at: new Date().toISOString(),
      conversations: new Set(rows.map(r=>r.subscriber_id)).size, messages: rows.length,
      lost_sales: parseInt(lost.rows[0].n||0),
      hot_leads_lost: parseInt(hll.rows[0].n||0),
      conversion_opportunities: parseInt(conv.rows[0].n||0),
      robotic_replies: roboN, repeated_replies: repN,
      objections: objN, objections_by_type: objBy,
      budget_mentions: budgetN,
      payment_issues: sum('PAYMENT_INTENT')+sum('PAYMENT_METHOD_UNKNOWN')+sum('FRAUD_REVIEW'),
      payment_claims_pending: parseInt(claimsPending.rows[0].n||0),
      fraud_reviews: sum('FRAUD_REVIEW'),
      interventions_by_code: ivBy,
      examples: { robotic: roboEx, repeated: repEx, objections: objEx, budget: budgetEx }
    };
    if(req.query.store==='1'){ await pool.query("INSERT INTO aykoshop_sales_audits (window_hours, report) VALUES ($1,$2)",[hrs, JSON.stringify(report)]).catch(()=>{}); }
    res.json(report);
  }catch(e){ console.error('[sales-audit]', e.message); res.status(500).json({ error:e.message }); }
});
// GET /api/reports/sales-audit/history — last stored audits for comparison
app.get('/api/reports/sales-audit/history', async (req,res)=>{
  try{ const r=await pool.query("SELECT id, created_at, window_hours, report FROM aykoshop_sales_audits ORDER BY created_at DESC LIMIT 14"); res.json(r.rows); }catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/ops/kpis", async (req,res)=>{
  try{
    const q=(sql)=>pool.query(sql).then(r=>parseInt(r.rows[0].n||0)).catch(()=>0);
    const [hot,resv,payPending,payConfirmed,fraud,delToday,delPending,lost]=await Promise.all([
      q("SELECT count(*)::int n FROM aykoshop_interventions WHERE reason_code=\x27HOT_LEAD\x27 AND status=\x27pending\x27"),
      q("SELECT count(*)::int n FROM aykoshop_deposits WHERE status=\x27reserved\x27"),
      q("SELECT count(*)::int n FROM aykoshop_payment_claims WHERE status=\x27pending\x27 AND is_test IS NOT TRUE"),
      q("SELECT count(*)::int n FROM aykoshop_payment_claims WHERE status=\x27confirmed\x27 AND is_test IS NOT TRUE"),
      q("SELECT count(*)::int n FROM aykoshop_interventions WHERE reason_code=\x27FRAUD_REVIEW\x27 AND status=\x27pending\x27"),
      q("SELECT count(*)::int n FROM aykoshop_orders WHERE status=\x27delivered\x27 AND created_at >= date_trunc(\x27day\x27,now())"),
      q("SELECT count(*)::int n FROM aykoshop_interventions WHERE reason_code=\x27DELIVERY_REQUIRED\x27 AND status=\x27pending\x27"),
      q("SELECT count(*)::int n FROM aykoshop_profiles p LEFT JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id WHERE p.stage IN (\x27hot\x27,\x27warm\x27) AND o.id IS NULL AND p.last_seen > now()-interval \x2724 hours\x27")
    ]);
    res.json({ hot_leads:hot, reservations:resv, payment_claims_pending:payPending, payments_confirmed:payConfirmed, fraud_reviews:fraud, deliveries_today:delToday, delivery_pending:delPending, lost_buyers:lost, ts:new Date().toISOString() });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ==================== KNOWLEDGE BASE (HITL) ENDPOINTS ====================
// POST /api/knowledge/learn — approve a human answer into the KB (durable knowledge ONLY; never prices/stock/payment)
app.post('/api/knowledge/learn', async (req,res)=>{ try{
  const b=req.body||{}; const q=String(b.question||b.customer_message||'').trim(); const a=String(b.answer||b.correct_reply||'').trim();
  if(!q||!a) return res.status(400).json({error:'question and answer required'});
  let aG=String(a).replace(/([0-9]{2,6})\s*(درهم|dh|dirham|dhs|dollar|\$)/gi,'[الثمن حسب الكاطالوج]').replace(/\b(cih|barid\s?bank|barid|binance|wafacash|cashplus|paypal)\b/gi,'[طريقة الدفع الرسمية]');
  if(/\bRIB\b|\bIBAN\b|رقم الحساب|[0-9]{10,}|كود التفعيل|رمز الحساب|[\w.\-]+@[\w.\-]+\.\w{2,}/i.test(aG)){
    return res.status(422).json({error:'refused: contains account number / activation code (cannot be stored even as style)', refused:true});
  }
  const _nq=await _normForEmbed(q); const emb=await _embed(_nq||q); const v=emb?('['+emb.join(',')+']'):null;
  const cat=b.category||'general'; const src=b.source||'human_approved'; const by=b.approved_by||'operator';
  const et=b.entry_type||'faq'; const oc=b.objection_category||null;
  const r=await pool.query("INSERT INTO aykoshop_conversation_examples (category,customer_message,correct_reply,source,subscriber_id,approved,embedding,channel,approved_by,usage_count,norm_text,entry_type,objection_category) VALUES ($1,$2,$3,$4,$5,$12,$6::vector,$7,$8,0,$9,$10,$11) RETURNING id",[cat,q,aG,src,b.subscriber_id||null,v,b.channel||null,by,_nq,et,oc,(b.auto_approve===true)]);
  if(b.intervention_id){ await pool.query("UPDATE aykoshop_interventions SET status='resolved', resolved_at=NOW() WHERE id=$1",[b.intervention_id]).catch(()=>{}); }
  res.json({ ok:true, id:r.rows[0].id, embedded:!!emb, pending:!(b.auto_approve===true) });
}catch(e){ res.status(500).json({error:e.message}); } });

// GET /api/knowledge — list learned entries (most-used first)
app.get('/api/knowledge', async (req,res)=>{ try{
  const r=await pool.query("SELECT id,category,customer_message,correct_reply,source,approved,usage_count,last_used,review_flag,created_at FROM aykoshop_conversation_examples WHERE approved=true ORDER BY usage_count DESC, created_at DESC LIMIT 200");
  res.json(r.rows);
}catch(e){ res.status(500).json({error:e.message}); } });

// PATCH /api/knowledge/:id — edit/flag/delete-soft a KB entry (re-embeds question if changed)
app.patch('/api/knowledge/:id', async (req,res)=>{ try{
  const b=req.body||{};
  if(b.delete){ await pool.query("UPDATE aykoshop_conversation_examples SET approved=false, review_flag=true WHERE id=$1",[req.params.id]); return res.json({ok:true,deleted:true}); }
  if(b.review_flag!=null){ await pool.query("UPDATE aykoshop_conversation_examples SET review_flag=$2 WHERE id=$1",[req.params.id,!!b.review_flag]); }
  if(b.correct_reply){ await pool.query("UPDATE aykoshop_conversation_examples SET correct_reply=$2 WHERE id=$1",[req.params.id,String(b.correct_reply).slice(0,2000)]); }
  if(b.question){ const emb=await _embed(b.question); const v=emb?('['+emb.join(',')+']'):null; await pool.query("UPDATE aykoshop_conversation_examples SET customer_message=$2, embedding=$3::vector WHERE id=$1",[req.params.id,String(b.question).slice(0,500),v]); }
  res.json({ok:true});
}catch(e){ res.status(500).json({error:e.message}); } });

// GET /api/knowledge/stats
app.get('/api/knowledge/stats', async (req,res)=>{ try{
  const tot=await pool.query("SELECT count(*)::int n, COALESCE(SUM(usage_count),0)::int uses FROM aykoshop_conversation_examples WHERE approved=true AND embedding IS NOT NULL");
  const rec=await pool.query("SELECT count(*)::int n FROM aykoshop_conversation_examples WHERE approved=true AND created_at>now()-interval '24 hours'");
  const unk=await pool.query("SELECT count(*)::int n FROM aykoshop_interventions WHERE reason_code='UNKNOWN_QUESTION' AND status='pending'");
  res.json({ learned:tot.rows[0].n, total_uses:tot.rows[0].uses, learned_24h:rec.rows[0].n, unknown_pending:unk.rows[0].n });
}catch(e){ res.status(500).json({error:e.message}); } });

// GET /api/reports/learning-audit — nightly learning report (?store=1 persists)
app.get('/api/reports/learning-audit', async (req,res)=>{ try{
  const hrs=Math.min(168,Math.max(1,parseInt(req.query.hours)||24)); const since="now() - interval '"+hrs+" hours'";
  const learned=await pool.query("SELECT id, left(customer_message,120) AS q, left(correct_reply,140) AS a, usage_count FROM aykoshop_conversation_examples WHERE approved=true AND created_at > "+since+" ORDER BY created_at DESC LIMIT 20");
  const topUsed=await pool.query("SELECT left(customer_message,120) AS q, usage_count FROM aykoshop_conversation_examples WHERE approved=true AND usage_count>0 ORDER BY usage_count DESC LIMIT 10");
  const unknowns=await pool.query("SELECT left(customer_message,140) AS q, count(*)::int n FROM aykoshop_interventions WHERE reason_code='UNKNOWN_QUESTION' AND created_at > "+since+" GROUP BY left(customer_message,140) ORDER BY n DESC LIMIT 15");
  const pendingUnk=await pool.query("SELECT count(*)::int n FROM aykoshop_interventions WHERE reason_code='UNKNOWN_QUESTION' AND status='pending'");
  const kbHighR=await pool.query("SELECT count(*)::int n FROM aykoshop_ai_usage WHERE created_at > "+since+" AND route_layer='kb_high'");
  const genR=await pool.query("SELECT count(*)::int n FROM aykoshop_ai_usage WHERE created_at > "+since+" AND role IN ('sales','support') AND mode IN ('primary','fallback')");
  const kbHigh=kbHighR.rows[0].n||0, genN=genR.rows[0].n||0;
  const report={ window_hours:hrs, generated_at:new Date().toISOString(),
    questions_learned: learned.rows.length, learned_today: learned.rows,
    top_learned_used: topUsed.rows, top_unknown_questions: unknowns.rows,
    unknown_pending: pendingUnk.rows[0].n,
    kb_direct_answers: kbHigh, generations: genN,
    retrieval_rate_pct: (kbHigh+genN)>0?Math.round(kbHigh/(kbHigh+genN)*100):0,
    tokens_saved_est: kbHigh*350 };
  if(req.query.store==='1'){ await pool.query("INSERT INTO aykoshop_sales_audits (window_hours, report) VALUES ($1,$2)",[hrs, JSON.stringify({learning:report})]).catch(()=>{}); }
  res.json(report);
}catch(e){ res.status(500).json({error:e.message}); } });

// GET /api/knowledge/sales-winners — auto-detect converted conversations (order/reservation) -> learn candidates (review only)
app.get('/api/knowledge/sales-winners', async (req,res)=>{ try{
  const days=Math.min(90,Math.max(1,parseInt(req.query.days)||14));
  const subs=await pool.query("SELECT DISTINCT subscriber_id FROM (SELECT subscriber_id FROM aykoshop_orders WHERE created_at>now()-($1||' days')::interval UNION SELECT subscriber_id FROM aykoshop_deposits WHERE status IN ('reserved','confirmed') AND created_at>now()-($1||' days')::interval) z WHERE subscriber_id ~ '^[0-9]+$' LIMIT 40",[String(days)]);
  const out=[];
  for(const s of subs.rows){
    const h=await pool.query("SELECT role, message FROM aykoshop_chat_history WHERE subscriber_id=$1 ORDER BY created_at LIMIT 60",[s.subscriber_id]);
    const rows=h.rows; let taken=0;
    for(let i=0;i<rows.length-1 && taken<2;i++){
      if(rows[i].role==='user' && rows[i+1].role==='assistant' && (rows[i+1].message||'').length>45){
        const cm=(rows[i].message||'').slice(0,300);
        const dup=await pool.query("SELECT 1 FROM aykoshop_conversation_examples WHERE customer_message=$1 LIMIT 1",[cm]).then(r=>r.rows.length).catch(()=>0);
        if(!dup){ out.push({ subscriber_id:s.subscriber_id, customer_message:cm, winning_reply:(rows[i+1].message||'').slice(0,500) }); taken++; }
      }
    }
  }
  res.json({ days, converted_conversations:subs.rows.length, candidates: out.slice(0,50) });
}catch(e){ res.status(500).json({error:e.message}); } });

// PATCH /api/knowledge/:id/score — increment a sales-memory counter (success/reservation/order)
app.patch('/api/knowledge/:id/score', async (req,res)=>{ try{
  const f=req.body&&req.body.field;
  if(['success_count','reservation_count','order_count'].indexOf(f)<0) return res.status(400).json({error:'invalid field'});
  await pool.query("UPDATE aykoshop_conversation_examples SET "+f+"="+f+"+1 WHERE id=$1",[req.params.id]);
  res.json({ok:true});
}catch(e){ res.status(500).json({error:e.message}); } });

// GET /api/buyer-context/:sub — full buyer context (dashboard panel)
app.get('/api/buyer-context/:sub', async (req,res)=>{ try{
  const sub=req.params.sub;
  const r=await pool.query("SELECT subscriber_id, customer_name, buyer_type, personality_type, favorite_game, budget, last_product_viewed, total_messages, lifetime_value, buyer_context_updated_at FROM aykoshop_profiles WHERE subscriber_id=$1",[sub]);
  const oc=await pool.query("SELECT count(*)::int n, max(product_name) lp FROM aykoshop_orders WHERE subscriber_id=$1",[sub]).catch(()=>({rows:[{n:0}]}));
  const dc=await pool.query("SELECT count(*)::int n FROM aykoshop_deposits WHERE subscriber_id=$1 AND status IN ('reserved','confirmed')",[sub]).catch(()=>({rows:[{n:0}]}));
  const summary=await _buyerContext(sub);
  res.json({ profile:r.rows[0]||null, orders:(oc.rows[0]||{}).n||0, last_order_product:(oc.rows[0]||{}).lp||null, reservations:(dc.rows[0]||{}).n||0, ai_summary:summary });
}catch(e){ res.status(500).json({error:e.message}); } });

// GET /api/ops/kpis-by-type — conversion by buyer type
app.get('/api/ops/kpis-by-type', asyncHandler(async (req,res)=>{
  const t=await pool.query("SELECT buyer_type, count(*)::int leads FROM aykoshop_profiles WHERE buyer_type IS NOT NULL GROUP BY buyer_type ORDER BY leads DESC");
  const conv=await pool.query("SELECT p.buyer_type, count(DISTINCT o.subscriber_id)::int buyers FROM aykoshop_profiles p JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id WHERE p.buyer_type IS NOT NULL GROUP BY p.buyer_type");
  const cmap={}; conv.rows.forEach(x=>cmap[x.buyer_type]=x.buyers);
  const out=t.rows.map(x=>({ buyer_type:x.buyer_type, leads:x.leads, converted:cmap[x.buyer_type]||0, conv_pct: x.leads>0?Math.round((cmap[x.buyer_type]||0)/x.leads*100):0 }));
  res.json({ by_type: out });
}));

// ===== MISSING PRODUCT TRACKING =====
app.get('/api/missing-products/scan', async (req,res)=>{ try{
  const days=Math.min(120,Math.max(1,parseInt(req.query.days)||30));
  const agg=await pool.query("SELECT label, count(DISTINCT subscriber_id)::int customers, count(*)::int mentions, max(created_at) last_req, (array_agg(message ORDER BY created_at DESC))[1] sample FROM (SELECT subscriber_id, message, created_at, CASE WHEN message ~* 'pes|\\ypss\\y' THEN 'PES' WHEN message ~* '\\yfc\\y|fc2|fifa|فيفا' THEN 'FC/FIFA' WHEN message ~* 'pubg|ببجي|بوبجي' THEN 'PUBG' WHEN message ~* 'viking|فايكينغ|فيكينغ' THEN 'Viking Rise' WHEN message ~* 'efootball|ايفوتبول' THEN 'eFootball' WHEN message ~* 'brawl|براول' THEN 'Brawl Stars' WHEN message ~* 'clash|كلاش' THEN 'Clash' ELSE NULL END label FROM aykoshop_chat_history WHERE role='user' AND created_at > now()-($1||' days')::interval) t WHERE label IS NOT NULL GROUP BY label",[String(days)]);
  for(const row of agg.rows){ await pool.query("INSERT INTO aykoshop_missing_products (product_key,request_count,customer_count,last_requested,sample_message,updated_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (product_key) DO UPDATE SET request_count=$2,customer_count=$3,last_requested=$4,sample_message=$5,updated_at=now()",[row.label,row.mentions,row.customers,row.last_req,String(row.sample||'').slice(0,200)]).catch(function(){}); }
  res.json({ scanned_days:days, updated:agg.rows.length, items:agg.rows });
}catch(e){ res.status(500).json({error:e.message}); } });

app.get('/api/missing-products', async (req,res)=>{ try{
  const r=await pool.query("SELECT product_key, request_count, customer_count, last_requested, sample_message, resolved FROM aykoshop_missing_products ORDER BY resolved ASC, customer_count DESC, request_count DESC");
  res.json({ missing: r.rows });
}catch(e){ res.status(500).json({error:e.message}); } });

app.patch('/api/missing-products/:key/resolve', async (req,res)=>{ try{
  await pool.query("UPDATE aykoshop_missing_products SET resolved=$2, updated_at=now() WHERE product_key=$1",[req.params.key, (req.body&&req.body.resolved)!==false]);
  res.json({ok:true});
}catch(e){ res.status(500).json({error:e.message}); } });

// ===== KB PENDING QUEUE (human learning — review BEFORE it goes live) =====
app.get('/api/knowledge/pending', async (req,res)=>{ try{
  const r=await pool.query("SELECT id, category, entry_type, customer_message, correct_reply, source, created_at FROM aykoshop_conversation_examples WHERE approved=false ORDER BY created_at DESC LIMIT 200");
  res.json({ pending: r.rows });
}catch(e){ res.status(500).json({error:e.message}); } });

app.patch('/api/knowledge/:id/approve', async (req,res)=>{ try{
  const r=await pool.query("UPDATE aykoshop_conversation_examples SET approved=true, approved_by=$2 WHERE id=$1 AND approved=false RETURNING id",[req.params.id, (req.body&&req.body.approved_by)||'operator']);
  res.json({ ok:true, approved: r.rows.length>0 });
}catch(e){ res.status(500).json({error:e.message}); } });

app.patch('/api/knowledge/:id/reject', async (req,res)=>{ try{
  await pool.query("DELETE FROM aykoshop_conversation_examples WHERE id=$1 AND approved=false",[req.params.id]);
  res.json({ ok:true, rejected:true });
}catch(e){ res.status(500).json({error:e.message}); } });

// ===== Outcome Learning V4 — Stage S0 Observatory (READ-ONLY, observe-only). Empty unless ff_outcome_v4_observe='on'. =====
// Populated by the standalone aykoshop-night-coach.js batch (never the live path). The brain never reads this table.
app.get('/api/patterns/performance', async (req,res)=>{ try{
  const _on = await _ff('outcome_v4_observe');
  if(!_on) return res.json({ ok:true, enabled:false, banner:null, cells:[], total:0 });
  let _rows=[]; try{ const r=await pool.query("SELECT tactic_category, state_bucket, n_trials, successes_weighted, base_rate, posterior_mean, ci_low, ci_high, lift, gate_pass, state_source, sample_patterns, last_scored FROM aykoshop_pattern_perf ORDER BY state_bucket, lift DESC NULLS LAST, tactic_category"); _rows=r.rows; }catch(_e){ /* table not yet created by the night job */ }
  const _anyGate=_rows.some(function(x){return x.gate_pass;});
  res.json({ ok:true, enabled:true,
    banner:'👁️ مراقبة فقط · prior-dominated · ماشي قرار (NOT decision-grade)'+(_anyGate?'':' · لا أدلة كافية بعد — كلشي قريب من الـbaseline'),
    note:'الحركات بـ lift موجب = مفيدة داخل نفس الحالة؛ lift سالب = anti (ارتباط ماشي سبب).',
    cells:_rows, total:_rows.length, last_scored:(_rows[0]&&_rows[0].last_scored)||null });
}catch(e){ res.status(500).json({error:e.message}); } });

// ===== HERMES PRODUCT ADVISOR — Demand vs Inventory (read-only). Mines REAL customer messages (test-filtered) for what they ASK for, compares to available catalog, flags gaps + estimates lost revenue. =====
function _hdGame(t){ t=String(t||'').toLowerCase();
  if(/فري ?فاير|free ?fire|freefire|\bff\b|فري فري/.test(t)) return 'Free Fire';
  if(/\bpes\b|بيس|efootball|اي ?فوتبول|إيفوتبول|fifa|فيفا|\bfc ?\d?\b/.test(t)) return 'PES';
  if(/pubg|ببجي|بوبجي/.test(t)) return 'PUBG';
  if(/نتفليكس|netflix|نتفلكس/.test(t)) return 'Netflix';
  if(/تيك ?توك|tiktok/.test(t)) return 'TikTok';
  return null; }
function _hdType(t){ t=String(t||'').toLowerCase();
  if(/اشتراك|نتفليكس|netflix|subscription|abonn/.test(t)) return 'subscription';
  if(/شحن|جواهر|دياموند|diamond|recharge|شحان|رشارج/.test(t)) return 'recharge';
  if(/كود|سكين|سكن|سلاح|\bcode\b|skin/.test(t)) return 'code';
  if(/حساب|كونط|كومت|account|compte/.test(t)) return 'account';
  return null; }
function _hdBudgets(t){ const s=String(t||''); if(/https?:\/\/|fbcdn|scontent|lookaside|\.(jpg|png|mp4|ogg)/i.test(s)) return []; // skip URLs/media (their digits are not prices)
  const out=[]; const re=/(\d{2,4})\s*(?:درهم|dh|dhs|dirham|د\.?ه|dh\.)?/gi; let m;
  while((m=re.exec(s))!==null){ const n=parseInt(m[1],10); if(n>=50 && n<=3000) out.push(n); } return out; }
// pure extractor (testable): messages=[{subscriber,text}] -> demand map keyed by game|type.
// Aggregates PER SUBSCRIBER first (merges game+type+budget across all their messages) so
// "فري فاير" in one msg + "حساب ب 250" in another = one Free Fire|account demand, not fragments.
function _hdExtract(messages){
  const bySub={};
  for(const msg of (messages||[])){
    const t=msg.text||''; const g=_hdGame(t), ty=_hdType(t); const b=_hdBudgets(t);
    if(!g && !ty && !b.length) continue;
    const s=String(msg.subscriber||'?');
    const e=bySub[s]||(bySub[s]={games:{},types:{},budgets:[],samples:[]});
    if(g) e.games[g]=(e.games[g]||0)+1;
    if(ty) e.types[ty]=(e.types[ty]||0)+1;
    for(const x of b) e.budgets.push(x);
    if(e.samples.length<3 && t.length>3 && (g||ty)) e.samples.push(t.slice(0,60));
  }
  const _mode=(obj)=>{ let best=null,bc=-1; for(const k of Object.keys(obj)){ if(obj[k]>bc){bc=obj[k];best=k;} } return best; };
  const demand={};
  for(const s of Object.keys(bySub)){
    const e=bySub[s]; const g=_mode(e.games), ty=_mode(e.types);
    if(!g && !ty) continue;                       // only a bare number, no product intent
    const key=(g||'?')+'|'+(ty||'?');
    const d=demand[key]||(demand[key]={game:g,type:ty,subs:new Set(),budgets:[],samples:[]});
    d.subs.add(s);
    for(const x of e.budgets) d.budgets.push(x);
    for(const sm of e.samples){ if(d.samples.length<3) d.samples.push(sm); }
  }
  return demand;
}
function _hdMedian(a){ if(!a.length) return null; const s=a.slice().sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2); }
function _hdParsePrice(p){ const m=String(p||'').match(/\d{2,6}/); return m?parseInt(m[0],10):null; }
app.get('/api/hermes/demand', async (req,res)=>{ try{
  if(String(req.query.selftest||'')==='1'){
    const fx=_hdExtract([
      {subscriber:'a',text:'سلام فري فاير'},
      {subscriber:'a',text:'بغيت حساب ب 250 درهم'},   // a: FF + account across 2 msgs -> must merge
      {subscriber:'a',text:'ممكن صورة'},               // noise, ignored
      {subscriber:'b',text:'عندك حساب فري فاير ب 400'},
      {subscriber:'c',text:'عطيني حسابات فري فاير ديال 500'},
      {subscriber:'d',text:'بغيت نتفليكس'} ]);
    const ff=fx['Free Fire|account'];
    return res.json({ selftest:true,
      ff_account_subs:ff?ff.subs.size:0, ff_budgets:ff?ff.budgets.slice().sort((x,y)=>x-y):[], ff_budget_median:ff?_hdMedian(ff.budgets):null,
      netflix:!!fx['Netflix|subscription'],
      pass:(!!ff && ff.subs.size===3 && _hdMedian(ff.budgets)===400 && !!fx['Netflix|subscription']) });
  }
  const days=Math.min(parseInt(req.query.days)||30, 180);
  // REAL customers only (Meta PSIDs are >=15 digits; exclude 999x test + short test IDs)
  const mr=await pool.query("SELECT subscriber_id, message FROM aykoshop_chat_history WHERE role='user' AND subscriber_id ~ '^[0-9]{15,}$' AND created_at > NOW() - ($1||' days')::interval", [String(days)]);
  const demand=_hdExtract(mr.rows.map(r=>({subscriber:r.subscriber_id, text:r.message})));
  // available inventory grouped by game|type
  const inv=await pool.query("SELECT game, product_type, product_name, price, min_price FROM aykoshop_products WHERE status='available'");
  const invByKey={};
  inv.rows.forEach(p=>{ const k=(p.game||'?')+'|'+(p.product_type||'?'); (invByKey[k]=invByKey[k]||[]).push({name:p.product_name, price:_hdParsePrice(p.min_price)||_hdParsePrice(p.price)}); });
  const rows=[];
  for(const key of Object.keys(demand)){
    const d=demand[key]; const inStock=invByKey[key]||[];
    const prices=inStock.map(x=>x.price).filter(x=>x!=null);
    const cheapest=prices.length?Math.min(...prices):null;
    const bMin=d.budgets.length?Math.min(...d.budgets):null, bMax=d.budgets.length?Math.max(...d.budgets):null, bMed=_hdMedian(d.budgets);
    let gap='OK';
    if(!inStock.length) gap='NO_PRODUCT';
    else if(bMax!=null && cheapest!=null && cheapest>bMax) gap='PRICE_GAP'; // exists but too expensive for what they asked
    const reqCount=d.subs.size;
    const lostRev=(gap!=='OK') ? Math.round(reqCount * (bMed || cheapest || 0)) : 0;
    rows.push({ game:d.game, type:d.type, product:(d.game||'?')+' '+(d.type||'?'),
      requested_count:reqCount, budget_min:bMin, budget_max:bMax, budget_median:bMed,
      available_inventory:inStock.length, cheapest_available:cheapest, gap,
      est_lost_revenue:lostRev, waitlist:Array.from(d.subs).slice(0,50), samples:d.samples });
  }
  rows.sort((a,b)=>(b.est_lost_revenue-a.est_lost_revenue)|| (b.requested_count-a.requested_count));
  // Lead-stage breakdown per demand row — turns "N mentions" into "who's actually close to buying"
  try{ const _ls=await _leadStages(days); rows.forEach(r=>{ r.waitlist_stages=(r.waitlist||[]).reduce(function(a,s){ var k=_ls.bySub[s]||'cold'; a[k]=(a[k]||0)+1; return a; },{}); }); }catch(_e){}
  const gaps=rows.filter(r=>r.gap!=='OK');
  const realCustomers=new Set(mr.rows.map(r=>r.subscriber_id)).size;
  res.json({ ok:true, window_days:days, real_customers:realCustomers, total_demand_rows:rows.length,
    gaps:gaps.length, total_lost_revenue:rows.reduce((s,r)=>s+r.est_lost_revenue,0),
    banner:'📦 الطلب vs المخزون — مبني على '+realCustomers+' زبون حقيقي'+(realCustomers<10?' (عيّنة صغيرة — اتجاه ماشي قرار نهائي)':''),
    rows });
}catch(e){ res.status(500).json({error:e.message}); } });

// ===== LEAD SCORING V1 — live deterministic stage per REAL customer (cold→warm→hot→buyer). 100% coverage, always fresh, NO cron, NO table write. From existing signals: funnel (agent_trail) + orders + budget + recency. =====
async function _leadStages(days){
  days=Math.min(parseInt(days)||30,180); const RE="subscriber_id ~ '^[0-9]{15,}$'";
  const [subs, stg, ord] = await Promise.all([
    pool.query("SELECT c.subscriber_id, MAX(c.created_at) last_seen, MAX(p.budget) budget, MAX(p.interested_in) interested FROM aykoshop_chat_history c LEFT JOIN aykoshop_profiles p ON p.subscriber_id=c.subscriber_id WHERE c.role='user' AND c."+RE+" AND c.created_at>NOW()-($1||' days')::interval GROUP BY c.subscriber_id",[String(days)]),
    pool.query("SELECT subscriber_id, array_agg(DISTINCT to_stage) st FROM aykoshop_agent_trail WHERE "+RE+" GROUP BY subscriber_id"),
    pool.query("SELECT DISTINCT subscriber_id FROM aykoshop_orders WHERE status IN ('paid','delivered') AND "+RE)
  ]);
  const sm={}; stg.rows.forEach(r=>sm[r.subscriber_id]=r.st||[]);
  const buyers=new Set(ord.rows.map(r=>String(r.subscriber_id))); const now=Date.now();
  const counts={buyer:0,hot:0,warm:0,cold:0}, bySub={};
  subs.rows.forEach(r=>{
    const s=String(r.subscriber_id), st=sm[s]||[], age=(now-new Date(r.last_seen).getTime())/86400000;
    let stage;
    if(buyers.has(s)) stage='buyer';
    else if(st.indexOf('payment')>=0 || (st.indexOf('sales')>=0 && age<7 && (r.budget||r.interested))) stage='hot';
    else if(st.indexOf('sales')>=0 || st.indexOf('discovery')>=0) stage='warm';
    else stage='cold';
    counts[stage]++; bySub[s]=stage;
  });
  return { counts, bySub };
}
// ===== P4 CHANNEL ATTRIBUTION — stored channel (from ManyChat) + CONSERVATIVE media-inference (IG=ig_messaging_cdn/lookaside · WA=audioclip/.ogg) for nulls. Backfills profiles.channel (fills NULL only). Reports coverage% so the founder sees channel-data quality. =====
async function _channelAttribution(days){
  days=Math.min(parseInt(days)||90,180); const RE="subscriber_id ~ '^[0-9]{15,}$'";
  let rows=[]; try{ const r=await pool.query("SELECT c.subscriber_id, MAX(p.channel) ch, count(*) FILTER(WHERE c.message ~* 'ig_messaging_cdn|lookaside') ig, count(*) FILTER(WHERE c.message ~* 'audioclip|\\.ogg') wa FROM aykoshop_chat_history c LEFT JOIN aykoshop_profiles p ON p.subscriber_id=c.subscriber_id WHERE c.role='user' AND c."+RE+" AND c.created_at>NOW()-($1||' days')::interval GROUP BY c.subscriber_id",[String(days)]); rows=r.rows; }catch(_e){}
  const counts={instagram:0,whatsapp:0,facebook:0,unknown:0}; const infer=[];
  rows.forEach(function(row){
    let ch=row.ch&&String(row.ch).toLowerCase();
    if(!ch){ if(Number(row.ig)>0){ch='instagram';infer.push([row.subscriber_id,'instagram']);} else if(Number(row.wa)>0){ch='whatsapp';infer.push([row.subscriber_id,'whatsapp']);} }
    if(ch==='instagram')counts.instagram++; else if(ch==='whatsapp')counts.whatsapp++; else if(ch==='facebook'||ch==='messenger')counts.facebook++; else counts.unknown++;
  });
  for(const a of infer){ await pool.query("UPDATE aykoshop_profiles SET channel=$2 WHERE subscriber_id=$1 AND (channel IS NULL OR channel='')",[a[0],a[1]]).catch(()=>{}); }
  const total=rows.length, known=total-counts.unknown;
  return { by_channel:counts, coverage_pct:(total?Math.round(100*known/total):null), total, inferred_now:infer.length };
}
// ===== HERMES PROJECT ADVISOR — unified analysis brain (read-only). Answers: what's demanded · what's NOT selling · where customers are lost · TRAFFIC vs CONVERSION · operations health · gaps. Honest confidence gating on real-customer volume. =====
async function _hermesAdvisor(days){
  days=Math.min(parseInt(days)||30,180); const RE="subscriber_id ~ '^[0-9]{15,}$'";
  const [cust, funnel, ord, notsell, ops, leadcov, clar] = await Promise.all([
    pool.query("SELECT COALESCE(p.channel,'?') ch, count(DISTINCT c.subscriber_id) n FROM aykoshop_chat_history c LEFT JOIN aykoshop_profiles p ON p.subscriber_id=c.subscriber_id WHERE c.role='user' AND c."+RE+" AND c.created_at>NOW()-($1||' days')::interval GROUP BY 1 ORDER BY 2 DESC",[String(days)]),
    pool.query("SELECT to_stage, count(DISTINCT subscriber_id) n FROM aykoshop_agent_trail WHERE "+RE+" GROUP BY 1"),
    pool.query("SELECT count(*) FILTER(WHERE status IN ('paid','delivered')) closed, count(*) total FROM aykoshop_orders WHERE "+RE),
    pool.query("SELECT p.product_name, COALESCE(o.n,0) orders FROM aykoshop_products p LEFT JOIN (SELECT product_name, count(*) n FROM aykoshop_orders WHERE status IN ('paid','delivered') GROUP BY product_name) o ON o.product_name=p.product_name WHERE p.status='available' ORDER BY orders ASC"),
    pool.query("SELECT (SELECT count(*) FROM aykoshop_stopped_chats) frozen, (SELECT count(*) FROM aykoshop_interventions WHERE status='pending' AND subscriber_id ~ '^[0-9]{15,}$') pending, (SELECT count(*) FROM aykoshop_ai_usage WHERE created_at>NOW()-INTERVAL '24 hours') ai24, (SELECT COALESCE(string_agg(provider,','),'ok') FROM aykoshop_circuit_state WHERE state='open') circ"),
    pool.query("SELECT count(*) FILTER(WHERE "+RE+") real FROM aykoshop_lead_scores"),
    pool.query("SELECT count(*) n FROM aykoshop_agent_trail WHERE "+RE+" AND reason ILIKE '%clarify%'")
  ]);
  const realCust=cust.rows.reduce((s,r)=>s+Number(r.n),0);
  const fmap={}; funnel.rows.forEach(r=>fmap[r.to_stage]=Number(r.n));
  const reachedSales=fmap.sales||0, reachedHuman=fmap.human||0, closed=Number(ord.rows[0].closed||0);
  let bottleneck, verdict;
  if(realCust<20){ bottleneck='TRAFFIC'; verdict='الزبناء الحقيقيين قلال بزّاف ('+realCust+') → المشكل الأول = الترافيك/التوزيع. التحويل مايتقاسش بثقة قبل ~30 زبون.'; }
  else if(closed/Math.max(1,realCust)<0.05){ bottleneck='CONVERSION'; verdict='الترافيك كافي ('+realCust+') لكن التحويل ضعيف → المشكل فالبيع/المخزون.'; }
  else { bottleneck='OK'; verdict='الترافيك والتحويل معقولين على هاد العيّنة.'; }
  let _ls={counts:{buyer:0,hot:0,warm:0,cold:0}}; try{ _ls=await _leadStages(days); }catch(_e){}
  let _ca={by_channel:{},coverage_pct:null,inferred_now:0}; try{ _ca=await _channelAttribution(days); }catch(_e){}
  return { window_days:days, real_customers:realCust, confidence:(realCust>=30?'medium':'low'), lead_stages:_ls.counts,
    traffic:{ by_channel:cust.rows, channel_attribution:_ca, reached:{greeting:fmap.greeting||0,discovery:fmap.discovery||0,browsing:fmap.browsing||0,sales:reachedSales,payment:fmap.payment||0,human:reachedHuman}, closed_orders:closed },
    bottleneck, verdict,
    not_selling: notsell.rows.filter(r=>Number(r.orders)===0).map(r=>r.product_name),
    operations:{ frozen:Number(ops.rows[0].frozen), pending_interventions:Number(ops.rows[0].pending), ai_calls_24h:Number(ops.rows[0].ai24), open_circuits:ops.rows[0].circ },
    gaps:{ lead_score_real_coverage:Number(leadcov.rows[0].real)+'/'+realCust, clarify_turns:Number(clar.rows[0].n), seller_to_human:reachedHuman } };
}
app.get('/api/hermes/advisor', async (req,res)=>{ try{
  const a=await _hermesAdvisor(req.query.days);
  let dem=null; try{ dem=await (await fetch('http://localhost:4000/api/hermes/demand?days='+(a.window_days))).json(); }catch(_e){}
  a.demand={ gaps:(dem&&dem.gaps)||0, total_lost_revenue:(dem&&dem.total_lost_revenue)||0, top:(dem&&(dem.rows||[]).filter(r=>r.gap!=='OK').slice(0,3))||[] };
  try{ a.recommendations = await _oppSync((dem&&dem.rows)||[]); }catch(_e){ a.recommendations=null; }
  try{ a.catalog = await _catalogIntel((dem&&dem.rows)||[], a.real_customers); }catch(_e){ a.catalog=null; }
  a.banner='🧠 مستشار المشروع — '+a.real_customers+' زبون حقيقي · ثقة '+a.confidence+(a.real_customers<30?' (عيّنة صغيرة — اتجاه ماشي قرار نهائي)':'');
  res.json({ ok:true, advisor:a });
}catch(e){ res.status(500).json({error:e.message}); } });

// ===== P5 CATALOG INTELLIGENCE V2 — what to ADD (demand gaps) · what's NOT selling · what to REVIEW/remove (dead = 0 demand + 0 sales). Honest: 'remove' is LOW-confidence on tiny traffic — never auto-act. =====
async function _catalogIntel(demRows, realCust){
  const [prods, sales] = await Promise.all([
    pool.query("SELECT product_name, game, product_type FROM aykoshop_products WHERE status='available'"),
    pool.query("SELECT product_name, count(*) n FROM aykoshop_orders WHERE status IN ('paid','delivered') GROUP BY 1")
  ]);
  const salesMap={}; sales.rows.forEach(function(r){ salesMap[r.product_name]=Number(r.n); });
  const demByKey={}; (demRows||[]).forEach(function(r){ demByKey[(r.game||'?')+'|'+(r.type||'?')]=r.requested_count||0; });
  const products=prods.rows.map(function(p){
    const key=(p.game||'?')+'|'+(p.product_type||'?'); const demanded=demByKey[key]||0; const sold=salesMap[p.product_name]||0;
    let cls=(sold>0&&demanded>0)?'winner':(demanded>0?'demanded_unsold':(sold>0?'quiet_seller':'dead'));
    return { product:p.product_name, game:p.game, type:p.product_type, demanded, sold, cls };
  });
  const to_add=(demRows||[]).filter(function(r){return r.gap&&r.gap!=='OK';}).map(function(r){return { product:(r.game||'?')+' '+(r.type||''), requested:r.requested_count, hot:(r.waitlist_stages&&r.waitlist_stages.hot)||0, budget_min:r.budget_min, budget_max:r.budget_max, lost:r.est_lost_revenue };});
  const dead=products.filter(function(p){return p.cls==='dead';}).map(function(p){return p.product;});
  const demanded_most=Object.keys(demByKey).map(function(k){return {key:k,n:demByKey[k]};}).sort(function(a,b){return b.n-a.n;}).slice(0,3);
  return { products, to_add, not_selling:products.filter(function(p){return p.sold===0;}).map(function(p){return p.product;}),
    dead_candidates:dead, demanded_most,
    remove_confidence:(realCust>=30?'ok':'low'), remove_note:(realCust<30?'⚠️ ماتحيّدش حتى منتج دابا — '+realCust+' زبناء فقط (إشارة ضعيفة). الـdead = ماطلبو حتى زبون + ماتباعو، ولكن الترافيك قليل.':'') };
}
app.get('/api/hermes/catalog', async (req,res)=>{ try{
  let dem={rows:[],real_customers:0}; try{ dem=await (await fetch('http://localhost:4000/api/hermes/demand?days='+(Math.min(parseInt(req.query.days)||90,180)))).json(); }catch(_e){}
  const ci=await _catalogIntel((dem&&dem.rows)||[], (dem&&dem.real_customers)||0);
  res.json({ ok:true, banner:'📚 ذكاء الكاطالوغ — زيد '+ci.to_add.length+' · مايتباعش '+ci.not_selling.length+' · مرشّح للحذف '+ci.dead_candidates.length+(ci.remove_note?(' '+ci.remove_note):''), ...ci });
}catch(e){ res.status(500).json({error:e.message}); } });
// ===== PROACTIVE HERMES — SIGNAL ENGINE. Scans real data, detects high-ROI/risk signals, dedups (cooldown), sends «💡 اقتراح»/«⚠️ انتباه» (what·why·suggest). ff_hermes_signals = off|shadow|on. shadow=detect+store, no send. on=send ≤cap/day, highest-ROI first. =====
async function _sigTgSend(text){ try{ const t=process.env.TEST_TG_TOKEN, c=process.env.TEST_TG_CHAT; if(!t||!c) return false; await fetch('https://api.telegram.org/bot'+t+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:c,text:text}),signal:AbortSignal.timeout(8000)}); return true; }catch(_e){ return false; } }
async function _signalScan(){
  let mode='off'; try{ const r=await pool.query("SELECT value FROM aykoshop_settings WHERE key='ff_hermes_signals' LIMIT 1"); mode=(r.rows[0]&&r.rows[0].value)||'off'; }catch(_e){}
  if(mode==='off') return {mode,skipped:true};
  await pool.query("CREATE TABLE IF NOT EXISTS aykoshop_signals (id SERIAL PRIMARY KEY, signal_type TEXT, dedup_key TEXT, severity TEXT, title TEXT, what TEXT, why TEXT, suggest TEXT, roi_score INT, status TEXT DEFAULT 'open', created_at TIMESTAMPTZ DEFAULT now(), sent_at TIMESTAMPTZ)").catch(()=>{});
  const COOLDOWN_DAYS=3, DAILY_CAP=3, cand=[];
  let adv={}; try{ adv=(((await (await fetch('http://localhost:4000/api/hermes/advisor?days=90')).json())||{}).advisor)||{}; }catch(_e){}
  // 1) HOT DEMAND GAP — a HOT customer wants a missing/too-expensive product
  for(const g of ((adv.demand&&adv.demand.top)||[])){ const hot=(g.waitlist_stages&&g.waitlist_stages.hot)||0; if(hot>=1){
    cand.push({ type:'hot_demand_gap', key:'hot_demand_gap:'+(g.game||'?')+'|'+(g.type||'?'), sev:'opportunity', roi:1000+(g.est_lost_revenue||0)+hot*100,
      title:'🔥 طلب حار ناقص', what:(g.requested_count||0)+' زبناء (منهم '+hot+' 🔥 حار) بغاو '+(g.product||'')+' بـ'+g.budget_min+'-'+g.budget_max+'DH · أرخص متوفر '+(g.cheapest_available||'ماكاينش'),
      why:'فيهم زبناء قريبين يشريو · خسارة مقدّرة ~'+(g.est_lost_revenue||0)+'DH', suggest:'زيد '+(g.product||'')+' فهاد الرينج (المخزون الحالي مايطابقش الميزانية)' }); } }
  // 2) HOT LEAD STUCK — reached sales/payment, no order, stalled 1-14d
  try{ const sl=await pool.query("SELECT c.subscriber_id sub, MAX(c.created_at) last_seen FROM aykoshop_chat_history c WHERE c.role='user' AND c.subscriber_id ~ '^[0-9]{15,}$' AND c.created_at < NOW()-INTERVAL '20 hours' AND c.created_at > NOW()-INTERVAL '14 days' AND EXISTS(SELECT 1 FROM aykoshop_agent_trail t WHERE t.subscriber_id=c.subscriber_id AND t.to_stage IN ('sales','payment')) AND NOT EXISTS(SELECT 1 FROM aykoshop_orders o WHERE o.subscriber_id=c.subscriber_id AND o.status IN ('paid','delivered')) GROUP BY c.subscriber_id");
    for(const r of sl.rows){ const days=Math.max(1,Math.round((Date.now()-new Date(r.last_seen).getTime())/86400000));
      cand.push({ type:'hot_lead_stuck', key:'hot_lead_stuck:'+r.sub, sev:'warn', roi:500+days*10,
        title:'💡 زبون حار واقف', what:'زبون '+r.sub+' وصل مرحلة البيع/الدفع وبقى بلا شراء من '+days+' يوم', why:'زبون قريب يشري متوقف — فرصة بيع كتضيع', suggest:'تواصل معاه ولا شوف فين وقف فالمحادثة وكمّل البيعة' }); } }catch(_e){}
  // 3) AI REPLY QUALITY — last 24h avg assistant length vs prior baseline / short-spike
  try{ const q=await pool.query("SELECT AVG(length(message)) FILTER(WHERE created_at>NOW()-INTERVAL '24 hours') l24, AVG(length(message)) FILTER(WHERE created_at BETWEEN NOW()-INTERVAL '30 days' AND NOW()-INTERVAL '24 hours') base, COUNT(*) FILTER(WHERE created_at>NOW()-INTERVAL '24 hours' AND length(message)<15) short24, COUNT(*) FILTER(WHERE created_at>NOW()-INTERVAL '24 hours') tot24 FROM aykoshop_chat_history WHERE role='assistant'");
    const r=q.rows[0]; const l24=Number(r.l24)||0, base=Number(r.base)||0, short=Number(r.short24)||0, tot=Number(r.tot24)||0;
    if(tot>=5 && base>0 && (l24<base*0.6 || (short/tot)>0.4)){
      cand.push({ type:'ai_reply_quality', key:'ai_reply_quality:'+(new Date().toISOString().slice(0,10)), sev:'warn', roi:400,
        title:'⚠️ مراجعة جودة الردود', what:'ردود البوت فآخر 24س: متوسط الطول '+Math.round(l24)+' حرف (المعتاد '+Math.round(base)+') · '+Math.round(100*short/Math.max(1,tot))+'% قصيرة جداً', why:'ردود أقصر/أضعف كتنقص التحويل (ممكن provider degraded ولا خلل)', suggest:'راجع الردود فالـQA Lab + شوف circuit/الـprovider واش طايح' }); } }catch(_e){}
  // 4) SALES-BLOCKING ERROR — provider failures that hurt sales for REAL customers (founder priority: "errors affecting sales")
  try{ const cr=await pool.query("SELECT COALESCE(string_agg(provider,','),'') o FROM aykoshop_circuit_state WHERE state='open' AND provider IN ('openai','anthropic')"); const o=cr.rows[0].o||''; const bothDown=o.indexOf('openai')>=0 && o.indexOf('anthropic')>=0;
    const fl=await pool.query("SELECT count(*) n FROM aykoshop_interventions WHERE reason_code IN ('AI_REPLY_FAILED','AI_UNAVAILABLE') AND subscriber_id ~ '^[0-9]{15,}$' AND created_at>NOW()-INTERVAL '24 hours'"); const nf=Number(fl.rows[0].n)||0;
    if(bothDown){ cand.push({ type:'sales_blocking_error', key:'sales_blocking_error:both_down:'+(new Date().toISOString().slice(0,10)), sev:'warn', roi:2000, title:'🚨 خلل كيأثر على المبيعات', what:'المزوّدان (OpenAI + Anthropic) طايحين — البوت مايقدرش يجاوب الزبناء دابا', why:'كل محادثة دابا = زبون ممكن يضيع', suggest:'شوف الكريدي/المفاتيح فالـKey Manager + حالة الـcircuit' }); }
    else if(nf>=1){ cand.push({ type:'sales_blocking_error', key:'sales_blocking_error:fails:'+(new Date().toISOString().slice(0,10)), sev:'warn', roi:900+nf*50, title:'⚠️ ردود فشلت لزبناء حقيقيين', what:nf+' زبون حقيقي ما توصلوش رد (فشل AI) فآخر 24س', why:'زبون ما تجاوبش = فرصة بيع ضايعة', suggest:'شوف الـprovider/الأخطاء وجاوبهم يدوياً قبل ما يضيعو' }); }
  }catch(_e){}
  // dedup (cooldown) + insert
  const inserted=[];
  for(const c of cand){
    let ex={rows:[]}; try{ ex=await pool.query("SELECT 1 FROM aykoshop_signals WHERE dedup_key=$1 AND created_at>NOW()-($2||' days')::interval LIMIT 1",[c.key,String(COOLDOWN_DAYS)]); }catch(_e){}
    if(ex.rows.length) continue;
    try{ const ins=await pool.query("INSERT INTO aykoshop_signals (signal_type,dedup_key,severity,title,what,why,suggest,roi_score,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open') RETURNING id",[c.type,c.key,c.sev,c.title,c.what,c.why,c.suggest,c.roi]); inserted.push(Object.assign({id:ins.rows[0].id},c)); }catch(_e){}
  }
  // send (only when 'on'): send OPEN (unsent) signals incl ones detected earlier in shadow, ≤cap/day, highest ROI first
  let sent=0;
  if(mode==='on'){
    let st=0; try{ st=Number((await pool.query("SELECT count(*) n FROM aykoshop_signals WHERE sent_at::date=CURRENT_DATE")).rows[0].n)||0; }catch(_e){}
    const budget=Math.max(0, DAILY_CAP-st);
    if(budget>0){
      let openRows=[]; try{ openRows=(await pool.query("SELECT id,severity,title,what,why,suggest FROM aykoshop_signals WHERE status='open' ORDER BY roi_score DESC LIMIT $1",[budget])).rows; }catch(_e){}
      for(const s of openRows){
        const head=(s.severity==='opportunity')?'💡 اقتراح':'⚠️ انتباه';
        const ok=await _sigTgSend(head+' — '+s.title+'\n\n📍 شنو لقا: '+s.what+'\n\n❓ علاش مهم: '+s.why+'\n\n✅ نقترح: '+s.suggest+'\n\n🔗 '+HDASH+'/#/system');
        if(ok){ await pool.query("UPDATE aykoshop_signals SET status='sent', sent_at=now() WHERE id=$1",[s.id]).catch(()=>{}); sent++; }
      }
    }
  }
  return { mode, candidates:cand.length, inserted:inserted.length, sent };
}
app.post('/api/hermes/signals/scan', async (req,res)=>{ try{ res.json({ ok:true, ...(await _signalScan()) }); }catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/hermes/signals', async (req,res)=>{ try{
  let rows=[]; try{ rows=(await pool.query("SELECT id,signal_type,severity,title,what,why,suggest,status,created_at,sent_at FROM aykoshop_signals ORDER BY created_at DESC LIMIT 30")).rows; }catch(_e){}
  res.json({ ok:true, signals:rows, total:rows.length });
}catch(e){ res.status(500).json({error:e.message}); } });
// ===== P3 OPPORTUNITY → SALE TRACKING — closed loop: Hermes recommends → did we add stock? → did demand repeat? → did it CONVERT to a confirmed sale? Measures recommendation HEALTH, not just discovery. =====
async function _oppSync(demRows){
  await pool.query("CREATE TABLE IF NOT EXISTS aykoshop_opportunities (id SERIAL PRIMARY KEY, opp_key TEXT UNIQUE, game TEXT, type TEXT, first_detected TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now(), requested_count INT, hot_count INT, budget_min INT, budget_max INT, est_lost_revenue INT, status TEXT DEFAULT 'open', inventory_added_at TIMESTAMPTZ, converted_at TIMESTAMPTZ, converted_order_id INT)").catch(()=>{});
  // paid/delivered orders mapped to game|type (via product join)
  let ordMap={}; try{ const ord=await pool.query("SELECT p.game, p.product_type, MIN(COALESCE(o.paid_at,o.created_at)) first_sale, (array_agg(o.id ORDER BY o.created_at))[1] order_id FROM aykoshop_orders o LEFT JOIN aykoshop_products p ON p.product_name=o.product_name WHERE o.status IN ('paid','delivered') GROUP BY 1,2"); ord.rows.forEach(function(r){ ordMap[(r.game||'?')+'|'+(r.product_type||'?')]={first_sale:r.first_sale, order_id:r.order_id}; }); }catch(_e){}
  for(const r of (demRows||[])){
    if(!(r.requested_count>0)) continue;
    const key=(r.game||'?')+'|'+(r.type||'?'); const hot=(r.waitlist_stages&&r.waitlist_stages.hot)||0;
    await pool.query("INSERT INTO aykoshop_opportunities (opp_key,game,type,requested_count,hot_count,budget_min,budget_max,est_lost_revenue,status,last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9='OK' THEN 'inventory_added' ELSE 'open' END, now()) ON CONFLICT (opp_key) DO UPDATE SET requested_count=$4, hot_count=$5, budget_min=$6, budget_max=$7, est_lost_revenue=$8, last_seen=now()",[key, r.game||null, r.type||null, r.requested_count, hot, r.budget_min, r.budget_max, r.est_lost_revenue, r.gap]).catch(()=>{});
    if(r.gap==='OK'){ await pool.query("UPDATE aykoshop_opportunities SET status='inventory_added', inventory_added_at=COALESCE(inventory_added_at,now()) WHERE opp_key=$1 AND status='open'",[key]).catch(()=>{}); }
    const o=ordMap[key];
    if(o&&o.first_sale){ await pool.query("UPDATE aykoshop_opportunities SET status='converted', converted_at=COALESCE(converted_at,$2), converted_order_id=COALESCE(converted_order_id,$3) WHERE opp_key=$1 AND first_detected<=$2",[key,o.first_sale,o.order_id]).catch(()=>{}); }
  }
  const all=await pool.query("SELECT opp_key,game,type,status,requested_count,hot_count,budget_min,budget_max,est_lost_revenue,first_detected,inventory_added_at,converted_at FROM aykoshop_opportunities ORDER BY (status='converted') DESC, est_lost_revenue DESC NULLS LAST, requested_count DESC");
  const byStatus={open:0,inventory_added:0,converted:0,stale:0}; all.rows.forEach(function(r){ byStatus[r.status]=(byStatus[r.status]||0)+1; });
  const addressed=(byStatus.inventory_added||0)+(byStatus.converted||0);
  return { tracked:all.rows.length, by_status:byStatus, addressed, recommendation_health_pct:(addressed>0?Math.round(100*(byStatus.converted||0)/addressed):null), opportunities:all.rows };
}
app.get('/api/hermes/opportunities', async (req,res)=>{ try{
  let dem={rows:[]}; try{ dem=await (await fetch('http://localhost:4000/api/hermes/demand?days='+(Math.min(parseInt(req.query.days)||90,180)))).json(); }catch(_e){}
  const opp=await _oppSync((dem&&dem.rows)||[]);
  res.json({ ok:true, banner:'🎯 تتبّع الفرص → البيع: '+opp.tracked+' فرصة متتبّعة · صحة التوصيات '+(opp.recommendation_health_pct!=null?opp.recommendation_health_pct+'%':'— (مازال ماكاين فرصة عولجت)'), ...opp });
}catch(e){ res.status(500).json({error:e.message}); } });

// GET /api/reports/daily — full daily report data (used by cron + Dashboard)
app.get('/api/reports/daily', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString();

    const [
      newCustomers, hotCustomers, ordersToday, revenueToday,
      interventionsToday, resolvedToday, rescuePending, rescueResolved,
      paymentIntents, aiErrors, lostSales, followupsDue
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_profiles WHERE created_at >= $1`, [todayStr]),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_profiles WHERE stage IN ('hot','warm')`),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_orders WHERE created_at >= $1`, [todayStr]),
      pool.query(`SELECT COALESCE(SUM(CASE WHEN REGEXP_REPLACE(price,'[^0-9]','','g')~'^[0-9]+$' THEN CAST(REGEXP_REPLACE(price,'[^0-9]','','g') AS INTEGER) ELSE 0 END),0) as n FROM aykoshop_orders WHERE created_at >= $1 AND status IN ('delivered','paid')`, [todayStr]),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_interventions WHERE is_test IS NOT TRUE AND created_at >= $1`, [todayStr]),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_interventions WHERE status='resolved' AND is_test IS NOT TRUE AND created_at >= $1`, [todayStr]),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_rescue_queue WHERE status='pending'`),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_rescue_queue WHERE status='resolved' AND resolved_at >= $1`, [todayStr]),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_interventions WHERE reason_code IN ('PAYMENT_INTENT','PAYMENT_CONFUSION') AND is_test IS NOT TRUE AND created_at >= $1`, [todayStr]),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_workflow_errors WHERE severity='critical' AND started_at >= $1`, [todayStr]),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_profiles p LEFT JOIN aykoshop_orders o ON o.subscriber_id=p.subscriber_id WHERE p.stage IN ('hot','warm') AND o.id IS NULL AND p.last_seen < NOW()-INTERVAL '24 hours'`),
      pool.query(`SELECT COUNT(*) as n FROM aykoshop_followups WHERE status='pending' AND due_at <= NOW()+INTERVAL '2 hours'`)
    ]);

    const totalProfiles = await pool.query(`SELECT COUNT(*) as n FROM aykoshop_profiles`);
    const totalInterv = parseInt(interventionsToday.rows[0].n||0);
    const resolved = parseInt(resolvedToday.rows[0].n||0);
    const aiSuccessRate = totalInterv === 0 ? 100 : Math.round(resolved / totalInterv * 100);

    res.json({
      date: new Date().toLocaleDateString('ar-MA', { weekday:'long', year:'numeric', month:'long', day:'numeric' }),
      customers: {
        new_today: parseInt(newCustomers.rows[0].n||0),
        hot_leads: parseInt(hotCustomers.rows[0].n||0),
        total: parseInt(totalProfiles.rows[0].n||0),
        lost_sales: parseInt(lostSales.rows[0].n||0)
      },
      orders: {
        today: parseInt(ordersToday.rows[0].n||0),
        revenue_today_dh: parseInt(revenueToday.rows[0].n||0)
      },
      ai: {
        interventions_today: totalInterv,
        resolved_today: resolved,
        success_rate: aiSuccessRate,
        critical_errors: parseInt(aiErrors.rows[0].n||0),
        payment_intents: parseInt(paymentIntents.rows[0].n||0)
      },
      rescue: {
        pending: parseInt(rescuePending.rows[0].n||0),
        resolved_today: parseInt(rescueResolved.rows[0].n||0)
      },
      followups: {
        due_soon: parseInt(followupsDue.rows[0].n||0)
      }
    });
  } catch(e) {
    console.error('[daily report]', e.message);
    res.status(500).json({ error: e.message });
  }
});



// ==================== SALES FUNNEL DASHBOARD ====================

app.get('/api/funnel', async (req, res) => {
  try {
    const period = req.query.period || '30'; // days
    const since = `NOW() - INTERVAL '${parseInt(period)} days'`;

    // ── Core funnel counts ────────────────────────────────────────
    const [base, paymentSignals, ordersData, channelData, productData, avgTime, monthlyTrend] = await Promise.all([

      // F1–F3: profiles
      pool.query(`
        SELECT
          COUNT(*) as f1_new,
          COUNT(*) FILTER (WHERE interested_in IS NOT NULL AND interested_in != '') as f2_interest,
          COUNT(*) FILTER (WHERE stage IN ('hot','warm')) as f3_hot
        FROM aykoshop_profiles
        WHERE channel IN ('whatsapp','instagram','messenger','')
          OR channel IS NULL`),

      // F4: payment intent signals
      pool.query(`
        SELECT COUNT(*) as n FROM (
          SELECT DISTINCT subscriber_id FROM aykoshop_interventions
          WHERE reason_code IN ('PAYMENT_INTENT','PAYMENT_CONFUSION')
          UNION
          SELECT DISTINCT subscriber_id FROM aykoshop_rescue_queue
          WHERE trigger_type ILIKE '%payment%'
        ) t`),

      // F5–F7: orders
      pool.query(`
        SELECT
          COUNT(DISTINCT subscriber_id) as f5_orders,
          COUNT(DISTINCT subscriber_id) FILTER (WHERE paid_at IS NOT NULL OR status IN ('paid','delivered')) as f6_paid,
          COUNT(DISTINCT subscriber_id) FILTER (WHERE delivered_at IS NOT NULL OR status = 'delivered') as f7_delivered,
          COALESCE(SUM(
            CASE WHEN REGEXP_REPLACE(price,'[^0-9]','','g') ~ '^[0-9]+$'
            THEN CAST(REGEXP_REPLACE(price,'[^0-9]','','g') AS INTEGER)
            ELSE 0 END
          ), 0) as total_revenue_dh
        FROM aykoshop_orders
        WHERE paid_at IS NOT NULL AND status IN ('paid','delivered')`),

      // Channel breakdown
      pool.query(`
        SELECT
          p.channel as ch,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE p.interested_in IS NOT NULL AND p.interested_in != '') as with_interest,
          COUNT(*) FILTER (WHERE p.stage IN ('hot','warm')) as hot,
          COUNT(DISTINCT o.subscriber_id) as ordered_any
        FROM aykoshop_profiles p
        LEFT JOIN aykoshop_orders o ON o.subscriber_id = p.subscriber_id
        WHERE p.channel IN ('whatsapp','instagram','messenger')
        GROUP BY p.channel ORDER BY total DESC`),

      // Top products
      pool.query(`
        SELECT o.product_name,
          COUNT(DISTINCT o.subscriber_id) as orders,
          COALESCE(SUM(
            CASE WHEN REGEXP_REPLACE(o.price,'[^0-9]','','g') ~ '^[0-9]+$'
            THEN CAST(REGEXP_REPLACE(o.price,'[^0-9]','','g') AS INTEGER)
            ELSE 0 END
          ), 0) as revenue_dh
        FROM aykoshop_orders o
        WHERE o.product_name IS NOT NULL
        GROUP BY o.product_name ORDER BY orders DESC LIMIT 8`),

      // Average time estimates
      pool.query(`
        SELECT
          AVG(EXTRACT(EPOCH FROM (last_seen - created_at))/3600) as avg_hrs_to_last,
          AVG(EXTRACT(EPOCH FROM (last_seen - created_at))/3600)
            FILTER (WHERE stage IN ('hot','warm')) as avg_hrs_to_hot,
          AVG(total_messages) as avg_msgs_per_customer,
          AVG(total_messages) FILTER (WHERE stage IN ('hot','warm')) as avg_msgs_hot
        FROM aykoshop_profiles`),

      // 7-day daily new customers trend
      pool.query(`
        SELECT DATE(created_at) as day, COUNT(*) as new_customers,
          COUNT(*) FILTER (WHERE stage IN ('hot','warm')) as became_hot
        FROM aykoshop_profiles
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at) ORDER BY day`)
    ]);

    const f1 = parseInt(base.rows[0].f1_new || 0);
    const f2 = parseInt(base.rows[0].f2_interest || 0);
    const f3 = parseInt(base.rows[0].f3_hot || 0);
    const f4 = parseInt(paymentSignals.rows[0].n || 0);
    const f5 = parseInt(ordersData.rows[0].f5_orders || 0);
    const f6 = parseInt(ordersData.rows[0].f6_paid || 0);
    const f7 = parseInt(ordersData.rows[0].f7_delivered || 0);
    const totalRevenue = parseInt(ordersData.rows[0].total_revenue_dh || 0);

    const safe = (n, d) => d > 0 ? Math.round(n / d * 100) : 0;

    // Build funnel stages array
    const stages = [
      { id:'new',      label:'زبون جديد',    label_en:'New Customer',    icon:'🟢', count:f1, pct_of_top:100,          conv_to_next: safe(f2,f1), color:'#10b981' },
      { id:'interest', label:'اهتمام بمنتج',  label_en:'Product Interest', icon:'📦', count:f2, pct_of_top:safe(f2,f1),  conv_to_next: safe(f3,f2), color:'#6366f1' },
      { id:'hot',      label:'Hot Lead',      label_en:'Hot Lead',         icon:'🔥', count:f3, pct_of_top:safe(f3,f1),  conv_to_next: safe(f4||f5,f3), color:'#f59e0b' },
      { id:'payment',  label:'نية الدفع',     label_en:'Payment Intent',   icon:'💳', count:f4, pct_of_top:safe(f4,f1),  conv_to_next: safe(f5,Math.max(f4,1)), color:'#8b5cf6' },
      { id:'order',    label:'طلب مُنشأ',    label_en:'Order Created',    icon:'📋', count:f5, pct_of_top:safe(f5,f1),  conv_to_next: safe(f6,f5), color:'#3b82f6' },
      { id:'paid',     label:'دفع مؤكد',     label_en:'Payment Confirmed', icon:'💰', count:f6, pct_of_top:safe(f6,f1),  conv_to_next: safe(f7,f6), color:'#06b6d4' },
      { id:'delivered',label:'تسليم',         label_en:'Delivered',        icon:'🎁', count:f7, pct_of_top:safe(f7,f1),  conv_to_next: null, color:'#34d399' }
    ];

    // Biggest drop-off (stage → next where most customers are lost)
    let biggestDropoff = { stage: '', dropoff_pct: 0, label: '' };
    for (let i = 0; i < stages.length - 1; i++) {
      const from = stages[i];
      const to   = stages[i + 1];
      const dropPct = from.count > 0 ? Math.round((from.count - to.count) / from.count * 100) : 0;
      if (dropPct > biggestDropoff.dropoff_pct) {
        biggestDropoff = {
          stage: from.id,
          label: from.label + ' → ' + to.label,
          dropoff_pct: dropPct,
          from_count: from.count,
          to_count: to.count
        };
      }
    }

    // Channel conversion rates
    const byChannel = channelData.rows.map(r => {
      const ch_total = parseInt(r.total||0);
      return {
        channel: r.ch,
        total: ch_total,
        interest_rate: safe(parseInt(r.with_interest||0), ch_total),
        hot_rate: safe(parseInt(r.hot||0), ch_total),
        order_rate: safe(parseInt(r.ordered_any||0), ch_total)
      };
    });

    // Best channel (highest hot_rate)
    const bestChannel = byChannel.reduce((a, b) => a.hot_rate > b.hot_rate ? a : b, { channel: '—', hot_rate: 0 });

    // Avg time estimates
    const avgHrsActive  = parseFloat(avgTime.rows[0].avg_hrs_to_last || 0).toFixed(1);
    const avgHrsToHot   = parseFloat(avgTime.rows[0].avg_hrs_to_hot  || 0).toFixed(1);
    const avgMsgs       = parseFloat(avgTime.rows[0].avg_msgs_per_customer || 0).toFixed(1);
    const avgMsgsHot    = parseFloat(avgTime.rows[0].avg_msgs_hot || 0).toFixed(1);

    // Overall metrics
    const overallConversion = safe(f5, f1);
    const hotConversion     = safe(f5, f3);

    res.json({
      stages,
      biggest_dropoff: biggestDropoff,
      by_channel: byChannel,
      best_channel: bestChannel.channel || null,
      by_product: productData.rows,
      total_revenue_dh: totalRevenue,
      overall_conversion_pct: overallConversion,
      hot_to_order_pct: hotConversion,
      avg_time: {
        avg_hrs_active: avgHrsActive,
        avg_hrs_to_hot: avgHrsToHot,
        avg_msgs_per_customer: avgMsgs,
        avg_msgs_hot: avgMsgsHot
      },
      trend_7d: monthlyTrend.rows,
      data_period_days: 12,
      generated_at: new Date().toISOString()
    });
  } catch(e) {
    console.error('[funnel]', e.message);
    res.status(500).json({ error: e.message });
  }
});



// ==================== SSE REAL-TIME EVENT STREAM ====================
// Replaces 30s polling across the entire Dashboard

const _sseClients = new Set();

// Broadcast to all connected Dashboard clients
function _broadcast(eventType, data) {
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of _sseClients) {
    try { client.res.write(msg); }
    catch(e) { _sseClients.delete(client); }
  }
  try { if(['order_paid','order_created','order_delivered','intervention','human_takeover'].includes(eventType)) triggerHermesRecompute(); } catch(e){}
}

// GET /api/events/stream — Dashboard connects here
app.get('/api/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const _sseOrigin=req.headers.origin||'';
  res.setHeader('Access-Control-Allow-Origin', /^https?:\/\/(ayko\.store|localhost|127\.0\.0\.1|5\.189\.170\.55)/.test(_sseOrigin)?_sseOrigin:'https://ayko.store');
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  const client = { res, id: clientId };
  _sseClients.add(client);

  // Send current badge counts immediately on connect
  pool.query(`SELECT
    COUNT(*) FILTER (WHERE status='pending') AS interventions,
    COUNT(*) FILTER (WHERE status='pending' AND priority IN ('critical','high')) AS urgent
    FROM aykoshop_interventions WHERE created_at > NOW() - INTERVAL '24 hours'`)
  .then(r => {
    res.write(`event: init\ndata: ${JSON.stringify({
      interventions: parseInt(r.rows[0].interventions || 0),
      urgent:        parseInt(r.rows[0].urgent || 0),
      clients:       _sseClients.size
    })}\n\n`);
  }).catch(() => {});

  // Heartbeat every 20s to keep connection alive
  const hb = setInterval(() => {
    try { res.write(`event: ping\ndata: ${Date.now()}\n\n`); }
    catch(e) { clearInterval(hb); }
  }, 20000);

  req.on('close', () => {
    clearInterval(hb);
    _sseClients.delete(client);
  });
});

// GET /api/events/sse-status — how many clients connected
app.get('/api/events/sse-status', (req, res) => {
  res.json({ connected_clients: _sseClients.size });
});



// GET /api/chat-history/:subscriber_id — fetch recent messages (for price extraction in Clear Product Fields)
app.get('/api/chat-history/:subscriber_id', async (req, res) => {
  try {
    const { limit = 30, role } = req.query;
    const lim = parseInt(limit) || 30;
    let r;
    if (role) {
      r = await pool.query(
        'SELECT role, message, media_url, media_type, created_at FROM aykoshop_chat_history WHERE subscriber_id=$1 AND role=$2 ORDER BY created_at DESC LIMIT $3',
        [req.params.subscriber_id, role, lim]
      );
    } else {
      r = await pool.query(
        'SELECT role, message, media_url, media_type, created_at FROM aykoshop_chat_history WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT $2',
        [req.params.subscriber_id, lim]
      );
    }
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ==================== RECOMMENDATIONS & REVENUE TRUTH ====================

// Revenue helper — single source of truth used by all endpoints
// Standard: paid_at IS NOT NULL AND status IN ('paid','delivered')
async function getRevenue(since, until) {
  const conditions = ["paid_at IS NOT NULL", "status IN ('paid','delivered')"];
  const params = [];
  let i = 1;
  if (since) { conditions.push(`created_at >= $${i++}`); params.push(since); }
  if (until) { conditions.push(`created_at < $${i++}`); params.push(until); }
  const where = conditions.join(' AND ');
  const r = await pool.query(
    `SELECT COALESCE(SUM(
       CASE WHEN REGEXP_REPLACE(price,'[^0-9]','','g') ~ '^[0-9]+$'
            THEN CAST(REGEXP_REPLACE(price,'[^0-9]','','g') AS INTEGER)
            ELSE 0 END
     ), 0) as revenue,
     COUNT(*) as count
     FROM aykoshop_orders WHERE ${where}`,
    params
  );
  return { revenue: parseInt(r.rows[0].revenue || 0), count: parseInt(r.rows[0].count || 0) };
}

// GET /api/revenue — single source of truth revenue endpoint
app.get('/api/revenue', async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const [todayRev, monthRev, totalRev, ordersByStatus] = await Promise.all([
      getRevenue(today.toISOString(), null),
      getRevenue(monthStart.toISOString(), null),
      getRevenue(null, null),
      pool.query(`SELECT status, COUNT(*) as n FROM aykoshop_orders GROUP BY status`)
    ]);
    const byStatus = {};
    for (const r of ordersByStatus.rows) byStatus[r.status] = parseInt(r.n);
    res.json({
      today:      todayRev,
      this_month: monthRev,
      all_time:   totalRev,
      by_status:  byStatus,
      source:     'paid_at IS NOT NULL AND status IN (paid,delivered)'
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/recommendations — log product shown to customer (from n8n)
app.post('/api/recommendations', async (req, res) => {
  try {
    const { subscriber_id, customer_name, channel, product_id, product_name,
            price_shown, price_numeric, customer_budget, similarity, selection_method } = req.body;
    if (!subscriber_id) return res.status(400).json({ error: 'subscriber_id required' });
    if (isTestSubscriber(subscriber_id)) return res.json({ success: true, skipped: 'test' });
    const r = await pool.query(
      `INSERT INTO aykoshop_recommendations
         (subscriber_id, customer_name, channel, product_id, product_name,
          price_shown, price_numeric, customer_budget, similarity, selection_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [subscriber_id, customer_name||null, channel||null, product_id||null, product_name||null,
       price_shown||null, parseInt(price_numeric||0), parseInt(customer_budget||0),
       parseFloat(similarity||0), selection_method||'vector']
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/recommendations/report — Product Conversion Report
app.get('/api/recommendations/report', async (req, res) => {
  try {
    const since = req.query.since || new Date(Date.now() - 30*86400000).toISOString();

    // Per-product: shown count, reply rate, order rate, revenue
    const byProduct = await pool.query(`
      SELECT
        r.product_name,
        COUNT(r.id) as times_shown,
        COUNT(DISTINCT r.subscriber_id) as unique_customers,
        ROUND(AVG(r.price_numeric)) as avg_price_shown,
        -- Customer replied after recommendation (had another message after this rec)
        COUNT(DISTINCT r.subscriber_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM aykoshop_chat_history ch
          WHERE ch.subscriber_id = r.subscriber_id AND ch.role = 'user'
            AND ch.created_at > r.created_at
        )) as replied_count,
        -- Order created after recommendation
        COUNT(DISTINCT r.subscriber_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM aykoshop_orders o
          WHERE o.subscriber_id = r.subscriber_id
            AND o.created_at > r.created_at
        )) as ordered_count,
        -- Payment confirmed after recommendation
        COUNT(DISTINCT r.subscriber_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM aykoshop_orders o
          WHERE o.subscriber_id = r.subscriber_id
            AND o.paid_at IS NOT NULL
            AND o.paid_at > r.created_at
        )) as paid_count,
        -- Total confirmed revenue from orders after these recs
        COALESCE(SUM(DISTINCT
          CASE WHEN EXISTS (
            SELECT 1 FROM aykoshop_orders o2
            WHERE o2.subscriber_id = r.subscriber_id AND o2.paid_at IS NOT NULL
          ) THEN r.price_numeric ELSE 0 END
        ), 0) as potential_revenue
      FROM aykoshop_recommendations r
      WHERE r.created_at >= $1
      GROUP BY r.product_name
      ORDER BY times_shown DESC`,
      [since]
    );

    // Budget vs shown price analysis
    const budgetAnalysis = await pool.query(`
      SELECT
        COUNT(*) as total_shown,
        COUNT(*) FILTER (WHERE customer_budget > 0) as had_budget,
        COUNT(*) FILTER (WHERE customer_budget > 0 AND price_numeric <= customer_budget * 1.1) as within_budget,
        COUNT(*) FILTER (WHERE customer_budget > 0 AND price_numeric > customer_budget * 1.5) as over_budget,
        ROUND(AVG(price_numeric)) as avg_price_shown,
        ROUND(AVG(NULLIF(customer_budget,0))) as avg_budget_mentioned
      FROM aykoshop_recommendations
      WHERE created_at >= $1`,
      [since]
    );

    // Daily trend
    const trend = await pool.query(`
      SELECT DATE(created_at) as day,
        COUNT(*) as shown,
        COUNT(DISTINCT subscriber_id) as customers
      FROM aykoshop_recommendations
      WHERE created_at >= $1
      GROUP BY DATE(created_at) ORDER BY day`,
      [since]
    );

    const totalShown = parseInt(budgetAnalysis.rows[0].total_shown || 0);

    res.json({
      by_product: byProduct.rows,
      budget_analysis: budgetAnalysis.rows[0],
      trend: trend.rows,
      summary: {
        total_recommendations: totalShown,
        unique_products: byProduct.rows.length,
        data_since: since
      }
    });
  } catch(e) {
    console.error('[recommendations/report]', e.message);
    res.status(500).json({ error: e.message });
  }
});



// ==================== CUSTOMER RETENTION SYSTEM ====================

// ─── Draft message generator (template-based, uses customer context) ───
function generateDraftFromContext(category, profile, orders, lastInterv, recs, sessionData) {
  const firstName = (profile.customer_name || 'صاحبي').split(' ')[0];
  const lastOrder  = orders && orders.length > 0 ? orders[orders.length - 1] : null;
  const product    = (lastOrder && lastOrder.product_name) || profile.interested_in || 'المنتج';
  const price      = lastOrder && lastOrder.price ? ' ب' + lastOrder.price : '';
  const budget     = sessionData && sessionData.last_budget ? parseInt(sessionData.last_budget) : 0;
  const hasBought  = lastOrder && (lastOrder.status === 'paid' || lastOrder.status === 'delivered' || lastOrder.paid_at);

  const TEMPLATES = {
    satisfaction_check:
      hasBought
        ? `سلام ${firstName}! واش كلشي خدام مزيان ف${product}${price} لي شريتي؟ إلا كاين أي مشكل كنكونو حاضرين دايما 😊`
        : `سلام ${firstName}! شنو رأيك في ${product}؟ واش كلشي مزيان معاك؟ 😊`,
    repeat_purchase:
      `سلام ${firstName}! مرحبا بيك من جديد 🔥 واش مزال محتاج ${product}؟ عندنا خيارات جديدة تناسب ميزانيتك`,
    upsell:
      `سلام ${firstName}! بعد ما شريتي ${product}${price}، عندنا إضافة ممتازة يمكن تعجبك 😊 تبغي تشوف؟`,
    lost_lead_recovery:
      `سلام ${firstName}! وقفت على ${product}؟ عندنا خيارات بأسعار مختلفة. غنقدرو نوريك شي يناسب ميزانيتك 😊`,
    product_reminder:
      budget > 0
        ? `سلام ${firstName}! مزال ${product} متاح. عندنا خيار${price || (' ب' + budget + 'DH ولا قريب منو')} 😊 واش مزال مهتم؟`
        : `سلام ${firstName}! مزال ${product} متاح واش مهتم نكملو؟ 🔥`,
    budget_recheck:
      `سلام ${firstName}! كنت بغيت ${product}${budget > 0 ? ' بميزانية ' + budget + 'DH' : ''}، عندنا خيارات جديدة دلوقت. تبغي تشوف؟ 😊`,
  };

  return TEMPLATES[category] || `سلام ${firstName}! كيف الحال؟ واش باغي تشوف شي جديد عندنا؟ 😊`;
}

// ─── GET /api/customers/:id/profile360 ───────────────────────────────
app.patch('/api/customers/:id', asyncHandler(async (req, res) => {
    const { notes, tags, stage } = req.body;
    const r = await pool.query("UPDATE aykoshop_profiles SET notes=COALESCE($1,notes), tags=COALESCE($2,tags), stage=COALESCE($3,stage) WHERE subscriber_id=$4 RETURNING subscriber_id,notes,tags,stage", [notes, tags, stage, req.params.id]);
    res.json(r.rows[0] || {});
}));
app.get('/api/customers/:id/profile360', async (req, res) => {
  try {
    const sid = req.params.id;
    const [
      profileR, ordersR, intervR, followupR, recR, chatStatsR, draftR
    ] = await Promise.all([
      pool.query(`SELECT * FROM aykoshop_profiles WHERE subscriber_id=$1`, [sid]),
      pool.query(`SELECT * FROM aykoshop_orders WHERE subscriber_id=$1 ORDER BY created_at ASC`, [sid]),
      pool.query(`SELECT id, reason_code, status, priority, customer_message, ai_last_reply, created_at, resolved_at, operator_name FROM aykoshop_interventions WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 10`, [sid]),
      pool.query(`SELECT id, type, status, product_name, due_at, created_at FROM aykoshop_followups WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 5`, [sid]),
      pool.query(`SELECT product_name, price_shown, price_numeric, created_at FROM aykoshop_recommendations WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 10`, [sid]),
      pool.query(`SELECT COUNT(*) FILTER (WHERE role='user') as user_msgs, COUNT(*) FILTER (WHERE role='assistant') as ai_msgs, MIN(created_at) as first_msg, MAX(created_at) as last_msg FROM aykoshop_chat_history WHERE subscriber_id=$1`, [sid]),
      pool.query(`SELECT id, category, draft_message, status, created_at, sent_at FROM aykoshop_followup_drafts WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 5`, [sid])
    ]);

    const profile = profileR.rows[0] || {};
    const orders  = ordersR.rows;

    // Lifetime value = sum of all confirmed payments
    const lifetimeValue = orders.reduce((sum, o) => {
      if (o.paid_at || o.status === 'paid' || o.status === 'delivered') {
        const n = parseInt((o.price || '').replace(/[^0-9]/g,'') || '0');
        return sum + n;
      }
      return sum;
    }, 0);

    // Suggested follow-up categories based on customer state
    const hasPurchased = orders.some(o => o.paid_at || o.status === 'paid' || o.status === 'delivered');
    const suggestedCategories = hasPurchased
      ? ['satisfaction_check', 'repeat_purchase', 'upsell']
      : ['lost_lead_recovery', 'product_reminder', 'budget_recheck'];

    res.json({
      profile,
      orders,
      lifetime_value:        lifetimeValue,
      order_count:           orders.length,
      paid_order_count:      orders.filter(o => o.paid_at).length,
      interventions:         intervR.rows,
      followup_history:      followupR.rows,
      followup_drafts:       draftR.rows,
      recommendations:       recR.rows,
      chat_stats:            chatStatsR.rows[0] || {},
      has_purchased:         hasPurchased,
      suggested_categories:  suggestedCategories
    });
  } catch(e) {
    console.error('[profile360]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/followup-drafts ─────────────────────────────────────────
app.get('/api/followup-drafts', async (req, res) => {
  try {
    const { status = 'all', limit = 50 } = req.query;
    const where = status === 'all' ? '' : `WHERE status = '${status.replace(/'/g,'')}'`;
    const rows = await pool.query(
      `SELECT d.*,
         EXTRACT(EPOCH FROM (NOW()-d.created_at))/3600 as hours_old
       FROM aykoshop_followup_drafts d
       ${where}
       ORDER BY
         CASE status WHEN 'draft' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
         d.created_at DESC
       LIMIT $1`,
      [parseInt(limit)]
    );
    const counts = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='draft') as draft,
        COUNT(*) FILTER (WHERE status='approved') as approved,
        COUNT(*) FILTER (WHERE status='sent') as sent,
        COUNT(*) FILTER (WHERE status='rejected') as rejected,
        COUNT(*) FILTER (WHERE status='failed') as failed
      FROM aykoshop_followup_drafts
      WHERE created_at > NOW() - INTERVAL '7 days' OR status IN ('draft','approved')`
    );
    res.json({ drafts: rows.rows, counts: counts.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/followup-drafts/generate ──────────────────────────────
app.post('/api/followup-drafts/generate', async (req, res) => {
  try {
    const { subscriber_id, category } = req.body;
    if (!subscriber_id || !category) return res.status(400).json({ error: 'subscriber_id and category required' });

    // Fetch context
    const [profileR, ordersR, intervR, recs] = await Promise.all([
      pool.query(`SELECT * FROM aykoshop_profiles WHERE subscriber_id=$1`, [subscriber_id]),
      pool.query(`SELECT * FROM aykoshop_orders WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 5`, [subscriber_id]),
      pool.query(`SELECT reason_code, customer_message FROM aykoshop_interventions WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 3`, [subscriber_id]),
      pool.query(`SELECT product_name, price_shown, created_at FROM aykoshop_recommendations WHERE subscriber_id=$1 ORDER BY created_at DESC LIMIT 3`, [subscriber_id])
    ]);

    const profile   = profileR.rows[0] || {};
    const orders    = ordersR.rows;
    const sessionData = profile.session_data || {};

    const draftMessage = generateDraftFromContext(category, profile, orders, intervR.rows[0], recs.rows, sessionData);

    // Build context summary for operator visibility
    const lastOrder = orders[0];
    const contextParts = [];
    if (profile.stage)                contextParts.push('Stage: ' + profile.stage);
    if (profile.interested_in)        contextParts.push('Interested: ' + profile.interested_in);
    if (lastOrder)                    contextParts.push('Last order: ' + lastOrder.product_name + ' (' + lastOrder.status + ')');
    if (sessionData.last_budget)      contextParts.push('Budget: ' + sessionData.last_budget + 'DH');
    if (sessionData.rejection_count)  contextParts.push('Rejections: ' + sessionData.rejection_count);
    if (intervR.rows.length)          contextParts.push('Last intervention: ' + intervR.rows[0].reason_code);

    const contextSummary = contextParts.join(' | ');

    const r = await pool.query(
      `INSERT INTO aykoshop_followup_drafts
         (subscriber_id, customer_name, channel, wa_phone, manychat_link,
          category, draft_message, context_summary, product_name,
          expected_revenue, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft') RETURNING *`,
      [subscriber_id, profile.customer_name||null, profile.channel||null,
       profile.wa_phone||null, profile.manychat_link||null,
       category, draftMessage, contextSummary,
       profile.interested_in || (lastOrder && lastOrder.product_name) || null,
       sessionData.last_budget || 0]
    );

    res.json({ success: true, draft: r.rows[0] });
  } catch(e) {
    console.error('[generate draft]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/followup-drafts — manual creation ─────────────────────
app.post('/api/followup-drafts', async (req, res) => {
  try {
    const { subscriber_id, customer_name, channel, wa_phone, manychat_link,
            category, draft_message, product_name, expected_revenue } = req.body;
    if (!subscriber_id || !draft_message) return res.status(400).json({ error: 'required fields missing' });
    const r = await pool.query(
      `INSERT INTO aykoshop_followup_drafts
         (subscriber_id, customer_name, channel, wa_phone, manychat_link,
          category, draft_message, product_name, expected_revenue, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft') RETURNING *`,
      [subscriber_id, customer_name||null, channel||null, wa_phone||null, manychat_link||null,
       category||'general', draft_message, product_name||null, parseInt(expected_revenue||0)]
    );
    res.json({ success: true, draft: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /api/followup-drafts/:id/approve ──────────────────────────
app.patch('/api/followup-drafts/:id/approve', async (req, res) => {
  try {
    const { edited_message, operator_notes, scheduled_at } = req.body;
    const r = await pool.query(
      `UPDATE aykoshop_followup_drafts
       SET status='approved', approved_at=NOW(), operator_notes=$1,
           scheduled_at=$2,
           draft_message=COALESCE($3, draft_message)
       WHERE id=$4 AND status='draft' RETURNING *`,
      [operator_notes||null, scheduled_at||null, edited_message||null, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'draft not found or not in draft status' });
    res.json({ success: true, draft: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /api/followup-drafts/:id/reject ───────────────────────────
app.patch('/api/followup-drafts/:id/reject', async (req, res) => {
  try {
    const { rejection_reason } = req.body;
    const r = await pool.query(
      `UPDATE aykoshop_followup_drafts SET status='rejected', rejection_reason=$1 WHERE id=$2 RETURNING *`,
      [rejection_reason||'Rejected by operator', req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/followup-drafts/:id/send ──────────────────────────────
app.post('/api/followup-drafts/:id/send', async (req, res) => {
  try {
    const dr = await pool.query(`SELECT * FROM aykoshop_followup_drafts WHERE id=$1`, [req.params.id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'not found' });
    const draft = dr.rows[0];
    if (draft.status !== 'approved' && draft.status !== 'draft') {
      return res.status(400).json({ error: 'draft must be approved before sending' });
    }

    // Send via ManyChat
    const MC_KEY = 'Bearer ' + (_mcKey()||'');
    const endpoint = 'https://api.manychat.com/fb/sending/sendContent';
    const payload = {
      subscriber_id: draft.subscriber_id,
      data: {
        version: 'v2',
        content: {
          messages: [{ type: 'text', text: draft.draft_message }],
          actions: [],
          quick_replies: []
        }
      }
    };

    let sendOk = false, sendError = null;
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': MC_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      sendOk = true;
    } catch(mcErr) {
      sendError = mcErr.message;
    }

    const newStatus = sendOk ? 'sent' : 'failed';
    await pool.query(
      `UPDATE aykoshop_followup_drafts SET status=$1, sent_at=NOW() WHERE id=$2`,
      [newStatus, req.params.id]
    );

    // Update profile last_operator
    if (req.body.operator_name) {
      await pool.query(
        `UPDATE aykoshop_profiles SET last_operator=$1 WHERE subscriber_id=$2`,
        [req.body.operator_name, draft.subscriber_id]
      ).catch(()=>{});
    }

    if (!sendOk) return res.status(500).json({ error: 'send failed: ' + sendError });
    res.json({ success: true, status: 'sent' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/retention/stats ─────────────────────────────────────────
app.get('/api/retention/stats', async (req, res) => {
  try {
    const [
      repeatCustomers, clvData, followupConv,
      revenueBySource, reactivated, retentionRate, draftStats
    ] = await Promise.all([
      // Repeat customers: bought 2+ times
      pool.query(`
        SELECT COUNT(*) as n FROM (
          SELECT subscriber_id FROM aykoshop_orders
          WHERE paid_at IS NOT NULL AND status IN ('paid','delivered')
          GROUP BY subscriber_id HAVING COUNT(*) >= 2
        ) t`),
      // CLV: avg revenue per paying customer
      pool.query(`
        SELECT
          COUNT(DISTINCT subscriber_id) as paying_customers,
          COALESCE(SUM(CASE WHEN REGEXP_REPLACE(price,'[^0-9]','','g')~'^[0-9]+$' THEN CAST(REGEXP_REPLACE(price,'[^0-9]','','g') AS INT) ELSE 0 END),0) as total_revenue,
          COALESCE(AVG(CASE WHEN REGEXP_REPLACE(price,'[^0-9]','','g')~'^[0-9]+$' THEN CAST(REGEXP_REPLACE(price,'[^0-9]','','g') AS INT) ELSE NULL END),0) as avg_clv
        FROM aykoshop_orders
        WHERE paid_at IS NOT NULL AND status IN ('paid','delivered')`),
      // Follow-up conversion: drafts sent → orders created
      pool.query(`
        SELECT
          COUNT(*) as total_sent,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM aykoshop_orders o
            WHERE o.subscriber_id = fd.subscriber_id AND o.created_at > fd.sent_at
          )) as led_to_order
        FROM aykoshop_followup_drafts fd
        WHERE status = 'sent' AND sent_at IS NOT NULL`),
      // Revenue by source
      pool.query(`
        SELECT
          COALESCE(revenue_source, 'ai') as source,
          COUNT(*) as orders,
          COALESCE(SUM(CASE WHEN REGEXP_REPLACE(price,'[^0-9]','','g')~'^[0-9]+$' THEN CAST(REGEXP_REPLACE(price,'[^0-9]','','g') AS INT) ELSE 0 END),0) as revenue
        FROM aykoshop_orders
        WHERE paid_at IS NOT NULL AND status IN ('paid','delivered')
        GROUP BY COALESCE(revenue_source, 'ai')`),
      // Reactivated: was cold/lost, now hot/warm
      pool.query(`
        SELECT COUNT(*) as n FROM aykoshop_profiles
        WHERE stage IN ('hot','warm')
          AND total_messages > 5
          AND last_seen > NOW() - INTERVAL '7 days'
          AND created_at < NOW() - INTERVAL '3 days'`),
      // Retention rate
      pool.query(`
        SELECT
          COUNT(DISTINCT p.subscriber_id) as total_buyers,
          COUNT(DISTINCT o2.subscriber_id) as repeat_buyers
        FROM aykoshop_profiles p
        JOIN aykoshop_orders o1 ON o1.subscriber_id=p.subscriber_id AND o1.paid_at IS NOT NULL
        LEFT JOIN aykoshop_orders o2 ON o2.subscriber_id=p.subscriber_id
          AND o2.id != o1.id AND o2.paid_at IS NOT NULL`),
      // Draft queue stats
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='draft') as pending_drafts,
          COUNT(*) FILTER (WHERE status='approved') as approved_drafts,
          COUNT(*) FILTER (WHERE status='sent' AND sent_at > NOW()-INTERVAL '7 days') as sent_7d,
          COUNT(*) FILTER (WHERE status='rejected') as rejected
        FROM aykoshop_followup_drafts`)
    ]);

    const clv = clvData.rows[0];
    const conv = followupConv.rows[0];
    const rr   = retentionRate.rows[0];

    res.json({
      repeat_customers: parseInt(repeatCustomers.rows[0].n || 0),
      paying_customers: parseInt(clv.paying_customers || 0),
      total_revenue:    parseInt(clv.total_revenue || 0),
      avg_clv:          Math.round(parseFloat(clv.avg_clv || 0)),
      followup_conv: {
        total_sent:  parseInt(conv.total_sent || 0),
        led_to_order: parseInt(conv.led_to_order || 0),
        rate: conv.total_sent > 0 ? Math.round(parseInt(conv.led_to_order) / parseInt(conv.total_sent) * 100) : 0
      },
      revenue_by_source: revenueBySource.rows,
      reactivated_customers: parseInt(reactivated.rows[0].n || 0),
      retention_rate: rr.total_buyers > 0 ? Math.round(parseInt(rr.repeat_buyers) / parseInt(rr.total_buyers) * 100) : 0,
      draft_stats: draftStats.rows[0]
    });
  } catch(e) {
    console.error('[retention/stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Wire operator name to takeover (updates last_operator)
// Patch the existing takeover endpoint to also update last_operator


// GET /api/recovery/stats (restored endpoint)
app.get('/api/recovery/stats', async (req, res) => {
  try {
    const [ordersAfterInterv, rescueResolved, totalRevenue] = await Promise.all([
      pool.query(`
        SELECT o.id, o.subscriber_id, o.product_name, o.price, o.created_at, o.status,
               i.reason_code, i.created_at as interv_at
        FROM aykoshop_orders o
        JOIN aykoshop_interventions i ON i.subscriber_id = o.subscriber_id
          AND o.created_at > i.created_at
          AND o.created_at < i.created_at + INTERVAL '24 hours'
          AND i.status = 'resolved'
        WHERE o.created_at > NOW() - INTERVAL '30 days'
        ORDER BY o.created_at DESC LIMIT 10`),
      pool.query(`
        SELECT COUNT(*) as resolved, COALESCE(SUM(amount),0) as revenue_sum
        FROM aykoshop_rescue_queue
        WHERE status = 'resolved' AND resolved_at > NOW() - INTERVAL '30 days'`),
      pool.query(`
        SELECT COALESCE(SUM(
          CASE WHEN REGEXP_REPLACE(price,'[^0-9]','','g') ~ '^[0-9]+$'
          THEN CAST(REGEXP_REPLACE(price,'[^0-9]','','g') AS INTEGER) ELSE 0 END
        ), 0) as total
        FROM aykoshop_orders
        WHERE paid_at IS NOT NULL AND status IN ('paid','delivered')`)
    ]);

    let recoveredRevenue = 0;
    for (const ord of ordersAfterInterv.rows) {
      const p = ord.price ? ord.price.replace(/[^0-9]/g, '') : '0';
      recoveredRevenue += parseInt(p || '0');
    }

    res.json({
      summary: {
        orders_after_intervention: ordersAfterInterv.rows.length,
        recovered_revenue_dh: recoveredRevenue + parseInt(rescueResolved.rows[0].revenue_sum || 0),
        total_revenue_dh: parseInt(totalRevenue.rows[0].total || 0),
        conversion_rate: ordersAfterInterv.rows.length > 0 ? Math.round(ordersAfterInterv.rows.length / 3 * 100) : 0
      },
      recent_orders: ordersAfterInterv.rows,
      daily_trend: []
    });
  } catch(e) {
    console.error('[recovery/stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ==================== RESTORED: JOURNEY + PRODUCT SUGGEST ====================

// GET /api/customers/:id/journey — complete customer timeline
app.get('/api/customers/:id/journey', async (req, res) => {
  try {
    const sid = req.params.id;
    const [profile, chatHistory, interventions, orders, rescueQueue] = await Promise.all([
      pool.query(`SELECT * FROM aykoshop_profiles WHERE subscriber_id=$1`, [sid]),
      pool.query(`SELECT id, role, message, created_at FROM aykoshop_chat_history WHERE subscriber_id=$1 ORDER BY created_at ASC`, [sid]),
      pool.query(`SELECT id, reason_code, reason_detail, customer_message, ai_last_reply, product_name, ai_confidence, vector_sim, status, priority, vector_matches, resolution_note, resolved_at, created_at FROM aykoshop_interventions WHERE subscriber_id=$1 ORDER BY created_at ASC`, [sid]),
      pool.query(`SELECT id, product_name, price, status, created_at, paid_at, delivered_at FROM aykoshop_orders WHERE subscriber_id=$1 ORDER BY created_at ASC`, [sid]),
      pool.query(`SELECT id, trigger_type, trigger_message, product_name, amount, priority_score, status, entered_queue_at, resolved_at FROM aykoshop_rescue_queue WHERE subscriber_id=$1 ORDER BY entered_queue_at ASC`, [sid])
    ]);

    const events = [];
    if (profile.rows[0]) {
      const p = profile.rows[0];
      events.push({ type:'joined', ts: p.created_at, icon:'🟢', label:'انضم للمتجر', detail: p.channel, color:'#10b981' });
      if (p.interested_in) events.push({ type:'interest', ts: p.created_at, icon:'📦', label:'اهتمام بالمنتج', detail: p.interested_in, color:'#6366f1' });
    }
    const userMsgs = chatHistory.rows.filter(r => r.role === 'user');
    const aiMsgs   = chatHistory.rows.filter(r => r.role === 'assistant');
    if (userMsgs.length > 0) events.push({ type:'first_message', ts: userMsgs[0].created_at, icon:'💬', label:'أول رسالة', detail: (userMsgs[0].message||'').slice(0,80), color:'#60a5fa' });
    if (aiMsgs.length > 0)   events.push({ type:'ai_first', ts: aiMsgs[0].created_at, icon:'🤖', label:'أول رد AI', detail: (aiMsgs[0].message||'').slice(0,80), color:'#a78bfa' });
    if (userMsgs.length > 1) events.push({ type:'messages_count', ts: userMsgs[userMsgs.length-1].created_at, icon:'💬', label:'رسائل الزبون', detail: userMsgs.length + ' رسالة', color:'#60a5fa' });

    const REASON_AR = {AI_REPLY_FAILED:'فشل رد AI',PAYMENT_INTENT:'نية دفع',PAYMENT_CONFUSION:'خلط دفع',PRODUCT_NOT_FOUND:'منتج مجهول',LOW_CONFIDENCE:'ثقة منخفضة',AI_LOOP_DETECTED:'تكرار AI',CUSTOMER_COMPLAINT:'شكاية',IMAGE_NOT_AVAILABLE:'صورة مفقودة',HUMAN_REQUESTED:'تدخل يدوي',PRODUCT_MISMATCH:'رفض منتج'};
    for (const iv of interventions.rows) {
      events.push({ type:'intervention', ts: iv.created_at, icon:'🚨', label:'تدخل — ' + (REASON_AR[iv.reason_code]||iv.reason_code), detail: (iv.customer_message||'').slice(0,80), color: iv.priority==='critical'?'#ef4444':'#f59e0b', meta:{ id:iv.id, reason:iv.reason_code, status:iv.status, confidence:iv.ai_confidence, vector_sim:iv.vector_sim, vector_matches:iv.vector_matches } });
      if (iv.status==='resolved' && iv.resolved_at) events.push({ type:'resolved', ts: iv.resolved_at, icon:'✅', label:'حُل التدخل', detail: iv.resolution_note||'', color:'#10b981' });
    }
    for (const rq of rescueQueue.rows) {
      events.push({ type:'rescue', ts: rq.entered_queue_at, icon:'🆘', label:'قائمة الإنقاذ', detail: rq.trigger_type + (rq.product_name?' — '+rq.product_name:''), color:'#f59e0b' });
    }
    for (const ord of orders.rows) {
      events.push({ type:'order', ts: ord.created_at, icon:'📋', label:'طلب جديد', detail: (ord.product_name||'') + (ord.price?' — '+ord.price:''), color:'#6366f1', meta:{ id:ord.id, status:ord.status } });
      if (ord.paid_at) events.push({ type:'payment', ts: ord.paid_at, icon:'💰', label:'تأكيد الدفع', detail: ord.product_name||'', color:'#10b981' });
      if (ord.delivered_at) events.push({ type:'delivered', ts: ord.delivered_at, icon:'🎁', label:'تم التسليم', detail:'', color:'#34d399' });
    }
    events.sort((a,b) => new Date(a.ts) - new Date(b.ts));
    res.json({
      profile: profile.rows[0] || null,
      events,
      summary: { total_messages: chatHistory.rows.length, user_messages: userMsgs.length, interventions: interventions.rows.length, orders: orders.rows.length, has_payment: orders.rows.some(o=>o.paid_at), stage: profile.rows[0]?profile.rows[0].stage:'unknown' }
    });
  } catch(e) { console.error('[journey]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/products/suggest?q=keyword
app.get('/api/products/suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().slice(0, 100);
    if (!q) return res.json({ suggestions: [] });
    const r = await pool.query(`
      SELECT id, product_name, category, price, image_url, status,
        CASE
          WHEN LOWER(product_name) LIKE LOWER($1) THEN 90
          WHEN LOWER(category)     LIKE LOWER($1) THEN 70
          WHEN LOWER(product_name || ' ' || COALESCE(category,'')) ILIKE '%' || $2 || '%' THEN 50
          ELSE 30
        END AS match_score
      FROM aykoshop_products
      WHERE status = 'available' AND stock > 0 AND (
        LOWER(product_name || ' ' || COALESCE(category,''))
        ILIKE '%' || $2 || '%'
        OR LOWER(product_name) LIKE LOWER('%' || $3 || '%')
      )
      ORDER BY match_score DESC, product_name
      LIMIT 5`,
      ['%' + q + '%', q, q]
    );
    res.json({ suggestions: r.rows, query: q });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ==================== SMART FOLLOW-UP: DRAFT AUTO-SCAN ====================

// Sanitize names that still contain ManyChat placeholders like {{first_name}}
function _cleanProfileName(p) {
  const nm = p.customer_name || '';
  return { ...p, customer_name: (nm && nm.indexOf('{{') === -1) ? nm : '' };
}

// POST /api/followup-drafts/auto-scan
// Generates DRAFTS (status='draft') for 2 segments. Never auto-sends.
app.post('/api/followup-drafts/auto-scan', async (req, res) => {
  try {
    const created = { leads_3h: 0, retention: 0 };

    // ── SEGMENT 1: Leads inactive 3h+ (interested, no order, no pending draft) ──
    const leads = await pool.query(`
      SELECT p.* FROM aykoshop_profiles p
      LEFT JOIN aykoshop_orders o ON o.subscriber_id = p.subscriber_id
      LEFT JOIN aykoshop_followup_drafts d ON d.subscriber_id = p.subscriber_id
        AND d.status IN ('draft','approved')
      WHERE p.stage IN ('hot','warm','buyer','payment')
        AND p.interested_in IS NOT NULL AND p.interested_in != ''
        AND o.id IS NULL
        AND p.last_seen < NOW() - INTERVAL '3 hours'
        AND p.last_seen > NOW() - INTERVAL '48 hours'
        AND d.id IS NULL
        AND p.subscriber_id ~ '^[0-9]+$'
      ORDER BY p.last_seen DESC
      LIMIT 30`);

    for (const row of leads.rows) {
      const p = _cleanProfileName(row);
      const sessionData = p.session_data || {};
      const msg = generateDraftFromContext('lost_lead_recovery', p, [], null, [], sessionData);
      const ctx = 'Lead 3h+ | Stage: ' + p.stage + ' | Interested: ' + (p.interested_in||'') +
                  (sessionData.last_budget ? ' | Budget: ' + sessionData.last_budget + 'DH' : '');
      await pool.query(`
        INSERT INTO aykoshop_followup_drafts
          (subscriber_id, customer_name, channel, wa_phone, manychat_link,
           category, draft_message, context_summary, product_name, expected_revenue, status)
        VALUES ($1,$2,$3,$4,$5,'lost_lead_recovery',$6,$7,$8,$9,'draft')`,
        [p.subscriber_id, p.customer_name||null, p.channel, p.wa_phone, p.manychat_link,
         msg, ctx, p.interested_in, parseInt(sessionData.last_budget||350)]);
      created.leads_3h++;
    }

    // ── SEGMENT 2: Post-purchase retention (paid 3-7 days ago, no repeat draft) ──
    const buyers = await pool.query(`
      SELECT DISTINCT ON (p.subscriber_id) p.*,
             o.product_name AS bought_product, o.price AS bought_price,
             COALESCE(o.paid_at, o.created_at) AS purchase_date
      FROM aykoshop_profiles p
      JOIN aykoshop_orders o ON o.subscriber_id = p.subscriber_id
      LEFT JOIN aykoshop_followup_drafts d ON d.subscriber_id = p.subscriber_id
        AND d.category = 'repeat_purchase' AND d.status IN ('draft','approved','sent')
      WHERE (o.paid_at IS NOT NULL OR o.status IN ('paid','delivered'))
        AND COALESCE(o.paid_at, o.created_at) < NOW() - INTERVAL '3 days'
        AND COALESCE(o.paid_at, o.created_at) > NOW() - INTERVAL '7 days'
        AND d.id IS NULL
        AND p.subscriber_id ~ '^[0-9]+$'
      ORDER BY p.subscriber_id, purchase_date DESC
      LIMIT 30`);

    // Product suggestions: 2 cheapest available products (purchase-history aware cross-sell)
    let suggNames = [];
    try {
      const sugg = await pool.query(`
        SELECT DISTINCT product_name FROM aykoshop_products
        WHERE status='available' AND stock>0
          AND REGEXP_REPLACE(price,'[^0-9]','','g') ~ '^[0-9]+$'
        ORDER BY product_name ASC LIMIT 4`);
      suggNames = sugg.rows.map(s => s.product_name).slice(0, 2);
    } catch(e) {}

    for (const row of buyers.rows) {
      const p = _cleanProfileName(row);
      const orders = [{ product_name: row.bought_product, price: row.bought_price, status: 'paid', paid_at: row.purchase_date }];
      // Suggest products different from what they already bought
      const fresh = suggNames.filter(n => n && n !== row.bought_product).slice(0, 2);
      let msg = generateDraftFromContext('repeat_purchase', p, orders, null, [], p.session_data || {});
      if (fresh.length) msg += ' عندنا ' + fresh.join(' و') + ' يمكن يعجبوك 😊';
      const ctx = 'Retention 3-7d | Bought: ' + (row.bought_product||'') +
                  ' | Suggest: ' + fresh.join(', ');
      await pool.query(`
        INSERT INTO aykoshop_followup_drafts
          (subscriber_id, customer_name, channel, wa_phone, manychat_link,
           category, draft_message, context_summary, product_name, expected_revenue, status)
        VALUES ($1,$2,$3,$4,$5,'repeat_purchase',$6,$7,$8,$9,'draft')`,
        [p.subscriber_id, p.customer_name||null, p.channel, p.wa_phone, p.manychat_link,
         msg, ctx, row.bought_product, 350]);
      created.retention++;
    }

    res.json({ success: true, created, total: created.leads_3h + created.retention });
  } catch(e) {
    console.error('[draft auto-scan]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/followups/segments — 3 dashboard counters
app.get('/api/followups/segments', async (req, res) => {
  try {
    const [leads, retention, drafts] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS n FROM aykoshop_profiles p
        LEFT JOIN aykoshop_orders o ON o.subscriber_id = p.subscriber_id
        WHERE p.stage IN ('hot','warm','buyer','payment')
          AND p.interested_in IS NOT NULL AND p.interested_in != ''
          AND o.id IS NULL
          AND p.last_seen < NOW() - INTERVAL '3 hours'
          AND p.last_seen > NOW() - INTERVAL '48 hours'
          AND p.subscriber_id ~ '^[0-9]+$'`),
      pool.query(`
        SELECT COUNT(DISTINCT p.subscriber_id) AS n
        FROM aykoshop_profiles p
        JOIN aykoshop_orders o ON o.subscriber_id = p.subscriber_id
        WHERE (o.paid_at IS NOT NULL OR o.status IN ('paid','delivered'))
          AND COALESCE(o.paid_at, o.created_at) < NOW() - INTERVAL '3 days'
          AND COALESCE(o.paid_at, o.created_at) > NOW() - INTERVAL '7 days'
          AND p.subscriber_id ~ '^[0-9]+$'`),
      pool.query(`SELECT COUNT(*) AS n FROM aykoshop_followup_drafts WHERE status IN ('draft','approved')`)
    ]);
    res.json({
      waiting_3h_leads:     parseInt(leads.rows[0].n||0),
      retention_candidates: parseInt(retention.rows[0].n||0),
      pending_drafts:       parseInt(drafts.rows[0].n||0)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Hermes intelligence layer (A+)
require('./hermes').registerRoutes(app, pool);

// ==================== START ====================
initTables().then(() => {
  const PORT = process.env.PORT || 4000;
  // ===================== Payment Claims (dispute-proof) =====================
// ── Payment Accounts ─────────────────────────────────────────────────────────
app.get('/api/payment-accounts', async (req,res)=>{ try{
  const r=await pool.query('SELECT id,method_key,display_name,holder_name,fields,currency,active,sort_order,notes,keywords,instructions,warnings,receipt_required,receipt_type,adult_required,requires_bank,countries,min_amount,max_amount,image_url FROM aykoshop_payment_accounts ORDER BY sort_order,id'); /* M2: new columns */
  res.json({ok:true,accounts:r.rows});
}catch(e){res.status(500).json({ok:false,error:e.message});} });

app.put('/api/payment-accounts/:key', async (req,res)=>{ try{
  const k=req.params.key;
  const b=req.body||{};
  const fields=Array.isArray(b.fields)?b.fields:[];
  /* M2: save new columns */
  const warnings_val = Array.isArray(b.warnings) ? JSON.stringify(b.warnings) : (b.warnings||null);
  await pool.query(
    'UPDATE aykoshop_payment_accounts SET holder_name=$1,currency=$2,active=$3,sort_order=$4,fields=$5,keywords=$7,instructions=$8,warnings=$9::jsonb,receipt_required=$10,receipt_type=$11,adult_required=$12,requires_bank=$13,min_amount=$14,max_amount=$15,image_url=$16,updated_at=now() WHERE method_key=$6',
    [b.holder_name||null, b.currency||'MAD', b.active!==false, parseInt(b.sort_order||0,10), JSON.stringify(fields), k,
     b.keywords||null, b.instructions||null, warnings_val,
     b.receipt_required!==false, b.receipt_type||'screenshot',
     !!b.adult_required, !!b.requires_bank,
     b.min_amount||null, b.max_amount||null, b.image_url||null]
  );
  res.json({ok:true});
}catch(e){res.status(500).json({ok:false,error:e.message});} });
// ─────────────────────────────────────────────────────────────────────────────

// M2: product-payment-prices — GET all methods with per-product pricing
app.get('/api/product-payment-prices/:product_id', async (req,res)=>{ try{
  const pid=parseInt(req.params.product_id,10);
  if(!pid||isNaN(pid)) return res.status(400).json({ok:false,error:'invalid product_id'});
  const r=await pool.query(`
    SELECT pa.method_key, pa.display_name, pa.fields, pa.active AS method_active, pa.sort_order,
           pa.instructions, pa.warnings, pa.receipt_required, pa.receipt_type,
           pa.adult_required, pa.requires_bank, pa.image_url, pa.keywords,
           ppp.price_value, ppp.currency, ppp.enabled, ppp.note, ppp.product_id
    FROM aykoshop_payment_accounts pa
    LEFT JOIN aykoshop_product_payment_prices ppp
      ON ppp.method_key=pa.method_key AND ppp.product_id=$1
    WHERE pa.active=true
    ORDER BY pa.sort_order, pa.id
  `,[pid]);
  res.json({ok:true, data:r.rows});
}catch(e){res.status(500).json({ok:false,error:e.message});} });

// M2: product-payment-prices — POST upsert (create or update)
app.post('/api/product-payment-prices', async (req,res)=>{ try{
  const {product_id,method_key,price_value,currency,enabled,note}=req.body||{};
  if(!product_id||!method_key) return res.status(400).json({ok:false,error:'product_id and method_key required'});
  if(price_value===undefined||price_value===null||price_value==='') return res.status(400).json({ok:false,error:'price_value required'});
  const r=await pool.query(
    `INSERT INTO aykoshop_product_payment_prices(product_id,method_key,price_value,currency,enabled,note)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(product_id,method_key) DO UPDATE SET
       price_value=$3, currency=$4, enabled=$5, note=$6, updated_at=NOW()
     RETURNING *`,
    [parseInt(product_id,10), String(method_key), parseFloat(price_value),
     currency||'MAD', enabled!==false, note||null]
  );
  res.json({ok:true, data:r.rows[0]});
}catch(e){res.status(500).json({ok:false,error:e.message});} });

// M2: product-payment-prices — DELETE
app.delete('/api/product-payment-prices/:product_id/:method_key', async (req,res)=>{ try{
  await pool.query(
    'DELETE FROM aykoshop_product_payment_prices WHERE product_id=$1 AND method_key=$2',
    [parseInt(req.params.product_id,10), req.params.method_key]
  );
  res.json({ok:true});
}catch(e){res.status(500).json({ok:false,error:e.message});} });

app.get('/api/payment-claims', async (req,res)=>{ try{
  const {status,q}=req.query; const cond=[],args=[]; let i=1;
  if(status){cond.push('status=$'+i++);args.push(status);}
  if(q){cond.push('(customer_name ILIKE $'+i+' OR subscriber_id ILIKE $'+i+' OR bank ILIKE $'+i+')');args.push('%'+q+'%');i++;}
  if(!req.query.include_test) cond.push("environment='prod'"); // ALLOWLIST: show ONLY prod claims (test/qa/unknown hidden) unless ?include_test=1
  const where=cond.length?'WHERE '+cond.join(' AND '):'';
  const lim=Math.min(parseInt(req.query.limit)||200,500);
  const r=await pool.query('SELECT * FROM aykoshop_payment_claims '+where+' ORDER BY created_at DESC LIMIT '+lim,args);
  res.json({claims:r.rows});
}catch(e){res.status(500).json({error:e.message});} });
app.get('/api/payment-claims/stats', async (req,res)=>{ try{
  const r=await pool.query("SELECT status, count(*)::int n, COALESCE(SUM(amount),0) val FROM aykoshop_payment_claims WHERE is_test IS NOT TRUE GROUP BY status");
  const by={}; let pv=0; r.rows.forEach(x=>{by[x.status]=x.n; if(x.status==='pending')pv=Number(x.val)||0;});
  res.json({by_status:by, pending:by.pending||0, confirmed:by.confirmed||0, rejected:by.rejected||0, pending_value:pv});
}catch(e){res.status(500).json({error:e.message});} });
// ===== PAYMENT TELEGRAM ALERTS (AI detects only; human approves/rejects). Operator chat via TG_CHAT/HTG_TOKEN. =====
async function _tgEditResolved(claim, status, source){
  try{ if(!claim.tg_message_id || !claim.tg_chat_id) return; const _ep=_tgRoute(_isTestRoute(claim.subscriber_id, claim.is_test)); if(!_ep) return; const TG=_ep.token;
    const label=(status==='confirmed')?'✅ تم تأكيد الدفع':'❌ تم رفض الدفع';
    const kb={inline_keyboard:[[{text:label+' · '+source,url:'https://aykoshoop.duckdns.org'}]]};
    await fetch('https://api.telegram.org/bot'+TG+'/editMessageReplyMarkup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:claim.tg_chat_id,message_id:Number(claim.tg_message_id),reply_markup:kb})}).catch(()=>{});
  }catch(e){}
}
// SINGLE SOURCE OF TRUTH + IDEMPOTENT: status flips pending->confirmed/rejected exactly once (WHERE status='pending'). Broadcasts + edits TG message.
async function _resolveClaim(id, action, source, actorId){
  const newStatus=(action==='approve'||action==='confirm')?'confirmed':'rejected'; const actor=source+':'+(actorId||'?');
  const cur=await pool.query('SELECT * FROM aykoshop_payment_claims WHERE id=$1',[id]); if(!cur.rows.length) return {error:'not_found'};
  const r=await pool.query("UPDATE aykoshop_payment_claims SET status=$2, confirmed_by=$3, confirmed_at=NOW() WHERE id=$1 AND status='pending' RETURNING *",[id,newStatus,actor]);
  if(!r.rows.length){ return {already:true, claim:cur.rows[0]}; }
  const claim=r.rows[0];
  await pool.query("INSERT INTO aykoshop_payment_claim_events (claim_id,action,from_status,to_status,actor,detail) VALUES ($1,$2,'pending',$3,$4,$5)",[id,newStatus,newStatus,actor,source]).catch(()=>{});
  try{ _broadcast('payment_claim_updated',{id:claim.id,status:claim.status,confirmed_by:claim.confirmed_by,source:source,subscriber_id:claim.subscriber_id}); }catch(e){}
  _tgEditResolved(claim,newStatus,source).catch(()=>{});
  return {ok:true, claim:claim};
}
async function _payClaimAlert(claim){
  try{
    const _ep=_tgRoute(_isTestRoute(claim.subscriber_id, claim.is_test)); if(!_ep) return false; const TG=_ep.token, CHAT=_ep.chat;
    let prod='—', method=claim.bank||null;
    try{ const p=await pool.query('SELECT service_type,favorite_game,payment_method FROM aykoshop_profiles WHERE subscriber_id=$1',[String(claim.subscriber_id)]); if(p.rows[0]){ const _p=p.rows[0]; prod=((_p.favorite_game||'')+(_p.service_type?(' '+_p.service_type):'')).trim()||'—'; if(!method && _p.payment_method) method=_p.payment_method; } }catch(e){}
    const ts=new Date(claim.created_at||Date.now()).toISOString().replace('T',' ').slice(0,16);
    const token=_crypto.randomBytes(9).toString('hex');
    const base='https://aykoshoop.duckdns.org/api/payment-claims/'+claim.id+'/act?t='+token;
    const kb={inline_keyboard:[[{text:'✅ تأكيد الدفع',url:base+'&a=approve'},{text:'❌ رفض',url:base+'&a=reject'}]]};
    const msg='🔔 Payment Claim جديد\n👤 '+(claim.customer_name||claim.subscriber_id||'—')+'\n🆔 '+(claim.subscriber_id||'—')+'\n🎮 '+(prod||'—')+'\n💰 '+(claim.amount?(claim.amount+' '+(claim.currency||'DH')):'—')+'\n🏦 '+(method||'—')+'\n📸 '+(claim.image_url?'كاينة صورة 👇':'بلا صورة')+(claim.fraud_score?('  ⚠️ احتيال: '+claim.fraud_score):'')+'\n🕒 '+ts+'\n📝 '+String(claim.raw_message||'—').slice(0,140)+'\n🔗 https://app.manychat.com/fb4538388/chat/'+(claim.subscriber_id||'');
    let ok=false, mid=null;
    if(claim.image_url && /^https?:\/\//.test(String(claim.image_url))){ try{ const r=await fetch('https://api.telegram.org/bot'+TG+'/sendPhoto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:CHAT,photo:claim.image_url,caption:msg.slice(0,1000),reply_markup:kb})}); const j=await r.json().catch(()=>null); ok=!!(j&&j.ok); mid=j&&j.result&&j.result.message_id; }catch(e){} }
    if(!ok){ try{ const r=await fetch('https://api.telegram.org/bot'+TG+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:CHAT,text:msg,reply_markup:kb})}); const j=await r.json().catch(()=>null); ok=!!(j&&j.ok); mid=j&&j.result&&j.result.message_id; }catch(e){} }
    if(ok){ await pool.query("UPDATE aykoshop_payment_claims SET tg_message_id=$2, tg_chat_id=$3, approve_token=$4 WHERE id=$1",[claim.id,(mid?String(mid):null),String(CHAT),token]).catch(()=>{}); }
    return ok;
  }catch(e){ return false; }
}
async function _payActionAlert(claim, kind, reason){
  try{
    const _ep=_tgRoute(_isTestRoute(claim.subscriber_id, claim.is_test)); if(!_ep) return false; const TG=_ep.token, CHAT=_ep.chat;
    const head=(kind==='approved')?'✅ Payment Approved':'❌ Payment Rejected';
    const msg=head+'\n👤 '+(claim.customer_name||claim.subscriber_id||'—')+'\n🆔 '+(claim.subscriber_id||'—')+'\n💰 '+(claim.amount?(claim.amount+' '+(claim.currency||'DH')):'—')+(reason?('\n📝 السبب: '+String(reason).slice(0,150)):'')+'\n👤 بواسطة: '+(claim.confirmed_by||'operator');
    const r=await fetch('https://api.telegram.org/bot'+TG+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:CHAT,text:msg})}); const j=await r.json().catch(()=>null); return !!(j&&j.ok);
  }catch(e){ return false; }
}
app.post('/api/payment-claims', async (req,res)=>{ try{
  const b=req.body||{}; const sub=b.subscriber_id||null; const _env=_envOf(b,sub);
  if(sub){ const _ex=await pool.query("SELECT * FROM aykoshop_payment_claims WHERE subscriber_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",[String(sub)]);
    if(_ex.rows.length){ const _c=_ex.rows[0]; const _ageMin=(Date.now()-new Date(_c.created_at).getTime())/60000;
      if(_ageMin<30){ await pool.query("INSERT INTO aykoshop_payment_claim_events (claim_id,action,to_status,actor,detail) VALUES ($1,'duplicate','pending',$2,$3)",[_c.id,(b.source||'text'),String(b.raw_message||'').slice(0,200)]).catch(()=>{}); return res.json(Object.assign({},_c,{duplicate:true})); }
      else { await pool.query("UPDATE aykoshop_payment_claims SET status='expired' WHERE id=$1",[_c.id]).catch(()=>{}); await pool.query("INSERT INTO aykoshop_payment_claim_events (claim_id,action,from_status,to_status,actor) VALUES ($1,'expired','pending','expired','system')",[_c.id]).catch(()=>{}); } } }
  const r=await pool.query("INSERT INTO aykoshop_payment_claims (subscriber_id,customer_name,channel,image_url,amount,currency,bank,order_id,raw_message,status,source,source_ref,fraud_score,fraud_reasons,is_test,environment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14,$15) RETURNING *",
    [b.subscriber_id||null,b.customer_name||null,b.channel||null,b.image_url||null,b.amount||null,b.currency||'DH',b.bank||null,b.order_id||null,b.raw_message||null,b.source||'manual',b.source_ref||null,b.fraud_score||null,b.fraud_reasons||null,(_env!=='prod'),_env]);
  await pool.query("INSERT INTO aykoshop_payment_claim_events (claim_id,action,to_status,actor,detail) VALUES ($1,'created','pending',$2,$3)",[r.rows[0].id,(b.actor||b.source||'manual'),String(b.raw_message||'').slice(0,200)]).catch(()=>{});
  // is_test persisted in the INSERT above (via _isTestRoute = flag OR test-range) + returned by RETURNING * — drives _payClaimAlert routing AND excludes it from real stats/revenue/stale-alerts
  _payClaimAlert(r.rows[0]).then(function(ok){ if(ok) pool.query("INSERT INTO aykoshop_payment_claim_events (claim_id,action,to_status,actor) VALUES ($1,'telegram_alert_sent','pending','telegram')",[r.rows[0].id]).catch(()=>{}); }).catch(()=>{});
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message});} });
app.patch('/api/payment-claims/:id/confirm', async (req,res)=>{ try{
  const actor=(req.body&&req.body.confirmed_by)||req.headers['x-operator']||'operator';
  const out=await _resolveClaim(req.params.id,'approve','dashboard',actor);
  if(out.error) return res.status(404).json({error:out.error});
  res.json(out.already?Object.assign({},out.claim,{already:true}):out.claim);
}catch(e){res.status(500).json({error:e.message});} });
app.patch('/api/payment-claims/:id/reject', async (req,res)=>{ try{
  const actor=(req.body&&req.body.actor)||req.headers['x-operator']||'operator'; const reason=String((req.body&&req.body.reason)||'');
  const out=await _resolveClaim(req.params.id,'reject','dashboard',actor);
  if(out.error) return res.status(404).json({error:out.error});
  if(out.ok && reason){ pool.query("INSERT INTO aykoshop_payment_claim_events (claim_id,action,detail,actor) VALUES ($1,'reject_reason',$2,$3)",[req.params.id,reason.slice(0,200),'dashboard:'+actor]).catch(()=>{}); }
  res.json(out.already?Object.assign({},out.claim,{already:true}):out.claim);
}catch(e){res.status(500).json({error:e.message});} });
app.get('/api/payment-claims/:id/act', async (req,res)=>{ try{
  const id=req.params.id; const a=(req.query.a==='reject')?'reject':'approve'; const t=String(req.query.t||'');
  const _html=function(title,sub,ico){ return '<!doctype html><html dir=\"rtl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>AykoShop</title></head><body style=\"font-family:system-ui;background:#0b0f17;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0\"><div style=\"text-align:center;padding:28px\"><div style=\"font-size:46px\">'+ico+'</div><h2 style=\"margin:10px 0\">'+title+'</h2><p style=\"color:#8b98a9\">'+sub+'</p></div></body></html>'; };
  const cur=await pool.query('SELECT id,status,approve_token FROM aykoshop_payment_claims WHERE id=$1',[id]);
  if(!cur.rows.length) return res.status(404).send(_html('غير موجود','هاد المطالبة ماكايناش','⚠️'));
  if(!t || !cur.rows[0].approve_token || t!==cur.rows[0].approve_token) return res.status(403).send(_html('غير مصرح','رابط غير صالح أو منتهي','🚫'));
  if(cur.rows[0].status!=='pending'){ const done=cur.rows[0].status==='confirmed'; return res.send(_html(done?'مؤكّد من قبل':'مرفوض من قبل','هاد المطالبة تعالجات من قبل (مرة وحدة فقط)',done?'✅':'❌')); }
  const out=await _resolveClaim(id, a, 'telegram', 'tg-btn');
  if(out && out.ok){ return res.send(_html(a==='approve'?'تم تأكيد الدفع':'تم رفض الدفع','تحدّث Dashboard مباشرة 🔄',a==='approve'?'✅':'❌')); }
  if(out && out.already){ const done=out.claim.status==='confirmed'; return res.send(_html(done?'مؤكّد من قبل':'مرفوض من قبل','تعالجات من قبل',done?'✅':'❌')); }
  return res.status(500).send(_html('خطأ','عاود من Dashboard','⚠️'));
}catch(e){ res.status(500).send('error'); } });
app.get('/api/payment-claims/:id/events', async (req,res)=>{ try{
  const r=await pool.query("SELECT * FROM aykoshop_payment_claim_events WHERE claim_id=$1 ORDER BY created_at ASC",[req.params.id]);
  res.json({events:r.rows});
}catch(e){res.status(500).json({error:e.message});} });

  app.listen(PORT, () => console.log(`AykoShop API v2.1 - port ${PORT}`));
});

module.exports = app;
