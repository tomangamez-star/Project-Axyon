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
  { key: 'stage_3', name: 'Hollow Threshold', ordinal: 3, hp: 180, atk: 14, def: 7, xp: 140, zen: 220 },
  { key: 'stage_4', name: 'Ashen Causeway', ordinal: 4, hp: 250, atk: 19, def: 9, xp: 190, zen: 300 },
  { key: 'stage_5', name: 'Wraithbound Crossing', ordinal: 5, hp: 330, atk: 24, def: 12, xp: 260, zen: 420 },
  { key: 'stage_6', name: 'Obsidian Watch', ordinal: 6, hp: 430, atk: 30, def: 15, xp: 340, zen: 560 },
  { key: 'stage_7', name: 'Crownless Arena', ordinal: 7, hp: 560, atk: 37, def: 18, xp: 440, zen: 720 },
  { key: 'stage_8', name: 'The Sovereign Gate', ordinal: 8, hp: 720, atk: 45, def: 22, xp: 580, zen: 950 }
]

/*
 * ORIGINAL DUNGEON FLOORS
 * -----------------------
 * `axyon_floors` was created but never seeded, so `!dungeon` always reported
 * "No floors configured" and `!floor` refused to start anything. Players could
 * not fight in the dungeon at all — the table existed and stayed empty.
 *
 * These are the same hardcoded numbers the stage ladder uses, scaled up per
 * floor, so dungeon combat is a real fight with real XP rather than a stub.
 * They are seeded with ON CONFLICT DO NOTHING, so an operator's own floors and
 * any edits to these are never overwritten on restart.
 */
