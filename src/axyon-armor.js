'use strict'
/*
 * ARMOR COMBAT HELPERS
 * --------------------
 * Kept in its own module so all four combat paths — solo, party, duel and the
 * NPC side — reduce damage through exactly ONE formula. When the two sides
 * disagree, armor stops being a balance decision and starts being a bug.
 *
 * Rules, deliberately simple:
 *   • A worn suit absorbs `protection` from every incoming hit.
 *   • Absorption never makes a hit negative, and it never reduces a hit to 0
 *     unless the protection alone covers it (so heavy enemies still hurt).
 *   • Durability is spent once per COMPLETED battle, not per hit. Spending it
 *     per hit would let a player farm `!rest` by taking cheap hits in one long
 *     fight, and would drain a tier-1 suit in a single encounter.
 */

const store = require('./axyon-store')

/**
 * Reduce one incoming hit by the worn suit's protection.
 *
 * Pure: it takes the armor row and returns numbers. It never writes, so it is
 * safe to call while resolving a turn that might still be rejected.
 *
 * @param {number} damage raw incoming damage
 * @param {object|null} armor the worn suit (or null)
 * @returns {{ damage: number, absorbed: number }}
 */
function absorb (damage, armor) {
  const raw = Math.max(0, Number(damage) || 0)
  if (!armor || armor.broken || !armor.equipped) return { damage: raw, absorbed: 0 }
  const protection = Math.max(0, Number(armor.protection) || 0)
  const absorbed = Math.min(raw, protection)
  return { damage: Math.max(0, raw - absorbed), absorbed }
}

/**
 * Load the worn suit for a batch of players in one go.
 *
 * Party and guild battles resolve several players per turn, so this avoids a
 * query per player. Players without a suit simply have no entry.
 *
 * @param {string[]} userIds
 * @returns {Promise<Map<string, object>>}
 */
async function wornBy (userIds = []) {
  const out = new Map()
  await Promise.all((userIds || []).map(async id => {
    const suit = await store.equippedArmor(id).catch(() => null)
    if (suit) out.set(String(id), suit)
  }))
  return out
}

/**
 * Spend one point of durability after a completed battle.
 *
 * Call once per battle per player, at the point the battle is marked
 * complete — never per turn, and never for a battle the player retreats from
 * before it is decided.
 *
 * @returns {Promise<object|null>} the suit after wear, or null
 */
async function wearAfterBattle (userId) {
  return store.wearArmor(userId, 1).catch(() => null)
}

/** One-line status for the battle HUD, or '' when nothing is worn. */
function hudLine (armor) {
  if (!armor || armor.broken) return ''
  return `\ud83d\udee1\ufe0f Armor T${armor.tier} \u00b7 ${armor.durability}/${armor.maxDurability}`
}

module.exports = { absorb, wornBy, wearAfterBattle, hudLine }
