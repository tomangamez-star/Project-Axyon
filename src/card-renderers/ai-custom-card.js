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
  return { a: color(first), b: second ? color(second) : hslHex((first.hue + 22) % 360, .52, .66), source: second ? 'artwork-multi' : 'artwork-single' }
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
  const starText = Array.from({ length: 10 }, (_, i) => `<text x="${100 + i * 34}" y="603" font-size="27" text-anchor="middle" fill="${i < stars ? colors.b : '#59616D'}" stroke="#080B12" stroke-width="2" paint-order="stroke">★</text>`).join('')
  const nameSize = name.length > 22 ? 34 : name.length > 15 ? 42 : 50
  const abilityFont = ability.length > 22 ? 16 : 20
  return Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors.a}"/><stop offset=".48" stop-color="#F5F0E8"/><stop offset="1" stop-color="${colors.b}"/></linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#080B12" stop-opacity=".95"/><stop offset=".55" stop-color="${colors.a}" stop-opacity=".32"/><stop offset="1" stop-color="#080B12" stop-opacity=".96"/></linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff" stop-opacity="0"/><stop offset=".46" stop-color="#fff" stop-opacity=".035"/><stop offset=".50" stop-color="#fff" stop-opacity=".25"/><stop offset=".54" stop-color="#fff" stop-opacity=".025"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="sideMetal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors.a}" stop-opacity=".82"/><stop offset=".48" stop-color="#F5F0E8" stop-opacity=".18"/><stop offset="1" stop-color="${colors.b}" stop-opacity=".82"/></linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="8"/></filter>
    <clipPath id="cardClip"><path d="M42 26 H658 L674 44 V852 L638 878 H62 L26 842 V62 Z"/></clipPath>
  </defs>
  <g clip-path="url(#cardClip)">
    <!-- Large, asymmetric right-side structure: deliberate visual mass, not hairline decoration. -->
    <path d="M486 146 L690 214 V624 L596 716 L492 642 L536 500 L480 390 Z" fill="#070A12" fill-opacity=".58" stroke="url(#sideMetal)" stroke-width="12"/>
    <path d="M514 190 L660 244 V590 L590 664 L526 610 L566 490 L510 382 Z" fill="${colors.a}" fill-opacity=".12" stroke="${colors.a}" stroke-opacity=".88" stroke-width="5"/>
    <path d="M548 244 L632 277 V558 L586 614 L548 578 L580 488 L540 386 Z" fill="${colors.b}" fill-opacity=".10" stroke="${colors.b}" stroke-opacity=".78" stroke-width="4"/>
    <path d="M500 286 L660 346 L660 394 L510 338 Z M500 430 L660 488 L660 532 L510 474 Z" fill="url(#sideMetal)" fill-opacity=".42"/>
    <path d="M530 216 L628 252 L628 568 L584 620" fill="none" stroke="#FFF" stroke-opacity=".62" stroke-width="3"/>
    <path d="M555 300 L620 325 L620 515 L584 560" fill="none" stroke="${colors.a}" stroke-width="8" stroke-opacity=".42"/>
    <polygon points="574,354 626,374 626,465 584,510 550,482 575,430" fill="${colors.b}" fill-opacity=".16" stroke="url(#frame)" stroke-width="3"/>
    <circle cx="592" cy="430" r="38" fill="none" stroke="${colors.b}" stroke-width="4" stroke-opacity=".78"/>
    <circle cx="592" cy="430" r="20" fill="${colors.a}" fill-opacity=".16" stroke="#FFF" stroke-opacity=".55" stroke-width="2"/>
    <path d="M492 170 L492 640 L558 692 M666 216 L688 198 M486 620 L460 680" fill="none" stroke="url(#frame)" stroke-width="7"/>
    <!-- Compact floating identity header; keeps the character portrait unobstructed. -->
    <path d="M38 38 H662 V128 L625 151 H38 Z" fill="#050810" fill-opacity=".66" stroke="url(#frame)" stroke-width="3"/>
    <path d="M176 42 H622 L604 120 H154 Z" fill="#080B12" fill-opacity=".60" stroke="${colors.a}" stroke-opacity=".68" stroke-width="2"/>
    <text x="385" y="98" text-anchor="middle" font-size="${nameSize}" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="900" fill="#FFF" stroke="#080B12" stroke-width="3" paint-order="stroke">${name}</text>
    <path d="M48 58 L112 34 L158 70 L146 142 L86 160 L38 116 Z" fill="#080B12" stroke="url(#frame)" stroke-width="5" filter="url(#glow)"/>
    <text x="98" y="103" text-anchor="middle" font-size="46" font-weight="900" fill="${colors.a}">${esc(tier.symbol, 3)}</text>
    <text x="98" y="128" text-anchor="middle" font-size="10" letter-spacing="1.2" font-weight="900" fill="#FFF">T${tier.tier} ${rarity}</text>
    <path d="M564 42 H646 L658 58 V136 L610 158 L562 136 Z" fill="#080B12" stroke="url(#frame)" stroke-width="3"/>
    <text x="610" y="78" text-anchor="middle" font-size="12" letter-spacing="1.4" font-weight="900" fill="#E9EDF4">RATING</text>
    <text x="610" y="119" text-anchor="middle" font-size="32" font-weight="900" fill="${colors.b}">${rating}<tspan font-size="13" fill="#FFF">/100</tspan></text>
    <!-- Character name / star rail is deliberately lower than the face. -->
    <path d="M42 566 L438 566 L496 612 L42 612 Z" fill="#070A12" fill-opacity=".84" stroke="url(#frame)" stroke-width="4"/>
    ${starText}
    <!-- Battle-data plate: broad, angled, and anchored to the lower-left. -->
    <path d="M34 632 L448 632 L530 874 H34 Z" fill="#050810" fill-opacity=".94" stroke="url(#frame)" stroke-width="7" filter="url(#shadow)"/>
    <path d="M34 632 L448 632 L530 874 H34 Z" fill="url(#panel)" stroke="${colors.a}" stroke-opacity=".82" stroke-width="3"/>
    <path d="M58 654 H416 L432 692 H58 Z" fill="${colors.a}" fill-opacity=".22"/>
    <text x="78" y="678" font-size="13" font-weight="900" letter-spacing="1.8" fill="${colors.b}">BASE DAMAGE</text>
    <text x="78" y="720" font-size="39" font-weight="900" fill="#FFF">${damage}</text>
    <text x="326" y="678" font-size="12" font-weight="900" letter-spacing="1.4" fill="${colors.b}">CARD TYPE</text>
    <text x="326" y="710" font-size="19" font-weight="900" fill="#FFF">${type}</text>
    <path d="M58 738 H432" stroke="url(#frame)" stroke-opacity=".75" stroke-width="2"/>
    <text x="78" y="770" font-size="12" font-weight="900" letter-spacing="1.5" fill="${colors.b}">SPECIAL ABILITY</text>
    <text x="78" y="805" font-size="${abilityFont}" font-weight="900" fill="#FFF">${ability}</text>
    <path d="M336 778 L482 778 L500 840 L354 840 Z" fill="#070A12" stroke="${colors.b}" stroke-width="3"/>
    <text x="418" y="802" text-anchor="middle" font-size="10" letter-spacing="1.1" font-weight="900" fill="${colors.b}">ABILITY DMG</text>
    <text x="418" y="830" text-anchor="middle" font-size="26" font-weight="900" fill="#FFF">${abilityDamage}</text>
    <text x="78" y="850" font-size="11" font-weight="900" letter-spacing="1.2" fill="${colors.b}">WEAPON</text>
    <text x="150" y="850" font-size="14" font-weight="800" fill="#FFF">${weapon}</text>
    <!-- Identity footer sits inside the left plate; right geometry remains open. -->
    <text x="48" y="870" font-size="10" font-weight="900" fill="#FFF">#${id}</text>
    <text x="280" y="870" text-anchor="middle" font-size="13" font-weight="900" letter-spacing="1.2" fill="#FFF">${series}</text>
    <text x="566" y="824" font-size="11" font-weight="900" fill="${colors.b}">${type}</text>
    <text x="566" y="846" font-size="10" font-weight="700" fill="#E9EDF4">${expiry}</text>
    <text x="566" y="870" font-size="15" font-weight="900" letter-spacing="1.2" fill="#FFF">AXYON</text>
    <!-- Printed gloss sheet: subtle, clipped reflections that retain legibility. -->
    <path d="M-130 180 L48 10 L270 10 L-42 900 L-220 900 Z" fill="url(#shine)" opacity=".74"/>
    <path d="M10 510 L205 20 M510 20 L688 390" stroke="#FFF" stroke-opacity=".13" stroke-width="5"/>
    <path d="M48 48 H652 V844 L632 866 H68 L48 846 Z" fill="none" stroke="#FFF" stroke-opacity=".36" stroke-width="2"/>
  </g>
  <path d="M42 26 H658 L674 44 V852 L638 878 H62 L26 842 V62 Z" fill="none" stroke="#05060B" stroke-width="17"/>
  <path d="M42 26 H658 L674 44 V852 L638 878 H62 L26 842 V62 Z" fill="none" stroke="url(#frame)" stroke-width="6" filter="url(#glow)"/>
  <path d="M48 34 H652 V842" fill="none" stroke="#FFF" stroke-opacity=".52" stroke-width="2"/>
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
