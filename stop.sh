#!/data/data/com.termux/files/usr/bin/bash
# Stop a mobile-cfy server started by start.sh (including one left in the
# background), and release the wake lock it took.
set -uo pipefail
cd "$(dirname "$0")"

stopped=0

if [ -f .server.pid ]; then
  pid="$(cat .server.pid 2>/dev/null || true)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null && stopped=1
  fi
  rm -f .server.pid
fi

# Catch a server started without start.sh, but never touch an unrelated process:
# match the full command line, not just the name.
for pid in $(pgrep -f 'node .*server\.js' 2>/dev/null || true); do
  [ "$pid" = "$$" ] && continue
  if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'server\.js'; then
    kill "$pid" 2>/dev/null && stopped=1
  fi
done

termux-wake-unlock 2>/dev/null || true

if [ "$stopped" = 1 ]; then
  echo "mobile-cfy stopped."
else
  echo "no mobile-cfy server was running."
fi

# Leaving a prompt queued in ComfyUI would make the next run look stuck, so say
# how to clear it rather than doing it silently.
echo "if ComfyUI still shows a prompt running, clear it with:"
echo "  curl -X POST http://COMFY_HOST:8188/queue  -H 'Content-Type: application/json' -d '{\"clear\":true}'"
echo "  curl -X POST http://COMFY_HOST:8188/interrupt"