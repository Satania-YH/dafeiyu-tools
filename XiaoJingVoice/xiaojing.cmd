@echo off
rem Xiaojing Voice CLI - for AI / script calls
rem Usage: xiaojing say "text" -NoPlay -Json
rem        xiaojing sing "D:\song.mp3" -Json
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0xiaojing-cli.ps1" %*
exit /b %ERRORLEVEL%
