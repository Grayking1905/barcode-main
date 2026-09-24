@echo off
title LabelPress Print Agent v2.0
color 0A
echo.
echo  ============================================================
echo    LabelPress Local Print Bridge  v2.0
echo  ============================================================
echo.
echo    This window bridges your web app to the printer.
echo    Keep it open while printing.
echo.
echo    Listening on:  http://localhost:47474
echo    Remote access: http://^<your-ip^>:47474
echo.
echo    Endpoints:
echo      GET  /api/health
echo      GET  /api/printers
echo      GET  /api/usb-devices
echo      POST /api/print          (Windows Spooler)
echo      POST /api/print-usb-win  (Raw USB port)
echo.
echo  ============================================================
echo.

node "%~dp0agent\labelpress-agent.mjs" %*

if errorlevel 1 (
  echo.
  echo  Agent stopped with an error. Check the output above.
  echo  Press any key to exit.
  pause >nul
)
