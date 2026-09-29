@echo off
setlocal EnableDelayedExpansion
title LabelPress Print Agent v3.0 — Auto-Setup
color 0A

echo.
echo  ============================================================
echo    LabelPress Universal Print Bridge  v3.0
echo    Auto-Setup Edition  (Node.js not required pre-installed)
echo  ============================================================
echo.
echo    This window bridges your web app to any printer.
echo    Direct USB (no driver setup) + Spooler / CUPS.
echo.
echo    Listening on:  http://localhost:47474
echo  ============================================================
echo.

:: ── STEP 1: Check if we are running as Administrator ─────────────────────────
net session >nul 2>&1
if %errorlevel% NEQ 0 (
    echo  [*] Requesting Administrator privileges to set PATH and install Node.js...
    echo      This is required only once. Please click "Yes" on the UAC prompt.
    echo.
    :: Re-launch this script elevated
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs -Wait"
    exit /b 0
)

:: ── STEP 2: Check if Node.js is installed ────────────────────────────────────
node --version >nul 2>&1
if %errorlevel% EQU 0 (
    for /f "delims=" %%V in ('node --version') do set "NODE_VER=%%V"
    echo  [OK] Node.js is already installed: !NODE_VER!
    goto :run_agent
)

:: ── STEP 3: Node.js is missing — auto-install Node.js LTS via winget ─────────
echo  [*] Node.js is NOT installed. Installing Node.js LTS automatically...
echo.

:: Try winget first (Windows 10/11 modern App Installer)
winget --version >nul 2>&1
if %errorlevel% EQU 0 (
    echo  [*] Using winget to install Node.js LTS...
    winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
    if !errorlevel! EQU 0 (
        echo  [OK] Node.js LTS installed via winget.
        goto :refresh_path
    )
    echo  [!] winget install failed. Trying PowerShell download...
)

:: Fallback: Download and install Node.js LTS MSI via PowerShell ───────────────
echo  [*] Downloading Node.js LTS MSI installer from nodejs.org...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "try {" ^
  "  $releaseUrl = 'https://nodejs.org/dist/index.json';" ^
  "  $releases = (Invoke-RestMethod -Uri $releaseUrl) | Where-Object { $_.lts -and $_.lts -ne 'false' } | Select-Object -First 1;" ^
  "  $version = $releases.version;" ^
  "  $msiFile = if ([System.Environment]::Is64BitOperatingSystem) { \"node-$version-x64.msi\" } else { \"node-$version-x86.msi\" };" ^
  "  $url = \"https://nodejs.org/dist/$version/$msiFile\";" ^
  "  $dest = \"$env:TEMP\\$msiFile\";" ^
  "  Write-Host \"  [*] Downloading $url ...\";" ^
  "  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing;" ^
  "  Write-Host '  [*] Running installer silently (this may take 1-2 minutes)...';" ^
  "  $p = Start-Process msiexec.exe -ArgumentList \"/i `\"$dest`\" /qn ADDLOCAL=ALL\" -Wait -PassThru;" ^
  "  Remove-Item $dest -Force -ErrorAction SilentlyContinue;" ^
  "  if ($p.ExitCode -eq 0) { Write-Host '[OK] Node.js LTS installed successfully.' } else { throw \"MSI exit code: $($p.ExitCode)\" }" ^
  "} catch { Write-Host \"[ERR] $($_.Exception.Message)\"; exit 1 }"

if %errorlevel% NEQ 0 (
    echo.
    echo  [ERR] Automatic Node.js installation failed.
    echo.
    echo  Please install Node.js manually:
    echo    1. Open your browser and go to: https://nodejs.org
    echo    2. Download the LTS version (the button on the left)
    echo    3. Run the installer with default settings
    echo    4. Re-run this file (start-agent.bat)
    echo.
    pause
    exit /b 1
)

:: ── STEP 4: Refresh PATH to pick up the newly installed Node.js ──────────────
:refresh_path
echo.
echo  [*] Refreshing system PATH to include Node.js...

:: Read the updated system PATH from registry and apply to this session
for /f "usebackq skip=2 tokens=2*" %%A in (
    `reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`
) do (
    set "SYS_PATH=%%B"
)
for /f "usebackq skip=2 tokens=2*" %%A in (
    `reg query "HKCU\Environment" /v Path 2^>nul`
) do (
    set "USR_PATH=%%B"
)

:: Combine and apply to current process
if defined SYS_PATH (
    if defined USR_PATH (
        set "PATH=!SYS_PATH!;!USR_PATH!"
    ) else (
        set "PATH=!SYS_PATH!"
    )
)

:: Also explicitly add default Node.js install locations in case registry update is slow
set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;!PATH!"

:: Broadcast WM_SETTINGCHANGE so Explorer and new cmd windows see the new PATH
powershell -NoProfile -Command ^
  "[System.Environment]::SetEnvironmentVariable('Path',[System.Environment]::GetEnvironmentVariable('Path','Machine')+';'+[System.Environment]::GetEnvironmentVariable('Path','User'),'Process'); [void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.SystemInformation]::ComputerName | Out-Null; Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '[DllImport(\"user32.dll\",SetLastError=true,CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd,uint Msg,UIntPtr wParam,string lParam,uint fuFlags,uint uTimeout,out UIntPtr lpdwResult);' -ErrorAction SilentlyContinue; $result=[UIntPtr]::Zero; [Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xFFFF,0x001A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$result) | Out-Null" >nul 2>&1

:: Verify Node.js is now accessible
node --version >nul 2>&1
if %errorlevel% NEQ 0 (
    echo.
    echo  [WARN] Node.js was installed but 'node' command is still not found in PATH.
    echo  This can happen if the installer needs a fresh terminal session to take effect.
    echo.
    echo  Please close this window, open a NEW Command Prompt, and run:
    echo      start-agent.bat
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%V in ('node --version') do set "NODE_VER=%%V"
echo  [OK] Node.js !NODE_VER! is now ready.

:: ── STEP 5: Run the agent ────────────────────────────────────────────────────
:run_agent

:: Determine the root project directory (one level above this bat file's directory)
set "SCRIPT_DIR=%~dp0"
set "AGENT_DIR=%SCRIPT_DIR%agent"

:: Check agent directory exists
if not exist "%AGENT_DIR%\package.json" (
    echo.
    echo  [ERR] Cannot find agent\package.json
    echo  Expected at: %AGENT_DIR%\package.json
    echo  Make sure this start-agent.bat is in the project root folder.
    pause
    exit /b 1
)

echo.
echo  [*] Starting LabelPress Agent...
echo      Directory : %AGENT_DIR%
echo      Command   : npm run agent
echo.
echo  ============================================================
echo    Agent is running. Keep this window open while printing.
echo    Press Ctrl+C to stop.
echo  ============================================================
echo.

:: Change into the agent directory and run via npm run agent
cd /d "%AGENT_DIR%"
npm run agent %*

if errorlevel 1 (
    echo.
    echo  ============================================================
    echo  [!] Agent stopped with an error. Check the output above.
    echo  ============================================================
    echo.
    pause
)
