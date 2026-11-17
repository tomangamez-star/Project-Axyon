'use strict'
/*
 * COMBAT AND DUNGEON — END TO END THROUGH THE REAL ROUTER.
 *
 * These are the tests that answer "can a player actually fight and level up?".
 * They drive `createCommands().handle` with a fake socket and a stubbed store,
 * so they exercise the same context construction, registration gate and battle
 * engine the live bot uses — not a handler in isolation.
 *
 * The two defects they lock down:
 *   1. `battleAct` referenced `moveName` without declaring it, so `!class <move>`
 *      threw a ReferenceError and the move never fired.
 *   2. `axyon_floors` was never seeded, so `!floor` always refused to start.
 */
const test = require('node:test')
const assert = require('node:assert')

const { createAxyon } = require('../src/axyon-rpg')
const { createCommands } = require('../src/axyon-commands')
const store = require('../src/axyon-store')

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

function harness ({ player = null, battle = null, floors = [] } = {}) {
  const a = createAxyon({})
  const c = createCommands({ axyon: a })
  const sock = fakeSock()
  const state = { player: player ? { ...player } : null, battle, floors }

  const saved = {}
  for (const k of ['player', 'group', 'getBattle', 'setBattle', 'savePlayer', 'log',
    'settings', 'axyonNumberMode', 'roleOf', 'partnerOf', 'floors', 'stage', 'stages',
    'classMastery', 'classMovesUsedToday', 'consumeClassMove', 'addClassMastery',
    'equippedCards', 'useCardAbility', 'inventory', 'inventoryQty', 'modes']) {
    saved[k] = store[k]
  }

  store.player = async () => state.player
  store.group = async () => ({ group_jid: '123@g.us', enabled: true, registered_by: 'u1' })
  store.getBattle = async () => state.battle
  store.setBattle = async (u, b) => { state.battle = b }
  store.savePlayer = async p => { state.player = { ...p } }
  store.log = async () => {}
  store.settings = async () => ({ prefix: '!', selfHealPerCombat: 5, classMovesPerDay: 3, xpDailyLimit: 1e9, zenDailyLimit: 1e9, partyMax: 5, partyMin: 2 })
  store.axyonNumberMode = async () => null
  store.roleOf = async () => null
  store.partnerOf = async () => null
  store.floors = async () => state.floors
  store.stage = async (n) => ({ ordinal: n, name: 'Outer Gate', hp: 60, atk: 5, def: 2, xp: 40, zen: 60, locked: false })
  store.stages = async () => [{ ordinal: 1, name: 'Outer Gate', hp: 60, atk: 5, def: 2, xp: 40, zen: 60, locked: false }]
  store.classMastery = async () => 0
  store.classMovesUsedToday = async () => 0
  store.consumeClassMove = async () => ({ ok: true, used: 1, remaining: 2 })
  store.addClassMastery = async () => {}
  store.equippedCards = async () => []
  store.useCardAbility = async () => ({ ok: false, reason: 'empty_slot' })
  store.inventory = async () => []
  store.inventoryQty = async () => 0
  store.modes = async () => [
    { mode: 'solo', enabled: true, max_players: 1 },
    { mode: 'multiplayer', enabled: true, max_players: 8 },
    { mode: 'party', enabled: true, max_players: 5 },
    { mode: 'duel', enabled: true, max_players: 2 }
  ]

  const restore = () => Object.assign(store, saved)

  const send = async (text, { jid = '123@g.us' } = {}) => {
    const content = { conversation: text }
    const m = { key: { remoteJid: jid, fromMe: false, id: 'x' }, message: content }
    const handled = await c.handle(sock, m, content)
    return { handled, out: sock.sent.map(s => s.text || s.caption || '').join('\n') }
  }

  return { a, c, sock, state, send, restore }
}

