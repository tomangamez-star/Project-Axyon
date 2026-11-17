'use strict'
/*
 * AXYON CLASSES — the class catalogue, class mastery, class grade and the
 * class-damage calculation.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The class system used to live as two hard-coded objects inside axyon-rpg.js:
 * four classes, one move each, and no mastery at all. That made the class a
 * label rather than a progression, and it put class balance inside the combat
 * engine where changing a number meant editing the engine.
 *
 * Everything here is DATA plus PURE FUNCTIONS. No database, no socket, no
 * clock. That is deliberate: the mastery thresholds, the grade table and the
 * damage curve are the rules most likely to be rebalanced, and they must be
 * testable without a Postgres instance.
 *
 * WHAT IS APPROVED AND WHAT IS NOT
 * --------------------------------
 * APPROVED (from the implementation note, do not change):
 *   - the nine class grades and their exact mastery thresholds
 *   - the exact attack bonus per grade
 *   - the 20-class roster, move names, move types and draft base damage
 *   - 3 shared class moves per UTC day
 *
 * PENDING OWNER APPROVAL (configurable, defaults documented in BALANCE):
 *   - the C- damage scale (the note says draft damage must be REDUCED at C-,
 *     but does not supply the reduced table)
 *   - the mastery-based damage curve
 *   - the ultimate damage target curve
 *   - Power Energy cost per move
 *   - per-move unlock mastery
 *   - mastery award amounts
 *
 * Nothing in the PENDING list is invented as if it were approved. Each has a
 * documented default, is overridable at runtime, and is reported as pending.
 */

/* ------------------------------------------------------------ class grades */

/*
 * The exact table from the note. Ordered ascending by mastery so the lookup is
 * "highest threshold reached". Do not rebalance, compress or reorder.
 */
const CLASS_GRADES = [
  { grade: 'C-', mastery: 0, bonus: 0 },
  { grade: 'C', mastery: 500, bonus: 1 },
  { grade: 'C+', mastery: 1500, bonus: 2 },
  { grade: 'B-', mastery: 3500, bonus: 4 },
  { grade: 'B', mastery: 7500, bonus: 6 },
  { grade: 'B+', mastery: 15000, bonus: 9 },
  { grade: 'A', mastery: 30000, bonus: 13 },
  { grade: 'S', mastery: 60000, bonus: 18 },
  { grade: 'SS', mastery: 120000, bonus: 25 }
]

const MAX_MASTERY = CLASS_GRADES[CLASS_GRADES.length - 1].mastery

/**
 * The class grade for a mastery value.
 *
 * Uses the HIGHEST threshold the player has reached, so 499 is still C- and
 * 500 is C. Negative or non-numeric mastery is treated as 0 rather than
 * throwing — a corrupt row must not take the bot down.
 *
 * Returns the reached grade, its bonus, the threshold that granted it, and the
 * next grade (or null at SS) so the UI can show "12,400 / 15,000 to B+".
 */
function classGradeFor (mastery) {
  const m = Math.max(0, Math.floor(Number(mastery) || 0))
  let reached = CLASS_GRADES[0]
  let next = null
  for (let i = 0; i < CLASS_GRADES.length; i++) {
    if (m >= CLASS_GRADES[i].mastery) {
      reached = CLASS_GRADES[i]
      next = CLASS_GRADES[i + 1] || null
    }
  }
  return {
    grade: reached.grade,
    bonus: reached.bonus,
    threshold: reached.mastery,
    mastery: m,
    next: next ? { grade: next.grade, mastery: next.mastery, remaining: next.mastery - m } : null
  }
}

/* ---------------------------------------------------------------- balance */

/*
 * PENDING APPROVAL — every number in here is a placeholder that the owner must
 * confirm. They are grouped in one object so a rebalance is a one-line change
 * and never a hunt through the combat engine.
 *
 * cMinusScale
 *   The note (section 23) says C- attacks must be REDUCED from the draft
 *   values, but the reduced table was not supplied. 0.5 means a C- player
 *   deals half the draft damage. NOT APPROVED.
 *
 * maxScale
 *   The multiplier at SS mastery. 1.0 means a fully mastered player deals the
 *   full draft damage. NOT APPROVED.
 *
 * ultimateTarget
 *   Section 22C: "at the highest progression, the strongest ultimate attacks
 *   should reach approximately 30 damage". This is that target. The ultimate
 *   curve interpolates from its C- value up to this, and the class-grade bonus
 *   is NOT added on top of an ultimate — otherwise a 27-draft ultimate plus a
 *   +25 SS bonus would land at 52 and blow through the stated target.
 *
 * masteryAward
 *   Section 2: "The method and amount of mastery earned per action must follow
 *   existing approved project rules. If no rule exists ... leave mastery
 *   awarding behind a configurable function and clearly report that the award
 *   values need approval." No rule exists in the repo, so these are null and
 *   award 0 until the owner sets them. NOT APPROVED.
 */
