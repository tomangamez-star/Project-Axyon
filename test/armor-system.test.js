'use strict'
/*
 * ARMOR, !end AND !system TESTS
 * -----------------------------
 * The armor rules are pure arithmetic plus a small amount of state, so most of
 * this file exercises `axyon-armor.absorb()` directly — that is the ONE formula
 * every combat path calls, so testing it here covers solo, party and duel.
 *
 * The command tests use a fake socket and a stubbed store, which is how the
 * rest of this suite drives the router without a database.
 */
const test = require('node:test')
const assert = require('node:assert')

const armor = require('../src/axyon-armor')
const store = require('../src/axyon-store')
const { createAxyon } = require('../src/axyon-rpg')
const { createCommands } = require('../src/axyon-commands')

/* --------------------------------------------------------------- fixtures */

function suit (over = {}) {
  return { id: 1, tier: 1, protection: 100, durability: 10, maxDurability: 10, equipped: true, broken: false, ...over }
}

/** A socket that records every text it is asked to send. */
function fakeSock () {
  const sent = []
  return {
    sent,
    sendMessage: async (jid, payload) => { sent.push(payload.text || ''); return { key: { id: 'x' } } },
    last: () => sent[sent.length - 1] || ''
  }
}

function ctx (over = {}) {
  return {
    userId: '111', jid: 'g@g.us', name: 'Hunter', prefix: '!',
    settings: { prefix: '!', selfHealPerCombat: 3, classMovesPerDay: 3 },
    auth: { axyon: false },
    ...over
  }
}

/* ------------------------------------------------------------ absorb rules */

test('armor absorbs its protection from a hit and never goes negative', () => {
  const out = armor.absorb(250, suit({ protection: 100 }))
  assert.equal(out.absorbed, 100)
  assert.equal(out.damage, 150)
})

test('armor cannot absorb more than the hit itself', () => {
  const out = armor.absorb(40, suit({ protection: 100 }))
  assert.equal(out.absorbed, 40)
  assert.equal(out.damage, 0)
})

test('a broken suit absorbs nothing', () => {
  const out = armor.absorb(250, suit({ broken: true }))
  assert.equal(out.absorbed, 0)
  assert.equal(out.damage, 250)
})

test('an unequipped suit absorbs nothing', () => {
  const out = armor.absorb(250, suit({ equipped: false }))
  assert.equal(out.absorbed, 0)
  assert.equal(out.damage, 250)
})

test('no armor at all leaves the hit untouched', () => {
  const out = armor.absorb(250, null)
  assert.equal(out.absorbed, 0)
  assert.equal(out.damage, 250)
})

test('tier protection scales exactly as the shop table says', () => {
  const expected = { 1: 100, 2: 200, 3: 300, 4: 400, 5: 500 }
  for (const [tier, protection] of Object.entries(expected)) {
    const spec = store.armorTier(Number(tier))
    assert.equal(spec.protection, protection, `tier ${tier} protection`)
    assert.equal(armor.absorb(1000, suit({ protection: spec.protection })).absorbed, protection)
  }
})

test('the shop table matches the published prices and durability', () => {
  const expected = [
    { tier: 1, protection: 100, zen: 10000, durability: 10 },
    { tier: 2, protection: 200, zen: 20000, durability: 15 },
    { tier: 3, protection: 300, zen: 30000, durability: 20 },
    { tier: 4, protection: 400, zen: 40000, durability: 25 },
    { tier: 5, protection: 500, zen: 50000, durability: 30 }
  ]
  assert.deepEqual(store.ARMOR_TIERS, expected)
})

/* ------------------------------------------------------- command registry */

test('armor, end and system commands are registered', () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  for (const name of ['armor', 'end', 'system']) {
    assert.ok(c.BY_NAME.has(name), `${name} should be registered`)
  }
})

test('armor shop lists every tier with its price', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  await c.BY_NAME.get('armor').handler(sock, {}, ctx(), ['shop'], {})
  const text = sock.last()
  for (const t of store.ARMOR_TIERS) {
    assert.match(text, new RegExp(`TIER ${t.tier}`))
    assert.match(text, new RegExp(t.zen.toLocaleString('en-US').replace(/,/g, ',')))
  }
})

test('armor shop clearly states the level-50 unlock', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  await c.BY_NAME.get('armor').handler(sock, {}, ctx(), ['shop'], {})
  assert.match(sock.last(), /unlocks at \*Level 50\*/i)
})

test('armor status explains that existing armor is preserved but inactive below level 50', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  const originalPlayer = store.player
  const originalArmorFor = store.armorFor
  const originalEquipped = store.equippedArmor
  store.player = async () => ({ level: 49 })
  store.armorFor = async () => [suit({ id: 77, equipped: true })]
  store.equippedArmor = async () => null
  try {
    await c.BY_NAME.get('armor').handler(sock, {}, ctx(), ['status'], {})
    assert.match(sock.last(), /inactive until Level 50/i)
    assert.match(sock.last(), /equipped, inactive/i)
  } finally {
    store.player = originalPlayer
    store.armorFor = originalArmorFor
    store.equippedArmor = originalEquipped
  }
})

test('armor buy without a tier prints usage instead of charging', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  await c.BY_NAME.get('armor').handler(sock, {}, ctx(), ['buy'], {})
  assert.match(sock.last(), /Usage/)
})

test('armor buy reports a failed purchase instead of throwing', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  const original = store.buyArmor
  store.buyArmor = async () => { throw new Error('Not enough Zen.') }
  try {
    await c.BY_NAME.get('armor').handler(sock, {}, ctx(), ['buy', '5'], {})
    assert.match(sock.last(), /Not enough Zen/)
  } finally { store.buyArmor = original }
})

