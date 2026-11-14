'use strict'
/*
 * AXYON STORE — persistence for the Architect RPG.
 *
 * Every table is prefixed axyon_ so it never collides with the pairing and
 * session tables (rimuru_wa_auth, rimuru_wa_accounts) that auth-store and
 * account-config own.
 */
const { database } = require('./auth-store')
const { cache } = require('./cache')

const RANKS = ['E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'Monarch']
const RANK_LEVEL = { E: 1, D: 10, C: 20, B: 30, A: 40, S: 50, SS: 60, SSS: 70, Monarch: 80 }
/* Power Energy runs 50 → 220 across the nine ranks (manuscript: "50 220").
 * Monarch is deliberately a larger final step. */
const POWER_ENERGY_BY_RANK = { E: 50, D: 70, C: 90, B: 110, A: 130, S: 150, SS: 170, SSS: 190, Monarch: 220 }
const POWER_ENERGY_BASE = 50
const POWER_ENERGY_CAP = 220
const GRADE_HP = 15
const GRADE_ATK = 4
const BASE_ATK = 6
const BASE_HP = 100
const BASE_DEF = 4
const BASE_SPD = 5

const DEFAULT_SETTINGS = {
  prefix: '!',
  xpDailyLimit: 5000,
  zenDailyLimit: 5000,
  partyMax: 5,
  partyMin: 2,
  selfHealPerCombat: 5,
  classMovesPerDay: 3,
  cardAbilitiesPerDay: 3,
  duelAutoPromote: true,
  groupRegistrationRequired: true,
  watermark: '\u232c AXYN CORE',
  /* The bot's creators, shown in every card header. AXYON is the OWNER TITLE
   * of the bot, not a creator — these two are separate concepts and the
   * dashboard edits them separately. */
  creators: ['Lil Clutch', 'Montai'],
  botName: 'Architect',
  /* The in-bot assistant. It explains commands; it cannot run them. */
  aiEnabled: true,
  aiModel: '',
  aiTimeoutMs: 12000
}

const ORIGINAL_STAGES = [
  { key: 'stage_1', name: 'Outer Gate', ordinal: 1, hp: 60, atk: 5, def: 2, xp: 40, zen: 60 },
  { key: 'stage_2', name: 'Broken Causeway', ordinal: 2, hp: 110, atk: 9, def: 4, xp: 80, zen: 120 },
  { key: 'stage_3', name: 'Hollow Threshold', ordinal: 3, hp: 180, atk: 14, def: 7, xp: 140, zen: 220 }
]

let ready = false
function db () {
  const d = database()
  if (!d) throw Object.assign(new Error('DATABASE_URL is required for the AXYON RPG'), { status: 503 })
  return d
}

async function ensureSchema () {
  if (ready) return
  await db().query(`
    CREATE TABLE IF NOT EXISTS axyon_settings(
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_groups(
      group_jid TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      registered_by TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      prefix TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_players(
      user_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      rank TEXT NOT NULL DEFAULT 'E',
      level INT NOT NULL DEFAULT 1,
      grade INT NOT NULL DEFAULT 1,
      xp INT NOT NULL DEFAULT 0,
      zen BIGINT NOT NULL DEFAULT 0,
      coins BIGINT NOT NULL DEFAULT 0,
      hp INT NOT NULL DEFAULT 100,
      max_hp INT NOT NULL DEFAULT 100,
      atk INT NOT NULL DEFAULT 6,
      def INT NOT NULL DEFAULT 4,
      spd INT NOT NULL DEFAULT 5,
      power_energy INT NOT NULL DEFAULT 50,
      max_power_energy INT NOT NULL DEFAULT 50,
      stage INT NOT NULL DEFAULT 1,
      wins INT NOT NULL DEFAULT 0,
      losses INT NOT NULL DEFAULT 0,
      zen_today BIGINT NOT NULL DEFAULT 0,
      xp_today INT NOT NULL DEFAULT 0,
      day_key TEXT NOT NULL DEFAULT '',
      class TEXT NOT NULL DEFAULT 'Fighter',
      class_moves_used INT NOT NULL DEFAULT 0,
      heal_uses INT NOT NULL DEFAULT 0,
      card_uses INT NOT NULL DEFAULT 0,
      last_daily TIMESTAMPTZ,
      active_battle JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_stages(
      id BIGSERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      ordinal INT NOT NULL,
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      original BOOLEAN NOT NULL DEFAULT FALSE,
      hp INT NOT NULL DEFAULT 60,
      atk INT NOT NULL DEFAULT 5,
      def INT NOT NULL DEFAULT 2,
      xp INT NOT NULL DEFAULT 40,
      zen INT NOT NULL DEFAULT 60,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_floors(
      id BIGSERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      ordinal INT NOT NULL,
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      boss BOOLEAN NOT NULL DEFAULT FALSE,
      hp INT NOT NULL DEFAULT 200,
      atk INT NOT NULL DEFAULT 12,
      def INT NOT NULL DEFAULT 6,
      xp INT NOT NULL DEFAULT 150,
      zen INT NOT NULL DEFAULT 200,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_cards(
      id BIGSERIAL PRIMARY KEY,
      owner_id TEXT NOT NULL,
      slot INT NOT NULL DEFAULT 1,
      equipped_slot SMALLINT,
      card_type TEXT NOT NULL DEFAULT 'character',
      series TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      weapon TEXT NOT NULL DEFAULT '',
      damage INT NOT NULL DEFAULT 0,
      ability TEXT NOT NULL DEFAULT '',
      ability_damage INT NOT NULL DEFAULT 0,
      rating INT NOT NULL DEFAULT 1,
      claimed BOOLEAN NOT NULL DEFAULT FALSE,
      expires_at TIMESTAMPTZ,
      image_url TEXT NOT NULL DEFAULT '',
      image_data BYTEA,
      renderer TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      source_artist TEXT NOT NULL DEFAULT '',
      ability_uses SMALLINT NOT NULL DEFAULT 0,
      ability_day TEXT NOT NULL DEFAULT '',
      drop_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS equipped_slot SMALLINT;
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS card_type TEXT NOT NULL DEFAULT 'character';
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS series TEXT NOT NULL DEFAULT '';
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS ability_uses SMALLINT NOT NULL DEFAULT 0;
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS ability_day TEXT NOT NULL DEFAULT '';
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS source_artist TEXT NOT NULL DEFAULT '';
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS image_data BYTEA;
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS renderer TEXT NOT NULL DEFAULT '';
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS source_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE axyon_cards ADD COLUMN IF NOT EXISTS drop_code TEXT;

    CREATE TABLE IF NOT EXISTS axyon_card_drops(
      id BIGSERIAL PRIMARY KEY,
      claim_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      weapon TEXT NOT NULL DEFAULT '',
      damage INT NOT NULL DEFAULT 0,
      ability TEXT NOT NULL DEFAULT '',
      ability_damage INT NOT NULL DEFAULT 0,
      rating INT NOT NULL DEFAULT 1,
      image_url TEXT NOT NULL DEFAULT '',
      image_data BYTEA NOT NULL,
      renderer TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      source_artist TEXT NOT NULL DEFAULT '',
      card_type TEXT NOT NULL DEFAULT 'character',
      series TEXT NOT NULL DEFAULT '',
      expires_at TIMESTAMPTZ,
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE axyon_card_drops ADD COLUMN IF NOT EXISTS source_artist TEXT NOT NULL DEFAULT '';
    ALTER TABLE axyon_card_drops ADD COLUMN IF NOT EXISTS card_type TEXT NOT NULL DEFAULT 'character';
    ALTER TABLE axyon_card_drops ADD COLUMN IF NOT EXISTS series TEXT NOT NULL DEFAULT '';
    ALTER TABLE axyon_card_drops ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS axyon_cards_owner ON axyon_cards(owner_id);
    CREATE UNIQUE INDEX IF NOT EXISTS axyon_cards_equipped_slot_unique
      ON axyon_cards(owner_id,equipped_slot) WHERE equipped_slot IS NOT NULL;
    CREATE INDEX IF NOT EXISTS axyon_card_drops_unclaimed ON axyon_card_drops(created_at) WHERE claimed_by IS NULL;
    CREATE TABLE IF NOT EXISTS axyon_card_spawn_state(
      singleton_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK(singleton_id=1),
      last_auto_spawn_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    INSERT INTO axyon_card_spawn_state(singleton_id) VALUES(1) ON CONFLICT(singleton_id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS axyon_social(
      id BIGSERIAL PRIMARY KEY,
      requester TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'marriage',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_roles(
      user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'rhm',
      added_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_numbers(
      user_id TEXT PRIMARY KEY,
      added_by TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'axyon',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE axyon_numbers ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'axyon';

    CREATE TABLE IF NOT EXISTS axyon_visuals(
      mode TEXT PRIMARY KEY,
      url TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_modes(
      mode TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      max_players INT NOT NULL DEFAULT 5,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_parties(
      id BIGSERIAL PRIMARY KEY,
      group_jid TEXT NOT NULL,
      leader TEXT NOT NULL,
      members JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_duels(
      id BIGSERIAL PRIMARY KEY,
      group_jid TEXT NOT NULL,
      challenger TEXT NOT NULL,
      opponent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      promoted JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_inventory(
      user_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      qty INT NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, item_key));

    CREATE TABLE IF NOT EXISTS axyon_log(
      id BIGSERIAL PRIMARY KEY,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE INDEX IF NOT EXISTS axyon_players_rank ON axyon_players(rank, level DESC);
    CREATE INDEX IF NOT EXISTS axyon_cards_owner ON axyon_cards(owner_id);
    CREATE INDEX IF NOT EXISTS axyon_log_created ON axyon_log(created_at DESC);
  `)
  /*
   * MIGRATION — the active game mode.
   *
   * `axyon_players` already exists on a live deployment, so the column is added
   * with ADD COLUMN IF NOT EXISTS rather than being folded into the CREATE
   * above. Existing players default to `general`, which is the mode that holds
   * the social and economy commands they were already using.
   */
  await db().query("ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS game_mode TEXT NOT NULL DEFAULT 'general'")
  for (const s of ORIGINAL_STAGES) {
    await db().query(
      `INSERT INTO axyon_stages(key,name,ordinal,original,hp,atk,def,xp,zen)
       VALUES($1,$2,$3,TRUE,$4,$5,$6,$7,$8) ON CONFLICT(key) DO NOTHING`,
      [s.key, s.name, s.ordinal, s.hp, s.atk, s.def, s.xp, s.zen]
    )
  }
  for (const m of ['duel', 'solo', 'multiplayer', 'party']) {
    await db().query('INSERT INTO axyon_modes(mode,enabled,max_players) VALUES($1,TRUE,$2) ON CONFLICT(mode) DO NOTHING', [m, DEFAULT_SETTINGS.partyMax])
  }
  await db().query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY slot,id) AS rn
      FROM axyon_cards WHERE claimed=TRUE AND equipped_slot IS NULL
        AND (expires_at IS NULL OR expires_at>NOW())
    )
    UPDATE axyon_cards c SET equipped_slot=ranked.rn
    FROM ranked WHERE c.id=ranked.id AND ranked.rn<=2
      AND NOT EXISTS (SELECT 1 FROM axyon_cards e WHERE e.owner_id=c.owner_id AND e.equipped_slot IS NOT NULL)
  `)
  ready = true
}

/* ---------------------------------------------------------------- settings */

/*
 * CACHED READS
 * ------------
 * settings / group / axyonNumberMode / roleOf are read on EVERY message and
 * change rarely. They are cached for 30 s and invalidated on write, which
 * removes four Postgres round trips from the hot path.
 *
 * Player rows and battles are deliberately never cached: they change on every
 * turn and a stale read would corrupt progression.
 */
async function settings () {
  return cache.wrap('settings', async () => {
    await ensureSchema()
    const rows = (await db().query('SELECT key,value FROM axyon_settings')).rows
    const out = { ...DEFAULT_SETTINGS }
    for (const r of rows) out[r.key] = r.value
    return out
  })
}

async function getSetting (key) {
  const all = await settings()
  return all[key]
}

async function setSetting (key, value) {
  await ensureSchema()
  await db().query(
    `INSERT INTO axyon_settings(key,value) VALUES($1,$2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,
    [key, JSON.stringify(value)]
  )
  cache.invalidate('settings')
  return value
}

