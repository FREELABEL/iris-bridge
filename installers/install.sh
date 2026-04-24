#!/bin/bash
# ─────────────────────────────────────────────────────────────
# IRIS Compute Node — One-Line Installer (macOS)
#
# Usage:
#   curl -fsSL https://heyiris.io/install-daemon | bash
#   bash install.sh --key node_live_xxx
#   bash install.sh --key node_live_xxx --api https://iris-api.freelabel.net
#
# What this does:
#   1. Clones the daemon code to ~/.iris/daemon/
#   2. Installs Node.js dependencies
#   3. Writes config to ~/.iris/config.json
#   4. Runs hardware profiling
#   5. Installs a macOS LaunchAgent (auto-start on login)
#   6. Starts the daemon
#
# What this does NOT do:
#   - No root/sudo required
#   - No system-level daemon (user-level LaunchAgent only)
#   - No Docker dependency
#   - No modifications outside ~/.iris/ and ~/Library/LaunchAgents/
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Constants ────────────────────────────────────────────────

IRIS_DIR="${HOME}/.iris"
DAEMON_DIR="${IRIS_DIR}/daemon"
LOGS_DIR="${IRIS_DIR}/logs"
DATA_DIR="${IRIS_DIR}/data"
CONFIG_FILE="${IRIS_DIR}/config.json"
PLIST_NAME="io.heyiris.daemon.plist"
PLIST_DEST="${HOME}/Library/LaunchAgents/${PLIST_NAME}"
REPO_URL="https://github.com/FREELABEL/iris-daemon.git"
DEFAULT_API_URL="https://iris-api.freelabel.net"
MIN_NODE_VERSION=18
HEALTH_PORT=3200

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ─── Banner ───────────────────────────────────────────────────

echo ""
echo -e "${CYAN}${BOLD}"
cat << 'BANNER'
  ╦╦═╗╦╔═╗   ╔═╗╔═╗╔╦╗╔═╗╦ ╦╔╦╗╔═╗
  ║╠╦╝║╚═╗   ║  ║ ║║║║╠═╝║ ║ ║ ║╣
  ╩╩╚═╩╚═╝   ╚═╝╚═╝╩ ╩╩  ╚═╝ ╩ ╚═╝
BANNER
echo -e "${NC}"
echo -e "  ${BOLD}Sovereign Distributed Compute Node${NC}"
echo -e "  Your hardware. Your data. Your cloud."
echo ""

# ─── Parse Arguments ──────────────────────────────────────────

API_KEY=""
API_URL="${DEFAULT_API_URL}"
PUSHER_KEY=""
PUSHER_CLUSTER="us2"
MAX_CPU=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key)     API_KEY="$2"; shift 2 ;;
    --api)     API_URL="$2"; shift 2 ;;
    --pusher-key) PUSHER_KEY="$2"; shift 2 ;;
    --pusher-cluster) PUSHER_CLUSTER="$2"; shift 2 ;;
    --max-cpu) MAX_CPU="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: bash install.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --key KEY          Node API key (required, or set IRIS_NODE_KEY env var)"
      echo "  --api URL          Hub API URL (default: ${DEFAULT_API_URL})"
      echo "  --pusher-key KEY   Pusher app key for real-time communication"
      echo "  --pusher-cluster C Pusher cluster (default: us2)"
      echo "  --max-cpu PCT      Max CPU threshold before rejecting tasks (e.g., 70)"
      echo "  --help             Show this help"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Run with --help for usage."
      exit 1
      ;;
  esac
done

# ─── OS Check ─────────────────────────────────────────────────

OS="$(uname -s)"
if [ "${OS}" != "Darwin" ]; then
  echo -e "${RED}Error: This installer currently supports macOS only.${NC}"
  echo "Linux and Windows support coming soon."
  echo ""
  echo "For manual installation on ${OS}:"
  echo "  git clone ${REPO_URL} ~/.iris/daemon"
  echo "  cd ~/.iris/daemon && npm install --production"
  echo "  node daemon.js --api-key YOUR_KEY"
  exit 1
fi

echo -e "${GREEN}[1/8]${NC} macOS detected ($(uname -m))"

# ─── Node.js Check ────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo -e "${RED}Error: Node.js is not installed.${NC}"
  echo ""
  echo "Install Node.js 20 via Homebrew:"
  echo -e "  ${CYAN}brew install node@20${NC}"
  echo ""
  echo "Or via nvm:"
  echo -e "  ${CYAN}curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash${NC}"
  echo -e "  ${CYAN}nvm install 20${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "${NODE_VERSION}" -lt "${MIN_NODE_VERSION}" ]; then
  echo -e "${RED}Error: Node.js ${MIN_NODE_VERSION}+ required (found v$(node -v))${NC}"
  echo "Upgrade: brew install node@20"
  exit 1
fi

