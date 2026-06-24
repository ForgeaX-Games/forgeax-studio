@echo off
setlocal EnableExtensions
REM ===========================================================================
REM  run.bat — one-click Windows launcher for the forgeax-studio dev stack.
REM
REM  run.sh is an 800+ line bash orchestrator (version banner, env audit,
REM  symlink repair, ordered boot of server/interface/engine, process-group
REM  management). Re-implementing it in pure batch would diverge fast, so this
REM  wrapper just locates Git-Bash `bash.exe` and runs scripts/run.sh, reusing
REM  ALL existing logic. Double-click this file, or run from cmd / PowerShell.
REM
REM  Any args are forwarded to run.sh, e.g.:
REM    scripts\run.bat --fresh        :: purge vite caches before starting
REM ===========================================================================

REM ── resolve repo root (this file lives in <root>\scripts) ──
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT=%%~fI"

REM ── locate Git-Bash bash.exe (MINGW), NOT WSL ──
REM  run.sh MUST run under Git-Bash (MINGW): it relies on Windows drive paths,
REM  Windows-side bun/pnpm, and a MINGW*/MSYS* compat shim. WSL's
REM  C:\Windows\System32\bash.exe would remap paths to /mnt/d and break it, so
REM  we deliberately AVOID System32\bash.exe.
REM  Strategy, in order:
REM   1. derive from git.exe: <gitroot>\cmd\git.exe -> <gitroot>\bin\bash.exe
REM      (covers Git for Windows AND bundled clients like UGit whose install
REM       path embeds a changing version number, e.g. ...\UGit\app-5.50.0\...)
REM   2. standard Git-for-Windows install dirs
REM   3. any bash on PATH that is NOT the System32 (WSL) launcher
set "BASH="
for /f "delims=" %%G in ('where git 2^>nul') do (
  if not defined BASH (
    for %%P in ("%%~dpG..") do (
      if exist "%%~fP\bin\bash.exe"     set "BASH=%%~fP\bin\bash.exe"
      if not defined BASH if exist "%%~fP\usr\bin\bash.exe" set "BASH=%%~fP\usr\bin\bash.exe"
    )
  )
)
if not defined BASH if exist "%ProgramFiles%\Git\bin\bash.exe"         set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles%\Git\usr\bin\bash.exe"     set "BASH=%ProgramFiles%\Git\usr\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe"    set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined BASH (
  for /f "delims=" %%B in ('where bash 2^>nul') do (
    if not defined BASH if /I not "%%B"=="%SystemRoot%\System32\bash.exe" set "BASH=%%B"
  )
)

if not defined BASH (
  echo [run.bat] ERROR: could not find Git-Bash 'bash.exe'.
  echo   Install Git for Windows ^(https://git-scm.com/download/win^),
  echo   or add its bin folder to PATH, then re-run.
  exit /b 1
)

echo [run.bat] using bash: %BASH%
echo [run.bat] starting forgeax-studio dev stack...
echo.

cd /d "%ROOT%"
"%BASH%" -lc "exec ./scripts/run.sh \"$@\"" run.sh %*
exit /b %ERRORLEVEL%
