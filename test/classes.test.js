'use strict'
/*
 * CLASS & MASTERY tests — the acceptance criteria from the implementation note.
 *
 * These are PURE tests: no database, no socket, no clock. The mastery table,
 * the grade lookup, the damage curve and the move validator are all pure
 * functions, which is exactly why they were written that way — the rules most
 * likely to be rebalanced must be testable without a Postgres instance.
 *
 * The daily-limit and concurrency tests exercise the SQL shape rather than a
 * live database, because the guarantee comes from the single-statement UPSERT.
 * That is asserted structurally and called out where it is.
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const classes = require('../src/axyon-classes')

/* ------------------------------------------------------------- mastery table */

test('class grade: every threshold from the note maps to its exact grade and bonus', () => {
  const table = [
    [0, 'C-', 0],
    [500, 'C', 1],
    [1500, 'C+', 2],
    [3500, 'B-', 4],
    [7500, 'B', 6],
    [15000, 'B+', 9],
    [30000, 'A', 13],
    [60000, 'S', 18],
    [120000, 'SS', 25]
  ]
  for (const [mastery, grade, bonus] of table) {
    const g = classes.classGradeFor(mastery)
    assert.strictEqual(g.grade, grade, `mastery ${mastery} should be ${grade}`)
    assert.strictEqual(g.bonus, bonus, `mastery ${mastery} bonus should be +${bonus}`)
  }
})

test('class grade: values between thresholds keep the lower reached grade', () => {
  assert.strictEqual(classes.classGradeFor(499).grade, 'C-')
  assert.strictEqual(classes.classGradeFor(1499).grade, 'C')
  assert.strictEqual(classes.classGradeFor(3499).grade, 'C+')
  assert.strictEqual(classes.classGradeFor(7499).grade, 'B-')
  assert.strictEqual(classes.classGradeFor(119999).grade, 'S')
  assert.strictEqual(classes.classGradeFor(999999).grade, 'SS')
})

test('class grade: negative or junk mastery is treated as 0, not an error', () => {
  assert.strictEqual(classes.classGradeFor(-500).grade, 'C-')
  assert.strictEqual(classes.classGradeFor(null).grade, 'C-')
  assert.strictEqual(classes.classGradeFor('nonsense').grade, 'C-')
})

test('class grade: reports the next threshold and the remaining gap', () => {
  const g = classes.classGradeFor(12000)
  assert.strictEqual(g.grade, 'B')
  assert.strictEqual(g.next.grade, 'B+')
  assert.strictEqual(g.next.remaining, 3000)
  assert.strictEqual(classes.classGradeFor(120000).next, null)
})

test('class grade: the thresholds are not compressed or rebalanced', () => {
  assert.deepStrictEqual(
    classes.CLASS_GRADES.map(g => g.mastery),
    [0, 500, 1500, 3500, 7500, 15000, 30000, 60000, 120000]
  )
  assert.deepStrictEqual(
    classes.CLASS_GRADES.map(g => g.bonus),
    [0, 1, 2, 4, 6, 9, 13, 18, 25]
  )
})

/* -------------------------------------------------------------- class roster */

test('roster: exactly 20 official classes', () => {
  assert.strictEqual(classes.OFFICIAL_CLASSES.length, 20)
})

test('roster: every official class has 7 moves except Elementalist, which has 8', () => {
  for (const c of classes.OFFICIAL_CLASSES) {
    const want = c.id === 'elementalist' ? 8 : 7
    assert.strictEqual(c.moves.length, want, `${c.name} should have ${want} moves`)
  }
})

test('roster: every class has exactly one ultimate', () => {
  for (const c of classes.OFFICIAL_CLASSES) {
    const ults = c.moves.filter(mv => mv.ultimate)
    assert.strictEqual(ults.length, 1, `${c.name} should have exactly one ultimate`)
  }
})

test('roster: move ids are unique within a class', () => {
  for (const c of classes.ALL_CLASSES) {
    const ids = c.moves.map(mv => mv.id)
    assert.strictEqual(new Set(ids).size, ids.length, `${c.name} has duplicate move ids`)
  }
})

test('roster: non-damaging moves carry null damage, never an invented 0', () => {
  /* The note is explicit: do not invent damage for moves without a value. */
  const noDamage = [
    ['assassin', 'shadow_step'],
    ['guardian', 'last_stand'],
    ['summoner', 'ancient_guardian'],
    ['holy_knight', 'heal'],
    ['elementalist', 'ice_bind']
  ]
  for (const [classId, moveId] of noDamage) {
    const mv = classes.moveById(classId, moveId)
    assert.ok(mv, `${classId}/${moveId} should exist`)
    assert.strictEqual(mv.damage, null, `${classId}/${moveId} must not have invented damage`)
  }
})

