'use strict'
/*
 * DASHBOARD AUTH — WhatsApp-number login, sessions, and the feedback inbox.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dashboard used to be protected by one shared password in an env var.
 * That is a single secret for everyone, it cannot tell an admin from a
 * moderator, and it cannot be revoked per person. This module replaces it with
 * a login that proves the person controls a WhatsApp number:
 *
 *   1. They type their number on the dashboard.
 *   2. The bot sends a 7- or 8-digit code to that number PRIVATELY.
 *   3. They type the code on the dashboard and get a session.
 *
 * The code is never returned by the API — it only ever leaves the server as a
 * WhatsApp message to the number that asked for it. That is what makes the
 * number itself the credential.
 *
 * SESSIONS SURVIVE APP SWITCHING
 * ------------------------------
 * A session is a row in Postgres with an expiry, and the browser holds the
 * token in localStorage as well as a cookie. Switching apps on a phone
 * suspends the page; it does not end the session. On return the client
 * re-validates the token and lands back where it was, instead of showing the
 * login screen again.
 *
 * FEEDBACK
 * --------
 * Anyone — logged in or not — can send AXYON a message. It is stored with no
 * identity attached beyond a random per-session id that is discarded when the
 * tab closes, so a person can hold a conversation without being identified.
 */
const crypto = require('crypto')
const { database } = require('./auth-store')
const { isOwner, norm } = require('./access')

const CODE_TTL_MS = 10 * 60 * 1000      // a code is good for ten minutes
const CODE_MAX_TRIES = 5                // then it is burned
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000  // thirty days
const RESEND_COOLDOWN_MS = 45 * 1000    // one code per number per 45 s

let ready = false

function db () {
  const d = database()
  if (!d) throw Object.assign(new Error('DATABASE_URL is required for dashboard login'), { status: 503 })
  return d
}

async function ensureSchema () {
  if (ready) return
  await db().query(`
    CREATE TABLE IF NOT EXISTS axyon_login_codes(
      phone TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'guest',
      tries INT NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS axyon_dash_sessions(
      token_hash TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'guest',
      csrf TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL);

    CREATE TABLE IF NOT EXISTS axyon_feedback(
      id BIGSERIAL PRIMARY KEY,
      thread TEXT NOT NULL,
      body TEXT NOT NULL,
      from_staff BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `)
  ready = true
}

/* ------------------------------------------------------------------ codes */

/** A 7- or 8-digit code. Never starts with 0, so it reads as a number. */
function newCode () {
  const digits = Math.random() < 0.5 ? 7 : 8
  let out = String(1 + Math.floor(Math.random() * 9))
  for (let i = 1; i < digits; i++) out += String(Math.floor(Math.random() * 10))
  return out
}

function hashCode (phone, code) {
  return crypto.createHash('sha256').update(`${norm(phone)}:${code}`).digest('hex')
}