const ORIGINAL_FLOORS = [
  { key: 'floor_1', name: 'Sunken Vestibule', ordinal: 1, boss: false, hp: 80, atk: 6, def: 3, xp: 55, zen: 80 },
  { key: 'floor_2', name: 'Cracked Colonnade', ordinal: 2, boss: false, hp: 140, atk: 11, def: 5, xp: 100, zen: 150 },
  { key: 'floor_3', name: 'Drowned Archive', ordinal: 3, boss: false, hp: 210, atk: 16, def: 8, xp: 170, zen: 260 },
  { key: 'floor_4', name: 'The Black Stair', ordinal: 4, boss: false, hp: 300, atk: 22, def: 11, xp: 260, zen: 400 },
  { key: 'floor_5', name: 'Warden of the Deep', ordinal: 5, boss: true, hp: 460, atk: 30, def: 15, xp: 420, zen: 700 },
  { key: 'floor_6', name: 'The Shattered Meridian', ordinal: 6, boss: false, hp: 590, atk: 36, def: 18, xp: 520, zen: 900 },
  { key: 'floor_7', name: 'Cathedral of Echoes', ordinal: 7, boss: false, hp: 740, atk: 43, def: 22, xp: 650, zen: 1150 },
  { key: 'floor_8', name: 'The Nameless Citadel', ordinal: 8, boss: false, hp: 920, atk: 51, def: 26, xp: 800, zen: 1450 },
  { key: 'floor_9', name: 'Throne of the Hollow King', ordinal: 9, boss: false, hp: 1160, atk: 60, def: 31, xp: 1000, zen: 1800 },
  { key: 'floor_10', name: 'The Gate Sovereign', ordinal: 10, boss: true, hp: 1500, atk: 72, def: 38, xp: 1350, zen: 2500 }
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      registration_id TEXT,
      registration_mode TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      features JSONB NOT NULL DEFAULT '[]'::jsonb,
      suspension_reason TEXT,
      suspended_at TIMESTAMPTZ,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity TIMESTAMPTZ);

    ALTER TABLE axyon_groups ADD COLUMN IF NOT EXISTS registration_id TEXT;
    ALTER TABLE axyon_groups ADD COLUMN IF NOT EXISTS registration_mode TEXT NOT NULL DEFAULT 'normal';
    ALTER TABLE axyon_groups ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';
    ALTER TABLE axyon_groups ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE axyon_groups ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
    ALTER TABLE axyon_groups ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
    ALTER TABLE axyon_groups ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE axyon_groups ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ;
    UPDATE axyon_groups SET features='[\"general\",\"combat\",\"dungeon\",\"cards\",\"social\",\"economy\",\"casino\"]'::jsonb WHERE registration_id IS NULL AND registration_mode='normal' AND features='[]'::jsonb;

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
      str INT NOT NULL DEFAULT 5,
      per INT NOT NULL DEFAULT 5,
      sta INT NOT NULL DEFAULT 5,
      vit INT NOT NULL DEFAULT 5,
      fatigue INT NOT NULL DEFAULT 0,
      fatigue_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      mp INT NOT NULL DEFAULT 0,
      max_mp INT NOT NULL DEFAULT 0,
      power_energy INT NOT NULL DEFAULT 50,
      max_power_energy INT NOT NULL DEFAULT 50,
      stage INT NOT NULL DEFAULT 1,
      wins INT NOT NULL DEFAULT 0,
      losses INT NOT NULL DEFAULT 0,
      battles_since_rest INT NOT NULL DEFAULT 0,
      zen_today BIGINT NOT NULL DEFAULT 0,
      xp_today INT NOT NULL DEFAULT 0,
      training_xp_today INT NOT NULL DEFAULT 0,
      training_uses_today INT NOT NULL DEFAULT 0,
      day_key TEXT NOT NULL DEFAULT '',
      class TEXT NOT NULL DEFAULT 'Fighter',
      class_moves_used INT NOT NULL DEFAULT 0,
      heal_uses INT NOT NULL DEFAULT 0,
      card_uses INT NOT NULL DEFAULT 0,
      last_daily TIMESTAMPTZ,
      active_battle JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS battles_since_rest INT NOT NULL DEFAULT 0;
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS training_xp_today INT NOT NULL DEFAULT 0;
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS training_uses_today INT NOT NULL DEFAULT 0;
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS str INT NOT NULL DEFAULT 5;
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS per INT NOT NULL DEFAULT 5;
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS sta INT NOT NULL DEFAULT 5;
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS vit INT NOT NULL DEFAULT 5;
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS fatigue INT NOT NULL DEFAULT 0;
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS fatigue_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS mp INT NOT NULL DEFAULT 0;
    ALTER TABLE axyon_players ADD COLUMN IF NOT EXISTS max_mp INT NOT NULL DEFAULT 0;
    -- Existing characters keep all progression. Players already level 10+
    -- receive their newly introduced MP tank once; lower levels stay locked.
    UPDATE axyon_players
       SET max_mp=100 + (((level - 10) / 5) * 15),
           mp=100 + (((level - 10) / 5) * 15)
     WHERE level >= 10 AND max_mp=0;

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

    CREATE TABLE IF NOT EXISTS axyon_floor_story(
      user_id TEXT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

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
      image_data BYTEA,
      mime_type TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE axyon_visuals ADD COLUMN IF NOT EXISTS image_data BYTEA;
    ALTER TABLE axyon_visuals ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT '';

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      invited JSONB NOT NULL DEFAULT '[]'::jsonb,
      ready JSONB NOT NULL DEFAULT '[]'::jsonb,
      state JSONB NOT NULL DEFAULT '{}'::jsonb);
    ALTER TABLE axyon_parties ADD COLUMN IF NOT EXISTS invited JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE axyon_parties ADD COLUMN IF NOT EXISTS ready JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE axyon_parties ADD COLUMN IF NOT EXISTS state JSONB NOT NULL DEFAULT '{}'::jsonb;

    /*
     * ROOMS — the session space a mode runs in.
     *
     * A mode defines the rules; a room hosts one session of it. Kept in its own
     * table so closing a room can never touch the mode, and so a room always
     * carries the mode id it was opened with (spec Part 14 rule 16).
     *
     * The state column holds the recoverable session payload (current floor,
     * round, combat snapshot) so a restart does not silently erase progress.
     */
    CREATE TABLE IF NOT EXISTS axyon_rooms(
      id BIGSERIAL PRIMARY KEY,
      room_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      group_jid TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      mode_id TEXT NOT NULL,
      participation TEXT NOT NULL DEFAULT 'solo',
      privacy TEXT NOT NULL DEFAULT 'public',
      status TEXT NOT NULL DEFAULT 'waiting',
      capacity INT NOT NULL DEFAULT 1,
      participants JSONB NOT NULL DEFAULT '[]'::jsonb,
      entry_requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      result TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE INDEX IF NOT EXISTS axyon_rooms_group ON axyon_rooms(group_jid, status);
    CREATE INDEX IF NOT EXISTS axyon_rooms_owner ON axyon_rooms(owner_id);

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

    CREATE TABLE IF NOT EXISTS axyon_combos(
      user_id TEXT NOT NULL,
      combo_key TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'training',
      unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, combo_key));

    CREATE TABLE IF NOT EXISTS axyon_inventory(
      user_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      qty INT NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, item_key));

    /* Armor is owned per player, one row per tier purchased. The equipped flag
     * is partial-unique (one worn suit per player), and durability reaching 0
     * means the suit is broken for good. */
    CREATE TABLE IF NOT EXISTS axyon_armor(
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      tier INT NOT NULL,
      protection INT NOT NULL,
      durability INT NOT NULL,
      max_durability INT NOT NULL,
      equipped BOOLEAN NOT NULL DEFAULT FALSE,
      broken BOOLEAN NOT NULL DEFAULT FALSE,
      bought_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS axyon_armor_user_idx ON axyon_armor(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS axyon_armor_one_equipped
      ON axyon_armor(user_id) WHERE equipped = TRUE;

    CREATE TABLE IF NOT EXISTS axyon_guilds(
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tag TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      leader_id TEXT NOT NULL,
      group_jid TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_guild_members(
      guild_id BIGINT NOT NULL REFERENCES axyon_guilds(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(guild_id,user_id));
    CREATE INDEX IF NOT EXISTS axyon_guild_members_guild ON axyon_guild_members(guild_id,joined_at);

    CREATE TABLE IF NOT EXISTS axyon_guild_suggestions(
      id BIGSERIAL PRIMARY KEY,
      suggested_by TEXT NOT NULL,
      name TEXT NOT NULL,
      tag TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING',
      reviewed_by TEXT,
      guild_id BIGINT REFERENCES axyon_guilds(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS axyon_guild_suggestions_pending ON axyon_guild_suggestions(status,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS axyon_guild_suggestions_one_pending ON axyon_guild_suggestions(suggested_by) WHERE status='PENDING';

    CREATE TABLE IF NOT EXISTS axyon_log(
      id BIGSERIAL PRIMARY KEY,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    /*
     * CLASS MASTERY \u2014 one row per player per class.
     *
     * Keyed by (user_id, class_id) rather than a single column on the player,
     * because the note requires that switching class does not transfer mastery
     * and that progress resumes if the player switches back. A single column
     * would force a destructive choice on every class change.
     */
    CREATE TABLE IF NOT EXISTS axyon_class_mastery(
      user_id TEXT NOT NULL,
      class_id TEXT NOT NULL,
      mastery BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, class_id));

    /*
     * CLASS-MOVE DAILY USAGE \u2014 one row per player per UTC day.
     *
     * A separate table, not a counter on the player, so the limit is enforced
     * by a single atomic UPSERT. Two simultaneous requests cannot both read
     * "2 used" and both write "3": the UPDATE ... WHERE used < limit either
     * matches the row or it does not, and the caller sees which.
     *
     * Card abilities keep their own counter (axyon_cards.ability_uses) and are
     * deliberately NOT in this table \u2014 the note requires the two limits to be
     * independent.
     */
    CREATE TABLE IF NOT EXISTS axyon_class_usage(
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      used INT NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, day_key));

    /*
     * CLASS DEFINITIONS & MOVES — the editable catalogue.
     *
     * The 20 official classes live in code (axyon-classes.js) because they are
     * approved data that must not drift. These two tables hold the OPERATOR'S
     * OWN classes and moves, plus any override of an official one, so
     * !classadmin can create, edit and delete without a redeploy.
     *
     * source distinguishes an operator-created row ('custom') from an
     * override of a code-defined one ('override'). An override never deletes
     * the code definition — it shadows it, so removing the override restores
     * the approved original rather than losing it.
     *
     * deleted is a soft-delete flag. A class that players are currently
     * assigned to must not vanish from under them: the row stays, marked
     * deleted, and the resolver refuses to hand it out while the player's
     * stored class value is left untouched.
     */
    CREATE TABLE IF NOT EXISTS axyon_class_defs(
      class_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      specialization TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'custom',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_class_moves(
      id BIGSERIAL PRIMARY KEY,
      class_id TEXT NOT NULL,
      move_id TEXT NOT NULL,
      name TEXT NOT NULL,
      move_type TEXT NOT NULL DEFAULT 'offensive',
      damage INT,
      cost INT,
      unlock BIGINT,
      heal INT,
      ultimate BOOLEAN NOT NULL DEFAULT FALSE,
      description TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(class_id, move_id));

    CREATE INDEX IF NOT EXISTS axyon_class_moves_class ON axyon_class_moves(class_id);

    /*
     * CUSTOM ROOM TYPES — operator-defined participation shapes.
     *
     * The three fixed types (solo/multiplayer/party) are code. These are the
     * operator's own, with their own capacity bounds, so a raid or a
     * tournament lobby does not have to pretend to be a party.
     */
    CREATE TABLE IF NOT EXISTS axyon_room_types(
      type_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      min_players INT NOT NULL DEFAULT 1,
      default_max INT NOT NULL DEFAULT 4,
      hard_max INT NOT NULL DEFAULT 50,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE INDEX IF NOT EXISTS axyon_players_rank ON axyon_players(rank, level DESC);
    CREATE INDEX IF NOT EXISTS axyon_cards_owner ON axyon_cards(owner_id);
    CREATE INDEX IF NOT EXISTS axyon_log_created ON axyon_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS axyon_class_mastery_user ON axyon_class_mastery(user_id);
  `)
  for (const s of ORIGINAL_STAGES) {
    await db().query(
      `INSERT INTO axyon_stages(key,name,ordinal,original,hp,atk,def,xp,zen)
       VALUES($1,$2,$3,TRUE,$4,$5,$6,$7,$8) ON CONFLICT(key) DO NOTHING`,
      [s.key, s.name, s.ordinal, s.hp, s.atk, s.def, s.xp, s.zen]
    )
  }
  for (const f of ORIGINAL_FLOORS) {
    await db().query(
      `INSERT INTO axyon_floors(key,name,ordinal,boss,hp,atk,def,xp,zen)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(key) DO NOTHING`,
      [f.key, f.name, f.ordinal, f.boss, f.hp, f.atk, f.def, f.xp, f.zen]
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
    for (const r of rows) if (r.key !== 'zenDailyLimit') out[r.key] = r.value
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

const GROUP_MODES = Object.freeze({
  normal: ['general', 'combat', 'dungeon', 'cards', 'social', 'economy', 'casino'],
  modes: [],
  duel: ['duel'],
  multiplayer: ['combat', 'dungeon', 'social'],
  guild: ['dungeon', 'social', 'guild_slot_1'],
  collab: ['collab', 'social']
})

function groupRegistrationId () {
  return `AX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
}

async function registerGroup (jid, name, by, registrationMode = 'normal', features = null) {
  await ensureSchema()
  const mode = String(registrationMode || 'normal').toLowerCase()
  if (!Object.hasOwn(GROUP_MODES, mode)) throw new Error(`Unknown group registration mode: ${mode}`)
  const enabledFeatures = Array.isArray(features) ? features : GROUP_MODES[mode]
  const r = await db().query(
    `INSERT INTO axyon_groups(group_jid,name,registered_by,enabled,registration_id,registration_mode,status,features,registered_at)
     VALUES($1,$2,$3,TRUE,$4,$5,'ACTIVE',$6::jsonb,NOW())
     ON CONFLICT(group_jid) DO UPDATE SET name=EXCLUDED.name,registered_by=EXCLUDED.registered_by,
       enabled=TRUE,registration_id=CASE WHEN axyon_groups.status='REMOVED' THEN EXCLUDED.registration_id ELSE COALESCE(axyon_groups.registration_id,EXCLUDED.registration_id) END,
       registration_mode=EXCLUDED.registration_mode,status='ACTIVE',features=EXCLUDED.features,
       suspension_reason=NULL,suspended_at=NULL,registered_at=CASE WHEN axyon_groups.status='REMOVED' THEN NOW() ELSE axyon_groups.registered_at END,updated_at=NOW()
     RETURNING *`,
    [jid, name || '', by || '', groupRegistrationId(), mode, JSON.stringify(enabledFeatures)]
  )
  cache.invalidate(`group:${jid}`)
  return r.rows[0]
}

async function updateGroupMode (jid, mode) {
  await ensureSchema()
  mode = String(mode || '').toLowerCase()
  if (!Object.hasOwn(GROUP_MODES, mode)) throw new Error(`Unknown group registration mode: ${mode}`)
  const r = await db().query(
    `UPDATE axyon_groups SET registration_mode=$2,features=$3::jsonb,updated_at=NOW()
     WHERE group_jid=$1 RETURNING *`, [jid, mode, JSON.stringify(GROUP_MODES[mode])]
  )
  cache.invalidate(`group:${jid}`)
  return r.rows[0] || null
}

async function updateGroupFeatures (jid, features) {
  await ensureSchema()
  const clean = [...new Set((Array.isArray(features) ? features : []).map(x => String(x).toLowerCase()).filter(Boolean))]
  const r = await db().query('UPDATE axyon_groups SET features=$2::jsonb,updated_at=NOW() WHERE group_jid=$1 RETURNING *', [jid, JSON.stringify(clean)])
  cache.invalidate(`group:${jid}`)
  return r.rows[0] || null
}

async function updateGroupStatus (jid, status, reason = '') {
  await ensureSchema()
  const next = String(status || '').toUpperCase()
  if (!['ACTIVE', 'SUSPENDED', 'DISABLED'].includes(next)) throw new Error('Invalid group status')
  const r = await db().query(
    `UPDATE axyon_groups SET status=$2,enabled=($2='ACTIVE'),
      suspension_reason=CASE WHEN $2='SUSPENDED' THEN NULLIF($3,'') ELSE NULL END,
      suspended_at=CASE WHEN $2='SUSPENDED' THEN NOW() ELSE NULL END,updated_at=NOW()
     WHERE group_jid=$1 RETURNING *`, [jid, next, String(reason || '')]
  )
  cache.invalidate(`group:${jid}`)
  return r.rows[0] || null
}

async function unregisterGroup (jid) {
  await ensureSchema()
  const r = await db().query("UPDATE axyon_groups SET status='REMOVED',enabled=FALSE,updated_at=NOW() WHERE group_jid=$1 RETURNING *", [jid])
  cache.invalidate(`group:${jid}`)
  return r.rows[0] || null
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

async function touchGroupActivity (jid) {
  await ensureSchema()
  await db().query("UPDATE axyon_groups SET last_activity=NOW() WHERE group_jid=$1 AND status <> 'REMOVED'", [jid])
  cache.invalidate(`group:${jid}`)
}

async function setGroupEnabled (jid, enabled) {
  await ensureSchema()
  const r = await db().query("UPDATE axyon_groups SET enabled=$2,status=CASE WHEN $2 THEN 'ACTIVE' ELSE 'DISABLED' END,updated_at=NOW() WHERE group_jid=$1 AND status <> 'REMOVED' RETURNING *", [jid, !!enabled])
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

function mpCapacityForLevel (level) {
  const n = Math.floor(Number(level) || 1)
  return n < 10 ? 0 : 100 + Math.floor((n - 10) / 5) * 15
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
    str: Number(r.str ?? 5),
    per: Number(r.per ?? 5),
    sta: Number(r.sta ?? 5),
    vit: Number(r.vit ?? 5),
    fatigue: Number(r.fatigue ?? 0),
    fatigueUpdatedAt: r.fatigue_updated_at || null,
    mp: Number(r.mp ?? 0),
    maxMp: Number(r.max_mp ?? 0),
    powerEnergy: Number(r.power_energy),
    maxPowerEnergy: Number(r.max_power_energy),
    stage: Number(r.stage),
    wins: Number(r.wins),
    losses: Number(r.losses),
    battlesSinceRest: Number(r.battles_since_rest || 0),
    zenToday: Number(r.zen_today),
    xpToday: Number(r.xp_today),
    trainingXpToday: Number(r.training_xp_today || 0),
    trainingUsesToday: Number(r.training_uses_today || 0),
    dayKey: r.day_key,
    class: r.class,
    classMovesUsed: Number(r.class_moves_used),
    healUses: Number(r.heal_uses),
    cardUses: Number(r.card_uses),
    lastDaily: r.last_daily,
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
  const levelRow = (await db().query('SELECT level FROM axyon_players WHERE user_id=$1', [String(userId)])).rows[0]
  if (levelRow) {
    const capacity = mpCapacityForLevel(levelRow.level)
    await db().query(
      `UPDATE axyon_players SET max_mp=$2,
         mp=CASE WHEN max_mp=0 AND $2>0 THEN $2 WHEN $2=0 THEN 0 ELSE LEAST(mp,$2) END
       WHERE user_id=$1 AND max_mp<>$2`,
      [String(userId), capacity]
    )
  }
  const cooled = await db().query(
    `UPDATE axyon_players p
       SET fatigue=GREATEST(0, p.fatigue - FLOOR(EXTRACT(EPOCH FROM (NOW()-p.fatigue_updated_at))/900)::int),
           fatigue_updated_at=p.fatigue_updated_at + (FLOOR(EXTRACT(EPOCH FROM (NOW()-p.fatigue_updated_at))/900)::int * INTERVAL '15 minutes')
     WHERE p.user_id=$1 AND p.fatigue>0
       AND p.active_battle IS NULL
       AND NOT EXISTS (SELECT 1 FROM axyon_duels d WHERE d.status='active' AND (d.challenger=p.user_id OR d.opponent=p.user_id))
       AND p.fatigue_updated_at <= NOW()-INTERVAL '15 minutes'
     RETURNING p.*`, [String(userId)]
  )
  if (cooled.rowCount) return norm(cooled.rows[0])
  return norm((await db().query('SELECT * FROM axyon_players WHERE user_id=$1', [userId])).rows[0])
}


async function updateFatigue (userId, fatigue, updatedAt = new Date().toISOString()) {
  await ensureSchema()
  const result = await db().query(
    `UPDATE axyon_players
       SET fatigue=$2,fatigue_updated_at=$3::timestamptz,updated_at=NOW()
     WHERE user_id=$1
     RETURNING fatigue,fatigue_updated_at`,
    [String(userId), Math.max(0, Math.min(100, Math.floor(Number(fatigue) || 0))), updatedAt]
  )
  return result.rows[0] || null
}

async function savePlayer (p) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_players SET name=$2,rank=$3,level=$4,grade=$5,xp=$6,zen=$7,coins=$8,hp=$9,max_hp=$10,
       atk=$11,def=$12,spd=$13,power_energy=$14,max_power_energy=$15,stage=$16,wins=$17,losses=$18,
       battles_since_rest=$19,zen_today=$20,xp_today=$21,training_xp_today=$22,training_uses_today=$23,
       day_key=$24,class=$25,class_moves_used=$26,heal_uses=$27,card_uses=$28,last_daily=$29,
       str=$30,per=$31,sta=$32,vit=$33,fatigue=$34,fatigue_updated_at=COALESCE($35::timestamptz,NOW()),
       max_mp=$36,mp=$37,updated_at=NOW()
     WHERE user_id=$1 RETURNING *`,
    [p.userId, p.name, p.rank, p.level, p.grade, p.xp, p.zen, p.coins, p.hp, p.maxHp,
      p.atk, p.def, p.spd, p.powerEnergy, p.maxPowerEnergy, p.stage, p.wins, p.losses,
      p.battlesSinceRest || 0, p.zenToday, p.xpToday, p.trainingXpToday || 0, p.trainingUsesToday || 0, p.dayKey, p.class,
      p.classMovesUsed, p.healUses, p.cardUses, p.lastDaily,
      Math.max(1, Number(p.str) || 5), Math.max(1, Number(p.per) || 5), Math.max(1, Number(p.sta) || 5), Math.max(1, Number(p.vit) || 5),
      Math.max(0, Math.min(100, Number(p.fatigue) || 0)), p.fatigueUpdatedAt || null,
      Math.max(0, Math.floor(Number(p.maxMp) || 0)), Math.max(0, Math.min(Math.floor(Number(p.maxMp) || 0), Math.floor(Number(p.mp) || 0)))]
  )
  return norm(r.rows[0])
}

/** Rolls the daily counters over when the calendar day changes. */
function rollDay (p) {
  const today = dayKey()
  if (p.dayKey === today) return p
  return { ...p, dayKey: today, zenToday: 0, xpToday: 0, trainingXpToday: 0, trainingUsesToday: 0, classMovesUsed: 0, cardUses: 0 }
}

async function resetPlayer (userId) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_players SET rank='E',level=1,grade=1,xp=0,zen=0,coins=0,hp=$2,max_hp=$2,atk=$3,def=$4,spd=$5,
       str=5,per=5,sta=5,vit=5,fatigue=0,fatigue_updated_at=NOW(),
       mp=0,max_mp=0,power_energy=$6,max_power_energy=$6,stage=1,wins=0,losses=0,zen_today=0,xp_today=0,day_key=$7,
       class_moves_used=0,heal_uses=0,card_uses=0,battles_since_rest=0,training_xp_today=0,training_uses_today=0,updated_at=NOW()
     WHERE user_id=$1 RETURNING *`,
    [userId, BASE_HP, BASE_ATK, BASE_DEF, BASE_SPD, POWER_ENERGY_BASE, dayKey()]
  )
  return norm(r.rows[0])
}

/** Reset every registered player's RPG progression without deleting identities. */
async function resetAllPlayers () {
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `UPDATE axyon_players SET rank='E',level=1,grade=1,xp=0,zen=0,coins=0,
         hp=$1,max_hp=$1,atk=$2,def=$3,spd=$4,power_energy=$5,max_power_energy=$5,
         mp=0,max_mp=0,str=5,per=5,sta=5,vit=5,fatigue=0,fatigue_updated_at=NOW(),
         stage=1,wins=0,losses=0,zen_today=0,xp_today=0,day_key=$6,
         class='Fighter',class_moves_used=0,heal_uses=0,card_uses=0,battles_since_rest=0,training_xp_today=0,training_uses_today=0,active_battle=NULL,updated_at=NOW()`,
      [BASE_HP, BASE_ATK, BASE_DEF, BASE_SPD, POWER_ENERGY_BASE, dayKey()]
    )
    await client.query('DELETE FROM axyon_class_mastery')
    await client.query('DELETE FROM axyon_class_usage')
    await client.query('COMMIT')
    return Number(result.rowCount || 0)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
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

async function setBattle (userId, battle) {
  await ensureSchema()
  await db().query('UPDATE axyon_players SET active_battle=$2::jsonb,updated_at=NOW() WHERE user_id=$1', [userId, battle ? JSON.stringify(battle) : null])
}

async function getBattle (userId) {
  await ensureSchema()
  return (await db().query('SELECT active_battle FROM axyon_players WHERE user_id=$1', [userId])).rows[0]?.active_battle || null
}

/** Spend Coins for one permanent +1 training upgrade and award capped XP. */
async function trainPlayer (userId, stat, { cost = 250, xp = 5, trainingXpCap = 25, trainingUsesCap = 5, xpDailyLimit = 5000 } = {}) {
  const columns = { atk: 'atk', def: 'def', spd: 'spd', str: 'str', per: 'per', sta: 'sta', vit: 'vit' }
  const column = columns[String(stat || '').toLowerCase()]
  if (!column) return { ok: false, reason: 'stat' }
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const result = await client.query('SELECT * FROM axyon_players WHERE user_id=$1 FOR UPDATE', [String(userId)])
    if (!result.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'player' } }
    const row = result.rows[0]
    const today = dayKey()
    const sameDay = row.day_key === today
    const coins = Number(row.coins) || 0
    const usesToday = sameDay ? Number(row.training_uses_today) || 0 : 0
    if (usesToday >= Math.max(1, Math.floor(Number(trainingUsesCap) || 5))) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'daily_cap', trainingUsesToday: usesToday, trainingUsesCap }
    }
    if (coins < cost) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'coins', coins }
    }
    const currentStat = Number(row[column]) || 0
    if (['str', 'per', 'sta', 'vit'].includes(column) && currentStat >= 100) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'stat_cap', stat: column, value: currentStat }
    }
    const hpBonus = column === 'vit' ? 5 : 0
    const previousTrainingXp = sameDay ? Number(row.training_xp_today) || 0 : 0
    const previousXpToday = sameDay ? Number(row.xp_today) || 0 : 0
    const trainingRoom = Math.max(0, Math.floor(Number(trainingXpCap) || 0) - previousTrainingXp)
    const dailyXpRoom = Math.max(0, Math.floor(Number(xpDailyLimit) || 0) - previousXpToday)
    const awardedXp = Math.max(0, Math.min(Math.floor(Number(xp) || 0), trainingRoom, dailyXpRoom))
    const update = await client.query(
      `UPDATE axyon_players SET ${column}=${column}+1,coins=coins-$2,xp=xp+$6,xp_today=$3,
         max_hp=max_hp+$8,hp=LEAST(max_hp+$8,hp+$8),fatigue_updated_at=NOW(),
         training_xp_today=$4,training_uses_today=$7,day_key=$5,
         zen_today=CASE WHEN day_key=$5 THEN zen_today ELSE 0 END,
         class_moves_used=CASE WHEN day_key=$5 THEN class_moves_used ELSE 0 END,
         card_uses=CASE WHEN day_key=$5 THEN card_uses ELSE 0 END,
         updated_at=NOW()
       WHERE user_id=$1 RETURNING *`,
      [String(userId), Math.floor(Number(cost) || 0), previousXpToday + awardedXp,
        previousTrainingXp + awardedXp, today, awardedXp, usesToday + 1, hpBonus]
    )
    await client.query('COMMIT')
    return {
      ok: true,
      player: norm(update.rows[0]),
      xp: awardedXp,
      xpReason: awardedXp > 0 ? '' : trainingRoom <= 0 ? 'training_cap' : 'daily_xp_cap',
      trainingXpToday: previousTrainingXp + awardedXp,
      trainingXpCap,
      trainingUsesToday: usesToday + 1,
      trainingUsesCap,
      hpBonus
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

/** Atomic 10 Coins → 1 Zen exchange. */
async function convertCoinsToZen (userId, coinsToConvert) {
  await ensureSchema()
  const amount = Math.floor(Number(coinsToConvert))
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount % 10 !== 0) return { ok: false, reason: 'amount' }
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const current = await client.query('SELECT * FROM axyon_players WHERE user_id=$1 FOR UPDATE', [String(userId)])
    if (!current.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'player' } }
    const p = norm(current.rows[0])
    if (p.coins < amount) { await client.query('ROLLBACK'); return { ok: false, reason: 'coins', balance: p.coins } }
    const gain = amount / 10
    const updated = await client.query(
      'UPDATE axyon_players SET coins=coins-$2,zen=zen+$3,updated_at=NOW() WHERE user_id=$1 RETURNING *',
      [String(userId), amount, gain]
    )
    await client.query('COMMIT')
    return { ok: true, player: norm(updated.rows[0]), coins: amount, zen: gain }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

async function activeDuelForUser (userId, groupJid = null) {
  await ensureSchema()
  return (await db().query(
    `SELECT * FROM axyon_duels
     WHERE status='active' AND (challenger=$1 OR opponent=$1)
       AND ($2::text IS NULL OR group_jid=$2)
     ORDER BY created_at DESC LIMIT 1`,
    [String(userId), groupJid == null ? null : String(groupJid)]
  )).rows[0] || null
}

/** Lock and update a live duel row so two simultaneous turns cannot both win. */
async function mutateDuel (id, mutate) {
  if (typeof mutate !== 'function') throw new TypeError('A duel mutator is required.')
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query('SELECT * FROM axyon_duels WHERE id=$1 FOR UPDATE', [Number(id)])
    if (!selected.rowCount) { await client.query('ROLLBACK'); return null }
    const current = selected.rows[0]
    const patch = await mutate(current)
    if (!patch) {
      await client.query('COMMIT')
      return current
    }
    const updated = await client.query(
      `UPDATE axyon_duels SET status=COALESCE($2,status),state=COALESCE($3::jsonb,state),updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [Number(id), patch.status ?? null, patch.state ? JSON.stringify(patch.state) : null]
    )
    await client.query('COMMIT')
    return updated.rows[0] || null
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
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
  // Repair older live databases that have the floors table but no built-in
  // rows. This is idempotent and never overwrites floors configured by AXYON.
  for (const f of ORIGINAL_FLOORS) {
    await db().query(
      `INSERT INTO axyon_floors(key,name,ordinal,boss,hp,atk,def,xp,zen)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(key) DO NOTHING`,
      [f.key, f.name, f.ordinal, f.boss, f.hp, f.atk, f.def, f.xp, f.zen]
    )
  }
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

async function studioRenderedCard (rawCode) {
  await ensureSchema()
  const code = String(rawCode || '').replace(/^#/, '').trim().toUpperCase()
  if (!code) return null
  return (await db().query(
    'SELECT rendered_data,card_data FROM axyon_card_studio WHERE claim_code=$1', [code]
  )).rows[0] || null
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

async function claimStudioCard (ownerId, rawCode) {
  await ensureSchema()
  const code = String(rawCode || '').replace(/^#/, '').trim().toUpperCase()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const playerResult = await client.query('SELECT * FROM axyon_players WHERE user_id=$1 FOR UPDATE', [ownerId])
    if (!playerResult.rows[0]) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_registered' } }
    const found = await client.query('SELECT * FROM axyon_card_studio WHERE claim_code=$1 FOR UPDATE', [code])
    const drop = found.rows[0]
    if (!drop) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' } }
    const data = drop.card_data || {}
    if (data.expiresAt && new Date(data.expiresAt).getTime() <= Date.now()) { await client.query('ROLLBACK'); return {ok:false,reason:'expired'} }
    const limit = Math.max(1, Number(data.claimLimit) || 30)
    if (Number(drop.claim_count) >= limit) { await client.query('ROLLBACK'); return { ok: false, reason: 'limit' } }
    const prior = await client.query('SELECT 1 FROM axyon_card_studio_claims WHERE card_id=$1 AND user_id=$2', [drop.id, ownerId])
    if (prior.rows[0]) { await client.query('ROLLBACK'); return { ok: false, reason: 'claimed' } }
    const coinCost = Math.max(0, Math.floor(Number(data.coin) || 0))
    const zenCost = Math.max(0, Math.floor(Number(data.zen) || 0))
    const wallet = playerResult.rows[0]
    const currentCoins = Number(wallet.coins) || 0
    const currentZen = Number(wallet.zen) || 0
    if (currentCoins < coinCost) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'coins', required: coinCost, balance: currentCoins }
    }
    if (currentZen < zenCost) {
      await client.query('ROLLBACK')
      return { ok: false, reason: 'zen', required: zenCost, balance: currentZen }
    }
    if (coinCost || zenCost) {
      await client.query(
        'UPDATE axyon_players SET coins=coins-$2,zen=zen-$3,updated_at=NOW() WHERE user_id=$1',
        [String(ownerId), coinCost, zenCost]
      )
    }
    const slotResult = await client.query('SELECT COALESCE(MAX(slot),0)+1 AS next FROM axyon_cards WHERE owner_id=$1', [ownerId])
    const slot = Number(slotResult.rows[0].next)
    const weapon = (data.weapons || []).map(x => x.name).join(', ')
    const ability = (data.abilities || []).map(x => x.name).join(', ')
    const abilityDamage = (data.abilities || []).reduce((n, x) => n + (Number(x.damage) || 0), 0)
    await client.query('INSERT INTO axyon_card_studio_claims(card_id,user_id) VALUES($1,$2)', [drop.id, ownerId])
    const card = await client.query(`INSERT INTO axyon_cards(owner_id,slot,card_type,series,name,weapon,damage,ability,ability_damage,rating,claimed,expires_at,image_url,image_data,renderer,source_url,source_artist,drop_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$12,$13,$14,$12,'',$15) RETURNING *`,
    [ownerId, slot, data.cardType || 'character', [data.version, data.arc].filter(Boolean).join(' • '), data.name, weapon, Number(data.baseDamage) || 0, ability, abilityDamage, Math.max(1, Math.min(6, Number(data.rarity) || 1)), data.expiresAt || null, drop.artwork_url || '', drop.rendered_data, ['old-gen', 'ai-custom'].includes(String(data.renderer)) ? data.renderer : 'old-gen', code])
    const count = await client.query('UPDATE axyon_card_studio SET claim_count=claim_count+1 WHERE id=$1 RETURNING claim_count', [drop.id])
    await client.query('COMMIT')
    return { ok: true, card: card.rows[0], slot, claimed: Number(count.rows[0].claim_count), limit, paidCoins: coinCost, paidZen: zenCost }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
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
    `INSERT INTO axyon_visuals(mode,url,caption,image_data,mime_type) VALUES($1,$2,$3,NULL,'')
     ON CONFLICT(mode) DO UPDATE SET url=EXCLUDED.url,caption=EXCLUDED.caption,image_data=NULL,mime_type='',updated_at=NOW() RETURNING *`,
    [mode, url || '', caption || '']
  )
  return r.rows[0]
}

async function setVisualImage (mode, imageData, mimeType, caption) {
  await ensureSchema()
  const r = await db().query(
    `INSERT INTO axyon_visuals(mode,url,caption,image_data,mime_type) VALUES($1,'',$2,$3,$4)
     ON CONFLICT(mode) DO UPDATE SET url='',caption=EXCLUDED.caption,image_data=EXCLUDED.image_data,mime_type=EXCLUDED.mime_type,updated_at=NOW() RETURNING mode,caption,mime_type,updated_at`,
    [mode, caption || '', imageData, mimeType]
  )
  return r.rows[0]
}

async function clearVisual (mode) {
  await ensureSchema()
  await db().query('DELETE FROM axyon_visuals WHERE mode=$1', [mode])
}

/* ----------------------------------------------------------------- armor */

/*
 * ARMOR
 * -----
 * Five tiers, fixed prices and durability. A suit absorbs a flat amount of
 * incoming damage per hit and loses one durability point per completed battle
 * it was worn in. At zero durability it is broken permanently — it is not
 * deleted, so the player can still see what they lost.
 */
const ARMOR_TIERS = [
  { tier: 1, protection: 100, zen: 10000, durability: 10 },
  { tier: 2, protection: 200, zen: 20000, durability: 15 },
  { tier: 3, protection: 300, zen: 30000, durability: 20 },
  { tier: 4, protection: 400, zen: 40000, durability: 25 },
  { tier: 5, protection: 500, zen: 50000, durability: 30 }
]

function armorTier (tier) {
  return ARMOR_TIERS.find(t => Number(t.tier) === Number(tier)) || null
}

function mapArmor (r) {
  if (!r) return null
  return {
    id: Number(r.id),
    userId: r.user_id,
    tier: Number(r.tier),
    protection: Number(r.protection),
    durability: Number(r.durability),
    maxDurability: Number(r.max_durability),
    equipped: !!r.equipped,
    broken: !!r.broken,
    boughtAt: r.bought_at
  }
}

/** Every suit a player owns, newest first. */
async function armorFor (userId) {
  await ensureSchema()
  const r = await db().query('SELECT * FROM axyon_armor WHERE user_id=$1 ORDER BY tier DESC, id DESC', [String(userId)])
  return r.rows.map(mapArmor)
}

/** The suit currently worn, or null. */
async function equippedArmor (userId) {
  await ensureSchema()
  const r = await db().query('SELECT * FROM axyon_armor WHERE user_id=$1 AND equipped=TRUE AND broken=FALSE LIMIT 1', [String(userId)])
  return mapArmor(r.rows[0])
}

/**
 * Buy a tier. Charges Zen atomically and refuses when the player cannot pay,
 * so a failed purchase never leaves a suit behind.
 */
async function buyArmor (userId, tier) {
  await ensureSchema()
  const spec = armorTier(tier)
  if (!spec) throw new Error('Unknown armor tier.')
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const p = await client.query('SELECT zen FROM axyon_players WHERE user_id=$1 FOR UPDATE', [String(userId)])
    if (!p.rows.length) throw new Error('Player not found.')
    const zen = Number(p.rows[0].zen || 0)
    if (zen < spec.zen) throw new Error(`Not enough Zen. Tier ${spec.tier} costs ${spec.zen.toLocaleString('en-US')} Zen.`)
    await client.query('UPDATE axyon_players SET zen=zen-$2, updated_at=NOW() WHERE user_id=$1', [String(userId), spec.zen])
    const r = await client.query(
      `INSERT INTO axyon_armor(user_id,tier,protection,durability,max_durability)
       VALUES($1,$2,$3,$4,$4) RETURNING *`,
      [String(userId), spec.tier, spec.protection, spec.durability]
    )
    await client.query('COMMIT')
    return mapArmor(r.rows[0])
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Wear one suit. Unequips whatever else was on, in one transaction. */
async function equipArmor (userId, armorId) {
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const r = await client.query('SELECT * FROM axyon_armor WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(armorId), String(userId)])
    const suit = r.rows[0]
    if (!suit) throw new Error('You do not own that armor.')
    if (suit.broken) throw new Error('That armor is broken and cannot be worn.')
    await client.query('UPDATE axyon_armor SET equipped=FALSE, updated_at=NOW() WHERE user_id=$1 AND equipped=TRUE', [String(userId)])
    const out = await client.query('UPDATE axyon_armor SET equipped=TRUE, updated_at=NOW() WHERE id=$1 RETURNING *', [Number(armorId)])
    await client.query('COMMIT')
    return mapArmor(out.rows[0])
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

async function unequipArmor (userId) {
  await ensureSchema()
  const r = await db().query('UPDATE axyon_armor SET equipped=FALSE, updated_at=NOW() WHERE user_id=$1 AND equipped=TRUE RETURNING *', [String(userId)])
  return mapArmor(r.rows[0])
}

/**
 * Repair a suit to full durability. Cost is proportional to the missing
 * points, so a nearly-new suit is cheap and a nearly-broken one is not.
 */
async function repairArmor (userId, armorId) {
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const r = await client.query('SELECT * FROM axyon_armor WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(armorId), String(userId)])
    const suit = r.rows[0]
    if (!suit) throw new Error('You do not own that armor.')
    if (suit.broken) throw new Error('That armor is broken beyond repair.')
    const missing = Number(suit.max_durability) - Number(suit.durability)
    if (missing <= 0) throw new Error('That armor is already at full durability.')
    const spec = armorTier(suit.tier)
    const cost = Math.ceil((spec.zen / spec.durability) * missing)
    const p = await client.query('SELECT zen FROM axyon_players WHERE user_id=$1 FOR UPDATE', [String(userId)])
    if (Number(p.rows[0]?.zen || 0) < cost) throw new Error(`Repair costs ${cost.toLocaleString('en-US')} Zen and you do not have it.`)
    await client.query('UPDATE axyon_players SET zen=zen-$2, updated_at=NOW() WHERE user_id=$1', [String(userId), cost])
    const out = await client.query('UPDATE axyon_armor SET durability=max_durability, updated_at=NOW() WHERE id=$1 RETURNING *', [Number(armorId)])
    await client.query('COMMIT')
    return { armor: mapArmor(out.rows[0]), cost }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Apply one completed battle's wear to the worn suit.
 *
 * Called once per battle, never per hit, so durability cannot be farmed by
 * taking many small hits in a single fight. Returns the suit after wear, or
 * null when nothing was equipped.
 */
async function wearArmor (userId, points = 1) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_armor
        SET durability=GREATEST(0, durability-$2),
            broken=(GREATEST(0, durability-$2) <= 0),
            equipped=(GREATEST(0, durability-$2) > 0),
            updated_at=NOW()
      WHERE user_id=$1 AND equipped=TRUE AND broken=FALSE
      RETURNING *`,
    [String(userId), Math.max(1, Number(points) || 1)]
  )
  return mapArmor(r.rows[0])
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

async function updateParty (id, members, status, invited = null, ready = null, state = null) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_parties SET members=$2::jsonb,status=COALESCE($3,status),
       invited=COALESCE($4::jsonb,invited),ready=COALESCE($5::jsonb,ready),state=COALESCE($6::jsonb,state)
     WHERE id=$1 RETURNING *`,
    [id, JSON.stringify(members), status || null,
      invited ? JSON.stringify(invited) : null, ready ? JSON.stringify(ready) : null,
      state ? JSON.stringify(state) : null]
  )
  return r.rows[0] || null
}

async function partyForUser (groupJid, userId) {
  await ensureSchema()
  return (await db().query(
    `SELECT * FROM axyon_parties
       WHERE group_jid=$1 AND status IN ('open','started','battling')
         AND members @> $2::jsonb
       ORDER BY id DESC LIMIT 1`,
    [String(groupJid), JSON.stringify([String(userId)])]
  )).rows[0] || null
}

async function mutateParty (id, mutate) {
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const found = await client.query('SELECT * FROM axyon_parties WHERE id=$1 FOR UPDATE', [Number(id)])
    if (!found.rowCount) { await client.query('ROLLBACK'); return null }
    const current = found.rows[0]
    const next = await mutate({ ...current })
    if (!next) { await client.query('ROLLBACK'); return null }
    const updated = await client.query(
      `UPDATE axyon_parties SET members=$2::jsonb,status=$3,invited=$4::jsonb,ready=$5::jsonb,state=$6::jsonb
       WHERE id=$1 RETURNING *`,
      [Number(id), JSON.stringify(next.members ?? current.members ?? []), String(next.status ?? current.status),
        JSON.stringify(next.invited ?? current.invited ?? []), JSON.stringify(next.ready ?? current.ready ?? []),
        JSON.stringify(next.state ?? current.state ?? {})]
    )
    await client.query('COMMIT')
    return updated.rows[0] || null
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

/* ------------------------------------------------------------------ rooms */

async function createRoom ({ name, groupJid, ownerId, modeId, participation, privacy, capacity, entryRequirements }) {
  await ensureSchema()
  const roomKey = `room_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  const r = await db().query(
    `INSERT INTO axyon_rooms(room_key,name,group_jid,owner_id,mode_id,participation,privacy,capacity,participants,entry_requirements)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) RETURNING *`,
    [roomKey, name, groupJid, ownerId, modeId, participation, privacy, capacity,
      JSON.stringify([{ userId: ownerId, role: 'leader' }]), JSON.stringify(entryRequirements || {})]
  )
  return r.rows[0]
}

async function room (roomKey) {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_rooms WHERE room_key=$1', [roomKey])).rows[0] || null
}

async function roomsFor (groupJid, { status = null } = {}) {
  await ensureSchema()
  if (status) {
    return (await db().query('SELECT * FROM axyon_rooms WHERE group_jid=$1 AND status=$2 ORDER BY id DESC', [groupJid, status])).rows
  }
  return (await db().query('SELECT * FROM axyon_rooms WHERE group_jid=$1 ORDER BY id DESC', [groupJid])).rows
}

async function updateRoom (roomKey, patch) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_rooms SET
       status=COALESCE($2,status),
       privacy=COALESCE($3,privacy),
       capacity=COALESCE($4,capacity),
       participants=COALESCE($5::jsonb,participants),
       state=COALESCE($6::jsonb,state),
       result=COALESCE($7,result),
       entry_requirements=COALESCE($8::jsonb,entry_requirements),
       last_activity=NOW()
     WHERE room_key=$1 RETURNING *`,
    [roomKey, patch.status ?? null, patch.privacy ?? null, patch.capacity ?? null,
      patch.participants ? JSON.stringify(patch.participants) : null,
      patch.state ? JSON.stringify(patch.state) : null,
      patch.result ?? null,
      patch.entryRequirements ? JSON.stringify(patch.entryRequirements) : null]
  )
  return r.rows[0] || null
}

/**
 * Atomically mutate the JSONB state attached to a shared room. This is used by
 * the additive campaign-story layer so two players cannot overwrite each
 * other's choices or discoveries with stale room snapshots. The mutator must
 * be synchronous and return the complete next state object.
 */
async function mutateRoomState (roomKey, mutate) {
  if (typeof mutate !== 'function') throw new TypeError('A room-state mutator is required.')
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const current = await client.query('SELECT state FROM axyon_rooms WHERE room_key=$1 FOR UPDATE', [String(roomKey)])
    if (!current.rowCount) { await client.query('ROLLBACK'); return null }
    const raw = current.rows[0].state
    const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const next = mutate(state)
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new TypeError('Room state must remain an object.')
    const updated = await client.query(
      'UPDATE axyon_rooms SET state=$2::jsonb,last_activity=NOW() WHERE room_key=$1 RETURNING *',
      [String(roomKey), JSON.stringify(next)]
    )
    await client.query('COMMIT')
    return updated.rows[0] || null
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
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

/* ---------------------------------------------------------- command combos */

async function combos (userId) {
  await ensureSchema()
  return (await db().query(
    'SELECT combo_key,source,unlocked_at FROM axyon_combos WHERE user_id=$1 ORDER BY unlocked_at',
    [String(userId)]
  )).rows
}

async function hasCombo (userId, comboKey) {
  await ensureSchema()
  const r = await db().query(
    'SELECT 1 FROM axyon_combos WHERE user_id=$1 AND combo_key=$2',
    [String(userId), String(comboKey)]
  )
  return r.rowCount > 0
}

async function unlockCombo (userId, comboKey, source = 'training') {
  await ensureSchema()
  const r = await db().query(
    `INSERT INTO axyon_combos(user_id,combo_key,source) VALUES($1,$2,$3)
     ON CONFLICT(user_id,combo_key) DO NOTHING RETURNING combo_key,source,unlocked_at`,
    [String(userId), String(comboKey), String(source)]
  )
  return r.rows[0] || null
}

async function buyCombo (userId, comboKey, price, requiredLevel = 1) {
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const playerResult = await client.query('SELECT * FROM axyon_players WHERE user_id=$1 FOR UPDATE', [String(userId)])
    if (!playerResult.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'player' } }
    const player = norm(playerResult.rows[0])
    if (player.level < requiredLevel) { await client.query('ROLLBACK'); return { ok: false, reason: 'level', level: player.level, requiredLevel } }
    const exists = await client.query('SELECT 1 FROM axyon_combos WHERE user_id=$1 AND combo_key=$2', [String(userId), String(comboKey)])
    if (exists.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'owned' } }
    if (player.zen < price) { await client.query('ROLLBACK'); return { ok: false, reason: 'zen', balance: player.zen } }
    await client.query('UPDATE axyon_players SET zen=zen-$2,updated_at=NOW() WHERE user_id=$1', [String(userId), Math.floor(Number(price))])
    const unlocked = await client.query(
      'INSERT INTO axyon_combos(user_id,combo_key,source) VALUES($1,$2,$3) RETURNING combo_key,source,unlocked_at',
      [String(userId), String(comboKey), 'purchase']
    )
    await client.query('COMMIT')
    return { ok: true, combo: unlocked.rows[0], balance: player.zen - price }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

/* ---------------------------------------------------------- floor story */

async function floorStory (userId) {
  await ensureSchema()
  const row = (await db().query('SELECT state FROM axyon_floor_story WHERE user_id=$1', [String(userId)])).rows[0]
  return row?.state || {}
}

async function saveFloorStory (userId, state) {
  await ensureSchema()
  const result = await db().query(
    `INSERT INTO axyon_floor_story(user_id,state) VALUES($1,$2::jsonb)
     ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW() RETURNING state`,
    [String(userId), JSON.stringify(state || {})]
  )
  return result.rows[0]?.state || state
}

/* --------------------------------------------------------------------- log */

/* ------------------------------------------------------- class mastery */

/**
 * The player's mastery in one class. Missing row means 0 — a player who has
 * never trained a class has no mastery in it, which is not an error.
 */
async function classMastery (userId, classId) {
  await ensureSchema()
  const r = await db().query(
    'SELECT mastery FROM axyon_class_mastery WHERE user_id=$1 AND class_id=$2',
    [userId, String(classId || '')]
  )
  return r.rows[0] ? Number(r.rows[0].mastery) : 0
}

/** Every class the player has mastery in, for the class view. */
async function classMasteries (userId) {
  await ensureSchema()
  const r = await db().query(
    'SELECT class_id, mastery FROM axyon_class_mastery WHERE user_id=$1 ORDER BY mastery DESC',
    [userId]
  )
  return r.rows.map(x => ({ classId: x.class_id, mastery: Number(x.mastery) }))
}

/**
 * Adds mastery to one class. Never negative, never touches another class.
 *
 * `amount` of 0 is a no-op that still returns the current value, so callers do
 * not need to branch on whether awarding is configured yet.
 */
async function addClassMastery (userId, classId, amount) {
  await ensureSchema()
  const delta = Math.max(0, Math.floor(Number(amount) || 0))
  if (!delta) return classMastery(userId, classId)
  const r = await db().query(
    `INSERT INTO axyon_class_mastery(user_id,class_id,mastery) VALUES($1,$2,$3)
     ON CONFLICT(user_id,class_id) DO UPDATE SET
       mastery = axyon_class_mastery.mastery + $3,
       updated_at = NOW()
     RETURNING mastery`,
    [userId, String(classId || ''), delta]
  )
  return Number(r.rows[0].mastery)
}

/** Sets mastery outright. Admin-only path; the caller must audit it. */
async function setClassMastery (userId, classId, mastery) {
  await ensureSchema()
  const value = Math.max(0, Math.floor(Number(mastery) || 0))
  const r = await db().query(
    `INSERT INTO axyon_class_mastery(user_id,class_id,mastery) VALUES($1,$2,$3)
     ON CONFLICT(user_id,class_id) DO UPDATE SET mastery=$3, updated_at=NOW()
     RETURNING mastery`,
    [userId, String(classId || ''), value]
  )
  return Number(r.rows[0].mastery)
}

/* --------------------------------------------------- class-move daily use */

/** Class moves already used today (UTC). */
async function classMovesUsedToday (userId, day = dayKey()) {
  await ensureSchema()
  const r = await db().query(
    'SELECT used FROM axyon_class_usage WHERE user_id=$1 AND day_key=$2',
    [userId, day]
  )
  return r.rows[0] ? Number(r.rows[0].used) : 0
}

/**
 * Atomically consumes one class-move use.
 *
 * This is the concurrency guard the note asks for. The INSERT ... ON CONFLICT
 * DO UPDATE ... WHERE used < $3 is a single statement, so Postgres serialises
 * it: of two simultaneous calls with limit 3 and 2 already used, exactly one
 * gets a row back and the other gets none. There is no read-then-write window
 * for a second request to slip through.
 *
 * Returns { ok, used, remaining }. `ok: false` means the limit was already
 * reached and NOTHING was consumed.
 */
async function consumeClassMove (userId, limit = 3, day = dayKey()) {
  await ensureSchema()
  const cap = Math.max(0, Math.floor(Number(limit) || 0))
  const r = await db().query(
    `INSERT INTO axyon_class_usage(user_id,day_key,used) VALUES($1,$2,1)
     ON CONFLICT(user_id,day_key) DO UPDATE SET used = axyon_class_usage.used + 1
       WHERE axyon_class_usage.used < $3
     RETURNING used`,
    [userId, day, cap]
  )
  if (!r.rows[0]) {
    const used = await classMovesUsedToday(userId, day)
    return { ok: false, used, remaining: Math.max(0, cap - used) }
  }
  const used = Number(r.rows[0].used)
  return { ok: true, used, remaining: Math.max(0, cap - used) }
}

/**
 * Gives a consumed use back. Used when a move passed the counter but then
 * failed downstream (the enemy died to a prior effect, the battle vanished).
 * The note is explicit that a rejected action must not consume a use.
 */
async function refundClassMove (userId, day = dayKey()) {
  await ensureSchema()
  const r = await db().query(
    `UPDATE axyon_class_usage SET used = GREATEST(0, used - 1)
     WHERE user_id=$1 AND day_key=$2 RETURNING used`,
    [userId, day]
  )
  return r.rows[0] ? Number(r.rows[0].used) : 0
}

/* ------------------------------------------------- class & move catalogue */

/*
 * The editable catalogue.
 *
 * `axyon-classes.js` holds the approved 20 classes in code. These functions
 * layer the operator's own classes and overrides on top, so `!classadmin` can
 * create, edit and delete without a redeploy.
 *
 * The layering rule is: a code definition is the base, an override row shadows
 * it, and a custom row adds a new one. Deleting an override restores the code
 * definition rather than losing it — which is why `deleted` is a soft flag and
 * the code catalogue is never written to.
 */

async function classDefs ({ includeDeleted = false } = {}) {
  await ensureSchema()
  const where = includeDeleted ? '' : 'WHERE deleted=FALSE'
  return (await db().query(`SELECT * FROM axyon_class_defs ${where} ORDER BY class_id`)).rows
}

async function classDef (classId) {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_class_defs WHERE class_id=$1', [String(classId || '').toLowerCase()])).rows[0] || null
}

/**
 * Creates or updates a class definition.
 *
 * `source` is 'custom' for a new class and 'override' when the id already
 * exists in the code catalogue. The caller does not choose it — this function
 * decides, so an operator cannot accidentally mark an official class as their
 * own and then delete it out from under the approved roster.
 */
async function upsertClassDef ({ classId, name, specialization = '', enabled = true, actor = '' }) {
  await ensureSchema()
  const id = String(classId || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  if (!id) return { ok: false, reason: 'no_id', message: 'A class needs an id.' }
  const label = String(name || '').trim()
  if (!label) return { ok: false, reason: 'no_name', message: 'A class needs a name.' }

  const existing = await classDef(id)
  const source = existing ? existing.source : 'custom'

  const r = await db().query(
    `INSERT INTO axyon_class_defs(class_id,name,specialization,source,enabled,deleted,created_by)
     VALUES($1,$2,$3,$4,$5,FALSE,$6)
     ON CONFLICT(class_id) DO UPDATE SET
       name=EXCLUDED.name,
       specialization=EXCLUDED.specialization,
       enabled=EXCLUDED.enabled,
       deleted=FALSE,
       updated_at=NOW()
     RETURNING *`,
    [id, label, String(specialization || ''), source, !!enabled, String(actor || '')]
  )
  return { ok: true, def: r.rows[0] }
}

/**
 * Soft-deletes a class definition.
 *
 * A class that players are assigned to is NOT hard-deleted: the row is marked
 * deleted and the players keep their stored class value, so nothing is
 * silently rewritten. The caller is told how many players are affected.
 */
async function deleteClassDef (classId) {
  await ensureSchema()
  const id = String(classId || '').trim().toLowerCase()
  const r = await db().query(
    'UPDATE axyon_class_defs SET deleted=TRUE, enabled=FALSE, updated_at=NOW() WHERE class_id=$1 RETURNING *',
    [id]
  )
  if (!r.rows[0]) return { ok: false, reason: 'not_found', message: 'No such class definition.' }
  const held = await db().query('SELECT COUNT(*)::int AS n FROM axyon_players WHERE LOWER(class)=$1', [id])
  return { ok: true, def: r.rows[0], players: Number(held.rows[0]?.n) || 0 }
}

async function classMoves ({ classId = null, includeDeleted = false } = {}) {
  await ensureSchema()
  const clauses = []
  const params = []
  if (classId) { params.push(String(classId).toLowerCase()); clauses.push(`class_id=$${params.length}`) }
  if (!includeDeleted) clauses.push('deleted=FALSE')
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return (await db().query(`SELECT * FROM axyon_class_moves ${where} ORDER BY class_id, id`, params)).rows
}

async function upsertClassMove ({ classId, moveId, name, moveType = 'offensive', damage = null, cost = null, unlock = null, heal = null, ultimate = false, description = '', enabled = true }) {
  await ensureSchema()
  const cid = String(classId || '').trim().toLowerCase()
  const mid = String(moveId || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  if (!cid) return { ok: false, reason: 'no_class', message: 'A move needs a class.' }
  if (!mid) return { ok: false, reason: 'no_id', message: 'A move needs an id.' }
  const label = String(name || '').trim()
  if (!label) return { ok: false, reason: 'no_name', message: 'A move needs a name.' }

  const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : null))

  const r = await db().query(
    `INSERT INTO axyon_class_moves(class_id,move_id,name,move_type,damage,cost,unlock,heal,ultimate,description,enabled)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT(class_id,move_id) DO UPDATE SET
       name=EXCLUDED.name,
       move_type=EXCLUDED.move_type,
       damage=EXCLUDED.damage,
       cost=EXCLUDED.cost,
       unlock=EXCLUDED.unlock,
       heal=EXCLUDED.heal,
       ultimate=EXCLUDED.ultimate,
       description=EXCLUDED.description,
       enabled=EXCLUDED.enabled,
       deleted=FALSE,
       updated_at=NOW()
     RETURNING *`,
    [cid, mid, label, String(moveType || 'offensive'), num(damage), num(cost), num(unlock), num(heal), !!ultimate, String(description || ''), !!enabled]
  )
  return { ok: true, move: r.rows[0] }
}

async function deleteClassMove (classId, moveId) {
  await ensureSchema()
  const r = await db().query(
    'UPDATE axyon_class_moves SET deleted=TRUE, enabled=FALSE, updated_at=NOW() WHERE class_id=$1 AND move_id=$2 RETURNING *',
    [String(classId || '').toLowerCase(), String(moveId || '').toLowerCase()]
  )
  if (!r.rows[0]) return { ok: false, reason: 'not_found', message: 'No such move.' }
  return { ok: true, move: r.rows[0] }
}

/* ------------------------------------------------------- custom room types */

async function roomTypes () {
  await ensureSchema()
  return (await db().query('SELECT * FROM axyon_room_types ORDER BY type_id')).rows
}

async function upsertRoomType ({ typeId, name, minPlayers = 1, defaultMax = 4, hardMax = 50 }) {
  await ensureSchema()
  const id = String(typeId || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  if (!id) return { ok: false, reason: 'no_id', message: 'A room type needs an id.' }
  const r = await db().query(
    `INSERT INTO axyon_room_types(type_id,name,min_players,default_max,hard_max)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(type_id) DO UPDATE SET
       name=EXCLUDED.name, min_players=EXCLUDED.min_players,
       default_max=EXCLUDED.default_max, hard_max=EXCLUDED.hard_max
     RETURNING *`,
    [id, String(name || id), Math.max(1, Math.floor(Number(minPlayers) || 1)),
      Math.max(1, Math.floor(Number(defaultMax) || 4)), Math.max(1, Math.floor(Number(hardMax) || 50))]
  )
  return { ok: true, type: r.rows[0] }
}

async function deleteRoomType (typeId) {
  await ensureSchema()
  const r = await db().query('DELETE FROM axyon_room_types WHERE type_id=$1 RETURNING *', [String(typeId || '').toLowerCase()])
  return r.rows[0] || null
}

/* ------------------------------------------------------------- guild registry */

async function guildTagTaken (tag) {
  await ensureSchema()
  return (await db().query('SELECT 1 FROM axyon_guilds WHERE LOWER(tag)=LOWER($1)', [tag])).rowCount > 0
}

async function createGuild ({ name, tag, description = '', leaderId, createdBy = '' } = {}) {
  await ensureSchema()
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 48)
  const cleanTag = String(tag || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12)
  const leader = String(leaderId || '').replace(/\D/g, '')
  if (!cleanName || !cleanTag || !leader) return { ok: false, reason: 'invalid', message: 'Guild name, tag and leader are required.' }
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query('SELECT guild_id FROM axyon_guild_members WHERE user_id=$1 FOR UPDATE', [leader])
    if (existing.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'leader_joined', message: 'That leader already belongs to a guild.' } }
    const inserted = await client.query(
      `INSERT INTO axyon_guilds(name,tag,description,leader_id,created_by)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [cleanName, cleanTag, String(description || '').trim().slice(0, 240), leader, String(createdBy || '')]
    )
    const guild = inserted.rows[0]
    await client.query("INSERT INTO axyon_guild_members(guild_id,user_id,role) VALUES($1,$2,'leader')", [guild.id, leader])
    await client.query('COMMIT')
    return { ok: true, guild }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error.code === '23505') return { ok: false, reason: 'duplicate', message: 'That guild tag is already in use, or the leader already belongs to a guild.' }
    throw error
  } finally { client.release() }
}

