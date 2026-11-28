'use strict'

const combatMechanics = require('./axyon-combat-mechanics')
/*
 * ITEMS AND ABILITIES — the shop catalogue.
 *
 * Pure data plus pure functions. No database, no network, no randomness that
 * changes between calls, so the shop renders identically every time and the
 * tests can assert exact prices.
 *
 * TWO KINDS
 * ---------
 *   item     — a consumable. Bought with Zen, held in the inventory, used with
 *              `!use <key>`. Some work anywhere, some only inside a battle.
 *   ability  — a permanent unlock. Bought once, then usable in any battle with
 *              `!use <key>`; it does not get consumed.
 *
 * EVERYTHING HERE IS MODE-AGNOSTIC. The shop and the inventory are reachable in
 * all four game modes (combat, duels, dungeon, general) — that is a deliberate
 * rule, not an oversight, so nothing in this file is gated by mode.
 */

const ITEMS = {
  /* ------------------------------------------------------------- healing */
  potion: {
    key: 'potion',
    name: 'Healing Potion',
    icon: '\ud83e\uddea',
    kind: 'item',
    price: 150,
    desc: 'Restores 40% of your maximum HP.',
    battleOnly: false,
    effect: { healPct: 0.4 }
  },
  elixir: {
    key: 'elixir',
    name: 'Greater Elixir',
    icon: '\u2697\ufe0f',
    kind: 'item',
    price: 400,
    desc: 'Restores 100% of your maximum HP.',
    battleOnly: false,
    effect: { healPct: 1 }
  },
  energy: {
    key: 'energy',
    name: 'Energy Cell',
    icon: '\ud83d\udd0b',
    kind: 'item',
    price: 250,
    desc: 'Restores 60 Power Energy.',
    battleOnly: false,
    effect: { energy: 60 }
  },
  mp_refiller: {
    key: 'mp_refiller',
    name: 'MP Refiller',
    icon: '\ud83d\udd2e',
    kind: 'item',
    price: 500,
    currency: 'zen',
    desc: 'Restores 50 MP. MP does not regenerate naturally.',
    battleOnly: false,
    effect: { mp: 50 }
  },

  /* ------------------------------------------------------------- battle */
  bomb: {
    key: 'bomb',
    name: 'Gate Bomb',
    icon: '\ud83d\udca3',
    kind: 'item',
    price: 300,
    desc: 'Deals 45 damage to the enemy. Battle only.',
    battleOnly: true,
    effect: { damage: 45 }
  },
  shield: {
    key: 'shield',
    name: 'Aegis Charm',
    icon: '\ud83d\udee1\ufe0f',
    kind: 'item',
    price: 220,
    desc: 'Halves the next enemy hit. Battle only.',
    battleOnly: true,
    effect: { guard: 0.5 }
  },
  revive: {
    key: 'revive',
    name: 'Phoenix Ash',
    icon: '\ud83d\udd25',
    kind: 'item',
    price: 900,
    desc: 'Survives one killing blow at 30% HP. Battle only.',
    battleOnly: true,
    effect: { revive: 0.3 }
  },

  /* ---------------------------------------------------------- abilities */
  ability_slash: {
    key: 'ability_slash',
    name: 'Void Slash',
    icon: '\ud83d\udde1\ufe0f',
    kind: 'ability',
    price: 1200,
    desc: 'Permanent. A 60-damage strike; costs 27 MP.',
    mpCost: 27,
    battleOnly: true,
    effect: { damage: 60 }
  },
  ability_drain: {
    key: 'ability_drain',
    name: 'Soul Drain',
    icon: '\ud83e\ude78',
    kind: 'ability',
    price: 1800,
    desc: 'Permanent. 40 damage and 40 HP recovery; costs 38 MP.',
    mpCost: 38,
    battleOnly: true,
    effect: { damage: 40, lifesteal: true }
  },
  ability_bulwark: {
    key: 'ability_bulwark',
    name: 'Iron Bulwark',
    icon: '\ud83d\udee1\ufe0f',
    kind: 'ability',
    price: 1500,
    desc: 'Permanent. Blocks 70% of the next enemy hit; costs 30 MP.',
    mpCost: 30,
    battleOnly: true,
    effect: { guard: 0.7 }
  }
}

const KEYS = Object.keys(ITEMS)

function get (key) {
  return ITEMS[String(key || '').toLowerCase()] || null
}

/** The shop, in a stable order: consumables first, then abilities. */
function catalogue () {
  return KEYS.map(k => ITEMS[k]).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'item' ? -1 : 1
    return a.price - b.price
  })
}

