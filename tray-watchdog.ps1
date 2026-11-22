# Dafeiyu room tray watchdog
# Scheduled every 2 minutes. Only acts while DeepSeek Harness is up:
# if the tray is not holding its mutex, launch it detached (WMI -> outside the
# task process tree, so it survives DSH restarts).
$ErrorActionPreference = 'SilentlyContinue'
$mutexName = 'Global\DafeiyuRoomTray_Mutex'
$logPath = 'D:\大肥鱼工具\room-sync.log'
$vbs = 'D:\大肥鱼工具\DafeiyuRoomSync.vbs'

$dsh = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if (-not $dsh) { exit 0 }

try {
    $m = [System.Threading.Mutex]::OpenExisting($mutexName)
    $m.Dispose()
    exit 0
} catch { }

try {
    $res = ([wmiclass]'Win32_Process').Create('wscript.exe "' + $vbs + '"')
    $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  watchdog: tray not running -> starting (rc=' + $res.ReturnValue + ' pid=' + $res.ProcessId + ')'
} catch {
    $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  watchdog: start failed: ' + $_.Exception.Message
}
try {
    [System.IO.File]::AppendAllText($logPath, [char]13 + [char]10 + $line + [char]13 + [char]10, (New-Object System.Text.UTF8Encoding($false)))
} catch { }
exit 0