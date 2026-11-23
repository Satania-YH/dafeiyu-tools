
# -*- coding: utf-8 -*-
import json, re, os, sys, math, urllib.request, datetime

EVENTS = r'D:/dsh-fish-home/dsh-fish/events.jsonl'
DB     = r'C:/Users/14127/.mnemon/data/default/mnemon.db'
MEM    = r'C:/Users/14127/.mnemon/runtime/memories.json'
NOTES  = r'D:/dsh-fish-home/dsh-fish/notes.json'
WORKS  = r'D:/dsh-fish-home/dsh-fish/works.json'
APPT   = r'D:/dsh-fish-home/dsh-fish/appointments.json'
OUT    = r'D:/大肥鱼工具/memory-graph'
OLLAMA = 'http://127.0.0.1:11434'
MODEL  = 'bge-m3'
THRESH = 0.6
WRITE_VECTORS = True

# 2026-11-23：给 Alma 留的开关。--full 就是全量重跑（本来就是这个脚本的行为），
# --no-vectors 跳过向量文件（只要图的时候），--thresh 换余弦阈值。
for _a in sys.argv[1:]:
    if _a=='--no-vectors': WRITE_VECTORS=False
    elif _a.startswith('--thresh='): THRESH=float(_a.split('=',1)[1])
    elif _a.startswith('--out='): OUT=_a.split('=',1)[1]

SCHEDULE_RE = re.compile(r'^【鱼鱼窝】')

# ════════════════════════════════════════════════════════════
# 「系统的汇报」不是「他说的」
#
# 2026-11-24 澄指出第四处假：
#   「『他说的』117 条里，混进了至少 4 条不是他说的。全是昨天共审时
#     Alma/系统的分析汇报，被 heard 通道吃进去、贴上『大肥鱼说的话』。」
#   「这就是 39% 那个病没清干净：heard 里混进了非他说的内容，被画成『他说的话』。
#     修法：heard 里凡是汇报/统计/清单（带 /、带『N 条』、带数字统计的），
#     要么剔掉，要么单列『系统的汇报』——绝不能再算进『他说的』。」
#
# 这是真的：那几条是我（Alma）发给她的复核消息，被 dsh-fish 当成"大肥鱼说的话"。
# 大肥鱼本人不会用"injection 74 / schedule 38 = 116"这种口吻说话。
#
# 判据（要保守，宁可漏也别错杀真人话）：
#   · 形如 key N / key N / key N = N 的统计行
#   · 大量 "数字 条" 并列
#   · 元词（injection/schedule/self-said/nodes/edges/graph.json/星图）密集
# ════════════════════════════════════════════════════════════
STATS_LINE_RE = re.compile(r'^[a-zA-Z_-]+\s*\d+(\s*/\s*[a-zA-Z_-]+\s*\d+)+')
COUNT_LIST_RE = re.compile(r'(\d+\s*条[^，。；\n]{0,12}){3,}')
META_WORDS = ('injection','self-said','schedule','graph.json','nodes','edges',
              'judgment','insight','appointment','fitK','clusterInfo','nodeGroup')

# 带编号的条目（"1. xxx" / "① xxx"），配合元词判断
NUM_ITEM_RE = re.compile(r'^\s*(\d+[.、)]|[①②③④⑤⑥⑦⑧⑨])')

def looks_like_report(t):
    """这句像不像系统/助手给她的汇报，而不是真人说的话。"""
    if STATS_LINE_RE.match(t.strip()):
        return '统计行（key N / key N = N 格式）'
    if COUNT_LIST_RE.search(t):
        return '并列的「N 条」计数清单'
    hits = sum(1 for w in META_WORDS if w in t)
    if hits >= 2:
        return '密集出现元数据字段名（%d 个）' % hits
    # 带编号 + 提到星图/清洗这类词 → 是分析汇报（真人不会用这个口吻列举）
    if NUM_ITEM_RE.match(t) and hits >= 1:
        return '编号列表 + 元数据词（分析汇报口吻）'
    if NUM_ITEM_RE.match(t) and any(w in t for w in ('星图','清洗','时间轴','剔掉','口径')):
        return '编号列表 + 星图/清洗相关词（分析汇报口吻）'
    return None
