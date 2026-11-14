'use strict'
/*
 * BINARY RESOLUTION — where yt-dlp, ffmpeg and ffprobe actually live.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `!play` needs three external programs that Node does not ship:
 *
 *   yt-dlp   resolves a song name to a YouTube video and downloads the audio
 *   ffmpeg   transcodes that audio to MP3 (and is what makes `audio/mpeg` true)
 *   ffprobe  reports the real duration, which is how a truncated stream is
 *            caught before it is sent as if it were the whole song
 *
 * On a managed host (Render's native Node runtime) none of them are on PATH,
 * and the previous build simply assumed they were. That is why `!play` failed
 * with "could not download the full audio" on a deploy that worked locally:
 * the code was calling a program that did not exist, and the error was
 * swallowed into one generic sentence.
 *
 * So every lookup goes through here, in a fixed order, and the result is
 * cached. The order matters:
 *
 *   1. An explicit environment override (YTDLP_PATH / FFMPEG_PATH /
 *      FFPROBE_PATH). An operator who installed the tool somewhere unusual
 *      should never have to fight the resolver.
 *   2. The repo-local bundle at `.tools/bin`, which is what `render-build.sh`
 *      populates during the build. This is the path that makes a deploy
 *      self-installing: the binaries travel with the built image.
 *   3. PATH, for a developer machine or a Docker image that installed them
 *      system-wide.
 *
 * `describe()` is the single source of truth for "what is missing", so the
 * user-facing error can name the exact program and the exact step instead of
 * guessing.
 */
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

/* The bundle `render-build.sh` writes into. Kept inside the repo so it is
 * captured by the deploy image rather than a temp dir that is wiped. */
const TOOLS_DIR = path.join(__dirname, '..', '.tools', 'bin')

const ENV_OVERRIDE = {
  'yt-dlp': 'YTDLP_PATH',
  ffmpeg: 'FFMPEG_PATH',
  ffprobe: 'FFPROBE_PATH'
}

/* name -> { path: string|null, version: string|null, source: string } */
const cache = new Map()

function isExecutable (p) {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch { return false }
}

/** Runs a program and resolves its stdout, or rejects with stderr attached. */
function run (bin, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }))
      resolve(String(stdout || ''))
    })
  })
}

/** Synchronous PATH lookup — avoids spawning `which` for every call. */
function onPath (name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * Finds one binary. Returns `{ path, source }` or `{ path: null }`.
 * Never throws: a missing tool is a normal, reportable state.
 */
function locate (name) {
  if (cache.has(name)) return cache.get(name)

  let found = { path: null, source: 'missing' }

  const override = process.env[ENV_OVERRIDE[name]]
  if (override && isExecutable(override)) {
    found = { path: override, source: 'env' }
  }

  if (!found.path) {
    const bundled = path.join(TOOLS_DIR, name)
    if (isExecutable(bundled)) found = { path: bundled, source: 'bundled' }
  }

  if (!found.path) {
    const sys = onPath(name)
    if (sys) found = { path: sys, source: 'path' }
  }

  cache.set(name, found)
  return found
}

/** Absolute path to a binary, or null when it is not installed. */
function binPath (name) {
  return locate(name).path
}

/** True when the binary can be executed. */
function has (name) {
  return Boolean(binPath(name))
}

/** Version string, or null. yt-dlp uses --version, ffmpeg/ffprobe use -version. */
async function version (name) {
  const p = binPath(name)
  if (!p) return null
  const args = name === 'yt-dlp' ? ['--version'] : ['-version']
  try {
    const out = await run(p, args, 15000)
    const first = String(out).split('\n')[0].trim()
    if (!first) return null
    /* ffmpeg prints "ffmpeg version 6.1.1-static ..." — keep the version token. */
    const m = first.match(/version\s+(\S+)/i)
    return m ? m[1] : first.slice(0, 60)
  } catch { return null }
}

/**
 * Full report for all three tools, with versions.
 *
 * @returns {Promise<{ytdlp:object, ffmpeg:object, ffprobe:object, ok:boolean, missing:string[]}>}
 */
async function describe () {
  const names = ['yt-dlp', 'ffmpeg', 'ffprobe']
  const out = {}
  for (const name of names) {
    const { path: p, source } = locate(name)
    out[name] = {
      name,
      found: Boolean(p),
      path: p,
      source,
      version: p ? await version(name) : null
    }
  }
  const missing = names.filter(n => !out[n].found)
  return {
    ytdlp: out['yt-dlp'],
    ffmpeg: out.ffmpeg,
    ffprobe: out.ffprobe,
    ok: missing.length === 0,
    missing
  }
}

/**
 * Logs the toolchain at startup so a deploy's logs answer "is yt-dlp there?"
 * without anyone needing shell access.
 *
 * A missing ffprobe is a warning, not a failure: duration probing degrades to
 * "unknown" and the truncation check is skipped, but playback still works.
 * A missing yt-dlp or ffmpeg is logged at warn level too — the Audius fallback
 * still serves full songs — but it is called out explicitly because it is the
 * difference between the primary path and the fallback.
 */
async function logStartup (logger) {
  const d = await describe()
  const line = t => `${t.name}=${t.found ? `${t.version || 'unknown'} (${t.source}: ${t.path})` : 'MISSING'}`

  const payload = {
    ytDlp: d.ytdlp.found ? d.ytdlp.version : null,
    ytDlpPath: d.ytdlp.path,
    ytDlpSource: d.ytdlp.source,
    ffmpeg: d.ffmpeg.found ? d.ffmpeg.version : null,
    ffmpegPath: d.ffmpeg.path,
    ffmpegSource: d.ffmpeg.source,
    ffprobe: d.ffprobe.found ? d.ffprobe.version : null,
    ffprobePath: d.ffprobe.path,
    missing: d.missing
  }

  if (d.ok) {
    logger?.info?.(payload, `play toolchain ready — ${[d.ytdlp, d.ffmpeg, d.ffprobe].map(line).join(', ')}`)
  } else {
    logger?.warn?.(
      payload,
      `play toolchain INCOMPLETE — missing: ${d.missing.join(', ')}. ` +
      'Run `bash render-build.sh` (or `npm run setup:tools`) to install them. ' +
      '!play will fall back to Audius until they are present.'
    )
  }
  return d
}

/** Clears the cache. Only used by tests. */
function reset () {
  cache.clear()
}

module.exports = {
  TOOLS_DIR,
  locate,
  binPath,
  has,
  version,
  describe,
  logStartup,
  reset,
  run
}
