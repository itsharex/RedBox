#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <tag>"
  exit 1
fi

TAG="$1"
ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
REPO="${REDBOX_PUBLIC_REPO:-Jamailar/RedBox}"
VERSION="${TAG#v}"
NOTES_FILE="$(mktemp -t redbox-release-notes.XXXXXX.md)"

cleanup() {
  rm -f "$NOTES_FILE"
}
trap cleanup EXIT

extract_notes_from_readme() {
  local readme_file="$1"
  if [[ ! -f "$readme_file" ]]; then
    return 1
  fi

  awk -v ver="$VERSION" '
    BEGIN { capture=0; printed=0 }
    $0 ~ "^### v" ver "([[:space:]]|\\(|$)" { capture=1; print; printed=1; next }
    capture && $0 ~ "^### v[0-9]" { exit }
    capture { print; printed=1 }
    END { if (!printed) exit 1 }
  ' "$readme_file" > "$NOTES_FILE"
}

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Please install gh and run 'gh auth login'."
  exit 1
fi

if [[ -n "${REDBOX_RELEASE_NOTES_FILE:-}" && -f "${REDBOX_RELEASE_NOTES_FILE}" ]]; then
  cp "${REDBOX_RELEASE_NOTES_FILE}" "$NOTES_FILE"
elif ! extract_notes_from_readme "$ROOT_DIR/README.md"; then
  {
    echo "### ${TAG}"
    echo
    echo "Release notes were auto-generated from recent commits:"
    echo
    git -C "$ROOT_DIR" log --no-merges --pretty='- %s' -n 12
  } > "$NOTES_FILE"
fi

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "[release] Release not found, create: $TAG"
  gh release create "$TAG" --repo "$REPO" --title "$TAG" --notes-file "$NOTES_FILE"
else
  echo "[release] Release exists, update notes: $TAG"
  gh release edit "$TAG" --repo "$REPO" --title "$TAG" --notes-file "$NOTES_FILE"
fi

shopt -s nullglob
FILES=(
  "$ROOT_DIR/desktop/release/"*.dmg
  "$ROOT_DIR/desktop/release/"*.zip
  "$ROOT_DIR/desktop/release/"latest*.yml
  "$ROOT_DIR/artifacts/win-remote/RedBox-${VERSION}-"*.exe
  "$ROOT_DIR/artifacts/win-remote/RedBox-${VERSION}-"*.blockmap
  "$ROOT_DIR/artifacts/win-remote/"latest*.yml
)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "[release] ERROR: no artifacts found to upload"
  exit 1
fi

echo "[release] Uploading ${#FILES[@]} files to $REPO@$TAG"
gh release upload "$TAG" "${FILES[@]}" --repo "$REPO" --clobber

echo "[release] Upload completed."
