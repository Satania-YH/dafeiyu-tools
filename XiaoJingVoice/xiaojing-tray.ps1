# 小鲸嗓子 · 托盘版（Breeze TTS 2 / xiaojing_d3）
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ═══════════════════════════════════════════════════════════
#  配置读取
#  优先读脚本旁边的 config.ini；没有就用默认值。
#  这样本脚本可以放在任何目录，指向别处的引擎和模型。
# ═══════════════════════════════════════════════════════════
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }

# 默认值：脚本自己所在目录
$Root   = $ScriptDir
$BinDir = Join-Path $Root 'app\breeze-engine'
$Model  = Join-Path $Root 'models\breeze-tts-2-q4_k.gguf'
$Voices = Join-Path $Root 'voices'
$LogDir = Join-Path $Root 'logs'
$Ico    = Join-Path $ScriptDir 'xiaojing.ico'
$FFmpeg = 'E:\ComfyUI\tools\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe'
$SeedVC = 'E:\seed-vc'
$Port   = 8137
$Voice  = 'xiaojing_d3'
$MinFreeMiB = 2600

# 读 config.ini 覆盖（支持 %ScriptDir% 占位符）
$cfgPath = Join-Path $ScriptDir 'config.ini'
if (Test-Path $cfgPath) {
    $cfg = @{}
    foreach ($line in (Get-Content $cfgPath -Encoding UTF8)) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith(';') -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -lt 1) { continue }
        $k = $t.Substring(0, $i).Trim()
        $v = $t.Substring($i + 1).Trim().Trim('"')
        $v = $v.Replace('%ScriptDir%', $ScriptDir)
        $cfg[$k] = $v
    }
    if ($cfg['Root'])      { $Root   = $cfg['Root'] }
    if ($cfg['EngineDir']) { $BinDir = $cfg['EngineDir'] } else { $BinDir = Join-Path $Root 'app\breeze-engine' }
    if ($cfg['Model'])     { $Model  = $cfg['Model'] }     else { $Model  = Join-Path $Root 'models\breeze-tts-2-q4_k.gguf' }
    if ($cfg['Voices'])    { $Voices = $cfg['Voices'] }    else { $Voices = Join-Path $Root 'voices' }
    if ($cfg['LogDir'])    { $LogDir = $cfg['LogDir'] }    else { $LogDir = Join-Path $Root 'logs' }
    if ($cfg['Icon'])      { $Ico    = $cfg['Icon'] }      else { $Ico    = Join-Path $ScriptDir 'xiaojing.ico' }
    if ($cfg['FFmpeg'])    { $FFmpeg = $cfg['FFmpeg'] }
    if ($cfg['SeedVC'])    { $SeedVC = $cfg['SeedVC'] }
    if ($cfg['Port'])      { $Port   = [int]$cfg['Port'] }
    if ($cfg['Voice'])     { $Voice  = $cfg['Voice'] }
    if ($cfg['MinFreeMiB']){ $MinFreeMiB = [int]$cfg['MinFreeMiB'] }
}

$Server = Join-Path $BinDir 'breeze-server.exe'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$global:proc  = $null
$global:ready = $false
$global:fails = 0

# ── 单实例保护 ──
# 双重保险：命名 Mutex（跨进程可靠）+ 进程扫描（兜底）
$global:mutex = $null
try {
    $global:mutex = New-Object System.Threading.Mutex($false, 'Local\XiaoJingVoiceTray')
    if (-not $global:mutex.WaitOne(0)) {
        # 已经有一个在跑
        exit
    }
} catch {
    # Mutex 创建失败不阻塞启动，靠下面的进程扫描兜底
    $global:mutex = $null
}

# 兜底：扫一遍有没有同脚本的托盘进程（排除自己和查询命令）
$myPid = $PID
$scriptName = 'xiaojing-tray.ps1'
$others = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.ProcessId -ne $myPid -and
        $_.CommandLine -and
        $_.CommandLine -match ('-File\s+\S*' + [regex]::Escape($scriptName))
    })
if ($others.Count -gt 0) {
    # 已经有托盘在跑，退出（释放 mutex）
    try { $global:mutex.ReleaseMutex() } catch { }
    exit
}

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function global:Get-FreeVram {
    try {
        $v = & nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null
        if ($v) { return [int](@($v)[0].ToString().Trim()) }
    } catch {}
    return -1
}

function global:Test-Ready {
    try {
        $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 2
        return ($r.status -eq 'ok')
    } catch { return $false }
}

