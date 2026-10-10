#!/data/data/com.termux/files/usr/bin/bash
#
# Enable Cloudflare `workerd` on Termux/Android.
#
# The `workerd` npm package only ships glibc builds and rejects
# `process.platform === "android"`. This host has `glibc-runner`, so we:
#   1. download the linux-arm64 workerd binary via `npm pack`
#   2. patch it to use Termux's glibc loader (patchelf) via `grun`
#   3. wrap it in a script that re-enters `grun` (so Node can spawn it)
#   4. teach the `workerd` npm package the `android arm64 LE` platform key
#
# Run this after every `npm install` (npm prunes the manually added package).
# This is a local development workaround only; the deployment target is
# unmodified Cloudflare Workers.

set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GRUN="$PREFIX/bin/grun"

for tool in "$GRUN" "$PREFIX/glibc/bin/patchelf" "$PREFIX/bin/npm" "$PREFIX/bin/node"; do
  if [ ! -x "$tool" ]; then
    echo "error: '$tool' not found. Install with: pkg install glibc-runner nodejs-lts" >&2
    exit 1
  fi
done

if [ ! -d "$PROJECT_DIR/node_modules/workerd" ]; then
  echo "error: run 'npm install' first" >&2
  exit 1
fi

WORKERD_VERSION="$("$PREFIX/bin/node" -p "require('$PROJECT_DIR/node_modules/workerd/package.json').version")"
PKG_NAME="@cloudflare/workerd-linux-arm64"
PKG_DIR="$PROJECT_DIR/node_modules/$PKG_NAME"

echo "Installing $PKG_NAME@$WORKERD_VERSION ..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(
  cd "$tmp"
  "$PREFIX/bin/npm" pack "$PKG_NAME@$WORKERD_VERSION" >/dev/null
  tar xzf ./*.tgz
)

# Always start from a clean package directory so re-runs are safe.
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR"
cp -r "$tmp/package/." "$PKG_DIR/"

BIN_DIR="$PKG_DIR/bin"
mv "$BIN_DIR/workerd" "$BIN_DIR/workerd.real"

LD_FILE="$(ls "$PREFIX/glibc/lib/ld-"* | head -1)"
"$GRUN" "$PREFIX/glibc/bin/patchelf" \
  --set-rpath "$PREFIX/glibc/lib" \
  --set-interpreter "$LD_FILE" \
  "$BIN_DIR/workerd.real"

cat > "$BIN_DIR/workerd" <<EOF
#!$PREFIX/bin/bash
# Real egress needs a CA bundle workerd can read (the default Termux paths are
# not visible to the glibc loader's cert store).
export SSL_CERT_FILE="\${SSL_CERT_FILE:-$PREFIX/etc/tls/cert.pem}"
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
exec $GRUN "\$DIR/workerd.real" "\$@"
EOF
chmod +x "$BIN_DIR/workerd"

"$PREFIX/bin/node" -e '
const fs = require("fs");
const file = process.argv[1];
let src = fs.readFileSync(file, "utf8");
if (!src.includes("\"android arm64 LE\"")) {
  const before = src;
  src = src.replace(
    /(\s*)"linux arm64 LE": "@cloudflare\/workerd-linux-arm64",/,
    "$1\"linux arm64 LE\": \"@cloudflare/workerd-linux-arm64\",$1\"android arm64 LE\": \"@cloudflare/workerd-linux-arm64\",",
  );
  if (src === before) {
    console.error("error: could not patch workerd platform table");
    process.exit(1);
  }
  fs.writeFileSync(file, src);
}
' "$PROJECT_DIR/node_modules/workerd/lib/main.js"

echo -n "workerd ready: "
"$BIN_DIR/workerd" --version
