'use strict'
/*
 * PLAY — `!play <song>`.
 *
 * Searches for the song, resolves the YouTube URL, downloads the COMPLETE
 * audio and sends it as a WhatsApp audio message.
 *
 * WHY THE SOURCE CHANGED
 * ----------------------
 * The previous build took its audio from Deezer's `preview` field. That field
 * is a 30-second clip by design — it is a marketing sample, not the track — so
 * every `!play` returned half a minute of music and stopped. No amount of
 * retrying fixes that: the preview URL is the only audio Deezer's public API
 * exposes.
 *
 * THE FULL-SONG METHOD (same architecture as JAWAD-MD's `.play`)
 * -------------------------------------------------------------
 *   1. SEARCH   yt-dlp `ytsearch1:<query>` resolves the song name to the first
 *               matching YouTube video and returns its id, title, uploader,
 *               duration and thumbnail.
 *   2. RESOLVE  the video id becomes a canonical watch URL.
 *   3. DOWNLOAD yt-dlp pulls the best audio stream for that URL. When ffmpeg is
 *               present the stream is transcoded to MP3 so the message is a
 *               real `audio/mpeg`; without ffmpeg the native stream (m4a/webm)
 *               is sent as-is with its honest mimetype.
 *   4. SEND     the local file is read into a Buffer and sent as an audio
 *               message with the song title as the file name.
 *
 * A track shorter than MIN_FULL_SECONDS is rejected rather than sent: that is
 * what makes "full song" true instead of merely "not a preview". There is no
 * preview fallback any more — if a full track cannot be produced, `!play`
 * says so instead of quietly sending 30 seconds.
 *
 * WHERE THE BINARIES COME FROM
 * ----------------------------
 * yt-dlp, ffmpeg and ffprobe are external programs, not npm packages. They are
 * resolved through `./binaries`, which checks an env override, then the
 * repo-local bundle at `.tools/bin` (populated by `render-build.sh` during the
 * deploy), then PATH. Every failure below names the exact program that is
 * missing and the exact step that failed, because the old build collapsed all
 * of it into one sentence that told nobody anything.
 *
 * FALLBACK ORDER
 * --------------
 *   1. yt-dlp (YouTube)      — the normal path, full track
 *   2. Audius                — full track, used when yt-dlp is missing or
 *                              YouTube is blocking the host
 *
 * Everything is bounded: a hard timeout on each call, a size cap, and a temp
 * directory that is always removed. A failed lookup returns a short message —
 * never a stack trace.
 */
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const binaries = require('./binaries')

const SEARCH_TIMEOUT_MS = 20000
const DOWNLOAD_TIMEOUT_MS = 90000
const MAX_BYTES = 16 * 1024 * 1024

/*
 * YOUTUBE COOKIES — WHY THEY ARE IN THE REPO
 * ------------------------------------------
 * YouTube answers a datacenter IP with "Sign in to confirm you're not a bot"
 * and refuses to serve the stream. That is not a bug in this code: it is
 * YouTube refusing an anonymous request from a cloud host. The only reliable
 * fix is to make the request look like a signed-in browser, which means
 * sending a real account's cookies.
 *
 * The repo is private, so the operator chose to commit the cookie jar rather
 * than require an env var on every deploy. The order below still lets an
 * operator override it without a code change:
 *
 *   1. YTDLP_COOKIES_FILE   — an explicit path (env)
 *   2. data/cookies.txt     — the committed jar (this is the normal path)
 *   3. YTDLP_COOKIES_FROM_BROWSER — a local browser profile, dev machines only
 *
 * A missing jar is not fatal: yt-dlp simply runs without cookies and the
 * Audius fallback still serves full tracks.
 */
const COOKIES_FILE = path.join(__dirname, '..', 'data', 'cookies.txt')

/*
 * THE JS RUNTIME AND THE PLAYER CLIENT — WHY BOTH ARE NEEDED
 * ---------------------------------------------------------
 * Cookies alone get past "Sign in to confirm you're not a bot", but YouTube
 * then serves a player that requires a JavaScript challenge to be solved
 * before any audio format is exposed. Without a solver yt-dlp reports
 * "Only images are available for download" and the download fails.
 *
 *   --js-runtimes deno   yt-dlp's EJS challenge solver. Deno is the runtime it
 *                        supports natively; Node 20 is reported as
 *                        "unsupported" and cannot solve the challenge.
 *   player_client=mweb   the client that actually returns a downloadable
 *                        audio stream with these cookies. The default `web`
 *                        client returns formats that 403 on the media fetch.
 *
 * Both are passed on every yt-dlp call. If Deno is absent the flags are
 * omitted rather than passed as a broken value, so the error stays honest.
 */