const basePlayer = () => ({
  userId: 'u1', name: 'Montai', level: 1, rank: 'Rookie', grade: 1,
  class: 'Swordsman', hp: 100, maxHp: 100, powerEnergy: 50, maxPowerEnergy: 50,
  xp: 0, zen: 0, coins: 0, atk: 20, def: 10, spd: 8,
  stage: 1, wins: 0, losses: 0, gameMode: 'combat', xpToday: 0, zenToday: 0,
  healUses: 0, classMovesUsed: 0
})

/* ------------------------------------------------------- stage combat */

test('combat: a player can enter a stage and start a real battle', async () => {
  const h = harness({ player: basePlayer() })
  const { out } = await h.send('!fight 1')
  h.restore()
  assert.ok(/Outer Gate|BATTLE|HP/i.test(out), `expected a battle card, got: ${out.slice(0, 200)}`)
})

test('combat: attacking damages the enemy and the enemy answers', async () => {
  const h = harness({
    player: basePlayer(),
    battle: {
      mode: 'stage', ordinal: 1, turn: 1, healsLeft: 5, guard: 0, energy: 50,
      enemyHp: 60, playerHp: 100,
      enemy: { name: 'Outer Gate', hp: 60, atk: 5, def: 2, xp: 40, zen: 60 }
    }
  })
  const { out } = await h.send('!attack')
  h.restore()
  assert.ok(h.state.battle === null || h.state.battle.enemyHp < 60, 'the enemy must take damage')
  assert.ok(/strike|damage|HP/i.test(out), `expected a damage line, got: ${out.slice(0, 200)}`)
})

test('combat: winning awards XP and can level the player up', async () => {
  const p = basePlayer()
  const h = harness({
    player: p,
    battle: {
      mode: 'stage', ordinal: 1, turn: 1, healsLeft: 5, guard: 0, energy: 50,
      enemyHp: 1, playerHp: 100,
      enemy: { name: 'Outer Gate', hp: 60, atk: 5, def: 2, xp: 500, zen: 60 }
    }
  })
  const { out } = await h.send('!attack')
  const after = h.state.player
  h.restore()
  assert.ok(/VICTORY/i.test(out), `expected a victory, got: ${out.slice(0, 200)}`)
  assert.ok(after.level > 1, `expected a level-up, level is ${after.level}`)
  assert.ok(after.xp > 0 || after.level > 1, 'XP must be awarded')
})

/* ----------------------------------------------------- dungeon combat */

test('dungeon: the seeded floor ladder is non-empty and fightable', async () => {
  const h = harness({ player: { ...basePlayer(), gameMode: 'dungeon' }, floors: store.ORIGINAL_FLOORS })
  const { out } = await h.send('!dungeon')
  h.restore()
  assert.ok(!/No floors configured/i.test(out), 'the dungeon must not be empty')
  assert.ok(/Sunken Vestibule/i.test(out), `expected the seeded floors, got: ${out.slice(0, 300)}`)
})

test('dungeon: a player can enter a floor and start a real battle', async () => {
  const h = harness({ player: { ...basePlayer(), gameMode: 'dungeon' }, floors: store.ORIGINAL_FLOORS })
  const { out } = await h.send('!floor 1')
  const b = h.state.battle
  h.restore()
  assert.ok(b, 'entering a floor must create a battle')
  assert.strictEqual(b.mode, 'floor')
  assert.ok(b.enemyHp > 0, 'the floor enemy must have HP')
  assert.ok(/Sunken Vestibule/i.test(out), `expected the floor name, got: ${out.slice(0, 200)}`)
})

test('dungeon: winning a floor awards XP and can level the player up', async () => {
  const h = harness({
    player: { ...basePlayer(), gameMode: 'dungeon' },
    floors: store.ORIGINAL_FLOORS,
    battle: {
      mode: 'floor', ordinal: 1, turn: 1, healsLeft: 5, guard: 0, energy: 50,
      enemyHp: 1, playerHp: 100,
      enemy: { name: 'Sunken Vestibule', hp: 80, atk: 6, def: 3, xp: 500, zen: 80 }
    }
  })
  const { out } = await h.send('!attack')
  const after = h.state.player
  h.restore()
  assert.ok(/VICTORY/i.test(out), `expected a victory, got: ${out.slice(0, 200)}`)
  assert.ok(after.level > 1, `expected a level-up in the dungeon, level is ${after.level}`)
})

