@echo off
rem ============================================================
rem  Beautylish crawl supervisor - launched by Windows Task Scheduler
rem
rem  Why a batch file + separate JS:
rem    - .ps1 files get mangled by Windows PowerShell 5.1 unless saved as
rem      UTF-8 with BOM; a plain ASCII .cmd avoids that entirely.
rem    - The supervisor must NOT be a child of the DSH session, otherwise a
rem      session restart kills it (this actually happened: the crawl and the
rem      old Node watchdog both died at once, losing ~30 minutes).
rem
rem  Scheduled every 15 minutes: if the crawl is alive it just returns;
rem  if it died it restarts (crawl resumes from data/beautylish-cache).
rem  When the crawl is finished it runs the wrap-up chain once.
rem ============================================================
set ROOT=H:\site-publish
cd /d %ROOT%
node "%ROOT%\scripts\beautylish-supervise.js" >> "%ROOT%\data\_bl-supervisor.log" 2>&1
exit /b 0
