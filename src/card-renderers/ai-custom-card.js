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
  // Keep two genuinely artwork-derived accents, but constrain the second
  // sample to the primary hue family. Previously the code deliberately chose
  // a distant/complementary bin, so blue-violet art could acquire red/teal
  // borders. Use the second sample's saturation/lightness while keeping its
  // hue analogous to the dominant artwork hue.
  const second = bins.find(x => x !== first && x.weight > first.weight * .03 && x.weight > 0)
  let secondary = hslHex((first.hue + 18) % 360, .52, .66)
  if (second) {
    const rgb = [second.r / second.weight, second.g / second.weight, second.b / second.weight]
    const [, s, l] = rgbToHsl(...rgb)
    secondary = hslHex((first.hue + 18) % 360, Math.max(.42, Math.min(.86, s * 1.05)), Math.max(.43, Math.min(.68, l)))
  }
  return { a: color(first), b: secondary, source: second ? 'artwork-multi' : 'artwork-single' }
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
  const starText = Array.from({ length: 10 }, (_, i) => `<text x="${72 + i * 61}" y="631" font-size="31" text-anchor="middle" fill="${i < stars ? colors.b : '#59616D'}" stroke="#080B12" stroke-width="2" paint-order="stroke">★</text>`).join('')
  const nameSize = name.length > 22 ? 29 : name.length > 15 ? 36 : 43
  const abilityFont = ability.length > 22 ? 17 : 21
  return Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="frame" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors.a}"/><stop offset=".48" stop-color="#DDE4EA"/><stop offset="1" stop-color="${colors.b}"/></linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2=".9" y2="1"><stop stop-color="#05070D" stop-opacity=".94"/><stop offset=".42" stop-color="#0A0D16" stop-opacity=".97"/><stop offset=".72" stop-color="${colors.a}" stop-opacity=".20"/><stop offset="1" stop-color="#03050A" stop-opacity=".99"/></linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#FFF" stop-opacity="0"/><stop offset=".34" stop-color="#FFF" stop-opacity=".025"/><stop offset=".48" stop-color="#FFF" stop-opacity=".12"/><stop offset=".51" stop-color="#FFF" stop-opacity=".25"/><stop offset=".55" stop-color="#FFF" stop-opacity=".035"/><stop offset="1" stop-color="#FFF" stop-opacity="0"/></linearGradient>
    <linearGradient id="edgeGlow" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors.a}"/><stop offset=".48" stop-color="#F7FAFF"/><stop offset="1" stop-color="${colors.b}"/></linearGradient>
    <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="portraitClip"><rect x="25" y="24" width="650" height="568" rx="25" ry="25"/></clipPath>
    <clipPath id="cardClip"><rect x="12" y="12" width="676" height="876" rx="30" ry="30"/></clipPath>
  </defs>
  <g clip-path="url(#cardClip)">
    <!-- Dynamic portrait frame: rounded, beveled rails with the artwork palette. -->
    <rect x="18" y="18" width="664" height="864" rx="27" fill="none" stroke="#02040A" stroke-width="20"/>
    <rect x="20" y="20" width="660" height="860" rx="26" fill="none" stroke="url(#edgeGlow)" stroke-width="8"/>
    <rect x="31" y="31" width="638" height="838" rx="20" fill="none" stroke="#F5F7FA" stroke-opacity=".62" stroke-width="2"/>
    <path d="M48 34 H250 M450 34 H646 M34 170 V380 M666 180 V410" fill="none" stroke="${colors.a}" stroke-width="4" stroke-linecap="round" opacity=".88"/>
    <path d="M48 866 H230 M470 866 H650" fill="none" stroke="${colors.b}" stroke-width="4" stroke-linecap="round" opacity=".9"/>
    <!-- Compact corner labels only; no nameplate over the character. -->
    <rect x="43" y="46" width="112" height="105" rx="17" fill="#050810" fill-opacity=".82" stroke="url(#edgeGlow)" stroke-width="3"/>
    <text x="99" y="103" text-anchor="middle" font-size="43" font-weight="900" fill="${colors.a}">${esc(tier.symbol, 3)}</text>
    <text x="99" y="128" text-anchor="middle" font-size="10" letter-spacing="1.1" font-weight="900" fill="#FFF">T${tier.tier} ${rarity}</text>
    <rect x="545" y="46" width="112" height="105" rx="17" fill="#050810" fill-opacity=".82" stroke="url(#edgeGlow)" stroke-width="3"/>
    <text x="601" y="78" text-anchor="middle" font-size="11" letter-spacing="1.4" font-weight="900" fill="#E9EDF4">RATING</text>
    <text x="601" y="119" text-anchor="middle" font-size="31" font-weight="900" fill="${colors.b}">${rating}<tspan font-size="12" fill="#FFF">/100</tspan></text>
    <!-- Full-width star strip separates portrait and information. -->
    <rect x="34" y="594" width="632" height="69" rx="12" fill="#05070D" fill-opacity=".94" stroke="url(#edgeGlow)" stroke-width="3"/>
    <path d="M48 603 H652" stroke="#FFF" stroke-opacity=".18" stroke-width="1"/>
    ${starText}
    <!-- Dark gradient information area. -->
    <rect x="24" y="672" width="652" height="208" rx="18" fill="url(#panel)" stroke="url(#edgeGlow)" stroke-width="4"/>
    <text x="52" y="708" font-size="${nameSize}" font-family="DejaVu Sans,Arial,sans-serif" font-style="italic" font-weight="900" fill="#FFF" stroke="#03050A" stroke-width="2" paint-order="stroke">${name}</text>
    <text x="648" y="705" text-anchor="end" font-size="12" letter-spacing="1.8" font-weight="900" fill="${colors.b}">${type}</text>
    <path d="M50 729 H650" stroke="url(#edgeGlow)" stroke-opacity=".62" stroke-width="2"/>
    <text x="54" y="761" font-size="12" font-weight="900" letter-spacing="1.5" fill="${colors.b}">BASE DAMAGE</text>
    <text x="54" y="798" font-size="39" font-weight="900" fill="#FFF">${damage}</text>
    <text x="270" y="761" font-size="12" font-weight="900" letter-spacing="1.5" fill="${colors.b}">CARD TYPE</text>
    <text x="270" y="797" font-size="20" font-weight="900" fill="#FFF">${type}</text>
    <text x="490" y="761" font-size="12" font-weight="900" letter-spacing="1.5" fill="${colors.b}">WEAPON</text>
    <text x="490" y="797" font-size="20" font-weight="900" fill="#FFF">${weapon}</text>
    <path d="M52 811 H650" stroke="#FFF" stroke-opacity=".22" stroke-width="1.5"/>
    <text x="54" y="836" font-size="11" font-weight="900" letter-spacing="1.3" fill="${colors.b}">SPECIAL ABILITY</text>
    <text x="54" y="861" font-size="${abilityFont}" font-weight="900" fill="#FFF">${ability}</text>
    <rect x="500" y="823" width="146" height="43" rx="9" fill="#05070D" stroke="${colors.b}" stroke-width="2"/>
    <text x="573" y="839" text-anchor="middle" font-size="9" letter-spacing="1" font-weight="900" fill="${colors.b}">ABILITY DMG</text>
    <text x="573" y="861" text-anchor="middle" font-size="20" font-weight="900" fill="#FFF">${abilityDamage}</text>
    <!-- Gloss remains a printed, translucent reflective sheet on the final PNG. -->
    <path d="M-100 190 L70 20 H240 L-70 900 H-210 Z" fill="url(#gloss)" opacity=".82"/>
    <path d="M34 290 L118 40 M530 40 L670 390" stroke="#FFF" stroke-opacity=".13" stroke-width="4" stroke-linecap="round"/>
    <rect x="34" y="34" width="632" height="832" rx="18" fill="none" stroke="#FFF" stroke-opacity=".18" stroke-width="1.5"/>
  </g>
  <rect x="12" y="12" width="676" height="876" rx="30" fill="none" stroke="#02040A" stroke-width="13"/>
  <rect x="16" y="16" width="668" height="868" rx="28" fill="none" stroke="url(#edgeGlow)" stroke-width="5" filter="url(#softGlow)"/>
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
  const backdrop = await s({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#05070D' } }).png().toBuffer()
  const portraitBackdrop = await s(imageBuffer).rotate().resize(WIDTH, 592, { fit: 'cover', position: 'attention' })
    .blur(24).modulate({ saturation: .72, brightness: .42 }).png().toBuffer()
  const portraitMask = Buffer.from(`<svg width="${WIDTH}" height="592" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="700" height="592" rx="26" ry="26" fill="#fff"/></svg>`)
  const foreground = await s(imageBuffer).rotate().resize(WIDTH, 592, {
    fit: 'contain', position: 'centre', background: { r: 4, g: 6, b: 12, alpha: 0 }
  }).composite([{ input: portraitMask, blend: 'dest-in' }]).png().toBuffer()
  const particlePath = require('path').join(__dirname, '../../assets/card-particles.png')
  let particles = null
  try {
    particles = await s(particlePath).resize(WIDTH, HEIGHT, { fit: 'cover' }).tint(colors.b).modulate({ brightness: 0.78, saturation: 0.9 }).png().toBuffer()
  } catch (error) { console.warn(`[ai-custom] particle overlay unavailable: ${error.message}`) }
  const shade = Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#03040A" stop-opacity=".10"/><stop offset=".58" stop-color="#03040A" stop-opacity=".02"/><stop offset="1" stop-color="#03040A" stop-opacity=".54"/></linearGradient></defs><rect width="700" height="900" fill="url(#v)"/></svg>`)
  const layers = [{ input: backdrop, left: 0, top: 0 }, { input: portraitBackdrop, left: 0, top: 0 }, { input: foreground, left: 0, top: 0 }, { input: shade, left: 0, top: 0 }]
  if (particles) layers.push({ input: particles, left: 0, top: 0, blend: 'screen' })
  layers.push({ input: svgOverlay(card, colors), left: 0, top: 0 })
  const buffer = await s({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#05060B' } })
    .composite(layers)
    .png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
  return { buffer, tier, width: WIDTH, height: HEIGHT, style: 'ai-custom', palette: colors }
}
module.exports = { WIDTH, HEIGHT, available, tierFor, paletteFrom, samplePalette, svgOverlay, render }
