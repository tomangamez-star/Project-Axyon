'use strict'

/*
 * COMMAND COMBINATIONS (CC)
 * Combo ownership is per-player. Knowing a recipe or seeing it in a group
 * does not grant permission to execute it.
 */
const CATALOGUE = [
  {
    key: 'soul_drain_heavy',
    name: 'Soul Drain: Heavy Fusion',
    description: 'Soul Drain deals its 40 damage and restores 40 HP, then Heavy adds its normal heavy-attack damage.',
    recipe: ['power', 'ability_drain', 'heavy'],
    abilityKey: 'ability_drain',
    energyCost: 35,
    price: 3000,
    requiredLevel: 10,
    trainingChance: 0.2
  }
]

function get (key) {
  const value = String(key || '').trim().toLowerCase()
  return CATALOGUE.find(combo => combo.key === value || combo.name.toLowerCase() === value) || null
}

function parseRecipe (tokens = []) {
  const cleaned = tokens
    .map(token => String(token || '').replace(/^[/!]/, '').toLowerCase())
    .filter(token => token && token !== '+')
  const [first, second, third] = cleaned.length === 2
    ? ['power', cleaned[0], cleaned[1]]
    : cleaned
  if (first === 'power' && third === 'heavy') {
    const combo = CATALOGUE.find(entry => entry.recipe[0] === 'power' && entry.recipe[1] === second && entry.recipe[2] === 'heavy')
    return combo || null
  }
  return null
}

function rollDiscovery (random = Math.random, chance = 0.2) {
  return Number(random()) < Number(chance)
}

module.exports = { CATALOGUE, get, parseRecipe, rollDiscovery }
