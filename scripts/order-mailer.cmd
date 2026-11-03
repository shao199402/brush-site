@echo off
rem ============================================================
rem  Order mail notifier - runs from Windows Task Scheduler
rem  Pure ASCII on purpose: cmd.exe reads this file with the OEM
rem  codepage, so non-ASCII characters inside would be executed
rem  as commands and break the script.
rem ============================================================
setlocal
cd /d "%~dp0"

rem node.exe: prefer the standard install path, fall back to PATH
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" "%~dp0order-mailer.js" %*
exit /b %ERRORLEVEL%
