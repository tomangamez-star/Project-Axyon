'use strict'
/*
 * PLAY — `!play <song>`.
 *
 * Searches a public catalogue, shows the artwork, downloads the audio and sends
 * it as a WhatsApp voice/audio message.
 *
 * WHY TWO SOURCES
 * ---------------
 * A full track needs a real extractor, and `yt-dlp` is not guaranteed to exist
 * on the host. So the flow is:
 *
 *   1. Search Deezer (no key, no quota) for title / artist / artwork / preview.
 *   2. If `yt-dlp` is available, download the full track from YouTube Music.
 *   3. Otherwise fall back to the catalogue's own preview MP3, and SAY SO in
 *      the caption. It never pretends a 30-second preview is the full song.
 *
 * Everything is bounded: a hard timeout on the search, a hard timeout on the
 * download, a size cap, and a temp file that is always removed. A failed lookup
 * returns a short message — never a stack trace.
 */
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const SEARCH_TIMEOUT_MS = 8000
const DOWNLOAD_TIMEOUT_MS = 45000
const MAX_BYTES = 16 * 1024 * 1024

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

/** Searches Deezer. Returns a normalised track or null. */
async function search (query) {
  const q = String(query || '').trim()
  if (!q) return null
  const j = await fetchJson(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1`)
  const t = j?.data?.[0]
  if (!t) return null
  return {
    id: t.id,
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
 * Downloads the full track with yt-dlp, or null.
 *
 * NO POST-PROCESSING. `--extract-audio` needs ffmpeg, which is not guaranteed
 * on the host — and when it is missing yt-dlp downloads the file and then
 * throws during postprocessing, so the track is lost. Instead we ask for the
 * best native audio stream (m4a preferred, which WhatsApp plays directly) and
 * send it as-is with the matching mimetype.
 */
async function downloadFull (track, dir) {
  const target = path.join(dir, 'track')
  const query = `ytsearch1:${track.artist} - ${track.title} audio`
  await run('yt-dlp', [
    '--no-playlist', '--no-warnings', '--quiet',
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
    '--max-filesize', String(MAX_BYTES),
    '-o', `${target}.%(ext)s`,
    query
  ], DOWNLOAD_TIMEOUT_MS)
  const files = await fs.readdir(dir)
  const audio = files.find(f => /^track\.(m4a|webm|mp3|opus|ogg|aac)$/i.test(f))
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

/** Downloads the catalogue preview MP3, or null. */
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
 * @returns {Promise<{ok:boolean, track?:object, file?:string, full?:boolean, message?:string}>}
 */
async function resolve (query, { logger } = {}) {
  const track = await search(query)
  if (!track) return { ok: false, message: 'No song found for that search.' }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axyon-play-'))
  try {
    let file = null
    let full = false
    if (await hasBinary('yt-dlp')) {
      try {
        file = await downloadFull(track, dir)
        full = !!file
      } catch (e) {
        logger?.warn?.({ err: e?.message }, 'yt-dlp download failed; falling back to preview')
      }
    }
    if (!file) file = await downloadPreview(track, dir)
    if (!file) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return { ok: false, message: 'Found the track but could not download the audio.' }
    }
    return { ok: true, track, file, full, dir }
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    logger?.warn?.({ err: e?.message }, 'play resolve failed')
    return { ok: false, message: 'Could not fetch that track right now.' }
  }
}

async function cleanup (dir) {
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

module.exports = { resolve, search, cleanup, mmss, hasBinary, mimeFor }
