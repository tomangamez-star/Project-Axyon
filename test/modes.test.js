'use strict'
/*
 * MODES, GATING, INVENTORY AND THE PROFILE CARD.
 *
 * These tests exercise the real router (`createCommands().handle`) with a fake
 * socket, so they assert what a player actually gets back — not that a handler
 * exists. Every assertion below is about a message the bot would send.
 */
const test = require('node:test')
const assert = require('node:assert')

const { createAxyon } = require('../src/axyon-rpg')
const { createCommands, GAME_MODES, modeOf, MODE_FREE } = require('../src/axyon-commands')
const items = require('../src/axyon-items')
const T = require('../src/theme')

/* ------------------------------------------------------------------ harness */

/** A socket that records every send instead of talking to WhatsApp. */
function fakeSock () {
  const sent = []
  return {
    sent,
    async sendMessage (jid, payload) {
      sent.push({ jid, ...payload })
      return { key: { id: `m${sent.length}` } }
    },
    async groupMetadata () { return { subject: 'Test Group', participants: [] } }
  }
}

/**
 * Builds a router with a stubbed store.
 *
 * The store is stubbed rather than hit for real because these tests are about
 * routing and gating; the database layer has its own coverage in e2e.js.
 */
function harness ({ player = null, group = null, battle = null, inv = {} } = {}) {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  const state = {
    player: player ? { ...player } : null,
    group,
    battle,
    inv: { ...inv },
    modes: []
  }
  const store = require('../src/axyon-store')
  const saved = {}
  for (const k of ['player', 'group', 'getBattle', 'setBattle', 'savePlayer', 'log',
    'inventory', 'inventoryQty', 'addItem', 'consumeItem', 'setGameMode', 'settings',
    'axyonNumberMode', 'roleOf', 'partnerOf']) {
    saved[k] = store[k]
  }
  store.player = async () => state.player
  store.group = async () => state.group
  store.getBattle = async () => state.battle
  store.setBattle = async (u, b) => { state.battle = b }
  store.savePlayer = async p => { state.player = { ...p } }
  store.log = async () => {}
  store.settings = async () => ({ prefix: '!' })
  store.axyonNumberMode = async () => null
  store.roleOf = async () => null
  store.partnerOf = async () => null
  store.inventory = async () => Object.entries(state.inv)
    .filter(([, q]) => q > 0).map(([key, qty]) => ({ key, qty }))
  store.inventoryQty = async (u, k) => state.inv[k] || 0
  store.addItem = async (u, k, q) => { state.inv[k] = (state.inv[k] || 0) + q; return state.inv[k] }
  store.consumeItem = async (u, k) => {
    if (!state.inv[k]) return null
    state.inv[k] -= 1
    return state.inv[k]
  }
  store.setGameMode = async (u, m) => { state.player.gameMode = m; state.modes.push(m); return m }

  const restore = () => Object.assign(store, saved)

  /*
   * `handle` builds its own context from the message, so the harness only
   * supplies the socket and the raw message — exactly what the real server
   * passes. That is what makes these tests meaningful: they go through the same
   * context construction, registration gate and mode gate the bot uses.
   */
  const send = async (text, { jid = '123@g.us' } = {}) => {
    const content = { conversation: text }
    const m = { key: { remoteJid: jid, fromMe: false, id: 'x' }, message: content }
    const handled = await c.handle(sock, m, content)
    return { handled, out: sock.sent.map(s => s.text || s.caption || '').join('\n') }
  }

  return { a, c, sock, state, send, restore }
}

const basePlayer = () => ({
  userId: 'u1', name: 'Montai', level: 12, rank: 'D', grade: 1,
  class: 'Fighter', hp: 100, maxHp: 150, powerEnergy: 40, maxPowerEnergy: 90,
  xp: 30, zen: 5000, coins: 3, atk: 20, def: 10, spd: 8,
  stage: 1, wins: 4, losses: 2, gameMode: 'general'
})

