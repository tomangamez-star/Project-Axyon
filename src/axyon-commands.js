'use strict'
/*
 * AXYON COMMAND ROUTER — every command from the manuscript, registered once
 * and rendered into help from the same registry so docs cannot drift.
 *
 * Prefix is ! by default (store.DEFAULT_SETTINGS.prefix) and AXYON can change
 * it with !prefix.
 */
const store = require('./axyon-store')
const { norm, isOwner } = require('./access')
const { canonicalUserId, displayName } = require('./economy-router')

const WATERMARK = '\u232c AXYN CORE'

const MODE_LIST = {
  duel: { name: 'Duel', blurb: 'One player against another player.' },
  solo: { name: 'Solo', blurb: 'One player enters a gate alone.' },
  multiplayer: { name: 'Multiplayer', blurb: 'Several players, individual turns.' },
  party: { name: 'Party', blurb: 'An organised team of 2 or more.' }
}

function parseNum (v) {
  const n = Number(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? Math.floor(n) : null
}

function mentionedId (content = {}) {
  const ci = content?.extendedTextMessage?.contextInfo || content?.imageMessage?.contextInfo || {}
  const jid = (ci.mentionedJid || [])[0] || ci.participant
  return jid ? String(jid).split(':')[0].split('@')[0] : null
}

function createCommands ({ axyon, economy, logger }) {
  const cmd = axyon.cmd
  const W = WATERMARK

  /* ------------------------------------------------------------ authority */

  async function authority (userId) {
    const owner = isOwner(userId)
    const numberMode = await store.axyonNumberMode(userId).catch(() => null)
    const isAxyonNumber = numberMode !== null
    const rhmRole = await store.roleOf(userId).catch(() => null)
    return {
      owner,
      isAxyonNumber,
      numberMode,
      // AXYON authority: original owner, or a number registered in AXYON_NUMBERS.
      // Switching to PLAYER mode does NOT remove management authority, per the manuscript.
      axyon: owner || isAxyonNumber,
      rhm: !!rhmRole || owner
    }
  }

  /* ---------------------------------------------------------- registration */

  cmd('arise', 'core', '{p}arise', 'Register with the System and awaken your hunter.', async (s, m, ctx) => axyon.arise(s, m, ctx))
  cmd('profile', 'core', '{p}profile', 'Your rank, grade, stats, energy and stage.', async (s, m, ctx) => axyon.profile(s, m, ctx))
  cmd('help', 'core', '{p}help [section]', 'Every command, grouped by section.', async (s, m, ctx, args) => {
    const section = String(args[0] || '').toLowerCase()
    if (section && axyon.SECTIONS[section]) return axyon.send(s, ctx.jid, m, axyon.helpPage(section, ctx.prefix))
    if (section && section !== 'all') {
      return axyon.send(s, ctx.jid, m, `${W}\n\nNo section named *${section}*.\nSections: ${Object.keys(axyon.SECTIONS).join(', ')}`)
    }
    return axyon.buttons(s, ctx.jid, m, axyon.helpAll(ctx.prefix), W, [
      ...axyon.helpButtons(),
      ['\ud83d\udc64 Profile', 'ax_profile']
    ])
  })
  cmd('ping', 'core', '{p}ping', 'Check that Architect is awake.', async (s, m, ctx) => axyon.send(s, ctx.jid, m, `\ud83c\udfd3 *Pong* \u2014 ${W}`), { hidden: true })
  cmd('top', 'core', '{p}top', 'The strongest hunters by level and XP.', async (s, m, ctx) => {
    const rows = await store.leaderboard(10)
    if (!rows.length) return axyon.send(s, ctx.jid, m, `${W}\n\nNo hunters have arisen yet.`)
    const med = ['\ud83e\udd47', '\ud83e\udd48', '\ud83e\udd49']
    return axyon.send(s, ctx.jid, m, [
      `${W}`, '', '\ud83c\udfc6 *HUNTER RANKING*', '',
      rows.map((p, i) => `${med[i] || `${i + 1}.`} *${p.name || p.userId}*\n   \ud83c\udf96\ufe0f ${p.rank} \u2022 G${p.grade} \u2022 Lv.${p.level} \u2022 \ud83c\udfc6 ${p.wins}W`).join('\n\n')
    ].join('\n'))
  })

  /* ---------------------------------------------------------------- prefix */

  cmd('prefix', 'management', '{p}prefix <symbol>', 'Change the command prefix (AXYON only).', async (s, m, ctx, args) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *AXYON ONLY*\n\nOnly AXYON can change the prefix.')
    const next = String(args[0] || '').trim()
    if (!next || next.length > 3) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}prefix !* \u2014 1 to 3 characters.`)
    await store.setSetting('prefix', next)
    await store.log(ctx.userId, 'set_prefix', next)
    return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *PREFIX CHANGED*\n\nNew prefix: *${next}*\nExample: *${next}help*`)
  })

  /* ---------------------------------------------------------------- stages */

  cmd('stages', 'battle', '{p}stages', 'List battle stages and your position.', async (s, m, ctx) => axyon.listStages(s, m, ctx))
  cmd('fight', 'battle', '{p}fight <stage>', 'Enter a stage and fight.', async (s, m, ctx, args) => {
    const p = await store.player(ctx.userId)
    const ordinal = parseNum(args[0]) ?? p?.stage ?? 1
    return axyon.beginBattle(s, m, ctx, ordinal)
  })
  cmd('battle', 'battle', '{p}battle', 'Resume an active battle.', async (s, m, ctx) => {
    const b = await store.getBattle(ctx.userId)
    const p = await store.player(ctx.userId)
    if (!b) return axyon.send(s, ctx.jid, m, `\u2694\ufe0f No active battle. Use *${ctx.prefix}stages*.`)
    return axyon.withVisual(s, ctx.jid, m, b.enemy.boss ? 'boss' : 'battle', axyon.battleCard(b, p), axyon.battleButtons())
  }, { hidden: true })
  cmd('attack', 'battle', '{p}attack', 'Strike the enemy.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'attack'), { hidden: true })
  cmd('guard', 'battle', '{p}guard', 'Reduce the next hit by 60%.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'guard'), { hidden: true })
  cmd('heal', 'battle', '{p}heal', 'Recover 25% HP. 5 uses per combat.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'heal'), { hidden: true })
  cmd('class', 'battle', '{p}class', 'Use your class move. 3 uses per day.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'class'), { hidden: true })
  cmd('carduse', 'battle', '{p}carduse', 'Call on a claimed card. 3 uses per day.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'card'), { hidden: true })
  cmd('retreat', 'battle', '{p}retreat', 'Leave the fight with no rewards.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'retreat'), { hidden: true })

  /* --------------------------------------------------------------- dungeon */

  cmd('dungeon', 'dungeon', '{p}dungeon', 'Dungeon modes and floors.', async (s, m, ctx) => {
    const modes = await store.modes()
    const floors = await store.floors()
    const lines = [
      `${W}`, '', '\ud83c\udff9 *DUNGEON*', '',
      '*MODES*',
      modes.map(x => `${x.enabled ? '\u2705' : '\u274c'} *${MODE_LIST[x.mode]?.name || x.mode}* \u2014 max ${x.max_players}\n   ${MODE_LIST[x.mode]?.blurb || ''}`).join('\n'),
      '',
      '*FLOORS*',
      floors.length ? floors.map(f => `${f.locked ? '\ud83d\udd12' : '\u25ab\ufe0f'} *${f.ordinal}. ${f.name}* ${f.boss ? '\ud83d\udc80' : ''}\n   \u2764\ufe0f ${f.hp} \u2022 \u2694\ufe0f ${f.atk} \u2022 \u2728 ${f.xp} XP`).join('\n') : 'No floors configured.',
      '',
      'Gates control progression. Fillers are a separate system and never merged with gates.'
    ]
    return axyon.buttons(s, ctx.jid, m, lines.join('\n'), W, [
      ['\ud83c\udff9 Solo Gate', 'ax_dungeon_solo'],
      ['\ud83d\udd25 Party Gate', 'ax_party_view'],
      ['\u2694\ufe0f Stages', 'ax_stages']
    ])
  })

  cmd('floor', 'dungeon', '{p}floor <n>', 'Enter a dungeon floor.', async (s, m, ctx, args) => {
    const p = await store.player(ctx.userId)
    if (!p) return axyon.arise(s, m, ctx)
    const floors = await store.floors()
    if (!floors.length) return axyon.send(s, ctx.jid, m, `\ud83c\udff9 No dungeon floors exist yet. AXYON can add one with *${ctx.prefix}flooradmin add <name>*`)
    const ordinal = parseNum(args[0]) ?? 1
    const f = floors.find(x => Number(x.ordinal) === ordinal)
    if (!f) return axyon.send(s, ctx.jid, m, `\u274c No floor *${ordinal}*.`)
    if (f.locked) return axyon.send(s, ctx.jid, m, '\ud83d\udd12 That floor is locked.')
    const enemy = { name: f.name, hp: f.hp, atk: f.atk, def: f.def, xp: f.xp, zen: f.zen, boss: f.boss }
    const b = { mode: 'floor', ordinal, enemy, enemyHp: enemy.hp, playerHp: p.hp, energy: p.powerEnergy, turn: 1, healsLeft: ctx.settings.selfHealPerCombat, guard: 0 }
    await store.setBattle(ctx.userId, b)
    await store.log(ctx.userId, 'floor_enter', String(ordinal), { name: f.name })
    return axyon.withVisual(s, ctx.jid, m, f.boss ? 'boss' : 'dungeon', axyon.battleCard(b, p, `You descend into *${f.name}*.`), axyon.battleButtons())
  })

  /* ----------------------------------------------------------------- party */

  cmd('party', 'dungeon', '{p}party <create|join|leave|view>', 'Organise a party. Minimum 2, default max 5.', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'view').toLowerCase()
    const settings = ctx.settings
    if (sub === 'create') {
      const p = await store.player(ctx.userId)
      if (!p) return axyon.send(s, ctx.jid, m, `\ud83c\udf00 Use *${ctx.prefix}arise* first.`)
      const party = await store.createParty(ctx.jid, ctx.userId, [ctx.userId])
      await store.log(ctx.userId, 'party_create', String(party.id))
      return axyon.buttons(s, ctx.jid, m, [
        `${W}`, '', '\ud83d\udd25 *PARTY FORMED*', '',
        `Leader: *${p.name || ctx.userId}*`,
        `Members: *1/${settings.partyMax}*`, '',
        `Minimum *${settings.partyMin}* players to enter a gate.`,
        `Others join with *${ctx.prefix}party join*.`
      ].join('\n'), W, [['\ud83d\udd25 View Party', 'ax_party_view'], ['\ud83c\udff9 Dungeon', 'ax_dungeon']])
    }
    if (sub === 'join') {
      const open = await store.openParty(ctx.jid)
      if (!open) return axyon.send(s, ctx.jid, m, `\ud83d\udd25 No open party. Start one with *${ctx.prefix}party create*.`)
      const members = [...new Set([...(open.members || []), ctx.userId])]
      if (members.length > settings.partyMax) return axyon.send(s, ctx.jid, m, `\u274c That party is full (max *${settings.partyMax}*).`)
      await store.updateParty(open.id, members)
      const p = await store.player(ctx.userId)
      await store.log(ctx.userId, 'party_join', String(open.id))
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *JOINED PARTY*\n\n*${p?.name || ctx.userId}* joined.\nMembers: *${members.length}/${settings.partyMax}*`)
    }
    if (sub === 'leave') {
      const open = await store.openParty(ctx.jid)
      if (!open) return axyon.send(s, ctx.jid, m, '\ud83d\udd25 You are not in a party.')
      const members = (open.members || []).filter(x => x !== ctx.userId)
      await store.updateParty(open.id, members, members.length ? null : 'closed')
      return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udc4b You left the party. *${members.length}* remain.`)
    }
    const open = await store.openParty(ctx.jid)
    if (!open) return axyon.send(s, ctx.jid, m, `\ud83d\udd25 No open party here.\nStart one with *${ctx.prefix}party create*.`)
    const names = []
    for (const id of open.members || []) {
      const p = await store.player(id)
      names.push(`\u2022 *${p?.name || `+${id}`}*${id === open.leader ? ' \ud83d\udc51' : ''}`)
    }
    return axyon.buttons(s, ctx.jid, m, [
      `${W}`, '', '\ud83d\udd25 *PARTY*', '',
      names.join('\n'), '',
      `Members: *${(open.members || []).length}/${settings.partyMax}* \u2022 minimum *${settings.partyMin}*`
    ].join('\n'), W, [['\u2705 Join', 'ax_party_join'], ['\ud83d\udc4b Leave', 'ax_party_leave'], ['\ud83c\udff9 Dungeon', 'ax_dungeon']])
  })

  /* ----------------------------------------------------------------- duels */

  cmd('duel', 'dungeon', '{p}duel @player', 'Challenge a player. Both get temporary admin.', async (s, m, ctx, args, content) => {
    const opponent = mentionedId(content) || norm(args[0] || '')
    return axyon.beginDuel(s, m, ctx, opponent || null)
  })

  /* ----------------------------------------------------------------- cards */

  cmd('cards', 'cards', '{p}cards', 'Your card collection and stats.', async (s, m, ctx) => axyon.cardPanel(s, m, ctx))
  cmd('claim', 'cards', '{p}claim card <n>', 'Claim a card by its slot number.', async (s, m, ctx, args) => {
    const slot = parseNum(args[1] ?? args[0])
    if (!slot) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}claim card 1*`)
    return axyon.claimCard(s, m, ctx, slot)
  })

  /* ---------------------------------------------------------------- social */

  cmd('marry', 'social', '{p}marry @player', 'Send a binding request. It needs their approval.', async (s, m, ctx, args, content) => {
    const target = mentionedId(content) || norm(args[0] || '')
    if (!target) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}marry @player*`)
    if (target === ctx.userId) return axyon.send(s, ctx.jid, m, '\ud83d\udc9e You cannot bind to yourself.')
    const a = await store.player(ctx.userId)
    const b = await store.player(target)
    if (!a) return axyon.send(s, ctx.jid, m, `\ud83c\udf00 Use *${ctx.prefix}arise* first.`)
    if (!b) return axyon.send(s, ctx.jid, m, '\ud83c\udf00 That player has not arisen yet.')
    const r = await store.socialRequest(ctx.userId, target, 'marriage')
    if (!r.ok) return axyon.send(s, ctx.jid, m, `\u274c ${r.message}`)
    await store.log(ctx.userId, 'social_request', target)
    return axyon.buttons(s, ctx.jid, m, [
      `${W}`, '', '\ud83d\udc9e *BINDING REQUEST*', '',
      `> *${a.name || ctx.userId}* \u2192 *${b.name || target}*`, '',
      `${b.name || target}, this requires your approval.`,
      `Request *#${r.request.id}*`
    ].join('\n'), W, [['\u2705 Accept', `ax_social_yes_${r.request.id}`], ['\u274c Decline', `ax_social_no_${r.request.id}`]])
  })

  cmd('requests', 'social', '{p}requests', 'Pending social requests waiting for you.', async (s, m, ctx) => {
    const rows = await store.pendingSocial(ctx.userId)
    if (!rows.length) return axyon.send(s, ctx.jid, m, '\ud83d\udc9e No pending requests.')
    const lines = []
    for (const r of rows) {
      const p = await store.player(r.requester)
      lines.push(`\u2022 *#${r.id}* ${r.kind} from *${p?.name || r.requester}*`)
    }
    return axyon.send(s, ctx.jid, m, [W, '', '\ud83d\udc9e *PENDING REQUESTS*', '', lines.join('\n'), '', `Accept with *${ctx.prefix}accept <id>*`].join('\n'))
  })

  cmd('accept', 'social', '{p}accept <id>', 'Accept a social request by its number.', async (s, m, ctx, args) => {
    const id = parseNum(args[0])
    if (!id) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}accept <id>*`)
    const r = await store.resolveSocial(id, ctx.userId, true)
    if (!r) return axyon.send(s, ctx.jid, m, '\u274c No pending request with that number.')
    await store.log(ctx.userId, 'social_accept', r.requester)
    return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udc9e *BINDING ACCEPTED*\n\nThe relationship is now recorded.`)
  })
  cmd('decline', 'social', '{p}decline <id>', 'Decline a social request by its number.', async (s, m, ctx, args) => {
    const id = parseNum(args[0])
    if (!id) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}decline <id>*`)
    const r = await store.resolveSocial(id, ctx.userId, false)
    if (!r) return axyon.send(s, ctx.jid, m, '\u274c No pending request with that number.')
    return axyon.send(s, ctx.jid, m, `${W}\n\n\u274c Request declined.`)
  })
  cmd('divorce', 'social', '{p}divorce', 'End a binding. Both sides are told.', async (s, m, ctx) => {
    const r = await store.endSocial(ctx.userId)
    if (!r) return axyon.send(s, ctx.jid, m, '\ud83d\udc9e You have no active binding.')
    await store.log(ctx.userId, 'social_end', r.requester)
    return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udc94 *BINDING ENDED*\n\nThe relationship has been dissolved.`)
  })

  /* --------------------------------------------------------------- economy */

  cmd('zen', 'economy', '{p}zen', 'Your Zen holdings and daily allowance.', async (s, m, ctx) => axyon.zenWallet(s, m, ctx))
  cmd('daily', 'economy', '{p}daily', 'Claim Zen and restore Power Energy.', async (s, m, ctx) => axyon.daily(s, m, ctx))
  cmd('economy', 'economy', '{p}economy <xp|zen|view> [value]', 'View or set daily XP and Zen limits (AXYON only).', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'view').toLowerCase()
    if (sub === 'view') {
      const s2 = await store.settings()
      const p = await store.player(ctx.userId)
      return axyon.send(s, ctx.jid, m, [
        `${W}`, '', '\ud83e\ude99 *ECONOMY*', '',
        `Daily XP limit: *${s2.xpDailyLimit}*`,
        `Daily Zen limit: *${s2.zenDailyLimit}*`, '',
        `Your XP today: *${p?.xpToday ?? 0}*`,
        `Your Zen today: *${p?.zenToday ?? 0}*`
      ].join('\n'))
    }
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *AXYON ONLY*\n\nOnly AXYON can change the economy limits.')
    const value = parseNum(args[1])
    if (!['xp', 'zen'].includes(sub)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}economy xp 5000*`)
    if (value === null || value < 0) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}economy ${sub} <amount>*`)
    await store.setSetting(sub === 'xp' ? 'xpDailyLimit' : 'zenDailyLimit', value)
    await store.log(ctx.userId, 'economy_limit', sub, { value })
    return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *LIMIT UPDATED*\n\nDaily ${sub.toUpperCase()} limit: *${value}*`)
  })

  /* --------------------------------------------------------------- resets */

  cmd('reset', 'management', '{p}reset [@player]', 'Reset your progression, or another player\u2019s (AXYON).', async (s, m, ctx, args, content) => {
    const target = mentionedId(content) || norm(args[0] || '') || null
    const self = !target || target === ctx.userId
    if (!self && !ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *AXYON ONLY*\n\nOnly AXYON can reset another player.')
    const id = self ? ctx.userId : target
    const p = await store.resetPlayer(id)
    if (!p) return axyon.send(s, ctx.jid, m, '\u274c That player has no progression to reset.')
    await store.log(ctx.userId, 'reset', id, { self })
    return axyon.send(s, ctx.jid, m, [
      `${W}`, '', '\ud83d\udd04 *PROGRESSION RESET*', '',
      `Target: *${p.name || id}*`, '',
      'Rank *E* \u2022 Level *1* \u2022 Grade *1*',
      'Zen, coins and stage cleared.', '',
      '> Every reset is logged so duplicate rewards cannot be farmed.'
    ].join('\n'))
  })

  /* --------------------------------------------------- group registration */

  cmd('register', 'management', '{p}register [name]', 'Register this group so Architect responds here.', async (s, m, ctx, args) => {
    if (!ctx.jid.endsWith('@g.us')) return axyon.send(s, ctx.jid, m, '\ud83d\udccd Run this inside the group you want to register.')
    if (!ctx.auth.axyon && !ctx.isGroupAdmin) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f Only AXYON or a group admin can register a group.')
    let name = args.join(' ').trim()
    if (!name) { try { name = (await s.groupMetadata(ctx.jid))?.subject || '' } catch { name = '' } }
    const g = await store.registerGroup(ctx.jid, name, ctx.userId)
    await store.log(ctx.userId, 'register_group', ctx.jid, { name })
    return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *GROUP REGISTERED*\n\n${name ? `*${g.name}*\n` : ''}Architect will now respond here.\n\nUnregistered groups stay silent, as designed.`)
  })

  cmd('unregister', 'management', '{p}unregister', 'Stop Architect responding in this group.', async (s, m, ctx) => {
    if (!ctx.auth.axyon && !ctx.isGroupAdmin) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f Only AXYON or a group admin can unregister a group.')
    await store.unregisterGroup(ctx.jid)
    await store.log(ctx.userId, 'unregister_group', ctx.jid)
    return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\uded1 *GROUP UNREGISTERED*\n\nArchitect will ignore this group.`)
  })

  cmd('groups', 'management', '{p}groups', 'List registered groups (AXYON only).', async (s, m, ctx) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *AXYON ONLY*')
    const rows = await store.groups()
    if (!rows.length) return axyon.send(s, ctx.jid, m, `${W}\n\nNo groups registered.`)
    return axyon.send(s, ctx.jid, m, [W, '', '\ud83d\udccd *REGISTERED GROUPS*', '', rows.map(g => `${g.enabled ? '\u2705' : '\u23f8\ufe0f'} *${g.name || 'Unnamed'}*\n   \`${g.group_jid}\``).join('\n\n')].join('\n'))
  })

  /* -------------------------------------------------------- AXYON identity */

  cmd('mode', 'management', '{p}mode <axyon|player>', 'Switch identity. PLAYER keeps AXYON authority.', async (s, m, ctx, args) => {
    const want = String(args[0] || '').toLowerCase()
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *AXYON ONLY*')
    if (!['axyon', 'player'].includes(want)) {
      const current = ctx.auth.numberMode || 'axyon'
      return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83e\udeb7 *IDENTITY*\n\nCurrent: *${current.toUpperCase()} MODE*\n\n*${ctx.prefix}mode player* \u2014 use normal saved progression\n*${ctx.prefix}mode axyon* \u2014 owner authority and management\n\n> Switching to PLAYER does not remove AXYON's management authority.`)
    }
    await store.setNumberMode(ctx.userId, want)
    await store.log(ctx.userId, 'identity_mode', want)
    return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83e\udeb7 *IDENTITY SWITCHED*\n\nNow operating in *${want.toUpperCase()} MODE*.\n\n${want === 'player' ? 'You use normal saved player progression. Management commands remain available to you.' : 'Full AXYON authority and management access.'}`)
  })

  cmd('numbers', 'management', '{p}numbers <add|remove|list> [number]', 'Manage AXYON_NUMBERS (AXYON only).', async (s, m, ctx, args, content) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *AXYON ONLY*')
    const sub = String(args[0] || 'list').toLowerCase()
    if (sub === 'list') {
      const rows = await store.axyonNumbers()
      return axyon.send(s, ctx.jid, m, [W, '', '\ud83d\udcf1 *AXYON NUMBERS*', '', rows.length ? rows.map(r => `\u2022 +${r.user_id} \u2014 *${(r.mode || 'axyon').toUpperCase()}*`).join('\n') : 'No extra numbers.', '', `Add with *${ctx.prefix}numbers add 234XXXXXXXXXX*`].join('\n'))
    }
    const target = mentionedId(content) || norm(args[1] || '')
    if (!/^\d{8,15}$/.test(target || '')) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}numbers add 234XXXXXXXXXX*`)
    if (sub === 'add') {
      await store.addAxyonNumber(target, ctx.userId)
      await store.log(ctx.userId, 'axyon_number_add', target)
      return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udcf1 *NUMBER ADDED*\n\n+${target} now holds AXYON authority.\n\nThis is how authority survives losing the owner's phone.`)
    }
    if (['remove', 'delete', 'del'].includes(sub)) {
      await store.removeAxyonNumber(target)
      await store.log(ctx.userId, 'axyon_number_remove', target)
      return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udcf1 *NUMBER REMOVED*\n\n+${target} no longer holds AXYON authority.`)
    }
    return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}numbers add|remove|list*`)
  })

  cmd('rhm', 'management', '{p}rhm <add|remove|list> [@player]', 'Manage RHM management roles (AXYON only).', async (s, m, ctx, args, content) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *AXYON ONLY*')
    const sub = String(args[0] || 'list').toLowerCase()
    if (sub === 'list') {
      const rows = await store.roles()
      return axyon.send(s, ctx.jid, m, [W, '', '\ud83d\udee1\ufe0f *RHM MANAGEMENT*', '', rows.length ? rows.map(r => `\u2022 +${r.user_id} \u2014 *${r.role}*`).join('\n') : 'No RHM roles.', '', "> RHM never overrides AXYON's ultimate authority."].join('\n'))
    }
    const target = mentionedId(content) || norm(args[1] || '')
    if (!/^\d{8,15}$/.test(target || '')) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}rhm add @player*`)
    if (sub === 'add') {
      const role = String(args[2] || 'rhm').toLowerCase()
      await store.addRole(target, role, ctx.userId)
      await store.log(ctx.userId, 'rhm_add', target, { role })
      return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udee1\ufe0f *RHM ADDED*\n\n+${target} \u2014 *${role}*\n\nScoped to the systems granted. AXYON remains above RHM.`)
    }
    if (['remove', 'delete', 'del'].includes(sub)) {
      await store.removeRole(target)
      await store.log(ctx.userId, 'rhm_remove', target)
      return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udee1\ufe0f *RHM REMOVED*\n\n+${target} lost management access.`)
    }
    return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}rhm add|remove|list*`)
  })

  /* ------------------------------------------------------- stage management */

  cmd('stage', 'management', '{p}stage <add|edit|move|lock|unlock|remove> ...', 'Manage battle stages (AXYON / RHM).', async (s, m, ctx, args) => {
    if (!ctx.auth.axyon && !ctx.auth.rhm) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *MANAGEMENT ONLY*')
    const sub = String(args[0] || '').toLowerCase()
    if (sub === 'add') {
      const name = args.slice(1).join(' ').trim()
      if (!name) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}stage add <name> [hp] [atk] [def] [xp] [zen]*`)
      const st = await store.addStage({ name, hp: parseNum(args[2]) ?? 80, atk: parseNum(args[3]) ?? 6, def: parseNum(args[4]) ?? 3, xp: parseNum(args[5]) ?? 50, zen: parseNum(args[6]) ?? 80 })
      await store.log(ctx.userId, 'stage_add', st.key, { name })
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *STAGE ADDED*\n\n*${st.ordinal}. ${st.name}*\n\u2764\ufe0f ${st.hp} \u2022 \u2694\ufe0f ${st.atk} \u2022 \ud83d\udee1\ufe0f ${st.def}`)
    }
    if (sub === 'edit') {
      const ordinal = parseNum(args[1])
      if (!ordinal) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}stage edit <n> [name] [hp] [atk] [def] [xp] [zen]*`)
      const st = await store.editStage(ordinal, { name: args[2] || null, hp: parseNum(args[3]), atk: parseNum(args[4]), def: parseNum(args[5]), xp: parseNum(args[6]), zen: parseNum(args[7]) })
      if (!st) return axyon.send(s, ctx.jid, m, `\u274c No stage *${ordinal}*.`)
      await store.log(ctx.userId, 'stage_edit', String(ordinal))
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *STAGE UPDATED*\n\n*${st.ordinal}. ${st.name}*\n\u2764\ufe0f ${st.hp} \u2022 \u2694\ufe0f ${st.atk} \u2022 \ud83d\udee1\ufe0f ${st.def} \u2022 \u2728 ${st.xp}`)
    }
    if (sub === 'move') {
      const from = parseNum(args[1]); const to = parseNum(args[2])
      if (!from || !to) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}stage move <from> <to>*`)
      const rows = await store.moveStage(from, to)
      if (!rows) return axyon.send(s, ctx.jid, m, '\u274c Both positions must exist.')
      await store.log(ctx.userId, 'stage_move', `${from}->${to}`)
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *STAGE MOVED*\n\n${from} \u2192 ${to}`)
    }
    if (['lock', 'unlock'].includes(sub)) {
      const ordinal = parseNum(args[1])
      const st = await store.lockStage(ordinal, sub === 'lock')
      if (!st) return axyon.send(s, ctx.jid, m, `\u274c No stage *${ordinal}*.`)
      await store.log(ctx.userId, `stage_${sub}`, String(ordinal))
      return axyon.send(s, ctx.jid, m, `${W}\n\n${sub === 'lock' ? '\ud83d\udd12' : '\ud83d\udd13'} *STAGE ${sub.toUpperCase()}ED*\n\n*${st.ordinal}. ${st.name}*`)
    }
    if (sub === 'remove') {
      const ordinal = parseNum(args[1])
      const r = await store.removeStage(ordinal)
      if (!r.ok) return axyon.send(s, ctx.jid, m, `\u274c ${r.message}`)
      await store.log(ctx.userId, 'stage_remove', String(ordinal))
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *STAGE REMOVED*\n\n*${r.stage.name}*`)
    }
    return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}stage add|edit|move|lock|unlock|remove*`)
  })

  cmd('flooradmin', 'management', '{p}flooradmin <add|edit|lock|unlock|remove> ...', 'Manage dungeon floors (AXYON / RHM).', async (s, m, ctx, args) => {
    if (!ctx.auth.axyon && !ctx.auth.rhm) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *MANAGEMENT ONLY*')
    const sub = String(args[0] || '').toLowerCase()
    if (sub === 'add') {
      const name = args.slice(1).join(' ').trim()
      if (!name) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}flooradmin add <name> [hp] [atk] [def] [xp] [zen] [boss]*`)
      const f = await store.addFloor({ name, hp: parseNum(args[2]) ?? 200, atk: parseNum(args[3]) ?? 12, def: parseNum(args[4]) ?? 6, xp: parseNum(args[5]) ?? 150, zen: parseNum(args[6]) ?? 200, boss: String(args[7] || '').toLowerCase() === 'boss' })
      await store.log(ctx.userId, 'floor_add', f.key, { name })
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *FLOOR ADDED*\n\n*${f.ordinal}. ${f.name}*${f.boss ? ' \ud83d\udc80' : ''}`)
    }
    if (sub === 'edit') {
      const ordinal = parseNum(args[1])
      const f = await store.editFloor(ordinal, { name: args[2] || null, hp: parseNum(args[3]), atk: parseNum(args[4]), def: parseNum(args[5]), xp: parseNum(args[6]), zen: parseNum(args[7]) })
      if (!f) return axyon.send(s, ctx.jid, m, `\u274c No floor *${ordinal}*.`)
      await store.log(ctx.userId, 'floor_edit', String(ordinal))
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *FLOOR UPDATED*\n\n*${f.ordinal}. ${f.name}*`)
    }
    if (['lock', 'unlock'].includes(sub)) {
      const f = await store.lockFloor(parseNum(args[1]), sub === 'lock')
      if (!f) return axyon.send(s, ctx.jid, m, '\u274c No such floor.')
      return axyon.send(s, ctx.jid, m, `${W}\n\n${sub === 'lock' ? '\ud83d\udd12' : '\ud83d\udd13'} *FLOOR ${sub.toUpperCase()}ED*\n\n*${f.name}*`)
    }
    if (sub === 'remove') {
      const f = await store.removeFloor(parseNum(args[1]))
      if (!f) return axyon.send(s, ctx.jid, m, '\u274c No such floor.')
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *FLOOR REMOVED*\n\n*${f.name}*`)
    }
    return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}flooradmin add|edit|lock|unlock|remove*`)
  })

  /* -------------------------------------------------------- modes & visuals */

  cmd('modes', 'management', '{p}modes <list|enable|disable|max> ...', 'Configure dungeon modes (AXYON / RHM).', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'list').toLowerCase()
    if (sub === 'list') {
      const rows = await store.modes()
      return axyon.send(s, ctx.jid, m, [W, '', '\ud83c\udff9 *MODES*', '', rows.map(r => `${r.enabled ? '\u2705' : '\u274c'} *${MODE_LIST[r.mode]?.name || r.mode}* \u2014 max *${r.max_players}*`).join('\n')].join('\n'))
    }
    if (!ctx.auth.axyon && !ctx.auth.rhm) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *MANAGEMENT ONLY*')
    const mode = String(args[1] || '').toLowerCase()
    if (!MODE_LIST[mode]) return axyon.send(s, ctx.jid, m, `Modes: ${Object.keys(MODE_LIST).join(', ')}`)
    if (sub === 'max') {
      const n = parseNum(args[2])
      if (!n || n < 2) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}modes max party 8*`)
      await store.setMode(mode, { maxPlayers: n })
      if (mode === 'party') await store.setSetting('partyMax', n)
      await store.log(ctx.userId, 'mode_max', mode, { n })
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *${MODE_LIST[mode].name.toUpperCase()} MAX* \u2192 *${n}*`)
    }
    const enabled = sub === 'enable'
    await store.setMode(mode, { enabled })
    await store.log(ctx.userId, `mode_${sub}`, mode)
    return axyon.send(s, ctx.jid, m, `${W}\n\n${enabled ? '\u2705' : '\u274c'} *${MODE_LIST[mode].name.toUpperCase()}* ${enabled ? 'enabled' : 'disabled'}.`)
  })

  cmd('visual', 'management', '{p}visual <set|remove|list> <mode> [url]', 'Configure mode-specific images, GIFs and clips.', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'list').toLowerCase()
    if (sub === 'list') {
      const rows = await store.visuals()
      return axyon.send(s, ctx.jid, m, [W, '', '\ud83c\udfa8 *VISUALS*', '', rows.length ? rows.map(r => `\u2022 *${r.mode}* \u2014 ${r.url ? `\`${r.url.slice(0, 60)}\`` : 'none'}${r.caption ? `\n   _${r.caption}_` : ''}`).join('\n') : 'No visuals configured.', '', 'Modes: arise, profile, battle, boss, dungeon, duel', '', `> ${W} is the watermark.`].join('\n'))
    }
    if (!ctx.auth.axyon && !ctx.auth.rhm) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *MANAGEMENT ONLY*')
    const mode = String(args[1] || '').toLowerCase()
    if (!mode) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}visual set battle <url>*`)
    if (sub === 'remove') {
      await store.clearVisual(mode)
      return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83c\udfa8 Visual for *${mode}* removed.`)
    }
    const url = String(args[2] || '').trim()
    if (!/^https?:\/\//i.test(url)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}visual set ${mode} https://...*`)
    const caption = args.slice(3).join(' ').trim()
    await store.setVisual(mode, url, caption)
    await store.log(ctx.userId, 'visual_set', mode, { url: url.slice(0, 80) })
    return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83c\udfa8 *VISUAL SET*\n\nMode: *${mode}*\n\`${url.slice(0, 80)}\``)
  })

  /* ------------------------------------------------------------- admin cards */

  cmd('grantcard', 'management', '{p}grantcard @player <name>', 'Grant a card to a player (AXYON).', async (s, m, ctx, args, content) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *AXYON ONLY*')
    const target = mentionedId(content) || norm(args[0] || '')
    if (!/^\d{8,15}$/.test(target || '')) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}grantcard @player <name>*`)
    const name = args.slice(1).join(' ').trim()
    if (!name) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}grantcard @player <name>*`)
    const existing = await store.cards(target)
    const slot = existing.length + 1
    const c = await store.addCard(target, {
      slot, name, weapon: 'Summoned Blade', damage: 24, ability: 'System Burst', abilityDamage: 18, rating: 3
    })
    await store.log(ctx.userId, 'grant_card', target, { name, slot })
    return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83c\udccf *CARD GRANTED*\n\nTarget: *${target}*\nSlot: *${slot}*\nCard: *${c.name}*\n\nThey claim it with *${ctx.prefix}claim card ${slot}*`)
  })

  /* --------------------------------------------------------------- dispatch */

  const BY_NAME = new Map()
  for (const c of axyon.COMMANDS) BY_NAME.set(c.name, c)
  const ALIASES = {
    fs: 'stages', h: 'help', p: 'profile', me: 'profile',
    wallet: 'zen', money: 'zen', collection: 'cards', inv: 'cards',
    leaderboard: 'top', lb: 'top'
  }
  for (const [alias, target] of Object.entries(ALIASES)) {
    const c = BY_NAME.get(target)
    if (c && !BY_NAME.has(alias)) BY_NAME.set(alias, c)
  }

  async function buildContext (sock, m, content) {
    const userId = canonicalUserId(m.key)
    const jid = m.key.remoteJid
    const settings = await store.settings()
    let group = null
    if (jid.endsWith('@g.us')) group = await store.group(jid)
    const auth = await authority(userId)
    let isGroupAdmin = false
    if (jid.endsWith('@g.us')) {
      try {
        const meta = await sock.groupMetadata(jid)
        isGroupAdmin = (meta.participants || []).some(p => {
          const ids = [p.id, p.phoneNumber, p.lid].filter(Boolean)
          return ids.some(v => String(v).split(':')[0].split('@')[0] === userId) && p.admin
        })
      } catch { /* metadata unavailable */ }
    }
    const prefix = group?.prefix || settings.prefix
    return { userId, jid, name: displayName(m), settings, group, auth, isGroupAdmin, prefix, content }
  }

  /** Parses `<prefix>command args...` from message content. */
  function parse (content, prefix) {
    const raw = String(content?.conversation || content?.extendedTextMessage?.text || '').trim()
    if (!raw) return null
    if (!raw.startsWith(prefix)) return null
    const parts = raw.slice(prefix.length).split(/\s+/).filter(Boolean)
    if (!parts.length) return null
    return { command: parts[0].toLowerCase().split('@')[0], args: parts.slice(1), raw }
  }

  async function handle (sock, m, content) {
    const ctx = await buildContext(sock, m, content)
    const parsed = parse(content, ctx.prefix)
    if (!parsed) return false

    // Unregistered groups are ignored, except for AXYON who may register them.
    if (ctx.jid.endsWith('@g.us') && !ctx.group && ctx.settings.groupRegistrationRequired) {
      if (!ctx.auth.axyon) return true // silent, by design
      if (!['register', 'groups', 'unregister'].includes(parsed.command)) return true
    }

    const command = BY_NAME.get(parsed.command)
    if (!command) return false
    try {
      await command.handler(sock, m, ctx, parsed.args, content)
    } catch (e) {
      logger?.error?.({ err: e, command: parsed.command }, 'AXYON command failed')
      await sock.sendMessage(ctx.jid, { text: `\u26a0\ufe0f Command failed: ${e.message}` }, { quoted: m }).catch(() => {})
    }
    return true
  }

  /** Handles native button ids emitted by this module (ax_*). */
  async function section (sock, m, id) {
    if (!String(id).startsWith('ax_')) return false
    const ctx = await buildContext(sock, m, {})

    if (id === 'ax_profile') { await axyon.profile(sock, m, ctx); return true }
    if (id === 'ax_help') {
      await axyon.buttons(sock, ctx.jid, m, axyon.helpAll(ctx.prefix), W, [...axyon.helpButtons()])
      return true
    }
    if (id.startsWith('ax_help_')) { await axyon.send(sock, ctx.jid, m, axyon.helpPage(id.slice(8), ctx.prefix)); return true }
    if (id === 'ax_stages') { await axyon.listStages(sock, m, ctx); return true }
    if (id.startsWith('ax_fight_')) { await axyon.beginBattle(sock, m, ctx, parseNum(id.slice(9))); return true }
    if (id === 'ax_cards') { await axyon.cardPanel(sock, m, ctx); return true }
    if (id.startsWith('ax_claim_')) { await axyon.claimCard(sock, m, ctx, parseNum(id.slice(9))); return true }
    if (id === 'ax_dungeon') { await BY_NAME.get('dungeon').handler(sock, m, ctx, [], {}); return true }
    if (id === 'ax_dungeon_solo') {
      const floors = await store.floors()
      if (floors.length) { await BY_NAME.get('floor').handler(sock, m, ctx, ['1'], {}); return true }
      await BY_NAME.get('stages').handler(sock, m, ctx, [], {}); return true
    }
    if (id === 'ax_party_view') { await BY_NAME.get('party').handler(sock, m, ctx, ['view'], {}); return true }
    if (id === 'ax_party_join') { await BY_NAME.get('party').handler(sock, m, ctx, ['join'], {}); return true }
    if (id === 'ax_party_leave') { await BY_NAME.get('party').handler(sock, m, ctx, ['leave'], {}); return true }
    if (id.startsWith('ax_b_')) { await axyon.battleAct(sock, m, ctx, id.slice(5)); return true }
    if (id.startsWith('ax_social_yes_')) { await BY_NAME.get('accept').handler(sock, m, ctx, [id.slice(14)], {}); return true }
    if (id.startsWith('ax_social_no_')) { await BY_NAME.get('decline').handler(sock, m, ctx, [id.slice(13)], {}); return true }
    if (id.startsWith('ax_duel_')) {
      const bits = id.match(/^ax_duel_(accept|decline)_(\d+)$/)
      if (!bits) return false
      const d = await store.duel(Number(bits[2]))
      if (!d || d.status !== 'pending') { await axyon.send(sock, ctx.jid, m, '\u231b That challenge is no longer active.'); return true }
      if (ctx.userId !== d.opponent && !ctx.auth.axyon) { await axyon.send(sock, ctx.jid, m, '\ud83d\udd12 Only the challenged player can answer.'); return true }
      if (bits[1] === 'decline') {
        await store.updateDuel(d.id, { status: 'declined' })
        await axyon.send(sock, ctx.jid, m, `${W}\n\n\u274c *DUEL DECLINED*`)
        return true
      }
      await store.updateDuel(d.id, { status: 'active', state: { turn: d.challenger, round: 1 } })
      await store.log(ctx.userId, 'duel_accept', String(d.id))
      const a = await store.player(d.challenger); const b = await store.player(d.opponent)
      await axyon.send(sock, ctx.jid, m, [W, '', '\u2694\ufe0f *DUEL BEGINS*', '', `*${a?.name || d.challenger}* vs *${b?.name || d.opponent}*`, '', 'Temporary admin promotion is applied for the duration of the duel and removed when it ends.'].join('\n'))
      return true
    }
    return false
  }

  return { handle, section, parse, buildContext, BY_NAME, mentionedId }
}

module.exports = { createCommands, MODE_LIST, mentionedId }
