'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const store = require('../src/axyon-store')
const items = require('../src/axyon-items')
const combos = require('../src/axyon-combos')

test('MP tank unlocks at level 10 and grows by 15 every five levels', () => {
  assert.equal(store.mpCapacityForLevel(1), 0)
  assert.equal(store.mpCapacityForLevel(9), 0)
  assert.equal(store.mpCapacityForLevel(10), 100)
  assert.equal(store.mpCapacityForLevel(14), 100)
  assert.equal(store.mpCapacityForLevel(15), 115)
  assert.equal(store.mpCapacityForLevel(20), 130)
})

test('Zen has no daily earning cap while the daily XP cap remains 5,000', () => {
  assert.equal(store.DEFAULT_SETTINGS.zenDailyLimit, undefined)
  assert.equal(store.DEFAULT_SETTINGS.xpDailyLimit, 5000)
})

test('MP Refiller costs 500 Zen and restores 50 MP up to the tank maximum', () => {
  const refiller = items.get('mp_refiller')
  assert.equal(refiller.price, 500)
  assert.deepEqual(refiller.effect, { mp: 50 })
  const used = items.apply(refiller, null, { hp: 100, maxHp: 100, mp: 70, maxMp: 100 })
  assert.equal(used.ok, true)
  assert.equal(used.player.mp, 100)
  const capped = items.apply(refiller, null, { hp: 100, maxHp: 100, mp: 100, maxMp: 100 })
  assert.equal(capped.ok, false)
  assert.match(capped.note, /already full/i)
})

test('Soul Drain requires and consumes 50 MP while preserving lifesteal', () => {
  const drain = items.get('ability_drain')
  const battle = { enemyHp: 100, playerHp: 50, mp: 50, guard: 0, enemy: { hp: 100, atk: 1, def: 0 } }
  const used = items.apply(drain, battle, { hp: 50, maxHp: 100, mp: 50, maxMp: 100, vit: 5 })
  assert.equal(used.ok, true)
  assert.equal(used.battle.enemyHp, 60)
  assert.equal(used.battle.playerHp, 90)
  assert.equal(used.battle.mp, 0)
  const denied = items.apply(drain, { ...battle, mp: 49 }, { hp: 50, maxHp: 100, mp: 49, maxMp: 100 })
  assert.equal(denied.ok, false)
})

test('power combos consume MP as well as their configured Energy cost', () => {
  const fusion = combos.get('soul_drain_heavy')
  const ability = items.get(fusion.abilityKey)
  assert.equal(ability.mpCost, 50)
  assert.equal(Math.ceil(ability.mpCost * fusion.powerMultiplier), 50)
  assert.ok(fusion.energyCost > 0)
})