echo -e "${GREEN}[2/8]${NC} Node.js $(node -v) found"

# ─── Git Check ────────────────────────────────────────────────

if ! command -v git &>/dev/null; then
  echo -e "${RED}Error: git is not installed.${NC}"
  echo "Install: xcode-select --install"
  exit 1
fi

# ─── API Key ──────────────────────────────────────────────────

if [ -z "${API_KEY}" ]; then
  API_KEY="${IRIS_NODE_KEY:-}"
fi

if [ -z "${API_KEY}" ]; then
  # Check existing config
  if [ -f "${CONFIG_FILE}" ]; then
    EXISTING_KEY=$(node -e "try { const c = require('${CONFIG_FILE}'); if (c.node_api_key) console.log(c.node_api_key); } catch {}" 2>/dev/null || true)
    if [ -n "${EXISTING_KEY}" ]; then
      echo -e "${YELLOW}Using existing API key from ${CONFIG_FILE}${NC}"
      API_KEY="${EXISTING_KEY}"
    fi
  fi
fi

if [ -z "${API_KEY}" ]; then
  echo ""
  echo -e "${BOLD}Enter your Node API key:${NC}"
  echo -e "  (Get one at ${CYAN}https://web.heyiris.io/settings/compute${NC})"
  echo -n "  Key: "
  read -r API_KEY

  if [ -z "${API_KEY}" ]; then
    echo -e "${RED}Error: API key is required.${NC}"
    exit 1
  fi
fi

echo -e "${GREEN}[3/8]${NC} API key configured"

# ─── Create Directories ──────────────────────────────────────

mkdir -p "${IRIS_DIR}" "${LOGS_DIR}" "${DATA_DIR}"

echo -e "${GREEN}[4/8]${NC} Created ~/.iris/ directory structure"

# ─── Clone/Update Daemon Code ─────────────────────────────────

if [ -d "${DAEMON_DIR}/.git" ]; then
  echo -e "${YELLOW}  Updating existing daemon code...${NC}"
  cd "${DAEMON_DIR}"
  git pull --ff-only origin main 2>/dev/null || {
    echo -e "${YELLOW}  Git pull failed, re-cloning...${NC}"
    cd "${IRIS_DIR}"
    rm -rf "${DAEMON_DIR}"
    git clone --depth 1 "${REPO_URL}" "${DAEMON_DIR}"
  }
else
  if [ -d "${DAEMON_DIR}" ]; then
    rm -rf "${DAEMON_DIR}"
  fi
  git clone --depth 1 "${REPO_URL}" "${DAEMON_DIR}"
fi

cd "${DAEMON_DIR}"
npm install --production --silent 2>/dev/null || npm install --production

echo -e "${GREEN}[5/8]${NC} Daemon code installed"

# ─── Write Config ─────────────────────────────────────────────

# Preserve existing config values if upgrading
EXISTING_PAUSED="false"
EXISTING_MAX_CPU="null"
if [ -f "${CONFIG_FILE}" ]; then
  EXISTING_PAUSED=$(node -e "try { const c = require('${CONFIG_FILE}'); console.log(c.paused || false); } catch { console.log(false); }" 2>/dev/null)
  EXISTING_MAX_CPU=$(node -e "try { const c = require('${CONFIG_FILE}'); console.log(c.max_cpu_threshold || 'null'); } catch { console.log('null'); }" 2>/dev/null)
fi

# Use provided values or existing ones
if [ -n "${MAX_CPU}" ]; then
  EXISTING_MAX_CPU="${MAX_CPU}"
fi

node -e "
const config = {
  node_api_key: $(node -e "process.stdout.write(JSON.stringify('${API_KEY}'))"),
  iris_api_url: $(node -e "process.stdout.write(JSON.stringify('${API_URL}'))"),
  pusher_key: $(node -e "process.stdout.write(JSON.stringify('${PUSHER_KEY}'))") || undefined,
  pusher_cluster: '${PUSHER_CLUSTER}',
  paused: ${EXISTING_PAUSED},
  max_cpu_threshold: ${EXISTING_MAX_CPU} === 'null' ? null : parseInt('${EXISTING_MAX_CPU}', 10) || null
};
// Remove undefined keys
Object.keys(config).forEach(k => config[k] === undefined && delete config[k]);
require('fs').writeFileSync('${CONFIG_FILE}', JSON.stringify(config, null, 2) + '\n');
"

echo -e "${GREEN}[6/8]${NC} Config written to ~/.iris/config.json"

# ─── Hardware Profile ─────────────────────────────────────────

