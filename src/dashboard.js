'use strict'
/*
 * DASHBOARD — the HTTP surface for Architect Control.
 *
 * AUTHENTICATION
 * --------------
 * There is no shared password any more. A person signs in with the WhatsApp
 * number the bot already knows them by:
 *
 *   POST /dashboard/api/login/request  { phone }
 *        -> the bot sends a 7- or 8-digit code to that number, privately
 *   POST /dashboard/api/login/verify   { phone, code }
 *        -> a session token, a role, and the permissions that role holds
 *
 * The code is NEVER in the HTTP response. It only ever leaves the server as a
 * WhatsApp message, which is what makes control of the number the credential.
 *
 * The session token is returned in the body AND set as a cookie. The client
 * keeps it in localStorage too, so switching apps on a phone (which suspends
 * the page) does not log anyone out — the token is still valid when the page
 * comes back, and the client re-validates instead of showing the login screen.
 *
 * AUTHORITY
 * ---------
 * Every route names the permission it needs and asks `access.can(role, perm)`.
 * No route hardcodes a role name, so adding a level later is one table edit.
 *
 * FEEDBACK
 * --------
 * `/dashboard/api/feedback*` is deliberately OUTSIDE the auth gate. Anyone can
 * message AXYON without an account; the thread id is a random value the
 * browser makes per tab and discards, so nothing identifies the sender.
 */
const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')
const { createAxyonAdmin } = require('./axyon-admin')
const { createAxyon } = require('./axyon-rpg')
const { createCommands } = require('./axyon-commands')
const access = require('./access')
const dashAuth = require('./dash-auth')
const store = require('./axyon-store')

const PUBLIC = path.join(__dirname, '..', 'public')
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' }

function json (res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(data))
}
function safeEqual (a, b) {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
function cookies (req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split(/=(.*)/s)).filter(x => x[0]).map(([k, v]) => [k, decodeURIComponent(v || '')]))
}
async function body (req, max = 16384) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw Object.assign(Error('Request too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(Error('Invalid JSON'), { status: 400 }) }
}

async function multipart (req, max = 8 * 1024 * 1024 + 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw Object.assign(Error('Image is too large. Maximum size is 8 MB.'), { status: 413 })
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks)
  const type = String(req.headers['content-type'] || '')
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!/^multipart\/form-data/i.test(type) || !boundary) throw Object.assign(Error('Expected an image upload.'), { status: 400 })
  const marker = Buffer.from(`--${(boundary[1] || boundary[2]).trim()}`)
  const fields = {}
  let pos = 0
  while ((pos = raw.indexOf(marker, pos)) !== -1) {
    pos += marker.length
    if (raw[pos] === 45 && raw[pos + 1] === 45) break
    if (raw[pos] === 13 && raw[pos + 1] === 10) pos += 2
    const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'), pos)
    if (headerEnd < 0) break
    const headers = raw.subarray(pos, headerEnd).toString('utf8')
    const next = raw.indexOf(marker, headerEnd + 4)
    if (next < 0) break
    let end = next
    if (raw[end - 2] === 13 && raw[end - 1] === 10) end -= 2
    const disposition = headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i)
    if (disposition) {
      const name = disposition[1]
      const data = raw.subarray(headerEnd + 4, end)
      const mime = (headers.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || ''
      fields[name] = disposition[2] !== undefined ? { data: Buffer.from(data), mime: mime.trim(), filename: disposition[2] } : data.toString('utf8')
    }
    pos = next
  }
  return fields
}

function imageMime (data) {
  if (!Buffer.isBuffer(data)) return ''
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return 'image/gif'
  return ''
}

function maskPhone (value) {
  const x = String(value || '').split(':')[0].split('@')[0].replace(/\D/g, '')
  return x.length > 7 ? `+${x.slice(0, 3)} ••• ••${x.slice(-4)}` : x ? 'Connected account' : 'Not available'
}
function formatPairingCode (value) {
  const raw = String(value || '').replace(/[^a-z0-9]/gi, '')
  return raw.match(/.{1,4}/g)?.join('-') || raw
}

/*
 * Which permission each admin action needs.
 *
 * Anything that can log an account out, reveal a number, or change who holds
 * authority is admin-only. Moderation of game content is rhm and up.
 */
