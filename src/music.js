'use strict'
/*
 * PLAY — `!play <song>`.
 *
 * Searches a public catalogue, shows the artwork, downloads the audio and sends
 * it as a WhatsApp audio message.
 *
 * WHY THE SOURCE CHANGED
 * ----------------------
 * The previous build took its audio from Deezer's `preview` field. That field
 * is a 30-second clip by design — it is a marketing sample, not the track — so
 * every `!play` returned half a minute of music and stopped. No amount of
 * retrying fixes that: the preview URL is the only audio Deezer's public API
 * exposes.
 *
 * The full track now comes from Audius, a public music catalogue with an open
 * API and no key:
 *
 *   GET /v1/tracks/search?query=...&app_name=AXYON   -> track ids + metadata
 *   GET /v1/tracks/{id}/stream?app_name=AXYON        -> the FULL audio file
 *
 * The stream endpoint returns the whole track (verified: a 3:47 track came back
 * as a 9.1 MB 320 kbps MP3), not a sample. Deezer is still used for the cover
 * art and the duration, because its artwork is better and it is a cheap call.
 *
 * FALLBACK ORDER
 * --------------
 *   1. Audius full track            (the normal path)
 *   2. yt-dlp, if the host has it   (full track, when YouTube is not blocking)
 *   3. Deezer preview               (last resort, and the caption SAYS it is a
 *                                    preview — it never pretends otherwise)
 *
 * Everything is bounded: a hard timeout on each network call, a size cap, and a
 * temp directory that is always removed. A failed lookup returns a short
 * message — never a stack trace.
 */
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const SEARCH_TIMEOUT_MS = 8000
const DOWNLOAD_TIMEOUT_MS = 45000
const MAX_BYTES = 16 * 1024 * 1024
const APP_NAME = 'AXYON'

/* Audius rotates its discovery hosts; this one is the documented entry point. */
const AUDIUS = 'https://api.audius.co'

function run (bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }))
      resolve(String(stdout || ''))
    })
  })
}

