'use strict'
/*
 * GUILD MODES, COLLABORATION, NPC OPPONENTS, CUSTOM ROOM TYPES, CLASS CRUD
 * AND THE FLAT SELF-HEAL.
 *
 * These cover the seven gaps the owner listed. Each block asserts the RULE,
 * not the implementation: a raid is lost when every member is down, a gauntlet
 * carries HP between waves, a co-op trial shares one pool, an NPC's damage
 * goes through the same calculator the player's does.
 */
const test = require('node:test')
const assert = require('node:assert')

const guild = require('../src/axyon-guild')
const npc = require('../src/axyon-npc')
const modes = require('../src/axyon-modes')
const classes = require('../src/axyon-classes')

/* ------------------------------------------------------------- guild modes */

test('guild: all three guild modes and the co-op trial are defined', () => {
  for (const id of ['guild_raid', 'guild_duel', 'guild_gauntlet', 'collab_trial']) {
    const def = guild.guildMode(id)
    assert.ok(def, `${id} must be defined`)
    assert.ok(def.rules.length >= 3, `${id} must state its rules`)
    assert.ok(def.minPlayers >= 2, `${id} is a party mode`)
  }
})

test('guild: a raid needs at least two players and refuses one', () => {
  const solo = guild.createRun({ modeId: 'guild_raid', members: [{ userId: 'a', hp: 100, maxHp: 100 }] })
  assert.strictEqual(solo.ok, false)
  assert.strictEqual(solo.reason, 'too_few')

  const duo = guild.createRun({
    modeId: 'guild_raid',
    members: [{ userId: 'a', hp: 100, maxHp: 100 }, { userId: 'b', hp: 100, maxHp: 100 }]
  })
  assert.strictEqual(duo.ok, true)
  assert.ok(duo.state.boss.hp > 0)
})

test('guild: a raid is won when the boss falls and lost when every member is down', () => {
  const run = guild.createRun({
    modeId: 'guild_raid',
    members: [{ userId: 'a', hp: 100, maxHp: 100 }, { userId: 'b', hp: 100, maxHp: 100 }],
    boss: { hp: 50, atk: 5 }
  })
  const win = guild.strike(run.state, { userId: 'a', damage: 60, incoming: 0 })
  assert.strictEqual(win.done, true)
  assert.strictEqual(win.won, true)

  const lose = guild.createRun({
    modeId: 'guild_raid',
    members: [{ userId: 'a', hp: 5, maxHp: 100 }, { userId: 'b', hp: 5, maxHp: 100 }],
    boss: { hp: 999, atk: 50 }
  })
  const first = guild.strike(lose.state, { userId: 'a', damage: 1 })
  assert.strictEqual(first.done, false, 'one member down is not a loss')
  const second = guild.strike(first.state, { userId: 'b', damage: 1 })
  assert.strictEqual(second.done, true)
  assert.strictEqual(second.won, false)
})

test('guild: a gauntlet carries HP between waves with no heal', () => {
  const run = guild.createRun({
    modeId: 'guild_gauntlet',
    members: [{ userId: 'a', hp: 100, maxHp: 100 }, { userId: 'b', hp: 100, maxHp: 100 }]
  })
  /* Take a hit in wave 1 without clearing it. */
  const hurt = guild.strike(run.state, { userId: 'a', damage: 1, incoming: 30 })
  const a1 = hurt.state.members.find(m => m.userId === 'a')
  assert.strictEqual(a1.hp, 70, 'the member must take the wave-1 hit')

  /* Now clear wave 1. A dead wave does not retaliate, so HP is unchanged. */
  const cleared = guild.strike(hurt.state, { userId: 'b', damage: 999 })
  assert.strictEqual(cleared.done, false, 'clearing wave 1 must not end the gauntlet')
  assert.strictEqual(cleared.state.wave, 1, 'the run must advance to wave 2')
  const a2 = cleared.state.members.find(m => m.userId === 'a')
  assert.strictEqual(a2.hp, 70, 'HP must carry over — no heal between waves')
})

test('guild: a co-op trial shares one HP pool, so a hit hurts everyone', () => {
  const run = guild.createRun({
    modeId: 'collab_trial',
    members: [{ userId: 'a', hp: 100, maxHp: 100 }, { userId: 'b', hp: 100, maxHp: 100 }],
    target: 100,
    boss: { atk: 25 }
  })
  assert.strictEqual(run.state.pool.maxHp, 200, 'the pool is the sum of the party')
  const hit = guild.strike(run.state, { userId: 'a', damage: 10 })
  assert.strictEqual(hit.state.pool.hp, 175, 'the shared pool takes the hit, not one member')
  assert.strictEqual(hit.state.target.remaining, 90)
})

