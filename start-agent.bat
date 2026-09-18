@echo off
title LabelPress Print Agent
echo ============================================================
echo   LabelPress Local Print Bridge
echo   Connects web browser directly to Windows Print Spooler
echo ============================================================
echo.
node "%~dp0agent\labelpress-agent.mjs"
if errorlevel 1 (
  echo.
  echo Agent encountered an error. Press any key to exit.
  pause >nul
)
