'use strict'

/*
 * AXYON adventure-session support.
 * This is an additive service around the existing room, player and floor-story
 * stores. It does not replace !floor or the four-option floor decision engine.
 */
const { randomBytes } = require('node:crypto')
const { database } = require('./auth-store')

const MODES = Object.freeze({
  solo: { id: 'solo', name: 'Solo Chronicles', maxPlayers: 1 },
  multiplayer: { id: 'multiplayer', name: 'Multiplayer Expedition', maxPlayers: 5 },
  guild: { id: 'guild', name: 'Guild Campaign', maxPlayers: 5 },
  duel: { id: 'duel', name: 'Duel Chronicles', maxPlayers: 2 },
  abyss: { id: 'abyss', name: 'Abyssal Frontier', maxPlayers: 5 }
})

function cleanMode (value) {
  const raw = String(value || '').trim().toLowerCase()
  const mode = raw === 'party' ? 'multiplayer' : raw
  return Object.hasOwn(MODES, mode) ? mode : null
}
function db () {
  const pool = database()
  if (!pool) throw Object.assign(new Error('DATABASE_URL is required for persistent adventure sessions.'), { status: 503 })
  return pool
}

let ready = false
async function ensureSchema () {
  if (ready) return
  await db().query(`
    CREATE TABLE IF NOT EXISTS axyon_adventure_mode_locks (
      mode TEXT PRIMARY KEY,
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      reason TEXT NOT NULL DEFAULT '',
      changed_by TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS axyon_adventure_saves (
      code TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      group_jid TEXT NOT NULL DEFAULT '',
      room_key TEXT,
      participants JSONB NOT NULL DEFAULT '[]'::jsonb,
      snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS axyon_adventure_saves_owner ON axyon_adventure_saves(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS axyon_adventure_saves_room ON axyon_adventure_saves(room_key);
    CREATE TABLE IF NOT EXISTS axyon_player_skins (
      user_id TEXT NOT NULL,
      skin_id TEXT NOT NULL,
      equipped BOOLEAN NOT NULL DEFAULT FALSE,
      unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, skin_id)
    );
  `)
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    for (const mode of Object.keys(MODES)) {
      await client.query(`INSERT INTO axyon_adventure_mode_locks(mode,locked) VALUES($1,FALSE) ON CONFLICT(mode) DO NOTHING`, [mode])
    }
    await client.query('COMMIT')
    ready = true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

function codeMode (mode) { return mode === 'multiplayer' ? 'PARTY' : String(mode || '').toUpperCase() }
function makeCode (mode) {
  const prefix = `AX-${codeMode(mode)}`
  return `${prefix}-${randomBytes(4).toString('hex').slice(0, 6).toUpperCase()}`
}

async function getModeLocks () {
  await ensureSchema()
  const rows = (await db().query('SELECT * FROM axyon_adventure_mode_locks ORDER BY mode')).rows
  return Object.values(MODES).map(mode => rows.find(row => row.mode === mode.id) || {
    mode: mode.id, locked: false, reason: '', changed_by: '', updated_at: null
  })
}
async function modeLock (mode) {
  const key = cleanMode(mode)
  if (!key) throw new Error('Unknown adventure mode.')
  await ensureSchema()
  const row = (await db().query('SELECT * FROM axyon_adventure_mode_locks WHERE mode=$1', [key])).rows[0]
  return row || { mode: key, locked: false, reason: '' }
}
async function setModeLock (mode, locked, reason = '', actorId = '') {
  const key = cleanMode(mode)
  if (!key) throw new Error('Unknown adventure mode.')
  await ensureSchema()
  const row = (await db().query(
    `INSERT INTO axyon_adventure_mode_locks(mode,locked,reason,changed_by,updated_at)
     VALUES($1,$2,$3,$4,NOW())
     ON CONFLICT(mode) DO UPDATE SET locked=EXCLUDED.locked,reason=EXCLUDED.reason,
       changed_by=EXCLUDED.changed_by,updated_at=NOW() RETURNING *`,
    [key, Boolean(locked), String(reason || '').slice(0, 220), String(actorId || '')]
  )).rows[0]
  return row
}

async function createSave ({ mode, ownerId, groupJid = '', roomKey = null, participants = [], snapshot = {} } = {}) {
  const key = cleanMode(mode)
  if (!key) throw new Error('Choose a valid adventure mode.')
  if (!ownerId) throw new Error('A session owner is required.')
  await ensureSchema()
  const ids = [...new Set([String(ownerId), ...(Array.isArray(participants) ? participants : []).map(String)])].slice(0, 5)
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = makeCode(key)
    try {
      const row = (await db().query(
        `INSERT INTO axyon_adventure_saves(code,mode,owner_id,group_jid,room_key,participants,snapshot)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING *`,
        [code, key, String(ownerId), String(groupJid || ''), roomKey ? String(roomKey) : null,
          JSON.stringify(ids), JSON.stringify(snapshot || {})]
      )).rows[0]
      return row
    } catch (error) {
      if (error.code !== '23505' || attempt === 3) throw error
    }
  }
  throw new Error('Could not generate a unique save code. Try again.')
}
async function getSave (code) {
  await ensureSchema()
  const cleaned = String(code || '').trim().toUpperCase()
  if (!/^AX-(SOLO|PARTY|MULTIPLAYER|GUILD|DUEL|ABYSS)-[A-F0-9]{6}$/.test(cleaned)) return null
  return (await db().query("SELECT * FROM axyon_adventure_saves WHERE code=$1 AND status='active'", [cleaned])).rows[0] || null
}
async function listSaves (ownerId) {
  await ensureSchema()
  return (await db().query("SELECT code,mode,group_jid,room_key,status,created_at,updated_at FROM axyon_adventure_saves WHERE owner_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 30", [String(ownerId)])).rows
}
async function latestSave (ownerId, mode = null) {
  await ensureSchema()
  const key = mode ? cleanMode(mode) : null
  return (await db().query(
    `SELECT * FROM axyon_adventure_saves WHERE owner_id=$1 AND status='active'
       AND ($2::text IS NULL OR mode=$2) ORDER BY created_at DESC LIMIT 1`,
    [String(ownerId), key]
  )).rows[0] || null
}
async function deleteSave (code, ownerId) {
  await ensureSchema()
  const row = (await db().query(
    `UPDATE axyon_adventure_saves SET status='deleted',deleted_at=NOW(),updated_at=NOW()
     WHERE code=$1 AND owner_id=$2 AND status='active' RETURNING code`,
    [String(code || '').toUpperCase(), String(ownerId)]
  )).rows[0]
  return Boolean(row)
}
async function unlockSkin (userId, skinId) {
  await ensureSchema()
  const skin = String(skinId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40)
  if (!skin || skin === 'default') return false
  await db().query('INSERT INTO axyon_player_skins(user_id,skin_id,equipped) VALUES($1,$2,FALSE) ON CONFLICT(user_id,skin_id) DO NOTHING', [String(userId), skin])
  return true
}
async function skins (userId) {
  await ensureSchema()
  return (await db().query('SELECT skin_id,equipped,unlocked_at FROM axyon_player_skins WHERE user_id=$1 ORDER BY unlocked_at', [String(userId)])).rows
}
async function equipSkin (userId, skinId) {
  const skin = String(skinId || '').trim().toLowerCase()
  await ensureSchema()
  if (skin === 'default') {
    await db().query('UPDATE axyon_player_skins SET equipped=FALSE WHERE user_id=$1', [String(userId)])
    return { ok: true, skin: 'default' }
  }
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const owned = await client.query('SELECT skin_id FROM axyon_player_skins WHERE user_id=$1 AND skin_id=$2 FOR UPDATE', [String(userId), skin])
    if (!owned.rowCount) { await client.query('ROLLBACK'); return { ok: false, message: 'That skin is not unlocked on your profile.' } }
    await client.query('UPDATE axyon_player_skins SET equipped=FALSE WHERE user_id=$1', [String(userId)])
    await client.query('UPDATE axyon_player_skins SET equipped=TRUE WHERE user_id=$1 AND skin_id=$2', [String(userId), skin])
    await client.query('COMMIT')
    return { ok: true, skin }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

module.exports = {
  MODES, cleanMode, codeMode, makeCode, ensureSchema, getModeLocks, modeLock, setModeLock,
  createSave, getSave, listSaves, latestSave, deleteSave,
  unlockSkin, skins, equipSkin
}