const ACTION_PERMISSION = {
  'group-enable': 'groups.write',
  'group-disable': 'groups.write',
  'group-remove': 'groups.write',
  'group-prefix': 'groups.write',
  'player-reset': 'players.write',
  'player-zen': 'players.write',
  'player-heal': 'players.write',
  'player-clear-battle': 'players.write',
  'player-grant-item': 'players.write',
  'player-grant-ability': 'players.write',
  settings: 'settings.write',
  'stage-add': 'stages.write',
  'stage-edit': 'stages.write',
  'stage-lock': 'stages.write',
  'stage-remove': 'stages.write',
  'floor-add': 'floors.write',
  'floor-edit': 'floors.write',
  'floor-lock': 'floors.write',
  'floor-remove': 'floors.write',
  mode: 'modes.write',
  'visual-set': 'visuals.write',
  'visual-remove': 'visuals.write',
  'role-add': 'authority.write',
  'role-remove': 'authority.write',
  'number-add': 'authority.write',
  'number-remove': 'authority.write'
}

function createDashboard ({ sessions, database, lease, logger }) {
  const failures = new Map()
  const hours = Math.max(1, Math.min(720, Number(process.env.DASHBOARD_SESSION_HOURS) || 720))
  const axyonAdmin = createAxyonAdmin({ logger })

  /* The command registry, so the site's help screen can never drift from what
   * the bot actually answers to. Built once, read-only. */
  const commandIndex = (() => {
    try {
      const axyon = createAxyon({ logger })
      createCommands({ axyon, logger })
      return axyon.COMMANDS.filter(c => !c.hidden).map(c => ({ name: c.name, section: c.section, usage: c.usage.replace(/\{p\}/g, '!'), desc: c.desc }))
    } catch (e) { logger.warn({ err: e }, 'command index unavailable'); return [] }
  })()

  function pruneFailures () {
    const now = Date.now()
    for (const [ip, s] of failures) if (now - s.startedAt > 10 * 60 * 1000) failures.delete(ip)
  }

  /** The session for this request, or null. */
  async function session (req) {
    const token = cookies(req).architect_session || String(req.headers['x-architect-token'] || '')
    if (!token) return null
    const s = await dashAuth.session(token).catch(() => null)
    return s ? { ...s, token } : null
  }

  /**
   * Gate. Returns the session, or writes the refusal and returns null.
   * `permission` is checked against the role the session carries.
   */
  async function requireAuth (req, res, permission = null, csrf = false) {
    const s = await session(req)
    if (!s) { json(res, 401, { ok: false, error: 'Sign in required' }); return null }
    if (permission && !access.can(s.role, permission)) {
      json(res, 403, { ok: false, error: `Your level (${s.role}) cannot do that.` })
      return null
    }
    if (csrf && !safeEqual(req.headers['x-architect-csrf'], s.csrf)) {
      json(res, 403, { ok: false, error: 'Security token mismatch. Refresh the dashboard.' })
      return null
    }
    return s
  }

  /*
   * THE PAGE
   * --------
   * The HTML is rendered with a content hash appended to every asset URL
   * (`/dashboard/app.js?v=ab12cd`). A deploy therefore changes the URL, so a
   * browser that cached the previous build cannot keep serving it.
   */
  async function page (req, res) {
    try {
      let html = await fs.readFile(path.join(PUBLIC, 'dashboard.html'), 'utf8')
      const FILES = { 'app.js': 'dashboard.js', 'app.css': 'dashboard.css', 'admin.js': 'admin.js', 'admin.css': 'admin.css', 'controls.css': 'controls.css' }
      const names = [...new Set([...html.matchAll(/\/dashboard\/([a-z]+\.(?:js|css))/g)].map(m => m[1]))]
      for (const name of names) {
        const file = FILES[name] || name
        const data = await fs.readFile(path.join(PUBLIC, file))
        const v = crypto.createHash('sha1').update(data).digest('hex').slice(0, 10)
        html = html.split(`/dashboard/${name}`).join(`/dashboard/${name}?v=${v}`)
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(html)
    } catch { res.writeHead(404).end('Not found') }
  }

  /*
   * STATIC ASSETS
   * -------------
   * Every asset carries a strong ETag derived from its bytes and is served
   * `no-cache, must-revalidate`: the browser revalidates on each load and gets
   * a cheap 304 when nothing changed, and the new file the moment it does.
   */
  async function asset (req, res, name) {
    const file = path.join(PUBLIC, name)
    try {
      const data = await fs.readFile(file)
      const etag = '"' + crypto.createHash('sha1').update(data).digest('base64url').slice(0, 27) + '"'
      const headers = { 'content-type': MIME[path.extname(name)] || 'application/octet-stream', 'cache-control': 'no-cache, must-revalidate', etag, 'x-content-type-options': 'nosniff' }
      if (String(req.headers['if-none-match'] || '') === etag) { res.writeHead(304, headers); res.end(); return }
      res.writeHead(200, headers); res.end(data)
    } catch { res.writeHead(404).end('Not found') }
  }

  async function stats () {
    const d = database()
    if (!d) return { database: false, registeredUsers: 0 }
    try {
      const q = await d.query('SELECT COUNT(*)::int AS registered_users FROM axyon_players')
      return { database: true, registeredUsers: q.rows[0]?.registered_users || 0 }
    } catch (e) { logger.warn({ err: e }, 'Architect dashboard stats failed'); return { database: false, registeredUsers: 0 } }
  }

  /**
   * Sends a login code to a number over WhatsApp.
   *
   * It goes through the connected account's own socket, so the message arrives
   * from the bot the person already talks to — not from a random number. If no
   * account is connected the login cannot proceed, and that is reported
   * honestly rather than pretending a code was sent.
   */
  async function sendCode (phone, code) {
    const conn = sessions.list().find(c => c.state === 'connected')
    const live = conn ? sessions.get(conn.sessionId) : null
    if (!live?.sock) return { ok: false, message: 'No WhatsApp account is connected, so the code cannot be sent. Ask an admin to reconnect the bot.' }
    const jid = `${phone}@s.whatsapp.net`
    const text = [
      '⌘ *AXYON CORE*',
      '',
      '🔐 *DASHBOARD LOGIN*',
      '',
      `Your code is ${code}`,
      '',
      'It expires in 10 minutes and works once.',
      'If you did not ask for this, ignore it — nobody can sign in without this code.'
    ].join('\n')
    try {
      await live.sock.sendMessage(jid, { text })
      return { ok: true }
    } catch (e) {
      logger.warn({ err: e?.message }, 'login code send failed')
      return { ok: false, message: 'The code could not be delivered. Check that the number has WhatsApp and try again.' }
    }
  }

  async function handle (req, res) {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/dashboard')) return false
    try {
      /* ---------------------------------------------------------- assets */
      if (req.method === 'GET' && ['/dashboard', '/dashboard/'].includes(url.pathname)) { await page(req, res); return true }
      if (req.method === 'GET' && url.pathname === '/dashboard/app.css') { await asset(req, res, 'dashboard.css'); return true }
      if (req.method === 'GET' && url.pathname === '/dashboard/controls.css') { await asset(req, res, 'controls.css'); return true }
      if (req.method === 'GET' && url.pathname === '/dashboard/app.js') { await asset(req, res, 'dashboard.js'); return true }
      if (req.method === 'GET' && url.pathname === '/dashboard/admin.js') { await asset(req, res, 'admin.js'); return true }
      if (req.method === 'GET' && url.pathname === '/dashboard/admin.css') { await asset(req, res, 'admin.css'); return true }

      /* ----------------------------------------------------------- login */
      if (req.method === 'GET' && url.pathname === '/dashboard/api/session') {
        const s = await session(req)
        if (!s) { json(res, 200, { ok: true, authenticated: false }); return true }
        json(res, 200, {
          ok: true,
          authenticated: true,
          role: s.role,
          phone: maskPhone(s.phone),
          csrf: s.csrf,
          permissions: access.permissionsOf(s.role)
        })
        return true
      }

      if (req.method === 'POST' && url.pathname === '/dashboard/api/login/request') {
        pruneFailures()
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim()
        const f = failures.get(ip) || { count: 0, startedAt: Date.now() }
        if (f.count >= 8 && Date.now() - f.startedAt < 10 * 60 * 1000) {
          json(res, 429, { ok: false, error: 'Too many attempts. Try again later.' })
          return true
        }
        const input = await body(req)
        const issued = await dashAuth.issueCode(input.phone)
        if (!issued.ok) {
          f.count++; failures.set(ip, f)
          json(res, 400, { ok: false, error: issued.message, retryAfterMs: issued.retryAfterMs || 0 })
          return true
        }
        const sent = await sendCode(issued.phone, issued.code)
        if (!sent.ok) { json(res, 503, { ok: false, error: sent.message }); return true }
        failures.delete(ip)
        /* The code is deliberately absent from this response. */
        json(res, 200, { ok: true, message: `A code was sent to ${maskPhone(issued.phone)} on WhatsApp.` })
        return true
      }

      if (req.method === 'POST' && url.pathname === '/dashboard/api/login/verify') {
        const input = await body(req)
        const r = await dashAuth.verifyCode(input.phone, input.code)
        if (!r.ok) { json(res, 401, { ok: false, error: r.message }); return true }
        const maxAge = Math.floor(hours * 3600)
        json(res, 200, {
          ok: true,
          token: r.token,
          csrf: r.csrf,
          role: r.role,
          phone: maskPhone(r.phone),
          permissions: access.permissionsOf(r.role)
        }, {
          'set-cookie': `architect_session=${r.token}; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
        })
        return true
      }

      if (req.method === 'POST' && url.pathname === '/dashboard/api/logout') {
        const s = await session(req)
        if (s) await dashAuth.endSession(s.token).catch(() => {})
        json(res, 200, { ok: true }, { 'set-cookie': 'architect_session=; Path=/dashboard; HttpOnly; Secure; SameSite=Lax; Max-Age=0' })
        return true
      }

      /* -------------------------------------------------------- feedback */
      /*
       * PUBLIC BY DESIGN. No session, no identity. The thread id is a random
       * value the browser makes per tab; the server never links it to a person.
       */
      if (req.method === 'POST' && url.pathname === '/dashboard/api/feedback') {
        const input = await body(req, 8192)
        const r = await dashAuth.addFeedback(input.thread, input.body)
        json(res, r.ok ? 200 : 400, r)
        return true
      }
      if (req.method === 'GET' && url.pathname === '/dashboard/api/feedback/thread') {
        const rows = await dashAuth.feedbackThread(url.searchParams.get('thread'))
        json(res, 200, { ok: true, messages: rows })
        return true
      }
      if (req.method === 'GET' && url.pathname === '/dashboard/api/feedback/inbox') {
        if (!await requireAuth(req, res, 'feedback.read')) return true
        json(res, 200, { ok: true, threads: await dashAuth.feedbackInbox(80) })
        return true
      }
      if (req.method === 'POST' && url.pathname === '/dashboard/api/feedback/reply') {
        if (!await requireAuth(req, res, 'feedback.reply', true)) return true
        const input = await body(req, 8192)
        const r = await dashAuth.addFeedback(input.thread, input.body, { fromStaff: true })
        json(res, r.ok ? 200 : 400, r)
        return true
      }

      /* --------------------------------------------------------- overview */
      if (req.method === 'GET' && url.pathname === '/dashboard/api/overview') {
        const s = await requireAuth(req, res, 'overview.read')
        if (!s) return true
        const state = sessions.status()
        const accounts = state.accounts.map(wa => ({ ...wa, phone: maskPhone(wa.phone) }))
        const primary = accounts.find(x => x.sessionId === state.primary?.sessionId) || accounts[0] || { state: 'not-paired', phone: 'Not available', storage: 'unknown', uptimeSec: 0, messagesHandled: 0 }
        json(res, 200, {
          ok: true,
          csrf: s.csrf,
          role: s.role,
          permissions: access.permissionsOf(s.role),
          instance: lease.status(),
          whatsapp: primary,
          accounts,
          accountSummary: { connected: state.connected, total: state.total },
          stats: await stats()
        })
        return true
      }

      /* ------------------------------------------------------------ admin */
      if (req.method === 'GET' && url.pathname === '/dashboard/api/admin') {
        const s = await requireAuth(req, res, 'stages.read')
        if (!s) return true
        const snap = await axyonAdmin.snapshot()
        json(res, 200, { ok: true, csrf: s.csrf, role: s.role, permissions: access.permissionsOf(s.role), ...filterSnapshot(snap, s.role) })
        return true
      }

      if (req.method === 'POST' && url.pathname === '/dashboard/api/visual-upload') {
        const s = await requireAuth(req, res, 'visuals.write', true)
        if (!s) return true
        const fields = await multipart(req)
        const mode = String(fields.mode || '').trim().toLowerCase()
        const caption = String(fields.caption || '').trim()
        const file = fields.image
        if (!['arise', 'profile', 'battle', 'boss', 'dungeon', 'duel'].includes(mode)) { json(res, 400, { ok: false, error: 'Choose a valid visual type.' }); return true }
        if (!file?.data?.length) { json(res, 400, { ok: false, error: 'Choose an image from your phone first.' }); return true }
        const mime = imageMime(file.data)
        if (!mime) { json(res, 400, { ok: false, error: 'Unsupported image. Use JPG, PNG, WEBP or GIF.' }); return true }
        if (file.data.length > 8 * 1024 * 1024) { json(res, 413, { ok: false, error: 'Image is too large. Maximum size is 8 MB.' }); return true }
        await store.setVisualImage(mode, file.data, mime, caption)
        await store.log('dashboard', 'admin_visual_upload', mode, { mime, bytes: file.data.length })
        json(res, 200, { ok: true, message: `Image uploaded for ${mode}.` })
        return true
      }

      if (req.method === 'POST' && url.pathname === '/dashboard/api/admin/action') {
        const input = await body(req, 65536)
        const action = String(input.action || '')
        const permission = ACTION_PERMISSION[action]
        if (!permission) { json(res, 400, { ok: false, error: `Unknown action: ${action}` }); return true }
        if (!await requireAuth(req, res, permission, true)) return true
        const result = await axyonAdmin.act(action, input)
        json(res, result.ok ? 200 : 400, result)
        return true
      }

      if (req.method === 'GET' && url.pathname === '/dashboard/api/commands') {
        if (!await requireAuth(req, res, 'commands.read')) return true
        json(res, 200, { ok: true, commands: commandIndex })
        return true
      }

      /* --------------------------------------------------------- controls */
      if (req.method === 'POST' && url.pathname.startsWith('/dashboard/api/actions/')) {
        const action = url.pathname.split('/').pop()
        /* Every one of these touches a live WhatsApp session: admin only. */
        if (!await requireAuth(req, res, 'overview.control', true)) return true
        if (!lease.status().owned) { json(res, 409, { ok: false, error: 'This deployment is in standby. Take control first.' }); return true }
        const input = await body(req)
        if (action === 'takeover') { await lease.forceTakeover(); json(res, 200, { ok: true, message: 'Control claimed.' }); return true }
        if (action === 'reconnect') { await sessions.reconnect(input.sessionId || sessions.status().primary?.sessionId); json(res, 200, { ok: true, message: 'Reconnect started' }); return true }
        if (action === 'pause') { const wa = sessions.setPaused(input.sessionId || sessions.status().primary?.sessionId, !!input.paused); json(res, 200, { ok: true, paused: wa.paused }); return true }
        if (action === 'pair') { const result = await sessions.pair(input.phone, input.label || 'Architect Instance', input.accountType || 'primary'); json(res, 200, { ok: true, sessionId: result.id, accountType: result.accountType, code: formatPairingCode(result.code) }); return true }
        if (action === 'remove') { if (input.confirm !== 'REMOVE') { json(res, 400, { ok: false, error: 'Type REMOVE to confirm.' }); return true } await sessions.remove(input.sessionId); json(res, 200, { ok: true }); return true }
        if (action === 'remove-all') { if (input.confirm !== 'REMOVE ALL') { json(res, 400, { ok: false, error: 'Type REMOVE ALL to confirm.' }); return true } const result = await sessions.resetAll(); json(res, 200, { ok: true, removed: result.removed, message: 'All sessions removed. Pair Architect again.' }); return true }
      }

      json(res, 404, { ok: false, error: 'Dashboard route not found' })
      return true
    } catch (e) {
      logger.error({ err: e, path: url.pathname }, 'Dashboard request failed')
      json(res, e.status || 500, { ok: false, error: e.status ? e.message : 'Dashboard request failed' })
      return true
    }
  }

  /**
   * Strips anything the role may not see.
   *
   * A guest gets the game catalogue and nothing else: no groups, no players,
   * no roles, no numbers, no audit log, no settings. An rhm gets moderation
   * data but not the authority lists or the economy settings.
   */
  function filterSnapshot (snap, role) {
    const out = { ...snap }
    if (!access.can(role, 'groups.read')) out.groups = []
    if (!access.can(role, 'players.read')) out.players = []
    if (!access.can(role, 'authority.read')) { out.roles = []; out.numbers = [] }
    if (!access.can(role, 'log.read')) out.log = []
    if (!access.can(role, 'settings.read')) out.settings = { prefix: snap.settings?.prefix, watermark: snap.settings?.watermark }
    if (!access.can(role, 'shop.read')) out.catalogue = []
    return out
  }

  return { handle, _test: { safeEqual, maskPhone, formatPairingCode, filterSnapshot, ACTION_PERMISSION } }
}

module.exports = { createDashboard, _test: { safeEqual, maskPhone, formatPairingCode, multipart, imageMime } }
