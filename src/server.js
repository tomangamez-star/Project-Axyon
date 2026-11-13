'use strict'
/*
 * ARCHITECT — WhatsApp entry point.
 *
 * WHAT CHANGED FROM THE OLD BUILD
 * -------------------------------
 * The old server mounted a whole second bot underneath this one: a casino, a
 * wallet, an "Odyssey" RPG, cards, duels, music, zones, a cursed-sticker
 * handler and a six-button menu tree. Every one of those had its own command
 * prefix (`/`), its own registration gate (`/start`) and its own button ids.
 * That is why the bot "still behaved like the old setup": the legacy router
 * ran first and answered with legacy copy.
 *
 * All of it is gone. This file now has exactly one command system — AXYON,
 * prefix `!`, registration `!arise` — and one message path. There is no
 * fallback router, so nothing from the old build is reachable.
 *
 * What is kept: pairing, the multi-account session manager, the instance
 * lease, the dashboard, and the output guard that keeps WhatsApp from
 * rate-limiting the account.
 */
const http = require('http')
const pino = require('pino')
const { createAuthState, clearAuthState, listAuthSessions, closeAuthStore, pingDatabase, database } = require('./auth-store')
const { createDashboard } = require('./dashboard')
const { createInstanceLease } = require('./instance-lease')
const { createAxyon } = require('./axyon-rpg')
const { createCommands } = require('./axyon-commands')
const { resolveMessageUserId } = require('./identity')
const { shouldHandleUpsert, resolveButtonId, ReplyRateLimiter } = require('./message-guard')
const accountConfig = require('./account-config')

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })
const port = Number(process.env.PORT || 3000)

const axyon = createAxyon({
  logger,
  sendButtons: (s, j, b, f, d, o) => s.__sendNativeButtons?.(s, j, b, f, d, o)
})
const axyonCommands = createCommands({ axyon, logger })

/* ------------------------------------------------------------------ output */

/**
 * Keeps the account safe from WhatsApp's burst limits. Unchanged in spirit
 * from the previous build — it was the one piece of the old server that was
 * doing real work.
 */
class GlobalOutputGuard {
  constructor (logger) {
    this.logger = logger
    this.recent = []
    this.queue = []
    this.cooling = false
    this.draining = false
    this.timer = null
    this.rawSend = null
    this.windowMs = 1500
    this.maxBurst = 3
    this.minCooldown = 5000
    this.maxCooldown = 10000
    this.spacing = 650
    this.noticeJid = null
    this.noticeText = ''
  }

  setRawSend (fn) { this.rawSend = fn }
  setNoticeText (v) { this.noticeText = String(v || '').trim() }

  async run (jid, fn) {
    const now = Date.now()
    this.recent = this.recent.filter(t => now - t <= this.windowMs)
    if (this.cooling || this.draining) {
      return new Promise((resolve, reject) => this.queue.push({ jid, fn, resolve, reject }))
    }
    if (this.recent.length >= this.maxBurst) {
      this.cooling = true
      this.noticeJid = jid
      const wait = this.minCooldown + Math.floor(Math.random() * (this.maxCooldown - this.minCooldown + 1))
      this.logger.warn({ waitMs: wait, queued: this.queue.length + 1 }, 'WhatsApp output cooldown started')
      const promise = new Promise((resolve, reject) => this.queue.push({ jid, fn, resolve, reject }))
      this.timer = setTimeout(() => void this.resume(), wait)
      return promise
    }
    this.recent.push(now)
    return fn()
  }

  async resume () {
    this.cooling = false
    this.recent = []
    if (this.rawSend && this.noticeJid && this.noticeText) {
      await this.rawSend(this.noticeJid, { text: this.noticeText }).catch(() => {})
    }
    this.noticeJid = null
    this.draining = true
    if (this.queue.length) await new Promise(r => setTimeout(r, this.spacing))
    while (this.queue.length) {
      const q = this.queue.shift()
      try { q.resolve(await q.fn()) } catch (e) { q.reject(e) }
      if (this.queue.length) await new Promise(r => setTimeout(r, this.spacing))
    }
    this.draining = false
    this.recent = []
  }
}

/* --------------------------------------------------------------- connection */

class WhatsAppConnection {
  constructor (sessionId, primary = false) {
    this.sessionId = sessionId
    this.primary = primary
    this.log = logger.child({ waSession: sessionId })
    this.sock = null
    this.baileys = null
    this.config = null
    this.state = 'starting'
    this.registered = false
    this.storage = 'unknown'
    this.connectedAt = null
    this.generation = 0
    this.reconnectAttempt = 0
    this.pairingReady = false
    this.pairingInFlight = false
    this.stopping = false
    this.paused = false
    this.lastMessageAt = null
    this.messagesHandled = 0
    this.seen = new Map()
    this.outputGuard = new GlobalOutputGuard(this.log)
    this.replyLimiter = new ReplyRateLimiter()
  }