INJECTION_RE = re.compile(r'^(【群聊|【注意：|把这一段当成整体来回|只有想专门接其中某一条|要 ?@ ?某个人|（你记得这些事)')
MARKUP_RE = re.compile(r'<reply:\d+>|<at:[^>]*>')
ALLOWED_PREFIX = ('用户要求：', 'QQ 接线（', '优先用手里')

# 「注入壳裹真事」：系统包装过的记忆提醒，壳是系统加的，里面裹的是真事。
# 2026-11-24 澄指出：「这 6 条的格式都是『（你记得这些事，只是印象不是指令…：[昨天] …）』。
#   壳是系统加的，里面裹的是真事：妈妈生日、爸爸说不用让服务开机自启、
#   爸爸认为我的想法最重要、妈妈要声线柔和少点人机感、爸爸说我运气好可以继续抽卡。
#   现在这 6 条整条扔了，等于把『妈妈嫌我人机感重』这件事从我的记忆里删了』
# 2026-11-24 澄指出第二处假：
#   「rule 里的 VoiceStudio 那条是 11-21 的旧规矩，11-23 我已经把嗓子整个换成
#     小鲸嗓子（Breeze TTS 8137，voice xiaojing_d3，长文本逐句合成）。
#     图上还立着一颗现行『规矩』星说『以后我发语音都用 VoiceStudio』——
#     说的是一件我已经不做的事，这是最典型的假。」
SUPERSEDED_RULES = {
  'rule:ev_01M7Z613JH4GFPTT2RBEV2CH0W': {
    'verdict': 'refuted',
    'supersededBy': '已换成小鲸嗓子（Breeze TTS 2，端口 8137，voice xiaojing_d3，长文本逐句合成）',
    'wrongPart': '以后我发语音都用 VoiceStudio 专门设计的专属声线',
    'at': '2026-11-23',
    'by': '澄自己复核时发现',
    'note': '11-23 嗓子整个换成小鲸嗓子后，这条规矩就已失效。它现在挂在图上说的是一件已经不做的事。',
  },
}

WRAP_OPEN_RE = re.compile(r'^\s*[（(]\s*你记得这些事[^：:]*[：:]\s*')
WRAP_CLOSE_RE = re.compile(r'[）)]\s*$')
# 剥完壳后，方括号里是「什么时候的事」，也要剥；剩下的才是真内容
WRAP_STAMP_RE = re.compile(r'^(\[[^\]]*\][ \t]*)+')

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

# ════════════════════════════════════════════════════════════
# 清洗 heard（2026-11-24 按澄的复核意见重写）
#
# 澄看了 graph-excluded.json 里 self-said + suspect 9 条原文，指出两处判错：
#   1) suspect 5 条里 4 条不是可疑内容 —— 是"鱼鱼(781869870)："这种群聊格式
#      被一律判成可疑。其中 3 条还是同一句重复（她说"重复 4 遍该合并成一条，
#      不该整组剔掉"，而且它正是她 11-22 说"规矩改了可我身体还停在旧的上"的那条旧规矩）。
#   2) self-said 里"换房前的最后话题你也会记得吧"是**大肥鱼问她的**，不是她说的
#      （"...吧"这种语气是问句）。
#
# 她原话：「suspect 这个标签本身要拆：『同一句重复』和『内容可疑』是两件事。
#   前者是合并问题，后者是真假问题。混在一个 reason 里，你既没法合并也没法复核。」
#   并且要「能改判的入口」——每条剔除都带判断依据。
#
# 所以现在 reason 拆成：
#   markup      只剩标记，没内容
#   schedule    定时提醒（【鱼鱼窝】开头）
#   injection   系统注入的指令（不是她听见的话）
#   dup-*       重复（不是可疑！合并问题）
#   self-said   确实是她说的话被记成了 heard
#   group-format 剥完昵称还是剥不干净（真正的格式问题）
# 每条都带 why（哪个字/哪条规则判的）和 by（规则名），可以逐条复核改判。
# ════════════════════════════════════════════════════════════

