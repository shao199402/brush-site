@echo off
rem ============================================================
rem  Daily price check - Windows Task Scheduler entry point
rem
rem  WHY A .cmd INSTEAD OF .ps1
rem    A .ps1 saved as UTF-8 without BOM is read as ANSI by Windows
rem    PowerShell 5.1; Chinese comments get garbled and the script may
rem    fail to parse. A .cmd avoids that entirely.
rem
rem  WHY THIS FILE IS PURE ASCII (no Chinese at all)
rem    cmd.exe reads batch files using the OEM code page (GBK on a
rem    Chinese Windows). UTF-8 Chinese bytes inside `rem` lines can
rem    decode to characters that cmd treats as command separators,
rem    so parts of a comment get EXECUTED as commands. This actually
rem    happened: "'XX is not recognized as an internal or external
rem    command". Keep this file ASCII-only.
rem
rem  WHY ROOT IS DERIVED FROM %~dp0
rem    %~dp0 is the directory of this .cmd (with trailing backslash).
rem    Its parent is the project root. This makes the whole project
rem    relocatable - copy it to D:\apps\brush-site on a server and
rem    nothing in this file needs editing.
rem
rem  WHY NODE IS LOOKED UP BY ABSOLUTE PATH FIRST
rem    The task runs as SYSTEM, whose PATH usually does not contain
rem    node. Try the usual install locations, then fall back to PATH.
rem
rem  WHY LOGS ARE NOT REDIRECTED HERE
rem    cmd `>>` and PowerShell `>` can write UTF-16LE; mixing that
rem    with Node's UTF-8 output corrupts the log. Node writes its own
rem    log (scripts/price-daily.js, UTF-8).
rem
rem  SCHEDULE   daily 00:00, SYSTEM account, catch-up when missed
rem  OUTPUT     data\price-reports\<local date>.md
rem             data\price-snapshots\<local date>.json
rem             data\_price-daily.log
rem ============================================================

rem This file lives in <root>\scripts\, so its parent is the root
for %%I in ("%~dp0..") do set "ROOT=%%~fI"

rem Locate node: common install paths first, then PATH
set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE set "NODE=node"

rem Chrome path is overridable via CHROME_PATH (Beautylish needs a browser)

cd /d "%ROOT%"
"%NODE%" "%ROOT%\scripts\price-daily.js"
exit /b %ERRORLEVEL%
