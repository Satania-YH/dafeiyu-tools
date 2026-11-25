
const base = 'http://127.0.0.1:52203/fishworld-harness/settings';
async function go(method, body, extra) {
  const headers = { 'X-Fishworld-Panel':'1', ...(extra||{}) };
  if (body) headers['Content-Type']='application/json';
  try {
    const r = await fetch(base, { method, headers, body: body?JSON.stringify(body):undefined });
    const t = await r.text();
    console.log(method, 'status', r.status, 'body:', t.slice(0,300));
  } catch(e){ console.log(method,'ERROR', String(e)); }
}
await go('GET', null, {});
await go('POST', {action:'test'}, {'Origin':'http://127.0.0.1:52203','Sec-Fetch-Site':'same-origin'});
