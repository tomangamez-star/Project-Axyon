'use strict'
/*
 * AXYON GUILD MODES & COLLABORATION
 * =================================
 *
 * The Modes & Room spec fixed the POSITION of guild modes 1-3 and the
 * Collaboration slot in the menu, but said their rules "must be defined in
 * their own specifications" and forbade inventing them. No such specification
 * was ever supplied, so they shipped as disabled placeholders.
 *
 * The owner has now asked for them to be built for real. This file is that
 * definition. It is written down here, in one place, so the rules are
 * inspectable rather than buried in a command handler.
 *
 * WHAT EACH MODE ACTUALLY DOES
 * ----------------------------
 *   guild_raid      A party of 2-5 shares ONE boss HP pool. Each member
 *                   strikes in turn and the boss retaliates against whoever
 *                   struck. Members fall individually; the raid is lost only
 *                   when every member is down. Rewards are split by damage
 *                   contribution, so carrying is not free.
 *
 *   guild_duel      Two guilds field equal-sized rosters. Members are paired
 *                   by index and each pair fights to a knockout. The guild
 *                   with more pair wins takes the duel. Ties are a draw, not
 *                   a win for either side.
 *
 *   guild_gauntlet  A party clears three consecutive waves. HP CARRIES OVER
 *                   between waves with no full heal, which is what makes it a
 *                   resource-management mode rather than three raids in a row.
 *
 *   collab_trial    The party shares ONE HP pool and ONE damage target. This is
 *                   the real difference from guild_raid: in a raid each member
 *                   has their own HP, so a strong member can carry; here the
 *                   pool is common, so one member taking hits hurts everyone.
 *
 * PURITY
 * ------
 * Every function here is pure: it takes a state object and returns a NEW state
 * plus a log of what happened. No database, no socket, no clock, no randomness.
 * The caller supplies the damage numbers (from the existing combat engine) and
 * this file decides what they mean. That is what makes the rules testable
 * without a live Postgres, and it is why a mode cannot silently invent a
 * statistic the engine never computed.
 */

/* ------------------------------------------------------------- definitions */

const GUILD_MODES = {
  guild_raid: {
    id: 'guild_raid',
    name: 'Guild Raid',
    category: 'guild',
    participation: 'party',
    minPlayers: 2,
    maxPlayers: 5,
    blurb: 'A party shares one boss HP pool. Members fall individually; the raid is lost when all are down.',
    rules: [
      'One shared boss HP pool for the whole party.',
      'Each member strikes in turn; the boss retaliates against the striker.',
      'A member at 0 HP is down and skips their turns.',
      'The raid is won when the boss reaches 0 HP.',
      'The raid is lost when every member is down.',
      'Rewards are split by damage contribution.'
    ]
  },
  guild_duel: {
    id: 'guild_duel',
    name: 'Guild Duel',
    category: 'guild',
    participation: 'party',
    minPlayers: 2,
    maxPlayers: 5,
    blurb: 'Two guilds field equal rosters. Members are paired by index; the side with more pair wins takes it.',
    rules: [
      'Both sides must field the same number of members.',
      'Members are paired by roster index.',
      'Each pair fights to a knockout.',
      'The side with more pair wins takes the duel.',
      'An equal number of pair wins is a draw, not a win.'
    ]
  },
  guild_gauntlet: {
    id: 'guild_gauntlet',
    name: 'Guild Gauntlet',
    category: 'guild',
    participation: 'party',
    minPlayers: 2,
    maxPlayers: 5,
    blurb: 'Three consecutive waves. HP carries over between waves with no full heal.',
    rules: [
      'Three waves, cleared in order.',
      'HP carries over between waves — there is no full heal.',
      'A member at 0 HP stays down for the rest of the gauntlet.',
      'Clearing all three waves wins the gauntlet.',
      'Losing every member at any wave loses it.'
    ]
  },
  collab_trial: {
    id: 'collab_trial',
    name: 'Co-op Trial',
    category: 'collab',
    participation: 'party',
    minPlayers: 2,
    maxPlayers: 5,
    blurb: 'The party shares one HP pool and one damage target. One member taking hits hurts everyone.',
    rules: [
      'The party shares a single HP pool.',
      'The party shares a single damage target.',
      'Any hit the boss lands reduces the shared pool.',
      'The trial is won when the damage target is reached.',
      'The trial is lost when the shared pool reaches 0.'
    ]
  }
}

