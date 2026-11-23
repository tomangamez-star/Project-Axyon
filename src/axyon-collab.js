'use strict'

/*
 * AXYON-native collaboration campaigns.
 * Adapted from the supplied Architect Collab reference package, but wired to
 * AXYON's PostgreSQL database and registered-group identity model. Group JIDs
 * are only accepted through the command layer after live admin verification.
 */
const { database } = require('./auth-store')

const STATUSES = Object.freeze(['draft', 'pending', 'approved', 'active', 'paused', 'completed', 'cancelled'])
function db () {
  const pool = database()
  if (!pool) throw Object.assign(new Error('DATABASE_URL is required for persistent collaborations.'), { status: 503 })
  return pool
}
function clean (value, max = 500) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) }
function validGroupJid (value) { return /^[0-9]+-[0-9]+@g\.us$/.test(String(value || '')) }
function canTransition (from, to) {
  const allowed = {
    draft: ['pending', 'cancelled'], pending: ['approved', 'cancelled'],
    approved: ['active', 'cancelled'], active: ['paused', 'completed', 'cancelled'],
    paused: ['active', 'cancelled'], completed: [], cancelled: []
  }
  return (allowed[from] || []).includes(to)
}
let ready = false
async function ensureSchema () {
  if (ready) return
  await db().query(`
    CREATE TABLE IF NOT EXISTS axyon_collabs (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      creator_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS axyon_collab_groups (
      collab_id BIGINT NOT NULL REFERENCES axyon_collabs(id) ON DELETE CASCADE,
      group_jid TEXT NOT NULL,
      group_name TEXT NOT NULL DEFAULT '',
      added_by TEXT NOT NULL,
      verified_admin BOOLEAN NOT NULL DEFAULT TRUE,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(collab_id,group_jid)
    );
    CREATE TABLE IF NOT EXISTS axyon_collab_participants (
      collab_id BIGINT NOT NULL REFERENCES axyon_collabs(id) ON DELETE CASCADE,
      group_jid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT 'Member',
      points INT NOT NULL DEFAULT 0,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(collab_id,group_jid,user_id),
      FOREIGN KEY(collab_id,group_jid) REFERENCES axyon_collab_groups(collab_id,group_jid) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS axyon_collab_events (
      id BIGSERIAL PRIMARY KEY,
      collab_id BIGINT NOT NULL REFERENCES axyon_collabs(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS axyon_collab_missions (
      id BIGSERIAL PRIMARY KEY,
      collab_id BIGINT NOT NULL REFERENCES axyon_collabs(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      points INT NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS axyon_collab_mission_claims (
      mission_id BIGINT NOT NULL REFERENCES axyon_collab_missions(id) ON DELETE CASCADE,
      collab_id BIGINT NOT NULL REFERENCES axyon_collabs(id) ON DELETE CASCADE,
      group_jid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      PRIMARY KEY(mission_id,group_jid,user_id)
    );
    CREATE TABLE IF NOT EXISTS axyon_collab_rewards (
      id BIGSERIAL PRIMARY KEY,
      collab_id BIGINT NOT NULL REFERENCES axyon_collabs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      points_required INT NOT NULL DEFAULT 0,
      quantity INT NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS axyon_collab_reward_claims (
      reward_id BIGINT NOT NULL REFERENCES axyon_collab_rewards(id) ON DELETE CASCADE,
      group_jid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(reward_id,group_jid,user_id)
    );
    CREATE TABLE IF NOT EXISTS axyon_collab_audit (
      id BIGSERIAL PRIMARY KEY,
      collab_id BIGINT REFERENCES axyon_collabs(id) ON DELETE SET NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS axyon_collab_status_idx ON axyon_collabs(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS axyon_collab_participant_user_idx ON axyon_collab_participants(user_id);
  `)
  ready = true
}
async function audit (collabId, actorId, action, detail = {}) {
  await db().query('INSERT INTO axyon_collab_audit(collab_id,actor_id,action,detail) VALUES($1,$2,$3,$4::jsonb)',
    [collabId || null, String(actorId || 'system'), action, JSON.stringify(detail)])
}
async function create ({ title, description = '', creatorId } = {}) {
  const t = clean(title, 60)
  if (!t || !creatorId) throw new Error('A collaboration title and creator are required.')
  await ensureSchema()
  const row = (await db().query('INSERT INTO axyon_collabs(title,description,creator_id) VALUES($1,$2,$3) RETURNING *',
    [t, clean(description, 1000), String(creatorId)])).rows[0]
  await audit(row.id, creatorId, 'created')
  return row
}
async function get (id) {
  await ensureSchema()
  const value = String(id || '').trim()
  if (!/^\d+$/.test(value)) return null
  const collab = (await db().query('SELECT * FROM axyon_collabs WHERE id=$1', [Number(value)])).rows[0]
  if (!collab) return null
  const [groups, participants, events, missions, rewards] = await Promise.all([
    db().query('SELECT * FROM axyon_collab_groups WHERE collab_id=$1 ORDER BY added_at', [collab.id]),
    db().query('SELECT COUNT(*)::int AS count FROM axyon_collab_participants WHERE collab_id=$1', [collab.id]),
    db().query('SELECT * FROM axyon_collab_events WHERE collab_id=$1 ORDER BY starts_at', [collab.id]),
    db().query('SELECT * FROM axyon_collab_missions WHERE collab_id=$1 ORDER BY id', [collab.id]),
    db().query('SELECT * FROM axyon_collab_rewards WHERE collab_id=$1 ORDER BY id', [collab.id])
  ])
  return { ...collab, groups: groups.rows, participant_count: participants.rows[0]?.count || 0,
    events: events.rows, missions: missions.rows, rewards: rewards.rows }
}
async function list (status = null) {
  await ensureSchema()
  const key = status ? clean(status, 20).toLowerCase() : null
  if (key && !STATUSES.includes(key)) throw new Error('Unknown collaboration status.')
  return (await db().query(
    `SELECT c.*,COUNT(DISTINCT g.group_jid)::int AS group_count,COUNT(DISTINCT p.user_id)::int AS participant_count
     FROM axyon_collabs c LEFT JOIN axyon_collab_groups g ON g.collab_id=c.id
     LEFT JOIN axyon_collab_participants p ON p.collab_id=c.id
     WHERE ($1::text IS NULL OR c.status=$1)
     GROUP BY c.id ORDER BY c.created_at DESC LIMIT 30`, [key])).rows
}
async function manage (id, actorId, isOwner = false) {
  const c = await get(id)
  if (!c) throw new Error('Collaboration not found.')
  if (!isOwner && String(c.creator_id) !== String(actorId)) throw new Error('Only the creator or AXYON can manage this collaboration.')
  return c
}
async function setStatus (id, actorId, next, isOwner = false) {
  const c = await manage(id, actorId, isOwner)
  if (!canTransition(c.status, next)) throw new Error(`Collaboration cannot move from ${c.status} to ${next}.`)
  if (next === 'active' && c.groups.length < 2) throw new Error('At least two verified registered groups are required before this collaboration can start.')
  const row = (await db().query('UPDATE axyon_collabs SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [c.id, next])).rows[0]
  await audit(c.id, actorId, `status_${next}`)
  return row
}
async function addGroup (id, { groupJid, name, actorId, verifiedAdmin, isOwner = false } = {}) {
  // As in the supplied reference package, each participating group's own
  // verified administrator may attach that group. They do not gain campaign
  // management rights merely by linking it; status/mission/reward management
  // remains restricted to the creator or AXYON.
  const c = await get(id)
  if (!c) throw new Error('Collaboration not found.')
  if (!validGroupJid(groupJid)) throw new Error('A valid WhatsApp group ID is required.')
  if (!verifiedAdmin) throw new Error('The actor must be verified as a WhatsApp group admin.')
  if (c.status !== 'draft' && c.status !== 'pending' && c.status !== 'approved') throw new Error('Groups can only be added before the collaboration starts.')
  const count = (await db().query('SELECT COUNT(*)::int AS n FROM axyon_collab_groups WHERE collab_id=$1', [c.id])).rows[0].n
  if (Number(count) >= 20) throw new Error('This collaboration has reached the 20-group limit.')
  const row = (await db().query(
    'INSERT INTO axyon_collab_groups(collab_id,group_jid,group_name,added_by,verified_admin) VALUES($1,$2,$3,$4,TRUE) RETURNING *',
    [c.id, groupJid, clean(name || 'WhatsApp group', 100), String(actorId)])).rows[0]
  await audit(c.id, actorId, 'group_added', { groupJid })
  return row
}
async function removeGroup (id, groupJid, actorId, isOwner = false) {
  const c = await manage(id, actorId, isOwner)
  const row = (await db().query('DELETE FROM axyon_collab_groups WHERE collab_id=$1 AND group_jid=$2 RETURNING *', [c.id, groupJid])).rows[0]
  if (!row) throw new Error('Participating group not found.')
  await audit(c.id, actorId, 'group_removed', { groupJid })
  return row
}
async function join (id, { groupJid, userId, displayName }) {
  const c = await get(id)
  if (!c || c.status !== 'active') throw new Error('This collaboration is not accepting participants.')
  if (!c.groups.some(g => g.group_jid === groupJid)) throw new Error('This registered group is not part of the collaboration.')
  await ensureSchema()
  const count = (await db().query('SELECT COUNT(*)::int AS n FROM axyon_collab_participants WHERE collab_id=$1 AND group_jid=$2', [c.id, groupJid])).rows[0].n
  if (Number(count) >= 200) throw new Error('This group has reached the 200-participant limit.')
  const row = (await db().query(
    `INSERT INTO axyon_collab_participants(collab_id,group_jid,user_id,display_name)
     VALUES($1,$2,$3,$4) ON CONFLICT(collab_id,group_jid,user_id) DO NOTHING RETURNING *`,
    [c.id, groupJid, String(userId), clean(displayName || 'Member', 60)])).rows[0]
  if (!row) throw new Error('You have already joined this collaboration from this group.')
  await audit(c.id, userId, 'participant_join', { groupJid })
  return row
}
async function leave (id, groupJid, userId) {
  await ensureSchema()
  const row = (await db().query('DELETE FROM axyon_collab_participants WHERE collab_id=$1 AND group_jid=$2 AND user_id=$3 RETURNING *',
    [Number(id), groupJid, String(userId)])).rows[0]
  if (!row) throw new Error('You are not participating in this collaboration from this group.')
  await audit(Number(id), userId, 'participant_leave', { groupJid })
  return row
}
async function addEvent (id, data, actorId, isOwner = false) {
  const c = await manage(id, actorId, isOwner)
  if (!['draft', 'pending', 'approved', 'active'].includes(c.status)) throw new Error('Events cannot be added to a closed collaboration.')
  const title = clean(data.title, 80)
  const description = clean(data.description, 500)
  const starts = new Date(data.startsAt)
  const ends = new Date(data.endsAt)
  if (!title || !Number.isFinite(starts.getTime()) || !Number.isFinite(ends.getTime()) || ends <= starts) throw new Error('Supply an event title and valid start/end dates.')
  const count = (await db().query('SELECT COUNT(*)::int AS n FROM axyon_collab_events WHERE collab_id=$1', [c.id])).rows[0].n
  if (Number(count) >= 30) throw new Error('This collaboration has reached the 30-event limit.')
  const row = (await db().query('INSERT INTO axyon_collab_events(collab_id,title,description,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [c.id, title, description, starts.toISOString(), ends.toISOString(), String(actorId)])).rows[0]
  await audit(c.id, actorId, 'event_added', { eventId: row.id })
  return row
}
async function addMission (id, data, actorId, isOwner = false) {
  const c = await manage(id, actorId, isOwner)
  const title = clean(data.title, 80)
  const description = clean(data.description, 500)
  if (!title || !description) throw new Error('Mission title and description are required.')
  const points = Math.max(0, Math.min(100000, Math.floor(Number(data.points) || 0)))
  const count = (await db().query('SELECT COUNT(*)::int AS n FROM axyon_collab_missions WHERE collab_id=$1', [c.id])).rows[0].n
  if (Number(count) >= 30) throw new Error('This collaboration has reached the 30-mission limit.')
  const row = (await db().query('INSERT INTO axyon_collab_missions(collab_id,title,description,points,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [c.id, title, description, points, String(actorId)])).rows[0]
  await audit(c.id, actorId, 'mission_added', { missionId: row.id })
  return row
}
async function requestMission (missionId, groupJid, userId) {
  await ensureSchema()
  const mission = (await db().query('SELECT m.*,c.status AS collab_status FROM axyon_collab_missions m JOIN axyon_collabs c ON c.id=m.collab_id WHERE m.id=$1', [Number(missionId)])).rows[0]
  if (!mission || mission.collab_status !== 'active') throw new Error('Mission not found or collaboration is not active.')
  const participant = await db().query('SELECT 1 FROM axyon_collab_participants WHERE collab_id=$1 AND group_jid=$2 AND user_id=$3', [mission.collab_id, groupJid, String(userId)])
  if (!participant.rowCount) throw new Error('Join the collaboration first.')
  const result = (await db().query(
    `INSERT INTO axyon_collab_mission_claims(mission_id,collab_id,group_jid,user_id,status)
     VALUES($1,$2,$3,$4,'pending') ON CONFLICT(mission_id,group_jid,user_id) DO NOTHING RETURNING *`,
    [mission.id, mission.collab_id, groupJid, String(userId)])).rows[0]
  if (!result) throw new Error('You already submitted this mission.')
  await audit(mission.collab_id, userId, 'mission_submitted', { missionId: mission.id, groupJid })
  return result
}
async function reviewMission (missionId, groupJid, userId, reviewerId, approve, isOwner = false) {
  await ensureSchema()
  const mission = (await db().query('SELECT m.*,c.creator_id FROM axyon_collab_missions m JOIN axyon_collabs c ON c.id=m.collab_id WHERE m.id=$1', [Number(missionId)])).rows[0]
  if (!mission) throw new Error('Mission not found.')
  if (!isOwner && mission.creator_id !== String(reviewerId)) throw new Error('Only the collaboration creator or AXYON can review mission submissions.')
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const claim = await client.query("SELECT * FROM axyon_collab_mission_claims WHERE mission_id=$1 AND group_jid=$2 AND user_id=$3 AND status='pending' FOR UPDATE", [mission.id, groupJid, String(userId)])
    if (!claim.rowCount) { await client.query('ROLLBACK'); throw new Error('No pending submission was found for this player.') }
    await client.query('UPDATE axyon_collab_mission_claims SET status=$4,reviewed_by=$5,reviewed_at=NOW() WHERE mission_id=$1 AND group_jid=$2 AND user_id=$3',
      [mission.id, groupJid, String(userId), approve ? 'approved' : 'rejected', String(reviewerId)])
    if (approve) await client.query('UPDATE axyon_collab_participants SET points=points+$4 WHERE collab_id=$1 AND group_jid=$2 AND user_id=$3',
      [mission.collab_id, groupJid, String(userId), Number(mission.points)])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
  await audit(mission.collab_id, reviewerId, approve ? 'mission_approved' : 'mission_rejected', { missionId: mission.id, groupJid, userId })
  return { points: approve ? Number(mission.points) : 0, status: approve ? 'approved' : 'rejected' }
}
async function addReward (id, data, actorId, isOwner = false) {
  const c = await manage(id, actorId, isOwner)
  const name = clean(data.name, 80)
  if (!name) throw new Error('Reward name is required.')
  const points = Math.max(0, Math.floor(Number(data.pointsRequired) || 0))
  const quantity = Math.max(1, Math.min(10000, Math.floor(Number(data.quantity) || 1)))
  const count = (await db().query('SELECT COUNT(*)::int AS n FROM axyon_collab_rewards WHERE collab_id=$1', [c.id])).rows[0].n
  if (Number(count) >= 20) throw new Error('This collaboration has reached the 20-reward limit.')
  const row = (await db().query('INSERT INTO axyon_collab_rewards(collab_id,name,description,points_required,quantity,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [c.id, name, clean(data.description, 300), points, quantity, String(actorId)])).rows[0]
  await audit(c.id, actorId, 'reward_added', { rewardId: row.id })
  return row
}
async function claimReward (rewardId, groupJid, userId) {
  await ensureSchema()
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const q = await client.query(
      `SELECT r.*,c.status AS collab_status,p.points FROM axyon_collab_rewards r
       JOIN axyon_collabs c ON c.id=r.collab_id
       JOIN axyon_collab_participants p ON p.collab_id=r.collab_id AND p.group_jid=$2 AND p.user_id=$3
       WHERE r.id=$1 FOR UPDATE OF r,p`, [Number(rewardId), groupJid, String(userId)])
    if (!q.rowCount) { await client.query('ROLLBACK'); throw new Error('Reward or collaboration participant not found.') }
    const reward = q.rows[0]
    if (reward.collab_status !== 'active') { await client.query('ROLLBACK'); throw new Error('Rewards can only be claimed while the collaboration is active.') }
    const claims = await client.query('SELECT COUNT(*)::int AS n FROM axyon_collab_reward_claims WHERE reward_id=$1', [reward.id])
    if (Number(claims.rows[0].n) >= Number(reward.quantity)) { await client.query('ROLLBACK'); throw new Error('This reward has already been fully claimed.') }
    if (Number(reward.points) < Number(reward.points_required)) { await client.query('ROLLBACK'); throw new Error('You do not have enough collaboration points.') }
    await client.query('INSERT INTO axyon_collab_reward_claims(reward_id,group_jid,user_id) VALUES($1,$2,$3)', [reward.id, groupJid, String(userId)])
    await client.query('UPDATE axyon_collab_participants SET points=points-$4 WHERE collab_id=$1 AND group_jid=$2 AND user_id=$3',
      [reward.collab_id, groupJid, String(userId), Number(reward.points_required)])
    await client.query('COMMIT')
    await audit(reward.collab_id, userId, 'reward_claimed', { rewardId: reward.id, groupJid })
    return reward
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}
async function stats (id) {
  const c = await get(id)
  if (!c) throw new Error('Collaboration not found.')
  const rows = await db().query('SELECT COUNT(*)::int AS participants,COALESCE(SUM(points),0)::int AS points FROM axyon_collab_participants WHERE collab_id=$1', [c.id])
  const eventCount = (await db().query('SELECT COUNT(*)::int AS n FROM axyon_collab_events WHERE collab_id=$1', [c.id])).rows[0].n
  const missionCompletions = (await db().query("SELECT COUNT(*)::int AS n FROM axyon_collab_mission_claims WHERE collab_id=$1 AND status='approved'", [c.id])).rows[0].n
  return { groups: c.groups.length, participants: rows.rows[0].participants, points: rows.rows[0].points,
    events: Number(eventCount), missions: c.missions.length, missionCompletions: Number(missionCompletions), rewards: c.rewards.length }
}
async function leaderboard (id, limit = 10) {
  const c = await get(id)
  if (!c) throw new Error('Collaboration not found.')
  return (await db().query('SELECT user_id,display_name,group_jid,points FROM axyon_collab_participants WHERE collab_id=$1 ORDER BY points DESC,joined_at ASC LIMIT $2',
    [c.id, Math.max(1, Math.min(50, Number(limit) || 10))])).rows
}

module.exports = {
  STATUSES, clean, validGroupJid, canTransition, ensureSchema, create, get, list, manage, setStatus,
  addGroup, removeGroup, join, leave, addEvent, addMission, requestMission, reviewMission,
  addReward, claimReward, stats, leaderboard
}
