#!/bin/sh
# macOS: double-click this file in Finder to start the demo.
#
# Prefers the bundled single-file launcher (needs nothing installed). Falls back to Node,
# then to `npx serve`, because file:// breaks iframes and module loading (SPEC §8.2).

cd "$(dirname "$0")" || exit 1

if [ "$(uname -m)" = "arm64" ]; then
  BINARY="./demo-kiosk-macos-arm64"
else
  BINARY="./demo-kiosk-macos-x64"
fi

if [ -x "$BINARY" ]; then
  exec "$BINARY"
fi

if command -v node >/dev/null 2>&1; then
  echo "Bundled launcher not found; using Node."
  exec node ./serve.mjs
fi

if command -v npx >/dev/null 2>&1; then
  echo "Bundled launcher and Node not found; trying npx serve (needs a network connection)."
  exec npx --yes serve -l 8080 .
fi

echo "Could not start a local server."
echo "Install Node, or rebuild the bundle on a machine with Go so the launcher binary is included."
read -r _
