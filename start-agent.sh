#!/usr/bin/env bash
# ============================================================
#  LabelPress Agent v3.0 — Auto-Setup Edition
#  Supports: Linux (Ubuntu/Debian/Fedora/Arch), macOS
#
#  Usage:
#    ./start-agent.sh
#    ./start-agent.sh --port 47474 --allow-origin "https://your-app.vercel.app"
#
# ============================================================
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
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$SCRIPT_DIR/agent"

echo ""
echo "  ============================================================"
echo "   LabelPress Universal Print Bridge  v3.0"
echo "   Auto-Setup Edition"
echo "  ============================================================"
echo ""
echo "   Listening on: http://localhost:47474"
echo "   Keep this window open while printing."
echo "  ============================================================"
echo ""

# ── HELPER: Install Node.js automatically ────────────────────────────────────
install_nodejs() {
    echo "  [*] Node.js is NOT installed. Installing Node.js LTS automatically..."
    echo ""

    OS="$(uname -s)"

    # ── macOS ─────────────────────────────────────────────────────────────────
    if [ "$OS" = "Darwin" ]; then
        if command -v brew &>/dev/null; then
            echo "  [*] Using Homebrew to install Node.js LTS..."
            brew install node@22 || brew install node
            brew link --overwrite node@22 2>/dev/null || true
        else
            echo "  [*] Homebrew not found. Installing Homebrew first..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            # Add brew to PATH for Apple Silicon
            if [ -f "/opt/homebrew/bin/brew" ]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
                echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
            fi
            brew install node@22 || brew install node
            brew link --overwrite node@22 2>/dev/null || true
        fi
        return 0
    fi

    # ── Linux ─────────────────────────────────────────────────────────────────
    if [ "$OS" = "Linux" ]; then

        # ── Method 1: nvm (Node Version Manager) — works on ALL Linux distros ──
        if ! command -v nvm &>/dev/null && [ ! -f "$HOME/.nvm/nvm.sh" ]; then
            echo "  [*] Installing nvm (Node Version Manager)..."
            curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
        fi

        # Source nvm into this shell session
        export NVM_DIR="$HOME/.nvm"
        if [ -f "$NVM_DIR/nvm.sh" ]; then
            # shellcheck source=/dev/null
            source "$NVM_DIR/nvm.sh"
            # Also persist nvm in shell profile for future sessions
            PROFILE_FILE=""
            if [ -f "$HOME/.zshrc" ];  then PROFILE_FILE="$HOME/.zshrc"
            elif [ -f "$HOME/.bashrc" ]; then PROFILE_FILE="$HOME/.bashrc"
            elif [ -f "$HOME/.profile" ]; then PROFILE_FILE="$HOME/.profile"
            fi
            if [ -n "$PROFILE_FILE" ]; then
                if ! grep -q 'NVM_DIR' "$PROFILE_FILE" 2>/dev/null; then
                    echo "" >> "$PROFILE_FILE"
                    echo '# nvm (Node Version Manager)' >> "$PROFILE_FILE"
                    echo 'export NVM_DIR="$HOME/.nvm"' >> "$PROFILE_FILE"
                    echo '[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"' >> "$PROFILE_FILE"
                    echo '[ -s "$NVM_DIR/bash_completion" ] && source "$NVM_DIR/bash_completion"' >> "$PROFILE_FILE"
                    echo "  [OK] Added nvm to $PROFILE_FILE for future sessions."
                fi
            fi
            echo "  [*] Installing latest Node.js LTS via nvm..."
            nvm install --lts
            nvm use --lts
            nvm alias default 'lts/*'
            echo "  [OK] Node.js LTS installed and set as default via nvm."
            return 0
        fi

        # ── Method 2: Package manager fallback (apt / dnf / pacman) ─────────
        echo "  [!] nvm setup failed, trying system package manager..."

        if command -v apt-get &>/dev/null; then
            echo "  [*] Detected Debian/Ubuntu — using NodeSource repository..."
            if command -v curl &>/dev/null; then
                curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
            else
                wget -qO- https://deb.nodesource.com/setup_lts.x | sudo -E bash -
            fi
            sudo apt-get install -y nodejs
        elif command -v dnf &>/dev/null; then
            echo "  [*] Detected Fedora/RHEL — using NodeSource repository..."
            curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
            sudo dnf install -y nodejs
        elif command -v yum &>/dev/null; then
            echo "  [*] Detected CentOS/RHEL (older) — using NodeSource repository..."
            curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
            sudo yum install -y nodejs
        elif command -v pacman &>/dev/null; then
            echo "  [*] Detected Arch Linux — installing Node.js via pacman..."
            sudo pacman -Sy --noconfirm nodejs npm
        elif command -v zypper &>/dev/null; then
            echo "  [*] Detected openSUSE — installing Node.js via zypper..."
            sudo zypper install -y nodejs
        else
            echo ""
            echo "  [ERR] Could not detect your Linux package manager."
            echo "  Please install Node.js LTS manually:"
            echo "    https://nodejs.org/en/download"
            echo "  Or use nvm:"
            echo "    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash"
            echo "    source ~/.bashrc && nvm install --lts"
            exit 1
        fi
        return 0
    fi

    echo "  [ERR] Unsupported operating system: $OS"
    exit 1
}

