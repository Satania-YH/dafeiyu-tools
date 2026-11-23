
# -*- coding: utf-8 -*-
import json, re, os, sys, math, urllib.request, datetime

EVENTS = r'D:/dsh-fish-home/dsh-fish/events.jsonl'
DB     = r'C:/Users/14127/.mnemon/data/default/mnemon.db'
MEM    = r'C:/Users/14127/.mnemon/runtime/memories.json'
OUT    = r'D:/大肥鱼工具/memory-graph'
OLLAMA = 'http://127.0.0.1:11434'
MODEL  = 'bge-m3'
THRESH = 0.6

SCHEDULE_RE = re.compile(r'^【鱼鱼窝】')
INJECTION_RE = re.compile(r'^(【群聊|【注意：|把这一段当成整体来回|只有想专门接其中某一条|要 ?@ ?某个人|（你记得这些事)')
MARKUP_RE = re.compile(r'<reply:\d+>|<at:[^>]*>')
ALLOWED_PREFIX = ('用户要求：', 'QQ 接线（', '优先用手里')

def norm(s):
    return re.sub(r'[\W_]+', '', s, flags=re.UNICODE)

def strip_markup(s):
    return MARKUP_RE.sub('', s or '').strip()

# ---------- load events ----------
def parse_ts(s):
    try:
        return datetime.datetime.fromisoformat((s or '').replace('Z','+00:00'))
    except Exception:
        return datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)

events=[]
with open(EVENTS,'r',encoding='utf-8') as f:
    for line in f:
        line=line.strip()
        if not line: continue
        try: events.append(json.loads(line))
        except: pass
events.sort(key=lambda e: parse_ts(e.get('ts')))

types={}
for e in events: types[e.get('type')]=types.get(e.get('type'),0)+1

# utterance norms for self-said test
utt_nodes=[]; utt_norms=[]; all_utt_norms=[]
for e in events:
    if e.get('type')=='utterance':
        tt=(e.get('text') or '').strip()
        if tt: all_utt_norms.append(norm(tt))
    if e.get('type')=='utterance' and (e.get('topic') or '').strip():
        t=(e.get('text') or '').strip()
        if not t: continue
        utt_nodes.append({'id':'utt:'+e['id'],'kind':'judgment','text':t,
                          'topic':e.get('topic'),'ts':e.get('ts'),'day':e.get('day')})
        utt_norms.append(norm(t))

excluded=[]; said_nodes=[]; rule_nodes=[]; seen_heard={}
dup_heard=0
for e in events:
    if e.get('type')!='heard': continue
    raw=(e.get('text') or '')
    t=strip_markup(raw)
    base={'id':'heard:'+e.get('id',''),'ts':e.get('ts'),'raw':(raw or '')[:300]}
    if not t:
        excluded.append({**base,'reason':'markup','detail':'markup only'}); continue
    if SCHEDULE_RE.match(t):
        excluded.append({**base,'reason':'schedule','detail':t[:120]}); continue
    if INJECTION_RE.match(t):
        excluded.append({**base,'reason':'injection','detail':t[:120]}); continue
    if re.match(r'^鱼鱼[\s]*[\(（]?\s*\d', t):
        excluded.append({**base,'reason':'suspect','suspect':'group-format','detail':t[:120]}); continue
    if t.startswith(ALLOWED_PREFIX):
        key=norm(t)
        if key in seen_heard: dup_heard+=1; continue
        seen_heard[key]=1
        rule_nodes.append({'id':'rule:'+e['id'],'kind':'rule','text':t,'ts':e.get('ts'),'day':e.get('day')}); continue
    n=norm(t)
    selfsaid=False
    if len(n)>=12:
        for un in all_utt_norms:
            if n in un: selfsaid=True; break
    if selfsaid:
        excluded.append({**base,'reason':'self-said','detail':t[:120]}); continue
    key=n
    if key in seen_heard: dup_heard+=1; continue
    seen_heard[key]=1
    said_nodes.append({'id':'heard:'+e['id'],'kind':'said','text':t,'ts':e.get('ts'),'day':e.get('day')})

voice_nodes=[]
for e in events:
    if e.get('type')=='voice':
        t=(e.get('text') or '').strip()
        if t: voice_nodes.append({'id':'voice:'+e['id'],'kind':'voice','text':t,'ts':e.get('ts'),'day':e.get('day'),'layer':'voice'})

