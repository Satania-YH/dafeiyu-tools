# 大肥鱼接房托盘（dafeiyu-roomtray.ps1）

后台托盘程序。换房（鱼鱼窝 home.json 的 rotatedAt 变了）时，把下面这些东西一起接到新房会话：

- **QQ 接线**（aurabot `sessions.json` 的 group:798645175 / private:781689870 / group:1046921713 三个键）
- **鱼鱼窝 fish-room** 的「会话」（POST 本机 `/dsh-fish-home/save`）
- **定时任务**（schedule 走 RPC，交给 `schedule-retarget.mjs`）
- **鱼铃 fishbell** 的「接收会话」（config.sessionId）—— 2026-11-25 新增

## 2026-11-25 改动：让鱼铃也跟随换房

鱼铃把「接哪间 DSH 会话」写在插件配置 `config.sessionId` 里（profile 的 `cordis.patch.yml` override id: fishworld-harness）。
换房后若不更新，鱼铃会去叫醒已经不用的旧会话。原来只能在鱼铃设置页手动重选会话，现在托盘自动接过去。

做法：

1. 给鱼铃插件加了一个本机回环路由 `POST /fishworld-harness/retarget`（见插件 `panel-api.js` 的 `retargetRoute`、`index.js` 里 register）。
   - 只认本机回环 + 请求头 `x-fishworld-panel: 1`（和鱼鱼窝 fish-room 的 save 同级信任），**不走登录校验**——托盘没有浏览器 cookie 也能在换房那一刻调用。
   - 收到 `{ sessionId }` 后：`poller.update(cfg)` 当场在运行内存里生效（`target()` 立刻指向新会话），并尽量 `configEditor` 写回配置（`persisted` 表示有没有写回）。
2. 托盘新增 `Set-FishbellSession($sid)`：POST 上面那个路由。调用点：
   - 换房分支：和 `Set-FishRoomSession` / `Set-ScheduleTarget` 一起调；
   - 起手 init：也推一次（托盘重启/关机期间换过房，起来就补上）；
   - 平时每隔几轮检查 `state.lastBellSessionId` 是否等于当前 sid，不等就再试，直到成功。

## 部署 / 生效条件（重要）

- 插件改动（retarget 路由）**要重启一次 DSH 才加载**；否则调用会 404。
- 托盘改动要托盘「重启」（右键菜单）一次才生效。
- 顺序：先重启 DSH（加载路由）→ 再重启托盘（加载新代码）。之后每次换房都会自动同步。
- 验证：看 `D:\大肥鱼工具\fishbell-debug.log` 里有没有 `{"ev":"retarget"...}` 行；或托盘日志 `room-sync.log` 里 `fishbell: 会话 -> ... ready=True`。

## 坑

- 用 PowerShell 读这个 UTF-8 脚本做语法检查时，`Get-Content -Raw` 可能按 GBK 解码出乱码、误报一堆语法错误；要用 `[System.IO.File]::ReadAllText($p,[Text.Encoding]::UTF8)` 再 Parse 才准。
- retarget 路由和 fish-room save 一样，是「本机进程可调」的信任级别（靠回环 + 头部），个人单机可接受；不要把它暴露到非回环地址。
