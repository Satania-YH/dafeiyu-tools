@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if exist "tray\星图托盘.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "tray\星图托盘.ps1"
) else (
    echo 找不到 tray\星图托盘.ps1
    pause
)
