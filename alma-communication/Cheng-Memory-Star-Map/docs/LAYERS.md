# 五层结构 · 数据源与字段实测

> 核查时间 2026-11-23 12:00 前后（本地 UTC+8）
> 所有数字为实测，非转述。复验脚本见文末。

---

## 第 0 层：事件流（唯一可信源）

**文件**：`D:/dsh-fish-home/dsh-fish/events.jsonl`
**快照**：2373 行 / 约 990 KB（只追加，不改不删）

### 每行字段

| 字段 | 实测情况 |
|---|---|
| `id` | `ev_01M…` ULID，**时间顺序应按此排，不能信文件顺序** |
| `v` | 恒为 1 |
| `ts` | ISO UTC。文件顺序里有 **37 处倒序** |
| `day` | **meta 恒为 0**，不可用于分组 |
| `stage` | 2367 条全是 1（未触发阶段推进）|
| `type` | 见下表 |
| `source` | `system` 2282 / `timer` 22 / `tool` 63 |
| `text` | 中位 33 字，均值 101.7，最长 1926，无空 |
| `refs[]` | **2367 条里只有 18 条有**，每目标仅被引 1 次 |
| `verdict` | **全 null（100%）** |
| `confidence` | 0.5 × 2313（97.7%），其余零星 |
| `flags[]` | `uncommitted` 641 / `anchored` 5 |

### type 分布

| type | 条数 | 说明 |
|---|---|---|
| `meta` | 1437 | 工具账，占 60.7% |
| `utterance` | 704 | 其中 **641 带 `uncommitted`**（聊天行，不进信念）|
| `heard` | 211 | 去重后 **128**（39% 重复）|
| `voice` | 12 | 读到的别人的字 |
| `seed` / `ask` / `answer` | 各 1 | |
| `revise` | **0** | 笔记说改口会新增，实际一次没有 |

**真正「她自己的判断」只有 63 条**（utterance 去掉 uncommitted，source 全是 `tool`）。

### meta 内部构成

| 前缀 | 条数 | 占比 |
|---|---|---|
| `seen:` | **876** | 占 meta 61%，占全库 **37%** |
| `use:` | 289 | 工具调用记录（35 条 fail）|
| `looked` / `look` / `mat` | 各 65–67 | |
| `browsed` | 16 | |
| `diary` | 9 | |

`seen:` 中位间隔 **72.8 秒**，最短 0 秒，最长 26865 秒。

### heard 重复明细

| 次数 | 内容开头 | 性质 |
|---|---|---|
| **50** | 只有想专门接其中某一条…写 `<reply:编号>` | 回复格式说明 |
| 15 | 用户要求：以后我发语音都用 VoiceStudio… | 规则注入 |
| 6 | QQ 接线（2026-11-20 起）… | 配置说明 |

同 session 内重复：

| session | 事件 | 去重 |
|---|---|---|
| e22c6b81 | 41 | 21 |
| aeb02dda | 40 | 26 |
| aa0a7259 | 74 | 53 |
| 994af702 | 39 | 28 |
| 46b42eee | 17 | 12 |

---

## 第 1 层：本子（故意不进事件流）

同目录 `D:/dsh-fish-home/dsh-fish/`：

| 文件 | 大小 | 条数 | 结构 |
|---|---|---|---|
| `notes.json` | 29900 B | 44 | list；字段 `id/text/due/waiting/doneNote/created/status/reason/closedAt/revisedAt/progress` |
| `appointments.json` | 428 B | 1 | list；`id/due/time/what/created/status/notifiedAt/lateMinutes/agreed/askId/closedAt/outcome/reason` |
| `works.json` | 1424 B | 2 | dict `{version, items[]}` |
| `diary/2026-11-2{0,1,2,3}.md` | — | 4 | 一天一篇 |
| `talk-recent.json` | 10543 B | — | 最近对白 |

### notes 状态

- open **29** / done **15**
- 已过期未完成：**0**（健康）
- 无 `due` 的 open：**21**
- done 里有 `doneNote` 的 14/15

---

## 第 2 层：派生状态（每轮现算，不落盘）

**插件**：`C:/Users/14127/.dsh/profiles/desktop/node_modules/@ssamurias/dsh-fish` v1.0.8

| 函数 | 位置 | 作用 |
|---|---|---|
| `deriveSelf(events, opts)` | `lib/derive.js:787` | 纯函数，算成「此刻的我」 |
| `renderSelfDoc(model, …)` | `lib/selfdoc.js:334` | 渲染中文身份文档 |
| `examine(events, opts)` | `lib/health.js` | 记忆检查（只读不写盘）|

**产物**：`home/她的身份.md`（16684 B，19 段）

**⚠️ 实测偏差**：mtime 11:15:28，之后落了 4 条 committed 事件（11:20 / 11:41 / 11:53），文档未重写。
不是「每轮重写」，是「有新 committed utterance 才重写」或更窄条件。

### examine() 实测输出

```json
{
  "ok": true, "events": 2367, "days": 3,
  "beliefs": 63, "solid": 2, "tensionsTotal": 0, "faded": 0,
  "guards": {"rewrite": 0, "secret": 0},
  "revises": {"week": 0, "refined": 0, "refuted": 0},
  "flips": 0,
  "stock": {"chat": {"hit": 1, "total": 704}, "comment": {"hit": 0, "total": 0}},
  "speech": {"total": 704, "anchored": 222, "openers": 0, "quoteCards": 0},
  "nearSolid": [...5 条], "stale": [], "tensions": []
}
```

---

## 第 3 层：Mnemon（跨会话热记忆 + 图谱 + 文档）

**根目录**：`C:/Users/14127/.mnemon/`