async function setSettings (patch = {}) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue
    await setSetting(k, v)
  }
  return settings()
}

/* ------------------------------------------------------------------ groups */

async function registerGroup (jid, name, by) {
  await ensureSchema()
  const r = await db().query(
    `INSERT INTO axyon_groups(group_jid,name,registered_by,enabled) VALUES($1,$2,$3,TRUE)
     ON CONFLICT(group_jid) DO UPDATE SET name=EXCLUDED.name,enabled=TRUE,updated_at=NOW()
     RETURNING *`,
    [jid, name || '', by || '']
  )
  cache.invalidate(`group:${jid}`)
  return r.rows[0]
}

async function unregisterGroup (jid) {
  await ensureSchema()
  const r = await db().query('DELETE FROM axyon_groups WHERE group_jid=$1', [jid])
  cache.invalidate(`group:${jid}`)
  return r.rowCount > 0
}

async function group (jid) {
  return cache.wrap(`group:${jid}`, async () => {
    await ensureSchema()
    return (await db().query('SELECT * FROM axyon_groups WHERE group_jid=$1', [jid])).rows[0] || null
  })
}

async function groups () {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_groups ORDER BY created_at DESC')).rows
}

async function setGroupEnabled (jid, enabled) {
  await ensureSchema()
  const r = await db().query('UPDATE axyon_groups SET enabled=$2,updated_at=NOW() WHERE group_jid=$1 RETURNING *', [jid, !!enabled])
  cache.invalidate(`group:${jid}`)
  return r.rows[0] || null
}

