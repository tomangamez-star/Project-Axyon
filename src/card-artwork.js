'use strict'

// Danbooru public read API + identity-matched AniList fallback.
// Public GETs do not require credentials. Credentials may be supplied for a
// registered Danbooru account, but this module never writes to Danbooru.
const API = 'https://danbooru.donmai.us/posts.json'

const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json'
const SERPAPI_TIMEOUT_MS = 20000
const UNSAFE_PIN_TERMS = /\b(nsfw|nude|nudity|explicit|porn|hentai|ecchi|sexual|18\+|adult content)\b/i

function pinterestQuery (name, searchTerm = '') {
  const identity = String(searchTerm || name || '').trim()
  if (!identity) throw new Error('A character name is required for Pinterest artwork search.')
  return `${identity} anime character portrait illustration`
}

function selectPinterestPin (pins = []) {
  const candidates = (Array.isArray(pins) ? pins : []).filter(pin => {
    const imageUrl = pin?.original || ''
    const width = Number(pin?.original_width || 0)
    const height = Number(pin?.original_height || 0)
    const text = `${pin?.title || ''} ${pin?.description || ''} ${pin?.alt_text || ''}`
    return validImageUrl(imageUrl) && width >= 420 && height >= 540 && height / width >= 1.12 && !UNSAFE_PIN_TERMS.test(text)
  }).sort((a, b) => {
    const score = pin => {
      const w = Number(pin.original_width) || 0
      const h = Number(pin.original_height) || 0
      const reactions = Math.max(0, Number(pin.reactions) || 0)
      return Math.min(w * h, 5000000) / 1000 + Math.min(reactions, 1000) * 2
    }
    return score(b) - score(a)
  })
  if (!candidates.length) return null
  // Randomise among the strongest portrait candidates instead of repeating
  // the same first result for every card.
  const shortlist = candidates.slice(0, Math.min(8, candidates.length))
  return shortlist[Math.floor(Math.random() * shortlist.length)]
}

