#!/usr/bin/env bash
set -euo pipefail

# One-time setup script for Linux remote host used to build Windows installer via electron-builder + wine.

if [[ "${EUID}" -ne 0 ]]; then
  SUDO="sudo"
else
  SUDO=""
fi

${SUDO} apt-get update
${SUDO} dpkg --add-architecture i386 || true
${SUDO} apt-get update
${SUDO} apt-get install -y \
  ca-certificates \
  curl \
  git \
  rsync \
  build-essential \
  python3 \
  python3-pip \
  wine64 \
  wine32:i386 \
  xvfb \
  p7zip-full

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | ${SUDO} -E bash -
  ${SUDO} apt-get install -y nodejs
fi

if ! command -v pnpm >/dev/null 2>&1; then
  ${SUDO} npm install -g pnpm@9
fi

if ! command -v gh >/dev/null 2>&1; then
  type -p curl >/dev/null || ${SUDO} apt-get install curl -y
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | ${SUDO} dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  ${SUDO} chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | ${SUDO} tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  ${SUDO} apt-get update
  ${SUDO} apt-get install -y gh
fi

echo "Remote setup completed."
echo "Next step (once): gh auth login"
