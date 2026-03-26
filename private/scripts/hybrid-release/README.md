# Hybrid Release (Local macOS + Remote Linux for Windows)

This folder provides a repeatable release pipeline without GitHub-hosted build minutes.

## Flow

1. Build Windows package on remote Linux host over SSH (`jamdebian` by default)
2. Build macOS package on local Mac
3. Upload all artifacts to `Jamailar/RedBox` release
4. Git tag + push (trigger cloud sync workflow for open-source mirror)

Release notes are auto-populated from `README.md` changelog section matching the tag (fallback: recent git commits).

Artifacts location:
- macOS: `desktop/release/`
- remote Windows: `artifacts/win-remote/`

## One-time setup

### 1) Remote Linux host

```bash
ssh jamdebian
bash ~/path/to/RedConvert/scripts/hybrid-release/remote-setup.sh
```

Then login once for release upload capability:

```bash
gh auth login
```

### 2) Local Mac

- Ensure `pnpm`, `gh`, Xcode command line tools are installed
- Ensure mac signing/notarization env is available when building mac package
- Ensure SSH alias works: `ssh jamdebian`

## Usage

Run from repository root:

```bash
bash scripts/hybrid-release/publish-hybrid.sh v1.7.6
```

or shorter:

```bash
bash scripts/release-all.sh v1.7.6
```

Optional env vars:

- `REDBOX_REMOTE_HOST` (default: `jamdebian`)
- `REDBOX_REMOTE_WORKDIR` (default: `/home/jam/build/redconvert-release`)
- `REDBOX_PUBLIC_REPO` (default: `Jamailar/RedBox`)
- `REDBOX_RELEASE_NOTES_FILE` (optional: use custom notes file instead of README extraction)
- `REDBOX_SKIP_WIN=1` (skip remote win build)
- `REDBOX_SKIP_MAC=1` (skip local mac build)
- `REDBOX_SYNC_PUBLIC=1` (after release upload, also sync code/README to public repo)
- `REDBOX_GIT_PUSH=0` (disable final git tag/push step)

## Individual commands

```bash
bash scripts/hybrid-release/build-win-on-remote.sh
bash scripts/hybrid-release/build-mac-local.sh
bash scripts/hybrid-release/upload-release.sh v1.7.6
bash scripts/sync-public-mirror.sh
```