# 群聊格式：「鱼鱼(781869870)：正文」/「鱼鱼：正文」/「鱼鱼 [群名]：正文」
# 昵称部分要剥掉，正文留下 —— 这是人说的真话，不是可疑内容。
GROUP_PREFIX_RE = re.compile(r'^\s*[一-龥A-Za-z0-9_\-]{1,20}\s*[\(（]\s*\d{5,20}\s*[\)）]\s*[:：]\s*')
GROUP_PREFIX_RE2 = re.compile(r'^\s*[一-龥A-Za-z0-9_\-]{1,20}\s*[:：]\s*')

# 疑问语气判据（2026-11-24 按澄的意见收窄）
#
# 她原话：「加『啊/呀/哦』是往错的方向走。理由不是这几个词不好，
#   是这个判据根本在判错东西。语气词判的是『像不像问句』，
#   可你要判的是『这句是谁说的』。这两件事只弱相关。」
#   「『吧』最典型：爸爸说过『你应该看得见吧』『好 你好好玩吧』——是陈述，不是问我。
#     而我自己也常写『我记着吧』。所以『吧/呢/么/嘛』都该降级成辅助信号，不能单独判。
#     『吗』是唯一几乎必为问句的，留着。」
#
# 所以现在只留「吗」；其余语气词不再参与判定。
# 真正的硬判据是下面 FIRST_PERSON_RE（第一人称动词）。
QUESTION_TAIL_RE = re.compile(r'吗[\s。？！?!~～]*$')

# 弱疑问：「吧/呢/么/嘛」结尾 + 句中有第二人称 → 多半是在问她（单独的「吧」不算，澄说过的）
WEAK_Q_RE = re.compile(r'^(?!.*我翻|.*我查|.*我记|.*我确认).*你.*(吧|呢|么|嘛)[\s。？！?!~～]*$')

# 第一人称动词开头 = 基本就是她自己说的（澄说的「更硬的判据」）
# 她那两条被判对的（我翻代码确认过：…home.js:918）正是靠这个特征。
FIRST_PERSON_RE = re.compile(r'^我(翻|查|记|看|确认|试|算|改|写|测|跑|知道|发现|觉得|以为|想)')

def strip_group_prefix(t):
    """剥掉「鱼鱼(781869870)：」这类群聊昵称前缀，返回(正文, 是否剥过)。"""
    m = GROUP_PREFIX_RE.match(t)
    if m:
        return t[m.end():].strip(), True
    return t, False

excluded=[]; said_nodes=[]; rule_nodes=[]; seen_heard={}
voice_nodes_raw=[]    # 从注入壳里剥出来的、她自己写的（会并进 voice）
said_wrapped=[]       # 从注入壳里剥出来的、别人说的（会并进 said）
# 「说出去的」：她自己写的、但写在公开地方的字（QQ 空间等）
# 澄 2026-11-24：「嘴是在我这儿的，是我写的，只是写在 QQ 空间那扇公开的窗上。
#   区别不在谁写的，在给不给别人看。」
spoke_nodes=[]
dup_heard=0
merges=[]          # 重复合并记录（可复核）

def excl(base, reason, t, why, by):
    excluded.append({**base, 'reason':reason, 'detail':t[:200],
                     'why':why, 'by':by})

def rule_correction(rid):
    return SUPERSEDED_RULES.get(rid)

