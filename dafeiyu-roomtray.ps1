param(
  [string]$HomeJson = 'D:\dsh-fish-home\dsh-fish\home.json',
  [string]$SessionsJson = 'C:\Users\14127\.dsh\plugins-data\aurabot\sessions.json',
  [string]$StateFile = 'D:\大肥鱼工具\room-sync-state.json',
  [string]$LogFile = 'D:\大肥鱼工具\room-sync.log',
  [string]$SessionsRoot = 'C:\Users\14127\.dsh\sessions\--D-dsh-fish-home-dsh-fish-home--',
  [string]$IconPath = 'D:\大肥鱼工具\dafeiyu-room.ico',
  [int]$PollSeconds = 10,
  [string]$NodeExe = 'E:\nodejs\node.exe',
  [string]$ScheduleScript = 'D:\大肥鱼工具\schedule-retarget.mjs',
  [string]$TalkScript = 'D:\大肥鱼工具\cheng-talk.mjs',
  [int]$TalkPort = 17801
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---- single instance ----
$script:mutex = New-Object System.Threading.Mutex($false, 'Global\DafeiyuRoomTray_Mutex')
$script:acquired = $false
for ($i = 0; $i -lt 60; $i++) {
  try { if ($script:mutex.WaitOne(200)) { $script:acquired = $true; break } }
  catch [System.Threading.AbandonedMutexException] { $script:acquired = $true; break }
}
if (-not $script:acquired) { exit 0 }

function Log([string]$msg) { try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg) -Encoding UTF8 } catch {} }
function ReadJsonFile([string]$p) { (Get-Content -Path $p -Raw -Encoding UTF8) | ConvertFrom-Json }
# ---- 鱼鱼窝插件那边「接哪间会话」也一起指过去 ----
# 插件把地址和会话写在 fish-room.discovery.json（~/.dsh 下），端口随 DSH 变，所以每次现读。
$DiscoveryFile = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $SessionsJson))) 'fish-room.discovery.json'
function Get-FishRoomOrigin {
  if (-not (Test-Path $DiscoveryFile)) { return '' }
  try { $d = ReadJsonFile $DiscoveryFile; $u = [uri]$d.url; return ($u.Scheme + '://' + $u.Authority) } catch { return '' }
}
function Get-FishRoomSession([string]$origin) {
  if (-not $origin) { return $null }
  try {
    $r = Invoke-WebRequest -Uri ($origin + '/dsh-fish-home/state') -UseBasicParsing -TimeoutSec 8
    return ($r.Content | ConvertFrom-Json)
  } catch { return $null }
}
function Set-FishRoomSession([string]$newSid) {
  $origin = Get-FishRoomOrigin
  if (-not $origin) { Log 'fishroom: 找不到 discovery 文件，跳过'; return $false }
  try {
    $body = @{ '会话' = $newSid } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $r = Invoke-WebRequest -Uri ($origin + '/dsh-fish-home/save') -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 10
    $j = $r.Content | ConvertFrom-Json
    if ([string]$j.'会话' -eq $newSid) { Log ('fishroom: 会话 -> ' + $newSid + ' (活着=' + $j.'会话活着' + ')'); return $true }
    Log ('fishroom: 写了但回的不一样：' + [string]$j.'会话')
    return $false
  } catch { Log ('fishroom: 写会话失败 ' + $_.Exception.Message); return $false }
}
function Sync-FishRoomIfEmpty([string]$sid) {
  if (-not $sid) { return }
  $origin = Get-FishRoomOrigin
  $st = Get-FishRoomSession $origin
  if ($st -and -not [string]$st.'会话') { Set-FishRoomSession $sid | Out-Null }
}
# ---- 定时任务（每天 23:30 记忆整理这类）也跟着换房改挂到新房 ----
# DSH 的 schedule 是内存态，改 schedule.json 不生效，只能走 RPC；
# RPC 要浏览器 cookie，交给 schedule-retarget.mjs 用 ~/.dsh/.credentials.yaml 的 secret 现签。
function Set-ScheduleTarget([string]$newSid) {
  if (-not $newSid) { return $false }
  if (-not (Test-Path $ScheduleScript)) { Log 'sched: 找不到 schedule-retarget.mjs，跳过'; return $false }
  if (-not (Test-Path $NodeExe)) { Log ('sched: 找不到 node: ' + $NodeExe); return $false }
  try {
    # 用 CreateNoWindow 起 node：托盘是 wscript 隐藏拉起的（本身没有控制台），
    # 直接 & node.exe 会让系统给它新建一个空的 cmd/控制台窗口——那就是多出来的空窗口。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    $psi.Arguments = ('"' + $ScheduleScript + '" "' + $newSid + '" --no-file-log')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $p = [System.Diagnostics.Process]::Start($psi)
    $outText = $p.StandardOutput.ReadToEnd()
    $errText = $p.StandardError.ReadToEnd()
    if (-not $p.WaitForExit(30000)) { try { $p.Kill() } catch {} }
    foreach ($line in (($outText + [Environment]::NewLine + $errText) -split '\r?\n')) { if ($line) { Log ('sched: ' + $line) } }
    return ($p.HasExited -and $p.ExitCode -eq 0)
  } catch { Log ('sched: 改挂失败 ' + $_.Exception.Message); return $false }
}
# ---- 起手对账：托盘重启/关机期间换过房，QQ 那两个键可能还指在旧房 ----
# 只在「旧值确实是一条以前的房、而且新房目录已经在」时才改，避免把别人有意指到别处的键掰回来。
function Repoint-QqIfStale([string]$sid, $hdata) {
  if (-not $sid) { return $false }
  if (-not (Test-Path $SessionsJson)) { return $false }
  $targetDir = Join-Path $SessionsRoot $sid
  if (-not (Test-Path $targetDir)) { Log ('qq: 新房目录还没建好，先不动 ' + $targetDir); return $false }
  $map = $null
  try { $map = ReadJsonFile $SessionsJson } catch { Log ('qq: 读 sessions.json 失败 ' + $_.Exception.Message); return $false }
  $known = @()
  try { $known = @($hdata.pressureRoomIds | ForEach-Object { [string]$_ }) } catch {}
  $need = @()
  foreach ($k in @('group:798645175','private:781689870','group:1046921713')) {
    if (-not ($map.chats.PSObject.Properties.Name -contains $k)) { continue }
    $cur = [string]$map.chats.$k.sessionId
    if ($cur -eq $sid) { continue }
    # 空着、或者指的是一条以前的房 —— 这两种才动
    if ($cur -and ($known -notcontains $cur)) {
      Log ('qq: ' + $k + ' 指的是 ' + (Short $cur) + '，不在以前的房名单里，不动')
      continue
    }
    $need += $k
  }
  if ($need.Count -eq 0) { return $false }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item -Path $SessionsJson -Destination ($SessionsJson + '.bak-roomsync-' + $stamp) -Force
  foreach ($k in $need) { $map.chats.$k.sessionId = $sid }
  $json = $map | ConvertTo-Json -Depth 30
  $tmp = $SessionsJson + '.tmp-roomsync'
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -Force -Path $tmp -Destination $SessionsJson
  Log ('qq: 起手补指 -> ' + $sid + ' ; repointed: ' + ($need -join ', ') + ' ; backup .bak-roomsync-' + $stamp)
  return $true
}
# ---- 和澄说话的小门（cheng-talk serve）----
# Alma 那边要能直接跟澄说话，不借鱼鱼窝房间。这门自己每次请求都现读 discovery 文件，
# 房间换了它自己就跟上；托盘这边只负责「门一直开着」——没开就拉起来。
function Test-TalkPort {
  try {
    $c = Get-NetTCPConnection -State Listen -LocalPort $TalkPort -ErrorAction Stop
    return [bool]$c
  } catch { return $false }
}
function Ensure-ChengTalk {
  if (Test-TalkPort) { return $true }
  if (-not (Test-Path $TalkScript)) { Log 'talk: 找不到 cheng-talk.mjs，跳过'; return $false }
  if (-not (Test-Path $NodeExe)) { Log ('talk: 找不到 node: ' + $NodeExe); return $false }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    $psi.Arguments = ('"' + $TalkScript + '" serve --port ' + $TalkPort)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = (Split-Path -Parent $TalkScript)
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Log ('talk: 门没开着，拉起来了（127.0.0.1:' + $TalkPort + '）')
    return $true
  } catch { Log ('talk: 拉不起来 ' + $_.Exception.Message); return $false }
}
function Check-QqOnce([string]$sid, $hdata) {
  if ($script:qqChecked) { return }
  $script:qqChecked = $true
  Repoint-QqIfStale $sid $hdata | Out-Null
}
function Short([string]$sid) { if (-not $sid) { return '?' }; if ($sid.Length -gt 13) { return $sid.Substring($sid.Length - 8) }; return $sid }

