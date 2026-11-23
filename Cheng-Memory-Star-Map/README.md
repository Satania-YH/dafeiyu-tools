# Cheng-Memory-Star-Map

澄的记忆星图 —— 只读可视化与检查工具。

把 dsh-fish 的五层记忆系统摊开看：事件流、本子、派生状态、Mnemon 记忆库、向量覆盖。
**只读，不写回任何被检数据。**

---

## 状态

**阶段：骨架就位，尚未开工**

开工前有两个决策待定，见 [docs/DECISIONS.md](docs/DECISIONS.md)。

---

## 为什么做这个

《记忆实现-给Alma.md》里那句最关键：

> 记忆不是一份「记忆库」，是一条只追加的事件流 + 每轮现算的派生状态 + 两套外挂检索。

这句话的结构是对的。但实测发现几个「看起来健康、实际在漏」的地方 ——
比如 `heard` 有 39% 是重复注入、insight 无法回溯到产生它的 event、`edges` 表 66% 是时间顺连。

完整核查见 [`../记忆系统体检-2026-11-23.md`](../记忆系统体检-2026-11-23.md)。

这个项目的目标不是「好看」，是让这些漏点**看得见**：
哪条记忆没有向量、哪条 insight 找不到出处、哪条判断二十天没再被提起。

---

## 目录

```
Cheng-Memory-Star-Map/
├── docs/
│   ├── LAYERS.md        五层结构 + 数据源路径 + 字段实测
│   ├── DECISIONS.md     开工前待定的决策
│   └── RULES.md         设计约束（只读 / 不做进度条 / 口径统一）
├── data/                本地快照与导出（不进 git）
└── src/                 源码
```

---

## 硬约束

1. **只读**。所有层都只读打开。写入口只有 `growth_commit`，这个项目不碰。
2. **不做成长进度条 / 亲密度分数 / 等级**。插件注释明确禁止（N2）。可以显示条数、分布、日期、改口链，不要评分。
3. **复用现成纯函数，别重写口径**：`searchEvents`、`renderRecall`、`deriveSelf`、`buildStances`、`examine`、`listNotes`、`listAppointments`。
4. **检查页直接吃 `examine()` 的字段**，不自己另造一套「健康度」。
5. **时间口径统一本地钟**。事件流 `ts` 是 UTC，展示要转本地。

---

## 数据源速查

| 层 | 路径 |
|---|---|
| 事件流 | `D:/dsh-fish-home/dsh-fish/events.jsonl` |
| 本子 | `D:/dsh-fish-home/dsh-fish/{notes,diary,works,appointments}.json` |
| 派生状态 | `D:/dsh-fish-home/dsh-fish/home/她的身份.md` |
| Mnemon | `C:/Users/14127/.mnemon/{runtime,data/default}` |
| 向量服务 | `http://localhost:11434`（Ollama bge-m3） |
| 说明小站 | `http://127.0.0.1:17321`（只 GET，不套栅栏） |
| 观测台 | `http://127.0.0.1:61955/dsh-fish/*`（要本次启动签名 cookie） |

---

## 版本管理

本目录在 `D:/大肥鱼工具` 仓库内（origin: Satania-YH/dafeiyu-tools），分支 `main`。
提交在仓库根执行。
