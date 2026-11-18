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
const npc = require('./axyon-npc')
const display = require('./axyon-combat-display')
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
 * It is now a plain dossier: one light frame, WhatsApp *bold* labels, an em
 * dash, and monospace values so the numbers line up in a column. Section rules
 * split it into VITALS / COMBAT / HOLDINGS so the eye can jump straight to the
 * group it wants. Everything is ordinary ASCII plus emoji, which every
 * WhatsApp client renders identically.
 *
 * `!arise` and every other card keep their existing treatment — this change is
 * scoped to the profile card only.
 */
function profileCard (p, extra = {}) {
  const need = store.xpNeed(p.level)
  const name = String(p.name || '').trim() || 'Unnamed Hunter'

  const body = [
    `\ud83d\udc64 ${T.b(name)}`,
    extra.partner ? `\ud83d\udc9e ${T.i('bound to')} ${T.b(extra.partner)}` : null,
    '',
    T.rule('VITALS', 'thin'),
    `\ud83d\udcc8 ${T.b('Level')} — ${T.m(p.level)}   \ud83c\udfc5 ${T.b('Rank')} — ${T.b(p.rank)}   \ud83c\udf96\ufe0f ${T.b('Grade')} — ${T.m(p.grade)}`,
    `\ud83c\udfad ${T.b('Class')} — ${p.class || 'Fighter'}`,
    '',
    `\u2764\ufe0f ${T.b('HP')}  ${T.barLine(p.hp, p.maxHp)}`,
    `\ud83d\udd0b ${T.b('Power Energy')}  ${T.barLine(p.powerEnergy, p.maxPowerEnergy)}`,
    `\ud83d\udca0 ${T.b('XP')}  ${T.barLine(p.xp, need)}`,
    '',
    T.rule('COMBAT', 'thin'),
    `\u2694\ufe0f ${T.b('Attack')} — ${T.m(p.atk)}   \ud83d\udee1\ufe0f ${T.b('Armor')} — ${T.m(p.def)}   \ud83d\udca8 ${T.b('Speed')} — ${T.m(p.spd)}`,
    `\ud83c\udfc6 ${T.b('Record')} — ${T.m(p.wins)}W / ${T.m(p.losses)}L`,
    '',
    T.rule('HOLDINGS', 'thin'),
    `\ud83d\udcb0 ${T.b('Zen')} — ${T.m(fmt(p.zen))}   \ud83d\udc8e ${T.b('Coins')} — ${T.m(fmt(p.coins))}`,
    `\ud83d\udeaa ${T.b('Stage')} — ${T.m(p.stage)}`
  ].filter(x => x !== null && x !== undefined)

  return [
    /*
     * A PLAIN HEADER, not T.header().
     *
     * T.header() renders the bot name in a mathematical-bold display font,
     * which is exactly the treatment this card is dropping. Every other card
     * still uses T.header(); only the profile card gets this plain variant, so
     * the change stays scoped to `!profile`.
     */
    `\u2b21 *AXYN CORE*`,
    `\u2514\u2500 by ${greetings.creatorsOf(extra.settings).join(' & ')}`,
    '',
    T.frame(body, { kind: 'light', title: 'DOSSIER', width: 30 }),
    '',
    `\ud83c\udf96\ufe0f ${T.b(p.rank)} • ${T.i(`grade ${p.grade}`)} • ${T.i(`level ${p.level}`)}`
  ].join('\n')
}

/**
 * The battle card.
 *
 * Heavy frame, because a fight should not look like a profile. Enemy on top,
 * hunter below, both with monospace bars, then the remaining uses.
 */
