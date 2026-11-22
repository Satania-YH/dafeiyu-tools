# ═══════════════════════════════════════════════════════════════
#  小鲸嗓子 CLI  —  给 AI / 脚本调用的命令行接口
#
#  设计原则：
#    · 不弹窗、不暂停、不阻塞
#    · stdout 只输出结果（文件路径 / JSON），日志走 stderr
#    · 退出码 0=成功，非0=失败
#    · 服务没起会自动拉起
#
#  用法：
#    xiaojing-cli.ps1 say "文字" [-Out 路径] [-NoPlay] [-Json]
#    xiaojing-cli.ps1 sing "歌.mp3" [-Out 目录] [-SemiTone -2] [-Json]
#    xiaojing-cli.ps1 status [-Json]
#    xiaojing-cli.ps1 start | stop
# ═══════════════════════════════════════════════════════════════
param(
    [Parameter(Position = 0)][string]$Action = 'status',
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'

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

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# ─── 解析选项 ───────────────────────────────────────────────
$optOut     = $null
$optNoPlay  = $false
$optJson    = $false
$optSemi    = 0
$positional = @()

for ($i = 0; $i -lt $Rest.Count; $i++) {
    $a = $Rest[$i]
    switch -Regex ($a) {
        '^-{1,2}Out$'       { $i++; $optOut = $Rest[$i]; continue }
        '^-{1,2}NoPlay$'    { $optNoPlay = $true; continue }
        '^-{1,2}Json$'      { $optJson = $true; continue }
        '^-{1,2}SemiTone$'  { $i++; $optSemi = [int]$Rest[$i]; continue }
        default             { $positional += $a }
    }
}
$TextArg = ($positional -join ' ')

# ─── 配置 ───────────────────────────────────────────────────
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }

$Root   = $ScriptDir
$BinDir = Join-Path $Root 'app\breeze-engine'
$Model  = Join-Path $Root 'models\breeze-tts-2-q4_k.gguf'
$Voices = Join-Path $Root 'voices'
$LogDir = Join-Path $Root 'logs'
$FFmpeg = 'E:\ComfyUI\tools\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe'
$SeedVC = 'E:\seed-vc'
$Port   = 8137
$Voice  = 'xiaojing_d3'
$MinFreeMiB = 2600

$cfgPath = Join-Path $ScriptDir 'config.ini'
if (Test-Path $cfgPath) {
    $cfg = @{}
    foreach ($line in (Get-Content $cfgPath -Encoding UTF8)) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith(';') -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -lt 1) { continue }
        $k = $t.Substring(0, $i).Trim()
        $v = $t.Substring($i + 1).Trim().Trim('"').Replace('%ScriptDir%', $ScriptDir)
        $cfg[$k] = $v
    }
    if ($cfg['Root'])      { $Root   = $cfg['Root'] }
    if ($cfg['EngineDir']) { $BinDir = $cfg['EngineDir'] } else { $BinDir = Join-Path $Root 'app\breeze-engine' }
    if ($cfg['Model'])     { $Model  = $cfg['Model'] }     else { $Model  = Join-Path $Root 'models\breeze-tts-2-q4_k.gguf' }
    if ($cfg['Voices'])    { $Voices = $cfg['Voices'] }    else { $Voices = Join-Path $Root 'voices' }
    if ($cfg['LogDir'])    { $LogDir = $cfg['LogDir'] }    else { $LogDir = Join-Path $Root 'logs' }
    if ($cfg['FFmpeg'])    { $FFmpeg = $cfg['FFmpeg'] }
    if ($cfg['SeedVC'])    { $SeedVC = $cfg['SeedVC'] }
    if ($cfg['Port'])      { $Port   = [int]$cfg['Port'] }
    if ($cfg['Voice'])     { $Voice  = $cfg['Voice'] }
    if ($cfg['MinFreeMiB']){ $MinFreeMiB = [int]$cfg['MinFreeMiB'] }
}
$Server = Join-Path $BinDir 'breeze-server.exe'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# ─── 工具函数 ───────────────────────────────────────────────
function Write-Log([string]$m) {
    # 日志走 stderr，不污染 stdout
    [Console]::Error.WriteLine($m)
}

function Get-ServerPid {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($c) { return (@($c)[0].OwningProcess) }
    $p = Get-Process breeze-server -ErrorAction SilentlyContinue
    if ($p) { return (@($p)[0].Id) }
    return $null
}

function Test-Ready {
    try {
        $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 2
        return ($r.status -eq 'ok')
    } catch { return $false }
}