async function guild (identifier) {
  await ensureSchema()
  const value = String(identifier || '').trim()
  if (!value) return null
  const byId = /^\d+$/.test(value)
  return (await db().query(
    `SELECT g.*, (SELECT COUNT(*)::int FROM axyon_guild_members m WHERE m.guild_id=g.id) AS member_count
     FROM axyon_guilds g WHERE ${byId ? 'g.id=$1' : 'LOWER(g.tag)=LOWER($1)'} LIMIT 1`, [byId ? Number(value) : value]
  )).rows[0] || null
}

async function guilds ({ activeOnly = true } = {}) {
  await ensureSchema()
  return (await db().query(
    `SELECT g.*, COUNT(m.user_id)::int AS member_count
     FROM axyon_guilds g LEFT JOIN axyon_guild_members m ON m.guild_id=g.id
     ${activeOnly ? "WHERE g.status='ACTIVE'" : ''}
     GROUP BY g.id ORDER BY g.created_at DESC`
  )).rows
}

async function guildForUser (userId) {
  await ensureSchema()
  return (await db().query(
    `SELECT g.*, m.role AS member_role FROM axyon_guild_members m
     JOIN axyon_guilds g ON g.id=m.guild_id WHERE m.user_id=$1 AND g.status='ACTIVE' LIMIT 1`,
    [String(userId || '').replace(/\D/g, '')]
  )).rows[0] || null
}

