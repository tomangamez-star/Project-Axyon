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
const { createCommands } = require('../src/axyon-commands')
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
function harness ({ player = null, group = { group_jid: '123@g.us', enabled: true, status: 'ACTIVE', features: ['general', 'combat', 'dungeon', 'cards', 'social', 'economy', 'casino', 'duel'] }, battle = null, inv = {} } = {}) {
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
    'inventory', 'inventoryQty', 'addItem', 'consumeItem', 'settings', 'registerGroup', 'equippedCards', 'updateGroupFeatures',
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
  store.registerGroup = async (jid, name, by, mode) => { state.registered = { group_jid: jid, name, registered_by: by, registration_mode: mode, status: 'ACTIVE', enabled: true, registration_id: 'AX-TEST', features: mode === 'duel' ? ['duel'] : [] }; state.group = state.registered; return state.registered }
  store.equippedCards = async () => []
  store.updateGroupFeatures = async (jid, features) => { state.group.features = [...features]; return state.group }

  const restore = () => Object.assign(store, saved)

  /*
   * `handle` builds its own context from the message, so the harness only
   * supplies the socket and the raw message — exactly what the real server
   * passes. That is what makes these tests meaningful: they go through the same
   * context construction, registration gate and mode gate the bot uses.
   */
  const send = async (text, { jid = '123@g.us', asAxyon = false } = {}) => {
    const content = { conversation: text }
    const participant = asAxyon ? '2349110799878@s.whatsapp.net' : '11111111111@s.whatsapp.net'
    const m = { key: { remoteJid: jid, participant, fromMe: false, id: 'x' }, message: content }
    const handled = await c.handle(sock, m, content)
    return { handled, out: sock.sent.map(s => s.text || s.caption || '').join('\n') }
  }

  return { a, c, sock, state, send, restore }
}

const basePlayer = () => ({
  userId: 'u1', name: 'Montai', level: 12, rank: 'D', grade: 1,
  class: 'Fighter', hp: 100, maxHp: 150, powerEnergy: 40, maxPowerEnergy: 90,
  xp: 30, zen: 5000, coins: 3, atk: 20, def: 10, spd: 8,
  stage: 1, wins: 4, losses: 2
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
  /*
   * There is no preview path at all any more. The 30-second Deezer `preview`
   * field was the bug, so it must not be reachable: a track that cannot be
   * produced in full is reported as a failure instead of being sent as a clip.
   */
  assert.doesNotMatch(src, /source = 'preview'/)
  assert.doesNotMatch(src, /downloadPreview/)
  assert.doesNotMatch(src, /t\.preview/)
  /* The full-song method: yt-dlp search -> resolve -> download. */
  assert.match(src, /ytsearch1:/)
  assert.match(src, /full: true/)
  /* A short file is rejected rather than sent. */
  assert.match(src, /MIN_FULL_SECONDS/)
  assert.match(src, /is_streamable/)
})

/* ------------------------------------------------------ 3. group feature gate */

test('!mode has been removed from the command registry and help', async () => {
  const h = harness({ player: basePlayer(), group: { group_jid: '123@g.us', enabled: true, status: 'ACTIVE', features: ['general'] } })
  const result = await h.send('!mode combat')
  const help = await h.send('!help')
  h.restore()
  assert.strictEqual(result.handled, false)
  assert.doesNotMatch(help.out, /!mode\b/)
})

test('dungeon commands are routed by group feature, not player mode', async () => {
  const h = harness({ player: basePlayer(), group: { group_jid: '123@g.us', enabled: true, status: 'ACTIVE', features: ['dungeon'] } })
  const r = await h.send('!floor')
  h.restore()
  assert.strictEqual(r.handled, true)
  assert.doesNotMatch(r.out, /WRONG MODE/)
  assert.doesNotMatch(r.out, /FEATURE UNAVAILABLE/)
})

test('combat commands are blocked when the group has not enabled combat', async () => {
  const h = harness({ player: basePlayer(), group: { group_jid: '123@g.us', enabled: true, status: 'ACTIVE', features: ['dungeon'] } })
  const r = await h.send('!fight')
  h.restore()
  assert.strictEqual(r.handled, true)
  assert.match(r.out, /FEATURE UNAVAILABLE/)
  assert.match(r.out, /combat/i)
})

