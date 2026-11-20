/* ARCHITECT CONTROL — screen switcher, WhatsApp-code login, feedback.
 *
 * SESSION PERSISTENCE
 * -------------------
 * The old build kept the session only in an HttpOnly cookie and re-checked it
 * on every page load. On a phone, switching apps suspends the page; when the
 * browser discards and reloads it, the login screen came back even though the
 * session was still valid. That is the "login screen disappears / resets"
 * complaint.
 *
 * Now the token is ALSO kept in localStorage. On boot the client sends it in
 * an `x-architect-token` header, so a reload — or a return from another app —
 * re-validates silently and lands back on the same screen. The cookie is still
 * set, so a fresh tab works too.
 *
 * The screen the person was on is remembered as well, so returning from
 * another app puts them back where they were instead of on Overview.
 */
const $ = s => document.querySelector(s)
const $$ = s => [...document.querySelectorAll(s)]

const TOKEN_KEY = 'architect.token'
const SCREEN_KEY = 'architect.screen'
const THREAD_KEY = 'architect.feedback.thread'

let csrf = ''
let token = ''
let role = 'guest'
let permissions = []
let overview = null
let refreshTimer = null
let pairCode = ''
let currentScreen = 'overview'
let pendingPhone = ''
window.architectCsrf = () => csrf

/* ------------------------------------------------------------- feedback */

function toast (t) {
  const e = $('#toast')
  if (!e) return
  e.textContent = t
  e.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => e.classList.remove('show'), 4200)
}

function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function duration (sec) {
  sec = Number(sec || 0)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h ${Math.floor(sec % 3600 / 60)}m`
}

function ago (v) {
  if (!v) return '—'
  const n = Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 1000))
  return n < 60 ? `${n}s ago` : n < 3600 ? `${Math.floor(n / 60)}m ago` : n < 86400 ? `${Math.floor(n / 3600)}h ago` : `${Math.floor(n / 86400)}d ago`
}

/* ------------------------------------------------------------------ api */

async function api (path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) }
  if (options.method && options.method !== 'GET') headers['x-architect-csrf'] = csrf
  if (token) headers['x-architect-token'] = token
  const r = await fetch(`/dashboard/api/${path}`, { credentials: 'same-origin', ...options, headers })
  const data = await r.json().catch(() => ({ error: `Invalid server response (HTTP ${r.status})` }))
  if (!r.ok) throw Error(data.error || data.message || `HTTP ${r.status}`)
  if (data.csrf) csrf = data.csrf
  return data
}

/* ------------------------------------------------------- SCREEN SWITCHER */

const SCREENS = ['overview', 'pairing', 'groups', 'players', 'shop', 'stages', 'floors', 'modes', 'cardstudio', 'visuals', 'authority', 'settings', 'log', 'feedback', 'help']

/* Which permission a screen needs. A screen the role cannot read is hidden
 * from the side panel and refused if reached by hash. */
const SCREEN_PERMISSION = {
  overview: 'overview.read',
  pairing: 'pairing.read',
  groups: 'groups.read',
  players: 'players.read',
  shop: 'shop.read',
  stages: 'stages.read',
  floors: 'floors.read',
  modes: 'modes.read',
  visuals: 'visuals.read',
  cardstudio: 'overview.control',
  authority: 'authority.read',
  settings: 'settings.read',
  log: 'log.read',
  feedback: null,   // public
  help: 'commands.read'
}

function can (permission) {
  if (!permission) return true
  return permissions.includes(permission)
}

function showScreen (name) {
  if (!SCREENS.includes(name)) name = 'overview'
  /* A screen the role cannot read falls back to the first one it can. */
  if (!can(SCREEN_PERMISSION[name])) {
    name = SCREENS.find(s => can(SCREEN_PERMISSION[s])) || 'feedback'
  }
  currentScreen = name
  $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name))
  $$('#sideList button').forEach(b => {
    const on = b.dataset.goto === name
    b.classList.toggle('active', on)
    if (on) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  })
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`)
  try { localStorage.setItem(SCREEN_KEY, name) } catch {}
  if (typeof window.architectRenderScreen === 'function') window.architectRenderScreen(name)
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' })
}