async function setGroupPrefix (jid, prefix) {
  await ensureSchema()
  const r = await db().query('UPDATE axyon_groups SET prefix=$2,updated_at=NOW() WHERE group_jid=$1 RETURNING *', [jid, prefix || null])
  cache.invalidate(`group:${jid}`)
  return r.rows[0] || null
}

/* ----------------------------------------------------------------- players */

function dayKey (d = new Date()) {
  return d.toISOString().slice(0, 10)
}

function xpNeed (level) {
  return 100 + Math.max(1, Number(level) || 1) * 50
}

function rankForLevel (level) {
  let rank = 'E'
  for (const r of RANKS) if (level >= RANK_LEVEL[r]) rank = r
  return rank
}

function norm (r) {
  if (!r) return null
  return {
    userId: r.user_id,
    name: r.name,
    rank: r.rank,
    level: Number(r.level),
    grade: Number(r.grade),
    xp: Number(r.xp),
    zen: Number(r.zen),
    coins: Number(r.coins),
    hp: Number(r.hp),
    maxHp: Number(r.max_hp),
    atk: Number(r.atk),
    def: Number(r.def),
    spd: Number(r.spd),
    powerEnergy: Number(r.power_energy),
    maxPowerEnergy: Number(r.max_power_energy),
    stage: Number(r.stage),
    wins: Number(r.wins),
    losses: Number(r.losses),
    zenToday: Number(r.zen_today),
    xpToday: Number(r.xp_today),
    dayKey: r.day_key,
    class: r.class,
    classMovesUsed: Number(r.class_moves_used),
    healUses: Number(r.heal_uses),
    cardUses: Number(r.card_uses),
    lastDaily: r.last_daily,
    gameMode: r.game_mode || 'general',
    createdAt: r.created_at
  }
}

async function arise (userId, name = '') {
  await ensureSchema()
  const r = await db().query(
    `INSERT INTO axyon_players(user_id,name,day_key) VALUES($1,$2,$3)
     ON CONFLICT(user_id) DO UPDATE SET
       name=CASE WHEN $2<>'' THEN $2 ELSE axyon_players.name END,
       updated_at=NOW()
     RETURNING *, (xmax=0) AS created`,
    [userId, name, dayKey()]
  )
  return { player: norm(r.rows[0]), created: r.rows[0].created === true }
}

async function player (userId) {
  await ensureSchema()
  return norm((await db().query('SELECT * FROM axyon_players WHERE user_id=$1', [userId])).rows[0])
}

async function savePlayer (p) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_players SET name=$2,rank=$3,level=$4,grade=$5,xp=$6,zen=$7,coins=$8,hp=$9,max_hp=$10,
       atk=$11,def=$12,spd=$13,power_energy=$14,max_power_energy=$15,stage=$16,wins=$17,losses=$18,
       zen_today=$19,xp_today=$20,day_key=$21,class=$22,class_moves_used=$23,heal_uses=$24,card_uses=$25,
       last_daily=$26,updated_at=NOW()
     WHERE user_id=$1 RETURNING *`,
    [p.userId, p.name, p.rank, p.level, p.grade, p.xp, p.zen, p.coins, p.hp, p.maxHp,
      p.atk, p.def, p.spd, p.powerEnergy, p.maxPowerEnergy, p.stage, p.wins, p.losses,
      p.zenToday, p.xpToday, p.dayKey, p.class, p.classMovesUsed, p.healUses, p.cardUses, p.lastDaily]
  )
  return norm(r.rows[0])
}

/** Rolls the daily counters over when the calendar day changes. */
function rollDay (p) {
  const today = dayKey()
  if (p.dayKey === today) return p
  return { ...p, dayKey: today, zenToday: 0, xpToday: 0, classMovesUsed: 0, cardUses: 0 }
}

async function resetPlayer (userId) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_players SET rank='E',level=1,grade=1,xp=0,zen=0,coins=0,hp=$2,max_hp=$2,atk=$3,def=$4,spd=$5,
       power_energy=$6,max_power_energy=$6,stage=1,wins=0,losses=0,zen_today=0,xp_today=0,day_key=$7,
       class_moves_used=0,heal_uses=0,card_uses=0,updated_at=NOW()
     WHERE user_id=$1 RETURNING *`,
    [userId, BASE_HP, BASE_ATK, BASE_DEF, BASE_SPD, POWER_ENERGY_BASE, dayKey()]
  )
  return norm(r.rows[0])
}

