@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend\voice\start-voice.ps1" %*
set "VOICE_LAUNCH_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %VOICE_LAUNCH_EXIT%
