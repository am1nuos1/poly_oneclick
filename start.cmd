@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>&1
if not errorlevel 1 goto node_ready
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE_EXE%" goto node_ready
echo ERROR: Node.js 24 or newer was not found.
echo Install Node.js, then double-click start.cmd again.
pause
exit /b 1

:node_ready

if not exist "node_modules\@polymarket\client\package.json" (
  echo ERROR: Dependencies are missing. Run npm install once in this folder.
  pause
  exit /b 1
)

if not exist "dist\main.js" (
  echo ERROR: The program is not built. Run npm run build once in this folder.
  pause
  exit /b 1
)

echo Starting with configuration from %CD%\config.txt
"%NODE_EXE%" --env-file=config.txt dist\main.js
set "PROGRAM_EXIT=%ERRORLEVEL%"

echo.
echo Program stopped with exit code %PROGRAM_EXIT%.
pause
exit /b %PROGRAM_EXIT%
