# 小鲸嗓子

本地 TTS + 歌声转换。给小鲸（8 岁女孩，清亮甜美）一副声音，能说话，也能唱歌。

**两种用法：**
- **给人用** → 双击 `小鲸嗓子.bat`，出托盘图标，右键点菜单
- **给 AI 用** → `xiaojing.cmd say/sing`，纯命令行，返回 JSON

---

## 一、给人用：托盘

### 启动

双击 **`小鲸嗓子.bat`** → 任务栏出现小鲸鱼图标。

**图标在隐藏区里** —— 点任务栏右下角的 **`^`** 箭头才能看到。
这是 Windows 11 的默认行为（新图标都先放隐藏区），不是 bug。

第一次启动要等 **30-40 秒**（加载模型），图标提示从「加载中」变成「就绪」。

> ⚠️ 如果同时跑着别的 powershell 托盘程序（比如大肥鱼），
> 两个图标的**位置会联动** —— Windows 按可执行文件记录位置，
> 它们都是 `powershell.exe`，所以共用一份设置。这是系统限制，无解。

### 右键菜单

| 菜单项 | 作用 |
|---|---|
| **状态：就绪 / 加载中** | 灰字，只显示 |
| **显存：空闲 xxx MiB** | 灰字，实时 |
| **说一句话…** | 弹输入框，打字，她念出来 |
| **试听一句** | 播放固定测试句 |
| **唱一首歌…** | 选音频文件，换成她的声音唱 |
| 打开目录 | 打开程序目录 |
| 看日志 | 打开运行日志 |
| **重启服务** | 卡住时点这个 |
| **停止服务（释放显存）** | 停服务，释放约 3G 显存 |
| **退出** | 停服务 + 关托盘 |

**双击图标** = 试听一句

---

## 二、给 AI 用：CLI

### 基本形式

```cmd
xiaojing.cmd <命令> [参数]
```

`xiaojing.cmd` 是包装器，直接调用不用打 `powershell -File`。

**`say` 走 Node 快路**：`xiaojing.cmd say` 会先看 `xiaojing.mjs`（Node 版），直接 POST 8137 合成，省掉每次拉起 PowerShell 的 ~1.6 秒。实测一句话 3.5 秒 → **2.0 秒**。
- Node 不在、或服务没起时，自动退回 `xiaojing-cli.ps1`（托盘拉起、清重复环境变量这些还得它干）。
- `sing` / `status` / `start` / `stop` 没动，还是走 ps1。

### 命令

#### `say` — 文字转语音

```cmd
xiaojing.cmd say "要说的文字" [-Out 路径] [-NoPlay] [-Json]
```

| 参数 | 说明 |
|---|---|
| `-Out <路径>` | 输出文件路径。默认 `%TEMP%\xj_<随机>.wav` |
| `-NoPlay` | **不播放，只生成文件**。AI 调用必须加，否则阻塞到播完 |
| `-Json` | 输出 JSON 而非纯路径 |

**输出（-Json）：**
```json
{"ok":true,"path":"C:\\...\\xj_abc.wav","bytes":46124,"duration":0.26,"voice":"xiaojing_d3","elapsed":3}
```

**输出（不加 -Json）：** 纯文件路径一行

#### `sing` — 唱歌

```cmd
xiaojing.cmd sing "D:\我的歌.mp3" [-Out 目录] [-SemiTone -2] [-Json]
```

| 参数 | 说明 |
|---|---|
| `-Out <目录>` | 输出目录。默认 `<脚本目录>\songs` |
| `-SemiTone <n>` | 降调半音数。负数=降，唱不上去时用（-2 或 -4） |
| `-Json` | 输出 JSON |

**输出（-Json）：**
```json
{"ok":true,"path":"E:\\BreezeTTS\\songs\\source-solo\\vc_...wav","bytes":3526736,"voice":"xiaojing_d3","semitone":0,"elapsed":65}
```

⚠️ `-Out` 是**目录**不是文件（Seed-VC 只接受目录）。真实文件路径从返回的 `path` 取。

#### `status` — 查状态

```cmd
xiaojing.cmd status [-Json]
```

```json
{"ok":true,"running":true,"ready":true,"pid":46140,"port":8137,"voice":"xiaojing_d3","freeVram":3839}
```

**退出码：** 就绪 = 0，未就绪 = 1

#### `start` / `stop`

