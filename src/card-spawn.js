'use strict'

/*
 * AXYON CARD SPAWNER
 * Uses the upgraded Old Gen renderer only. Danbooru is the primary artwork
 * source; AniList is an identity-matched character fallback. A drop is global:
 * the first successful database transaction owns it.
 */
const crypto = require('crypto')
const store = require('./axyon-store')
const artwork = require('./card-artwork')
const renderers = [{ key: 'old-gen', render: require('./card-renderers/special-hunt-card') }]

const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000
// Generated drops default to a 30-day validity window; set 0 for permanent.
const CARD_VALIDITY_DAYS = process.env.AXYON_CARD_VALIDITY_DAYS == null
  ? 30
  : Math.max(0, Math.min(3650, Number.parseInt(process.env.AXYON_CARD_VALIDITY_DAYS, 10) || 0))
const TIER_WEIGHTS = [
  { tier: 1, weight: 45 }, { tier: 2, weight: 27 }, { tier: 3, weight: 15 },
  { tier: 4, weight: 8 }, { tier: 5, weight: 4 }, { tier: 6, weight: 1 }
]
const WEAPONS = ['Shadow Daggers', 'System Blade', 'Monarch Spear', 'Demon Fang', 'Aether Katana', 'Void Reaper']
const ABILITIES = ['Shadow Extraction', 'Crimson Break', 'Monarch Pressure', 'Void Step', 'Arcane Burst', 'Eclipse Slash']

let timer = null
let activeSocket = null
let running = false
let lastAutoAttemptAt = 0

function rollTier () {
  const total = TIER_WEIGHTS.reduce((n, x) => n + x.weight, 0)
  let roll = Math.random() * total
  for (const item of TIER_WEIGHTS) {
    roll -= item.weight
    if (roll < 0) return item.tier
  }
  return 1
}

function makeCode () {
  return crypto.randomBytes(6).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase()
}

