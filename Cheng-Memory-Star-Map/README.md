# 澄的记忆星图

把记忆画成一片星图：**一颗星 = 一条记忆**。相近的自动连线，点开看原话。

后台服务 + 浏览器打开 + 系统托盘，**只读**（不改任何记忆文件、不回写、不联网）。

---

## 快速开始

```bash
# 1. 生成数据（大肥鱼的导出脚本）
python D:/大肥鱼工具/memory-graph/export-graph.py

# 2. 补向量（bge-m3，走本机 Ollama）
node server/embed.mjs

# 3. 起服务
node server/server.mjs
# → http://127.0.0.1:17800/
```

或者双击 `tray/星图.bat` —— 托盘会自己拉起服务。

---

## 目录

```
Cheng-Memory-Star-Map/
├── app/index.html        前端（单文件，Canvas 2D 渲染）
├── server/
│   ├── server.mjs        后台服务（HTTP + 单实例锁）
│   └── embed.mjs         向量计算（bge-m3）
├── tray/
│   ├── 星图托盘.ps1      系统托盘（右键菜单 / 自动守护）
│   ├── 星图.bat          双击启动托盘
│   ├── make-icon.ps1     生成图标（橙色底 + 白「澄」字）
│   └── starmap.ico       托盘图标
├── data-sources/         数据源（*.json，按 memory-graph/1 规范）
└── data/                 运行时（锁 / 日志 / 向量缓存）
```

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 前端页面 |
| GET | `/api/health` | 健康检查 `{ok, version, sources}` |
| GET | `/api/sources` | 数据源列表 |
| GET | `/api/source?id=<name>` | 某个源的节点 + 向量 |

**默认端口 17800**，只绑 `127.0.0.1`（不对外）。

---

## 数据源格式（memory-graph/1）

```json
{
  "schema": "memory-graph/1",
  "title": "澄的记忆",
  "note": "可选说明",
  "nodes": [
    {
      "id": "唯一 id",
      "text": "记忆原文（点开就看它）",
      "kind": "fact",
      "ts": "2026-11-23",
      "importance": 0.8,
      "confidence": 0.85,
      "scope": "分区名",
      "tags": ["标签A"],
      "vector": [0.01, -0.03, 0.22]
    }
  ]
}
```

- **`text` 是唯一必填字段**
- **`vector`** 可选，但**有它才走语义连线**（余弦 topK），没有就退回文本相似度（中文双字 Jaccard）
- 同一文件内 `vector` 维度必须一致（我们用 bge-m3 的 1024 维）
- 也接受裸数组 `[{...}]` 或 `.jsonl`（一行一个节点）

`kind` 决定颜色，我们用的映射：

| 我们的 kind | 星图的 kind | 含义 |
|---|---|---|
| judgment | conclusion | 我的判断 |
| said | event | 听到的真话 |
| rule | promise | 规矩 |
| insight / memory | fact | 长期记忆 |

---

## 单例保护

三层，从内到外：

1. **托盘**：`data/tray.lock` 独占文件 —— 第二次启动直接退出
2. **服务**：`data/server.lock` 独占文件 —— 检测到活 PID 就报「已经在运行了」
3. **端口**：操作系统 `EADDRINUSE` —— 兜底，捕获后给可读提示

**残留锁自动接管**：进程崩了但锁还在 → 检查 PID → 死了就接管，不会卡死。
**退出清理**：`SIGINT` / `SIGTERM` / `exit` 三个钩子都释放锁。

---

## 托盘

双击 `tray/星图.bat`（或 `powershell -File tray/星图托盘.ps1`）。

| 操作 | 效果 |
|---|---|
| 悬停 | `澄的记忆星图 · 运行中 · N 个源` |
| 双击 | 打开星图 |
| 右键 → 打开星图 | 打开浏览器 |
| 右键 → 复制地址 | 复制 `http://127.0.0.1:17800/` |
| 右键 → 重启服务 | 停再启 |
| 右键 → 停止服务 | 停掉 node |
| 右键 → 退出 | 停服务 + 清理锁 |

**自动守护**：每 15 秒探一次，服务掉了自动拉起。

---

## 向量计算

```bash
node server/embed.mjs                    # 处理 data-sources/cheng.json
node server/embed.mjs --file=xxx.json    # 指定文件
node server/embed.mjs --force            # 忽略缓存全重算
```

- 走本机 Ollama（`http://localhost:11434`），模型 `bge-m3`，1024 维
- **235 条约 4 秒**（2 路并发）
- 缓存在 `data/vector-cache.json`，按**文本哈希**索引 —— 文本没变就不重算
- 结果写回同一个 JSON 的 `vector` 字段

---

## 视觉可调项

前端面板里能直接调：

- **形态**：分区 / 星云 / 球壳 / 星系 / 长河 / 星河 / 极光 / 突破 + 随机生成
- **主题**：暮色 / 冰蓝 / 霓虹 / 紫夜 + 自定义
- **特效**：星芒 / 连线流光 / 星海 / 流星 / 脉冲（可逐项开关）+ 自定义
- **调节**：节点大小、连线阈值、自动旋转、辉光、星尘密度、铺开程度
- **配置**：随机一套 / 存为收藏 / 复制种子分享

---

## 来源

前端渲染基于 [asdfd3/3d-memory-sea](https://github.com/asdfd3/3d-memory-sea)（MIT）的思路，
以及 [记忆星图 v0.2](https://space.bilibili.com/16669666)（作者：苏小懒SAMA）的界面与交互设计。

本项目的改动：
- 去掉 Electron，改成**后台服务 + 浏览器**（`app/index.html` 注入 `window.starmap` 桥接层）
- 加**单实例锁**（三层）
- 加**系统托盘**（自动守护 + 橙色「澄」字图标）
- 接 **bge-m3 向量**（`server/embed.mjs`）
- 数据源适配 dsh-fish 的记忆格式

---

## 只读保证

- 从打开到关掉，只**读**数据源文件，不改、不写回、不删
- 向量写在数据源 JSON 里（那是我们自己的导出文件，不是原始记忆库）
- 服务只绑 `127.0.0.1`，不联网