function battleCard (b, p, note = '') {
  const e = b.enemy

  /*
   * RENDERED THROUGH THE SPEC'S DISPLAY LAYER.
   *
   * The engine has already computed every number by the time we get here, so
   * this only formats them: a 20-segment HP/PE bar beside the exact values,
   * the enemy and hunter panels, and the live usage tracker. Nothing below
   * rolls a die or clamps a stat — if a value is absent it is omitted rather
   * than filled with something plausible.
   */
  const playerPanel = display.combatantPanel({
    name: p.name,
    rank: p.rank,
    level: p.level,
    class: p.class,
    hp: Math.max(0, b.playerHp),
    maxHp: p.maxHp,
    pe: Math.max(0, b.energy),
    maxPe: p.maxPowerEnergy,
    atk: p.atk,
    def: p.def
  }, 'player')

  const enemyPanel = display.combatantPanel({
    name: e.name,
    type: e.boss ? 'BOSS' : 'MONSTER',
    rank: e.rank,
    level: e.level,
    class: e.className,
    grade: e.grade,
    hp: Math.max(0, b.enemyHp),
    maxHp: e.hp,
    pe: e.pe != null ? e.pe : undefined,
    maxPe: e.maxPe != null ? e.maxPe : undefined,
    atk: e.atk,
    def: e.def,
    abilities: Array.isArray(e.abilities) ? e.abilities : undefined
  }, 'enemy')

  const tracker = display.usageTracker({
    moves: liveClassMoves(p).map(m => ({ name: m.name, used: p.classMovesUsed || 0, limit: 3 })),
    heals: { used: Math.max(0, 5 - Math.max(0, b.healsLeft ?? 5)), limit: 5 }
  })

  return [
    T.header({ creators: greetings.creatorsOf({}) }),
    '',
    `${T.b('BATTLE')} \u2022 ${T.i(`turn ${b.turn}`)}${e.boss ? ` \u2022 ${T.b('BOSS')}` : ''}`,
    '',
    note ? `${note}\n` : null,
    enemyPanel,
    '',
    playerPanel,
    '',
    tracker
  ].filter(x => x !== null && x !== undefined).join('\n')
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
      ? greetings.firstGreeting(p, settings.prefix, settings)
      : greetings.returnGreeting(p, settings.prefix, settings)
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
    // Upgrade inherited card art lazily, using its original stored artwork URL.
    // If the old source is unavailable, preserve and show the existing image.
    if (c.image_url && c.renderer !== 'old-gen') {
      try {
        const upgraded = await cardSpawner.renderUpdatedArtwork(c, c.image_url)
        c = await store.editCard(ctx.userId, Number(collectionNo), { imageData: upgraded.rendered.buffer, renderer: 'old-gen' }) || c
      } catch (error) { console.warn('[AXYON cards] legacy card re-render skipped:', error?.message || error) }
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

  async function battleAct (sock, m, ctx, action, cardSlot = 1, moveName = null) {
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

    let note = ''
    let dealt = 0

    if (action === 'attack') {
      const equipped = await store.equippedCards(ctx.userId)
      const weaponCard = equipped.find(c => Number(c.equipped_slot) === 1)
      const baseBonus = weaponCard && (!weaponCard.expires_at || new Date(weaponCard.expires_at).getTime() > Date.now()) ? Number(weaponCard.damage) || 0 : 0
      dealt = playerHit(p, b.enemy, 1.0, baseBonus)
      note = `\u2694\ufe0f You strike for *${dealt}*${baseBonus ? ` (includes ${weaponCard.name} +${baseBonus})` : ''}.`
    } else if (action === 'guard') {
      b.guard = 0.6
      note = '\ud83d\udee1\ufe0f You brace for the counter.'
    } else if (action === 'heal') {
      /*
       * FLAT 10 HP, as the implementation note specifies.
       *
       * This used to heal 25% of max HP, which scaled with the player and made
       * the five-per-combat limit worth wildly different amounts at level 1 and
       * level 80. The note fixes the value at 10, so it is a constant now.
       */
      const amount = SELF_HEAL_HP
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
        dealt = dmg.final
        note = `\ud83e\udde0 *${classMove.name}* lands for *${dealt}*.`
        if (dmg.bonus) note += `\n> base ${dmg.scaled} + class ${classGrade.grade} bonus ${dmg.bonus}`
      } else if (classMove.type === 'defensive') {
        b.guard = 0.6
        note = `\ud83d\udee1\ufe0f *${classMove.name}* \u2014 you brace.`
      } else if (classMove.type === 'support' && Number(classMove.heal) > 0) {
        const before = b.playerHp
        b.playerHp = Math.min(p.maxHp, b.playerHp + Number(classMove.heal))
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
    }

    b.enemyHp -= dealt

    if (b.enemyHp <= 0) return finishBattle(sock, m, ctx, p, b, true)

    const hit = enemyHit(b.enemy, p, b.guard)
    b.guard = 0
    b.playerHp -= hit
    note += `\n\ud83d\udc79 ${b.enemy.name} answers for *${hit}*.`

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
        note += `\n\u2728 ${b.enemy.name} uses *${b.enemy.signature}* for *${move.final}*.`
      } else if (b.enemy.signature) {
        note += `\n\u2728 ${b.enemy.name} invokes *${b.enemy.signature}*.`
      }
    }

    if (b.playerHp <= 0) return finishBattle(sock, m, ctx, p, b, false)

    b.turn += 1
    b.energy = Math.min(p.maxPowerEnergy, b.energy + 8)
    await store.setBattle(ctx.userId, b)

    return withVisual(sock, ctx.jid, m, b.enemy.boss ? 'boss' : 'battle', battleCard(b, p, note), battleButtons(), true)
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

      const continueButton = ['floor', 'floor_boss'].includes(b.mode)
        ? ['\ud83c\udff9 Dungeon', 'ax_dungeon']
        : ['\u2694\ufe0f Next Stage', 'ax_stages']
      return buttons(sock, ctx.jid, m, [
        `${WATERMARK}`, '', '\ud83c\udfc6 *VICTORY*', '',
        `*${b.enemy.name}* falls.`, '',
        `\u2728 +${fmt(xp)} XP \u2022 \ud83e\ude99 +${fmt(zen)} Zen`,
        notes.length ? `\n${notes.join('\n')}` : '',
        capped, '',
        `\ud83c\udf96\ufe0f Rank *${after.rank}* \u2022 Lv. *${after.level}*`
      ].filter(Boolean).join('\n'), WATERMARK, [continueButton, ['\ud83d\udc64 Profile', 'ax_profile']])
    }

    p.losses += 1
    p.hp = Math.max(1, Math.round(p.maxHp * 0.25))
    await store.savePlayer(p)
    await store.log(ctx.userId, 'battle_loss', b.enemy.name, { ordinal: b.ordinal })
    const retryButton = ['floor', 'floor_boss'].includes(b.mode)
      ? ['\ud83d\udd04 Dungeon', 'ax_dungeon']
      : ['\ud83d\udd04 Try Again', 'ax_stages']
    return buttons(sock, ctx.jid, m, [
      `${WATERMARK}`, '', '\ud83d\udc80 *DEFEAT*', '',
      `*${b.enemy.name}* overwhelms you.`, '',
      `\u2764\ufe0f You wake with *${p.hp}/${p.maxHp}* HP.`,
      'No Zen was lost \u2014 only time.'
    ].join('\n'), WATERMARK, [retryButton, ['\ud83d\udc64 Profile', 'ax_profile']])
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

  return {
    WATERMARK, CLASSES, CLASS_MOVES, MODES, COMMANDS, SECTIONS,
    cmd, send, buttons, tapButtons, withVisual,
    arise, profile, listStages, beginBattle, battleAct, finishBattle, battleButtons,
    classSheet,
    cardPanel, cardDetail, equipCard, unequipCard, cardSlots, cardAbilities, claimCard, claimDrop, beginDuel, answerDuel, daily, zenWallet, play,
    helpPage, helpAll, helpButtons, helpCommand,
    applyProgress, powerEnergyForRank, buildEnemy, profileCard, battleCard
  }
}

module.exports = {
  createAxyon, applyProgress, buildEnemy, playerHit, enemyHit,
  powerEnergyForRank, profileCard, battleCard,
  CLASSES, CLASS_MOVES, MODES, WATERMARK
}