const JS_RUNTIME = 'deno'

/*
 * THE FORMAT LADDER — WHY `bestaudio` ALONE IS NOT ENOUGH
 * ------------------------------------------------------
 * With these cookies YouTube exposes two kinds of stream on the mweb client:
 *
 *   format 251 (webm/opus)  audio-only, but its media URL now requires a GVS
 *                           PO token. yt-dlp warns about it and the fetch
 *                           returns HTTP 403, so `bestaudio` picks a stream
 *                           that cannot actually be downloaded.
 *   format 18  (mp4)        muxed audio+video, no PO token needed, and ffmpeg
 *                           strips the audio out. This is the one that works.
 *
 * So the download walks a ladder: prefer a real audio-only stream, fall back
 * to the muxed one, and only then give up. Each rung is a separate yt-dlp run
 * in a clean directory, because a failed run can leave a partial file behind.
 */
const PLAYER_CLIENTS = ['mweb', 'web_embedded', 'default']

/** Format selectors, best first. `best` is the muxed stream that still works. */
const FORMAT_LADDER = [
  { label: 'audio-only', selector: 'bestaudio[ext=m4a]/bestaudio' },
  { label: 'muxed', selector: 'best' }
]

/** True when the challenge solver runtime is available (bundle or PATH). */
function hasJsRuntime () {
  const bundled = path.join(binaries.TOOLS_DIR, JS_RUNTIME)
  try {
    if (require('fs').statSync(bundled).isFile()) return true
  } catch { /* fall through to PATH */ }
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    try {
      if (require('fs').statSync(path.join(dir, JS_RUNTIME)).isFile()) return true
    } catch { /* keep looking */ }
  }
  return false
}

/** The yt-dlp flags that make a datacenter request look like a real browser. */
function youtubeArgs (client = PLAYER_CLIENTS[0]) {
  const args = []
  const jar = cookiesPath()
  if (jar) args.push('--cookies', jar)
  if (hasJsRuntime()) args.push('--js-runtimes', JS_RUNTIME)
  args.push('--extractor-args', `youtube:player_client=${client}`)
  return args
}

/** The cookie jar to hand yt-dlp, or null when none is available. */
function cookiesPath () {
  const explicit = String(process.env.YTDLP_COOKIES_FILE || '').trim()
  if (explicit) {
    try {
      if (require('fs').statSync(explicit).isFile()) return explicit
    } catch { /* fall through to the committed jar */ }
  }
  try {
    if (require('fs').statSync(COOKIES_FILE).isFile()) return COOKIES_FILE
  } catch { /* no jar committed */ }
  return null
}
/* Anything under this is a snippet, an intro or a preview — never a song. */
const MIN_FULL_SECONDS = 60
const APP_NAME = 'AXYON'

/* Audius rotates its discovery hosts; this one is the documented entry point. */
const AUDIUS = 'https://api.audius.co'

/* The install hint shown whenever a required program is absent. */
const INSTALL_HINT = 'Run `bash render-build.sh` (or `npm run setup:tools`) on the host to install it.'

function run (bin, args, timeoutMs) {
  return binaries.run(bin, args, timeoutMs)
}

/** True when the program is installed and executable. */
async function hasBinary (bin) {
  return binaries.has(bin)
}

/** The last meaningful line of a tool's stderr, for a specific error message. */
function tail (text, max = 180) {
  const s = String(text || '').trim().split('\n').filter(Boolean).pop() || ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

async function fetchJson (url, ms = SEARCH_TIMEOUT_MS) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'ArchitectBot/1.0' } })
    if (!r.ok) return null
    return await r.json()
  } catch { return null } finally { clearTimeout(t) }
}

/* ------------------------------------------------------------------ search */

/**
 * Resolves a free-text query to a YouTube video.
 *
 * `--flat-playlist` keeps this cheap: yt-dlp returns the search metadata
 * without resolving every stream format, so the lookup stays fast.
 *
 * @returns {Promise<{id:string,url:string,title:string,artist:string,duration:number,artwork:string}|null>}
 */