const BALANCE = {
  cMinusScale: 0.5,
  maxScale: 1.0,
  ultimateTarget: 30,
  masteryAward: {
    classMove: null,
    battleWin: null
  }
}

/** Runtime override, so an admin can rebalance without a redeploy. */
function setBalance (patch = {}) {
  if (Number.isFinite(Number(patch.cMinusScale))) BALANCE.cMinusScale = Number(patch.cMinusScale)
  if (Number.isFinite(Number(patch.maxScale))) BALANCE.maxScale = Number(patch.maxScale)
  if (Number.isFinite(Number(patch.ultimateTarget))) BALANCE.ultimateTarget = Number(patch.ultimateTarget)
  if (patch.masteryAward && typeof patch.masteryAward === 'object') {
    for (const k of ['classMove', 'battleWin']) {
      if (k in patch.masteryAward) {
        const v = patch.masteryAward[k]
        BALANCE.masteryAward[k] = v === null ? null : (Number.isFinite(Number(v)) ? Number(v) : null)
      }
    }
  }
  return { ...BALANCE, masteryAward: { ...BALANCE.masteryAward } }
}

/** 0 → 1 across the mastery range, clamped. */
function masteryProgress (mastery) {
  const m = Math.max(0, Math.min(MAX_MASTERY, Number(mastery) || 0))
  return m / MAX_MASTERY
}

/**
 * The single place class damage is calculated.
 *
 * Section 2: "Apply it only to eligible class combat damage, not automatically
 * to card damage, unrelated weapons, environmental damage, or every damage
 * source" and "Avoid applying the bonus twice when a move already passes
 * through a shared damage-calculation function."
 *
 * Because this is the ONLY function that adds the class-grade bonus, and the
 * combat engine calls it exactly once per class move, the bonus cannot be
 * applied twice. Card damage and basic attacks never call it.
 *
 * Non-damaging moves (defensive, healing, control, summon) return final 0 and
 * `damaging: false` — they must never be processed as a zero-damage attack.
 */
function classDamage ({ move, mastery = 0, gradeBonus = 0, balance = BALANCE } = {}) {
  /*
   * The catalogue names these `damage` and `ultimate`; a move row loaded from
   * the database may name them `base_damage` and `is_ultimate`. Accept both so
   * a stored move and a catalogue move calculate identically.
   */
  const draft = move ? (move.base_damage != null ? move.base_damage : move.damage) : null
  const base = Number(draft)
  const damaging = Number.isFinite(base) && base > 0
  const isUltimate = !!(move && (move.is_ultimate || move.ultimate))
  if (!damaging) {
    return { damaging: false, base: 0, scaled: 0, bonus: 0, final: 0, isUltimate }
  }

  const progress = masteryProgress(mastery)
  const scale = balance.cMinusScale + (balance.maxScale - balance.cMinusScale) * progress
  const scaled = base * scale
  const bonus = Math.max(0, Math.floor(Number(gradeBonus) || 0))
  const raw = scaled + bonus

  /*
   * THE CEILING APPLIES TO EVERY CLASS MOVE, NOT JUST ULTIMATES.
   *
   * Section 22C says "at the highest progression, the strongest ultimate
   * attacks should reach approximately 30 damage". That is a statement about
   * the top of the class damage scale, so 30 is the ceiling for the system.
   *
   * Capping only the ultimate was wrong: a 22-draft move plus the +18 S bonus
   * reached 35 and beat the 27-draft ultimate clamped at 30, which inverts the
   * progression. Capping everything keeps the ultimate on top (it has the
   * highest draft value) and keeps the stated ceiling honest.
   *
   * `capped` is reported so the battle log can show that a hit saturated
   * rather than silently losing damage.
   */
  const final = Math.max(1, Math.min(balance.ultimateTarget, Math.round(raw)))

  return {
    damaging: true,
    base,
    scaled: Math.round(scaled * 100) / 100,
    bonus,
    final,
    capped: raw > balance.ultimateTarget,
    isUltimate
  }
}

/* --------------------------------------------------------------- catalogue */

/*
 * The 20 official classes from the note.
 *
 * `damage: null` means the note supplied no numeric damage for that move. It
 * is NOT zero — a defensive stance, a heal, a summon or a control effect is
 * not a 0-damage attack, and the combat engine must branch on move_type
 * instead of subtracting 0 from the enemy's HP.
 *
 * `unlock: null` means the unlock requirement is PENDING (section 7: "Do not
 * infer unlock requirements from move order, damage, class grade, player level,
 * or rank"). A null unlock means "no requirement configured", which is the
 * only safe default — the note forbids making everything available by default
 * *unless that is already the approved behaviour*, and the existing bot had no
 * unlock system at all, so every existing move was available. Preserving that
 * is the non-breaking choice; the owner can set real thresholds per move.
 *
 * `cost: null` means the Power Energy cost is PENDING (section 5: "do not
 * guess costs"). A null cost is treated as 0 by the validator, which matches
 * the existing behaviour where only the single class move had a cost.
 */
