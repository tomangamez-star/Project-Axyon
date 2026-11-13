'use strict'
/*
 * THEME — the visual language of every Architect message.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The old build rendered every card the same way: one pale flat block of text
 * with a single `⬡ AXYN CORE` line on top. Nothing was bold, nothing was
 * framed, and every card looked identical. The reference screenshots show
 * something much more deliberate:
 *
 *   - a header block with the sigil and a `└─ by …` credit line
 *   - real WhatsApp *bold*, _italic_, ~strike~ and `monospace`
 *   - Unicode display fonts for names and section titles
 *   - box-drawing dividers (─ ═ ┈) instead of a wall of underscores
 *   - profile cards inside actual frames, and DIFFERENT frame styles so two
 *     cards never look like the same card
 *   - monospace progress bars so the blocks line up
 *
 * Everything here is pure string work. No AI, no network, no randomness that
 * changes between calls — the same player always renders the same card.
 */

/* ------------------------------------------------------------ unicode fonts */

const RANGES = {
  /* 𝗕𝗼𝗹𝗱 𝗦𝗮𝗻𝘀 — the default "display" font for headings. */
  bold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
  /* 𝕭𝖔𝖑𝖉 𝕱𝖗𝖆𝖐𝖙𝖚𝖗 — used for hunter names, the Solo Leveling look. */
  fraktur: { upper: 0x1d56c, lower: 0x1d586, digit: null },
  /* 𝙼𝚘𝚗𝚘𝚜𝚙𝚊𝚌𝚎 — used for values that must align. */
  mono: { upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },
  /* Ｆｕｌｌｗｉｄｔｈ — used sparingly for the big banner words. */
  wide: { upper: 0xff21, lower: 0xff41, digit: 0xff10 }
}

const SMALL_CAPS = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ',
  k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ',
  u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ'
}

/**
 * Converts ASCII letters/digits into a Unicode display font.
 * Anything outside A-Z a-z 0-9 is passed through untouched, so emoji, spaces
 * and punctuation survive.
 */
function font (text, style = 'bold') {
  const s = String(text ?? '')
  if (style === 'smallcaps') {
    return s.replace(/[a-z]/g, c => SMALL_CAPS[c] || c).replace(/[A-Z]/g, c => SMALL_CAPS[c.toLowerCase()] || c)
  }
  const r = RANGES[style]
  if (!r) return s
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (c >= 65 && c <= 90) out += String.fromCodePoint(r.upper + (c - 65))
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(r.lower + (c - 97))
    else if (c >= 48 && c <= 57 && r.digit) out += String.fromCodePoint(r.digit + (c - 48))
    else out += ch
  }
  return out
}

/* --------------------------------------------------------------- primitives */

/** WhatsApp bold. */
const b = t => `*${t}*`
/** WhatsApp italic. */
const i = t => `_${t}_`
/** WhatsApp strikethrough. */
const s = t => `~${t}~`
/** WhatsApp monospace — the only way to get aligned columns. */
const m = t => '`' + String(t) + '`'

/* ---------------------------------------------------------------- dividers */

const DIV = {
  thin: '─'.repeat(18),
  hair: '┈'.repeat(18),
  heavy: '═'.repeat(18),
  dotted: '┄'.repeat(18),
  double: '╌'.repeat(18),
  wave: '〜'.repeat(9)
}

/** A divider, optionally with a label sitting inside it. */
function rule (label = '', kind = 'thin') {
  const line = DIV[kind] || DIV.thin
  if (!label) return line
  const text = ` ${label} `
  const half = Math.max(2, Math.floor((line.length - text.length) / 2))
  return '─'.repeat(half) + text + '─'.repeat(Math.max(2, line.length - text.length - half))
}

/* ------------------------------------------------------------------ frames */

/*
 * FIVE distinct frame styles. Cards pick one by kind, so a profile card, a
 * battle card and a help page never share a border. This is the "different
 * border styles, not one single style everywhere" requirement.
 */
const FRAMES = {
  /* ╭─╮ rounded — profile cards */
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  /* ┏━┓ heavy — battle / boss cards */
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
  /* ┌─┐ light — help and reference pages */
  light: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  /* ▛▀▜ block — victory / defeat banners */
  block: { tl: '▛', tr: '▜', bl: '▙', br: '▟', h: '▀', v: '▌' },
  /* ╔═╗ double — management / authority cards */
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' }
}

/**
 * Wraps lines in a frame.
 *
 * WhatsApp has no real table layout, so the frame is drawn with box-drawing
 * characters and the content is padded to a fixed width. Emoji are wide, so
 * the width is measured in "display cells" rather than code points — otherwise
 * the right edge of the frame staggers on every line that has an emoji.
 */
