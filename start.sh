#!/data/data/com.termux/files/usr/bin/bash
# mobile-cfy launcher. Starts the server in the foreground.
#
#   bash start.sh            run in the foreground (Ctrl-C stops it)
#   bash start.sh --open     also open the web UI in the browser
#   bash start.sh --no-open  accepted and ignored - opening is off by default
#
# Opening the browser is opt-in now. Doing it on every start threw the Termux
# session behind a page nobody had asked for yet, which on a phone means losing
# sight of the log the server is writing into at the exact moment you start it.
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

# Opening the browser is opt-in. --no-open is still accepted, so an old habit or
# a saved command line keeps working rather than failing on an unknown flag.
open_ui=false
for arg in "$@"; do
  case "$arg" in
    --open)    open_ui=true ;;
    --no-open) open_ui=false ;;
    *) echo "warning: ignoring unknown option: $arg" >&2 ;;
  esac
done

if [ "$open_ui" = true ]; then
  termux-open-url "http://127.0.0.1:${port}" >/dev/null 2>&1 || true
fi

# Reach the UI from another device on the same wifi using the phone's LAN address.
ip="$(ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]\{1,3\}\.[0-9.]\{1,3\}\.[0-9.]\{1,3\}\.[0-9.]\{1,3\}\).*/\1/p' | head -1)"
echo
echo "  mobile-cfy  http://127.0.0.1:${port}"
[ -n "$ip" ] && echo "  from a desktop on the same wifi:  http://${ip}:${port}"
echo "  open the page:  bash start.sh --open   (or just tap the link above)"
echo "  stop with Ctrl-C, or: bash stop.sh"
echo

wait "$server_pid"