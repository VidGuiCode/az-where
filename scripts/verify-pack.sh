#!/usr/bin/env bash
# Post-pack verification: install the .tgz into a temp directory and smoke test
# both bin entries (`az-where` and `azw`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo "=== Packing ==="
TARBALL=$(npm pack 2>/dev/null | tail -1)
echo "  Packed: $TARBALL"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR" "$PROJECT_DIR/$TARBALL"' EXIT

echo ""
echo "=== Installing into temp directory ==="
cd "$TMPDIR"
npm init -y > /dev/null 2>&1
npm install "$PROJECT_DIR/$TARBALL" > /dev/null 2>&1
echo "  Installed successfully"

LONG_BIN="$TMPDIR/node_modules/.bin/az-where"
SHORT_BIN="$TMPDIR/node_modules/.bin/azw"

echo ""
echo "=== Smoke tests ==="

for BIN_NAME in az-where azw; do
  BIN="$TMPDIR/node_modules/.bin/$BIN_NAME"
  echo "-- $BIN_NAME --"

  VERSION=$("$BIN" --version 2>&1)
  echo "  version: $VERSION"

  HELP=$("$BIN" --help 2>&1)
  echo "$HELP" | grep -q "Commands" && echo "  help: OK" || { echo "  help: FAIL"; exit 1; }

  for cmd in where regions pick quota geos; do
    echo "$HELP" | grep -q "$cmd" && echo "  $cmd: OK" || { echo "  $cmd: FAIL"; exit 1; }
  done
done

echo ""
echo "All smoke tests passed."
