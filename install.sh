#!/usr/bin/env bash
# Install the JoyCode → OpenAI-compatible bridge as a launchd service on macOS.
#
# Usage:
#   ./install.sh                 # install both agents (JoyCode.app autostart + shim)
#   ./install.sh --shim-only     # only the shim (if JoyCode.app starts some other way)
#   ./install.sh --uninstall     # unload and remove both agents
#
# Env overrides:
#   JOYCODE_SHIM_TOKEN   bearer token downstream clients must send (default: generated)
#   JOYCODE_SHIM_PORT    listen port (default 18888)
#   NODE_BIN             node executable (default: `command -v node`)
#   LABEL_PREFIX         launchd label prefix (default: dev.joycode-bridge)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/joycode-bridge"
LABEL_PREFIX="${LABEL_PREFIX:-dev.joycode-bridge}"

SHIM_LABEL="$LABEL_PREFIX.shim"
APP_LABEL="$LABEL_PREFIX.app"
SHIM_PLIST="$LAUNCHD_DIR/$SHIM_LABEL.plist"
APP_PLIST="$LAUNCHD_DIR/$APP_LABEL.plist"

MODE="install"
case "${1:-}" in
  --shim-only) MODE="shim-only" ;;
  --uninstall) MODE="uninstall" ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 64 ;;
esac

if [[ "$MODE" == "uninstall" ]]; then
  for label in "$SHIM_LABEL" "$APP_LABEL"; do
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$LAUNCHD_DIR/$label.plist"
    echo "removed $label"
  done
  exit 0
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found; install Node.js >= 22 or set NODE_BIN" >&2
  exit 1
fi

if [[ ! -d "/Applications/JoyCode.app" ]]; then
  echo "warning: /Applications/JoyCode.app not found." >&2
  echo "         The shim will start but report the upstream proxy as unavailable." >&2
fi

TOKEN="${JOYCODE_SHIM_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  TOKEN="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 32)"
  echo "no JOYCODE_SHIM_TOKEN given; generated one:"
  echo "  $TOKEN"
fi
PORT="${JOYCODE_SHIM_PORT:-18888}"

mkdir -p "$LAUNCHD_DIR" "$LOG_DIR"

# render <template> <dest> <label>
render() {
  sed \
    -e "s|__LABEL__|$3|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__SCRIPT__|$ROOT/scripts/joycode-openai-shim.mjs|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__TOKEN__|$TOKEN|g" \
    "$1" >"$2"
}

render "$ROOT/launchd/shim.plist.template" "$SHIM_PLIST" "$SHIM_LABEL"
plutil -lint "$SHIM_PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$SHIM_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$SHIM_PLIST"
echo "loaded $SHIM_LABEL on port $PORT"

if [[ "$MODE" == "install" ]]; then
  render "$ROOT/launchd/app.plist.template" "$APP_PLIST" "$APP_LABEL"
  plutil -lint "$APP_PLIST" >/dev/null
  launchctl bootout "gui/$(id -u)/$APP_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$APP_PLIST"
  echo "loaded $APP_LABEL (JoyCode.app autostart)"
fi

echo
echo "waiting for the upstream proxy..."
for _ in $(seq 1 20); do
  sleep 2
  if curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" >"$LOG_DIR/health.json" 2>/dev/null; then
    cat "$LOG_DIR/health.json"
    echo
    echo "ready. try:"
    echo "  curl -s -X POST http://127.0.0.1:$PORT/v1/chat/completions \\"
    echo "    -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' \\"
    echo "    -d '{\"model\":\"GLM-5.3\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
    exit 0
  fi
done

echo "shim is up but the upstream proxy is not reachable yet." >&2
echo "check: tail -20 $LOG_DIR/shim.err.log" >&2
echo "       tail -5 ~/.joycode/logs/joycode-app.log" >&2
exit 1
