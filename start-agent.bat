@echo off
title LabelPress Print Agent v3.0 (Universal)
color 0A
echo.
echo  ============================================================
echo    LabelPress Universal Print Bridge  v3.0
echo  ============================================================
echo.
echo    This window bridges your web app to any printer.
echo    Cross-platform: Windows, Linux, macOS.
echo    Direct USB (no driver setup) + Spooler / CUPS.
echo.
echo    Listening on:  http://localhost:47474
echo    Remote access: http://^<your-ip^>:47474
echo.
echo    Endpoints:
echo      GET  /api/health
echo      GET  /api/printers
echo      GET  /api/usb-devices
echo      POST /api/print-auto     (Universal: Auto-detects direct USB or Spooler)
echo      POST /api/print          (Spooler / CUPS by printer name)
echo      POST /api/print-usb-win  (Windows direct USB \\?\ device path)
echo      POST /api/print-usb      (Linux /dev/usb/lp* direct)
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