function global:Test-Port {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $a = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $a.AsyncWaitHandle.WaitOne(1200) -and $c.Connected
        $c.Close()
        return $ok
    } catch { return $false }
}

function global:Stop-All {
    if ($global:proc) { Stop-Process -Id $global:proc.Id -Force -ErrorAction SilentlyContinue }
    Get-Process breeze-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
    $global:proc = $null
    $global:ready = $false
}

function global:Start-Server {
    if (Test-Port) { return }
    $outLog = Join-Path $LogDir 'tray.out.log'
    $errLog = Join-Path $LogDir 'tray.err.log'
    $argList = @(
        ('"' + $Model + '"'),
        '--host', '127.0.0.1',
        '--port', [string]$Port,
        '--voices-dir', ('"' + $Voices + '"')
    )
    try {
        $global:proc = Start-Process -FilePath $Server -ArgumentList $argList -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    } catch {
        $global:proc = $null
    }
    $global:ready = $false
}


# ─── 清掉大小写重复的环境变量 ───────────────────────────────
# 本机进程环境里 no_proxy/NO_PROXY、https_proxy/HTTPS_PROXY、http_proxy/HTTP_PROXY
# 三对同时存在（DSH 注进来的）。PowerShell 5.1 建环境字典时会撞车，
# 凡是 Start-Process 带 -RedirectStandardOutput 就抛
# 「已添加项。字典中的关键字:"no_proxy"所添加的关键字:"NO_PROXY"」，
# 异常一被 catch 吞掉，服务就永远起不来、日志一片空白。起进程前先清一遍。
function Clear-DupEnv {
    try {
        $envs = [System.Environment]::GetEnvironmentVariables('Process')
        $seen = @{}
        foreach ($k in @($envs.Keys)) {
            $low = $k.ToLower()
            if ($seen.ContainsKey($low)) {
                if ($k -ceq $low) { [System.Environment]::SetEnvironmentVariable($k, $null, 'Process') }
                else { [System.Environment]::SetEnvironmentVariable($seen[$low], $null, 'Process'); $seen[$low] = $k }
            } else { $seen[$low] = $k }
        }
    } catch { }
}
Clear-DupEnv

# ---- 托盘图标 ----
# 图标默认会进 Windows 的隐藏区（任务栏 ^ 按钮里），这是正常的，不用管。
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Text = '小鲸嗓子'
if (Test-Path $Ico) {
    try { $icon.Icon = New-Object System.Drawing.Icon($Ico) }
    catch { $icon.Icon = [System.Drawing.SystemIcons]::Application }
} else {
    $icon.Icon = [System.Drawing.SystemIcons]::Application
}
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$st = $menu.Items.Add('状态：加载中…')
$st.Enabled = $false
$vr = $menu.Items.Add('显存：--')
$vr.Enabled = $false
# Breeze 是流式输出，WAV 头里 RIFF/data 长度写的是 0xFFFFFFFF 占位符，
# System.Media.SoundPlayer 会判定"不是有效的波形文件"而静音。这里改成真实长度。
function global:Fix-WavHeader {
    param([string]$Path)
    $fs = [System.IO.File]::Open($Path, 'Open', 'ReadWrite')
    try {
        $len = $fs.Length
        if ($len -lt 44) { return }
        $br = New-Object System.IO.BinaryWriter($fs)
        try {
            $br.Seek(4, 'Begin')  | Out-Null; $br.Write([uint32]($len - 8))
            $br.Seek(40, 'Begin') | Out-Null; $br.Write([uint32]($len - 44))
        } finally { $br.Dispose() }
    } finally { $fs.Close() }
}

# 合成一段，返回文件路径；失败返回 $null
function global:Synthesize-Segment {
    param([string]$Text, [string]$OutPath)
    $body = @{ input = $Text; voice = $Voice; response_format = 'wav' } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/v1/audio/speech') -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -OutFile $OutPath
        Fix-WavHeader $OutPath
        return $OutPath
    } catch {
        return $null
    }
}