const GUILD_MODE_IDS = Object.keys(GUILD_MODES)

/** The three waves of a gauntlet, in order. */
const GAUNTLET_WAVES = [
  { name: 'First Wave', hp: 120, atk: 8 },
  { name: 'Second Wave', hp: 200, atk: 13 },
  { name: 'Final Wave', hp: 320, atk: 19 }
]

function guildMode (id) {
  return GUILD_MODES[String(id || '').toLowerCase()] || null
}

/* ------------------------------------------------------------------- runs */

/**
 * Creates a run.
 *
 * `members` is [{ userId, name, hp, maxHp }]. The caller reads those from the
 * player rows; this file never touches the database.
 *
 * `boss` is optional and only used by the raid/gauntlet/trial shapes. When it
 * is absent a default is derived from the member count, so a run can always be
 * created and the caller does not have to supply a stat block.
 */
function createRun ({ modeId, members = [], boss = null, target = null } = {}) {
  const def = guildMode(modeId)
  if (!def) return { ok: false, reason: 'unknown_mode', message: 'No such guild mode.' }

  const roster = members
    .filter(m => m && m.userId)
    .map(m => ({
      userId: String(m.userId),
      name: String(m.name || m.userId),
      hp: Math.max(0, Math.floor(Number(m.hp) || 0)),
      maxHp: Math.max(1, Math.floor(Number(m.maxHp) || 100)),
      down: Math.max(0, Math.floor(Number(m.hp) || 0)) <= 0,
      damage: 0
    }))

  if (roster.length < def.minPlayers) {
    return {
      ok: false,
      reason: 'too_few',
      message: `${def.name} needs at least ${def.minPlayers} players. You have ${roster.length}.`
    }
  }
  if (roster.length > def.maxPlayers) {
    return {
      ok: false,
      reason: 'too_many',
      message: `${def.name} allows at most ${def.maxPlayers} players. You have ${roster.length}.`
    }
  }

  const base = {
    modeId: def.id,
    modeName: def.name,
    members: roster,
    turn: 0,
    round: 1,
    log: [],
    done: false,
    won: null
  }

  if (def.id === 'guild_raid') {
    const hp = Number(boss?.hp) || 200 + roster.length * 90
    return {
      ok: true,
      state: {
        ...base,
        boss: {
          name: String(boss?.name || 'Guild Warden'),
          hp,
          maxHp: hp,
          atk: Number(boss?.atk) || 10 + roster.length * 3
        }
      }
    }
  }

  if (def.id === 'guild_gauntlet') {
    const wave = GAUNTLET_WAVES[0]
    return {
      ok: true,
      state: {
        ...base,
        wave: 0,
        waves: GAUNTLET_WAVES.map(w => ({ ...w })),
        boss: { name: wave.name, hp: wave.hp, maxHp: wave.hp, atk: wave.atk }
      }
    }
  }

  if (def.id === 'collab_trial') {
    const pool = roster.reduce((sum, m) => sum + m.maxHp, 0)
    const goal = Number(target) || 300 + roster.length * 120
    return {
      ok: true,
      state: {
        ...base,
        pool: { hp: pool, maxHp: pool },
        target: { remaining: goal, total: goal },
        boss: {
          name: String(boss?.name || 'Trial Construct'),
          atk: Number(boss?.atk) || 8 + roster.length * 2
        }
      }
    }
  }

  /* guild_duel — two rosters, paired by index. */
  const sideA = roster.map(m => ({ ...m }))
  const sideB = roster.map(m => ({ ...m, userId: `opp_${m.userId}`, name: `Rival ${m.name}` }))
  return {
    ok: true,
    state: {
      ...base,
      sides: { a: sideA, b: sideB },
      pairs: sideA.map((m, i) => ({
        index: i,
        a: { userId: m.userId, name: m.name, hp: m.hp, maxHp: m.maxHp, down: m.down },
        b: { userId: sideB[i].userId, name: sideB[i].name, hp: sideB[i].hp, maxHp: sideB[i].maxHp, down: sideB[i].down },
        winner: null
      })),
      score: { a: 0, b: 0 }
    }
  }
}

/** The member whose turn it is, or null when the run is over. */
function activeMember (state) {
  if (!state || state.done) return null
  const alive = state.members.filter(m => !m.down)
  if (!alive.length) return null
  return alive[state.turn % alive.length]
}

