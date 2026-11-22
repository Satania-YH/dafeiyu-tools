@echo off
rem Xiaojing Voice CLI - for AI / script calls
rem Usage: xiaojing say "text" -NoPlay -Json
rem        xiaojing sing "song.mp3" -Json
rem say goes through node (skips the ~2s PowerShell startup); everything else stays on ps1
if /i "%~1"=="say" goto :saynode
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0xiaojing-cli.ps1" %*
exit /b %ERRORLEVEL%
:saynode
where node >nul 2>nul || goto :psfallback
node "%~dp0xiaojing.mjs" %*
exit /b %ERRORLEVEL%
:psfallback
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0xiaojing-cli.ps1" %*
exit /b %ERRORLEVEL%
