'use strict'
/*
 * ACCESS — who is who, and what each level may touch.
 *
 * THREE LEVELS
 * ------------
 *   admin  Full control. The original owner, any OWNER_NUMBERS, and any number
 *          registered in AXYON_NUMBERS. Can pair accounts, reset sessions,
 *          edit the economy, grant items, change authority.
 *   rhm    Scoped moderation. Can moderate players, stages, floors, modes and
 *          the audit log — but cannot view or manage group registration,
 *          pair/reset WhatsApp sessions, change authority or economy limits.
 *   guest  Read-only, non-sensitive. Sees the game content (stages, floors,
 *          modes, shop catalogue, command reference) and nothing that exposes
 *          an account, a phone number, a session or a player's private data.
 *
 * The permission table is the single source of truth. The dashboard asks
 * `can(role, permission)`; it never hardcodes a role name in a route.
 */
const ORIGINAL_OWNER = '2349110799878'

const ROLES = ['admin', 'rhm', 'guest']

/* Ordered strongest → weakest, for "at least this level" checks. */
const RANK = { admin: 3, rhm: 2, guest: 1 }

/*
 * Permissions, grouped by what they expose.
 *
 * Anything that can log a WhatsApp account out, reveal a phone number, or
 * change who holds authority is admin-only. Guest gets the game catalogue and
 * the help text — the same thing a stranger could read in a public group.
 */
const PERMISSIONS = {
  admin: [
    'overview.read', 'overview.control',
    'pairing.read', 'pairing.write',
    'groups.read', 'groups.write',
    'players.read', 'players.write',
    'shop.read', 'shop.write',
    'stages.read', 'stages.write',
    'floors.read', 'floors.write',
    'modes.read', 'modes.write',
    'visuals.read', 'visuals.write',
    'authority.read', 'authority.write',
    'settings.read', 'settings.write',
    'log.read',
    'feedback.read', 'feedback.reply',
    'commands.read'
  ],
  rhm: [
    'overview.read',
    'players.read', 'players.write',
    'stages.read', 'stages.write',
    'floors.read', 'floors.write',
    'modes.read', 'modes.write',
    'visuals.read', 'visuals.write',
    'log.read',
    'feedback.read', 'feedback.reply',
    'commands.read'
  ],
  guest: [
    'stages.read',
    'floors.read',
    'modes.read',
    'shop.read',
    'commands.read'
  ]
}

function norm (x) { return String(x || '').replace(/\D/g, '') }

function ownerIds () {
  return new Set([
    ORIGINAL_OWNER,
    ...String(process.env.OWNER_NUMBERS || process.env.OWNER_NUMBER || process.env.OWNER_ID || '')
      .split(/[,;\s]+/).map(norm).filter(Boolean)
  ])
}

function isOwner (id) { return ownerIds().has(norm(id)) }

/** True when `role` holds `permission`. Unknown roles hold nothing. */
function can (role, permission) {
  const list = PERMISSIONS[role]
  return Array.isArray(list) && list.includes(permission)
}

/** True when `role` is at least as strong as `minimum`. */
function atLeast (role, minimum) {
  return (RANK[role] || 0) >= (RANK[minimum] || 0)
}

/** Every permission a role holds, for the client to gate its own UI. */
function permissionsOf (role) { return [...(PERMISSIONS[role] || [])] }

module.exports = {
  ORIGINAL_OWNER,
  ROLES,
  RANK,
  PERMISSIONS,
  ownerIds,
  isOwner,
  norm,
  can,
  atLeast,
  permissionsOf
}
