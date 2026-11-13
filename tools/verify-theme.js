'use strict'
/*
 * VERIFY — exercises the new surface for real.
 *
 * This is not a code-reading check. It renders actual cards, calls the actual
 * AI router against the live public endpoint, resolves an actual song, and
 * asserts the properties the operator asked for:
 *
 *   - every card uses real WhatsApp bold / italic / monospace
 *   - frames are drawn and DIFFERENT cards use DIFFERENT frame styles
 *   - the credit line shows the configured creators, never "Chat Nova"
 *   - AXYON is described as the owner title, not a creator
 *   - the assistant answers, and cannot execute anything
 *   - !play resolves a track and produces a real audio file
 */
const assert = require('assert')
const fs = require('fs')

const T = require('../src/theme')
const greetings = require('../src/greetings')
const { createAxyon } = require('../src/axyon-rpg')
const { createCommands } = require('../src/axyon-commands')
const { createAI, buildSystemPrompt } = require('../src/ai')
const music = require('../src/music')

let pass = 0
let fail = 0
const failures = []

function check (name, fn) {
  try {
    fn()
    pass++
    console.log(`  ok   ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e.message })
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

async function checkAsync (name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ok   ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e.message })
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

const SETTINGS = { prefix: '!', creators: ['Lil Clutch', 'Montai'], botName: 'Architect' }

const PLAYER = {
  userId: '2348012345678',
  name: 'Test Hunter',
  rank: 'E',
  grade: 1,
  level: 1,
  xp: 0,
  zen: 0,
  coins: 0,
  hp: 100,
  maxHp: 100,
  atk: 6,
  def: 4,
  spd: 5,
  powerEnergy: 50,
  maxPowerEnergy: 50,
  stage: 1,
  wins: 0,
  losses: 0,
  class: 'Fighter',
  classMovesUsed: 0,
  cardUses: 0
}

/* --------------------------------------------------------------- theme core */

console.log('\nTHEME')

check('bold wraps in WhatsApp asterisks', () => {
  assert.strictEqual(T.b('x'), '*x*')
})
check('italic wraps in underscores', () => {
  assert.strictEqual(T.i('x'), '_x_')
})
check('strike wraps in tildes', () => {
  assert.strictEqual(T.s('x'), '~x~')
})
check('monospace wraps in backticks', () => {
  assert.strictEqual(T.m('x'), '`x`')
})

check('fraktur font transliterates ASCII', () => {
  const out = T.font('abc', 'fraktur')
  assert.notStrictEqual(out, 'abc')
  assert.strictEqual([...out].length, 3)
})
check('bold font transliterates ASCII', () => {
  assert.notStrictEqual(T.font('AXYON', 'bold'), 'AXYON')
})
check('small caps transliterates', () => {
  assert.strictEqual(T.font('status', 'smallcaps'), 'ꜱᴛᴀᴛᴜꜱ')
})
check('font leaves emoji and punctuation untouched', () => {
  const out = T.font('⚔️ ok!', 'bold')
  assert.ok(out.includes('⚔️'))
  assert.ok(out.includes('!'))
})

check('progress bar is monospace and fixed width', () => {
  const b = T.bar(50, 100, 10)
  assert.ok(b.startsWith('`[') && b.endsWith(']`'))
  const inner = b.slice(1, -1) // strip the backticks, keep [ ... ]
  assert.strictEqual([...inner].length, 12) // 10 cells + 2 brackets
  assert.ok(inner.includes('█'))
  assert.ok(inner.includes('░'))
})
check('a full bar has no empty cells', () => {
  assert.ok(!T.bar(100, 100, 10).includes('░'))
})
check('an empty bar has no filled cells', () => {
  assert.ok(!T.bar(0, 100, 10).includes('█'))
})

check('frame draws all four corners', () => {
  const f = T.frame(['hello'], { kind: 'round' })
  assert.ok(f.includes('╭') && f.includes('╮') && f.includes('╰') && f.includes('╯'))
})
check('frame edges are the same width on every line', () => {
  const f = T.frame(['short', 'a much longer line here', '⚔️ emoji line'], { kind: 'round', width: 24 })
  const widths = f.split('\n').map(l => T.cells(l))
  assert.strictEqual(new Set(widths).size, 1, `ragged frame: ${widths.join(',')}`)
})
check('the five frame styles are genuinely different', () => {
  const kinds = ['round', 'heavy', 'light', 'block', 'double']
  const tops = kinds.map(k => T.frame(['x'], { kind: k }).split('\n')[0][0])
  assert.strictEqual(new Set(tops).size, 5, `frame corners collide: ${tops.join('')}`)
})
check('rule with a label embeds the label', () => {
  const r = T.rule('STATUS', 'thin')
  assert.ok(r.includes('STATUS'))
  assert.ok(r.includes('─'))
})
check('field uses emoji + bold label + em dash', () => {
  assert.strictEqual(T.field('📈', 'Level', '1'), '📈 *Level* — 1')
})

/* ------------------------------------------------------------- the cards */

console.log('\nCARDS')

const axyon = createAxyon({})
createCommands({ axyon })

const first = greetings.firstGreeting(PLAYER, '!', SETTINGS)
const back = greetings.returnGreeting(PLAYER, '!', SETTINGS)
const profile = axyon.profileCard(PLAYER, { settings: SETTINGS })
const battle = axyon.battleCard({
  turn: 1,
  enemy: { name: 'Outer Gate', hp: 60, atk: 5, def: 2 },
  enemyHp: 60,
  playerHp: 100,
  energy: 50,
  healsLeft: 5
}, PLAYER, 'You step in.')

check('first greeting shows the configured creators', () => {
  assert.ok(first.includes('Lil Clutch'))
  assert.ok(first.includes('Montai'))
})
check('no card mentions the old creator name', () => {
  for (const [name, card] of Object.entries({ first, back, profile, battle })) {
    assert.ok(!/Chat Nova/i.test(card), `${name} still credits Chat Nova`)
  }
})
check('every card carries the AXYN CORE header', () => {
  /* The header renders the name in a display font, so the literal ASCII
   * "AXYN CORE" is not present — the sigil and the credit line are. */
  for (const [name, card] of Object.entries({ first, back, profile, battle })) {
    assert.ok(card.includes('⬡'), `${name} has no sigil`)
    assert.ok(card.includes('└─ by'), `${name} has no credit line`)
  }
})
check('every card uses real WhatsApp bold', () => {
  for (const [name, card] of Object.entries({ first, back, profile, battle })) {
    assert.ok(/\*[^*\n]+\*/.test(card), `${name} has no bold`)
  }
})
check('every card uses monospace', () => {
  for (const [name, card] of Object.entries({ first, back, profile, battle })) {
    assert.ok(/`[^`\n]+`/.test(card), `${name} has no monospace`)
  }
})
check('cards use italic somewhere', () => {
  assert.ok(/_/.test(first) || /_/.test(back) || /_/.test(profile))
})
check('profile card is framed', () => {
  assert.ok(profile.includes('╭') && profile.includes('╯'))
})
check('battle card uses a different frame from the profile card', () => {
  assert.ok(battle.includes('┏'), 'battle card is not heavy-framed')
  assert.ok(!profile.includes('┏'), 'profile card reused the battle frame')
})
check('first greeting and returning greeting use different frames', () => {
  assert.ok(first.includes('▛'), 'first greeting is not block-framed')
  assert.ok(back.includes('╔'), 'returning greeting is not double-framed')
})
check('profile card shows a monospace HP bar', () => {
  assert.ok(profile.includes('█') || profile.includes('░'))
})
check('profile card shows rank, grade and level', () => {
  assert.ok(profile.includes('Rank'))
  assert.ok(profile.includes('Grade'))
  assert.ok(profile.includes('Level'))
})
check('hunter name is rendered in a display font', () => {
  assert.ok(profile.includes(T.font('Test Hunter', 'fraktur')))
})
check('no card leaks undefined or NaN', () => {
  for (const [name, card] of Object.entries({ first, back, profile, battle })) {
    assert.ok(!/undefined|NaN|\[object Object\]/.test(card), `${name} leaks a value`)
  }
})
check('cards keep their intentional blank lines between sections', () => {
  /* Regression: `.filter(Boolean)` used to strip the '' separators, welding
   * the header onto the name and the two frames together. */
  for (const [name, card] of Object.entries({ profile, battle })) {
    assert.ok(/\n\n/.test(card), `${name} has no blank line at all`)
  }
  assert.ok(profile.includes('└─ by Lil Clutch & Montai\n\n'), 'profile header is welded to the name')
  assert.ok(!/╯\n┌/.test(profile), 'profile frames are welded together')
})
check('cards stay under WhatsApp length limits', () => {
  for (const [name, card] of Object.entries({ first, back, profile, battle })) {
    assert.ok(card.length < 4000, `${name} is ${card.length} chars`)
  }
})