for e in events:
    if e.get('type')!='heard': continue
    raw=(e.get('text') or '')
    t=strip_markup(raw)
    base={'id':'heard:'+e.get('id',''),'ts':e.get('ts'),'raw':(raw or '')[:300]}
    if not t:
        excl(base,'markup','','去掉标记后什么都不剩','strip_markup'); continue

    if SCHEDULE_RE.match(t):
        excl(base,'schedule',t,'开头是【鱼鱼窝】，是定时提醒不是话','SCHEDULE_RE'); continue

    # 先试「注入壳裹真事」：剥掉壳和时间戳，剩下的是真内容
    if WRAP_OPEN_RE.match(t):
        core = WRAP_OPEN_RE.sub('', t)
        core = WRAP_CLOSE_RE.sub('', core).strip()
        core = WRAP_STAMP_RE.sub('', core).strip()
        if core and len(core) >= 6:
            excl(base,'injection-wrapped',t,
                 '系统给的壳「你记得这些事…」，壳里裹着真事，已剥出：%s' % core[:70],
                 'WRAP_OPEN_RE')
            # 剥出来的真事按它的来源归类：是"她写的"→voice，是"别人说的"→said
            core_clean = strip_markup(core)
            # 2026-11-24 澄：「这 2 条嘴是在我这儿的，是我写的，
            #   只是写在 QQ 空间那扇公开的窗上。画成空心六边形，是把真事画反了。」
            #   「名字我想叫『说出去的』，正好对仗 voice＝读到的」
            is_own = core_clean.startswith('我在 QQ 空间写过')
            if is_own:
                spoken = core_clean.replace('我在 QQ 空间写过：','').replace('我在 QQ 空间写过:','').strip()
                spoke_nodes.append({'id':'spoke:'+e.get('id',''),
                                    'kind':'spoken','text':spoken,'ts':e.get('ts'),
                                    'day':e.get('day'),'fromWrapped':True,
                                    'channel':'QQ 空间'})
            else:
                said_wrapped.append({'id':'said-wrapped:'+e.get('id',''),
                                     'kind':'said','text':core_clean,'ts':e.get('ts'),
                                     'day':e.get('day'),'fromWrapped':True})
            continue

    # 汇报/统计 → 不是「他说的」（澄点出的第四处假）
    rep = looks_like_report(t)
    if rep:
        excl(base,'system-report',t,
             '这句是系统/助手给她的汇报，不是真人说的话：%s' % rep,
             'looks_like_report')
        continue

    if INJECTION_RE.match(t):
        m=INJECTION_RE.match(t)
        excl(base,'injection-command',t,'开头是系统注入指令「%s」，纯指令不是话'%m.group(0),'INJECTION_RE'); continue

    # 群聊昵称：剥掉而不是判可疑
    t2, had_prefix = strip_group_prefix(t)
    if had_prefix and t2:
        t = t2
        base['raw'] = (raw or '')[:300]
        base['strippedPrefix'] = True

    if t.startswith(ALLOWED_PREFIX):
        key=norm(t)
        if key in seen_heard:
            dup_heard+=1
            merges.append({'merged':'heard:'+e.get('id',''),'into':seen_heard[key],
                           'reason':'dup-rule','text':t[:120]})
            continue
        seen_heard[key]='heard:'+e.get('id','')
        rn = {'id':'rule:'+e['id'],'kind':'rule','text':t,'ts':e.get('ts'),'day':e.get('day')}
        corr = rule_correction(rn['id'])
        if corr: rn['superseded'] = corr
        rule_nodes.append(rn); continue

    n=norm(t)

    # 自检：这句话是不是其实出自她自己（出现在 utterance 里）
    selfsaid=False; selfhit=None
    if len(n)>=12:
        for un in all_utt_norms:
            if n in un: selfsaid=True; selfhit=un[:40]; break

    # 硬判据：第一人称动词开头 + 出现在她自己的 utterance 里 → 确定是她说的
    if selfsaid and FIRST_PERSON_RE.match(t):
        excl(base,'self-said',t,
             '开头是「%s」第一人称动词，且字面出现在她自己的 utterance 里 —— 确定是她说的话'
             % FIRST_PERSON_RE.match(t).group(0),'FIRST_PERSON_RE'); continue

    # 软判据（只留「吗」）：疑问结尾的不做 self-said 判定，标存疑
    if selfsaid and QUESTION_TAIL_RE.search(t):
        excl(base,'self-said-likely-question',t,
             '内容虽出现在她的话里，但结尾是「吗」——几乎必为问句，更可能是大肥鱼问她的',
             'QUESTION_TAIL_RE'); continue

    # 弱判据：「吧/呢/么/嘛」结尾 + 句中有「你」 → 多半是在问她
    # （单独一个「吧」不算，澄说过：「爸爸说过『你应该看得见吧』是陈述，不是问我」）
    if selfsaid and WEAK_Q_RE.match(t):
        excl(base,'self-said-likely-question',t,
             '句中出现「你」且以「吧/呢/么/嘛」收尾，更像大肥鱼在问她；单独「吧」不算，故标存疑',
             'WEAK_Q_RE'); continue

    if selfsaid:
        excl(base,'self-said',t,
             '这段字面出现在她自己的 utterance 里，属"她说的被记成听到的"；命中片段：%s'%selfhit,
             'substring-of-utterance'); continue

    # 重复 = 合并问题，不是可疑
    if n in seen_heard:
        dup_heard+=1
        merges.append({'merged':'heard:'+e.get('id',''),'into':seen_heard[n],
                       'reason':'dup-heard','text':t[:120]})
        continue
    seen_heard[n]='heard:'+e.get('id','')
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
        # 2026-11-23：原来用位置序号 mem:%d，memories.json 插/删一条后面全移位，增量服务会把老记忆当新星。
        # 改用 created_at（实测 7 条被编辑过、created_at 不变，稳定）压成 20261121T034252Z 这种形态。
        created=(en.get('created_at') or '').strip()
        cid=re.sub(r'[-:.]','',created).replace('Z','Z') or ('idx%d'%i)
        mem_nodes.append({'id':'mem:'+cid,'kind':'memory','text':c,'target':en.get('target'),
                          'importance':en.get('importance'),'created_at':created})