function frame (lines, { kind = 'round', title = '', width = 26 } = {}) {
  const f = FRAMES[kind] || FRAMES.round
  const body = (Array.isArray(lines) ? lines : [lines]).map(x => String(x ?? ''))
  const inner = Math.max(width, ...body.map(cells))
  const out = []

  if (title) {
    const t = ` ${title} `
    out.push(f.tl + f.h + t + f.h.repeat(Math.max(0, inner - cells(t) - 1)) + f.tr)
  } else {
    out.push(f.tl + f.h.repeat(inner + 2) + f.tr)
  }

  for (const line of body) {
    out.push(f.v + ' ' + line + ' '.repeat(Math.max(0, inner - cells(line))) + ' ' + f.v)
  }
  out.push(f.bl + f.h.repeat(inner + 2) + f.br)
  return out.join('\n')
}

/**
 * Approximate display width in cells.
 * Emoji and CJK take two cells; combining marks and zero-width take none.
 * This is what keeps the frame edges straight.
 */
function cells (str) {
  let n = 0
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0)
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || c === 0x20e3) continue
    if (c >= 0x1f000 || (c >= 0x2600 && c <= 0x27bf) || (c >= 0x2b00 && c <= 0x2bff)) { n += 2; continue }
    if (c >= 0x1100 && c <= 0x115f) { n += 2; continue }
    if (c >= 0x3000 && c <= 0x9fff) { n += 2; continue }
    n += 1
  }
  return n
}

/* ------------------------------------------------------------ progress bars */

/**
 * A monospace progress bar. Monospace is essential: in the proportional font
 * the blocks and the empty cells have different widths and the bar looks
 * broken. Wrapped in backticks so WhatsApp renders it as code.
 */
function bar (value, max, width = 10) {
  const v = Number(value) || 0
  const mx = Number(max) || 0
  const filled = mx > 0 ? Math.max(0, Math.min(width, Math.round((v / mx) * width))) : 0
  return m('[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']')
}

/** A bar plus its numbers, aligned. */
function barLine (value, max, width = 10) {
  return `${bar(value, max, width)} ${m(`${Math.max(0, Math.round(Number(value) || 0))}/${Math.round(Number(max) || 0)}`)}`
}

/* ------------------------------------------------------------------ fields */

/**
 * One stat row: `📈 *Level* — 1`.
 * The em-dash separator and the bold label are what the reference images use
 * on every single field, so every card goes through here.
 */
function field (icon, label, value) {
  return `${icon} ${b(label)} — ${value}`
}

/** A field whose value is monospaced (numbers that should align). */
function numField (icon, label, value) {
  return `${icon} ${b(label)} — ${m(value)}`
}

/* ------------------------------------------------------------------ header */

/**
 * The card header used at the top of every message.
 *
 *   ⬡ AXYN CORE
 *   └─ by Lil Clutch & Montai
 *
 * `AXYON` is the owner title of the bot — it is not a creator credit. The
 * creators are separate and configurable from the dashboard.
 */
function header ({ creators = ['Lil Clutch', 'Montai'], subtitle = '' } = {}) {
  const out = [`⬡ ${font('AXYN CORE', 'bold')}`]
  if (creators && creators.length) out.push(`└─ by ${creators.join(' & ')}`)
  if (subtitle) out.push(`   ${i(subtitle)}`)
  return out.join('\n')
}

/** A big banner word inside a block frame. */
function banner (word, { kind = 'block', note = '' } = {}) {
  const lines = [font(String(word).toUpperCase(), 'bold')]
  if (note) lines.push(i(note))
  return frame(lines, { kind, width: 22 })
}

/* ------------------------------------------------------------------- lists */

/** A bulleted list with a hanging indent that survives WhatsApp wrapping. */
function bullets (items, icon = '•') {
  return items.map(x => `${icon} ${x}`).join('\n')
}

/** Numbered list. */
function numbered (items) {
  return items.map((x, n) => `${n + 1}. ${x}`).join('\n')
}

/** A quoted block — WhatsApp renders `> ` as a left bar. */
function quote (text) {
  return String(text).split('\n').map(l => `> ${l}`).join('\n')
}

/* -------------------------------------------------------------- name styles */

/**
 * Renders a hunter's name in the display font.
 * Falls back to the raw name if it is empty, so a card never shows `𝕦𝕟𝕕𝕖𝕗𝕚𝕟𝕖𝕕`.
 */
function hunterName (name) {
  const n = String(name || '').trim()
  if (!n) return font('Unnamed Hunter', 'fraktur')
  /* Only transliterate plain ASCII names; a name that is already stylised or
   * contains emoji is left exactly as the player set it. */
  return /^[\x20-\x7e]+$/.test(n) ? font(n, 'fraktur') : n
}

module.exports = {
  font, b, i, s, m,
  DIV, rule,
  FRAMES, frame, cells,
  bar, barLine,
  field, numField,
  header, banner,
  bullets, numbered, quote,
  hunterName
}
