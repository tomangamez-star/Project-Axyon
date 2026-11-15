'use strict'

/*
 * AXYON PLAY — TubeGrab is the ONLY audio download source.
 *
 * Flow:
 *   1. Read optional metadata/artwork from Deezer (metadata only; never audio).
 *   2. Ask TubeGrab to search YouTube for the requested track.
 *   3. Create an audio job, poll until complete, then fetch its temporary file.
 *   4. Verify the resulting duration when ffprobe is available.
 *
 * There is deliberately no local yt-dlp download and no Audius audio fallback.
 * If TubeGrab cannot provide the file, !play fails clearly rather than silently
 * switching to a different recording or a preview.
 */

const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const binaries = require('./binaries')

const SEARCH_TIMEOUT_MS = 20000
const DOWNLOAD_TIMEOUT_MS = 120000
const MAX_BYTES = 32 * 1024 * 1024
const MIN_FULL_SECONDS = 60
const TUBEGRAB_BASE = String(
  process.env.TUBEGRAB_URL || 'https://tubegrab-m1r2.onrender.com'
).trim().replace(/\/+$/, '')
const TUBEGRAB_JOB_TIMEOUT_MS = 6 * 60 * 1000
const TUBEGRAB_QUEUE_GRACE_MS = 90 * 1000
const TUBEGRAB_POLL_MS = 2500

function run (bin, args, timeoutMs) {
  return binaries.run(bin, args, timeoutMs)
}

async function hasBinary (bin) {
  return binaries.has(bin)
}

async function fetchJson (url, ms = SEARCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'AxyonMusic/1.0' }
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/* Deezer is used ONLY for title/artist/album/artwork metadata. */
async function deezerMeta (query) {
  const q = String(query || '').trim()
  if (!q) return null
  const json = await fetchJson(
    `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1`
  )
  const item = json?.data?.[0]
  if (!item) return null
  return {
    title: item.title_short || item.title || q,
    artist: item.artist?.name || 'Unknown artist',
    album: item.album?.title || '',
    duration: Number(item.duration) || 0,
    artwork: item.album?.cover_xl || item.album?.cover_big ||
      item.album?.cover_medium || ''
  }
}

async function tubegrabJson (pathname, { method = 'GET', body = null, ms = SEARCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const response = await fetch(`${TUBEGRAB_BASE}${pathname}`, {
      method,
      signal: controller.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    })
    const data = await response.json().catch(() => null)
    return { ok: response.ok, status: response.status, data }
  } catch (error) {
    return { ok: false, status: 0, data: null, error }
  } finally {
    clearTimeout(timer)
  }
}

async function tubegrabAlive () {
  const response = await tubegrabJson('/api/health', { ms: 10000 })
  return Boolean(response.ok && response.data?.ok)
}