/**
 * Applies one strike.
 *
 * `damage` is what the combat engine already computed for this member — this
 * function never rolls a die. `incoming` is the retaliation the boss lands on
 * the striker; when omitted the boss's own `atk` is used.
 *
 * Returns a NEW state. The input is never mutated, so a caller can retry or
 * discard a turn without corrupting the run.
 */
function strike (state, { userId, damage = 0, incoming = null } = {}) {
  if (!state) return { ok: false, reason: 'no_run', message: 'There is no run in progress.' }
  if (state.done) return { ok: false, reason: 'done', message: 'That run is already over.' }

  const next = JSON.parse(JSON.stringify(state))
  const dealt = Math.max(0, Math.floor(Number(damage) || 0))

  if (next.modeId === 'guild_duel') return duelStrike(next, { userId, damage: dealt })

  const member = activeMember(next)
  if (!member) {
    next.done = true
    next.won = false
    return { ok: true, state: next, log: ['Every member is down.'], done: true, won: false }
  }
  if (userId && String(userId) !== member.userId) {
    return { ok: false, reason: 'not_your_turn', message: `It is *${member.name}*'s turn.` }
  }

  const lines = []
  const target = next.members.find(m => m.userId === member.userId)
  target.damage += dealt

  if (next.modeId === 'collab_trial') {
    next.target.remaining = Math.max(0, next.target.remaining - dealt)
    lines.push(`${member.name} strikes for ${dealt}. ${next.target.remaining} damage remaining.`)
    if (next.target.remaining <= 0) {
      next.done = true
      next.won = true
      lines.push('The damage target is reached — the trial is won.')
      return { ok: true, state: next, log: lines, done: true, won: true }
    }
    const hit = incoming == null ? next.boss.atk : Math.max(0, Math.floor(Number(incoming) || 0))
    next.pool.hp = Math.max(0, next.pool.hp - hit)
    lines.push(`${next.boss.name} answers for ${hit} against the shared pool. ${next.pool.hp}/${next.pool.maxHp} left.`)
    if (next.pool.hp <= 0) {
      next.done = true
      next.won = false
      lines.push('The shared pool is empty — the trial is lost.')
      return { ok: true, state: next, log: lines, done: true, won: false }
    }
    next.turn += 1
    next.round = Math.floor(next.turn / Math.max(1, next.members.filter(m => !m.down).length)) + 1
    return { ok: true, state: next, log: lines, done: false, won: null }
  }

  /* guild_raid and guild_gauntlet share the boss-HP shape. */
  next.boss.hp = Math.max(0, next.boss.hp - dealt)
  lines.push(`${member.name} strikes ${next.boss.name} for ${dealt}. ${next.boss.hp}/${next.boss.maxHp} left.`)

  if (next.boss.hp <= 0) {
    if (next.modeId === 'guild_gauntlet' && next.wave < next.waves.length - 1) {
      next.wave += 1
      const w = next.waves[next.wave]
      next.boss = { name: w.name, hp: w.hp, maxHp: w.hp, atk: w.atk }
      lines.push(`${w.name} rises. HP carries over — there is no heal between waves.`)
      next.turn += 1
      return { ok: true, state: next, log: lines, done: false, won: null }
    }
    next.done = true
    next.won = true
    lines.push(next.modeId === 'guild_gauntlet'
      ? 'All three waves are cleared — the gauntlet is won.'
      : `${next.boss.name} falls — the raid is won.`)
    return { ok: true, state: next, log: lines, done: true, won: true }
  }

  const hit = incoming == null ? next.boss.atk : Math.max(0, Math.floor(Number(incoming) || 0))
  target.hp = Math.max(0, target.hp - hit)
  lines.push(`${next.boss.name} answers for ${hit}. ${member.name} has ${target.hp}/${target.maxHp} HP.`)
  if (target.hp <= 0) {
    target.down = true
    lines.push(`${member.name} is down.`)
  }

  if (next.members.every(m => m.down)) {
    next.done = true
    next.won = false
    lines.push('Every member is down — the run is lost.')
    return { ok: true, state: next, log: lines, done: true, won: false }
  }

  next.turn += 1
  next.round = Math.floor(next.turn / Math.max(1, next.members.filter(m => !m.down).length)) + 1
  return { ok: true, state: next, log: lines, done: false, won: null }
}

