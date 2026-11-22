'use strict'

// AI Custom v2 — an independent cinematic battle-card composition.
// Artwork is fitted without destructive face-cropping; a sampled image palette
// (not a generated complementary hue) drives every accent and the gloss.
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
    h = (h * 60 + 360) % 360
  }
  return [h, s, l]
}
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
function paletteFrom (samples, tier = { tier: 1 }) {
  // Accept a legacy single RGB dominant value for callers/tests, but do not
  // invent an opposite hue. A neutral image gets a restrained neutral pair.
  if (samples && Number.isFinite(samples.r)) samples = [{ r: samples.r, g: samples.g, b: samples.b }]
  if (!Array.isArray(samples) || !samples.length) return { a: '#B7C2D0', b: '#75869B', source: 'neutral' }
  const bins = Array.from({ length: 24 }, (_, i) => ({ hue: i * 15 + 7.5, weight: 0, r: 0, g: 0, b: 0, count: 0 }))
  for (const p of samples) {
    const [h, s, l] = rgbToHsl(p.r, p.g, p.b)
    if (s < .16 || l < .10 || l > .94) continue
    const idx = Math.floor(h / 15) % 24
    const weight = Math.pow(s, 1.25) * (0.45 + (1 - Math.abs(l - .52)))
    const bin = bins[idx]
    bin.weight += weight; bin.r += p.r * weight; bin.g += p.g * weight; bin.b += p.b * weight; bin.count++
  }
  bins.sort((a, b) => b.weight - a.weight)
  const first = bins.find(x => x.weight > 0)
  if (!first) return { a: '#B7C2D0', b: '#75869B', source: 'neutral' }
  const color = bin => {
    const rgb = [bin.r / bin.weight, bin.g / bin.weight, bin.b / bin.weight]
    const [h, s, l] = rgbToHsl(...rgb)
    return hslHex(h, Math.max(.48, Math.min(.88, s * 1.12)), Math.max(.43, Math.min(.68, l)))
  }
  const second = bins.find(x => x.weight > first.weight * .16 && x.weight > 0 && Math.min(Math.abs(x.hue - first.hue), 360 - Math.abs(x.hue - first.hue)) >= 30)
  return { a: color(first), b: second ? color(second) : hslHex(first.hue, .42, .78), source: second ? 'artwork-multi' : 'artwork-single' }
}
async function samplePalette (sharpFactory, imageBuffer) {
  try {
    const { data, info } = await sharpFactory(imageBuffer).rotate().resize(112, 112, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const samples = []
    const stride = info.channels
    // Deterministic spatial sampling prevents large flat backgrounds from
    // overwhelming the palette while still representing the whole artwork.
    for (let y = 0; y < info.height; y += 2) {
      for (let x = 0; x < info.width; x += 2) {
        const i = (y * info.width + x) * stride
        samples.push({ r: data[i], g: data[i + 1], b: data[i + 2] })
      }
    }
    return paletteFrom(samples)
  } catch { return paletteFrom(null) }
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
  const rating = Math.max(0, Math.min(100, Number(card.percent_rating ?? card.percentRating ?? card.rating ?? 0)))
  const stars = Math.max(0, Math.min(10, Number(card.star_rating ?? card.starRating ?? 0)))
  const damage = Math.max(0, Number(card.damage ?? card.baseDamage) || 0)
  const ability = esc(card.ability || '—', 38)
  const abilityDamage = Math.max(0, Number(card.ability_damage ?? card.abilityDamage) || 0)
  const weapon = esc(card.weapon || '—', 30)
  const id = esc(String(card.character_id || card.id || 'AXYON').replace(/^anilist-/i, ''), 32)
  const series = esc(card.series || 'AXYON CORE', 38)
  const expiry = esc(expiryLabel(card.expires_at || card.expiresAt), 36)
  const starText = Array.from({ length: 10 }, (_, i) => `<text x="${88 + i * 31}" y="592" font-size="24" text-anchor="middle" fill="${i < stars ? colors.b : '#59616D'}" stroke="#080B12" stroke-width="2" paint-order="stroke">★</text>`).join('')
  const nameSize = name.length > 22 ? 32 : name.length > 15 ? 40 : 48
  const abilityFont = ability.length > 22 ? 16 : 20
  return Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors.a}"/><stop offset=".52" stop-color="#F5F0E8" stop-opacity=".72"/><stop offset="1" stop-color="${colors.b}"/></linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#080B12" stop-opacity=".97"/><stop offset=".55" stop-color="${colors.a}" stop-opacity=".26"/><stop offset="1" stop-color="#080B12" stop-opacity=".98"/></linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff" stop-opacity="0"/><stop offset=".47" stop-color="#fff" stop-opacity=".035"/><stop offset=".50" stop-color="#fff" stop-opacity=".22"/><stop offset=".53" stop-color="#fff" stop-opacity=".025"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="monolith" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors.a}" stop-opacity=".72"/><stop offset=".45" stop-color="#080B12" stop-opacity=".94"/><stop offset="1" stop-color="${colors.b}" stop-opacity=".62"/></linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="cardClip"><path d="M38 24 H662 L676 42 V850 L640 878 H60 L24 842 V60 Z"/></clipPath>
  </defs>
  <g clip-path="url(#cardClip)">
    <!-- A single architectural monolith: large, quiet geometry instead of circuit clutter. -->
    <path d="M548 154 L690 204 V648 L614 732 L526 660 L558 520 L526 376 Z" fill="#050810" fill-opacity=".72" stroke="url(#frame)" stroke-width="10"/>
    <path d="M568 210 L660 242 V614 L610 676 L558 630 L588 510 L558 390 Z" fill="url(#monolith)" fill-opacity=".88" stroke="${colors.a}" stroke-opacity=".82" stroke-width="3"/>
    <path d="M590 276 L638 294 V584 L608 624 L580 598 L604 502 L580 404 Z" fill="none" stroke="${colors.b}" stroke-opacity=".78" stroke-width="4"/>
    <path d="M548 154 L548 650 L614 732 M660 242 L690 220" fill="none" stroke="#FFF" stroke-opacity=".42" stroke-width="2"/>
    <path d="M566 696 L612 744 L658 696" fill="none" stroke="url(#frame)" stroke-width="5"/>
    <!-- restrained identity header -->
    <path d="M38 38 H662 V126 L628 146 H38 Z" fill="#050810" fill-opacity=".78" stroke="url(#frame)" stroke-width="3"/>
    <path d="M164 43 H554 L536 120 H148 Z" fill="#080B12" fill-opacity=".64" stroke="${colors.a}" stroke-opacity=".58" stroke-width="2"/>
    <text x="354" y="96" text-anchor="middle" font-size="${nameSize}" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="900" fill="#FFF" stroke="#080B12" stroke-width="3" paint-order="stroke">${name}</text>
    <path d="M48 56 L102 34 L150 62 L142 132 L86 150 L38 112 Z" fill="#080B12" stroke="url(#frame)" stroke-width="4"/>
    <text x="94" y="100" text-anchor="middle" font-size="42" font-weight="900" fill="${colors.a}">${esc(tier.symbol, 3)}</text>
    <text x="94" y="124" text-anchor="middle" font-size="9" letter-spacing="1" font-weight="900" fill="#FFF">T${tier.tier} ${rarity}</text>
    <path d="M574 44 H646 L658 58 V130 L614 150 L570 130 Z" fill="#080B12" stroke="url(#frame)" stroke-width="3"/>
    <text x="614" y="78" text-anchor="middle" font-size="10" letter-spacing="1.2" font-weight="900" fill="#E9EDF4">RATING</text>
    <text x="614" y="116" text-anchor="middle" font-size="29" font-weight="900" fill="${colors.b}">${rating}<tspan font-size="12" fill="#FFF">/100</tspan></text>
    <!-- Star rail floats above the data plate, leaving the portrait visible. -->
    <path d="M42 558 H392 L444 606 H42 Z" fill="#070A12" fill-opacity=".88" stroke="url(#frame)" stroke-width="3"/>
    ${starText}
    <!-- Angled lower-left battle plate. -->
    <path d="M32 630 H430 L514 876 H32 Z" fill="#050810" fill-opacity=".96" stroke="url(#frame)" stroke-width="6"/>
    <path d="M32 630 H430 L514 876 H32 Z" fill="url(#panel)" stroke="${colors.a}" stroke-opacity=".76" stroke-width="2"/>
    <path d="M54 650 H394 L410 684 H54 Z" fill="${colors.a}" fill-opacity=".20"/>
    <text x="72" y="675" font-size="12" font-weight="900" letter-spacing="1.5" fill="${colors.b}">BASE DAMAGE</text>
    <text x="72" y="718" font-size="38" font-weight="900" fill="#FFF">${damage}</text>
    <text x="286" y="675" font-size="11" font-weight="900" letter-spacing="1.1" fill="${colors.b}">CARD TYPE</text>
    <text x="286" y="708" font-size="17" font-weight="900" fill="#FFF">${type}</text>
    <path d="M54 736 H414" stroke="url(#frame)" stroke-opacity=".72" stroke-width="2"/>
    <text x="72" y="768" font-size="11" font-weight="900" letter-spacing="1.4" fill="${colors.b}">SPECIAL ABILITY</text>
    <text x="72" y="803" font-size="${abilityFont}" font-weight="900" fill="#FFF">${ability}</text>
    <path d="M300 812 H438 L456 856 H318 Z" fill="#070A12" stroke="${colors.b}" stroke-width="2.5"/>
    <text x="378" y="832" text-anchor="middle" font-size="9" letter-spacing="1" font-weight="900" fill="${colors.b}">ABILITY DMG</text>
    <text x="378" y="852" text-anchor="middle" font-size="21" font-weight="900" fill="#FFF">${abilityDamage}</text>
    <text x="72" y="846" font-size="10" font-weight="900" letter-spacing="1" fill="${colors.b}">WEAPON</text>
    <text x="132" y="846" font-size="13" font-weight="800" fill="#FFF">${weapon}</text>
    <!-- Footer metadata sits in the open right rail. -->
    <text x="554" y="782" font-size="10" font-weight="900" fill="${colors.b}">${type}</text>
    <text x="554" y="804" font-size="9" font-weight="700" fill="#E9EDF4">${expiry}</text>
    <text x="554" y="846" font-size="11" font-weight="900" fill="#FFF">${series}</text>
    <text x="554" y="866" font-size="12" font-weight="900" letter-spacing="1" fill="#FFF">AXYON</text>
    <text x="48" y="872" font-size="9" font-weight="900" fill="#FFF">#${id}</text>
    <!-- Physical gloss is part of the exported PNG, not a browser-only effect. -->
    <path d="M-130 180 L48 10 L270 10 L-42 900 L-220 900 Z" fill="url(#shine)" opacity=".72"/>
    <path d="M10 510 L205 20 M510 20 L688 390" stroke="#FFF" stroke-opacity=".10" stroke-width="4"/>
    <path d="M48 48 H652 V844 L632 866 H68 L48 846 Z" fill="none" stroke="#FFF" stroke-opacity=".32" stroke-width="2"/>
  </g>
  <path d="M38 24 H662 L676 42 V850 L640 878 H60 L24 842 V60 Z" fill="none" stroke="#05060B" stroke-width="15"/>
  <path d="M38 24 H662 L676 42 V850 L640 878 H60 L24 842 V60 Z" fill="none" stroke="url(#frame)" stroke-width="5" filter="url(#glow)"/>
  </svg>`)
}
async function render (card, imageBuffer) {
  const s = sharp()
  if (!s || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null
  const tier = tierFor(card)
  const colors = await samplePalette(s, imageBuffer)
  // Use a soft, enlarged backdrop to fill the canvas, then fit the complete
  // original artwork over it. This avoids the face/head cropping caused by
  // cover-only scaling while preserving a full-bleed card silhouette.
  const backdrop = await s(imageBuffer).rotate().resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention' })
    .blur(22).modulate({ saturation: .72, brightness: .42 }).png().toBuffer()
  const foreground = await s(imageBuffer).rotate().resize(WIDTH, HEIGHT, {
    fit: 'contain', position: 'centre', background: { r: 4, g: 6, b: 12, alpha: 0 }
  }).png().toBuffer()
  const shade = Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#03040A" stop-opacity=".10"/><stop offset=".58" stop-color="#03040A" stop-opacity=".02"/><stop offset="1" stop-color="#03040A" stop-opacity=".54"/></linearGradient></defs><rect width="700" height="900" fill="url(#v)"/></svg>`)
  const buffer = await s({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#05060B' } })
    .composite([{ input: backdrop, left: 0, top: 0 }, { input: foreground, left: 0, top: 0 }, { input: shade, left: 0, top: 0 }, { input: svgOverlay(card, colors), left: 0, top: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
  return { buffer, tier, width: WIDTH, height: HEIGHT, style: 'ai-custom', palette: colors }
}
module.exports = { WIDTH, HEIGHT, available, tierFor, paletteFrom, samplePalette, svgOverlay, render }
