'use strict'

/*
 * COMMAND COMBINATIONS (CC)
 * Each recipe is ordered. Seeing a combo in a group does not unlock it for
 * another player; ownership remains a per-player database record.
 */
const CATALOGUE = [
  {
    key: 'attack_dodge',
    name: 'Slipstream Strike',
    category: 'Evasive Offense',
    description: 'A lighter strike that leaves you ready to evade the enemy counter.',
    recipe: ['attack', 'dodge'],
    effect: 'attack_dodge',
    attackMultiplier: 0.8,
    evade: true,
    energyCost: 8,
    fatigueCost: 'attack_dodge',
    price: 1400,
    requiredLevel: 3,
    trainingChance: 0.2
  },
  {
    key: 'dodge_attack',
    name: 'Ghost Counter',
    category: 'Evasive Offense',
    description: 'Move first, then counter with a controlled strike while the next incoming attack is easier to read.',
    recipe: ['dodge', 'attack'],
    effect: 'dodge_attack',
    attackMultiplier: 0.7,
    evade: true,
    dodgeBonus: 0.06,
    energyCost: 10,
    fatigueCost: 'dodge_attack',
    price: 1900,
    requiredLevel: 5,
    trainingChance: 0.2
  },
  {
    key: 'attack_block',
    name: 'Guarded Assault',
    category: 'Balanced Offense',
    description: 'Trade a little attack power for a guarded response to the counter.',
    recipe: ['attack', 'block'],
    effect: 'attack_block',
    attackMultiplier: 0.85,
    guard: 0.66,
    energyCost: 12,
    fatigueCost: 'attack_block',
    price: 1600,
    requiredLevel: 4,
    trainingChance: 0.2
  },
  {
    key: 'block_attack',
    name: 'Bastion Counter',
    category: 'Defensive Offense',
    description: 'Raise your guard first, then answer with a measured strike.',
    recipe: ['block', 'attack'],
    effect: 'block_attack',
    attackMultiplier: 0.75,
    guard: 0.72,
    energyCost: 12,
    fatigueCost: 'attack_block',
    price: 1800,
    requiredLevel: 5,
    trainingChance: 0.2
  },
  {
    key: 'heavy_block',
    name: 'Bulwark Breaker',
    category: 'Heavy Defense',
    description: 'A controlled heavy strike followed by a reinforced block.',
    recipe: ['heavy', 'block'],
    effect: 'heavy_block',
    attackMultiplier: 1.4,
    guard: 0.78,
    energyCost: 25,
    fatigueCost: 'heavy_block',
    price: 2800,
    requiredLevel: 8,
    trainingChance: 0.2
  },
  {
    key: 'heavy_dodge',
    name: 'Recoil Step',
    category: 'Heavy Evasion',
    description: 'A reduced heavy strike that commits your movement to evading the counter.',
    recipe: ['heavy', 'dodge'],
    effect: 'heavy_dodge',
    attackMultiplier: 1.35,
    evade: true,
    energyCost: 24,
    fatigueCost: 'heavy_dodge',
    price: 3000,
    requiredLevel: 9,
    trainingChance: 0.2
  },
  {
    key: 'soul_drain_heavy',
    name: 'Soul Drain: Heavy Fusion',
    category: 'Power Fusion',
    description: 'Soul Drain deals its full damage and restores HP, then Heavy adds its normal heavy-attack damage.',
    recipe: ['power', 'ability_drain', 'heavy'],
    abilityKey: 'ability_drain',
    effect: 'power_heavy',
    powerMultiplier: 1,
    attackMultiplier: 1.65,
    energyCost: 35,
    fatigueCost: 'power_heavy',
    price: 3000,
    requiredLevel: 10,
    trainingChance: 0.2
  },
  {
    key: 'soul_drain_attack',
    name: 'Soul Drain: Quickstrike',
    category: 'Power Fusion',
    description: 'A reduced Soul Drain combined with a quick physical strike and partial recovery.',
    recipe: ['power', 'ability_drain', 'attack'],
    abilityKey: 'ability_drain',
    effect: 'power_attack',
    powerMultiplier: 0.7,
    attackMultiplier: 0.7,
    energyCost: 27,
    fatigueCost: 'power_attack',
    price: 2600,
    requiredLevel: 8,
    trainingChance: 0.2
  },
  {
    key: 'void_slash_attack',
    name: 'Void Slash: Follow-through',
    category: 'Power Fusion',
    description: 'A shortened Void Slash that flows into a lighter follow-up attack.',
    recipe: ['power', 'ability_slash', 'attack'],
    abilityKey: 'ability_slash',
    effect: 'power_attack',
    powerMultiplier: 0.7,
    attackMultiplier: 0.7,
    energyCost: 30,
    fatigueCost: 'power_attack',
    price: 2800,
    requiredLevel: 9,
    trainingChance: 0.2
  },
  {
    key: 'void_slash_heavy',
    name: 'Void Slash: Rupture',
    category: 'Power Fusion',
    description: 'A full Void Slash reinforced by a controlled heavy strike.',
    recipe: ['power', 'ability_slash', 'heavy'],
    abilityKey: 'ability_slash',
    effect: 'power_heavy',
    powerMultiplier: 1,
    attackMultiplier: 1.4,
    energyCost: 40,
    fatigueCost: 'power_heavy',
    price: 4200,
    requiredLevel: 15,
    trainingChance: 0.2
  },
  {
    key: 'iron_bulwark_attack',
    name: 'Iron Bulwark: Advancing Guard',
    category: 'Power Defense',
    description: 'Advance behind Iron Bulwark and strike with reduced force while retaining protection.',
    recipe: ['power', 'ability_bulwark', 'attack'],
    abilityKey: 'ability_bulwark',
    effect: 'power_attack',
    powerMultiplier: 1,
    attackMultiplier: 0.7,
    guard: 0.7,
    energyCost: 26,
    fatigueCost: 'power_attack',
    price: 3200,
    requiredLevel: 10,
    trainingChance: 0.2
  },
  {
    key: 'iron_bulwark_block',
    name: 'Iron Bulwark: Fortress',
    category: 'Power Defense',
    description: 'Layer Iron Bulwark with a block for a stronger defensive stance.',
    recipe: ['power', 'ability_bulwark', 'block'],
    abilityKey: 'ability_bulwark',
    effect: 'power_block',
    powerMultiplier: 1,
    guard: 0.88,
    energyCost: 24,
    fatigueCost: 'power_block',
    price: 3500,
    requiredLevel: 12,
    trainingChance: 0.2
  },
  {
    key: 'soul_drain_dodge',
    name: 'Soul Drain: Phantom Veil',
    category: 'Power Evasion',
    description: 'A reduced Soul Drain that prepares you to evade the enemy counter.',
    recipe: ['power', 'ability_drain', 'dodge'],
    abilityKey: 'ability_drain',
    effect: 'power_dodge',
    powerMultiplier: 0.7,
    evade: true,
    energyCost: 28,
    fatigueCost: 'power_dodge',
    price: 3100,
    requiredLevel: 11,
    trainingChance: 0.2
  },
  {
    key: 'void_slash_dodge',
    name: 'Void Slash: Phase Cut',
    category: 'Power Evasion',
    description: 'A shortened Void Slash that leaves you prepared to slip past the counter.',
    recipe: ['power', 'ability_slash', 'dodge'],
    abilityKey: 'ability_slash',
    effect: 'power_dodge',
    powerMultiplier: 0.7,
    evade: true,
    energyCost: 30,
    fatigueCost: 'power_dodge',
    price: 3300,
    requiredLevel: 12,
    trainingChance: 0.2
  }
]

