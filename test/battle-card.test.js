'use strict'
/*
 * The live battle card is intentionally compact. The former detailed report
 * remains available through !battleinfo and is tested separately below.
 */
const test = require('node:test')
const assert = require('node:assert')

const { createAxyon } = require('../src/axyon-rpg')
const T = require('../src/theme')

const a = createAxyon({})

function card (b, p) { return a.battleCard(b, p, '') }
function info (b, p) { return a.battleInfoCard(b, p, '') }

const player = {
  name: 'Montai', rank: 'E', level: 3, grade: 1, class: 'Swordsman',
  hp: 100, maxHp: 550, powerEnergy: 50, maxPowerEnergy: 145,
  xp: 0, atk: 44, def: 18, spd: 10, classMovesUsed: 1
}

const battle = {
  turn: 1, playerHp: 520, enemyHp: 415, energy: 135, healsLeft: 5,
  enemy: { name: 'Shadow Beast', hp: 460, atk: 55, def: 20, xp: 120, zen: 90 }
}

test('battle HUD: uses the profile HP, Energy and XP bar style', () => {
  const text = card(battle, player)
  assert.ok(text.includes('❤️ HP  [▰'))
  assert.ok(text.includes('⚡ Energy  [▰'))
  assert.ok(text.includes('💠 XP  [▱'))
  assert.ok(text.includes('520/550'))
  assert.ok(text.includes('415/460'))
  assert.ok(text.includes('0/250'))
})

test('battle HUD: shows monster, hunter vitals and boss status without filler', () => {
  const text = card(battle, player)
  assert.ok(text.includes('*MONSTER*'))
  assert.ok(text.includes('SHADOW BEAST'))
  assert.ok(text.includes('*VITALS*'))
  assert.ok(text.includes('Level *3*'))
  assert.ok(!text.includes('The arena where this encounter is unfolding'))
  assert.ok(!text.includes('A hostile presence stands in your way'))
  assert.ok(!/ATTACK:|DEFENCE:|\bATK\b|\bDEF\b/i.test(text))
  const boss = card({ ...battle, enemy: { ...battle.enemy, boss: true } }, player)
  assert.ok(boss.includes('*BOSS*'))
})

test('battle HUD: keeps equipped cards and all current action commands visible', () => {
  const equippedBattle = {
    ...battle,
    equippedCards: [{ equipped_slot: 1, name: 'Makima', ability: 'Control Chain', ability_damage: 13 }]
  }
  const text = card(equippedBattle, player)
  assert.ok(text.includes('Makima'))
  assert.ok(text.includes('Control Chain'))
  assert.ok(text.includes('!attack') && text.includes('!heavy') && text.includes('!heal'))
  assert.ok(text.includes('!guard') && text.includes('!defend'))
  assert.ok(text.includes('!ability') && text.includes('!power') && text.includes('!class'))
  assert.ok(text.includes('!battleinfo') && text.includes('!retreat'))
  assert.ok(text.includes('Retreats do not count towards !rest.'))
})

test('detailed battle info: retains location, equipped card detail and activity counters', () => {
  const equippedBattle = {
    ...battle,
    location: 'Sunken Citadel · Dungeon Hall',
    equippedCards: [{
      equipped_slot: 1, name: 'Makima', ability: 'Control Chain', ability_damage: 13,
      damage: 7, expires_at: null
    }],
    damageTaken: 24,
    damageBlocked: 8
  }
  const text = info(equippedBattle, player)
  assert.ok(text.includes('Sunken Citadel · Dungeon Hall'))
  assert.ok(text.includes('Makima'))
  assert.ok(text.includes('Control Chain'))
  assert.ok(text.includes('Damage taken: *24*'))
  assert.ok(text.includes('Damage blocked: *8*'))
  assert.ok(text.includes(T.font('BATTLE ACTIVITY')))
  assert.ok(text.includes(T.font('EQUIPPED CARDS')))
})

test('detailed battle info: hides zero activity counters and includes command details', () => {
  const text = info(battle, player)
  assert.ok(text.includes(T.font('MONSTER')))
  assert.ok(text.includes('!attack') && text.includes('!heal') && text.includes('!defend'))
  assert.ok(!text.includes('Damage taken: 0') && !text.includes('Damage blocked: 0'))
  const partial = info({ ...battle, damageTaken: 12, damageBlocked: 0 }, player)
  assert.ok(partial.includes('Damage taken: *12*'))
  assert.ok(!partial.includes('Damage blocked:'))
})

test('detailed battle info: legacy classes render without invented move names', () => {
  const legacy = { ...player, class: 'Fighter' }
  const text = info(battle, legacy)
  assert.ok(text.includes('520 / 550 HP'))
  assert.strictEqual(typeof text, 'string')
})
