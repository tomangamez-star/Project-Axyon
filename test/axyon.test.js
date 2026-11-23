'use strict'
/*
 * AXYON RPG tests — progression, combat, economy limits, command registry
 * and the admin moderation surface. No database required: these exercise the
 * pure logic and the registries, which is where the manuscript rules live.
 */
const test = require('node:test')
const assert = require('node:assert')

const store = require('../src/axyon-store')
const rpg = require('../src/axyon-rpg')
const { createAxyon } = require('../src/axyon-rpg')
const { createCommands } = require('../src/axyon-commands')
const { createAxyonAdmin } = require('../src/axyon-admin')

function freshPlayer (over = {}) {
  return {
    userId: '1', name: 'Hunter', rank: 'E', level: 1, grade: 1, xp: 0, zen: 0, coins: 0,
    hp: 100, maxHp: 100, atk: 6, def: 4, spd: 5, powerEnergy: 50, maxPowerEnergy: 50,
    stage: 1, wins: 0, losses: 0, zenToday: 0, xpToday: 0, dayKey: '', class: 'Fighter',
    classMovesUsed: 0, healUses: 0, cardUses: 0, lastDaily: null, ...over
  }
}

/* ------------------------------------------------------------- manuscript */

test('global purge command and resetall alias are registered', () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  assert.ok(c.BY_NAME.has('purge'))
  assert.ok(c.BY_NAME.has('resetall'))
  assert.equal(c.BY_NAME.get('resetall'), c.BY_NAME.get('purge'))
})

test('default prefix is ! and registration is !arise', () => {
  assert.strictEqual(store.DEFAULT_SETTINGS.prefix, '!')
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  assert.ok(c.BY_NAME.has('arise'))
})

test('combat allowances match the manuscript', () => {
  assert.strictEqual(store.DEFAULT_SETTINGS.selfHealPerCombat, 5)
  assert.strictEqual(store.DEFAULT_SETTINGS.classMovesPerDay, 3)
  assert.strictEqual(store.DEFAULT_SETTINGS.cardAbilitiesPerDay, 3)
})

test('party is minimum 2, default maximum 5', () => {
  assert.strictEqual(store.DEFAULT_SETTINGS.partyMin, 2)
  assert.strictEqual(store.DEFAULT_SETTINGS.partyMax, 5)
})

test('early-game attack sits in the 5-7 band', () => {
  assert.ok(store.BASE_ATK >= 5 && store.BASE_ATK <= 7)
})

test('Power Energy spans 50 to 220', () => {
  assert.strictEqual(store.POWER_ENERGY_BASE, 50)
  assert.strictEqual(store.POWER_ENERGY_CAP, 220)
  assert.strictEqual(rpg.powerEnergyForRank('E'), 50)
  assert.strictEqual(rpg.powerEnergyForRank('Monarch'), 220)
})

test('there are exactly three original stages', () => {
  assert.strictEqual(store.ORIGINAL_STAGES.length, 3)
})

test('rank ladder runs E to Monarch', () => {
  assert.strictEqual(store.rankForLevel(1), 'E')
  assert.strictEqual(store.rankForLevel(10), 'D')
  assert.strictEqual(store.rankForLevel(70), 'SSS')
  assert.strictEqual(store.rankForLevel(80), 'Monarch')
})

/* ------------------------------------------------------------ progression */

test('xp accumulates and levels up', () => {
  const r = rpg.applyProgress(freshPlayer(), { xp: 150, zen: 100 })
  assert.strictEqual(r.player.level, 2)
  assert.strictEqual(r.player.xp, 0)
  assert.strictEqual(r.player.zen, 100)
})

test('grade-up at level 10 grants +15 HP and +4 ATK', () => {
  const p = freshPlayer({ level: 9 })
  const r = rpg.applyProgress(p, { xp: store.xpNeed(9) })
  assert.strictEqual(r.player.level, 10)
  assert.strictEqual(r.player.grade, 2)
  assert.strictEqual(r.player.maxHp, 115)
  assert.strictEqual(r.player.atk, 10)
})

test('grade-up does not repeat while inside the same band', () => {
  const p = freshPlayer({ level: 10, grade: 2, maxHp: 115, atk: 10 })
  const r = rpg.applyProgress(p, { xp: 10 })
  assert.strictEqual(r.player.grade, 2)
  assert.strictEqual(r.player.maxHp, 115)
})

test('grade 3 arrives at level 20', () => {
  const p = freshPlayer({ level: 19, grade: 2, maxHp: 115, atk: 10 })
  const r = rpg.applyProgress(p, { xp: store.xpNeed(19) })
  assert.strictEqual(r.player.level, 20)
  assert.strictEqual(r.player.grade, 3)
  assert.strictEqual(r.player.maxHp, 130)
})

test('rank-up restores Power Energy', () => {
  const p = freshPlayer({ level: 9, powerEnergy: 3 })
  const r = rpg.applyProgress(p, { xp: store.xpNeed(9) })
  assert.strictEqual(r.player.rank, 'D')
  assert.strictEqual(r.player.powerEnergy, r.player.maxPowerEnergy)
  assert.strictEqual(r.player.maxPowerEnergy, 70)
})

