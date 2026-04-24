#!/bin/sh
set -e

CONFIG_FILE="/app/.bridge-config.json"
KEY_FILE="/data/.bridge-api-key"

# ─── API Key: use env var, persisted file, or generate new one ───
if [ -n "$BRIDGE_API_KEY" ]; then
  API_KEY="$BRIDGE_API_KEY"
elif [ -f "$KEY_FILE" ]; then
  API_KEY=$(cat "$KEY_FILE")
else
  API_KEY=$(openssl rand -hex 16)
fi

# Persist the key for next restart
echo -n "$API_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"

# ─── Patch .bridge-config.json with runtime values ───
node -e "
  const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
  cfg.auth.apiKey = '$API_KEY';
  cfg.fileSystem.allowedRoots = ['/', '/data/'];
  cfg.fileSystem.executeTimeout = 60;
  cfg.fileSystem.executeMaxTimeout = 300;
  require('fs').writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2));
"

echo "Bridge API key: $(printf '%.8s' "$API_KEY")..."
echo "IRIS API URL: ${IRIS_API_URL:-https://web.heyiris.io}"

# ─── Restore any persistent PM2 processes ───
pm2 resurrect 2>/dev/null || true

# ─── Docker needs external binding (local installs default to 127.0.0.1) ───
export BRIDGE_BIND_HOST="${BRIDGE_BIND_HOST:-0.0.0.0}"
export BRIDGE_TOKEN_PATH="${BRIDGE_TOKEN_PATH:-/data/.bridge-token}"

# ─── Start the bridge ───
exec node index.js