function Fix-WavHeader([string]$Path) {
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

function Convert-Audio([string]$In, [string]$Out) {
    if (-not (Test-Path $FFmpeg)) { return $null }
    $a = @('-v','error','-y','-i',$In,
           '-af','loudnorm=I=-16:TP=-1.5:LRA=11',
           '-ar','44100','-ac','2','-c:a','pcm_s16le',$Out)
    try {
        $p = Start-Process -FilePath $FFmpeg -ArgumentList $a -Wait -PassThru -NoNewWindow `
             -RedirectStandardError (Join-Path $LogDir 'ff.err.log')
        if ($p.ExitCode -ne 0 -or -not (Test-Path $Out)) { return $null }
        return $Out
    } catch { return $null }
}

function Test-TrayRunning {
    try {
        $t = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandLine -like '*-File*xiaojing-tray.ps1*' })
        return ($t.Count -gt 0)
    } catch { return $false }
}

function Start-TrayIfNeeded {
    # CLI 拉起服务时，顺便把托盘也带起来，这样用户能在 ^ 里看到图标
    if (Test-TrayRunning) { return }
    $tray = Join-Path $ScriptDir 'xiaojing-tray.ps1'
    if (-not (Test-Path $tray)) { return }
    try {
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File', $tray) `
            -WindowStyle Hidden | Out-Null
        Write-Log '[tray] 已启动托盘'
    } catch {
        Write-Log ('[tray] 启动失败: ' + $_.Exception.Message)
    }
}

function Start-ServerIfNeeded {
    # 已经就绪：确保托盘在（不重复启动服务）
    if (Test-Ready) {
        Start-TrayIfNeeded
        return $true
    }

    # 有服务进程但没就绪：等它
    if (Get-ServerPid) {
        for ($i = 0; $i -lt 120; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-Ready) { Start-TrayIfNeeded; return $true }
        }
        return $false
    }

    # 都没起：优先让托盘去拉服务（这样图标一定会有），CLI 只等结果。
    # 只有托盘脚本不存在时，才自己直接启动服务。
    $tray = Join-Path $ScriptDir 'xiaojing-tray.ps1'
    if (Test-Path $tray) {
        Start-TrayIfNeeded
        Write-Log '[start] 等待托盘拉起服务...'
        for ($i = 0; $i -lt 240; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-Ready) { Write-Log '[start] 就绪'; return $true }
        }
        Write-Log '[start] 托盘未在 120 秒内就绪'
        return $false
    }

    # 兜底：没有托盘脚本，直接起服务（无图标）
    Write-Log '[start] 启动服务（无托盘）...'
    $a = @(('"' + $Model + '"'), '--host','127.0.0.1','--port',[string]$Port,'--voices-dir',('"' + $Voices + '"'))
    Start-Process -FilePath $Server -ArgumentList $a -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogDir 'cli.out.log') `
        -RedirectStandardError  (Join-Path $LogDir 'cli.err.log') | Out-Null
    for ($i = 0; $i -lt 180; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Ready) { Write-Log '[start] 就绪'; return $true }
    }
    Write-Log '[start] 超时未就绪'
    return $false
}

function Emit([hashtable]$obj) {
    if ($optJson) {
        Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
    } else {
        Write-Output $obj.path
    }
}

# ─── 命令：say ──────────────────────────────────────────────
function Cmd-Say {
    if ([string]::IsNullOrWhiteSpace($TextArg)) {
        Write-Log '用法: xiaojing-cli.ps1 say "文字" [-Out 路径] [-NoPlay] [-Json]'
        exit 2
    }
    if (-not (Start-ServerIfNeeded)) { Write-Log '服务启动失败'; exit 1 }

    $raw = Join-Path $env:TEMP ('xj_' + [Guid]::NewGuid().ToString('N') + '.wav')
    $body = @{ input = $TextArg; voice = $Voice; response_format = 'wav' } | ConvertTo-Json -Compress
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/v1/audio/speech') -Method Post `
            -ContentType 'application/json; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($body)) -OutFile $raw | Out-Null
    } catch {
        Write-Log ('合成失败: ' + $_.Exception.Message)
        exit 1
    }
    Fix-WavHeader $raw

    # 转 44.1k 立体声 + 音量归一化
    $final = $raw
    if ($optOut) {
        $final = $optOut
        $dir = Split-Path $final -Parent
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory $dir -Force | Out-Null }
    }
    $conv = Convert-Audio $raw $final
    if ($conv) {
        if ($final -ne $raw) { Remove-Item $raw -Force -ErrorAction SilentlyContinue }
        $final = $conv
    } else {
        # 转码失败就用原始 24k
        if ($final -ne $raw) { Move-Item $raw $final -Force }
    }
    $sw.Stop()

    $size = (Get-Item $final).Length
    if (-not $optNoPlay) {
        try { (New-Object System.Media.SoundPlayer $final).PlaySync() } catch { Write-Log '播放失败（文件已生成）' }
    }

    Emit @{
        ok       = $true
        path     = $final
        bytes    = $size
        duration = [math]::Round($size / 176400, 2)
        voice    = $Voice
        elapsed  = [int]$sw.Elapsed.TotalSeconds
    }
    exit 0
}