test('roster: Ancient Guardian is a summon, not a 0-damage attack', () => {
  const mv = classes.moveById('summoner', 'ancient_guardian')
  assert.strictEqual(mv.type, 'special')
  assert.strictEqual(mv.summon, true)
  assert.strictEqual(mv.ultimate, true)
})

test('roster: Guardian Last Stand is defensive, not an attack', () => {
  const mv = classes.moveById('guardian', 'last_stand')
  assert.strictEqual(mv.type, 'defensive')
  assert.strictEqual(mv.damage, null)
})

test('roster: Holy Knight heals carry their supplied HP values', () => {
  assert.strictEqual(classes.moveById('holy_knight', 'heal').heal, 5)
  assert.strictEqual(classes.moveById('holy_knight', 'greater_heal').heal, 15)
})

test('roster: supplied draft damage is preserved exactly', () => {
  assert.strictEqual(classes.moveById('swordsman', 'slash').damage, 4)
  assert.strictEqual(classes.moveById('swordsman', 'world_splitter').damage, 27)
  assert.strictEqual(classes.moveById('necromancer', 'soul_overlord').damage, 26)
  assert.strictEqual(classes.moveById('alchemist', 'alchemical_chaos').damage, 25)
  assert.strictEqual(classes.moveById('royal_mage', 'kingdom_fall').damage, 27)
})

/* ------------------------------------------------------------ class lookup */

test('lookup: class ids normalise from display names and casing', () => {
  assert.strictEqual(classes.normalizeClassId('Battle Mage'), 'battle_mage')
  assert.strictEqual(classes.normalizeClassId('battle_mage'), 'battle_mage')
  assert.strictEqual(classes.normalizeClassId('DRAGON KNIGHT'), 'dragon_knight')
  assert.strictEqual(classes.normalizeClassId('Swordsman'), 'swordsman')
})

test('lookup: the legacy DB default "Fighter" resolves instead of falling through', () => {
  /* This is the bug that made every player use the fighter move. */
  assert.strictEqual(classes.normalizeClassId('Fighter'), 'fighter')
  assert.strictEqual(classes.normalizeClassId('Mystic'), 'mystic')
})

test('lookup: an unknown class returns null rather than a wrong class', () => {
  assert.strictEqual(classes.normalizeClassId('Paladin'), null)
  assert.strictEqual(classes.classById('Paladin'), null)
  assert.deepStrictEqual(classes.movesForClass('Paladin'), [])
})

test('lookup: moves resolve by id and by display name', () => {
  assert.strictEqual(classes.moveById('swordsman', 'soul_cut').name, 'Soul Cut')
  assert.strictEqual(classes.moveByName('swordsman', 'Soul Cut').id, 'soul_cut')
  assert.strictEqual(classes.moveByName('swordsman', 'soul cut').id, 'soul_cut')
  assert.strictEqual(classes.moveByName('swordsman', 'Fireball'), null)
})

test('lookup: a move cannot be reached through the wrong class', () => {
  assert.strictEqual(classes.moveById('mage', 'soul_cut'), null)
})

/* ------------------------------------------------------------ damage curve */

test('damage: a C- player does NOT get the full draft damage', () => {
  /* Section 23: C- attacks must be reduced from the draft values. */
  const mv = classes.moveById('swordsman', 'world_splitter')
  const d = classes.classDamage({ move: mv, mastery: 0, gradeBonus: 0 })
  assert.ok(d.final < mv.damage, `C- ultimate ${d.final} should be below draft ${mv.damage}`)
})

test('damage: the class-grade bonus is added exactly once', () => {
  const mv = classes.moveById('swordsman', 'slash')
  const d = classes.classDamage({ move: mv, mastery: 500, gradeBonus: 1 })
  assert.strictEqual(d.bonus, 1)
  assert.strictEqual(d.final, Math.round(d.scaled + 1))
})

test('damage: a non-damaging move is never processed as a zero-damage attack', () => {
  for (const [classId, moveId] of [['guardian', 'guard'], ['holy_knight', 'heal'], ['summoner', 'summon_wolf']]) {
    const d = classes.classDamage({ move: classes.moveById(classId, moveId), mastery: 0, gradeBonus: 0 })
    assert.strictEqual(d.damaging, false, `${classId}/${moveId} must not be damaging`)
    assert.strictEqual(d.final, 0)
  }
})

