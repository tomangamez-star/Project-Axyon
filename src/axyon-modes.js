'use strict'
/*
 * AXYON CORE — MODES & ROOM SYSTEM
 * ================================
 *
 * Implements the Modes & Room System specification.
 *
 * THE ONE DISTINCTION THAT MATTERS
 * --------------------------------
 * A MODE defines the rules of a gameplay format. A ROOM is one live session
 * hosting a mode. A room always knows which mode it is running; a mode never
 * owns room state. Closing a room must never delete or alter its mode.
 *
 * This module is deliberately PURE: no database, no socket, no clock beyond
 * what the caller passes in. The store owns persistence, the command layer owns
 * messaging, and this file owns the rules — which is what makes the rules
 * testable without a live Postgres.
 *
 * WHAT IS PROTECTED
 * -----------------
 * Normal Battle, Challenge Battle and Boss Battle are the three protected core
 * combat modes. They cannot be removed or reordered by ordinary users. Custom
 * content lives in its own registry and can be added, edited, locked, unlocked
 * and removed without touching the protected three.
 *
 * WHAT IS DELIBERATELY NOT INVENTED
 * ---------------------------------
 * The spec says the three guild-mode slots exist in the menu order but that
 * their names, rules and rewards "must be defined in their own specifications"
 * and explicitly forbids inventing them. They are therefore registered as
 * PLACEHOLDER slots with no rules, and `enabled: false`. They appear in the
 * menu order and cannot be entered until an owner configures them.
 */

/* ------------------------------------------------------------ mode types */

/**
 * The three global participation types. These are NOT battle modes — they
 * describe who takes part, and any mode may support one or more of them.
 */
const MODE_TYPES = {
  solo: {
    id: 'solo',
    name: 'Solo',
    blurb: 'One player, alone.',
    minPlayers: 1,
    defaultMax: 1
  },
  multiplayer: {
    id: 'multiplayer',
    name: 'Multiplayer',
    blurb: 'Two or more players in one shared session.',
    minPlayers: 2,
    defaultMax: 8
  },
  party: {
    id: 'party',
    name: 'Party / Group',
    blurb: 'An organised team. Minimum 2, default maximum 5.',
    minPlayers: 2,
    defaultMax: 5
  }
}

const MODE_TYPE_IDS = Object.keys(MODE_TYPES)

/** Party capacity bounds. The default maximum of 5 is adjustable by AXYON. */
const PARTY_MIN = 2
const PARTY_DEFAULT_MAX = 5
const PARTY_HARD_MAX = 20

/**
 * CUSTOM ROOM TYPES
 * -----------------
 * The three participation types above are fixed by the spec. Operators also
 * need their own room shapes — a raid, a tournament bracket, a spectator
 * lobby — and those have their own capacity rules that the three fixed types
 * cannot express.
 *
 * A custom type is a plain record: an id, a display name, a minimum, a default
 * maximum and a hard ceiling. It is registered at runtime (or seeded from the
 * database by the command layer) and is looked up by the SAME `capacityFor`
 * that the fixed types use, so a custom room cannot bypass the clamping that
 * protects the fixed ones.
 *
 * Custom types can never shadow a fixed type id: `solo`, `multiplayer` and
 * `party` are reserved, because a custom entry that redefined `party` would
 * silently change the capacity of every existing party room.
 */
const RESERVED_TYPE_IDS = new Set(MODE_TYPE_IDS)

const CUSTOM_ROOM_TYPES = new Map()

/** Hard ceiling for any custom type, so a typo cannot open a 10,000-seat room. */
const CUSTOM_HARD_MAX = 50

/**
 * Registers a custom room type.
 *
 * Returns { ok, reason, message } rather than throwing, because this is called
 * from a command handler where a bad argument must produce a message, not a
 * stack trace.
 */
function registerRoomType ({ id, name, minPlayers = 1, defaultMax = 4, hardMax = CUSTOM_HARD_MAX } = {}) {
  const key = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  if (!key) return { ok: false, reason: 'no_id', message: 'A room type needs an id.' }
  if (RESERVED_TYPE_IDS.has(key)) {
    return { ok: false, reason: 'reserved', message: `*${key}* is a built-in participation type and cannot be redefined.` }
  }
  const min = Math.max(1, Math.floor(Number(minPlayers) || 1))
  const hard = Math.max(min, Math.min(CUSTOM_HARD_MAX, Math.floor(Number(hardMax) || CUSTOM_HARD_MAX)))
  const def = Math.max(min, Math.min(hard, Math.floor(Number(defaultMax) || min)))
  CUSTOM_ROOM_TYPES.set(key, {
    id: key,
    name: String(name || key).trim() || key,
    minPlayers: min,
    defaultMax: def,
    hardMax: hard,
    custom: true
  })
  return { ok: true, type: CUSTOM_ROOM_TYPES.get(key) }
}