const OFFICIAL_CLASSES = [
  {
    id: 'swordsman',
    name: 'Swordsman',
    specialization: 'Sword combat, cutting attacks, counters, and powerful sword techniques.',
    moves: [
      { id: 'slash', name: 'Slash', type: 'offensive', damage: 4, desc: 'Basic direct sword attack.' },
      { id: 'heavy_cut', name: 'Heavy Cut', type: 'offensive', damage: 6, desc: 'Stronger, slower sword swing.' },
      { id: 'counter_slash', name: 'Counter Slash', type: 'offensive', damage: 8, desc: 'Counterattack after successfully responding to an attack.' },
      { id: 'blade_rush', name: 'Blade Rush', type: 'offensive', damage: 10, desc: 'Rapid forward attack that closes distance.' },
      { id: 'blade_storm', name: 'Blade Storm', type: 'offensive', damage: 15, desc: 'Quick sequence of sword attacks.' },
      { id: 'soul_cut', name: 'Soul Cut', type: 'offensive', damage: 22, desc: 'Powerful cut designed to penetrate defenses.' },
      { id: 'world_splitter', name: 'World Splitter', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate sword strike.' }
    ]
  },
  {
    id: 'assassin',
    name: 'Assassin',
    specialization: 'Stealth, speed, evasion, and critical attacks.',
    moves: [
      { id: 'quick_stab', name: 'Quick Stab', type: 'offensive', damage: 5, desc: 'Fast stabbing attack.' },
      { id: 'ambush', name: 'Ambush', type: 'offensive', damage: 7, desc: 'Unexpected attack.' },
      { id: 'shadow_step', name: 'Shadow Step', type: 'defensive', damage: null, desc: 'Evasion; avoids an incoming attack through quick movement.' },
      { id: 'critical_strike', name: 'Critical Strike', type: 'offensive', damage: 12, desc: 'Precision attack against a vulnerable opening.' },
      { id: 'death_mark', name: 'Death Mark', type: 'offensive', damage: 16, desc: 'Marks an opponent for a stronger follow-up.' },
      { id: 'phantom_strike', name: 'Phantom Strike', type: 'offensive', damage: 22, desc: 'Rapid, difficult-to-track attack.' },
      { id: 'execution', name: 'Execution', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate finishing attack against a vulnerable opponent.' }
    ]
  },
  {
    id: 'guardian',
    name: 'Guardian',
    specialization: 'Defense, protection, and counterattacks.',
    moves: [
      { id: 'shield_bash', name: 'Shield Bash', type: 'offensive', damage: 4, desc: 'Shield strike that disrupts an opponent.' },
      { id: 'guard', name: 'Guard', type: 'defensive', damage: null, desc: 'Reduces incoming damage through defensive positioning.' },
      { id: 'fortify', name: 'Fortify', type: 'defensive', damage: null, desc: 'Temporarily strengthens defense.' },
      { id: 'shield_break', name: 'Shield Break', type: 'offensive', damage: 8, desc: 'Shield attack designed to break a defensive stance.' },
      { id: 'iron_wall', name: 'Iron Wall', type: 'defensive', damage: null, desc: 'Strong defensive stance.' },
      { id: 'guardian_strike', name: 'Guardian Strike', type: 'offensive', damage: 16, desc: 'Powerful strike combining defensive strength and attack power.' },
      { id: 'last_stand', name: 'Last Stand', type: 'defensive', damage: null, ultimate: true, desc: 'Ultimate defense; final defensive stance to withstand pressure and protect self or allies.' }
    ]
  },
  {
    id: 'brawler',
    name: 'Brawler',
    specialization: 'Hand-to-hand combat, physical strength, and combos.',
    moves: [
      { id: 'jab', name: 'Jab', type: 'offensive', damage: 4, desc: 'Quick basic punch.' },
      { id: 'punch', name: 'Punch', type: 'offensive', damage: 6, desc: 'Stronger direct punch.' },
      { id: 'combo', name: 'Combo', type: 'offensive', damage: 9, desc: 'Consecutive punches.' },
      { id: 'counterpunch', name: 'Counterpunch', type: 'offensive', damage: 11, desc: 'Punch after successfully countering.' },
      { id: 'power_combo', name: 'Power Combo', type: 'offensive', damage: 15, desc: 'Stronger multi-hit combination.' },
      { id: 'impact', name: 'Impact', type: 'offensive', damage: 21, desc: 'Concentrated heavy physical attack.' },
      { id: 'earthbreaker', name: 'Earthbreaker', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate physical attack.' }
    ]
  },
  {
    id: 'archer',
    name: 'Archer',
    specialization: 'Ranged combat, accuracy, and precision.',
    moves: [
      { id: 'arrow_shot', name: 'Arrow Shot', type: 'offensive', damage: 4, desc: 'Basic arrow.' },
      { id: 'power_arrow', name: 'Power Arrow', type: 'offensive', damage: 7, desc: 'Stronger arrow.' },
      { id: 'piercing_arrow', name: 'Piercing Arrow', type: 'offensive', damage: 9, desc: 'Arrow designed to penetrate defensive protection.' },
      { id: 'multishot', name: 'Multishot', type: 'offensive', damage: 12, desc: 'Multiple arrows in one attack.' },
      { id: 'weakpoint', name: 'Weakpoint', type: 'offensive', damage: 15, desc: 'Targets a vulnerable area to create an opening.' },
      { id: 'stormshot', name: 'Stormshot', type: 'offensive', damage: 21, desc: 'Rapid sequence of arrow attacks.' },
      { id: 'heaven_arrow', name: 'Heaven Arrow', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate ranged attack.' }
    ]
  },
  {
    id: 'mage',
    name: 'Mage',
    specialization: 'Magical attacks and elemental spells.',
    moves: [
      { id: 'magic_bolt', name: 'Magic Bolt', type: 'offensive', damage: 4, desc: 'Basic magical projectile.' },
      { id: 'fireball', name: 'Fireball', type: 'offensive', damage: 7, desc: 'Fire-based attack.' },
      { id: 'frostbolt', name: 'Frostbolt', type: 'offensive', damage: 7, desc: 'Ice attack that may slow an opponent.' },
      { id: 'thunderbolt', name: 'Thunderbolt', type: 'offensive', damage: 9, desc: 'Lightning attack.' },
      { id: 'arcane_crush', name: 'Arcane Crush', type: 'offensive', damage: 13, desc: 'Concentrated magical crushing attack.' },
      { id: 'meteor', name: 'Meteor', type: 'offensive', damage: 21, desc: 'Powerful meteor-like attack.' },
      { id: 'arcane_cataclysm', name: 'Arcane Cataclysm', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate destructive magical wave.' }
    ]
  },
  {
    id: 'battle_mage',
    name: 'Battle Mage',
    specialization: 'Physical combat combined with magic.',
    moves: [
      { id: 'mana_strike', name: 'Mana Strike', type: 'offensive', damage: 5, desc: 'Physical strike enhanced with magic.' },
      { id: 'flame_blade', name: 'Flame Blade', type: 'offensive', damage: 7, desc: 'Fire-enhanced blade attack.' },
      { id: 'arcane_hit', name: 'Arcane Hit', type: 'offensive', damage: 9, desc: 'Direct arcane-enhanced attack.' },
      { id: 'spell_rush', name: 'Spell Rush', type: 'offensive', damage: 12, desc: 'Movement combined with a rapid magical attack.' },
      { id: 'magic_breaker', name: 'Magic Breaker', type: 'offensive', damage: 15, desc: 'Disrupts magical defenses.' },
      { id: 'battle_burst', name: 'Battle Burst', type: 'offensive', damage: 21, desc: 'Concentrated magical energy during an offensive attack.' },
      { id: 'arcane_overdrive', name: 'Arcane Overdrive', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate combination of magical and physical power.' }
    ]
  },
  {
    id: 'elementalist',
    name: 'Elementalist',
    specialization: 'Elemental manipulation.',
    moves: [
      { id: 'element_shot', name: 'Element Shot', type: 'offensive', damage: 5, desc: 'Basic elemental projectile.' },
      { id: 'flame_burst', name: 'Flame Burst', type: 'offensive', damage: 7, desc: 'Burst of fire.' },
      { id: 'ice_bind', name: 'Ice Bind', type: 'special', damage: null, desc: 'Control; temporarily restricts an opponent\u2019s movement.' },
      { id: 'thunder_strike', name: 'Thunder Strike', type: 'offensive', damage: 9, desc: 'Lightning attack.' },
      { id: 'wind_slash', name: 'Wind Slash', type: 'offensive', damage: 10, desc: 'Cutting wind attack.' },
      { id: 'element_storm', name: 'Element Storm', type: 'offensive', damage: 15, desc: 'Combines multiple elements.' },
      { id: 'elemental_wrath', name: 'Elemental Wrath', type: 'offensive', damage: 21, desc: 'Powerful elemental assault.' },
      { id: 'primordial_storm', name: 'Primordial Storm', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate combination of elemental forces.' }
    ]
  },
  {
    id: 'berserker',
    name: 'Berserker',
    specialization: 'Aggression, strength, and offensive pressure.',
    moves: [
      { id: 'rage_hit', name: 'Rage Hit', type: 'offensive', damage: 5, desc: 'Aggression-powered basic attack.' },
      { id: 'blood_rush', name: 'Blood Rush', type: 'offensive', damage: 7, desc: 'Damage plus temporary offensive boost.' },
      { id: 'brutal_smash', name: 'Brutal Smash', type: 'offensive', damage: 9, desc: 'Heavy attack.' },
      { id: 'rampage', name: 'Rampage', type: 'offensive', damage: 12, desc: 'Escalating sequence of attacks.' },
      { id: 'berserk', name: 'Berserk', type: 'support', damage: null, desc: 'Offensive boost; temporarily increases offensive capability.' },
      { id: 'ravage', name: 'Ravage', type: 'offensive', damage: 21, desc: 'Concentrated Berserker attack.' },
      { id: 'berserker_wrath', name: 'Berserker Wrath', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate offensive attack.' }
    ]
  },
  {
    id: 'duelist',
    name: 'Duelist',
    specialization: 'Precision, counters, and one-on-one combat.',
    moves: [
      { id: 'fine_strike', name: 'Fine Strike', type: 'offensive', damage: 5, desc: 'Precise attack against an opening.' },
      { id: 'parry', name: 'Parry', type: 'defensive', damage: null, desc: 'Damage reduction; deflects an incoming attack and reduces damage received.' },
      { id: 'riposte', name: 'Riposte', type: 'offensive', damage: 7, desc: 'Counterattack after a successful parry.' },
      { id: 'precision_cut', name: 'Precision Cut', type: 'offensive', damage: 10, desc: 'Accurate, carefully executed attack.' },
      { id: 'duelist_surge', name: 'Duelist Surge', type: 'offensive', damage: 14, desc: 'Offensive sequence that increases combat pressure.' },
      { id: 'perfect_counter', name: 'Perfect Counter', type: 'offensive', damage: 21, desc: 'Powerful counter after a successful defense.' },
      { id: 'final_stance', name: 'Final Stance', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate combat stance and decisive attack.' }
    ]
  },
  {
    id: 'shadow',
    name: 'Shadow',
    specialization: 'Stealth, concealment, repositioning, and shadow attacks.',
    moves: [
      { id: 'shadow_hit', name: 'Shadow Hit', type: 'offensive', damage: 5, desc: 'Basic shadow-enhanced attack.' },
      { id: 'vanish', name: 'Vanish', type: 'defensive', damage: null, desc: 'Evasion; temporarily conceals the player to avoid an incoming attack.' },
      { id: 'dark_slash', name: 'Dark Slash', type: 'offensive', damage: 8, desc: 'Dark-energy cutting attack.' },
      { id: 'phantom_step', name: 'Phantom Step', type: 'defensive', damage: null, desc: 'Evasion/repositioning; avoids an attack and repositions.' },
      { id: 'shadow_combo', name: 'Shadow Combo', type: 'offensive', damage: 14, desc: 'Multiple shadow-enhanced attacks.' },
      { id: 'void_strike', name: 'Void Strike', type: 'offensive', damage: 21, desc: 'Concentrated void-energy strike.' },
      { id: 'shadow_realm', name: 'Shadow Realm', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate shadow technique.' }
    ]
  },
  {
    id: 'alchemist',
    name: 'Alchemist',
    specialization: 'Chemical mixtures, battlefield control, and enhancement.',
    moves: [
      { id: 'acid_shot', name: 'Acid Shot', type: 'offensive', damage: 4, desc: 'Acidic projectile.' },
      { id: 'weakening_brew', name: 'Weakening Brew', type: 'special', damage: null, desc: 'Debuff; temporarily reduces opponent attack power.' },
      { id: 'smoke_bomb', name: 'Smoke Bomb', type: 'defensive', damage: null, desc: 'Defensive/concealment; obstructs visibility and helps avoid attacks.' },
      { id: 'explosive_brew', name: 'Explosive Brew', type: 'offensive', damage: 8, desc: 'Explosive mixture.' },
      { id: 'enhancement_brew', name: 'Enhancement Brew', type: 'support', damage: null, desc: 'Offensive boost; temporarily increases offensive capability.' },
      { id: 'volatile_mixture', name: 'Volatile Mixture', type: 'offensive', damage: 18, desc: 'Unstable explosive mixture.' },
      { id: 'alchemical_chaos', name: 'Alchemical Chaos', type: 'offensive', damage: 25, ultimate: true, desc: 'Ultimate combination of alchemical effects.' }
    ]
  },
  {
    id: 'hunter',
    name: 'Hunter',
    specialization: 'Tracking, ranged attacks, traps, and target control.',
    moves: [
      { id: 'hunters_arrow', name: 'Hunter\u2019s Arrow', type: 'offensive', damage: 5, desc: 'Basic precision arrow.' },
      { id: 'track_shot', name: 'Track Shot', type: 'offensive', damage: 6, desc: 'Targeted shot that maintains pressure.' },
      { id: 'trap', name: 'Trap', type: 'special', damage: null, desc: 'Battlefield control; restricts or disrupts an opponent who triggers it.' },
      { id: 'beast_strike', name: 'Beast Strike', type: 'offensive', damage: 10, desc: 'Powerful beast-inspired attack.' },
      { id: 'prey_lock', name: 'Prey Lock', type: 'special', damage: null, desc: 'Target control; marks an opponent to maintain focus.' },
      { id: 'hunters_fury', name: 'Hunter\u2019s Fury', type: 'offensive', damage: 20, desc: 'Powerful release of the Hunter\u2019s offensive capability.' },
      { id: 'apex_shot', name: 'Apex Shot', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate precision attack.' }
    ]
  },
  {
    id: 'dragon_knight',
    name: 'Dragon Knight',
    specialization: 'Dragon power, physical attacks, and defense.',
    moves: [
      { id: 'dragon_strike', name: 'Dragon Strike', type: 'offensive', damage: 7, desc: 'Dragon-enhanced strike.' },
      { id: 'draconic_guard', name: 'Draconic Guard', type: 'defensive', damage: null, desc: 'Defense; defensive layer using dragon energy.' },
      { id: 'dragon_rush', name: 'Dragon Rush', type: 'offensive', damage: 10, desc: 'Rapid dragon-powered forward attack.' },
      { id: 'dragonscale', name: 'Dragonscale', type: 'defensive', damage: null, desc: 'Defense boost; temporarily increases defensive strength.' },
      { id: 'dragon_fury', name: 'Dragon Fury', type: 'offensive', damage: 15, desc: 'Powerful dragon-enhanced attack.' },
      { id: 'draconic_roar', name: 'Draconic Roar', type: 'special', damage: null, desc: 'Attack/control; roar that disrupts or weakens opponents.' },
      { id: 'dragon_ascension', name: 'Dragon Ascension', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate dragon-powered attack.' }
    ]
  },
  {
    id: 'holy_knight',
    name: 'Holy Knight',
    specialization: 'Holy energy, protection, healing, and judgment.',
    moves: [
      { id: 'holy_slash', name: 'Holy Slash', type: 'offensive', damage: 5, desc: 'Basic holy-energy attack.' },
      { id: 'holy_guard', name: 'Holy Guard', type: 'defensive', damage: null, desc: 'Protection; creates a protective holy barrier.' },
      { id: 'heal', name: 'Heal', type: 'support', damage: null, heal: 5, desc: 'Restores 5 HP to the selected player.' },
      { id: 'blessing', name: 'Blessing', type: 'support', damage: null, desc: 'Defense boost; temporarily increases the selected player\u2019s defense.' },
      { id: 'holy_strike', name: 'Holy Strike', type: 'offensive', damage: 12, desc: 'Powerful holy-energy attack.' },
      { id: 'greater_heal', name: 'Greater Heal', type: 'support', damage: null, heal: 15, desc: 'Restores 15 HP to the selected player.' },
      { id: 'divine_judgment', name: 'Divine Judgment', type: 'offensive', damage: 25, ultimate: true, desc: 'Ultimate holy attack.' }
    ]
  },
  {
    id: 'necromancer',
    name: 'Necromancer',
    specialization: 'Dark magic, curses, life drain, and undead forces.',
    moves: [
      { id: 'dark_bolt', name: 'Dark Bolt', type: 'offensive', damage: 5, desc: 'Dark-energy projectile.' },
      { id: 'curse', name: 'Curse', type: 'special', damage: null, desc: 'Debuff; applies a negative effect to an opponent.' },
      { id: 'life_drain', name: 'Life Drain', type: 'offensive', damage: 7, drain: true, desc: 'Deals damage and restores a small amount of vitality to the Necromancer.' },
      { id: 'soul_chain', name: 'Soul Chain', type: 'special', damage: null, desc: 'Control; restricts an opponent.' },
      { id: 'death_burst', name: 'Death Burst', type: 'offensive', damage: 14, desc: 'Destructive dark-energy burst.' },
      { id: 'undead_army', name: 'Undead Army', type: 'special', damage: null, summon: true, desc: 'Summoning; summons undead forces to assist in combat.' },
      { id: 'soul_overlord', name: 'Soul Overlord', type: 'offensive', damage: 26, ultimate: true, desc: 'Ultimate soul-based attack.' }
    ]
  },
  {
    id: 'summoner',
    name: 'Summoner',
    specialization: 'Summoning creatures and controlling summoned allies.',
    moves: [
      { id: 'spirit_shot', name: 'Spirit Shot', type: 'offensive', damage: 4, desc: 'Spiritual-energy projectile.' },
      { id: 'summon_wolf', name: 'Summon Wolf', type: 'special', damage: null, summon: true, desc: 'Summoning; wolf assists with offensive attacks.' },
      { id: 'summon_hawk', name: 'Summon Hawk', type: 'special', damage: null, summon: true, desc: 'Summoning/support; hawk provides ranged support.' },
      { id: 'beast_charge', name: 'Beast Charge', type: 'offensive', damage: 9, desc: 'Commands a summoned beast to charge.' },
      { id: 'summon_knight', name: 'Summon Knight', type: 'special', damage: null, summon: true, desc: 'Summoning/defense; knight provides defensive support.' },
      { id: 'beast_storm', name: 'Beast Storm', type: 'offensive', damage: 19, desc: 'Coordinated attack by summoned beasts.' },
      { id: 'ancient_guardian', name: 'Ancient Guardian', type: 'special', damage: null, summon: true, ultimate: true, desc: 'Ultimate summon; summons a powerful guardian to assist in combat.' }
    ]
  },
  {
    id: 'spellblade',
    name: 'Spellblade',
    specialization: 'Swordsmanship combined with elemental and arcane magic.',
    moves: [
      { id: 'arcane_slash', name: 'Arcane Slash', type: 'offensive', damage: 5, desc: 'Arcane-enhanced sword attack.' },
      { id: 'flame_cut', name: 'Flame Cut', type: 'offensive', damage: 7, desc: 'Fire-enhanced sword strike.' },
      { id: 'frost_cut', name: 'Frost Cut', type: 'offensive', damage: 7, desc: 'Ice-enhanced sword strike.' },
      { id: 'mana_rush', name: 'Mana Rush', type: 'offensive', damage: 10, desc: 'Rapid magical attack.' },
      { id: 'spellbreaker', name: 'Spellbreaker', type: 'offensive', damage: 14, desc: 'Disrupts magical defenses.' },
      { id: 'arcane_edge', name: 'Arcane Edge', type: 'offensive', damage: 21, desc: 'Concentrated arcane sword attack.' },
      { id: 'dimensional_cut', name: 'Dimensional Cut', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate dimensional cutting technique.' }
    ]
  },
  {
    id: 'royal_mage',
    name: 'Royal Mage',
    specialization: 'High-level magic, magical defense, and large-scale spells.',
    moves: [
      { id: 'royal_bolt', name: 'Royal Bolt', type: 'offensive', damage: 7, desc: 'Royal-magic projectile.' },
      { id: 'royal_flame', name: 'Royal Flame', type: 'offensive', damage: 9, desc: 'Powerful fire attack.' },
      { id: 'royal_barrier', name: 'Royal Barrier', type: 'defensive', damage: null, desc: 'Defense; magical barrier that reduces incoming damage.' },
      { id: 'royal_storm', name: 'Royal Storm', type: 'offensive', damage: 13, desc: 'Storm of magical energy.' },
      { id: 'grand_spell', name: 'Grand Spell', type: 'offensive', damage: 17, desc: 'Advanced spell with concentrated force.' },
      { id: 'royal_cataclysm', name: 'Royal Cataclysm', type: 'offensive', damage: 23, desc: 'Devastating large-scale magical attack.' },
      { id: 'kingdom_fall', name: 'Kingdom Fall', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate royal-magic technique.' }
    ]
  },
  {
    id: 'arcane_warrior',
    name: 'Arcane Warrior',
    specialization: 'Arcane energy, magical weapons, and physical combat.',
    moves: [
      { id: 'arcane_strike', name: 'Arcane Strike', type: 'offensive', damage: 6, desc: 'Arcane-enhanced physical attack.' },
      { id: 'mana_blade', name: 'Mana Blade', type: 'offensive', damage: 8, desc: 'Creates a magical blade.' },
      { id: 'arcane_guard', name: 'Arcane Guard', type: 'defensive', damage: null, desc: 'Defense; uses arcane energy to reduce incoming damage.' },
      { id: 'warrior_burst', name: 'Warrior Burst', type: 'offensive', damage: 12, desc: 'Concentrated energy attack.' },
      { id: 'runic_crush', name: 'Runic Crush', type: 'offensive', damage: 15, desc: 'Rune-powered crushing attack.' },
      { id: 'arcane_annihilation', name: 'Arcane Annihilation', type: 'offensive', damage: 22, desc: 'Powerful overwhelming arcane attack.' },
      { id: 'transcendent_blade', name: 'Transcendent Blade', type: 'offensive', damage: 27, ultimate: true, desc: 'Ultimate arcane-enhanced weapon technique.' }
    ]
  }
]

/*
 * LEGACY CLASSES — kept so existing players are not orphaned.
 *
 * The live bot shipped with four classes: fighter, guardian, assassin, mystic.
 * Two of those (guardian, assassin) exist in the official roster under the same
 * name, so those players map cleanly. `fighter` and `mystic` do NOT appear in
 * the 20-class roster at all.
 *
 * The note says: "Do not silently overwrite player-owned data or existing
 * approved definitions." Reassigning a Fighter to Swordsman would be exactly
 * that — a silent class change. So both are preserved as legacy classes with
 * their original single move, and the owner can migrate those players
 * deliberately with `!classadmin set`.
 */
const LEGACY_CLASSES = [
  {
    id: 'fighter',
    name: 'Fighter',
    legacy: true,
    specialization: 'Balanced striker. Reliable damage. (Legacy class, kept for existing players.)',
    moves: [
      { id: 'cleaving_strike', name: 'Cleaving Strike', type: 'offensive', damage: 26, cost: 12, desc: 'Legacy Fighter class move.' }
    ]
  },
  {
    id: 'mystic',
    name: 'Mystic',
    legacy: true,
    specialization: 'Strong class moves, weaker basics. (Legacy class, kept for existing players.)',
    moves: [
      { id: 'arcane_lance', name: 'Arcane Lance', type: 'offensive', damage: 34, cost: 18, desc: 'Legacy Mystic class move.' }
    ]
  }
]

const ALL_CLASSES = [...OFFICIAL_CLASSES, ...LEGACY_CLASSES]

/* Flat move index, built once. */
const MOVE_INDEX = new Map()
for (const c of ALL_CLASSES) {
  for (const mv of c.moves) {
    MOVE_INDEX.set(`${c.id}:${mv.id}`, { ...mv, class_id: c.id, class_name: c.name })
  }
}

/** Normalises a stored class value to a catalogue id. */
function normalizeClassId (value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const lower = raw.toLowerCase().replace(/[\s-]+/g, '_')
  if (ALL_CLASSES.some(c => c.id === lower)) return lower
  /* Display-name match, so 'Battle Mage' and 'battle_mage' both resolve. */
  const byName = ALL_CLASSES.find(c => c.name.toLowerCase() === raw.toLowerCase())
  return byName ? byName.id : null
}

function classById (id) {
  const key = normalizeClassId(id)
  return key ? ALL_CLASSES.find(c => c.id === key) || null : null
}

function movesForClass (id) {
  const c = classById(id)
  return c ? c.moves.map(mv => ({ ...mv, class_id: c.id, class_name: c.name })) : []
}

function moveById (classId, moveId) {
  const cid = normalizeClassId(classId)
  if (!cid) return null
  return MOVE_INDEX.get(`${cid}:${String(moveId || '').trim().toLowerCase()}`) || null
}

/** Finds a move by its display name inside a class, for `!classmove Soul Cut`. */
function moveByName (classId, name) {
  const want = String(name || '').trim().toLowerCase()
  if (!want) return null
  return movesForClass(classId).find(mv => mv.name.toLowerCase() === want) || null
}

/* -------------------------------------------------------------- validation */

/*
 * Section 5 — every condition checked on the server, in order, before a move
 * runs. Returns { ok: true } or { ok: false, reason, message }.
 *
 * `reason` is a stable machine code (used by tests and the audit log);
 * `message` is what the player sees.
 */
function validateMoveUse ({
  player,
  move,
  mastery = 0,
  usesToday = 0,
  dailyLimit = 3,
  inBattle = false,
  energy = null,
  targetRequired = false,
  target = null
} = {}) {
  if (!player) return { ok: false, reason: 'no_player', message: 'You have not arisen yet. Use !arise.' }

  const classId = normalizeClassId(player.class)
  if (!classId) {
    return { ok: false, reason: 'no_class', message: 'You have no class assigned. Ask AXYON to assign one.' }
  }
  if (!move) return { ok: false, reason: 'no_move', message: 'That move does not exist.' }
  if (normalizeClassId(move.class_id) !== classId) {
    return { ok: false, reason: 'wrong_class', message: `*${move.name}* belongs to another class.` }
  }
  if (move.enabled === false) {
    return { ok: false, reason: 'disabled', message: `*${move.name}* is disabled.` }
  }
  if (move.unlock != null && Number(mastery) < Number(move.unlock)) {
    return {
      ok: false,
      reason: 'locked',
      message: `*${move.name}* unlocks at *${Number(move.unlock).toLocaleString('en-US')}* class mastery.`
    }
  }
  if (!inBattle) {
    return { ok: false, reason: 'no_battle', message: 'You are not in a battle.' }
  }
  if (targetRequired && !target) {
    return { ok: false, reason: 'no_target', message: `*${move.name}* needs a target.` }
  }
  if (Number(usesToday) >= Number(dailyLimit)) {
    return {
      ok: false,
      reason: 'daily_limit',
      message: `You have used all *${dailyLimit}* class moves today. Resets at 00:00 UTC.`
    }
  }
  const cost = Number(move.cost) || 0
  if (energy != null && cost > 0 && Number(energy) < cost) {
    return {
      ok: false,
      reason: 'energy',
      message: `Not enough Power Energy. *${move.name}* costs *${cost}*, you have *${Number(energy)}*.`
    }
  }
  return { ok: true, reason: null, message: null, cost }
}

/** Mastery awarded for an action, or 0 while the award values are pending. */
function masteryFor (action) {
  const v = BALANCE.masteryAward[action]
  return Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0
}

/** True when the owner has not yet approved the mastery award values. */
function masteryAwardPending () {
  return BALANCE.masteryAward.classMove == null && BALANCE.masteryAward.battleWin == null
}

module.exports = {
  CLASS_GRADES,
  MAX_MASTERY,
  BALANCE,
  setBalance,
  classGradeFor,
  masteryProgress,
  classDamage,
  masteryFor,
  masteryAwardPending,
  OFFICIAL_CLASSES,
  LEGACY_CLASSES,
  ALL_CLASSES,
  normalizeClassId,
  classById,
  movesForClass,
  moveById,
  moveByName,
  validateMoveUse
}