echo -e "${YELLOW}  Detecting hardware...${NC}"
node -e "
  const { detectProfile } = require('./daemon/hardware-profile');
  detectProfile({ force: true }).then(p => {
    console.log('  CPU: ' + p.cpu.model + ' (' + p.cpu.cores + ' cores)');
    console.log('  RAM: ' + p.ram.total_gb + ' GB');
    if (p.gpu.available) console.log('  GPU: ' + p.gpu.model + ' (' + p.gpu.type + ')');
    if (p.ollama.available) console.log('  Ollama: ' + p.ollama.model_count + ' model(s)');
  }).catch(err => {
    console.log('  (hardware profiling skipped: ' + err.message + ')');
  });
" 2>/dev/null || echo -e "  ${YELLOW}(hardware profiling skipped)${NC}"

# ─── Install LaunchAgent ──────────────────────────────────────

# Unload existing LaunchAgent if present
if launchctl list | grep -q "io.heyiris.daemon" 2>/dev/null; then
  launchctl unload "${PLIST_DEST}" 2>/dev/null || true
fi

# Copy wrapper script
cp "${DAEMON_DIR}/installers/macos/iris-daemon-wrapper.sh" "${IRIS_DIR}/iris-daemon-wrapper.sh"
chmod +x "${IRIS_DIR}/iris-daemon-wrapper.sh"

# Generate plist from template (replace __HOME__ placeholder)
mkdir -p "${HOME}/Library/LaunchAgents"
sed "s|__HOME__|${HOME}|g" "${DAEMON_DIR}/installers/macos/${PLIST_NAME}" > "${PLIST_DEST}"

# Load the LaunchAgent
launchctl load "${PLIST_DEST}"

echo -e "${GREEN}[7/8]${NC} LaunchAgent installed (auto-starts on login)"

# ─── Create CLI Symlink ───────────────────────────────────────

# Create iris-daemon CLI command
SYMLINK_TARGET="/usr/local/bin/iris-daemon"
if [ -w "/usr/local/bin" ] || [ -w "$(dirname "${SYMLINK_TARGET}")" ]; then
  ln -sf "${DAEMON_DIR}/daemon.js" "${SYMLINK_TARGET}" 2>/dev/null || true
  echo -e "${GREEN}[8/8]${NC} CLI installed: iris-daemon"
else
  # Fall back to ~/.local/bin if /usr/local/bin isn't writable
  mkdir -p "${HOME}/.local/bin"
  ln -sf "${DAEMON_DIR}/daemon.js" "${HOME}/.local/bin/iris-daemon" 2>/dev/null || true
  echo -e "${GREEN}[8/8]${NC} CLI installed: ~/.local/bin/iris-daemon"
  if [[ ":${PATH}:" != *":${HOME}/.local/bin:"* ]]; then
    echo -e "  ${YELLOW}Add to your shell profile: export PATH=\"\${HOME}/.local/bin:\${PATH}\"${NC}"
  fi
fi

# ─── Verify ───────────────────────────────────────────────────

echo ""
echo -e "${YELLOW}  Waiting for daemon to start...${NC}"
sleep 4

HEALTH_OK=false
for i in 1 2 3; do
  if curl -sf "http://localhost:${HEALTH_PORT}/health" >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 2
done

echo ""
echo -e "${CYAN}${BOLD}"
echo "  ┌─────────────────────────────────────────┐"

if [ "${HEALTH_OK}" = true ]; then
  HEALTH_JSON=$(curl -sf "http://localhost:${HEALTH_PORT}/health" 2>/dev/null || echo '{}')
  NODE_NAME=$(echo "${HEALTH_JSON}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).node_name||'unknown')}catch{console.log('unknown')}})" 2>/dev/null || echo "unknown")

  echo "  │   IRIS Compute Node — ONLINE             │"
  echo "  ├─────────────────────────────────────────┤"
  printf "  │  Node:  %-33s│\n" "${NODE_NAME}"
  printf "  │  Hub:   %-33s│\n" "$(echo "${API_URL}" | head -c 33)"
  printf "  │  Port:  %-33s│\n" "${HEALTH_PORT}"
else
  echo "  │   IRIS Compute Node — STARTING           │"
  echo "  ├─────────────────────────────────────────┤"
  echo "  │  Daemon is starting up...                │"
  echo "  │  Check logs: tail -f ~/.iris/logs/       │"
fi

echo "  └─────────────────────────────────────────┘"
echo -e "${NC}"

echo -e "${BOLD}Commands:${NC}"
echo "  iris-daemon status     Show daemon status"
echo "  iris-daemon pause      Pause task processing"
echo "  iris-daemon resume     Resume task processing"
echo ""
echo -e "${BOLD}Files:${NC}"
echo "  ~/.iris/config.json    Configuration"
echo "  ~/.iris/status.json    Live status (for menu bar)"
echo "  ~/.iris/logs/          Daemon logs"
echo ""
echo -e "${BOLD}Uninstall:${NC}"
echo "  bash ~/.iris/daemon/installers/uninstall.sh"
echo ""
echo -e "${GREEN}${BOLD}Your MacBook is now a sovereign compute node.${NC}"
echo ""
