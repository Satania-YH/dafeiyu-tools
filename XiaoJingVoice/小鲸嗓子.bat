@echo off
chcp 65001 >nul
setlocal

if "%~1"=="" (
    rem 没参数 = 正常启动托盘
    start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0xiaojing-tray.ps1"
    exit /b
)

rem 有参数 = 拖了个文件进来，走唱歌
set "FILE=%~1"
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

echo.
echo   小鲸唱歌
echo   ─────────────────────────────
echo   素材: %FILE%
echo.

rem 读 config.ini 拿 SeedVC 和 refs 路径
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"SeedVC" "%HERE%\config.ini"`) do set "SEEDVC=%%b"
if not defined SEEDVC set "SEEDVC=E:\seed-vc"
set "SEEDVC=%SEEDVC: =%"

set "REF=%HERE%\voices\refs\d3_long.wav"
set "OUT=%HERE%\songs"

if not exist "%SEEDVC%\.venv\Scripts\python.exe" (
    echo   [错误] 找不到唱歌引擎: %SEEDVC%
    pause
    exit /b 1
)
if not exist "%REF%" (
    echo   [错误] 找不到音色参考: %REF%
    pause
    exit /b 1
)

echo   引擎: %SEEDVC%
echo   音色: %REF%
echo.
echo   正在转换，请稍候...
echo.

cd /d "%SEEDVC%"
.venv\Scripts\python.exe inference.py --source "%FILE%" --target "%REF%" --output "%OUT%" --diffusion-steps 30 --f0-condition True --fp16 True

echo.
echo   ─────────────────────────────
echo   完成！输出在: %OUT%
start "" "%OUT%"
pause
