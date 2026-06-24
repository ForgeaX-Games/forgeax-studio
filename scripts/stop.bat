@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM ===========================================================================
REM  stop.bat — Windows-native teardown for the forgeax-studio dev stack.
REM
REM  Why this exists: scripts/stop.sh relies on MSYS `kill` / `ps` which cannot
REM  reliably terminate ORPHANED native Windows processes (e.g. bun.exe that
REM  detached from its Git-Bash launcher and keeps squatting :18900). This
REM  script discovers the LISTEN owner per port via `netstat -ano` and kills it
REM  with the native `taskkill /F /T`, which always works on Windows.
REM
REM  Usage:
REM    scripts\stop.bat            graceful taskkill, then escalate to /F
REM    scripts\stop.bat --force    skip grace, go straight to /F
REM
REM  Exit codes:
REM    0  clean teardown (or nothing was running)
REM    1  a port remained bound after kill
REM ===========================================================================

set "FORCE=0"
if /I "%~1"=="--force" set "FORCE=1"
if /I "%~1"=="-f"      set "FORCE=1"

REM ── resolve repo root (this file lives in <root>\scripts) ──
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT=%%~fI"

REM ── FIXED studio ports (mirror scripts\lib\ports.sh) ──
set "PORTS=18900 18920 15173 15280 8900 18930"

REM ── dynamic plugin ports from .forgeax\dev-stack.env (FORGEAX_RUN_PORTS) ──
set "STACK_ENV=%ROOT%\.forgeax\dev-stack.env"
if exist "%STACK_ENV%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%STACK_ENV%") do (
    if /I "%%A"=="FORGEAX_RUN_PORTS" (
      set "DYN=%%B"
      set "DYN=!DYN:"=!"
      set "PORTS=!PORTS! !DYN!"
    )
  )
)

echo [stop.bat] scanning forgeax-studio dev stack on ports: %PORTS%
echo.

REM ── discover unique LISTEN PIDs across all ports ──
set "PIDLIST= "
for %%P in (%PORTS%) do (
  for /f "tokens=5" %%K in ('netstat -ano ^| findstr /r /c:":%%P *LISTENING" 2^>nul') do (
    set "FOUND=%%K"
    REM de-dup
    echo !PIDLIST! | findstr /c:" !FOUND! " >nul || (
      set "PIDLIST=!PIDLIST!!FOUND! "
      echo   :%%P  -^>  pid !FOUND!
    )
  )
)

REM trim and test emptiness
set "TRIM=%PIDLIST: =%"
if "%TRIM%"=="" (
  echo [stop.bat] nothing to kill - all ports already free.
  call :cleanup
  exit /b 0
)

echo.
if "%FORCE%"=="1" goto :forcekill

REM ── graceful pass: taskkill without /F (best-effort), then wait ──
echo [stop.bat] sending graceful taskkill, waiting ~3s...
for %%K in (%PIDLIST%) do taskkill /PID %%K /T >nul 2>&1
ping -n 4 127.0.0.1 >nul

:forcekill
echo [stop.bat] escalating to SIGKILL (taskkill /F /T) on stragglers...
for %%K in (%PIDLIST%) do (
  tasklist /FI "PID eq %%K" 2>nul | findstr /c:"%%K" >nul && (
    echo   killing pid %%K
    taskkill /F /T /PID %%K >nul 2>&1
  )
)
ping -n 2 127.0.0.1 >nul

REM ── final port verification ──
echo.
echo [stop.bat] final port state:
set "ANY_BUSY=0"
for %%P in (%PORTS%) do (
  netstat -ano | findstr /r /c:":%%P *LISTENING" >nul 2>&1 && (
    echo   [X] :%%P  STILL BUSY
    set "ANY_BUSY=1"
  ) || (
    echo   [OK] :%%P
  )
)

if "%ANY_BUSY%"=="1" (
  echo.
  echo [stop.bat] done - but some ports remain bound (see above^).
  exit /b 1
)

call :cleanup
echo.
echo [stop.bat] done - stack is down, safe to run scripts\run.sh
exit /b 0

REM ── housekeeping: drop run-state files run.sh checks on next launch ──
:cleanup
if exist "%ROOT%\.forgeax\dev-stack.env"        del /q "%ROOT%\.forgeax\dev-stack.env" >nul 2>&1
if exist "%ROOT%\.forgeax\plugin-dev-ports.json" del /q "%ROOT%\.forgeax\plugin-dev-ports.json" >nul 2>&1
if exist "%ROOT%\.forgeax\run.lock"             rmdir /s /q "%ROOT%\.forgeax\run.lock" >nul 2>&1
exit /b 0