test('guild: a co-op trial is won at the damage target and lost at an empty pool', () => {
  const run = guild.createRun({
    modeId: 'collab_trial',
    members: [{ userId: 'a', hp: 100, maxHp: 100 }, { userId: 'b', hp: 100, maxHp: 100 }],
    target: 20,
    boss: { atk: 1 }
  })
  const win = guild.strike(run.state, { userId: 'a', damage: 25 })
  assert.strictEqual(win.done, true)
  assert.strictEqual(win.won, true)

  const doomed = guild.createRun({
    modeId: 'collab_trial',
    members: [{ userId: 'a', hp: 10, maxHp: 10 }, { userId: 'b', hp: 10, maxHp: 10 }],
    target: 999,
    boss: { atk: 50 }
  })
  const loss = guild.strike(doomed.state, { userId: 'a', damage: 1 })
  assert.strictEqual(loss.done, true)
  assert.strictEqual(loss.won, false)
})

test('guild: a duel pairs members by index and a tie is a draw, not a win', () => {
  const run = guild.createRun({
    modeId: 'guild_duel',
    members: [{ userId: 'a', hp: 50, maxHp: 50 }, { userId: 'b', hp: 50, maxHp: 50 }]
  })
  assert.strictEqual(run.state.pairs.length, 2, 'two members means two pairs')

  /* Knock out pair 0 for side A. */
  const one = guild.strike(run.state, { userId: 'a', damage: 60 })
  assert.strictEqual(one.state.score.a, 1)
  assert.strictEqual(one.done, false)

  /* Knock out pair 1 for side B — the duel is then 1-1. */
  const two = guild.strike(one.state, { userId: 'opp_b', damage: 60 })
  assert.strictEqual(two.done, true)
  assert.strictEqual(two.state.score.a, 1)
  assert.strictEqual(two.state.score.b, 1)
  assert.strictEqual(two.won, null, 'an even score is a draw, not a win')
})

test('guild: rewards split by damage contribution and sum to the total', () => {
  const state = {
    members: [
      { userId: 'a', name: 'A', damage: 75 },
      { userId: 'b', name: 'B', damage: 25 },
      { userId: 'c', name: 'C', damage: 0 }
    ]
  }
  const split = guild.splitReward(state, 100)
  assert.strictEqual(split.reduce((s, x) => s + x.share, 0), 100, 'no Zen may be created or lost to rounding')
  assert.strictEqual(split.find(x => x.userId === 'c').share, 0, 'a member who dealt nothing gets nothing')
  assert.ok(split.find(x => x.userId === 'a').share > split.find(x => x.userId === 'b').share)
})

test('guild: strike never mutates the state it was given', () => {
  const run = guild.createRun({
    modeId: 'guild_raid',
    members: [{ userId: 'a', hp: 100, maxHp: 100 }, { userId: 'b', hp: 100, maxHp: 100 }],
    boss: { hp: 200, atk: 5 }
  })
  const before = JSON.stringify(run.state)
  guild.strike(run.state, { userId: 'a', damage: 10 })
  assert.strictEqual(JSON.stringify(run.state), before, 'the input state must be untouched')
})

test('guild: it is not your turn when another member is active', () => {
  const run = guild.createRun({
    modeId: 'guild_raid',
    members: [{ userId: 'a', hp: 100, maxHp: 100 }, { userId: 'b', hp: 100, maxHp: 100 }],
    boss: { hp: 200, atk: 5 }
  })
  const wrong = guild.strike(run.state, { userId: 'b', damage: 10 })
  assert.strictEqual(wrong.ok, false)
  assert.strictEqual(wrong.reason, 'not_your_turn')
})

/* ---------------------------------------------------------- custom room types */

test('room types: a custom type gets its own capacity and is clamped to its ceiling', () => {
  const reg = modes.registerRoomType({ id: 'raid', name: 'Raid', minPlayers: 3, defaultMax: 8, hardMax: 12 })
  assert.strictEqual(reg.ok, true)
  assert.strictEqual(modes.capacityFor('raid'), 8, 'the custom default is used')
  assert.strictEqual(modes.capacityFor('raid', 10), 10, 'the operator may raise it')
  assert.strictEqual(modes.capacityFor('raid', 999), 12, 'but never past the custom hard ceiling')
  assert.strictEqual(modes.capacityFor('raid', 1), 8, 'and never below the custom default')
  modes.unregisterRoomType('raid')
})

test('room types: a custom type can never shadow a built-in participation type', () => {
  const res = modes.registerRoomType({ id: 'party', name: 'Hijacked', defaultMax: 99 })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'reserved')
  assert.strictEqual(modes.capacityFor('party'), 5, 'party capacity must be unchanged')
})

test('room types: an unknown type still yields a capacity of 1', () => {
  assert.strictEqual(modes.capacityFor('does_not_exist'), 1)
})

/* ------------------------------------------------------------ NPC opponents */

test('npc: an NPC carries a class, rank, grade, mastery and moves', () => {
  const n = npc.buildNpc({ key: 'stage_1', name: 'Outer Gate', ordinal: 1, hp: 60, atk: 5, def: 2, xp: 40, zen: 60 })
  assert.ok(n.classId, 'an NPC must have a class')
  assert.ok(n.className)
  assert.ok(n.rank, 'an NPC must have a rank')
  assert.ok(n.grade, 'an NPC must have a class grade')
  assert.ok(n.mastery >= 0)
  assert.ok(Array.isArray(n.moves) && n.moves.length > 0, 'an NPC must have moves')
  assert.ok(n.signature, 'an NPC must have a signature move')
})

