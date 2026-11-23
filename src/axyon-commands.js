'use strict'
/*
 * AXYON COMMAND ROUTER — every command from the manuscript, registered once
 * and rendered into help from the same registry so docs cannot drift.
 *
 * Prefix is ! by default (store.DEFAULT_SETTINGS.prefix) and AXYON can change
 * it with !prefix.
 *
 * This module has no dependency on the old economy/casino command system. It
 * reads identity from ./identity and authority from ./access + the store.
 */
const store = require('./axyon-store')
const greetings = require('./greetings')
const lore = require('./lore')
const floorStory = require('./floor-story')
const T = require('./theme')
const items = require('./axyon-items')
const cardSpawner = require('./card-spawn')
const classes = require('./axyon-classes')
const modesLib = require('./axyon-modes')
const guild = require('./axyon-guild')
const lyrics = require('./lyrics')

/** Thousands separators, matching the formatter the RPG cards use. */
const fmt = (n) => Number(n || 0).toLocaleString('en-US')
const { norm, isOwner } = require('./access')
const { canonicalUserId, displayName, mentionedId } = require('./identity')

const WATERMARK = '\u232c AXYN CORE'

/* A group-metadata lookup that hangs must never hang the command. */
const GROUP_META_TIMEOUT_MS = 4000

function withTimeout (promise, ms) {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('group metadata timed out')), ms) })
  ])
}

/* Commands that must work before a player has registered. */
const OPEN_BEFORE_ARISE = new Set(['arise', 'help', 'ping', 'register', 'group', 'unregister', 'groups', 'prefix', 'numbers', 'rhm', 'stage', 'flooradmin', 'modes', 'visual', 'economy', 'reset', 'grantcard', 'spawncard', 'cardadmin', 'classadmin', 'top', 'story', 'aura', 'feedback', 'room', 'roomtype'])

const MODE_LIST = {
  duel: { name: 'Duel', blurb: 'One player against another player.' },
  solo: { name: 'Solo', blurb: 'One player enters a gate alone.' },
  multiplayer: { name: 'Multiplayer', blurb: 'Several players, individual turns.' },
  party: { name: 'Party', blurb: 'An organised team of 2 or more.' }
}

function parseNum (v) {
  const raw = String(v ?? '').replace(/,/g, '').trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? Math.floor(n) : null
}