# ---------- insights from mnemon.db ----------
import sqlite3
ins_nodes=[]
try:
    con=sqlite3.connect(DB); con.row_factory=sqlite3.Row; cur=con.cursor()
    for r in cur.execute("select id,content,category,importance,effective_importance from insights where deleted_at is null"):
        c=(r['content'] or '').strip()
        if not c: continue
        ins_nodes.append({'id':'ins:'+r['id'],'kind':'insight','text':c,'category':r['category'],
                          'importance':r['importance'],'eff_importance':r['effective_importance']})
    con.close()
except Exception as ex:
    print('DB ERR', ex, file=sys.stderr)

# ---------- runtime memories ----------
mem_nodes=[]
try:
    mem=json.load(open(MEM,'r',encoding='utf-8'))
    entries=mem.get('entries',[]) if isinstance(mem,dict) else mem
    ins_norms=[norm(x['text']) for x in ins_nodes]
    for i,en in enumerate(entries):
        c=(en.get('content') or '').strip()
        if not c: continue
        n=norm(c)
        dup=any(n==x or (len(n)>=40 and (n in x or x in n)) for x in ins_norms)
        if dup: continue
        mem_nodes.append({'id':'mem:%d'%i,'kind':'memory','text':c,'target':en.get('target'),'importance':en.get('importance')})
except Exception as ex:
    print('MEM ERR', ex, file=sys.stderr)

nodes = utt_nodes + said_nodes + rule_nodes + ins_nodes + mem_nodes + voice_nodes

# ---------- embeddings via ollama ----------
def embed_all(texts):
    out=[]
    for i in range(0,len(texts),16):
        chunk=texts[i:i+16]
        body=json.dumps({'model':MODEL,'input':chunk}).encode('utf-8')
        req=urllib.request.Request(OLLAMA+'/api/embed', data=body, headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req, timeout=180) as r:
            j=json.load(r)
        embs=j.get('embeddings')
        if embs is None and 'data' in j:
            embs=[d['embedding'] for d in j['data']]
        out.extend(embs)
    return out

def l2(v):
    s=math.sqrt(sum(x*x for x in v)) or 1.0
    return [x/s for x in v]

texts=[x['text'] for x in nodes]
vecs=None
try:
    raw=embed_all(texts)
    vecs=[l2(v) for v in raw]
except Exception as ex:
    print('EMBED ERR', ex, file=sys.stderr)

edges=[]
if vecs and len(vecs)==len(nodes):
    n=len(nodes)
    for i in range(n):
        vi=vecs[i]
        for j in range(i+1,n):
            vj=vecs[j]
            c=sum(a*b for a,b in zip(vi,vj))
            if c>=THRESH:
                edges.append({'source':nodes[i]['id'],'target':nodes[j]['id'],'cos':round(c,3)})
    # attach dimensions
    for k,x in enumerate(nodes): x['vec_dim']=len(vecs[k])

# ---------- write ----------
deg={}
for ed in edges:
    deg[ed['source']]=deg.get(ed['source'],0)+1
    deg[ed['target']]=deg.get(ed['target'],0)+1
for x in nodes: x['degree']=deg.get(x['id'],0)

meta={
 'generatedAt': datetime.datetime.now().isoformat(timespec='seconds'),
 'source': {'events':EVENTS,'mnemonDb':DB,'memories':MEM},
 'params': {'embedModel':MODEL,'cosThreshold':THRESH},
 'counts': {
   'events_total': len(events), 'event_types': types,
   'nodes_total': len(nodes),
   'judgment': len(utt_nodes), 'said': len(said_nodes), 'rule': len(rule_nodes),
   'insight': len(ins_nodes), 'memory': len(mem_nodes), 'voice': len(voice_nodes),
   'duplicate_heard_merged': dup_heard,
   'edges': len(edges),
   'excluded': len(excluded),
   'isolated_nodes': sum(1 for x in nodes if x.get('degree',0)==0),
   'max_degree': max([x.get('degree',0) for x in nodes] or [0]),
   'embed_dim': (len(vecs[0]) if vecs else 0),
 },
 'excluded_reasons': {k:sum(1 for x in excluded if x['reason']==k) for k in set(x['reason'] for x in excluded)},
}
graph={'meta':meta,'nodes':nodes,'edges':edges}
json.dump(graph, open(os.path.join(OUT,'graph.json'),'w',encoding='utf-8'), ensure_ascii=False, indent=1)
json.dump(excluded, open(os.path.join(OUT,'graph-excluded.json'),'w',encoding='utf-8'), ensure_ascii=False, indent=1)

summary=json.dumps(meta, ensure_ascii=False, indent=1)
open(os.path.join(OUT,'_summary.txt'),'w',encoding='utf-8').write(summary)
print(summary)
