# 起「小鲸嗓子」托盘（澄自己写的启动器）
# 为什么需要这一层：本机进程环境里 no_proxy/NO_PROXY、https_proxy/HTTPS_PROXY、http_proxy/HTTP_PROXY
# 三对大小写重复，PowerShell 建环境字典时会撞车，凡是 Start-Process 带 -RedirectStandardOutput
# 就抛「已添加项。字典中的关键字…」，外壳托盘的 Start-Server 正好是这么写的，异常被 catch 吞掉，
# 服务永远起不来、日志一片空白。所以起之前先把重复的那份清掉。
# 2026-11-22 记。

$ErrorActionPreference = 'Continue'
$ShellDir = 'D:\大肥鱼工具\XiaoJingVoice'
$Tray = Join-Path $ShellDir 'xiaojing-tray.ps1'

function Clear-DupEnv {
    $envs = [System.Environment]::GetEnvironmentVariables('Process')
    $seen = @{}
    foreach ($k in @($envs.Keys)) {
        $low = $k.ToLower()
        if ($seen.ContainsKey($low)) {
            if ($k -ceq $low) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }
            else { [Environment]::SetEnvironmentVariable($seen[$low], $null, 'Process'); $seen[$low] = $k }
        } else { $seen[$low] = $k }
    }
}

Clear-DupEnv

if (-not (Test-Path $Tray)) { Write-Output ('找不到 ' + $Tray); exit 1 }

$already = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like '*xiaojing-tray.ps1*' })
if ($already.Count -gt 0) { Write-Output ('托盘已经在跑 (pid ' + ($already[0].ProcessId) + ')'); exit 0 }

Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File', $Tray) -WindowStyle Hidden | Out-Null
Write-Output '托盘已启动'
