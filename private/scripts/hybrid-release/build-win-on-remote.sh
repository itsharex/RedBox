#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
REMOTE_HOST="${REDBOX_REMOTE_HOST:-jamdebian}"
REMOTE_WORKDIR="${REDBOX_REMOTE_WORKDIR:-/home/jam/build/redconvert-release}"

printf "[remote-win] Sync source to %s:%s\n" "$REMOTE_HOST" "$REMOTE_WORKDIR"
ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_WORKDIR/desktop'"
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='dist-electron' \
  --exclude='release' \
  "$ROOT_DIR/desktop/" "$REMOTE_HOST:$REMOTE_WORKDIR/desktop/"

printf "[remote-win] Build Windows installer on remote host\n"
ssh "$REMOTE_HOST" "bash -lc '
set -euo pipefail
cd $REMOTE_WORKDIR/desktop
pnpm install --frozen-lockfile
pnpm run clean
pnpm exec tsc
pnpm exec vite build
export WINEDEBUG=-all
export XDG_RUNTIME_DIR=\"/tmp/runtime-\$USER\"
mkdir -p \"\$XDG_RUNTIME_DIR\"
xvfb-run -a pnpm exec electron-builder --win --x64 --publish never
'"

LOCAL_WIN_DIR="$ROOT_DIR/artifacts/win-remote"
mkdir -p "$LOCAL_WIN_DIR"

printf "[remote-win] Fetch artifacts back to local: %s\n" "$LOCAL_WIN_DIR"
rsync -az \
  --include='*/' \
  --include='*.exe' \
  --include='*.blockmap' \
  --include='latest*.yml' \
  --exclude='*' \
  "$REMOTE_HOST:$REMOTE_WORKDIR/desktop/release/" "$LOCAL_WIN_DIR/"

if ! ls "$LOCAL_WIN_DIR"/*.exe >/dev/null 2>&1; then
  echo "[remote-win] ERROR: no .exe artifacts found in $LOCAL_WIN_DIR"
  exit 1
fi

echo "[remote-win] Windows artifacts ready."