| 文件 | 大小 | 内容 |
|---|---|---|
| `runtime/memories.json` | 15208 B | 29 条 entries：`content/created_at/updated_at/target/importance` |
| `runtime/MEMORY.md` | 7370 B | **投影，不许手改**（18 条 memory 全在）|
| `runtime/USER.md` | 2492 B | 投影 |
| `data/default/mnemon.db` | 991232 B | SQLite |
| `documents/index.json` | 40208 B | 38 篇项目文档 |

### memories.json 分布

- `target`：memory 18 / user 11
- `importance`：critical 19 / normal 10
- `updated ≠ created`：7 条

### mnemon.db

| 表 | 行数 |
|---|---|
| `insights` | 66（软删除 4）|
| `edges` | 783 |
| `oplog` | 226 |

**insights 字段**：`id, content, category, importance, tags, entities, source, access_count, stored_at, created_at, updated_at, deleted_at, last_accessed_at, embedding, effective_importance`

| category | 条数 | avg importance | 无向量 |
|---|---|---|---|
| context | 29 | 4.0 | 0 |
| fact | 21 | 4.33 | 0 |
| insight | 7 | 4.57 | 0 |
| decision | 4 | 4.0 | 0 |
| preference | 4 | 4.5 | 0 |
| general | 1 | 3.0 | 0 |

**关键实测**

- `source` **全部是 `'agent'`** —— 无字段指向来源 event
- `embedding` **100% 覆盖**，1024 维（4096 bytes float32）
- `tags` 空 29/66，`entities` 空 16/66
- `access_count = 0` 的 **29 条**，其中 **28 条是 context**
- `effective_importance` 范围 0.70 – 1.50，**importance=5 的也掉到 1.2**
- 内容前 40 字归一化后**零重复**

**edges 分布**

| edge_type | 条数 |
|---|---|
| temporal | **518**（其中 `proximity` 顺连 **404**）|
| entity | 232 |
| semantic | 18 |
| causal | 15 |

只留非时间边：**23/66 孤立点**。

### memories.json ↔ db 重复

29 条里 **16 条** 与 insights 相似度 **1.00**（同文）。需定唯一真身。

---

## 第 4 层：语义向量（Ollama bge-m3）

- 服务：`E:/Ollama/ollama.exe serve` → `http://localhost:11434`
- 实测 `/api/version` = **0.40.17**，`bge-m3:latest` 1.16 GB / bert / 1024 维
- 常驻：计划任务 `OllamaWatchdog`，每 2 分钟探端口，不通才 WMI 拉起，互斥体 `Local\OllamaWatchdog`
- 配置：`cordis.patch.yml:1138-1155`

### 余弦相似度实测（66 条全对，2145 对）

| 阈值 | 边数 | 孤立点 |
|---|---|---|
| ≥0.9 | 2 | — |
| ≥0.8 | 23 | — |
| ≥0.7 | 56 | — |
| **≥0.6** | **210** | **5 / 66** |
| ≥0.5 | 952 | 0 |

**最像的一对：0.888** —— 恰好是内容重复的两条（鱼鱼窝 farm 参数）。

**结论：向量质量很好，是 edges 表没用上它。**

### 坑

补向量必须显式 `--embed-model bge-m3`。CLI 默认 `nomic-embed-text`（768 维），维数对不上等于白补，且不报错。

---

## 第 5 层：会话与上下文压缩

- 会话文件：`C:/Users/14127/.dsh/sessions/<项目>/session.v4.jsonl.zstd`
- 老对话由 billion-context 换摘要：`compress` / `decompress` / `search_context` / `acp_status`
- **原话只能用 `decompress` 取回**，`search_context` 只搜得到摘要
- 没有可直接读的落盘文件，这层只能通过工具看

---

## 复验脚本

```python
import json, collections, sqlite3, math, struct

# 事件流
ev = [json.loads(l) for l in open('D:/dsh-fish-home/dsh-fish/events.jsonl', encoding='utf-8') if l.strip()]
print('总事件', len(ev))
print('类型', collections.Counter(e['type'] for e in ev))
print('flags', collections.Counter(f for e in ev for f in (e.get('flags') or [])))
print('seen 条数', sum(1 for e in ev if e['text'].startswith('seen:')))

h = [e for e in ev if e['type'] == 'heard']
print('heard', len(h), '去重', len(set(e['text'] for e in h)))

com = [e for e in ev if e['type'] == 'utterance' and 'uncommitted' not in (e.get('flags') or [])]
print('committed utterance', len(com))

# Mnemon
db = sqlite3.connect('C:/Users/14127/.mnemon/data/default/mnemon.db')
c = db.cursor()
c.execute('SELECT edge_type, COUNT(*) FROM edges GROUP BY edge_type')
print('边类型', c.fetchall())
c.execute('SELECT COUNT(*) FROM insights WHERE embedding IS NULL')
print('无向量条数', c.fetchone()[0])

# 向量余弦
c.execute('SELECT id, content, embedding FROM insights WHERE embedding IS NOT NULL')
rows = c.fetchall()
V = [(r[0], r[1], struct.unpack(f'{len(r[2])//4}f', r[2])) for r in rows]
def cos(a, b):
    d = sum(x*y for x, y in zip(a, b))
    na = math.sqrt(sum(x*x for x in a)); nb = math.sqrt(sum(x*x for x in b))
    return d / (na*nb) if na and nb else 0
sims = [cos(V[i][2], V[j][2]) for i in range(len(V)) for j in range(i+1, len(V))]
for th in (0.9, 0.8, 0.7, 0.6, 0.5):
    print(f'≥{th}: {sum(1 for s in sims if s >= th)} 对')
```