async function ytSearch (query) {
  const q = String(query || '').trim()
  if (!q) return null
  const bin = binaries.binPath('yt-dlp')
  if (!bin) return null

  /* The search itself is also blocked without cookies on a datacenter IP, so
   * the same browser-like flags are passed here too — not only on the
   * download. */
  const searchArgs = ['--flat-playlist', '--no-warnings', '--quiet', ...youtubeArgs()]
  searchArgs.push('-J', `ytsearch1:${q}`)

  let raw
  try {
    raw = await run(bin, searchArgs, SEARCH_TIMEOUT_MS)
  } catch { return null }

  let j
  try { j = JSON.parse(raw) } catch { return null }
  const e = Array.isArray(j?.entries) ? j.entries[0] : null
  if (!e?.id) return null

  const thumbs = Array.isArray(e.thumbnails) ? e.thumbnails : []
  const best = thumbs.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0]

  return {
    id: e.id,
    url: `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title || q,
    artist: e.uploader || e.channel || 'Unknown artist',
    duration: Number(e.duration) || 0,
    artwork: best?.url || (e.id ? `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` : '')
  }
}

/** Deezer metadata: better cover art and the real duration. Never the audio. */
async function deezerMeta (query) {
  const j = await fetchJson(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`)
  const t = j?.data?.[0]
  if (!t) return null
  return {
    title: t.title_short || t.title,
    artist: t.artist?.name || 'Unknown artist',
    album: t.album?.title || '',
    duration: Number(t.duration) || 0,
    artwork: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || ''
  }
}

/* ---------------------------------------------------------------- download */

/**
 * Downloads the complete audio for a resolved YouTube URL.
 *
 * MP3 IS PREFERRED, because the caller sends `audio/mpeg`. Transcoding needs
 * ffmpeg, which is not guaranteed on every host — so when it is missing we ask
 * for the best native audio stream instead and let `mimeFor()` report the
 * truth. Either way the file is the WHOLE track, never a sample.
 *
 * @returns {Promise<{file:string|null, error?:string, step?:string}>}
 */
