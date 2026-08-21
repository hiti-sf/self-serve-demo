#!/bin/sh
# Linux: run ./launch.sh to start the demo.

cd "$(dirname "$0")" || exit 1

if [ -x ./demo-kiosk-linux-x64 ]; then
  exec ./demo-kiosk-linux-x64
fi

if command -v node >/dev/null 2>&1; then
  exec node ./serve.mjs
fi

if command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l 8080 .
fi

echo "Could not start a local server. Install Node or rebuild with Go available."
