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
const adventure = require('./axyon-adventure')
const collab = require('./axyon-collab')

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
const OPEN_BEFORE_ARISE = new Set(['arise', 'help', 'ping', 'register', 'group', 'unregister', 'groups', 'prefix', 'numbers', 'rhm', 'stage', 'flooradmin', 'modes', 'visual', 'economy', 'reset', 'grantcard', 'spawncard', 'cardadmin', 'classadmin', 'top', 'story', 'aura', 'feedback', 'room', 'roomtype', 'mode', 'modes', 'collab'])

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

  /* New commands adapt the existing engines; they do not replace old flows. */
  async function invokeLocal (name, sock, message, ctx, args = [], content = {}) {
    const command = BY_NAME.get(name)
    if (!command) return axyon.send(sock, ctx.jid, message, `Command *${name}* is not available in this build.`)
    return command.handler(sock, message, ctx, args, content)
  }

  async function activeRoomFor (ctx) {
    const rows = await store.roomsFor(ctx.jid).catch(() => [])
    return rows.find(room => !['completed', 'cancelled', 'expired'].includes(String(room.status)) &&
      Array.isArray(room.participants) && room.participants.some(part => String(part.userId) === String(ctx.userId))) || null
  }

  function adventureModeForRoom (room) {
    if (!room) return null
    if (String(room.mode_id).startsWith('guild_')) return 'guild'
    if (room.mode_id === 'duel') return 'duel'
    if (room.mode_id === 'abyss') return 'abyss'
    return room.participation === 'solo' ? 'solo' : 'multiplayer'
  }

  async function createAdventureSave (ctx, requestedMode = null) {
    const player = await store.player(ctx.userId)
    if (!player) throw new Error(`Use *${ctx.prefix}arise* first.`)
    const battle = await store.getBattle(ctx.userId)
    const storyState = await store.floorStory(ctx.userId)
    const room = await activeRoomFor(ctx)
    const inferred = room ? adventureModeForRoom(room) : 'solo'
    const mode = adventure.cleanMode(requestedMode || inferred)
    if (!mode) throw new Error('Choose solo, multiplayer, guild, duel or abyss.')
    if (mode !== 'solo' && !room) throw new Error(`No active *${mode}* session was found in this chat.`)
    if (room && mode !== inferred && !(mode === 'abyss' && room.mode_id === 'abyss')) {
      throw new Error(`The active session is *${inferred}*, not *${mode}*.`)
    }
    if (mode === 'solo' && !battle && !storyState?.chapter) throw new Error('Start a Solo floor before creating a save.')
    const participants = room ? (room.participants || []).map(part => part.userId) : [ctx.userId]
    return adventure.createSave({
      mode,
      ownerId: ctx.userId,
      groupJid: ctx.jid,
      roomKey: room?.room_key || null,
      participants,
      snapshot: { version: 1, battle: battle || null, floorStory: storyState || {}, roomState: room?.state || null, savedAt: new Date().toISOString() }
    })
  }

  async function restoreAdventureSave (ctx, code) {
    const saved = await adventure.getSave(code)
    if (!saved) throw new Error('Save code not found or no longer active.')
    const participants = Array.isArray(saved.participants) ? saved.participants.map(String) : []
    if (!participants.includes(String(ctx.userId))) throw new Error('Your player identity is not listed in this save.')
    const lock = await adventure.modeLock(saved.mode)
    if (lock.locked) throw new Error(`*${saved.mode.toUpperCase()}* is locked and cannot accept login requests.${lock.reason ? `
Reason: ${lock.reason}` : ''}`)
    if (saved.mode === 'solo') {
      if (String(saved.owner_id) !== String(ctx.userId)) throw new Error('Only the save owner can restore Solo Chronicles.')
      if (String(saved.group_jid || '') !== String(ctx.jid)) throw new Error('Restore this Solo save from the same chat where it was created.')
      const snapshot = saved.snapshot || {}
      // The live player profile is never overwritten by a reusable save code.
      // HP, energy, inventory and progression remain in their authoritative rows.
      await store.setBattle(ctx.userId, snapshot.battle || null)
      await store.saveFloorStory(ctx.userId, snapshot.floorStory || {})
      return { mode: saved.mode, code: saved.code, restored: true, room: null }
    }
    if (String(saved.group_jid || '') !== String(ctx.jid)) throw new Error('Return to the registered group where this team session was saved.')
    const room = saved.room_key ? await store.room(saved.room_key) : null
    if (!room) throw new Error('The saved team room no longer exists.')
    if (String(room.group_jid) !== String(ctx.jid)) throw new Error('This session belongs to another registered group.')
    if (saved.mode === 'guild') {
      const membership = await store.guildForUser(ctx.userId)
      const expectedGuild = Number(room.entry_requirements?.guildId)
      if (!membership || Number(membership.id) !== expectedGuild) throw new Error('Guild Campaign login requires current membership in the same registered guild.')
      if (String(membership.group_jid || '') !== String(ctx.jid)) throw new Error('Return to the registered WhatsApp group linked to your guild.')
    }
    const roomParticipants = Array.isArray(room.participants) ? room.participants : []
    if (!roomParticipants.some(part => String(part.userId) === String(ctx.userId))) throw new Error('You are not a participant in this saved session.')
    return { mode: saved.mode, code: saved.code, restored: false, room }
  }

  function storyBattle (battle) { return battle && battle.mode === 'floor' ? battle : null }

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
  cmd('fight', 'battle', '{p}fight [start|status|info|enemies|scene|continue|history|surrender|exit]', 'Enter a stage or inspect/manage the current encounter.', async (s, m, ctx, args) => {
    const sub = String(args[0] || '').toLowerCase()
    const active = await store.getBattle(ctx.userId)
    if (['status', 'info', 'enemies', 'scene', 'history'].includes(sub) && !active) {
      return axyon.send(s, ctx.jid, m, `⚔️ No active encounter. Use *${ctx.prefix}fight start* when you are ready.`)
    }
    if (active && ['status', 'info', 'enemies', 'scene', 'continue', 'history'].includes(sub)) {
      if (sub === 'continue') return invokeLocal('battle', s, m, ctx, [], {})
      const enemy = active.enemy || {}
      const info = `${W}\n\n⚔️ *CURRENT ENCOUNTER*\n\nEnemy: *${enemy.name || 'Unknown'}*\nHP: *${active.enemyHp ?? enemy.hp ?? '?'}*\nLocation: *${active.location || 'Unknown'}*\nTurn: *${active.turn || 1}*\nStage: *${active.mode || 'battle'}*`
      return axyon.send(s, ctx.jid, m, info)
    }
    if (active && ['surrender', 'exit'].includes(sub)) return axyon.battleAct(s, m, ctx, 'retreat')
    if (sub === 'start') args = args.slice(1)
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

  cmd('party', 'dungeon', '{p}party <create|invite|join|decline|members|leader|status|ready|start|leave|kick|disband|save|logout|resume|view>', 'Organise an existing party or launch a three-player Multiplayer Expedition.', async (s, m, ctx, args, content) => {
    const sub = String(args[0] || 'view').toLowerCase()
    const settings = ctx.settings
    const open = await store.openParty(ctx.jid)
    const isLeader = party => party && String(party.leader) === String(ctx.userId)
    if (sub === 'login') return invokeLocal('login', s, m, ctx, ['multiplayer', String(args[1] || '')], {})
    const namesFor = async ids => Promise.all((ids || []).map(async id => {
      const p = await store.player(id)
      return `• *${p?.name || id}*${String(id) === String(ctx.userId) ? ' (you)' : ''}${String(id) === String(open?.leader) ? ' 👑' : ''}`
    }))

    if (sub === 'create') {
      const p = await store.player(ctx.userId)
      if (!p) return axyon.send(s, ctx.jid, m, `🌀 Use *${ctx.prefix}arise* first.`)
      const party = await store.createParty(ctx.jid, ctx.userId, [ctx.userId])
      await store.updateParty(party.id, [ctx.userId], 'open', [], [ctx.userId], { expedition: true })
      await store.log(ctx.userId, 'party_create', String(party.id))
      return axyon.send(s, ctx.jid, m, [W, '', '⚔️ *EXPEDITION PARTY FORMED*', '', `Leader: *${p.name || ctx.userId}*`, 'Members: *1/3*', 'Status: *Recruiting*', '', `Invite: *${ctx.prefix}party invite @player*`, `Ready: *${ctx.prefix}party ready*`, `Launch: *${ctx.prefix}party start*`].join('\n'))
    }

    if (sub === 'invite' || sub === 'add') {
      if (!open) return axyon.send(s, ctx.jid, m, `No open party. Use *${ctx.prefix}party create* first.`)
      if (!isLeader(open)) return axyon.send(s, ctx.jid, m, 'Only the Party Leader can invite players.')
      const target = mentionedId(content)
      if (!target || target === ctx.userId) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}party invite @player*`)
      if ((open.members || []).includes(target)) return axyon.send(s, ctx.jid, m, 'That player is already in the party.')
      if ((open.members || []).length + (open.invited || []).length >= 3) return axyon.send(s, ctx.jid, m, 'This expedition supports a maximum of three participants, including pending invitations.')
      if (!(await store.player(target))) return axyon.send(s, ctx.jid, m, 'That player must use !arise before joining an expedition.')
      const invited = [...new Set([...(open.invited || []), target])]
      await store.updateParty(open.id, open.members || [], null, invited)
      return axyon.send(s, ctx.jid, m, `📨 Invitation added for @${target.split('@')[0]}. They can join with *${ctx.prefix}party join*.`)
    }

    if (sub === 'decline') {
      if (!open || !(open.invited || []).includes(ctx.userId)) return axyon.send(s, ctx.jid, m, 'You do not have a pending party invitation here.')
      const invited = open.invited.filter(id => id !== ctx.userId)
      await store.updateParty(open.id, open.members || [], null, invited)
      return axyon.send(s, ctx.jid, m, 'Party invitation declined.')
    }

    if (sub === 'join') {
      if (!open) return axyon.send(s, ctx.jid, m, `🔥 No open party here. Start one with *${ctx.prefix}party create*.`)
      if ((open.members || []).includes(ctx.userId)) return axyon.send(s, ctx.jid, m, 'You are already in this party.')
      const invited = Array.isArray(open.invited) ? open.invited : []
      if (invited.length && !invited.includes(ctx.userId)) return axyon.send(s, ctx.jid, m, 'This party is invitation-only. Ask its leader to invite you.')
      const members = [...new Set([...(open.members || []), ctx.userId])]
      if (members.length > settings.partyMax) return axyon.send(s, ctx.jid, m, `❌ That party is full (max *${settings.partyMax}*).`)
      const nextInvited = invited.filter(id => id !== ctx.userId)
      const ready = (open.ready || []).filter(id => members.includes(id))
      await store.updateParty(open.id, members, null, nextInvited, ready)
      const player = await store.player(ctx.userId)
      await store.log(ctx.userId, 'party_join', String(open.id))
      return axyon.send(s, ctx.jid, m, `${W}

✅ *JOINED PARTY*

*${player?.name || ctx.userId}* joined.
Members: *${members.length}/3*`)
    }

    if (!open) {
      const active = await activeRoomFor(ctx)
      if (active && ['story', 'continue', 'choose', 'explore', 'investigate', 'talk', 'recap', 'history', 'mission', 'objectives', 'map', 'chapter', 'floor', 'progress', 'discoveries', 'characters', 'save', 'logout', 'resume', 'rejoin', 'members', 'status', 'leader', 'waiting', 'leave', 'kick', 'disband'].includes(sub)) {
        if (['story', 'continue', 'choose', 'explore', 'investigate', 'talk', 'recap', 'history', 'mission', 'objectives', 'map', 'chapter', 'floor', 'progress', 'discoveries', 'characters'].includes(sub)) return invokeLocal('session', s, m, ctx, [sub, ...args.slice(1)], {})
        if (sub === 'save') {
          const saveAction = String(args[1] || 'progress').toLowerCase()
          return saveAction === 'status' ? invokeLocal('save', s, m, ctx, ['status'], {})
            : invokeLocal('save', s, m, ctx, ['progress', 'multiplayer'], {})
        }
        if (sub === 'login') return invokeLocal('login', s, m, ctx, ['multiplayer', String(args[1] || '')], {})
        if (sub === 'logout') return invokeLocal('logout', s, m, ctx, ['multiplayer'], {})
        if (sub === 'resume' || sub === 'rejoin') return invokeLocal('session', s, m, ctx, ['resume'], {})
        if (sub === 'leave') return invokeLocal('room', s, m, ctx, ['leave', active.room_key], {})
        if (sub === 'kick') return invokeLocal('room', s, m, ctx, ['kick', active.room_key], content)
        if (sub === 'disband') return invokeLocal('room', s, m, ctx, ['close', active.room_key], {})
        if (sub === 'members' || sub === 'waiting' || sub === 'status' || sub === 'leader') return invokeLocal('session', s, m, ctx, ['members'], {})
      }
      return axyon.send(s, ctx.jid, m, `🔥 No open party here. Start one with *${ctx.prefix}party create*.`)
    }

    if (sub === 'leader') return axyon.send(s, ctx.jid, m, `👑 Party Leader: *${(await store.player(open.leader))?.name || open.leader}*`)
    if (sub === 'members' || sub === 'view' || sub === 'status' || sub === 'waiting') {
      const lines = await namesFor(open.members)
      const waiting = (open.invited || []).map(id => `◌ @${id.split('@')[0]} — invited`)
      return axyon.send(s, ctx.jid, m, [W, '', '⚔️ *MULTIPLAYER EXPEDITION*', '', ...lines, ...waiting, '', `Ready: *${(open.ready || []).length}/${(open.members || []).length}*`, `Capacity: *${(open.members || []).length}/3*`, `Status: *${open.status}*`, '', `Use *${ctx.prefix}party ready* when prepared.`].join('\n'))
    }
    if (sub === 'ready') {
      if (!(open.members || []).includes(ctx.userId)) return axyon.send(s, ctx.jid, m, 'Join the party before marking yourself ready.')
      const ready = [...new Set([...(open.ready || []), ctx.userId])]
      await store.updateParty(open.id, open.members || [], null, open.invited || [], ready)
      return axyon.send(s, ctx.jid, m, `✅ You are ready. *${ready.length}/${(open.members || []).length}* party members ready.`)
    }
    if (sub === 'start') {
      if (!isLeader(open)) return axyon.send(s, ctx.jid, m, 'Only the Party Leader can start the expedition.')
      if ((open.members || []).length < 2) return axyon.send(s, ctx.jid, m, 'An expedition needs at least two players.')
      if ((open.members || []).length > 3) return axyon.send(s, ctx.jid, m, 'Multiplayer Expeditions are limited to three players. Your legacy party remains unchanged.')
      const notReady = (open.members || []).filter(id => !(open.ready || []).includes(id))
      if (notReady.length) return axyon.send(s, ctx.jid, m, `Waiting for ${notReady.length} member(s) to use *${ctx.prefix}party ready*.`)
      const existingSession = await activeRoomFor(ctx)
      if (existingSession) return axyon.send(s, ctx.jid, m, `You already have a live session here: *${existingSession.name}* (\`${existingSession.room_key}\`). Use *${ctx.prefix}session* to continue it.`)
      const group = await registeredGroupFor(ctx, null)
      if (!groupFeatureEnabled(group, 'combat') && !groupFeatureEnabled(group, 'dungeon')) throw new Error('This registered group needs its combat or dungeon feature enabled.')
      const participants = []
      for (const id of open.members) {
        if (!(await store.player(id))) return axyon.send(s, ctx.jid, m, `Player ${id} must use *${ctx.prefix}arise* before the expedition starts.`)
        participants.push({ userId: id, role: id === open.leader ? 'leader' : 'member' })
      }
      const room = await store.createRoom({ name: `MULTIPLAYER EXPEDITION — ${String(Date.now()).slice(-4)}`, groupJid: ctx.jid, ownerId: open.leader, modeId: 'dungeon', participation: 'multiplayer', privacy: 'public', capacity: 3, entryRequirements: { adventureMode: 'multiplayer', partyId: Number(open.id) } })
      await store.updateRoom(room.room_key, { participants, status: 'ready' })
      await store.updateParty(open.id, open.members || [], 'started', open.invited || [], open.ready || [], { ...(open.state || {}), roomKey: room.room_key })
      await store.log(ctx.userId, 'party_expedition_start', room.room_key, { partyId: open.id })
      return axyon.send(s, ctx.jid, m, `${W}

🟢 *EXPEDITION PARTY READY*

${room.name}
Players: *${participants.length}/3*
Room: \`${room.room_key}\`

The shared session is open. Use *${ctx.prefix}session* to inspect it.`)
    }
    if (sub === 'kick') {
      if (!isLeader(open)) return axyon.send(s, ctx.jid, m, 'Only the Party Leader can remove a member.')
      const target = mentionedId(content)
      if (!target || target === open.leader || !(open.members || []).includes(target)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}party kick @member*`)
      const members = open.members.filter(id => id !== target)
      const ready = (open.ready || []).filter(id => id !== target)
      await store.updateParty(open.id, members, null, open.invited || [], ready)
      return axyon.send(s, ctx.jid, m, `Removed @${target.split('@')[0]} from the party.`)
    }
    if (sub === 'disband') {
      if (!isLeader(open)) return axyon.send(s, ctx.jid, m, 'Only the Party Leader can disband this party.')
      await store.updateParty(open.id, [], 'closed', [], [])
      return axyon.send(s, ctx.jid, m, '🛑 Party disbanded. Existing character and story progress is untouched.')
    }
    if (sub === 'save') {
      const saveAction = String(args[1] || 'progress').toLowerCase()
      return saveAction === 'status' ? invokeLocal('save', s, m, ctx, ['status'], {})
        : invokeLocal('save', s, m, ctx, ['progress', 'multiplayer'], {})
    }
    if (sub === 'login') return invokeLocal('login', s, m, ctx, ['multiplayer', String(args[1] || '')], {})
    if (sub === 'logout') return invokeLocal('logout', s, m, ctx, ['multiplayer'], {})
    if (sub === 'resume' || sub === 'rejoin') return invokeLocal('session', s, m, ctx, ['resume'], {})
    if (sub === 'leave') {
      const members = (open.members || []).filter(x => x !== ctx.userId)
      if (members.length === (open.members || []).length) return axyon.send(s, ctx.jid, m, 'You are not in this party.')
      const ready = (open.ready || []).filter(id => members.includes(id))
      await store.updateParty(open.id, members, members.length ? null : 'closed', open.invited || [], ready)
      return axyon.send(s, ctx.jid, m, `👋 You left the party. *${members.length}* remain.`)
    }
    return axyon.send(s, ctx.jid, m, `⌘ *PARTY COMMANDS*

${ctx.prefix}party create
${ctx.prefix}party invite @player
${ctx.prefix}party join
${ctx.prefix}party members
${ctx.prefix}party ready
${ctx.prefix}party start
${ctx.prefix}party save [code|status]
${ctx.prefix}party logout
${ctx.prefix}party login <save-code>
${ctx.prefix}party rejoin`)
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

    if (sub === 'invite') {
      const room = await activeRoomFor(ctx)
      const target = mentionedId(ctx.content || {})
      if (!room) return axyon.send(s, ctx.jid, m, 'You are not leading an active room in this group.')
      if (String(room.owner_id) !== String(ctx.userId) && !ctx.auth.axyon) return axyon.send(s, ctx.jid, m, 'Only the session leader can invite players.')
      if (!target || target === ctx.userId) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}room invite @player*`)
      const req = room.entry_requirements || {}
      if (req.guildId) {
        const member = await store.guildForUser(target)
        if (!member || Number(member.id) !== Number(req.guildId) || String(member.group_jid || '') !== String(ctx.jid)) return axyon.send(s, ctx.jid, m, 'Only a member of this linked guild can be invited to its campaign.')
      }
      const invited = [...new Set([...(req.invited || []), target])]
      await store.updateRoom(room.room_key, { entryRequirements: { ...req, invited } })
      return axyon.send(s, ctx.jid, m, `📨 Invitation recorded for @${target.split('@')[0]}. They can join with *${ctx.prefix}room join ${room.room_key}*.`)
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
      const req = room.entry_requirements || {}
      const alreadyJoined = (room.participants || []).some(part => String(part.userId) === String(ctx.userId))
      if (!alreadyJoined && req.guildId) {
        const member = await store.guildForUser(ctx.userId)
        if (!member || Number(member.id) !== Number(req.guildId) || String(member.group_jid || '') !== String(ctx.jid)) {
          return axyon.send(s, ctx.jid, m, '❌ This campaign is restricted to members of its linked guild.')
        }
      }
      if (!alreadyJoined && Array.isArray(req.invited) && req.invited.length && !req.invited.includes(ctx.userId) && String(room.owner_id) !== String(ctx.userId)) {
        return axyon.send(s, ctx.jid, m, '❌ This session is invitation-only. Ask its leader to invite you.')
      }
      const check = modesLib.canJoin(room, ctx.userId)
      if (!check.ok) return axyon.send(s, ctx.jid, m, `❌ ${check.message}`)
      const participants = modesLib.addParticipant(room, ctx.userId)
      const next = modesLib.isReady({ ...room, participants }) && room.status === 'waiting' ? 'ready' : room.status
      const remainingInvites = Array.isArray(req.invited) ? req.invited.filter(id => id !== ctx.userId) : []
      await store.updateRoom(room.room_key, { participants, status: next, entryRequirements: { ...req, invited: remainingInvites } })
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

    if (sub === 'kick') {
      if (!modesLib.canManage(room, ctx.userId, ctx.auth)) return axyon.send(s, ctx.jid, m, '🛡️ Only the room leader or AXYON can remove a participant.')
      if (String(room.status) === 'active') return axyon.send(s, ctx.jid, m, 'A participant cannot be removed after the encounter has started. Close or finish the session first.')
      const target = mentionedId(ctx.content || {})
      if (!target || String(target) === String(room.owner_id)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}room kick ${room.room_key} @member*`)
      const participants = (room.participants || []).filter(part => String(part.userId) !== String(target))
      if (participants.length === (room.participants || []).length) return axyon.send(s, ctx.jid, m, 'That player is not in this room.')
      const requirements = room.entry_requirements || {}
      const invited = (requirements.invited || []).filter(id => String(id) !== String(target))
      await store.updateRoom(room.room_key, { participants, entryRequirements: { ...requirements, invited } })
      await store.log(ctx.userId, 'room_kick', room.room_key, { target })
      return axyon.send(s, ctx.jid, m, `Removed @${String(target).split('@')[0]} from *${room.name}*.`)
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

  cmd('duel', 'duel', '{p}duel @player | {p}duel <chronicles|invite|accept|decline|start|status|members|leave|resume>', 'Direct duels remain available; Chronicles uses a separate two-player registered-group session.', async (s, m, ctx, args, content) => {
    const sub = String(args[0] || '').toLowerCase()
    const rows = async () => store.roomsFor(ctx.jid)
    const duelRoom = async () => {
      const current = await activeRoomFor(ctx)
      return current && current.mode_id === 'duel' ? current : null
    }
    const invitedRoom = async () => (await rows()).find(r => r.mode_id === 'duel' &&
      ['waiting', 'ready', 'paused'].includes(String(r.status)) &&
      Array.isArray(r.entry_requirements?.invited) && r.entry_requirements.invited.map(String).includes(String(ctx.userId))) || null

    if (sub === 'chronicles' || sub === 'create') return adventureDirectory(s, m, ctx, ['enter', 'duel'])
    if (sub === 'invite') {
      const target = mentionedId(content)
      if (!target || target === ctx.userId) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}duel invite @player*`)
      if (!(await store.player(target))) return axyon.send(s, ctx.jid, m, 'That player must use !arise before joining Duel Chronicles.')
      let room = await duelRoom()
      if (!room) {
        try { const made = await createModeRoom(s, m, ctx, 'duel'); room = made.room }
        catch (error) { return axyon.send(s, ctx.jid, m, `❌ ${error.message}`) }
      }
      if (String(room.owner_id) !== String(ctx.userId) && !ctx.auth.axyon) return axyon.send(s, ctx.jid, m, 'Only the Duel Leader can invite participants.')
      if ((room.participants || []).some(part => String(part.userId) === String(target))) return axyon.send(s, ctx.jid, m, 'That player is already in this duel.')
      const invited = [...new Set([...(room.entry_requirements?.invited || []), String(target)])]
      await store.updateRoom(room.room_key, { entryRequirements: { ...(room.entry_requirements || {}), invited } })
      return axyon.send(s, ctx.jid, m, `⚔️ *DUEL INVITATION SENT*

@${target.split('@')[0]} has been invited to Duel Chronicles.
Accept with *${ctx.prefix}duel accept*.`)
    }
    if (sub === 'accept' && !parseNum(args[1])) {
      const pending = await invitedRoom()
      if (pending) return invokeLocal('room', s, m, ctx, ['join', pending.room_key], {})
      return axyon.send(s, ctx.jid, m, 'There is no pending Duel Chronicles invitation in this group. For a direct duel, use *!duel accept <id>*.')
    }
    if (sub === 'decline' && !parseNum(args[1])) {
      const pending = await invitedRoom()
      if (!pending) return axyon.send(s, ctx.jid, m, 'There is no pending Duel Chronicles invitation in this group.')
      const req = pending.entry_requirements || {}
      const invited = (req.invited || []).filter(id => String(id) !== String(ctx.userId))
      await store.updateRoom(pending.room_key, { entryRequirements: { ...req, invited } })
      return axyon.send(s, ctx.jid, m, 'Duel Chronicles invitation declined.')
    }
    if (['accept', 'decline'].includes(sub) && parseNum(args[1])) {
      const id = parseNum(args[1])
      return axyon.answerDuel(s, m, ctx, id, sub === 'accept')
    }
    if (['story', 'continue', 'choose', 'explore', 'investigate', 'talk', 'recap', 'history', 'mission', 'objectives', 'map', 'chapter', 'floor', 'progress', 'discoveries', 'characters'].includes(sub)) return invokeLocal('session', s, m, ctx, [sub, ...args.slice(1)], {})
    if (sub === 'login') return invokeLocal('login', s, m, ctx, ['duel', String(args[1] || '')], {})
    if (sub === 'save') return invokeLocal('save', s, m, ctx, ['progress', 'duel'], {})
    if (sub === 'logout') return invokeLocal('logout', s, m, ctx, ['duel'], {})
    if (sub === 'start') {
      const room = await duelRoom()
      if (!room) return axyon.send(s, ctx.jid, m, `No Duel Chronicles room found. Use *${ctx.prefix}duel chronicles* first.`)
      return invokeLocal('room', s, m, ctx, ['start', room.room_key], {})
    }
    if (sub === 'status' || sub === 'members') {
      const room = await duelRoom()
      if (!room) return axyon.send(s, ctx.jid, m, `No active Duel Chronicles session. Use *${ctx.prefix}duel chronicles* to open one.`)
      return invokeLocal('room', s, m, ctx, ['view', room.room_key], {})
    }
    if (sub === 'leave') {
      const room = await duelRoom()
      if (!room) return axyon.send(s, ctx.jid, m, 'You are not in an active Duel Chronicles session.')
      return invokeLocal('room', s, m, ctx, ['leave', room.room_key], {})
    }
    if (sub === 'resume' || sub === 'rejoin') return invokeLocal('session', s, m, ctx, ['resume'], {})

    // Legacy direct player-versus-player duels are deliberately unchanged.
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

  cmd('story', 'media', '{p}story [continue|recap|history|choices|choose <1-4>|objectives|characters|location|skip]', 'Continue and inspect the active floor storyline. No-argument anthology remains available.', async (s, m, ctx, args = []) => {
    const sub = String(args[0] || '').toLowerCase()
    if (sub) {
      const battle = await store.getBattle(ctx.userId)
      const storyState = await store.floorStory(ctx.userId)
      if (sub === 'choose') return invokeLocal('choice', s, m, ctx, [String(args[1] || '')], {})
      if (sub === 'continue') return invokeLocal('battle', s, m, ctx, [], {})
      if (sub === 'skip') return axyon.send(s, ctx.jid, m, battle?.mode === 'floor' && battle.storyPending
        ? 'This is a required floor decision. Choose one of the four options with *!choice 1-4*; the story cannot be skipped.'
        : 'There is no required story scene waiting to be skipped.')
      if (sub === 'choices') return axyon.send(s, ctx.jid, m, battle?.mode === 'floor' && battle.storyPending
        ? floorStory.begin(battle.ordinal, storyState).text
        : 'There is no pending story decision. Use *!floor* to enter the next floor.')
      if (sub === 'history' || sub === 'recap') {
        const rows = Array.isArray(storyState.history) ? storyState.history.slice(-8) : []
        return axyon.send(s, ctx.jid, m, rows.length
          ? [W, '', '📖 *STORY RECAP*', '', ...rows.map((r, i) => `${i + 1}. Floor ${r.floor} — *${r.chapter}*\n   Decision: ${r.choice}`)].join('\n\n')
          : 'Your story journal is empty. Enter a floor with *!floor* to begin.')
      }
      if (sub === 'objectives') {
        const rows = floorStory.objectives(storyState)
        return axyon.send(s, ctx.jid, m, rows.length
          ? [W, '', '🎯 *STORY OBJECTIVES*', '', ...rows.map(q => `${q.status === 'complete' ? '✅' : q.status === 'claimed' ? '🏅' : '▫️'} *${q.name}*\n   ${q.objective}`)].join('\n\n')
          : 'No story objectives yet. Talk to the current NPC or make a floor decision to unlock a side quest.')
      }
      if (sub === 'characters') {
        const current = battle?.mode === 'floor' ? floorStory.chapterFor(battle.ordinal) : null
        const contacts = Array.isArray(storyState.npcContacts) ? storyState.npcContacts : []
        return axyon.send(s, ctx.jid, m, current
          ? `👥 *CHAPTER CHARACTERS*\n\n• ${current.npc}${contacts.length ? `\n\nRecorded conversations: ${contacts.length}` : ''}`
          : 'No active floor chapter. Enter a floor to meet its characters.')
      }
      if (sub === 'location') return axyon.send(s, ctx.jid, m, battle?.mode === 'floor' ? `⌖ *CURRENT LOCATION*\n\n${battle.location || floorStory.chapterFor(battle.ordinal).place}` : 'You are not inside a floor location.')
      return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}story continue|recap|history|choices|choose <1-4>|objectives|characters|location|skip*`)
    }
    /* Original deterministic anthology; no-argument behaviour is unchanged. */
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
      await axyon.send(sock, ctx.jid, m, [
        T.header({ creators: greetings.creatorsOf(ctx.settings) }),
        '',
        `🤖 ${T.i('I could not reach my knowledge base just now.')}`,
        '',
        `Try ${T.b(`${ctx.prefix}help`)} for the full command list.`
      ].join('\n'))
      return true
    }

    await axyon.send(sock, ctx.jid, m, [
      T.header({ creators: greetings.creatorsOf(ctx.settings) }),
      '',
      `🤖 ${T.font('ARCHITECT', 'bold')}`,
      '',
      text,
      '',
      T.rule('', 'hair'),
      T.i('I can explain commands. I cannot run them.')
    ].join('\n'))
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
    if (command.name === 'mode') return null // mode checks the selected adventure's registration feature itself
    if (command.name === 'collab') return 'collab'
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
  const registrationHelp = `${W}\n\n*GROUP REGISTRATION*\n\n• \`!register group normal\` — Original gaming\n• \`!register group modes\` — Select features individually\n• \`!register group duel\` — Duel system only\n• \`!register group multiplayer\` — Multiplayer Expedition\n• \`!register group guild\` — Guild Campaigns\n• \`!register group collab\` — Cross-group collaboration\n• \`!register view\` — Current group record\n• \`!register list\` — All registered groups (AXYON)\n• \`!register mode <normal|modes|duel|multiplayer|guild|collab>\` — Change mode (AXYON)`

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
      if (!Object.hasOwn(store.GROUP_MODES, mode)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}register mode normal|modes|duel|multiplayer|guild|collab*`)
      if (!current || current.status === 'REMOVED') return axyon.send(s, ctx.jid, m, `This group is not registered. Use *${ctx.prefix}register group ${mode}*.`)
      const updated = await store.updateGroupMode(ctx.jid, mode)
      await store.log(ctx.userId, 'group_registration_mode', ctx.jid, { mode })
      return axyon.send(s, ctx.jid, m, `${W}\n\n✅ *REGISTRATION MODE UPDATED*\n\n${updated.name || ctx.jid}\nMode: *${mode.toUpperCase()}*\nFeatures: ${(updated.features || []).join(', ') || 'none enabled'}`)
    }
    if (sub !== 'group') return axyon.send(s, ctx.jid, m, registrationHelp)
    const mode = String(args[1] || '').toLowerCase()
    if (!Object.hasOwn(store.GROUP_MODES, mode)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}register group normal|modes|duel|multiplayer|guild|collab*`)
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

  cmd('group', 'management', '{p}group <register|status|info|verify|list|change|unregister|enable|disable|suspend|reactivate|remove|features>', 'Manage registered group types and access (AXYON only).', async (s, m, ctx, args) => {
    if (!ctx.auth.axyon) return axyon.send(s, ctx.jid, m, `${W}\n\n🛡️ *AXYON ONLY*`)
    const sub = String(args[0] || 'info').toLowerCase()
    if (sub === 'list') return invokeLocal('groups', s, m, ctx, [], {})
    if (!ctx.jid.endsWith('@g.us')) return axyon.send(s, ctx.jid, m, '📍 Run group management inside the target WhatsApp group.')
    if (sub === 'register') return invokeLocal('register', s, m, ctx, ['group', String(args[1] || 'normal')], {})
    if (sub === 'change') return invokeLocal('register', s, m, ctx, ['mode', String(args[1] || '')], {})
    if (sub === 'unregister' || sub === 'remove') {
      const current = await store.group(ctx.jid)
      if (!current || current.status === 'REMOVED') return axyon.send(s, ctx.jid, m, 'This group is not registered.')
      const requested = String(args[1] || '').toLowerCase()
      if (requested && requested !== String(current.registration_mode || 'normal').toLowerCase()) return axyon.send(s, ctx.jid, m, `This group is registered as *${current.registration_mode}*, not *${requested}*.`)
      const removed = await store.unregisterGroup(ctx.jid)
      await store.log(ctx.userId, 'group_unregister', ctx.jid, { mode: current.registration_mode })
      return axyon.send(s, ctx.jid, m, removed ? '⛔ Group registration removed. Existing player and adventure data was preserved.' : 'Group registration could not be removed.')
    }
    const g = await store.group(ctx.jid)
    if (sub === 'verify') {
      const verified = !!g && String(g.status || '').toUpperCase() === 'ACTIVE' && g.enabled !== false
      return axyon.send(s, ctx.jid, m, `${verified ? '✅' : '⛔'} *GROUP VERIFICATION*\n\n${verified ? 'This group is actively registered.' : 'This group does not have an active registration.'}\nRegistration type: *${g?.registration_mode || 'none'}*\nFeatures: ${(g?.features || []).join(', ') || 'none'}`)
    }
    if (sub === 'info' || sub === 'view' || sub === 'status') return axyon.send(s, ctx.jid, m, groupRecordText(g, ctx.prefix))
    if (!g || g.status === 'REMOVED') return axyon.send(s, ctx.jid, m, 'This group has no active registration.')
    if (sub === 'features') {
      const available = g.registration_mode === 'modes' ? [...GROUP_FEATURES] : [...(store.GROUP_MODES[g.registration_mode] || store.GROUP_MODES.normal)]
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
      const allowedForMode = g.registration_mode === 'modes' ? GROUP_FEATURES : new Set(store.GROUP_MODES[g.registration_mode] || store.GROUP_MODES.normal)
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

  cmd('guild', 'social', '{p}guild <list|info|suggest|create|join|leave|members|group|ungroup|leader|disband|suggestions|approve|reject|squad>', 'Create and join guilds, submit guild proposals, link guilds, and run five-player guild campaigns.', async (s, m, ctx, args, content) => {
    const sub = String(args[0] || 'help').toLowerCase()

    /* Guild squad campaigns are a separate layer over the existing guild
     * registry. They reuse guild_1 room combat and never change membership. */
    if (sub === 'squad') {
      const action = String(args[1] || 'status').toLowerCase()
      const membership = await store.guildForUser(ctx.userId)
      if (!membership) return axyon.send(s, ctx.jid, m, `Join a guild before using campaign squads: *${ctx.prefix}guild join <id|tag>*.`)
      if (!membership.group_jid || String(membership.group_jid) !== String(ctx.jid)) return axyon.send(s, ctx.jid, m, 'Guild campaigns must run inside your guild’s linked WhatsApp group.')
      const linked = await store.group(ctx.jid)
      if (!linked || String(linked.status || '').toUpperCase() !== 'ACTIVE' || linked.enabled === false || !(linked.features || []).includes('dungeon')) {
        return axyon.send(s, ctx.jid, m, 'This guild group must be registered and have the dungeon feature enabled.')
      }
      const rooms = await store.roomsFor(ctx.jid)
      const live = rooms.filter(r => String(r.mode_id).startsWith('guild_') && Number(r.entry_requirements?.guildId) === Number(membership.id) && !['completed', 'cancelled', 'expired'].includes(String(r.status)))
      const room = live[0] || null
      const leader = r => r && String(r.owner_id) === String(ctx.userId)
      if (action === 'login') return invokeLocal('login', s, m, ctx, ['guild', String(args[2] || '')], {})
      if (action === 'create') {
        if (room) return axyon.send(s, ctx.jid, m, `A guild squad is already open: *${room.name}* (\`${room.room_key}\`).`)
        const created = await store.createRoom({
          name: `GUILD CAMPAIGN — ${String(Date.now()).slice(-4)}`,
          groupJid: ctx.jid, ownerId: ctx.userId, modeId: 'guild_1', participation: 'party',
          privacy: 'public', capacity: 5,
          entryRequirements: { adventureMode: 'guild', guildId: Number(membership.id), invited: [ctx.userId], guildTag: membership.tag }
        })
        await store.log(ctx.userId, 'guild_squad_create', created.room_key, { guildId: membership.id })
        return axyon.send(s, ctx.jid, m, `${W}

⚔️ *GUILD CAMPAIGN SQUAD OPENED*

Guild: *${membership.name}* [${membership.tag}]
Leader: *${ctx.name || ctx.userId}*
Capacity: *1/5*
Room: \`${created.room_key}\`

Invite guild members with *${ctx.prefix}guild squad invite @member*.
Start with *${ctx.prefix}guild squad start*.`)
      }
      if (!room) return axyon.send(s, ctx.jid, m, `No open squad for *${membership.name}*. Create one with *${ctx.prefix}guild squad create*.`)
      if (['story', 'continue', 'choose', 'explore', 'investigate', 'talk', 'recap', 'history', 'mission', 'objectives', 'map', 'chapter', 'floor', 'progress', 'discoveries', 'characters'].includes(action)) return invokeLocal('session', s, m, ctx, [action, ...args.slice(2)], {})
      if (action === 'invite' || action === 'add') {
        if (!leader(room) && membership.member_role !== 'leader' && !ctx.auth.axyon) return axyon.send(s, ctx.jid, m, 'Only the squad creator or Guild Leader can invite members.')
        const target = mentionedId(content)
        if (!target || target === ctx.userId) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}guild squad invite @member*`)
        const targetGuild = await store.guildForUser(target)
        if (!targetGuild || Number(targetGuild.id) !== Number(membership.id)) return axyon.send(s, ctx.jid, m, 'Only members of this guild can join its campaign squad.')
        const current = (room.participants || []).map(p => String(p.userId))
        const invited = room.entry_requirements?.invited || []
        if (current.includes(target)) return axyon.send(s, ctx.jid, m, 'That member is already in the squad.')
        if (current.length + invited.length >= 5) return axyon.send(s, ctx.jid, m, 'This guild squad is full (maximum 5).')
        await store.updateRoom(room.room_key, { entryRequirements: { ...room.entry_requirements, invited: [...new Set([...invited, target])] } })
        return axyon.send(s, ctx.jid, m, `📨 Guild squad invitation recorded for @${target.split('@')[0]}. Use *${ctx.prefix}guild squad join* to join.`)
      }
      if (action === 'join') {
        const invites = room.entry_requirements?.invited || []
        const already = (room.participants || []).some(p => String(p.userId) === String(ctx.userId))
        if (!already && invites.length && !invites.includes(ctx.userId)) return axyon.send(s, ctx.jid, m, 'This squad is invite-only. Ask the Guild Leader or squad creator for an invitation.')
        return invokeLocal('room', s, m, ctx, ['join', room.room_key], {})
      }
      if (action === 'decline') {
        const invites = (room.entry_requirements?.invited || []).filter(id => id !== ctx.userId)
        if (invites.length === (room.entry_requirements?.invited || []).length) return axyon.send(s, ctx.jid, m, 'You have no pending guild squad invitation.')
        await store.updateRoom(room.room_key, { entryRequirements: { ...room.entry_requirements, invited: invites } })
        return axyon.send(s, ctx.jid, m, 'Guild squad invitation declined.')
      }
      if (action === 'start') {
        if (!leader(room) && membership.member_role !== 'leader' && !ctx.auth.axyon) return axyon.send(s, ctx.jid, m, 'Only the squad creator or Guild Leader can start this campaign.')
        if ((room.participants || []).length > 5) return axyon.send(s, ctx.jid, m, 'Guild campaigns are limited to five players.')
        return invokeLocal('room', s, m, ctx, ['start', room.room_key], {})
      }
      if (action === 'leave') return invokeLocal('room', s, m, ctx, ['leave', room.room_key], {})
      if (action === 'kick') {
        if (!leader(room) && membership.member_role !== 'leader' && !ctx.auth.axyon) return axyon.send(s, ctx.jid, m, 'Only the squad creator or Guild Leader can remove members.')
        const target = mentionedId(content)
        if (!target || target === String(room.owner_id)) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}guild squad kick @member*`)
        const participants = (room.participants || []).filter(p => String(p.userId) !== String(target))
        const invited = (room.entry_requirements?.invited || []).filter(id => id !== target)
        if (participants.length === (room.participants || []).length && invited.length === (room.entry_requirements?.invited || []).length) return axyon.send(s, ctx.jid, m, 'That player is not in this squad.')
        await store.updateRoom(room.room_key, { participants, entryRequirements: { ...room.entry_requirements, invited } })
        return axyon.send(s, ctx.jid, m, `Removed @${target.split('@')[0]} from the squad.`)
      }
      if (action === 'disband') {
        if (!leader(room) && membership.member_role !== 'leader' && !ctx.auth.axyon) return axyon.send(s, ctx.jid, m, 'Only the squad creator or Guild Leader can disband this squad.')
        await store.updateRoom(room.room_key, { status: 'cancelled', result: 'disbanded' })
        return axyon.send(s, ctx.jid, m, 'Guild squad disbanded. Guild membership and campaign saves remain intact.')
      }
      if (action === 'save') {
        const saveAction = String(args[2] || 'progress').toLowerCase()
        return saveAction === 'status' ? invokeLocal('save', s, m, ctx, ['status'], {})
          : invokeLocal('save', s, m, ctx, ['progress', 'guild'], {})
      }
      if (action === 'login') return invokeLocal('login', s, m, ctx, ['guild', String(args[2] || '')], {})
      if (action === 'logout') return invokeLocal('logout', s, m, ctx, ['guild'], {})
      if (action === 'resume' || action === 'rejoin') return invokeLocal('session', s, m, ctx, ['resume'], {})
      if (action === 'waiting' || action === 'members' || action === 'status' || action === 'leader') {
        const parts = room.participants || []
        const names = []
        for (const part of parts) { const player = await store.player(part.userId); names.push(`• *${player?.name || part.userId}*${part.role === 'leader' ? ' 👑' : ''}`) }
        const waiting = (room.entry_requirements?.invited || []).map(id => `◌ @${id.split('@')[0]} — invited`)
        if (action === 'leader') return axyon.send(s, ctx.jid, m, `👑 Squad Leader: *${(await store.player(room.owner_id))?.name || room.owner_id}*`)
        return axyon.send(s, ctx.jid, m, [W, '', '🛡️ *GUILD CAMPAIGN SQUAD*', '', ...names, ...waiting, '', `Players: *${parts.length}/5*`, `Status: *${room.status}*`, `Room: \`${room.room_key}\``, '', `Invite: *${ctx.prefix}guild squad invite @member*`, `Start: *${ctx.prefix}guild squad start*`].join('\n'))
      }
      return axyon.send(s, ctx.jid, m, `⚔️ *GUILD CAMPAIGN*\n\n${ctx.prefix}guild squad create\n${ctx.prefix}guild squad invite @member\n${ctx.prefix}guild squad join\n${ctx.prefix}guild squad members\n${ctx.prefix}guild squad start\n${ctx.prefix}guild squad save\n${ctx.prefix}guild squad logout`)
    }

    // Campaign shortcuts requested in the mode directory; the existing
    // guild registry commands (list/join/info/members) remain unchanged.
    if (sub === 'login') return invokeLocal('login', s, m, ctx, ['guild', String(args[1] || '')], {})
    if (['story', 'progress', 'chapter', 'floor', 'explore', 'investigate', 'mission', 'objectives', 'map', 'rewards', 'checkpoint', 'save', 'logout', 'rejoin', 'waiting', 'resume'].includes(sub)) {
      const active = await activeRoomFor(ctx)
      if (!active || !String(active.mode_id).startsWith('guild_')) {
        return axyon.send(s, ctx.jid, m, `No active Guild Campaign here. Use *${ctx.prefix}guild squad create* first.`)
      }
      if (['save', 'logout', 'login', 'rejoin', 'waiting', 'resume'].includes(sub)) {
        if (sub === 'save') return invokeLocal('save', s, m, ctx, ['progress', 'guild'], {})
        if (sub === 'logout') return invokeLocal('logout', s, m, ctx, ['guild'], {})
        if (sub === 'login') return invokeLocal('login', s, m, ctx, ['guild', String(args[1] || '')], {})
        if (sub === 'rejoin' || sub === 'resume') return invokeLocal('session', s, m, ctx, ['resume'], {})
        return invokeLocal('session', s, m, ctx, ['members'], {})
      }
      return invokeLocal('session', s, m, ctx, [sub, ...args.slice(1)], {})
    }

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


  /* -------------------------------------------------- adventure command layer */
  /* These commands are additive façades over the existing floor, room, guild,
   * duel, battle, player and inventory engines. `!floor` and `!choice` remain
   * the canonical narrative/decision flow. */
  function modeLabel (mode) { return adventure.MODES[mode]?.name || mode }
  function groupFeatureEnabled (group, feature) {
    return !!group && String(group.status || '').toUpperCase() === 'ACTIVE' && group.enabled !== false &&
      Array.isArray(group.features) && group.features.includes(feature)
  }
  async function registeredGroupFor (ctx, feature) {
    if (!String(ctx.jid).endsWith('@g.us')) throw new Error('This adventure mode must be started inside its registered WhatsApp group.')
    const row = await store.group(ctx.jid)
    if (!row || String(row.status || '').toUpperCase() !== 'ACTIVE' || row.enabled === false) throw new Error('This WhatsApp group is not actively registered with AXYON.')
    if (feature && !groupFeatureEnabled(row, feature)) throw new Error(`This group needs the *${feature}* feature enabled. Ask AXYON to configure its registration.`)
    return row
  }
  async function isLiveGroupAdmin (sock, ctx) {
    if (!String(ctx.jid).endsWith('@g.us') || typeof sock.groupMetadata !== 'function') return false
    try {
      const meta = await withTimeout(sock.groupMetadata(ctx.jid), GROUP_META_TIMEOUT_MS)
      const digits = value => String(value || '').split('@')[0].replace(/\D/g, '')
      const self = digits(ctx.userId)
      const participant = (meta?.participants || []).find(p => digits(p.id || p.jid) === self)
      return !!participant && (participant.admin === 'admin' || participant.admin === 'superadmin')
    } catch { return false }
  }
  function roomModeMatch (room, mode) {
    if (!room) return false
    if (mode === 'guild') return String(room.mode_id).startsWith('guild_')
    if (mode === 'duel') return room.mode_id === 'duel'
    if (mode === 'abyss') return room.mode_id === 'abyss'
    if (mode === 'multiplayer') return room.mode_id === 'dungeon' && room.participation === 'multiplayer'
    return room.participation === 'solo'
  }
  async function createModeRoom (sock, m, ctx, mode, participation = null) {
    const locked = await adventure.modeLock(mode)
    if (locked.locked) throw new Error(`${modeLabel(mode)} is locked.${locked.reason ? ` Reason: ${locked.reason}` : ''}`)
    const player = await store.player(ctx.userId)
    if (!player) throw new Error(`Use *${ctx.prefix}arise* first.`)
    const existing = await activeRoomFor(ctx)
    if (existing) throw new Error(`You already have an open session in this chat: *${existing.name}* (\`${existing.room_key}\`). Use *${ctx.prefix}session* to inspect it.`)
    let group = null
    let modeId = 'dungeon'
    let type = participation || (mode === 'multiplayer' ? 'multiplayer' : 'solo')
    let capacity = 1
    let name = modeLabel(mode)
    let entryRequirements = { adventureMode: mode }
    if (mode === 'solo') {
      // Solo Chronicles deliberately uses the existing floor story engine.
      return { solo: true }
    }
    if (mode === 'multiplayer') {
      group = await registeredGroupFor(ctx, null)
      if (!groupFeatureEnabled(group, 'dungeon') && !groupFeatureEnabled(group, 'combat')) throw new Error('The registered group needs the combat or dungeon feature enabled.')
      modeId = 'dungeon'; type = 'multiplayer'; capacity = 3
    } else if (mode === 'guild') {
      group = await registeredGroupFor(ctx, 'dungeon')
      const membership = await store.guildForUser(ctx.userId)
      if (!membership) throw new Error('Join a guild before starting a Guild Campaign.')
      if (String(membership.group_jid || '') !== String(ctx.jid)) throw new Error('The campaign must run inside your guild’s linked WhatsApp group.')
      modeId = 'guild_1'; type = 'party'; capacity = 5
      entryRequirements.guildId = Number(membership.id)
      entryRequirements.invited = [ctx.userId]
    } else if (mode === 'duel') {
      group = await registeredGroupFor(ctx, 'duel')
      if (group.registration_mode !== 'duel' && !(group.features || []).includes('duel')) throw new Error('Duel Chronicles require a registered Duel Group.')
      modeId = 'duel'; type = 'multiplayer'; capacity = 2
      entryRequirements.invited = [ctx.userId]
    } else if (mode === 'abyss') {
      if (type === 'party') {
        group = await registeredGroupFor(ctx, 'dungeon')
        capacity = 5
        entryRequirements.invited = [ctx.userId]
      } else if (type === 'multiplayer') {
        group = await registeredGroupFor(ctx, null)
        if (!groupFeatureEnabled(group, 'combat') && !groupFeatureEnabled(group, 'dungeon')) throw new Error('The registered group needs the combat or dungeon feature enabled.')
        capacity = 3
        entryRequirements.invited = [ctx.userId]
      } else { type = 'solo'; capacity = 1 }
      modeId = 'abyss'
    }
    const room = await store.createRoom({
      name: `${name.toUpperCase()} — ${String(Date.now()).slice(-4)}`,
      groupJid: ctx.jid, ownerId: ctx.userId, modeId, participation: type,
      privacy: 'public', capacity,
      entryRequirements
    })
    await store.log(ctx.userId, 'adventure_mode_enter', room.room_key, { mode, participation: type, group: ctx.jid })
    return { solo: false, room, mode, group }
  }
  async function adventureDirectory (sock, m, ctx, args = []) {
    const sub = String(args[0] || 'list').toLowerCase()
    const valid = Object.keys(adventure.MODES)
    if (sub === 'help') return axyon.send(sock, ctx.jid, m, [
      W, '', '⚔️ *ADVENTURE MODE DIRECTORY*', '',
      '`!mode list` · Available modes', '`!mode info <mode>` · Rules and participant limits',
      '`!mode enter <mode> [party|multiplayer|solo]` · Open a session', '`!mode start <mode>` · Start a waiting session',
      '`!mode status` · Current mode and lock status', '`!mode leave` · Leave the current session',
      '`!mode save progress <mode>` · Save a session', '`!mode login <save-code>` · Restore a save',
      '', '*Modes:* solo · multiplayer · guild · duel · abyss',
      '', 'Solo Chapters continue to use the established `!floor` and `!choice` story system.'
    ].join('\n'))
    if (sub === 'list' || sub === 'modes') {
      const locks = await adventure.getModeLocks()
      return axyon.send(sock, ctx.jid, m, [W, '', '⚔️ *AVAILABLE ADVENTURES*', '', ...valid.map(id => {
        const lock = locks.find(x => x.mode === id)
        return `${lock?.locked ? '🔒' : '🟢'} *${modeLabel(id)}* — ${id}\n   ${adventure.MODES[id].maxPlayers} max participant(s)${lock?.reason ? ` · ${lock.reason}` : ''}`
      }), '', `Details: *${ctx.prefix}mode info <mode>*`].join('\n'))
    }
    if (sub === 'info') {
      const mode = adventure.cleanMode(args[1])
      if (!mode) return axyon.send(sock, ctx.jid, m, `Choose one: ${valid.join(', ')}`)
      const lock = await adventure.modeLock(mode)
      const details = {
        solo: 'One player. Uses the existing floor campaign and four-choice decision engine.',
        multiplayer: 'A shared group room for 2–3 players. The existing room lifecycle controls entry and start.',
        guild: 'A 2–5 member campaign squad in its registered guild group. Guild membership is verified.',
        duel: 'A two-player room in a registered Duel Group. Existing direct duel challenges remain available.',
        abyss: 'Advanced exploration room for Solo, Multiplayer or Party participation.'
      }
      return axyon.send(sock, ctx.jid, m, `${W}\n\n⚔️ *${modeLabel(mode).toUpperCase()}*\n\n${details[mode]}\n\nParticipants: *1–${adventure.MODES[mode].maxPlayers}*\nStatus: *${lock.locked ? 'LOCKED' : 'AVAILABLE'}*${lock.reason ? `\nReason: ${lock.reason}` : ''}`)
    }
    if (sub === 'progress' || sub === 'checkpoint') {
      const active = await activeRoomFor(ctx)
      if (active) return invokeLocal('session', sock, m, ctx, [sub], {})
      return invokeLocal('solo', sock, m, ctx, [sub], {})
    }
    if (sub === 'status') {
      const locks = await adventure.getModeLocks()
      const active = await activeRoomFor(ctx)
      return axyon.send(sock, ctx.jid, m, [W, '', '⌘ *ADVENTURE STATUS*', '', `Current session: ${active ? `*${active.name}* · ${active.status}` : 'None'}`, '', ...locks.map(x => `${x.locked ? '🔒' : '✅'} ${x.mode.toUpperCase()}${x.reason ? ` — ${x.reason}` : ''}`)].join('\n'))
    }
    if (sub === 'locks') {
      const locks = await adventure.getModeLocks()
      return axyon.send(sock, ctx.jid, m, [W, '', '🔐 *MODE LOCKS*', '', ...locks.map(x => `${x.locked ? '🔒 LOCKED' : '🔓 OPEN'} · *${x.mode.toUpperCase()}*${x.reason ? `\n   ${x.reason}` : ''}`)].join('\n'))
    }
    if (sub === 'save') {
      const action = String(args[1] || 'progress').toLowerCase()
      if (action === 'progress') return invokeLocal('save', sock, m, ctx, ['progress', args[2] || ''], {})
      if (action === 'status' || action === 'code') return invokeLocal('save', sock, m, ctx, [action], {})
      return axyon.send(sock, ctx.jid, m, `Usage: *${ctx.prefix}mode save progress <mode>|status|code*`)
    }
    if (sub === 'lock' && ['info', 'reason'].includes(String(args[1] || '').toLowerCase())) {
      if (!ctx.auth.axyon && !ctx.auth.rhm) return axyon.send(sock, ctx.jid, m, '🛡️ Only AXYON or RHM can inspect or change mode locks.')
      const action = String(args[1]).toLowerCase()
      const mode = adventure.cleanMode(args[2])
      if (!mode) return axyon.send(sock, ctx.jid, m, `Choose one: ${valid.join(', ')}`)
      if (action === 'info') {
        const lock = await adventure.modeLock(mode)
        return axyon.send(sock, ctx.jid, m, `${W}\n\n🔐 *${mode.toUpperCase()} LOCK*\nStatus: *${lock.locked ? 'LOCKED' : 'OPEN'}*\nReason: ${lock.reason || 'None recorded'}\nChanged by: ${lock.changed_by || '—'}\nUpdated: ${lock.updated_at || '—'}`)
      }
      const reason = args.slice(3).join(' ').trim()
      if (!reason) return axyon.send(sock, ctx.jid, m, `Usage: *${ctx.prefix}mode lock reason <mode> <reason>*`)
      const row = await adventure.setModeLock(mode, true, reason, ctx.userId)
      await store.log(ctx.userId, 'adventure_mode_lock_reason', mode, { reason })
      return axyon.send(sock, ctx.jid, m, `🔒 *${mode.toUpperCase()} LOCK REASON UPDATED*\n${row.reason}`)
    }
    if (sub === 'lock' || sub === 'unlock') {
      if (!ctx.auth.axyon && !ctx.auth.rhm) return axyon.send(sock, ctx.jid, m, '🛡️ Only AXYON or RHM can lock adventure modes.')
      const mode = String(args[1] || '').toLowerCase()
      const lockAll = mode === 'all'
      const validModes = lockAll ? valid : [adventure.cleanMode(mode)].filter(Boolean)
      if (!validModes.length) return axyon.send(sock, ctx.jid, m, `Usage: *${ctx.prefix}mode ${sub} <${valid.join('|')}|all> [reason]*`)
      const reason = args.slice(2).join(' ')
      const rows = []
      for (const id of validModes) rows.push(await adventure.setModeLock(id, sub === 'lock', reason, ctx.userId))
      await store.log(ctx.userId, `adventure_modes_${sub}`, mode, { reason, modes: validModes })
      return axyon.send(sock, ctx.jid, m, `${W}\n\n${sub === 'lock' ? '🔒' : '🔓'} *MODES ${sub.toUpperCase()}ED*\n\n${rows.map(x => `• ${x.mode.toUpperCase()}${x.reason ? ` — ${x.reason}` : ''}`).join('\n')}`)
    }
    if (sub === 'lock-info') {
      const mode = adventure.cleanMode(args[1]); if (!mode) return axyon.send(sock, ctx.jid, m, `Choose one: ${valid.join(', ')}`)
      const lock = await adventure.modeLock(mode)
      return axyon.send(sock, ctx.jid, m, `${W}\n\n*${mode.toUpperCase()}*\n${lock.locked ? '🔒 LOCKED' : '🔓 OPEN'}\nReason: ${lock.reason || 'None recorded'}\nChanged by: ${lock.changed_by || '—'}`)
    }
    if (sub === 'enter' || sub === 'start') {
      const mode = adventure.cleanMode(args[1])
      if (!mode) return axyon.send(sock, ctx.jid, m, `Usage: *${ctx.prefix}mode ${sub} <${valid.join('|')}>`)
      const lock = await adventure.modeLock(mode)
      if (lock.locked) return axyon.send(sock, ctx.jid, m, `🔒 *${mode.toUpperCase()}* is locked.${lock.reason ? `\n${lock.reason}` : ''}`)
      if (mode === 'solo') {
        if (sub === 'start' || sub === 'enter') {
          const existingBattle = await store.getBattle(ctx.userId)
          if (existingBattle?.mode === 'floor') return axyon.send(sock, ctx.jid, m, `You already have an active floor encounter. Continue with *${ctx.prefix}battle* or save with *${ctx.prefix}save progress solo*.`)
          return invokeLocal('floor', sock, m, ctx, [String(args[2] || '1')], {})
        }
      }
      // These two modes already have mature, separate lifecycle handlers.
      // Route the directory facade into them instead of creating a duplicate room.
      if (mode === 'multiplayer') return invokeLocal('party', sock, m, ctx, [sub === 'enter' ? 'create' : 'start'], {})
      if (mode === 'guild') return invokeLocal('guild', sock, m, ctx, ['squad', sub === 'enter' ? 'create' : 'start'], {})
      if (sub === 'start') {
        const rooms = await store.roomsFor(ctx.jid)
        const room = rooms.find(r => roomModeMatch(r, mode) && String(r.owner_id) === String(ctx.userId) && ['waiting', 'ready', 'paused'].includes(String(r.status)))
        if (!room) return axyon.send(sock, ctx.jid, m, `No waiting ${modeLabel(mode)} session found. Enter it first with *${ctx.prefix}mode enter ${mode}*.`)
        return invokeLocal('room', sock, m, ctx, ['start', room.room_key], {})
      }
      try {
        const result = await createModeRoom(sock, m, ctx, mode, String(args[2] || '').toLowerCase() || null)
        if (result.solo) return invokeLocal('floor', sock, m, ctx, [String(args[2] || '1')], {})
        return axyon.send(sock, ctx.jid, m, [W, '', `🧭 *${modeLabel(mode).toUpperCase()} SESSION OPENED*`, '', `Session: *${result.room.name}*`, `Mode: *${mode}* · Type: *${result.room.participation}*`, `Players: *1/${result.room.capacity}*`, `Session key: \`${result.room.room_key}\``, '', `Join with *${ctx.prefix}room join ${result.room.room_key}*`, `Start with *${ctx.prefix}mode start ${mode}*`].join('\n'))
      } catch (error) { return axyon.send(sock, ctx.jid, m, `❌ ${error.message}`) }
    }
    if (sub === 'leave') return invokeLocal('mode', sock, m, ctx, ['logout'], {})
    if (sub === 'logout') return invokeLocal('logout', sock, m, ctx, [String(args[1] || '')], {})
    if (sub === 'login') return invokeLocal('login', sock, m, ctx, args.slice(1), {})
    return axyon.send(sock, ctx.jid, m, `Usage: *${ctx.prefix}mode list|info <mode>|enter <mode>|start <mode>|status|leave|login <code>|lock|unlock|locks*`)
  }

  cmd('mode', 'dungeon', '{p}mode <list|info|enter|start|status|leave|login|logout|lock|unlock|locks>', 'Adventure mode directory and session controls; separate from the existing !modes admin configuration.', async (s, m, ctx, args) => adventureDirectory(s, m, ctx, args))

  cmd('solo', 'dungeon', '{p}solo <start|continue|story|progress|chapter|floor|explore|investigate|mission|objectives|map|inventory|rewards|checkpoint|save|logout|login>', 'Solo Chronicles commands mapped to the existing floor-story engine.', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'help').toLowerCase()
    if (sub === 'start' || sub === 'floor') return invokeLocal('floor', s, m, ctx, [String(args[1] || '1')], {})
    if (sub === 'continue') return invokeLocal('battle', s, m, ctx, [], {})
    if (sub === 'story') return invokeLocal('story', s, m, ctx, ['recap'], {})
    if (sub === 'progress' || sub === 'chapter' || sub === 'checkpoint') {
      const b = storyBattle(await store.getBattle(ctx.userId)); const state = await store.floorStory(ctx.userId)
      if (!b) return axyon.send(s, ctx.jid, m, `No active Solo floor. Start with *${ctx.prefix}solo start*.`)
      const ch = floorStory.chapterFor(b.ordinal)
      return axyon.send(s, ctx.jid, m, `${W}\n\n📖 *SOLO CHRONICLES*\n\nChapter: *${b.ordinal} — ${ch.title}*\nFloor: *${b.ordinal}*\nLocation: *${b.location || ch.place}*\nObjectives: *${floorStory.objectives(state).length}*\nCheckpoint: *${b.ordinal}*`)
    }
    if (sub === 'explore') return invokeLocal('explore', s, m, ctx, args.slice(1), {})
    if (sub === 'investigate') return invokeLocal('investigate', s, m, ctx, args.slice(1), {})
    if (sub === 'mission' || sub === 'objectives') return invokeLocal('mission', s, m, ctx, args.slice(1), {})
    if (sub === 'map') return invokeLocal('map', s, m, ctx, [], {})
    if (sub === 'inventory') return invokeLocal('inventory', s, m, ctx, [], {})
    if (sub === 'rewards') return axyon.send(s, ctx.jid, m, `Use *${ctx.prefix}quest* to view NPC quest rewards. Completed rewards are claimed with *${ctx.prefix}quest claim <id>*.`)
    if (sub === 'save') {
      const saveAction = String(args[1] || 'progress').toLowerCase()
      return saveAction === 'status' ? invokeLocal('save', s, m, ctx, ['status'], {})
        : invokeLocal('save', s, m, ctx, ['progress', 'solo'], {})
    }
    if (sub === 'logout') return invokeLocal('logout', s, m, ctx, ['solo'], {})
    if (sub === 'login') return invokeLocal('login', s, m, ctx, [String(args[1] || '')], {})
    return axyon.send(s, ctx.jid, m, `⌘ *SOLO CHRONICLES*\n\n${ctx.prefix}solo start [floor]\n${ctx.prefix}solo continue\n${ctx.prefix}solo story\n${ctx.prefix}solo explore\n${ctx.prefix}solo investigate <target>\n${ctx.prefix}solo mission\n${ctx.prefix}solo save\n${ctx.prefix}solo logout`)
  })

  cmd('abyss', 'dungeon', '{p}abyss <start|continue|story|progress|chapter|floor|explore|investigate|events|discoveries|threats|loot|rewards|checkpoint|save|logout|login>', 'Abyssal Frontier exploration sessions.', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'help').toLowerCase()
    if (sub === 'start' || sub === 'continue') {
      if (sub === 'continue') {
        const room = await activeRoomFor(ctx)
        if (room?.mode_id === 'abyss') return axyon.send(s, ctx.jid, m, `${W}\n\n🌌 *ABYSSAL FRONTIER*\n\n${room.name}\nStatus: *${room.status}*\nUse *${ctx.prefix}session resume* when paused or *${ctx.prefix}room view ${room.room_key}* for details.`)
      }
      return adventureDirectory(s, m, ctx, ['enter', 'abyss', String(args[1] || 'solo')])
    }
    const abyssRoom = await activeRoomFor(ctx)
    if (abyssRoom?.mode_id === 'abyss' && ['story', 'progress', 'chapter', 'floor', 'checkpoint', 'explore', 'investigate', 'mission', 'objectives', 'map', 'discoveries', 'events', 'characters', 'location'].includes(sub)) {
      return invokeLocal('session', s, m, ctx, [sub === 'events' ? 'history' : sub, ...args.slice(1)], {})
    }
    if (sub === 'story' || sub === 'progress' || sub === 'chapter' || sub === 'floor' || sub === 'checkpoint') return invokeLocal('story', s, m, ctx, ['recap'], {})
    if (sub === 'explore') return invokeLocal('explore', s, m, ctx, [], {})
    if (sub === 'investigate') return invokeLocal('investigate', s, m, ctx, args.slice(1), {})
    if (sub === 'discoveries') return invokeLocal('discoveries', s, m, ctx, [], {})
    if (sub === 'events') return axyon.send(s, ctx.jid, m, 'Abyss event entries unlock from the active exploration engine. No additional event table is configured yet.')
    if (sub === 'threats') return invokeLocal('fight', s, m, ctx, ['enemies'], {})
    if (sub === 'loot' || sub === 'rewards') return invokeLocal('inventory', s, m, ctx, [], {})
    if (sub === 'save') {
      const saveAction = String(args[1] || 'progress').toLowerCase()
      return saveAction === 'status' ? invokeLocal('save', s, m, ctx, ['status'], {})
        : invokeLocal('save', s, m, ctx, ['progress', 'abyss'], {})
    }
    if (sub === 'logout') return invokeLocal('logout', s, m, ctx, ['abyss'], {})
    if (sub === 'login') return invokeLocal('login', s, m, ctx, [String(args[1] || '')], {})
    return axyon.send(s, ctx.jid, m, `⌘ *ABYSSAL FRONTIER*\n\n${ctx.prefix}abyss start [solo|multiplayer|party]\n${ctx.prefix}abyss explore\n${ctx.prefix}abyss investigate <target>\n${ctx.prefix}abyss discoveries\n${ctx.prefix}abyss save`)
  })

  cmd('save', 'dungeon', '{p}save [progress|code|status|list|delete] ...', 'Save and manage adventure checkpoints.', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'help').toLowerCase()
    if (sub === 'progress' || sub === 'code') {
      const requested = sub === 'progress' ? args[1] : null
      try {
        const row = await createAdventureSave(ctx, requested)
        await store.log(ctx.userId, 'adventure_save', row.code, { mode: row.mode })
        return axyon.send(s, ctx.jid, m, `${W}\n\n💾 *ADVENTURE SAVED*\n\nMode: *${row.mode.toUpperCase()}*\nSave Code: \`${row.code}\`\nParticipants: *${(row.participants || []).length}*\n\nKeep this code private. It identifies the session; player identity is still checked on login.`)
      } catch (error) { return axyon.send(s, ctx.jid, m, `❌ ${error.message}`) }
    }
    if (sub === 'status') {
      const row = await adventure.latestSave(ctx.userId)
      return axyon.send(s, ctx.jid, m, row ? `${W}\n\n💾 *LATEST SAVE*\n${row.mode.toUpperCase()} · \`${row.code}\`\nUpdated: ${row.updated_at}` : 'No saved adventure found for your account.')
    }
    if (sub === 'history') return invokeLocal('save', s, m, ctx, ['list'], {})
    if (sub === 'checkpoint') {
      try {
        const row = await createAdventureSave(ctx, args[1] || null)
        await store.log(ctx.userId, 'adventure_checkpoint_save', row.code, { mode: row.mode })
        return axyon.send(s, ctx.jid, m, `${W}\n\n📍 *CHECKPOINT SAVED*\n\n${row.mode.toUpperCase()} · \`${row.code}\``)
      } catch (error) { return axyon.send(s, ctx.jid, m, `❌ ${error.message}`) }
    }
    if (sub === 'info') {
      const code = String(args[1] || '').trim().toUpperCase()
      if (!code) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}save info <code>*`)
      const row = await adventure.getSave(code)
      const participants = Array.isArray(row?.participants) ? row.participants.map(String) : []
      if (!row || !participants.includes(String(ctx.userId))) return axyon.send(s, ctx.jid, m, 'Save not found, or you are not listed as a participant.')
      return axyon.send(s, ctx.jid, m, `${W}\n\n💾 *SAVE INFORMATION*\n\nMode: *${row.mode.toUpperCase()}*\nCode: \`${row.code}\`\nStatus: *${row.status}*\nParticipants: *${participants.length}*\nCreated: ${row.created_at}\nUpdated: ${row.updated_at}`)
    }
    if (sub === 'list') {
      const rows = await adventure.listSaves(ctx.userId)
      return axyon.send(s, ctx.jid, m, rows.length ? [W, '', '💾 *YOUR SAVED ADVENTURES*', '', ...rows.map(r => `• *${r.mode.toUpperCase()}* — \`${r.code}\` · ${r.updated_at}`)].join('\n') : 'No saved adventures yet.')
    }
    if (sub === 'delete') {
      const code = String(args[1] || '').toUpperCase()
      if (!code || String(args[2] || '').toLowerCase() !== 'confirm') return axyon.send(s, ctx.jid, m, `Confirm deletion with *${ctx.prefix}save delete <code> confirm*. This only deletes your own save record.`)
      const ok = await adventure.deleteSave(code, ctx.userId)
      return axyon.send(s, ctx.jid, m, ok ? `🗑️ Save \`${code}\` deleted.` : 'Save not found or it does not belong to you.')
    }
    return axyon.send(s, ctx.jid, m, `💾 *SAVE SYSTEM*\n\n${ctx.prefix}save progress [mode]\n${ctx.prefix}save checkpoint [mode]\n${ctx.prefix}save status\n${ctx.prefix}save list|history\n${ctx.prefix}save info <code>\n${ctx.prefix}save delete <code> confirm`)
  })

  cmd('login', 'dungeon', '{p}login [mode] <save-code>', 'Restore an adventure session from a save code.', async (s, m, ctx, args) => {
    const modeArg = adventure.cleanMode(args[0])
    const code = modeArg ? args[1] : args[0]
    if (!code) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}login <save-code>* or *${ctx.prefix}login <mode> <save-code>*`)
    try {
      const result = await restoreAdventureSave(ctx, code)
      if (modeArg && result.mode !== modeArg) throw new Error(`That save belongs to ${result.mode}, not ${modeArg}.`)
      await store.log(ctx.userId, 'adventure_login', result.code, { mode: result.mode })
      if (result.restored) return axyon.send(s, ctx.jid, m, `${W}\n\n✅ *${modeLabel(result.mode).toUpperCase()} RESTORED*\n\nSave: \`${result.code}\`\nYour player, active floor battle and story journal have been restored.`)
      return axyon.send(s, ctx.jid, m, `${W}\n\n✅ *${modeLabel(result.mode).toUpperCase()} SESSION FOUND*\n\nSave: \`${result.code}\`\nRoom: *${result.room.name}*\nStatus: *${result.room.status}*\nUse *${ctx.prefix}session resume* when the required participants have returned.`)
    } catch (error) { return axyon.send(s, ctx.jid, m, `❌ ${error.message}`) }
  })

  cmd('logout', 'dungeon', '{p}logout [solo|multiplayer|guild|duel|abyss]', 'Save and exit or pause the current adventure session.', async (s, m, ctx, args) => {
    const mode = adventure.cleanMode(args[0])
    try {
      const row = await createAdventureSave(ctx, mode)
      if (row.mode === 'solo') await store.setBattle(ctx.userId, null)
      else if (row.room_key) {
        const room = await store.room(row.room_key)
        if (room && ['active', 'ready', 'waiting'].includes(String(room.status))) await store.updateRoom(room.room_key, { status: 'paused' })
      }
      await store.log(ctx.userId, 'adventure_logout', row.code, { mode: row.mode })
      return axyon.send(s, ctx.jid, m, `${W}\n\n💤 *${row.mode.toUpperCase()} SAVED & PAUSED*\n\nSave Code: \`${row.code}\`\nYour progress is preserved. Resume with *${ctx.prefix}login ${row.code}*.`)
    } catch (error) { return axyon.send(s, ctx.jid, m, `❌ ${error.message}`) }
  })

  async function sessionStoryAction (room, action, value, ctx) {
    if (!room || !['active', 'paused'].includes(String(room.status))) {
      return { message: 'This shared story is available after the room session has started.' }
    }
    let message = ''
    let failed = false
    const currentRoom = await store.mutateRoomState(room.room_key, state => {
      const campaign = state.campaignStory && typeof state.campaignStory === 'object'
        ? state.campaignStory
        : { ordinal: 1, storyState: floorStory.cleanState(), sceneOpen: false, lastChoice: null }
      campaign.ordinal = Math.max(1, Math.floor(Number(campaign.ordinal) || 1))
      campaign.storyState = floorStory.cleanState(campaign.storyState || {})

      if (action === 'story' || action === 'continue') {
        const scene = floorStory.begin(campaign.ordinal, campaign.storyState)
        campaign.sceneOpen = true
        message = scene.text
      } else if (action === 'choose' || action === 'choice') {
        if (!campaign.sceneOpen) { failed = true; message = `There is no pending shared story decision. Use *${ctx.prefix}session story* first.` }
        else {
          const picked = floorStory.choose(campaign.ordinal, value, campaign.storyState)
          if (!picked.ok) { failed = true; message = picked.message }
          else {
            campaign.storyState = picked.state
            campaign.lastChoice = { chapter: picked.chapter.title, label: picked.choice.label, by: ctx.userId, at: new Date().toISOString() }
            campaign.ordinal += 1
            campaign.sceneOpen = false
            message = `${picked.message}\n\nThe shared decision is recorded. Continue with *${ctx.prefix}session story* when the party is ready.`
          }
        }
      } else if (action === 'explore') {
        if (!campaign.sceneOpen) { failed = true; message = `Open the current chapter with *${ctx.prefix}session story* first.` }
        else { const r = floorStory.explore(campaign.ordinal, campaign.storyState); campaign.storyState = r.state; message = r.message }
      } else if (action === 'investigate') {
        if (!campaign.sceneOpen) { failed = true; message = `Open the current chapter with *${ctx.prefix}session story* first.` }
        else { const r = floorStory.investigate(campaign.ordinal, value, campaign.storyState); campaign.storyState = r.state; message = r.message }
      } else if (action === 'talk' || action === 'interact') {
        if (!campaign.sceneOpen) { failed = true; message = `Open the current chapter with *${ctx.prefix}session story* first.` }
        else { const r = floorStory.talk(campaign.ordinal, value, campaign.storyState); if (!r.ok) failed = true; else campaign.storyState = r.state; message = r.message }
      } else if (action === 'recap' || action === 'history') {
        const rows = campaign.storyState.history || []
        message = rows.length ? [W, '', '📖 *SHARED STORY RECAP*', '', ...rows.slice(-10).map((r, i) => `${i + 1}. Chapter ${r.floor} — *${r.chapter}*\n   Decision: ${r.choice}\n   By: ${r.by || 'party'}`)].join('\n\n') : 'The shared story journal is empty. Begin with *!session story*.'
      } else if (action === 'objectives' || action === 'mission') {
        const rows = floorStory.objectives(campaign.storyState)
        message = rows.length ? [W, '', '🎯 *SHARED OBJECTIVES*', '', ...rows.map(q => `${q.status === 'complete' ? '✅' : q.status === 'claimed' ? '🏅' : '▫️'} *${q.name}*\n${q.objective}`)].join('\n\n') : 'No shared NPC side quests have been unlocked yet.'
      } else if (action === 'map' || action === 'location' || action === 'chapter' || action === 'floor' || action === 'progress') {
        const chapter = floorStory.chapterFor(campaign.ordinal)
        message = `${W}\n\n🗺️ *${chapter.title.toUpperCase()}*\n\nLocation: *${chapter.place}*\nNPC: *${chapter.npc}*\nChapter: *${campaign.ordinal}*\nDecision: *${campaign.sceneOpen ? 'Awaiting party choice' : 'Not opened'}*\nDiscoveries: *${campaign.storyState.discoveries.length}*\nObjectives: *${floorStory.objectives(campaign.storyState).length}*`
      } else if (action === 'discoveries') {
        const rows = [...campaign.storyState.discoveries, ...campaign.storyState.investigations]
        message = rows.length ? [W, '', '🔎 *SHARED DISCOVERIES*', '', ...rows.slice(-25).map(x => `• ${x}`)].join('\n') : 'No shared discoveries have been recorded yet.'
      } else if (action === 'characters') {
        const chapter = floorStory.chapterFor(campaign.ordinal)
        message = `👥 *CHAPTER CHARACTERS*\n\n• ${chapter.npc}\n\nRecorded conversations: *${campaign.storyState.npcContacts.length}*`
      } else if (action === 'skip') {
        failed = true; message = campaign.sceneOpen ? 'This chapter has a required decision. Choose one of the four options; it cannot be skipped.' : 'There is no open shared scene to skip.'
      } else {
        failed = true; message = `Unknown shared story action. Use *${ctx.prefix}session story|choose|explore|investigate|talk|recap|objectives|map*.`
      }
      state.campaignStory = campaign
      return state
    })
    if (!currentRoom) return { message: 'The session room no longer exists.' }
    if (!failed) await store.log(ctx.userId, `session_story_${action}`, room.room_key, { ordinal: currentRoom.state?.campaignStory?.ordinal })
    return { message }
  }

  cmd('session', 'dungeon', '{p}session <status|members|save|leave|resume|code|story|choose|explore|investigate|talk|recap|objectives|map>', 'Inspect the active room session and its shared campaign story.', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'status').toLowerCase()
    const room = await activeRoomFor(ctx)
    if (!room) return axyon.send(s, ctx.jid, m, `No active room session in this chat. Enter with *${ctx.prefix}mode enter <mode>*.`)
    if (['story', 'continue', 'choose', 'choice', 'explore', 'investigate', 'talk', 'interact', 'recap', 'history', 'objectives', 'mission', 'map', 'location', 'chapter', 'floor', 'progress', 'discoveries', 'characters', 'skip'].includes(sub)) {
      const result = await sessionStoryAction(room, sub, args.slice(1).join(' '), ctx)
      return axyon.send(s, ctx.jid, m, result.message)
    }
    if (sub === 'members') return axyon.send(s, ctx.jid, m, [W, '', '👥 *SESSION MEMBERS*', '', ...(room.participants || []).map((p, i) => `${i + 1}. ${p.userId}${p.role === 'leader' ? ' 👑' : ''}`), '', `Capacity: ${room.participants.length}/${room.capacity}`].join('\n'))
    if (sub === 'save' || sub === 'code') return invokeLocal('save', s, m, ctx, ['progress', adventureModeForRoom(room)], {})
    if (sub === 'leave') return invokeLocal('room', s, m, ctx, ['leave', room.room_key], {})
    if (sub === 'resume') {
      if (!['paused', 'waiting', 'ready'].includes(String(room.status))) return axyon.send(s, ctx.jid, m, `This session is ${room.status} and cannot be resumed.`)
      if (String(room.owner_id) !== String(ctx.userId) && !ctx.auth.axyon) return axyon.send(s, ctx.jid, m, 'Only the session leader can resume this session.')
      const updated = await store.updateRoom(room.room_key, { status: 'active' })
      await store.log(ctx.userId, 'adventure_resume', room.room_key)
      return axyon.send(s, ctx.jid, m, `${W}\n\n▶️ *SESSION RESUMED*\n\n${updated.name}`)
    }
    return axyon.send(s, ctx.jid, m, `${W}\n\n🧭 *SESSION STATUS*\n\n${room.name}\nMode: *${adventureModeForRoom(room)}* · ${room.mode_id}\nStatus: *${room.status}*\nPlayers: *${room.participants.length}/${room.capacity}*\nKey: \`${room.room_key}\`\n\nUse *${ctx.prefix}session members* or *${ctx.prefix}session save*.`)
  })

  /* Shared story actions reuse the current persisted floor state. They do not
   * advance or bypass required four-choice decisions. */
  async function currentFloorContext (ctx) {
    const battle = storyBattle(await store.getBattle(ctx.userId))
    if (!battle) return null
    return { battle, state: await store.floorStory(ctx.userId) }
  }
  cmd('continue', 'dungeon', '{p}continue', 'Continue the current story scene or battle.', async (s, m, ctx) => invokeLocal('battle', s, m, ctx, [], {}))
  cmd('explore', 'dungeon', '{p}explore', 'Explore the active floor location and record discoveries.', async (s, m, ctx) => {
    const current = await currentFloorContext(ctx)
    if (!current) return axyon.send(s, ctx.jid, m, `Enter a floor with *${ctx.prefix}floor* first.`)
    const r = floorStory.explore(current.battle.ordinal, current.state)
    await store.saveFloorStory(ctx.userId, r.state)
    return axyon.send(s, ctx.jid, m, r.message)
  })
  cmd('investigate', 'dungeon', '{p}investigate [target]', 'Investigate an object or location in the active floor.', async (s, m, ctx, args) => {
    const current = await currentFloorContext(ctx)
    if (!current) return axyon.send(s, ctx.jid, m, `Enter a floor with *${ctx.prefix}floor* first.`)
    const r = floorStory.investigate(current.battle.ordinal, args.join(' '), current.state)
    await store.saveFloorStory(ctx.userId, r.state)
    return axyon.send(s, ctx.jid, m, r.message)
  })
  cmd('talk', 'dungeon', '{p}talk <character>', 'Speak to the current chapter NPC.', async (s, m, ctx, args) => {
    const current = await currentFloorContext(ctx)
    if (!current) return axyon.send(s, ctx.jid, m, `Enter a floor with *${ctx.prefix}floor* first.`)
    const r = floorStory.talk(current.battle.ordinal, args.join(' '), current.state)
    if (r.ok) await store.saveFloorStory(ctx.userId, r.state)
    return axyon.send(s, ctx.jid, m, r.message)
  })
  cmd('interact', 'dungeon', '{p}interact <target>', 'Interact with a known NPC or object in the current chapter.', async (s, m, ctx, args) => invokeLocal('talk', s, m, ctx, args, {}))
  cmd('mission', 'dungeon', '{p}mission [list|status|abandon <id>|complete]', 'Manage unlocked NPC side quests without bypassing their objectives.', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'list').toLowerCase()
    const state = await store.floorStory(ctx.userId)
    if (sub === 'abandon') {
      const r = floorStory.abandonQuest(state, args[1])
      if (r.ok) await store.saveFloorStory(ctx.userId, r.state)
      return axyon.send(s, ctx.jid, m, r.ok ? `Quest *${r.name}* abandoned.` : r.message)
    }
    if (sub === 'complete') return axyon.send(s, ctx.jid, m, `Quest objectives are completed by the story engine after the associated encounter. Use *${ctx.prefix}quest claim <id>* only when its status is complete.`)
    if (sub === 'status') {
      const rows = floorStory.objectives(state)
      return axyon.send(s, ctx.jid, m, rows.length ? rows.map(q => `${q.name}: *${q.status}*`).join('\n') : 'No unlocked missions yet.')
    }
    return axyon.send(s, ctx.jid, m, floorStory.questList(state))
  })
  cmd('objectives', 'dungeon', '{p}objectives', 'Display active floor and NPC quest objectives.', async (s, m, ctx) => invokeLocal('mission', s, m, ctx, ['status'], {}))
  cmd('map', 'dungeon', '{p}map', 'Display the current chapter location and recorded discoveries.', async (s, m, ctx) => {
    const current = await currentFloorContext(ctx)
    if (!current) return axyon.send(s, ctx.jid, m, 'No active floor map. Enter a floor first.')
    const chapter = floorStory.chapterFor(current.battle.ordinal)
    return axyon.send(s, ctx.jid, m, `🗺️ *${chapter.place.toUpperCase()}*\n\nCurrent chapter: *${chapter.title}*\nArea: ${current.state.discoveries?.includes(`floor_${current.battle.ordinal}_zone`) ? 'Explored' : 'Unexplored'}\nClues: *${(current.state.investigations || []).filter(x => x.startsWith(`floor_${current.battle.ordinal}:`)).length}*`)
  })
  cmd('location', 'dungeon', '{p}location', 'Display the current chapter location.', async (s, m, ctx) => {
    const current = await currentFloorContext(ctx)
    if (!current) return axyon.send(s, ctx.jid, m, 'You are not inside a floor location.')
    const ch = floorStory.chapterFor(current.battle.ordinal)
    return axyon.send(s, ctx.jid, m, `⌖ *${current.battle.location || ch.place}*\n${ch.title}`)
  })
  cmd('discoveries', 'dungeon', '{p}discoveries', 'View recorded discoveries and investigated clues.', async (s, m, ctx) => {
    const state = await store.floorStory(ctx.userId)
    const rows = [...(state.discoveries || []), ...(state.investigations || [])]
    return axyon.send(s, ctx.jid, m, rows.length ? [W, '', '🔎 *DISCOVERIES*', '', ...rows.slice(-30).map(x => `• ${x}`)].join('\n') : 'No discoveries recorded yet. Use *!explore* or *!investigate*.')
  })
  cmd('treasure', 'dungeon', '{p}treasure', 'Inspect treasure discoveries recorded by the current floor.', async (s, m, ctx) => axyon.send(s, ctx.jid, m, 'No dedicated treasure tables are configured yet. Keep exploring and inspect the discoveries journal with *!discoveries*.'))
  cmd('checkpoint', 'dungeon', '{p}checkpoint', 'Display the current story checkpoint.', async (s, m, ctx) => invokeLocal('solo', s, m, ctx, ['checkpoint'], {}))

  /* Combat directory aliases are adapters to existing mechanics, not new
   * damage systems. */
  cmd('move', 'battle', '{p}move <name>', 'Alias for the existing class-move engine.', async (s, m, ctx, args) => invokeLocal('classmove', s, m, ctx, args, {}))
  cmd('weapon', 'battle', '{p}weapon <name>', 'Inspect currently supported weapon equipment.', async (s, m, ctx) => axyon.send(s, ctx.jid, m, 'Weapon-specific combat actions are not yet wired to a separate weapon engine. Your existing equipped battle cards and class moves remain available.'))
  cmd('target', 'battle', '{p}target <enemy>', 'Select the current encounter target.', async (s, m, ctx) => invokeLocal('fight', s, m, ctx, ['info'], {}))
  cmd('targets', 'battle', '{p}targets', 'List targets in the current encounter.', async (s, m, ctx) => invokeLocal('fight', s, m, ctx, ['enemies'], {}))
  cmd('hp', 'battle', '{p}hp', 'Display current HP.', async (s, m, ctx) => {
    const p = await store.player(ctx.userId); return axyon.send(s, ctx.jid, m, `❤️ HP: *${p.hp}/${p.maxHp}*`)
  })
  cmd('energy', 'battle', '{p}energy', 'Display current Power Energy.', async (s, m, ctx) => {
    const p = await store.player(ctx.userId); return axyon.send(s, ctx.jid, m, `⚡ Power Energy: *${p.powerEnergy}/${p.maxPowerEnergy}*`)
  })
  cmd('cooldowns', 'battle', '{p}cooldowns', 'Display remaining class-move and card ability uses.', async (s, m, ctx) => {
    const b = await store.getBattle(ctx.userId)
    const moves = await store.classMovesUsedToday(ctx.userId).catch(() => 0)
    const cards = typeof store.cardAbilityUsage === 'function'
      ? await store.cardAbilityUsage(ctx.userId).catch(() => null)
      : null
    return axyon.send(s, ctx.jid, m, `⏱️ *COMBAT AVAILABILITY*\n\nClass moves used today: *${moves}*\nBattle: *${b ? 'Active' : 'No active battle'}*${cards ? `\nCard abilities: ${JSON.stringify(cards)}` : ''}`)
  })
  cmd('fightstatus', 'battle', '{p}fightstatus', 'Inspect the current fight without starting a new one.', async (s, m, ctx) => invokeLocal('fight', s, m, ctx, ['status'], {}), { hidden: true })

  if (!axyon.COMMANDS.some(c => c.name === 'boss')) {
    cmd('boss', 'battle', '{p}boss [inspect|status|rewards]', 'Inspect the current boss encounter without starting a new fight.', async (s, m, ctx, args) => {
      const sub = String(args[0] || 'status').toLowerCase()
      const battle = await store.getBattle(ctx.userId)
      const enemy = battle?.enemy
      if (!battle || !enemy || !enemy.boss) return axyon.send(s, ctx.jid, m, 'No active boss encounter. Boss encounters are opened by the campaign or an eligible boss stage.')
      if (sub === 'rewards') return axyon.send(s, ctx.jid, m, 'Boss rewards are granted by the existing encounter completion flow; they cannot be claimed before victory.')
      const player = await store.player(ctx.userId)
      return axyon.send(s, ctx.jid, m, `${W}\n\n👑 *BOSS ${sub === 'inspect' ? 'INSPECTION' : 'STATUS'}*\n\n*${enemy.name || 'Unknown Guardian'}*\nHP: *${battle.enemyHp ?? enemy.hp}*\nLocation: *${battle.location || 'Unknown'}*\nTurn: *${battle.turn || 1}*\nYour HP: *${player?.hp ?? battle.playerHp}*`)
    })
  }
  if (!axyon.COMMANDS.some(c => c.name === 'rewards')) {
    cmd('rewards', 'dungeon', '{p}rewards', 'Review earned NPC quest rewards and their claim status.', async (s, m, ctx) => {
      const state = await store.floorStory(ctx.userId)
      const rows = floorStory.objectives(state)
      if (!rows.length) return axyon.send(s, ctx.jid, m, 'No NPC quest rewards have been unlocked yet. Continue the floor story and speak with its characters.')
      const lines = rows.map(q => `${q.status === 'claimed' ? '🏅' : q.status === 'complete' ? '✅' : '▫️'} *${q.name}* — ${q.status}${q.status === 'complete' ? `\nClaim with *${ctx.prefix}quest claim ${q.id}*` : ''}`)
      return axyon.send(s, ctx.jid, m, [W, '', '🎁 *ADVENTURE REWARDS*', '', ...lines].join('\n\n'))
    })
  }

  /* Group collaboration system, adapted from the provided standalone package
   * to AXYON group registration, live WhatsApp admin checks and PostgreSQL. */
  cmd('collab', 'social', '{p}collab <list|create|submit|info|approve|start|pause|resume|end|group|join|leave|event|mission|reward|stats|leaderboard>', 'Create cross-group collaborations with verified groups, missions, events and shared rewards.', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'help').toLowerCase()
    const isOwner = !!ctx.auth.axyon
    const groupJid = String(ctx.jid || '')
    const inGroup = groupJid.endsWith('@g.us')
    const ensureCollabGroup = async () => {
      const g = await registeredGroupFor(ctx, 'collab')
      return g
    }
    const format = c => `*#${c.id} ${c.title}* — ${String(c.status).toUpperCase()}\n${c.description || 'No description.'}\nGroups: ${(c.groups || []).length} · Participants: ${c.participant_count || 0}`
    try {
      if (sub === 'list') {
        const rows = await collab.list(args[1] || null)
        return axyon.send(s, ctx.jid, m, rows.length ? [W, '', '🤝 *AXYON COLLABORATIONS*', '', ...rows.map(c => `*#${c.id} ${c.title}* · ${c.status.toUpperCase()}\n   Groups: ${c.group_count} · Participants: ${c.participant_count}`)].join('\n') : 'No collaborations found.')
      }
      if (sub === 'create') {
        const [title, description] = args.slice(1).join(' ').split('|').map(x => String(x || '').trim())
        if (!title) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}collab create <title> | <description>*`)
        const row = await collab.create({ title, description, creatorId: ctx.userId })
        await store.log(ctx.userId, 'collab_create', String(row.id), { title })
        return axyon.send(s, ctx.jid, m, `${W}\n\n🤝 *COLLABORATION CREATED*\n\n${format({ ...row, groups: [] })}\n\nAttach verified groups with *${ctx.prefix}collab group add ${row.id}* then submit with *${ctx.prefix}collab submit ${row.id}*.`)
      }
      if (sub === 'info') {
        const c = await collab.get(args[1]); if (!c) return axyon.send(s, ctx.jid, m, 'Collaboration not found.')
        return axyon.send(s, ctx.jid, m, [W, '', '🤝 *COLLABORATION DETAILS*', '', format(c), '', '*GROUPS*', ...(c.groups || []).map(g => `• ${g.group_name} — ${g.group_jid}`), '', '*UPCOMING EVENTS*', ...(c.events || []).map(e => `• ${e.title} — ${e.starts_at}`), '', '*MISSIONS*', ...(c.missions || []).map(q => `• #${q.id} ${q.title} — ${q.points} pts`), '', '*REWARDS*', ...(c.rewards || []).map(r => `• #${r.id} ${r.name} — ${r.points_required} pts`)].join('\n'))
      }
      if (sub === 'submit') {
        const row = await collab.setStatus(args[1], ctx.userId, 'pending', isOwner)
        return axyon.send(s, ctx.jid, m, `📨 *SUBMITTED FOR REVIEW*\n\n#${row.id} ${row.title}`)
      }
      if (sub === 'approve') {
        if (!isOwner) return axyon.send(s, ctx.jid, m, '🛡️ Only AXYON can approve a collaboration.')
        const row = await collab.setStatus(args[1], ctx.userId, 'approved', true)
        return axyon.send(s, ctx.jid, m, `✅ *COLLABORATION APPROVED*\n\n#${row.id} ${row.title}`)
      }
      if (['start', 'pause', 'resume', 'end', 'cancel'].includes(sub)) {
        const next = ({ start: 'active', pause: 'paused', resume: 'active', end: 'completed', cancel: 'cancelled' })[sub]
        if (sub === 'start' || sub === 'resume') {
          const candidate = await collab.get(args[1])
          if (!candidate) throw new Error('Collaboration not found.')
          for (const linked of candidate.groups || []) {
            const live = await store.group(linked.group_jid)
            if (!live || String(live.status || '').toUpperCase() !== 'ACTIVE' || live.enabled === false || !(live.features || []).includes('collab')) {
              throw new Error(`Group ${linked.group_name || linked.group_jid} is no longer actively registered with the collab feature.`)
            }
          }
        }
        const row = await collab.setStatus(args[1], ctx.userId, next, isOwner)
        await store.log(ctx.userId, `collab_${sub}`, String(row.id))
        return axyon.send(s, ctx.jid, m, `🤝 *${row.title}* is now *${row.status.toUpperCase()}*.`)
      }
      if (sub === 'group') {
        const action = String(args[1] || '').toLowerCase(); const id = args[2]
        if (!id) return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}collab group add|remove <collab-id>*`)
        if (action === 'add') {
          if (!inGroup) throw new Error('Run this inside the registered WhatsApp group you want to attach.')
          const registered = await ensureCollabGroup()
          const verifiedAdmin = await isLiveGroupAdmin(s, ctx)
          if (!verifiedAdmin) throw new Error('Your WhatsApp group-admin status could not be verified live.')
          const row = await collab.addGroup(id, { groupJid, name: registered.name || '', actorId: ctx.userId, verifiedAdmin, isOwner })
          return axyon.send(s, ctx.jid, m, `✅ *GROUP LINKED*\n\n${row.group_name}\nThis group is now attached to collaboration #${id}.`)
        }
        if (action === 'remove') {
          if (!inGroup) throw new Error('Run this inside the group being removed.')
          await ensureCollabGroup()
          const verifiedAdmin = await isLiveGroupAdmin(s, ctx)
          if (!verifiedAdmin) throw new Error('Your WhatsApp group-admin status could not be verified live.')
          const row = await collab.removeGroup(id, groupJid, ctx.userId, isOwner)
          return axyon.send(s, ctx.jid, m, `Group *${row.group_name}* removed from collaboration #${id}.`)
        }
      }
      if (sub === 'join') {
        if (!inGroup) throw new Error('Join collaboration from one of its participating registered groups.')
        await ensureCollabGroup()
        const row = await collab.join(args[1], { groupJid, userId: ctx.userId, displayName: ctx.name })
        return axyon.send(s, ctx.jid, m, `✅ You joined collaboration #${args[1]}. Your points are now tracked across this campaign.`)
      }
      if (sub === 'leave') {
        if (!inGroup) throw new Error('Leave from the group where you joined the collaboration.')
        const row = await collab.leave(args[1], groupJid, ctx.userId)
        return axyon.send(s, ctx.jid, m, `You left collaboration #${args[1]}.`)
      }
      if (sub === 'event') {
        const action = String(args[1] || '').toLowerCase(); const id = args[2]
        if (action === 'list') {
          const c = await collab.get(id); if (!c) throw new Error('Collaboration not found.')
          return axyon.send(s, ctx.jid, m, c.events.length ? c.events.map(e => `#${e.id} *${e.title}*\n${e.description}\n${e.starts_at} → ${e.ends_at}`).join('\n\n') : 'No events yet.')
        }
        if (action === 'add') {
          const [title, description, startsAt, endsAt] = args.slice(3).join(' ').split('|').map(x => String(x || '').trim())
          const e = await collab.addEvent(id, { title, description, startsAt, endsAt }, ctx.userId, isOwner)
          return axyon.send(s, ctx.jid, m, `📅 Event *${e.title}* added to collaboration #${id}.`)
        }
      }
      if (sub === 'mission') {
        const action = String(args[1] || '').toLowerCase(); const id = args[2]
        if (action === 'list') {
          const c = await collab.get(id); if (!c) throw new Error('Collaboration not found.')
          return axyon.send(s, ctx.jid, m, c.missions.length ? c.missions.map(q => `#${q.id} *${q.title}* — ${q.points} points\n${q.description}`).join('\n\n') : 'No missions yet.')
        }
        if (action === 'add') {
          const [title, description, points] = args.slice(3).join(' ').split('|').map(x => String(x || '').trim())
          const q = await collab.addMission(id, { title, description, points }, ctx.userId, isOwner)
          return axyon.send(s, ctx.jid, m, `📜 Mission *${q.title}* added (#${q.id}).`)
        }
        if (action === 'submit') {
          if (!inGroup) throw new Error('Submit missions from a participating group.')
          const row = await collab.requestMission(id, groupJid, ctx.userId)
          return axyon.send(s, ctx.jid, m, `📨 Mission submission #${id} is pending review.`)
        }
        if (action === 'review') {
          if (!inGroup) throw new Error('Review submissions inside the participating group.')
          await ensureCollabGroup()
          const campaign = await collab.get(id)
          if (!campaign) throw new Error('Collaboration not found.')
          const campaignCreator = String(campaign.creator_id) === String(ctx.userId)
          if (!isOwner && !ctx.auth.rhm && !campaignCreator) throw new Error('Only the collaboration creator or AXYON/RHM may review submissions.')
          const verdict = String(args[args.length - 1] || '').toLowerCase()
          const targetArg = args.slice(3, -1).join(' ').trim()
          const target = mentionedId(content) || norm(targetArg)
          if (!target || !['approve', 'reject'].includes(verdict)) throw new Error(`Usage: ${ctx.prefix}collab mission review <mission-id> @player approve|reject`)
          const row = await collab.reviewMission(id, groupJid, target, ctx.userId, verdict === 'approve', isOwner || ctx.auth.rhm)
          return axyon.send(s, ctx.jid, m, `Mission submission ${row.status}. ${row.points ? `+${row.points} collaboration points.` : ''}`)
        }
      }
      if (sub === 'reward') {
        const action = String(args[1] || '').toLowerCase(); const id = args[2]
        if (action === 'list') {
          const c = await collab.get(id); if (!c) throw new Error('Collaboration not found.')
          return axyon.send(s, ctx.jid, m, c.rewards.length ? c.rewards.map(r => `#${r.id} *${r.name}* — ${r.points_required} points · stock ${r.quantity}`).join('\n') : 'No rewards yet.')
        }
        if (action === 'add') {
          const [name, description, pointsRequired, quantity] = args.slice(3).join(' ').split('|').map(x => String(x || '').trim())
          const r = await collab.addReward(id, { name, description, pointsRequired, quantity }, ctx.userId, isOwner)
          return axyon.send(s, ctx.jid, m, `🎁 Reward *${r.name}* added (#${r.id}).`)
        }
        if (action === 'claim') {
          if (!inGroup) throw new Error('Claim a collaboration reward from a participating group.')
          const r = await collab.claimReward(id, groupJid, ctx.userId)
          return axyon.send(s, ctx.jid, m, `🏅 *REWARD CLAIMED*\n\n${r.name}`)
        }
      }
      if (sub === 'stats') {
        const st = await collab.stats(args[1])
        return axyon.send(s, ctx.jid, m, `📊 *COLLABORATION STATISTICS*\n\nGroups: ${st.groups}\nParticipants: ${st.participants}\nPoints: ${fmt(st.points)}\nEvents: ${st.events}\nMissions: ${st.missions}\nApproved missions: ${st.missionCompletions}\nRewards: ${st.rewards}`)
      }
      if (sub === 'leaderboard') {
        const rows = await collab.leaderboard(args[1])
        return axyon.send(s, ctx.jid, m, rows.length ? [W, '', '🏆 *COLLABORATION LEADERBOARD*', '', ...rows.map((r, i) => `${i + 1}. *${r.display_name}* — ${r.points} pts`)].join('\n') : 'No participants yet.')
      }
    } catch (error) { return axyon.send(s, ctx.jid, m, `❌ ${error.message}`) }
    return axyon.send(s, ctx.jid, m, [W, '', '🤝 *AXYON COLLABORATION SYSTEM*', '', `*${ctx.prefix}collab list*`, `*${ctx.prefix}collab create <title> | <description>*`, `*${ctx.prefix}collab group add <id>*`, `*${ctx.prefix}collab submit <id>*`, `*${ctx.prefix}collab approve <id>*`, `*${ctx.prefix}collab start <id>*`, `*${ctx.prefix}collab join <id>*`, `*${ctx.prefix}collab mission add|list|submit|review ...*`, `*${ctx.prefix}collab event add|list ...*`, `*${ctx.prefix}collab reward add|list|claim ...*`, `*${ctx.prefix}collab stats <id>*`, `*${ctx.prefix}collab leaderboard <id>*`, '', 'Groups must be registered with the `collab` feature; group linking also verifies live WhatsApp admin status.'].join('\n'))
  })

  /* ------------------------------------------------------- progression views */
  const progressViews = {
    progression: ['level', 'rank', 'grade', 'class', 'xp', 'zen'],
    level: ['level'], rank: ['rank'], grade: ['grade'], stats: ['stats'], xp: ['xp'], coins: ['zen']
  }
  for (const name of Object.keys(progressViews)) {
    if (axyon.COMMANDS.some(c => c.name === name)) continue
    cmd(name, 'core', `{p}${name}`, `Display ${name} information from your existing profile.`, async (s, m, ctx) => {
      const p = await store.player(ctx.userId)
      if (!p) return axyon.send(s, ctx.jid, m, `Use *${ctx.prefix}arise* first.`)
      const rows = []
      if (name === 'progression' || name === 'stats') rows.push(`Level: *${p.level}* · Rank: *${p.rank}* · Grade: *${p.grade}*`, `HP: *${p.hp}/${p.maxHp}* · Power Energy: *${p.powerEnergy}/${p.maxPowerEnergy}*`, `Attack: *${p.atk}* · Defence: *${p.def}*`, `XP: *${fmt(p.xp)}* · Zen: *${fmt(p.zen)}*`)
      else if (name === 'level') rows.push(`Level: *${p.level}* · XP: *${fmt(p.xp)}*`)
      else if (name === 'rank') rows.push(`Rank: *${p.rank}*`)
      else if (name === 'grade') rows.push(`Grade: *${p.grade}*`)
      else if (name === 'xp') rows.push(`XP: *${fmt(p.xp)}*`)
      else if (name === 'coins') rows.push(`Coins: *${fmt(p.coins)}*`)
      else rows.push(`Zen: *${fmt(p.zen)}*`)
      return axyon.send(s, ctx.jid, m, `${W}\n\n📈 *${name.toUpperCase()}*\n\n${rows.join('\n')}`)
    })
  }

  if (!axyon.COMMANDS.some(c => c.name === 'moves')) {
    cmd('moves', 'battle', '{p}moves', 'Display your existing class and its available moves.', async (s, m, ctx) => invokeLocal('class', s, m, ctx, [], {}))
  }
  if (!axyon.COMMANDS.some(c => c.name === 'equipment')) {
    cmd('equipment', 'cards', '{p}equipment', 'Display your existing equipped card slots.', async (s, m, ctx) => invokeLocal('card', s, m, ctx, ['slots'], {}))
  }
  if (!axyon.COMMANDS.some(c => c.name === 'appearance')) {
    cmd('appearance', 'cards', '{p}appearance', 'Display your currently selected cosmetic appearance.', async (s, m, ctx) => invokeLocal('skin', s, m, ctx, ['current'], {}))
  }

  cmd('skin', 'cards', '{p}skin <list|current|equip|unequip|inventory|view>', 'Equip and inspect unlocked cosmetic skins.', async (s, m, ctx, args) => {
    const sub = String(args[0] || 'list').toLowerCase()
    if (sub === 'list' || sub === 'inventory' || sub === 'unlocked') {
      const rows = await adventure.skins(ctx.userId)
      return axyon.send(s, ctx.jid, m, [W, '', '🎭 *SKIN INVENTORY*', '', '• default (always available)', ...(rows.map(x => `• ${x.skin_id}${x.equipped ? ' ✅ EQUIPPED' : ''}`))].join('\n'))
    }
    if (sub === 'current') {
      const rows = await adventure.skins(ctx.userId); const current = rows.find(x => x.equipped)
      return axyon.send(s, ctx.jid, m, `Current appearance: *${current?.skin_id || 'default'}*`)
    }
    if (sub === 'equip') {
      const result = await adventure.equipSkin(ctx.userId, args[1])
      return axyon.send(s, ctx.jid, m, result.ok ? `✅ Equipped skin *${result.skin}*.` : `❌ ${result.message}`)
    }
    if (sub === 'unequip' || sub === 'reset') {
      const result = await adventure.equipSkin(ctx.userId, 'default')
      return axyon.send(s, ctx.jid, m, result.ok ? '✅ Returned to the default appearance.' : 'Could not reset appearance.')
    }
    if (sub === 'view' || sub === 'inspect' || sub === 'preview') return axyon.send(s, ctx.jid, m, 'Skin previews are not connected to the character artwork renderer yet.')
    return axyon.send(s, ctx.jid, m, `Usage: *${ctx.prefix}skin list|current|equip <owned-skin>|unequip*`)
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