```cmd
xiaojing.cmd start    # 启动服务，就绪后输出 ready
xiaojing.cmd stop     # 停止服务，释放显存，输出 stopped
```

### 调用约定

| 项 | 规则 |
|---|---|
| **stdout** | 只有结果（路径 / JSON），可直接解析 |
| **stderr** | 所有日志、进度、错误 |
| **退出码** | 0=成功，1=失败，2=参数错误 |
| **自动启动** | `say` / `sing` / `start` 会自动拉起服务**和托盘**（首次 30-40 秒） |
| **托盘图标** | CLI 启动时托盘图标会自动出现，不用另外双击 |
| **并发** | 服务同时只处理 1 个请求，第二个会返回 `busy` |

### AI 调用示例

```powershell
# 生成语音，拿路径，自己决定怎么用
$r = xiaojing.cmd say "主人，欢迎回来。" -NoPlay -Json | ConvertFrom-Json
if ($r.ok) { Write-Host "音频在 $($r.path)" }

# 唱歌
$r = xiaojing.cmd sing "D:\歌.mp3" -Json | ConvertFrom-Json
Copy-Item $r.path "D:\输出\翻唱.wav"
```

---

## 三、配置文件

`config.ini` — 改完重启托盘 / 重新调用 CLI 生效。

```ini
; 引擎和模型的根目录
Root = E:\BreezeTTS

; 音色用哪份（%ScriptDir% = 本脚本所在目录）
Voices = %ScriptDir%\voices

; 默认音色
Voice = xiaojing_d3

; ffmpeg（转码 + 音量归一化，必需）
FFmpeg = E:\ComfyUI\tools\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe

; Seed-VC 唱歌引擎
SeedVC = E:\seed-vc

; 服务端口
Port = 8137

; 启动前要求的最小空闲显存（MiB）
MinFreeMiB = 2600
```

**所有可配置项：**

| 键 | 默认 | 说明 |
|---|---|---|
| `Root` | 脚本所在目录 | 引擎/模型的基准路径 |
| `EngineDir` | `Root\app\breeze-engine` | 单独指定引擎目录 |
| `Model` | `Root\models\breeze-tts-2-q4_k.gguf` | 单独指定模型文件 |
| `Voices` | `Root\voices` | 音色目录 |
| `LogDir` | `脚本目录\logs` | 日志目录（**跟脚本走，不跟 Root**） |
| `Icon` | `脚本目录\xiaojing.ico` | 托盘图标 |
| `FFmpeg` | 内置默认 | ffmpeg 路径 |
| `SeedVC` | `E:\seed-vc` | 唱歌引擎路径 |
| `Port` | `8137` | 服务端口 |
| `Voice` | `xiaojing_d3` | 默认音色 |
| `MinFreeMiB` | `2600` | 最小空闲显存 |

**`%ScriptDir%`** 占位符 = 脚本所在目录。

---

## 四、文件结构

```
小鲸嗓子-外壳\              1.6M（不含引擎和模型）
├── 小鲸嗓子.bat            托盘启动入口
├── xiaojing.cmd            CLI 包装器（给 AI 用）
├── xiaojing-cli.ps1        CLI 实现
├── xiaojing-tray.ps1       托盘实现（图标进隐藏区，正常）
├── config.ini              配置
├── xiaojing.ico            图标
├── README.md               本文件
├── 唱歌说明.txt             唱歌的详细说明
├── voices\
│   ├── xiaojing_d3.breeze  ⭐ 当前音色
│   ├── xiaojing_d1.breeze     备选：6 岁更奶
│   ├── xiaojing2.breeze       备选：早期
│   ├── xiaojing.breeze        备选：最早
│   └── refs\
│       ├── d3_long.wav        唱歌用的参考音频（27.9 秒）
│       └── d3_reftranscript.txt
├── songs\                  唱歌输出
├── logs\                   运行日志
└── (tray.lock)             旧版单实例锁文件，新版改用 Mutex，此文件已不再生成
```

### 外部依赖