async function downloadYt (video, dir, { ffmpeg }) {
  const bin = binaries.binPath('yt-dlp')
  if (!bin) {
    return { file: null, step: 'download', error: 'yt-dlp is not installed on this host' }
  }

  const attempts = []
  let n = 0

  /*
   * Walk the client x format ladder. The first rung that produces a real file
   * wins; every failure is recorded so the final error names what was tried
   * instead of only the last thing that broke.
   */
  for (const client of PLAYER_CLIENTS) {
    for (const rung of FORMAT_LADDER) {
      n += 1
      const sub = path.join(dir, `try${n}`)
      await fs.mkdir(sub, { recursive: true })
      const target = path.join(sub, 'track')

      const args = [
        '--no-playlist', '--no-warnings', '--quiet',
        '--max-filesize', String(MAX_BYTES),
        '--retries', '3', '--socket-timeout', '20',
        '-o', `${target}.%(ext)s`,
        ...youtubeArgs(client)
      ]
      if (!cookiesPath() && process.env.YTDLP_COOKIES_FROM_BROWSER) {
        args.push('--cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER)
      }

      if (ffmpeg) {
        args.push('-f', rung.selector, '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0')
      } else {
        args.push('-f', rung.selector)
      }
      args.push(video.url)

      try {
        await run(bin, args, DOWNLOAD_TIMEOUT_MS)
      } catch (e) {
        attempts.push(`${client}/${rung.label}: ${tail(e?.stderr) || e?.message || 'unknown error'}`)
        await fs.rm(sub, { recursive: true, force: true }).catch(() => {})
        continue
      }

      const files = await fs.readdir(sub).catch(() => [])
      const audio = files.find(f => /^track\.(mp3|m4a|mp4|webm|opus|ogg|aac|wav)$/i.test(f))
      if (!audio) {
        attempts.push(`${client}/${rung.label}: yt-dlp exited without producing an audio file`)
        await fs.rm(sub, { recursive: true, force: true }).catch(() => {})
        continue
      }

      const full = path.join(sub, audio)
      const st = await fs.stat(full).catch(() => null)
      if (!st?.size) {
        attempts.push(`${client}/${rung.label}: downloaded file was empty`)
        await fs.rm(sub, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (st.size > MAX_BYTES) {
        attempts.push(`${client}/${rung.label}: downloaded file exceeded the size cap`)
        await fs.rm(sub, { recursive: true, force: true }).catch(() => {})
        continue
      }

      return { file: full, client, format: rung.label }
    }
  }

  return {
    file: null,
    step: ffmpeg ? 'download+transcode (ffmpeg)' : 'download',
    error: attempts.length ? attempts[attempts.length - 1] : 'every download attempt failed',
    attempts
  }
}

/**
 * Searches Audius for a full-length track — the fallback when yt-dlp is
 * unavailable or YouTube is blocking the host.
 *
 * Two filters matter: `is_streamable` (unstreamable tracks 404 on /stream) and
 * duration (a 34-second result is a snippet, not the song).
 */
/**
 * Strips the noise a YouTube title carries, so a fallback search can match.
 * "Song (Official Music Video) [4K]" becomes "Song".
 */
function cleanQuery (q) {
  return String(q || '')
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/\b(official\s*(music\s*)?video|official\s*audio|lyric\s*video|lyrics?|audio|hd|hq|4k|8k|visuali[sz]er|explicit|remaster(ed)?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function audiusSearch (query) {
  const q = String(query || '').trim()
  if (!q) return null
  const j = await fetchJson(`${AUDIUS}/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=${APP_NAME}&limit=20`)
  const all = Array.isArray(j?.data) ? j.data : []
  if (!all.length) return null

  const rows = all.filter(t => t.is_streamable !== false && Number(t.duration) >= MIN_FULL_SECONDS)
  if (!rows.length) return null

  /* Prefer a normal song over a multi-hour mix that would blow the size cap. */
  const normal = rows.filter(t => Number(t.duration) <= 12 * 60)
  const pool = normal.length ? normal : rows

  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  /*
   * A remix, bootleg, cover or sped-up edit is a different recording, not the
   * song the user asked for. They are heavily represented on Audius, so they
   * are pushed to the back of the queue rather than merely scored lower.
   */
  const DERIVATIVE = /\b(remix|bootleg|mashup|cover|sped\s*up|slowed|nightcore|instrumental|karaoke|8d|reverb|edit|flip|refix)\b/i
  const score = t => {
    const hay = `${t.title || ''} ${t.user?.name || ''}`.toLowerCase()
    const hits = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0)
    return hits - (DERIVATIVE.test(hay) ? 100 : 0)
  }
  const best = pool.slice().sort((a, b) => score(b) - score(a))[0]
  if (!best?.id) return null
  /* If every candidate is a derivative, there is no real match to offer. */
  if (score(best) < 0) return null

  return {
    id: best.id,
    title: best.title || q,
    artist: best.user?.name || 'Unknown artist',
    duration: Number(best.duration) || 0,
    artwork: best.artwork?.['1000x1000'] || best.artwork?.['480x480'] || best.artwork?.['150x150'] || '',
    stream: `${AUDIUS}/v1/tracks/${encodeURIComponent(best.id)}/stream?app_name=${APP_NAME}`
  }
}

/** Downloads the full Audius stream, or null. */
async function downloadAudius (track, dir) {
  if (!track?.stream) return null
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const r = await fetch(track.stream, { signal: c.signal, redirect: 'follow' })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length || buf.length > MAX_BYTES) return null
    /* Audius serves MP3. Keep the extension honest so the mimetype matches. */
    const file = path.join(dir, 'track.mp3')
    await fs.writeFile(file, buf)
    return file
  } catch { return null } finally { clearTimeout(t) }
}

/* ------------------------------------------------------------------ output */

/** The mimetype WhatsApp needs for a given file extension. */
function mimeFor (file) {
  const ext = String(file).split('.').pop().toLowerCase()
  if (ext === 'm4a' || ext === 'aac' || ext === 'mp4') return 'audio/mp4'
  if (ext === 'webm') return 'audio/webm'
  if (ext === 'ogg' || ext === 'opus') return 'audio/ogg; codecs=opus'
  if (ext === 'wav') return 'audio/wav'
  return 'audio/mpeg'
}

/** A safe WhatsApp file name: the song title, with the real extension. */
function fileNameFor (title, file) {
  const ext = String(file).split('.').pop().toLowerCase() || 'mp3'
  const base = String(title || 'track')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'track'
  return `${base}.${ext}`
}

function mmss (sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Resolves a query to a playable FULL track.
 *
 * @returns {Promise<{ok:boolean, track?:object, file?:string, full?:boolean, source?:string, message?:string, reason?:string}>}
 */
async function resolve (query, { logger } = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, reason: 'empty-query', message: 'No song found for that search.' }

  const [meta, yt, ffmpeg, ffprobe] = await Promise.all([
    deezerMeta(q).catch(() => null),
    hasBinary('yt-dlp').then(ok => (ok ? ytSearch(q).catch(() => null) : null)),
    hasBinary('ffmpeg'),
    hasBinary('ffprobe')
  ])

  if (!meta && !yt) {
    /*
     * Distinguish "the search found nothing" from "the searcher is not
     * installed" — they need completely different fixes.
     */
    if (!binaries.has('yt-dlp')) {
      return {
        ok: false,
        reason: 'missing-ytdlp',
        message: `yt-dlp is not installed on this host, so the full-song search cannot run. ${INSTALL_HINT}`
      }
    }
    return { ok: false, reason: 'no-match', message: 'No song found for that search.' }
  }

  /* Prefer the catalogue that actually has the audio, but keep the better
   * artwork and the real duration from Deezer when it has them. */
  const track = {
    title: meta?.title || yt?.title || q,
    artist: meta?.artist || yt?.artist || 'Unknown artist',
    album: meta?.album || '',
    duration: meta?.duration || yt?.duration || 0,
    artwork: meta?.artwork || yt?.artwork || '',
    url: yt?.url || ''
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axyon-play-'))
  try {
    let file = null
    let source = ''
    let ytError = null
    let ytStep = null

    /* 1. yt-dlp — the normal path, and the one that returns the whole song. */
    if (yt) {
      const r = await downloadYt(yt, dir, { ffmpeg })
      if (r.file) {
        file = r.file
        source = 'yt-dlp'
      } else {
        ytError = r.error
        ytStep = r.step
        logger?.warn?.({ step: r.step, err: r.error }, 'yt-dlp download failed; trying Audius')
      }
    }

    /*
     * 2. Audius — full track, when yt-dlp is missing or YouTube is blocking.
     *
     * The raw query is often a YouTube title ("Don Toliver - TORE UP [Official
     * Music Video]"), which matches nothing on Audius. So the cleaned form is
     * tried as a second pass before giving up — one YouTube failure should not
     * leave the user with nothing.
     */
    if (!file) {
      const queries = [q]
      const cleaned = cleanQuery(q)
      if (cleaned && cleaned.toLowerCase() !== q.toLowerCase()) queries.push(cleaned)

      for (const aq of queries) {
        const audius = await audiusSearch(aq).catch(() => null)
        if (!audius) continue
        file = await downloadAudius(audius, dir)
        if (file) {
          source = 'audius'
          if (!track.duration) track.duration = audius.duration
          if (!track.artwork) track.artwork = audius.artwork
          break
        }
      }
    }

    if (!file) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      /*
       * The message names the failing step and the tool's own words. This is
       * the sentence that used to be "could not download the full audio" and
       * told nobody whether yt-dlp was missing, blocked, or out of disk.
       */
      const parts = []
      if (!binaries.has('yt-dlp')) {
        parts.push(`yt-dlp is not installed. ${INSTALL_HINT}`)
      } else if (ytError) {
        parts.push(`yt-dlp ${ytStep || 'download'} failed: ${ytError}`)
      }
      if (!ffmpeg) parts.push('ffmpeg is not installed, so MP3 conversion is unavailable.')
      if (!ffprobe) parts.push('ffprobe is not installed, so the track length cannot be verified.')
      parts.push('The Audius fallback had no full-length match either.')

      return {
        ok: false,
        reason: 'download-failed',
        message: `Found the track but could not download the full audio. ${parts.join(' ')}`
      }
    }

    /*
     * A short file is a snippet, not a song. Measure what actually landed
     * rather than trusting the search metadata, and refuse to send a preview.
     */
    const seconds = await probeSeconds(file)
    if (seconds && seconds < MIN_FULL_SECONDS) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return {
        ok: false,
        reason: 'too-short',
        message: 'Only a short clip was available for that track — no full song found.'
      }
    }

    /*
     * A file that stops well before the track's known length is a truncated
     * stream, not the song. This is what catches a catalogue that serves the
     * first 90 seconds of a 3:20 track and calls it a stream.
     */
    if (seconds && track.duration && seconds < track.duration * 0.85) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return {
        ok: false,
        reason: 'truncated',
        message: `Only ${mmss(seconds)} of a ${mmss(track.duration)} track was available — no full song found.`
      }
    }

    if (seconds && !track.duration) track.duration = seconds

    return { ok: true, track, file, full: true, source, dir }
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    logger?.warn?.({ err: e?.message }, 'play resolve failed')
    return { ok: false, reason: 'exception', message: `Could not fetch that track right now (${e?.message || 'unknown error'}).` }
  }
}

/** Real duration of a downloaded file, via ffprobe. 0 when it cannot tell. */
async function probeSeconds (file) {
  const bin = binaries.binPath('ffprobe')
  if (!bin) return 0
  try {
    const out = await run(bin, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file
    ], 10000)
    return Math.round(Number(String(out).trim()) || 0)
  } catch { return 0 }
}

async function cleanup (dir) {
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** The toolchain report, re-exported so the dashboard/health route can show it. */
function toolchain () {
  return binaries.describe()
}

module.exports = {
  resolve,
  search: deezerMeta,
  ytSearch,
  audiusSearch,
  cleanup,
  mmss,
  hasBinary,
  mimeFor,
  fileNameFor,
  probeSeconds,
  toolchain,
  cookiesPath,
  youtubeArgs
}