function createCommands ({ axyon, economy, logger, ai }) {
  const cmd = axyon.cmd
  const W = WATERMARK

  /* How many stories each player has read, so `!story` walks the anthology
   * instead of repeating. In memory on purpose: it is a reading position. */
  const storyReads = new Map()
  // Short-lived conversational memory, scoped per chat and speaker.
  const architectHistory = new Map()

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
      // Management authority is tied to verified identity, not WhatsApp group role.
      axyon: owner || isAxyonNumber,
      rhm: !!rhmRole || owner
    }
  }

  /* ---------------------------------------------------------- registration */

  cmd('arise', 'core', '{p}arise', 'Register with the System and awaken your hunter.', async (s, m, ctx) => axyon.arise(s, m, ctx))
  cmd('profile', 'core', '{p}profile', 'Your rank, grade, stats, energy and stage.', async (s, m, ctx) => axyon.profile(s, m, ctx))
  cmd('help', 'core', '{p}help [section|command]', 'Every command, grouped by section. Name a command for detail.', async (s, m, ctx, args) => {
    const section = String(args[0] || '').toLowerCase()
    if (section && axyon.SECTIONS[section]) return axyon.send(s, ctx.jid, m, axyon.helpPage(section, ctx.prefix))
    if (section && section !== 'all') {
      /*
       * Not a section — try it as a command name before giving up. This is what
       * makes `!help fight` and `!help dungeon` work, and it is where the
       * optional long-form explanation is surfaced.
       */
      const one = axyon.helpCommand(section, ctx.prefix)
      if (one) return axyon.send(s, ctx.jid, m, one)
      return axyon.send(s, ctx.jid, m, `${W}\n\nNo section or command named *${section}*.\nSections: ${Object.keys(axyon.SECTIONS).join(', ')}`)
    }
    return axyon.send(s, ctx.jid, m, axyon.helpAll(ctx.prefix))
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
  cmd('fight', 'battle', '{p}fight', 'Enter your next stage and fight.', async (s, m, ctx, args) => {
    const p = await store.player(ctx.userId)
    const ordinal = parseNum(args[0]) ?? p?.stage ?? 1
    return axyon.beginBattle(s, m, ctx, ordinal)
  })
  cmd('battle', 'battle', '{p}battle', 'Resume an active battle.', async (s, m, ctx) => {
    const b = await store.getBattle(ctx.userId)
    const p = await store.player(ctx.userId)
    if (!b) return axyon.send(s, ctx.jid, m, `\u2694\ufe0f No active battle. Use *${ctx.prefix}stages*.`)
    b.equippedCards = await store.equippedCards(ctx.userId)
    if (b.storyPending) return axyon.send(s, ctx.jid, m, floorStory.begin(b.ordinal, await store.floorStory(ctx.userId)).text)
    return axyon.withVisual(s, ctx.jid, m, b.enemy.boss ? 'boss' : 'battle', axyon.battleCard(b, p), [], true)
  }, { hidden: true })
  cmd('attack', 'battle', '{p}attack', 'Strike the enemy.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'attack'), { hidden: true })
  cmd('guard', 'battle', '{p}guard', 'Reduce the next hit by 60%.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'guard'), { hidden: true })
  cmd('defend', 'battle', '{p}defend', 'Alias for guard.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'guard'), { hidden: true })
  cmd('heal', 'battle', '{p}heal', 'Recover 25% HP. 5 uses per combat.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'heal'), { hidden: true })
  cmd('class', 'battle', '{p}class [move]', 'Your class, mastery, grade and moves. In battle, uses a move.', async (s, m, ctx, args) => {
    /*
     * `!class` is BOTH the class sheet and the in-battle move command.
     *
     * The old command was hidden and only ever fired a move, so a player had
     * no way to see their class, mastery, grade or remaining uses. Now: with
     * no argument and no active battle it shows the sheet; with an argument it
     * uses that named move; with no argument inside a battle it uses the
     * default move, which is the old behaviour.
     */
    const b = await store.getBattle(ctx.userId)
    const moveName = args && args.length ? args.join(' ') : null
    if (b || moveName) return axyon.battleAct(s, m, ctx, 'class', 1, moveName)
    return axyon.classSheet(s, m, ctx)
  })
  cmd('classmove', 'battle', '{p}classmove <move>', 'Use a named class move in battle.', async (s, m, ctx, args) => {
    if (!args || !args.length) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}classmove <move name>* \u2014 see *${ctx.prefix}class*.`)
    return axyon.battleAct(s, m, ctx, 'class', 1, args.join(' '))
  }, { hidden: true })
  cmd('carduse', 'battle', '{p}carduse', 'Call on a claimed card. 3 uses per day.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'card'), { hidden: true })
  cmd('ability', 'battle', '{p}ability', 'Use your equipped card ability in battle.', async (s, m, ctx) => axyon.battleAct(s, m, ctx, 'card'), { hidden: true })
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
      `Enter a floor with *${ctx.prefix}floor*.`,
      'Gates control progression. Fillers are a separate system and never merged with gates.'
    ]
    return axyon.send(s, ctx.jid, m, lines.join('\n'))
  })

  cmd('floor', 'dungeon', '{p}floor', 'Enter a dungeon floor.', async (s, m, ctx, args) => {
    const p = await store.player(ctx.userId)
    if (!p) return axyon.arise(s, m, ctx)
    const floors = await store.floors()
    if (!floors.length) return axyon.send(s, ctx.jid, m, `\ud83c\udff9 No dungeon floors exist yet. AXYON can add one with *${ctx.prefix}flooradmin add <name>*`)
    const ordinal = parseNum(args[0]) ?? 1
    const f = floors.find(x => Number(x.ordinal) === ordinal)
    if (!f) return axyon.send(s, ctx.jid, m, `\u274c No floor *${ordinal}*.`)
    if (f.locked) return axyon.send(s, ctx.jid, m, '\ud83d\udd12 That floor is locked.')
    const enemy = { name: f.name, hp: f.hp, atk: f.atk, def: f.def, xp: f.xp, zen: f.zen, boss: f.boss }
    const scene = floorStory.begin(ordinal, await store.floorStory(ctx.userId))
    const b = { mode: 'floor', ordinal, location: f.name, equippedCards: await store.equippedCards(ctx.userId), enemy, enemyHp: enemy.hp, playerHp: p.hp, energy: p.powerEnergy, turn: 1, healsLeft: ctx.settings.selfHealPerCombat, guard: 0, storyPending: true }
    await store.setBattle(ctx.userId, b)
    await store.log(ctx.userId, 'floor_enter', String(ordinal), { name: f.name, chapter: scene.chapter.title })
    return axyon.send(s, ctx.jid, m, scene.text)
  })

  cmd('choice', 'dungeon', '{p}choice <1-4>', 'Make a decision during a floor story event.', async (s, m, ctx, args) => {
    const b = await store.getBattle(ctx.userId)
    if (!b || b.mode !== 'floor' || !b.storyPending) return axyon.send(s, ctx.jid, m, `No pending story decision. Enter a floor with *${ctx.prefix}floor* first.`)
    const result = floorStory.choose(b.ordinal, parseNum(args[0]), await store.floorStory(ctx.userId))
    if (!result.ok) return axyon.send(s, ctx.jid, m, result.message)
    await store.saveFloorStory(ctx.userId, result.state)
    const hpDelta = Number(result.choice.enemy?.hp || 0)
    const atkDelta = Number(result.choice.enemy?.atk || 0)
    b.enemy.hp = Math.max(20, Number(b.enemy.hp || 1) + hpDelta)
    b.enemy.atk = Math.max(1, Number(b.enemy.atk || 1) + atkDelta)
    b.enemyHp = b.enemy.hp
    b.storyPending = false
    b.storyChoice = result.choice.label
    b.storyQuestId = result.choice.quest || null
    b.storyFlags = result.state.flags
    await store.setBattle(ctx.userId, b)
    const p = await store.player(ctx.userId)
    await axyon.send(s, ctx.jid, m, result.message)
    return axyon.withVisual(s, ctx.jid, m, b.enemy.boss ? 'boss' : 'dungeon', axyon.battleCard(b, p), [], true)
  })

  cmd('quest', 'dungeon', '{p}quest [claim <id>]', 'View NPC side quests or claim a completed reward.', async (s, m, ctx, args) => {
    const state = await store.floorStory(ctx.userId)
    if (String(args[0] || '').toLowerCase() !== 'claim') return axyon.send(s, ctx.jid, m, floorStory.questList(state))
    const claimed = floorStory.claim(state, args[1])
    if (!claimed.ok) return axyon.send(s, ctx.jid, m, claimed.message)
    await store.saveFloorStory(ctx.userId, claimed.state)
    const p = await store.player(ctx.userId)
    const xp = Math.min(claimed.reward.xp, Math.max(0, Number(ctx.settings.xpDailyLimit || 5000) - Number(p.xpToday || 0)))
    const zen = Math.min(claimed.reward.zen, Math.max(0, Number(ctx.settings.zenDailyLimit || 5000) - Number(p.zenToday || 0)))
    p.xpToday = Number(p.xpToday || 0) + xp
    p.zenToday = Number(p.zenToday || 0) + zen
    const progressed = axyon.applyProgress(p, { xp, zen })
    await store.savePlayer(progressed.player)
    await store.log(ctx.userId, 'floor_quest_claim', claimed.name, { xp, zen })
    return axyon.send(s, ctx.jid, m, `⌬ AXYN CORE\n\n🏅 *QUEST COMPLETE*\n${claimed.name}\n\n✨ +${xp} XP\n🪙 +${zen} Zen`)
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
      return axyon.send(s, ctx.jid, m, [
        `${W}`, '', '\ud83d\udd25 *PARTY FORMED*', '',
        `Leader: *${p.name || ctx.userId}*`,
        `Members: *1/${settings.partyMax}*`, '',
        `Minimum *${settings.partyMin}* players to enter a gate.`,
        `Others join with *${ctx.prefix}party join*.`
      ].join('\n'))
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
    return axyon.send(s, ctx.jid, m, [
      `${W}`, '', '\ud83d\udd25 *PARTY*', '',
      names.join('\n'), '',
      `Members: *${(open.members || []).length}/${settings.partyMax}* \u2022 minimum *${settings.partyMin}*`, '',
      `*${ctx.prefix}party join* \u2022 *${ctx.prefix}party leave*`
    ].join('\n'))
  })

  /* ----------------------------------------------------------------- rooms */

  /*
   * ROOMS — the session space a mode runs in.
   *
   * A room hosts one mode; it is not a mode itself. These commands are the
   * command-controlled management surface the Modes & Room spec requires, and
   * every one of them is permission-checked through `ctx.auth` before it
   * touches a row.
   */
  cmd('room', 'dungeon', '{p}room <create|list|join|leave|start|close|view> ...', 'Open and manage a game room for a mode.', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'list').toLowerCase()
    const modes = modesLib.createModeRegistry()

    if (sub === 'list') {
      const rows = await store.roomsFor(ctx.jid)
      const live = rows.filter(r => !['completed', 'cancelled', 'expired'].includes(String(r.status)))
      if (!live.length) {
        return axyon.send(s, ctx.jid, m, [
          `${W}`, '', '\ud83c\udf9f\ufe0f *ROOMS*', '',
          'No open rooms here.', '',
          `Open one with *${ctx.prefix}room create <mode> [solo|multiplayer|party]*`,
          `Modes: ${modes.ordered().filter(x => x.enabled).map(x => x.id).join(', ')}`
        ].join('\n'))
      }
      return axyon.send(s, ctx.jid, m, [
        `${W}`, '', '\ud83c\udf9f\ufe0f *ROOMS*', '',
        live.map(r => {
          const parts = Array.isArray(r.participants) ? r.participants.length : 0
          const lock = r.privacy === 'private' ? '\ud83d\udd12' : '\ud83c\udf10'
          return `${lock} *${r.name}* \u2014 ${modes.get(r.mode_id)?.name || r.mode_id}\n   ${r.status} \u2022 ${parts}/${r.capacity} \u2022 ${r.participation}\n   \`${r.room_key}\``
        }).join('\n\n'),
        '', `Join with *${ctx.prefix}room join <key>*`
      ].join('\n'))
    }

    if (sub === 'create') {
      const p = await store.player(ctx.userId)
      if (!p) return axyon.send(s, ctx.jid, m, `\ud83c\udf00 Use *${ctx.prefix}arise* first.`)

      const modeId = String(args[1] || '').toLowerCase()
      const check = modes.canEnter(modeId)
      if (!check.ok) {
        return axyon.send(s, ctx.jid, m, [
          `${W}`, '', `\u274c *CANNOT OPEN THAT MODE*`, '', check.message, '',
          `Available: ${modes.ordered().filter(x => x.enabled && !x.placeholder).map(x => x.id).join(', ')}`
        ].join('\n'))
      }

      const participation = String(args[2] || 'solo').toLowerCase()
      if (!modesLib.modeType(participation)) {
        return axyon.send(s, ctx.jid, m, `Participation must be one of: ${modesLib.MODE_TYPE_IDS.join(', ')}`)
      }
      if (!check.mode.participation.includes(participation)) {
        return axyon.send(s, ctx.jid, m, `\u274c *${check.mode.name}* does not support *${participation}*.\nSupported: ${check.mode.participation.join(', ')}`)
      }

      const privacy = String(args[3] || 'public').toLowerCase() === 'private' ? 'private' : 'public'
      const capacity = modesLib.capacityFor(participation, ctx.settings.partyMax)
      const name = `${check.mode.name.toUpperCase()} \u2014 ROOM ${String(Date.now()).slice(-3)}`

      const room = await store.createRoom({
        name,
        groupJid: ctx.jid,
        ownerId: ctx.userId,
        modeId: check.mode.id,
        participation,
        privacy,
        capacity
      })
      await store.log(ctx.userId, 'room_create', room.room_key, { mode: check.mode.id, participation, privacy })

      return axyon.send(s, ctx.jid, m, [
        `${W}`, '', '\ud83c\udf9f\ufe0f *ROOM OPENED*', '',
        `*${room.name}*`,
        `Mode: *${check.mode.name}*`,
        `Type: *${modesLib.modeType(participation).name}*`,
        `Privacy: *${privacy}*`,
        `Capacity: *${capacity}*`,
        '', `Key: \`${room.room_key}\``, '',
        `Others join with *${ctx.prefix}room join ${room.room_key}*`,
        `Start it with *${ctx.prefix}room start ${room.room_key}*`
      ].join('\n'))
    }

    const key = String(args[1] || '').trim()
    if (!key) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}room ${sub} <key>*`)
    const room = await store.room(key)
    if (!room) return axyon.send(s, ctx.jid, m, `\u274c No room with key \`${key}\`.`)

    /* A room belongs to its group. A key from elsewhere is not a way in. */
    if (String(room.group_jid) !== String(ctx.jid)) {
      return axyon.send(s, ctx.jid, m, '\u274c That room belongs to another group.')
    }

    if (sub === 'view') {
      const parts = Array.isArray(room.participants) ? room.participants : []
      return axyon.send(s, ctx.jid, m, [
        `${W}`, '', `\ud83c\udf9f\ufe0f *${room.name}*`, '',
        `Mode: *${modes.get(room.mode_id)?.name || room.mode_id}*`,
        `Type: *${room.participation}* \u2022 Privacy: *${room.privacy}*`,
        `Status: *${room.status}*`,
        `Players: *${parts.length}/${room.capacity}*`,
        parts.length ? `\n${parts.map(x => `\u2022 ${x.userId}${x.role === 'leader' ? ' \ud83d\udc51' : ''}`).join('\n')}` : '',
        room.result ? `\nResult: *${room.result}*` : ''
      ].filter(Boolean).join('\n'))
    }

    if (sub === 'join') {
      const check = modesLib.canJoin(room, ctx.userId)
      if (!check.ok) return axyon.send(s, ctx.jid, m, `\u274c ${check.message}`)
      const participants = modesLib.addParticipant(room, ctx.userId)
      const next = modesLib.isReady({ ...room, participants }) && room.status === 'waiting' ? 'ready' : room.status
      await store.updateRoom(room.room_key, { participants, status: next })
      await store.log(ctx.userId, 'room_join', room.room_key)
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *JOINED*\n\n*${room.name}*\nPlayers: *${participants.length}/${room.capacity}*${next === 'ready' ? '\n\n\ud83d\udfe2 Room is *READY*.' : ''}`)
    }

    if (sub === 'leave') {
      const participants = modesLib.removeParticipant(room, ctx.userId)
      if (participants.length === 0) {
        await store.updateRoom(room.room_key, { participants, status: 'cancelled', result: 'abandoned' })
        return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udc4b You left. The room was empty, so it is now *cancelled*.`)
      }
      await store.updateRoom(room.room_key, { participants })
      return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udc4b You left *${room.name}*. *${participants.length}* remain.`)
    }

    if (sub === 'start') {
      if (!modesLib.canManage(room, ctx.userId, ctx.auth)) {
        return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f Only the room leader or AXYON can start this room.')
      }
      if (!modesLib.canTransition(room.status, 'active')) {
        return axyon.send(s, ctx.jid, m, `\u274c A room that is *${room.status}* cannot be started.`)
      }
      if (!modesLib.isReady(room)) {
        const t = modesLib.modeType(room.participation)
        return axyon.send(s, ctx.jid, m, `\u274c Not enough players. *${room.participation}* needs at least *${t?.minPlayers || 1}*.`)
      }

      /*
       * A GUILD MODE OR THE CO-OP TRIAL ACTUALLY STARTS A RUN HERE.
       *
       * Without this the modes would be enterable but unplayable — the same
       * dead-code trap as a module nothing calls. The run is built from the
       * room's real participants and stored in the room's `state` column, so
       * it survives a restart and every member sees the same run.
       */
      const modeDef = modes.get(room.mode_id)
      const ruleId = modeDef && modeDef.rules
      if (ruleId) {
        const participants = Array.isArray(room.participants) ? room.participants : []
        const members = []
        for (const part of participants) {
          const pl = await store.player(part.userId)
          if (!pl) continue
          members.push({ userId: part.userId, name: pl.name || part.userId, hp: pl.hp, maxHp: pl.maxHp })
        }
        const run = guild.createRun({ modeId: ruleId, members })
        if (!run.ok) return axyon.send(s, ctx.jid, m, `\u274c ${run.message}`)

        await store.updateRoom(room.room_key, { status: 'active', state: run.state })
        await store.log(ctx.userId, 'room_start', room.room_key, { mode: room.mode_id, run: ruleId })
        return axyon.send(s, ctx.jid, m, [
          `${W}`, '', `\ud83d\udfe2 *${run.state.modeName.toUpperCase()} \u2014 STARTED*`, '',
          ...guild.runStatus(run.state), '',
          `Strike with *${ctx.prefix}room act <damage>*`
        ].join('\n'))
      }

      await store.updateRoom(room.room_key, { status: 'active' })
      await store.log(ctx.userId, 'room_start', room.room_key)
      return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udfe2 *ROOM ACTIVE*\n\n*${room.name}* is now in progress.`)
    }

    /*
     * `room act` — one strike in a guild-mode or co-op run.
     *
     * The damage is the player's own class damage, computed by the same
     * `classes.classDamage()` the rest of combat uses. The run decides what
     * that damage MEANS (shared pool, boss HP, pair knockout); this handler
     * only supplies the number and persists the result.
     */
    if (sub === 'act' || sub === 'strike') {
      const run = room.state && room.state.modeId ? room.state : null
      if (!run) return axyon.send(s, ctx.jid, m, `\u274c This room has no run in progress. Start it with *${ctx.prefix}room start ${room.room_key}*.`)
      if (run.done) return axyon.send(s, ctx.jid, m, `\u274c That run is already over.`)

      const p = await store.player(ctx.userId)
      if (!p) return axyon.send(s, ctx.jid, m, `\ud83c\udf00 Use *${ctx.prefix}arise* first.`)

      const classId = classes.normalizeClassId(p.class)
      const mastery = classId ? await store.classMastery(ctx.userId, classId) : 0
      const g = classes.classGradeFor(mastery)
      const moves = classId ? classes.movesForClass(classId) : []
      const move = moves.find(mv => Number(mv.damage) > 0) || null
      const dmg = move
        ? classes.classDamage({ move, mastery, gradeBonus: g.bonus }).final
        : Math.max(1, Math.round(Number(p.atk) || 5))

      const res = guild.strike(run, { userId: ctx.userId, damage: dmg })
      if (!res.ok) return axyon.send(s, ctx.jid, m, `\u274c ${res.message}`)

      await store.updateRoom(room.room_key, {
        state: res.state,
        status: res.done ? 'completed' : 'active',
        result: res.done ? (res.won ? 'won' : 'lost') : ''
      })

      const lines = [
        `${W}`, '', `\u2694\ufe0f *${res.state.modeName}*`, '',
        ...res.log, '',
        ...guild.runStatus(res.state)
      ]
      if (res.done) {
        lines.push('', res.won ? '\ud83c\udfc6 *VICTORY*' : '\ud83d\udc80 *DEFEAT*')
        if (res.won && Array.isArray(res.state.members)) {
          const split = guild.splitReward(res.state, 200)
          lines.push('', '*Rewards by contribution:*')
          for (const x of split) lines.push(`\u2022 ${x.name} \u2014 *${x.share}* Zen`)
        }
      }
      return axyon.send(s, ctx.jid, m, lines.join('\n'))
    }

    if (sub === 'close') {
      if (!modesLib.canManage(room, ctx.userId, ctx.auth)) {
        return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f Only the room leader or AXYON can close this room.')
      }
      const to = room.status === 'active' ? 'completed' : 'cancelled'
      if (!modesLib.canTransition(room.status, to)) {
        return axyon.send(s, ctx.jid, m, `\u274c A room that is *${room.status}* cannot be closed.`)
      }
      await store.updateRoom(room.room_key, { status: to, result: to })
      await store.log(ctx.userId, 'room_close', room.room_key, { to })
      return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83d\udd12 *ROOM ${to.toUpperCase()}*\n\n*${room.name}* is closed. The mode itself is untouched.`)
    }

    return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}room <create|list|join|leave|start|close|view>*`)
  })

  /*
   * CUSTOM ROOM TYPES
   * -----------------
   * The three built-in participation types are fixed. This lets AXYON define
   * their own — a raid, a tournament lobby — with their own capacity bounds,
   * so a large room does not have to pretend to be a party.
   *
   * The bounds are enforced in `modesLib.capacityFor()`, not here, so a custom
   * type cannot bypass the clamping that protects the built-in ones.
   */
  cmd('roomtype', 'dungeon', '{p}roomtype <list|add|del> ...', 'Define custom room types and their capacity.', async (s, m, ctx, args) => {
    if (ctx.auth !== 'owner') {
      return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f Only AXYON can manage room types.')
    }
    const sub = String(args[0] || 'list').toLowerCase()

    if (sub === 'list') {
      const rows = await store.roomTypes()
      const builtin = modesLib.MODE_TYPE_IDS.map(id => {
        const t = modesLib.modeType(id)
        return `\u2022 *${t.name}* \u2014 \`${id}\` \u2022 ${t.minPlayers}-${t.defaultMax} \u2022 built-in`
      })
      return axyon.send(s, ctx.jid, m, [
        `${W}`, '', '\ud83c\udf9f\ufe0f *ROOM TYPES*', '',
        ...builtin,
        ...(rows.length ? ['', '*Custom:*', ...rows.map(r => `\u2022 *${r.name}* \u2014 \`${r.type_id}\` \u2022 ${r.min_players}-${r.default_max} (max ${r.hard_max})`)] : ['', 'No custom types yet.']),
        '', `Add one with *${ctx.prefix}roomtype add <id> <Name> <min> <default> <max>*`
      ].join('\n'))
    }

    if (sub === 'add') {
      const id = String(args[1] || '').trim().toLowerCase()
      const name = args[2] || ''
      if (!id || !name) {
        return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}roomtype add <id> <Name> <min> <default> <max>*\nExample: *${ctx.prefix}roomtype add raid Raid 3 8 12*`)
      }
      const min = Number(args[3]) || 1
      const def = Number(args[4]) || 4
      const hard = Number(args[5]) || 50

      /* Register in memory first: it rejects a reserved id before we persist. */
      const reg = modesLib.registerRoomType({ id, name, minPlayers: min, defaultMax: def, hardMax: hard })
      if (!reg.ok) return axyon.send(s, ctx.jid, m, `\u274c ${reg.message}`)

      const saved = await store.upsertRoomType({ typeId: reg.type.id, name: reg.type.name, minPlayers: reg.type.minPlayers, defaultMax: reg.type.defaultMax, hardMax: reg.type.hardMax })
      if (!saved.ok) {
        modesLib.unregisterRoomType(reg.type.id)
        return axyon.send(s, ctx.jid, m, `\u274c ${saved.message}`)
      }
      await store.log(ctx.userId, 'roomtype_add', reg.type.id, { min, def, hard })
      return axyon.send(s, ctx.jid, m, [
        `${W}`, '', '\u2705 *ROOM TYPE ADDED*', '',
        `*${reg.type.name}* \u2014 \`${reg.type.id}\``,
        `Players: *${reg.type.minPlayers}* min \u2022 *${reg.type.defaultMax}* default \u2022 *${reg.type.hardMax}* max`,
        '', `Open one with *${ctx.prefix}room create <mode> ${reg.type.id}*`
      ].join('\n'))
    }

    if (sub === 'del') {
      const id = String(args[1] || '').trim().toLowerCase()
      if (!id) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}roomtype del <id>*`)
      if (modesLib.MODE_TYPE_IDS.includes(id)) {
        return axyon.send(s, ctx.jid, m, `\u274c *${id}* is a built-in type and cannot be removed.`)
      }
      const gone = await store.deleteRoomType(id)
      modesLib.unregisterRoomType(id)
      if (!gone) return axyon.send(s, ctx.jid, m, `\u274c No custom room type \`${id}\`.`)
      await store.log(ctx.userId, 'roomtype_del', id)
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *ROOM TYPE REMOVED*\n\n\`${id}\` is gone. Existing rooms keep their stored capacity.`)
    }

    return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}roomtype <list|add|del>*`)
  })

  /* ----------------------------------------------------------------- duels */

  cmd('duel', 'duel', '{p}duel @player | {p}duel accept <id>', 'Challenge a player, or answer a challenge.', async (s, m, ctx, args, content) => {
    const sub = String(args[0] || '').toLowerCase()
    if (['accept', 'decline'].includes(sub)) {
      const id = parseNum(args[1])
      if (!id) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}duel ${sub} <id>*`)
      return axyon.answerDuel(s, m, ctx, id, sub === 'accept')
    }
    const opponent = mentionedId(content) || norm(args[0] || '')
    return axyon.beginDuel(s, m, ctx, opponent || null)
  })

  /* ----------------------------------------------------------------- cards */

  cmd('cards', 'cards', '{p}cards [page]', 'Your full card collection and stats.', async (s, m, ctx, args) => axyon.cardPanel(s, m, ctx, parseNum(args[0]) || 1))
  cmd('card', 'cards', '{p}card <number|equip|unequip|slots|abilities|use|inventory>', 'Inspect, equip and use your collectible cards.', async (s, m, ctx, args) => {
    const sub = String(args[0] || '').toLowerCase()
    if (!sub) {
      const activeBattle = await store.getBattle(ctx.userId)
      if (activeBattle) return axyon.battleAct(s, m, ctx, 'card')
      return axyon.cardPanel(s, m, ctx, 1)
    }
    if (sub === 'inventory') return axyon.cardPanel(s, m, ctx, parseNum(args[1]) || 1)
    if (sub === 'slots') return axyon.cardSlots(s, m, ctx)
    if (sub === 'abilities') return axyon.cardAbilities(s, m, ctx)
    if (sub === 'equip') {
      const no = parseNum(args[1]); const slot = parseNum(args[2])
      if (!no) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}card equip <collection number> [equipment slot 1|2]*`)
      return axyon.equipCard(s, m, ctx, no, slot)
    }
    if (sub === 'unequip') {
      const slot = parseNum(args[1])
      if (![1, 2].includes(slot)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}card unequip 1|2*`)
      return axyon.unequipCard(s, m, ctx, slot)
    }
    if (sub === 'use') {
      const slot = parseNum(args[1])
      if (![1, 2].includes(slot)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}card use 1|2* (during battle)`)
      return axyon.battleAct(s, m, ctx, 'card', slot)
    }
    const no = parseNum(sub)
    if (no) return axyon.cardDetail(s, m, ctx, no)
    return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}card <number|equip|unequip|slots|abilities|use|inventory>*`)
  })
  cmd('claim', 'cards', '{p}claim card <number|#CODE>', 'Claim a granted card or a global spawned drop.', async (s, m, ctx, args) => {
    const target = String(args[1] ?? args[0] ?? '').trim()
    if (/^#?[A-Z0-9]{6}$/i.test(target)) {
      const studio = await store.claimStudioCard(ctx.userId, target).catch(() => null)
      if (studio?.ok) return axyon.send(s, ctx.jid, m, `🎴 *CARD CLAIMED*\n\n${studio.card.name} · Collection #${studio.slot}\nClaims: ${studio.claimed}/${studio.limit}`)
      if (studio && studio.reason !== 'not_found') {
        const messages = {not_registered:'Use !arise first.',claimed:'You have already claimed this card.',expired:'This card has expired.',limit:'All copies of this card have been claimed.'}
        return axyon.send(s, ctx.jid, m, `❌ ${messages[studio.reason] || 'This card cannot be claimed.'}`)
      }
      return axyon.claimDrop(s, m, ctx, target)
    }
    const collectionNo = parseNum(target)
    if (!collectionNo) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}claim card 1* or *${ctx.prefix}claim card #F9GGK0*`)
    return axyon.claimCard(s, m, ctx, collectionNo)
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
    return axyon.send(s, ctx.jid, m, [
      `${W}`, '', '\ud83d\udc9e *BINDING REQUEST*', '',
      `> *${a.name || ctx.userId}* \u2192 *${b.name || target}*`, '',
      `${b.name || target}, this requires your approval.`,
      `Request *#${r.request.id}*`, '',
      `Accept with *${ctx.prefix}accept ${r.request.id}* \u2022 decline with *${ctx.prefix}decline ${r.request.id}*`
    ].join('\n'))
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

  /* ----------------------------------------------------------------- media */

  cmd('play', 'media', '{p}play <song>', 'Search a song, show its cover and send the audio.', async (s, m, ctx, args) => axyon.play(s, m, ctx, args))

  /* ------------------------------------------------------------------ lore */

  cmd('story', 'media', '{p}story', 'A short piece of the tower\u2019s history.', async (s, m, ctx) => {
    /* Deterministic per player, so the anthology is walked rather than
     * sampled — the same hunter gets a new story each time until it wraps.
     * The counter is in memory: it is a reading position, not progress, and
     * it must not appear in anyone's inventory. */
    const n = storyReads.get(ctx.userId) || 0
    storyReads.set(ctx.userId, n + 1)
    if (storyReads.size > 5000) storyReads.clear()
    const entry = lore.story(`${ctx.userId}:${n}`)
    return axyon.send(s, ctx.jid, m, lore.storyCard(entry, ctx.prefix))
  })

  cmd('aura', 'media', '{p}aura', 'A line that reminds you who you are.', async (s, m, ctx) => {
    return axyon.send(s, ctx.jid, m, lore.auraCard(lore.aura()))
  })

  /* -------------------------------------------------------------- feedback */

  /**
   * `!feedback <message>` — talk to AXYON without an account.
   *
   * The message is stored against a thread derived from the chat, so a reply
   * can land in the same place, and nothing else about the sender is kept.
   */
  cmd('feedback', 'core', '{p}feedback <message>', 'Send AXYON a message. No account needed.', async (s, m, ctx, args) => {
    const text = args.join(' ').trim()
    if (!text) {
      return axyon.send(s, ctx.jid, m, [
        `${W}`, '', '\ud83d\udcac *FEEDBACK*', '',
        `Usage: ${T.b(`${ctx.prefix}feedback <message>`)}`,
        '',
        T.i('A bug, an idea, a complaint, a hello \u2014 all of it reaches AXYON.')
      ].join('\n'))
    }
    const dashAuth = require('./dash-auth')
    const thread = `wa-${String(ctx.jid).replace(/[^a-zA-Z0-9]/g, '').slice(-24)}`
    const r = await dashAuth.addFeedback(thread, text).catch(() => ({ ok: false }))
    if (!r.ok) return axyon.send(s, ctx.jid, m, `\u26a0\ufe0f Could not record that right now. Try again in a moment.`)
    return axyon.send(s, ctx.jid, m, [
      `${W}`, '', '\u2705 *MESSAGE RECEIVED*', '',
      T.i('AXYON has it. No account, no name, no trace.')
    ].join('\n'))
  })

  /* ------------------------------------------------------------------- ai */

  /**
   * Answers a question about the bot.
   *
   * The assistant is given the command CATALOGUE (name / usage / description)
   * and nothing else — no handlers, no store, no socket. It can describe a
   * command but has no path to run one.
   */
  async function answerAI (sock, m, ctx, question) {
    const q = String(question || '').trim()
    if (!q) return false
    if (!ai) return false

    const catalogue = axyon.COMMANDS.filter(c => !c.hidden).map(c => ({
      name: c.name, section: c.section, usage: c.usage, desc: c.desc, help: c.help
    }))

    /*
     * AUTHORITY-AWARE.
     * The asker's level decides the register of the reply: an AXYON owner is
     * answered as the operator, a member as a member. It is derived from the
     * same `ctx.auth` every command gate uses, so the assistant can never be
     * more permissive than the command layer.
     */
    const authority = ctx.auth?.axyon ? 'owner' : ctx.auth?.rhm ? 'rhm' : 'member'
    const threadKey = `${ctx.jid}:${ctx.userId}`
    const history = architectHistory.get(threadKey) || []
    const text = await ai.ask({ question: q, history, commands: catalogue, prefix: ctx.prefix, authority })
    if (text) {
      history.push({ role: 'user', content: q }, { role: 'assistant', content: text })
      architectHistory.set(threadKey, history.slice(-12))
      if (architectHistory.size > 500) architectHistory.delete(architectHistory.keys().next().value)
    }

    /*
     * NO ERRORS IN CHAT.
     * If every provider failed, say one short line. Never a stack trace, never
     * a provider name, never a retry loop that spams the group.
     */
    if (!text) {
      await axyon.send(sock, ctx.jid, m, 'I’m having a little trouble responding right now. Try again in a moment.')
      return true
    }

    await axyon.send(sock, ctx.jid, m, text)
    return true
  }

  cmd('ai', 'core', '{p}ai <question>', 'Ask the assistant about the bot. It explains, it cannot act.', async (s, m, ctx, args) => {
    const q = args.join(' ').trim()
    if (!q) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}ai how do I play a mode?*`)
    return answerAI(s, m, ctx, q)
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

  const GROUP_FEATURES = new Set([
    'general', 'combat', 'dungeon', 'casino', 'duel', 'cards', 'social', 'economy',
    'guild_slot_1', 'guild_slot_2', 'guild_slot_3', 'collab'
  ])
  const SECTION_FEATURE = {
    core: 'general', social: 'social', economy: 'economy', media: 'general', shop: 'economy',
    battle: 'combat', dungeon: 'dungeon', duel: 'duel', cards: 'cards'
  }
  function featureFor (command) {
    if (command.name === 'flooradmin') return 'dungeon'
    if (command.name === 'classadmin') return 'general'
    if (command.name === 'stage') return 'combat'
    if (['modes', 'roomtype'].includes(command.name)) return 'dungeon'
    if (['cardadmin', 'spawncard', 'grantcard'].includes(command.name)) return 'cards'
    if (command.name === 'carduse') return { all: ['cards'], any: ['combat', 'dungeon'] }
    if (['arise', 'help', 'ping', 'ai', 'profile'].includes(command.name)) return null
    // The same battle actions resolve both Combat stages and Dungeon floors.
    if (command.section === 'battle' && !['fight', 'stages'].includes(command.name)) return ['combat', 'dungeon']
    return SECTION_FEATURE[command.section] || null
  }
  const registrationHelp = `${W}\n\n*GROUP REGISTRATION*\n\n• \`!register group normal\` — Original gaming\n• \`!register group modes\` — Select features individually\n• \`!register group duel\` — Duel system only\n• \`!register view\` — Current group record\n• \`!register list\` — All registered groups (AXYON)\n• \`!register mode <normal|modes|duel>\` — Change mode (AXYON)`

  cmd('register', 'management', '{p}register <group normal|modes|duel|view|list|mode>', 'Register and inspect group access (AXYON only).', async (s, m, ctx, args) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, `${W}\n\n🛡️ *AXYON ONLY*\n\nOnly verified AXYON identities can manage group registration.`)
    const sub = String(args[0] || '').toLowerCase()
    if (sub === 'list') {
      const rows = await store.groups()
      return axyon.send(s, ctx.jid, m, [W, '', '⌬ *GROUP REGISTRY*', '', rows.length ? rows.map(g => `${g.status === 'ACTIVE' ? '✅' : '⛔'} *${g.name || 'Unnamed'}* — ${String(g.registration_mode || 'normal').toUpperCase()}\n   ${g.status} • ${g.registration_id || 'legacy'}\n   \`${g.group_jid}\``).join('\n\n') : 'No registered groups.'].join('\n'))
    }
    if (!ctx.jid.endsWith('@g.us')) return axyon.send(s, ctx.jid, m, '📍 Send this command inside the WhatsApp group you want to register.')
    const current = await store.group(ctx.jid)
    if (['view', 'status'].includes(sub)) return axyon.send(s, ctx.jid, m, groupRecordText(current, ctx.prefix))
    if (sub === 'mode') {
      const mode = String(args[1] || '').toLowerCase()
      if (!['normal', 'modes', 'duel'].includes(mode)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}register mode normal|modes|duel*`)
      if (!current || current.status === 'REMOVED') return axyon.send(s, ctx.jid, m, `This group is not registered. Use *${ctx.prefix}register group ${mode}*.`)
      const updated = await store.updateGroupMode(ctx.jid, mode)
      await store.log(ctx.userId, 'group_registration_mode', ctx.jid, { mode })
      return axyon.send(s, ctx.jid, m, `${W}\n\n✅ *REGISTRATION MODE UPDATED*\n\n${updated.name || ctx.jid}\nMode: *${mode.toUpperCase()}*\nFeatures: ${(updated.features || []).join(', ') || 'none enabled'}`)
    }
    if (sub !== 'group') return axyon.send(s, ctx.jid, m, registrationHelp)
    const mode = String(args[1] || '').toLowerCase()
    if (!['normal', 'modes', 'duel'].includes(mode)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}register group normal|modes|duel*`)
    let name = ''
    try { name = (await withTimeout(s.groupMetadata(ctx.jid), GROUP_META_TIMEOUT_MS))?.subject || '' } catch {}
    const g = await store.registerGroup(ctx.jid, name, ctx.userId, mode)
    await store.log(ctx.userId, 'register_group', ctx.jid, { name, mode, registrationId: g.registration_id })
    return axyon.send(s, ctx.jid, m, [W, '', '✅ *GROUP REGISTERED*', '', `Group: *${g.name || 'Unnamed'}*`, `Registration ID: \`${g.registration_id}\``, `Mode: *${mode.toUpperCase()}*`, `Features: ${(g.features || []).join(', ') || 'none enabled yet'}`, '', mode === 'modes' ? `Enable systems with *${ctx.prefix}group enable <feature>*.\nUse *${ctx.prefix}group features* to view available features.` : 'The group is now authorized for its registration mode.'].join('\n'))
  })

  function groupRecordText (g, prefix = '!') {
    if (!g || g.status === 'REMOVED') return `${W}\n\n⌬ *NO ACTIVE REGISTRATION*\n\nThis group is not registered.`
    return [W, '', '⌬ *GROUP REGISTRATION*', '', `Name: *${g.name || 'Unnamed'}*`, `JID: \`${g.group_jid}\``, `ID: \`${g.registration_id || 'legacy'}\``, `Mode: *${String(g.registration_mode || 'normal').toUpperCase()}*`, `Status: *${g.status || (g.enabled ? 'ACTIVE' : 'DISABLED')}*`, `Features: ${(g.features || []).join(', ') || 'none'}`, `Registered by: ${g.registered_by || 'unknown'}`, `Registered: ${g.registered_at || g.created_at || 'unknown'}`, g.suspension_reason ? `Reason: ${g.suspension_reason}` : null].filter(Boolean).join('\n')
  }

  cmd('group', 'management', '{p}group <info|enable|disable|suspend|reactivate|remove|features>', 'Manage this group registration (AXYON only).', async (s, m, ctx, args) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, `${W}\n\n🛡️ *AXYON ONLY*`)
    if (!ctx.jid.endsWith('@g.us')) return axyon.send(s, ctx.jid, m, '📍 Run group management inside the target WhatsApp group.')
    const sub = String(args[0] || 'info').toLowerCase()
    const g = await store.group(ctx.jid)
    if (sub === 'info' || sub === 'view') return axyon.send(s, ctx.jid, m, groupRecordText(g, ctx.prefix))
    if (!g || g.status === 'REMOVED') return axyon.send(s, ctx.jid, m, 'This group has no active registration.')
    if (sub === 'features') {
      const available = g.registration_mode === 'duel' ? ['duel'] : g.registration_mode === 'modes' ? [...GROUP_FEATURES] : [...store.GROUP_MODES.normal]
      return axyon.send(s, ctx.jid, m, [W, '', '*GROUP FEATURES*', '', `Enabled: ${(g.features || []).join(', ') || 'none'}`, `Available: ${available.join(', ')}`, '', `Enable: *${ctx.prefix}group enable <feature>*`, `Disable: *${ctx.prefix}group disable <feature>*`].join('\n'))
    }
    if (sub === 'enable' || sub === 'disable') {
      const feature = String(args[1] || '').toLowerCase()
      if (!feature) {
        if (sub === 'enable') {
          const updated = await store.updateGroupStatus(ctx.jid, 'ACTIVE')
          await store.log(ctx.userId, 'group_enable', ctx.jid)
          return axyon.send(s, ctx.jid, m, `✅ Group reactivated. Status: *${updated.status}*`)
        }
        const updated = await store.updateGroupStatus(ctx.jid, 'DISABLED')
        await store.log(ctx.userId, 'group_disable', ctx.jid)
        return axyon.send(s, ctx.jid, m, `⏸️ Group disabled. Status: *${updated.status}*`)
      }
      if (!GROUP_FEATURES.has(feature)) return axyon.send(s, ctx.jid, m, `Unknown feature. Available: ${[...GROUP_FEATURES].join(', ')}`)
      const allowedForMode = g.registration_mode === 'duel' ? new Set(['duel']) : g.registration_mode === 'modes' ? GROUP_FEATURES : new Set(store.GROUP_MODES.normal)
      if (!allowedForMode.has(feature)) return axyon.send(s, ctx.jid, m, `The *${feature}* feature is not available under ${String(g.registration_mode).toUpperCase()} registration.`)
      const features = new Set(g.features || [])
      if (sub === 'enable') features.add(feature); else features.delete(feature)
      const updated = await store.updateGroupFeatures(ctx.jid, [...features])
      await store.log(ctx.userId, `group_feature_${sub}`, ctx.jid, { feature })
      return axyon.send(s, ctx.jid, m, `✅ Feature *${feature}* ${sub}d.\nEnabled: ${(updated.features || []).join(', ') || 'none'}`)
    }
    if (sub === 'suspend') {
      const reason = args.slice(1).join(' ').trim()
      const updated = await store.updateGroupStatus(ctx.jid, 'SUSPENDED', reason)
      await store.log(ctx.userId, 'group_suspend', ctx.jid, { reason })
      return axyon.send(s, ctx.jid, m, `⛔ *GROUP SUSPENDED*\n\n${updated.name || ctx.jid}${reason ? `\nReason: ${reason}` : ''}`)
    }
    if (sub === 'reactivate') {
      const updated = await store.updateGroupStatus(ctx.jid, 'ACTIVE')
      await store.log(ctx.userId, 'group_reactivate', ctx.jid)
      return axyon.send(s, ctx.jid, m, `✅ *GROUP REACTIVATED*\n\n${updated.name || ctx.jid}`)
    }
    if (sub === 'remove') {
      const removed = await store.unregisterGroup(ctx.jid)
      await store.log(ctx.userId, 'group_remove', ctx.jid)
      return axyon.send(s, ctx.jid, m, removed ? '🗑️ Group removed from the active registry. Player accounts remain untouched.' : 'Group registration not found.')
    }
    return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}group info|enable|disable|suspend|reactivate|remove|features*`)
  })

  cmd('unregister', 'management', '{p}unregister', 'Remove this group from active registration (AXYON only).', async (s, m, ctx) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '🛡️ AXYON ONLY')
    if (!ctx.jid.endsWith('@g.us')) return axyon.send(s, ctx.jid, m, 'Run this inside a group.')
    await store.unregisterGroup(ctx.jid)
    await store.log(ctx.userId, 'unregister_group', ctx.jid)
    return axyon.send(s, ctx.jid, m, `${W}\n\n🛑 *GROUP REMOVED*\n\nPlayer accounts remain intact.`)
  })

  cmd('groups', 'management', '{p}groups', 'List registered groups (AXYON only).', async (s, m, ctx) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '🛡️ *AXYON ONLY*')
    const rows = await store.groups()
    if (!rows.length) return axyon.send(s, ctx.jid, m, `${W}\n\nNo groups registered.`)
    return axyon.send(s, ctx.jid, m, [W, '', '⌬ *GROUP REGISTRY*', '', rows.map(g => `${g.status === 'ACTIVE' ? '✅' : '⛔'} *${g.name || 'Unnamed'}* — ${String(g.registration_mode || 'normal').toUpperCase()}\n   ${g.status} • ${g.registration_id || 'legacy'}\n   \`${g.group_jid}\``).join('\n\n')].join('\n'))
  })

  /* -------------------------------------------------------- AXYON identity */


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

  /* ------------------------------------------------------ class management */

  /*
   * `!classadmin` — the AXYON-only class surface.
   *
   * Authorization is `ctx.auth.axyon`, which is the bot's existing trusted
   * identity check (original owner, OWNER_NUMBERS, or a number registered in
   * AXYON_NUMBERS). It is NOT derived from a display name or message text, as
   * the note requires.
   *
   * Every mutating subcommand writes an audit row through store.log with the
   * actor, the target and the before/after values.
   */
  cmd('classadmin', 'management', '{p}classadmin <list|info|set|mastery|reset|balance|moves> ...', 'Manage classes, mastery and balance (AXYON only).', async (s, m, ctx, args, content) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *AXYON ONLY*\n\nClass management is restricted to AXYON.')

    const sub = String(args[0] || 'list').toLowerCase()
    const P = ctx.prefix

    if (sub === 'list') {
      const rows = classes.ALL_CLASSES.map(c => {
        const ult = c.moves.find(mv => mv.ultimate)
        return `\u2022 *${c.name}* \u2014 ${c.moves.length} moves${ult ? ` \u2022 ult: ${ult.name}` : ''}${c.legacy ? ' \u2022 legacy' : ''}`
      })
      return axyon.send(s, ctx.jid, m, [
        W, '', '\ud83c\udfad *CLASS CATALOGUE*', '',
        `${classes.OFFICIAL_CLASSES.length} official \u2022 ${classes.LEGACY_CLASSES.length} legacy`, '',
        ...rows, '',
        `Inspect one with *${P}classadmin info <class>*.`
      ].join('\n'))
    }

    if (sub === 'info') {
      const name = args.slice(1).join(' ')
      const def = classes.classById(name)
      if (!def) return axyon.send(s, ctx.jid, m, `\u274c No class called *${name || '\u2014'}*. See *${P}classadmin list*.`)
      const lines = [
        W, '', `\ud83c\udfad *${def.name.toUpperCase()}*${def.legacy ? ' \u00b7 legacy' : ''}`,
        `_${def.specialization}_`, '',
        ...def.moves.map(mv => {
          const dmg = Number(mv.damage) > 0 ? `${mv.damage} dmg` : mv.type
          const cost = mv.cost != null ? ` \u2022 \u26a1${mv.cost}` : ' \u2022 \u26a1 pending'
          const unlock = mv.unlock != null ? ` \u2022 unlock ${mv.unlock}` : ' \u2022 unlock pending'
          return `\u2022 *${mv.name}* \u2014 ${dmg}${cost}${unlock}${mv.ultimate ? ' \u2022 ULTIMATE' : ''}`
        })
      ]
      return axyon.send(s, ctx.jid, m, lines.join('\n'))
    }

    if (sub === 'set') {
      const target = mentionedId(content) || norm(args[1] || '')
      if (!/^\d{8,15}$/.test(target || '')) return axyon.send(s, ctx.jid, m, `Usage: *${P}classadmin set @player <class>*`)
      const classArg = args.slice(2).join(' ')
      const def = classes.classById(classArg)
      if (!def) return axyon.send(s, ctx.jid, m, `\u274c No class called *${classArg || '\u2014'}*. See *${P}classadmin list*.`)

      const p = await store.player(target)
      if (!p) return axyon.send(s, ctx.jid, m, `\u274c +${target} has not arisen yet.`)

      const before = p.class
      p.class = def.id
      await store.savePlayer(p)
      await store.log(ctx.userId, 'class_set', target, { from: before, to: def.id })

      /*
       * Mastery is NOT transferred. The note is explicit: switching class must
       * not carry mastery across, and the old class's mastery is kept so it
       * resumes if the player switches back.
       */
      const kept = await store.classMastery(target, def.id)
      return axyon.send(s, ctx.jid, m, [
        W, '', '\u2705 *CLASS SET*', '',
        `+${target} \u2014 *${before || '\u2014'}* \u2192 *${def.name}*`,
        `Mastery in ${def.name}: *${kept.toLocaleString('en-US')}*`,
        '', '> Mastery is per class and is never transferred on a switch.'
      ].join('\n'))
    }

    if (sub === 'mastery') {
      const target = mentionedId(content) || norm(args[1] || '')
      if (!/^\d{8,15}$/.test(target || '')) return axyon.send(s, ctx.jid, m, `Usage: *${P}classadmin mastery @player <class> <value>*`)
      const classArg = args.slice(2, -1).join(' ')
      const value = parseNum(args[args.length - 1])
      const def = classes.classById(classArg)
      if (!def) return axyon.send(s, ctx.jid, m, `\u274c No class called *${classArg || '\u2014'}*.`)
      if (value == null || value < 0) return axyon.send(s, ctx.jid, m, `\u274c Mastery must be a number \u2265 0.`)

      const before = await store.classMastery(target, def.id)
      const after = await store.setClassMastery(target, def.id, value)
      const g = classes.classGradeFor(after)
      await store.log(ctx.userId, 'class_mastery_set', target, { classId: def.id, from: before, to: after })

      return axyon.send(s, ctx.jid, m, [
        W, '', '\u2705 *MASTERY SET*', '',
        `+${target} \u2022 *${def.name}*`,
        `${before.toLocaleString('en-US')} \u2192 *${after.toLocaleString('en-US')}*`,
        `Class grade: *${g.grade}* \u2022 bonus *+${g.bonus}*`
      ].join('\n'))
    }

    if (sub === 'reset') {
      const target = mentionedId(content) || norm(args[1] || '')
      if (!/^\d{8,15}$/.test(target || '')) return axyon.send(s, ctx.jid, m, `Usage: *${P}classadmin reset @player <class> confirm*`)
      const classArg = args.slice(2, -1).join(' ')
      const confirm = String(args[args.length - 1] || '').toLowerCase()
      const def = classes.classById(classArg)
      if (!def) return axyon.send(s, ctx.jid, m, `\u274c No class called *${classArg || '\u2014'}*.`)
      if (confirm !== 'confirm') {
        return axyon.send(s, ctx.jid, m, `\u26a0\ufe0f *CONFIRM REQUIRED*\n\nThis wipes +${target}'s *${def.name}* mastery.\n\nRepeat with:\n*${P}classadmin reset @player ${def.id} confirm*`)
      }
      const before = await store.classMastery(target, def.id)
      await store.setClassMastery(target, def.id, 0)
      await store.log(ctx.userId, 'class_mastery_reset', target, { classId: def.id, from: before, to: 0 })
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *MASTERY RESET*\n\n+${target} \u2022 *${def.name}*\n${before.toLocaleString('en-US')} \u2192 *0*\n\n> Logged to the audit trail.`)
    }

    if (sub === 'balance') {
      const key = String(args[1] || '').toLowerCase()
      const value = Number(args[2])
      if (!key) {
        const b = classes.BALANCE
        return axyon.send(s, ctx.jid, m, [
          W, '', '\u2696\ufe0f *CLASS BALANCE*', '',
          `cMinusScale \u2014 *${b.cMinusScale}*`,
          `maxScale \u2014 *${b.maxScale}*`,
          `ultimateTarget \u2014 *${b.ultimateTarget}*`,
          `masteryAward.classMove \u2014 *${b.masteryAward.classMove ?? 'pending'}*`,
          `masteryAward.battleWin \u2014 *${b.masteryAward.battleWin ?? 'pending'}*`,
          '', `Set with *${P}classadmin balance <key> <value>*.`,
          '> These are PENDING owner approval. Changing them is a live rebalance.'
        ].join('\n'))
      }
      if (!Number.isFinite(value)) return axyon.send(s, ctx.jid, m, `\u274c *${key}* needs a numeric value.`)
      const patch = {}
      if (key === 'cminusscale') patch.cMinusScale = value
      else if (key === 'maxscale') patch.maxScale = value
      else if (key === 'ultimatetarget') patch.ultimateTarget = value
      else if (key === 'masteryaward.classmove') patch.masteryAward = { classMove: value }
      else if (key === 'masteryaward.battlewin') patch.masteryAward = { battleWin: value }
      else return axyon.send(s, ctx.jid, m, `\u274c Unknown key *${key}*.`)
      const after = classes.setBalance(patch)
      await store.log(ctx.userId, 'class_balance_set', key, { value, after })
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *BALANCE UPDATED*\n\n*${key}* \u2192 *${value}*\n\n> In-memory only \u2014 resets on restart until approved and committed.`)
    }

    if (sub === 'moves') {
      const target = mentionedId(content) || norm(args[1] || '')
      if (!/^\d{8,15}$/.test(target || '')) return axyon.send(s, ctx.jid, m, `Usage: *${P}classadmin moves @player*`)
      const p = await store.player(target)
      if (!p) return axyon.send(s, ctx.jid, m, `\u274c +${target} has not arisen yet.`)
      const classId = classes.normalizeClassId(p.class)
      if (!classId) return axyon.send(s, ctx.jid, m, `\u274c +${target} has no valid class.`)
      const mastery = await store.classMastery(target, classId)
      const g = classes.classGradeFor(mastery)
      const used = await store.classMovesUsedToday(target)
      const moves = classes.movesForClass(classId)
      return axyon.send(s, ctx.jid, m, [
        W, '', `\ud83d\udc64 *+${target}* \u2014 ${p.name || 'unnamed'}`, '',
        `Class: *${classes.classById(classId).name}*`,
        `Mastery: *${mastery.toLocaleString('en-US')}* \u2022 Grade *${g.grade}* \u2022 Bonus *+${g.bonus}*`,
        `Class moves today: *${used}/${ctx.settings.classMovesPerDay}*`,
        `Power Energy: *${p.powerEnergy}/${p.maxPowerEnergy}*`, '',
        ...moves.map(mv => {
          const locked = mv.unlock != null && mastery < Number(mv.unlock)
          return `${locked ? '\ud83d\udd12' : '\u2705'} *${mv.name}* \u2014 ${Number(mv.damage) > 0 ? `${mv.damage} dmg` : mv.type}`
        })
      ].join('\n'))
    }

    /* ---------------------------------------------------- class CRUD */

    /*
     * CLASS AND MOVE CRUD
     * -------------------
     * The 20 official classes live in code and are never written to. These
     * subcommands manage the OPERATOR'S layer on top: new classes, overrides
     * of official ones, and their moves — all in the database, so a change
     * survives a restart and needs no redeploy.
     *
     * Deleting is a SOFT delete. A class that players are assigned to must not
     * vanish from under them, so the row is flagged and the players keep their
     * stored class value. The reply says how many players are affected.
     */

    if (sub === 'create') {
      const id = String(args[1] || '').trim().toLowerCase()
      const name = args.slice(2).join(' ').trim()
      if (!id || !name) {
        return axyon.send(s, ctx.jid, m, [
          `\ud83c\udfad *CREATE A CLASS*`, '',
          `*${P}classadmin create <id> <Name>*`, '',
          `Example: *${P}classadmin create voidwalker Void Walker*`,
          '', 'Then add moves with *' + P + 'classadmin addmove <id> <move id> <Name> [damage]*'
        ].join('\n'))
      }
      const res = await store.upsertClassDef({ classId: id, name, actor: ctx.userId })
      if (!res.ok) return axyon.send(s, ctx.jid, m, `\u274c ${res.message}`)
      await store.log(ctx.userId, 'class_create', res.def.class_id, { name })
      return axyon.send(s, ctx.jid, m, [
        W, '', '\u2705 *CLASS CREATED*', '',
        `*${res.def.name}* \u2014 id \`${res.def.class_id}\``,
        `Source: *${res.def.source}*`,
        '', `Add a move: *${P}classadmin addmove ${res.def.class_id} <move id> <Name> [damage]*`
      ].join('\n'))
    }

    if (sub === 'editclass') {
      const id = String(args[1] || '').trim().toLowerCase()
      const name = args.slice(2).join(' ').trim()
      if (!id || !name) return axyon.send(s, ctx.jid, m, `Usage: *${P}classadmin editclass <id> <New Name>*`)
      const res = await store.upsertClassDef({ classId: id, name, actor: ctx.userId })
      if (!res.ok) return axyon.send(s, ctx.jid, m, `\u274c ${res.message}`)
      await store.log(ctx.userId, 'class_edit', id, { name })
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *CLASS UPDATED*\n\n*${res.def.name}* \u2014 id \`${res.def.class_id}\``)
    }

    if (sub === 'delclass') {
      const id = String(args[1] || '').trim().toLowerCase()
      const confirm = String(args[2] || '').toLowerCase()
      if (!id) return axyon.send(s, ctx.jid, m, `Usage: *${P}classadmin delclass <id> confirm*`)
      if (confirm !== 'confirm') {
        return axyon.send(s, ctx.jid, m, `\u26a0\ufe0f *CONFIRM REQUIRED*\n\nThis removes the class definition *${id}*.\n\nRepeat with:\n*${P}classadmin delclass ${id} confirm*`)
      }
      const res = await store.deleteClassDef(id)
      if (!res.ok) return axyon.send(s, ctx.jid, m, `\u274c ${res.message}`)
      await store.log(ctx.userId, 'class_delete', id, { players: res.players })
      return axyon.send(s, ctx.jid, m, [
        W, '', '\u2705 *CLASS REMOVED*', '',
        `*${res.def.name}* is no longer offered.`,
        res.players ? `\u26a0\ufe0f *${res.players}* player(s) still hold it \u2014 their stored class was NOT changed.` : 'No players held it.',
        '', '> Soft delete: the row is kept so nothing is silently rewritten.'
      ].join('\n'))
    }

    if (sub === 'addmove' || sub === 'editmove') {
      const classId = String(args[1] || '').trim().toLowerCase()
      const moveId = String(args[2] || '').trim().toLowerCase()
      const name = args[3] || ''
      const damage = parseNum(args[4])
      if (!classId || !moveId || !name) {
        return axyon.send(s, ctx.jid, m, [
          `\ud83c\udfad *${sub === 'addmove' ? 'ADD' : 'EDIT'} A MOVE*`, '',
          `*${P}classadmin ${sub} <class id> <move id> <Name> [damage] [cost] [unlock]*`, '',
          `Example: *${P}classadmin addmove voidwalker void_rend Void Rend 18 10 5000*`
        ].join('\n'))
      }
      const res = await store.upsertClassMove({
        classId,
        moveId,
        name,
        damage,
        cost: parseNum(args[5]),
        unlock: parseNum(args[6])
      })
      if (!res.ok) return axyon.send(s, ctx.jid, m, `\u274c ${res.message}`)
      await store.log(ctx.userId, sub === 'addmove' ? 'class_move_add' : 'class_move_edit', `${classId}:${moveId}`, { name, damage })
      return axyon.send(s, ctx.jid, m, [
        W, '', `\u2705 *MOVE ${sub === 'addmove' ? 'ADDED' : 'UPDATED'}*`, '',
        `*${res.move.name}* \u2014 \`${res.move.class_id}:${res.move.move_id}\``,
        `Damage: *${res.move.damage ?? 'none'}* \u2022 Cost: *${res.move.cost ?? 'none'}* \u2022 Unlock: *${res.move.unlock ?? 'none'}*`
      ].join('\n'))
    }

    if (sub === 'delmove') {
      const classId = String(args[1] || '').trim().toLowerCase()
      const moveId = String(args[2] || '').trim().toLowerCase()
      if (!classId || !moveId) return axyon.send(s, ctx.jid, m, `Usage: *${P}classadmin delmove <class id> <move id>*`)
      const res = await store.deleteClassMove(classId, moveId)
      if (!res.ok) return axyon.send(s, ctx.jid, m, `\u274c ${res.message}`)
      await store.log(ctx.userId, 'class_move_delete', `${classId}:${moveId}`)
      return axyon.send(s, ctx.jid, m, `${W}\n\n\u2705 *MOVE REMOVED*\n\n*${res.move.name}* is no longer offered.\n\n> Soft delete \u2014 the row is kept.`)
    }

    if (sub === 'custom') {
      const defs = await store.classDefs()
      const moves = await store.classMoves()
      if (!defs.length) {
        return axyon.send(s, ctx.jid, m, [
          W, '', '\ud83c\udfad *CUSTOM CLASSES*', '',
          'None yet.', '',
          `Create one with *${P}classadmin create <id> <Name>*.`
        ].join('\n'))
      }
      return axyon.send(s, ctx.jid, m, [
        W, '', '\ud83c\udfad *CUSTOM CLASSES*', '',
        ...defs.map(d => {
          const own = moves.filter(mv => mv.class_id === d.class_id)
          return `\u2022 *${d.name}* \u2014 \`${d.class_id}\` \u2022 ${own.length} move(s) \u2022 ${d.source}${d.enabled ? '' : ' \u2022 DISABLED'}`
        }),
        '', `Add a move with *${P}classadmin addmove <class id> <move id> <Name> [damage]*`
      ].join('\n'))
    }

    return axyon.send(s, ctx.jid, m, [
      `\ud83c\udfad *CLASS ADMIN*`, '',
      `*${P}classadmin list* \u2014 every class`,
      `*${P}classadmin info <class>* \u2014 moves and costs`,
      `*${P}classadmin set @player <class>* \u2014 assign a class`,
      `*${P}classadmin mastery @player <class> <n>* \u2014 set mastery`,
      `*${P}classadmin reset @player <class> confirm* \u2014 wipe mastery`,
      `*${P}classadmin moves @player* \u2014 inspect a player`,
      `*${P}classadmin balance [key value]* \u2014 view or set balance`,
      '',
      `*${P}classadmin create <id> <Name>* \u2014 new class`,
      `*${P}classadmin editclass <id> <Name>* \u2014 rename a class`,
      `*${P}classadmin delclass <id> confirm* \u2014 remove a class`,
      `*${P}classadmin addmove <class> <move> <Name> [dmg] [cost] [unlock]*`,
      `*${P}classadmin delmove <class> <move>* \u2014 remove a move`,
      `*${P}classadmin custom* \u2014 list operator classes`
    ].join('\n'))
  })

  /* --------------------------------------------------------- guild registry */

  cmd('guild', 'social', '{p}guild <list|info|suggest|create|join|leave|members|group|ungroup|leader|disband|suggestions|approve|reject>', 'Create and join guilds, submit guild proposals, and link guilds to registered group chats.', async (s, m, ctx, args, content) => {
    const sub = String(args[0] || 'help').toLowerCase()
    const ownerOnly = ['create', 'group', 'ungroup', 'leader', 'disband', 'suggestions', 'approve', 'reject'].includes(sub)
    if (ownerOnly && !ctx.auth.owner) return axyon.send(s, ctx.jid, m, `${W}\n\n🛡️ *AXYON OWNER ONLY*\n\nOnly the bot owner can perform that guild-management action.`)

    if (sub === 'list' || sub === 'browse') {
      const rows = await store.guilds()
      if (!rows.length) return axyon.send(s, ctx.jid, m, `${W}\n\n⚔️ *GUILDS*\n\nNo guilds have been created yet.`)
      return axyon.send(s, ctx.jid, m, [W, '', '⚔️ *GUILD DIRECTORY*', '', ...rows.map(g => `*#${g.id} [${g.tag}]* ${g.name}\n   ${g.member_count} member(s)${g.group_jid ? ` · linked group` : ''}\n   ${g.description || 'No description set.'}`), '', `Join with *${ctx.prefix}guild join <id|tag>*`].join('\n'))
    }

    if (sub === 'suggest') {
      const raw = args.slice(1).join(' ')
      const [name, tag, description] = raw.split('|').map(x => String(x || '').trim())
      if (!name || !tag) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}guild suggest <name> | <tag> | <description>*`)
      const result = await store.suggestGuild({ suggestedBy: ctx.userId, name, tag, description })
      if (!result.ok) return axyon.send(s, ctx.jid, m, `❌ ${result.message}`)
      await store.log(ctx.userId, 'guild_suggest', String(result.suggestion.id), { name, tag })
      return axyon.send(s, ctx.jid, m, `${W}\n\n📨 *GUILD SUGGESTION SENT*\n\n*${name}* [${tag.toUpperCase()}]\nRequest: *#${result.suggestion.id}*\n\nThe owner will review it. Approval creates the guild and makes you its first leader.`)
    }

    if (sub === 'create') {
      const raw = args.slice(1).join(' ')
      const [name, tagInput, description] = raw.split('|').map(x => String(x || '').trim())
      if (!name) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}guild create <name> | <tag> | <description>*`)
      const tag = tagInput || name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8)
      const leaderId = mentionedId(content) || ctx.userId
      const result = await store.createGuild({ name, tag, description, leaderId, createdBy: ctx.userId })
      if (!result.ok) return axyon.send(s, ctx.jid, m, `❌ ${result.message}`)
      await store.log(ctx.userId, 'guild_create', String(result.guild.id), { name, tag, leaderId })
      return axyon.send(s, ctx.jid, m, `${W}\n\n✅ *GUILD CREATED*\n\n*${result.guild.name}* [${result.guild.tag}]\nID: *#${result.guild.id}*\nLeader appointed.\n\nPlayers can join with *${ctx.prefix}guild join ${result.guild.id}*`)
    }

    if (sub === 'join') {
      const target = await store.guild(args[1])
      if (!target) return axyon.send(s, ctx.jid, m, `❌ Guild not found. Use *${ctx.prefix}guild list*.`)
      if (target.group_jid && ctx.jid !== target.group_jid) return axyon.send(s, ctx.jid, m, `📍 This guild is linked to its registered group. Join from that group chat.`)
      const result = await store.joinGuild(target.id, ctx.userId)
      if (!result.ok) return axyon.send(s, ctx.jid, m, `❌ ${result.message}`)
      await store.log(ctx.userId, 'guild_join', String(target.id))
      return axyon.send(s, ctx.jid, m, `${W}\n\n⚔️ *GUILD JOINED*\n\nWelcome to *${target.name}* [${target.tag}].`)
    }

    if (sub === 'leave') {
      const result = await store.leaveGuild(ctx.userId)
      if (!result.ok) return axyon.send(s, ctx.jid, m, `❌ ${result.message}`)
      await store.log(ctx.userId, 'guild_leave', String(result.guild.id))
      return axyon.send(s, ctx.jid, m, `${W}\n\n👋 You left *${result.guild.name}* [${result.guild.tag}].`)
    }

    if (sub === 'info' || sub === 'view') {
      const target = args[1] ? await store.guild(args[1]) : await store.guildForUser(ctx.userId)
      if (!target) return axyon.send(s, ctx.jid, m, `You are not in a guild. Use *${ctx.prefix}guild list* or *${ctx.prefix}guild suggest ...*.`)
      const members = await store.guildMembers(target.id)
      return axyon.send(s, ctx.jid, m, [W, '', `⚔️ *${target.name}* [${target.tag}]`, '', `ID: *#${target.id}*`, `Leader: *${members.find(x => x.role === 'leader')?.name || 'Unknown hunter'}*`, `Members: *${members.length}*`, `Linked group: ${target.group_jid ? 'configured' : 'not set'}`, target.description || 'No description set.', '', `Use *${ctx.prefix}guild members ${target.id}* to view the roster.`].join('\n'))
    }

    if (sub === 'members') {
      const target = args[1] ? await store.guild(args[1]) : await store.guildForUser(ctx.userId)
      if (!target) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}guild members <id|tag>*`)
      const members = await store.guildMembers(target.id)
      return axyon.send(s, ctx.jid, m, [W, '', `👥 *${target.name} — MEMBERS*`, '', ...members.map((x, i) => `${i + 1}. ${x.role === 'leader' ? '👑 ' : ''}*${x.name || `Hunter ${i + 1}`}* · ${x.rank || 'E'} / Lv.${x.level || 1}`)].join('\n'))
    }

    if (sub === 'group') {
      const id = args[1]
      if (!ctx.jid.endsWith('@g.us')) return axyon.send(s, ctx.jid, m, `Run *${ctx.prefix}guild group <id|tag>* inside the WhatsApp group you want to link.`)
      const registered = await store.group(ctx.jid)
      if (!registered || registered.status !== 'ACTIVE') return axyon.send(s, ctx.jid, m, '❌ Register this WhatsApp group with AXYON before linking a guild.')
      const target = await store.guild(id)
      if (!target) return axyon.send(s, ctx.jid, m, '❌ Guild not found.')
      const result = await store.bindGuildGroup(target.id, ctx.jid)
      if (!result.ok) return axyon.send(s, ctx.jid, m, `❌ ${result.message}`)
      await store.log(ctx.userId, 'guild_group_bind', String(target.id), { groupJid: ctx.jid })
      return axyon.send(s, ctx.jid, m, `${W}\n\n🔗 *GUILD LINKED*\n\n*${target.name}* [${target.tag}] is now linked to this group.`)
    }

    if (sub === 'ungroup') {
      const target = await store.guild(args[1])
      if (!target) return axyon.send(s, ctx.jid, m, '❌ Guild not found.')
      const result = await store.unbindGuildGroup(target.id)
      if (!result) return axyon.send(s, ctx.jid, m, '❌ Guild not found.')
      await store.log(ctx.userId, 'guild_group_unbind', String(target.id))
      return axyon.send(s, ctx.jid, m, `🔓 *${target.name}* is no longer linked to a WhatsApp group.`)
    }

    if (sub === 'leader') {
      const target = await store.guild(args[1])
      const leaderId = mentionedId(content)
      if (!target || !leaderId) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}guild leader <id|tag> @member*`)
      const result = await store.transferGuildLeader(target.id, leaderId)
      if (!result.ok) return axyon.send(s, ctx.jid, m, `❌ ${result.message}`)
      await store.log(ctx.userId, 'guild_leader_transfer', String(target.id), { leaderId })
      return axyon.send(s, ctx.jid, m, `👑 Leadership of *${target.name}* has been transferred.`)
    }

    if (sub === 'disband') {
      const target = await store.guild(args[1])
      if (!target) return axyon.send(s, ctx.jid, m, '❌ Guild not found.')
      const result = await store.disbandGuild(target.id)
      if (!result) return axyon.send(s, ctx.jid, m, '❌ Guild is already inactive.')
      await store.log(ctx.userId, 'guild_disband', String(target.id))
      return axyon.send(s, ctx.jid, m, `🛑 *${target.name}* has been disbanded. Its members are free to join another guild.`)
    }

    if (sub === 'suggestions') {
      const rows = await store.guildSuggestions()
      return axyon.send(s, ctx.jid, m, [W, '', '📨 *PENDING GUILD SUGGESTIONS*', '', rows.length ? rows.map(x => `*#${x.id}* ${x.name} [${x.tag}]\n   By: ${x.suggested_by}\n   ${x.description || 'No description.'}`).join('\n\n') : 'No pending suggestions.', '', `Approve: *${ctx.prefix}guild approve <id>*`, `Reject: *${ctx.prefix}guild reject <id>*`].join('\n'))
    }

    if (sub === 'approve' || sub === 'reject') {
      const id = parseNum(args[1])
      if (!id) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}guild ${sub} <suggestion id>*`)
      const result = await store.resolveGuildSuggestion(id, ctx.userId, sub === 'approve')
      if (!result.ok) return axyon.send(s, ctx.jid, m, `❌ ${result.message}`)
      await store.log(ctx.userId, `guild_suggestion_${sub}`, String(id), { guildId: result.guild?.id || null })
      return axyon.send(s, ctx.jid, m, sub === 'approve'
        ? `${W}\n\n✅ *SUGGESTION APPROVED*\n\n*${result.guild.name}* [${result.guild.tag}] created. The suggester is its first leader.`
        : `${W}\n\n🗑️ *SUGGESTION REJECTED*\n\nRequest *#${id}* was declined.`)
    }

    const own = await store.guildForUser(ctx.userId)
    const line = '━━━━━━━━━━━━━━━━━━━━'
    const help = [
      W, '', '⚔️ *GUILD NETWORK*',
      '┌──────────────────────',
      own ? `│  🏰 *${own.name}*  ·  [${own.tag}]` : '│  ◇ *NO GUILD AFFILIATION*',
      own ? `│  ${own.member_role === 'leader' ? 'Guild Leader' : 'Guild Member'} · ${own.member_count || 1} member(s)` : '│  Your place in the network is open.',
      '└──────────────────────', '',
      '*⌬  EXPLORE THE NETWORK*',
      `  ◈  *${ctx.prefix}guild list*`, '      Browse active guilds',
      `  ◈  *${ctx.prefix}guild info <id|tag>*`, '      View a guild profile',
      `  ◈  *${ctx.prefix}guild members <id|tag>*`, '      Meet its members', '',
      line, '', '*⚔️  MEMBERSHIP*',
      `  ⟡  *${ctx.prefix}guild suggest <name> | <tag> | <description>*`,
      '      Propose a new guild for review',
      `  ⟡  *${ctx.prefix}guild join <id|tag>*`, '      Join an open guild',
      `  ⟡  *${ctx.prefix}guild leave*`, '      Leave your current guild', '',
      line, '', '*♛  NETWORK ADMINISTRATION*',
      `  • *${ctx.prefix}guild create <name> | <tag> | <description>*`,
      `  • *${ctx.prefix}guild group <id|tag>*  ·  ${ctx.prefix}guild ungroup <id|tag>`,
      `  • *${ctx.prefix}guild leader <id|tag> @member*`,
      `  • *${ctx.prefix}guild disband <id|tag>*`,
      `  • *${ctx.prefix}guild suggestions*`,
      `  • *${ctx.prefix}guild approve <id>*  ·  ${ctx.prefix}guild reject <id>*`,
      T.i('Administration commands are reserved for AXYON.'), '',
      '└─ *Find your people. Build your banner.*'
    ].join('\n')
    return axyon.send(s, ctx.jid, m, help)
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

  cmd('spawncard', 'management', '{p}spawncard', 'Generate and globally release a collectible card (AXYON owner only).', async (s, m, ctx) => {
    if (!ctx.auth.owner) return axyon.send(s, ctx.jid, m, '🛡️ *AXYON OWNER ONLY*')
    const result = await cardSpawner.createAndBroadcast(s, { announceJid: ctx.jid, quoted: m, manual: true })
    if (!result.ok) return axyon.send(s, ctx.jid, m, `⚠️ Card spawn failed: ${result.reason}`)
    return axyon.send(s, ctx.jid, m, `✅ *CARD DROP RELEASED*\n\nCharacter: *${result.card.name}*\nClaim code: *#${result.code}*\nBroadcast: *${result.sent}/${result.total}* chats\nRenderer: *${result.renderer}*`)
  })

  cmd('grantcard', 'management', '{p}grantcard @player <name>', 'Grant a card to a player (AXYON).', async (s, m, ctx, args, content) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '\ud83d\udee1\ufe0f *AXYON ONLY*')
    const target = mentionedId(content) || norm(args[0] || '')
    if (!/^\d{8,15}$/.test(target || '')) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}grantcard @player <name>*`)
    const name = args.slice(1).join(' ').trim()
    if (!name) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}grantcard @player <name>*`)
    const c = await store.addCard(target, {
      name, cardType: 'character', weapon: 'Summoned Blade', damage: 24, ability: 'System Burst', abilityDamage: 18, rating: 3
    })
    const slot = c.slot
    await store.log(ctx.userId, 'grant_card', target, { name, slot })
    return axyon.send(s, ctx.jid, m, `${W}\n\n\ud83c\udccf *CARD GRANTED*\n\nTarget: *${target}*\nSlot: *${slot}*\nCard: *${c.name}*\n\nThey claim it with *${ctx.prefix}claim card ${slot}*`)
  })

  cmd('cardadmin', 'management', '{p}cardadmin <create|edit|art|delete|inspect|drops|cancel>', 'Manage the collectible card system (AXYON only).', async (s, m, ctx, args, content) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, '🛡️ *AXYON AUTHORITY REQUIRED*')
    const sub = String(args[0] || '').toLowerCase()
    const target = mentionedId(content) || norm(args[1] || '')
    const raw = String(content?.conversation || content?.extendedTextMessage?.text || '')
    const baseUsage = `*${ctx.prefix}cardadmin create @player <character|weapon> | Name | Series | BaseDamage | Ability | AbilityDamage | Rating | ExpiryDays | ImageURL(optional)*`

    if (sub === 'create' || sub === 'give') {
      const head = raw.replace(new RegExp(`^${ctx.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}cardadmin\\s+(?:create|give)\\s+`, 'i'), '')
      const segments = head.split('|').map(x => x.trim())
      const firstWords = String(segments[0] || '').split(/\s+/).filter(Boolean)
      const type = String(firstWords.pop() || '').toLowerCase()
      const player = target || String(firstWords.pop() || '').replace(/\D/g, '')
      if (!/^\d{8,15}$/.test(player) || !['character', 'weapon'].includes(type) || segments.length < 7) {
        return axyon.send(s, ctx.jid, m, `Usage: ${baseUsage}`)
      }
      const [name, series, damage, ability, abilityDamage, rating, expiryDays, imageUrl] = segments.slice(1)
      if (!name || !Number.isFinite(Number(damage)) || !Number.isFinite(Number(abilityDamage)) || !Number.isFinite(Number(rating))) {
        return axyon.send(s, ctx.jid, m, `Name, damage, ability damage and rating are required.\n${baseUsage}`)
      }
      const expiresAt = Number(expiryDays) > 0 ? new Date(Date.now() + Math.min(3650, Number(expiryDays)) * 86400000).toISOString() : null
      const result = await cardSpawner.createPlayerCard(player, {
        name, series, cardType: type, damage: Number(damage), ability,
        abilityDamage: Number(abilityDamage), rating: Number(rating), expiresAt, imageUrl: imageUrl || ''
      })
      await store.log(ctx.userId, 'cardadmin_create', player, { card: result.card.name, collectionNo: result.card.slot, cardType: type })
      return s.sendMessage(ctx.jid, { image: result.rendered.buffer, caption: `${W}\n\n✅ *CARD CREATED & GRANTED*\nTarget: *${player}*\nCollection: *#${result.card.slot}*\nCard: *${result.card.name}*\nArtwork: *${result.artwork.source}*${result.artwork.sourceArtist ? ` · ${result.artwork.sourceArtist}` : ''}\nSource: ${result.artwork.sourceUrl || 'not provided'}` }, { quoted: m })
    }

    if (['edit', 'art', 'delete', 'remove', 'inspect'].includes(sub)) {
      if (!/^\d{8,15}$/.test(target || '')) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}cardadmin ${sub} @player <collection number> ...*`)
      const collectionNo = parseNum(args[2])
      if (!collectionNo) return axyon.send(s, ctx.jid, m, `A valid collection number is required.`)
      if (sub === 'inspect') {
        const rows = await store.cards(target)
        const c = rows.find(row => Number(row.slot) === collectionNo)
        if (!c) return axyon.send(s, ctx.jid, m, 'That player has no card with that collection number.')
        const today = new Date().toISOString().slice(0, 10)
        const todayUses = c.ability_day === today ? Number(c.ability_uses || 0) : 0
        return axyon.send(s, ctx.jid, m, `${W}\n\n*${c.name}* (#${c.slot})\nOwner: ${target}\nType: ${c.card_type}\nSeries: ${c.series || '—'}\nClaimed: ${c.claimed}\nEquipped: ${c.equipped_slot || 'no'}\nDamage: ${c.damage}\nAbility: ${c.ability} (${c.ability_damage})\nUses: ${todayUses}/3 today\nRating: ${c.rating}/6\nExpiry: ${c.expires_at || 'permanent'}\nArtist/source: ${c.source_artist || 'unknown'} · ${c.source_url || 'none'}`)
      }
      if (sub === 'delete' || sub === 'remove') {
        const removed = await store.removeCard(target, collectionNo)
        if (!removed) return axyon.send(s, ctx.jid, m, 'That card was not found.')
        await store.log(ctx.userId, 'cardadmin_delete', target, { collectionNo, name: removed.name })
        return axyon.send(s, ctx.jid, m, `✅ Removed *${removed.name}* from ${target}'s collection.`)
      }
      if (sub === 'art') {
        const imageUrl = args.slice(3).join(' ').trim()
        if (!/^https:\/\//i.test(imageUrl)) return axyon.send(s, ctx.jid, m, `Supply a direct HTTPS image URL. Usage: *${ctx.prefix}cardadmin art @player ${collectionNo} https://...jpg*`)
        const existing = await store.card(target, collectionNo)
        if (!existing) return axyon.send(s, ctx.jid, m, 'That card was not found.')
        const rendered = await cardSpawner.renderUpdatedArtwork(existing, imageUrl)
        const updated = await store.editCard(target, collectionNo, { imageUrl: rendered.art.fileUrl || imageUrl, imageData: rendered.rendered.buffer, sourceUrl: rendered.art.sourceUrl || imageUrl, sourceArtist: rendered.art.sourceArtist || '', renderer: 'old-gen' })
        await store.log(ctx.userId, 'cardadmin_art', target, { collectionNo, name: existing.name })
        return s.sendMessage(ctx.jid, { image: rendered.rendered.buffer, caption: `✅ Artwork refreshed for *${updated.name}*.\nSource: ${rendered.art.sourceUrl || imageUrl}` }, { quoted: m })
      }
      const field = String(args[3] || '').toLowerCase()
      const value = args.slice(4).join(' ').trim()
      const fields = {
        name: { name: value }, series: { series: value }, type: { cardType: value.toLowerCase() }, damage: { damage: Math.min(999999, Math.max(0, Number(value) || 0)) },
        ability: { ability: value }, abilitydamage: { abilityDamage: Math.min(999999, Math.max(0, Number(value) || 0)) },
        rating: { rating: Math.max(1, Math.min(6, Number(value) || 1)) },
        expiry: { expiresAt: Number(value) > 0 ? new Date(Date.now() + Math.min(3650, Number(value)) * 86400000).toISOString() : null },
        weapon: { weapon: value }
      }
      const patch = fields[field]
      if (field === 'type' && !['character', 'weapon'].includes(String(value).toLowerCase())) return axyon.send(s, ctx.jid, m, 'Card type must be character or weapon.')
      if (!patch || (!value && field !== 'expiry')) return axyon.send(s, ctx.jid, m, `Editable fields: name, series, type, weapon, damage, ability, abilitydamage, rating, expiry.`)
      const updated = await store.editCard(target, collectionNo, patch)
      if (!updated) return axyon.send(s, ctx.jid, m, 'That card was not found.')
      await store.log(ctx.userId, 'cardadmin_edit', target, { collectionNo, field, value })
      if (updated.image_data && ['name', 'series', 'type', 'damage', 'ability', 'abilitydamage', 'rating', 'expiry', 'weapon'].includes(field)) {
        const imageUrl = updated.image_url
        if (imageUrl) {
          try {
            const rendered = await cardSpawner.renderUpdatedArtwork(updated, imageUrl)
            const saved = await store.editCard(target, collectionNo, { imageData: rendered.rendered.buffer, renderer: 'old-gen' })
            return s.sendMessage(ctx.jid, { image: rendered.rendered.buffer, caption: `✅ Updated *${saved.name}* (${field}).` }, { quoted: m })
          } catch (error) { return axyon.send(s, ctx.jid, m, `Card data updated, but re-render failed: ${error.message}`) }
        }
      }
      return axyon.send(s, ctx.jid, m, `✅ Updated *${updated.name}* · ${field}.`)
    }

    if (sub === 'drops') {
      const drops = await store.cardDrops()
      const rows = drops.length ? drops.map(d => `#${d.claim_code} · ${d.name} · ${d.claimed_by ? `claimed by ${d.claimed_by}` : 'available'}`).join('\n') : 'No drops in history.'
      return axyon.send(s, ctx.jid, m, `${W}\n\n*CARD DROP HISTORY*\n\n${rows}`)
    }
    if (sub === 'cancel') {
      const code = String(args[1] || '').replace(/^#/, '').toUpperCase()
      if (!code) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}cardadmin cancel #CODE*`)
      const removed = await store.removeCardDrop(code)
      return axyon.send(s, ctx.jid, m, removed ? `✅ Unclaimed drop *#${code}* cancelled.` : `No unclaimed drop *#${code}* was found.`)
    }
    return axyon.send(s, ctx.jid, m, `${W}\n\n*CARD ADMIN*\n\n${baseUsage}\n*${ctx.prefix}cardadmin edit @player 1 damage 120*\n*${ctx.prefix}cardadmin art @player 1 https://...jpg*\n*${ctx.prefix}cardadmin delete @player 1*\n*${ctx.prefix}cardadmin inspect @player 1*\n*${ctx.prefix}cardadmin drops*\n*${ctx.prefix}cardadmin cancel #CODE*`)
  })

  /* ------------------------------------------------------- shop & inventory */

  /* Shop and inventory are ordinary group features, routed through Economy. */

  cmd('shop', 'shop', '{p}shop [items|abilities]', 'Browse the shop. Works in every mode.', async (s, m, ctx, args) => {
    const filter = String(args[0] || '').toLowerCase()
    const rows = filter === 'items' ? items.items()
      : filter === 'abilities' ? items.abilities()
        : items.catalogue()
    const p = await store.player(ctx.userId)
    const lines = rows.map(x => [
      `${x.icon} ${T.b(x.name)} \u2014 ${T.m(fmt(x.price))} Zen`,
      `   ${T.i(x.desc)}`,
      `   ${T.m(`${ctx.prefix}buy ${x.key}`)}`
    ].join('\n'))
    return axyon.send(s, ctx.jid, m, [
      T.header({ creators: greetings.creatorsOf(ctx.settings) }),
      '',
      `\ud83d\uded2 ${T.b('SHOP')}`,
      '',
      T.rule('', 'thin'),
      '',
      lines.join('\n\n'),
      '',
      T.rule('', 'hair'),
      `Your Zen: ${T.b(fmt(p?.zen || 0))} \u2022 ${T.b(`${ctx.prefix}inventory`)} to see what you hold`,
      T.i('The shop works in every mode.')
    ].join('\n'))
  })

  cmd('buy', 'shop', '{p}buy <item>', 'Buy an item or ability with Zen. Works in every mode.', async (s, m, ctx, args) => {
    const key = String(args[0] || '').toLowerCase()
    const entry = items.get(key)
    if (!entry) {
      return axyon.send(s, ctx.jid, m, [
        `\u274c No item called *${key || '(nothing)'}*.`,
        '',
        `See ${T.b(`${ctx.prefix}shop`)} for the catalogue.`
      ].join('\n'))
    }
    const p = await store.player(ctx.userId)
    if (!p) return axyon.send(s, ctx.jid, m, `\ud83c\udf00 Use *${ctx.prefix}arise* first.`)

    /* An ability is bought once. Buying it twice would silently burn Zen. */
    if (entry.kind === 'ability' && await store.inventoryQty(ctx.userId, entry.key) > 0) {
      return axyon.send(s, ctx.jid, m, `\u2705 You already own *${entry.name}*.`)
    }
    if (p.zen < entry.price) {
      return axyon.send(s, ctx.jid, m, [
        `\u274c *NOT ENOUGH ZEN*`,
        '',
        `*${entry.name}* costs ${T.b(fmt(entry.price))} Zen.`,
        `You hold ${T.b(fmt(p.zen))} \u2014 you need ${T.b(fmt(entry.price - p.zen))} more.`
      ].join('\n'))
    }

    p.zen -= entry.price
    await store.savePlayer(p)
    const qty = await store.addItem(ctx.userId, entry.key, 1)
    await store.log(ctx.userId, 'shop_buy', entry.key, { price: entry.price, qty })

    return axyon.send(s, ctx.jid, m, [
      T.header({ creators: greetings.creatorsOf(ctx.settings) }),
      '',
      `\u2705 ${T.b('PURCHASED')}`,
      '',
      `${entry.icon} ${T.b(entry.name)}`,
      `${T.i(entry.desc)}`,
      '',
      T.rule('', 'hair'),
      `Paid ${T.b(fmt(entry.price))} Zen \u2022 Zen left ${T.b(fmt(p.zen))}`,
      `You now hold ${T.b(qty)}.`,
      '',
      `Use it with ${T.b(`${ctx.prefix}use ${entry.key}`)}`
    ].join('\n'))
  })

  cmd('inventory', 'shop', '{p}inventory', 'Everything you hold. Works in every mode.', async (s, m, ctx) => {
    const rows = await store.inventory(ctx.userId)
    if (!rows.length) {
      return axyon.send(s, ctx.jid, m, [
        T.header({ creators: greetings.creatorsOf(ctx.settings) }),
        '',
        `\ud83c\udf92 ${T.b('INVENTORY')}`,
        '',
        'Your bag is empty.',
        '',
        `Buy something with ${T.b(`${ctx.prefix}shop`)}.`
      ].join('\n'))
    }
    const lines = rows.map(r => {
      const e = items.get(r.key)
      if (!e) return `\u2022 ${T.m(r.key)} \u00d7 ${T.m(r.qty)}`
      return [
        `${e.icon} ${T.b(e.name)} \u00d7 ${T.m(r.qty)}`,
        `   ${T.i(e.desc)}`,
        `   ${T.m(`${ctx.prefix}use ${e.key}`)}`
      ].join('\n')
    })
    return axyon.send(s, ctx.jid, m, [
      T.header({ creators: greetings.creatorsOf(ctx.settings) }),
      '',
      `\ud83c\udf92 ${T.b('INVENTORY')}`,
      '',
      T.rule('', 'thin'),
      '',
      lines.join('\n\n'),
      '',
      T.rule('', 'hair'),
      T.i('Usable in every mode.')
    ].join('\n'))
  })

  cmd('use', 'shop', '{p}use <item>', 'Use an item or ability. Works in every mode.', async (s, m, ctx, args) => {
    const key = String(args[0] || '').toLowerCase()
    const entry = items.get(key)
    if (!entry) return axyon.send(s, ctx.jid, m, `\u274c No item called *${key || '(nothing)'}*. See *${ctx.prefix}inventory*.`)

    const qty = await store.inventoryQty(ctx.userId, entry.key)
    if (qty <= 0) return axyon.send(s, ctx.jid, m, `\u274c You do not hold *${entry.name}*.`)

    const p = await store.player(ctx.userId)
    if (!p) return axyon.send(s, ctx.jid, m, `\ud83c\udf00 Use *${ctx.prefix}arise* first.`)
    const battle = await store.getBattle(ctx.userId)

    const r = items.apply(entry, battle, p)
    if (!r.ok) return axyon.send(s, ctx.jid, m, `\u274c ${r.note}`)

    /* Abilities are permanent: they are never consumed. */
    if (entry.kind === 'item') await store.consumeItem(ctx.userId, entry.key)

    if (r.battle) {
      /* In a battle the effect lands on the battle state, and the enemy still
       * gets its turn — using an item is an action, not a free move. */
      const hit = Math.max(1, Math.round(r.battle.enemy.atk + Math.floor(Math.random() * 6) - p.def * 0.3))
      r.battle.playerHp -= hit
      r.battle.turn += 1
      if (r.battle.playerHp <= 0) {
        await store.setBattle(ctx.userId, null)
        p.losses += 1
        p.hp = Math.max(1, Math.round(p.maxHp * 0.25))
        await store.savePlayer(p)
        await store.log(ctx.userId, 'item_use', entry.key, { died: true })
        return axyon.send(s, ctx.jid, m, [
          `${W}`, '', '\ud83d\udc80 *DEFEAT*', '',
          `${entry.icon} ${T.b(entry.name)} was not enough.`,
          `*${r.battle.enemy.name}* answers for *${hit}*.`
        ].join('\n'))
      }
      r.battle.equippedCards = await store.equippedCards(ctx.userId)
      await store.setBattle(ctx.userId, r.battle)
      await store.log(ctx.userId, 'item_use', entry.key, { inBattle: true })
      return axyon.withVisual(s, ctx.jid, m, r.battle.enemy.boss ? 'boss' : 'battle',
        axyon.battleCard(r.battle, p, `${entry.icon} ${T.b(entry.name)}\n${r.note}\n\ud83d\udc79 ${r.battle.enemy.name} answers for *${hit}*.`),
        axyon.battleButtons(), true)
    }

    /* Outside a battle the effect lands on the player row. */
    await store.savePlayer(r.player)
    await store.log(ctx.userId, 'item_use', entry.key, { inBattle: false })
    return axyon.send(s, ctx.jid, m, [
      T.header({ creators: greetings.creatorsOf(ctx.settings) }),
      '',
      `${entry.icon} ${T.b(entry.name.toUpperCase())}`,
      '',
      r.note,
      '',
      T.rule('', 'hair'),
      `\u2764\ufe0f HP ${T.m(`${r.player.hp}/${r.player.maxHp}`)} \u2022 \ud83d\udd0b ${T.m(`${r.player.powerEnergy}/${r.player.maxPowerEnergy}`)}`
    ].join('\n'))
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
    const prefix = group?.prefix || settings.prefix

    const ctx = {
      userId,
      jid,
      name: displayName(m),
      settings,
      group,
      auth,
      prefix,
      content
    }
    return ctx
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

    /*
     * `.play` — DOT PREFIX ONLY
     * -------------------------
     * Deliberately independent of the configured command prefix: it answers
     * `.play <song>` and nothing else, so it keeps working whatever `!prefix`
     * is set to, and a bare `!play` is NOT this command.
     *
     * It never downloads or sends audio. It looks the lyrics up and posts them
     * as plain text; when nothing is found it says so in plain text.
     */
    const rawText = String(content?.conversation || content?.extendedTextMessage?.text || '').trim()
    if (/^\.play(?:\s|$)/i.test(rawText)) {
      const query = rawText.replace(/^\.play/i, '').trim()
      if (!query) {
        await axyon.send(sock, ctx.jid, m, '🎵 *PLAY*\n\nUsage: *.play <song name>*\nExample: *.play Blinding Lights The Weeknd*')
        return true
      }
      let result = { found: false }
      try { result = await lyrics.lookup(query) } catch { result = { found: false } }
      if (!result.found) {
        await axyon.send(sock, ctx.jid, m, `🎵 *LYRICS NOT FOUND*\n\nI could not find lyrics for *${query}*.\nTry adding the artist, e.g. *.play ${query} <artist>*.`)
        return true
      }
      await axyon.send(sock, ctx.jid, m, `🎵 *${result.title}* — ${result.artist}\n\n${result.lyrics}`)
      return true
    }

    const parsed = parse(content, ctx.prefix)
    if (!parsed) return false

    const command = BY_NAME.get(parsed.command)
    if (!command) return false

    const groupManagement = new Set(['register', 'group', 'groups', 'unregister'])
    if (ctx.jid.endsWith('@g.us')) {
      const isAxyonManagement = ctx.auth.axyon && groupManagement.has(parsed.command)
      if (!ctx.group || ctx.group.status === 'REMOVED') {
        if (!isAxyonManagement) {
          await axyon.send(sock, ctx.jid, m, `${W}\n\n*ACCESS DENIED*\n\nThis group has not been registered with the AXYN CORE system.\nContact an authorized AXYON operator for registration.`)
          return true
        }
      } else if (!ctx.auth.axyon) {
        const status = String(ctx.group.status || (ctx.group.enabled ? 'ACTIVE' : 'DISABLED')).toUpperCase()
        if (status === 'SUSPENDED') {
          await axyon.send(sock, ctx.jid, m, `${W}\n\n*GROUP SUSPENDED*\n\nThis group's access has been temporarily suspended. Gaming features are currently unavailable.`)
          return true
        }
        if (status !== 'ACTIVE' || ctx.group.enabled === false) {
          await axyon.send(sock, ctx.jid, m, `${W}\n\n*GROUP DISABLED*\n\nThis group's access has been manually disabled.`)
          return true
        }
      }
    }

    /*
     * REGISTRATION GATE
     * -----------------
     * `!arise` is the only command that works before registration. Everything
     * else tells the player to run it, rather than failing silently or
     * throwing a null-player error deep inside a handler.
     */
    if (parsed.command !== 'arise' && !OPEN_BEFORE_ARISE.has(parsed.command)) {
      const p = await store.player(ctx.userId).catch(() => null)
      if (!p) {
        await axyon.send(sock, ctx.jid, m, greetings.notRegistered(ctx.prefix))
        return true
      }
    }

    /* GROUP FEATURE GATE — command sections map to group-level features. */
    if (ctx.jid.endsWith('@g.us') && ctx.group && !ctx.auth.axyon && !['register', 'group', 'groups', 'unregister'].includes(parsed.command)) {
      const feature = featureFor(command)
      if (feature) {
        const enabled = Array.isArray(ctx.group.features) ? ctx.group.features : []
        const required = Array.isArray(feature) ? feature : [feature]
        const all = !Array.isArray(feature) && feature.all ? feature.all : []
        const any = !Array.isArray(feature) && feature.any ? feature.any : required
        const allowed = all.every(name => enabled.includes(name)) && any.some(name => enabled.includes(name))
        if (!allowed) {
          const needs = [...all, any.length > 1 ? `(${any.join(' or ')})` : any[0]].filter(Boolean)
          await axyon.send(sock, ctx.jid, m, `${W}\n\n*FEATURE UNAVAILABLE*\n\nThis command requires: *${needs.join(' + ')}*.`)
          return true
        }
      }
    }

    /* Duel commands require a group even when AXYON is testing them. */
    if (command.section === 'duel' && !ctx.jid.endsWith('@g.us')) {
      await axyon.send(sock, ctx.jid, m, `${W}\n\n*GROUPS ONLY*\n\nDuel commands require a registered WhatsApp group.`)
      return true
    }

    if (ctx.jid.endsWith('@g.us') && ctx.group) {
      await store.touchGroupActivity(ctx.jid).catch(() => {})
    }

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
    if (id === 'ax_help') { await axyon.send(sock, ctx.jid, m, axyon.helpAll(ctx.prefix)); return true }
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
      await axyon.answerDuel(sock, m, ctx, Number(bits[2]), bits[1] === 'accept')
      return true
    }
    return false
  }

  return { handle, section, parse, buildContext, BY_NAME, mentionedId, answerAI }
}

module.exports = { createCommands, MODE_LIST, mentionedId }
