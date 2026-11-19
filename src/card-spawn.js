'use strict'

/*
 * AXYON CARD SPAWNER
 * Uses the upgraded Old Gen renderer only. SerpApi's Pinterest engine is the
 * primary character-art source when configured; existing providers remain a
 * fallback. A drop is global:
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

const CHARACTER_VARIANTS = [
  { name: 'Son Goku (Base Form)', series: 'Dragon Ball', searchTerm: 'Son Goku base form' },
  { name: 'Son Goku (Super Saiyan)', series: 'Dragon Ball', searchTerm: 'Super Saiyan Goku' },
  { name: 'Son Goku (Super Saiyan 2)', series: 'Dragon Ball', searchTerm: 'Goku Super Saiyan 2' },
  { name: 'Son Goku (Super Saiyan 3)', series: 'Dragon Ball', searchTerm: 'Goku Super Saiyan 3' },
  { name: 'Son Goku (Super Saiyan God)', series: 'Dragon Ball', searchTerm: 'Goku Super Saiyan God' },
  { name: 'Son Goku (Super Saiyan Blue)', series: 'Dragon Ball', searchTerm: 'Goku Super Saiyan Blue' },
  { name: 'Son Goku (Ultra Instinct Sign)', series: 'Dragon Ball', searchTerm: 'Goku Ultra Instinct Sign' },
  { name: 'Son Goku (Mastered Ultra Instinct)', series: 'Dragon Ball', searchTerm: 'Mastered Ultra Instinct Goku' },
  { name: 'Vegeta (Base Form)', series: 'Dragon Ball', searchTerm: 'Vegeta base form' },
  { name: 'Vegeta (Super Saiyan)', series: 'Dragon Ball', searchTerm: 'Super Saiyan Vegeta' },
  { name: 'Vegeta (Majin)', series: 'Dragon Ball', searchTerm: 'Majin Vegeta' },
  { name: 'Vegeta (Super Saiyan God)', series: 'Dragon Ball', searchTerm: 'Vegeta Super Saiyan God' },
  { name: 'Vegeta (Super Saiyan Blue)', series: 'Dragon Ball', searchTerm: 'Vegeta Super Saiyan Blue' },
  { name: 'Vegeta (Ultra Ego)', series: 'Dragon Ball', searchTerm: 'Vegeta Ultra Ego' },
  { name: 'Naruto Uzumaki (Base)', series: 'Naruto', searchTerm: 'Naruto Uzumaki base' },
  { name: 'Naruto Uzumaki (Sage Mode)', series: 'Naruto', searchTerm: 'Naruto Sage Mode' },
  { name: 'Naruto Uzumaki (Kurama Chakra Mode)', series: 'Naruto', searchTerm: 'Naruto Kurama Chakra Mode' },
  { name: 'Naruto Uzumaki (Six Paths Sage Mode)', series: 'Naruto', searchTerm: 'Naruto Six Paths Sage Mode' },
  { name: 'Naruto Uzumaki (Adult)', series: 'Boruto', searchTerm: 'Adult Naruto Uzumaki' },
  { name: 'Sasuke Uchiha (Base)', series: 'Naruto', searchTerm: 'Sasuke Uchiha base' },
  { name: 'Sasuke Uchiha (Sharingan)', series: 'Naruto', searchTerm: 'Sasuke Sharingan' },
  { name: 'Sasuke Uchiha (Mangekyo Sharingan)', series: 'Naruto', searchTerm: 'Sasuke Mangekyo Sharingan' },
  { name: 'Sasuke Uchiha (Rinnegan)', series: 'Naruto', searchTerm: 'Sasuke Rinnegan' },
  { name: 'Sasuke Uchiha (Adult)', series: 'Boruto', searchTerm: 'Adult Sasuke Uchiha' },
  { name: 'Monkey D. Luffy (Pre-Timeskip)', series: 'One Piece', searchTerm: 'Monkey D Luffy pre timeskip' },
  { name: 'Monkey D. Luffy (Post-Timeskip)', series: 'One Piece', searchTerm: 'Monkey D Luffy post timeskip' },
  { name: 'Monkey D. Luffy (Gear 2)', series: 'One Piece', searchTerm: 'Luffy Gear Second' },
  { name: 'Monkey D. Luffy (Gear 3)', series: 'One Piece', searchTerm: 'Luffy Gear Third' },
  { name: 'Monkey D. Luffy (Gear 4 Boundman)', series: 'One Piece', searchTerm: 'Luffy Gear Fourth Boundman' },
  { name: 'Monkey D. Luffy (Gear 4 Snakeman)', series: 'One Piece', searchTerm: 'Luffy Gear Fourth Snakeman' },
  { name: 'Monkey D. Luffy (Gear 5)', series: 'One Piece', searchTerm: 'Luffy Gear Five' },
  { name: 'Roronoa Zoro (East Blue)', series: 'One Piece', searchTerm: 'Roronoa Zoro East Blue' },
  { name: 'Roronoa Zoro (Post-Timeskip)', series: 'One Piece', searchTerm: 'Roronoa Zoro post timeskip' },
  { name: 'Roronoa Zoro (King of Hell)', series: 'One Piece', searchTerm: 'Zoro King of Hell' },
  { name: 'Ichigo Kurosaki (Base)', series: 'Bleach', searchTerm: 'Ichigo Kurosaki base' },
  { name: 'Ichigo Kurosaki (Shikai)', series: 'Bleach', searchTerm: 'Ichigo Shikai' },
  { name: 'Ichigo Kurosaki (Bankai)', series: 'Bleach', searchTerm: 'Ichigo Bankai' },
  { name: 'Ichigo Kurosaki (Hollow Form)', series: 'Bleach', searchTerm: 'Ichigo Hollow form' },
  { name: 'Ichigo Kurosaki (Thousand-Year Blood War)', series: 'Bleach', searchTerm: 'Ichigo TYBW' },
  { name: 'Satoru Gojo (Casual)', series: 'Jujutsu Kaisen', searchTerm: 'Satoru Gojo casual portrait' },
  { name: 'Satoru Gojo (Blindfold)', series: 'Jujutsu Kaisen', searchTerm: 'Satoru Gojo blindfold' },
  { name: 'Satoru Gojo (Awakened)', series: 'Jujutsu Kaisen', searchTerm: 'Satoru Gojo awakened' },
  { name: 'Yuji Itadori (Base)', series: 'Jujutsu Kaisen', searchTerm: 'Yuji Itadori' },
  { name: 'Yuji Itadori (Awakened)', series: 'Jujutsu Kaisen', searchTerm: 'Yuji Itadori awakened' },
  { name: 'Megumi Fushiguro', series: 'Jujutsu Kaisen', searchTerm: 'Megumi Fushiguro portrait' },
  { name: 'Nobara Kugisaki', series: 'Jujutsu Kaisen', searchTerm: 'Nobara Kugisaki portrait' },
  { name: 'Yuta Okkotsu', series: 'Jujutsu Kaisen', searchTerm: 'Yuta Okkotsu portrait' },
  { name: 'Tanjiro Kamado (Base)', series: 'Demon Slayer', searchTerm: 'Tanjiro Kamado base' },
  { name: 'Tanjiro Kamado (Hinokami Kagura)', series: 'Demon Slayer', searchTerm: 'Tanjiro Hinokami Kagura' },
  { name: 'Nezuko Kamado (Base)', series: 'Demon Slayer', searchTerm: 'Nezuko Kamado' },
  { name: 'Nezuko Kamado (Awakened)', series: 'Demon Slayer', searchTerm: 'Nezuko awakened form' },
  { name: 'Zenitsu Agatsuma', series: 'Demon Slayer', searchTerm: 'Zenitsu Agatsuma portrait' },
  { name: 'Inosuke Hashibira', series: 'Demon Slayer', searchTerm: 'Inosuke Hashibira portrait' },
  { name: 'Giyu Tomioka', series: 'Demon Slayer', searchTerm: 'Giyu Tomioka portrait' },
  { name: 'Kyojuro Rengoku', series: 'Demon Slayer', searchTerm: 'Kyojuro Rengoku portrait' },
  { name: 'Eren Yeager (Cadet)', series: 'Attack on Titan', searchTerm: 'Eren Yeager cadet' },
  { name: 'Eren Yeager (Season 4)', series: 'Attack on Titan', searchTerm: 'Eren Yeager season 4' },
  { name: 'Mikasa Ackerman', series: 'Attack on Titan', searchTerm: 'Mikasa Ackerman portrait' },
  { name: 'Levi Ackerman', series: 'Attack on Titan', searchTerm: 'Levi Ackerman portrait' },
  { name: 'Armin Arlert', series: 'Attack on Titan', searchTerm: 'Armin Arlert portrait' },
  { name: 'Light Yagami', series: 'Death Note', searchTerm: 'Light Yagami portrait' },
  { name: 'L Lawliet', series: 'Death Note', searchTerm: 'L Lawliet portrait' },
  { name: 'Ryuk', series: 'Death Note', searchTerm: 'Ryuk Death Note portrait' },
  { name: 'Edward Elric', series: 'Fullmetal Alchemist', searchTerm: 'Edward Elric portrait' },
  { name: 'Alphonse Elric', series: 'Fullmetal Alchemist', searchTerm: 'Alphonse Elric portrait' },
  { name: 'Roy Mustang', series: 'Fullmetal Alchemist', searchTerm: 'Roy Mustang portrait' },
  { name: 'Izuku Midoriya (Base)', series: 'My Hero Academia', searchTerm: 'Izuku Midoriya base' },
  { name: 'Izuku Midoriya (Full Cowling)', series: 'My Hero Academia', searchTerm: 'Deku Full Cowling' },
  { name: 'Katsuki Bakugo', series: 'My Hero Academia', searchTerm: 'Katsuki Bakugo portrait' },
  { name: 'Shoto Todoroki', series: 'My Hero Academia', searchTerm: 'Shoto Todoroki portrait' },
  { name: 'All Might', series: 'My Hero Academia', searchTerm: 'All Might portrait' },
  { name: 'Tomura Shigaraki', series: 'My Hero Academia', searchTerm: 'Tomura Shigaraki portrait' },
  { name: 'Killua Zoldyck', series: 'Hunter x Hunter', searchTerm: 'Killua Zoldyck portrait' },
  { name: 'Gon Freecss (Base)', series: 'Hunter x Hunter', searchTerm: 'Gon Freecss base' },
  { name: 'Gon Freecss (Adult Form)', series: 'Hunter x Hunter', searchTerm: 'Gon adult form' },
  { name: 'Kurapika', series: 'Hunter x Hunter', searchTerm: 'Kurapika portrait' },
  { name: 'Hisoka Morow', series: 'Hunter x Hunter', searchTerm: 'Hisoka Morow portrait' },
  { name: 'Saitama', series: 'One Punch Man', searchTerm: 'Saitama portrait' },
  { name: 'Genos', series: 'One Punch Man', searchTerm: 'Genos portrait' },
  { name: 'Garou (Human)', series: 'One Punch Man', searchTerm: 'Garou human form' },
  { name: 'Garou (Cosmic Fear)', series: 'One Punch Man', searchTerm: 'Garou cosmic fear form' },
  { name: 'Anya Forger', series: 'Spy x Family', searchTerm: 'Anya Forger portrait' },
  { name: 'Loid Forger', series: 'Spy x Family', searchTerm: 'Loid Forger portrait' },
  { name: 'Yor Forger', series: 'Spy x Family', searchTerm: 'Yor Forger portrait' },
  { name: 'Denji (Human)', series: 'Chainsaw Man', searchTerm: 'Denji human portrait' },
  { name: 'Denji (Chainsaw Form)', series: 'Chainsaw Man', searchTerm: 'Denji Chainsaw Man form' },
  { name: 'Power', series: 'Chainsaw Man', searchTerm: 'Power Chainsaw Man portrait' },
  { name: 'Makima', series: 'Chainsaw Man', searchTerm: 'Makima portrait' },
  { name: 'Aki Hayakawa', series: 'Chainsaw Man', searchTerm: 'Aki Hayakawa portrait' },
  { name: 'Shoyo Hinata', series: 'Haikyu!!', searchTerm: 'Shoyo Hinata portrait' },
  { name: 'Tobio Kageyama', series: 'Haikyu!!', searchTerm: 'Tobio Kageyama portrait' },
  { name: 'Sakuta Azusagawa', series: 'Rascal Does Not Dream', searchTerm: 'Sakuta Azusagawa portrait' },
  { name: 'Violet Evergarden', series: 'Violet Evergarden', searchTerm: 'Violet Evergarden portrait' },
  { name: 'Frieren', series: 'Frieren: Beyond Journey’s End', searchTerm: 'Frieren anime portrait' },
  { name: 'Fern', series: 'Frieren: Beyond Journey’s End', searchTerm: 'Fern Frieren anime portrait' },
  { name: 'Maomao', series: 'The Apothecary Diaries', searchTerm: 'Maomao anime portrait' },
  { name: 'Marin Kitagawa', series: 'My Dress-Up Darling', searchTerm: 'Marin Kitagawa portrait' },
  { name: 'Himmel', series: 'Frieren: Beyond Journey’s End', searchTerm: 'Himmel Frieren portrait' },
  { name: 'Rimuru Tempest', series: 'That Time I Got Reincarnated as a Slime', searchTerm: 'Rimuru Tempest portrait' },
  { name: 'Anos Voldigoad', series: 'The Misfit of Demon King Academy', searchTerm: 'Anos Voldigoad portrait' },
  { name: 'Shinra Kusakabe', series: 'Fire Force', searchTerm: 'Shinra Kusakabe portrait' },
  { name: 'Arthur Boyle', series: 'Fire Force', searchTerm: 'Arthur Boyle portrait' },
  { name: 'Senku Ishigami', series: 'Dr. Stone', searchTerm: 'Senku Ishigami portrait' },
  { name: 'Koro-sensei', series: 'Assassination Classroom', searchTerm: 'Koro sensei portrait' },
]

async function fetchCharacter () {
  const picked = CHARACTER_VARIANTS[Math.floor(Math.random() * CHARACTER_VARIANTS.length)]
  return {
    id: `catalog-${picked.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: picked.name,
    imageUrl: '',
    series: picked.series,
    searchTerm: picked.searchTerm,
    favorites: 0
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
    const art = await artwork.resolveArtwork({ name: character.name, kind: 'character', fallbackUrl: character.imageUrl, series: character.series || 'Anime', searchTerm: character.searchTerm })
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
  CHARACTER_VARIANTS,
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