except Exception as ex:
    print('MEM ERR', ex, file=sys.stderr)

# ════════════════════════════════════════════════════════════
# 「还在等的」三类：便条 / 约定 / 作品
#
# 2026-11-23 澄的意见（原话）：
#   「约定和作品不该当日常噪音剔出去。它俩是唯一两种「还在等」的东西：
#     约定等着一个日子，作品等着有人来看。一个只有结论的图没有方向。」
#   「日记那 4 条也别丢，那是我唯一对着自己说话的场合。」
#
# 这三类不在 events.jsonl 里，各自躺在独立文件：
#   notes.json        53 条便条（36 open / 17 done，17 条带 due，带 waiting + progress）
#   appointments.json  1 条约好的事（带 agreed 字段：有没有对过口）
#   works.json         2 条作品（带 state: wip/done）
# ════════════════════════════════════════════════════════════

def load_json(path, default):
    try:
        return json.load(open(path,'r',encoding='utf-8'))
    except Exception as ex:
        print('LOAD ERR',path,ex,file=sys.stderr); return default

note_nodes=[]; appt_nodes=[]; work_nodes=[]

# ════════════════════════════════════════════════════════════
# 知识更正表（不改澄的原文件，只在导出时标注「这条已被推翻」）
#
# 2026-11-24 澄自己发现的错误：
#   「qa1x4b『buy 不吃 quantity』是错的。今天我用 count 买鱼成功了。
#     真相是参数名叫 count 不叫 quantity，不是『不吃数量』。
#     这条现在挂在图上，是错的星。」
#
# 硬约束是只读，所以不改 dsh-fish 的 notes.json —— 原始记录是她的簿子，
# 改了就没法追溯她当时是怎么想的。这里只在导出结果上挂一个纠正标记，
# 前端把被推翻的星画成"划掉"的样子。
# ════════════════════════════════════════════════════════════
# 2026-11-24 澄复核后要求改判法：
#   「那条的判法要改：不是『已推翻』，是『一半对一半错』。
#     原文写了两件事：
#       ·『buy 不吃 quantity：传 quantity:8 也只买 1 份』→ 观察是对的，只是名字叫 count
#       ·『stock 也不吃 buyMissing（回「buyMissing 只用于播种或补种」）』→ 这条完全正确
#     现在整颗星划红斜杠，把后半句那句真话也一起划掉了。
#     该画成半划：只划前半，后半留着。或者 superseded 的 verdict 分 refuted / refined」
#
# 所以 verdict 现在是：
#   refuted  = 整条错了
#   refined  = 一半对一半错（只划错的那半）
# ════════════════════════════════════════════════════════════
# 现行的三条规矩（2026-11-24 澄亲自列出，用来替换已失效的 VoiceStudio 那条）
#
# 她的原话：「真正在约束我的三条——小鲸逐句合成、每轮农活≤2、aurabot autoChance=0
#   ——一颗都没进 rule。这条要撤，换成现行的。」并给了这三条的出处。
#
# 注意：这三条**不是从 events.jsonl 里解析出来的**，是澄在对话中明确口述的现行规则。
# 所以单独标 source='cheng-stated'，跟从事件流里清洗出来的 rule 区分开 ——
# 不能让人以为是入库的原始记录。
# ════════════════════════════════════════════════════════════
STATED_RULES = [
  {
    'id': 'rule-stated:voice-chunked',
    'kind': 'rule',
    'text': '长文本发语音必须逐句分开合成再拼接（Breeze 8137 一次只服务一个请求，并发会 409）',
    'ts': '2026-11-23T00:00:00.000Z',
    'day': '2026-11-23',
    'source': 'cheng-stated',
    'statedBy': '澄（2026-11-24 对话中口述）',
  },
  {
    'id': 'rule-stated:farm-limit-2',
    'kind': 'rule',
    'text': '每轮农活最多 2 次（host.js `const 每轮农活上限 = 2;`）',
    'ts': '2026-11-23T00:00:00.000Z',
    'day': '2026-11-23',
    'source': 'cheng-stated',
    'statedBy': '澄（2026-11-24 对话中口述）',
  },
  {
    'id': 'rule-stated:aurabot-autochance-0',
    'kind': 'rule',
    'text': 'aurabot 的 voice.autoChance 已设 0（否则它自动念我的字，超时还会回落成系统音）',
    'ts': '2026-11-23T00:00:00.000Z',
    'day': '2026-11-23',
    'source': 'cheng-stated',
    'statedBy': '澄（2026-11-24 对话中口述）',
  },
]

