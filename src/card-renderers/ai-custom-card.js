'use strict'

// AI Custom — clean portrait-first collectible frame.
// The decorative metal frame is a pre-rendered transparent PNG asset; SVG is
// reserved for variable card text, the footer gradient, and compact markers.
const path = require('path')
const WIDTH = 700
const HEIGHT = 900
const FRAME_PATH = path.join(__dirname, '../../assets/ai-custom-frame.png')
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
function paletteFrom (samples) {
  if (samples && Number.isFinite(samples.r)) samples = [{ r: samples.r, g: samples.g, b: samples.b }]
  if (!Array.isArray(samples) || !samples.length) return { a: '#B7C2D0', b: '#75869B', source: 'neutral' }
  const bins = Array.from({ length: 24 }, (_, i) => ({ hue: i * 15 + 7.5, weight: 0, r: 0, g: 0, b: 0 }))
  for (const p of samples) {
    const [h, s, l] = rgbToHsl(p.r, p.g, p.b)
    if (s < .16 || l < .10 || l > .94) continue
    const bin = bins[Math.floor(h / 15) % 24]
    const weight = Math.pow(s, 1.25) * (0.45 + (1 - Math.abs(l - .52)))
    bin.weight += weight; bin.r += p.r * weight; bin.g += p.g * weight; bin.b += p.b * weight
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
  return { a: color(first), b: second ? color(second) : color(first), source: second ? 'artwork-multi' : 'artwork-single' }
}
async function samplePalette (sharpFactory, imageBuffer) {
  try {
    const { data, info } = await sharpFactory(imageBuffer).rotate().resize(112, 112, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const samples = []
    for (let y = 0; y < info.height; y += 2) for (let x = 0; x < info.width; x += 2) {
      const i = (y * info.width + x) * info.channels
      samples.push({ r: data[i], g: data[i + 1], b: data[i + 2] })
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
  const name = esc(card.name || 'UNKNOWN', 34)
  const type = String(card.card_type || card.cardType || 'character').toUpperCase() === 'WEAPON' ? 'WEAPON' : 'CHARACTER'
  const rating = Math.max(0, Math.min(100, Number(card.percent_rating ?? card.percentRating ?? card.rating ?? 0)))
  const stars = Math.max(0, Math.min(10, Number(card.star_rating ?? card.starRating ?? 0)))
  const damage = Math.max(0, Number(card.damage ?? card.baseDamage) || 0)
  const ability = esc(card.ability || '—', 34)
  const abilityDamage = Math.max(0, Number(card.ability_damage ?? card.abilityDamage) || 0)
  const weapon = esc(card.weapon || '—', 24)
  const nameSize = name.length > 22 ? 27 : name.length > 15 ? 31 : 36
  const starRail = Array.from({ length: 10 }, (_, i) =>
    `<text x="616" y="${710 + i * 14}" text-anchor="middle" font-size="14" font-weight="900" fill="${i < stars ? colors.b : '#525B67'}">★</text>`).join('')
  return Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="footer" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05070C" stop-opacity="0"/><stop offset=".12" stop-color="#05070C" stop-opacity=".72"/><stop offset=".36" stop-color="#05070C" stop-opacity=".94"/><stop offset="1" stop-color="#03050A" stop-opacity=".99"/></linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop stop-color="${colors.a}"/><stop offset="1" stop-color="${colors.b}"/></linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#FFF" stop-opacity=".10"/><stop offset=".35" stop-color="#FFF" stop-opacity="0"/><stop offset="1" stop-color="#FFF" stop-opacity=".04"/></linearGradient>
    <clipPath id="portrait"><path d="M36 22 H664 Q678 22 678 38 V862 Q678 878 662 878 H38 Q22 878 22 862 V38 Q22 22 36 22Z"/></clipPath>
  </defs>
  <g clip-path="url(#portrait)">
    <rect x="0" y="620" width="700" height="280" fill="url(#footer)"/>
    <path d="M54 654 H646" stroke="url(#accent)" stroke-width="2" opacity=".78"/>
    <path d="M62 666 H638" stroke="#FFF" stroke-width="1" opacity=".14"/>
    <path d="M38 28 H662 V872 H38Z" fill="url(#glass)"/>
    <!-- Compact identity markers; no nameplate over the character's face. -->
    <path d="M82 42 H142 L154 54 V124 L140 138 H82Z" fill="#05070C" fill-opacity=".88" stroke="url(#accent)" stroke-width="3"/>
    <text x="118" y="94" text-anchor="middle" font-size="39" font-weight="900" fill="${colors.a}">${esc(tier.symbol, 3)}</text>
    <text x="118" y="119" text-anchor="middle" font-size="9" letter-spacing="1" font-weight="900" fill="#F1F4F8">T${tier.tier} ${esc(tier.label, 14)}</text>
    <path d="M548 42 H618 V124 L604 138 H548Z" fill="#05070C" fill-opacity=".88" stroke="url(#accent)" stroke-width="3"/>
    <text x="583" y="70" text-anchor="middle" font-size="10" letter-spacing="1.2" font-weight="900" fill="#DCE3EC">RATING</text>
    <text x="583" y="108" text-anchor="middle" font-size="29" font-weight="900" fill="${colors.b}">${rating}<tspan font-size="11" fill="#FFF">/100</tspan></text>
    <!-- Dark gradient information deck, with the title kept below the artwork. -->
    <text x="335" y="728" text-anchor="middle" font-size="${nameSize}" font-style="italic" font-weight="900" fill="#FFF" stroke="#05070C" stroke-width="2" paint-order="stroke">${name}</text>
    ${starRail}
    <path d="M62 744 H584" stroke="#DCE3EC" stroke-opacity=".28" stroke-width="1.5"/>
    <text x="72" y="766" font-size="11" letter-spacing="1.5" font-weight="900" fill="${colors.b}">BASE DAMAGE</text>
    <text x="72" y="795" font-size="31" font-weight="900" fill="#FFF">${damage}</text>
    <text x="245" y="766" font-size="11" letter-spacing="1.5" font-weight="900" fill="${colors.b}">CARD TYPE</text>
    <text x="245" y="792" font-size="17" font-weight="900" fill="#FFF">${type}</text>
    <text x="415" y="766" font-size="11" letter-spacing="1.5" font-weight="900" fill="${colors.b}">WEAPON</text>
    <text x="415" y="792" font-size="15" font-weight="800" fill="#FFF">${weapon}</text>
    <path d="M62 805 H584" stroke="#DCE3EC" stroke-opacity=".22" stroke-width="1.5"/>
    <text x="124" y="823" font-size="10" letter-spacing="1.4" font-weight="900" fill="${colors.b}">SPECIAL ABILITY</text>
    <text x="124" y="848" font-size="18" font-weight="900" fill="#FFF">${ability}</text>
    <path d="M442 800 H566 Q574 800 574 808 V852 H442Z" fill="#05070C" stroke="url(#accent)" stroke-width="2"/>
    <text x="508" y="819" text-anchor="middle" font-size="8" letter-spacing="1" font-weight="900" fill="${colors.b}">ABILITY DMG</text>
    <text x="508" y="843" text-anchor="middle" font-size="20" font-weight="900" fill="#FFF">${abilityDamage}</text>
  </g>
  </svg>`)
}
async function render (card, imageBuffer) {
  const s = sharp()
  if (!s || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null
  const tier = tierFor(card)
  const colors = await samplePalette(s, imageBuffer)
  // Keep the original image intact in a portrait viewport. Rounded clipping
  // prevents sharp image corners from poking through the bevelled frame.
  const portraitMask = Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><path d="M36 22 H664 Q678 22 678 38 V862 Q678 878 662 878 H38 Q22 878 22 862 V38 Q22 22 36 22Z" fill="#fff"/></svg>`)
  const foreground = await s(imageBuffer).rotate().resize(WIDTH, HEIGHT, {
    fit: 'contain', position: 'centre', background: { r: 5, g: 7, b: 12, alpha: 1 }
  }).composite([{ input: portraitMask, blend: 'dest-in' }]).png().toBuffer()
  const frame = await s(FRAME_PATH).resize(WIDTH, HEIGHT, { fit: 'fill' }).png().toBuffer()
  const buffer = await s({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#05060B' } })
    .composite([
      { input: foreground, left: 0, top: 0 },
      { input: svgOverlay(card, colors), left: 0, top: 0 },
      { input: frame, left: 0, top: 0 }
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
  return { buffer, tier, width: WIDTH, height: HEIGHT, style: 'ai-custom', palette: colors }
}
module.exports = { WIDTH, HEIGHT, FRAME_PATH, available, tierFor, paletteFrom, samplePalette, svgOverlay, render }
