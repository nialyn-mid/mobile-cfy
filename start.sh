#!/data/data/com.termux/files/usr/bin/bash
# mobile-cfy launcher. Start the server and open the web UI in the Termux browser.
#
#   bash start.sh            run in the foreground (Ctrl-C stops it)
#   bash start.sh --no-open  do not open a browser window
#   PORT=4000 bash start.sh  override the port from config.json
#
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed.  Run:  pkg install nodejs-lts" >&2
  exit 1
fi

# A batch can run for many minutes; without this the screen sleeps and the phone
# may throttle the CPU. Best-effort - not every Termux build has the tool.
termux-wake-lock 2>/dev/null || true

if [ ! -f .env ] || ! grep -Eq '^AUTH_TOKEN=..+' .env; then
  cat >&2 <<'WARN'
warning: .env has no AUTH_TOKEN, so ComfyUI will reject every request.

  The ComfyUI-Login extension prints this line at startup:
      To see the GUI go to: ... For direct API calls, use token=$2b$...
  Copy that hash into .env as a single line:
      AUTH_TOKEN=$2b$12$....
WARN
fi

# Read the port the server will actually bind to, so the browser never lands on
# the wrong URL after someone edits config.json.
detect_port() {
  PORT="$(node --input-type=module -e '
    import { init, config } from "./lib/config.js";
    init(process.cwd());
    process.stdout.write(String(config().server.port));
  ' 2>/dev/null || true)"
  echo "${PORT:-3081}"
}
port="$(detect_port)"

node server.js &
server_pid=$!
echo "$server_pid" > .server.pid

cleanup() {
  termux-wake-unlock 2>/dev/null || true
  rm -f .server.pid
}
trap cleanup EXIT

# Wait for the port to answer rather than sleeping blind - on a cold phone the
# first start also has to read and merge the config.
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if [ "${1:-}" != "--no-open" ]; then
  termux-open-url "http://127.0.0.1:${port}" >/dev/null 2>&1 || true
fi

# Reach the UI from another device on the same wifi using the phone's LAN address.
ip="$(ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]\{1,3\}\.[0-9.]\{1,3\}\.[0-9.]\{1,3\}\.[0-9.]\{1,3\}\).*/\1/p' | head -1)"
echo
echo "  mobile-cfy  http://127.0.0.1:${port}"
[ -n "$ip" ] && echo "  from a desktop on the same wifi:  http://${ip}:${port}"
echo "  stop with Ctrl-C, or: bash stop.sh"
echo

wait "$server_pid"