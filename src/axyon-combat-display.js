'use strict'
/*
 * AXYN CORE — COMBAT PRESENTATION
 * ===============================
 *
 * The display half of the Complete Combat System specification.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * "The combat engine calculates and saves the real results. The message
 * templates display those results. A display must never invent statistics,
 * damage, energy costs, usage counts or rewards."
 *
 * So every function here takes already-computed values and renders them. None
 * of them rolls a die, clamps a stat, or decides an outcome. If a value is
 * missing it renders as NONE or is omitted — it is never filled with a
 * plausible-looking number.
 *
 * BARS
 * ----
 * A 20-segment bar whose filled count is derived from current/maximum. The
 * exact numbers sit beside it and are authoritative. The bar is never typed as
 * a fixed decoration, and a full bar is never shown for a combatant that has
 * lost HP or PE.
 */

const BAR_WIDTH = 20
const FILLED = '\u2588'
const EMPTY = '\u2591'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * A 20-segment progress bar.
 *
 * @param {number} current
 * @param {number} maximum
 * @returns {string} e.g. `[███████████████████░]`
 */
function bar (current, maximum, width = BAR_WIDTH) {
  const cur = Number(current)
  const max = Number(maximum)
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) {
    return `[${EMPTY.repeat(width)}]`
  }
  const ratio = clamp(cur / max, 0, 1)
  const filled = clamp(Math.round(ratio * width), 0, width)
  return `[${FILLED.repeat(filled)}${EMPTY.repeat(width - filled)}]`
}

/**
 * Percentage, rounded the way the spec's examples round (94.5 -> 95).
 * Returns 0 for a zero or missing maximum rather than NaN.
 */
function percent (current, maximum) {
  const cur = Number(current)
  const max = Number(maximum)
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return 0
  return clamp(Math.round((cur / max) * 100), 0, 100)
}

/** `520 / 550 HP  (95%)` */
function hpLine (current, maximum) {
  return `${Number(current) || 0} / ${Number(maximum) || 0} HP  (${percent(current, maximum)}%)`
}

/** `135 / 145 PE  (93%)` */
function peLine (current, maximum) {
  return `${Number(current) || 0} / ${Number(maximum) || 0} PE  (${percent(current, maximum)}%)`
}

/** The full labelled HP block: title, bar, exact line. */
function hpBlock (current, maximum) {
  return ['\u2764\ufe0f HEALTH POINTS', bar(current, maximum), hpLine(current, maximum)].join('\n')
}

/** The full labelled PE block. */
function peBlock (current, maximum) {
  return ['\u26a1 POWER ENERGY', bar(current, maximum), peLine(current, maximum)].join('\n')
}

/* ------------------------------------------------------- combatant panels */

const RULE = '\u2501'.repeat(28)

function rule (label) {
  return label ? `${RULE}\n${label}\n${RULE}` : RULE
}

/**
 * Renders one combatant panel.
 *
 * Works for a player, monster, boss or NPC. The spec is explicit that enemies
 * get the same quality of record as players, and that player-only fields must
 * not be invented for a monster — so `card` and `moves` are simply omitted when
 * the combatant has none, and `abilities` is shown instead.
 *
 * @param {object} c  a saved combatant record
 * @param {'player'|'enemy'} side
 */