async function leaderboard (limit = 10) {
  await ensureSchema()
  return (await db().query(
    'SELECT * FROM axyon_players ORDER BY level DESC, xp DESC, zen DESC LIMIT $1', [limit]
  )).rows.map(norm)
}

async function playerCount () {
  await ensureSchema()
  return Number((await db().query('SELECT COUNT(*)::int c FROM axyon_players')).rows[0].c)
}

/**
 * Sets the player's active game mode.
 *
 * The mode is stored on the player row, not in memory, so it survives a
 * reconnect and is the same in every chat the player uses.
 */
async function setGameMode (userId, mode) {
  await ensureSchema()
  const r = await db().query(
    'UPDATE axyon_players SET game_mode=$2,updated_at=NOW() WHERE user_id=$1 RETURNING game_mode',
    [userId, mode]
  )
  return r.rows[0]?.game_mode || null
}

async function setBattle (userId, battle) {
  await ensureSchema()
  await db().query('UPDATE axyon_players SET active_battle=$2::jsonb,updated_at=NOW() WHERE user_id=$1', [userId, battle ? JSON.stringify(battle) : null])
}

async function getBattle (userId) {
  await ensureSchema()
  return (await db().query('SELECT active_battle FROM axyon_players WHERE user_id=$1', [userId])).rows[0]?.active_battle || null
}

/* ------------------------------------------------------------------ stages */

async function stages () {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_stages ORDER BY ordinal,id')).rows
}

async function stage (ordinal) {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_stages WHERE ordinal=$1', [ordinal])).rows[0] || null
}

async function addStage ({ name, hp, atk, def, xp, zen }) {
  await ensureSchema()
  const max = Number((await db().query('SELECT COALESCE(MAX(ordinal),0) m FROM axyon_stages')).rows[0].m)
  const key = `custom_${Date.now().toString(36)}`
  const r = await db().query(
    `INSERT INTO axyon_stages(key,name,ordinal,original,hp,atk,def,xp,zen)
     VALUES($1,$2,$3,FALSE,$4,$5,$6,$7,$8) RETURNING *`,
    [key, name, max + 1, hp, atk, def, xp, zen]
  )
  return r.rows[0]
}

async function editStage (ordinal, patch) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_stages SET name=COALESCE($2,name),hp=COALESCE($3,hp),atk=COALESCE($4,atk),
       def=COALESCE($5,def),xp=COALESCE($6,xp),zen=COALESCE($7,zen) WHERE ordinal=$1 RETURNING *`,
    [ordinal, patch.name ?? null, patch.hp ?? null, patch.atk ?? null, patch.def ?? null, patch.xp ?? null, patch.zen ?? null]
  )
  return r.rows[0] || null
}

async function moveStage (ordinal, to) {
  await ensureSchema()
  const target = await stage(to)
  if (!target) return null
  const from = await stage(ordinal)
  if (!from) return null
  await db().query('UPDATE axyon_stages SET ordinal=$2 WHERE id=$1', [from.id, -1])
  await db().query('UPDATE axyon_stages SET ordinal=$2 WHERE id=$1', [target.id, ordinal])
  await db().query('UPDATE axyon_stages SET ordinal=$2 WHERE id=$1', [from.id, to])
  return stages()
}

async function lockStage (ordinal, locked) {
  await ensureSchema()
  const r = await db().query('UPDATE axyon_stages SET locked=$2 WHERE ordinal=$1 RETURNING *', [ordinal, !!locked])
  return r.rows[0] || null
}

async function removeStage (ordinal) {
  await ensureSchema()
  const s = await stage(ordinal)
  if (!s) return { ok: false, message: 'No stage at that position.' }
  if (s.original) return { ok: false, message: 'The original three stages cannot be removed.' }
  await db().query('DELETE FROM axyon_stages WHERE id=$1', [s.id])
  return { ok: true, stage: s }
}

/* ------------------------------------------------------------------ floors */

async function floors () {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_floors ORDER BY ordinal,id')).rows
}

async function addFloor ({ name, hp, atk, def, xp, zen, boss }) {
  await ensureSchema()
  const max = Number((await db().query('SELECT COALESCE(MAX(ordinal),0) m FROM axyon_floors')).rows[0].m)
  const key = `floor_${Date.now().toString(36)}`
  const r = await db().query(
    `INSERT INTO axyon_floors(key,name,ordinal,boss,hp,atk,def,xp,zen)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [key, name, max + 1, !!boss, hp, atk, def, xp, zen]
  )
  return r.rows[0]
}

