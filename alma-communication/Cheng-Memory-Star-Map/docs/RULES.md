# 设计约束

> 这些不是建议，是硬约束。违反任何一条，做出来的东西就不该上。

---

## R1 · 只读

**所有层都只读打开。不写回 `events.jsonl`，不写回 `mnemon.db`，不写回任何本子。**

理由：事件流的写入口只有一个 —— `growth_commit`。绕过它写入会破坏「唯一可信源」这个前提，
让「改口是新增 revise 而不是覆盖」的设计失效。

**具体禁止**

- ❌ 不以任何方式 append `events.jsonl`
- ❌ 不 `UPDATE` / `DELETE` `mnemon.db` 任何表
- ❌ 不写 `notes.json` / `appointments.json` / `works.json`
- ❌ 不手改 `她的身份.md`（它是投影，每轮重写会覆盖）
- ❌ 不手改 `MEMORY.md` / `USER.md`（同上）

**允许**

- ✅ 复制快照到 `data/` 做分析
- ✅ 在 `data/` 下建自己的索引/缓存
- ✅ 调用 `examine()` / `searchEvents()` 等纯函数

---

## R2 · 不做成长进度条 / 亲密度分数 / 等级

插件注释明确禁止（标记为 **N2**）。

> 「别做成长进度条 / 亲密度分数：插件注释明确禁止（N2）。可以显示条数、分布、日期、改口链，不要等级/进度/评分」

**可以显示**

- ✅ 条数、分布、占比
- ✅ 日期、时间跨度、间隔
- ✅ 改口链（哪条 revise 指回哪条）
- ✅ 孤立点、覆盖率这类客观统计

**不可以显示**

- ❌ 「成长进度 67%」
- ❌ 「亲密度 ★★★☆☆」
- ❌ 「记忆健康度 82 分」
- ❌ 任何形式的分级、评分、进度条、等级

**为什么**：一旦有了分数，她本人会想去「刷分」。这不读自身数值是设计约束 ——
`health.js` 文件头写明「这些数字不给『我本人』看」。

---

## R3 · 复用现成纯函数，不重写口径

| 函数 | 位置 | 用途 |
|---|---|---|
| `searchEvents` | `lib/recall.js` | 事件检索 |
| `renderRecall` | `lib/recall.js` | 检索结果渲染 |
| `deriveSelf` | `lib/derive.js:787` | 派生「此刻的我」 |
| `buildStances` | `lib/stance.js` | 判断的生长轨迹 |
| `examine` | `lib/health.js` | 记忆检查 |
| `listNotes` | `lib/note.js` | 便条 |
| `listAppointments` | `lib/appoint.js` | 预约簿 |

**不允许**：自己再定义一套「什么算信念」「什么算重复」「什么算健康」。
口径分叉后，两个页面会给出矛盾的数字，那时没人知道该信哪个。

---

## R4 · 检查页直接吃 `examine()` 字段

不自己另造「健康度」模型。

`examine()` 返回：`ok / empty / events / days / beliefs / solid / tensionsTotal / faded / byType / tensions / stale / nearSolid / staleDays / solidStaleDays / guards / revises / flips / stock / speech`

如果 `examine()` 覆盖不到（比如向量覆盖率），**另开一栏明确标注「体检补充，非 examine 口径」**，
不要混在一起，也不要改 `examine()` 的语义。

---

## R5 · 时间口径统一本地钟

- 事件流 `ts` 是 **UTC**，展示必须转本地（UTC+8）
- `day` 字段**对 meta 恒为 0**，横跨四天 —— 不能用
- 文件顺序里有 **37 处 ts 倒序** —— 不能假设有序
- 排序用 `id`（ULID，内含时间），或 `ts` 排序后重排

**日期键统一走 `dateKey()`**（本地日）。

---

## R6 · 脏数据必须前端过滤，不能假装不存在

实测存在的噪声：

| 类别 | 条数 | 处理 |
|---|---|---|
| `seen:` 心跳 | 876 | 默认隐藏，可开关 |
| `uncommitted` 聊天行 | 641 | 默认隐藏（不进信念）|
| 系统指令注入（重复 heard）| 83 | 默认去重 |
| `meta` 工具账 | 1437 | 默认隐藏 |
| 软删除 insights | 4 | 默认隐藏 |

**不允许**：把 `seen:` 画成节点然后说「图有点密」。
**不允许**：把 `uncommitted` 混进「她的判断」里。

---

## R7 · 不暴露内部路径与凭据

- 不把 API key / token / cookie 打进页面
- 观测台的 `/dsh-fish/*` 需要本次启动签名的 cookie，**不要尝试绕过栅栏**
- 页面只在本机回环（127.0.0.1）上开，不监听 0.0.0.0

---

## R8 · 出问题不影响 dsh-fish

独立进程，独立端口。挂了不能拖累插件。

启动失败要明确报错，不能静默。
