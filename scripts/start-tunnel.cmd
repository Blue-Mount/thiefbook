@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0supervise-tunnel.ps1"
exit /b %errorlevel%
