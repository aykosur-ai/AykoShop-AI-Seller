require('dotenv').config({ path: __dirname + '/.env', override: true });

// hermes-worker.js — PM2 worker; precomputes Hermes off the request path.
const { Pool } = require('pg');
const hermes = require('./hermes');
const pool = new Pool({ host:process.env.DB_HOST||'localhost', port:process.env.DB_PORT||5432, database:process.env.DB_NAME||'n8ndb', user:process.env.DB_USER||'n8n', password:process.env.DB_PASSWORD|| '' });
async function tick(){ try{ const r=await hermes.computeAll(pool); console.log(new Date().toISOString(),'[hermes-worker] computed',JSON.stringify(r)); }catch(e){ console.error(new Date().toISOString(),'[hermes-worker] error:',e.message); } }
tick(); setInterval(tick, 5*60*1000);