async function guildMembers (guildId) {
  await ensureSchema()
  return (await db().query(
    `SELECT m.user_id,m.role,m.joined_at,p.name,p.rank,p.level
     FROM axyon_guild_members m LEFT JOIN axyon_players p ON p.user_id=m.user_id
     WHERE m.guild_id=$1 ORDER BY CASE WHEN m.role='leader' THEN 0 ELSE 1 END,m.joined_at`, [Number(guildId)]
  )).rows
}

async function joinGuild (guildId, userId) {
  await ensureSchema()
  const id = Number(guildId)
  const user = String(userId || '').replace(/\D/g, '')
  if (!Number.isSafeInteger(id) || id < 1 || !user) return { ok: false, reason: 'invalid', message: 'Choose a valid guild.' }
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const target = await client.query("SELECT * FROM axyon_guilds WHERE id=$1 AND status='ACTIVE' FOR UPDATE", [id])
    if (!target.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'missing', message: 'That guild does not exist or is inactive.' } }
    const current = await client.query('SELECT guild_id FROM axyon_guild_members WHERE user_id=$1 FOR UPDATE', [user])
    if (current.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'already_member', message: Number(current.rows[0].guild_id) === id ? 'You are already in this guild.' : 'Leave your current guild before joining another.' } }
    await client.query("INSERT INTO axyon_guild_members(guild_id,user_id,role) VALUES($1,$2,'member')", [id, user])
    await client.query('COMMIT')
    return { ok: true, guild: target.rows[0] }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error.code === '23505') return { ok: false, reason: 'already_member', message: 'You already belong to a guild.' }
    throw error
  } finally { client.release() }
}