# ─── 命令：sing ─────────────────────────────────────────────
function Cmd-Sing {
    $song = $TextArg
    if ([string]::IsNullOrWhiteSpace($song)) {
        Write-Log '用法: xiaojing-cli.ps1 sing "D:\歌.mp3" [-Out 目录] [-SemiTone -2] [-Json]'
        exit 2
    }
    $song = $song.Trim('"', "'", ' ')
    if (-not (Test-Path $song)) { Write-Log ('找不到文件: ' + $song); exit 1 }
    if (-not (Test-Path $SeedVC)) { Write-Log ('找不到唱歌引擎: ' + $SeedVC); exit 1 }

    $py  = Join-Path $SeedVC '.venv\Scripts\python.exe'
    $ref = Join-Path $Voices 'refs\d3_long.wav'
    if (-not (Test-Path $py))  { Write-Log ('找不到 python: ' + $py); exit 1 }
    if (-not (Test-Path $ref)) { Write-Log ('找不到音色参考: ' + $ref); exit 1 }

    $outDir = if ($optOut) { $optOut } else { Join-Path $Root 'songs' }
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory $outDir -Force | Out-Null }
    $songName = [System.IO.Path]::GetFileNameWithoutExtension($song)
    $outSub = Join-Path $outDir $songName
    if (Test-Path $outSub) { Remove-Item $outSub -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory $outSub -Force | Out-Null

    Write-Log ('[sing] ' + (Split-Path $song -Leaf) + ' -> ' + $outSub)

    $a = @('inference.py',
           '--source', ('"' + $song + '"'),
           '--target', ('"' + $ref + '"'),
           '--output', ('"' + $outSub + '"'),
           '--diffusion-steps','30','--f0-condition','True','--fp16','True')
    if ($optSemi -ne 0) { $a += @('--semi-tone-shift', [string]$optSemi) }

    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $py -ArgumentList $a -WindowStyle Hidden -PassThru -WorkingDirectory $SeedVC `
         -RedirectStandardOutput (Join-Path $LogDir 'sing.out.log') `
         -RedirectStandardError  (Join-Path $LogDir 'sing.err.log')
    $p.WaitForExit()
    $sw.Stop()

    $found = Get-ChildItem $outSub -Filter '*.wav' -Recurse -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $found) {
        Write-Log '转换失败，看日志: ' + (Join-Path $LogDir 'sing.err.log')
        exit 1
    }

    Emit @{
        ok       = $true
        path     = $found.FullName
        bytes    = $found.Length
        voice    = $Voice
        semitone = $optSemi
        elapsed  = [int]$sw.Elapsed.TotalSeconds
    }
    exit 0
}

# ─── 命令：status / start / stop ────────────────────────────
function Cmd-Status {
    $pid2 = Get-ServerPid
    $ready = Test-Ready
    $free = -1
    try {
        $v = & nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null
        if ($v) { $free = [int](@($v)[0].ToString().Trim()) }
    } catch {}
    if ($optJson) {
        Write-Output (@{
            ok       = $ready
            running  = [bool]$pid2
            pid      = $pid2
            ready    = $ready
            port     = $Port
            voice    = $Voice
            freeVram = $free
        } | ConvertTo-Json -Compress)
    } else {
        Write-Output ('running=' + [bool]$pid2 + ' ready=' + $ready + ' port=' + $Port + ' voice=' + $Voice + ' freeVram=' + $free)
    }
    if ($ready) { exit 0 } else { exit 1 }
}

function Cmd-Start {
    if (Start-ServerIfNeeded) {
        Write-Output 'ready'
        exit 0
    }
    Write-Log '启动失败'
    exit 1
}

function Cmd-Stop {
    $pid2 = Get-ServerPid
    if (-not $pid2) { Write-Output 'already stopped'; exit 0 }
    Stop-Process -Id $pid2 -Force -ErrorAction SilentlyContinue
    Get-Process breeze-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Get-ServerPid)) { break }
    }
    if (Get-ServerPid) { Write-Log '停止失败'; exit 1 }
    Write-Output 'stopped'
    exit 0
}

# ─── 分发 ───────────────────────────────────────────────────
switch ($Action.ToLower()) {
    'say'    { Cmd-Say }
    'sing'   { Cmd-Sing }
    'status' { Cmd-Status }
    'start'  { Cmd-Start }
    'stop'   { Cmd-Stop }
    default {
        Write-Output @'
小鲸嗓子 CLI  —  给 AI / 脚本调用

  xiaojing-cli.ps1 say "文字" [-Out 路径] [-NoPlay] [-Json]
      文字转语音。默认播放并输出文件路径。
      -NoPlay  不播放，只生成文件（AI 调用推荐）
      -Out     指定输出路径（默认 %TEMP%\xj_xxx.wav）
      -Json    输出 JSON：{ok,path,bytes,duration,voice,elapsed}

  xiaojing-cli.ps1 sing "D:\歌.mp3" [-Out 目录] [-SemiTone -2] [-Json]
      把歌换成小鲸的声音唱。输出文件路径。
      -Out      指定输出目录（默认 <脚本目录>\songs）
      -SemiTone 降调半音数，唱不上去时用

  xiaojing-cli.ps1 status [-Json]
      查服务状态。就绪退出码 0，未就绪 1。

  xiaojing-cli.ps1 start | stop
      启动 / 停止服务（释放显存）。

注意：
  · stdout 只有结果，日志走 stderr
  · 退出码 0=成功，1=失败，2=参数错误
  · say 会自动拉起服务（首次约 30-40 秒）
'@
        exit 0
    }
}