$stateDir = Split-Path -Parent $StateFile
if ($stateDir -and -not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
$script:state = $null
if (Test-Path $StateFile) { try { $script:state = ReadJsonFile $StateFile } catch {} }
$script:lastCheck = '--:--:--'
$script:lastMsg = '启动中'
$script:tick = 0
$script:schedChecked = $false
$script:schedPending = $false
$script:qqChecked = $false

function Save-State {
  try { ($script:state | ConvertTo-Json) | Set-Content -Path $StateFile -Encoding UTF8 } catch {}
}

function Invoke-Check {
  $script:lastCheck = Get-Date -Format 'HH:mm:ss'
  if (-not (Test-Path $HomeJson)) { $script:lastMsg = '找不到 home.json'; return }
  $hdata = ReadJsonFile $HomeJson
  $rot = [string]$hdata.rotatedAt
  $to = [string]$hdata.rotatedTo
  $sid = [string]$hdata.sessionId
  if (-not $script:state) {
    $script:state = [pscustomobject]@{ lastRotatedAt = $rot; lastSessionId = $sid }
    Save-State
    Log ("init: rotatedAt=$rot session=$sid")
    Sync-FishRoomIfEmpty $sid
    Check-QqOnce $sid $hdata
    $script:lastMsg = '已接 ' + (Short $sid)
    return
  }
  # 起手（state 已经在了）也校一次定时任务，免得重启后任务还指在旧房
  if (-not $script:schedChecked) {
    $script:schedChecked = $true
    $script:schedPending = -not (Set-ScheduleTarget $sid)
  }
  Check-QqOnce $sid $hdata
  # 上一轮没改成功（新房刚建、DSH 还没登记之类）就每隔几轮再试，直到成功
  if ($script:schedPending -and $sid) {
    $script:tick = [int]$script:tick + 1
    if (($script:tick % 3) -eq 0) {
      if (Set-ScheduleTarget $sid) { $script:schedPending = $false; Log 'sched: 重试改挂成功' }
    }
  }
  if ($rot -and ($rot -ne [string]$script:state.lastRotatedAt)) {
    $newSid = if ($to) { $to } else { $sid }
    $targetDir = Join-Path $SessionsRoot $newSid
    if ($newSid -and (Test-Path $targetDir)) {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      Copy-Item -Path $SessionsJson -Destination ($SessionsJson + '.bak-roomsync-' + $stamp) -Force
      $map = ReadJsonFile $SessionsJson
      $changed = @()
      foreach ($k in @('group:798645175','private:781689870','group:1046921713')) {
        if ($map.chats.PSObject.Properties.Name -contains $k) { $map.chats.$k.sessionId = $newSid; $changed += $k }
      }
      $json = $map | ConvertTo-Json -Depth 30
      $tmp = $SessionsJson + '.tmp-roomsync'
      [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
      Move-Item -Force -Path $tmp -Destination $SessionsJson
      $script:state = [pscustomobject]@{ lastRotatedAt = $rot; lastSessionId = $newSid }
      Save-State
      $fishOk = Set-FishRoomSession $newSid
      $schedOk = Set-ScheduleTarget $newSid
      $script:schedPending = -not $schedOk
      Log ("rotated -> new room $newSid ; repointed: " + ($changed -join ', ') + " ; fishroom=" + $fishOk + " ; sched=" + $schedOk + " ; backup .bak-roomsync-$stamp")
      $script:lastMsg = '已接新房 ' + (Short $newSid)
      try { $script:ni.ShowBalloonTip(4000, '大肥鱼接房', ('换房间啦，QQ、鱼鱼窝、定时任务都接到 ' + (Short $newSid)), [System.Windows.Forms.ToolTipIcon]::Info) } catch {}
    } else {
      Log ("rotated detected (rotatedAt=$rot) new=$newSid but session dir missing: $targetDir ; kept QQ on old, will retry")
      $script:lastMsg = '等新房就位 ' + (Short $newSid)
    }
    return
  }
  if ($sid -and ($sid -ne [string]$script:state.lastSessionId)) {
    $script:state.lastSessionId = $sid
    Save-State
    Sync-FishRoomIfEmpty $sid
  }
  # 定期看一眼：鱼鱼窝那边的「会话」要是空的（换过房、重装过插件、被人清掉），就补上
  $script:tick = [int]$script:tick + 1
  if (($script:tick % 3) -eq 1 -and $sid) { Sync-FishRoomIfEmpty $sid }
  if (($script:tick % 3) -eq 2) { Ensure-ChengTalk | Out-Null }
  $script:lastMsg = '已接 ' + (Short $sid)
}

function Update-Ui {
  try {
    $script:ni.Text = ('大肥鱼 · ' + $script:lastMsg)
    $script:miStatus.Text = ($script:lastMsg + '  (' + $script:lastCheck + ')')
  } catch {}
}

function Exit-Tray {
  try { $script:timer.Stop() } catch {}
  try { $script:ni.Visible = $false; $script:ni.Dispose() } catch {}
  try { $script:mutex.ReleaseMutex() } catch {}
  [System.Windows.Forms.Application]::Exit()
}

# ---- tray ----
$script:ni = New-Object System.Windows.Forms.NotifyIcon
try { $script:ni.Icon = New-Object System.Drawing.Icon($IconPath) }
catch { $script:ni.Icon = [System.Drawing.SystemIcons]::Application }
$script:ni.Text = '大肥鱼 · 看家（QQ/鱼鱼窝/定时）'
$script:ni.Visible = $true

$script:menu = New-Object System.Windows.Forms.ContextMenuStrip
$miHead = $script:menu.Items.Add('大肥鱼接房 · 后台看着')
$miHead.Enabled = $false
$script:miStatus = $script:menu.Items.Add('启动中')
$script:miStatus.Enabled = $false
$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$miLog = $script:menu.Items.Add('打开日志')
$miLog.Add_Click({ try { Start-Process notepad.exe $LogFile } catch {} })
$miWeb = $script:menu.Items.Add('看现在接的是哪条')
$miWeb.Add_Click({
  try {
    $m = ReadJsonFile $SessionsJson
    $g = Short ([string]$m.chats.'group:798645175'.sessionId)
    $p = Short ([string]$m.chats.'private:781689870'.sessionId)
    $script:ni.ShowBalloonTip(5000, '大肥鱼接房', ('群：' + $g + '   私聊：' + $p), [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {}
})
$miRestart = $script:menu.Items.Add('重启')
$miRestart.Add_Click({
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\大肥鱼工具\dafeiyu-roomtray.ps1"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Log 'restart requested'
  } catch {}
  Exit-Tray
})
$miExit = $script:menu.Items.Add('退出')
$miExit.Add_Click({ Log 'exit requested'; Exit-Tray })

$script:ni.ContextMenuStrip = $script:menu
$script:ni.Add_DoubleClick({ try { Start-Process notepad.exe $LogFile } catch {} })

$script:startTip = $true
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = [Math]::Max(2000, $PollSeconds * 1000)
$script:timer.Add_Tick({
  try { Invoke-Check } catch { Log ('ERROR ' + $_.Exception.Message); $script:lastMsg = '出错，见日志' }
  Update-Ui
  if ($script:startTip) { $script:startTip = $false; try { $script:ni.ShowBalloonTip(3000, '大肥鱼接房', '我在后台看着啦，房间一换我就把 QQ、鱼鱼窝和定时任务都接过去', [System.Windows.Forms.ToolTipIcon]::Info) } catch {} }
})
$script:timer.Start()
try { Invoke-Check } catch {}
Update-Ui
Log 'tray started'
[System.Windows.Forms.Application]::Run()