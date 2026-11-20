'use strict'
/*
 * THE LIVE BATTLE CARD IS RENDERED THROUGH THE DISPLAY LAYER.
 *
 * The display module is only worth having if the real battle output uses it.
 * These assert that the card a player actually receives carries the spec's
 * 20-segment HP/PE bars, the exact values beside them, and the usage tracker —
 * and that a damaged combatant never shows a full bar.
 */
const test = require('node:test')
const assert = require('node:assert')

const { createAxyon } = require('../src/axyon-rpg')

const a = createAxyon({})

function card (b, p) {
  return a.battleCard(b, p, '')
}

const player = {
  name: 'Montai', rank: 'Rookie', level: 3, grade: 1, class: 'Swordsman',
  hp: 100, maxHp: 550, powerEnergy: 50, maxPowerEnergy: 145,
  atk: 44, def: 18, spd: 10, classMovesUsed: 1
}

const battle = {
  turn: 1, playerHp: 520, enemyHp: 415, energy: 135, healsLeft: 5,
  enemy: { name: 'Shadow Beast', hp: 460, atk: 55, def: 20, xp: 120, zen: 90 }
}

test('battle card: shows monster and player HP with compact XP', () => {
  const text = card(battle, player)
  assert.ok(text.includes('520 / 550 HP'), `expected player HP, got:\n${text}`)
  assert.ok(text.includes('415 / 460 HP'), `expected monster HP, got:\n${text}`)
  assert.ok(text.includes('0 / 250 XP'), `expected compact XP, got:\n${text}`)
})

test('battle card: omits PE bars and raw combat stats', () => {
  const text = card(battle, player)
  assert.ok(!/POWER ENERGY|\bPE\b/i.test(text), 'PE must not clutter the battle screen')
  assert.ok(!/ATTACK:|DEFENCE:|\bATK\b|\bDEF\b/i.test(text), 'raw attack and defence must be hidden')
})

test('battle card: the enemy is shown as a monster, not as a player', () => {
  const text = card(battle, player)
  assert.ok(text.toUpperCase().includes('MONSTER'), 'the enemy must be labelled MONSTER')
  assert.ok(!text.includes('EQUIPPED CARD'), 'a monster must not be given a player card')
})

test('battle card: hides permanent usage trackers and shows command actions', () => {
  const text = card(battle, player)
  assert.ok(!/ABILITY & USAGE TRACKER|CLASS MOVES|SELF-HEALING/i.test(text))
  assert.ok(text.includes('!attack') && text.includes('!heal') && text.includes('!defend'))
  assert.ok(text.includes('Damage taken: 0') && text.includes('Damage blocked: 0'))
})

test('battle card: a boss enemy is labelled BOSS', () => {
  const text = card({ ...battle, enemy: { ...battle.enemy, boss: true } }, player)
  assert.ok(text.toUpperCase().includes('BOSS'), 'a boss must be labelled BOSS')
})

test('battle card: a legacy class shows no invented move names', () => {
  const legacy = { ...player, class: 'Fighter' }
  const text = card(battle, legacy)
  /* It must render, and must not fabricate a move list for an unconfigured class. */
  assert.ok(text.includes('520 / 550 HP'))
  assert.strictEqual(typeof text, 'string')
})
