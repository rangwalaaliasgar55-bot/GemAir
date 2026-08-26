#!/usr/bin/env bash
# Create and push version tag to trigger .github/workflows/release.yml
set -euo pipefail
V="${1:-v2.5.1}"
git tag -a "$V" -m "GemAir $V"
git push origin "$V"
echo "Pushed $V — watch Actions → Build & Release"
echo "https://github.com/rangwalaaliasgar55-bot/GemAir/releases"