/** Hides the side-panel rows this role may not open. */
function applyRoleToNav () {
  $$('#sideList button').forEach(b => {
    const perm = SCREEN_PERMISSION[b.dataset.goto]
    b.hidden = !can(perm)
  })
  const badge = $('#roleBadge')
  if (badge) {
    badge.hidden = false
    badge.textContent = role.toUpperCase()
    badge.className = `role-badge role-${role}`
  }
}

/* --------------------------------------------------------- SIDE PANEL */

let panelOpen = false
let lastFocus = null

function panelEls () {
  return { panel: $('#sidePanel'), scrim: $('#scrim'), btn: $('#menuBtn') }
}

function openPanel () {
  const { panel, scrim, btn } = panelEls()
  if (!panel || panelOpen) return
  panelOpen = true
  lastFocus = document.activeElement
  panel.classList.add('open')
  panel.setAttribute('aria-hidden', 'false')
  if (scrim) { scrim.hidden = false; requestAnimationFrame(() => scrim.classList.add('show')) }
  if (btn) btn.setAttribute('aria-expanded', 'true')
  document.body.classList.add('panel-open')
  const active = panel.querySelector('#sideList button.active') || panel.querySelector('#sideList button:not([hidden])')
  if (active) active.focus({ preventScroll: false })
}

function closePanel ({ restoreFocus = true } = {}) {
  const { panel, scrim, btn } = panelEls()
  if (!panel || !panelOpen) return
  panelOpen = false
  panel.classList.remove('open')
  panel.setAttribute('aria-hidden', 'true')
  if (scrim) {
    scrim.classList.remove('show')
    setTimeout(() => { if (!panelOpen) scrim.hidden = true }, 240)
  }
  if (btn) btn.setAttribute('aria-expanded', 'false')
  document.body.classList.remove('panel-open')
  if (restoreFocus && lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true })
}

function togglePanel () { panelOpen ? closePanel() : openPanel() }

