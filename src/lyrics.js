'use strict'
/*
 * LYRICS LOOKUP — backs the `.play` command.
 *
 * `.play <song>` does NOT download or send audio. It resolves the song, fetches
 * its lyrics from an open lyrics service, and returns the lyrics as plain text
 * so the caller can post them into the chat.
 *
 * The service is lyrics.ovh (https://lyrics.ovh), a free open lyrics API that
 * needs no key:
 *   - /suggest/<free text>      → candidate {artist,title} matches
 *   - /v1/<artist>/<title>      → the lyrics body
 *
 * Everything network-facing is injectable (`fetchImpl`) so tests never touch
 * the network, and every failure path returns `{ found: false }` rather than
 * throwing — the command turns that into a plain "couldn't find it" reply.
 */

const SUGGEST_URL = 'https://api.lyrics.ovh/suggest/'
const LYRICS_URL = 'https://api.lyrics.ovh/v1/'
const TIMEOUT_MS = Number(process.env.AXYON_LYRICS_TIMEOUT_MS) || 15000

async function getJson (url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res || !res.ok) return null
  return res.json().catch(() => null)
}

/** Candidate {artist,title} matches for a free-text query. */
async function suggest (query, fetchImpl = fetch) {
  const data = await getJson(`${SUGGEST_URL}${encodeURIComponent(query)}`, fetchImpl)
  return Array.isArray(data?.data) ? data.data : []
}

/** The lyrics body for one artist + title, or null. */
async function lyricsFor (artist, title, fetchImpl = fetch) {
  if (!artist || !title) return null
  const data = await getJson(`${LYRICS_URL}${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, fetchImpl)
  const text = String(data?.lyrics || '').replace(/\r/g, '').trim()
  return text || null
}

/**
 * Resolves a free-text `.play <song name>` into lyrics.
 *
 * Tries the best match first, then the next few candidates, so a slightly off
 * title still finds the song. Returns:
 *   { found: true, artist, title, lyrics }
 *   { found: false }
 */
async function lookup (query, { fetchImpl = fetch } = {}) {
  const clean = String(query || '').trim()
  if (!clean) return { found: false }

  let matches = []
  try { matches = await suggest(clean, fetchImpl) } catch { matches = [] }

  for (const cand of matches.slice(0, 4)) {
    const artist = String(cand?.artist?.name || '').trim()
    const title = String(cand?.title || '').trim()
    if (!artist || !title) continue
    let lyrics = null
    try { lyrics = await lyricsFor(artist, title, fetchImpl) } catch { lyrics = null }
    if (lyrics) return { found: true, artist, title, lyrics }
  }

  return { found: false }
}

module.exports = { lookup, suggest, lyricsFor, SUGGEST_URL, LYRICS_URL }