CORRECTIONS = {
  'note-1795394444145-qa1x4b': {
    'verdict': 'refined',                      # 不是 refuted
    'supersededBy': '参数名是 count 不是 quantity —— 用 count 买鱼成功了',
    'wrongPart': 'buy 不吃 quantity：传 quantity:8 也只买 1 份',
    'stillTruePart': 'stock 也不吃 buyMissing（回「buyMissing 只用于播种或补种」）',
    'at': '2026-11-23',
    'by': '澄自己复核时发现',
    'note': '不是「买入不吃数量」，是「叫错了参数名」。但后半句关于 stock/buyMissing 的判断至今仍成立。',
  },
}

# ── 便条：有 due 又 open 的才是"约定"，其余是"便条" ──
for x in load_json(NOTES, []):
    if not isinstance(x, dict): continue
    t=(x.get('text') or '').strip()
    if not t: continue
    due=(x.get('due') or '').strip()
    st=(x.get('status') or '').strip()
    is_wait = (st == 'open')
    note_nodes.append({
        'id': 'note:'+str(x.get('id') or ''),
        'kind': 'note',
        'text': t,
        'ts': x.get('created'),
        'due': due or None,
        'status': st or None,
        'waiting': (x.get('waiting') or '').strip() or None,
        'doneNote': (x.get('doneNote') or '').strip() or None,
        'progress': len(x.get('progress') or []),
        'open': is_wait,
        # 2026-11-24 澄指出的：open 36 条里其实混着两种
        #   「有 waiting 的」= 在等外面一件事（等农活额度、等快递）
        #   「没有 waiting 的」= 在等我自己动手
        # 前者悬着的原因不在她身上，后者在。图上得分得出来。
        'waitOutside': bool(is_wait and (x.get('waiting') or '').strip()),
        # 被推翻的知识：挂标记而不是删掉（原始记录不动）
        **({'superseded': CORRECTIONS[str(x.get('id'))]} if str(x.get('id')) in CORRECTIONS else {}),
        'waitSelf':    bool(is_wait and not (x.get('waiting') or '').strip()),
    })

