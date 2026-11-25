# 澄的记忆星图 · 系统托盘
# 右键菜单：打开星图 / 重启服务 / 复制地址 / 停止服务 / 退出
# 悬停显示：服务状态 + 数据源数量
#
# 启动：powershell -WindowStyle Hidden -File 星图托盘.ps1

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Port = 17800
$Url = "http://127.0.0.1:$Port/"
$LogFile = Join-Path $Root 'data\tray.log'

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# 打开页面。
# 2026-11-25 踩到的坑：这台机器默认浏览器是 egoliteHTM（ego-browser，自动化用的），
# 不是给人看网页的那个。所以 Start-Process $Url 把页面交给 ego 了，
# 界面上什么都不出现 —— 看起来像"没打开"。
# 所以这里按顺序试：系统默认 → Edge → Chrome，谁能用就用谁。
function Open-Page {
    $tries = @(
        @{ how = 'shell-default'; act = { Start-Process $Url } },
        @{ how = 'edge';   exe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' },
        @{ how = 'chrome'; exe = 'C:\Program Files\Google\Chrome\Application\chrome.exe' }
    )
    foreach ($t in $tries) {
        try {
            if ($t.exe) {
                if (-not (Test-Path $t.exe)) { continue }
                Start-Process -FilePath $t.exe -ArgumentList "`"$Url`""
                Log ("Open-Page via " + $t.how)
                return
            } else {
                & $t.act
                Log ("Open-Page via " + $t.how)
                return
            }
        } catch {
            Log ("Open-Page " + $t.how + " 失败: " + $_)
        }
    }
    Log 'Open-Page 全部失败'
}

# 2026-11-25 爸爸：「你在桌面做一个快捷方式之类的 一点开就自动启动托盘并打开浏览器」
#   -OpenBrowser  启动托盘后顺便把页面开出来（桌面快捷方式用这个）
# 如果托盘已经在跑，就不再起第二个，但要顺手把页面开出来 —— 点了就得看见星图。
$script:openBrowser = ($args -contains '-OpenBrowser')

# ── 单实例锁（独占文件，非全局 Mutex —— 后者非管理员会失败）──
$lockFile = Join-Path $Root 'data\tray.lock'
try {
    $script:lock = [System.IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    # 已经在跑：只打开页面
    Write-Host '托盘已经在运行，打开页面'
    # 这里函数还没定义（脚本在上面就 exit 了），所以直接走同样的回退顺序
    try { Start-Process $Url } catch {}
    $edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    if (Test-Path $edge) { try { Start-Process -FilePath $edge -ArgumentList "`"$Url`"" } catch {} }
    exit 0
}

# ── 服务管理 ──
$script:proc = $null

function Test-Server {
    try {
        $r = Invoke-WebRequest -Uri "${Url}api/health" -TimeoutSec 2 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch { return $false }
}

function Get-Stats {
    try {
        $r = Invoke-RestMethod -Uri "${Url}api/health" -TimeoutSec 2
        return $r
    } catch { return $null }
}

function Start-Server {
    if (Test-Server) { Log '服务已在运行'; return }
    Log '启动服务'
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Log '找不到 node'; return }
    $script:proc = Start-Process -FilePath $node `
        -ArgumentList "server/server.mjs","--port=$Port" `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    Log "服务 PID $($script:proc.Id)"
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-Server) { Log '服务就绪'; return }
    }
    Log '服务启动超时'
}

function Stop-Server {
    Log '停止服务'
    if ($script:proc -and -not $script:proc.HasExited) {
        Stop-Process -Id $script:proc.Id -Force -ErrorAction SilentlyContinue
    }
    # 兜底：按端口找
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
    } catch {}
    $script:proc = $null
}

# ── 托盘 ──
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# ── 让气泡通知显示我们自己的图标，而不是 PowerShell 的 ──
# Windows 的 balloon tip 取的是「进程的 AppUserModelID 对应图标」，
# 而我们的宿主是 powershell.exe，所以默认显示 PowerShell 图标。
# 设一个自己的 AppUserModelID 后，通知会去找这个 ID 注册的图标。
try {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AppId {
    [DllImport("shell32.dll", SetLastError = true)]
    public static extern int SetCurrentProcessExplicitAppUserModelID(
        [MarshalAs(UnmanagedType.LPWStr)] string AppID);
}
"@
    $appId = 'Cheng.StarMap.Tray'
    [AppId]::SetCurrentProcessExplicitAppUserModelID($appId) | Out-Null

    # 把这个 ID 和图标登记进注册表，通知中心才认
    $icoForReg = Join-Path $ScriptDir 'starmap.ico'
    if (Test-Path $icoForReg) {
        $regPath = "HKCU:\Software\Classes\AppUserModelId\$appId"
        if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
        Set-ItemProperty -Path $regPath -Name 'DisplayName' -Value '澄的记忆星图' -Force
        Set-ItemProperty -Path $regPath -Name 'IconUri' -Value $icoForReg -Force
    }
} catch {}


$notify = New-Object System.Windows.Forms.NotifyIcon
$iconPath = Join-Path $ScriptDir 'starmap.ico'
if (Test-Path $iconPath) {
    $notify.Icon = New-Object System.Drawing.Icon $iconPath
} else {
    $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Text = '澄的记忆星图'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miOpen = $menu.Items.Add('打开星图')
$miOpen.add_Click({ Open-Page })

$miCopy = $menu.Items.Add('复制地址')
$miCopy.add_Click({
    [System.Windows.Forms.Clipboard]::SetText($Url)
    $notify.ShowBalloonTip(1500, '已复制', $Url, 'None')
})

$miRestart = $menu.Items.Add('重启服务')
$miRestart.add_Click({
    Stop-Server
    Start-Sleep -Milliseconds 600
    Start-Server
    Update-Tip
})

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miStop = $menu.Items.Add('停止服务')
$miStop.add_Click({
    Stop-Server
    Update-Tip
})

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miExit = $menu.Items.Add('退出')
$miExit.add_Click({
    $script:exiting = $true
    Stop-Server
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu

function Update-Tip {
    $ok = Test-Server
    if ($ok) {
        $s = Get-Stats
        $n = if ($s) { $s.sources } else { 0 }
        $notify.Text = "澄的记忆星图 · 运行中 · $n 个源"
        $miOpen.Enabled = $true
        $miStop.Enabled = $true
    } else {
        $notify.Text = '澄的记忆星图 · 已停止'
        $miOpen.Enabled = $false
        $miStop.Enabled = $false
    }
}

$notify.add_DoubleClick({ Open-Page })
$notify.add_MouseMove({
    # 悬停刷新（NotifyIcon 没有真正的 hover 事件，用 MouseMove 近似）
})

# ── 启动 ──
Log '托盘启动'
Start-Server
Update-Tip

# 服务就绪后把页面打开（只在 -OpenBrowser 时；托盘自身常驻，不主动打扰）
if ($script:openBrowser) {
    if (Test-Server) {
        Log '打开浏览器'
        Open-Page
    }
}

# ── 定时刷新状态 + 服务守护 ──
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 15000
$timer.add_Tick({
    if ($script:exiting) { return }
    if (-not (Test-Server)) {
        Log '服务掉了，自动拉起'
        Start-Server
    }
    Update-Tip
})
$timer.Start()

$notify.ShowBalloonTip(2000, '澄的记忆星图', "已启动 · $Url", 'None')

# 消息循环
[System.Windows.Forms.Application]::Run()

# 清理
try { $script:lock.Close(); $script:lock.Dispose() } catch {}
Remove-Item $lockFile -ErrorAction SilentlyContinue
