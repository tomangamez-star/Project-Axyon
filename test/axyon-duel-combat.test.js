'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAxyon } = require('../src/axyon-rpg')
const { createCommands } = require('../src/axyon-commands')
const store = require('../src/axyon-store')

function makePlayer (userId, name, overrides = {}) {
  return {
    userId, name, rank: 'E', level: 10, grade: 1, xp: 0, zen: 0, coins: 0,
    hp: 100, maxHp: 100, atk: 20, def: 10, spd: 20,
    str: 5, per: 20, sta: 10, vit: 5, fatigue: 0,
    powerEnergy: 50, maxPowerEnergy: 50, stage: 1, wins: 0, losses: 0,
    class: 'Fighter', classMovesUsed: 0, battlesSinceRest: 0,
    ...overrides
  }
}

function fakeSock () {
  const sent = []
  return {
    sent,
    async sendMessage (jid, payload) { sent.push({ jid, ...payload }); return { key: { id: `m${sent.length}` } } }
  }
}

test('direct duel: personal combo evasion carries to the opponent turn', async () => {
  const names = ['getBattle', 'activeDuelForUser', 'player', 'equippedCards', 'hasCombo', 'inventoryQty', 'mutateDuel', 'updateFatigue']
  const saved = Object.fromEntries(names.map(name => [name, store[name]]))
  const players = {
    u1: makePlayer('u1', 'Hunter One'),
    u2: makePlayer('u2', 'Hunter Two')
  }
  let duel = {
    id: 'duel-1', status: 'active', challenger: 'u1', opponent: 'u2',
    state: {
      turn: 'u1', round: 1,
      hp: { u1: 100, u2: 100 }, maxHp: { u1: 100, u2: 100 },
      energy: { u1: 50, u2: 50 }, maxEnergy: { u1: 50, u2: 50 },
      fatigue: { u1: 0, u2: 0 }, guards: {}, evading: {}, heals: {}
    }
  }

  store.getBattle = async () => null
  store.activeDuelForUser = async () => ({ ...duel, state: { ...duel.state } })
  store.player = async id => players[id] ? { ...players[id] } : null
  store.equippedCards = async () => []
  store.hasCombo = async () => true
  store.inventoryQty = async () => 0
  store.updateFatigue = async (id, fatigue, updatedAt) => {
    if (players[id]) { players[id].fatigue = fatigue; players[id].fatigueUpdatedAt = updatedAt }
    return { fatigue, fatigue_updated_at: updatedAt }
  }
  store.mutateDuel = async (_id, mutator) => {
    const changed = mutator({ ...duel, state: { ...duel.state } })
    if (changed) duel = { ...duel, ...changed }
    return { ...duel, state: { ...duel.state } }
  }

  const api = createAxyon()
  const commands = createCommands({ axyon: api })
  const sock = fakeSock()
  const originalRandom = Math.random
  Math.random = () => 0
  try {
    const groupCtx = { jid: 'test-group@g.us', userId: 'u1', prefix: '!', settings: { selfHealPerCombat: 5, classMovesPerDay: 3 } }
    await commands.BY_NAME.get('attack').handler(sock, {}, groupCtx, ['+', '!dodge'])
    assert.equal(duel.state.evading.u1, true)
    assert.ok(duel.state.fatigue.u1 > 0)
    assert.ok(duel.state.hp.u2 < 100)

    const opponentCtx = { ...groupCtx, userId: 'u2' }
    await commands.BY_NAME.get('attack').handler(sock, {}, opponentCtx, [])
    assert.equal(duel.state.evading.u1, false)
    assert.equal(duel.state.hp.u1, 100)
    assert.ok(sock.sent.some(row => /PERFECT DODGE/i.test(row.text || '')))
  } finally {
    Math.random = originalRandom
    Object.assign(store, saved)
  }
})