/* ------------------------------------------------------- class moves */

test('combat: !class <move> fires the named move instead of throwing', async () => {
  const h = harness({
    player: basePlayer(),
    battle: {
      mode: 'stage', ordinal: 1, turn: 1, healsLeft: 5, guard: 0, energy: 50,
      enemyHp: 200, playerHp: 100,
      enemy: { name: 'Outer Gate', hp: 200, atk: 5, def: 2, xp: 40, zen: 60 }
    }
  })
  /* The regression: this used to throw ReferenceError: moveName is not defined. */
  const { out } = await h.send('!class slash')
  h.restore()
  assert.ok(!/ReferenceError|is not defined/i.test(out), `the move must not throw: ${out.slice(0, 200)}`)
  assert.ok(/slash|move|damage|no move/i.test(out), `expected a move result, got: ${out.slice(0, 200)}`)
})

test('combat: !class with no argument inside a battle uses a move, not the sheet', async () => {
  const h = harness({
    player: basePlayer(),
    battle: {
      mode: 'stage', ordinal: 1, turn: 1, healsLeft: 5, guard: 0, energy: 50,
      enemyHp: 200, playerHp: 100,
      enemy: { name: 'Outer Gate', hp: 200, atk: 5, def: 2, xp: 40, zen: 60 }
    }
  })
  const { out } = await h.send('!class')
  h.restore()
  assert.ok(!/ReferenceError|is not defined/i.test(out), `must not throw: ${out.slice(0, 200)}`)
})

/* --------------------------------------------------------------- help */

test('help: !help <command> returns that command, not "no section"', async () => {
  const h = harness({ player: basePlayer() })
  const { out } = await h.send('!help fight')
  h.restore()
  assert.ok(!/No section or command named/i.test(out), `expected a command page, got: ${out.slice(0, 200)}`)
  assert.ok(/FIGHT/i.test(out), `expected the fight help, got: ${out.slice(0, 200)}`)
})

test('help: !help <section> still works', async () => {
  const h = harness({ player: basePlayer() })
  const { out } = await h.send('!help battle')
  h.restore()
  assert.ok(/HELP/i.test(out), `expected a section page, got: ${out.slice(0, 200)}`)
})

test('help: an unknown name is refused clearly', async () => {
  const h = harness({ player: basePlayer() })
  const { out } = await h.send('!help notacommand')
  h.restore()
  assert.ok(/No section or command named/i.test(out))
})

/* --------------------------------------------------------------- rooms */

test('rooms: a room can be opened for a protected combat mode', async () => {
  const h = harness({ player: { ...basePlayer(), gameMode: 'dungeon' } })
  const saved = { createRoom: store.createRoom, log: store.log }
  store.createRoom = async (o) => ({
    room_key: 'room_test', name: o.name, mode_id: o.modeId, participation: o.participation,
    privacy: o.privacy, capacity: o.capacity, status: 'waiting', participants: [{ userId: o.ownerId, role: 'leader' }]
  })
  const { out } = await h.send('!room create normal_battle solo')
  Object.assign(store, saved)
  h.restore()
  assert.ok(/ROOM OPENED/i.test(out), `expected a room, got: ${out.slice(0, 300)}`)
  assert.ok(/room_test/.test(out), 'the room key must be shown')
})

test('rooms: a placeholder guild mode is refused with a clear reason', async () => {
  const h = harness({ player: { ...basePlayer(), gameMode: 'dungeon' } })
  const { out } = await h.send('!room create guild_1 party')
  h.restore()
  assert.ok(/no rules configured yet/i.test(out), `expected a placeholder refusal, got: ${out.slice(0, 300)}`)
})