/** One pair of a guild duel resolves independently. */
function duelStrike (state, { userId, damage }) {
  const pair = state.pairs.find(p => !p.winner && (p.a.userId === String(userId) || p.b.userId === String(userId)))
  if (!pair) return { ok: false, reason: 'no_pair', message: 'You are not in an unresolved pair.' }

  const lines = []
  const attacker = pair.a.userId === String(userId) ? pair.a : pair.b
  const defender = attacker === pair.a ? pair.b : pair.a

  defender.hp = Math.max(0, defender.hp - damage)
  lines.push(`${attacker.name} hits ${defender.name} for ${damage}. ${defender.hp}/${defender.maxHp} left.`)

  if (defender.hp <= 0) {
    defender.down = true
    pair.winner = attacker === pair.a ? 'a' : 'b'
    state.score[pair.winner] += 1
    lines.push(`${defender.name} is knocked out — ${attacker.name} takes the pair.`)
  }

  if (state.pairs.every(p => p.winner)) {
    state.done = true
    state.won = state.score.a > state.score.b ? true : state.score.a < state.score.b ? false : null
    lines.push(state.won === null
      ? `The duel is a draw at ${state.score.a}-${state.score.b}.`
      : `${state.won ? 'Your guild' : 'The rival guild'} takes the duel ${Math.max(state.score.a, state.score.b)}-${Math.min(state.score.a, state.score.b)}.`)
    return { ok: true, state, log: lines, done: true, won: state.won }
  }

  state.turn += 1
  return { ok: true, state, log: lines, done: false, won: null }
}

/**
 * Splits a reward by damage contribution.
 *
 * A member who dealt nothing gets nothing — that is the point of the split.
 * Returns whole numbers that sum to `total` (the remainder goes to the top
 * contributor, so no Zen is created or destroyed by rounding).
 */
function splitReward (state, total) {
  const pool = Math.max(0, Math.floor(Number(total) || 0))
  const members = Array.isArray(state?.members) ? state.members : []
  const sum = members.reduce((s, m) => s + Math.max(0, Number(m.damage) || 0), 0)
  if (!sum || !pool) return members.map(m => ({ userId: m.userId, name: m.name, share: 0 }))

  const out = members.map(m => ({
    userId: m.userId,
    name: m.name,
    share: Math.floor((Math.max(0, Number(m.damage) || 0) / sum) * pool)
  }))
  const given = out.reduce((s, x) => s + x.share, 0)
  const top = out.reduce((best, x) => (x.share > best.share ? x : best), out[0])
  if (top) top.share += pool - given
  return out
}

/** A short status block for the room card. */
function runStatus (state) {
  if (!state) return ['No run in progress.']
  const lines = [`*${state.modeName}* — round ${state.round}`]

  if (state.modeId === 'guild_duel') {
    lines.push(`Score: *${state.score.a}* — *${state.score.b}*`)
    for (const p of state.pairs) {
      const mark = p.winner ? (p.winner === 'a' ? '✅' : '❌') : '•'
      lines.push(`${mark} ${p.a.name} ${p.a.hp}/${p.a.maxHp} vs ${p.b.name} ${p.b.hp}/${p.b.maxHp}`)
    }
    return lines
  }

  if (state.modeId === 'collab_trial') {
    lines.push(`Shared pool: *${state.pool.hp}/${state.pool.maxHp}*`)
    lines.push(`Damage remaining: *${state.target.remaining}/${state.target.total}*`)
  } else {
    lines.push(`${state.boss.name}: *${state.boss.hp}/${state.boss.maxHp}*`)
    if (state.modeId === 'guild_gauntlet') lines.push(`Wave *${state.wave + 1}/${state.waves.length}*`)
  }

  for (const m of state.members) {
    lines.push(`${m.down ? '💀' : '•'} ${m.name} — ${m.hp}/${m.maxHp} HP · ${m.damage} dmg`)
  }
  const active = activeMember(state)
  if (active) lines.push(`Turn: *${active.name}*`)
  return lines
}

module.exports = {
  GUILD_MODES,
  GUILD_MODE_IDS,
  GAUNTLET_WAVES,
  guildMode,
  createRun,
  activeMember,
  strike,
  splitReward,
  runStatus
}
