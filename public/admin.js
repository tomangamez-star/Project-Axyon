/* AXYON ADMIN PANEL — moderation for the WhatsApp bot.
 *
 * WHY THIS WAS REWRITTEN
 * ----------------------
 * The previous version mounted exactly once, on DOMContentLoaded. If you were
 * not already signed in at that moment it returned early and never tried
 * again — so after logging in, the panel stayed hidden and every button in it
 * was unreachable. Worse, its CSRF token was captured at that same failed
 * moment, so any POST that did fire came back 403 "Security token mismatch"
 * and the error was swallowed by a toast that vanished in under three seconds.
 *
 * Now: mounting is idempotent and re-runs on the `architect:login` event the
 * dashboard fires after a successful sign-in. Every request reports failure in
 * a persistent banner as well as a toast, and every button is wired to a real
 * endpoint with its own error path.
 */
const A = (() => {
  const $ = s => document.querySelector(s)
  const $$ = s => [...document.querySelectorAll(s)]
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const nf = n => Number(n || 0).toLocaleString('en-US')

  let csrf = ''
  let data = null
  let tab = 'groups'
  let mounted = false
  let loading = false

  /* ------------------------------------------------------------- feedback */

  function toast (t) {
    const e = $('#toast')
    if (!e) return
    e.textContent = t
    e.classList.add('show')
    clearTimeout(toast._t)
    toast._t = setTimeout(() => e.classList.remove('show'), 3200)
  }

  /** Persistent error strip — a toast alone is too easy to miss. */
  function banner (message) {
    let el = $('#adminError')
    if (!el) {
      el = document.createElement('div')
      el.id = 'adminError'
      el.className = 'admin-error'
      const host = $('#adminPanel')
      if (host) host.insertBefore(el, host.firstChild)
    }
    if (!message) { el.remove(); return }
    el.innerHTML = `<b>Action failed</b><span>${esc(message)}</span><button type="button" aria-label="Dismiss">\u00d7</button>`
    el.querySelector('button').onclick = () => el.remove()
  }

  /* ------------------------------------------------------------------ api */

  async function api (path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) }
    if (options.method && options.method !== 'GET') headers['x-architect-csrf'] = csrf
    const r = await fetch(`/dashboard/api/${path}`, { credentials: 'same-origin', ...options, headers })
    const out = await r.json().catch(() => ({ error: `Invalid server response (HTTP ${r.status})` }))
    if (!r.ok) throw Error(out.error || out.message || `HTTP ${r.status}`)
    if (out.csrf) csrf = out.csrf
    return out
  }

  /** Runs one moderation action, then reloads the snapshot. */
  async function act (action, payload = {}) {
    banner('')
    try {
      const out = await api('admin/action', { method: 'POST', body: JSON.stringify({ action, ...payload }) })
      toast(out.message || 'Done')
      await load()
      return out
    } catch (e) {
      banner(e.message)
      toast(e.message)
      throw e
    }
  }

  /* ------------------------------------------------------------ rendering */

  function renderGroups () {
    const rows = data.groups || []
    if (!rows.length) return '<div class="admin-empty">No groups registered yet. Send <b>!register</b> inside a WhatsApp group.</div>'
    return `<div class="admin-scroll"><table class="admin-table"><thead><tr>
      <th>Group</th><th>JID</th><th>Prefix</th><th>State</th><th></th></tr></thead><tbody>
      ${rows.map(g => `<tr>
        <td><b>${esc(g.name || 'Unnamed')}</b></td>
        <td class="mono">${esc(g.jid)}</td>
        <td class="mono">${esc(g.prefix || data.settings.prefix)}</td>
        <td><span class="tag ${g.enabled ? 'on' : 'off'}">${g.enabled ? 'active' : 'paused'}</span></td>
        <td style="text-align:right;white-space:nowrap">
          <button class="mini" data-act="${g.enabled ? 'group-disable' : 'group-enable'}" data-jid="${esc(g.jid)}">${g.enabled ? 'Pause' : 'Resume'}</button>
          <button class="mini" data-act="group-prefix" data-jid="${esc(g.jid)}">Prefix</button>
          <button class="mini danger" data-act="group-remove" data-jid="${esc(g.jid)}">Remove</button>
        </td></tr>`).join('')}
    </tbody></table></div>`
  }

  function renderPlayers () {
    const rows = data.players || []
    if (!rows.length) return '<div class="admin-empty">No players have used <b>!arise</b> yet.</div>'
    return `<div class="admin-scroll"><table class="admin-table"><thead><tr>
      <th>Hunter</th><th>Rank</th><th class="num">Lv</th><th class="num">Zen</th><th class="num">HP</th><th class="num">W/L</th><th></th></tr></thead><tbody>
      ${rows.map(p => `<tr>
        <td><b>${esc(p.name || '\u2014')}</b><br><span class="mono">+${esc(p.userId)}</span></td>
        <td><span class="tag">${esc(p.rank)} \u00b7 G${p.grade}</span></td>
        <td class="num">${p.level}</td>
        <td class="num">${nf(p.zen)}</td>
        <td class="num">${p.hp}/${p.maxHp}</td>
        <td class="num">${p.wins}/${p.losses}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="mini" data-act="player-heal" data-user="${esc(p.userId)}">Heal</button>
          <button class="mini" data-act="player-zen" data-user="${esc(p.userId)}">Zen</button>
          <button class="mini" data-act="player-clear-battle" data-user="${esc(p.userId)}">Clear battle</button>
          <button class="mini danger" data-act="player-reset" data-user="${esc(p.userId)}">Reset</button>
        </td></tr>`).join('')}
    </tbody></table></div>`
  }

  function renderStages () {
    const rows = data.stages || []
    return `<div class="admin-scroll"><table class="admin-table"><thead><tr>
      <th>#</th><th>Stage</th><th class="num">HP</th><th class="num">ATK</th><th class="num">DEF</th><th class="num">XP</th><th class="num">Zen</th><th>State</th><th></th></tr></thead><tbody>
      ${rows.map(s => `<tr>
        <td class="num">${s.ordinal}</td><td><b>${esc(s.name)}</b></td>
        <td class="num">${s.hp}</td><td class="num">${s.atk}</td><td class="num">${s.def}</td>
        <td class="num">${s.xp}</td><td class="num">${s.zen}</td>
        <td><span class="tag ${s.locked ? 'off' : 'on'}">${s.locked ? 'locked' : 'open'}</span></td>
        <td style="text-align:right;white-space:nowrap">
          <button class="mini" data-act="stage-edit" data-ordinal="${s.ordinal}">Edit</button>
          <button class="mini" data-act="stage-lock" data-ordinal="${s.ordinal}" data-locked="${s.locked ? '0' : '1'}">${s.locked ? 'Unlock' : 'Lock'}</button>
          ${s.original ? '' : `<button class="mini danger" data-act="stage-remove" data-ordinal="${s.ordinal}">Remove</button>`}
        </td></tr>`).join('')}
    </tbody></table></div>`
  }

  function renderFloors () {
    const rows = data.floors || []
    if (!rows.length) return '<div class="admin-empty">No dungeon floors yet. Add one below.</div>'
    return `<div class="admin-scroll"><table class="admin-table"><thead><tr>
      <th>#</th><th>Floor</th><th class="num">HP</th><th class="num">ATK</th><th class="num">XP</th><th>State</th><th></th></tr></thead><tbody>
      ${rows.map(f => `<tr>
        <td class="num">${f.ordinal}</td>
        <td><b>${esc(f.name)}</b> ${f.boss ? '<span class="tag boss">boss</span>' : ''}</td>
        <td class="num">${f.hp}</td><td class="num">${f.atk}</td><td class="num">${f.xp}</td>
        <td><span class="tag ${f.locked ? 'off' : 'on'}">${f.locked ? 'locked' : 'open'}</span></td>
        <td style="text-align:right;white-space:nowrap">
          <button class="mini" data-act="floor-edit" data-ordinal="${f.ordinal}">Edit</button>
          <button class="mini" data-act="floor-lock" data-ordinal="${f.ordinal}" data-locked="${f.locked ? '0' : '1'}">${f.locked ? 'Unlock' : 'Lock'}</button>
          <button class="mini danger" data-act="floor-remove" data-ordinal="${f.ordinal}">Remove</button>
        </td></tr>`).join('')}
    </tbody></table></div>`
  }

  function renderModes () {
    const rows = data.modes || []
    return `<div class="admin-scroll"><table class="admin-table"><thead><tr>
      <th>Mode</th><th>State</th><th class="num">Max players</th><th></th></tr></thead><tbody>
      ${rows.map(m => `<tr>
        <td><b>${esc(m.mode)}</b></td>
        <td><span class="tag ${m.enabled ? 'on' : 'off'}">${m.enabled ? 'enabled' : 'disabled'}</span></td>
        <td class="num">${m.maxPlayers}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="mini" data-act="mode" data-mode="${esc(m.mode)}" data-enabled="${m.enabled ? '0' : '1'}">${m.enabled ? 'Disable' : 'Enable'}</button>
          <button class="mini" data-act="mode-max" data-mode="${esc(m.mode)}">Max</button>
        </td></tr>`).join('')}
    </tbody></table></div>`
  }

  function renderVisuals () {
    const rows = data.visuals || []
    return `<div class="admin-scroll"><table class="admin-table"><thead><tr>
      <th>Mode</th><th>URL</th><th>Caption</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map(v => `<tr>
        <td><b>${esc(v.mode)}</b></td>
        <td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v.url)}</td>
        <td>${esc(v.caption || '\u2014')}</td>
        <td style="text-align:right"><button class="mini danger" data-act="visual-remove" data-mode="${esc(v.mode)}">Remove</button></td>
      </tr>`).join('') : '<tr><td colspan="4" class="admin-empty">No visuals configured.</td></tr>'}
    </tbody></table></div>`
  }

  function renderAuthority () {
    const roles = data.roles || []
    const numbers = data.numbers || []
    return `<div class="admin-grid" style="margin-top:4px">
      <div><p class="eyebrow">AXYON NUMBERS</p>
        ${numbers.length ? `<div class="admin-scroll"><table class="admin-table"><tbody>
          ${numbers.map(n => `<tr><td class="mono">+${esc(n.userId)}</td><td><span class="tag on">${esc(n.mode)}</span></td>
          <td style="text-align:right"><button class="mini danger" data-act="number-remove" data-user="${esc(n.userId)}">Revoke</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="admin-note">No extra numbers hold AXYON authority.</p>'}
      </div>
      <div><p class="eyebrow">RHM MANAGEMENT</p>
        ${roles.length ? `<div class="admin-scroll"><table class="admin-table"><tbody>
          ${roles.map(r => `<tr><td class="mono">+${esc(r.userId)}</td><td><span class="tag">${esc(r.role)}</span></td>
          <td style="text-align:right"><button class="mini danger" data-act="role-remove" data-user="${esc(r.userId)}">Revoke</button></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="admin-note">No RHM roles granted.</p>'}
      </div>
    </div>`
  }

  function renderLog () {
    const rows = data.log || []
    if (!rows.length) return '<div class="admin-empty">No activity recorded yet.</div>'
    return `<div class="admin-scroll">${rows.map(l => `<div class="log-line">
      <time>${new Date(l.at).toISOString().slice(5, 16).replace('T', ' ')}</time>
      <b>${esc(l.action)}</b>
      <span>${esc(l.actor || '\u2014')}${l.target ? ` \u2192 ${esc(l.target)}` : ''}</span>
    </div>`).join('')}</div>`
  }

  function renderSettings () {
    const s = data.settings || {}
    return `<div class="admin-grid">
      <label class="admin-field"><small>Default prefix</small><input id="setPrefix" value="${esc(s.prefix)}" maxlength="3"></label>
      <label class="admin-field"><small>Daily XP limit</small><input id="setXp" type="number" min="0" value="${s.xpDailyLimit}"></label>
      <label class="admin-field"><small>Daily Zen limit</small><input id="setZen" type="number" min="0" value="${s.zenDailyLimit}"></label>
      <label class="admin-field"><small>Party max</small><input id="setPartyMax" type="number" min="2" value="${s.partyMax}"></label>
      <label class="admin-field"><small>Party min</small><input id="setPartyMin" type="number" min="1" value="${s.partyMin}"></label>
      <label class="admin-field"><small>Self-heals per combat</small><input id="setHeals" type="number" min="0" value="${s.selfHealPerCombat}"></label>
      <label class="admin-field"><small>Class moves per day</small><input id="setClass" type="number" min="0" value="${s.classMovesPerDay}"></label>
      <label class="admin-field"><small>Card abilities per day</small><input id="setCards" type="number" min="0" value="${s.cardAbilitiesPerDay}"></label>
      <label class="admin-field"><small>Group registration required</small>
        <select id="setReg"><option value="1"${s.groupRegistrationRequired ? ' selected' : ''}>Yes \u2014 ignore unregistered groups</option><option value="0"${!s.groupRegistrationRequired ? ' selected' : ''}>No \u2014 respond everywhere</option></select></label>
      <label class="admin-field"><small>Duel auto-promote</small>
        <select id="setDuel"><option value="1"${s.duelAutoPromote ? ' selected' : ''}>Yes \u2014 temporary admin during duels</option><option value="0"${!s.duelAutoPromote ? ' selected' : ''}>No</option></select></label>
    </div>
    <div class="admin-row"><button class="primary" id="saveSettings">Save settings</button></div>
    <p class="admin-note">The prefix applies to every group without its own override. Daily limits cap XP and Zen earned per player per day; anything above the cap is discarded, not banked.</p>`
  }

  const VIEWS = {
    groups: { title: 'Groups', body: renderGroups, extra: () => '<p class="admin-note">Pausing a group makes Architect ignore it entirely. Removing it deletes the registration \u2014 players keep their progress.</p>' },
    players: { title: 'Players', body: renderPlayers, extra: () => '<p class="admin-note">Heal restores HP and Power Energy. Zen adjusts the balance by the amount you enter (negative removes). Clear battle drops a stuck fight. Reset returns a hunter to rank E, level 1.</p>' },
    stages: { title: 'Stages', body: renderStages, extra: () => `<div class="admin-row">
        <label class="admin-field" style="flex:2"><small>New stage name</small><input id="stageName" placeholder="Shattered Spire"></label>
        <label class="admin-field"><small>HP</small><input id="stageHp" type="number" value="120"></label>
        <label class="admin-field"><small>ATK</small><input id="stageAtk" type="number" value="10"></label>
        <label class="admin-field"><small>DEF</small><input id="stageDef" type="number" value="5"></label>
        <label class="admin-field"><small>XP</small><input id="stageXp" type="number" value="90"></label>
        <label class="admin-field"><small>Zen</small><input id="stageZen" type="number" value="140"></label>
        <button class="primary" id="addStage">Add stage</button>
      </div><p class="admin-note">The original three stages cannot be removed, only edited or locked.</p>` },
    floors: { title: 'Dungeon floors', body: renderFloors, extra: () => `<div class="admin-row">
        <label class="admin-field" style="flex:2"><small>New floor name</small><input id="floorName" placeholder="Sunken Vault"></label>
        <label class="admin-field"><small>HP</small><input id="floorHp" type="number" value="240"></label>
        <label class="admin-field"><small>ATK</small><input id="floorAtk" type="number" value="14"></label>
        <label class="admin-field"><small>DEF</small><input id="floorDef" type="number" value="7"></label>
        <label class="admin-field"><small>XP</small><input id="floorXp" type="number" value="180"></label>
        <label class="admin-field"><small>Zen</small><input id="floorZen" type="number" value="240"></label>
        <label class="admin-field"><small>Boss</small><select id="floorBoss"><option value="0">No</option><option value="1">Yes</option></select></label>
        <button class="primary" id="addFloor">Add floor</button>
      </div>` },
    modes: { title: 'Modes', body: renderModes, extra: () => '<p class="admin-note">Disabling a mode hides it from players. Party max also updates the global party limit.</p>' },
    visuals: { title: 'Visuals', body: renderVisuals, extra: () => `<div class="admin-row">
        <label class="admin-field"><small>Mode</small><select id="visMode">
          <option value="arise">arise</option><option value="profile">profile</option>
          <option value="battle">battle</option><option value="boss">boss</option>
          <option value="dungeon">dungeon</option><option value="duel">duel</option></select></label>
        <label class="admin-field" style="flex:3"><small>Image / GIF / MP4 URL</small><input id="visUrl" placeholder="https://\u2026"></label>
        <label class="admin-field" style="flex:2"><small>Caption (optional)</small><input id="visCaption" placeholder="The System awakens."></label>
        <button class="primary" id="setVisual">Set visual</button>
      </div><p class="admin-note">Each mode can carry its own image, GIF or short clip. The AXYN CORE watermark stays on every message.</p>` },
    authority: { title: 'Authority', body: renderAuthority, extra: () => `<div class="admin-row">
        <label class="admin-field" style="flex:2"><small>Phone number</small><input id="authNumber" placeholder="2348012345678" inputmode="numeric"></label>
        <label class="admin-field"><small>Grant</small><select id="authKind">
          <option value="number">AXYON authority</option><option value="role">RHM management</option></select></label>
        <button class="primary" id="grantAuth">Grant</button>
      </div><p class="admin-note">AXYON numbers keep management authority even after switching to PLAYER mode. RHM is scoped and never overrides AXYON.</p>` },
    settings: { title: 'Settings', body: renderSettings, extra: () => '' },
    log: { title: 'Audit log', body: renderLog, extra: () => '<p class="admin-note">Every management action is recorded \u2014 resets, grants, stage edits and dashboard changes alike.</p>' }
  }

  function render () {
    const view = VIEWS[tab] || VIEWS.groups
    const body = $('#adminBody')
    if (!body) return
    body.innerHTML = view.body() + view.extra()
    $$('.admin-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
    wire()
  }

  /* --------------------------------------------------------------- wiring */

  function wire () {
    $$('[data-act]').forEach(b => { b.onclick = () => handle(b) })

    const addStage = $('#addStage')
    if (addStage) addStage.onclick = () => act('stage-add', {
      name: $('#stageName').value, hp: $('#stageHp').value, atk: $('#stageAtk').value,
      def: $('#stageDef').value, xp: $('#stageXp').value, zen: $('#stageZen').value
    }).catch(() => {})

    const addFloor = $('#addFloor')
    if (addFloor) addFloor.onclick = () => act('floor-add', {
      name: $('#floorName').value, hp: $('#floorHp').value, atk: $('#floorAtk').value,
      def: $('#floorDef').value, xp: $('#floorXp').value, zen: $('#floorZen').value,
      boss: $('#floorBoss').value === '1'
    }).catch(() => {})

    const setVisual = $('#setVisual')
    if (setVisual) setVisual.onclick = () => act('visual-set', {
      mode: $('#visMode').value, url: $('#visUrl').value, caption: $('#visCaption').value
    }).catch(() => {})

    const grantAuth = $('#grantAuth')
    if (grantAuth) grantAuth.onclick = () => {
      const userId = $('#authNumber').value
      const kind = $('#authKind').value
      act(kind === 'number' ? 'number-add' : 'role-add', { userId, role: 'rhm' }).catch(() => {})
    }

    const saveSettings = $('#saveSettings')
    if (saveSettings) saveSettings.onclick = () => act('settings', {
      prefix: $('#setPrefix').value,
      xpDailyLimit: $('#setXp').value,
      zenDailyLimit: $('#setZen').value,
      partyMax: $('#setPartyMax').value,
      partyMin: $('#setPartyMin').value,
      selfHealPerCombat: $('#setHeals').value,
      classMovesPerDay: $('#setClass').value,
      cardAbilitiesPerDay: $('#setCards').value,
      groupRegistrationRequired: $('#setReg').value === '1',
      duelAutoPromote: $('#setDuel').value === '1'
    }).catch(() => {})
  }

  async function handle (btn) {
    const a = btn.dataset.act
    const jid = btn.dataset.jid
    const user = btn.dataset.user
    const ordinal = btn.dataset.ordinal
    try {
      btn.disabled = true
      if (a === 'group-enable' || a === 'group-disable') return await act(a, { jid })
      if (a === 'group-remove') {
        if (!confirm('Unregister this group? Players keep their progress.')) return
        return await act(a, { jid })
      }
      if (a === 'group-prefix') {
        const prefix = prompt('Prefix for this group (1\u20133 characters):', data.settings.prefix)
        if (prefix === null) return
        return await act(a, { jid, prefix })
      }
      if (a === 'player-reset') {
        if (!confirm('Reset this hunter to rank E, level 1? This cannot be undone.')) return
        return await act(a, { userId: user })
      }
      if (a === 'player-zen') {
        const amount = prompt('Zen to add (negative to remove):', '500')
        if (amount === null) return
        return await act(a, { userId: user, amount })
      }
      if (a === 'player-heal' || a === 'player-clear-battle') return await act(a, { userId: user })
      if (a === 'stage-edit') {
        const row = (data.stages || []).find(s => String(s.ordinal) === String(ordinal))
        const hp = prompt('HP:', row.hp); if (hp === null) return
        const atk = prompt('ATK:', row.atk); if (atk === null) return
        const def = prompt('DEF:', row.def); if (def === null) return
        const xp = prompt('XP:', row.xp); if (xp === null) return
        const zen = prompt('Zen:', row.zen); if (zen === null) return
        return await act('stage-edit', { ordinal, hp, atk, def, xp, zen })
      }
      if (a === 'stage-lock') return await act(a, { ordinal, locked: btn.dataset.locked === '1' })
      if (a === 'stage-remove') {
        if (!confirm(`Remove stage ${ordinal}?`)) return
        return await act(a, { ordinal })
      }
      if (a === 'floor-edit') {
        const row = (data.floors || []).find(f => String(f.ordinal) === String(ordinal))
        const hp = prompt('HP:', row.hp); if (hp === null) return
        const atk = prompt('ATK:', row.atk); if (atk === null) return
        const def = prompt('DEF:', row.def); if (def === null) return
        const xp = prompt('XP:', row.xp); if (xp === null) return
        const zen = prompt('Zen:', row.zen); if (zen === null) return
        return await act('floor-edit', { ordinal, hp, atk, def, xp, zen })
      }
      if (a === 'floor-lock') return await act(a, { ordinal, locked: btn.dataset.locked === '1' })
      if (a === 'floor-remove') {
        if (!confirm(`Remove floor ${ordinal}?`)) return
        return await act(a, { ordinal })
      }
      if (a === 'mode') return await act('mode', { mode: btn.dataset.mode, enabled: btn.dataset.enabled === '1' })
      if (a === 'mode-max') {
        const n = prompt('Max players:', '5')
        if (!n) return
        return await act('mode', { mode: btn.dataset.mode, maxPlayers: n })
      }
      if (a === 'visual-remove') return await act(a, { mode: btn.dataset.mode })
      if (a === 'role-remove' || a === 'number-remove') {
        if (!confirm('Revoke this authority?')) return
        return await act(a, { userId: user })
      }
      banner(`No handler for "${a}" \u2014 this button is not wired.`)
    } catch (e) {
      /* act() already surfaced it; nothing more to do. */
    } finally {
      btn.disabled = false
    }
  }

  /* ----------------------------------------------------------------- boot */

  async function load () {
    if (loading) return
    loading = true
    try {
      data = await api('admin')
      render()
    } finally {
      loading = false
    }
  }

  /**
   * Idempotent mount. Safe to call on load, after login, and on retry.
   * Returns true when the panel is visible and populated.
   */
  async function mount () {
    const host = $('#adminPanel')
    if (!host) return false
    try {
      const s = await api('session')
      if (!s.authenticated) {
        host.classList.add('hidden')
        mounted = false
        return false
      }
      csrf = s.csrf || csrf
      host.classList.remove('hidden')
      if (!mounted) {
        $$('.admin-tabs button').forEach(b => {
          b.onclick = () => { tab = b.dataset.tab; render() }
        })
        mounted = true
      }
      await load()
      return true
    } catch (e) {
      banner(e.message)
      return false
    }
  }

  return { mount, load, render, banner }
})()

/* Mount on load, and again whenever the dashboard reports a successful login. */
function bootAdmin () { A.mount().catch(() => {}) }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootAdmin)
else bootAdmin()
document.addEventListener('architect:login', bootAdmin)
document.addEventListener('architect:logout', () => {
  const host = document.querySelector('#adminPanel')
  if (host) host.classList.add('hidden')
})
