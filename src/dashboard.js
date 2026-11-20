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
const cardSpawner = require('./card-spawn')
const cardStore = require('./axyon-store')

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
      const FILES = { 'app.js': 'dashboard.js', 'app.css': 'dashboard.css', 'admin.js': 'admin.js', 'admin.css': 'admin.css', 'controls.css': 'controls.css', 'card-studio.js': 'card-studio.js' }
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

  async function ensureCardStudioSchema () {
    const d = database()
    if (!d) throw Object.assign(Error('DATABASE_URL is required'), { status: 503 })
    await d.query(`CREATE TABLE IF NOT EXISTS axyon_card_studio (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, card_data JSONB NOT NULL,
      artwork_url TEXT NOT NULL DEFAULT '', image_data BYTEA NOT NULL,
      rendered_data BYTEA NOT NULL, created_by TEXT NOT NULL DEFAULT '',
      claim_code TEXT UNIQUE, claim_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), spawned_at TIMESTAMPTZ
    )`)
    await d.query('ALTER TABLE axyon_card_studio ADD COLUMN IF NOT EXISTS claim_code TEXT UNIQUE')
    await d.query('ALTER TABLE axyon_card_studio ADD COLUMN IF NOT EXISTS claim_count INT NOT NULL DEFAULT 0')
    await d.query(`CREATE TABLE IF NOT EXISTS axyon_card_studio_claims (card_id BIGINT NOT NULL REFERENCES axyon_card_studio(id) ON DELETE CASCADE, user_id TEXT NOT NULL, claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(card_id,user_id))`)
    return d
  }
  function normalizeStudioInput (input) {
    const clean = (v, max = 180) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
    const n = (v, min, max, fallback = 0) => Math.max(min, Math.min(max, Number.isFinite(Number(v)) ? Number(v) : fallback))
    const abilities = Array.isArray(input.abilities) ? input.abilities.slice(0, 12).map(x => ({ name: clean(x.name, 80), damage: n(x.damage, 0, 100000) })).filter(x => x.name) : []
    const weapons = Array.isArray(input.weapons) ? input.weapons.slice(0, 8).map(x => ({ name: clean(x.name, 80), damage: n(x.damage, 0, 100000) })).filter(x => x.name) : []
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw Object.assign(Error('Invalid expiry date'), { status: 400 })
    const imageUrl = clean(input.imageUrl, 2048)
    const imageData = input.imageData ? Buffer.from(String(input.imageData).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, ''), 'base64') : null
    if (imageData && (imageData.length > 8 * 1024 * 1024 || !['89504e47','ffd8ff','47494638','52494646'].some(sig => imageData.subarray(0,4).toString('hex').startsWith(sig)))) throw Object.assign(Error('Upload a valid PNG, JPEG, GIF or WebP image under 8 MB.'), { status: 400 })
    if (!imageData && !/^https:\/\//i.test(imageUrl)) throw Object.assign(Error('Choose an artwork file or enter a direct HTTPS image URL.'), { status: 400 })
    const name = clean(input.name, 100)
    if (!name) throw Object.assign(Error('Character name is required.'), { status: 400 })
    return {
      name, version: clean(input.version, 100), arc: clean(input.arc, 100), cardType: clean(input.cardType || 'character', 20).toLowerCase() === 'weapon' ? 'weapon' : 'character',
      renderer: ['old-gen', 'ai-custom'].includes(String(input.renderer || 'old-gen')) ? String(input.renderer || 'old-gen') : 'old-gen',
      rarity: n(input.rarity, 1, 6, 3), percentRating: n(input.percentRating, 0, 100, 50), starRating: n(input.starRating, 0, 10, 5),
      baseDamage: n(input.baseDamage, 0, 100000), abilities, weapons, coin: n(input.coin, 0, 100000000), zen: n(input.zen, 0, 100000000),
      claimLimit: n(input.claimLimit, 1, 100000, 30), expiresAt: expiresAt ? expiresAt.toISOString() : null, imageUrl, imageData: imageData ? imageData.toString('base64') : null
    }
  }
  async function renderStudioCard (data) {
    const art = data.imageData ? Buffer.from(data.imageData, 'base64') : await cardSpawner.artwork.fetchBuffer(data.imageUrl)
    const rendererEntry = cardSpawner.renderers.find(x => x.key === data.renderer) || cardSpawner.renderers[0]
    const renderer = rendererEntry.render
    const card = {
      name: data.name, series: [data.version, data.arc].filter(Boolean).join(' • ') || 'AXYON CUSTOM CARD', card_type: data.cardType,
      weapon: data.weapons.map(x => x.name).join(', ') || '—', damage: data.baseDamage,
      ability: data.abilities.map(x => x.name).join(', ') || '—',
      ability_damage: data.abilities.reduce((sum, x) => sum + x.damage, 0), rating: data.rarity,
      percent_rating: data.percentRating, star_rating: data.starRating, expires_at: data.expiresAt
    }
    const rendered = await renderer.render(card, art)
    if (!rendered?.buffer) throw Error(`The ${rendererEntry.label || rendererEntry.key} renderer could not render this artwork.`)
    return { art, rendered }
  }
  function studioCaption (d, claim = 0) {
    const date = d.expiresAt ? new Date(d.expiresAt).toISOString().slice(0, 10) : 'Never'
    const abilities = d.abilities.length ? d.abilities.map(x => `${x.name} : ${x.damage}`).join('\n') : '—'
    const weapons = d.weapons.length ? d.weapons.map(x => `${x.name} : ${x.damage}`).join('\n') : '—'
    return ['*AXYN CORE - Lil Clutch & Montai*','*CARD CODE*','',`Name : ${d.name}`,`Version : ${d.version || '—'}`,`Arc : ${d.arc || '—'}`,`Ability : ${d.abilities.map(x => x.name).join(' , ') || '—'}`,`Weapon : ${d.weapons.map(x => x.name).join(' , ') || '—'}`,'','*Ability damage*',abilities,'','*Weapon damage*',weapons,'',`Rating : ${d.percentRating}/100`,`Star Rating : ${d.starRating}/10`,'*Price*',`Coin : ${d.coin}`,`Zen : ${d.zen}`,'',`Claim : ${claim} / ${d.claimLimit}`,`Expires date : ${date}`].join('\n')
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
      if (req.method === 'GET' && url.pathname === '/dashboard/card-studio.js') { await asset(req, res, 'card-studio.js'); return true }

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

      /* ------------------------------------------------------ card studio */
      if (url.pathname.startsWith('/dashboard/api/card-studio')) {
        const s = await requireAuth(req, res, 'overview.control', req.method !== 'GET')
        if (!s) return true
        const d = await ensureCardStudioSchema()
        if (req.method === 'POST' && url.pathname === '/dashboard/api/card-studio/complete') {
          const input = await body(req, 12 * 1024 * 1024)
          const fields = input.fields || {}
          const missing = ['name','version','arc','baseDamage','abilities','weapons','coin','zen','percentRating','starRating','rarity'].filter(k => fields[k] == null || fields[k] === '' || (Array.isArray(fields[k]) && !fields[k].length))
          if (!missing.length) { json(res, 200, { ok: true, fields: {} }); return true }
          // Character completion is search-assisted and does not depend on a paid LLM.
          // SerpApi is already configured for the Pinterest card-artwork workflow.
          const apiKey = String(process.env.SERPAPI_API_KEY || '').trim()
          if (!apiKey) { json(res, 503, { ok:false, error:'SERPAPI_API_KEY is missing. Add the same SerpApi key used by card artwork search in Render.' }); return true }
          if (!String(fields.name || '').trim()) { json(res, 400, { ok:false, error:'Enter the character name first so Axyon can look up the correct character.' }); return true }
          const query = [fields.name, fields.version, fields.arc, 'anime character profile abilities powers techniques'].filter(Boolean).join(' ')
          const params = new URLSearchParams({ engine:'google', q:query, num:'8', api_key:apiKey })
          const lookup = await fetch(`https://serpapi.com/search.json?${params}`, { headers:{Accept:'application/json'}, signal:AbortSignal.timeout(20000) })
          if (!lookup.ok) throw Object.assign(Error(`Character lookup failed (${lookup.status}).`), {status:502})
          const search = await lookup.json()
          if (search.error) throw Object.assign(Error(`Character lookup failed: ${String(search.error).slice(0,180)}`), {status:502})
          const snippets = (search.organic_results || []).slice(0,8).map(x => `${x.title || ''}. ${x.snippet || ''}`).join(' ')
          let artworkUrl = ''
          if (!fields.imageUrl && !fields.imageData) {
            // Use the same SerpApi credential to find artwork from the character
            // name/version/arc; the existing card renderer still handles rendering.
            const imageParams = new URLSearchParams({ engine:'google_images', q:`${query} official anime character artwork portrait`, num:'10', api_key:apiKey })
            const imageLookup = await fetch(`https://serpapi.com/search.json?${imageParams}`, { headers:{Accept:'application/json'}, signal:AbortSignal.timeout(20000) })
            if (imageLookup.ok) {
              const imageSearch = await imageLookup.json()
              const candidate = (imageSearch.images_results || []).find(x => /^https:\/\//i.test(String(x.original || '')))
              if (candidate) artworkUrl = candidate.original
            }
          }
          if (!snippets.trim()) throw Object.assign(Error(`No useful character information found for ${fields.name}. Try adding a more specific version or arc.`), {status:404})
          const safe = {}
          if (artworkUrl) safe.imageUrl = artworkUrl
          // Only supply missing identity metadata from search context. Game balance
          // values are deterministic estimates, not claims about canonical power levels.
          if (missing.includes('version') && fields.version) safe.version = fields.version
          if (missing.includes('arc') && fields.arc) safe.arc = fields.arc
          const abilityCandidates = [...new Set((snippets.match(/\b[A-Z][A-Za-z'-]{2,}(?:\s+[A-Z][A-Za-z'-]{2,}){0,2}(?=\s+(?:is|was|are|uses|used|can|technique|ability|attack|power))/g) || []).filter(x => !/^(The|This|That|They|Anime|Character|Series|Story)$/i.test(x)))].slice(0,3)
          const scale = Math.max(1, Math.min(6, Number(fields.rarity) || 3))
          if (missing.includes('abilities')) safe.abilities = abilityCandidates.map((name,i) => ({name,damage:10 + scale * 3 + i * 2}))
          if (missing.includes('weapons')) safe.weapons = []
          if (missing.includes('baseDamage')) safe.baseDamage = 15 + scale * 5
          if (missing.includes('percentRating')) safe.percentRating = Math.min(99, 55 + scale * 7)
          if (missing.includes('starRating')) safe.starRating = Math.min(10, Math.round((55 + scale * 7) / 10))
          if (missing.includes('coin')) safe.coin = 500 * scale
          if (missing.includes('zen')) safe.zen = 5000 * scale
          if (missing.includes('rarity')) safe.rarity = scale
          json(res, 200, { ok:true, fields:safe, source:'SerpApi character and artwork search', note: artworkUrl ? 'Character details and artwork were found with SerpApi; damage, ratings and prices are Axyon game-balance estimates.' : 'Character details were search-assisted. No suitable artwork URL was found, so choose artwork manually. Damage, ratings and prices are Axyon game-balance estimates.' }); return true
        }
        if (req.method === 'POST' && url.pathname === '/dashboard/api/card-studio/preview') {
          const input = normalizeStudioInput(await body(req, 12 * 1024 * 1024))
          const { rendered } = await renderStudioCard(input)
          json(res, 200, { ok: true, preview: rendered.buffer.toString('base64'), caption: studioCaption(input) })
          return true
        }
        if (req.method === 'POST' && url.pathname === '/dashboard/api/card-studio/save') {
          const input = normalizeStudioInput(await body(req, 12 * 1024 * 1024))
          const { art, rendered } = await renderStudioCard(input)
          const saved = await d.query(`INSERT INTO axyon_card_studio(name,card_data,artwork_url,image_data,rendered_data,created_by)
            VALUES($1,$2::jsonb,$3,$4,$5,$6) RETURNING id, name, created_at`,
            [input.name, JSON.stringify(input), input.imageUrl || '', art, rendered.buffer, String(s.phone || '')])
          json(res, 200, { ok: true, card: saved.rows[0] })
          return true
        }
        if (req.method === 'GET' && url.pathname === '/dashboard/api/card-studio/list') {
          const rows = await d.query('SELECT id,name,created_at,spawned_at,claim_code,claim_count, (card_data->>\'claimLimit\')::int AS claim_limit FROM axyon_card_studio ORDER BY id DESC LIMIT 50')
          json(res, 200, { ok: true, cards: rows.rows })
          return true
        }
        if (req.method === 'GET' && url.pathname === '/dashboard/api/card-studio/groups') {
          const state = sessions.status()
          const live = sessions.get(state.primary?.sessionId)
          if (!live?.sock || live.state !== 'connected') { json(res, 503, {ok:false,error:'Primary WhatsApp session is not connected.'}); return true }
          const [participating, registered] = await Promise.all([
            live.sock.groupFetchAllParticipating(),
            cardStore.groups()
          ])
          const rows = registered
            .filter(g => g.status === 'ACTIVE' && g.enabled !== false && participating?.[g.group_jid])
            .map(g => ({ jid: g.group_jid, name: String(g.name || participating[g.group_jid]?.subject || g.group_jid) }))
            .sort((a,b) => a.name.localeCompare(b.name))
          json(res,200,{ok:true,groups:rows}); return true
        }
        if (req.method === 'POST' && url.pathname === '/dashboard/api/card-studio/spawn') {
          const input = await body(req)
          const jid = String(input.groupJid || '').trim()
          if (!/^\d{5,30}(?:-\d{5,25})?@g\.us$/.test(jid)) { json(res, 400, { ok: false, error: 'Select a registered WhatsApp group.' }); return true }
          const registeredGroups = await cardStore.groups()
          const registeredGroup = registeredGroups.find(g => g.group_jid === jid && g.status === 'ACTIVE' && g.enabled !== false)
          if (!registeredGroup) { json(res, 403, { ok:false, error:'That group is not actively registered with AXYON CORE.' }); return true }
          if (!lease.status().owned) { json(res, 409, { ok: false, error: 'This deployment is in standby. Take control first.' }); return true }
          const result = await d.query('SELECT * FROM axyon_card_studio WHERE id=$1', [Number(input.id)])
          const saved = result.rows[0]
          if (!saved) { json(res, 404, { ok: false, error: 'Saved card not found.' }); return true }
          const state = sessions.status()
          const live = sessions.get(state.primary?.sessionId)
          if (!live?.sock || live.state !== 'connected') { json(res, 503, { ok: false, error: 'Primary WhatsApp session is not connected.' }); return true }
          const participating = await live.sock.groupFetchAllParticipating()
          if (!participating?.[jid]) { json(res, 409, {ok:false,error:'The registered group is not available in the connected WhatsApp session. Refresh groups or reconnect the session.'}); return true }
          const data = saved.card_data
          const code = saved.claim_code || crypto.randomBytes(3).toString('hex').toUpperCase()
          const caption = `${studioCaption(data, saved.claim_count || 0)}\n\nClaim with *!claim card #${code}*`
          const image = Buffer.isBuffer(saved.rendered_data) ? saved.rendered_data : Buffer.from(saved.rendered_data || [])
          if (!image.length) { json(res, 500, {ok:false,error:'Saved card image is missing. Re-render and save this card.'}); return true }
          // Mark as spawned only after WhatsApp accepts the send request.
          try { await live.sock.sendMessage(jid, { image, caption }) } catch (sendError) {
            logger.error({ err: sendError, groupJid: jid, cardId: saved.id }, 'Card Studio WhatsApp send failed')
            json(res, 502, {ok:false,error:`WhatsApp rejected the card send: ${String(sendError?.message || 'unknown send error').slice(0,240)}`}); return true
          }
          await d.query('UPDATE axyon_card_studio SET spawned_at=NOW(),claim_code=COALESCE(claim_code,$2) WHERE id=$1', [saved.id, code])
          json(res, 200, { ok: true, message: 'Card image and complete card code sent to WhatsApp.' })
          return true
        }
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

module.exports = { createDashboard, _test: { safeEqual, maskPhone, formatPairingCode } }
