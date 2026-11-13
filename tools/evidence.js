'use strict'
/*
 * EVIDENCE — renders the real cards and proves `!play` returns full audio.
 *
 * Run: node tools/evidence.js
 * Writes documents/axyon-modes/evidence.txt
 */
const fs = require('fs')
const path = require('path')
const { createAxyon } = require('../src/axyon-rpg')
const { createCommands, GAME_MODES, modeOf } = require('../src/axyon-commands')
const greetings = require('../src/greetings')
const music = require('../src/music')

const OUT = path.join(__dirname, '..', 'documents', 'axyon-modes')
fs.mkdirSync(OUT, { recursive: true })

const lines = []
const say = s => { lines.push(s); console.log(s) }

const player = {
  userId: 'u1', name: 'Montai', level: 12, rank: 'D', grade: 1,
  class: 'Fighter', hp: 118, maxHp: 150, powerEnergy: 40, maxPowerEnergy: 90,
  xp: 30, zen: 5000, coins: 3, atk: 20, def: 10, spd: 8,
  stage: 1, wins: 4, losses: 2, gameMode: 'general'
}

async function main () {
  const a = createAxyon({})
  createCommands({ axyon: a })

  say('='.repeat(70))
  say('1. THE NEW !profile CARD  (no Unicode display fonts)')
  say('='.repeat(70))
  const profile = a.profileCard(player, { settings: {} })
  say(profile)
  say('')
  const banned = /[\u{1D400}-\u{1D7FF}]/u
  say(`contains mathematical-alphanumeric display font: ${banned.test(profile)}`)
  say(`contains WhatsApp bold (*...*): ${/\*[^*]+\*/.test(profile)}`)
  say(`contains monospace (\`...\`): ${/`/.test(profile)}`)
  say(`contains a box frame: ${/[\u256D\u2570\u2502\u250C\u2514]/.test(profile)}`)

  say('')
  say('='.repeat(70))
  say('2. !arise IS UNCHANGED  (still uses the display font)')
  say('='.repeat(70))
  const arise = greetings.firstGreeting(
    { name: 'Montai', rank: 'E', level: 1, grade: 1, hp: 100, maxHp: 100, powerEnergy: 50, maxPowerEnergy: 50, xp: 0 },
    '!', {}
  )
  say(arise)
  say('')
  say(`arise still contains the display font: ${banned.test(arise)}`)

  say('')
  say('='.repeat(70))
  say('3. MODE MAP')
  say('='.repeat(70))
  for (const [key, meta] of Object.entries(GAME_MODES)) {
    const rows = a.COMMANDS.filter(x => meta.sections.includes(x.section) && !x.hidden).map(x => x.name)
    say(`${meta.name.padEnd(9)} ${rows.map(r => '!' + r).join(' ')}`)
  }
  const free = a.COMMANDS.filter(x => modeOf(x.name, x.section) === null).map(x => '!' + x.name)
  say(`${'Every mode'.padEnd(9)} ${free.join(' ')}`)

  say('')
  say('='.repeat(70))
  say('4. !play — FULL-LENGTH AUDIO')
  say('='.repeat(70))
  for (const q of ['blinding lights', 'daft punk one more time']) {
    const r = await music.resolve(q)
    if (!r.ok) { say(`${q}: FAILED — ${r.message}`); continue }
    const st = fs.statSync(r.file)
    say(`${q}`)
    say(`  title      ${r.track.title}`)
    say(`  artist     ${r.track.artist}`)
    say(`  duration   ${music.mmss(r.track.duration)} (${r.track.duration}s)`)
    say(`  bytes      ${st.size.toLocaleString('en-US')}`)
    say(`  mimetype   ${music.mimeFor(r.file)}`)
    say(`  source     ${r.source}`)
    say(`  full track ${r.full}`)
    say(`  verdict    ${r.full && r.track.duration > 60 ? 'FULL SONG (not a 30s preview)' : 'PREVIEW'}`)
    await music.cleanup(r.dir)
  }

  fs.writeFileSync(path.join(OUT, 'evidence.txt'), lines.join('\n') + '\n')
  console.log(`\nwritten to ${path.join(OUT, 'evidence.txt')}`)
}

main().catch(e => { console.error(e); process.exit(1) })