async function editFloor (ordinal, patch) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_floors SET name=COALESCE($2,name),hp=COALESCE($3,hp),atk=COALESCE($4,atk),
       def=COALESCE($5,def),xp=COALESCE($6,xp),zen=COALESCE($7,zen) WHERE ordinal=$1 RETURNING *`,
    [ordinal, patch.name ?? null, patch.hp ?? null, patch.atk ?? null, patch.def ?? null, patch.xp ?? null, patch.zen ?? null]
  )
  return r.rows[0] || null
}

async function lockFloor (ordinal, locked) {
  await ensureSchema()
  const r = await db().query('UPDATE axyon_floors SET locked=$2 WHERE ordinal=$1 RETURNING *', [ordinal, !!locked])
  return r.rows[0] || null
}

async function removeFloor (ordinal) {
  await ensureSchema()
  const r = await db().query('DELETE FROM axyon_floors WHERE ordinal=$1 RETURNING *', [ordinal])
  return r.rows[0] || null
}

/* ------------------------------------------------------------------- cards */

async function cards (ownerId) {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_cards WHERE owner_id=$1 ORDER BY slot,id', [ownerId])).rows
}

async function card (ownerId, collectionNo) {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_cards WHERE owner_id=$1 AND slot=$2', [ownerId, collectionNo])).rows[0] || null
}

async function addCard (ownerId, c) {
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(ownerId)])
    await client.query('SELECT user_id FROM axyon_players WHERE user_id=$1 FOR UPDATE', [ownerId])
    const number = Number(c.slot) > 0 ? Number(c.slot) : Number((await client.query(
      'SELECT COALESCE(MAX(slot),0)+1 AS next FROM axyon_cards WHERE owner_id=$1', [ownerId]
    )).rows[0].next)
    const r = await client.query(
      `INSERT INTO axyon_cards(owner_id,slot,equipped_slot,card_type,series,name,weapon,damage,ability,ability_damage,rating,claimed,expires_at,image_url,image_data,renderer,source_url,source_artist,drop_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [ownerId, number, c.equippedSlot || null, c.cardType || 'character', c.series || '', c.name, c.weapon || '', c.damage || 0,
        c.ability || '', c.abilityDamage || 0, c.rating || 1, c.claimed === true, c.expiresAt || null,
        c.imageUrl || '', c.imageData || null, c.renderer || '', c.sourceUrl || '', c.sourceArtist || '', c.dropCode || null]
    )
    await client.query('COMMIT')
    return r.rows[0]
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function claimCard (ownerId, collectionNo) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_cards SET claimed=TRUE
     WHERE owner_id=$1 AND slot=$2 AND claimed=FALSE AND (expires_at IS NULL OR expires_at>NOW()) RETURNING *`,
    [ownerId, collectionNo]
  )
  return r.rows[0] || null
}

async function createCardDrop (drop) {
  await ensureSchema()
  const r = await db().query(
    `INSERT INTO axyon_card_drops(claim_code,name,weapon,damage,ability,ability_damage,rating,image_url,image_data,renderer,source_url,source_artist,card_type,series,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id,claim_code,name,weapon,damage,ability,ability_damage,rating,renderer,source_url,source_artist,card_type,series,expires_at,created_at`,
    [drop.code, drop.name, drop.weapon || '', drop.damage || 0, drop.ability || '', drop.abilityDamage || 0,
      drop.rating || 1, drop.imageUrl || '', drop.imageData, drop.renderer || '', drop.sourceUrl || '',
      drop.sourceArtist || '', drop.cardType || 'character', drop.series || '', drop.expiresAt || null]
  )
  return r.rows[0]
}

async function claimCardDrop (ownerId, rawCode) {
  await ensureSchema()
  const code = String(rawCode || '').replace(/^#/, '').trim().toUpperCase()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const player = await client.query('SELECT user_id FROM axyon_players WHERE user_id=$1 FOR UPDATE', [ownerId])
    if (!player.rows[0]) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_registered' } }
    const found = await client.query('SELECT * FROM axyon_card_drops WHERE claim_code=$1 FOR UPDATE', [code])
    const drop = found.rows[0]
    if (!drop) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' } }
    if (drop.claimed_by) { await client.query('ROLLBACK'); return { ok: false, reason: 'claimed' } }
    if (drop.expires_at && new Date(drop.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK'); return { ok: false, reason: 'expired' }
    }
    const slotResult = await client.query('SELECT COALESCE(MAX(slot),0)+1 AS next FROM axyon_cards WHERE owner_id=$1', [ownerId])
    const collectionNo = Number(slotResult.rows[0].next)
    const updated = await client.query(
      'UPDATE axyon_card_drops SET claimed_by=$2,claimed_at=NOW() WHERE id=$1 AND claimed_by IS NULL RETURNING id',
      [drop.id, ownerId]
    )
    if (!updated.rows[0]) { await client.query('ROLLBACK'); return { ok: false, reason: 'claimed' } }
    const inserted = await client.query(
      `INSERT INTO axyon_cards(owner_id,slot,card_type,series,name,weapon,damage,ability,ability_damage,rating,claimed,expires_at,image_url,image_data,renderer,source_url,source_artist,drop_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [ownerId, collectionNo, drop.card_type || 'character', drop.series || '', drop.name, drop.weapon, drop.damage, drop.ability,
        drop.ability_damage, drop.rating, drop.expires_at, drop.image_url, drop.image_data, drop.renderer,
        drop.source_url, drop.source_artist || '', drop.claim_code]
    )
    await client.query('COMMIT')
    return { ok: true, card: inserted.rows[0], slot: collectionNo }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function equipCard (ownerId, collectionNo, requestedSlot = null) {
  await ensureSchema()
  if (requestedSlot != null && ![1, 2].includes(Number(requestedSlot))) return { ok: false, reason: 'invalid_slot' }
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT user_id FROM axyon_players WHERE user_id=$1 FOR UPDATE', [ownerId])
    await client.query('UPDATE axyon_cards SET equipped_slot=NULL WHERE owner_id=$1 AND equipped_slot IS NOT NULL AND expires_at<=NOW()', [ownerId])
    const found = await client.query(
      `SELECT * FROM axyon_cards WHERE owner_id=$1 AND slot=$2 AND claimed=TRUE FOR UPDATE`, [ownerId, collectionNo]
    )
    const c = found.rows[0]
    if (!c) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_owned' } }
    if (c.expires_at && new Date(c.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK'); return { ok: false, reason: 'expired' }
    }
    let target = Number(requestedSlot)
    if (![1, 2].includes(target) && c.equipped_slot) target = Number(c.equipped_slot)
    if (![1, 2].includes(target)) {
      const used = await client.query('SELECT equipped_slot FROM axyon_cards WHERE owner_id=$1 AND equipped_slot IS NOT NULL FOR UPDATE', [ownerId])
      const occupied = new Set(used.rows.map(x => Number(x.equipped_slot)))
      target = [1, 2].find(x => !occupied.has(x))
      if (!target) { await client.query('ROLLBACK'); return { ok: false, reason: 'slots_full' } }
    }
    await client.query('UPDATE axyon_cards SET equipped_slot=NULL WHERE owner_id=$1 AND slot=$2', [ownerId, collectionNo])
    await client.query('UPDATE axyon_cards SET equipped_slot=NULL WHERE owner_id=$1 AND equipped_slot=$2', [ownerId, target])
    const updated = await client.query('UPDATE axyon_cards SET equipped_slot=$3 WHERE owner_id=$1 AND slot=$2 RETURNING *', [ownerId, collectionNo, target])
    await client.query('COMMIT')
    return { ok: true, card: updated.rows[0], equippedSlot: target }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function unequipCard (ownerId, equippedSlot) {
  await ensureSchema()
  if (![1, 2].includes(Number(equippedSlot))) return null
  const r = await db().query(
    'UPDATE axyon_cards SET equipped_slot=NULL WHERE owner_id=$1 AND equipped_slot=$2 RETURNING *', [ownerId, Number(equippedSlot)]
  )
  return r.rows[0] || null
}

async function equippedCards (ownerId) {
  await ensureSchema()
  await db().query('UPDATE axyon_cards SET equipped_slot=NULL WHERE owner_id=$1 AND equipped_slot IS NOT NULL AND expires_at<=NOW()', [ownerId])
  return (await db().query('SELECT * FROM axyon_cards WHERE owner_id=$1 AND equipped_slot IS NOT NULL ORDER BY equipped_slot', [ownerId])).rows
}

async function useCardAbility (ownerId, equippedSlot) {
  await ensureSchema()
  const today = dayKey()
  const r = await db().query(
    `UPDATE axyon_cards SET
       ability_uses=CASE WHEN ability_day=$3 THEN ability_uses+1 ELSE 1 END,
       ability_day=$3
     WHERE owner_id=$1 AND equipped_slot=$2 AND claimed=TRUE
       AND (expires_at IS NULL OR expires_at>NOW())
       AND CASE WHEN ability_day=$3 THEN ability_uses ELSE 0 END < 3
       AND ability IS NOT NULL AND ability<>''
     RETURNING *`, [ownerId, Number(equippedSlot), today]
  )
  if (r.rows[0]) return { ok: true, card: r.rows[0] }
  const current = await db().query('SELECT * FROM axyon_cards WHERE owner_id=$1 AND equipped_slot=$2', [ownerId, Number(equippedSlot)])
  const c = current.rows[0]
  if (!c) return { ok: false, reason: 'empty_slot' }
  if (c.expires_at && new Date(c.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' }
  if (!c.ability) return { ok: false, reason: 'no_ability' }
  return { ok: false, reason: 'depleted' }
}

async function editCard (ownerId, collectionNo, patch) {
  await ensureSchema()
  const allowed = { name: 'name', cardType: 'card_type', series: 'series', weapon: 'weapon', damage: 'damage', ability: 'ability', abilityDamage: 'ability_damage', rating: 'rating', expiresAt: 'expires_at', imageUrl: 'image_url', imageData: 'image_data', renderer: 'renderer', sourceUrl: 'source_url', sourceArtist: 'source_artist' }
  const keys = Object.keys(patch || {}).filter(k => allowed[k])
  if (!keys.length) return null
  const values = [ownerId, collectionNo]
  const sets = keys.map((k, i) => { values.push(patch[k]); return `${allowed[k]}=$${i + 3}` })
  const r = await db().query(`UPDATE axyon_cards SET ${sets.join(',')} WHERE owner_id=$1 AND slot=$2 RETURNING *`, values)
  return r.rows[0] || null
}

async function removeCard (ownerId, collectionNo) {
  await ensureSchema()
  const r = await db().query('DELETE FROM axyon_cards WHERE owner_id=$1 AND slot=$2 RETURNING *', [ownerId, collectionNo])
  return r.rows[0] || null
}

async function cardDrops () {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_card_drops ORDER BY created_at DESC LIMIT 30')).rows
}

async function removeCardDrop (code) {
  await ensureSchema()
  const r = await db().query('DELETE FROM axyon_card_drops WHERE claim_code=$1 AND claimed_by IS NULL RETURNING *', [String(code || '').replace(/^#/, '').trim().toUpperCase()])
  return r.rows[0] || null
}

async function cardSpawnState () {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_card_spawn_state WHERE singleton_id=1')).rows[0] || null
}

async function setLastAutoCardSpawnAt (date = new Date()) {
  await ensureSchema()
  await db().query(
    `INSERT INTO axyon_card_spawn_state(singleton_id,last_auto_spawn_at,updated_at)
     VALUES(1,$1,NOW()) ON CONFLICT(singleton_id)
     DO UPDATE SET last_auto_spawn_at=EXCLUDED.last_auto_spawn_at,updated_at=NOW()`,
    [date]
  )
}

/* ------------------------------------------------------------------ social */

async function socialRequest (requester, target, kind = 'marriage') {
  await ensureSchema()
  const existing = (await db().query(
    "SELECT * FROM axyon_social WHERE status='pending' AND ((requester=$1 AND target=$2) OR (requester=$2 AND target=$1))",
    [requester, target]
  )).rows[0]
  if (existing) return { ok: false, message: 'A request between you two is already pending.' }
  const r = await db().query(
    'INSERT INTO axyon_social(requester,target,kind) VALUES($1,$2,$3) RETURNING *',
    [requester, target, kind]
  )
  return { ok: true, request: r.rows[0] }
}

async function pendingSocial (target) {
  await ensureSchema()
  return (await db().query("SELECT * FROM axyon_social WHERE target=$1 AND status='pending' ORDER BY created_at DESC", [target])).rows
}

async function resolveSocial (id, target, accept) {
  await ensureSchema()
  const r = await db().query(
    "UPDATE axyon_social SET status=$3,updated_at=NOW() WHERE id=$1 AND target=$2 AND status='pending' RETURNING *",
    [id, target, accept ? 'accepted' : 'declined']
  )
  return r.rows[0] || null
}

async function partnerOf (userId) {
  await ensureSchema()
  return (await db().query(
    "SELECT * FROM axyon_social WHERE status='accepted' AND kind='marriage' AND (requester=$1 OR target=$1) LIMIT 1",
    [userId]
  )).rows[0] || null
}

async function endSocial (userId) {
  await ensureSchema()
  const r = await db().query(
    "UPDATE axyon_social SET status='divorced',updated_at=NOW() WHERE status='accepted' AND kind='marriage' AND (requester=$1 OR target=$1) RETURNING *",
    [userId]
  )
  return r.rows[0] || null
}

/* ------------------------------------------------------- roles and numbers */

async function addRole (userId, role, by) {
  await ensureSchema()
  const r = await db().query(
    `INSERT INTO axyon_roles(user_id,role,added_by) VALUES($1,$2,$3)
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role RETURNING *`,
    [userId, role, by || '']
  )
  cache.invalidate(`role:${userId}`)
  return r.rows[0]
}

async function removeRole (userId) {
  await ensureSchema()
  const r = await db().query('DELETE FROM axyon_roles WHERE user_id=$1', [userId])
  cache.invalidate(`role:${userId}`)
  return r.rowCount > 0
}

async function roles () {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_roles ORDER BY created_at')).rows
}

async function roleOf (userId) {
  return cache.wrap(`role:${userId}`, async () => {
    await ensureSchema()
    return (await db().query('SELECT role FROM axyon_roles WHERE user_id=$1', [userId])).rows[0]?.role || null
  })
}

async function addAxyonNumber (userId, by, mode = 'axyon') {
  await ensureSchema()
  const r = await db().query(
    'INSERT INTO axyon_numbers(user_id,added_by,mode) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET mode=EXCLUDED.mode RETURNING *',
    [userId, by || '', mode === 'player' ? 'player' : 'axyon']
  )
  cache.invalidate(`number:${userId}`)
  return r.rows[0] || null
}

/** Switches an authorised number between AXYON mode and PLAYER mode. */
async function setNumberMode (userId, mode) {
  await ensureSchema()
  const r = await db().query('UPDATE axyon_numbers SET mode=$2 WHERE user_id=$1 RETURNING *', [userId, mode === 'player' ? 'player' : 'axyon'])
  cache.invalidate(`number:${userId}`)
  return r.rows[0] || null
}

async function axyonNumberMode (userId) {
  return cache.wrap(`number:${userId}`, async () => {
    await ensureSchema()
    const row = (await db().query('SELECT mode FROM axyon_numbers WHERE user_id=$1', [userId])).rows[0]
    return row ? row.mode : null
  })
}

async function removeAxyonNumber (userId) {
  await ensureSchema()
  const r = await db().query('DELETE FROM axyon_numbers WHERE user_id=$1', [userId])
  cache.invalidate(`number:${userId}`)
  return r.rowCount > 0
}

async function axyonNumbers () {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_numbers ORDER BY created_at')).rows
}

/* ---------------------------------------------------------------- visuals */

async function visuals () {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_visuals ORDER BY mode')).rows
}

async function visual (mode) {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_visuals WHERE mode=$1', [mode])).rows[0] || null
}

async function setVisual (mode, url, caption) {
  await ensureSchema()
  const r = await db().query(
    `INSERT INTO axyon_visuals(mode,url,caption) VALUES($1,$2,$3)
     ON CONFLICT(mode) DO UPDATE SET url=EXCLUDED.url,caption=EXCLUDED.caption,updated_at=NOW() RETURNING *`,
    [mode, url || '', caption || '']
  )
  return r.rows[0]
}

async function clearVisual (mode) {
  await ensureSchema()
  await db().query('DELETE FROM axyon_visuals WHERE mode=$1', [mode])
}

/* ------------------------------------------------------------------ modes */

async function modes () {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_modes ORDER BY mode')).rows
}

async function setMode (mode, patch) {
  await ensureSchema()
  const r = await db().query(
    `INSERT INTO axyon_modes(mode,enabled,max_players) VALUES($1,COALESCE($2,TRUE),COALESCE($3,5))
     ON CONFLICT(mode) DO UPDATE SET enabled=COALESCE($2,axyon_modes.enabled),
       max_players=COALESCE($3,axyon_modes.max_players),updated_at=NOW() RETURNING *`,
    [mode, patch.enabled ?? null, patch.maxPlayers ?? null]
  )
  return r.rows[0]
}

/* ------------------------------------------------------------------ party */

async function createParty (jid, leader, members) {
  await ensureSchema()
  await db().query("UPDATE axyon_parties SET status='closed' WHERE group_jid=$1 AND status='open'", [jid])
  const r = await db().query(
    "INSERT INTO axyon_parties(group_jid,leader,members) VALUES($1,$2,$3::jsonb) RETURNING *",
    [jid, leader, JSON.stringify(members)]
  )
  return r.rows[0]
}

async function openParty (jid) {
  await ensureSchema()
  return (await db().query("SELECT * FROM axyon_parties WHERE group_jid=$1 AND status='open' ORDER BY id DESC LIMIT 1", [jid])).rows[0] || null
}

async function updateParty (id, members, status) {
  await ensureSchema()
  const r = await db().query(
    'UPDATE axyon_parties SET members=$2::jsonb,status=COALESCE($3,status) WHERE id=$1 RETURNING *',
    [id, JSON.stringify(members), status || null]
  )
  return r.rows[0] || null
}

/* ------------------------------------------------------------------- duels */

async function createDuel (jid, challenger, opponent) {
  await ensureSchema()
  const r = await db().query(
    'INSERT INTO axyon_duels(group_jid,challenger,opponent) VALUES($1,$2,$3) RETURNING *',
    [jid, challenger, opponent]
  )
  return r.rows[0]
}

async function duel (id) {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_duels WHERE id=$1', [id])).rows[0] || null
}

async function updateDuel (id, patch) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_duels SET status=COALESCE($2,status),state=COALESCE($3::jsonb,state),
       promoted=COALESCE($4::jsonb,promoted),updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id, patch.status ?? null, patch.state ? JSON.stringify(patch.state) : null, patch.promoted ? JSON.stringify(patch.promoted) : null]
  )
  return r.rows[0] || null
}

/* -------------------------------------------------------------- inventory */

/*
 * INVENTORY
 * ---------
 * One row per (player, item). `qty` is the stock; abilities are stored with
 * qty 1 and are never decremented, so "owned" and "in stock" are the same
 * column and there is no second table to keep in sync.
 *
 * These are deliberately NOT cached: a purchase or a use must be visible on the
 * very next read, and a stale inventory would let a player use an item twice.
 */

async function inventory (userId) {
  await ensureSchema()
  return (await db().query(
    'SELECT item_key, qty FROM axyon_inventory WHERE user_id=$1 AND qty>0 ORDER BY item_key',
    [userId]
  )).rows.map(r => ({ key: r.item_key, qty: Number(r.qty) }))
}

async function inventoryQty (userId, key) {
  await ensureSchema()
  const r = await db().query(
    'SELECT qty FROM axyon_inventory WHERE user_id=$1 AND item_key=$2',
    [userId, key]
  )
  return Number(r.rows[0]?.qty || 0)
}

/** Adds stock. Used by purchases and by rewards. */
async function addItem (userId, key, qty = 1) {
  await ensureSchema()
  const r = await db().query(
    `INSERT INTO axyon_inventory(user_id,item_key,qty) VALUES($1,$2,$3)
     ON CONFLICT(user_id,item_key) DO UPDATE SET qty=axyon_inventory.qty+$3
     RETURNING qty`,
    [userId, key, Math.max(1, Math.floor(qty))]
  )
  return Number(r.rows[0].qty)
}

/**
 * Removes one unit. Returns false when there is nothing to remove, so a caller
 * can refuse the action instead of going negative.
 */
async function consumeItem (userId, key) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_inventory SET qty=qty-1
     WHERE user_id=$1 AND item_key=$2 AND qty>0 RETURNING qty`,
    [userId, key]
  )
  return r.rows.length ? Number(r.rows[0].qty) : null
}

/* --------------------------------------------------------------------- log */

async function log (actor, action, target = '', detail = {}) {
  await ensureSchema()
  await db().query(
    'INSERT INTO axyon_log(actor,action,target,detail) VALUES($1,$2,$3,$4::jsonb)',
    [actor || '', action, target || '', JSON.stringify(detail || {})]
  )
}

async function recentLog (limit = 50) {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_log ORDER BY id DESC LIMIT $1', [limit])).rows
}

module.exports = {
  RANKS,
  RANK_LEVEL,
  POWER_ENERGY_BY_RANK,
  POWER_ENERGY_BASE,
  POWER_ENERGY_CAP,
  GRADE_HP,
  GRADE_ATK,
  BASE_ATK,
  BASE_HP,
  BASE_DEF,
  BASE_SPD,
  DEFAULT_SETTINGS,
  ORIGINAL_STAGES,
  ensureSchema,
  settings,
  getSetting,
  setSetting,
  setSettings,
  registerGroup,
  unregisterGroup,
  group,
  groups,
  setGroupEnabled,
  setGroupPrefix,
  dayKey,
  xpNeed,
  rankForLevel,
  norm,
  arise,
  player,
  savePlayer,
  rollDay,
  resetPlayer,
  leaderboard,
  playerCount,
  setBattle,
  setGameMode,
  getBattle,
  stages,
  stage,
  addStage,
  editStage,
  moveStage,
  lockStage,
  removeStage,
  floors,
  addFloor,
  editFloor,
  lockFloor,
  removeFloor,
  cards,
  card,
  addCard,
  claimCard,
  createCardDrop,
  claimCardDrop,
  equipCard,
  unequipCard,
  equippedCards,
  useCardAbility,
  editCard,
  removeCard,
  cardDrops,
  removeCardDrop,
  cardSpawnState,
  setLastAutoCardSpawnAt,
  socialRequest,
  pendingSocial,
  resolveSocial,
  partnerOf,
  endSocial,
  addRole,
  removeRole,
  roles,
  roleOf,
  addAxyonNumber,
  removeAxyonNumber,
  setNumberMode,
  axyonNumberMode,
  axyonNumbers,
  visuals,
  visual,
  setVisual,
  clearVisual,
  modes,
  setMode,
  createParty,
  openParty,
  updateParty,
  createDuel,
  duel,
  updateDuel,
  inventory,
  inventoryQty,
  addItem,
  consumeItem,
  log,
  recentLog
}
