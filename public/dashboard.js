/* ARCHITECT CONTROL — screen switcher + pairing/overview logic.
 *
 * The dashboard is a set of discrete screens, not one long scroll. Exactly one
 * <section class="screen"> carries .active at a time; the slide-out side panel
 * toggles that class. No reload, no router, no history entries to get lost in.
 */
const $ = s => document.querySelector(s)
const $$ = s => [...document.querySelectorAll(s)]

let csrf = ''
let overview = null
let refreshTimer = null
let pairCode = ''
let currentScreen = 'overview'

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
  if (!v) return '\u2014'
  const n = Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 1000))
  return n < 60 ? `${n}s ago` : n < 3600 ? `${Math.floor(n / 60)}m ago` : n < 86400 ? `${Math.floor(n / 3600)}h ago` : `${Math.floor(n / 86400)}d ago`
}

/* ------------------------------------------------------------------ api */

async function api (path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) }
  if (options.method && options.method !== 'GET') headers['x-architect-csrf'] = csrf
  const r = await fetch(`/dashboard/api/${path}`, { credentials: 'same-origin', ...options, headers })
  const data = await r.json().catch(() => ({ error: `Invalid server response (HTTP ${r.status})` }))
  if (!r.ok) throw Error(data.error || data.message || `HTTP ${r.status}`)
  if (data.csrf) csrf = data.csrf
  return data
}

/* ------------------------------------------------------- SCREEN SWITCHER */

const SCREENS = ['overview', 'pairing', 'groups', 'players', 'shop', 'stages', 'floors', 'modes', 'visuals', 'authority', 'settings', 'log', 'help']

/**
 * Shows one screen and hides the rest. Instant — a class toggle, no reload.
 * Also keeps the side panel highlight and the URL hash in sync so a refresh or
 * a shared link lands on the same screen.
 */
function showScreen (name) {
  if (!SCREENS.includes(name)) name = 'overview'
  currentScreen = name
  $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name))
  $$('#sideList button').forEach(b => {
    const on = b.dataset.goto === name
    b.classList.toggle('active', on)
    if (on) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  })
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`)
  /* The admin screens are rendered lazily on first visit, then kept. */
  if (typeof window.architectRenderScreen === 'function') window.architectRenderScreen(name)
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' })
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
  /* Focus the current screen's row so keyboard users land in the right place. */
  const active = panel.querySelector('#sideList button.active') || panel.querySelector('#sideList button')
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

  /* Escape closes; Tab is trapped inside the panel while it is open. */
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

async function boot () {
  wirePanel()
  try {
    const s = await api('session')
    if (!s.configured) { showLogin('Set DASHBOARD_PASSWORD in Render, then redeploy.'); return }
    if (!s.authenticated) { showLogin(); return }
    csrf = s.csrf
    showApp()
    showScreen(location.hash.slice(1) || 'overview')
    await refresh()
    refreshTimer = setInterval(refresh, 15000)
  } catch (e) {
    showLogin(e.message)
  }
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
    if (/sign in/i.test(e.message)) { clearInterval(refreshTimer); showLogin() } else toast(e.message)
  }
}

/* --------------------------------------------------------------- wiring */

$('#loginForm').onsubmit = async e => {
  e.preventDefault()
  $('#loginError').textContent = ''
  try {
    const d = await api('login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) })
    csrf = d.csrf
    $('#password').value = ''
    showApp()
    showScreen(location.hash.slice(1) || 'overview')
    await refresh()
    refreshTimer = setInterval(refresh, 15000)
  } catch (err) {
    $('#loginError').textContent = err.message
  }
}

$('#logoutBtn').onclick = async () => {
  try { await api('logout', { method: 'POST', body: '{}' }) } catch {}
  clearInterval(refreshTimer)
  showLogin()
}

$('#pairType').onchange = () => $('#pairLabelWrap').classList.toggle('hidden', $('#pairType').value !== 'instance')

$('#pairBtn').onclick = async () => {
  const b = $('#pairBtn')
  const accountType = $('#pairType').value
  /*
   * A pairing request waits for the WhatsApp socket to become ready, which can
   * take up to 20 seconds. Without a visible pending state the button looks
   * dead for that whole time — the exact complaint this dashboard keeps
   * getting. So the label changes immediately and a toast says what is
   * happening, before the request is even sent.
   */
  const original = b.textContent
  try {
    b.disabled = true
    b.textContent = 'Contacting WhatsApp\u2026'
    toast('Requesting a pairing code \u2014 this can take up to 20 seconds')
    const d = await api('actions/pair', { method: 'POST', body: JSON.stringify({ phone: $('#pairPhone').value, label: $('#pairLabel').value, accountType }) })
    pairCode = d.code
    $('#pairIdentity').textContent = d.accountType === 'primary' ? 'PRIMARY ARCHITECT PAIRING CODE' : 'ADDITIONAL INSTANCE PAIRING CODE'
    $('#pairCode').textContent = d.code
    $('#pairSlot').textContent = `Slot: ${d.sessionId}`
    $('#pairResult').classList.remove('hidden')
    toast('Pairing code ready \u2014 enter it in WhatsApp')
  } catch (e) {
    /* Never silent: the reason goes to the toast AND stays on screen. */
    toast(e.message)
    $('#pairResult').classList.remove('hidden')
    $('#pairIdentity').textContent = 'PAIRING FAILED'
    $('#pairCode').textContent = '\u2014'
    $('#pairSlot').textContent = e.message
  } finally {
    b.disabled = false
    b.textContent = original
  }
}

$('#copyPairCode').onclick = async () => {
  /* Never a silent no-op: if there is nothing to copy, say so. */
  if (!pairCode) { toast('Generate a pairing code first'); return }
  const plain = pairCode.replace(/-/g, '')
  try {
    await navigator.clipboard.writeText(plain)
    toast('Pairing code copied')
  } catch {
    /* Clipboard is blocked outside a secure context. Select the code so the
       user can copy it by hand, and tell them. */
    const el = $('#pairCode')
    if (el) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
    toast('Code selected \u2014 press Ctrl/Cmd+C to copy')
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

/* Expose the switcher so admin.js can drive screen rendering. */
window.architectShowScreen = showScreen
window.architectClosePanel = closePanel
window.architectToast = toast
window.architectEsc = esc

boot()