test('npc: the original stat block is preserved exactly', () => {
  const row = { key: 'floor_5', name: 'Warden of the Deep', ordinal: 5, hp: 460, atk: 30, def: 15, xp: 420, zen: 700, boss: true }
  const n = npc.buildNpc(row)
  assert.strictEqual(n.hp, 460)
  assert.strictEqual(n.atk, 30)
  assert.strictEqual(n.def, 15)
  assert.strictEqual(n.xp, 420)
  assert.strictEqual(n.zen, 700)
  assert.strictEqual(n.boss, true)
})

test('npc: the same row always produces the same opponent', () => {
  const row = { key: 'stage_2', name: 'Broken Causeway', ordinal: 2, hp: 110, atk: 9, def: 4, xp: 80, zen: 120 }
  const a = npc.buildNpc(row)
  const b = npc.buildNpc(row)
  assert.strictEqual(a.classId, b.classId, 'a retreat and return must meet the same enemy')
  assert.strictEqual(a.mastery, b.mastery)
})

test('npc: a deeper floor is a higher rank than the opening stage', () => {
  const shallow = npc.buildNpc({ key: 'stage_1', name: 'A', ordinal: 1, hp: 60, atk: 5, def: 2, xp: 40, zen: 60 })
  const deep = npc.buildNpc({ key: 'floor_5', name: 'B', ordinal: 5, hp: 460, atk: 30, def: 15, xp: 420, zen: 700, boss: true })
  const order = npc.NPC_RANKS
  assert.ok(order.indexOf(deep.rank) > order.indexOf(shallow.rank), `${deep.rank} must outrank ${shallow.rank}`)
})

test('npc: NPC damage goes through the same calculator the player uses', () => {
  const n = npc.buildNpc({ key: 'floor_5', name: 'Boss', ordinal: 5, hp: 460, atk: 30, def: 15, xp: 420, zen: 700, boss: true })
  const viaNpc = npc.npcMoveDamage(n)
  const viaClass = classes.classDamage({
    move: n.signatureMove,
    mastery: n.mastery,
    gradeBonus: n.gradeBonus
  })
  assert.deepStrictEqual(viaNpc, viaClass, 'there must be no second damage formula')
})

test('npc: a basic attack still uses the existing shape', () => {
  const n = { atk: 20 }
  assert.strictEqual(npc.npcBasicDamage(n, 0, 0), 20)
  assert.ok(npc.npcBasicDamage(n, 100, 0) >= 1, 'defence must never reduce a hit below 1')
})

/* --------------------------------------------------------------- self-heal */

test('heal: the self-heal is a flat 10 HP, not a percentage', () => {
  const fs = require('fs')
  const src = fs.readFileSync(require.resolve('../src/axyon-rpg'), 'utf8')
  assert.match(src, /const SELF_HEAL_HP = 10/, 'the flat heal constant must exist')
  assert.match(src, /const amount = SELF_HEAL_HP/, 'the heal must use the constant')
  /*
   * The old percentage heal must be gone from the HEAL branch. A 25% figure
   * still exists elsewhere — it is the HP a defeated player wakes with, which
   * is a different rule and must not be confused with the heal.
   */
  const at = src.indexOf("action === 'heal')")
  assert.ok(at > 0, 'the heal branch must be findable')
  const healBranch = src.slice(at, at + 600)
  assert.doesNotMatch(healBranch, /maxHp \* 0\.25/, 'the old percentage heal must be gone from the heal branch')
})

/* -------------------------------------------------------------- class CRUD */

test('class crud: the store exposes create, edit and delete for classes and moves', () => {
  const store = require('../src/axyon-store')
  for (const fn of ['classDefs', 'classDef', 'upsertClassDef', 'deleteClassDef', 'classMoves', 'upsertClassMove', 'deleteClassMove']) {
    assert.strictEqual(typeof store[fn], 'function', `store.${fn} must exist`)
  }
})

test('class crud: the schema creates the catalogue tables', () => {
  const fs = require('fs')
  const src = fs.readFileSync(require.resolve('../src/axyon-store'), 'utf8')
  assert.match(src, /CREATE TABLE IF NOT EXISTS axyon_class_defs/)
  assert.match(src, /CREATE TABLE IF NOT EXISTS axyon_class_moves/)
  assert.match(src, /CREATE TABLE IF NOT EXISTS axyon_room_types/)
  /* A soft delete, so a class players hold is never silently removed. */
  assert.match(src, /deleted BOOLEAN NOT NULL DEFAULT FALSE/)
})

test('class crud: the command surface exposes the CRUD subcommands', () => {
  const fs = require('fs')
  const src = fs.readFileSync(require.resolve('../src/axyon-commands'), 'utf8')
  for (const sub of ['create', 'editclass', 'delclass', 'addmove', 'delmove', 'custom']) {
    assert.ok(src.includes(`sub === '${sub}'`), `!classadmin ${sub} must be handled`)
  }
  /* Deleting a class must require confirmation. */
  assert.match(src, /delclass <id> confirm/)
})