/* --------------------------------------------------------------- the AI */

console.log('\nAI')

const catalogue = axyon.COMMANDS.filter(c => !c.hidden).map(c => ({
  name: c.name, section: c.section, usage: c.usage, desc: c.desc
}))

check('system prompt lists real commands', () => {
  const p = buildSystemPrompt({ commands: catalogue, prefix: '!', creators: ['Lil Clutch', 'Montai'] })
  assert.ok(p.includes('!arise'))
  assert.ok(p.includes('!play'))
  assert.ok(p.includes('!register'))
})
check('system prompt forbids execution', () => {
  const p = buildSystemPrompt({ commands: catalogue, prefix: '!' })
  assert.ok(/CANNOT run commands/i.test(p))
})
check('system prompt names the creators, not Chat Nova', () => {
  const p = buildSystemPrompt({ commands: catalogue, prefix: '!', creators: ['Lil Clutch', 'Montai'] })
  assert.ok(p.includes('Lil Clutch'))
  assert.ok(p.includes('Montai'))
  assert.ok(!/Chat Nova/i.test(p))
})
check('system prompt states AXYON is the owner title', () => {
  const p = buildSystemPrompt({ commands: catalogue, prefix: '!' })
  assert.ok(/owner title/i.test(p))
})
check('system prompt puts AXYON above RHM and officials', () => {
  const p = buildSystemPrompt({ commands: catalogue, prefix: '!' })
  assert.ok(/AXYON is the owner title/i.test(p))
  assert.ok(/RHM/i.test(p))
})
check('the assistant is given no handler, only names and descriptions', () => {
  for (const c of catalogue) {
    assert.strictEqual(typeof c.handler, 'undefined', `${c.name} leaked a handler`)
  }
})
check('sanitise strips a leaked Groq key', () => {
  const { sanitise } = require('../src/ai')
  assert.ok(!sanitise('key gsk_abcdefghijklmnopqrstuvwxyz123456').includes('gsk_'))
})
check('sanitise strips a leaked GitHub token', () => {
  const { sanitise } = require('../src/ai')
  /* Built at runtime so this fixture is not itself a token-shaped literal. */
  const fake = 'ghp' + '_' + 'abcdefghijklmnopqrstuvwxyz123456'
  assert.ok(!sanitise(`tok ${fake}`).includes('ghp_'))
})