test('damage: ultimates scale toward the ~30 target and are clamped there', () => {
  const mv = classes.moveById('swordsman', 'world_splitter')
  const low = classes.classDamage({ move: mv, mastery: 0, gradeBonus: 0 })
  const mid = classes.classDamage({ move: mv, mastery: 30000, gradeBonus: 13 })
  const max = classes.classDamage({ move: mv, mastery: 120000, gradeBonus: 25 })

  assert.ok(low.final < mid.final, 'ultimate should scale with mastery')
  assert.ok(mid.final <= max.final, 'ultimate must never go backwards')
  assert.strictEqual(max.final, 30, 'maxed ultimate should land on the ~30 target')
  assert.strictEqual(max.capped, true, 'the clamp must be reported, not silent')
  assert.strictEqual(low.capped, false, 'a low-mastery hit must not report a clamp')
})

test('damage: the ultimate is the strongest move in its class at every mastery level', () => {
  /*
   * A progression where the ultimate is weaker than a mid-tier move is not a
   * progression. This caught a real bug: an earlier curve interpolated the
   * ultimate straight to 30 and left World Splitter (15) below Soul Cut (18)
   * at B mastery.
   */
  for (const c of classes.OFFICIAL_CLASSES) {
    const ult = c.moves.find(mv => mv.ultimate)
    if (!ult || !(Number(ult.damage) > 0)) continue
    for (const mastery of [0, 500, 1500, 3500, 7500, 15000, 30000, 60000, 120000]) {
      const bonus = classes.classGradeFor(mastery).bonus
      const ultDmg = classes.classDamage({ move: ult, mastery, gradeBonus: bonus }).final
      for (const mv of c.moves) {
        if (mv === ult || !(Number(mv.damage) > 0)) continue
        const d = classes.classDamage({ move: mv, mastery, gradeBonus: bonus }).final
        assert.ok(ultDmg >= d, `${c.id}: ${ult.name} (${ultDmg}) < ${mv.name} (${d}) at mastery ${mastery}`)
      }
    }
  }
})

test('damage: mastery scaling never produces a negative or zero hit', () => {
  for (const c of classes.OFFICIAL_CLASSES) {
    for (const mv of c.moves) {
      if (!(Number(mv.damage) > 0)) continue
      for (const mastery of [0, 500, 15000, 120000]) {
        const d = classes.classDamage({ move: mv, mastery, gradeBonus: classes.classGradeFor(mastery).bonus })
        assert.ok(d.final >= 1, `${c.id}/${mv.id} at ${mastery} produced ${d.final}`)
      }
    }
  }
})

test('damage: balance values are configurable and reported as pending', () => {
  const before = { ...classes.BALANCE }
  try {
    classes.setBalance({ cMinusScale: 0.4 })
    assert.strictEqual(classes.BALANCE.cMinusScale, 0.4)
  } finally {
    classes.setBalance({ cMinusScale: before.cMinusScale })
  }
  assert.strictEqual(classes.masteryAwardPending(), true, 'award values must still be pending')
  assert.strictEqual(classes.masteryFor('classMove'), 0, 'unapproved award must be 0')
})

/* -------------------------------------------------------------- validation */

function player (over = {}) {
  return { userId: '1', class: 'swordsman', ...over }
}

test('validate: no player is rejected', () => {
  const r = classes.validateMoveUse({ player: null, move: classes.moveById('swordsman', 'slash') })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'no_player')
})

test('validate: no class is rejected', () => {
  const r = classes.validateMoveUse({ player: player({ class: '' }), move: classes.moveById('swordsman', 'slash'), inBattle: true })
  assert.strictEqual(r.reason, 'no_class')
})

