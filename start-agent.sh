#!/bin/bash
# LabelPress Agent v3.0 - Universal Linux / macOS / Windows startup script
# Usage: ./start-agent.sh
#        ./start-agent.sh --port 47474 --allow-origin "https://your-app.vercel.app"
#
# === Linux USB Printer Access (run ONCE before first use if needed) ===
#
# If /api/usb-devices returns devices but /api/print-usb gives "Permission denied":
#
#   sudo bash -c 'echo "SUBSYSTEM==\"usb\", KERNEL==\"lp[0-9]*\", MODE=\"0666\", TAG+=\"uaccess\"" > /etc/udev/rules.d/99-usb-printer.rules'
#   sudo udevadm control --reload-rules && sudo udevadm trigger
#   # Then unplug and replug your printer
#
# If the printer appears via lsusb but /dev/usb/lp0 doesn't exist:
#   sudo modprobe usblp
#
# If usblp is blacklisted (e.g. for WebUSB):
#   sudo modprobe usblp   # re-enable it for agent-based raw access

echo ""
echo "  LabelPress Agent v3.0 (Universal)"
echo "  ──────────────────────────────────"
echo "  Cross-platform: Linux, macOS, Windows"
echo "  Direct USB + Spooler / CUPS raw printing"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "  ERROR: Node.js is not installed or not in PATH."
  echo "  Install with: sudo apt install nodejs  (Ubuntu/Debian)"
  echo "                sudo dnf install nodejs   (Fedora)"
  echo "                brew install node         (macOS)"
  exit 1
fi

NODE_VERSION=$(node --version)
echo "  Node.js: $NODE_VERSION"
echo ""

# Print USB device status
if ls /dev/usb/lp* 2>/dev/null | grep -q .; then
  echo "  USB printer devices found:"
  ls -la /dev/usb/lp* 2>/dev/null
  echo ""
else
  echo "  NOTE: No /dev/usb/lp* devices found."
  echo "  If your printer is plugged in, try: sudo modprobe usblp"
  echo ""
fi

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node "$SCRIPT_DIR/agent/labelpress-agent.mjs" "$@"
