'use strict'
/*
 * AXYON RPG ENGINE — deterministic, no AI.
 *
 * Implements the Architect manuscript: !arise registration, stages, ranks,
 * grades, Power Energy, dungeons (solo / multiplayer / party), duels with
 * temporary admin promotion, cards, social requests and the daily economy.
 *
 * All coin/turn resolution happens here in code. There is no model call
 * anywhere in this file — every outcome is Math.random() plus fixed tables.
 */
const store = require('./axyon-store')
const cardSpawner = require('./card-spawn')
const greetings = require('./greetings')
const T = require('./theme')
const music = require('./music')
const classes = require('./axyon-classes')
const items = require('./axyon-items')
const comboCatalog = require('./axyon-combos')
const combatMechanics = require('./axyon-combat-mechanics')
const floorStory = require('./floor-story')
const npc = require('./axyon-npc')
const display = require('./axyon-combat-display')
const armorLib = require('./axyon-armor')
const fs = require('fs/promises')

const WATERMARK = '\u232c AXYN CORE'

/*
 * CLASSES and CLASS_MOVES are now DERIVED from the class catalogue.
 *
 * They used to be two hard-coded objects here: four classes, one move each.
 * The catalogue in axyon-classes.js is the single source of truth, and these
 * two exports are kept only so existing callers and tests that read
 * `rpg.CLASSES` / `rpg.CLASS_MOVES` keep working.
 *
 * CLASS_MOVES is keyed by class id and holds that class's move list, which is
 * a shape change from the old one-move-per-class object. Anything that used
 * `CLASS_MOVES[p.class].damage` must go through classes.classDamage() instead.
 */
const CLASSES = classes.ALL_CLASSES.map(c => ({
  key: c.id,
  name: c.name,
  blurb: c.specialization,
  legacy: !!c.legacy,
  moves: c.moves.map(m => m.name)
}))

const CLASS_MOVES = Object.fromEntries(
  classes.ALL_CLASSES.map(c => [c.id, c.moves.map(m => ({ ...m, class_id: c.id }))])
)

const MODES = {
  duel: { name: 'Duel', blurb: 'One player against another.' },
  solo: { name: 'Solo', blurb: 'One player against a gate.' },
  multiplayer: { name: 'Multiplayer', blurb: 'Several players, individual turns.' },
  party: { name: 'Party', blurb: 'An organised team, 2 or more.' }
}

/*
 * SELF-HEAL — a flat 10 HP per use, five uses per combat.
 *
 * The implementation note fixes the amount at 10. It is a constant, not a
 * percentage, so the five uses are worth the same at every level.
 */
const SELF_HEAL_HP = 10
const TRAINING_COST = 250
const TRAINING_XP_PER_USE = 5
const TRAINING_XP_DAILY_CAP = 25
const TRAINING_USES_DAILY_CAP = 5
const HEAVY_ATTACK_ENERGY = 15
const HEAVY_ATTACK_MULTIPLIER = 1.65
const PHYSICAL_ENERGY_COSTS = Object.freeze({ attack: 5, heavy: HEAVY_ATTACK_ENERGY, block: 5, guard: 5, dodge: 8 })
const ENERGY_REGEN_PER_TURN = 4

const rnd = (n) => Math.floor(Math.random() * n)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const fmt = (n) => Number(n || 0).toLocaleString('en-US')

function powerEnergyForRank (rank) {
  const table = store.POWER_ENERGY_BY_RANK || {}
  const v = table[rank]
  if (Number.isFinite(v)) return v
  const i = Math.max(0, store.RANKS.indexOf(rank))
  return clamp(store.POWER_ENERGY_BASE + i * 20, store.POWER_ENERGY_BASE, store.POWER_ENERGY_CAP)
}

function mpCapacityForLevel (level) {
  const n = Math.floor(Number(level) || 1)
  return n < 10 ? 0 : 100 + Math.floor((n - 10) / 5) * 15
}

/* -------------------------------------------------------------- progression */

/**
 * Applies xp and zen to a player object, handling level-ups, rank-ups and
 * grade-ups. Returns the mutated player plus a list of events for the reply.
 *
 * Grade-up grants +4 ATK. Maximum HP is derived only from player level.
 */
function applyProgress (p, { xp = 0, zen = 0, coins = 0 } = {}) {
  const events = []
  const beforeRank = p.rank
  const beforeGrade = p.grade
  const oldMaxMp = Math.max(0, Number(p.maxMp) || 0)

  p.xp += Math.max(0, Math.floor(xp))
  p.zen += Math.max(0, Math.floor(zen))
  p.coins += Math.max(0, Math.floor(coins))

  let guard = 0
  while (p.xp >= store.xpNeed(p.level) && guard++ < 500) {
    p.xp -= store.xpNeed(p.level)
    p.level += 1
    events.push({ type: 'level', level: p.level })
  }

  p.maxMp = mpCapacityForLevel(p.level)
  // A player receives a full MP tank exactly when the level-10 system unlocks.
  // Later capacity increases do not refill the tank for free.
  if (oldMaxMp === 0 && p.maxMp > 0) p.mp = p.maxMp
  else p.mp = clamp(Math.floor(Number(p.mp) || 0), 0, p.maxMp)

  // Grade advances every 10 levels: level 10 → grade 2, level 20 → grade 3.
  const newGrade = 1 + Math.floor(p.level / 10)
  if (newGrade > beforeGrade) {
    const steps = newGrade - beforeGrade
    p.grade = newGrade
    p.atk += store.GRADE_ATK * steps
    events.push({ type: 'grade', grade: p.grade, atk: store.GRADE_ATK * steps })
  }

  // HP follows the manuscript's exact level formula; a level-up does not
  // automatically heal the player's current HP.
  p.maxHp = store.maxHpForLevel(p.level)

  const newRank = store.rankForLevel(p.level)
  if (newRank !== beforeRank) {
    p.rank = newRank
    p.maxPowerEnergy = powerEnergyForRank(newRank)
    p.powerEnergy = p.maxPowerEnergy
    events.push({ type: 'rank', rank: newRank, powerEnergy: p.maxPowerEnergy })
  }

  p.hp = clamp(p.hp, 0, p.maxHp)
  return { player: p, events }
}

/* ------------------------------------------------------------------ combat */

function buildEnemy (stage) {
  /*
   * An enemy is now a real NPC: class, rank, grade, mastery and class moves,
   * derived deterministically from the stage/floor row (see axyon-npc.js).
   *
   * The original stat block is preserved exactly — `hp`, `atk`, `def`, `xp`,
   * `zen` and `boss` are the same numbers as before, so the difficulty of
   * every existing stage and floor is unchanged. The class identity is added
   * alongside them, and the NPC's class move goes through the same
   * `classes.classDamage()` the player's does.
   */
  return npc.buildNpc(stage)
}

function playerHitDetails (p, enemy, mult = 1, bonus = 0) {
  const strengthBonus = Math.max(0, (Number(p.str) || 5) - 5) * 0.35
  const base = p.atk * 1.15 + strengthBonus + rnd(7) + bonus
  const rawDamage = Math.max(1, base * mult - enemy.def * 0.35)
  const damage = Math.max(1, Math.round(combatMechanics.applyFatiguePenalty(rawDamage, p, p.fatigue)))
  return { damage, rawDamage: Math.max(1, Math.round(rawDamage)), fatigueReduced: Math.max(0, Math.max(1, Math.round(rawDamage)) - damage) }
}

function playerHit (p, enemy, mult = 1, bonus = 0) {
  return playerHitDetails(p, enemy, mult, bonus).damage
}

function enemyHitDetails (enemy, p, guardRatio = 0) {
  const defencePenalty = combatMechanics.fatiguePenalty(p, p.fatigue) * 0.5
  const effectiveDef = Math.max(0, Number(p.def) * (1 - defencePenalty))
  const incoming = Math.max(1, Math.round(enemy.atk + rnd(6) - effectiveDef * 0.3))
  const finalDamage = guardRatio ? Math.max(1, Math.round(incoming * (1 - guardRatio))) : incoming
  return { incoming, finalDamage, blocked: Math.max(0, incoming - finalDamage) }
}

function enemyHit (enemy, p, guardRatio = 0) {
  return enemyHitDetails(enemy, p, guardRatio).finalDamage
}

/* ------------------------------------------------------------- formatting */

function bar (value, max, width = 10) {
  const filled = max > 0 ? clamp(Math.round((value / max) * width), 0, width) : 0
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled)
}

/**
 * The hunter's profile card.
 *
 * NO UNICODE DISPLAY FONTS HERE.
 * ------------------------------
 * This card used to render its section titles in small-caps and the hunter's
 * name in fraktur. It looked decorative but was genuinely hard to scan: the
 * stylised glyphs are not the letter shapes a reader's eye is trained on, so a
 * player had to decode the card instead of reading it.
 *
 * It is now a narrow, vertical dossier: no fixed-width frame, no multi-column
 * rows and short progress bars so it survives WhatsApp's mobile message width.
 * `!arise` and every other card keep their existing treatment.
 */
function profileCard (p, extra = {}) {
  const need = store.xpNeed(p.level)
  const name = String(p.name || '').trim() || 'Unnamed Hunter'
  const compactBar = (value, max, width = 8) => {
    const current = Math.max(0, Number(value) || 0)
    const total = Math.max(0, Number(max) || 0)
    const filled = total > 0 ? Math.max(0, Math.min(width, Math.round(current / total * width))) : 0
    return `[${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}] ${Math.round(current)}/${Math.round(total)}`
  }
  const lines = [
    '⬡ *AXYN CORE*',
    `*${name}*`,
    extra.partner ? `💞 Bound to *${extra.partner}*` : null,
    '',
    '┈┈┈ *VITALS* ┈┈┈',
    `📈 Level *${p.level}*`,
    `🏅 Rank *${p.rank}*  ·  🎖 Grade *${p.grade}*`,
    `🎭 Class *${p.class || 'Fighter'}*`,
    `❤️ HP  ${compactBar(p.hp, p.maxHp)}`,
    `⚡ Energy  ${compactBar(p.powerEnergy, p.maxPowerEnergy)}`,
    `🔮 MP  ${compactBar(p.mp, p.maxMp)}`,
    `💠 XP  ${compactBar(p.xp, need)}`,
    '',
    '┈┈┈ *COMBAT* ┈┈┈',
    `⚔ ATK *${p.atk}*  ·  🛡 DEF *${p.def}*  ·  💨 SPD *${p.spd}*`,
    `💪 STR *${p.str ?? 5}*  ·  👁 PER *${p.per ?? 5}*`,
    `🫁 STA *${p.sta ?? 5}*  ·  🧬 VIT *${p.vit ?? 5}*`,
    `😮‍💨 Fatigue *${p.fatigue ?? 0}/100*`,
    `🏆 Record *${p.wins}W* / *${p.losses}L*`,
    '',
    '┈┈┈ *HOLDINGS* ┈┈┈',
    `💰 Zen *${fmt(p.zen)}*`,
    `💎 Coins *${fmt(p.coins)}*`,
    `🚪 Stage *${p.stage}*`
  ]
  return lines.filter(line => line !== null).join('\n')
}

/**
 * The battle card.
 *
 * Heavy frame, because a fight should not look like a profile. Enemy on top,
 * hunter below, both with monospace bars, then the remaining uses.
 */
function battleInfoCard (b, p, note = '') {
  const e = b.enemy || {}
  const xpNeed = store.xpNeed(p.level)
  const playerName = String(p.name || 'Hunter')
  const location = String(b.location || (b.mode === 'floor'
    ? e.name || `Dungeon Floor ${b.ordinal || 1}`
    : `Stage ${b.ordinal || p.stage || 1}`))
  const status = String(b.status || (e.boss ? 'BOSS ENCOUNTER' : 'IN PROGRESS'))
  const playerHp = Math.max(0, Number(b.playerHp ?? p.hp) || 0)
  const playerMaxHp = Math.max(0, Number(p.maxHp) || 0)
  const enemyHp = Math.max(0, Number(b.enemyHp ?? e.hp) || 0)
  const enemyMaxHp = Math.max(0, Number(e.hp) || 0)
  const bar = (current, maximum, width = 20) => {
    const ratio = maximum > 0 ? Math.max(0, Math.min(1, current / maximum)) : 0
    const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))
    return T.m(`[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`)
  }
  const section = (heading, description, rows = []) => [
    '━━━━━━━━━━━━━━━━━━━━',
    T.font(heading, 'bold'),
    description,
    ...rows
  ].filter(Boolean).join('\n')

  const equipped = Array.isArray(b.equippedCards)
    ? b.equippedCards.filter(c => c && (!c.expires_at || new Date(c.expires_at).getTime() > Date.now()))
    : Array.isArray(p.equippedCards) ? p.equippedCards.filter(Boolean) : []

  const activityRows = []
  const damageTaken = Math.max(0, Number(b.damageTaken) || 0)
  const damageBlocked = Math.max(0, Number(b.damageBlocked) || 0)
  if (damageTaken > 0) activityRows.push(`• Damage taken: *${damageTaken}*`)
  if (damageBlocked > 0) activityRows.push(`• Damage blocked: *${damageBlocked}*`)

  const cardRows = equipped.length
    ? equipped.map(c => {
        const slot = Number(c.equipped_slot) || equipped.indexOf(c) + 1
        const details = [`  ${T.b(`Slot ${slot} · ${c.name || 'Unnamed Card'}`)}`]
        if (c.ability) {
          const abilityDamage = c.ability_damage != null ? ` · Damage ${c.ability_damage}` : ''
          details.push(`  Ability: ${c.ability}${abilityDamage}`)
        } else if (c.damage != null) {
          details.push(`  Card damage: ${c.damage}`)
        }
        return details.join('\n')
      })
    : ['  No cards are equipped yet. Visit your card collection and equip up to two cards to bring their abilities into battle.']

  const out = [
    `⬡ ${T.font('AXYN CORE', 'bold')}`,
    `└─ by ${greetings.creatorsOf({}).join(' & ')}`,
    '',
    `${T.font('BATTLE REPORT', 'bold')}  ·  ${T.b(`TURN ${b.turn || 1}`)}${e.boss ? '  ·  👑 BOSS' : ''}`,
    '',
    section('📍  LOCATION',
      'The arena where this encounter is unfolding. Every move from here shapes the outcome.',
      [`*${location}*`, `Status: ${T.b(status)}`]),
    '',
    section(`🔵  ${e.boss ? 'BOSS ENCOUNTER' : 'MONSTER'}`,
      'A hostile presence stands in your way. Watch its remaining health as the battle develops.',
      [`*${String(e.name || 'UNKNOWN').toUpperCase()}*`, bar(enemyHp, enemyMaxHp), `*${enemyHp} / ${enemyMaxHp} HP*`]),
    '',
    section(`🔴  YOUR HUNTER`,
      'Your current condition and progression. Keep an eye on your health before choosing your next move.',
      [
        `*${T.hunterName(playerName)}*`,
        `${p.rank || 'E'} Rank  ·  Level ${p.level || 1}  ·  ${p.class || 'Fighter'}`,
        `ATK ${p.atk} · DEF ${p.def} · SPD ${p.spd} · STR ${p.str ?? 5} · PER ${p.per ?? 5} · STA ${p.sta ?? 5} · VIT ${p.vit ?? 5}`,
        `Fatigue ${p.fatigue ?? b.fatigue ?? 0}/100`,
        bar(playerHp, playerMaxHp),
        `*${playerHp} / ${playerMaxHp} HP*`,
        `🔮 MP *${Math.max(0, Number(b.mp ?? p.mp) || 0)}/${Math.max(0, Number(p.maxMp) || 0)}*`,
        `⭐ XP  ·  *${Math.max(0, Number(p.xp) || 0)} / ${xpNeed} XP*`
      ]),
    '',
    section('🎴  EQUIPPED CARDS',
      'Your equipped cards provide the abilities and bonuses available to you during combat.',
      cardRows),
    activityRows.length ? '' : null,
    activityRows.length ? section('📊  BATTLE ACTIVITY',
      'A record of the impact you have taken and the damage you have successfully blocked.',
      activityRows) : null,
    '',
    section('⚔️  BATTLE COMMANDS',
      'Choose the action that best fits the situation. AXYON will update the battle record after every turn.',
      [
        '`!attack`  ·  Strike the enemy',
        '`!heavy`  ·  Stronger strike; costs Power Energy',
        '`!heal`  ·  Restore health',
        '`!guard` / `!defend`  ·  Brace for impact',
        '`!ability`  ·  Use an equipped card ability',
        '`!power`  ·  Use a purchased hunter power',
        '`!class`  ·  Use a class move',
        '`!card`  ·  View or manage your cards'
      ]),
    '',
    '`!retreat`  ·  Leave this encounter (no rest credit)',
    T.i('The battle continues until you win, fall, or retreat. Retreating does not advance your next !rest.')
  ]

  if (note) {
    out.splice(4, 0, section('✦  LATEST EVENT',
      'The latest action has changed the state of this encounter.',
      [String(note)]), '')
  }

  return out.filter(x => x !== null && x !== undefined && x !== '').join('\n')
}