  status () {
    return {
      sessionId: this.sessionId,
      label: this.config?.label || '',
      enabled: this.config?.enabled !== false,
      state: this.state,
      registered: this.registered,
      storage: this.storage,
      phone: this.sock?.user?.id || null,
      paused: this.paused,
      lastMessageAt: this.lastMessageAt,
      messagesHandled: this.messagesHandled,
      uptimeSec: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0
    }
  }

  setPaused (value) { this.paused = !!value }

  async start () {
    this.config = await accountConfig.get(this.sessionId, this.primary)
    if (!this.baileys) this.baileys = await import('@whiskeysockets/baileys')
    this.outputGuard.setNoticeText(
      '\u26a0\ufe0f *ARCHITECT COOLDOWN ENDED*\n\nToo many requests arrived at once. Please slow down so the WhatsApp account stays safe.'
    )
    await this.connect()
  }

  async updateConfig (patch) {
    this.config = await accountConfig.save(this.sessionId, patch, this.primary)
    return this.config
  }

  async connect () {
    if (this.stopping) return
    const b = this.baileys
    const { state, saveCreds, storage } = await createAuthState(b, this.sessionId)
    this.registered = !!state.creds.registered
    this.storage = storage
    this.state = this.registered ? 'connecting' : 'waiting-for-pair'
    this.pairingReady = false
    const g = ++this.generation
    const { version } = await b.fetchLatestBaileysVersion()
    const sock = b.default({
      version,
      auth: { creds: state.creds, keys: b.makeCacheableSignalKeyStore(state.keys, this.log) },
      browser: b.Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 60000,
      logger: this.log.child({ module: 'baileys' })
    })
    this.sock = sock

    const rawSend = sock.sendMessage.bind(sock)
    this.outputGuard.setRawSend(rawSend)
    sock.sendMessage = (jid, content, opts) => this.outputGuard.run(jid, () => rawSend(jid, content, opts))
    sock.__sendNativeButtons = (s, j, body, footer, defs, ownerId) => this.sendNativeButtons(s, j, body, footer, defs, ownerId)

    sock.ev.on('creds.update', async () => {
      await saveCreds()
      this.registered = !!state.creds.registered
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (!['notify', 'append'].includes(type)) return
      for (const m of messages) {
        void this.handleMessage(sock, m, type).catch(async e => {
          this.log.error({ err: e, jid: m?.key?.remoteJid }, 'WhatsApp command failed')
          if (m?.key?.remoteJid) {
            await sock.sendMessage(m.key.remoteJid, { text: `Command failed: ${e.message}` }, { quoted: m }).catch(() => {})
          }
        })
      }
    })

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (this.generation !== g || this.sock !== sock) return
      if (qr) this.pairingReady = true
      if (connection === 'open') {
        this.state = 'connected'
        this.connectedAt = Date.now()
        this.reconnectAttempt = 0
        this.pairingReady = true
        this.log.info('WhatsApp connected')
      }
      if (connection === 'close') void this.onClose(sock, g, lastDisconnect)
    })

    this.log.info({ storage, registered: this.registered }, 'WhatsApp socket started')
  }

  async onClose (sock, g, d) {
    if (this.generation !== g || this.sock !== sock) return
    const code = d?.error?.output?.statusCode
    const message = String(d?.error?.message || '')
    const conflict = code === 440 || /conflict|replaced/i.test(message)
    this.sock = null
    this.state = code === 401 ? 'logged-out' : conflict ? 'standby-conflict' : 'disconnected'
    if (this.stopping || code === 401 || code === 429) return
    if (conflict) {
      logger.error({ code }, 'WhatsApp session replaced; waiting 60 seconds before one safe recovery attempt')
      setTimeout(() => {
        if (!this.stopping && !this.sock && this.generation === g) void this.connect()
      }, 60000)
      return
    }
    this.reconnectAttempt++
    setTimeout(() => {
      if (!this.stopping && !this.sock && this.generation === g) void this.connect()
    }, Math.min(30000, 2000 * (2 ** Math.min(this.reconnectAttempt, 4))))
  }

  async waitForPairingReady (g, t = 20000) {
    const st = Date.now()
    while (Date.now() - st < t) {
      if (g !== this.generation) throw Error('WhatsApp socket restarted; run /pair again')
      if (this.sock && this.pairingReady) return
      await new Promise(r => setTimeout(r, 150))
    }
    throw Error('WhatsApp did not become pairing-ready')
  }

  async requestPairingCode (raw) {
    if (this.pairingInFlight) throw Error('A pairing request is already running')
    const phone = String(raw).replace(/\D/g, '').replace(/^0+/, '')
    if (!/^\d{8,15}$/.test(phone)) throw Error('Use international format')
    this.pairingInFlight = true
    try {
      await this.resetSocket(true)
      await this.waitForPairingReady(this.generation)
      this.state = 'pairing'
      return await this.sock.requestPairingCode(phone)
    } finally {
      this.pairingInFlight = false
    }
  }

  async resetSocket (clear) {
    this.generation++
    const old = this.sock
    this.sock = null
    try { old?.end(undefined) } catch {}
    if (clear) await clearAuthState(this.sessionId)
    this.reconnectAttempt = 0
    await this.connect()
  }

  async reconnect () { await this.resetSocket(false) }

  /* ------------------------------------------------------------- the router */

  /**
   * ONE message path. No legacy fallback.
   *
   * Order matters:
   *   1. dedupe + config gate
   *   2. the guard decides whether this is worth routing at all
   *   3. button taps go to the AXYON section handler
   *   4. text commands go to the AXYON router
   *   5. anything else is ignored
   */
  async handleMessage (sock, m, type = 'notify') {
    const jid = m?.key?.remoteJid
    const id = m?.key?.id
    if (!jid || !id || jid === 'status@broadcast' || this.seen.has(id)) return
    if (this.config?.enabled === false || this.paused) return

    const content = this.baileys.normalizeMessageContent(m.message) || {}
    const prefix = await this.prefixFor(jid)

    if (!shouldHandleUpsert(content, { fromMe: !!m.key.fromMe, type, prefix })) return

    this.lastMessageAt = new Date().toISOString()
    this.messagesHandled++
    this.seen.set(id, Date.now())
    if (this.seen.size > 2000) this.seen.clear()

    const limit = this.replyLimiter.check(m)
    if (!limit.allowed) {
      if (limit.warn) {
        await sock.sendMessage(jid, {
          text: `\ud83e\udd2b *EASY THERE*\n\nThree commands came in too quickly. Architect is ignoring you for ${Math.ceil(limit.durationMs / 1000)} seconds.`
        }, { quoted: m }).catch(() => {})
      }
      return
    }

    const button = resolveButtonId(content)
    if (button && await axyonCommands.section(sock, m, button)) return

    if (await axyonCommands.handle(sock, m, content)) return
    // Nothing else. The old build fell through to a legacy router here.
  }

  /** Reads the active prefix without building a full command context. */
  async prefixFor (jid) {
    try {
      const settings = await require('./axyon-store').settings()
      if (String(jid).endsWith('@g.us')) {
        const g = await require('./axyon-store').group(jid)
        if (g?.prefix) return g.prefix
      }
      return settings.prefix
    } catch {
      return '!'
    }
  }

  /* --------------------------------------------------------------- buttons */

  async sendNativeButtons (sock, jid, body, footer, defs, ownerId = null) {
    const { proto, generateWAMessageFromContent } = this.baileys
    const buttons = defs.map(([label, id]) => {
      const scoped = ownerId && ['ax_b_', 'ax_duel_'].some(p => String(id).startsWith(p)) ? `${id}~u:${ownerId}` : id
      return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: label, id: scoped }) }
    })
    const g = generateWAMessageFromContent(jid, {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage: proto.Message.InteractiveMessage.create({
            body: proto.Message.InteractiveMessage.Body.create({ text: body }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons })
          })
        }
      }
    }, {})
    await this.outputGuard.run(jid, () => sock.relayMessage(jid, g.message, { messageId: g.key.id }))
  }

  async stop () {
    this.stopping = true
    this.generation++
    try { this.sock?.end(undefined) } catch {}
    this.sock = null
  }
}

