#!/usr/bin/env bash
#
# AXYON — build step.
#
# WHAT THIS FIXES
# ---------------
# `!play` needs three programs Node does not ship: yt-dlp, ffmpeg and ffprobe.
# The repo never installed them, so on Render's native Node runtime `!play`
# failed with "could not download the full audio" — the code was calling
# programs that did not exist on the host.
#
# This script installs them into `.tools/bin` INSIDE the repo, so they are part
# of the built image and survive the deploy. `src/binaries.js` looks there
# first (after an env override), so the running app finds them without any
# PATH juggling.
#
# WHY STATIC BINARIES AND NOT apt
# -------------------------------
# Render's native Node runtime gives no root and no apt, so `apt-get install
# ffmpeg` is not available. Both tools ship self-contained static builds that
# need nothing but a writable directory:
#
#   yt-dlp_linux   a PyInstaller binary — no Python required on the host
#                  (the plain `yt-dlp` asset is a zipapp and DOES need python3,
#                  which the Node image does not guarantee)
#   ffmpeg static  johnvansickle's build, which bundles ffmpeg AND ffprobe
#                  in one archive
#
# Both are downloaded with retries and verified by running them, so a broken
# download fails the build loudly instead of failing `!play` at runtime.
#
# The script is idempotent: an already-installed tool is left alone, so a
# cached build directory does not re-download 80 MB every deploy.
set -euo pipefail

cd "$(dirname "$0")"

TOOLS_DIR="$PWD/.tools/bin"
mkdir -p "$TOOLS_DIR"

log() { printf '[build] %s\n' "$*"; }

# ---------------------------------------------------------------- yt-dlp ----
if [ -x "$TOOLS_DIR/yt-dlp" ] && "$TOOLS_DIR/yt-dlp" --version >/dev/null 2>&1; then
  log "yt-dlp already present: $("$TOOLS_DIR/yt-dlp" --version)"
else
  log "installing yt-dlp (static linux binary)"
  rm -f "$TOOLS_DIR/yt-dlp"
  curl -L --fail --retry 3 --retry-delay 2 --connect-timeout 20 \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    -o "$TOOLS_DIR/yt-dlp"
  chmod +x "$TOOLS_DIR/yt-dlp"
  if ! "$TOOLS_DIR/yt-dlp" --version >/dev/null 2>&1; then
    log "ERROR: yt-dlp downloaded but will not run on this host"
    exit 1
  fi
  log "yt-dlp installed: $("$TOOLS_DIR/yt-dlp" --version)"
fi

# ---------------------------------------------------------------- ffmpeg ----
# One archive provides both ffmpeg and ffprobe.
if [ -x "$TOOLS_DIR/ffmpeg" ] && [ -x "$TOOLS_DIR/ffprobe" ] \
   && "$TOOLS_DIR/ffmpeg" -version >/dev/null 2>&1; then
  log "ffmpeg already present: $("$TOOLS_DIR/ffmpeg" -version | head -n 1)"
else
  log "installing ffmpeg + ffprobe (static build)"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) FF_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" ;;
    aarch64|arm64) FF_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz" ;;
    *) log "ERROR: unsupported architecture for the static ffmpeg build: $ARCH"; exit 1 ;;
  esac

  curl -L --fail --retry 3 --retry-delay 2 --connect-timeout 20 "$FF_URL" -o "$TMP/ffmpeg.tar.xz"
  tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP"

  # The archive unpacks to ffmpeg-<version>-static/; find the binaries rather
  # than hardcoding the version in the path.
  FF_BIN="$(find "$TMP" -type f -name ffmpeg -perm -u+x | head -n 1)"
  FP_BIN="$(find "$TMP" -type f -name ffprobe -perm -u+x | head -n 1)"
  if [ -z "$FF_BIN" ] || [ -z "$FP_BIN" ]; then
    log "ERROR: ffmpeg archive did not contain the expected binaries"
    exit 1
  fi

  install -m 0755 "$FF_BIN" "$TOOLS_DIR/ffmpeg"
  install -m 0755 "$FP_BIN" "$TOOLS_DIR/ffprobe"

  if ! "$TOOLS_DIR/ffmpeg" -version >/dev/null 2>&1; then
    log "ERROR: ffmpeg installed but will not run on this host"
    exit 1
  fi
  log "ffmpeg installed: $("$TOOLS_DIR/ffmpeg" -version | head -n 1)"
fi

# ------------------------------------------------------------- npm deps ----
# `npm ci` when a lockfile is present (reproducible), otherwise `npm install`.
if [ -f package-lock.json ]; then
  log "installing node dependencies (npm ci)"
  npm ci --no-audit --no-fund
else
  log "installing node dependencies (npm install)"
  npm install --no-audit --no-fund
fi

# ------------------------------------------------------------- verify ------
log "toolchain:"
"$TOOLS_DIR/yt-dlp" --version | sed 's/^/  yt-dlp  /'
"$TOOLS_DIR/ffmpeg" -version | head -n 1 | sed 's/^/  ffmpeg  /'
"$TOOLS_DIR/ffprobe" -version | head -n 1 | sed 's/^/  ffprobe /'
log "build complete"