/** Compact combat HUD. The detailed narrative remains available via !battleinfo. */
function battleCard (b, p, note = '') {
  const enemy = b.enemy || {}
  const playerName = String(p.name || 'Hunter').trim() || 'Hunter'
  const hpBar = (current, maximum) => {
    const width = 8
    const cur = Math.max(0, Number(current) || 0)
    const max = Math.max(0, Number(maximum) || 0)
    const filled = max > 0 ? clamp(Math.round(cur / max * width), 0, width) : 0
    return `[${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}] ${Math.round(cur)}/${Math.round(max)}`
  }
  const equipped = Array.isArray(b.equippedCards)
    ? b.equippedCards.filter(c => c && (!c.expires_at || new Date(c.expires_at).getTime() > Date.now()))
    : Array.isArray(p.equippedCards) ? p.equippedCards.filter(Boolean) : []
  const cardLines = equipped.slice(0, 2).map((card, index) => {
    const label = card.ability ? `${card.name} · ${card.ability}` : card.name
    return `🎴 ${index + 1}. ${label}`
  })
  const latest = String(note || '').split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3)
  const xpNeed = store.xpNeed(p.level)
  const maxEnergy = Math.max(0, Number(p.maxPowerEnergy) || 0)
  const energy = Math.max(0, Number(b.energy ?? p.powerEnergy) || 0)
  const location = String(b.location || enemy.name || `Stage ${b.ordinal || p.stage || 1}`)
  const lines = [
    '⬡ *AXYN CORE*',
    `*亗『${T.hunterName(playerName)}』亗*`,
    '',
    `┈┈┈ *BATTLE · TURN ${Number(b.turn) || 1}* ┈┈┈`,
    `📍 ${location}`,
    latest.length ? `✦ ${latest.join('\n')}` : null,
    '',
    `┈┈┈ *${enemy.boss ? 'BOSS' : 'MONSTER'}* ┈┈┈`,
    `👹 *${String(enemy.name || 'ENEMY').toUpperCase()}*`,
    `❤️ HP ${hpBar(b.enemyHp ?? enemy.hp, enemy.hp)}`,
    '',
    '┈┈┈ *VITALS* ┈┈┈',
    `📈 Level *${p.level || 1}*  ·  🏅 Rank *${p.rank || 'E'}*  ·  🎖 Grade *${p.grade || 1}*`,
    `🎭 Class *${p.class || 'Fighter'}*`,
    `❤️ HP  ${hpBar(b.playerHp ?? p.hp, p.maxHp)}`,
    `⚡ Energy  ${hpBar(energy, maxEnergy)}`,
      `🔮 MP  ${hpBar(b.mp ?? p.mp, p.maxMp)}`,
    `💠 XP  ${hpBar(p.xp, xpNeed)}`,
    `💪 STR *${p.str ?? 5}* · 👁 PER *${p.per ?? 5}* · 🫁 STA *${p.sta ?? 5}* · 🧬 VIT *${p.vit ?? 5}*`,
    `😮‍💨 Fatigue *${Math.max(0, Number(b.fatigue ?? p.fatigue) || 0)}/100*`,
    '',
    cardLines.length ? cardLines.join('\n') : '🎴 No cards equipped',
    '',
    '`!attack` · `!heavy` · `!dodge` · `!block` · `!guard / !defend` · `!heal`',
    '`!ability` · `!power` · `!class` · `!card` · `!cc`',
    '`!battleinfo` · `!retreat`',
    '↳ Retreats do not count towards !rest.'
  ]
  return lines.filter(line => line !== null && line !== undefined).join('\n')
}

/**
 * The class moves a player can use right now.
 *
 * Returns an empty list when the player's class has no catalogue entry (a legacy
 * class, or one an operator has not configured). The card then shows no move
 * rows rather than inventing names.
 */
