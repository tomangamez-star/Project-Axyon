'use strict'

// Upgraded Old Gen collectible renderer. All combat/card metadata is rendered
// into this one image; no secondary WhatsApp-only stat card is required.
const baseRenderer = require('./hunt-card')
const WIDTH = 700
const HEIGHT = 900
const OLD_GEN = {
  1: { symbol: 'C', label: 'COMMON', accent: '#8FC9FF', accent2: '#D9EEFF' },
  2: { symbol: 'R', label: 'RARE', accent: '#51F28D', accent2: '#B9FFD1' },
  3: { symbol: 'M', label: 'MYTHICAL', accent: '#B96CFF', accent2: '#F0C8FF' },
  4: { symbol: 'L', label: 'LEGACY', accent: '#A96AFF', accent2: '#FFD066' },
  5: { symbol: 'U', label: 'ULTIMATE', accent: '#FFD34F', accent2: '#FF8A2A' },
  6: { symbol: '✦', label: 'GODLIKE', accent: '#FFE476', accent2: '#FF4D3D' }
}
let sharpModule
let sharpLoadAttempted = false
function getSharp () {
  if (sharpLoadAttempted) return sharpModule || null
  sharpLoadAttempted = true
  try { sharpModule = require('sharp') } catch (error) {
    sharpModule = null
    console.warn(`[special-cards] sharp unavailable; Old Gen rendering disabled: ${error.message}`)
  }
  return sharpModule
}
function available () { return !!getSharp() }
function clean (value, max = 100) {
  return String(value == null ? '' : value).replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '').replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max)
}
function esc (value) {
  return clean(value, 180).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
function tierFor (card) { return baseRenderer.tierFor(card) }
function oldTier (card) { const t = tierFor(card); return { ...t, ...(OLD_GEN[t.tier] || OLD_GEN[1]) } }
function hex (n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0') }
function rgbToHsl (r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0, s = 0
  const l = (max + min) / 2
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60; if (h < 0) h += 360
  }
  return [h, s, l]
}
function hslToHex (h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2
  let rgb = [0, 0, 0]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return `#${rgb.map(v => hex((v + m) * 255)).join('')}`
}
function paletteFrom (dominant, tier) {
  if (!dominant || !Number.isFinite(dominant.r)) return { accent: tier.accent, accent2: tier.accent2, glow: tier.accent }
  const [h, s, l] = rgbToHsl(dominant.r, dominant.g, dominant.b)
  // Keep the card in the artwork's colour family. A near-complementary hue
  // made purple/blue art produce red/teal frames even though those colours
  // were not present in the character image.
  const saturation = Math.max(.42, Math.min(.88, s * 1.04))
  const accent = hslToHex(h, saturation, Math.max(.38, Math.min(.66, l)))
  const secondary = hslToHex((h + 18) % 360, Math.max(.38, saturation * .92), .68)
  return { accent, accent2: secondary, glow: accent }
}
function wrap (value, limit = 42, maxLines = 2) {
  const words = clean(value, 180).split(/\s+/).filter(Boolean)
  const lines = []; let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length > limit && line) { lines.push(line); line = word; if (lines.length === maxLines - 1) break }
    else line = next
  }
  if (line && lines.length < maxLines) lines.push(line)
  return lines.length ? lines : ['—']
}
function expiryLabel (value) {
  if (!value) return 'PERMANENT'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'PERMANENT'
  const remaining = date.getTime() - Date.now()
  const dayCount = Math.ceil(remaining / 86400000)
  const dateText = date.toISOString().slice(0, 10)
  return remaining <= 0 ? `EXPIRED • ${dateText}` : `${dateText} • ${dayCount}D LEFT`
}
function starRow (rating, accent) {
  const n = Math.max(0, Math.min(10, Number(rating ?? 5) || 0))
  const gap = 24, start = 350 - (9 * gap) / 2
  return Array.from({ length: 10 }, (_, i) => `<text x="${start + i * gap}" y="607" text-anchor="middle" font-size="22" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="${i < n ? accent : '#667085'}" opacity="${i < n ? 1 : .55}" stroke="#101018" stroke-width="1.5" paint-order="stroke">★</text>`).join('')
}
function overlaySvg (card, palette = null) {
  const tier = oldTier(card)
  const colors = palette || { accent: tier.accent, accent2: tier.accent2, glow: tier.accent }
  const name = esc(card.name || 'UNKNOWN')
  const type = String(card.card_type || card.cardType || 'character').toUpperCase() === 'WEAPON' ? 'WEAPON' : 'CHARACTER'
  const subtitle = esc(card.series || (type === 'WEAPON' ? 'AXYON ARMORY' : 'ANIME ARCHIVE')).toUpperCase()
  const nameSize = name.length > 25 ? 34 : name.length > 18 ? 42 : name.length > 12 ? 49 : 57
  const ability = wrap(card.ability || 'No ability assigned', 30, 2)
  const abilityLines = ability.map((line, i) => `<text x="92" y="768" dy="${i * 24}" font-size="20" font-family="DejaVu Sans,Arial,sans-serif" font-weight="800" fill="#F5F7FF">${esc(line)}</text>`).join('')
  const rarity = esc(tier.label)
  const damage = Math.max(0, Number(card.damage) || 0)
  const abilityDamage = Math.max(0, Number(card.ability_damage ?? card.abilityDamage) || 0)
  const percentRating = Math.max(0, Math.min(100, Number(card.percent_rating ?? card.percentRating ?? Math.round((Number(card.rating) || tier.tier) / 6 * 100))))
  const starRating = Math.max(0, Math.min(10, Number(card.star_rating ?? card.starRating ?? Math.round((Number(card.rating) || tier.tier) / 6 * 10))))
  const expiry = esc(expiryLabel(card.expires_at || card.expiresAt))
  const weapon = esc(card.weapon || '—')
  const id = esc(String(card.character_id || card.id || 'AXYON').replace(/^anilist-/i, ''))
  return Buffer.from(`<svg width="700" height="900" viewBox="0 0 700 900" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors.accent}"/><stop offset="1" stop-color="${colors.accent2}"/></linearGradient>
    <linearGradient id="heroFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#080B13" stop-opacity="0"/><stop offset=".44" stop-color="#080B13" stop-opacity=".18"/><stop offset=".66" stop-color="#080B13" stop-opacity=".86"/><stop offset="1" stop-color="#060810" stop-opacity=".99"/></linearGradient>
    <linearGradient id="infoPanel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors.accent}" stop-opacity=".23"/><stop offset=".55" stop-color="#080C17" stop-opacity=".94"/><stop offset="1" stop-color="${colors.accent2}" stop-opacity=".18"/></linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4"/></filter>
  </defs>
  <rect x="22" y="22" width="656" height="856" rx="18" fill="none" stroke="#05070C" stroke-width="20"/>
  <rect x="32" y="32" width="636" height="836" rx="12" fill="none" stroke="url(#edge)" stroke-width="5" filter="url(#glow)"/>
  <path d="M42 42 H166 L132 76 H42 Z M658 42 H534 L568 76 H658 Z M42 858 H170 L132 824 H42 Z M658 858 H530 L568 824 H658 Z" fill="${colors.accent}" opacity=".72"/>
  <rect x="48" y="45" width="604" height="810" fill="url(#heroFade)"/>
  <path d="M49 560 L128 560 L101 589 L49 589 Z M651 560 L572 560 L599 589 L651 589 Z" fill="${colors.accent2}" opacity=".68"/>
  <path d="M50 622 L650 622 L630 856 L70 856 Z" fill="url(#infoPanel)" stroke="${colors.accent}" stroke-opacity=".76" stroke-width="2.5"/>
  <path d="M50 622 L650 622 L628 640 L72 640 Z" fill="${colors.accent}" opacity=".82"/>
  <path d="M50 622 L85 622 L68 640 L50 640 Z M650 622 L615 622 L632 640 L650 640 Z" fill="#F5F7FF" opacity=".55"/>
  <path d="M54 54 L111 43 L145 78 L130 137 L76 151 L43 111 Z" fill="#080B13" fill-opacity=".9" stroke="url(#edge)" stroke-width="4"/>
  <text x="94" y="101" text-anchor="middle" font-size="45" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="${colors.accent2}">${esc(tier.symbol)}</text>
  <text x="94" y="123" text-anchor="middle" font-size="10" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="1" fill="#FFFFFF">T${tier.tier} ${rarity}</text>
  <path d="M570 48 L650 48 L650 133 L608 151 L566 133 Z" fill="#080B13" fill-opacity=".93" stroke="url(#edge)" stroke-width="3"/>
  <text x="608" y="83" text-anchor="middle" font-size="12" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="1.2" fill="#DCE6F5">RATING</text>
  <text x="608" y="124" text-anchor="middle" font-size="34" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="${colors.accent2}">${percentRating}<tspan font-size="15" fill="#FFFFFF">/100</tspan></text>
  <text x="350" y="535" text-anchor="middle" font-size="${nameSize}" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="900" fill="#FFFFFF" stroke="#080B13" stroke-width="4" paint-order="stroke" filter="url(#glow)">${name}</text>
  <text x="350" y="571" text-anchor="middle" font-size="16" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="3" fill="${colors.accent2}">${subtitle}</text>
  ${starRow(starRating, colors.accent2)}
  <text x="82" y="660" font-size="13" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="1.5" fill="${colors.accent2}">BASE DAMAGE</text>
  <text x="82" y="693" font-size="32" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="#FFFFFF">${damage}</text>
  <text x="350" y="660" font-size="13" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="1.5" fill="${colors.accent2}">CARD TYPE</text>
  <text x="350" y="690" font-size="19" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="#FFFFFF">${type}</text>
  <text x="618" y="660" text-anchor="end" font-size="13" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="1.5" fill="${colors.accent2}">WEAPON</text>
  <text x="618" y="690" text-anchor="end" font-size="14" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="#FFFFFF">${weapon}</text>
  <path d="M82 711 H618" stroke="${colors.accent2}" stroke-opacity=".42" stroke-width="1.5"/>
  <text x="82" y="739" font-size="12" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="1.7" fill="${colors.accent2}">SPECIAL ABILITY</text>
  ${abilityLines}
  <rect x="462" y="725" width="156" height="79" rx="8" fill="#060912" fill-opacity=".88" stroke="${colors.accent}" stroke-width="1.5"/>
  <text x="540" y="751" text-anchor="middle" font-size="10" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="1" fill="${colors.accent2}">ABILITY DMG</text>
  <text x="540" y="784" text-anchor="middle" font-size="27" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="#FFFFFF">${abilityDamage}</text>
  <text x="82" y="829" font-size="11" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="1.1" fill="${colors.accent2}">EXPIRY</text>
  <text x="149" y="829" font-size="13" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="#FFFFFF">${expiry}</text>
  <text x="618" y="829" text-anchor="end" font-size="12" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" fill="#FFFFFF" opacity=".75">#${id.slice(0, 15)}</text>
  <text x="350" y="854" text-anchor="middle" font-size="16" font-family="DejaVu Sans,Arial,sans-serif" font-weight="900" letter-spacing="3" fill="#FFFFFF" opacity=".92">⌬ AXYN CORE</text>
  </svg>`)
}
async function render (card, imageBuffer) {
  const sharp = getSharp()
  if (!sharp || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null
  const tier = oldTier(card)
  let palette = null
  try {
    // Reuse the multi-sample artwork palette from AI Custom so both renderer
    // paths stay faithful to the actual image instead of one noisy pixel.
    const sampled = await require('./ai-custom-card').samplePalette(sharp, imageBuffer)
    palette = { accent: sampled.a, accent2: sampled.b, glow: sampled.a }
  } catch {}
  if (!palette) {
    let dominant = null
    try { dominant = (await sharp(imageBuffer).stats()).dominant } catch {}
    palette = paletteFrom(dominant, tier)
  }
  const hero = await sharp(imageBuffer).rotate().resize(604, 810, { fit: 'cover', position: 'attention' })
    .modulate({ saturation: 1.08, brightness: 0.98 }).png().toBuffer()
  const ambience = Buffer.from(`<svg width="700" height="900" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="a"><stop offset="0" stop-color="${palette.accent}" stop-opacity=".34"/><stop offset="1" stop-color="#05070C" stop-opacity=".98"/></radialGradient></defs><rect width="700" height="900" fill="#05070C"/><rect width="700" height="900" fill="url(#a)"/></svg>`)
  const buffer = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#05070C' } })
    .composite([{ input: ambience, left: 0, top: 0 }, { input: hero, left: 48, top: 45 }, { input: overlaySvg(card, palette), left: 0, top: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
  return { buffer, tier, width: WIDTH, height: HEIGHT, style: 'old-gen' }
}
module.exports = { WIDTH, HEIGHT, OLD_GEN, available, tierFor, oldTier, overlaySvg, expiryLabel, paletteFrom, render }