function normalizeToken (token) {
  const value = String(token || '').trim().replace(/^[/!]/, '').toLowerCase()
  if (['guard', 'defend'].includes(value)) return 'block'
  return value
}

function get (key) {
  const value = String(key || '').trim().toLowerCase()
  return CATALOGUE.find(combo => combo.key === value || combo.name.toLowerCase() === value) || null
}

function parseRecipe (tokens = []) {
  let cleaned = (Array.isArray(tokens) ? tokens : String(tokens || '').split(/\s+/))
    .map(normalizeToken)
    .filter(token => token && token !== '+')

  // A command handler for !power has already consumed the first token.
  if (cleaned.length === 2 && !['attack', 'heavy', 'dodge', 'block', 'power'].includes(cleaned[0])) {
    cleaned = ['power', ...cleaned]
  }

  return CATALOGUE.find(combo => combo.recipe.length === cleaned.length && combo.recipe.every((part, index) => part === cleaned[index])) || null
}

function formatRecipe (comboOrKey, prefix = '!') {
  const combo = typeof comboOrKey === 'string' ? get(comboOrKey) : comboOrKey
  if (!combo) return ''
  if (combo.recipe[0] === 'power') return `${prefix}power ${combo.recipe[1]} + ${prefix}${combo.recipe[2]}`
  return `${prefix}${combo.recipe[0]} + ${prefix}${combo.recipe[1]}`
}

function rollDiscovery (random = Math.random, chance = 0.2) {
  return Number(random()) < Number(chance)
}

module.exports = { CATALOGUE, get, parseRecipe, formatRecipe, rollDiscovery }