async function searchPinterest (name, searchTerm = '') {
  const apiKey = String(process.env.SERPAPI_API_KEY || '').trim()
  if (!apiKey) throw new Error('SERPAPI_API_KEY is not configured. Add it to Render environment variables.')
  const params = new URLSearchParams({
    engine: 'pinterest',
    q: pinterestQuery(name, searchTerm),
    type: 'pins',
    api_key: apiKey
  })
  const response = await fetch(`${SERPAPI_ENDPOINT}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(SERPAPI_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`SerpApi Pinterest search failed (${response.status}).`)
  const json = await response.json()
  if (json?.error) throw new Error(`SerpApi Pinterest search failed: ${String(json.error).slice(0, 220)}`)
  const pin = selectPinterestPin(json?.pins)
  if (!pin) throw new Error(`Pinterest returned no suitable portrait artwork for ${name}.`)
  return pin
}

async function findPinterest (name, searchTerm = '') {
  const pin = await searchPinterest(name, searchTerm)
  const url = pin.original
  const buffer = await fetchBuffer(url)
  const pinUrl = pin.pin_link || pin.board?.link || `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(pinterestQuery(name, searchTerm))}`
  return {
    buffer,
    source: 'Pinterest via SerpApi',
    sourceUrl: pinUrl,
    fileUrl: url,
    sourceArtist: String(pin.pinner?.name || pin.pinner?.username || ''),
    pinId: String(pin.pin_id || '')
  }
}
const USER_AGENT = `AXYON-Core/2.0 (https://github.com/tomangamez-star/Project-Axyon; ${process.env.DANBOORU_USER_ID ? `user #${process.env.DANBOORU_USER_ID}` : 'anonymous API client'})`
let danbooruQueue = Promise.resolve()
let lastDanbooruReadAt = 0

async function fetchDanbooruJson (url, headers, signal) {
  const task = danbooruQueue.then(async () => {
    const delay = Math.max(0, 1000 - (Date.now() - lastDanbooruReadAt))
    if (delay) await new Promise(resolve => setTimeout(resolve, delay))
    lastDanbooruReadAt = Date.now()
    const response = await fetch(url, { headers, signal })
    if (!response.ok) throw new Error(`Danbooru lookup failed (${response.status}).`)
    return response.json()
  })
  danbooruQueue = task.catch(() => {})
  return task
}

function tagSlug (value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}
function tagAliases (value) {
  const original = tagSlug(value)
  const words = original.split('_').filter(Boolean)
  const reversed = words.length === 2 ? words.reverse().join('_') : ''
  return [...new Set([original, reversed].filter(Boolean))]
}
function tagMatches (tags, name) {
  const wanted = tagAliases(name)
  return String(tags || '').split(/\s+/).some(tag => {
    const raw = String(tag || '').toLowerCase().replace(/[\s-]+/g, '_')
    const normalized = tagSlug(tag)
    // Danbooru character tags may use family-name-first order and append
    // the franchise in parentheses, e.g. gojo_satoru_(jujutsu_kaisen).
    return wanted.some(alias => normalized === alias || raw.startsWith(`${alias}_(`))
  })
}
function validImageUrl (url) {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const privateHost = !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !privateHost && /\.(jpe?g|png|webp)(?:$|\?)/i.test(parsed.href)
  } catch { return false }
}

async function fetchBuffer (url, options = {}) {
  if (!validImageUrl(url)) throw new Error('Artwork URL must be a direct HTTPS JPEG, PNG or WebP image.')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeout || 18000)
  try {
    const headers = { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': USER_AGENT }
    let current = url
    let response
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!validImageUrl(current)) throw new Error('Artwork redirect must remain a public HTTPS image URL.')
      response = await fetch(current, { headers, signal: controller.signal, redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (!location || redirects === 3) throw new Error('Artwork source redirected too many times.')
      current = new URL(location, current).href
    }
    if (!response || !response.ok) throw new Error(`Artwork download failed (${response?.status || 'unknown'}).`)
    const type = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase()
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new Error('Artwork source did not return a supported image.')
    const length = Number(response.headers.get('content-length') || 0)
    if (length > 12 * 1024 * 1024) throw new Error('Artwork image exceeds the 12 MB limit.')
    const data = Buffer.from(await response.arrayBuffer())
    if (!data.length || data.length > 12 * 1024 * 1024) throw new Error('Artwork image is empty or too large.')
    return data
  } finally { clearTimeout(timeout) }
}

async function danbooruPosts (tag, kind = 'character') {
  const normalized = tagSlug(tag)
  if (!normalized) return []
  const params = new URLSearchParams({
    tags: `*${normalized}* rating:g -is:flagged -is:pending score:>=5 order:score`,
    limit: '50',
    only: 'id,rating,tag_string_character,tag_string_general,file_url,large_file_url,preview_file_url,file_ext,image_width,image_height,score,tag_string_artist,source'
  })
  const url = `${API}?${params}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 16000)
  try {
    const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT }
    if (process.env.DANBOORU_LOGIN && process.env.DANBOORU_API_KEY) {
      headers.Authorization = `Basic ${Buffer.from(`${process.env.DANBOORU_LOGIN}:${process.env.DANBOORU_API_KEY}`).toString('base64')}`
    }
    const rows = await fetchDanbooruJson(url, headers, controller.signal)
    const tagField = kind === 'weapon' ? 'tag_string_general' : 'tag_string_character'
    return (Array.isArray(rows) ? rows : []).filter(post => {
      const matchingTag = tagMatches(post[tagField], tag)
      const safeRating = String(post.rating || '').toLowerCase() === 'g'
      const ext = String(post.file_ext || '').toLowerCase()
      const image = ['jpg', 'jpeg', 'png', 'webp'].includes(ext)
      const dimensions = Number(post.image_width) >= 420 && Number(post.image_height) >= 540
      const direct = post.large_file_url || post.file_url
      return matchingTag && safeRating && image && dimensions && validImageUrl(direct)
    }).sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
  } finally { clearTimeout(timeout) }
}

async function findDanbooru (name, kind = 'character') {
  try {
    let rows = []
    for (const alias of tagAliases(name)) {
      rows = await danbooruPosts(alias.replace(/_/g, ' '), kind)
      if (rows.length) break
    }
    if (!rows.length) return null
    // Avoid always using the same top image; use only the top quality subset.
    const shortlist = rows.slice(0, Math.min(8, rows.length))
    const chosen = shortlist[Math.floor(Math.random() * shortlist.length)]
    const url = chosen.large_file_url || chosen.file_url
    const buffer = await fetchBuffer(url)
    return {
      buffer,
      source: 'Danbooru',
      sourceUrl: `https://danbooru.donmai.us/posts/${chosen.id}`,
      fileUrl: url,
      sourceArtist: String(chosen.tag_string_artist || '').split(/\s+/).map(x => x.replace(/_/g, ' ')).join(', '),
      postId: chosen.id
    }
  } catch (error) {
    // The matching fallback is used by resolveArtwork; do not silently pick a
    // different character from the tag search.
    return { error }
  }
}

