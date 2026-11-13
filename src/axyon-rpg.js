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
const greetings = require('./greetings')

const WATERMARK = '\u232c AXYN CORE'

const CLASSES = [
  { key: 'fighter', name: 'Fighter', blurb: 'Balanced striker. Reliable damage.' },
  { key: 'guardian', name: 'Guardian', blurb: 'High defence, slower kills.' },
  { key: 'assassin', name: 'Assassin', blurb: 'Fast and fragile.' },
  { key: 'mystic', name: 'Mystic', blurb: 'Strong class moves, weaker basics.' }
]

/* Class moves: 3 uses per day, shared pool per player. */
const CLASS_MOVES = {
  fighter: { name: 'Cleaving Strike', damage: 26, cost: 12 },
  guardian: { name: 'Bulwark Slam', damage: 18, cost: 10 },
  assassin: { name: 'Shadow Step', damage: 30, cost: 15 },
  mystic: { name: 'Arcane Lance', damage: 34, cost: 18 }
}

const MODES = {
  duel: { name: 'Duel', blurb: 'One player against another.' },
  solo: { name: 'Solo', blurb: 'One player against a gate.' },
  multiplayer: { name: 'Multiplayer', blurb: 'Several players, individual turns.' },
  party: { name: 'Party', blurb: 'An organised team, 2 or more.' }
}

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

/* -------------------------------------------------------------- progression */

/**
 * Applies xp and zen to a player object, handling level-ups, rank-ups and
 * grade-ups. Returns the mutated player plus a list of events for the reply.
 *
 * Grade-up grants +15 HP and +4 ATK.  A rank-up restores Power Energy.
 */
function applyProgress (p, { xp = 0, zen = 0, coins = 0 } = {}) {
  const events = []
  const beforeRank = p.rank
  const beforeGrade = p.grade

  p.xp += Math.max(0, Math.floor(xp))
  p.zen += Math.max(0, Math.floor(zen))
  p.coins += Math.max(0, Math.floor(coins))

  let guard = 0
  while (p.xp >= store.xpNeed(p.level) && guard++ < 500) {
    p.xp -= store.xpNeed(p.level)
    p.level += 1
    events.push({ type: 'level', level: p.level })
  }

  // Grade advances every 10 levels: level 10 → grade 2, level 20 → grade 3.
  const newGrade = 1 + Math.floor(p.level / 10)
  if (newGrade > beforeGrade) {
    const steps = newGrade - beforeGrade
    p.grade = newGrade
    p.maxHp += store.GRADE_HP * steps
    p.hp = p.maxHp
    p.atk += store.GRADE_ATK * steps
    events.push({ type: 'grade', grade: p.grade, hp: store.GRADE_HP * steps, atk: store.GRADE_ATK * steps })
  }

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
  const s = stage || {}
  return {
    name: s.name,
    hp: Number(s.hp) || 60,
    atk: Number(s.atk) || 5,
    def: Number(s.def) || 2,
    xp: Number(s.xp) || 40,
    zen: Number(s.zen) || 60,
    boss: !!s.boss
  }
}

function playerHit (p, enemy, mult = 1, bonus = 0) {
  const base = p.atk * 1.15 + rnd(7) + bonus
  const dmg = base * mult - enemy.def * 0.35
  return Math.max(1, Math.round(dmg))
}

function enemyHit (enemy, p, guardRatio = 0) {
  let dmg = enemy.atk + rnd(6) - p.def * 0.3
  dmg = Math.max(1, Math.round(dmg))
  if (guardRatio) dmg = Math.max(1, Math.round(dmg * (1 - guardRatio)))
  return dmg
}

/* ------------------------------------------------------------- formatting */

function bar (value, max, width = 10) {
  const filled = max > 0 ? clamp(Math.round((value / max) * width), 0, width) : 0
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled)
}

