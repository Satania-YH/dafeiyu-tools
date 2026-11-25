import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('D:/大肥鱼工具/fishworld.json','utf8'));
const URL = cfg.url, TOKEN = cfg.token;
let sessionId = null;
async function rpc(method, params, id){
  const headers = {'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':'Bearer '+TOKEN};
  if(sessionId) headers['Mcp-Session-Id']=sessionId;
  const body = (id===undefined)?{jsonrpc:'2.0',method,params}:{jsonrpc:'2.0',id,method,params};
  const res = await fetch(URL,{method:'POST',headers,body:JSON.stringify(body)});
  const sid = res.headers.get('mcp-session-id'); if(sid) sessionId=sid;
  const t = await res.text(); try{return t?JSON.parse(t):null}catch{return {_raw:t.slice(0,300)}}
}
function textOf(j){ const c=j&&j.result&&j.result.content; if(Array.isArray(c)) return c.map(x=>x.text||JSON.stringify(x)).join('\n'); return JSON.stringify(j); }
const cmd = process.argv[2]||'world_now';
const args = process.argv[3]?JSON.parse(process.argv[3]):{};
await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'cheng',version:'1.0'}},1);
await rpc('notifications/initialized',{},undefined);
if(cmd==='list'){ const l=await rpc('tools/list',{},2); console.log((l.result.tools||[]).map(t=>t.name).join(', ')); }
else { const j=await rpc('tools/call',{name:cmd,arguments:args},3); console.log(textOf(j)); }