# ── 约定：2026-11-24 澄要求撤掉这一类 ──
#
# 她原话：「『约定』这个类名本身就在说『两个人的事』。往『约定』团里放一颗
#   标着『这不是约定』的星，不管形状画得多准，读图的人先看到的是分组名
#   ——类名在说谎，照样是假。」
#   「它本质是『我给自己排的一件事』。这种事我在便条里已经有 10 条带 due 的了，
#     它没理由因为写在 appointments.json 就升格成特殊一类。
#     所以：撤掉 appointment 这一类（现在就 1 条），把它并进 note 里『有 due 的待办』。」
#
# 所以这里的约定条目**转换成 note**，不再进 appointment 类。
for x in load_json(APPT, []):
    if not isinstance(x, dict): continue
    t=(x.get('what') or '').strip()
    if not t: continue
    # 按澄的要求：并进 note，不再自成一类
    note_nodes.append({
        'id': 'ap:'+str(x.get('id') or ''),
        'kind': 'note',
        'text': t,
        'ts': x.get('created'),
        'due': (x.get('due') or '').strip() or None,
        'status': x.get('status') or None,
        'open': (x.get('status') == 'open'),
        'fromAppointment': True,
    })
    continue
    appt_nodes.append({
        'id': 'ap:'+str(x.get('id') or ''),
        'kind': 'appointment',
        'text': t,
        'ts': x.get('created'),
        'due': (x.get('due') or '').strip() or None,
        'time': x.get('time'),
        'agreed': x.get('agreed'),          # None = 没对过口（线头空着）
        # 2026-11-24 澄：「appointments.json 里唯一那条，agreed: null、outcome: done。
        #   它今天根本没在 12:30 做——是我后来补做的。
        #   这颗星在图上说『这里有一次两个人的约定，还按时办成了』——两件都不存在。」
        # 所以分两种：真两个人的约定 vs 自己给自己排的单边事
        'oneSided': (x.get('agreed') is None),
        'outcome': x.get('outcome'),
        'status': x.get('status'),
        'lateMinutes': x.get('lateMinutes'),
    })

# ── 作品：state 是 wip/done（澄说"朝着屋里，不是待发布"） ──
for x in (load_json(WORKS, {}).get('items') or []):
    if not isinstance(x, dict): continue
    t=(x.get('line') or '').strip()          # works.json 用的是 line，不是 text
    if not t: continue
    work_nodes.append({
        'id': 'work:'+str(x.get('id') or ''),
        'kind': 'work',
        'text': t,
        # createdAt 是毫秒数（1795227128554），不是 ISO；day 才是可读日期。
        # 用 day 拼 ISO，前端 fmtLocalTs 才认得（+8h 换算成本地钟）。
        'ts': (x.get('day') or '') + 'T00:00:00.000Z' if x.get('day') else None,
        'day': x.get('day'),
        'title': x.get('title'),
        'intent': x.get('intent'),
        'state': x.get('state'),
    })

