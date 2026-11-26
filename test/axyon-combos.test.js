'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const combos = require('../src/axyon-combos')


test('combo recipes are ordered and prefix-safe', () => {
  assert.equal(combos.parseRecipe(['ability_drain', '+', '!heavy'])?.key, 'soul_drain_heavy')
  assert.equal(combos.parseRecipe(['power', 'ability_drain', '+', '!heavy'])?.key, 'soul_drain_heavy')
  assert.equal(combos.parseRecipe(['heavy', '+', 'power', 'ability_drain']), null)
  assert.equal(combos.parseRecipe(['attack', '+', '!dodge'])?.key, 'attack_dodge')
  assert.equal(combos.parseRecipe(['heavy', '+', '!block'])?.key, 'heavy_block')
  assert.equal(combos.parseRecipe(['power', 'ability_drain', '+', '!attack'])?.key, 'soul_drain_attack')
  assert.equal(combos.parseRecipe(['power', 'ability_bulwark', '+', '!block'])?.key, 'iron_bulwark_block')
})

test('the catalogue contains different offensive, evasive and defensive styles', () => {
  const keys = combos.CATALOGUE.map(combo => combo.key)
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(keys.length >= 10)
  assert.ok(combos.get('attack_dodge'))
  assert.ok(combos.get('heavy_block'))
  assert.ok(combos.get('soul_drain_attack'))
  assert.ok(combos.get('iron_bulwark_block'))
})

test('combo recipes can be shown in the active command prefix', () => {
  assert.equal(combos.formatRecipe('attack_dodge', '/'), '/attack + /dodge')
  assert.equal(combos.formatRecipe('soul_drain_heavy', '!'), '!power ability_drain + !heavy')
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
  assert.equal(combo.powerMultiplier, 1)
  assert.equal(combo.attackMultiplier, 1.65)
})

test('group command handlers route ordered combos into the shared battle engine', async () => {
  const rpg = require('../src/axyon-rpg')
  const { createCommands } = require('../src/axyon-commands')
  const axyon = rpg.createAxyon()
  const calls = []
  axyon.battleAct = async (...args) => { calls.push(args); return true }
  const commands = createCommands({ axyon })
  const ctx = { jid: 'test-group@g.us', userId: 'player-1', prefix: '!', settings: { prefix: '!' } }

  await commands.BY_NAME.get('attack').handler({}, {}, ctx, ['+', '!dodge'])
  await commands.BY_NAME.get('power').handler({}, {}, ctx, ['ability_drain', '+', '!heavy'])
  await commands.BY_NAME.get('block').handler({}, {}, ctx, ['+', '!attack'])

  assert.equal(calls[0][3], 'combo')
  assert.equal(calls[0][5], 'attack_dodge')
  assert.equal(calls[1][3], 'combo')
  assert.equal(calls[1][5], 'soul_drain_heavy')
  assert.equal(calls[2][3], 'combo')
  assert.equal(calls[2][5], 'block_attack')
})

test('combo catalogue output uses actual line breaks, not escaped backslash-n text', async () => {
  const rpg = require('../src/axyon-rpg')
  const { createCommands } = require('../src/axyon-commands')
  const store = require('../src/axyon-store')
  const originalCombos = store.combos
  const axyon = rpg.createAxyon()
  let sent = ''
  store.combos = async () => []
  axyon.send = async (_sock, _jid, _message, text) => { sent = text; return true }
  try {
    const commands = createCommands({ axyon })
    await commands.BY_NAME.get('cc').handler({}, {}, { jid: 'test-group@g.us', userId: 'player-1', prefix: '!', settings: { prefix: '!' } }, ['shop'])
    assert.ok(sent.includes('\n'))
    assert.ok(!sent.includes('\\n'))
    assert.ok(sent.includes('Soul Drain: Heavy Fusion'))
    assert.ok(sent.includes('Slipstream Strike'))
  } finally {
    store.combos = originalCombos
  }
})