test('validate: a move from another class is rejected', () => {
  const r = classes.validateMoveUse({
    player: player({ class: 'mage' }),
    move: classes.moveById('swordsman', 'slash'),
    inBattle: true
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'wrong_class')
})

test('validate: a locked move is rejected', () => {
  const mv = { ...classes.moveById('swordsman', 'slash'), unlock: 5000 }
  const r = classes.validateMoveUse({ player: player(), move: mv, mastery: 100, inBattle: true })
  assert.strictEqual(r.reason, 'locked')
})

test('validate: a disabled move is rejected', () => {
  const mv = { ...classes.moveById('swordsman', 'slash'), enabled: false }
  const r = classes.validateMoveUse({ player: player(), move: mv, inBattle: true })
  assert.strictEqual(r.reason, 'disabled')
})

test('validate: no battle is rejected', () => {
  const r = classes.validateMoveUse({ player: player(), move: classes.moveById('swordsman', 'slash'), inBattle: false })
  assert.strictEqual(r.reason, 'no_battle')
})

test('validate: the fourth class move of the day is rejected', () => {
  const r = classes.validateMoveUse({
    player: player(),
    move: classes.moveById('swordsman', 'slash'),
    usesToday: 3,
    dailyLimit: 3,
    inBattle: true
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'daily_limit')
})

test('validate: insufficient Power Energy is rejected', () => {
  const mv = { ...classes.moveById('swordsman', 'slash'), cost: 20 }
  const r = classes.validateMoveUse({ player: player(), move: mv, inBattle: true, energy: 5 })
  assert.strictEqual(r.reason, 'energy')
})

test('validate: a move with no configured cost is allowed at any energy', () => {
  const r = classes.validateMoveUse({
    player: player(),
    move: classes.moveById('swordsman', 'slash'),
    inBattle: true,
    energy: 0
  })
  assert.strictEqual(r.ok, true)
})

test('validate: a valid move passes and reports its cost', () => {
  const mv = { ...classes.moveById('swordsman', 'slash'), cost: 7 }
  const r = classes.validateMoveUse({ player: player(), move: mv, inBattle: true, energy: 50 })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.cost, 7)
})

/* ------------------------------------------------------- daily-limit SQL shape */

test('daily limit: the counter is a single atomic statement, not read-then-write', () => {
  /*
   * The concurrency guarantee comes from the SQL, so it is asserted on the
   * source. A read-then-write would be two statements and would let two
   * simultaneous requests both pass at 2/3.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'axyon-store.js'), 'utf8')
  const fn = src.slice(src.indexOf('async function consumeClassMove'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3)

  assert.ok(body.includes('ON CONFLICT(user_id,day_key) DO UPDATE'), 'must be an upsert')
  assert.ok(body.includes('WHERE axyon_class_usage.used < $3'), 'must guard the increment in SQL')
  assert.ok(!/SELECT[\s\S]*?UPDATE/.test(body), 'must not read then write')
})

test('daily limit: usage is keyed by player AND UTC day', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'axyon-store.js'), 'utf8')
  assert.ok(src.includes('CREATE TABLE IF NOT EXISTS axyon_class_usage'), 'usage table must exist')
  assert.ok(/axyon_class_usage\([\s\S]*?PRIMARY KEY\(user_id, day_key\)/.test(src), 'must be keyed by user and day')
})

test('daily limit: card abilities are NOT in the class-move counter', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'axyon-store.js'), 'utf8')
  const table = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS axyon_class_usage'))
  const ddl = table.slice(0, table.indexOf(');'))
  assert.ok(!ddl.includes('card'), 'the class-move table must not track card uses')
})

test('mastery: stored per player per class, so a switch does not transfer it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'axyon-store.js'), 'utf8')
  assert.ok(src.includes('CREATE TABLE IF NOT EXISTS axyon_class_mastery'), 'mastery table must exist')
  assert.ok(/axyon_class_mastery\([\s\S]*?PRIMARY KEY\(user_id, class_id\)/.test(src), 'must be keyed by user and class')
})

/* ------------------------------------------------------------- integration */

test('integration: the RPG engine no longer hard-codes a single move per class', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'axyon-rpg.js'), 'utf8')
  assert.ok(src.includes("require('./axyon-classes')"), 'the engine must use the catalogue')
  assert.ok(!src.includes("fighter: { name: 'Cleaving Strike'"), 'the old hard-coded table must be gone')
})

test('integration: the class branch consumes the daily use atomically', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'axyon-rpg.js'), 'utf8')
  assert.ok(src.includes('store.consumeClassMove'), 'battleAct must consume via the atomic helper')
  assert.ok(src.includes('classes.classDamage'), 'damage must go through the single calculator')
})

test('integration: classadmin is registered and gated on AXYON authority', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'axyon-commands.js'), 'utf8')
  assert.ok(src.includes("cmd('classadmin'"), 'classadmin must be registered')
  const at = src.indexOf("cmd('classadmin'")
  const body = src.slice(at, at + 400)
  assert.ok(body.includes('ctx.auth.axyon'), 'classadmin must check AXYON authority')
})

test('integration: the class sheet is exposed to players', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'axyon-rpg.js'), 'utf8')
  assert.ok(src.includes('async function classSheet'), 'classSheet must exist')
  assert.ok(src.includes('classSheet,'), 'classSheet must be exported')
})

test('integration: class grade is never conflated with Level, Rank or overall Grade', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'axyon-rpg.js'), 'utf8')
  const at = src.indexOf('async function classSheet')
  const body = src.slice(at, at + 3000)
  assert.ok(body.includes('separate from your Level, Rank and overall Grade'), 'the sheet must say so')
})
