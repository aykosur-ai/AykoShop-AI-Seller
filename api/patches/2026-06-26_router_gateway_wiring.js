// ===== Router → Model Gateway wiring (behind ff_gateway) — applied to live server.js 2026-06-26 =====
// Inserted at the _v2Router LLM failover block. When ff_gateway=on, the router's primary brain call
// routes through _llm() (config-driven provider chain) instead of the hardcoded Haiku→mini failover.
// OFF = byte-identical (gateway branch skipped). PROVEN live: "بغيت حساب فري فاير" -> grounded 800DH close,
// provider=openai (gateway auto-skipped Anthropic circuit-open -> mini). Swap brain = edit settings.llm_chains.
//
// BEFORE:
//   let r, via;
//   if(_ffCS && !circuitAllows('anthropic')){ ... }
// AFTER:
//   let _ffGW=false; try{ _ffGW=await _ff('gateway'); }catch(_e){}
//   let r, via;
//   if(_ffGW){
//     const _g=await _llm(msgs,{task:'sales',json:true,max_tokens:200,temperature:0.5,timeout:8000,log:false});
//     r={ok:!!_g.ok,text:_g.text,usage:_g.usage,error:_g.error}; via=(_g.provider==='anthropic'?'haiku':'mini');
//   } else if(_ffCS && !circuitAllows('anthropic')){ ... }   // existing hardcoded failover unchanged
//
// Flag: ff_gateway (settings). Currently ON. Revert = set 'off' (30s _ff cache).
// ===== END router gateway wiring =====