# ── STEP 1: Check / Install Node.js ─────────────────────────────────────────

# Source nvm if already installed (to pick up node installed by nvm)
export NVM_DIR="$HOME/.nvm"
if [ -f "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
fi

if ! command -v node &>/dev/null; then
    install_nodejs
fi

# Final check after potential install
if ! command -v node &>/dev/null; then
    echo ""
    echo "  [ERR] Node.js installation completed but 'node' command is still not found."
    echo "  Please CLOSE this terminal, open a NEW one, and run:"
    echo "      ./start-agent.sh"
    echo ""
    echo "  Or manually add Node.js to your PATH, then retry."
    exit 1
fi

NODE_VERSION=$(node --version)
echo "  [OK] Node.js $NODE_VERSION is ready."

# ── STEP 2: Check if npm is available ───────────────────────────────────────
if ! command -v npm &>/dev/null; then
    echo ""
    echo "  [ERR] npm is not installed or not in PATH."
    echo "  On Ubuntu/Debian, run: sudo apt-get install -y npm"
    echo "  On macOS: brew install node"
    exit 1
fi

NPM_VERSION=$(npm --version)
echo "  [OK] npm $NPM_VERSION is ready."

# ── STEP 3: Verify agent directory and package.json ─────────────────────────
if [ ! -d "$AGENT_DIR" ]; then
    echo ""
    echo "  [ERR] agent/ directory not found at: $AGENT_DIR"
    echo "  Make sure start-agent.sh is in the project root folder."
    exit 1
fi

if [ ! -f "$AGENT_DIR/package.json" ]; then
    echo ""
    echo "  [ERR] agent/package.json not found."
    echo "  Make sure start-agent.sh is in the project root folder."
    exit 1
fi

# ── STEP 4: Print USB device status (Linux only) ─────────────────────────────
if [ "$(uname -s)" = "Linux" ]; then
    if ls /dev/usb/lp* 2>/dev/null | grep -q .; then
        echo ""
        echo "  USB printer devices found:"
        ls -la /dev/usb/lp* 2>/dev/null
    else
        echo ""
        echo "  NOTE: No /dev/usb/lp* devices found."
        echo "  If your printer is plugged in, try: sudo modprobe usblp"
    fi
fi

# ── STEP 5: Run the agent via npm run agent ──────────────────────────────────
echo ""
echo "  [*] Starting LabelPress Agent..."
echo "      Directory : $AGENT_DIR"
echo "      Command   : npm run agent"
echo ""
echo "  ============================================================"
echo "    Agent is running. Keep this window open while printing."
echo "    Press Ctrl+C to stop."
echo "  ============================================================"
echo ""

cd "$AGENT_DIR"
exec npm run agent -- "$@"