async function leaveGuild (userId) {
  await ensureSchema()
  const user = String(userId || '').replace(/\D/g, '')
  const current = await guildForUser(user)
  if (!current) return { ok: false, reason: 'not_member', message: 'You are not in a guild.' }
  if (current.member_role === 'leader') return { ok: false, reason: 'leader', message: 'The guild leader cannot leave. Transfer leadership or ask AXYON to disband the guild.' }
  await db().query('DELETE FROM axyon_guild_members WHERE guild_id=$1 AND user_id=$2', [current.id, user])
  return { ok: true, guild: current }
}

async function bindGuildGroup (guildId, groupJid) {
  await ensureSchema()
  const id = Number(guildId)
  const jid = String(groupJid || '').trim()
  if (!Number.isSafeInteger(id) || id < 1 || !jid.endsWith('@g.us')) return { ok: false, reason: 'invalid', message: 'A valid guild and WhatsApp group are required.' }
  try {
    const r = await db().query("UPDATE axyon_guilds SET group_jid=$2,updated_at=NOW() WHERE id=$1 AND status='ACTIVE' RETURNING *", [id, jid])
    if (!r.rowCount) return { ok: false, reason: 'missing', message: 'That guild does not exist or is inactive.' }
    return { ok: true, guild: r.rows[0] }
  } catch (error) {
    if (error.code === '23505') return { ok: false, reason: 'group_taken', message: 'That WhatsApp group is already linked to another guild.' }
    throw error
  }
}