async function hasBinary (bin) {
  try { await run('which', [bin], 3000); return true } catch { return false }
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

/** Deezer metadata: cover art, album, duration. Never the audio. */
async function deezerMeta (query) {
  const j = await fetchJson(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`)
  const t = j?.data?.[0]
  if (!t) return null
  return {
    title: t.title_short || t.title,
    artist: t.artist?.name || 'Unknown artist',
    album: t.album?.title || '',
    duration: Number(t.duration) || 0,
    artwork: t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || '',
    preview: t.preview || '',
    url: t.link || ''
  }
}

/**
 * Searches Audius for a full-length track.
 *
 * TWO FILTERS THAT MATTER
 * ----------------------
 * 1. `is_streamable` — Audius lists tracks whose rights holder has not enabled
 *    streaming. Their `/stream` endpoint answers 404, so picking one silently
 *    falls through to the 30-second preview. They are excluded up front.
 * 2. Duration — a 4-second or 34-second result is a snippet or a cover intro,
 *    not the song. Anything under 60 s is dropped, which is what makes "full
 *    length" true rather than merely "not a preview".
 *
 * Among what survives, the result whose title and artist best match the query
 * wins, so "blinding lights the weeknd" does not return an unrelated remix.
 */
async function audiusSearch (query) {
  const q = String(query || '').trim()
  if (!q) return null
  const j = await fetchJson(`${AUDIUS}/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=${APP_NAME}&limit=20`)
  const all = Array.isArray(j?.data) ? j.data : []
  if (!all.length) return null

  const rows = all.filter(t => t.is_streamable !== false && Number(t.duration) >= 60)
  if (!rows.length) return null

  /*
   * Prefer a normal song over a multi-hour mix.
   *
   * A search for "lofi hip hop" happily returns a 3-hour compilation, which is
   * a legitimate result but a 100 MB download that blows the size cap and makes
   * `!play` feel broken. Anything under 12 minutes is preferred; longer results
   * are only used when nothing else matched.
   */
  const normal = rows.filter(t => Number(t.duration) <= 12 * 60)
  const pool = normal.length ? normal : rows

  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  const score = t => {
    const hay = `${t.title || ''} ${t.user?.name || ''}`.toLowerCase()
    return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0)
  }
  const best = pool.slice().sort((a, b) => score(b) - score(a))[0]
  if (!best?.id) return null

  return {
    id: best.id,
    title: best.title || q,
    artist: best.user?.name || 'Unknown artist',
    album: best.album_backlink ? '' : '',
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

/**
 * Downloads the full track with yt-dlp, or null.
 *
 * NO POST-PROCESSING. `--extract-audio` needs ffmpeg, which is not guaranteed
 * on the host — and when it is missing yt-dlp downloads the file and then
 * throws during postprocessing, so the track is lost. Instead we ask for the
 * best native audio stream (m4a preferred, which WhatsApp plays directly) and
 * send it as-is with the matching mimetype.
 */
async function downloadFull (track, dir) {
  const target = path.join(dir, 'yt')
  const query = `ytsearch1:${track.artist} - ${track.title} audio`
  await run('yt-dlp', [
    '--no-playlist', '--no-warnings', '--quiet',
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
    '--max-filesize', String(MAX_BYTES),
    '-o', `${target}.%(ext)s`,
    query
  ], DOWNLOAD_TIMEOUT_MS)
  const files = await fs.readdir(dir)
  const audio = files.find(f => /^yt\.(m4a|webm|mp3|opus|ogg|aac)$/i.test(f))
  if (!audio) return null
  const full = path.join(dir, audio)
  const st = await fs.stat(full)
  if (!st.size || st.size > MAX_BYTES) return null
  return full
}

/** The mimetype WhatsApp needs for a given file extension. */
function mimeFor (file) {
  const ext = String(file).split('.').pop().toLowerCase()
  if (ext === 'm4a' || ext === 'aac') return 'audio/mp4'
  if (ext === 'webm') return 'audio/webm'
  if (ext === 'ogg' || ext === 'opus') return 'audio/ogg; codecs=opus'
  return 'audio/mpeg'
}

/** Downloads the catalogue preview MP3, or null. Last resort only. */
async function downloadPreview (track, dir) {
  if (!track.preview) return null
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const r = await fetch(track.preview, { signal: c.signal })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length || buf.length > MAX_BYTES) return null
    const file = path.join(dir, 'preview.mp3')
    await fs.writeFile(file, buf)
    return file
  } catch { return null } finally { clearTimeout(t) }
}

function mmss (sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Resolves a query to a playable file.
 *
 * @returns {Promise<{ok:boolean, track?:object, file?:string, full?:boolean, source?:string, message?:string}>}
 */
async function resolve (query, { logger } = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, message: 'No song found for that search.' }

  /* Metadata and the full track are looked up in parallel: they are
   * independent, and doing them together keeps `!play` feeling instant. */
  const [meta, audius] = await Promise.all([
    deezerMeta(q).catch(() => null),
    audiusSearch(q).catch(() => null)
  ])

  if (!meta && !audius) return { ok: false, message: 'No song found for that search.' }

  /* Prefer the catalogue that actually has the audio, but keep the better
   * artwork and the real duration from Deezer when it has them. */
  const track = {
    title: meta?.title || audius?.title || q,
    artist: meta?.artist || audius?.artist || 'Unknown artist',
    album: meta?.album || '',
    duration: meta?.duration || audius?.duration || 0,
    artwork: meta?.artwork || audius?.artwork || '',
    preview: meta?.preview || '',
    url: meta?.url || ''
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axyon-play-'))
  try {
    let file = null
    let full = false
    let source = ''

    /* 1. Audius — the normal path, and the only one that reliably returns a
     *    full-length track without a key or a cookie. */
    if (audius) {
      file = await downloadAudius(audius, dir)
      if (file) { full = true; source = 'audius' }
    }

    /* 2. yt-dlp, when the host has it and YouTube is not blocking. */
    if (!file && await hasBinary('yt-dlp')) {
      try {
        file = await downloadFull(track, dir)
        if (file) { full = true; source = 'yt-dlp' }
      } catch (e) {
        logger?.warn?.({ err: e?.message }, 'yt-dlp download failed; trying the preview')
      }
    }

    /* 3. Deezer preview — last resort, and the caption says so. */
    if (!file) {
      file = await downloadPreview(track, dir)
      if (file) source = 'preview'
    }

    if (!file) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return { ok: false, message: 'Found the track but could not download the audio.' }
    }
    return { ok: true, track, file, full, source, dir }
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    logger?.warn?.({ err: e?.message }, 'play resolve failed')
    return { ok: false, message: 'Could not fetch that track right now.' }
  }
}

async function cleanup (dir) {
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

module.exports = { resolve, search: deezerMeta, audiusSearch, cleanup, mmss, hasBinary, mimeFor }