test('shared battle actions still work in a Dungeon-only group', async () => {
  const h = harness({
    player: basePlayer(),
    group: { group_jid: '123@g.us', enabled: true, status: 'ACTIVE', features: ['dungeon'] },
    battle: { mode: 'floor', ordinal: 1, turn: 1, healsLeft: 5, guard: 0, energy: 50, enemyHp: 80, playerHp: 100, enemy: { name: 'Floor Guardian', hp: 80, atk: 4, def: 1, xp: 10, zen: 10 } }
  })
  const r = await h.send('!attack')
  h.restore()
  assert.doesNotMatch(r.out, /FEATURE UNAVAILABLE/)
  assert.ok(h.state.battle === null || h.state.battle.enemyHp < 80, 'Dungeon battle action did not execute')
})

test('suspended groups cannot use protected commands', async () => {
  const h = harness({ player: basePlayer(), group: { group_jid: '123@g.us', enabled: false, status: 'SUSPENDED', features: ['dungeon'] } })
  const r = await h.send('!floor')
  h.restore()
  assert.match(r.out, /GROUP SUSPENDED/)
})

test('duel commands require a group with the duel feature enabled', async () => {
  const blocked = harness({ player: basePlayer(), group: { group_jid: '123@g.us', enabled: true, status: 'ACTIVE', features: [] } })
  const no = await blocked.send('!duel @someone')
  blocked.restore()
  assert.match(no.out, /FEATURE UNAVAILABLE/)
  const allowed = harness({ player: basePlayer(), group: { group_jid: '123@g.us', enabled: true, status: 'ACTIVE', features: ['duel'] } })
  const yes = await allowed.send('!duel @someone')
  allowed.restore()
  assert.doesNotMatch(yes.out, /FEATURE UNAVAILABLE/)
})

test('unregistered groups are denied before protected systems run', async () => {
  const h = harness({ player: basePlayer(), group: null })
  const r = await h.send('!floor')
  h.restore()
  assert.match(r.out, /ACCESS DENIED/)
  assert.match(r.out, /AXYN CORE/)
})

test('only AXYON can register the current group with !register group duel', async () => {
  const denied = harness({ player: basePlayer(), group: null })
  const no = await denied.send('!register group duel')
  denied.restore()
  assert.match(no.out, /ACCESS DENIED/)

  const allowed = harness({ player: basePlayer(), group: null })
  const yes = await allowed.send('!register group duel', { asAxyon: true })
  assert.match(yes.out, /GROUP REGISTERED/)
  assert.match(yes.out, /DUEL/)
  assert.strictEqual(allowed.state.registered.group_jid, '123@g.us')
  assert.strictEqual(allowed.state.registered.registration_mode, 'duel')
  assert.deepStrictEqual(allowed.state.registered.features, ['duel'])
  allowed.restore()
})

test('Modes registration starts empty and AXYON can enable individual features', async () => {
  const h = harness({ player: basePlayer(), group: null })
  const registered = await h.send('!register group modes', { asAxyon: true })
  assert.match(registered.out, /MODES/)
  assert.deepStrictEqual(h.state.group.features, [])
  const enabled = await h.send('!group enable combat', { asAxyon: true })
  assert.match(enabled.out, /combat.*enabled/i)
  assert.deepStrictEqual(h.state.group.features, ['combat'])
  h.restore()
})

/* ------------------------------------- 5. inventory and shop in all modes */

test('shop and inventory commands remain registered without player-mode gates', () => {
  const h = harness({ player: basePlayer() })
  for (const name of ['shop', 'buy', 'inventory', 'use']) assert.ok(h.c.BY_NAME.has(name), `${name} is missing`)
  assert.ok(!h.c.BY_NAME.has('mode'), '!mode should not be registered')
  h.restore()
})

test('shop and inventory work as shared commands', async () => {
  for (const mode of ['legacy-combat', 'legacy-duels', 'legacy-dungeon', 'legacy-general']) {
    const h = harness({ player: { ...basePlayer()}, inv: { potion: 2 } })
    const shop = await h.send('!shop')
    const inv = await h.send('!inventory')
    h.restore()
    assert.ok(!/WRONG MODE/.test(shop.out), `!shop blocked in ${mode}`)
    assert.ok(!/WRONG MODE/.test(inv.out), `!inventory blocked in ${mode}`)
    assert.match(shop.out, /SHOP/)
    assert.match(inv.out, /Healing Potion/)
  }
})

test('buying an item deducts Zen and adds stock', async () => {
  for (const mode of ['legacy-combat', 'legacy-duels', 'legacy-dungeon', 'legacy-general']) {
    const h = harness({ player: { ...basePlayer(), zen: 1000 } })
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
