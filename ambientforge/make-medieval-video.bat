@echo off
setlocal
title AmbientForge - medieval path one-click launcher
cd /d "%~dp0"

REM This machine has no DistroKid profile; force mock so branch A succeeds.
set DISTROKID_MODE=mock

echo.
echo ===============================================================
echo   AmbientForge - medieval-path video (FULL 30-track REAL run)
echo ===============================================================
echo   *** THIS IS A REAL SUNO BILL: 30 tracks = 15 generations ***
echo   Starting: suno bridge, freepik bridge, freepik Chrome,
echo   cover-picker popup, and the worker. Five windows will open.
echo.
echo   When the 4 covers are ready, a window pops up with a sound -
echo   click the cover you want. Output ends up at:
echo     projects\01KRNX8PRFD4MNF5T20P0GXV0C\<albumId>\final.mp4
echo ===============================================================
echo.

REM Ask how many times every song plays in the final video.
REM 1 = normal (each song once, no repeat), 2 = twice, 3 = three times.
REM Default (just press Enter) = 2. Anything but "1"/"3" -> 2.
set "LOOPF=2"
set /p LOOPF="How many times should every song play? 1 = normal (once), 2, or 3 [default 2]: "
if not "%LOOPF%"=="1" if not "%LOOPF%"=="3" set "LOOPF=2"
set AMBIENT_VIDEO_LOOP_FACTOR=%LOOPF%
echo   -^> every song will play x%AMBIENT_VIDEO_LOOP_FACTOR% in the final video.
echo.

REM Cost gate: this run spends real Suno credits (15 dual-variant
REM generations). Require an explicit YES so a stray double-click of
REM this .bat can never start a billable run by accident.
set "GO=no"
set /p GO="Start a REAL 30-track Suno run (15 generations, real bill)? Type YES: "
if /i not "%GO%"=="YES" (
  echo.
  echo Aborted - nothing launched, no Suno charge.
  echo.
  pause
  endlocal
  exit /b 0
)
echo.

REM 1. Always-on-top cover-picker popup. Its OWN window on purpose - the
REM    whole point is a visible popup that jumps to the front (Win32
REM    SetForegroundWindow) the moment the 4 covers land.
start "AF cover-picker" powershell -NoProfile -ExecutionPolicy Bypass -Sta -File "scripts\pick-popup.ps1"

REM 2. Everything else - suno bridge, freepik bridge, freepik Chrome,
REM    and the worker - runs under ONE concurrently console in THIS
REM    window (prefixed: suno|fp-br|chrome|worker). No bridges-first
REM    stagger is needed: the worker's first bridge contact is Suno at
REM    step 03 (minutes away) and freepik at step 05a (later still), so
REM    all four can start together. Closing or Ctrl+C-ing this one
REM    window stops the whole run.
echo Starting one console for suno/freepik/chrome/worker. The cover
echo picker is its own window and will pop to the front when ready.
echo.
call npm run medieval

echo.
echo ===============================================================
echo   Run ended (worker exited or you stopped it). Log is above.
echo ===============================================================
pause
endlocal
