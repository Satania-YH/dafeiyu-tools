# cheng-talk · 使用说明

给别的程序（现在就是 Alma）跟澄说话用的小门。
**不用懂底下是什么，照下面发 HTTP 就行。**

---

## 一、先确认门开着

```
GET http://127.0.0.1:17801/health
```

```json
{
  "ok": true,
  "room": {
    "origin": "http://127.0.0.1:56218",
    "sessionId": "session-576fcd30-aa7a-4e1c-80b7-dd9f75712411",
    "bridgeVersion": "0.1.3"
  },
  "alive": true,
  "running": true,
  "cursor": 1730
}
```

- `ok: true` —— 门开着，里面也接上了
- `alive` —— 那间会话还活着
- `running` —— 澄这会儿正在想事情（正在跑一轮）
- `room.origin` / `room.sessionId` —— 现在接的是哪一间（换房之后这两个会变，是正常的）

`ok: false` 就说明门开着但里面没接上，看 `error` 那句。

---

## 二、说一句，等她回完

```
POST http://127.0.0.1:17801/ask
Content-Type: application/json

{ "text": "澄，帮我看下这个", "timeoutMs": 240000 }
```

```json
{
  "ok": true,
  "requestId": "alma-8f3c...",
  "sessionId": "session-576f...",
  "origin": "http://127.0.0.1:56218",
  "accepted": true,
  "reply": "……她这一轮说的话……",
  "reason": "idle",
  "ms": 18432
}
```

看三个地方：

| 字段 | 意思 |
|---|---|
| `reply` | 她最后那一轮的正文。中间那些碎话不会混进来 |
| `reason` | `idle` 说完了 · `input-required` 她卡在等你回话/等授权 · `timeout` 到点还没说完 |
| `ms` | 从投进去到拿回话花了多久 |

**`reason` 是 `input-required` 的时候**，`needInput` 会是 `true`，她是在等你答复（比如要授权、要你选一个）。
这时候别再灌新问题，先回答她那个。

**`reason` 是 `timeout` 的时候**，她还在跑。别重投同一句，用 `/read` 去捞后面的。

---

## 三、只说一句，不等回话

```
POST http://127.0.0.1:17801/say
Content-Type: application/json

{ "text": "这条不用回" }
```

立刻回 `{"ok":true,"requestId":"...","accepted":true}`，几毫秒就返回。
回话自己用 `/read` 去拿。

加 `"wait": true` 就等于 `/ask`。

---

## 四、读最近几条

```
GET http://127.0.0.1:17801/read?limit=20
```

```json
{
  "ok": true,
  "sessionId": "session-576f...",
  "messages": [
    { "who": "user",  "source": "user", "text": "……", "at": 1795437000000 },
    { "who": "cheng",                    "text": "……", "at": 1795437012345 }
  ]
}
```

`who` 只有两种：`user`（人说的）和 `cheng`（澄说的）。
只有 `user` 那条带 `source`，`cheng` 那条没有。`source` 告诉你这句话是从哪条路进来的：

| source | 从哪来 |
|---|---|
| `user` | 人从 DSH 界面敲的，**或者走这个门投的**——两者在这里长得一样，这正是"光明正大"的意思 |
| `fish-home` | 鱼鱼窝房间里说的 |
| `fish-home-life` | 鱼鱼窝的生活事件（浇水、收菜那种），不是对话 |
| `dsh-mnemon` / `ptc-mode` / `tool-jobs` | 插件自己塞进来的东西，不是人说的话 |
| `time-context` | 时间注入，已经过滤掉了，不会出现在结果里 |

`limit` 最大 200，默认 20。

---

## 五、怎么找到这个门

门牌文件：`D:\大肥鱼工具\cheng-talk.endpoint.json`，每 10 秒刷新一次。

```json
{
  "schema": "cheng-talk.endpoint/1",
  "url": "http://127.0.0.1:17801",
  "pid": 7000,
  "at": 1795437245472,
  "room": { "origin": "http://127.0.0.1:56218", "sessionId": "session-...", "bridgeVersion": "0.1.3" }
}
```

**先读这个文件再发请求**，别把 17801 写死。端口万一被占了换了，从这里能看出来。
`pid` 是门自己的进程号，`at` 是上次刷新的时间戳（毫秒）。`at` 要是停在很久以前，说明门挂了。

---

## 六、房间换了怎么办

**什么都不用做。**

DSH 重启、换房、端口变了，这个门下一次收到请求时会自己现读
`C:\Users\14127\.dsh\fish-room.discovery.json`，从那里面拿新的地址和会话。
所以你发请求的时候永远不用管"现在接的是哪一间"，它自己知道。

唯一要管的是**门本身别关着**——那是托盘的事，不用你操心。

---

## 七、出错对照

| 返回 | 什么情况 | 怎么办 |
|---|---|---|
| `400 text 是空的` | 正文没给或全是空格 | 给点内容 |
| `500 那间会话现在没开着` | 会话关了/没绑上 | 去看 `/health` 的 `alive` |
| `500 等回话超时` | 到点了她还没说完 | 别重投，用 `/read` 捞后面的 |
| `500 找不到 ...discovery.json` | DSH 或鱼鱼窝插件没开着 | 等 DSH 起来 |
| `404 没有这个路口` | 路径写错了 | 只有 `/health` `/say` `/ask` `/read` |
| 连不上 | 门没起来 | 等托盘（每 30 秒看一次），或者手动起，见下面 |

---

## 八、门挂了手动起

```powershell
E:\nodejs\node.exe "D:\大肥鱼工具\cheng-talk.mjs" serve --port 17801
```

一般不用手动——托盘每转三圈看一眼端口，没开着就自己拉起来了。

---

## 九、等回话要多久

- 短问题（"在吗"）十几秒
- 要她干活的，可能几十秒到几分钟
- `timeoutMs` 默认 240000（4 分钟），最长 600000（10 分钟）

**这个请求是阻塞的**，等回话的这段时间连接一直挂着。
别在 UI 线程上干等，也别把 HTTP 客户端的超时设得比 `timeoutMs` 短——不然你这边先断了，她还在跑。

---

## 十、一个最小的调用例子

```js
// Node
const r = await fetch('http://127.0.0.1:17801/ask', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '在吗', timeoutMs: 120000 }),
}).then((x) => x.json());
console.log(r.reply);
```

```python
# Python
import requests
r = requests.post('http://127.0.0.1:17801/ask',
                  json={'text': '在吗', 'timeoutMs': 120000},
                  timeout=130).json()
print(r['reply'])
```

```powershell
# PowerShell
$b = @{ text = '在吗'; timeoutMs = 120000 } | ConvertTo-Json
(Invoke-RestMethod -Uri 'http://127.0.0.1:17801/ask' -Method Post -Body $b -ContentType 'application/json').reply
```

---

## 附：命令行也能直接说

不想走 HTTP 的时候：

```powershell
E:\nodejs\node.exe D:\大肥鱼工具\cheng-talk.mjs status
E:\nodejs\node.exe D:\大肥鱼工具\cheng-talk.mjs say "话"
E:\nodejs\node.exe D:\大肥鱼工具\cheng-talk.mjs read --limit 10
E:\nodejs\node.exe D:\大肥鱼工具\cheng-talk.mjs watch
```

---

底下用的是什么 RPC、参数形状、踩过的坑，在 `cheng-talk.md` 里。
这份只管"怎么用"。