async function fetchCharacter () {
  const page = 1 + Math.floor(Math.random() * 35)
  const query = `query ($page: Int) {
    Page(page: $page, perPage: 50) {
      characters(sort: FAVOURITES_DESC) {
        id
        name { full }
        image { large }
        favourites
        media(perPage: 1, sort: POPULARITY_DESC) { nodes { title { english romaji } } }
      }
    }
  }`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 18000)
  try {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'AXYON-Core/1.0' },
      body: JSON.stringify({ query, variables: { page } }),
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`AniList character lookup failed (${response.status})`)
    const json = await response.json()
    const rows = json?.data?.Page?.characters || []
    const candidates = rows.filter(x => x?.name?.full && x?.image?.large)
    if (!candidates.length) throw new Error('AniList returned no usable character portraits')
    const picked = candidates[Math.floor(Math.random() * candidates.length)]
    return {
      id: picked.id,
      name: picked.name.full,
      imageUrl: picked.image.large,
      series: picked.media?.nodes?.[0]?.title?.english || picked.media?.nodes?.[0]?.title?.romaji || 'Anime',
      favorites: Number(picked.favourites) || 0
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchImage (url) { return artwork.fetchBuffer(url) }

function buildCard (character, tier) {
  const weapon = WEAPONS[Math.floor(Math.random() * WEAPONS.length)]
  const ability = ABILITIES[Math.floor(Math.random() * ABILITIES.length)]
  return {
    id: character.id,
    character_id: `anilist-${character.id}`,
    name: character.name,
    series: character.series || 'Anime Character',
    favorites: character.favorites,
    forced_tier: tier,
    rarity: ['common', 'rare', 'epic', 'legendary', 'mythic', 'godlike'][tier - 1],
    weapon,
    damage: 8 + tier * 7,
    ability,
    ability_damage: 12 + tier * 9,
    rating: tier,
    expires_at: CARD_VALIDITY_DAYS > 0 ? new Date(Date.now() + CARD_VALIDITY_DAYS * 86400000).toISOString() : null
  }
}

async function enabledGroups () {
  return (await store.groups()).filter(g => g.enabled && String(g.group_jid || '').endsWith('@g.us'))
}

async function safeText (sock, jid, text, quoted) {
  try { await sock.sendMessage(jid, { text }, quoted ? { quoted } : {}) } catch {}
}

async function createAndBroadcast (sock, options = {}) {
  if (running) return { ok: false, reason: 'A card spawn is already running.' }
  running = true
  try {
    const groups = await enabledGroups()
    if (!groups.length) return { ok: false, reason: 'No registered, enabled groups are available for card drops.' }
    const destinations = new Map(groups.map(g => [g.group_jid, null]))
    if (options.announceJid) destinations.set(options.announceJid, options.quoted || null)

    const generating = '⌛ *AXYON CARD FORGE*\n\nA new collectible is being generated. The first hunter to claim its code will own it.'
    for (const [jid, quoted] of destinations) await safeText(sock, jid, generating, quoted)

    const character = await fetchCharacter()
    const tier = rollTier()
    const card = buildCard(character, tier)
    const art = await artwork.resolveArtwork({ name: character.name, kind: 'character', fallbackUrl: character.imageUrl, series: character.series || 'Anime' })
    card.series = art.series || character.series || 'Anime'
    const sourceBuffer = art.buffer
    const renderer = renderers[0]
    if (!renderer.render.available()) throw new Error(`The ${renderer.key} renderer is unavailable. Install sharp and redeploy.`)
    const rendered = await renderer.render.render(card, sourceBuffer)
    if (!rendered?.buffer || !Buffer.isBuffer(rendered.buffer)) throw new Error('The card renderer returned no image.')

    let created
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode()
      try {
        created = await store.createCardDrop({
          code,
          name: character.name,
          series: card.series,
          weapon: card.weapon,
          damage: card.damage,
          ability: card.ability,
          abilityDamage: card.ability_damage,
          rating: tier,
          cardType: 'character',
          imageUrl: art.fileUrl || character.imageUrl,
          imageData: rendered.buffer,
          renderer: renderer.key,
          sourceUrl: art.sourceUrl || character.imageUrl,
          sourceArtist: art.sourceArtist || '',
          expiresAt: card.expires_at
        })
        break
      } catch (error) {
        if (error?.code !== '23505' || attempt === 4) throw error
      }
    }
    if (!created) throw new Error('Could not reserve a unique claim code.')

    const globalSettings = await store.settings().catch(() => ({ prefix: '!' }))
    const captionFor = (prefix) => [
      '✦ *AXYON — CARD DROP*',
      '',
      `*${character.name}*`,
      `Rarity: *${['COMMON', 'RARE', 'MYTHICAL', 'LEGACY', 'ULTIMATE', 'GODLIKE'][tier - 1]}*`,
      `Weapon: *${card.weapon}*`,
      `Damage: *${card.damage}*`,
      `Ability: *${card.ability}* (${card.ability_damage} damage)`,
      `Rating: *${tier}/6*`,
      `Artwork: *${art.source}*${art.sourceArtist ? ` • ${art.sourceArtist}` : ''}`,
      ...(art.sourceUrl ? [`Source: ${art.sourceUrl}`] : []),
      '',
      `Claim code: *#${created.claim_code}*`,
      'First successful claim wins globally.',
      '',
      `Use: *${prefix || globalSettings.prefix || '!'}claim card #CODE*`
    ].join('\n')

    let sent = 0
    for (const [jid] of destinations) {
      try {
        const group = groups.find(g => g.group_jid === jid)
        const prefix = group?.prefix || globalSettings.prefix || '!'
        await sock.sendMessage(jid, { image: rendered.buffer, caption: captionFor(prefix) })
        sent++
      } catch (error) {
        console.warn('[AXYON cards] broadcast failed:', jid, error?.message || error)
      }
    }
    if (options.auto) await store.setLastAutoCardSpawnAt(new Date())
    return { ok: true, card: created, code: created.claim_code, sent, total: destinations.size, tier, renderer: renderer.key }
  } catch (error) {
    console.error('[AXYON cards] spawn failed:', error?.stack || error)
    const failedGroups = await enabledGroups().catch(() => [])
    for (const group of failedGroups) await safeText(sock, group.group_jid, `⚠️ *AXYON CARD FORGE FAILED*\n\n${error.message}`)
    if (options.announceJid && !failedGroups.some(g => g.group_jid === options.announceJid)) {
      await safeText(sock, options.announceJid, `⚠️ Card generation failed: ${error.message}`, options.quoted)
    }
    return { ok: false, reason: error.message }
  } finally {
    running = false
  }
}

