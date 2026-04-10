#!/bin/bash
# Verifies all version strings match before a release
# Usage: ./scripts/version-check.sh 1.2.2

TARGET=$1
if [ -z "$TARGET" ]; then
  echo "Usage: ./scripts/version-check.sh <version>"
  exit 1
fi

FILES=(
  "packages/worker/package.json"
  "packages/cli/package.json"
  "plugins/claude-lore/.claude-plugin/plugin.json"
  ".claude-plugin/marketplace.json"
)

CODE_FILES=(
  "packages/worker/src/index.ts"
  "packages/worker/src/mcp/server.ts"
  "packages/cli/src/index.ts"
  "packages/cli/src/help.ts"
)

PASS=true

for f in "${FILES[@]}"; do
  if grep -q "\"version\": \"$TARGET\"" "$f"; then
    echo "✓ $f"
  else
    CURRENT=$(grep '"version"' "$f" | head -1 | sed 's/.*: "//;s/".*//')
    echo "✗ $f — found $CURRENT, expected $TARGET"
    PASS=false
  fi
done

for f in "${CODE_FILES[@]}"; do
  if grep -q "$TARGET" "$f"; then
    echo "✓ $f"
  else
    echo "✗ $f — $TARGET not found"
    PASS=false
  fi
done

echo ""
if $PASS; then
  echo "✓ All version strings match $TARGET — safe to tag"
else
  echo "✗ Version mismatch — fix before tagging"
  exit 1
fi