function hashToken (token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

/**
 * Resolves the role a number logs in as.
 *
 * Owner numbers and AXYON_NUMBERS are admin. A number listed in axyon_roles as
 * 'rhm' is rhm. Everyone else is a guest — they can look at the game content
 * but nothing that exposes an account.
 */
async function roleFor (phone) {
  const p = norm(phone)
  if (!p) return null
  if (isOwner(p)) return 'admin'
  try {
    const store = require('./axyon-store')
    if (await store.axyonNumberMode(p).catch(() => null) !== null) return 'admin'
    const role = await store.roleOf(p).catch(() => null)
    if (role === 'rhm') return 'rhm'
  } catch { /* no store yet — fall through to guest */ }
  return 'guest'
}

/**
 * Issues a code for a number.
 *
 * Returns `{ ok, code, role }` — the CALLER sends `code` over WhatsApp and
 * must never put it in an HTTP response.
 */
async function issueCode (phone) {
  await ensureSchema()
  const p = norm(phone)
  if (!/^\d{8,15}$/.test(p)) {
    return { ok: false, reason: 'bad-number', message: 'Enter your number in international format, digits only.' }
  }

  const existing = (await db().query('SELECT created_at FROM axyon_login_codes WHERE phone=$1', [p])).rows[0]
  if (existing) {
    const age = Date.now() - new Date(existing.created_at).getTime()
    if (age < RESEND_COOLDOWN_MS) {
      return {
        ok: false,
        reason: 'cooldown',
        retryAfterMs: RESEND_COOLDOWN_MS - age,
        message: `A code was just sent. Wait ${Math.ceil((RESEND_COOLDOWN_MS - age) / 1000)} seconds before asking for another.`
      }
    }
  }

  const role = await roleFor(p)
  const code = newCode()
  await db().query(
    `INSERT INTO axyon_login_codes(phone,code_hash,role,tries,expires_at,created_at)
     VALUES($1,$2,$3,0,NOW()+($4::bigint * INTERVAL '1 millisecond'),NOW())
     ON CONFLICT(phone) DO UPDATE SET code_hash=EXCLUDED.code_hash,role=EXCLUDED.role,
       tries=0,expires_at=EXCLUDED.expires_at,created_at=NOW()`,
    [p, hashCode(p, code), role, CODE_TTL_MS]
  )
  return { ok: true, code, role, phone: p }
}

/**
 * Verifies a code and, on success, creates a session.
 *
 * Returns `{ ok, token, csrf, role, phone }` or `{ ok:false, message }`.
 * A wrong code burns one try; five wrong tries delete the code entirely.
 */
async function verifyCode (phone, code) {
  await ensureSchema()
  const p = norm(phone)
  const c = String(code || '').replace(/\D/g, '')
  if (!p || !c) return { ok: false, message: 'Enter the number and the code.' }

  const row = (await db().query('SELECT * FROM axyon_login_codes WHERE phone=$1', [p])).rows[0]
  if (!row) return { ok: false, message: 'No code was requested for that number. Ask for one first.' }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db().query('DELETE FROM axyon_login_codes WHERE phone=$1', [p])
    return { ok: false, message: 'That code has expired. Ask for a new one.' }
  }
  if (row.tries >= CODE_MAX_TRIES) {
    await db().query('DELETE FROM axyon_login_codes WHERE phone=$1', [p])
    return { ok: false, message: 'Too many wrong attempts. Ask for a new code.' }
  }
  if (row.code_hash !== hashCode(p, c)) {
    await db().query('UPDATE axyon_login_codes SET tries=tries+1 WHERE phone=$1', [p])
    const left = CODE_MAX_TRIES - (row.tries + 1)
    return { ok: false, message: left > 0 ? `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Ask for a new code.' }
  }

  /* Success: the code is single-use. */
  await db().query('DELETE FROM axyon_login_codes WHERE phone=$1', [p])

  const token = crypto.randomBytes(32).toString('base64url')
  const csrf = crypto.randomBytes(24).toString('base64url')
  await db().query(
    `INSERT INTO axyon_dash_sessions(token_hash,phone,role,csrf,expires_at)
     VALUES($1,$2,$3,$4,NOW()+($5::bigint * INTERVAL '1 millisecond'))`,
    [hashToken(token), p, row.role, csrf, SESSION_TTL_MS]
  )
  return { ok: true, token, csrf, role: row.role, phone: p }
}

/* --------------------------------------------------------------- sessions */

/** Resolves a session token to `{ phone, role, csrf }`, or null. */
async function session (token) {
  if (!token) return null
  await ensureSchema()
  const row = (await db().query(
    'SELECT phone,role,csrf,expires_at FROM axyon_dash_sessions WHERE token_hash=$1',
    [hashToken(token)]
  )).rows[0]
  if (!row) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db().query('DELETE FROM axyon_dash_sessions WHERE token_hash=$1', [hashToken(token)])
    return null
  }
  /* Touch at most once a minute, so a busy dashboard is not a write storm. */
  await db().query(
    'UPDATE axyon_dash_sessions SET last_seen_at=NOW() WHERE token_hash=$1 AND last_seen_at < NOW() - INTERVAL \'1 minute\'',
    [hashToken(token)]
  ).catch(() => {})
  return { phone: row.phone, role: row.role, csrf: row.csrf }
}

async function endSession (token) {
  if (!token) return
  await ensureSchema()
  await db().query('DELETE FROM axyon_dash_sessions WHERE token_hash=$1', [hashToken(token)])
}

/** Drops expired rows. Cheap, and keeps the tables from growing forever. */
async function prune () {
  await ensureSchema()
  await db().query("DELETE FROM axyon_dash_sessions WHERE expires_at <= NOW()").catch(() => {})
  await db().query("DELETE FROM axyon_login_codes WHERE expires_at <= NOW()").catch(() => {})
}

/* --------------------------------------------------------------- feedback */

/**
 * Stores one feedback message.
 *
 * `thread` is a random id the browser generates per tab and throws away when
 * the tab closes. It is what lets a reply land in the same conversation
 * without the server ever knowing who the person is.
 */
async function addFeedback (thread, body, { fromStaff = false } = {}) {
  await ensureSchema()
  const t = String(thread || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
  const text = String(body || '').trim().slice(0, 2000)
  if (!t || !text) return { ok: false, message: 'Type a message first.' }
  const r = await db().query(
    'INSERT INTO axyon_feedback(thread,body,from_staff) VALUES($1,$2,$3) RETURNING id,created_at',
    [t, text, !!fromStaff]
  )
  return { ok: true, id: r.rows[0].id, createdAt: r.rows[0].created_at }
}

/** The conversation for one thread, oldest first. */
async function feedbackThread (thread) {
  await ensureSchema()
  const t = String(thread || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
  if (!t) return []
  return (await db().query(
    'SELECT id,body,from_staff,created_at FROM axyon_feedback WHERE thread=$1 ORDER BY id',
    [t]
  )).rows.map(r => ({ id: r.id, body: r.body, fromStaff: r.from_staff, createdAt: r.created_at }))
}

/** The staff inbox: the newest message of every thread, newest first. */
async function feedbackInbox (limit = 60) {
  await ensureSchema()
  const rows = (await db().query(`
    SELECT f.thread, f.body, f.from_staff, f.created_at,
           (SELECT COUNT(*)::int FROM axyon_feedback x WHERE x.thread=f.thread) AS total
    FROM axyon_feedback f
    JOIN (SELECT thread, MAX(id) AS id FROM axyon_feedback GROUP BY thread) m ON m.id=f.id
    ORDER BY f.id DESC LIMIT $1`, [Math.max(1, Math.min(200, Number(limit) || 60))])).rows
  return rows.map(r => ({ thread: r.thread, preview: r.body, fromStaff: r.from_staff, createdAt: r.created_at, total: r.total }))
}

module.exports = {
  ensureSchema,
  newCode,
  roleFor,
  issueCode,
  verifyCode,
  session,
  endSession,
  prune,
  addFeedback,
  feedbackThread,
  feedbackInbox,
  _test: { newCode, hashCode, hashToken, CODE_TTL_MS, SESSION_TTL_MS }
}