async function unbindGuildGroup (guildId) {
  await ensureSchema()
  const r = await db().query('UPDATE axyon_guilds SET group_jid=NULL,updated_at=NOW() WHERE id=$1 RETURNING *', [Number(guildId)])
  return r.rows[0] || null
}

async function transferGuildLeader (guildId, newLeaderId) {
  await ensureSchema()
  const id = Number(guildId)
  const user = String(newLeaderId || '').replace(/\D/g, '')
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const g = await client.query("SELECT * FROM axyon_guilds WHERE id=$1 AND status='ACTIVE' FOR UPDATE", [id])
    if (!g.rowCount) { await client.query('ROLLBACK'); return { ok: false, message: 'Guild not found.' } }
    const member = await client.query('SELECT 1 FROM axyon_guild_members WHERE guild_id=$1 AND user_id=$2 FOR UPDATE', [id, user])
    if (!member.rowCount) { await client.query('ROLLBACK'); return { ok: false, message: 'The new leader must already be a guild member.' } }
    await client.query("UPDATE axyon_guild_members SET role='member' WHERE guild_id=$1 AND role='leader'", [id])
    await client.query("UPDATE axyon_guild_members SET role='leader' WHERE guild_id=$1 AND user_id=$2", [id, user])
    await client.query('UPDATE axyon_guilds SET leader_id=$2,updated_at=NOW() WHERE id=$1', [id, user])
    await client.query('COMMIT')
    return { ok: true, guild: g.rows[0], leaderId: user }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

async function disbandGuild (guildId) {
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const r = await client.query("UPDATE axyon_guilds SET status='DISBANDED',group_jid=NULL,updated_at=NOW() WHERE id=$1 AND status='ACTIVE' RETURNING *", [Number(guildId)])
    if (!r.rowCount) { await client.query('ROLLBACK'); return null }
    // Release members so they can join another guild; the guild record itself remains as history.
    await client.query('DELETE FROM axyon_guild_members WHERE guild_id=$1', [Number(guildId)])
    await client.query('COMMIT')
    return r.rows[0]
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

async function suggestGuild ({ suggestedBy, name, tag, description = '' } = {}) {
  await ensureSchema()
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 48)
  const cleanTag = String(tag || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12)
  const user = String(suggestedBy || '').replace(/\D/g, '')
  if (!cleanName || !cleanTag || !user) return { ok: false, message: 'Name, tag and requester are required.' }
  const existing = await db().query("SELECT id FROM axyon_guild_suggestions WHERE suggested_by=$1 AND status='PENDING'", [user])
  if (existing.rowCount) return { ok: false, message: 'You already have a pending guild suggestion.' }
  try {
    const r = await db().query(
      `INSERT INTO axyon_guild_suggestions(suggested_by,name,tag,description)
       VALUES($1,$2,$3,$4) RETURNING *`, [user, cleanName, cleanTag, String(description || '').trim().slice(0, 240)]
    )
    return { ok: true, suggestion: r.rows[0] }
  } catch (error) {
    if (error.code === '23505') return { ok: false, message: 'You already have a pending guild suggestion.' }
    throw error
  }
}

async function guildSuggestions ({ pendingOnly = true } = {}) {
  await ensureSchema()
  return (await db().query(
    `SELECT s.*,p.name AS suggester_name FROM axyon_guild_suggestions s
     LEFT JOIN axyon_players p ON p.user_id=s.suggested_by
     ${pendingOnly ? "WHERE s.status='PENDING'" : ''} ORDER BY s.created_at DESC LIMIT 50`
  )).rows
}

async function resolveGuildSuggestion (suggestionId, reviewerId, approve = false) {
  await ensureSchema()
  const id = Number(suggestionId)
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const q = await client.query("SELECT * FROM axyon_guild_suggestions WHERE id=$1 AND status='PENDING' FOR UPDATE", [id])
    if (!q.rowCount) { await client.query('ROLLBACK'); return { ok: false, message: 'No pending suggestion with that ID.' } }
    let created = null
    if (approve) {
      const s = q.rows[0]
      const inserted = await client.query(
        `INSERT INTO axyon_guilds(name,tag,description,leader_id,created_by)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [s.name, s.tag, s.description, s.suggested_by, String(reviewerId || '')]
      )
      created = inserted.rows[0]
      await client.query("INSERT INTO axyon_guild_members(guild_id,user_id,role) VALUES($1,$2,'leader')", [created.id, s.suggested_by])
    }
    await client.query(
      `UPDATE axyon_guild_suggestions SET status=$2,reviewed_by=$3,guild_id=$4,reviewed_at=NOW() WHERE id=$1`,
      [id, approve ? 'APPROVED' : 'REJECTED', String(reviewerId || ''), created?.id || null]
    )
    await client.query('COMMIT')
    return { ok: true, suggestion: q.rows[0], guild: created }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error.code === '23505') return { ok: false, message: 'The proposed tag is already in use, or the suggester already belongs to a guild.' }
    throw error
  } finally { client.release() }
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
  BASE_COMBAT_STATS: Object.freeze({ str: 5, per: 5, sta: 5, vit: 5 }),
  FATIGUE_RECOVERY_MINUTES: 15,
  mpCapacityForLevel,
  DEFAULT_SETTINGS,
  ORIGINAL_STAGES,
  ORIGINAL_FLOORS,
  ensureSchema,
  settings,
  getSetting,
  setSetting,
  setSettings,
  registerGroup,
  updateGroupMode,
  updateGroupFeatures,
  updateGroupStatus,
  GROUP_MODES,
  unregisterGroup,
  group,
  groups,
  touchGroupActivity,
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
  resetAllPlayers,
  leaderboard,
  playerCount,
  setBattle,
  getBattle,
  trainPlayer,
  convertCoinsToZen,
  activeDuelForUser,
  mutateDuel,
  floorStory,
  saveFloorStory,
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
  studioRenderedCard,
  addCard,
  claimCard,
  createCardDrop,
  claimStudioCard,
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
  setVisualImage,
  clearVisual,
  ARMOR_TIERS,
  armorTier,
  armorFor,
  equippedArmor,
  buyArmor,
  equipArmor,
  unequipArmor,
  repairArmor,
  wearArmor,
  modes,
  setMode,
  createParty,
  openParty,
  updateParty,
  partyForUser,
  mutateParty,
  createRoom,
  room,
  roomsFor,
  updateRoom,
  mutateRoomState,
  createDuel,
  duel,
  updateDuel,
  inventory,
  inventoryQty,
  addItem,
  consumeItem,
  combos,
  hasCombo,
  unlockCombo,
  buyCombo,
  classMastery,
  classMasteries,
  addClassMastery,
  setClassMastery,
  classMovesUsedToday,
  consumeClassMove,
  refundClassMove,
  classDefs,
  classDef,
  upsertClassDef,
  deleteClassDef,
  classMoves,
  upsertClassMove,
  deleteClassMove,
  roomTypes,
  upsertRoomType,
  deleteRoomType,
  createGuild,
  guild,
  guilds,
  guildForUser,
  guildMembers,
  joinGuild,
  leaveGuild,
  bindGuildGroup,
  unbindGuildGroup,
  transferGuildLeader,
  disbandGuild,
  suggestGuild,
  guildSuggestions,
  resolveGuildSuggestion,
  log,
  recentLog
}