function unregisterRoomType (id) {
  return CUSTOM_ROOM_TYPES.delete(String(id || '').trim().toLowerCase())
}

function customRoomTypes () {
  return [...CUSTOM_ROOM_TYPES.values()]
}

/**
 * Resolves a participation id to a type definition, fixed or custom.
 *
 * Fixed types win, so a custom entry can never shadow one even if it somehow
 * reached the map.
 */
function modeType (id) {
  const key = String(id || '').toLowerCase()
  if (MODE_TYPES[key]) return MODE_TYPES[key]
  return CUSTOM_ROOM_TYPES.get(key) || null
}

/**
 * Resolves the capacity a room should get for a participation type.
 *
 * `partyMax` is the operator's configured ceiling, so AXYON can raise the
 * default 5 without a code change. It is clamped to the hard maximum so a
 * typo cannot open a 10,000-seat room.
 *
 * A CUSTOM type uses its own default and its own hard ceiling, and is clamped
 * the same way. An unknown type still returns 1 — a room with no recognised
 * participation must never be given a large capacity by accident.
 */
function capacityFor (participation, partyMax = PARTY_DEFAULT_MAX) {
  const t = modeType(participation)
  if (!t) return 1
  if (t.id === 'party') {
    const n = Number(partyMax)
    const max = Number.isFinite(n) ? Math.max(PARTY_MIN, Math.min(PARTY_HARD_MAX, Math.floor(n))) : PARTY_DEFAULT_MAX
    return max
  }
  if (t.custom) {
    const n = Number(partyMax)
    /* A custom type's own default is the floor; the operator may raise it up
     * to that type's hard ceiling, never past it. */
    const wanted = Number.isFinite(n) ? Math.max(t.defaultMax, Math.floor(n)) : t.defaultMax
    return Math.max(t.minPlayers, Math.min(t.hardMax, wanted))
  }
  return t.defaultMax
}

/* --------------------------------------------------------- mode registry */

/**
 * The protected core combat modes, in their protected order.
 *
 * `protected: true` means ordinary users cannot remove, reorder or replace
 * them. Only AXYON-level control may manage custom content around them.
 */
const CORE_MODES = [
  {
    id: 'normal_battle',
    name: 'Normal Battle',
    category: 'combat',
    protected: true,
    enabled: true,
    participation: ['solo', 'multiplayer', 'party'],
    blurb: 'The standard combat format. The baseline battle mode.',
    usesRoom: true
  },
  {
    id: 'challenge_battle',
    name: 'Challenge Battle',
    category: 'combat',
    protected: true,
    enabled: true,
    participation: ['solo', 'multiplayer', 'party'],
    blurb: 'Configured challenges with their own restrictions and objectives.',
    usesRoom: true
  },
  {
    id: 'boss_battle',
    name: 'Boss Battle',
    category: 'combat',
    protected: true,
    enabled: true,
    participation: ['solo', 'multiplayer', 'party'],
    blurb: 'A configured boss encounter with its own saved statistics.',
    usesRoom: true
  }
]

/**
 * The rest of the menu, in the spec's order.
 *
 * Guild slots 1-3 and Collaboration are now REAL modes with defined rules
 * (see axyon-guild.js). They were placeholders because the spec fixed their
 * position but forbade inventing their rules; the owner has since asked for
 * them to be built, so the rules are written down in that file and these
 * entries point at it.
 */
