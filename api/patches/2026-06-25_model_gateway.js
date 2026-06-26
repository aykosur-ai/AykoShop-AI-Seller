// ===== MODEL GATEWAY (provider-agnostic) — swap the brain by CONFIG, not code. 2026-06-25 =====
// One entry point _llm(messages,opt). Provider chain from settings.llm_chains (JSON, 30s cache).
// Wraps the existing _AI_CALL + circuit breaker + _logAiUsage. Uniform result {ok,text,provider,model,usage,tried}.
// Additive: nothing calls _llm yet except the test endpoints -> ZERO change to live brain behavior.
var _LLM_DEFAULT_CHAIN=[{provider:'anthropic',model:'claude-haiku-4-5'},{provider:'mini'},{provider:'gemini',model:'gemini-2.0-flash'}];
var _llmChainsCache=null,_llmChainsTs=0;
async function _getLlmChains(){ if(_llmChainsCache&&(Date.now()-_llmChainsTs)<30000) return _llmChainsCache;
  try{ var r=await pool.query("SELECT value FROM aykoshop_settings WHERE key='llm_chains'"); _llmChainsCache=(r.rows.length&&r.rows[0].value)?JSON.parse(r.rows[0].value):{}; }
  catch(e){ if(!_llmChainsCache)_llmChainsCache={}; }
  _llmChainsTs=Date.now(); return _llmChainsCache;
}
async function _llmResolveChain(task){ if(Array.isArray(task)) return task; var c=await _getLlmChains(); return (c&&c[task||'default'])||(c&&c.default)||_LLM_DEFAULT_CHAIN; }
async function _llm(messages, opt){ opt=opt||{};
  var chain=opt.chain||await _llmResolveChain(opt.task||'default'); var tried=[],lastErr=null;
  for(var i=0;i<chain.length;i++){ var step=chain[i]||{}; var p=step.provider; var fn=_AI_CALL[p]; if(!fn){ tried.push({provider:p,skipped:'unknown_provider'}); continue; }
    var ckey=(p==='mini'?'openai':p);
    if(!circuitAllows(ckey)){ tried.push({provider:p,skipped:'circuit_open'}); continue; }
    var co=Object.assign({},opt,{model:step.model||_modelOf(p,(typeof _cfg!=='undefined'?_cfg:null)),timeout:opt.timeout||8000});
    delete co.chain; delete co.task; delete co.json;
    if(opt.json && (p==='openai'||p==='mini')) co.response_format={type:'json_object'};
    var r; try{ r=await fn(messages,co); }catch(e){ r={ok:false,error:String((e&&e.message)||e).slice(0,160)}; }
    try{ circuitRecord(ckey,!!(r&&r.ok),(r&&r.ok?'gateway ok':'gateway '+((r&&r.error)||'no_text')).slice(0,90)); }catch(e){}
    tried.push({provider:p,model:co.model,ok:!!(r&&r.ok)});
    if(r&&r.ok){ return {ok:true,text:r.text,provider:p,model:co.model,usage:r.usage,tried:tried}; }
    lastErr=(r&&r.error)||'no_text';
  }
  return {ok:false,error:lastErr||'all_providers_failed',tried:tried};
}
app.get('/api/llm/chain', async (req,res)=>{ try{ var c=await _getLlmChains(); res.json({ok:true, configured:c, effective:{default:await _llmResolveChain('default'), sales:await _llmResolveChain('sales')}, providers:Object.keys(_AI_CALL)}); }catch(e){ res.status(500).json({error:e.message}); } });
app.put('/api/llm/chain', async (req,res)=>{ try{ var b=req.body||{}; var val=JSON.stringify(b.chains||b); await pool.query("INSERT INTO aykoshop_settings(key,value) VALUES('llm_chains',$1) ON CONFLICT (key) DO UPDATE SET value=$1",[val]); _llmChainsCache=null; res.json({ok:true, chains:JSON.parse(val)}); }catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/llm/test', async (req,res)=>{ try{ var b=req.body||{}; var r=await _llm([{role:'system',content:b.system||'أنت بائع AykoShop. أجب بإيجاز بالدارجة المغربية.'},{role:'user',content:b.prompt||'سلام، شنو كاين عندكم؟'}],{task:b.task||'default',json:!!b.json,max_tokens:b.max_tokens||120,temperature:(b.temperature==null?0.6:b.temperature)}); res.json(r); }catch(e){ res.status(500).json({error:e.message}); } });
// ===== END Model Gateway =====