# 单段转码成可播格式（用于逐段播放时）
function global:Convert-Segment {
    param([string]$InPath, [string]$OutPath)
    if (-not (Test-Path $FFmpeg)) { return $null }
    # loudnorm: EBU R128 响度归一化
    #   I=-16  目标响度（语音/播客常用）
    #   TP=-1.5 峰值上限，保证不削波
    # Breeze 原始输出峰值仅 -10.8dB，听起来偏小，这里补回来
    $args = @('-v', 'error', '-y', '-i', $InPath,
              '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
              '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', $OutPath)
    try {
        $p = Start-Process -FilePath $FFmpeg -ArgumentList $args -Wait -PassThru -NoNewWindow `
            -RedirectStandardError ((Join-Path (Split-Path $InPath -Parent) 'ff2.err.log'))
        if ($p.ExitCode -ne 0) { return $null }
        if (-not (Test-Path $OutPath)) { return $null }
        return $OutPath
    } catch { return $null }
}

# 合成 + 分段 + 边合成边播放
function global:Speak-Text {
    # 整段合成 → ffmpeg 转 44.1k 立体声 → 播放
    # 注：曾试过按句切分再拼接，实测各长度都更慢且音频更长（每段独立开销累积），已回退。
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $true }
    if (-not (Test-Ready)) {
        [System.Windows.Forms.MessageBox]::Show('服务还没就绪，等托盘状态变成「就绪」再试。', '小鲸嗓子')
        return $false
    }

    $tmpDir = Join-Path $Root 'tmp_seg'
    if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    $sw = [Diagnostics.Stopwatch]::StartNew()

    # 1) 整段合成
    $raw = Join-Path $tmpDir 'raw.wav'
    if (-not (Synthesize-Segment -Text $Text -OutPath $raw)) {
        [System.Windows.Forms.MessageBox]::Show('合成失败，服务可能出问题了。', '小鲸嗓子')
        Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        return $false
    }
    $genMs = $sw.ElapsedMilliseconds

    # 2) 转 44.1k 立体声（Alma 的 <audio crossOrigin> 播不了 24k 单声道）
    $play = Join-Path $tmpDir 'play.wav'
    $converted = Convert-Segment -InPath $raw -OutPath $play
    if (-not $converted) { $play = $raw }   # 转码失败退回原文件

    # 3) 播
    try {
        $sp = New-Object System.Media.SoundPlayer $play
        $sp.PlaySync()
    } catch {
        [System.Windows.Forms.MessageBox]::Show(('播放失败：' + $_.Exception.Message), '小鲸嗓子')
    }

    # 4) 存成 last.wav
    try {
        Copy-Item $play (Join-Path $Root 'last.wav') -Force
        $global:lastInfo = '单段 | 合成 ' + [int]$genMs + 'ms | 全部 ' + [int]$sw.Elapsed.TotalSeconds + ' 秒'
    } catch {
        $global:lastInfo = '单段 | 保存失败'
    }

    $sw.Stop()
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    return $true
}

$menu.Items.Add('-') | Out-Null

$miSay = $menu.Items.Add('说一句话…')
$miSay.Add_Click({
    $txt = [Microsoft.VisualBasic.Interaction]::InputBox('要用小鲸的声音说什么？', '小鲸嗓子', '')
    if ([string]::IsNullOrWhiteSpace($txt)) { return }
    Speak-Text $txt | Out-Null
    if ($global:lastInfo) { $st.Text = '状态：就绪 · ' + $global:lastInfo }
})

$miTest = $menu.Items.Add('试听一句')
$miTest.Add_Click({
    Speak-Text '主人，欢迎回来。我是小鲸，今天也会好好照顾你的。' | Out-Null
    if ($global:lastInfo) { $st.Text = '状态：就绪 · ' + $global:lastInfo }
})

# ---- 唱一首歌 ----
$miSing = $menu.Items.Add('唱一首歌…')
$miSing.Add_Click({
    # 让用户选歌曲文件
    $ofd = New-Object System.Windows.Forms.OpenFileDialog
    $ofd.Title = '选一首歌给小鲸唱'
    $ofd.Filter = '音频文件|*.wav;*.mp3;*.flac;*.m4a;*.ogg;*.aac|所有文件|*.*'
    if ($ofd.ShowDialog() -ne 'OK') { return }
    $src = $ofd.FileName

    if (-not (Test-Path $SeedVC)) {
        [System.Windows.Forms.MessageBox]::Show("找不到唱歌引擎：`n$SeedVC`n`n需要 E:\seed-vc 目录。", '小鲸嗓子')
        return
    }

    $outDir = Join-Path $Root 'songs'
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory $outDir -Force | Out-Null }
    $songName = [System.IO.Path]::GetFileNameWithoutExtension($src)
    $outSub = Join-Path $outDir $songName
    if (Test-Path $outSub) { Remove-Item $outSub -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory $outSub -Force | Out-Null

    $icon.Text = '小鲸嗓子：唱歌中…'
    $st.Text = '状态：唱歌中（' + $songName + '）'

    $py = Join-Path $SeedVC '.venv\Scripts\python.exe'
    $ref = Join-Path $Voices 'refs\d3_long.wav'
    $logFile = Join-Path $LogDir 'sing.log'

    $args = @(
        'inference.py',
        '--source', ('"' + $src + '"'),
        '--target', ('"' + $ref + '"'),
        '--output', ('"' + $outSub + '"'),
        '--diffusion-steps', '30',
        '--f0-condition', 'True',
        '--fp16', 'True'
    )

    $global:singProc = Start-Process -FilePath $py -ArgumentList $args -WindowStyle Hidden -PassThru `
        -WorkingDirectory $SeedVC -RedirectStandardOutput $logFile -RedirectStandardError (Join-Path $LogDir 'sing.err.log')

    # 用计时器轮询，不阻塞界面
    $global:singTimer = New-Object System.Windows.Forms.Timer
    $global:singTimer.Interval = 2000
    $global:singTimer.Add_Tick({
        if ($global:singProc -and -not $global:singProc.HasExited) { return }
        $global:singTimer.Stop()
        $icon.Text = '小鲸嗓子：就绪（' + $Voice + '）'

        # 找输出文件
        $found = $null
        if ($global:singOutDir -and (Test-Path $global:singOutDir)) {
            $found = Get-ChildItem $global:singOutDir -Filter '*.wav' -Recurse -ErrorAction SilentlyContinue |
                     Sort-Object LastWriteTime -Descending | Select-Object -First 1
        }
        if ($found) {
            $st.Text = '状态：就绪 · 唱完了：' + $found.Name
            # 自动播放
            try { (New-Object System.Media.SoundPlayer $found.FullName).PlaySync() } catch { }
            Start-Process explorer.exe $global:singOutDir
        } else {
            $st.Text = '状态：就绪 · 唱歌失败，看日志'
            [System.Windows.Forms.MessageBox]::Show("转换失败，看看日志：`n" + (Join-Path $LogDir 'sing.err.log'), '小鲸嗓子')
        }
    })
    $global:singOutDir = $outSub
    $global:singTimer.Start()
})