| 用途 | 路径 | 必需 |
|---|---|---|
| TTS 引擎 + 模型 | `E:\BreezeTTS\` | ✅ |
| ffmpeg | `E:\ComfyUI\tools\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe` | ✅ |
| 唱歌引擎 | `E:\seed-vc\` | 只有唱歌要 |

---

## 五、性能参考（实测）

### 说话

| 文字长度 | 合成耗时 | 音频时长 |
|---|---|---|
| 16 字 | 1.7 秒 | 3.5 秒 |
| 39 字 | 4.2 秒 | 9.4 秒 |
| 112 字 | 11 秒 | 25.8 秒 |

短句效率最高。40 字以上会越来越"拖"，建议分多次。

### 唱歌

| 歌曲长度 | 转换耗时 |
|---|---|
| 20 秒 | 45-65 秒 |
| 1 分钟 | 2-3 分钟 |
| 3 分钟 | 6-9 分钟 |

### 实测验证记录（2026-11-22）

| 场景 | 结果 |
|---|---|
| 全停 | 服务 0，显存 6117 MiB 空闲 |
| `xiaojing.cmd say` | 自动拉起服务和托盘，3 秒出音频 |
| `xiaojing.cmd status` | JSON 正常，退出码 0/1 正确 |
| 双击 `小鲸嗓子.bat` | 托盘出现，服务就绪 |
| 启动第 2 个托盘 | 被单实例保护拦住，无重复进程 |
| 唱歌（20 秒素材） | 45-65 秒完成，输出 3.36 MB |

### 资源占用

- **显存**：约 3 GB（服务常驻）
- **启动时间**：30-40 秒（加载模型）
- **CPU**：低（GPU 满载跑，1785MHz / 90%+）

---

## 六、常见问题

**Q: 看不到托盘图标？**
图标在**隐藏区**里 —— 点任务栏右下角的 `^` 箭头。这是 Windows 11 默认行为。

**Q: 托盘图标和大肥鱼联动？**
两个都是 `powershell.exe` 启动的，Windows 按可执行文件记录图标位置，所以共用一份设置。系统限制，无法分开。

**Q: 双击没反应？**
已经有托盘在跑了，被单实例保护拦住。这是正常的 —— 防止开出多个图标抢显存。
要重开：任务管理器找带 `xiaojing-tray.ps1` 的 `powershell.exe`，结束掉再双击。

**Q: 一直「加载中」？**
看 `logs\tray.out.log`。卡在 `warming up` 多半是显存不够，关掉 ComfyUI。

**Q: 说话没声音？**
1. 确认状态是「就绪」
2. 看输出文件有没有更新
3. 检查系统音量和默认播放设备

**Q: AI 调用超时？**
`say` 忘了加 `-NoPlay`，会阻塞到播放完毕。AI 一律加 `-NoPlay`。

**Q: 唱歌效果差？**
素材问题。要用单人干声，不要合唱/重混响/低码率。详见 `唱歌说明.txt`。

**Q: 唱高音破音？**
她的嗓子是说话录的，音域窄。加 `-SemiTone -2` 降调。

**Q: 想省显存跑 ComfyUI？**
`xiaojing.cmd stop` 或托盘右键停止服务，释放约 2.8G。

**Q: 换音色？**
改 `config.ini` 的 `Voice = xiaojing_d1`，重启。

**Q: 换资源位置？**
改 `config.ini` 的 `Root` 或对应的 `EngineDir` / `Model` / `Voices`。

**Q: 唱歌没反应，日志里啥都没有？**
以前会出现"脚本悄悄退出、python 在后台空转、谁也看不到结果"。现在不会了 —— 如果是日志目录写不进去，会直接告诉你：

```
日志目录不可用: Z:\nope\logs
原因: 找不到驱动器。名为"Z"的驱动器不存在。
改 config.ini 里的 LogDir，或者删掉那一行让它跟着脚本走
```

**Q: 日志到底在哪个文件夹？**
在**脚本旁边**的 `logs\`，不在引擎目录。即使 `config.ini` 的 `Root` 指向别处（比如 `E:\BreezeTTS`），日志也留在你自己这份文件夹里。
只有显式写 `LogDir = ...` 才会改。

**Q: 唱歌时显存不够？**
`sing` 现在会**自动先停掉说话服务**再跑。你会在 stderr 看到 `[sing] 说话服务在占用显存，先停掉`。
如果想说话和唱歌都留着，就得接受 8G 卡同时跑会 OOM。

**Q: `-Out` 报 "parameter name 'Out' is ambiguous"？**
旧版会。现在 `-Out` / `-o` 是正式参数，直接写就行：

```cmd
xiaojing.cmd sing "D:\歌.mp3" -Out "D:\输出目录" -Json
```

原来的 `-Action sing -Rest @(...)` 写法也还兼容。

---

## 七、技术说明

### 为什么音频要转码

Breeze 输出 24kHz 单声道，且 WAV 头里的长度字段是 `0xFFFFFFFF` 占位符（流式输出的特点）。Alma 的 `<audio crossOrigin="anonymous">` 播不了。所以每次合成后：

1. `Fix-WavHeader` 修 RIFF/data 长度字段
2. ffmpeg 转 44.1kHz 立体声
3. `loudnorm` 响度归一到 -16 LUFS（原始输出峰值只有 -10.8dB，偏小）

### 单实例保护怎么做的

**双保险**，防止开出多个托盘抢显存：

```powershell
# 1) 命名 Mutex（跨进程可靠）
$mutex = New-Object System.Threading.Mutex($false, 'Local\XiaoJingVoiceTray')
if (-not $mutex.WaitOne(0)) { exit }