const OTHER_MODES = [
  { id: 'guild_1', name: 'Guild Raid', category: 'guild', protected: false, enabled: true, participation: ['party'], blurb: 'A party shares one boss HP pool. Members fall individually; the raid is lost when all are down.', usesRoom: true, rules: 'guild_raid' },
  { id: 'guild_2', name: 'Guild Duel', category: 'guild', protected: false, enabled: true, participation: ['party'], blurb: 'Two guilds field equal rosters. Members are paired by index; the side with more pair wins takes it.', usesRoom: true, rules: 'guild_duel' },
  { id: 'guild_3', name: 'Guild Gauntlet', category: 'guild', protected: false, enabled: true, participation: ['party'], blurb: 'Three consecutive waves. HP carries over between waves with no full heal.', usesRoom: true, rules: 'guild_gauntlet' },
  { id: 'duel', name: 'Duel', category: 'duel', protected: false, enabled: true, participation: ['multiplayer'], blurb: 'Direct player-versus-player combat.', usesRoom: true },
  { id: 'card', name: 'Card', category: 'card', protected: false, enabled: true, participation: ['solo', 'multiplayer'], blurb: 'Card features, inventory and abilities.', usesRoom: false },
  { id: 'collab', name: 'Co-op Trial', category: 'collab', protected: false, enabled: true, participation: ['party'], blurb: 'The party shares one HP pool and one damage target. One member taking hits hurts everyone.', usesRoom: true, rules: 'collab_trial' },
  { id: 'dungeon', name: 'Dungeon', category: 'dungeon', protected: false, enabled: true, participation: ['solo', 'multiplayer', 'party'], blurb: 'Expandable floors and protected gates.', usesRoom: true },
  { id: 'abyss', name: 'Abyssal Frontier', category: 'exploration', protected: false, enabled: true, participation: ['solo', 'multiplayer', 'party'], blurb: 'Advanced exploration sessions using the shared room and save systems.', usesRoom: true }
]

/** Menu order, exactly as the spec lists it. */
const MENU_ORDER = [
  'normal_battle', 'challenge_battle', 'boss_battle',
  'guild_1', 'guild_2', 'guild_3',
  'duel', 'card', 'collab', 'dungeon', 'abyss'
]

const CORE_MODE_IDS = CORE_MODES.map(m => m.id)

/**
 * The mode registry.
 *
 * Resolves a mode id to its definition, keeps protected core modes distinct
 * from custom content, and refuses to let a custom entry shadow a core id.
 */
function createModeRegistry ({ custom = [] } = {}) {
  const byId = new Map()

  for (const m of [...CORE_MODES, ...OTHER_MODES]) byId.set(m.id, { ...m })

  /* Custom content is stored separately and can never overwrite a core id. */
  for (const c of custom) {
    if (!c || !c.id) continue
    if (byId.has(c.id) && byId.get(c.id).protected) continue
    byId.set(c.id, { ...c, protected: false, custom: true })
  }

  function get (id) {
    return byId.get(String(id || '').toLowerCase()) || null
  }

  function all () {
    return [...byId.values()]
  }

  /** Menu order first, then any custom modes appended. */
  function ordered () {
    const seen = new Set()
    const out = []
    for (const id of MENU_ORDER) {
      const m = byId.get(id)
      if (m) { out.push(m); seen.add(id) }
    }
    for (const m of byId.values()) if (!seen.has(m.id)) out.push(m)
    return out
  }

  function isProtected (id) {
    const m = get(id)
    return !!(m && m.protected)
  }

  /**
   * Whether a mode may be entered.
   *
   * A disabled mode is refused. A placeholder is refused with a distinct
   * reason so the message can say "not configured yet" rather than "disabled".
   */
  function canEnter (id) {
    const m = get(id)
    if (!m) return { ok: false, reason: 'unknown', message: 'No such mode.' }
    if (m.placeholder) return { ok: false, reason: 'placeholder', message: `${m.name} has no rules configured yet.` }
    if (!m.enabled) return { ok: false, reason: 'disabled', message: `${m.name} is disabled.` }
    return { ok: true, mode: m }
  }

  return { get, all, ordered, isProtected, canEnter, CORE_MODE_IDS }
}

/* ------------------------------------------------------------ room states */

/**
 * Room states and the transitions that are legal between them.
 *
 * The spec requires transitions to be validated — a completed room must not
 * silently return to active. This table is the single source of that rule.
 */
const ROOM_STATES = ['waiting', 'ready', 'active', 'paused', 'completed', 'cancelled', 'expired']

const ROOM_TRANSITIONS = {
  waiting: ['ready', 'active', 'cancelled', 'expired'],
  ready: ['active', 'waiting', 'cancelled', 'expired'],
  active: ['paused', 'completed', 'cancelled'],
  paused: ['active', 'cancelled', 'expired'],
  completed: [],
  cancelled: [],
  expired: []
}