$menu.Items.Add('-') | Out-Null
$miDir = $menu.Items.Add('打开目录')
$miDir.Add_Click({ Start-Process explorer.exe $Root })
$miLog = $menu.Items.Add('看日志')
$miLog.Add_Click({ Start-Process notepad.exe (Join-Path $LogDir 'tray.out.log') })
$menu.Items.Add('-') | Out-Null
$miRe = $menu.Items.Add('重启服务')
$miRe.Add_Click({
    $icon.Text = '小鲸嗓子：重启中…'
    Stop-All
    Start-Sleep -Milliseconds 800
    Start-Server
})
$miStop = $menu.Items.Add('停止服务（释放显存）')
$miStop.Add_Click({
    Stop-All
    $icon.Text = '小鲸嗓子：已停止'
    $st.Text = '状态：已停止（手动）'
})
$miExit = $menu.Items.Add('退出')
$miExit.Add_Click({
    Stop-All
    $icon.Visible = $false
    $icon.Dispose()
    $timer.Stop()
    # 释放单实例锁（进程退出也会自动释放，这里显式一点更保险）
    try { if ($global:lockStream) { $global:lockStream.Close() } } catch { }
    [System.Windows.Forms.Application]::Exit()
})
$icon.ContextMenuStrip = $menu
$icon.Add_DoubleClick({ if ($miTest.Enabled) { $miTest.PerformClick() } })

Start-Server

# ---- 状态轮询 ----
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    $ok = Test-Ready
    $free = Get-FreeVram
    if ($free -ge 0) {
        $vr.Text = ('显存：空闲 ' + $free + ' MiB')
    }
    if ($ok) {
        $global:fails = 0
        if (-not $global:ready) {
            $global:ready = $true
            $icon.Text = '小鲸嗓子：就绪（' + $Voice + '）'
            $st.Text = '状态：就绪 · ' + $Voice
        }
    } else {
        $global:ready = $false
        $global:fails++
        $icon.Text = '小鲸嗓子：加载中…'
        $st.Text = '状态：加载中…'
        # 连续 3 次（约 9 秒）连不上才自动重启，避免抖动
        if ($global:fails -ge 3) {
            $global:fails = 0
            if (-not $global:proc -or $global:proc.HasExited) { Start-Server }
        }
    }
})
$timer.Start()

if (-not ('Microsoft.VisualBasic.Interaction' -as [type])) {
    Add-Type -AssemblyName Microsoft.VisualBasic
}

[System.Windows.Forms.Application]::Run()