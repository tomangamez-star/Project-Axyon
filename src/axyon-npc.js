'use strict'
/*
 * AXYON NPC OPPONENTS
 * ===================
 *
 * Stage and dungeon combat used to fight a bare stat block: `{hp, atk, def,
 * xp, zen}`. That is enough to subtract numbers from, but it is not an
 * OPPONENT — it has no class, no rank, no grade, no mastery and no moves, so
 * every fight read the same and a "boss" was only a bigger number.
 *
 * This file gives an NPC a real identity:
 *
 *   class     one of the 20 official classes (or a legacy one)
 *   rank      E → Monarch, the same ladder players use
 *   grade     1-6, the same grade the player card shows
 *   mastery   class mastery, which drives the class grade and the damage
 *   moves     the class's own move list, used in combat
 *
 * THE ONE RULE THAT MATTERS
 * -------------------------
 * An NPC's damage goes through the SAME `classes.classDamage()` the player's
 * does. There is no second damage formula. If a class move is rebalanced, the
 * NPC is rebalanced with it — which is the only way a fight stays fair and the
 * only way the numbers on the card mean the same thing on both sides.
 *
 * DETERMINISM
 * -----------
 * An NPC is derived from its stage/floor row, not stored separately. The same
 * stage always produces the same opponent, so a player who retreats and
 * returns meets the same enemy rather than a rerolled one. The derivation is a
 * pure function of the row's key, so it survives a restart with no extra table.
 */

const classes = require('./axyon-classes')

/* The rank ladder, matching the store's RANKS. */
const NPC_RANKS = ['E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'Monarch']

/*
 * Which classes an NPC may be given, by tier.
 *
 * A floor-1 monster should not be a Dragon Knight with a 27-damage ultimate.
 * The tier is derived from the stage/floor ordinal, so the roster widens as
 * the player climbs — the same way the player's own options widen.
 */
const NPC_CLASS_TIERS = [
  /* tier 0 — the opening stages */
  ['fighter', 'brawler', 'archer', 'swordsman'],
  /* tier 1 */
  ['swordsman', 'guardian', 'assassin', 'mage', 'brawler', 'archer'],
  /* tier 2 */
  ['guardian', 'assassin', 'mage', 'battle_mage', 'berserker', 'duelist', 'hunter'],
  /* tier 3 */
  ['battle_mage', 'elementalist', 'dragon_knight', 'holy_knight', 'shadow', 'spellblade', 'royal_mage'],
  /* tier 4 — bosses */
  ['dragon_knight', 'necromancer', 'summoner', 'royal_mage', 'arcane_warrior', 'mystic']
]

/** A stable small hash, so the same key always yields the same NPC. */
function hash (text) {
  let h = 2166136261
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function tierFor (ordinal, boss) {
  const n = Math.max(1, Math.floor(Number(ordinal) || 1))
  if (boss) return 4
  if (n <= 1) return 0
  if (n <= 3) return 1
  if (n <= 6) return 2
  return 3
}

/**
 * The rank an NPC of this ordinal should hold.
 *
 * Derived from the ordinal so a floor-5 boss is genuinely a higher rank than a
 * floor-1 monster, rather than every NPC being rank E.
 */
function rankFor (ordinal, boss) {
  const n = Math.max(1, Math.floor(Number(ordinal) || 1))
  const idx = Math.min(NPC_RANKS.length - 1, Math.floor((n - 1) / 2) + (boss ? 2 : 0))
  return NPC_RANKS[idx]
}

/**
 * Builds the NPC for a stage or floor row.
 *
 * `row` is the database row: { key, name, ordinal, hp, atk, def, xp, zen, boss }.
 * The returned object is a superset of the old `buildEnemy()` shape, so every
 * existing caller keeps working — `hp`, `atk`, `def`, `xp`, `zen` and `boss`
 * are all still there, and the class identity is added alongside them.
 */
function buildNpc (row) {
  const r = row || {}
  const ordinal = Math.max(1, Math.floor(Number(r.ordinal) || 1))
  const boss = !!r.boss
  const seed = hash(`${r.key || r.name || 'npc'}:${ordinal}`)

  const tier = tierFor(ordinal, boss)
  const pool = NPC_CLASS_TIERS[tier] || NPC_CLASS_TIERS[0]
  const classId = pool[seed % pool.length]
  const def = classes.classById(classId) || classes.classById('fighter')

  /*
   * Mastery scales with the ordinal, so a deep-floor NPC has a real class
   * grade and a real damage bonus instead of a flat one. The curve is the
   * approved grade table — no new numbers are invented here.
   */
  const mastery = Math.min(classes.MAX_MASTERY, Math.floor(ordinal * ordinal * 900))
  const grade = classes.classGradeFor(mastery)

  const moves = def ? classes.movesForClass(def.id) : []
  const damaging = moves.filter(mv => Number(mv.damage) > 0)
  const ultimate = moves.find(mv => mv.ultimate) || damaging[damaging.length - 1] || null

  /*
   * The NPC's signature move is its ultimate when it has one, otherwise its
   * strongest damaging move. A defensive-only class still gets a move so the
   * fight is not silent.
   */
  const signature = ultimate || damaging[0] || moves[0] || null

  return {
    /* --- the original stat block, unchanged --- */
    name: r.name,
    hp: Number(r.hp) || 60,
    atk: Number(r.atk) || 5,
    def: Number(r.def) || 2,
    xp: Number(r.xp) || 40,
    zen: Number(r.zen) || 60,
    boss,

    /* --- the identity --- */
    npc: true,
    classId: def ? def.id : null,
    className: def ? def.name : 'Unknown',
    rank: rankFor(ordinal, boss),
    grade: grade.grade,
    gradeBonus: grade.bonus,
    mastery,
    level: Math.max(1, ordinal * 4 + (boss ? 8 : 0)),
    moves: moves.map(mv => mv.name),
    signature: signature ? signature.name : null,
    signatureMove: signature,
    abilities: moves.slice(-3).map(mv => mv.name)
  }
}

/**
 * The damage an NPC's class move deals.
 *
 * Deliberately routed through `classes.classDamage()` — the same function the
 * player's move uses. An NPC never gets its own formula, so a rebalance cannot
 * leave the two sides disagreeing.
 */
function npcMoveDamage (npc, move = null) {
  const mv = move || npc?.signatureMove
  if (!mv) return { damaging: false, final: 0 }
  return classes.classDamage({
    move: mv,
    mastery: Number(npc?.mastery) || 0,
    gradeBonus: Number(npc?.gradeBonus) || 0
  })
}

/**
 * The NPC's basic attack.
 *
 * Kept as the existing `enemy.atk + rnd(6) - player.def * 0.3` shape the
 * engine already used, so adding a class does not change how a basic hit
 * feels. The class move is the extra option, not a replacement.
 */
function npcBasicDamage (npc, playerDef, roll = 0) {
  const atk = Number(npc?.atk) || 5
  const def = Number(playerDef) || 0
  return Math.max(1, Math.round(atk + roll - def * 0.3))
}

/** A one-line identity for the battle card. */
function npcLine (npc) {
  if (!npc || !npc.npc) return ''
  return `${npc.className} · Rank ${npc.rank} · Grade ${npc.grade} · Mastery ${Number(npc.mastery).toLocaleString('en-US')}`
}

module.exports = {
  NPC_RANKS,
  NPC_CLASS_TIERS,
  hash,
  tierFor,
  rankFor,
  buildNpc,
  npcMoveDamage,
  npcBasicDamage,
  npcLine
}