function canTransition (from, to) {
  const allowed = ROOM_TRANSITIONS[String(from || '').toLowerCase()]
  if (!allowed) return false
  return allowed.includes(String(to || '').toLowerCase())
}

/* --------------------------------------------------------- room lifecycle */

/**
 * Validates a join request against a room.
 *
 * Every check the spec lists is here, in the order it lists them: privacy,
 * capacity, duplicate identity, and status. Group registration is checked by
 * the command layer before this is called, because it is a separate permission
 * system (spec Part 8) and must not be folded into room access.
 *
 * @returns {{ok: boolean, reason?: string, message?: string}}
 */
function canJoin (room, userId) {
  if (!room) return { ok: false, reason: 'missing', message: 'That room does not exist.' }

  const status = String(room.status || '').toLowerCase()
  if (status === 'completed' || status === 'cancelled' || status === 'expired') {
    return { ok: false, reason: 'closed', message: `That room is ${status}.` }
  }
  if (status === 'active') {
    return { ok: false, reason: 'active', message: 'That room is already in progress.' }
  }

  const participants = Array.isArray(room.participants) ? room.participants : []

  /* Duplicate identity — a player must not occupy a room twice. */
  if (participants.some(p => String(p.userId) === String(userId))) {
    return { ok: false, reason: 'duplicate', message: 'You are already in that room.' }
  }

  /* Capacity. */
  const capacity = Number(room.capacity) || 1
  if (participants.length >= capacity) {
    return { ok: false, reason: 'full', message: `That room is full (${participants.length}/${capacity}).` }
  }

  /*
   * Privacy. A private room is invite-only: the participant list is the
   * authority, so guessing a room key gets you nothing.
   */
  if (String(room.privacy || '').toLowerCase() === 'private') {
    const invited = Array.isArray(room.invited) ? room.invited : []
    const isInvited = invited.some(x => String(x) === String(userId))
    const isOwner = String(room.owner_id || room.ownerId || '') === String(userId)
    if (!isInvited && !isOwner) {
      return { ok: false, reason: 'private', message: 'That room is private. You need an invitation.' }
    }
  }

  return { ok: true }
}

/** Adds a participant, returning the new list. Never mutates the input. */
function addParticipant (room, userId, role = 'member') {
  const participants = Array.isArray(room.participants) ? room.participants.slice() : []
  if (participants.some(p => String(p.userId) === String(userId))) return participants
  participants.push({ userId: String(userId), role })
  return participants
}

/** Removes a participant, returning the new list. Never mutates the input. */
function removeParticipant (room, userId) {
  const participants = Array.isArray(room.participants) ? room.participants : []
  return participants.filter(p => String(p.userId) !== String(userId))
}

/**
 * Whether the room has satisfied its start conditions.
 *
 * A room is ready when it has at least the minimum for its participation type
 * and has not exceeded capacity. Solo rooms are ready with one player.
 */
function isReady (room) {
  const t = modeType(room?.participation)
  const min = t ? t.minPlayers : 1
  const participants = Array.isArray(room?.participants) ? room.participants : []
  const capacity = Number(room?.capacity) || 1
  return participants.length >= min && participants.length <= capacity
}

/**
 * Whether a user may manage a room.
 *
 * The room leader gets the limited session powers the spec grants (invite,
 * start). Owner-level changes — capacity beyond limits, privacy overrides,
 * closing another owner's room — need AXYON. A leader is never AXYON.
 */
function canManage (room, userId, auth = {}) {
  if (auth.axyon) return true
  if (!room) return false
  return String(room.owner_id || room.ownerId || '') === String(userId)
}

module.exports = {
  MODE_TYPES,
  MODE_TYPE_IDS,
  PARTY_MIN,
  PARTY_DEFAULT_MAX,
  PARTY_HARD_MAX,
  CUSTOM_HARD_MAX,
  RESERVED_TYPE_IDS,
  registerRoomType,
  unregisterRoomType,
  customRoomTypes,
  modeType,
  capacityFor,
  CORE_MODES,
  OTHER_MODES,
  MENU_ORDER,
  CORE_MODE_IDS,
  createModeRegistry,
  ROOM_STATES,
  ROOM_TRANSITIONS,
  canTransition,
  canJoin,
  addParticipant,
  removeParticipant,
  isReady,
  canManage
}