async function createPlayerCard (ownerId, input = {}) {
  const cardType = String(input.cardType || 'character').toLowerCase() === 'weapon' ? 'weapon' : 'character'
  const identity = String(input.name || '').trim()
  if (!identity) throw new Error('Card name is required.')
  const art = input.imageUrl
    ? { buffer: await artwork.fetchBuffer(input.imageUrl), source: 'AXYON supplied artwork', sourceUrl: input.imageUrl, fileUrl: input.imageUrl, sourceArtist: '', series: input.series || 'AXYON ARCHIVE' }
    : await artwork.resolveArtwork({
        name: identity,
        kind: cardType,
        series: input.series || (cardType === 'weapon' ? 'AXYON ARMORY' : 'Anime')
      })
  const card = {
    name: identity,
    series: input.series || art.series || (cardType === 'weapon' ? 'AXYON ARMORY' : 'ANIME'),
    card_type: cardType,
    weapon: input.weapon || (cardType === 'weapon' ? identity : ''),
    damage: Math.max(0, Math.min(999999, Number(input.damage) || 0)),
    ability: String(input.ability || '').slice(0, 100),
    ability_damage: Math.max(0, Math.min(999999, Number(input.abilityDamage) || 0)),
    rating: Math.max(1, Math.min(6, Number(input.rating) || 1)),
    expires_at: input.expiresAt || null,
    forced_tier: Math.max(1, Math.min(6, Number(input.rating) || 1)),
    character_id: `admin-${Date.now()}`
  }
  const renderer = renderers[0]
  if (!renderer.render.available()) throw new Error('Sharp is required for card image rendering.')
  const rendered = await renderer.render.render(card, art.buffer)
  const saved = await store.addCard(ownerId, {
    name: card.name,
    cardType,
    series: card.series,
    weapon: card.weapon,
    damage: card.damage,
    ability: card.ability,
    abilityDamage: card.ability_damage,
    rating: card.rating,
    expiresAt: card.expires_at,
    claimed: true,
    imageUrl: art.fileUrl || input.imageUrl || '',
    imageData: rendered.buffer,
    renderer: renderer.key,
    sourceUrl: art.sourceUrl || '',
    sourceArtist: art.sourceArtist || ''
  })
  return { card: saved, artwork: art, rendered }
}

async function renderUpdatedArtwork (card, imageUrl) {
  const art = imageUrl
    ? { buffer: await artwork.fetchBuffer(imageUrl), source: 'AXYON supplied artwork', sourceUrl: imageUrl, fileUrl: imageUrl, sourceArtist: '' }
    : await artwork.resolveArtwork({ name: card.name, kind: card.card_type || 'character' })
  const renderer = renderers[0]
  const payload = {
    name: card.name,
    series: card.series || (card.card_type === 'weapon' ? 'AXYON ARMORY' : 'ANIME'),
    card_type: card.card_type || 'character',
    weapon: card.weapon,
    damage: card.damage,
    ability: card.ability,
    ability_damage: card.ability_damage,
    rating: card.rating,
    forced_tier: card.rating,
    expires_at: card.expires_at || card.expiresAt || null
  }
  const rendered = await renderer.render.render(payload, art.buffer)
  return { art, rendered }
}

async function tick () {
  if (!activeSocket || running) return
  try {
    const now = Date.now()
    if (now - lastAutoAttemptAt < 10 * 60 * 1000) return
    const state = await store.cardSpawnState()
    const last = state?.last_auto_spawn_at ? new Date(state.last_auto_spawn_at).getTime() : 0
    if (now - last < AUTO_INTERVAL_MS) return
    const groups = await enabledGroups()
    if (!groups.length) return
    lastAutoAttemptAt = now
    await createAndBroadcast(activeSocket, { auto: true })
  } catch (error) {
    console.warn('[AXYON cards] scheduler tick failed:', error?.message || error)
  }
}

function start (sock) {
  if (timer) clearInterval(timer)
  activeSocket = sock
  void tick()
  timer = setInterval(() => void tick(), 60 * 1000)
  timer.unref?.()
}

function stop (sock) {
  if (sock && activeSocket !== sock) return
  if (timer) clearInterval(timer)
  timer = null
  activeSocket = null
}

module.exports = {
  AUTO_INTERVAL_MS,
  CARD_VALIDITY_DAYS,
  createAndBroadcast,
  start,
  stop,
  fetchCharacter,
  createPlayerCard,
  renderUpdatedArtwork,
  renderers,
  artwork
}