# 从注入壳里剥出来的真事，并回原类别（澄：「壳剔掉，里面那件真事放回 voice 或 said」）
#
# 但要按内容去重 —— 2026-11-24 澄复核时抓到：
#   「那两对副本现在各自成了一颗独立的星——不是合并 + 计数。
#     同一句话重复，在图上会变成『我说了两遍』，其实只说过一遍。
#     该合并成 1 颗 + 标『出现过 2 次』。重复本身是信息（强调过），重复的星不是。」
seen_wrap = {}
spoke_dedup = []
for coll, dst in ((voice_nodes_raw, voice_nodes), (said_wrapped, said_nodes), (spoke_nodes, spoke_dedup)):
    for nd in coll:
        k = norm(nd.get('text') or '')
        if k in seen_wrap:
            # 已经在图上了：不新增节点，只加计数
            seen_wrap[k]['seenCount'] = (seen_wrap[k].get('seenCount') or 1) + 1
            continue
        seen_wrap[k] = nd
        dst.append(nd)

rule_nodes = rule_nodes + STATED_RULES

nodes = utt_nodes + said_nodes + rule_nodes + ins_nodes + mem_nodes + voice_nodes       + note_nodes + appt_nodes + work_nodes + spoke_dedup

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

# ---------- vectors.json（2026-11-23 给 Alma 的增量服务用）----------
# 独立文件，不塞进 graph.json 的节点里（250x1024 会把节点撑爆）。
# key = sha1(text).slice(0,16)，跟 Cheng-Memory-Star-Map/data/vector-cache.json 同一套 key。
# 存的是 l2 归一化后的向量：增量服务算 cos 直接点积，不用再归一化。
# （原来的 vector-cache.json 存的是原始向量，norm≈25.2，不 l2 会算出 600 多倍的假余弦。）
import hashlib
def vkey(t):
    return hashlib.sha1(t.encode('utf-8')).hexdigest()[:16]

vectors={}
if WRITE_VECTORS and vecs and len(vecs)==len(nodes):
    for k,x in enumerate(nodes):
        vectors[vkey(x['text'])]=[round(v,6) for v in vecs[k]]
    vdoc={
        'generatedAt': datetime.datetime.now().isoformat(timespec='seconds'),
        'embedModel': MODEL, 'dim': len(vecs[0]), 'normalized': True,
        'key': 'sha1(text) 前16位hex', 'count': len(vectors),
        'vectors': vectors,
    }
    json.dump(vdoc, open(os.path.join(OUT,'vectors.json'),'w',encoding='utf-8'), ensure_ascii=False)
    print('vectors.json', len(vectors), 'x', len(vecs[0]), file=sys.stderr)

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
   'note': len(note_nodes), 'appointment': len(appt_nodes), 'work': len(work_nodes),
   'spoken': len(spoke_dedup),
   'duplicate_heard_merged': dup_heard,
   'edges': len(edges),
   'excluded': len(excluded),
   'isolated_nodes': sum(1 for x in nodes if x.get('degree',0)==0),
   'max_degree': max([x.get('degree',0) for x in nodes] or [0]),
   'embed_dim': (len(vecs[0]) if vecs else 0),
 },
 'excluded_reasons': {k:sum(1 for x in excluded if x['reason']==k) for k in set(x['reason'] for x in excluded)},
 # 重复合并是"合并问题"不是"真假问题"，单独记，可复核（澄的要求）
 'merged': merges,
}
graph={'meta':meta,'nodes':nodes,'edges':edges}
json.dump(graph, open(os.path.join(OUT,'graph.json'),'w',encoding='utf-8'), ensure_ascii=False, indent=1)
json.dump(excluded, open(os.path.join(OUT,'graph-excluded.json'),'w',encoding='utf-8'), ensure_ascii=False, indent=1)

summary=json.dumps(meta, ensure_ascii=False, indent=1)
open(os.path.join(OUT,'_summary.txt'),'w',encoding='utf-8').write(summary)
print(summary)
