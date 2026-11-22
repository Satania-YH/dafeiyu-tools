# 大肥鱼自启：缺什么起什么（自己要用的时候先跑这个）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File "D:\大肥鱼工具\大肥鱼自启.ps1"
#       加 -What voice|comfy|all 只起某一样

param([string]$What = 'all')

function Test-Port([int]$port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $a = $c.BeginConnect('127.0.0.1', $port, $null, $null)
    $ok = $a.AsyncWaitHandle.WaitOne(800) -and $c.Connected
    $c.Close()
    return $ok
  } catch { return $false }
}

# 嗓子 = 小鲸嗓子（Breeze TTS 2），外壳在 D:\大肥鱼工具\XiaoJingVoice，只有一个服务，直连 8137。
# 先看 /health 而不是只看端口：端口开着但模型还没加载完的话，念字会 409。
function Test-Breeze {
  try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8137/health' -TimeoutSec 3; return ($r.status -eq 'ok') } catch { return $false }
}

function Start-Voice {
  if (Test-Breeze) { Write-Output 'voice: already up'; return }
  # 2026-11-22 起走「小鲸嗓子」外壳（D:\大肥鱼工具\XiaoJingVoice，读它自己的 config.ini）：
  # 启动器会先清掉进程里大小写重复的 no_proxy/NO_PROXY 等，再拉托盘（带图标、能唱歌）。
  # 不走这条路的话，Start-Process -RedirectStandardOutput 会因为环境字典撞车静默失败。
  $launcher = 'D:\大肥鱼工具\start-xiaojing.ps1'
  if (Test-Path $launcher) {
    & $launcher | Out-Null
    for ($i = 0; $i -lt 90; $i++) { Start-Sleep -Milliseconds 1000; if (Test-Breeze) { Write-Output 'voice: up'; return } }
    Write-Output 'voice: FAILED (90s)'
    return
  }
  Write-Output ('voice: FAILED (找不到 ' + $launcher + ')')
}

function Start-Comfy {
  if (Test-Port 8188) { Write-Output 'comfy: already up'; return }
  Start-Process -FilePath 'E:\ComfyUI\ComfyUI_windows_portable\python_embeded\python.exe' -WorkingDirectory 'E:\ComfyUI\ComfyUI_windows_portable' -WindowStyle Hidden -ArgumentList '-s','ComfyUI\main.py','--windows-standalone-build'
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 1500; if (Test-Port 8188) { Write-Output 'comfy: up'; return } }
  Write-Output 'comfy: FAILED (90s)'
}

function Start-Ollama {
  if (Test-Port 11434) { Write-Output 'ollama: already up'; return }
  Start-Process -FilePath 'E:\Ollama\ollama.exe' -ArgumentList 'serve' -WindowStyle Hidden
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 1000; if (Test-Port 11434) { Write-Output 'ollama: up'; return } }
  Write-Output 'ollama: FAILED (20s)'
}

switch ($What) {
  'voice' { Start-Voice }
  'comfy' { Start-Comfy }
  'ollama' { Start-Ollama }
  default { Start-Ollama; Start-Voice; Start-Comfy }
}