function items () { return catalogue().filter(x => x.kind === 'item') }
function abilities () { return catalogue().filter(x => x.kind === 'ability') }

/**
 * Applies an item's effect to a battle state.
 *
 * Returns `{ ok, note, battle, player }` — never throws, and never mutates the
 * inputs, so a caller that rejects the use (no stock, wrong context) has
 * nothing to roll back.
 *
 * @param entry   catalogue entry
 * @param battle  active battle object, or null outside a battle
 * @param player  player object
 */
function apply (entry, battle, player) {
  if (!entry) return { ok: false, note: 'Unknown item.' }
  const e = entry.effect || {}
  const b = battle ? { ...battle } : null
  const p = { ...player }
  const notes = []

  if (entry.battleOnly && !b) {
    return { ok: false, note: `*${entry.name}* only works inside a battle.` }
  }

  const mpCost = Math.max(0, Math.floor(Number(entry.mpCost) || 0))
  if (mpCost) {
    const currentMp = Math.max(0, Number(b ? b.mp : p.mp) || 0)
    if (currentMp < mpCost) {
      return { ok: false, note: `*${entry.name}* costs *${mpCost} MP*. You have *${currentMp} MP*.` }
    }
    if (b) b.mp = currentMp - mpCost
    else p.mp = currentMp - mpCost
    notes.push(`\ud83d\udd2e -${mpCost} MP`)
  }

  if (e.healPct) {
    const amount = combatMechanics.enhancedHealing(p, Math.round(p.maxHp * e.healPct))
    if (b) {
      const before = b.playerHp
      b.playerHp = Math.min(p.maxHp, b.playerHp + amount)
      notes.push(`\u2764\ufe0f Recovered *${b.playerHp - before}* HP.`)
    } else {
      const before = p.hp
      p.hp = Math.min(p.maxHp, p.hp + amount)
      notes.push(`\u2764\ufe0f Recovered *${p.hp - before}* HP.`)
    }
  }

  if (e.energy) {
    if (b) {
      const before = b.energy
      b.energy = Math.min(p.maxPowerEnergy, b.energy + e.energy)
      notes.push(`\ud83d\udd0b Power Energy *+${b.energy - before}*.`)
    } else {
      const before = p.powerEnergy
      p.powerEnergy = Math.min(p.maxPowerEnergy, p.powerEnergy + e.energy)
      notes.push(`\ud83d\udd0b Power Energy *+${p.powerEnergy - before}*.`)
    }
  }

  if (e.mp) {
    const maxMp = Math.max(0, Number(p.maxMp) || 0)
    if (maxMp <= 0) return { ok: false, note: 'Your MP tank unlocks at Level 10.' }
    if (b) {
      const before = Math.max(0, Number(b.mp ?? p.mp) || 0)
      if (before >= maxMp) return { ok: false, note: 'Your MP tank is already full.' }
      b.mp = Math.min(maxMp, before + Number(e.mp))
      notes.push(`\ud83d\udd2e MP *+${b.mp - before}*.`)
    } else {
      const before = Math.max(0, Number(p.mp) || 0)
      if (before >= maxMp) return { ok: false, note: 'Your MP tank is already full.' }
      p.mp = Math.min(maxMp, before + Number(e.mp))
      notes.push(`\ud83d\udd2e MP *+${p.mp - before}*.`)
    }
  }

  if (e.damage) {
    b.enemyHp = Math.max(0, b.enemyHp - e.damage)
    notes.push(`\ud83d\udca5 Dealt *${e.damage}* damage.`)
    if (e.lifesteal) {
      const before = b.playerHp
      b.playerHp = Math.min(p.maxHp, b.playerHp + combatMechanics.enhancedHealing(p, e.damage))
      notes.push(`\ud83e\ude78 Drained *${b.playerHp - before}* HP.`)
    }
  }

  if (e.guard) {
    b.guard = e.guard
    notes.push(`\ud83d\udee1\ufe0f Guarding \u2014 the next hit is reduced by *${Math.round(e.guard * 100)}%*.`)
  }

  if (e.revive) {
    b.reviveAt = e.revive
    notes.push(`\ud83d\udd25 Phoenix Ash armed \u2014 you survive one killing blow.`)
  }

  return { ok: true, note: notes.join('\n'), battle: b, player: p }
}

module.exports = { ITEMS, KEYS, get, catalogue, items, abilities, apply }
