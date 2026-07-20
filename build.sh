#!/usr/bin/env bash
# Build the Firefox xpi package into dist/.
# Usage: ./build.sh
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT_DIR="dist"
OUT_FILE="$OUT_DIR/salesforce_spotlight-${VERSION}.xpi"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

zip -r -X "$OUT_FILE" \
  manifest.json \
  background.js \
  content.js \
  popup.html \
  popup.js \
  icons \
  -x '*.DS_Store'

echo ""
echo "Built: $OUT_FILE"
echo "Install (temporary): about:debugging → This Firefox → Load Temporary Add-on"
echo "Install (permanent, unsigned): Firefox Developer Edition/Nightly/ESR with"
echo "  about:config → xpinstall.signatures.required = false, then open the xpi."