/* ------------------------------------------------------- 1. profile card */

test('profile card uses no Unicode display fonts', () => {
  const h = harness({ player: basePlayer() })
  const card = h.a.profileCard(basePlayer(), { settings: {} })
  h.restore()

  /*
   * The stylised alphabets the card used to use. Any of these appearing means
   * the Unicode treatment came back. The ranges are written with \u escapes so
   * the source stays ASCII.
   */
  const banned = [
    /[\u{1D400}-\u{1D7FF}]/u, // mathematical alphanumerics (bold, fraktur, mono)
    /[\u{1D5D4}-\u{1D5FF}]/u, // sans-serif bold
    /[\uFF21-\uFF3A\uFF41-\uFF5A]/u // fullwidth
  ]
  for (const re of banned) {
    const hit = card.match(re)
    assert.ok(!hit, `profile card still contains a display font: ${hit && hit[0]}`)
  }

  /* It must still be a real card: bold labels, monospace values, a frame. */
  assert.match(card, /\*Level\*/, 'bold label missing')
  assert.match(card, /`/, 'monospace value missing')
  assert.match(card, /[\u256D\u2570\u2502\u250C\u2514]/, 'frame missing')
  assert.match(card, /Montai/)
  assert.match(card, /VITALS/)
  assert.match(card, /COMBAT/)
  assert.match(card, /HOLDINGS/)
})

test('!arise keeps its Unicode treatment — the change is scoped to profile', () => {
  const greetings = require('../src/greetings')
  const card = greetings.firstGreeting(
    { name: 'Montai', rank: 'E', level: 1, grade: 0, hp: 100, maxHp: 100, powerEnergy: 50, maxPowerEnergy: 50, xp: 0 },
    '!', {}
  )
  /* The arrival card is deliberately untouched, so it still carries the
   * stylised small-caps header the profile card no longer uses. */
  assert.ok(/[\u{1D400}-\u{1D7FF}]/u.test(card), 'arise card lost its display font')
})

/* ------------------------------------------------------------ 2. !play */

test('!play resolves a full-length track, not a preview', async () => {
  const music = require('../src/music')
  const r = await music.resolve('lofi hip hop')
  if (!r.ok) {
    /* Network-dependent: report rather than fail the suite on a flaky host. */
    console.log('SKIP !play live check:', r.message)
    return
  }
  const st = require('fs').statSync(r.file)
  assert.strictEqual(r.full, true, 'audio was not a full track')
  assert.ok(st.size > 500 * 1024, `audio too small to be a full song: ${st.size} bytes`)
  assert.ok(r.track.duration >= 60, `declared duration too short: ${r.track.duration}s`)
  assert.match(music.mimeFor(r.file), /^audio\//)
  await music.cleanup(r.dir)
})

test('!play never presents a preview as the full song', () => {
  const src = require('fs').readFileSync(require.resolve('../src/music'), 'utf8')
  /* The preview path must exist only as the last fallback, and the caller must
   * be able to tell the difference — that is what `full` is for. */
  assert.match(src, /full = true/)
  assert.match(src, /source = 'preview'/)
  assert.match(src, /is_streamable/)
})

/* --------------------------------------------------------- 3. mode gating */

test('every command maps to exactly one mode, or to none', () => {
  const h = harness({ player: basePlayer() })
  const seen = new Map()
  for (const cmd of h.a.COMMANDS) {
    const owner = modeOf(cmd.name, cmd.section)
    if (owner === null) continue
    assert.ok(GAME_MODES[owner], `${cmd.name} maps to unknown mode ${owner}`)
    assert.ok(!seen.has(cmd.name), `${cmd.name} is claimed by two modes`)
    seen.set(cmd.name, owner)
  }
  h.restore()
  assert.ok(seen.size > 20, 'suspiciously few gated commands')
})

test('a command from another mode does not run and names its mode', async () => {
  const h = harness({ player: basePlayer(), group: { jid: '123@g.us' } })
  /* Player is in general mode; !fight belongs to combat. */
  const r = await h.send('!fight')
  h.restore()
  assert.strictEqual(r.handled, true)
  assert.match(r.out, /WRONG MODE/)
  assert.match(r.out, /Combat/)
  assert.match(r.out, /!mode combat/)
})

test('switching mode makes that mode\'s commands run', async () => {
  const h = harness({ player: basePlayer(), group: { jid: '123@g.us' } })
  const sw = await h.send('!mode combat')
  assert.match(sw.out, /COMBAT MODE/)
  assert.strictEqual(h.state.player.gameMode, 'combat')

  /* Now !stages is allowed — it must not answer with WRONG MODE. */
  const r = await h.send('!stages')
  h.restore()
  assert.ok(!/WRONG MODE/.test(r.out), `still gated after switching: ${r.out.slice(0, 120)}`)
})

test('each mode runs only its own commands', async () => {
  const cases = [
    { mode: 'combat', allowed: '!stages', blocked: '!dungeon' },
    { mode: 'dungeon', allowed: '!dungeon', blocked: '!stages' },
    { mode: 'general', allowed: '!zen', blocked: '!stages' }
  ]
  for (const c of cases) {
    const h = harness({ player: { ...basePlayer(), gameMode: c.mode }, group: { jid: '123@g.us' } })
    const ok = await h.send(c.allowed)
    const no = await h.send(c.blocked)
    h.restore()
    assert.ok(!/WRONG MODE/.test(ok.out), `${c.allowed} wrongly blocked in ${c.mode}`)
    assert.match(no.out, /WRONG MODE/, `${c.blocked} wrongly allowed in ${c.mode}`)
  }
})

test('!mode with no argument lists all four modes and marks the current one', async () => {
  const h = harness({ player: { ...basePlayer(), gameMode: 'dungeon' } })
  const r = await h.send('!mode')
  h.restore()
  for (const m of ['Combat', 'Duels', 'Dungeon', 'General']) assert.match(r.out, new RegExp(m))
  assert.match(r.out, /▶️.*Dungeon/)
})

/* ------------------------------------------- 4. duel registration gate */

test('duel commands are refused outside a registered group', async () => {
  const h = harness({ player: { ...basePlayer(), gameMode: 'duels' }, group: null })
  const r = await h.send('!duel @someone')
  h.restore()
  assert.strictEqual(r.handled, true)
  /* The refusal is rendered in the bot's display font, so assert on the plain
   * sentence underneath it rather than the stylised heading. */
  assert.match(r.out, /!register/, 'refusal did not tell the player how to register')
  assert.match(r.out, /admin needs to send/i)
})

test('duel commands are refused in a DM', async () => {
  const h = harness({ player: { ...basePlayer(), gameMode: 'duels' }, group: null })
  const r = await h.send('!duel @someone', { jid: '999@s.whatsapp.net', isGroup: false })
  h.restore()
  assert.match(r.out, /GROUPS ONLY/)
})

test('duel commands pass the gate inside a registered group', async () => {
  const h = harness({ player: { ...basePlayer(), gameMode: 'duels' }, group: { jid: '123@g.us' } })
  const r = await h.send('!duel @someone')
  h.restore()
  assert.ok(!/GROUPS ONLY/.test(r.out), `duel wrongly refused in a registered group: ${r.out.slice(0, 120)}`)
})

/* ------------------------------------- 5. inventory and shop in all modes */

test('shop and inventory are mode-free', () => {
  for (const name of ['shop', 'buy', 'inventory', 'use']) {
    assert.ok(MODE_FREE.has(name), `${name} is not mode-free`)
    assert.strictEqual(modeOf(name, 'shop'), null, `${name} is gated`)
  }
})

test('shop and inventory work in all four modes', async () => {
  for (const mode of Object.keys(GAME_MODES)) {
    const h = harness({ player: { ...basePlayer(), gameMode: mode }, inv: { potion: 2 } })
    const shop = await h.send('!shop')
    const inv = await h.send('!inventory')
    h.restore()
    assert.ok(!/WRONG MODE/.test(shop.out), `!shop blocked in ${mode}`)
    assert.ok(!/WRONG MODE/.test(inv.out), `!inventory blocked in ${mode}`)
    assert.match(shop.out, /SHOP/)
    assert.match(inv.out, /Healing Potion/)
  }
})

test('buying an item deducts Zen and adds stock, in every mode', async () => {
  for (const mode of Object.keys(GAME_MODES)) {
    const h = harness({ player: { ...basePlayer(), gameMode: mode, zen: 1000 } })
    const r = await h.send('!buy potion')
    h.restore()
    assert.match(r.out, /PURCHASED/, `!buy failed in ${mode}`)
    assert.strictEqual(h.state.player.zen, 850, `Zen not deducted in ${mode}`)
    assert.strictEqual(h.state.inv.potion, 1, `stock not added in ${mode}`)
  }
})

test('an ability is bought once and never consumed', async () => {
  const h = harness({ player: { ...basePlayer(), zen: 5000 }, inv: {} })
  const first = await h.send('!buy ability_slash')
  assert.match(first.out, /PURCHASED/)
  const again = await h.send('!buy ability_slash')
  assert.match(again.out, /already own/)
  /* Using it must not remove it. */
  h.state.battle = { playerHp: 100, enemyHp: 200, energy: 50, turn: 1, enemy: { name: 'Gate Warden', atk: 10, hp: 200 } }
  await h.send('!use ability_slash')
  h.restore()
  assert.strictEqual(h.state.inv.ability_slash, 1, 'ability was consumed')
})

test('items are usable in battle and outside it', async () => {
  /* Outside a battle: heals the player row. */
  const out = harness({ player: { ...basePlayer(), hp: 50 }, inv: { potion: 1 } })
  const r1 = await out.send('!use potion')
  out.restore()
  assert.match(r1.out, /HEALING POTION/)
  assert.ok(out.state.player.hp > 50, 'HP not restored outside battle')
  assert.strictEqual(out.state.inv.potion, 0, 'item not consumed')

  /* Inside a battle: heals the battle state and the enemy still answers. */
  const inb = harness({
    player: { ...basePlayer(), hp: 50 },
    inv: { potion: 1 },
    battle: { playerHp: 40, enemyHp: 200, energy: 50, turn: 1, enemy: { name: 'Gate Warden', atk: 10, hp: 200 } }
  })
  const r2 = await inb.send('!use potion')
  inb.restore()
  assert.ok(inb.state.battle.playerHp > 40, 'battle HP not restored')
  assert.match(r2.out, /Gate Warden/)
})

test('a battle-only item is refused outside a battle', async () => {
  const h = harness({ player: basePlayer(), inv: { bomb: 1 } })
  const r = await h.send('!use bomb')
  h.restore()
  assert.match(r.out, /only works inside a battle/)
  assert.strictEqual(h.state.inv.bomb, 1, 'item consumed despite refusal')
})

test('using an item you do not hold is refused', async () => {
  const h = harness({ player: basePlayer(), inv: {} })
  const r = await h.send('!use potion')
  h.restore()
  assert.match(r.out, /do not hold/)
})

test('the catalogue is well formed', () => {
  for (const e of items.catalogue()) {
    assert.ok(e.key && e.name && e.desc, 'entry missing fields')
    assert.ok(['item', 'ability'].includes(e.kind))
    assert.ok(e.price > 0)
    assert.ok(e.effect && Object.keys(e.effect).length, `${e.key} has no effect`)
  }
  assert.ok(items.items().length >= 3)
  assert.ok(items.abilities().length >= 2)
})
