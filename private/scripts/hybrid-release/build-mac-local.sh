#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR/desktop"

echo "[mac] Build macOS installer on local machine"
pnpm run clean
pnpm exec tsc
pnpm exec vite build
pnpm exec electron-builder --mac --x64 --arm64 --publish never

echo "[mac] macOS artifacts ready in desktop/release"