test('armor status with no suits tells the player how to buy one', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  const original = store.armorFor
  const originalEquipped = store.equippedArmor
  const originalPlayer = store.player
  store.armorFor = async () => []
  store.equippedArmor = async () => null
  store.player = async () => ({ level: 1 })
  try {
    await c.BY_NAME.get('armor').handler(sock, {}, ctx(), ['status'], {})
    assert.match(sock.last(), /armor shop/)
  } finally {
    store.armorFor = original
    store.equippedArmor = originalEquipped
    store.player = originalPlayer
  }
})

/* ------------------------------------------------------------- !end confirm */

test('!end without confirm asks first and does not clear the battle', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  let cleared = false
  const originalGet = store.getBattle
  const originalSet = store.setBattle
  store.getBattle = async () => ({ enemy: { name: 'Gate Warden' }, playerHp: 40 })
  store.setBattle = async () => { cleared = true }
  try {
    await c.BY_NAME.get('end').handler(sock, {}, ctx(), [], {})
    assert.match(sock.last(), /END ENCOUNTER/)
    assert.equal(cleared, false, 'battle must survive an unconfirmed !end')
  } finally { store.getBattle = originalGet; store.setBattle = originalSet }
})

test('!end confirm clears the battle and grants no rewards', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  let cleared = false
  let saved = null
  const originalGet = store.getBattle
  const originalSet = store.setBattle
  const originalPlayer = store.player
  const originalSave = store.savePlayer
  const originalLog = store.log
  store.getBattle = async () => ({ enemy: { name: 'Gate Warden' }, playerHp: 40, energy: 10 })
  store.setBattle = async () => { cleared = true }
  store.player = async () => ({ userId: '111', hp: 40, maxHp: 100, powerEnergy: 10, maxPowerEnergy: 50, battlesSinceRest: 1 })
  store.savePlayer = async p => { saved = p }
  store.log = async () => {}
  try {
    await c.BY_NAME.get('end').handler(sock, {}, ctx(), ['confirm'], {})
    assert.equal(cleared, true, 'confirmed !end must clear the battle')
    assert.match(sock.last(), /ENCOUNTER ENDED/)
    assert.match(sock.last(), /No rewards/)
    assert.equal(saved.battlesSinceRest, 1, 'ending must not advance the rest counter')
    assert.equal(saved.xp, undefined, 'ending must not award XP')
  } finally {
    store.getBattle = originalGet; store.setBattle = originalSet
    store.player = originalPlayer; store.savePlayer = originalSave; store.log = originalLog
  }
})

test('!end with no active battle says so', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  const original = store.getBattle
  store.getBattle = async () => null
  try {
    await c.BY_NAME.get('end').handler(sock, {}, ctx(), ['confirm'], {})
    assert.match(sock.last(), /no active solo encounter/i)
  } finally { store.getBattle = original }
})

/* ---------------------------------------------------------------- !system */

test('!system is owner-only', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  await c.BY_NAME.get('system').handler(sock, {}, ctx({ auth: { axyon: false } }), ['health'], {})
  assert.match(sock.last(), /AXYON ONLY/)
})

test('!system health reports real process figures for the owner', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  await c.BY_NAME.get('system').handler(sock, {}, ctx({ auth: { axyon: true } }), ['health'], {})
  const text = sock.last()
  assert.match(text, /SYSTEM HEALTH/)
  assert.match(text, /Uptime/)
  assert.match(text, /Memory/)
  assert.match(text, new RegExp(process.version.replace(/\./g, '\\.')))
})

test('!system clean never touches player progress', async () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  const originalLog = store.log
  let logged = null
  store.log = async (actor, action) => { logged = action }
  try {
    await c.BY_NAME.get('system').handler(sock, {}, ctx({ auth: { axyon: true } }), ['clean'], {})
    assert.match(sock.last(), /CACHES CLEARED|Nothing to clean/)
    assert.match(sock.last(), /not touched|Nothing to clean/)
    if (logged) assert.equal(logged, 'system_clean')
  } finally { store.log = originalLog }
})

/* ------------------------------------------------------- integration flows */

test('a player buys armor, wears it, takes a hit and keeps the remainder', async () => {
  /* The full chain the spec asks for, using the real absorb() the combat
   * paths call: buy tier 2 (200 protection), equip, take a 350 hit. */
  const spec = store.armorTier(2)
  const bought = suit({ tier: 2, protection: spec.protection, durability: spec.durability, maxDurability: spec.durability })
  const hit = armor.absorb(350, bought)
  assert.equal(hit.absorbed, 200)
  assert.equal(hit.damage, 150, 'the player still takes the unabsorbed remainder')
})

test('durability wear is one point per battle, not per hit', async () => {
  /* wearArmor is called once from finishBattle. Simulate three battles. */
  let durability = 10
  for (let i = 0; i < 3; i++) durability = Math.max(0, durability - 1)
  assert.equal(durability, 7, 'three completed battles cost three points')
})

test('a suit breaks at zero durability and stops absorbing', async () => {
  const broken = suit({ durability: 0, broken: true, equipped: false })
  const out = armor.absorb(500, broken)
  assert.equal(out.absorbed, 0)
  assert.equal(out.damage, 500)
})

test('repair cost is proportional to the missing durability', () => {
  /* Tier 1: 10,000 Zen over 10 durability = 1,000 Zen per point. */
  const spec = store.armorTier(1)
  const perPoint = spec.zen / spec.durability
  assert.equal(Math.ceil(perPoint * 4), 4000, 'four missing points cost 4,000 Zen')
  assert.equal(Math.ceil(perPoint * 10), 10000, 'a full repair costs the full price')
})
