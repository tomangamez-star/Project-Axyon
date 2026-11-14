# AXYON — container build.
#
# WHY THIS EXISTS ALONGSIDE render-build.sh
# -----------------------------------------
# `render-build.sh` is the path for Render's NATIVE Node runtime: it downloads
# static binaries into `.tools/bin` because that environment has no root and no
# apt. This Dockerfile is the alternative for anyone deploying as a container
# (Render's Docker runtime, Fly, Railway, a VPS). Here we CAN use apt, so
# ffmpeg/ffprobe come from the distro and yt-dlp from its official static
# release — the same three programs, installed the way a container should.
#
# Pick ONE:
#   native runtime  -> render.yaml already points buildCommand at render-build.sh
#   docker runtime  -> set the service to use this Dockerfile
#
# Both produce a host where `src/binaries.js` finds all three tools.
FROM node:22-bookworm-slim

# ffmpeg ships ffprobe in the same package; ca-certificates is needed for the
# HTTPS calls to YouTube/Audius; python3 is NOT needed (yt-dlp_linux is a
# self-contained PyInstaller binary).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      curl \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp: the static linux build, so it does not depend on the distro's Python.
RUN curl -L --fail --retry 3 \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && yt-dlp --version

# deno: yt-dlp's JavaScript challenge solver. Without it YouTube exposes no
# audio format and `!play` fails even with valid cookies.
RUN curl -L --fail --retry 3 \
      https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
      -o /tmp/deno.zip \
 && (unzip -o -q /tmp/deno.zip -d /usr/local/bin || python3 -c "import zipfile;zipfile.ZipFile('/tmp/deno.zip').extractall('/usr/local/bin')") \
 && chmod +x /usr/local/bin/deno \
 && rm -f /tmp/deno.zip \
 && deno --version

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall node_modules.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .

# Fail the image build — not the first `!play` — if a tool is missing.
RUN yt-dlp --version \
 && ffmpeg -version | head -n 1 \
 && ffprobe -version | head -n 1 \
 && deno --version | head -n 1

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# The health server answers /health; Render's healthCheckPath uses it too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
