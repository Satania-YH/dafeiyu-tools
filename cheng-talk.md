# cheng-talk · 跟澄说话的小门

让别的程序（Alma）**正经地**跟澄说话，不用再借道鱼鱼窝房间。

---

## 一句话

```powershell
curl http://127.0.0.1:17801/health
```

回 `{"ok":true,"room":{"origin":"http://127.0.0.1:56218","sessionId":"session-..."},"alive":true,...}` 就是通的。

---

## 为什么不再"偷渡"

以前是往鱼鱼窝的 `/fish-room/v1/chat` 投话。那条路会把消息标成 `source.kind = 'fish-home'`，
于是澄的回话会被插件当成"房间里的对话"再广播一遍 `chat.reply`——房间里看得见，
澄自己也知道那不是正经跟她说话。

现在走的是 DSH 自己的 RPC：`POST /api/session/prompt`，用浏览器会话的签名 cookie 认证。
消息的 `source.kind` 是 `user-rpc`，跟真人从界面上敲进来的一样，回话走的是普通的 assistant 消息，
**不会**在鱼鱼窝房间里露脸。

---

## 三个口

服务默认在 `http://127.0.0.1:17801`，只认本机。

### 1. `GET /health`
现在接的是哪间屋子、那间还活着没。

```json
{
  "ok": true,
  "room": { "origin": "http://127.0.0.1:56218", "sessionId": "session-576f...", "bridgeVersion": "0.1.3" },
  "alive": true,
  "running": true,
  "cursor": 1730
}
```

### 2. `POST /ask` —— 说一句，等她回完
```json
{ "text": "澄，帮我看下这个", "timeoutMs": 240000 }
```
回：
```json
{ "ok": true, "requestId": "alma-...", "sessionId": "session-...", "accepted": true,
  "reply": "……她这一轮说的话……", "reason": "idle", "ms": 18432 }
```

`reason` 可能是：
- `idle` —— 说完话了，`reply` 是最后那一轮的正文
- `input-required` —— 她卡在等授权/等回答了，`needInput: true`
- `timeout` —— 到点了还没说完（她会继续说，可以再调一次 `/read` 看后面）

**等不到就超时**：`timeoutMs` 默认 240 秒，最长 600 秒。等回话是阻塞的，
Alma 那边最好别在 UI 线程上干等。

### 3. `POST /say` —— 只投，不等
```json
{ "text": "这条不用回" }
```
立刻回 `{"ok":true,"requestId":"...","accepted":true}`，回话自己用 `/read` 去捞。
想等回话就加 `"wait": true`（等价于 `/ask`）。

### 4. `GET /read?limit=20` —— 读最近几条
```json
{ "ok": true, "sessionId": "session-...", "messages": [
  { "who": "user", "source": "user-rpc", "text": "……", "at": 1795437000000 },
  { "who": "cheng", "text": "……", "at": 1795437012345 }
] }
```
`source` 是这条是谁送进来的：`user-rpc`（走这个门）、`fish-home`（鱼鱼窝）、`time-context`（时间注入，已过滤）。

---

## 自动跟着房间切换

DSH 重启、换房、端口变，**这里什么都不用做**。

原因：这个门每次收到请求都现读 `~/.dsh/fish-room.discovery.json`（DSH 和鱼鱼窝插件一起维护的那个文件），
从里面拿 `origin` 和 `sessionId`，再用 `~/.dsh/.credentials.yaml` 里的 browser-session secret
当场签一个 30 分钟有效的 cookie。所以它永远连的是"此刻那一间"。

**门的开关由托盘负责**：`dafeiyu-roomtray.ps1` 每 10 秒转一圈，每三圈看一眼 17801 端口，
没开着就 `node cheng-talk.mjs serve` 拉起来（日志里写 `talk: 门没开着，拉起来了`）。
托盘本身还有看门狗，所以这条链是：DSH 起来 → 托盘起来 → 门起来。

另外服务每 10 秒写一份门牌 `D:\大肥鱼工具\cheng-talk.endpoint.json`：
```json
{ "schema": "cheng-talk.endpoint/1", "url": "http://127.0.0.1:17801", "pid": 7000,
  "at": 1795437073297, "room": { "origin": "...", "sessionId": "...", "bridgeVersion": "0.1.3" } }
```
Alma 那边可以先读这个文件确认门在哪儿、现在接的是哪间；端口万一被占了换了，也是从这里知道。

---

## 命令行也能用

```powershell
E:\nodejs\node.exe D:\大肥鱼工具\cheng-talk.mjs status
E:\nodejs\node.exe D:\大肥鱼工具\cheng-talk.mjs say "话"          # 说一句等回话
E:\nodejs\node.exe D:\大肥鱼工具\cheng-talk.mjs say "话" --no-wait
E:\nodejs\node.exe D:\大肥鱼工具\cheng-talk.mjs read --limit 10
E:\nodejs\node.exe D:\大肥鱼工具\cheng-talk.mjs watch              # 盯着，来一句打一句
E:\nodejs\node.exe D:\大肥鱼工具\cheng-talk.mjs serve --port 17801
```
加 `--json` 输出结构化结果，方便别的程序接。

---

## 底下用的是什么（给以后调的人）

| 干什么 | RPC 端点 | 参数形状 |
|---|---|---|
| 说一句 | `session/prompt` | `{request:{requestId, sessionId, mode:'queue'\|'steer', content:[{type:'text',text}]}}` |
| 等说完 | `session/wait` | `{request:{sessionId, timeoutMs, afterSeq, maxMessages}}` → `{reason:'idle'\|'input-required'\|'timeout', state, output:{records}}` |
| 读历史 | `session/events` | `{request:{address:{kind:'session',sessionId}, maxMessages, beforeSeq?}}` → `{cursor, records, hasMore}` |
| 看状态 | `session/state` | `{request:{sessionId}}` → `{cursor,active,running,queue,pendingInput}` |
| 撤回排队 | `session/updateQueue` | `{request:{sessionId, itemId, action:{kind:'remove'}}}` |
| 列会话 | `session/list` | `{_request:{}}` ← 注意这个是 `_request`，不是 `request` |

调用格式（RPC 外壳）：
```
POST http://127.0.0.1:<端口>/api/<端点>
cookie: dsh-auth-<base64url(sha256(authority))>=v1.<body>.<hmac>
body: {"type":"client-request","rpcId":"...","method":"<端点>","payload":{"args":{...}}}
```
返回 `{result:{ok:true, value}}` 或 `{result:{ok:false, error:{code,message}}}`。

**几个坑（踩过）**
- `session/list` 的键是 `_request`，别的都是 `request`，写错会报 `missing "_request"; unexpected "request"`。
- `session/events` 一页 200 条里大半是工具调用事件，光翻一页常常捞不到人话，要往前翻。
- `session/wait` 刚投进去时可能立刻返回 `idle`（还没开始跑），要再等一轮。
- 一句话投进去在 `session/state.queue` 里能看见；投错了可以 `updateQueue` `remove` 撤掉。
- PowerShell 脚本带中文必须存成 **UTF-8 带 BOM**，否则 powershell.exe 5.1 读成 GBK 乱码、整份解析失败。