/* ----------------------------------------------------------------- combat */

test('damage is always at least 1', () => {
  const e = rpg.buildEnemy({ name: 'Gate', hp: 60, atk: 5, def: 2, xp: 40, zen: 60 })
  assert.ok(rpg.playerHit({ atk: 1 }, e) >= 1)
  assert.ok(rpg.enemyHit(e, { def: 99 }) >= 1)
})

test('guard reduces incoming damage', () => {
  const e = rpg.buildEnemy({ name: 'Gate', hp: 60, atk: 20, def: 2 })
  const plain = rpg.enemyHit(e, { def: 4 })
  const guarded = rpg.enemyHit(e, { def: 4 }, 0.6)
  assert.ok(guarded <= plain)
})

test('enemy is built from a stage row', () => {
  const e = rpg.buildEnemy({ name: 'Outer Gate', hp: 60, atk: 5, def: 2, xp: 40, zen: 60 })
  assert.strictEqual(e.name, 'Outer Gate')
  assert.strictEqual(e.hp, 60)
  assert.strictEqual(e.boss, false)
})

/* ---------------------------------------------------------------- economy */

test('daily counters roll over on a new day', () => {
  const rolled = store.rollDay({ dayKey: '2000-01-01', zenToday: 500, xpToday: 500, classMovesUsed: 3, cardUses: 3 })
  assert.strictEqual(rolled.zenToday, 0)
  assert.strictEqual(rolled.xpToday, 0)
  assert.strictEqual(rolled.classMovesUsed, 0)
  assert.strictEqual(rolled.cardUses, 0)
})

test('daily counters survive within the same day', () => {
  const same = store.rollDay({ dayKey: store.dayKey(), zenToday: 500 })
  assert.strictEqual(same.zenToday, 500)
})

/* ------------------------------------------------------- command registry */

test('every manuscript command is registered', () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const need = ['arise', 'profile', 'help', 'stages', 'fight', 'dungeon', 'party', 'duel', 'cards',
    'claim', 'marry', 'requests', 'accept', 'decline', 'divorce', 'zen', 'daily', 'economy', 'reset',
    'prefix', 'register', 'group', 'unregister', 'groups', 'numbers', 'rhm', 'stage', 'flooradmin',
    'modes', 'visual', 'grantcard', 'top']
  const missing = need.filter(n => !c.BY_NAME.has(n))
  assert.deepStrictEqual(missing, [])
})

test('every visible command appears in help', () => {
  const a = createAxyon({})
  const help = a.helpAll('!')
  const missing = a.COMMANDS.filter(x => !x.hidden)
    .filter(x => !help.includes(x.usage.replace(/\{p\}/g, '!')))
  assert.deepStrictEqual(missing.map(x => x.name), [])
})

test('help exposes every section, including media', () => {
  const a = createAxyon({})
  createCommands({ axyon: a }) // registers the commands help renders from
  assert.deepStrictEqual(Object.keys(a.SECTIONS).sort(),
    ['battle', 'cards', 'core', 'duel', 'dungeon', 'economy', 'management', 'media', 'shop', 'social'])
  assert.ok(a.helpPage('core', '!'))
  assert.ok(a.helpPage('media', '!'))
  assert.ok(a.helpPage('shop', '!'))
  assert.strictEqual(a.helpButtons().length, 10)
})

test('the parser honours the prefix and ignores everything else', () => {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  assert.strictEqual(c.parse({ conversation: '!arise' }, '!').command, 'arise')
  assert.deepStrictEqual(c.parse({ conversation: '!claim card 1' }, '!').args, ['card', '1'])
  assert.strictEqual(c.parse({ conversation: 'hello' }, '!'), null)
  assert.strictEqual(c.parse({ conversation: '.help' }, '.').command, 'help')
  assert.strictEqual(c.parse({ conversation: '!arise@123' }, '!').command, 'arise')
})

/* ------------------------------------------------------------------ admin */

test('admin exposes snapshot and act', () => {
  const admin = createAxyonAdmin({ logger: { warn () {}, error () {} } })
  assert.strictEqual(typeof admin.snapshot, 'function')
  assert.strictEqual(typeof admin.act, 'function')
})

test('admin rejects an unknown action instead of silently accepting it', async () => {
  const admin = createAxyonAdmin({ logger: { warn () {}, error () {} } })
  const r = await admin.act('definitely-not-an-action', {})
  assert.strictEqual(r.ok, false)
})

test('admin validates input before touching the database', async () => {
  const admin = createAxyonAdmin({ logger: { warn () {}, error () {} } })
  assert.strictEqual((await admin.act('settings', { prefix: 'toolong' })).ok, false)
  assert.strictEqual((await admin.act('visual-set', { mode: 'battle', url: 'not-a-url' })).ok, false)
  assert.strictEqual((await admin.act('number-add', { userId: 'abc' })).ok, false)
  assert.strictEqual((await admin.act('mode', { mode: 'nonsense' })).ok, false)
})