function liveClassMoves (p) {
  try {
    const moves = classes.movesForClass ? classes.movesForClass(p.class) : null
    if (!Array.isArray(moves)) return []
    return moves.slice(0, 3)
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ engine */

function createAxyon ({ economy, logger, sendButtons } = {}) {
  /*
   * Live send instrumentation, read by the owner's !system health snapshot.
   * `inFlight` is the queue depth (sends awaiting WhatsApp right now) and
   * `lastLatencyMs` is the duration of the most recent successful send. Both
   * start empty and report null until something is actually sent, so the
   * health card never claims a measurement it does not have.
   */
  let inFlight = 0
  let lastLatencyMs = null
  const send = async (s, j, m, t) => {
    inFlight++
    const started = Date.now()
    try {
      return await s.sendMessage(j, { text: t }, { quoted: m })
    } finally {
      lastLatencyMs = Date.now() - started
      inFlight--
    }
  }
  const persistFatigue = async (userId, fatigue, updatedAt, playerState) => {
    if (typeof store.updateFatigue === 'function') return store.updateFatigue(userId, fatigue, updatedAt)
    // Keep lightweight test adapters and older injected stores compatible.
    if (playerState && typeof store.savePlayer === 'function') {
      playerState.fatigue = combatMechanics.fatigueValue(fatigue)
      playerState.fatigueUpdatedAt = updatedAt
      return store.savePlayer(playerState)
    }
    return null
  }

  /*
   * BUTTON POLICY
   * -------------
   * Most of this bot is plain commands. Buttons are reserved for the two
   * places where tapping genuinely beats typing: the six battle actions, and
   * accepting or declining a duel (where the other player has to answer).
   *
   * `buttons()` therefore renders plain text and ignores any button defs it is
   * handed, so no screen can quietly grow a button grid again. `tapButtons()`
   * is the explicit opt-in used only by battle and duels.
   */
  const buttons = (s, j, m, body) => s.sendMessage(j, { text: body }, { quoted: m })
  const tapButtons = async (s, j, m, body, footer, defs, owner, fallbackBody = body) => {
    // Native-flow is optional. Never let a failed button send swallow the
    // battle/floor response: send the full playable text card instead.
    if (sendButtons) {
      try {
        const result = await sendButtons(s, j, body, footer || WATERMARK, defs, owner)
        if (result === true) return true
      } catch (e) {
        logger?.warn?.({ err: e?.message || e }, 'native buttons unavailable; falling back to text')
      }
    }
    return s.sendMessage(j, { text: fallbackBody }, { quoted: m })
  }

  /* ---------------------------------------------------------- media helper */
  async function withVisual (sock, jid, m, mode, text, defs, tappable = false) {
    const v = await store.visual(mode).catch(() => null)
    if (v && v.url) {
      try {
        const payload = { caption: text }
        if (/\.(mp4|webm|mov)(\?|$)/i.test(v.url)) payload.video = { url: v.url }
        else payload.image = { url: v.url }
        await sock.sendMessage(jid, payload, { quoted: m })
        if (defs && defs.length) {
          return tappable
            ? tapButtons(sock, jid, m, v.caption || '\u2728', WATERMARK, defs, null, text)
            : buttons(sock, jid, m, v.caption || '\u2728')
        }
        return true
      } catch (e) {
        logger?.warn?.({ err: e, mode }, 'axyon visual send failed')
      }
    }
    if (defs && defs.length) {
      return tappable
        ? tapButtons(sock, jid, m, text, WATERMARK, defs)
        : buttons(sock, jid, m, text)
    }
    return send(sock, jid, m, text)
  }

  /* -------------------------------------------------------------- registry */
  // Every implemented command is registered here, which is also what /help
  // renders — so help can never drift from what actually exists.
  const COMMANDS = []
  function cmd (name, section, usage, desc, handler, opts = {}) {
    COMMANDS.push({ name, section, usage, desc, handler, ...opts })
  }

  /* ----------------------------------------------------------------- arise */

  async function arise (sock, m, ctx) {
    const { userId, jid, name, settings } = ctx
    const r = await store.arise(userId, name)
    await store.log(userId, r.created ? 'arise' : 'arise_return', userId, { created: r.created })
    const p = r.player
    const caption = r.created
      ? greetings.firstGreeting(p, settings.prefix, settings)
      : greetings.returnGreeting(p, settings.prefix, settings)
    return withVisual(sock, jid, m, 'arise', caption)
  }

  async function profile (sock, m, ctx) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    const activeBattle = await store.getBattle(ctx.userId)
    if (activeBattle) {
      p.hp = Number(activeBattle.playerHp ?? p.hp)
      p.powerEnergy = Number(activeBattle.energy ?? p.powerEnergy)
      p.mp = Number(activeBattle.mp ?? p.mp)
      p.fatigue = combatMechanics.fatigueValue(activeBattle.fatigue ?? p.fatigue)
    } else {
      const party = await store.partyForUser(ctx.jid, ctx.userId).catch(() => null)
      const member = party?.status === 'battling' ? party.state?.floorBattle?.players?.[ctx.userId] : null
      if (member) {
        p.hp = Number(member.hp ?? p.hp)
        p.powerEnergy = Number(member.energy ?? p.powerEnergy)
        p.mp = Number(member.mp ?? p.mp)
        p.fatigue = combatMechanics.fatigueValue(member.fatigue ?? p.fatigue)
      } else {
        const duel = await store.activeDuelForUser(ctx.userId, ctx.jid).catch(() => null)
        const state = duel?.state || {}
        if (duel) {
          p.hp = Number(state.hp?.[ctx.userId] ?? p.hp)
          p.powerEnergy = Number(state.energy?.[ctx.userId] ?? p.powerEnergy)
          p.mp = Number(state.mp?.[ctx.userId] ?? p.mp)
          p.fatigue = combatMechanics.fatigueValue(state.fatigue?.[ctx.userId] ?? p.fatigue)
        }
      }
    }
    const partner = await store.partnerOf(ctx.userId).catch(() => null)
    let partnerName = null
    if (partner) {
      const otherId = partner.requester === ctx.userId ? partner.target : partner.requester
      partnerName = (await store.player(otherId))?.name || `+${otherId}`
    }
    return withVisual(sock, ctx.jid, m, 'profile', profileCard(p, { partner: partnerName, settings: ctx.settings }))
  }

  /* ---------------------------------------------------------------- stages */

  async function listStages (sock, m, ctx) {
    const p = await store.player(ctx.userId)
    const rows = await store.stages()
    const lines = rows.map(s => {
      const mark = s.locked ? '\ud83d\udd12' : Number(s.ordinal) === p.stage ? '\u25b6\ufe0f' : '\u25ab\ufe0f'
      return `${mark} *${s.ordinal}. ${s.name}*\n   \u2764\ufe0f ${s.hp} \u2022 \u2694\ufe0f ${s.atk} \u2022 \ud83d\udee1\ufe0f ${s.def} \u2022 \u2728 ${s.xp} XP \u2022 \ud83e\ude99 ${s.zen}`
    })
    const defs = rows.filter(s => !s.locked).slice(0, 6).map(s => [`\u2694\ufe0f ${s.name}`, `ax_fight_${s.ordinal}`])
    defs.push(['\ud83d\udc64 Profile', 'ax_profile'])
    return buttons(sock, ctx.jid, m, [
      `${WATERMARK}`, '', '\ud83d\udeaa *BATTLE STAGES*', '',
      lines.join('\n'), '', `You are at stage *${p.stage}*.`
    ].join('\n'), WATERMARK, defs)
  }

  /* --------------------------------------------------------------- battles */

  async function beginBattle (sock, m, ctx, ordinal) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    const party = await store.partyForUser(ctx.jid, ctx.userId).catch(() => null)
    if (party?.status === 'battling') return send(sock, ctx.jid, m, '⚔️ You are already participating in a shared party floor. Finish or retreat from that encounter first.')
    const stage = await store.stage(Number(ordinal) || p.stage)
    if (!stage) return send(sock, ctx.jid, m, `\u274c There is no stage *${ordinal}*. Use *${ctx.settings.prefix}stages*.`)
    if (stage.locked) return send(sock, ctx.jid, m, '\ud83d\udd12 That stage is locked.')
    const enemy = buildEnemy(stage)
    const b = {
      mode: 'stage',
      ordinal: Number(stage.ordinal),
      location: stage.name || `Stage ${stage.ordinal}`,
      equippedCards: await store.equippedCards(ctx.userId),
      enemy,
      enemyHp: enemy.hp,
      playerHp: p.hp,
      energy: p.powerEnergy,
      mp: p.mp,
      fatigue: Math.max(0, Number(p.fatigue) || 0),
      turn: 1,
      healsLeft: ctx.settings.selfHealPerCombat,
      guard: 0
    }
    await store.setBattle(ctx.userId, b)
    await store.log(ctx.userId, 'battle_start', String(stage.ordinal), { enemy: enemy.name })
    return withVisual(sock, ctx.jid, m, enemy.boss ? 'boss' : 'battle',
      battleCard(b, p), [], true)
  }

  function battleButtons () {
    // Combat is command-driven; no numbered or quick-reply action menu.
    return []
  }

  async function battleInfo (sock, m, ctx) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    const party = await store.partyForUser(ctx.jid, ctx.userId).catch(() => null)
    const partyBattle = party?.status === 'battling' ? party.state?.floorBattle : null
    if (partyBattle) {
      const member = partyBattle.players?.[ctx.userId]
      const player = member ? { ...p, hp: member.hp, maxHp: member.maxHp, powerEnergy: member.energy, maxPowerEnergy: member.maxEnergy, mp: member.mp, fatigue: member.fatigue } : p
      const equippedCards = await store.equippedCards(ctx.userId)
      return send(sock, ctx.jid, m, battleCard({ ...partyBattle, equippedCards, playerHp: member?.hp, energy: member?.energy, mp: member?.mp }, player, partyBattle.lastEvent || ''))
    }
    const battle = await store.getBattle(ctx.userId)
    if (battle) return send(sock, ctx.jid, m, battleInfoCard(battle, p, battle.lastEvent || ''))

    const duel = await store.activeDuelForUser(ctx.userId, ctx.jid).catch(() => null)
    if (duel) {
      const first = await store.player(duel.challenger)
      const second = await store.player(duel.opponent)
      const state = duel.state || {}
      const hp = state.hp || {}
      const nextId = String(state.turn || duel.challenger)
      return send(sock, ctx.jid, m, [
        `${WATERMARK}`, '', `⚔️ *DUEL DETAILS · #${duel.id}*`, '',
        `*${first?.name || duel.challenger}* · ${first?.rank || 'E'} Rank · Lv.${first?.level || 1}`,
        `❤️ HP ${Number(hp[duel.challenger] ?? first?.hp ?? 0)}/${first?.maxHp || 0} · ⚡ Energy ${Number(state.energy?.[duel.challenger] ?? first?.powerEnergy ?? 0)}/${first?.maxPowerEnergy || 0}`,
        `🔮 MP ${Number(state.mp?.[duel.challenger] ?? first?.mp ?? 0)}/${first?.maxMp || 0}`,
        `ATK ${first?.atk || 0} · DEF ${first?.def || 0} · SPD ${first?.spd || 0} · STR ${first?.str ?? 5} · PER ${first?.per ?? 5} · STA ${first?.sta ?? 5} · VIT ${first?.vit ?? 5} · Fatigue ${state.fatigue?.[duel.challenger] ?? first?.fatigue ?? 0}/100`,
        '',
        `*${second?.name || duel.opponent}* · ${second?.rank || 'E'} Rank · Lv.${second?.level || 1}`,
        `❤️ HP ${Number(hp[duel.opponent] ?? second?.hp ?? 0)}/${second?.maxHp || 0} · ⚡ Energy ${Number(state.energy?.[duel.opponent] ?? second?.powerEnergy ?? 0)}/${second?.maxPowerEnergy || 0}`,
        `🔮 MP ${Number(state.mp?.[duel.opponent] ?? second?.mp ?? 0)}/${second?.maxMp || 0}`,
        `ATK ${second?.atk || 0} · DEF ${second?.def || 0} · SPD ${second?.spd || 0} · STR ${second?.str ?? 5} · PER ${second?.per ?? 5} · STA ${second?.sta ?? 5} · VIT ${second?.vit ?? 5} · Fatigue ${state.fatigue?.[duel.opponent] ?? second?.fatigue ?? 0}/100`,
        '',
        `Round: *${Number(state.round) || 1}* · Next turn: *${(nextId === String(duel.challenger) ? first?.name : second?.name) || 'Unknown'}*`,
        state.lastAction ? `Latest action: ${state.lastAction}` : 'No actions taken yet.',
        `Guard states: ${Object.entries(state.guards || {}).filter(([, value]) => Number(value) > 0).map(([id, value]) => `${id === String(duel.challenger) ? first?.name : second?.name} ${Math.round(Number(value) * 100)}%`).join(', ') || 'None'}`,
        `Healing uses: ${Number(state.heals?.[duel.challenger] || 0)} / ${Number(state.heals?.[duel.opponent] || 0)}`,
        '',
        `Actions: ${ctx.prefix}attack · ${ctx.prefix}heavy · ${ctx.prefix}dodge · ${ctx.prefix}block · ${ctx.prefix}heal · ${ctx.prefix}power · ${ctx.prefix}cc · ${ctx.prefix}class · ${ctx.prefix}retreat`
      ].join('\n'))
    }
    return send(sock, ctx.jid, m, `You are not in a battle. Use *${ctx.prefix}stages* or *${ctx.prefix}floor*.`)
  }

  async function rest (sock, m, ctx) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    const battle = await store.getBattle(ctx.userId)
    const duel = await store.activeDuelForUser(ctx.userId).catch(() => null)
    const party = await store.partyForUser(ctx.jid, ctx.userId).catch(() => null)
    if (battle || duel || party?.status === 'battling') return send(sock, ctx.jid, m, '⛔ You can only rest outside a battle. Finish or leave the encounter first.')
    const completed = Math.max(0, Number(p.battlesSinceRest) || 0)
    if (completed < 2) {
      const remaining = 2 - completed
      return send(sock, ctx.jid, m, `🛌 *REST UNAVAILABLE*\n\nComplete *${remaining}* more battle${remaining === 1 ? '' : 's'} to restore your HP.\nRetreating does not count.`)
    }
    p.hp = p.maxHp
    p.fatigue = 0
    p.fatigueUpdatedAt = new Date().toISOString()
    p.battlesSinceRest = 0
    await store.savePlayer(p)
    await store.log(ctx.userId, 'rest', ctx.userId, { restoredHp: p.maxHp, fatigueReset: true })
    await persistFatigue(ctx.userId, 0, p.fatigueUpdatedAt, p)
    return send(sock, ctx.jid, m, `${WATERMARK}\n\n🛌 *REST COMPLETE*\n\n❤️ HP restored to *${p.hp}/${p.maxHp}*.\n😮‍💨 Fatigue reset to *0/100*.\nYour next rest unlocks after 2 more completed battles.`)
  }

  async function train (sock, m, ctx, requestedStat) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    const party = await store.partyForUser(ctx.jid, ctx.userId).catch(() => null)
    if (party?.status === 'battling' || await store.getBattle(ctx.userId) || await store.activeDuelForUser(ctx.userId).catch(() => null)) {
      return send(sock, ctx.jid, m, '🏋️ Training is only available outside active battles.')
    }
    if (await store.getBattle(ctx.userId) || await store.activeDuelForUser(ctx.userId).catch(() => null)) return send(sock, ctx.jid, m, '⛔ You cannot train during an active battle.')
    const stat = String(requestedStat || '').trim().toLowerCase()
    const labels = { atk: 'ATK', attack: 'ATK', def: 'DEF', defence: 'DEF', defense: 'DEF', spd: 'SPD', speed: 'SPD', str: 'STR', strength: 'STR', per: 'PER', perception: 'PER', sta: 'STA', stamina: 'STA', vit: 'VIT', vitality: 'VIT' }
    const key = ({ ATK: 'atk', DEF: 'def', SPD: 'spd', STR: 'str', PER: 'per', STA: 'sta', VIT: 'vit' })[labels[stat]]
    if (!key) return send(sock, ctx.jid, m, `Usage: *${ctx.prefix}train <atk|def|spd|str|per|sta|vit>*\nSTR boosts physical force · PER and SPD improve dodging · STA reduces fatigue gain · VIT improves recovery.\nCost: *${TRAINING_COST} Coins* · Reward: *${TRAINING_XP_PER_USE} XP* (up to *${TRAINING_USES_DAILY_CAP} trainings / ${TRAINING_XP_DAILY_CAP} training XP per day).`)

    const result = await store.trainPlayer(ctx.userId, key, {
      cost: TRAINING_COST,
      xp: TRAINING_XP_PER_USE,
      trainingXpCap: TRAINING_XP_DAILY_CAP,
      trainingUsesCap: TRAINING_USES_DAILY_CAP
    })
    if (!result.ok) {
      if (result.reason === 'coins') return send(sock, ctx.jid, m, `💎 *NOT ENOUGH COINS*\n\nTraining costs *${TRAINING_COST} Coins*. You have *${fmt(result.coins)}*.`)
      if (result.reason === 'daily_cap') return send(sock, ctx.jid, m, `⏳ *TRAINING LIMIT REACHED*\n\nYou can train *${TRAINING_USES_DAILY_CAP} times per day*, earning up to *${TRAINING_XP_DAILY_CAP} XP*. Resets at 00:00 UTC.`)
      if (result.reason === 'player') return arise(sock, m, ctx)
      if (result.reason === 'stat_cap') return send(sock, ctx.jid, m, `${labels[stat]} has reached its training cap of *100*.`)
      return send(sock, ctx.jid, m, 'That training option is unavailable.')
    }
    const progressed = applyProgress(result.player, { xp: 0 })
    await store.savePlayer(progressed.player)
    const statValue = progressed.player[key]
    let comboDiscovery = null
    const ownedCombos = await store.combos(ctx.userId).catch(() => [])
    const inventory = await store.inventory(ctx.userId).catch(() => [])
    const ownedPowerKeys = new Set(inventory.filter(row => Number(row.qty) > 0).map(row => row.key))
    const undiscovered = comboCatalog.CATALOGUE.filter(combo => Number(progressed.player.level) >= Number(combo.requiredLevel || 1) && !ownedCombos.some(row => row.combo_key === combo.key) && (!combo.abilityKey || ownedPowerKeys.has(combo.abilityKey)))
    if (undiscovered.length) {
      const candidate = undiscovered[Math.floor(Math.random() * undiscovered.length)]
      if (comboCatalog.rollDiscovery(Math.random, candidate.trainingChance)) {
        comboDiscovery = await store.unlockCombo(ctx.userId, candidate.key, 'training')
      }
    }
    const events = progressed.events.map(event => event.type === 'level'
      ? `⬆️ Level *${event.level}*`
      : event.type === 'grade' ? `🎖 Grade *${event.grade}*` : `🏅 Rank *${event.rank}*`).join('\n')
    const xpNote = result.xp ? `✨ +${result.xp} XP` : '✨ +0 XP · Training XP cap reached'
    return send(sock, ctx.jid, m, [
      `${WATERMARK}`, '', '🏋️ *TRAINING COMPLETE*', '',
      `⚔️ ${labels[stat]} *${statValue}*  (+1)`,
      `💎 -${TRAINING_COST} Coins`, xpNote,
      `Training today: *${result.trainingUsesToday}/${TRAINING_USES_DAILY_CAP}* · XP: *${result.trainingXpToday}/${TRAINING_XP_DAILY_CAP}*`,
      comboDiscovery ? `\n🔓 *NEW COMBO DISCOVERED*\n${comboCatalog.get(comboDiscovery.combo_key)?.name || comboDiscovery.combo_key}\nView it with *${ctx.prefix}cc*.` : '',
      events ? `\n${events}` : ''
    ].filter(Boolean).join('\n'))
  }

  function cardExpiryText (value) {
    if (!value) return 'PERMANENT'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return 'PERMANENT'
    const left = date.getTime() - Date.now()
    return left <= 0 ? `EXPIRED (${date.toISOString().slice(0, 10)})` : `${date.toISOString().slice(0, 10)} (${Math.ceil(left / 86400000)}d left)`
  }

  async function cardPanel (sock, m, ctx, requestedPage = 1) {
    const rows = await store.cards(ctx.userId)
    const equippedCount = rows.filter(c => c.equipped_slot && (!c.expires_at || new Date(c.expires_at).getTime() > Date.now())).length
    const pageSize = 10
    const pages = Math.max(1, Math.ceil(rows.length / pageSize))
    const page = Math.max(1, Math.min(pages, Number(requestedPage) || 1))
    const visibleRows = rows.slice((page - 1) * pageSize, page * pageSize)
    const lines = [WATERMARK, '', '⌬ *CARD ARCHIVE*', `Owned: *${rows.length}* • Equipped: *${equippedCount}/2* • Page: *${page}/${pages}*`, '']
    if (!rows.length) lines.push('You hold no cards yet.', 'Watch registered groups for six-hour drops, or receive one from AXYON.')
    else {
      for (const c of visibleRows) {
        const isExpired = c.expires_at && new Date(c.expires_at).getTime() <= Date.now()
        const status = !c.claimed ? 'UNCLAIMED' : isExpired ? 'EXPIRED' : c.equipped_slot ? `EQUIPPED · SLOT ${c.equipped_slot}` : 'IN COLLECTION'
        const todayUses = c.ability_day === new Date().toISOString().slice(0, 10) ? Number(c.ability_uses || 0) : 0
        lines.push(
          `*#${c.slot} ${c.name}*  _${status}_`,
          `Series: *${c.series || '—'}*`,
          `Type: *${String(c.card_type || 'character').toUpperCase()}* • Base DMG: *${c.damage}* • Rating: *${c.rating}/6*`,
          `Ability: *${c.ability || '—'}* • Ability DMG: *${c.ability_damage}* • Uses: *${todayUses}/3 today*`,
          `Expiry: *${cardExpiryText(c.expires_at)}*`, ''
        )
      }
    }
    const pageNav = pages > 1 ? [page > 1 ? `!cards ${page - 1} (previous)` : '', page < pages ? `!cards ${page + 1} (next)` : ''].filter(Boolean).join(' • ') : 'Only one page.'
    lines.push('**CARD CONTROLS**', '!card <number> • !card equip <number> [slot 1|2]', '!card unequip <slot> • !card slots • !card abilities', '!card use <slot> (during battle) • !card inventory [page]', `Pages: *${pageNav}*`)
    await send(sock, ctx.jid, m, lines.join('\n'))
    // Keep the archive lightweight even when ownership is unlimited. Use
    // `!card <number>` to open one card's artwork and complete details.
    return true
  }

  async function cardDetail (sock, m, ctx, collectionNo) {
    let c = await store.card(ctx.userId, Number(collectionNo))
    if (!c) return send(sock, ctx.jid, m, `No card #${collectionNo} exists in your collection.`)
    // Studio cards were historically claimed with the original artwork bytes
    // even though the dashboard had already saved a complete rendered card.
    // Backfill those older claims from the matching Studio record on first view.
    let studioBackfilled = false
    let studioCardFound = false
    if (c.drop_code) {
      try {
        const studio = await store.studioRenderedCard(c.drop_code)
        const fullRender = studio?.rendered_data
        studioCardFound = Buffer.isBuffer(fullRender) && fullRender.length > 0
        if (studioCardFound &&
            (!Buffer.isBuffer(c.image_data) || !c.image_data.equals(fullRender))) {
          const renderer = ['old-gen', 'ai-custom'].includes(String(studio.card_data?.renderer)) ? studio.card_data.renderer : 'old-gen'
          c = await store.editCard(ctx.userId, Number(collectionNo), { imageData: fullRender, renderer }) || c
          studioBackfilled = true
        }
      } catch (error) { console.warn('[AXYON cards] Studio render backfill skipped:', error?.message || error) }
    }
    // Re-render only AI Custom cards from their original artwork URL. Old Gen
    // is intentionally left untouched; both archive previews and manual card
    // opens now use the exact same stored rendered image bytes.
    if (!studioBackfilled && !studioCardFound && c.image_url && c.renderer === 'ai-custom') {
      try {
        const upgraded = await cardSpawner.renderUpdatedArtwork(c, c.image_url)
        if (upgraded?.rendered?.buffer) {
          c = await store.editCard(ctx.userId, Number(collectionNo), { imageData: upgraded.rendered.buffer, renderer: 'ai-custom' }) || c
        }
      } catch (error) { console.warn('[AXYON cards] AI Custom re-render skipped:', error?.message || error) }
    }
    const todayUses = c.ability_day === new Date().toISOString().slice(0, 10) ? Number(c.ability_uses || 0) : 0
    const text = [WATERMARK, '', `⌬ *${c.name}*`, `Collection number: *#${c.slot}*`, `Type: *${String(c.card_type || 'character').toUpperCase()}*`, `Series: *${c.series || '—'}*`, `Base damage: *${c.damage}*`, `Ability: *${c.ability || '—'}*`, `Ability damage: *${c.ability_damage}*`, `Daily ability uses: *${todayUses}/3*`, `Rating: *${c.rating}/6*`, `Expiry: *${cardExpiryText(c.expires_at)}*`, `Equipment: *${c.equipped_slot ? `Slot ${c.equipped_slot}` : 'Not equipped'}*`, `Status: *${c.claimed ? 'Owned' : 'Waiting to be claimed'}*`].join('\n')
    if (Buffer.isBuffer(c.image_data) && c.image_data.length) return sock.sendMessage(ctx.jid, { image: c.image_data, caption: text }, { quoted: m })
    return send(sock, ctx.jid, m, text)
  }

  async function equipCard (sock, m, ctx, collectionNo, targetSlot) {
    const result = await store.equipCard(ctx.userId, Number(collectionNo), targetSlot)
    const messages = { not_owned: 'That card is not in your claimed collection.', expired: 'Expired cards cannot be equipped.', slots_full: 'Both equipment slots are occupied. Choose slot 1 or 2 to replace one.', invalid_slot: 'Equipment slot must be 1 or 2.' }
    if (!result.ok) return send(sock, ctx.jid, m, `❌ ${messages[result.reason] || 'Could not equip that card.'}`)
    await store.log(ctx.userId, 'equip_card', String(collectionNo), { equippedSlot: result.equippedSlot })
    return send(sock, ctx.jid, m, `✅ *${result.card.name}* equipped in card slot *${result.equippedSlot}*.`)
  }

  async function unequipCard (sock, m, ctx, targetSlot) {
    const c = await store.unequipCard(ctx.userId, Number(targetSlot))
    if (!c) return send(sock, ctx.jid, m, 'Choose an occupied equipment slot: *1* or *2*.')
    await store.log(ctx.userId, 'unequip_card', String(targetSlot), { collectionNo: c.slot })
    return send(sock, ctx.jid, m, `✅ *${c.name}* removed from equipment slot *${targetSlot}*. It remains in your collection.`)
  }

  async function cardSlots (sock, m, ctx) {
    const rows = await store.equippedCards(ctx.userId)
    const bySlot = new Map(rows.map(c => [Number(c.equipped_slot), c]))
    const lines = [WATERMARK, '', '⌬ *CARD EQUIPMENT*', '']
    for (const slot of [1, 2]) {
      const c = bySlot.get(slot)
      lines.push(`*SLOT ${slot}*`, c ? `#${c.slot} · *${c.name}* · Base ${c.damage} · Ability ${c.ability_damage}${c.expires_at && new Date(c.expires_at).getTime() <= Date.now() ? ' · EXPIRED (unequip/replace)' : ''}` : 'Empty', '')
    }
    lines.push('Only two cards can be equipped. Your owned collection is unlimited.')
    return send(sock, ctx.jid, m, lines.join('\n'))
  }

  async function cardAbilities (sock, m, ctx) {
    const rows = await store.equippedCards(ctx.userId)
    const today = new Date().toISOString().slice(0, 10)
    const lines = [WATERMARK, '', '⌬ *EQUIPPED CARD ABILITIES*', '']
    if (!rows.length) lines.push('Equip a claimed card first.')
    for (const c of rows) {
      const uses = c.ability_day === today ? Number(c.ability_uses || 0) : 0
      lines.push(`*Slot ${c.equipped_slot} · ${c.name}*`, `${c.ability || 'No ability'} · Ability damage: *${c.ability_damage}*`, `Uses today: *${uses}/3*`, '')
    }
    lines.push('Each equipped card has its own three-use daily limit. Reset is automatic at UTC midnight.')
    return send(sock, ctx.jid, m, lines.join('\n'))
  }

  async function claimDrop (sock, m, ctx, code) {
    const result = await store.claimCardDrop(ctx.userId, code)
    if (!result.ok) {
      const messages = {
        not_registered: 'Use !arise before claiming a card.',
        not_found: 'That claim code does not exist. Check the code and try again.',
        claimed: 'Someone already claimed that card. The first successful claim wins.',
        expired: 'That card drop has expired.'
      }
      return send(sock, ctx.jid, m, `❌ ${messages[result.reason] || 'The card could not be claimed.'}`)
    }
    const c = result.card
    await store.log(ctx.userId, 'claim_spawned_card', c.drop_code || code, { name: c.name, collectionNo: result.slot })
    const caption = [WATERMARK, '', '✅ *CARD ACQUIRED*', '', `*${c.name}*`, `Collection number: *#${result.slot}*`, `Type: *${String(c.card_type || 'character').toUpperCase()}*`, `Series: *${c.series || '—'}*`, `Base damage: *${c.damage}*`, `Ability: *${c.ability || '—'}*`, `Ability damage: *${c.ability_damage}*`, `Rating: *${c.rating}/6*`, `Expiry: *${cardExpiryText(c.expires_at)}*`, '', 'Unlimited collection. Equip up to two cards with !card equip.'].join('\n')
    if (Buffer.isBuffer(c.image_data) && c.image_data.length) await sock.sendMessage(ctx.jid, { image: c.image_data, caption }, { quoted: m })
    else await send(sock, ctx.jid, m, caption)
    return true
  }

  async function claimCard (sock, m, ctx, collectionNo) {
    const c = await store.claimCard(ctx.userId, Number(collectionNo))
    if (!c) return send(sock, ctx.jid, m, `❌ Card #${collectionNo} is unavailable, already claimed, or expired.`)
    await store.log(ctx.userId, 'claim_card', String(collectionNo))
    return send(sock, ctx.jid, m, [WATERMARK, '', '✅ *CARD CLAIMED*', `*${c.name}*`, `Type: *${String(c.card_type || 'character').toUpperCase()}*`, `Series: *${c.series || '—'}*`, `Base damage: *${c.damage}*`, `Ability: *${c.ability || '—'}*`, `Ability damage: *${c.ability_damage}*`, `Rating: *${c.rating}/6*`, `Expiry: *${cardExpiryText(c.expires_at)}*`, '', `Equip it with *${ctx.settings.prefix}card equip ${c.slot}*`].join('\n'))
  }

  async function partyBattleDisplay (sock, jid, quoted, battle, note = '') {
    const hpBar = (current, maximum) => {
      const width = 8
      const cur = Math.max(0, Number(current) || 0)
      const max = Math.max(0, Number(maximum) || 0)
      const filled = max > 0 ? Math.max(0, Math.min(width, Math.round(cur / max * width))) : 0
      return `[${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}] ${Math.round(cur)}/${Math.round(max)}`
    }
    const members = []
    for (const id of battle.memberIds || []) {
      const player = await store.player(id)
      const member = battle.players?.[id] || {}
      const suffix = (battle.retreats || []).includes(id) ? ' · RETREATED' : Number(member.hp) <= 0 ? ' · DOWN' : ''
      members.push({
        name: player?.name || id,
        hp: hpBar(member.hp, member.maxHp || player?.maxHp),
        energy: hpBar(member.energy, member.maxEnergy || player?.maxPowerEnergy),
        mp: hpBar(member.mp, member.maxMp || player?.maxMp),
        fatigue: Math.max(0, Number(member.fatigue) || 0),
        suffix
      })
    }
    const nextId = battle.completed ? null : battle.turnOrder?.[battle.turnIndex]
    const next = nextId ? await store.player(nextId) : null
    const enemy = battle.enemy || {}
    const lines = [
      '⬡ *AXYN CORE*',
      '*亗『PARTY EXPEDITION』亗*',
      '',
      `┈┈┈ *DUNGEON · FLOOR ${battle.ordinal} · ROUND ${battle.round || 1}* ┈┈┈`,
      `👹 *${enemy.name || 'ENEMY'}*`,
      `❤️ HP ${hpBar(battle.enemyHp, enemy.hp)}`,
      '',
      '┈┈┈ *PARTY VITALS* ┈┈┈',
      ...members.flatMap(member => [
        `*${member.name}*${member.suffix}`,
        `❤️ HP ${member.hp}`,
        `⚡ Energy ${member.energy}`,
        `🔮 MP ${member.mp} · 😮‍💨 Fatigue ${member.fatigue}/100`
      ]),
      note ? '' : null,
      note ? `✦ ${note}` : null,
      next ? `⌛ Next turn: *${next.name || nextId}*` : null,
      '',
      '`!attack` · `!heavy` · `!block` · `!dodge` · `!heal`',
      '`!power` · `!cc` · `!class` · `!ability` · `!retreat`',
      '`!battleinfo`'
    ].filter(line => line !== null && line !== undefined)
    return send(sock, jid, quoted, lines.join('\n'))
  }

  async function partyBattleAct (sock, m, ctx, action, cardSlot = 1, moveName = null) {
    const party = await store.partyForUser(ctx.jid, ctx.userId)
    if (!party || party.status !== 'battling' || !party.state?.floorBattle) return send(sock, ctx.jid, m, 'There is no active party floor battle here.')
    const battle = party.state.floorBattle
    const actorId = String(ctx.userId)
    if (battle.storyPending) return send(sock, ctx.jid, m, `📖 The party story decision is still pending. Party Leader *${(await store.player(party.leader))?.name || party.leader}* must choose with *${ctx.prefix}choice 1-4* before combat begins.`)
    const order = Array.isArray(battle.turnOrder) ? battle.turnOrder : (battle.memberIds || [])
    if (String(order[Number(battle.turnIndex) || 0] || '') !== actorId) {
      const waitingFor = order[Number(battle.turnIndex) || 0]
      const next = waitingFor ? await store.player(waitingFor) : null
      return send(sock, ctx.jid, m, `⌛ It is *${next?.name || waitingFor || 'another party member'}*'s turn.`)
    }
    const actor = await store.player(actorId)
    const member = battle.players?.[actorId]
    if (!actor || !member) return send(sock, ctx.jid, m, 'Your party combat record could not be loaded.')
    if (Number(member.hp) <= 0 || (battle.retreats || []).includes(actorId)) return send(sock, ctx.jid, m, 'You are no longer active in this party encounter.')

    let card = null
    let weaponBonus = 0
    let weaponName = ''
    let power = null
    let combo = null
    let classMove = null
    let classMastery = 0
    let classSpend = null
    if (action === 'card') {
      const use = await store.useCardAbility(actorId, Number(cardSlot) || 1)
      if (!use.ok) return send(sock, ctx.jid, m, `❌ Card ability unavailable: *${use.reason}*.`)
      card = use.card
    } else if (action === 'attack' || action === 'heavy') {
      const equipped = await store.equippedCards(actorId)
      const weapon = equipped.find(entry => Number(entry.equipped_slot) === 1 && (!entry.expires_at || new Date(entry.expires_at).getTime() > Date.now()))
      weaponBonus = Number(weapon?.damage) || 0
      weaponName = weapon?.name || ''
    } else if (action === 'power') {
      const key = String(moveName || '').trim().toLowerCase()
      power = items.get(key) || items.abilities().find(entry => entry.name.toLowerCase() === key)
      if (!power || power.kind !== 'ability') return send(sock, ctx.jid, m, `Usage: *${ctx.prefix}power <owned power>*.`)
      if ((await store.inventoryQty(actorId, power.key)) < 1) return send(sock, ctx.jid, m, `🔒 You have not unlocked *${power.name}*.`)
      const cost = Math.max(0, Number(power.mpCost) || 0)
      if (Number(member.mp) < cost) return send(sock, ctx.jid, m, `🔮 ${power.name} costs *${cost} MP*. You have *${member.mp} MP*.`)
    } else if (action === 'combo') {
      combo = comboCatalog.get(moveName)
      if (!combo) return send(sock, ctx.jid, m, `❌ Unknown combo. See *${ctx.prefix}cc shop*.`)
      if (!(await store.hasCombo(actorId, combo.key))) return send(sock, ctx.jid, m, `🔒 *${combo.name}* is not unlocked for you.`)
      if (combo.abilityKey && (await store.inventoryQty(actorId, combo.abilityKey)) < 1) return send(sock, ctx.jid, m, `🔒 You must own *${items.get(combo.abilityKey)?.name || combo.abilityKey}*.`)
      const ability = combo.abilityKey ? items.get(combo.abilityKey) : null
      const mpCost = ability ? Math.ceil((Number(ability.mpCost) || 0) * Number(combo.powerMultiplier ?? 1)) : 0
      if (Number(member.energy) < Number(combo.energyCost)) return send(sock, ctx.jid, m, `⚡ This combo costs *${combo.energyCost} Energy*. You have *${member.energy}*.`)
      if (Number(member.mp) < mpCost) return send(sock, ctx.jid, m, `🔮 This combo costs *${mpCost} MP*. You have *${member.mp} MP*.`)
    } else if (action === 'class') {
      const classId = classes.normalizeClassId(actor.class)
      const moves = classId ? classes.movesForClass(classId) : []
      classMastery = await store.classMastery(actorId, classId)
      if (!classId || !moves.length) return send(sock, ctx.jid, m, '🎭 You do not have an available class move.')
      classMove = moveName ? classes.moveByName(classId, moveName) : moves.filter(x => x.unlock == null || x.unlock <= classMastery).filter(x => Number(x.damage) > 0).pop()
      if (!classMove) return send(sock, ctx.jid, m, `🔒 That class move is unavailable. Use *${ctx.prefix}class* to see your moves.`)
      const usesToday = await store.classMovesUsedToday(actorId)
      const check = classes.validateMoveUse({ player: actor, move: classMove, mastery: classMastery, usesToday, dailyLimit: ctx.settings.classMovesPerDay, inBattle: true, energy: Number(member.energy) })
      if (!check.ok) return send(sock, ctx.jid, m, check.message)
      classSpend = await store.consumeClassMove(actorId, ctx.settings.classMovesPerDay)
      if (!classSpend.ok) return send(sock, ctx.jid, m, `🧠 You have used all ${ctx.settings.classMovesPerDay} class moves today.`)
    }

    let mutationError = ''
    let result = null
    /* Armor is loaded before the synchronous mutation callback. */
    const partySuit = await store.equippedArmor(actorId).catch(() => null)
    const updatedParty = await store.mutateParty(party.id, current => {
      const state = { ...(current.state || {}) }
      const currentBattle = { ...(state.floorBattle || {}) }
      if (current.status !== 'battling' || !currentBattle.players) { mutationError = 'The party battle has already ended.'; return null }
      const currentOrder = currentBattle.turnOrder || currentBattle.memberIds || []
      const currentActor = String(currentOrder[Number(currentBattle.turnIndex) || 0] || '')
      if (currentActor !== actorId) { mutationError = 'The turn changed before your action was accepted.'; return null }
      const playerState = { ...(currentBattle.players[actorId] || {}) }
      if (Number(playerState.hp) <= 0 || (currentBattle.retreats || []).includes(actorId)) { mutationError = 'You are no longer active in this encounter.'; return null }
      let dealt = 0
      let note = ''
      let fatigueAction = ''
      const fighter = { ...actor, fatigue: combatMechanics.fatigueValue(playerState.fatigue) }
      const enemy = currentBattle.enemy || {}
      if (action === 'retreat') {
        currentBattle.retreats = [...new Set([...(currentBattle.retreats || []), actorId])]
        note = `${actor.name || actorId} retreated. No rest credit or rewards.`
      } else if (action === 'attack' || action === 'heavy') {
        const cost = Number(PHYSICAL_ENERGY_COSTS[action]) || 0
        if (Number(playerState.energy) < cost) { mutationError = `${action.toUpperCase()} costs ${cost} Energy.`; return null }
        playerState.energy -= cost
        const hitResult = playerHitDetails(fighter, enemy, action === 'heavy' ? HEAVY_ATTACK_MULTIPLIER : 1, weaponBonus)
        dealt = hitResult.damage
        fatigueAction = action
        note = `${actor.name || actorId} ${action === 'heavy' ? 'used Heavy Attack' : 'attacked'}${weaponName ? ` with ${weaponName}` : ''} for ${dealt} damage (-${cost} Energy).`
        if (hitResult.fatigueReduced > 0) note += ` Fatigue reduced damage by ${hitResult.fatigueReduced}.`
      } else if (action === 'block' || action === 'guard') {
        const cost = Number(PHYSICAL_ENERGY_COSTS[action]) || 0
        if (Number(playerState.energy) < cost) { mutationError = `Block costs ${cost} Energy.`; return null }
        playerState.energy -= cost
        playerState.guard = 0.6
        fatigueAction = 'block'
        note = `${actor.name || actorId} prepared a block (-${cost} Energy).`
      } else if (action === 'dodge') {
        const cost = Number(PHYSICAL_ENERGY_COSTS.dodge) || 0
        if (Number(playerState.energy) < cost) { mutationError = `Dodge costs ${cost} Energy.`; return null }
        playerState.energy -= cost
        playerState.evading = true
        fatigueAction = 'dodge'
        note = `${actor.name || actorId} prepared to dodge (-${cost} Energy).`
      } else if (action === 'heal') {
        if (Number(playerState.healsLeft) <= 0) { mutationError = 'You have no heals left in this party battle.'; return null }
        const healed = Math.min(Number(playerState.maxHp), Number(playerState.hp) + combatMechanics.enhancedHealing(actor, SELF_HEAL_HP)) - Number(playerState.hp)
        if (healed <= 0) { mutationError = 'Your HP is already full.'; return null }
        playerState.hp += healed
        playerState.healsLeft -= 1
        note = `${actor.name || actorId} recovered ${healed} HP.`
      } else if (action === 'card') {
        dealt = playerHit(fighter, enemy, 1, Number(card?.ability_damage) || 0)
        note = `${actor.name || actorId} used ${card?.ability || card?.name || 'a card ability'} for ${dealt} damage.`
      } else if (action === 'power') {
        const fake = { enemy, enemyHp: currentBattle.enemyHp, playerHp: playerState.hp, guard: playerState.guard || 0, mp: playerState.mp }
        const applied = items.apply(power, fake, { ...actor, mp: playerState.mp, maxMp: playerState.maxMp })
        if (!applied.ok) { mutationError = applied.note; return null }
        currentBattle.enemyHp = Number(applied.battle.enemyHp)
        playerState.hp = Number(applied.battle.playerHp)
        playerState.guard = Number(applied.battle.guard) || 0
        playerState.mp = Number(applied.battle.mp) || 0
        note = `${actor.name || actorId} used ${power.name}. ${applied.note}`
      } else if (action === 'combo') {
        const ability = combo.abilityKey ? items.get(combo.abilityKey) : null
        const effect = ability?.effect || {}
        const energyCost = Math.max(0, Number(combo.energyCost) || 0)
        const mpCost = ability ? Math.ceil((Number(ability.mpCost) || 0) * Number(combo.powerMultiplier ?? 1)) : 0
        if (Number(playerState.energy) < energyCost || Number(playerState.mp) < mpCost) { mutationError = 'Your Energy or MP changed before the combo could execute.'; return null }
        playerState.energy -= energyCost
        playerState.mp -= mpCost
        if (effect.damage) {
          const powerDamage = Math.max(0, Math.round(Number(effect.damage) * Number(combo.powerMultiplier ?? 1)))
          dealt += powerDamage
          if (effect.lifesteal) playerState.hp = Math.min(playerState.maxHp, playerState.hp + combatMechanics.enhancedHealing(actor, powerDamage))
        }
        if (effect.guard || combo.guard) playerState.guard = Math.max(Number(playerState.guard) || 0, Number(combo.guard) || Number(effect.guard) || 0)
        if (combo.attackMultiplier > 0) dealt += playerHit(fighter, enemy, Number(combo.attackMultiplier), weaponBonus)
        if (combo.evade) playerState.evading = true
        fatigueAction = combo.fatigueCost || combo.effect
        note = `${actor.name || actorId} executed ${combo.name} for ${dealt} damage.`
      } else if (action === 'class') {
        const cost = Math.max(0, Number(classMove.cost) || 0)
        if (Number(playerState.energy) < cost) { mutationError = `This class move costs ${cost} Energy.`; return null }
        playerState.energy -= cost
        const grade = classes.classGradeFor(classMastery)
        const effect = classes.classDamage({ move: classMove, mastery: classMastery, gradeBonus: grade.bonus })
        if (effect.damaging) dealt = Math.max(0, Number(effect.final) || 0)
        else if (effect.healing) playerState.hp = Math.min(playerState.maxHp, playerState.hp + effect.healing)
        if (effect.guard) playerState.guard = Math.max(Number(playerState.guard) || 0, effect.guard)
        note = `${actor.name || actorId} used ${classMove.name}${dealt ? ` for ${dealt} damage` : ''}.`
      } else {
        mutationError = 'That action is not available in party combat.'
        return null
      }
      if (fatigueAction) playerState.fatigue = combatMechanics.addFatigue(playerState.fatigue, fatigueAction, actor)
      if (dealt > 0) currentBattle.enemyHp = Math.max(0, Number(currentBattle.enemyHp) - dealt)
      if (action !== 'retreat' && Number(currentBattle.enemyHp) > 0) {
        const incoming = enemyHitDetails(enemy, { ...actor, fatigue: playerState.fatigue }, playerState.guard || 0).finalDamage
        let hit = incoming
        if (playerState.evading) {
          const dodge = combatMechanics.resolveDodge({ ...actor, fatigue: playerState.fatigue }, playerState.fatigue)
          if (dodge.result === 'perfect') hit = 0
          else if (dodge.result === 'partial') hit = Math.max(1, Math.round(hit * dodge.damageMultiplier))
          note += ` · ${dodge.result.toUpperCase()} DODGE`
        }
        playerState.hp = Math.max(0, Number(playerState.hp) - hit)
        playerState.guard = 0
        playerState.evading = false
        if (hit > 0) note += ` · enemy hit ${hit}`
      }
      /* Party members wear armor too — same formula as solo. */
      if (partySuit) {
        const beforeHp = Number(playerState.hp)
        const rawHit = Math.max(0, Number(playerState.maxHp) - beforeHp)
        const soaked = armorLib.absorb(rawHit, partySuit)
        if (soaked.absorbed > 0) {
          playerState.hp = Math.min(Number(playerState.maxHp), beforeHp + soaked.absorbed)
          note += ` · armor ${soaked.absorbed} absorbed`
        }
      }
      if (action !== 'retreat') playerState.energy = Math.min(Number(playerState.maxEnergy) || 0, Number(playerState.energy) + ENERGY_REGEN_PER_TURN)
      currentBattle.players[actorId] = playerState
      currentBattle.lastEvent = note
      currentBattle.round = Math.max(1, Number(currentBattle.round) || 1)
      const surviving = (currentBattle.memberIds || []).filter(id => !(currentBattle.retreats || []).includes(id) && Number(currentBattle.players?.[id]?.hp) > 0)
      const participating = (currentBattle.memberIds || []).filter(id => !(currentBattle.retreats || []).includes(id))
      const won = Number(currentBattle.enemyHp) <= 0
      const aborted = participating.length === 0
      const lost = !won && !aborted && surviving.length === 0
      if (won || aborted || lost) {
        currentBattle.completed = true
        currentBattle.result = won ? 'victory' : lost ? 'defeat' : 'retreated'
        state.floorBattle = currentBattle
        result = { completed: true, won, lost, aborted, battle: currentBattle, note, retreatedId: action === 'retreat' ? actorId : null }
        return { ...current, status: 'started', state }
      }
      const total = currentOrder.length
      let nextIndex = 0
      for (let offset = 1; offset <= total; offset++) {
        const index = ((Number(currentBattle.turnIndex) || 0) + offset) % total
        if (surviving.includes(String(currentOrder[index] || ''))) {
          nextIndex = index
          if (index <= (Number(currentBattle.turnIndex) || 0)) currentBattle.round += 1
          break
        }
      }
      currentBattle.turnIndex = nextIndex
      state.floorBattle = currentBattle
      result = { completed: false, battle: currentBattle, note, retreatedId: action === 'retreat' ? actorId : null }
      return { ...current, state }
    })

    if (mutationError || !updatedParty) {
      if (classSpend?.ok) await store.refundClassMove(actorId).catch(() => {})
      return send(sock, ctx.jid, m, `❌ ${mutationError || 'The party battle could not be updated.'}`)
    }
    if (result?.retreatedId) {
      const retreated = await store.player(result.retreatedId)
      const state = result.battle.players?.[result.retreatedId]
      if (retreated && state) {
        retreated.hp = Math.max(0, Math.min(retreated.maxHp, Number(state.hp) || 0))
        retreated.powerEnergy = Math.max(0, Math.min(retreated.maxPowerEnergy, Number(state.energy) || 0))
        retreated.mp = Math.max(0, Math.min(retreated.maxMp, Number(state.mp) || 0))
        retreated.fatigue = combatMechanics.fatigueValue(state.fatigue)
        retreated.fatigueUpdatedAt = new Date().toISOString()
        await store.savePlayer(retreated)
      }
    }
    if (result?.completed) {
      const completed = result.battle
      if (result.won || result.lost) {
        for (const id of completed.memberIds || []) {
          if ((completed.retreats || []).includes(id)) continue
          const player = await store.player(id)
          const memberState = completed.players?.[id]
          if (!player || !memberState) continue
          const p = store.rollDay(player)
          p.battlesSinceRest = Math.max(0, Number(p.battlesSinceRest) || 0) + 1
          p.fatigue = combatMechanics.fatigueValue(memberState.fatigue)
          p.fatigueUpdatedAt = new Date().toISOString()
          p.powerEnergy = Math.max(0, Math.min(p.maxPowerEnergy, Number(memberState.energy) || 0))
          p.mp = Math.max(0, Math.min(p.maxMp, Number(memberState.mp) || 0))
          p.hp = result.won && Number(memberState.hp) > 0
            ? Math.min(p.maxHp, Number(memberState.hp))
            : Math.max(1, Math.round(p.maxHp * 0.25))
          if (result.won) {
            const xp = Math.max(0, Math.floor(Number(completed.enemy.xp) || 0))
            const zen = Math.round((Number(completed.enemy.zen) || 0) * (completed.enemy.boss ? 2 : 1.5))
            const coins = Math.max(75, Math.round((Number(completed.enemy.zen) || 0) * (completed.enemy.boss ? 6 : 4)))
            p.xpToday += xp
            p.zenToday += zen
            p.wins += 1
            const { player: rewarded } = applyProgress(p, { xp, zen, coins })
            await store.savePlayer(rewarded)
            await store.log(id, 'party_floor_win', String(completed.ordinal), { xp, zen, coins, partyId: party.id })
            if (completed.storyQuestId) {
              const story = await store.floorStory(id)
              await store.saveFloorStory(id, floorStory.completeQuest(story, completed.storyQuestId))
            }
          } else {
            p.losses += 1
            await store.savePlayer(p)
            await store.log(id, 'party_floor_loss', String(completed.ordinal), { partyId: party.id })
          }
        }
      }
      const heading = result.won ? '🏆 PARTY VICTORY' : result.lost ? '💀 PARTY DEFEAT' : '🏃 PARTY WITHDREW'
      return partyBattleDisplay(sock, ctx.jid, m, completed, `${heading} · ${completed.enemy?.name || 'Floor encounter'} ended.`)
    }
    return partyBattleDisplay(sock, ctx.jid, m, result.battle, result.note)
  }

  async function battleAct (sock, m, ctx, action, cardSlot = 1, moveName = null) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    const party = await store.partyForUser(ctx.jid, ctx.userId).catch(() => null)
    if (party?.status === 'battling' && party.state?.floorBattle) return partyBattleAct(sock, m, ctx, action, cardSlot, moveName)
    const b = await store.getBattle(ctx.userId)
    if (!b) return duelAct(sock, m, ctx, action, moveName, cardSlot)
    b.fatigue = combatMechanics.fatigueValue(b.fatigue ?? p.fatigue)
    p.fatigue = b.fatigue

    if (action === 'retreat') {
      p.hp = Math.max(0, Math.min(p.maxHp, Number(b.playerHp ?? p.hp)))
      p.powerEnergy = Math.max(0, Math.min(p.maxPowerEnergy, Number(b.energy ?? p.powerEnergy)))
      p.mp = Math.max(0, Math.min(p.maxMp, Number(b.mp ?? p.mp)))
      p.fatigue = combatMechanics.fatigueValue(b.fatigue ?? p.fatigue)
      p.fatigueUpdatedAt = new Date().toISOString()
      await store.savePlayer(p)
      await store.setBattle(ctx.userId, null)
      const progress = Math.max(0, Number(p.battlesSinceRest) || 0)
      return send(sock, ctx.jid, m, `${WATERMARK}\n\n\ud83c\udfc3 *RETREATED*\n\nYou pull back. No rewards, no losses.\nRest progress: *${progress}/2* completed battles. Retreating does not count.`)
    }

    if (action === 'heal' && b.healsLeft <= 0) {
      return send(sock, ctx.jid, m, `\u2764\ufe0f *NO HEALS LEFT*\n\nYou have used all ${ctx.settings.selfHealPerCombat} self-heals this combat.`)
    }

    /*
     * CLASS MOVE — resolved and validated BEFORE anything is mutated.
     *
     * The old code read `CLASS_MOVES[p.class]` with p.class = 'Fighter' (the
     * DB default, capitalised) against lowercase keys, so it silently fell
     * through to the fighter move for every player. It also never rolled the
     * daily counter, so after three class moves ever the command was dead
     * forever. Both are fixed here: the class id is normalised through the
     * catalogue, and the counter is a per-UTC-day row.
     */
    let classMove = null
    let classMastery = 0
    let classGrade = null
    if (action === 'class') {
      const classId = classes.normalizeClassId(p.class)
      if (!classId) {
        return send(sock, ctx.jid, m, `\ud83c\udfad *NO CLASS*\n\nYou have no class assigned. Ask AXYON to set one with *${ctx.settings.prefix}classadmin set @you <class>*.`)
      }
      const catalogue = classes.movesForClass(classId)
      classMastery = await store.classMastery(ctx.userId, classId)
      classGrade = classes.classGradeFor(classMastery)

      /* Named move, or the strongest unlocked damaging move by default. */
      if (moveName) {
        classMove = classes.moveByName(classId, moveName)
        if (!classMove) {
          return send(sock, ctx.jid, m, `\u274c *${classes.classById(classId).name}* has no move called *${moveName}*.\n\nSee them with *${ctx.settings.prefix}class*.`)
        }
      } else {
        const unlocked = catalogue.filter(mv => mv.unlock == null || classMastery >= Number(mv.unlock))
        classMove = unlocked.filter(mv => Number(mv.damage) > 0).pop() || unlocked[0] || catalogue[0]
      }

      const usesToday = await store.classMovesUsedToday(ctx.userId)
      const check = classes.validateMoveUse({
        player: p,
        move: classMove,
        mastery: classMastery,
        usesToday,
        dailyLimit: ctx.settings.classMovesPerDay,
        inBattle: true,
        energy: b.energy
      })
      if (!check.ok) {
        const head = check.reason === 'daily_limit' ? '\ud83e\udde0 *CLASS MOVES SPENT*'
          : check.reason === 'energy' ? '\u26a1 *NOT ENOUGH POWER ENERGY*'
            : check.reason === 'locked' ? '\ud83d\udd12 *MOVE LOCKED*'
              : '\u274c *CANNOT USE THAT MOVE*'
        return send(sock, ctx.jid, m, `${head}\n\n${check.message}`)
      }
    }

    const physicalCost = Math.max(0, Number(PHYSICAL_ENERGY_COSTS[action]) || 0)
    if (physicalCost && Number(b.energy) < physicalCost) {
      return send(sock, ctx.jid, m, `⚡ ${action.toUpperCase()} costs *${physicalCost} Energy*. You have *${Math.max(0, Number(b.energy) || 0)}*.`)
    }

    let selectedAbility = null
    if (action === 'card') {
      const use = await store.useCardAbility(ctx.userId, Number(cardSlot))
      if (!use.ok) {
        const messages = {
          empty_slot: `Equipment slot ${cardSlot} is empty. Use !card equip <number>.`,
          expired: 'Expired cards cannot be used in combat.',
          no_ability: 'That card has no ability assigned.',
          depleted: 'That card has used all three ability charges for today.'
        }
        return send(sock, ctx.jid, m, `❌ ${messages[use.reason] || 'Card ability is unavailable.'}`)
      }
      selectedAbility = use.card
    }

    let selectedPower = null
    let selectedCombo = null
    if (action === 'combo') {
      selectedCombo = comboCatalog.get(moveName)
      if (!selectedCombo) return send(sock, ctx.jid, m, `❌ Unknown combo. See *${ctx.prefix}cc shop*.`)
      if (!(await store.hasCombo(ctx.userId, selectedCombo.key))) {
        return send(sock, ctx.jid, m, `🔒 *COMBO LOCKED*\n\n${selectedCombo.name}\nYou have not unlocked this combination. Discover it through training or purchase it with *${ctx.prefix}cc buy ${selectedCombo.key}*.`)
      }
      if (selectedCombo.abilityKey && (await store.inventoryQty(ctx.userId, selectedCombo.abilityKey)) < 1) {
        return send(sock, ctx.jid, m, `🔒 You must own *${items.get(selectedCombo.abilityKey)?.name || selectedCombo.abilityKey}* to execute this combo.`)
      }
      if (Number(b.energy) < selectedCombo.energyCost) {
        return send(sock, ctx.jid, m, `⚡ This combo costs *${selectedCombo.energyCost} Energy*. You have *${Math.max(0, Number(b.energy) || 0)}*.`)
      }
      if (selectedCombo.abilityKey) {
        const powerEntry = items.get(selectedCombo.abilityKey)
        const mpCost = Math.ceil((Number(powerEntry?.mpCost) || 0) * Number(selectedCombo.powerMultiplier ?? 1))
        if (Number(b.mp ?? p.mp) < mpCost) return send(sock, ctx.jid, m, `🔮 This combo costs *${mpCost} MP*. You have *${Math.max(0, Number(b.mp ?? p.mp) || 0)} MP*.`)
      }
    }
    if (action === 'power') {
      const key = String(moveName || '').trim().toLowerCase()
      selectedPower = items.get(key) || items.abilities().find(entry => entry.name.toLowerCase() === key)
      if (!selectedPower || selectedPower.kind !== 'ability') {
        return send(sock, ctx.jid, m, `Usage: *${ctx.settings.prefix}power <owned power>* · See your powers with *${ctx.settings.prefix}power*.`)
      }
      if ((await store.inventoryQty(ctx.userId, selectedPower.key)) < 1) {
        return send(sock, ctx.jid, m, `🔒 You have not unlocked *${selectedPower.name}*. Buy it from *${ctx.settings.prefix}shop abilities*.`)
      }
      const mpCost = Math.max(0, Number(selectedPower.mpCost) || 0)
      if (Number(b.mp ?? p.mp) < mpCost) return send(sock, ctx.jid, m, `🔮 *${selectedPower.name}* costs *${mpCost} MP*. You have *${Math.max(0, Number(b.mp ?? p.mp) || 0)} MP*.`)
    }

    let note = ''
    let dealt = 0

    if (action === 'attack') {
      const equipped = await store.equippedCards(ctx.userId)
      const weaponCard = equipped.find(c => Number(c.equipped_slot) === 1)
      const baseBonus = weaponCard && (!weaponCard.expires_at || new Date(weaponCard.expires_at).getTime() > Date.now()) ? Number(weaponCard.damage) || 0 : 0
      dealt = playerHit({ ...p, fatigue: b.fatigue }, b.enemy, 1.0, baseBonus)
      b.energy = Math.max(0, Number(b.energy) - physicalCost)
      b.fatigue = combatMechanics.addFatigue(b.fatigue, 'attack', p)
      note = `\u2694\ufe0f You strike for *${dealt}*${baseBonus ? ` (includes ${weaponCard.name} +${baseBonus})` : ''}.`
    } else if (action === 'heavy') {
      const equipped = await store.equippedCards(ctx.userId)
      const weaponCard = equipped.find(c => Number(c.equipped_slot) === 1)
      const baseBonus = weaponCard && (!weaponCard.expires_at || new Date(weaponCard.expires_at).getTime() > Date.now()) ? Number(weaponCard.damage) || 0 : 0
      b.energy = Math.max(0, Number(b.energy) - physicalCost)
      dealt = playerHit({ ...p, fatigue: b.fatigue }, b.enemy, HEAVY_ATTACK_MULTIPLIER, baseBonus)
      b.fatigue = combatMechanics.addFatigue(b.fatigue, 'heavy', p)
      note = `💥 *HEAVY ATTACK* deals *${dealt}* damage. (-${HEAVY_ATTACK_ENERGY} Energy)`
    } else if (action === 'guard' || action === 'block') {
      b.energy = Math.max(0, Number(b.energy) - physicalCost)
      b.guard = 0.6
      b.fatigue = combatMechanics.addFatigue(b.fatigue, 'block', p)
      note = '🛡️ You brace for the counter.'
    } else if (action === 'dodge') {
      b.energy = Math.max(0, Number(b.energy) - physicalCost)
      b.evade = true
      b.fatigue = combatMechanics.addFatigue(b.fatigue, 'dodge', p)
      note = '🌀 You prepare to evade the enemy counter.'
    } else if (action === 'heal') {
      /*
       * FLAT 10 HP, as the implementation note specifies.
       *
       * This used to heal 25% of max HP, which scaled with the player and made
       * the five-per-combat limit worth wildly different amounts at level 1 and
       * level 80. The note fixes the value at 10, so it is a constant now.
       */
      const amount = SELF_HEAL_HP + combatMechanics.healingBonus(p, SELF_HEAL_HP)
      b.playerHp = Math.min(p.maxHp, b.playerHp + amount)
      b.healsLeft -= 1
      p.healUses += 1
      await store.savePlayer(p)
      note = `\u2764\ufe0f You recover *${amount}* HP. *${b.healsLeft}* heals left.`
    } else if (action === 'class') {
      /*
       * Consume the daily use ATOMICALLY, before applying anything. If the
       * limit was already reached the statement matches no row and we bail
       * without touching energy, HP or the enemy.
       */
      const spend = await store.consumeClassMove(ctx.userId, ctx.settings.classMovesPerDay)
      if (!spend.ok) {
        return send(sock, ctx.jid, m, `\ud83e\udde0 *CLASS MOVES SPENT*\n\nYou have used all *${ctx.settings.classMovesPerDay}* class moves today. Resets at 00:00 UTC.`)
      }

      const cost = Number(classMove.cost) || 0
      if (cost > 0) b.energy = Math.max(0, b.energy - cost)

      const dmg = classes.classDamage({
        move: classMove,
        mastery: classMastery,
        gradeBonus: classGrade.bonus
      })

      if (dmg.damaging) {
        const classStrengthBonus = classMove.type === 'offensive' ? Math.floor(Math.max(0, (Number(p.str) || 5) - 5) * 0.35) : 0
        dealt = Math.max(1, Math.round(combatMechanics.applyFatiguePenalty(Number(dmg.final) + classStrengthBonus, p, b.fatigue)))
        if (classMove.type === 'offensive') b.fatigue = combatMechanics.addFatigue(b.fatigue, 'attack', p)
        note = `\ud83e\udde0 *${classMove.name}* lands for *${dealt}*.`
        if (dmg.bonus) note += `\n> base ${dmg.scaled} + class ${classGrade.grade} bonus ${dmg.bonus}`
      } else if (classMove.type === 'defensive') {
        b.guard = 0.6
        note = `\ud83d\udee1\ufe0f *${classMove.name}* \u2014 you brace.`
      } else if (classMove.type === 'support' && Number(classMove.heal) > 0) {
        const before = b.playerHp
        b.playerHp = Math.min(p.maxHp, b.playerHp + combatMechanics.enhancedHealing(p, Number(classMove.heal)))
        note = `\u2764\ufe0f *${classMove.name}* restores *${b.playerHp - before}* HP.`
      } else {
        note = `\u2728 *${classMove.name}* \u2014 ${classMove.desc || 'the effect takes hold.'}`
      }

      /* Keep the legacy column in step so the profile card stays truthful. */
      p.classMovesUsed = spend.used
      await store.savePlayer(p)

      await store.log(ctx.userId, 'class_move', classMove.id, {
        classId: classes.normalizeClassId(p.class),
        move: classMove.name,
        type: classMove.type,
        mastery: classMastery,
        grade: classGrade.grade,
        bonus: classGrade.bonus,
        base: dmg.base,
        scaled: dmg.scaled,
        final: dmg.final,
        cost,
        usedToday: spend.used,
        remaining: spend.remaining
      })

      /* Mastery award is 0 until the owner approves the values. */
      const award = classes.masteryFor('classMove')
      if (award > 0) await store.addClassMastery(ctx.userId, classes.normalizeClassId(p.class), award)

      note += `\n> \ud83e\udde0 ${spend.remaining}/${ctx.settings.classMovesPerDay} class moves left today`
    } else if (action === 'card') {
      dealt = playerHit(p, b.enemy, 1.0, Number(selectedAbility?.ability_damage) || 0)
      note = `\ud83c\udccf *${selectedAbility.name} · ${selectedAbility.ability}* erupts for *${dealt}*. (${selectedAbility.ability_uses}/3 today)`
    } else if (action === 'combo') {
      const equipped = await store.equippedCards(ctx.userId)
      const weaponCard = equipped.find(c => Number(c.equipped_slot) === 1)
      const baseBonus = weaponCard && (!weaponCard.expires_at || new Date(weaponCard.expires_at).getTime() > Date.now()) ? Number(weaponCard.damage) || 0 : 0
      const powerEntry = selectedCombo.abilityKey ? items.get(selectedCombo.abilityKey) : null
      const effect = powerEntry?.effect || {}
      const energyCost = Math.max(0, Number(selectedCombo.energyCost) || 0)
      b.energy = Math.max(0, Number(b.energy) - energyCost)
      const mpCost = powerEntry ? Math.ceil((Number(powerEntry.mpCost) || 0) * Number(selectedCombo.powerMultiplier ?? 1)) : 0
      b.mp = Math.max(0, Number(b.mp ?? p.mp) - mpCost)
      const parts = []
      const powerDamage = effect.damage ? Math.max(0, Math.round(Number(effect.damage) * Number(selectedCombo.powerMultiplier ?? 1))) : 0
      if (powerDamage > 0) {
        dealt += powerDamage
        parts.push(`${powerEntry.name} ${powerDamage}`)
        if (effect.lifesteal) {
          const healed = Math.min(p.maxHp, b.playerHp + combatMechanics.enhancedHealing(p, powerDamage)) - b.playerHp
          b.playerHp += healed
          parts.push(`+${healed} HP`)
        }
      }
      if (effect.guard || selectedCombo.guard) {
        b.guard = Math.max(Number(b.guard) || 0, Number(selectedCombo.guard) || Number(effect.guard) || 0)
        parts.push(`${Math.round(b.guard * 100)}% block`)
      }
      if (selectedCombo.attackMultiplier > 0) {
        const physicalPlayer = { ...p, fatigue: b.fatigue }
        const strike = playerHit(physicalPlayer, b.enemy, Number(selectedCombo.attackMultiplier), baseBonus)
        dealt += strike
        parts.push(`${selectedCombo.attackMultiplier >= HEAVY_ATTACK_MULTIPLIER ? 'Heavy' : 'Attack'} ${strike}`)
      }
      if (selectedCombo.evade) {
        b.evade = true
        if (selectedCombo.dodgeBonus) b.dodgeBonus = Number(selectedCombo.dodgeBonus)
        parts.push('evasion prepared')
      }
      b.fatigue = combatMechanics.addFatigue(b.fatigue, selectedCombo.fatigueCost || selectedCombo.effect, p)
      note = `🔗 *${selectedCombo.name}*\n${parts.join(' · ')} · ⚡ -${energyCost} Energy${mpCost ? ` · 🔮 -${mpCost} MP` : ''}`
    } else if (action === 'power') {
      const result = items.apply(selectedPower, b, { ...p, mp: Number(b.mp ?? p.mp), maxMp: p.maxMp })
      if (!result.ok) return send(sock, ctx.jid, m, `❌ ${result.note}`)
      b.enemyHp = result.battle.enemyHp
      b.playerHp = result.battle.playerHp
      b.guard = result.battle.guard
      b.mp = result.battle.mp
      note = `✨ *${selectedPower.name}*\n${result.note}`
    }

    b.enemyHp -= dealt

    p.fatigue = b.fatigue
    p.fatigueUpdatedAt = new Date().toISOString()
    if (b.enemyHp <= 0) return finishBattle(sock, m, ctx, p, b, true)

    const hitDetails = enemyHitDetails(b.enemy, { ...p, fatigue: b.fatigue }, b.guard)
    let hit = hitDetails.finalDamage
    let blocked = hitDetails.blocked
    b.guard = 0
    if (b.evade) {
      const dodgeBonus = Math.max(0, Number(b.dodgeBonus) || 0)
      const dodge = combatMechanics.resolveDodge({ ...p, fatigue: b.fatigue }, b.fatigue, Math.random(), dodgeBonus)
      if (dodge.result === 'perfect') {
        blocked += hit
        hit = 0
        note += '\n🌀 *PERFECT DODGE* · You avoid the counter completely.'
      } else if (dodge.result === 'partial') {
        const before = hit
        hit = Math.max(1, Math.round(hit * dodge.damageMultiplier))
        blocked += Math.max(0, before - hit)
        note += `\n🌀 *PARTIAL DODGE* · Incoming damage reduced to *${hit}*.`
      } else {
        note += '\n🌀 *DODGE FAILED* · The counter connects.'
      }
      b.evade = false
      b.dodgeBonus = 0
    }
    /* A worn suit absorbs a flat slice of the hit that just landed. */
    const wornSuit = await store.equippedArmor(ctx.userId).catch(() => null)
    if (wornSuit) {
      const soaked = armorLib.absorb(hit, wornSuit)
      if (soaked.absorbed > 0) {
        hit = soaked.damage
        blocked += soaked.absorbed
        note += `\n\ud83d\udee1\ufe0f Armor absorbed *${soaked.absorbed}*.`
      }
    }
    b.playerHp -= hit
    b.damageTaken = Math.max(0, Number(b.damageTaken) || 0) + hit
    b.damageBlocked = Math.max(0, Number(b.damageBlocked) || 0) + blocked
    if (hit > 0) note += `\n\ud83d\udc79 ${b.enemy.name} answers for *${hit}*.`
    /*
     * THE NPC'S CLASS MOVE.
     *
     * An NPC with a class now actually uses it — otherwise the class, rank,
     * grade and mastery on its card would be decoration. It fires on a fixed
     * cadence (every third round) rather than at random, so a fight is
     * predictable enough to plan around and the player can see it coming.
     *
     * The damage comes from `npc.npcMoveDamage()`, which routes through the
     * SAME `classes.classDamage()` the player's move uses. There is no second
     * formula, so a rebalance cannot leave the two sides disagreeing.
     */
    if (b.enemy.npc && b.enemy.signatureMove && b.turn % 3 === 0) {
      const move = npc.npcMoveDamage(b.enemy)
      if (move.damaging && move.final > 0) {
        b.playerHp -= move.final
        b.damageTaken = Math.max(0, Number(b.damageTaken) || 0) + move.final
        note += `\n\u2728 ${b.enemy.name} uses *${b.enemy.signature}* for *${move.final}* damage.`
      } else if (b.enemy.signature) {
        note += `\n\u2728 ${b.enemy.name} invokes *${b.enemy.signature}*.`
      }
    }

    if (b.playerHp <= 0) return finishBattle(sock, m, ctx, p, b, false)

    b.turn += 1
    b.energy = Math.min(p.maxPowerEnergy, b.energy + ENERGY_REGEN_PER_TURN)
    b.equippedCards = await store.equippedCards(ctx.userId)
    b.lastEvent = note
    await persistFatigue(ctx.userId, p.fatigue, p.fatigueUpdatedAt, p)
    await store.setBattle(ctx.userId, b)

    return withVisual(sock, ctx.jid, m, b.enemy.boss ? 'boss' : 'battle', battleCard(b, p, note), battleButtons(), true)
  }

  /* ---------------------------------------------------------- direct duels */

  async function demoteDuelPlayers (sock, duelRow) {
    const promoted = Array.isArray(duelRow?.promoted) ? duelRow.promoted : []
    if (!promoted.length || !duelRow?.group_jid || !sock.groupParticipantsUpdate) return
    try {
      await sock.groupParticipantsUpdate(
        duelRow.group_jid,
        promoted.map(id => `${String(id).split('@')[0]}@s.whatsapp.net`),
        'demote'
      )
    } catch (error) {
      logger?.warn?.({ err: error?.message || error, duelId: duelRow.id }, 'duel admin demotion failed')
    }
  }

  async function duelAct (sock, m, ctx, action, moveName = null, cardSlot = 1) {
    const d = await store.activeDuelForUser(ctx.userId, ctx.jid)
    if (!d) return send(sock, ctx.jid, m, `⚔️ No active battle. Use *${ctx.prefix}stages* or challenge someone with *${ctx.prefix}duel @player*.`)
    const actorId = String(ctx.userId)
    const challengerId = String(d.challenger)
    const opponentId = String(d.opponent)
    if (![challengerId, opponentId].includes(actorId)) {
      return send(sock, ctx.jid, m, '🔒 You are not a fighter in this duel.')
    }
    const first = await store.player(challengerId)
    const second = await store.player(opponentId)
    if (!first || !second) return send(sock, ctx.jid, m, '❌ A fighter is no longer registered. This duel cannot continue.')

    if (action === 'retreat') {
      let retired = false
      const closed = await store.mutateDuel(d.id, current => {
        if (current.status !== 'active') return null
        retired = true
        return { status: 'retreated', state: { ...(current.state || {}), retreatedBy: actorId } }
      })
      if (!retired || closed?.status !== 'retreated') return send(sock, ctx.jid, m, '⌛ This duel has already ended.')
      await store.log(actorId, 'duel_retreat', String(d.id), { opponent: actorId === challengerId ? opponentId : challengerId })
      await demoteDuelPlayers(sock, d)
      return send(sock, ctx.jid, m, `${WATERMARK}\n\n🏃 *DUEL RETREATED*\n\nNo rewards or losses were recorded. Retreating does not count towards either fighter's rest progress.`)
    }

    const liveState = d.state || {}
    if (String(liveState.turn || challengerId) !== actorId) {
      const nextId = String(liveState.turn || challengerId)
      const next = nextId === challengerId ? first : second
      return send(sock, ctx.jid, m, `⌛ It is *${next.name || 'the other hunter'}*'s turn.`)
    }

    const actor = actorId === challengerId ? first : second
    const targetId = actorId === challengerId ? opponentId : challengerId
    const target = actorId === challengerId ? second : first
    let card = null
    let power = null
    let classMove = null
    let classSpend = null
    let classMastery = 0
    let weaponCard = null

    if (action === 'attack' || action === 'heavy' || action === 'combo') {
      const equipped = await store.equippedCards(actorId)
      weaponCard = equipped.find(c => Number(c.equipped_slot) === 1) || null
    }

    if (action === 'card') {
      const use = await store.useCardAbility(actorId, Number(cardSlot) || 1)
      if (!use.ok) {
        const messages = {
          empty_slot: `Equipment slot ${cardSlot} is empty. Use !card equip <number>.`,
          expired: 'Expired cards cannot be used in combat.',
          no_ability: 'That card has no ability assigned.',
          depleted: 'That card has used all three ability charges for today.'
        }
        return send(sock, ctx.jid, m, `❌ ${messages[use.reason] || 'Card ability is unavailable.'}`)
      }
      card = use.card
    }

    if (action === 'power') {
      const key = String(moveName || '').trim().toLowerCase()
      power = items.get(key) || items.abilities().find(entry => entry.name.toLowerCase() === key)
      if (!power || power.kind !== 'ability') {
        return send(sock, ctx.jid, m, `Usage: *${ctx.prefix}power <owned power>* · See available powers with *${ctx.prefix}power*.`)
      }
      if ((await store.inventoryQty(actorId, power.key)) < 1) {
        return send(sock, ctx.jid, m, `🔒 You have not unlocked *${power.name}*. Buy it from *${ctx.prefix}shop abilities*.`)
      }
      const mpCost = Math.max(0, Number(power.mpCost) || 0)
      const availableMp = Number((liveState.mp || {})[actorId] ?? actor.mp) || 0
      if (availableMp < mpCost) return send(sock, ctx.jid, m, `🔮 ${power.name} costs *${mpCost} MP*. You have *${availableMp} MP*.`)
    }

    if (action === 'combo') {
      const combo = comboCatalog.get(moveName)
      if (!combo) return send(sock, ctx.jid, m, `❌ Unknown combo. See *${ctx.prefix}cc shop*.`)
      if (!(await store.hasCombo(actorId, combo.key))) return send(sock, ctx.jid, m, `🔒 *COMBO LOCKED*\n\n${combo.name}\nUnlock it through training or purchase.`)
      if (combo.abilityKey && (await store.inventoryQty(actorId, combo.abilityKey)) < 1) return send(sock, ctx.jid, m, `🔒 You must own *${items.get(combo.abilityKey)?.name || combo.abilityKey}* to execute this combo.`)
      if (Number((liveState.energy || {})[actorId] ?? actor.powerEnergy) < combo.energyCost) return send(sock, ctx.jid, m, `⚡ This combo costs *${combo.energyCost} Energy*.`)
      if (combo.abilityKey) {
        const ability = items.get(combo.abilityKey)
        const mpCost = Math.ceil((Number(ability?.mpCost) || 0) * Number(combo.powerMultiplier ?? 1))
        const availableMp = Number((liveState.mp || {})[actorId] ?? actor.mp) || 0
        if (availableMp < mpCost) return send(sock, ctx.jid, m, `🔮 This combo costs *${mpCost} MP*. You have *${availableMp} MP*.`)
      }
      power = combo
    }

    if (action === 'class') {
      const classId = classes.normalizeClassId(actor.class)
      const moves = classId ? classes.movesForClass(classId) : []
      classMastery = await store.classMastery(actorId, classId)
      if (!classId || !moves.length) return send(sock, ctx.jid, m, '🎭 You do not have an available class move.')
      classMove = moveName ? classes.moveByName(classId, moveName) : moves.filter(x => x.unlock == null || classMastery >= Number(x.unlock)).filter(x => Number(x.damage) > 0).pop()
      if (!classMove) return send(sock, ctx.jid, m, `🔒 That class move is unavailable. Use *${ctx.prefix}class* to see your moves.`)
      const usesToday = await store.classMovesUsedToday(actorId)
      const check = classes.validateMoveUse({ player: actor, move: classMove, mastery: classMastery, usesToday, dailyLimit: ctx.settings.classMovesPerDay, inBattle: true, energy: Number((liveState.energy || {})[actorId] ?? actor.powerEnergy) })
      if (!check.ok) return send(sock, ctx.jid, m, check.message)
      classSpend = await store.consumeClassMove(actorId, ctx.settings.classMovesPerDay)
      if (!classSpend.ok) return send(sock, ctx.jid, m, `🧠 You have used all ${ctx.settings.classMovesPerDay} class moves today.`)
    }

    let mutationError = ''
    let waitingForTurn = false
    let resultState = null
    let winnerId = null
    let actionNote = ''
    /* Armor is loaded BEFORE the mutation callback: that callback is
     * synchronous, so it cannot await a query mid-turn. */
    const duelArmor = await armorLib.wornBy([challengerId, opponentId])
    const updated = await store.mutateDuel(d.id, current => {
      if (current.status !== 'active') { mutationError = 'ended'; return null }
      const state = { ...(current.state || {}) }
      state.hp = { ...(state.hp || { [challengerId]: first.hp, [opponentId]: second.hp }) }
      state.maxHp = { ...(state.maxHp || { [challengerId]: first.maxHp, [opponentId]: second.maxHp }) }
      state.energy = { ...(state.energy || { [challengerId]: first.powerEnergy, [opponentId]: second.powerEnergy }) }
      state.maxEnergy = { ...(state.maxEnergy || { [challengerId]: first.maxPowerEnergy, [opponentId]: second.maxPowerEnergy }) }
      state.mp = { ...(state.mp || { [challengerId]: first.mp, [opponentId]: second.mp }) }
      state.maxMp = { ...(state.maxMp || { [challengerId]: first.maxMp, [opponentId]: second.maxMp }) }
      state.fatigue = { ...(state.fatigue || { [challengerId]: first.fatigue || 0, [opponentId]: second.fatigue || 0 }) }
      state.guards = { ...(state.guards || {}) }
      state.evading = { ...(state.evading || {}) }
      state.evadeBonus = { ...(state.evadeBonus || {}) }
      state.heals = { ...(state.heals || {}) }
      if (String(state.turn || challengerId) !== actorId) { waitingForTurn = true; return null }

      let damage = 0
      const actorHp = Math.max(0, Number(state.hp[actorId] ?? actor.hp))
      const targetHp = Math.max(0, Number(state.hp[targetId] ?? target.hp))
      const actorFatigue = combatMechanics.fatigueValue(state.fatigue[actorId] ?? actor.fatigue)
      const targetFatigue = combatMechanics.fatigueValue(state.fatigue[targetId] ?? target.fatigue)
      const actorForTurn = { ...actor, fatigue: actorFatigue }
      const targetStats = { ...target, fatigue: targetFatigue }
      let fatigueAction = ''
      if (action === 'attack' || action === 'heavy') {
        const energy = Math.max(0, Number(state.energy[actorId] ?? actor.powerEnergy))
        const cost = Number(PHYSICAL_ENERGY_COSTS[action]) || 0
        if (energy < cost) {
          mutationError = `${action.toUpperCase()} costs ${cost} Energy. You have ${energy}.`
          return null
        }
        let cardBonus = 0
        let weaponName = ''
        if (weaponCard && (!weaponCard.expires_at || new Date(weaponCard.expires_at).getTime() > Date.now())) {
          cardBonus = Number(weaponCard.damage) || 0
          weaponName = weaponCard.name || ''
        }
        damage = playerHit(actorForTurn, targetStats, action === 'heavy' ? HEAVY_ATTACK_MULTIPLIER : 1, cardBonus)
        fatigueAction = action
        state.energy[actorId] = energy - cost
        actionNote = action === 'heavy' ? `💥 Heavy Attack (-${cost} Energy)` : `⚔️ Strike (-${cost} Energy)${weaponName ? ` · ${weaponName}` : ''}`
      } else if (action === 'guard' || action === 'block') {
        const energy = Math.max(0, Number(state.energy[actorId] ?? actor.powerEnergy))
        const cost = Number(PHYSICAL_ENERGY_COSTS[action]) || 0
        if (energy < cost) { mutationError = `Block costs ${cost} Energy. You have ${energy}.`; return null }
        state.energy[actorId] = energy - cost
        state.guards[actorId] = 0.6
        fatigueAction = 'block'
        actionNote = `🛡️ Guard raised (-${cost} Energy)`
      } else if (action === 'dodge') {
        const energy = Math.max(0, Number(state.energy[actorId] ?? actor.powerEnergy))
        const cost = Number(PHYSICAL_ENERGY_COSTS.dodge) || 0
        if (energy < cost) { mutationError = `Dodge costs ${cost} Energy. You have ${energy}.`; return null }
        state.energy[actorId] = energy - cost
        state.evading[actorId] = true
        fatigueAction = 'dodge'
        actionNote = `🌀 Evasion prepared (-${cost} Energy)`
      } else if (action === 'heal') {
        const used = Number(state.heals[actorId] || 0)
        const limit = Math.max(1, Number(ctx.settings.selfHealPerCombat) || 5)
        if (used >= limit) { mutationError = `You have used all ${limit} heals in this duel.`; return null }
        const healed = Math.min(Number(state.maxHp[actorId] || actor.maxHp), actorHp + combatMechanics.enhancedHealing(actor, SELF_HEAL_HP)) - actorHp
        if (healed <= 0) { mutationError = 'Your HP is already full.'; return null }
        state.hp[actorId] = actorHp + healed
        state.heals[actorId] = used + 1
        actionNote = `❤️ +${healed} HP`
      } else if (action === 'card') {
        damage = playerHit(actor, targetStats, 1, Number(card?.ability_damage) || 0)
        actionNote = `🎴 ${card?.ability || card?.name || 'Card ability'}`
      } else if (action === 'power') {
        const fakeBattle = { enemy: { hp: target.maxHp, atk: target.atk, def: target.def }, enemyHp: targetHp, playerHp: actorHp, guard: 0 }
        fakeBattle.mp = Number(state.mp[actorId] ?? actor.mp)
        const applied = items.apply(power, fakeBattle, { ...actorForTurn, mp: fakeBattle.mp, maxMp: actor.maxMp })
        if (!applied.ok) { mutationError = applied.note; return null }
        state.hp[actorId] = applied.battle.playerHp
        state.guards[actorId] = applied.battle.guard || 0
        state.mp[actorId] = Number(applied.battle.mp) || 0
        damage = targetHp - Number(applied.battle.enemyHp)
        actionNote = `✨ ${power.name}`
      } else if (action === 'combo') {
        const energy = Math.max(0, Number(state.energy[actorId] ?? actor.powerEnergy))
        const combo = power
        if (energy < combo.energyCost) { mutationError = `This combo costs ${combo.energyCost} Energy. You have ${energy}.`; return null }
        state.energy[actorId] = energy - combo.energyCost
        let cardBonus = 0
        if (weaponCard && (!weaponCard.expires_at || new Date(weaponCard.expires_at).getTime() > Date.now())) cardBonus = Number(weaponCard.damage) || 0
        const ability = combo.abilityKey ? items.get(combo.abilityKey) : null
        const effect = ability?.effect || {}
        const parts = []
        const mpCost = ability ? Math.ceil((Number(ability.mpCost) || 0) * Number(combo.powerMultiplier ?? 1)) : 0
        const currentMp = Math.max(0, Number(state.mp[actorId] ?? actor.mp) || 0)
        if (currentMp < mpCost) { mutationError = `This combo costs ${mpCost} MP. You have ${currentMp}.`; return null }
        state.mp[actorId] = currentMp - mpCost
        if (effect.damage) {
          const powerDamage = Math.max(0, Math.round(Number(effect.damage) * Number(combo.powerMultiplier ?? 1)))
          damage += powerDamage
          parts.push(`${ability.name} ${powerDamage}`)
          if (effect.lifesteal) {
            const healed = Math.min(Number(state.maxHp[actorId] || actor.maxHp), Number(state.hp[actorId]) + combatMechanics.enhancedHealing(actor, powerDamage)) - Number(state.hp[actorId])
            state.hp[actorId] = Number(state.hp[actorId]) + healed
            parts.push(`+${healed} HP`)
          }
        }
        if (effect.guard || combo.guard) {
          state.guards[actorId] = Math.max(Number(state.guards[actorId]) || 0, Number(combo.guard) || Number(effect.guard) || 0)
          parts.push(`${Math.round(state.guards[actorId] * 100)}% block`)
        }
        if (combo.attackMultiplier > 0) {
          const hit = playerHit(actorForTurn, targetStats, Number(combo.attackMultiplier), cardBonus)
          damage += hit
          parts.push(`${combo.attackMultiplier >= HEAVY_ATTACK_MULTIPLIER ? 'Heavy' : 'Attack'} ${hit}`)
        }
        if (combo.evade) {
          state.evading[actorId] = true
          state.evadeBonus[actorId] = Number(combo.dodgeBonus) || 0
          parts.push('evasion prepared')
        }
        fatigueAction = combo.fatigueCost || combo.effect
        actionNote = `🔗 ${combo.name} · ${parts.join(' · ')}${mpCost ? ` · -${mpCost} MP` : ''}`
      } else if (action === 'class') {
        const energy = Math.max(0, Number(state.energy[actorId] ?? actor.powerEnergy))
        const cost = Math.max(0, Number(classMove.cost) || 0)
        if (energy < cost) { mutationError = `Not enough Energy. This move costs ${cost}.`; return null }
        if (cost) state.energy[actorId] = energy - cost
        const classId = classes.normalizeClassId(actor.class)
        const grade = classes.classGradeFor(classMastery)
        const effect = classes.classDamage({ move: classMove, mastery: classMastery, gradeBonus: grade.bonus })
        if (effect.damaging) {
          const classStrengthBonus = classMove.type === 'offensive' ? Math.floor(Math.max(0, (Number(actor.str) || 5) - 5) * 0.35) : 0
          damage = Math.max(1, Math.round(combatMechanics.applyFatiguePenalty((Number(effect.final) || 1) + classStrengthBonus, actorForTurn, actorFatigue)))
          if (classMove.type === 'offensive') fatigueAction = 'attack'
          actionNote = `🎭 ${classMove.name}`
        } else if (classMove.type === 'defensive') {
          state.guards[actorId] = 0.6
          actionNote = `🛡️ ${classMove.name} · Guard raised`
        } else if (classMove.type === 'support' && Number(classMove.heal) > 0) {
          const healed = Math.min(Number(state.maxHp[actorId] || actor.maxHp), actorHp + combatMechanics.enhancedHealing(actor, Number(classMove.heal))) - actorHp
          state.hp[actorId] = actorHp + healed
          actionNote = `❤️ ${classMove.name} · +${healed} HP`
        } else actionNote = `✨ ${classMove.name}`
      } else {
        mutationError = 'That action is not available in a direct duel.'
        return null
      }

      if (fatigueAction) state.fatigue[actorId] = combatMechanics.addFatigue(actorFatigue, fatigueAction, actor)
      if (damage > 0) {
        const guard = Math.max(0, Math.min(0.9, Number(state.guards[targetId]) || 0))
        let finalDamage = Math.max(1, Math.round(damage * (1 - guard)))
        state.guards[targetId] = 0
        if (state.evading[targetId]) {
          const dodge = combatMechanics.resolveDodge(targetStats, targetFatigue, Math.random(), Number(state.evadeBonus[targetId]) || 0)
          state.evading[targetId] = false
          state.evadeBonus[targetId] = 0
          if (dodge.result === 'perfect') {
            finalDamage = 0
            actionNote += ' · PERFECT DODGE'
          } else if (dodge.result === 'partial') {
            finalDamage = Math.max(1, Math.round(finalDamage * dodge.damageMultiplier))
            actionNote += ' · PARTIAL DODGE'
          } else actionNote += ' · DODGE FAILED'
        }
        state.hp[targetId] = Math.max(0, targetHp - finalDamage)
        if (finalDamage) actionNote += ` · ${finalDamage} dealt`
      }

      /* The defender's worn suit soaks part of whatever landed. */
      const defenderSuit = duelArmor.get(String(targetId))
      if (defenderSuit) {
        const before = Math.max(0, Number(state.hp[targetId]) || 0)
        const soaked = armorLib.absorb(Math.max(0, targetHp - before), defenderSuit)
        if (soaked.absorbed > 0) {
          state.hp[targetId] = Math.min(Number(state.maxHp[targetId] || target.maxHp), before + soaked.absorbed)
          actionNote += ` · ARMOR ${soaked.absorbed} absorbed`
        }
      }

      state.round = Math.max(1, Number(state.round) || 1)
      if (Number(state.hp[targetId]) <= 0) {
        winnerId = actorId
        state.winner = actorId
      } else {
        const currentEnergy = Math.max(0, Number(state.energy[actorId] ?? actor.powerEnergy))
        state.energy[actorId] = Math.min(Number(state.maxEnergy[actorId] ?? actor.maxPowerEnergy), currentEnergy + ENERGY_REGEN_PER_TURN)
        state.turn = targetId
        state.round += 1
      }
      state.lastAction = actionNote
      resultState = state
      return { status: winnerId ? 'completed' : 'active', state }
    })

    if (mutationError) {
      if (classSpend?.ok) await store.refundClassMove(actorId).catch(() => {})
      if (mutationError === 'ended') return send(sock, ctx.jid, m, '⌛ This duel has already ended.')
      return send(sock, ctx.jid, m, `❌ ${mutationError}`)
    }
    if (waitingForTurn) {
      if (classSpend?.ok) await store.refundClassMove(actorId).catch(() => {})
      const nextId = String((updated?.state || liveState).turn || challengerId)
      const next = nextId === challengerId ? first : second
      return send(sock, ctx.jid, m, `⌛ It is *${next.name}*'s turn.`)
    }
    if (!updated) {
      if (classSpend?.ok) await store.refundClassMove(actorId).catch(() => {})
      return send(sock, ctx.jid, m, '⌛ This duel has already ended.')
    }
    if (updated.status === 'completed' && winnerId) {
      const winningPlayer = await store.player(winnerId)
      const losingId = winnerId === challengerId ? opponentId : challengerId
      const losingPlayer = await store.player(losingId)
      if (!winningPlayer || !losingPlayer) return send(sock, ctx.jid, m, '⚠️ Duel ended, but a fighter record could not be loaded for rewards.')

      let winner = store.rollDay(winningPlayer)
      let loser = store.rollDay(losingPlayer)
      const finalState = resultState || updated.state || {}
      winner.fatigue = combatMechanics.fatigueValue(finalState.fatigue?.[winnerId] ?? winner.fatigue)
      loser.fatigue = combatMechanics.fatigueValue(finalState.fatigue?.[losingId] ?? loser.fatigue)
      winner.fatigueUpdatedAt = new Date().toISOString()
      loser.fatigueUpdatedAt = new Date().toISOString()
      winner.hp = Math.max(1, Math.min(winner.maxHp, Number(finalState.hp?.[winnerId] ?? winner.hp)))
      loser.hp = Math.max(1, Math.round(loser.maxHp * 0.25))
      winner.powerEnergy = Math.max(0, Math.min(winner.maxPowerEnergy, Number(finalState.energy?.[winnerId] ?? winner.powerEnergy)))
      loser.powerEnergy = Math.max(0, Math.min(loser.maxPowerEnergy, Number(finalState.energy?.[losingId] ?? loser.powerEnergy)))
      winner.mp = Math.max(0, Math.min(winner.maxMp, Number(finalState.mp?.[winnerId] ?? winner.mp)))
      loser.mp = Math.max(0, Math.min(loser.maxMp, Number(finalState.mp?.[losingId] ?? loser.mp)))
      winner.battlesSinceRest = Math.max(0, Number(winner.battlesSinceRest) || 0) + 1
      loser.battlesSinceRest = Math.max(0, Number(loser.battlesSinceRest) || 0) + 1
      /* Both fighters' suits take one point of wear for the completed duel. */
      await armorLib.wearAfterBattle(winnerId).catch(() => null)
      await armorLib.wearAfterBattle(losingId).catch(() => null)
      winner.wins += 1
      loser.losses += 1

      const xp = Math.max(0, Math.floor(60 + loser.level * 5))
      const requestedZen = 80 + loser.level * 8
      const zen = requestedZen
      const coins = 300 + loser.level * 40
      winner.xpToday += xp
      winner.zenToday += zen
      const { player: rewarded, events } = applyProgress(winner, { xp, zen, coins })
      await store.savePlayer(rewarded)
      await store.savePlayer(loser)
      await store.log(winnerId, 'duel_win', String(d.id), { opponent: losingId, xp, zen, coins })
      await store.log(losingId, 'duel_loss', String(d.id), { opponent: winnerId })
      await demoteDuelPlayers(sock, d)
      const ups = events.filter(x => x.type === 'level' || x.type === 'rank').map(x => x.type === 'level' ? `⬆️ Lv. ${x.level}` : `🏅 ${x.rank}`).join(' · ')
      return send(sock, ctx.jid, m, [
        `${WATERMARK}`, '', '🏆 *DUEL COMPLETE*', '',
        `👑 *${rewarded.name}* defeats *${loser.name}*.`,
        `⚔️ ${actionNote}`, '',
        `✨ +${fmt(xp)} XP  ·  💰 +${fmt(coins)} Coins  ·  💠 +${fmt(zen)} Zen`,
        `❤️ HP ${rewarded.hp}/${rewarded.maxHp}  ·  ${loser.name}: ${loser.hp}/${loser.maxHp}`,
        ups ? `\n${ups}` : '',
        `Both fighters' rest counters advanced. Retreating does not count.`
      ].filter(Boolean).join('\n'))
    }

    const state = resultState || updated.state || {}
    actor.fatigue = combatMechanics.fatigueValue(state.fatigue?.[actorId] ?? actor.fatigue)
    actor.fatigueUpdatedAt = new Date().toISOString()
    await persistFatigue(actorId, actor.fatigue, actor.fatigueUpdatedAt, actor)
    const nextId = String(state.turn || targetId)
    const nextPlayer = nextId === challengerId ? first : second
    const nextActorHp = Number(state.hp?.[actorId] ?? actor.hp)
    const nextTargetHp = Number(state.hp?.[targetId] ?? target.hp)
    return send(sock, ctx.jid, m, [
      `${WATERMARK}`, '', `⚔️ *DUEL · ROUND ${Number(state.round) || 1}*`, '',
      `*${actor.name}* · ${actionNote}`,
      `❤️ ${actor.name}: *${nextActorHp}/${actor.maxHp}*`,
      `❤️ ${target.name}: *${nextTargetHp}/${target.maxHp}*`, '',
      `Next turn: *${nextPlayer.name}* · ${ctx.prefix}attack / ${ctx.prefix}heavy / ${ctx.prefix}guard / ${ctx.prefix}heal`
    ].join('\n'))
  }

  /* ------------------------------------------------------------ class sheet */

  /**
   * The player's class dossier: class, specialization, mastery, class grade,
   * attack bonus, the full move list with unlock/energy state, and today's
   * remaining uses.
   *
   * Deliberately separate from the profile card: the profile shows Level, Rank
   * and overall Grade, which are different progressions. The note is explicit
   * that class grade must not be confused with any of them, so they are never
   * printed in the same block.
   */
  async function classSheet (sock, m, ctx) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)

    const classId = classes.normalizeClassId(p.class)
    if (!classId) {
      return send(sock, ctx.jid, m, [
        `${WATERMARK}`, '', '\ud83c\udfad *NO CLASS ASSIGNED*', '',
        `Your stored class is *${p.class || '\u2014'}*, which is not in the catalogue.`,
        `AXYON can set one with *${ctx.settings.prefix}classadmin set @you <class>*.`,
        '', `See every class with *${ctx.settings.prefix}classadmin list*.`
      ].join('\n'))
    }

    const def = classes.classById(classId)
    const mastery = await store.classMastery(ctx.userId, classId)
    const grade = classes.classGradeFor(mastery)
    const used = await store.classMovesUsedToday(ctx.userId)
    const limit = ctx.settings.classMovesPerDay
    const remaining = Math.max(0, limit - used)
    const moves = classes.movesForClass(classId)

    const moveLines = moves.map(mv => {
      const locked = mv.unlock != null && mastery < Number(mv.unlock)
      const icon = locked ? '\ud83d\udd12' : mv.ultimate ? '\ud83d\udc80' : mv.type === 'defensive' ? '\ud83d\udee1\ufe0f' : mv.type === 'support' ? '\u2764\ufe0f' : mv.type === 'special' ? '\u2728' : '\u2694\ufe0f'
      const dmg = Number(mv.damage) > 0 ? `${mv.damage} dmg` : mv.type
      const cost = mv.cost != null ? ` \u2022 \u26a1${mv.cost}` : ''
      const lock = locked ? ` \u2022 needs ${Number(mv.unlock).toLocaleString('en-US')} mastery` : ''
      return `${icon} *${mv.name}* \u2014 ${dmg}${cost}${lock}`
    })

    const nextLine = grade.next
      ? `\ud83d\udcc8 Next: *${grade.next.grade}* at *${grade.next.mastery.toLocaleString('en-US')}* \u2014 ${grade.next.remaining.toLocaleString('en-US')} to go`
      : '\ud83d\udcc8 *SS* \u2014 maximum class mastery reached.'

    const lines = [
      `${WATERMARK}`, '',
      `\ud83c\udfad *${def.name.toUpperCase()}*${def.legacy ? ' \u00b7 legacy' : ''}`,
      `_${def.specialization}_`, '',
      T.rule('CLASS MASTERY', 'thin'),
      `\ud83e\udde0 Mastery \u2014 *${mastery.toLocaleString('en-US')}*`,
      `\ud83c\udf96\ufe0f Class grade \u2014 *${grade.grade}*`,
      `\u2694\ufe0f Class attack bonus \u2014 *+${grade.bonus}*`,
      nextLine, '',
      T.rule('TODAY', 'thin'),
      `\ud83e\udde0 Class moves \u2014 *${remaining}/${limit}* left`,
      `\u26a1 Power Energy \u2014 *${p.powerEnergy}/${p.maxPowerEnergy}*`,
      '', T.rule('MOVES', 'thin'),
      ...moveLines, '',
      `Use one in battle with *${ctx.settings.prefix}class <move>* or *${ctx.settings.prefix}classmove <move>*.`,
      `Class grade is separate from your Level, Rank and overall Grade.`
    ]

    if (classes.masteryAwardPending()) {
      lines.push('', '> \u26a0\ufe0f Mastery award values are pending owner approval \u2014 mastery does not increase yet.')
    }

    return send(sock, ctx.jid, m, lines.join('\n'))
  }

  async function finishBattle (sock, m, ctx, p, b, won) {
    await store.setBattle(ctx.userId, null)
    p = store.rollDay(p)
    p.battlesSinceRest = Math.max(0, Number(p.battlesSinceRest) || 0) + 1
    /* One durability point per COMPLETED battle — win or loss, but never per
     * hit, so a long fight cannot drain a suit faster than a short one. */
    const wornAfter = await armorLib.wearAfterBattle(ctx.userId)
    p.fatigue = combatMechanics.fatigueValue(b.fatigue ?? p.fatigue)
    p.fatigueUpdatedAt = new Date().toISOString()
    p.hp = Math.max(0, Math.min(p.maxHp, Number(b.playerHp ?? p.hp) || 0))
    p.powerEnergy = Math.max(0, Math.min(p.maxPowerEnergy, Number(b.energy ?? p.powerEnergy) || 0))
    p.mp = Math.max(0, Math.min(p.maxMp, Number(b.mp ?? p.mp) || 0))
    if (won) {
      const xp = Math.max(0, Math.floor(Number(b.enemy.xp) || 0))
      const requestedZen = Math.round((Number(b.enemy.zen) || 0) * (b.enemy.boss ? 2 : 1.5))
      const zen = requestedZen
      const coins = Math.max(75, Math.round((Number(b.enemy.zen) || 0) * (b.enemy.boss ? 6 : 4)))
      p.wins += 1
      p.xpToday += xp
      p.zenToday += zen
      if (b.mode === 'stage' && b.ordinal >= p.stage) p.stage = b.ordinal + 1
      const { player: after, events } = applyProgress(p, { xp, zen, coins })
      await store.savePlayer(after)
      if (b.mode === 'floor' && b.storyQuestId) {
        const storyState = await store.floorStory(ctx.userId)
        await store.saveFloorStory(ctx.userId, floorStory.completeQuest(storyState, b.storyQuestId))
      }
      await store.log(ctx.userId, 'battle_win', b.enemy.name, { xp, zen, coins, ordinal: b.ordinal })

      const notes = events.map(e => e.type === 'level' ? `\u2b06\ufe0f Level *${e.level}*`
        : e.type === 'grade' ? `\ud83c\udf1f Grade *${e.grade}* \u2014 +\u2694\ufe0f${e.atk}`
          : `\ud83d\udc51 Rank up \u2192 *${e.rank}* \u2022 Power Energy restored to *${e.powerEnergy}*`)

      const wearNote = wornAfter ? (wornAfter.broken ? '\n\ud83d\udc80 *Armor broke* \u2014 protection lost until repaired.' : `\n\ud83d\udee1\ufe0f Armor *${wornAfter.durability}/${wornAfter.maxDurability}* durability`) : ''

      return buttons(sock, ctx.jid, m, [
        `${WATERMARK}`, '', '\ud83c\udfc6 *VICTORY*', '',
        `*${b.enemy.name}* falls.`, '',
        `\u2728 +${fmt(xp)} XP \u2022 \ud83e\ude99 +${fmt(zen)} Zen \u2022 \ud83d\udcb0 +${fmt(coins)} Coins`,
        notes.length ? `\n${notes.join('\n')}` : '',
        '',
        `\ud83c\udf96\ufe0f Rank *${after.rank}* \u2022 Lv. *${after.level}*`,
        wearNote
      ].filter(Boolean).join('\n'), WATERMARK, [['\u2694\ufe0f Next Stage', 'ax_stages'], ['\ud83d\udc64 Profile', 'ax_profile']])
    }

    p.losses += 1
    p.hp = Math.max(1, Math.round(p.maxHp * 0.25))
    await store.savePlayer(p)
    await store.log(ctx.userId, 'battle_loss', b.enemy.name, { ordinal: b.ordinal })
    const wearNote = wornAfter ? (wornAfter.broken ? '\n\ud83d\udc80 *Armor broke* \u2014 protection lost until repaired.' : `\n\ud83d\udee1\ufe0f Armor *${wornAfter.durability}/${wornAfter.maxDurability}* durability`) : ''
    return buttons(sock, ctx.jid, m, [
      `${WATERMARK}`, '', '\ud83d\udc80 *DEFEAT*', '',
      `*${b.enemy.name}* overwhelms you.`, '',
      `\u2764\ufe0f You wake with *${p.hp}/${p.maxHp}* HP.`,
      'No Zen was lost \u2014 only time.',
      wearNote
    ].join('\n'), WATERMARK, [['\ud83d\udd04 Try Again', 'ax_stages'], ['\ud83d\udc64 Profile', 'ax_profile']])
  }

  /* ----------------------------------------------------------------- duels */

  async function beginDuel (sock, m, ctx, opponentId) {
    if (!ctx.jid.endsWith('@g.us')) return send(sock, ctx.jid, m, '🥊 Duels happen inside a WhatsApp group.')
    if (!opponentId) return send(sock, ctx.jid, m, `🥊 Mention an opponent: *${ctx.settings.prefix}duel @player*`)
    const a = await store.player(ctx.userId)
    const b = await store.player(String(opponentId).split('@')[0])
    if (!a) return send(sock, ctx.jid, m, `🌱 Register first with *${ctx.settings.prefix}arise*.`)
    if (!b) return send(sock, ctx.jid, m, '🌱 That player has not used `!arise` yet. Make sure their WhatsApp number is linked to their registered account.')
    if (String(a.userId) === String(b.userId)) return send(sock, ctx.jid, m, '❌ You cannot challenge yourself.')
    const d = await store.createDuel(ctx.jid, a.userId, b.userId)
    await store.log(a.userId, 'duel_challenge', b.userId, { id: d.id })
    return tapButtons(sock, ctx.jid, m, [
      `${WATERMARK}`, '', '🥊 *DUEL CHALLENGE*', '',
      `> *${a.name}* ⚔️ *${b.name}*`, '',
      `Rank *${a.rank}* Lv.${a.level} vs Rank *${b.rank}* Lv.${b.level}`, '',
      'Both fighters may receive temporary group admin while the duel is active, then are demoted when it ends.', '',
      `*${ctx.settings.prefix}duel accept ${d.id}*  •  *${ctx.settings.prefix}duel decline ${d.id}*`
    ].join('\n'), WATERMARK, [['✅ Accept', `ax_duel_accept_${d.id}`], ['❌ Decline', `ax_duel_decline_${d.id}`]])
  }

  /**
   * Answers a pending duel. Only the challenged player (or AXYON) may answer.
   *
   * On accept, both fighters are promoted to group admin for the duration of
   * the duel and recorded in `promoted` so they can be demoted when it ends.
   * Promotion is best-effort: if the bot is not a group admin itself, WhatsApp
   * refuses and we say so instead of pretending it worked.
   */
  async function answerDuel (sock, m, ctx, id, accept) {
    const d = await store.duel(Number(id))
    if (!d || d.status !== 'pending' || String(d.group_jid) !== String(ctx.jid)) {
      return send(sock, ctx.jid, m, '\u231b That challenge is no longer active in this group.')
    }
    if (String(ctx.userId) !== String(d.opponent) && !ctx.auth.axyon) {
      return send(sock, ctx.jid, m, '\ud83d\udd12 Only the challenged player can answer this duel.')
    }
    if (!accept) {
      await store.updateDuel(d.id, { status: 'declined' })
      await store.log(ctx.userId, 'duel_decline', String(d.id))
      return send(sock, ctx.jid, m, `${WATERMARK}\n\n\u274c *DUEL DECLINED*\n\nThe challenge was withdrawn.`)
    }

    const a = await store.player(d.challenger)
    const b = await store.player(d.opponent)
    if (!a || !b) return send(sock, ctx.jid, m, '\u274c One of the fighters no longer exists.')
    if (String(a.userId) !== String(d.challenger) || String(b.userId) !== String(d.opponent)) {
      return send(sock, ctx.jid, m, '\u274c A fighter identity could not be matched to their registered account.')
    }

    let promoted = []
    let promoteNote = ''
    if (ctx.settings.duelAutoPromote && ctx.jid.endsWith('@g.us')) {
      try {
        const ids = [d.challenger, d.opponent].map(x => `${x}@s.whatsapp.net`)
        await sock.groupParticipantsUpdate(ctx.jid, ids, 'promote')
        promoted = [d.challenger, d.opponent]
        promoteNote = '\ud83d\udee1\ufe0f Both fighters hold temporary group admin for this duel.'
      } catch (e) {
        logger?.warn?.({ err: e }, 'duel admin promotion failed')
        promoteNote = '\u26a0\ufe0f Temporary admin could not be granted \u2014 Architect needs to be a group admin itself. The duel still runs.'
      }
    }

    const nowFatigueStamp = new Date().toISOString()
    a.fatigueUpdatedAt = nowFatigueStamp
    b.fatigueUpdatedAt = nowFatigueStamp
    await persistFatigue(a.userId, a.fatigue || 0, nowFatigueStamp, a)
    await persistFatigue(b.userId, b.fatigue || 0, nowFatigueStamp, b)
    const state = {
      turn: String(a.userId),
      round: 1,
      hp: { [a.userId]: a.hp, [b.userId]: b.hp },
      maxHp: { [a.userId]: a.maxHp, [b.userId]: b.maxHp },
      energy: { [a.userId]: a.powerEnergy, [b.userId]: b.powerEnergy },
      maxEnergy: { [a.userId]: a.maxPowerEnergy, [b.userId]: b.maxPowerEnergy },
      mp: { [a.userId]: a.mp, [b.userId]: b.mp },
      maxMp: { [a.userId]: a.maxMp, [b.userId]: b.maxMp },
      fatigue: { [a.userId]: a.fatigue || 0, [b.userId]: b.fatigue || 0 },
      guards: {},
      evading: {},
      heals: {}
    }
    await store.updateDuel(d.id, { status: 'active', state, promoted })
    await store.log(ctx.userId, 'duel_accept', String(d.id), { promoted })

    return send(sock, ctx.jid, m, [
      `${WATERMARK}`, '', '\u2694\ufe0f *DUEL BEGINS*', '',
      `> *${a.name || d.challenger}* vs *${b.name || d.opponent}*`, '',
      `Rank *${a.rank}* Lv.${a.level} \u2022 ${a.hp}/${a.maxHp} HP`,
      `Rank *${b.rank}* Lv.${b.level} \u2022 ${b.hp}/${b.maxHp} HP`, '',
      promoteNote, '',
      `Duel *#${d.id}* is live. *${a.name}* moves first.`,
      `Use *${ctx.settings.prefix}attack*, *${ctx.settings.prefix}heavy*, *${ctx.settings.prefix}dodge*, *${ctx.settings.prefix}block*, *${ctx.settings.prefix}heal*, *${ctx.settings.prefix}power <name>*, *${ctx.settings.prefix}cc* or *${ctx.settings.prefix}class*.`,
      `Use *${ctx.settings.prefix}battleinfo* for details. *${ctx.settings.prefix}retreat* gives no rewards and does not count towards rest.`
    ].filter(Boolean).join('\n'))
  }

  /* ------------------------------------------------------ daily / economy */

  async function daily (sock, m, ctx) {
    let p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    p = store.rollDay(p)
    const now = Date.now()
    if (p.lastDaily && now - new Date(p.lastDaily).getTime() < 86400000) {
      const left = Math.ceil((86400000 - (now - new Date(p.lastDaily).getTime())) / 3600000)
      return send(sock, ctx.jid, m, `\u23f3 *DAILY ALREADY CLAIMED*\n\nCome back in about *${left}h*.`)
    }
    const gain = 120 + rnd(180)
    p.zenToday += gain
    p.lastDaily = new Date().toISOString()
    p.maxPowerEnergy = Math.max(p.maxPowerEnergy, powerEnergyForRank(p.rank))
    p.powerEnergy = p.maxPowerEnergy
    const { player: after } = applyProgress(p, { zen: gain })
    await store.savePlayer(after)
    await store.log(ctx.userId, 'daily', ctx.userId, { gain })
    return send(sock, ctx.jid, m, `${WATERMARK}\n\n\ud83c\udf81 *DAILY*\n\n\ud83e\ude99 +${fmt(gain)} Zen\n\u26a1 Power Energy restored to *${after.maxPowerEnergy}*`)
  }

  async function zenWallet (sock, m, ctx) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    const q = store.rollDay(p)
    const lines = [
      `${WATERMARK}`, '', '💠 *WALLET*', '',
      `💠 Zen: *${fmt(q.zen)}*`,
      `💎 Coins: *${fmt(q.coins)}*`,
      `Earned today: *${fmt(q.zenToday)} Zen*`, '',
      'Exchange: *1,000 Coins = 100 Zen*',
      `Convert with *${ctx.settings.prefix}convert 1000*.`
    ]
    if (economy) {
      try {
        const u = await economy.getBalance(ctx.userId, q.name)
        lines.push('', `💵 Casino wallet: *${economy.fmt(u.wallet)}*`)
      } catch { /* wallet is optional */ }
    }
    return send(sock, ctx.jid, m, lines.join('\n'))
  }

  /* ------------------------------------------------------------------ play */

  /**
   * `!play <song>` — search, show artwork, send the audio.
   *
   * Deliberately small: one search, one download, one message. It never blocks
   * the message path for other users because the caller does not await it
   * before returning, and every step has its own timeout.
   */
  async function play (sock, m, ctx, args) {
    const query = args.join(' ').trim()
    if (!query) {
      return send(sock, ctx.jid, m, [
        T.header({ creators: greetings.creatorsOf(ctx.settings) }),
        '',
        `🎵 ${T.font('PLAY', 'bold')}`,
        '',
        `Usage: ${T.b(`${ctx.prefix}play <song or artist>`)}`,
        '',
        T.quote('Example: ' + `${ctx.prefix}play blinding lights`)
      ].join('\n'))
    }

    const r = await music.resolve(query, { logger })
    if (!r.ok) {
      return send(sock, ctx.jid, m, [
        T.header({ creators: greetings.creatorsOf(ctx.settings) }),
        '',
        `🎵 ${T.font('PLAY', 'bold')}`,
        '',
        `❌ ${r.message || 'Could not find that track.'}`,
        '',
        T.quote('Try the artist name and the song title together.')
      ].join('\n'))
    }

    const t = r.track
    const caption = [
      T.header({ creators: greetings.creatorsOf(ctx.settings) }),
      '',
      `🎵 ${T.b(t.title)}`,
      `👤 ${T.i(t.artist)}`,
      t.album ? `💿 ${T.i(t.album)}` : null,
      `⏱️ ${T.m(music.mmss(t.duration))}`,
      '',
      T.rule('', 'hair'),
      `✅ ${T.i('full track')}`
    ].filter(Boolean).join('\n')

    try {
      /* Artwork first, so the chat shows the cover even if the audio is slow. */
      if (t.artwork) {
        await sock.sendMessage(ctx.jid, { image: { url: t.artwork }, caption }, { quoted: m }).catch(() => {})
      }
      /*
       * The audio is a LOCAL file, so it must be sent as a Buffer.
       * `{ audio: { url: '/tmp/...' } }` makes Baileys treat the path as an
       * HTTP URL and the send fails — which is exactly what happened before.
       */
      const buf = await fs.readFile(r.file)
      await sock.sendMessage(ctx.jid, {
        audio: buf,
        mimetype: music.mimeFor(r.file),
        /* The song title is the file name the recipient sees and saves. */
        fileName: music.fileNameFor(t.title, r.file),
        ptt: false
      }, { quoted: m })
      /*
       * Logging is best-effort and deliberately OUTSIDE the try above: a failed
       * audit write must never be reported to the user as "could not send the
       * audio" when the audio did in fact send.
       */
      store.log(ctx.userId, 'play', t.title, { artist: t.artist, full: r.full })
        .catch(e => logger?.debug?.({ err: e?.message }, 'play log failed'))
      return true
    } catch (e) {
      logger?.warn?.({ err: e?.message }, 'play send failed')
      return send(sock, ctx.jid, m, `⚠️ Found *${t.title}* but could not send the audio.`)
    } finally {
      await music.cleanup(r.dir)
    }
  }

  /* ------------------------------------------------------------------ help */

  const SECTIONS = {
    core: { name: 'Core', icon: '\ud83c\udf00' },
    battle: { name: 'Combat', icon: '\u2694\ufe0f' },
    duel: { name: 'Duels', icon: '\ud83e\udd4a' },
    dungeon: { name: 'Dungeon', icon: '\ud83c\udff9' },
    cards: { name: 'Cards', icon: '\ud83c\udccf' },
    shop: { name: 'Shop & Inventory', icon: '\ud83d\uded2' },
    social: { name: 'Social', icon: '\ud83d\udc9e' },
    economy: { name: 'Economy', icon: '\ud83e\ude99' },
    media: { name: 'Media', icon: '\ud83c\udfb5' },
    management: { name: 'Management', icon: '\ud83d\udc51' }
  }

  function helpPage (section, prefix) {
    const meta = SECTIONS[section]
    const rows = COMMANDS.filter(c => c.section === section && !c.hidden)
    if (!meta || !rows.length) return null
    const body = rows.map(c => {
      const head = `${T.b(c.usage.replace(/\{p\}/g, prefix))}\n${T.i(c.desc)}`
      /* Optional long-form explanation, shown only when the command has one. */
      return c.help ? `${head}\n${String(c.help).trim()}` : head
    }).join('\n\n')
    return [
      T.header({ creators: greetings.creatorsOf({}) }),
      '',
      `${meta.icon} ${T.font(`HELP \u2014 ${meta.name.toUpperCase()}`, 'bold')}`,
      '',
      T.rule('', 'thin'),
      '',
      body,
      '',
      T.rule('', 'hair'),
      `Prefix ${T.b(prefix)} \u2022 ${T.b(`${prefix}help`)} for all sections`
    ].join('\n')
  }

  /**
   * Help for ONE command, by name or alias.
   *
   * `!help <command>` used to fall through to "no section named X". This is the
   * lookup that makes the optional explanation reachable: usage, one-line
   * description, the long explanation when the registry has one, and the
   * section it lives in so the reader can go wider.
   */
  function helpCommand (name, prefix) {
    const key = String(name || '').trim().toLowerCase().replace(/^[!/.#]/, '')
    if (!key) return null
    const c = COMMANDS.find(x => x.name === key && !x.hidden) ||
      COMMANDS.find(x => Array.isArray(x.aliases) && x.aliases.includes(key) && !x.hidden)
    if (!c) return null
    const meta = SECTIONS[c.section]
    const out = [
      T.header({ creators: greetings.creatorsOf({}) }),
      '',
      `${meta?.icon || '\u2022'} ${T.font(`HELP \u2014 ${c.name.toUpperCase()}`, 'bold')}`,
      '',
      T.rule('', 'thin'),
      '',
      T.m(c.usage.replace(/\{p\}/g, prefix)),
      '',
      c.desc
    ]
    if (c.help) out.push('', String(c.help).trim())
    if (Array.isArray(c.aliases) && c.aliases.length) {
      out.push('', `${T.b('Also')} \u2014 ${c.aliases.map(a => T.m(`${prefix}${a}`)).join(', ')}`)
    }
    out.push('', T.rule('', 'hair'), `${T.b('Section')} \u2014 ${meta?.name || c.section} \u2022 ${T.b(`${prefix}help ${c.section}`)}`)
    return out.join('\n')
  }

  function helpAll (prefix) {
    const out = [
      T.header({ creators: greetings.creatorsOf({}) }),
      '',
      `\ud83d\udcda ${T.font('COMMAND INDEX', 'bold')}`,
      ''
    ]
    for (const [key, meta] of Object.entries(SECTIONS)) {
      const rows = COMMANDS.filter(c => c.section === key && !c.hidden)
      if (!rows.length) continue
      out.push(T.rule(meta.name.toUpperCase(), 'thin'))
      out.push(rows.map(c => `${meta.icon} ${T.m(c.usage.replace(/\{p\}/g, prefix))}`).join('\n'))
      out.push('')
    }
    out.push(T.rule('', 'hair'))
    out.push(`Prefix ${T.b(prefix)} \u2022 ${T.b(`${prefix}help <section>`)}`)
    return out.join('\n')
  }

  function helpButtons () {
    return Object.entries(SECTIONS).map(([k, v]) => [`${v.icon} ${v.name}`, `ax_help_${k}`])
  }

  /*
   * Live instrumentation for the owner's !system health snapshot.
   *
   * `queueDepth` and `sendLatency` are real measurements, not placeholders:
   * `send()` above increments/decrements the in-flight counter around every
   * WhatsApp send and records its duration.
   */
  function queueDepth () {
    return inFlight
  }

  function sendLatency () {
    return lastLatencyMs
  }

  /**
   * Drop the temporary caches this module holds.
   *
   * There is no cross-command cache map here any more, so this reports 0 and
   * touches nothing. It deliberately does NOT clear battles, players or
   * sessions — `!system clean` must never cost anyone progress.
   */
  function cleanCaches () {
    return 0
  }

  return {
    WATERMARK, CLASSES, CLASS_MOVES, MODES, COMMANDS, SECTIONS,
    queueDepth, sendLatency, cleanCaches,
    cmd, send, buttons, tapButtons, withVisual,
    arise, profile, listStages, beginBattle, battleAct, battleInfo, rest, train, finishBattle, battleButtons,
    classSheet,
    cardPanel, cardDetail, equipCard, unequipCard, cardSlots, cardAbilities, claimCard, claimDrop, beginDuel, answerDuel, daily, zenWallet, play,
    helpPage, helpAll, helpButtons, helpCommand,
    applyProgress, powerEnergyForRank, buildEnemy, profileCard, battleCard, battleInfoCard
  }
}

module.exports = {
  createAxyon, applyProgress, buildEnemy, playerHit, enemyHit,
  powerEnergyForRank, profileCard, battleCard, battleInfoCard, combatMechanics,
  CLASSES, CLASS_MOVES, MODES, WATERMARK
}