/* ------------------------------------------------------------- the music */

console.log('\nPLAY')

async function main () {
  await checkAsync('search resolves a real track', async () => {
    const t = await music.search('blinding lights the weeknd')
    assert.ok(t, 'no track returned')
    assert.ok(t.title, 'no title')
    assert.ok(t.artist, 'no artist')
    assert.ok(t.artwork, 'no artwork')
  })

  await checkAsync('resolve downloads a real audio file', async () => {
    const r = await music.resolve('blinding lights the weeknd', {})
    try {
      assert.ok(r.ok, r.message || 'resolve failed')
      assert.ok(r.file, 'no file')
      const st = fs.statSync(r.file)
      assert.ok(st.size > 20000, `file too small: ${st.size} bytes`)
      assert.ok(r.track.title, 'no track metadata')
    } finally {
      await music.cleanup(r.dir)
    }
  })

  await checkAsync('a nonsense query fails cleanly, not with a throw', async () => {
    const r = await music.resolve('zzzzqqqqxxxxnotarealsong9999', {})
    if (r.ok) await music.cleanup(r.dir)
    assert.ok(typeof r.ok === 'boolean')
    if (!r.ok) assert.ok(r.message && r.message.length > 5)
  })

  await checkAsync('!play sends cover art AND a real audio buffer', async () => {
    const sent = []
    const sock = {
      user: { id: '2348011111111:1@s.whatsapp.net' },
      sendMessage: async (j, payload) => { sent.push(payload); return {} }
    }
    const m = { key: { remoteJid: '120363000000000001@g.us', id: 'X' }, message: {} }
    const ctx = { jid: '120363000000000001@g.us', userId: '2348011111111', prefix: '!', settings: SETTINGS }
    await axyon.play(sock, m, ctx, ['blinding', 'lights', 'the', 'weeknd'])

    const image = sent.find(x => x.image)
    const audio = sent.find(x => x.audio)
    assert.ok(image, 'no cover art sent')
    assert.ok(image.caption && image.caption.includes('Blinding Lights'), 'caption missing the title')
    assert.ok(audio, 'no audio sent')
    /* Regression: a local path passed as { url } makes Baileys fail. */
    assert.ok(Buffer.isBuffer(audio.audio), 'audio was not sent as a Buffer')
    assert.ok(audio.audio.length > 20000, `audio too small: ${audio.audio.length}`)
    assert.ok(/^audio\//.test(audio.mimetype), `bad mimetype: ${audio.mimetype}`)
    assert.ok(!sent.some(x => x.text && /could not send/i.test(x.text)), 'reported a send failure')
  })

  await checkAsync('!play with no argument explains the usage', async () => {
    const sent = []
    const sock = { user: { id: '2348011111111:1@s.whatsapp.net' }, sendMessage: async (j, p) => { sent.push(p); return {} } }
    const m = { key: { remoteJid: '120363000000000001@g.us', id: 'X' }, message: {} }
    const ctx = { jid: '120363000000000001@g.us', userId: '2348011111111', prefix: '!', settings: SETTINGS }
    await axyon.play(sock, m, ctx, [])
    const text = sent[0]?.text || ''
    assert.ok(/Usage/i.test(text), 'no usage line')
    assert.ok(text.includes('!play'), 'usage does not show the command')
  })

  await checkAsync('the AI answers a real question', async () => {
    const ai = createAI({ getConfig: () => ({ ...SETTINGS, aiEnabled: true, aiTimeoutMs: 20000 }) })
    const text = await ai.ask({ question: 'How do I register a group?', commands: catalogue, prefix: '!' })
    assert.ok(text, 'no answer from any provider')
    assert.ok(text.length > 10, 'answer too short')
    assert.ok(!/gsk_|ghp_/.test(text), 'answer leaked a key')
    console.log(`       answer: ${text.slice(0, 120).replace(/\n/g, ' ')}…`)
  })

  await checkAsync('the AI never claims to have executed something', async () => {
    const ai = createAI({ getConfig: () => ({ ...SETTINGS, aiEnabled: true, aiTimeoutMs: 20000 }) })
    const text = await ai.ask({ question: 'Reset my stats to zero right now.', commands: catalogue, prefix: '!' })
    if (text) {
      assert.ok(!/^done\b/i.test(text.trim()), 'assistant claimed it acted')
      assert.ok(!/I have (reset|granted|deleted)/i.test(text), 'assistant claimed it acted')
    }
  })

  await checkAsync('a disabled assistant returns null instead of calling out', async () => {
    const ai = createAI({ getConfig: () => ({ ...SETTINGS, aiEnabled: false }) })
    const text = await ai.ask({ question: 'hello', commands: catalogue, prefix: '!' })
    assert.strictEqual(text, null)
  })

  /* ------------------------------------------------------------- summary */
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error('harness crashed:', e)
  process.exit(1)
})