function combatantPanel (c, side = 'player') {
  if (!c) return ''
  const isPlayer = side === 'player'
  const marker = isPlayer ? '\ud83d\udd34' : '\ud83d\udd35'
  const typeLabel = isPlayer ? 'PLAYER' : String(c.type || 'ENEMY').toUpperCase()
  const out = []

  out.push(rule(`${marker}  ${typeLabel} \u2014 ${String(c.name || 'UNKNOWN').toUpperCase()}`))
  out.push('')

  if (c.rank) out.push(`\ud83d\udc64 Rank: ${c.rank}`)
  if (c.level != null) out.push(`\ud83c\udfc5 Level: ${c.level}${c.grade != null ? `  |  Grade: ${c.grade}` : ''}`)
  if (c.class) out.push(`\u26a1 Class: ${c.class}`)
  if (c.title) out.push(`\ud83c\udff7\ufe0f Title: ${c.title}`)
  out.push('')

  out.push(hpBlock(c.hp, c.maxHp))
  out.push('')
  out.push(peBlock(c.pe, c.maxPe))
  out.push('')

  if (c.atk != null) out.push(`\u2694\ufe0f ATTACK: ${c.atk}`)
  if (c.def != null) out.push(`\ud83d\udee1\ufe0f DEFENCE: ${c.def}`)
  if (c.spd != null) out.push(`\ud83d\udca8 SPEED: ${c.spd}`)
  if (c.crit != null) out.push(`\ud83c\udfaf CRITICAL RATE: ${c.crit}%`)

  /* Player-only: the equipped card. Omitted entirely for an enemy. */
  if (isPlayer && c.card) {
    out.push('')
    out.push('\ud83c\udfb4 EQUIPPED CARD')
    out.push(`\u2022 ${c.card.name}`)
    if (c.card.ability) out.push(`\u2022 Ability: ${c.card.ability}`)
  }

  /* Enemy abilities, or the player's class moves. Never both invented. */
  const abilities = Array.isArray(c.abilities) ? c.abilities.filter(Boolean) : []
  if (!isPlayer && abilities.length) {
    out.push('')
    out.push('\ud83d\udd25 SPECIAL ABILITIES')
    for (const a of abilities) out.push(`\u2022 ${a}`)
  }

  return out.join('\n')
}

/* --------------------------------------------------------- usage tracker */

/**
 * The ability & usage tracker.
 *
 * Class move counters are independent of each other and of the card ability
 * counter — the spec is emphatic about that, so each is rendered from its own
 * saved value and never derived from a shared total.
 *
 * @param {object} t
 * @param {Array<{name:string, used:number, limit:number}>} [t.moves]
 * @param {{name:string, used:number, limit:number}} [t.card]
 * @param {{used:number, limit:number}} [t.heals]
 */
function usageTracker (t = {}) {
  const out = [rule('\ud83d\udcdc ABILITY & USAGE TRACKER'), '']

  const moves = Array.isArray(t.moves) ? t.moves.filter(Boolean) : []
  if (moves.length) {
    out.push('\u2694\ufe0f CLASS MOVES')
    for (const m of moves) {
      const limit = Number(m.limit) || 3
      out.push(`\u2022 ${m.name}: ${Number(m.used) || 0}/${limit}`)
    }
    out.push('')
  }

  if (t.card) {
    const limit = Number(t.card.limit) || 3
    out.push('\ud83c\udfb4 CARD ABILITY')
    out.push(`\u2022 ${t.card.name}: ${Number(t.card.used) || 0}/${limit}`)
    out.push('')
  }

  if (t.heals) {
    const limit = Number(t.heals.limit) || 5
    const used = Number(t.heals.used) || 0
    out.push('\ud83d\udc9a SELF-HEALING')
    out.push(`\u2022 Used: ${used}/${limit}`)
    out.push(`\u2022 Remaining: ${Math.max(0, limit - used)}`)
  }

  return out.join('\n').trimEnd()
}

/* ------------------------------------------------------- action rendering */

/**
 * Renders the combat-action block for one resolved action.
 *
 * Every number here comes from the engine's saved result. A field the action
 * did not produce is omitted rather than shown as zero — a basic attack has no
 * "damage blocked" line, and a heal has no "final damage" line.
 */
