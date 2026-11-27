'use strict'

/*
 * Shared combat-stat formulas. These functions are deliberately pure so the
 * stage/floor engine and direct duels use exactly the same calculations.
 */

const BASE_STATS = Object.freeze({ str: 5, per: 5, sta: 5, vit: 5, fatigue: 0 })
const FATIGUE_MAX = 100
const FATIGUE_RECOVERY_MINUTES = 15
const VITALITY_HP_PER_POINT = 5

const FATIGUE_COSTS = Object.freeze({
  attack: 5,
  heavy: 12,
  dodge: 10,
  block: 5,
  attack_dodge: 12,
  attack_block: 10,
  dodge_attack: 12,
  heavy_block: 17,
  heavy_dodge: 17,
  power_attack: 7,
  power_heavy: 15,
  power_block: 7,
  power_dodge: 10
})

function stat (player, key) {
  const value = Number(player?.[key])
  return Number.isFinite(value) && value > 0 ? value : BASE_STATS[key] || 5
}

function fatigueValue (value) {
  return Math.max(0, Math.min(FATIGUE_MAX, Math.floor(Number(value) || 0)))
}

/** Fatigue reduces physical output. STA dampens the penalty. */
function fatiguePenalty (player, currentFatigue = player?.fatigue) {
  const fatigue = fatigueValue(currentFatigue)
  const sta = stat(player, 'sta')
  return Math.max(0, Math.min(0.45, (fatigue / FATIGUE_MAX) * (5 / sta) * 0.30))
}

function applyFatiguePenalty (amount, player, currentFatigue = player?.fatigue) {
  const raw = Math.max(0, Number(amount) || 0)
  const reduced = raw * (1 - fatiguePenalty(player, currentFatigue))
  // Fatigue can never cut a physical action below half of its fatigue-free damage.
  return Math.max(raw * 0.5, reduced)
}

/** STA reduces how much exhaustion each physical action adds. */
function addFatigue (current, action, player) {
  const base = FATIGUE_COSTS[action] ?? 0
  if (!base) return fatigueValue(current)
  const staminaReduction = Math.max(0, Math.min(0.45, (stat(player, 'sta') - 5) * 0.015))
  const gain = Math.max(1, Math.ceil(base * (1 - staminaReduction)))
  return Math.min(FATIGUE_MAX, fatigueValue(current) + gain)
}

/**
 * Perfect dodges are intentionally rare. PER helps read an incoming move,
 * SPD helps execute the movement, STA limits the effect of fatigue.
 * Partial dodges avoid some damage; failed dodges receive the full hit.
 */
function dodgeChances (player, currentFatigue = player?.fatigue, bonus = 0) {
  const per = stat(player, 'per')
  const spd = stat(player, 'spd')
  const fatigue = fatiguePenalty(player, currentFatigue)
  const perfect = Math.max(0.01, Math.min(0.30,
    0.03 + (per - 5) * 0.0055 + (spd - 5) * 0.0045 - fatigue * 0.18 + Math.max(0, Number(bonus) || 0) * 0.5))
  const rawPartial = Math.max(0.05, Math.min(0.72,
    0.18 + (per - 5) * 0.013 + (spd - 5) * 0.011 - fatigue * 0.55 + Math.max(0, Number(bonus) || 0) * 0.5))
  const partial = Math.min(rawPartial, Math.max(0, 0.95 - perfect))
  return { perfect, partial, total: perfect + partial }
}

function resolveDodge (player, currentFatigue = player?.fatigue, roll = Math.random(), bonus = 0) {
  const chances = dodgeChances(player, currentFatigue, bonus)
  const value = Math.max(0, Math.min(0.999999, Number(roll) || 0))
  if (value < chances.perfect) return { result: 'perfect', damageMultiplier: 0, chances }
  if (value < chances.perfect + chances.partial) return { result: 'partial', damageMultiplier: 0.45, chances }
  return { result: 'failed', damageMultiplier: 1, chances }
}

/** VIT improves all restorative effects without changing existing HP caps. */
function healingBonus (player, baseAmount) {
  const base = Math.max(0, Math.floor(Number(baseAmount) || 0))
  if (!base) return 0
  return Math.floor(Math.max(0, stat(player, 'vit') - 5) / 3)
}

function enhancedHealing (player, baseAmount) {
  const base = Math.max(0, Math.floor(Number(baseAmount) || 0))
  return base + healingBonus(player, base)
}

function vitalityHpGain (player) {
  // The existing player's max HP is never recalculated. This only applies to
  // the explicit act of training VIT after this patch.
  return VITALITY_HP_PER_POINT
}

module.exports = {
  BASE_STATS,
  FATIGUE_MAX,
  FATIGUE_RECOVERY_MINUTES,
  VITALITY_HP_PER_POINT,
  FATIGUE_COSTS,
  stat,
  fatigueValue,
  fatiguePenalty,
  applyFatiguePenalty,
  addFatigue,
  dodgeChances,
  resolveDodge,
  healingBonus,
  enhancedHealing,
  vitalityHpGain
}