# 2) 兜底：扫进程（Mutex 创建失败时用）
$others = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '-File\s+\S*xiaojing-tray\.ps1' }
if ($others.Count -gt 0) { exit }
```

用 `Local\` 而不是 `Global\` —— `Global:` 在非管理员进程里创建会失败，等于没锁。

**为什么不用文件锁**：试过 `FileShare.None`，但在某些 Windows 环境下不生效（第二个进程照样能打开）。Mutex 更可靠。

### 为什么用 Vulkan 不用 CUDA

官方实测 **CUDA 反而慢 12%**。因为 backbone 每层新建计算图，CUDA 的 graph 优化用不上。

### 为什么没有流式播放

WebSocket 接口实测首字 478ms（比整段合成快 22 倍），但 PowerShell 的 `SoundPlayer` 只能播完整文件。要做得装 NAudio，工作量大，暂未实现。

### 唱歌为什么曾经"卡死"（已修）

2026-11-22 排查过一例：`sing` 跑三分钟不出 wav，日志一片空白。

**实测结论：引擎没问题。** 同一个 30 秒素材，三种方式各跑一次：

| 方式 | 耗时 | 输出 |
|---|---|---|
| 直调 `python -u inference.py` | 63 秒 | 5,290,064 字节 |
| 照抄 `Start-Process -Redirect*` | 59 秒 | 同上 |
| `xiaojing-cli.ps1 sing` | 61 秒 | 同上 |

`RTF ≈ 1.26`，稳定。

**真正的坑有三个：**

1. **LogDir 跟着 Root 跑** —— `Root` 被配成 `E:\BreezeTTS` 时，日志也跑去了 E 盘，在脚本文件夹里永远找不到。现在改成跟脚本走。

2. **日志目录建不出来时静默退出** —— 配置加载阶段那句 `New-Item -Path $LogDir` 没包 try/catch，报错直接终止，而 python 已经被 `Start-Process` 拉起来了。父进程一死，子进程还在空转，谁也收不到结果。现在会明确报错并返回退出码 1。

3. **唱歌和说话抢显存** —— Seed-VC 要 4.8–5.5G，breeze-server 常驻占 2.8G，8G 卡同时跑必然不够。现在 `sing` 开始前自动停服务。

顺带修了 `-Out` 被 PowerShell 当成 `-OutVariable` 前缀而报 ambiguous 的问题。

**排除掉的怀疑**（都不成立，别再往这几个方向查）：

- 缓存路径不一致：`inference.py:3` 用 `hf_cache`、`hf_utils.py:7` 用 `checkpoints`，确实不一致，但两边模型都齐（whisper 923M / bigvgan 467M），日志确认加载成功
- 卡在联网：代理 `127.0.0.1:7897` 和直连 huggingface 都返回 200；`HF_ENDPOINT` 本来就未设置
- 输出被缓冲吞掉：`python -u` 和 `-RedirectStandard*` 都能正常写日志

### 音色是怎么来的

1. design 模式生成 28 秒长样本（8 岁女孩，清亮甜美）
2. `--save-voice` 把样本编码成 `.breeze` 音色文件
3. 以后所有合成都用 `--voice xiaojing_d3`

**关键：参考音频必须 ≥25 秒。** 5 秒只够抓音高，抓不到"童声"那种发声特质。

---

## 八、卸载

1. 托盘右键 → 退出
2. 删掉本文件夹
3. 如果不再需要：删掉 `E:\BreezeTTS\`（2.6G）、`E:\seed-vc\`（1G）

不写注册表、不装服务、不留系统残留。
