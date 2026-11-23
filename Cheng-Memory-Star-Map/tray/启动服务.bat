@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo 启动记忆星图服务...
start "" http://127.0.0.1:17800/
node server/server.mjs --port=17800
pause