function wirePanel () {
  const { btn, scrim } = panelEls()
  if (btn) btn.onclick = togglePanel
  const close = $('#sideClose')
  if (close) close.onclick = () => closePanel()
  if (scrim) scrim.onclick = () => closePanel()

  $$('#sideList button').forEach(b => {
    b.onclick = () => {
      showScreen(b.dataset.goto)
      closePanel({ restoreFocus: false })
    }
  })

  document.addEventListener('keydown', e => {
    if (!panelOpen) return
    if (e.key === 'Escape') { e.preventDefault(); closePanel(); return }
    if (e.key !== 'Tab') return
    const panel = $('#sidePanel')
    if (!panel) return
    const items = [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  })

  window.addEventListener('hashchange', () => showScreen(location.hash.slice(1) || 'overview'))
}

/* --------------------------------------------------------------- login */

function showLogin (message = '') {
  $('#login').classList.remove('hidden')
  $('#app').classList.add('hidden')
  $('#loginError').textContent = message
  document.dispatchEvent(new CustomEvent('architect:logout'))
}

function showApp () {
  $('#login').classList.add('hidden')
  $('#app').classList.remove('hidden')
  document.dispatchEvent(new CustomEvent('architect:login'))
}

function showCodeStep (phone, message = '') {
  pendingPhone = phone
  $('#loginForm').classList.add('hidden')
  $('#codeForm').classList.remove('hidden')
  $('#codeSentTo').textContent = `Code sent to ${phone} on WhatsApp.`
  $('#codeError').textContent = message
  $('#loginCode').value = ''
  $('#loginCode').focus()
}

function showPhoneStep () {
  $('#codeForm').classList.add('hidden')
  $('#loginForm').classList.remove('hidden')
  $('#loginError').textContent = ''
  $('#loginPhone').focus()
}

/** Stores the session and enters the app. */
function enterApp (data) {
  token = data.token || token
  csrf = data.csrf || csrf
  role = data.role || 'guest'
  permissions = Array.isArray(data.permissions) ? data.permissions : []
  try { if (token) localStorage.setItem(TOKEN_KEY, token) } catch {}
  applyRoleToNav()
  showApp()
  const remembered = (() => { try { return localStorage.getItem(SCREEN_KEY) } catch { return null } })()
  showScreen(location.hash.slice(1) || remembered || 'overview')
  void refresh()
  clearInterval(refreshTimer)
  refreshTimer = setInterval(refresh, 15000)
}

/**
 * Boot.
 *
 * The stored token is tried FIRST, before anything is drawn, so a reload or a
 * return from another app never flashes the login screen for a signed-in
 * person.
 */
async function boot () {
  wirePanel()
  wireFeedback()
  try { token = localStorage.getItem(TOKEN_KEY) || '' } catch { token = '' }
  try {
    const s = await api('session')
    if (s.authenticated) {
      role = s.role
      permissions = s.permissions || []
      csrf = s.csrf
      applyRoleToNav()
      showApp()
      const remembered = (() => { try { return localStorage.getItem(SCREEN_KEY) } catch { return null } })()
      showScreen(location.hash.slice(1) || remembered || 'overview')
      await refresh()
      clearInterval(refreshTimer)
      refreshTimer = setInterval(refresh, 15000)
      return
    }
  } catch { /* fall through to the login screen */ }
  /* No valid session: clear the stale token so it is not retried forever. */
  token = ''
  try { localStorage.removeItem(TOKEN_KEY) } catch {}
  showLogin()
}

/* ------------------------------------------------------------- accounts */

function renderAccounts (items) {
  const el = $('#accountList')
  if (!el) return
  if (!items.length) { el.className = 'list empty'; el.textContent = 'No paired accounts yet.'; return }
  el.className = 'list'
  el.innerHTML = items.map((a, i) => `<article class="panel account-card"><div class="panel-head"><div><p class="eyebrow">${i === 0 ? 'PRIMARY ARCHITECT' : 'ARCHITECT INSTANCE'}</p><h3>${esc(a.phone)}</h3><small class="muted">${esc(a.label || a.sessionId)}</small></div><span class="badge">${esc(a.paused ? 'Paused' : a.state)}</span></div><div class="detail-grid"><div><small>STORAGE</small><b>${esc(a.storage)}</b></div><div><small>MESSAGES</small><b>${Number(a.messagesHandled || 0).toLocaleString()}</b></div><div><small>UPTIME</small><b>${duration(a.uptimeSec)}</b></div></div><div class="actions"><button data-account-action="reconnect" data-session="${esc(a.sessionId)}">Reconnect</button><button data-account-action="pause" data-session="${esc(a.sessionId)}" data-paused="${a.paused ? '1' : '0'}">${a.paused ? 'Resume' : 'Pause'}</button>${i === 0 ? '' : `<button class="danger" data-account-action="remove" data-session="${esc(a.sessionId)}">Remove</button>`}</div></article>`).join('')
  $$('[data-account-action]').forEach(b => { b.onclick = () => accountAction(b) })
}

async function accountAction (b) {
  const sessionId = b.dataset.session
  const action = b.dataset.accountAction
  try {
    b.disabled = true
    if (action === 'remove') {
      if (prompt('Type REMOVE to delete this paired session') !== 'REMOVE') return
      await api('actions/remove', { method: 'POST', body: JSON.stringify({ sessionId, confirm: 'REMOVE' }) })
      toast('Instance removed')
    } else if (action === 'pause') {
      await api('actions/pause', { method: 'POST', body: JSON.stringify({ sessionId, paused: b.dataset.paused !== '1' }) })
      toast('Instance updated')
    } else {
      await api('actions/reconnect', { method: 'POST', body: JSON.stringify({ sessionId }) })
      toast('Reconnect started')
    }
    await refresh()
  } catch (e) {
    toast(e.message)
  } finally {
    b.disabled = false
  }
}

/* -------------------------------------------------------------- refresh */

async function refresh () {
  if (!can('overview.read')) return
  try {
    overview = await api('overview')
    const w = overview.whatsapp
    const s = overview.stats
    const active = !!overview.instance?.owned
    const online = (overview.accountSummary?.connected || 0) > 0

    $('#livePill').className = `pill ${online ? 'online' : ''}`
    $('#livePill span').textContent = active ? (online ? `${overview.accountSummary.connected} online` : 'Disconnected') : 'Standby'
    $('#heroTitle').textContent = !active ? 'Architect is in standby.' : online ? 'Architect is online.' : 'Architect is waiting for a WhatsApp link.'
    $('#heroSub').textContent = !active
      ? 'Another process owns these sessions. Take control to manage this instance.'
      : online
        ? `${overview.accountSummary.connected} of ${overview.accountSummary.total} WhatsApp accounts are connected.`
        : 'Pair a number on the Pairing screen to activate the game engine.'

    $('#users').textContent = (s.registeredUsers || 0).toLocaleString()
    $('#accounts').textContent = overview.accountSummary.total
    $('#online').textContent = overview.accountSummary.connected
    $('#uptime').textContent = duration(w.uptimeSec)
    $('#primaryTitle').textContent = w.label || 'Architect'
    $('#primaryMeta').textContent = w.sessionId || 'Waiting for pairing'
    $('#accountPhone').textContent = w.phone
    $('#waBadge').textContent = active ? (w.paused ? 'Paused' : w.state) : 'Standby'
    $('#storage').textContent = w.storage
    $('#lastMessage').textContent = ago(w.lastMessageAt)
    $('#handled').textContent = (w.messagesHandled || 0).toLocaleString()
    $('#pauseBtn').textContent = w.paused ? 'Resume' : 'Pause'
    $('#takeoverBtn').classList.toggle('hidden', active)
    $('#standbyNote').classList.toggle('hidden', active)
    $('#reconnectBtn').disabled = !active || !w.sessionId
    $('#pauseBtn').disabled = !active || !w.sessionId
    renderAccounts(overview.accounts || [])
  } catch (e) {
    if (/sign in/i.test(e.message)) { clearInterval(refreshTimer); signOutLocal(); showLogin() } else toast(e.message)
  }
}

/* ------------------------------------------------------------- feedback */

/** A random per-tab id. It is never sent anywhere but the feedback endpoints,
 *  and it is discarded when the tab closes — that is what keeps it anonymous. */
function feedbackThreadId () {
  let t = ''
  try { t = sessionStorage.getItem(THREAD_KEY) || '' } catch {}
  if (!t) {
    t = 'f' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    try { sessionStorage.setItem(THREAD_KEY, t) } catch {}
  }
  return t
}

function renderFeedback (messages) {
  const el = $('#feedbackThread')
  if (!el) return
  if (!messages.length) {
    el.innerHTML = '<p class="admin-empty">No messages yet. Say anything — a bug, an idea, a hello.</p>'
    return
  }
  el.innerHTML = messages.map(m => `<div class="fb-msg ${m.fromStaff ? 'fb-staff' : 'fb-user'}"><p>${esc(m.body)}</p><small>${m.fromStaff ? 'AXYON' : 'You'} · ${ago(m.createdAt)}</small></div>`).join('')
  el.scrollTop = el.scrollHeight
}

async function loadFeedback () {
  try {
    const d = await api(`feedback/thread?thread=${encodeURIComponent(feedbackThreadId())}`)
    renderFeedback(d.messages || [])
  } catch (e) { /* the thread is best-effort; a failure must not block the page */ }
}

async function loadInbox () {
  const panel = $('#feedbackInboxPanel')
  if (!panel) return
  if (!can('feedback.read')) { panel.hidden = true; return }
  panel.hidden = false
  try {
    const d = await api('feedback/inbox')
    const el = $('#feedbackInbox')
    const rows = d.threads || []
    if (!rows.length) { el.className = 'list empty'; el.textContent = 'No messages yet.'; return }
    el.className = 'list'
    el.innerHTML = rows.map(t => `<article class="panel"><div class="panel-head"><div><p class="eyebrow">${t.total} MESSAGE${t.total === 1 ? '' : 'S'}</p><p>${esc(t.preview)}</p><small class="muted">${ago(t.createdAt)}</small></div></div><div class="actions"><button data-reply-thread="${esc(t.thread)}">Reply</button></div></article>`).join('')
    $$('[data-reply-thread]').forEach(b => {
      b.onclick = async () => {
        const text = prompt('Reply to this conversation')
        if (!text) return
        try {
          await api('feedback/reply', { method: 'POST', body: JSON.stringify({ thread: b.dataset.replyThread, body: text }) })
          toast('Reply sent')
          await loadInbox()
        } catch (e) { toast(e.message) }
      }
    })
  } catch (e) { toast(e.message) }
}

function wireFeedback () {
  const form = $('#feedbackForm')
  if (form) {
    form.onsubmit = async e => {
      e.preventDefault()
      const input = $('#feedbackInput')
      const text = input.value.trim()
      if (!text) return
      const btn = $('#feedbackSend')
      try {
        btn.disabled = true
        await api('feedback', { method: 'POST', body: JSON.stringify({ thread: feedbackThreadId(), body: text }) })
        input.value = ''
        $('#feedbackError').textContent = ''
        await loadFeedback()
      } catch (err) {
        $('#feedbackError').textContent = err.message
      } finally { btn.disabled = false }
    }
  }
  const refreshBtn = $('#feedbackRefresh')
  if (refreshBtn) refreshBtn.onclick = loadInbox
  const fromLogin = $('#openFeedbackFromLogin')
  if (fromLogin) {
    fromLogin.onclick = () => {
      /* Feedback needs no session, so it opens even from the login screen. */
      showApp()
      applyRoleToNav()
      showScreen('feedback')
      void loadFeedback()
    }
  }
}

/* --------------------------------------------------------------- wiring */

$('#loginForm').onsubmit = async e => {
  e.preventDefault()
  const phone = $('#loginPhone').value.replace(/\D/g, '')
  const btn = $('#loginSendBtn')
  $('#loginError').textContent = ''
  if (!/^\d{8,15}$/.test(phone)) { $('#loginError').textContent = 'Enter your number in international format, digits only.'; return }
  try {
    btn.disabled = true
    btn.textContent = 'Sending…'
    const d = await api('login/request', { method: 'POST', body: JSON.stringify({ phone }) })
    showCodeStep(phone, d.message || '')
  } catch (err) {
    $('#loginError').textContent = err.message
  } finally {
    btn.disabled = false
    btn.textContent = 'Send me a code'
  }
}

$('#codeForm').onsubmit = async e => {
  e.preventDefault()
  const code = $('#loginCode').value.replace(/\D/g, '')
  const btn = $('#loginVerifyBtn')
  $('#codeError').textContent = ''
  try {
    btn.disabled = true
    btn.textContent = 'Checking…'
    const d = await api('login/verify', { method: 'POST', body: JSON.stringify({ phone: pendingPhone, code }) })
    enterApp(d)
  } catch (err) {
    $('#codeError').textContent = err.message
  } finally {
    btn.disabled = false
    btn.textContent = 'Unlock control'
  }
}

$('#loginBack').onclick = showPhoneStep

function signOutLocal () {
  token = ''
  csrf = ''
  role = 'guest'
  permissions = []
  try { localStorage.removeItem(TOKEN_KEY) } catch {}
  clearInterval(refreshTimer)
}

$('#logoutBtn').onclick = async () => {
  try { await api('logout', { method: 'POST', body: '{}' }) } catch {}
  signOutLocal()
  showLogin()
}

$('#pairType').onchange = () => $('#pairLabelWrap').classList.toggle('hidden', $('#pairType').value !== 'instance')

$('#pairBtn').onclick = async () => {
  const b = $('#pairBtn')
  const accountType = $('#pairType').value
  const original = b.textContent
  try {
    b.disabled = true
    b.textContent = 'Contacting WhatsApp…'
    toast('Requesting a pairing code — this can take up to 20 seconds')
    const d = await api('actions/pair', { method: 'POST', body: JSON.stringify({ phone: $('#pairPhone').value, label: $('#pairLabel').value, accountType }) })
    pairCode = d.code
    $('#pairIdentity').textContent = d.accountType === 'primary' ? 'PRIMARY ARCHITECT PAIRING CODE' : 'ADDITIONAL INSTANCE PAIRING CODE'
    $('#pairCode').textContent = d.code
    $('#pairSlot').textContent = `Slot: ${d.sessionId}`
    $('#pairResult').classList.remove('hidden')
    toast('Pairing code ready — enter it in WhatsApp')
  } catch (e) {
    toast(e.message)
    $('#pairResult').classList.remove('hidden')
    $('#pairIdentity').textContent = 'PAIRING FAILED'
    $('#pairCode').textContent = '—'
    $('#pairSlot').textContent = e.message
  } finally {
    b.disabled = false
    b.textContent = original
  }
}

$('#copyPairCode').onclick = async () => {
  if (!pairCode) { toast('Generate a pairing code first'); return }
  const plain = pairCode.replace(/-/g, '')
  try {
    await navigator.clipboard.writeText(plain)
    toast('Pairing code copied')
  } catch {
    const el = $('#pairCode')
    if (el) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
    toast('Code selected — press Ctrl/Cmd+C to copy')
  }
}

$('#refreshBtn').onclick = refresh

$('#reconnectBtn').onclick = async () => {
  try { await api('actions/reconnect', { method: 'POST', body: JSON.stringify({}) }); toast('Reconnect started'); await refresh() } catch (e) { toast(e.message) }
}

$('#pauseBtn').onclick = async () => {
  try {
    await api('actions/pause', { method: 'POST', body: JSON.stringify({ paused: !overview.whatsapp.paused }) })
    toast(overview.whatsapp.paused ? 'Architect resumed' : 'Architect paused')
    await refresh()
  } catch (e) { toast(e.message) }
}

$('#takeoverBtn').onclick = async () => {
  if (!confirm('Take control from the other running process?')) return
  try { await api('actions/takeover', { method: 'POST', body: '{}' }); toast('Control takeover requested'); setTimeout(refresh, 2500) } catch (e) { toast(e.message) }
}

$('#removeAllBtn').onclick = async () => {
  if (prompt('This logs out every paired WhatsApp number. Type REMOVE ALL') !== 'REMOVE ALL') return
  try {
    const d = await api('actions/remove-all', { method: 'POST', body: JSON.stringify({ confirm: 'REMOVE ALL' }) })
    pairCode = ''
    $('#pairResult').classList.add('hidden')
    toast(`${d.removed} sessions removed`)
    await refresh()
  } catch (e) { toast(e.message) }
}

/*
 * RETURNING FROM ANOTHER APP
 * --------------------------
 * A phone suspends the page rather than closing it. When it comes back the
 * session is still valid, so the client re-validates quietly and re-renders
 * the screen it was on. It never shows the login screen for a live session.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (!token) return
  void (async () => {
    try {
      const s = await api('session')
      if (!s.authenticated) { signOutLocal(); showLogin('Your session expired. Sign in again.'); return }
      role = s.role
      permissions = s.permissions || []
      csrf = s.csrf
      applyRoleToNav()
      if (currentScreen === 'feedback') void loadFeedback()
      else if (can('overview.read')) void refresh()
    } catch { /* offline: keep the current screen, try again on the next tick */ }
  })()
})

/* A bfcache restore (back/forward) also must not reset the screen. */
window.addEventListener('pageshow', e => {
  if (!e.persisted) return
  if (token) showScreen(currentScreen)
})

/* Expose the switcher so admin.js can drive screen rendering. */
window.architectShowScreen = showScreen
window.architectClosePanel = closePanel
window.architectToast = toast
window.architectEsc = esc
window.architectCan = can
window.architectRole = () => role
window.architectLoadFeedback = loadFeedback
window.architectLoadInbox = loadInbox

boot()