async function aniListCharacter (name) {
  const query = `query ($search: String) { Character(search: $search) { id name { full } image { large } media(perPage: 1, sort: POPULARITY_DESC) { nodes { title { english romaji } } } } }`
  const response = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ query, variables: { search: name } }),
    signal: AbortSignal.timeout(16000)
  })
  if (!response.ok) throw new Error(`AniList fallback failed (${response.status}).`)
  const json = await response.json()
  const character = json?.data?.Character
  if (!character?.image?.large || tagSlug(character.name?.full) !== tagSlug(name)) {
    throw new Error(`No exact AniList character fallback was found for ${name}.`)
  }
  return {
    buffer: await fetchBuffer(character.image.large),
    source: 'AniList fallback',
    sourceUrl: character.image.large,
    fileUrl: character.image.large,
    sourceArtist: '',
    series: character.media?.nodes?.[0]?.title?.english || character.media?.nodes?.[0]?.title?.romaji || 'Anime'
  }
}

async function resolveArtwork ({ name, kind = 'character', fallbackUrl = '', series = '', searchTerm = '' } = {}) {
  if (!name) throw new Error('A character or weapon name is required for artwork matching.')
  if (kind === 'character' && (process.env.SERPAPI_API_KEY || process.env.SERPAPI_REQUIRED === 'true')) {
    try {
      const pinterest = await findPinterest(name, searchTerm)
      return { ...pinterest, series }
    } catch (error) {
      // Keep the existing exact-match providers as a fallback if Pinterest
      // has no usable portrait or the SerpApi request is temporarily down.
      if (process.env.SERPAPI_REQUIRED === 'true') throw error
    }
  }
  const found = await findDanbooru(name, kind)
  if (found?.buffer) return { ...found, series }
  if (fallbackUrl) {
    const buffer = await fetchBuffer(fallbackUrl)
    return { buffer, source: kind === 'character' ? 'AniList fallback' : 'AXYON supplied artwork', sourceUrl: fallbackUrl, fileUrl: fallbackUrl, sourceArtist: '', series }
  }
  if (kind === 'character') return aniListCharacter(name)
  throw new Error(`No exact safe Danbooru artwork was found for weapon tag “${name}”. Add a direct HTTPS image URL or use an exact Danbooru tag.`)
}

module.exports = { API, SERPAPI_ENDPOINT, USER_AGENT, tagSlug, tagAliases, tagMatches, validImageUrl, fetchBuffer, pinterestQuery, selectPinterestPin, searchPinterest, findPinterest, danbooruPosts, findDanbooru, resolveArtwork }
