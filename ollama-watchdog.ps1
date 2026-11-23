param()
# Ollama watchdog: 只在 DeepSeek Harness 在跑、且 11434 不应答时，把 ollama serve 拉起来
$ErrorActionPreference = 'SilentlyContinue'
$logPath = 'D:\大肥鱼工具\ollama-sync.log'
$ollamaExe = 'E:\Ollama\ollama.exe'

function Write-Log($msg) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
    Add-Content -Path $logPath -Value $line -Encoding UTF8
}

# 1. DSH 没在跑就不管
if (-not (Get-Process -Name 'DeepSeek Harness')) { exit 0 }

# 2. 端口能连上就什么都不做
$alive = $false
try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect('127.0.0.1', 11434, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(1500)) { $client.EndConnect($iar); $alive = $client.Connected }
    $client.Close()
} catch { $alive = $false }
if ($alive) { exit 0 }

# 3. 用互斥体防并发
$mutex = New-Object System.Threading.Mutex($false, 'Local\OllamaWatchdog')
if (-not $mutex.WaitOne(200)) { exit 0 }

try {
    if (-not (Test-Path $ollamaExe)) { Write-Log ('ollama exe missing: ' + $ollamaExe); exit 0 }
    $cmd = '"' + $ollamaExe + '" serve'
    $r = ([wmiclass]'Win32_Process').Create($cmd)
    Write-Log ('watchdog: ollama not running -> starting (rc=' + $r.ReturnValue + ' pid=' + $r.ProcessId + ')')
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
exit 0