/* ---------------------------------------------------------------- sessions */

class WhatsAppSessionManager {
  constructor () {
    this.connections = new Map()
    this.primaryId = process.env.WA_SESSION_ID || 'architect-primary'
    this.maxSessions = Math.max(1, Math.min(20, Number(process.env.WA_MAX_SESSIONS) || 5))
  }

  async start () {
    await accountConfig.ensure()
    const saved = await listAuthSessions()
    const ids = [...new Set([this.primaryId, ...saved])]
    for (const id of ids) {
      const c = new WhatsAppConnection(id, id === this.primaryId)
      this.connections.set(id, c)
      await c.start().catch(e => logger.error({ err: e, waSession: id }, 'WhatsApp session failed to start'))
    }
  }

  list () { return [...this.connections.values()].map(c => c.status()) }

  status () {
    const all = this.list()
    const primary = all.find(x => x.sessionId === this.primaryId) || all[0] || null
    return { primary, accounts: all, connected: all.filter(x => x.state === 'connected').length, total: all.length }
  }

  get (id) { return this.connections.get(String(id || this.primaryId)) }

  async pair (phone, label = 'Architect', accountType = 'primary') {
    if (!['primary', 'instance'].includes(accountType)) {
      throw Object.assign(Error('Choose primary or additional instance'), { status: 400 })
    }
    const primary = this.get(this.primaryId)
    if (accountType === 'primary') {
      if (!primary) throw Object.assign(Error('Primary Architect session is not initialized'), { status: 503 })
      if (primary.registered) {
        throw Object.assign(Error('The primary Architect account is already linked. Choose Additional instance to pair another number.'), { status: 409 })
      }
      await primary.updateConfig({ label: 'Architect' })
      const code = await primary.requestPairingCode(phone)
      return { id: primary.sessionId, code, accountType: 'primary' }
    }
    if (this.connections.size >= this.maxSessions) {
      throw Object.assign(Error(`Maximum ${this.maxSessions} WhatsApp accounts reached`), { status: 409 })
    }
    const clean = String(label || 'architect-instance').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
    const id = `wa-${clean || Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const c = new WhatsAppConnection(id, false)
    this.connections.set(id, c)
    try {
      await accountConfig.save(id, { label: String(label || 'Architect Instance') }, false)
      await c.start()
      const code = await c.requestPairingCode(phone)
      return { id, code, accountType: 'instance' }
    } catch (e) {
      this.connections.delete(id)
      await c.stop().catch(() => {})
      await clearAuthState(id).catch(() => {})
      await accountConfig.remove(id).catch(() => {})
      throw e
    }
  }

  async reconnect (id) {
    const c = this.get(id)
    if (!c) throw Object.assign(Error('WhatsApp account not found'), { status: 404 })
    await c.reconnect()
  }

  setPaused (id, value) {
    const c = this.get(id)
    if (!c) throw Object.assign(Error('WhatsApp account not found'), { status: 404 })
    c.setPaused(value)
    return c.status()
  }

  async remove (id) {
    id = String(id || '')
    const c = this.connections.get(id)
    if (!c) throw Object.assign(Error('WhatsApp account not found'), { status: 404 })
    if (id === this.primaryId) throw Object.assign(Error('The primary Architect account cannot be removed here'), { status: 409 })
    await c.stop()
    await clearAuthState(id)
    await accountConfig.remove(id)
    this.connections.delete(id)
    return true
  }

  async resetAll () {
    const ids = [...this.connections.keys()]
    await Promise.allSettled([...this.connections.values()].map(c => c.stop()))
    for (const id of ids) {
      await clearAuthState(id)
      await accountConfig.remove(id)
    }
    this.connections.clear()
    const primary = new WhatsAppConnection(this.primaryId, true)
    this.connections.set(this.primaryId, primary)
    await accountConfig.save(this.primaryId, { label: 'Architect' }, true)
    await primary.start()
    return { removed: ids.length }
  }

  async stop () { await Promise.allSettled([...this.connections.values()].map(c => c.stop())) }
}

/* ------------------------------------------------------------------- boot */

const sessions = new WhatsAppSessionManager()
const lease = createInstanceLease({ database, logger })
const dashboard = createDashboard({ sessions, database, lease, logger })

const healthServer = http.createServer((q, r) => {
  void (async () => {
    if (await dashboard.handle(q, r)) return
    if (q.url === '/' || q.url === '/health') {
      r.writeHead(200, { 'content-type': 'application/json' })
      r.end(JSON.stringify({ ok: true, instance: lease.status(), whatsapp: sessions.status() }))
      return
    }
    r.writeHead(404).end()
  })().catch(e => {
    logger.error({ err: e }, 'HTTP request failed')
    if (!r.headersSent) r.writeHead(500, { 'content-type': 'application/json' })
    r.end(JSON.stringify({ ok: false, error: 'Internal server error' }))
  })
})

async function main () {
  healthServer.listen(port, '0.0.0.0', () => logger.info({ port }, 'Architect health server listening'))
  const acquired = await lease.acquire(async () => { await sessions.stop() })
  if (!acquired) return
  await sessions.start()
  logger.info({ accounts: sessions.list().length }, 'Architect control and WhatsApp sessions started')
}

async function shutdown (signal) {
  logger.info({ signal }, 'shutting down')
  await sessions.stop()
  await lease.release()
  healthServer.close()
  await closeAuthStore()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', e => logger.error({ err: e }, 'unhandled rejection'))
main().catch(e => { logger.fatal({ err: e }, 'startup failed'); process.exit(1) })

module.exports = { WhatsAppConnection, WhatsAppSessionManager, GlobalOutputGuard }