function actionBlock (a = {}) {
  const out = [rule(`\u2694\ufe0f ROUND ${String(a.round ?? 1).padStart(2, '0')} \u2014 COMBAT ACTION`), '']

  out.push(`\ud83d\udd34 ${String(a.attacker || 'UNKNOWN').toUpperCase()} ACTS!`)
  out.push('')
  if (a.action) out.push(`\u26a1 Action: ${a.action}`)
  if (a.type) out.push(`\ud83d\udd25 Type: ${String(a.type).toUpperCase()}`)
  if (a.target) out.push(`\ud83c\udfaf Target: ${a.target}`)
  out.push('')

  if (a.baseDamage != null) out.push(`\ud83d\udca5 Base Damage: ${a.baseDamage}`)
  if (a.bonuses) out.push(`\u2728 Bonuses: ${a.bonuses}`)
  if (a.blocked != null) out.push(`\ud83d\udee1\ufe0f Damage Blocked: ${a.blocked}`)
  if (a.finalDamage != null) out.push(`\ud83d\udca2 Final Damage: ${a.finalDamage}`)
  if (a.healing != null) out.push(`\ud83d\udc9a Healing: ${a.healing}`)
  if (a.peCost != null) out.push(`\u26a1 Energy Used: ${a.peCost} PE`)

  return out.join('\n')
}

/**
 * The battle communication block: a short, accurate result line plus the real
 * next combatant. Never claims an effect the engine did not save.
 */
function communication ({ lines = [], next = null } = {}) {
  const out = [rule('\ud83d\udce2 BATTLE COMMUNICATION'), '']
  for (const l of lines.filter(Boolean)) out.push(l)
  if (next) {
    out.push('')
    out.push(`\u23f3 NEXT TURN: ${String(next).toUpperCase()}`)
  }
  return out.join('\n')
}

/* ------------------------------------------------------------ full frame */

const TOP = '\u256d' + '\u2501'.repeat(28) + '\u256e'
const BOTTOM = '\u2570' + '\u2501'.repeat(28) + '\u256f'

function frameTop (subtitle = 'BATTLE ARENA') {
  return [TOP, '          \u2b21 AXYN CORE', `          \u2694\ufe0f ${subtitle}`, BOTTOM].join('\n')
}

function frameBottom () {
  return [TOP, '          \u2b21 AXYN CORE', '        ARCHITECT SYSTEM', BOTTOM].join('\n')
}

/**
 * The universal one-round live combat frame.
 *
 * This is the WhatsApp-facing structure from Part 13. It composes the panels
 * above; it does not compute anything.
 */
function battleFrame ({
  round = 1,
  location = 'BATTLE ARENA',
  mode = 'NORMAL BATTLE',
  status = 'BATTLE IN PROGRESS',
  turn = null,
  player = null,
  enemy = null,
  action = null,
  tracker = null,
  comms = null
} = {}) {
  const out = [frameTop()]

  out.push('')
  out.push(`          \u2694\ufe0f ROUND ${String(round).padStart(2, '0')} \u2694\ufe0f`)
  out.push(`  \ud83d\udccd LOCATION: ${location}`)
  out.push(`  \ud83c\udfae MODE: ${mode}`)
  out.push(`  \ud83d\udd30 STATUS: ${status}`)
  if (turn) out.push(`  \u23f3 TURN: ${String(turn).toUpperCase()}`)
  out.push('')

  if (player) { out.push(combatantPanel(player, 'player')); out.push('') }
  if (enemy) { out.push(combatantPanel(enemy, 'enemy')); out.push('') }
  if (action) { out.push(actionBlock(action)); out.push('') }
  if (tracker) { out.push(usageTracker(tracker)); out.push('') }
  if (comms) { out.push(communication(comms)); out.push('') }

  out.push(frameBottom())
  return out.join('\n')
}

module.exports = {
  BAR_WIDTH,
  bar,
  percent,
  hpLine,
  peLine,
  hpBlock,
  peBlock,
  rule,
  combatantPanel,
  usageTracker,
  actionBlock,
  communication,
  frameTop,
  frameBottom,
  battleFrame
}
