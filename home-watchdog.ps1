# Home watchdog (single) - keeps three helpers alive while DeepSeek Harness runs:
#   1) ollama serve         (127.0.0.1:11434)
#   2) XiaoJingVoice tray   (mutex Local\XiaoJingVoiceTray)
#   3) Dafeiyu room tray    (mutex Global\DafeiyuRoomTray_Mutex)
# Every launch goes through WMI with Win32_ProcessStartup.ShowWindow = 0,
# so the created process never gets a console window (no flashing cmd window).
$ErrorActionPreference = 'SilentlyContinue'
$logPath = 'D:\大肥鱼工具\home-watchdog.log'

function Write-Log([string]$msg) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
    try { [System.IO.File]::AppendAllText($logPath, $line + [char]13 + [char]10, (New-Object System.Text.UTF8Encoding($false))) } catch { }
}

function Start-Hidden([string]$cmdline) {
    $su = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
    $su.ShowWindow = 0
    return ([wmiclass]'Win32_Process').Create($cmdline, $null, $su)
}

function Test-Port([int]$port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(1200)) { $c.EndConnect($iar); return [bool]$c.Connected }
        return $false
    } catch { return $false } finally { $c.Close() }
}

function Test-Mutex([string]$name) {
    try { $m = [System.Threading.Mutex]::OpenExisting($name); $m.Dispose(); return $true } catch { return $false }
}

function Test-ProcCmd([string]$pattern) {
    $found = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like ('*' + $pattern + '*') })
    return ($found.Count -gt 0)
}

# 1. only work while DSH is up
if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { exit 0 }

# 2. single instance
$self = New-Object System.Threading.Mutex($false, 'Local\HomeWatchdog')
if (-not $self.WaitOne(0)) { exit 0 }

try {
    # ---- ollama ----
    $portUp = Test-Port 11434
    $op = @(Get-Process ollama -ErrorAction SilentlyContinue)
    if (-not $portUp) {
        if ($op.Count -eq 0) {
            $r = Start-Hidden '"E:\Ollama\ollama.exe" serve'
            Write-Log ('ollama: not running -> started (rc=' + $r.ReturnValue + ' pid=' + $r.ProcessId + ')')
        } else {
            $age = ((Get-Date) - $op[0].StartTime).TotalSeconds
            if ($age -gt 90) {
                $op | Stop-Process -Force
                Start-Sleep -Seconds 2
                $r = Start-Hidden '"E:\Ollama\ollama.exe" serve'
                Write-Log ('ollama: no port ' + [int]$age + 's after start -> restarted (rc=' + $r.ReturnValue + ' pid=' + $r.ProcessId + ')')
            }
        }
    }

    # ---- XiaoJingVoice tray ----
    if (-not (Test-Mutex 'Local\XiaoJingVoiceTray') -and -not (Test-ProcCmd 'xiaojing-tray')) {
        $r = Start-Hidden 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\大肥鱼工具\XiaoJingVoice\xiaojing-tray.ps1"'
        Write-Log ('xiaojing tray: not running -> started (rc=' + $r.ReturnValue + ' pid=' + $r.ProcessId + ')')
    }

    # ---- Dafeiyu room tray ----
    if (-not (Test-Mutex 'Global\DafeiyuRoomTray_Mutex') -and -not (Test-ProcCmd 'dafeiyu-roomtray')) {
        $r = Start-Hidden 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\大肥鱼工具\dafeiyu-roomtray.ps1"'
        Write-Log ('room tray: not running -> started (rc=' + $r.ReturnValue + ' pid=' + $r.ProcessId + ')')
    }
} finally {
    try { $self.ReleaseMutex() } catch { }
    try { $self.Dispose() } catch { }
}
exit 0