function profileCard (p, extra = {}) {
  const need = store.xpNeed(p.level)
  return [
    `${WATERMARK}`,
    '',
    `> \ud83d\udc64 *${p.name || 'Unnamed Hunter'}*`,
    `\ud83c\udf96\ufe0f *Rank ${p.rank}* \u2022 Grade *${p.grade}* \u2022 Lv. *${p.level}*`,
    '',
    `\u2764\ufe0f HP      ${p.hp}/${p.maxHp}  ${bar(p.hp, p.maxHp)}`,
    `\u26a1 Energy  ${p.powerEnergy}/${p.maxPowerEnergy}  ${bar(p.powerEnergy, p.maxPowerEnergy)}`,
    `\ud83d\udca0 XP      ${p.xp}/${need}`,
    '',
    `\u2694\ufe0f ATK *${p.atk}*   \ud83d\udee1\ufe0f DEF *${p.def}*   \ud83d\udca8 SPD *${p.spd}*`,
    `\ud83e\udde0 Class *${p.class}*`,
    '',
    `\ud83e\ude99 Zen *${fmt(p.zen)}*   \ud83d\udc8e Coins *${fmt(p.coins)}*`,
    `\ud83d\udeaa Stage *${p.stage}*   \ud83c\udfc6 ${p.wins}W / ${p.losses}L`,
    extra.partner ? `\ud83d\udc9e Bound to *${extra.partner}*` : null
  ].filter(Boolean).join('\n')
}

function battleCard (b, p, note = '') {
  const e = b.enemy
  return [
    `${WATERMARK}`,
    `\u2694\ufe0f *BATTLE \u2022 TURN ${b.turn}*`,
    '',
    note ? `${note}\n` : null,
    `> \ud83d\udc79 *${e.name}*`,
    `\u2764\ufe0f ${Math.max(0, b.enemyHp)}/${e.hp}  ${bar(Math.max(0, b.enemyHp), e.hp)}`,
    '',
    `> \ud83d\udc64 *${p.name || 'Hunter'}*`,
    `\u2764\ufe0f ${Math.max(0, b.playerHp)}/${p.maxHp}  ${bar(Math.max(0, b.playerHp), p.maxHp)}`,
    `\u26a1 ${b.energy}/${p.maxPowerEnergy}`,
    '',
    `Uses left \u2014 heal *${Math.max(0, b.healsLeft)}* \u2022 class *${Math.max(0, 3 - p.classMovesUsed)}* \u2022 card *${Math.max(0, 3 - p.cardUses)}*`
  ].filter(Boolean).join('\n')
}

/* ------------------------------------------------------------------ engine */

