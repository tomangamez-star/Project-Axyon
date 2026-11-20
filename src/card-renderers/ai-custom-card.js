'use strict'

// AI Custom — cinematic battle-card renderer. Independent from Old Gen.
// The lower-left combat panel is intentionally angled, leaving the right side
// open for premium geometry and the character artwork to breathe.
const WIDTH = 700
const HEIGHT = 900
let sharpModule
let sharpTried = false
function sharp () {
  if (sharpTried) return sharpModule
  sharpTried = true
  try { sharpModule = require('sharp') } catch (error) {
    sharpModule = null
    console.warn(`[ai-custom] sharp unavailable: ${error.message}`)
  }
  return sharpModule
}
function available () { return !!sharp() }
function clean (value, max = 120) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/https?:\/\/\S+/gi, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}
function esc (value, max) {
  return clean(value, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
function tierFor (card) {
  const n = Math.max(1, Math.min(6, Number(card.forced_tier || card.rarity_tier || card.rarity) || 1))
  const labels = ['COMMON', 'RARE', 'MYTHICAL', 'LEGACY', 'ULTIMATE', 'GODLIKE']
  const symbols = ['C', 'R', 'M', 'L', 'U', '✦']
  return { tier: n, label: labels[n - 1], symbol: symbols[n - 1] }
}
function hex (n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0') }
function hslHex (h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = l - c / 2
  let rgb
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return `#${rgb.map(v => hex((v + m) * 255)).join('')}`
}
function paletteFrom (dominant, tier) {
  if (!dominant || !Number.isFinite(dominant.r)) return { a: '#D94A45', b: '#F4B45B' }
  const r = dominant.r / 255, g = dominant.g / 255, b = dominant.b / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
  }
  const s = max ? d / max : 0
  const accent = hslHex(h, Math.max(.58, s), .58)
  const secondary = hslHex((h + (tier.tier >= 5 ? 28 : 155)) % 360, Math.max(.5, s), .68)
  return { a: accent, b: secondary }
}
function expiryLabel (value) {
  if (!value) return 'PERMANENT'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'PERMANENT'
  const days = Math.ceil((date.getTime() - Date.now()) / 86400000)
  return days <= 0 ? 'EXPIRED' : `${date.toISOString().slice(0, 10)} · ${days}D LEFT`
}
function svgOverlay (card, colors) {
  const tier = tierFor(card)
  const name = esc(card.name || 'UNKNOWN', 42)
  const type = String(card.card_type || card.cardType || 'character').toUpperCase() === 'WEAPON' ? 'WEAPON' : 'CHARACTER'
  const rarity = esc(tier.label, 20)
  const rating = Math.max(0, Math.min(100, Number(card.percent_rating ?? card.percentRating ?? 0)))
  const stars = Math.max(0, Math.min(10, Number(card.star_rating ?? card.starRating ?? 0)))
  const damage = Math.max(0, Number(card.damage ?? card.baseDamage) || 0)
  const ability = esc(card.ability || 'UNASSIGNED', 38)
  const abilityDamage = Math.max(0, Number(card.ability_damage ?? card.abilityDamage) || 0)
  const weapon = esc(card.weapon || '—', 30)
  const id = esc(String(card.character_id || card.id || 'AXYON').replace(/^anilist-/i, ''), 32)
  const series = esc(card.series || 'AXYON CORE', 38)
  const expiry = esc(expiryLabel(card.expires_at || card.expiresAt), 36)
  const starText = Array.from({ length: 10 }, (_, i) => `<text x="${118 + i * 35}" y="594" font-size="29" text-anchor="middle" fill="${i < stars ? colors.b : '#62616A'}" stroke="#0A0A10" stroke-width="2" paint-order="stroke">★</text>`).join('')
  const abilityFont = ability.length > 22 ? 17 : 21
  return Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors.a}"/><stop offset=".52" stop-color="#F7E8D0"/><stop offset="1" stop-color="${colors.b}"/></linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors.a}" stop-opacity=".28"/><stop offset=".45" stop-color="#090A12" stop-opacity=".94"/><stop offset="1" stop-color="${colors.b}" stop-opacity=".22"/></linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff" stop-opacity="0"/><stop offset=".43" stop-color="#fff" stop-opacity=".06"/><stop offset=".49" stop-color="#fff" stop-opacity=".32"/><stop offset=".54" stop-color="#fff" stop-opacity=".04"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
    <clipPath id="cardClip"><path d="M36 34 Q36 20 54 20 H646 Q666 20 666 42 V858 Q666 880 644 880 H56 Q34 880 34 858 Z"/></clipPath>
  </defs>
  <g clip-path="url(#cardClip)">
    <!-- cinematic top title plate; artwork remains visible beneath the overlays -->
    <path d="M36 34 H664 V142 L610 164 H36 Z" fill="#080A12" fill-opacity=".82" stroke="url(#frame)" stroke-width="3"/>
    <path d="M174 39 H620 L590 128 H120 Z" fill="url(#glass)" stroke="url(#frame)" stroke-width="2"/>
    <text x="360" y="101" text-anchor="middle" font-size="${name.length > 20 ? 34 : name.length > 13 ? 43 : 52}" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="900" fill="#FFF8F0" stroke="#101018" stroke-width="3" paint-order="stroke">${name}</text>
    <!-- rarity crest and rating shield -->
    <path d="M52 54 L112 30 L162 70 L147 145 L88 164 L42 119 Z" fill="#090B14" stroke="url(#frame)" stroke-width="5" filter="url(#glow)"/>
    <text x="103" y="103" text-anchor="middle" font-size="47" font-weight="900" fill="${colors.b}">${esc(tier.symbol, 3)}</text>
    <text x="103" y="128" text-anchor="middle" font-size="10" letter-spacing="1.3" font-weight="900" fill="#FFF">T${tier.tier} ${rarity}</text>
    <path d="M562 43 H646 L657 59 V139 L608 161 L560 139 Z" fill="#090B14" stroke="url(#frame)" stroke-width="3"/>
    <text x="609" y="78" text-anchor="middle" font-size="12" letter-spacing="1.5" font-weight="900" fill="#E9EAF2">RATING</text>
    <text x="609" y="121" text-anchor="middle" font-size="33" font-weight="900" fill="${colors.b}">${rating}<tspan font-size="13" fill="#FFF">/100</tspan></text>
    <!-- right-side premium negative-space geometry -->
    <path d="M535 190 L650 240 L650 492 L585 550 L535 505 Z" fill="none" stroke="${colors.a}" stroke-opacity=".72" stroke-width="3"/>
    <path d="M565 220 L630 251 V464 L590 503 L565 478 Z" fill="none" stroke="${colors.b}" stroke-opacity=".62" stroke-width="2"/>
    <path d="M548 265 L625 303 M548 305 L625 343 M548 345 L625 383" stroke="url(#frame)" stroke-opacity=".34" stroke-width="2"/>
    <circle cx="590" cy="390" r="62" fill="none" stroke="${colors.a}" stroke-opacity=".32" stroke-width="2"/>
    <circle cx="590" cy="390" r="43" fill="none" stroke="${colors.b}" stroke-opacity=".28" stroke-width="2" stroke-dasharray="7 10"/>
    <!-- stars sweep into the left combat panel -->
    <path d="M48 574 L470 574 L520 608 L48 608 Z" fill="#090A12" fill-opacity=".82" stroke="url(#frame)" stroke-width="3"/>
    ${starText}
    <!-- angled lower-left battle data slab; intentionally stops before right edge -->
    <path d="M42 624 L468 624 L548 858 L42 858 Z" fill="#070911" fill-opacity=".91" stroke="url(#frame)" stroke-width="4" filter="url(#shadow)"/>
    <path d="M42 624 L468 624 L548 858 L42 858 Z" fill="url(#glass)" stroke="url(#frame)" stroke-opacity=".8" stroke-width="2"/>
    <path d="M62 647 H437 L450 681 H62 Z" fill="${colors.a}" fill-opacity=".16"/>
    <text x="78" y="670" font-size="13" font-weight="900" letter-spacing="1.8" fill="${colors.b}">BASE DAMAGE</text>
    <text x="78" y="710" font-size="37" font-weight="900" fill="#FFF">${damage}</text>
    <path d="M62 729 H453" stroke="${colors.a}" stroke-opacity=".55" stroke-width="2"/>
    <text x="78" y="758" font-size="12" font-weight="900" letter-spacing="1.4" fill="${colors.b}">SPECIAL ABILITY</text>
    <text x="78" y="791" font-size="${abilityFont}" font-weight="900" fill="#FFF">${ability}</text>
    <path d="M342 766 L492 766 L510 824 L360 824 Z" fill="#080A12" fill-opacity=".96" stroke="${colors.a}" stroke-width="2.5"/>
    <text x="423" y="789" text-anchor="middle" font-size="10" letter-spacing="1.1" font-weight="900" fill="${colors.b}">ABILITY DMG</text>
    <text x="423" y="816" text-anchor="middle" font-size="25" font-weight="900" fill="#FFF">${abilityDamage}</text>
    <text x="78" y="833" font-size="11" font-weight="900" letter-spacing="1.2" fill="${colors.b}">WEAPON</text>
    <text x="150" y="833" font-size="14" font-weight="800" fill="#FFF">${weapon}</text>
    <!-- footer / series and identity -->
    <path d="M48 850 H538 L555 876 H48 Z" fill="#070911" stroke="url(#frame)" stroke-width="2"/>
    <text x="68" y="870" font-size="10" font-weight="900" fill="#E9EAF2">#${id}</text>
    <text x="315" y="870" text-anchor="middle" font-size="13" font-weight="900" letter-spacing="1.4" fill="#FFF">${series}</text>
    <text x="570" y="836" font-size="11" font-weight="900" fill="${colors.b}">${type}</text>
    <text x="570" y="856" font-size="10" font-weight="700" fill="#E9EAF2">${expiry}</text>
    <text x="570" y="872" font-size="15" font-weight="900" letter-spacing="1.2" fill="#FFF">AXYON</text>
    <!-- printed gloss sheet: clipped diagonal reflection plus fine specular streaks -->
    <path d="M-110 110 L80 -20 L310 -20 L-20 900 L-210 900 Z" fill="url(#shine)" opacity=".82"/>
    <path d="M-20 510 L190 -20" stroke="#FFF" stroke-opacity=".20" stroke-width="7"/>
    <path d="M520 20 L690 370" stroke="#FFF" stroke-opacity=".16" stroke-width="5"/>
    <path d="M45 42 L655 42 L655 858 L45 858 Z" fill="none" stroke="#FFF" stroke-opacity=".32" stroke-width="2"/>
  </g>
  <!-- raised metallic perimeter -->
  <path d="M36 34 Q36 20 54 20 H646 Q666 20 666 42 V858 Q666 880 644 880 H56 Q34 880 34 858 Z" fill="none" stroke="#05060B" stroke-width="17"/>
  <path d="M36 34 Q36 20 54 20 H646 Q666 20 666 42 V858 Q666 880 644 880 H56 Q34 880 34 858 Z" fill="none" stroke="url(#frame)" stroke-width="5" filter="url(#glow)"/>
  <path d="M46 38 H650 V852" fill="none" stroke="#FFF" stroke-opacity=".48" stroke-width="2"/>
  </svg>`)
}
async function render (card, imageBuffer) {
  const s = sharp()
  if (!s || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null
  const tier = tierFor(card)
  let dominant = null
  try { dominant = (await s(imageBuffer).stats()).dominant } catch {}
  const colors = paletteFrom(dominant, tier)
  const hero = await s(imageBuffer).rotate().resize(700, 900, { fit: 'cover', position: 'attention' })
    .modulate({ saturation: 1.08, brightness: .88 }).png().toBuffer()
  const shade = Buffer.from(`<svg width="700" height="900" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#03040A" stop-opacity=".18"/><stop offset=".48" stop-color="#03040A" stop-opacity=".02"/><stop offset="1" stop-color="#03040A" stop-opacity=".82"/></linearGradient><radialGradient id="r"><stop stop-color="${colors.a}" stop-opacity=".22"/><stop offset="1" stop-color="#05060B" stop-opacity="0"/></radialGradient></defs><rect width="700" height="900" fill="url(#v)"/><circle cx="570" cy="380" r="240" fill="url(#r)"/></svg>`)
  const buffer = await s({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#05060B' } })
    .composite([{ input: hero, left: 0, top: 0 }, { input: shade, left: 0, top: 0 }, { input: svgOverlay(card, colors), left: 0, top: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
  return { buffer, tier, width: WIDTH, height: HEIGHT, style: 'ai-custom' }
}
module.exports = { WIDTH, HEIGHT, available, tierFor, paletteFrom, svgOverlay, render }
