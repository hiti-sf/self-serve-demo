@echo off
REM Windows: double-click this file to start the demo.
REM
REM Prefers the bundled single-file launcher (needs nothing installed). Falls back to
REM Node, then to `npx serve`, because file:// breaks iframes and module loading (SPEC 8.2).

cd /d "%~dp0"

if exist "demo-kiosk-windows-x64.exe" (
  start "" "demo-kiosk-windows-x64.exe"
  exit /b 0
)

where node >nul 2>nul
if %ERRORLEVEL% == 0 (
  echo Bundled launcher not found; using Node.
  node serve.mjs
  exit /b 0
)

where npx >nul 2>nul
if %ERRORLEVEL% == 0 (
  echo Bundled launcher and Node not found; trying npx serve ^(needs a network connection^).
  npx --yes serve -l 8080 .
  exit /b 0
)

echo Could not start a local server.
echo Install Node, or rebuild the bundle on a machine with Go so the launcher binary is included.
pause
