'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const combos = require('../src/axyon-combos')

test('Soul Drain + Heavy recipe is order-sensitive', () => {
  assert.equal(combos.parseRecipe(['ability_drain', '+', '!heavy'])?.key, 'soul_drain_heavy')
  assert.equal(combos.parseRecipe(['heavy', '+', 'power', 'ability_drain']), null)
})

test('combo discovery uses the configured one-in-five chance', () => {
  assert.equal(combos.rollDiscovery(() => 0.19, 0.2), true)
  assert.equal(combos.rollDiscovery(() => 0.2, 0.2), false)
})

test('Soul Drain fusion has the expected unlock gate and energy cost', () => {
  const combo = combos.get('soul_drain_heavy')
  assert.equal(combo.requiredLevel, 10)
  assert.equal(combo.energyCost, 35)
  assert.equal(combo.abilityKey, 'ability_drain')
})
