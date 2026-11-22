@echo off
REM 嗓子 = 「小鲸嗓子」（Breeze TTS 2），只有一个服务，直连 8137。
REM 外壳 2026-11-22 搬进 D:\大肥鱼工具\XiaoJingVoice；启动器 start-xiaojing.ps1 会先清掉重复的代理环境变量
REM （不清的话外壳托盘的 Start-Server 会因为 PowerShell 环境字典撞车而静默失败）。
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\大肥鱼工具\start-xiaojing.ps1"