function sniffAudioExt (contentType, buffer) {
  const type = String(contentType || '').toLowerCase()
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3'
  if (type.includes('m4a') || type.includes('mp4') || type.includes('aac')) return 'm4a'
  if (type.includes('webm')) return 'webm'
  if (type.includes('ogg') || type.includes('opus')) return 'ogg'
  if (type.includes('wav')) return 'wav'

  if (buffer && buffer.length > 12) {
    if (buffer.slice(0, 3).toString('latin1') === 'ID3') return 'mp3'
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3'
    if (buffer.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a'
    if (buffer.slice(0, 4).toString('latin1') === 'OggS') return 'ogg'
  }
  return 'mp3'
}

async function tubegrabSearch (query) {
  const response = await tubegrabJson('/api/search', {
    method: 'POST',
    body: { q: String(query || '').trim() },
    ms: 45000
  })
  const results = Array.isArray(response.data?.results) ? response.data.results : []
  const first = results.find(item => item?.url)
  if (!first) return null
  return {
    id: first.id || '',
    url: first.url,
    title: first.title || String(query || ''),
    artist: first.channel || first.uploader || first.artist || 'Unknown artist',
    duration: Number(first.duration) || 0,
    artwork: first.thumbnail || first.artwork || ''
  }
}

/**
 * Downloads the complete audio through TubeGrab.
 * Returns null on failure; it never switches to another audio source.
 */
async function tubegrabDownload (query, url, dir, { logger } = {}) {
  if (!(await tubegrabAlive())) {
    logger?.warn?.({ base: TUBEGRAB_BASE }, 'tubegrab: health check failed')
    return null
  }

  let selected = null
  const target = String(url || '').trim()
  if (target) {
    selected = { url: target, title: String(query || '') }
  } else {
    selected = await tubegrabSearch(query)
    if (!selected?.url) {
      logger?.warn?.({ query }, 'tubegrab: no YouTube search result')
      return null
    }
  }

  const created = await tubegrabJson('/api/download', {
    method: 'POST',
    body: { url: selected.url, type: 'audio' },
    ms: 45000
  })
  const id = created.data?.id
  if (!created.ok || !id) {
    logger?.warn?.({ status: created.status, error: created.data?.error }, 'tubegrab: job creation failed')
    return null
  }

  const startedAt = Date.now()
  let queuedSince = Date.now()
  let job = null

  while (Date.now() - startedAt < TUBEGRAB_JOB_TIMEOUT_MS) {
    const status = await tubegrabJson(`/api/jobs/${encodeURIComponent(id)}`, {
      ms: 20000
    })
    job = status.data
    if (!status.ok || !job) {
      logger?.warn?.({ id, status: status.status }, 'tubegrab: status request failed')
      return null
    }

    if (job.status === 'complete') break
    if (job.status === 'failed' || job.status === 'expired') {
      logger?.warn?.({ id, error: job.error }, 'tubegrab: job did not complete')
      return null
    }

    if (job.phase === 'queued') {
      if (Date.now() - queuedSince > TUBEGRAB_QUEUE_GRACE_MS) {
        logger?.warn?.({ id }, 'tubegrab: worker did not claim queued job')
        return null
      }
    } else {
      queuedSince = Date.now()
    }

    await new Promise(resolve => setTimeout(resolve, TUBEGRAB_POLL_MS))
  }

  if (job?.status !== 'complete') {
    logger?.warn?.({ id, phase: job?.phase }, 'tubegrab: job timed out')
    return null
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${TUBEGRAB_BASE}/api/jobs/${encodeURIComponent(id)}/file`,
      { signal: controller.signal }
    )
    if (!response.ok) {
      logger?.warn?.({ id, status: response.status }, 'tubegrab: completed file could not be fetched')
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length || buffer.length > MAX_BYTES) {
      logger?.warn?.({ id, bytes: buffer.length }, 'tubegrab: audio is empty or exceeds the size limit')
      return null
    }

    const extension = sniffAudioExt(response.headers.get('content-type'), buffer)
    const file = path.join(dir, `track.${extension}`)
    await fs.writeFile(file, buffer)

    return {
      file,
      title: job.title || selected.title || '',
      artist: selected.artist || '',
      artwork: selected.artwork || '',
      duration: Number(job.duration) || Number(selected.duration) || 0
    }
  } catch (error) {
    logger?.warn?.({ id, error: error?.message }, 'tubegrab: file retrieval failed')
    return null
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ output */

function mimeFor (file) {
  const extension = String(file).split('.').pop().toLowerCase()
  if (['m4a', 'aac', 'mp4'].includes(extension)) return 'audio/mp4'
  if (extension === 'webm') return 'audio/webm'
  if (['ogg', 'opus'].includes(extension)) return 'audio/ogg; codecs=opus'
  if (extension === 'wav') return 'audio/wav'
  return 'audio/mpeg'
}

function fileNameFor (title, file) {
  const extension = String(file).split('.').pop().toLowerCase() || 'mp3'
  const base = String(title || 'track')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'track'
  return `${base}.${extension}`
}

function mmss (seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

async function probeSeconds (file) {
  const binary = binaries.binPath('ffprobe')
  if (!binary) return 0
  try {
    const output = await run(binary, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file
    ], 15000)
    return Math.round(Number(String(output).trim()) || 0)
  } catch {
    return 0
  }
}

/**
 * Resolve a query using TubeGrab only for audio.
 * Deezer metadata is optional and never supplies audio bytes.
 */
async function resolve (query, { logger } = {}) {
  const q = String(query || '').trim()
  if (!q) {
    return { ok: false, reason: 'empty-query', message: 'Enter a song name to search.' }
  }

  if (!(await tubegrabAlive())) {
    return {
      ok: false,
      reason: 'tubegrab-unavailable',
      message: 'TubeGrab is not responding right now. Please try again shortly.'
    }
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'axyon-play-'))
  try {
    const [metadata, downloaded] = await Promise.all([
      deezerMeta(q).catch(() => null),
      tubegrabDownload(q, null, dir, { logger }).catch(error => {
        logger?.warn?.({ error: error?.message }, 'tubegrab download failed')
        return null
      })
    ])

    if (!downloaded?.file) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return {
        ok: false,
        reason: 'tubegrab-download-failed',
        message: 'TubeGrab could not retrieve the full track. Please try another search or try again later.'
      }
    }

    const track = {
      title: metadata?.title || downloaded.title || q,
      artist: metadata?.artist || downloaded.artist || 'Unknown artist',
      album: metadata?.album || '',
      duration: metadata?.duration || downloaded.duration || 0,
      artwork: metadata?.artwork || downloaded.artwork || '',
      url: ''
    }

    const actualSeconds = await probeSeconds(downloaded.file)
    if (actualSeconds && actualSeconds < MIN_FULL_SECONDS) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return {
        ok: false,
        reason: 'too-short',
        message: 'TubeGrab returned a short clip rather than a full track. No audio was sent.'
      }
    }

    if (actualSeconds && track.duration && actualSeconds < track.duration * 0.85) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      return {
        ok: false,
        reason: 'truncated',
        message: `Only ${mmss(actualSeconds)} of a ${mmss(track.duration)} track was retrieved. No audio was sent.`
      }
    }

    if (actualSeconds && !track.duration) track.duration = actualSeconds
    return {
      ok: true,
      track,
      file: downloaded.file,
      full: true,
      source: 'tubegrab',
      dir
    }
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    logger?.warn?.({ error: error?.message }, 'play resolve failed')
    return {
      ok: false,
      reason: 'tubegrab-error',
      message: 'TubeGrab could not retrieve that track right now. Please try again.'
    }
  }
}

async function cleanup (dir) {
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

/* Compatibility exports: none of these performs a second audio download. */
async function audiusSearch () { return null }
async function downloadAudius () { return null }
async function ytSearch (query) { return tubegrabSearch(query) }
function cookiesPath () { return null }
async function cookieJarFor () { return null }
async function youtubeArgs () { return [] }
function ytFailureReason () { return null }
function toolchain () { return binaries.describe() }

module.exports = {
  resolve,
  search: deezerMeta,
  ytSearch,
  audiusSearch,
  tubegrabDownload,
  tubegrabAlive,
  sniffAudioExt,
  cleanup,
  mmss,
  hasBinary,
  mimeFor,
  fileNameFor,
  probeSeconds,
  toolchain,
  cookiesPath,
  cookieJarFor,
  youtubeArgs,
  ytFailureReason
}