function createAxyon ({ economy, logger, sendButtons } = {}) {
  const send = (s, j, m, t) => s.sendMessage(j, { text: t }, { quoted: m })

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
  const tapButtons = (s, j, m, body, footer, defs, owner) => {
    if (sendButtons) return sendButtons(s, j, body, footer || WATERMARK, defs, owner)
    return s.sendMessage(j, { text: body }, { quoted: m })
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
            ? tapButtons(sock, jid, m, v.caption || '\u2728', WATERMARK, defs)
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
    await store.log(userId, 'arise', userId, { created: r.created })
    const p = r.player
    const caption = r.created
      ? greetings.firstGreeting(p, settings.prefix)
      : greetings.returnGreeting(p, settings.prefix)
    return withVisual(sock, jid, m, 'arise', caption)
  }

  async function profile (sock, m, ctx) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    const partner = await store.partnerOf(ctx.userId).catch(() => null)
    let partnerName = null
    if (partner) {
      const otherId = partner.requester === ctx.userId ? partner.target : partner.requester
      partnerName = (await store.player(otherId))?.name || `+${otherId}`
    }
    return withVisual(sock, ctx.jid, m, 'profile', profileCard(p, { partner: partnerName }),
      [['\u2694\ufe0f Stages', 'ax_stages'], ['\ud83c\udff9 Dungeon', 'ax_dungeon'], ['\ud83c\udccf Cards', 'ax_cards'], ['\ud83d\udcda Help', 'ax_help']])
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
    const stage = await store.stage(Number(ordinal) || p.stage)
    if (!stage) return send(sock, ctx.jid, m, `\u274c There is no stage *${ordinal}*. Use *${ctx.settings.prefix}stages*.`)
    if (stage.locked) return send(sock, ctx.jid, m, '\ud83d\udd12 That stage is locked.')
    const enemy = buildEnemy(stage)
    const b = {
      mode: 'stage',
      ordinal: Number(stage.ordinal),
      enemy,
      enemyHp: enemy.hp,
      playerHp: p.hp,
      energy: p.powerEnergy,
      turn: 1,
      healsLeft: ctx.settings.selfHealPerCombat,
      guard: 0
    }
    await store.setBattle(ctx.userId, b)
    await store.log(ctx.userId, 'battle_start', String(stage.ordinal), { enemy: enemy.name })
    return withVisual(sock, ctx.jid, m, enemy.boss ? 'boss' : 'battle',
      battleCard(b, p, `You step into *${enemy.name}*.`), battleButtons(), true)
  }

  function battleButtons () {
    return [
      ['\u2694\ufe0f Attack', 'ax_b_attack'],
      ['\ud83e\udde0 Class Move', 'ax_b_class'],
      ['\u2764\ufe0f Self-Heal', 'ax_b_heal'],
      ['\ud83c\udccf Card', 'ax_b_card'],
      ['\ud83d\udee1\ufe0f Guard', 'ax_b_guard'],
      ['\ud83c\udfc3 Retreat', 'ax_b_retreat']
    ]
  }

  async function cardPanel (sock, m, ctx) {
    const rows = await store.cards(ctx.userId)
    if (!rows.length) {
      return send(sock, ctx.jid, m, `${WATERMARK}\n\n\ud83c\udccf *CARD COLLECTION*\n\nYou hold no cards yet.\nCards are granted by AXYON or won in Duels.`)
    }
    const lines = rows.map(c => {
      const exp = c.expires_at ? new Date(c.expires_at).toISOString().slice(0, 10) : 'never'
      return [
        `*${c.slot}. ${c.name}*${c.claimed ? ' \u2705' : ''}`,
        `   \ud83d\udde1\ufe0f ${c.weapon || '\u2014'} \u2022 \ud83d\udca5 ${c.damage}`,
        `   \u2728 ${c.ability || '\u2014'} \u2022 \ud83d\udca5 ${c.ability_damage}`,
        `   \u2b50 ${c.rating} \u2022 \u23f3 ${exp}`
      ].join('\n')
    })
    const defs = rows.slice(0, 6).map(c => [`\ud83c\udccf ${c.name}`, `ax_claim_${c.slot}`])
    return buttons(sock, ctx.jid, m, [WATERMARK, '', '\ud83c\udccf *CARD COLLECTION*', '', lines.join('\n\n'), '', `Card abilities: *${ctx.settings.cardAbilitiesPerDay}* per day.`].join('\n'), WATERMARK, defs)
  }

  async function claimCard (sock, m, ctx, slot) {
    const c = await store.claimCard(ctx.userId, Number(slot))
    if (!c) return send(sock, ctx.jid, m, `\u274c You have no card in slot *${slot}*.`)
    await store.log(ctx.userId, 'claim_card', String(slot))
    return send(sock, ctx.jid, m, [
      `${WATERMARK}`, '', '\u2705 *CARD CLAIMED*', '',
      `> \ud83c\udccf *${c.name}*`,
      `\ud83d\udde1\ufe0f Weapon: *${c.weapon || '\u2014'}*`,
      `\ud83d\udca5 Damage: *${c.damage}*`,
      `\u2728 Ability: *${c.ability || '\u2014'}*`,
      `\ud83d\udca5 Ability Damage: *${c.ability_damage}*`,
      `\u2b50 Rating: *${c.rating}*`,
      `\u23f3 Expires: *${c.expires_at ? new Date(c.expires_at).toISOString().slice(0, 10) : 'never'}*`
    ].join('\n'))
  }

  async function battleAct (sock, m, ctx, action) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    const b = await store.getBattle(ctx.userId)
    if (!b) return send(sock, ctx.jid, m, `\u2694\ufe0f You are not in a battle. Use *${ctx.settings.prefix}stages*.`)

    if (action === 'retreat') {
      await store.setBattle(ctx.userId, null)
      return send(sock, ctx.jid, m, `${WATERMARK}\n\n\ud83c\udfc3 *RETREATED*\n\nYou pull back. No rewards, no losses.`)
    }

    if (action === 'heal' && b.healsLeft <= 0) {
      return send(sock, ctx.jid, m, `\u2764\ufe0f *NO HEALS LEFT*\n\nYou have used all ${ctx.settings.selfHealPerCombat} self-heals this combat.`)
    }

    if (action === 'class') {
      if (p.classMovesUsed >= ctx.settings.classMovesPerDay) {
        return send(sock, ctx.jid, m, `\ud83e\udde0 *CLASS MOVES SPENT*\n\nYou have used all *${ctx.settings.classMovesPerDay}* class moves today.`)
      }
      const move = CLASS_MOVES[p.class] || CLASS_MOVES.fighter
      if (b.energy < move.cost) return send(sock, ctx.jid, m, `\u26a1 Not enough Power Energy. *${move.name}* costs *${move.cost}*.`)
    }

    if (action === 'card') {
      if (p.cardUses >= ctx.settings.cardAbilitiesPerDay) {
        return send(sock, ctx.jid, m, `\ud83c\udccf *CARD ABILITIES SPENT*\n\nYou have used all *${ctx.settings.cardAbilitiesPerDay}* card abilities today.`)
      }
      const owned = await store.cards(ctx.userId)
      const card = owned.find(c => c.claimed)
      if (!card) return send(sock, ctx.jid, m, '\ud83c\udccf You have no claimed card to call on.')
      b.cardName = card.name
      b.cardDamage = card.ability_damage || card.damage || 10
    }

    let note = ''
    let dealt = 0

    if (action === 'attack') {
      dealt = playerHit(p, b.enemy)
      note = `\u2694\ufe0f You strike for *${dealt}*.`
    } else if (action === 'guard') {
      b.guard = 0.6
      note = '\ud83d\udee1\ufe0f You brace for the counter.'
    } else if (action === 'heal') {
      const amount = Math.round(p.maxHp * 0.25)
      b.playerHp = Math.min(p.maxHp, b.playerHp + amount)
      b.healsLeft -= 1
      p.healUses += 1
      await store.savePlayer(p)
      note = `\u2764\ufe0f You recover *${amount}* HP. *${b.healsLeft}* heals left.`
    } else if (action === 'class') {
      const move = CLASS_MOVES[p.class] || CLASS_MOVES.fighter
      b.energy -= move.cost
      dealt = playerHit(p, b.enemy, 1.0, move.damage)
      p.classMovesUsed += 1
      await store.savePlayer(p)
      note = `\ud83e\udde0 *${move.name}* lands for *${dealt}*.`
    } else if (action === 'card') {
      dealt = playerHit(p, b.enemy, 1.0, b.cardDamage || 10)
      p.cardUses += 1
      await store.savePlayer(p)
      note = `\ud83c\udccf *${b.cardName || 'Card'}* erupts for *${dealt}*.`
    }

    b.enemyHp -= dealt

    if (b.enemyHp <= 0) return finishBattle(sock, m, ctx, p, b, true)

    const hit = enemyHit(b.enemy, p, b.guard)
    b.guard = 0
    b.playerHp -= hit
    note += `\n\ud83d\udc79 ${b.enemy.name} answers for *${hit}*.`

    if (b.playerHp <= 0) return finishBattle(sock, m, ctx, p, b, false)

    b.turn += 1
    b.energy = Math.min(p.maxPowerEnergy, b.energy + 8)
    await store.setBattle(ctx.userId, b)

    return withVisual(sock, ctx.jid, m, b.enemy.boss ? 'boss' : 'battle', battleCard(b, p, note), battleButtons(), true)
  }

  async function finishBattle (sock, m, ctx, p, b, won) {
    await store.setBattle(ctx.userId, null)
    if (won) {
      const settings = ctx.settings
      const xpRoom = Math.max(0, settings.xpDailyLimit - p.xpToday)
      const zenRoom = Math.max(0, settings.zenDailyLimit - p.zenToday)
      const xp = Math.min(b.enemy.xp, xpRoom)
      const zen = Math.min(b.enemy.zen, zenRoom)
      p.wins += 1
      p.xpToday += xp
      p.zenToday += zen
      if (b.mode === 'stage' && b.ordinal >= p.stage) p.stage = b.ordinal + 1
      const { player: after, events } = applyProgress(p, { xp, zen })
      await store.savePlayer(after)
      await store.log(ctx.userId, 'battle_win', b.enemy.name, { xp, zen, ordinal: b.ordinal })

      const notes = events.map(e => e.type === 'level' ? `\u2b06\ufe0f Level *${e.level}*`
        : e.type === 'grade' ? `\ud83c\udf1f Grade *${e.grade}* \u2014 +\u2764\ufe0f${e.hp} +\u2694\ufe0f${e.atk}`
          : `\ud83d\udc51 Rank up \u2192 *${e.rank}* \u2022 Power Energy restored to *${e.powerEnergy}*`)
      const capped = (b.enemy.xp > xp || b.enemy.zen > zen) ? `\n\n> Daily cap reached \u2014 see *${ctx.settings.prefix}economy view*.` : ''

      return buttons(sock, ctx.jid, m, [
        `${WATERMARK}`, '', '\ud83c\udfc6 *VICTORY*', '',
        `*${b.enemy.name}* falls.`, '',
        `\u2728 +${fmt(xp)} XP \u2022 \ud83e\ude99 +${fmt(zen)} Zen`,
        notes.length ? `\n${notes.join('\n')}` : '',
        capped, '',
        `\ud83c\udf96\ufe0f Rank *${after.rank}* \u2022 Lv. *${after.level}*`
      ].filter(Boolean).join('\n'), WATERMARK, [['\u2694\ufe0f Next Stage', 'ax_stages'], ['\ud83d\udc64 Profile', 'ax_profile']])
    }

    p.losses += 1
    p.hp = Math.max(1, Math.round(p.maxHp * 0.25))
    await store.savePlayer(p)
    await store.log(ctx.userId, 'battle_loss', b.enemy.name, { ordinal: b.ordinal })
    return buttons(sock, ctx.jid, m, [
      `${WATERMARK}`, '', '\ud83d\udc80 *DEFEAT*', '',
      `*${b.enemy.name}* overwhelms you.`, '',
      `\u2764\ufe0f You wake with *${p.hp}/${p.maxHp}* HP.`,
      'No Zen was lost \u2014 only time.'
    ].join('\n'), WATERMARK, [['\ud83d\udd04 Try Again', 'ax_stages'], ['\ud83d\udc64 Profile', 'ax_profile']])
  }

  /* ----------------------------------------------------------------- duels */

  async function beginDuel (sock, m, ctx, opponentId) {
    if (!ctx.jid.endsWith('@g.us')) return send(sock, ctx.jid, m, '\ud83e\udd4a Duels happen inside a WhatsApp group.')
    if (!opponentId || opponentId === ctx.userId) return send(sock, ctx.jid, m, `\ud83e\udd4a Mention an opponent: *${ctx.settings.prefix}duel @player*`)
    const a = await store.player(ctx.userId)
    const b = await store.player(opponentId)
    if (!a) return send(sock, ctx.jid, m, `\ud83c\udf00 Register first with *${ctx.settings.prefix}arise*.`)
    if (!b) return send(sock, ctx.jid, m, '\ud83c\udf00 That player has not used `!arise` yet.')
    const d = await store.createDuel(ctx.jid, ctx.userId, opponentId)
    await store.log(ctx.userId, 'duel_challenge', opponentId, { id: d.id })
    return tapButtons(sock, ctx.jid, m, [
      `${WATERMARK}`, '', '\ud83e\udd4a *DUEL CHALLENGE*', '',
      `> *${a.name}* \u2694\ufe0f *${b.name}*`, '',
      `Rank *${a.rank}* Lv.${a.level} vs Rank *${b.rank}* Lv.${b.level}`, '',
      'Both fighters are granted temporary group admin for the duration of the duel, then demoted when it ends.', '',
      `*${ctx.settings.prefix}duel accept ${d.id}*  \u2022  *${ctx.settings.prefix}duel decline ${d.id}*`
    ].join('\n'), WATERMARK, [['\u2705 Accept', `ax_duel_accept_${d.id}`], ['\u274c Decline', `ax_duel_decline_${d.id}`]])
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
    if (!d || d.status !== 'pending') {
      return send(sock, ctx.jid, m, '\u231b That challenge is no longer active.')
    }
    if (ctx.userId !== d.opponent && !ctx.auth.axyon) {
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

    await store.updateDuel(d.id, { status: 'active', state: { turn: d.challenger, round: 1 }, promoted })
    await store.log(ctx.userId, 'duel_accept', String(d.id), { promoted })

    return send(sock, ctx.jid, m, [
      `${WATERMARK}`, '', '\u2694\ufe0f *DUEL BEGINS*', '',
      `> *${a.name || d.challenger}* vs *${b.name || d.opponent}*`, '',
      `Rank *${a.rank}* Lv.${a.level} \u2022 ${a.hp} HP`,
      `Rank *${b.rank}* Lv.${b.level} \u2022 ${b.hp} HP`, '',
      promoteNote, '',
      `Duel *#${d.id}* is live.`
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
    const zen = 120 + rnd(180)
    const room = Math.max(0, ctx.settings.zenDailyLimit - p.zenToday)
    const gain = Math.min(zen, room)
    p.zenToday += gain
    p.lastDaily = new Date().toISOString()
    p.maxPowerEnergy = Math.max(p.maxPowerEnergy, powerEnergyForRank(p.rank))
    p.powerEnergy = p.maxPowerEnergy
    const { player: after } = applyProgress(p, { zen: gain })
    await store.savePlayer(after)
    await store.log(ctx.userId, 'daily', ctx.userId, { gain })
    return send(sock, ctx.jid, m, `${WATERMARK}\n\n\ud83c\udf81 *DAILY*\n\n\ud83e\ude99 +${fmt(gain)} Zen\n\u26a1 Power Energy restored to *${after.maxPowerEnergy}*\n\nZen today: *${fmt(after.zenToday)}/${fmt(ctx.settings.zenDailyLimit)}*`)
  }

  async function zenWallet (sock, m, ctx) {
    const p = await store.player(ctx.userId)
    if (!p) return arise(sock, m, ctx)
    const q = store.rollDay(p)
    const left = Math.max(0, ctx.settings.zenDailyLimit - q.zenToday)
    const lines = [
      `${WATERMARK}`, '', '\ud83e\ude99 *ZEN WALLET*', '',
      `Zen held: *${fmt(q.zen)}*`,
      `Earned today: *${fmt(q.zenToday)}/${fmt(ctx.settings.zenDailyLimit)}*`,
      `Remaining daily allowance: *${fmt(left)}*`, '',
      '\ud83d\udc8e Coins are separate \u2014 they come from gameplay and have no daily limit.'
    ]
    if (economy) {
      try {
        const u = await economy.getBalance(ctx.userId, q.name)
        lines.push('', `\ud83d\udc5b Casino wallet: *${economy.fmt(u.wallet)}*`)
      } catch { /* wallet is optional */ }
    }
    return send(sock, ctx.jid, m, lines.join('\n'))
  }

  /* ------------------------------------------------------------------ help */

  const SECTIONS = {
    core: { name: 'Core', icon: '\ud83c\udf00' },
    battle: { name: 'Battle', icon: '\u2694\ufe0f' },
    dungeon: { name: 'Dungeon', icon: '\ud83c\udff9' },
    cards: { name: 'Cards', icon: '\ud83c\udccf' },
    social: { name: 'Social', icon: '\ud83d\udc9e' },
    economy: { name: 'Economy', icon: '\ud83e\ude99' },
    management: { name: 'Management', icon: '\ud83d\udc51' }
  }

  function helpPage (section, prefix) {
    const meta = SECTIONS[section]
    const rows = COMMANDS.filter(c => c.section === section && !c.hidden)
    if (!meta || !rows.length) return null
    return [
      `${WATERMARK}`, '', `${meta.icon} *HELP \u2014 ${meta.name.toUpperCase()}*`, '',
      rows.map(c => `*${c.usage.replace(/\{p\}/g, prefix)}*\n${c.desc}`).join('\n\n'), '',
      `> Prefix: *${prefix}*  \u2022  ${prefix}help for all sections`
    ].join('\n')
  }

  function helpAll (prefix) {
    const out = [`${WATERMARK}`, '', '\ud83d\udcda *AXYON \u2014 COMMAND INDEX*', '']
    for (const [key, meta] of Object.entries(SECTIONS)) {
      const rows = COMMANDS.filter(c => c.section === key && !c.hidden)
      if (!rows.length) continue
      out.push(`${meta.icon} *${meta.name.toUpperCase()}*`)
      out.push(rows.map(c => `\u2022 ${c.usage.replace(/\{p\}/g, prefix)}`).join('\n'))
      out.push('')
    }
    out.push(`> Prefix: *${prefix}* \u2022 ${prefix}help <section>`)
    return out.join('\n')
  }

  function helpButtons () {
    return Object.entries(SECTIONS).map(([k, v]) => [`${v.icon} ${v.name}`, `ax_help_${k}`])
  }

  return {
    WATERMARK, CLASSES, CLASS_MOVES, MODES, COMMANDS, SECTIONS,
    cmd, send, buttons, tapButtons, withVisual,
    arise, profile, listStages, beginBattle, battleAct, finishBattle, battleButtons,
    cardPanel, claimCard, beginDuel, answerDuel, daily, zenWallet,
    helpPage, helpAll, helpButtons,
    applyProgress, powerEnergyForRank, buildEnemy, profileCard, battleCard
  }
}

module.exports = {
  createAxyon, applyProgress, buildEnemy, playerHit, enemyHit,
  powerEnergyForRank, profileCard, battleCard,
  CLASSES, CLASS_MOVES, MODES, WATERMARK
}
