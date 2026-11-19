/* AXYON ADMIN PANEL — moderation for the WhatsApp bot.
 *
 * Each moderation area is its own SCREEN (see dashboard.html), not a tab inside
 * one long scroll. This module renders into the per-screen container
 * `#adminBody-<name>` and is driven by the dashboard's screen switcher through
 * `window.architectRenderScreen`.
 *
 * Every button here is wired to a real endpoint. Failures surface in a
 * persistent banner AND a toast — never silently.
 */
const A = (() => {
  const $ = s => document.querySelector(s)
  const $$ = s => [...document.querySelectorAll(s)]
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const nf = n => Number(n || 0).toLocaleString('en-US')

  let csrf = ''
  let data = null
  let mounted = false
  let loading = false
  const rendered = new Set()

  /* ------------------------------------------------------------- feedback */

  function toast (t) {
    if (window.architectToast) return window.architectToast(t)
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
      const host = $('#app')
      if (host) host.insertBefore(el, host.firstChild)
    }
    if (!message) { el.remove(); return }
    el.innerHTML = `<b>Action failed</b><span>${esc(message)}</span><button type="button" aria-label="Dismiss">\u00d7</button>`
    el.querySelector('button').onclick = () => el.remove()
  }

  /**
   * Marks a field invalid and explains why, in place. Used before a request is
   * even sent, so an empty form never looks like a dead button.
   */
  function requireField (input, message) {
    if (!input) { banner(message); return }
    input.classList.add('field-invalid')
    input.setAttribute('aria-invalid', 'true')
    input.focus()
    banner(message)
    toast(message)
    const clear = () => {
      input.classList.remove('field-invalid')
      input.removeAttribute('aria-invalid')
      input.removeEventListener('input', clear)
    }
    input.addEventListener('input', clear)
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
    if (!rows.length) return '<div class="admin-empty">No groups registered yet. An AXYON operator can send <b>!register group normal</b> inside the target group.</div>'
    return `<div class="admin-scroll"><table class="admin-table"><thead><tr>
      <th>Group</th><th>JID</th><th>Registration</th><th>Features</th><th>Prefix</th><th>State</th><th></th></tr></thead><tbody>
      ${rows.map(g => `<tr>
        <td><b>${esc(g.name || 'Unnamed')}</b><br><small>${esc(g.registrationId || 'legacy')}</small></td>
        <td class="mono">${esc(g.jid)}</td>
        <td>${esc(g.registrationMode || 'normal')}</td>
        <td>${esc((g.features || []).join(', ') || 'none')}</td>
        <td class="mono">${esc(g.prefix || data.settings.prefix)}</td>
        <td><span class="tag ${g.status === 'ACTIVE' ? 'on' : 'off'}">${esc(g.status || (g.enabled ? 'active' : 'disabled'))}</span></td>
        <td style="text-align:right;white-space:nowrap">
          ${g.status === 'REMOVED' ? '<small>Re-register in WhatsApp to restore</small>' : `<button class="mini" data-act="${g.enabled ? 'group-disable' : 'group-enable'}" data-jid="${esc(g.jid)}">${g.enabled ? 'Pause' : 'Resume'}</button>
          <button class="mini" data-act="group-prefix" data-jid="${esc(g.jid)}">Prefix</button>
          <button class="mini danger" data-act="group-remove" data-jid="${esc(g.jid)}">Remove</button>`}
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
    </tbody></table></div>
    <div class="admin-row">
      <label class="admin-field" style="flex:2"><small>New stage name</small><input id="stageName" placeholder="Shattered Spire"></label>
      <label class="admin-field"><small>HP</small><input id="stageHp" type="number" value="120"></label>
      <label class="admin-field"><small>ATK</small><input id="stageAtk" type="number" value="10"></label>
      <label class="admin-field"><small>DEF</small><input id="stageDef" type="number" value="5"></label>
      <label class="admin-field"><small>XP</small><input id="stageXp" type="number" value="90"></label>
      <label class="admin-field"><small>Zen</small><input id="stageZen" type="number" value="140"></label>
      <button class="primary" id="addStage">Add stage</button>
    </div>`
  }

  function renderFloors () {
    const rows = data.floors || []
    const table = !rows.length
      ? '<div class="admin-empty">No dungeon floors yet. Add one below.</div>'
      : `<div class="admin-scroll"><table class="admin-table"><thead><tr>
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
    return table + `<div class="admin-row">
      <label class="admin-field" style="flex:2"><small>New floor name</small><input id="floorName" placeholder="Sunken Vault"></label>
      <label class="admin-field"><small>HP</small><input id="floorHp" type="number" value="240"></label>
      <label class="admin-field"><small>ATK</small><input id="floorAtk" type="number" value="14"></label>
      <label class="admin-field"><small>DEF</small><input id="floorDef" type="number" value="7"></label>
      <label class="admin-field"><small>XP</small><input id="floorXp" type="number" value="180"></label>
      <label class="admin-field"><small>Zen</small><input id="floorZen" type="number" value="240"></label>
      <label class="admin-field"><small>Boss</small><select id="floorBoss"><option value="0">No</option><option value="1">Yes</option></select></label>
      <button class="primary" id="addFloor">Add floor</button>
    </div>`
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
      <th>Visual</th><th>Image</th><th>Caption</th><th></th></tr></thead><tbody>
      ${rows.length ? rows.map(v => `<tr>
        <td><b>${esc(v.mode)}</b></td>
        <td>${v.hasImage ? `<span class="tag on">Uploaded ${esc(v.mimeType || 'image')}</span>` : v.url ? '<span class="tag">Legacy URL</span>' : '<span class="tag off">No image</span>'}</td>
        <td>${esc(v.caption || '\u2014')}</td>
        <td style="text-align:right"><button class="mini danger" data-act="visual-remove" data-mode="${esc(v.mode)}">Remove</button></td>
      </tr>`).join('') : '<tr><td colspan="4" class="admin-empty">No visuals configured.</td></tr>'}
    </tbody></table></div>
    <div class="admin-row" style="align-items:end;flex-wrap:wrap">
      <label class="admin-field"><small>Visual type</small><select id="visMode">
        <option value="arise">arise / welcome</option><option value="profile">profile</option>
        <option value="battle">battle</option><option value="boss">boss</option>
        <option value="dungeon">dungeon</option><option value="duel">duel</option></select></label>
      <label class="admin-field" style="flex:3;min-width:220px"><small>Choose image from your phone</small><input id="visFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif" /></label>
      <label class="admin-field" style="flex:2"><small>Caption (optional)</small><input id="visCaption" placeholder="The System awakens."></label>
      <button class="primary" id="setVisual">Upload &amp; set visual</button>
      <p class="admin-note" style="flex-basis:100%;margin:0">JPG, PNG, WEBP or GIF · Maximum 8 MB. Images are stored in the database, so they remain available after a redeploy.</p>
    </div>`
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
    </div>
    <div class="admin-row">
      <label class="admin-field" style="flex:2"><small>Phone number</small><input id="authNumber" placeholder="2348012345678" inputmode="numeric"></label>
      <label class="admin-field"><small>Grant</small><select id="authKind">
        <option value="number">AXYON authority</option><option value="role">RHM management</option></select></label>
      <button class="primary" id="grantAuth">Grant</button>
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
    const creators = Array.isArray(s.creators) && s.creators.length ? s.creators : ['Lil Clutch', 'Montai']
    return `
    <div class="panel">
      <div class="panel-head"><div><p class="eyebrow">IDENTITY</p><h3>Creators</h3><p class="muted">These two names appear in the credit line of every card the bot sends. They are stored exactly as you type them.</p></div></div>
      <div class="admin-grid">
        <label class="admin-field"><small>Creator one</small><input id="setCreator1" value="${esc(creators[0] || '')}" maxlength="40" placeholder="Lil Clutch"></label>
        <label class="admin-field"><small>Creator two</small><input id="setCreator2" value="${esc(creators[1] || '')}" maxlength="40" placeholder="Montai"></label>
        <label class="admin-field"><small>Bot name</small><input id="setBotName" value="${esc(s.botName || 'Architect')}" maxlength="40"></label>
      </div>
      <p class="admin-note"><b>AXYON</b> is the owner title of the bot &mdash; it is not a creator credit and is not edited here.</p>
      <div class="admin-row"><button class="primary" id="saveCreators">Save creators</button></div>
    </div>

    <div class="panel">
      <div class="panel-head"><div><p class="eyebrow">ASSISTANT</p><h3>AI helper</h3><p class="muted">Answers questions about the bot when it is @-mentioned or replied to. It explains commands; it cannot run them.</p></div></div>
      <div class="admin-grid">
        <label class="admin-field"><small>Assistant enabled</small>
          <select id="setAi"><option value="1"${s.aiEnabled !== false ? ' selected' : ''}>Yes \u2014 answer mentions and replies</option><option value="0"${s.aiEnabled === false ? ' selected' : ''}>No \u2014 stay silent</option></select></label>
        <label class="admin-field"><small>Model override (optional)</small><input id="setAiModel" value="${esc(s.aiModel || '')}" maxlength="60" placeholder="leave blank for default"></label>
        <label class="admin-field"><small>Timeout (ms)</small><input id="setAiTimeout" type="number" min="3000" max="30000" step="500" value="${s.aiTimeoutMs || 12000}"></label>
      </div>
      <p class="admin-note">Public AI routes are tried first. If they fail, the bot uses <code>GROQ_API_KEY</code> from the environment. If nothing works it sends one short line &mdash; never an error.</p>
      <div class="admin-row"><button class="primary" id="saveAi">Save assistant</button></div>
    </div>

    <div class="panel">
      <div class="panel-head"><div><p class="eyebrow">GAMEPLAY</p><h3>Limits</h3></div></div>
    <div class="admin-grid">
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
    </div>`
  }

  /*
   * SHOP & INVENTORY
   * ----------------
   * Two halves on one screen:
   *   - the catalogue, read from the same module the bot sells from
   *   - a reward desk that grants an item or an ability to a chosen player
   *
   * The player picker is a real <select> built from the snapshot, so a grant
   * can never be sent with an empty or mistyped id.
   */
  function renderShop () {
    const rows = data.catalogue || []
    const players = data.players || []
    const items = rows.filter(x => x.kind === 'item')
    const abilities = rows.filter(x => x.kind === 'ability')

    const table = list => `<div class="admin-scroll"><table class="admin-table"><thead><tr>
        <th>Item</th><th>Effect</th><th class="num">Price</th><th></th></tr></thead><tbody>
        ${list.map(x => `<tr>
          <td><b>${esc(x.name)}</b><br><span class="mono">${esc(x.key)}</span></td>
          <td>${esc(x.desc)}</td>
          <td class="num">${nf(x.price)}</td>
          <td style="text-align:right"><button class="mini" data-act="grant-item" data-item="${esc(x.key)}">Grant</button></td>
        </tr>`).join('')}
      </tbody></table></div>`

    return `
      <div class="admin-card">
        <h3>Reward desk</h3>
        <p class="muted">Grants go straight into the player's inventory &mdash; the same stock <code>!use</code> consumes.</p>
        <div class="admin-grid">
          <label class="admin-field"><small>Player</small>
            <select id="grantUser">${players.length
              ? players.map(p => `<option value="${esc(p.userId)}">${esc(p.name || 'Unnamed')} &middot; +${esc(p.userId)}</option>`).join('')
              : '<option value="">No players yet</option>'}</select></label>
          <label class="admin-field"><small>Item or ability</small>
            <select id="grantItem">${rows.map(x => `<option value="${esc(x.key)}">${esc(x.name)} (${esc(x.kind)})</option>`).join('')}</select></label>
          <label class="admin-field"><small>Quantity</small><input id="grantQty" type="number" min="1" max="99" value="1"></label>
        </div>
        <div class="admin-row"><button class="primary" id="doGrant">Grant reward</button></div>
      </div>

      <div class="admin-card">
        <h3>Consumables</h3>
        ${items.length ? table(items) : '<div class="admin-empty">No consumables in the catalogue.</div>'}
      </div>

      <div class="admin-card">
        <h3>Abilities</h3>
        <p class="muted">Permanent unlocks. A player owns each one once.</p>
        ${abilities.length ? table(abilities) : '<div class="admin-empty">No abilities in the catalogue.</div>'}
      </div>`
  }

  const VIEWS = {
    groups: renderGroups,
    players: renderPlayers,
    shop: renderShop,
    stages: renderStages,
    floors: renderFloors,
    modes: renderModes,
    visuals: renderVisuals,
    authority: renderAuthority,
    settings: renderSettings,
    log: renderLog
  }

  /** Renders one screen's body into its own container. */
  function renderScreen (name) {
    const view = VIEWS[name]
    if (!view) return false
    const host = $(`#adminBody-${name}`)
    if (!host) return false
    if (!data) { host.innerHTML = '<div class="admin-empty">Loading\u2026</div>'; return false }
    host.innerHTML = view()
    wire(host)
    rendered.add(name)
    return true
  }

  /* --------------------------------------------------------------- wiring */

  function wire (host) {
    host.querySelectorAll('[data-act]').forEach(b => { b.onclick = () => handle(b) })

    const addStage = host.querySelector('#addStage')
    if (addStage) addStage.onclick = () => {
      const name = host.querySelector('#stageName').value.trim()
      if (!name) return requireField(host.querySelector('#stageName'), 'Give the stage a name first.')
      act('stage-add', {
        name, hp: host.querySelector('#stageHp').value,
        atk: host.querySelector('#stageAtk').value, def: host.querySelector('#stageDef').value,
        xp: host.querySelector('#stageXp').value, zen: host.querySelector('#stageZen').value
      }).catch(() => {})
    }

    const addFloor = host.querySelector('#addFloor')
    if (addFloor) addFloor.onclick = () => {
      const name = host.querySelector('#floorName').value.trim()
      if (!name) return requireField(host.querySelector('#floorName'), 'Give the floor a name first.')
      act('floor-add', {
        name, hp: host.querySelector('#floorHp').value,
        atk: host.querySelector('#floorAtk').value, def: host.querySelector('#floorDef').value,
        xp: host.querySelector('#floorXp').value, zen: host.querySelector('#floorZen').value,
        boss: host.querySelector('#floorBoss').value === '1'
      }).catch(() => {})
    }

    const setVisual = host.querySelector('#setVisual')
    if (setVisual) setVisual.onclick = async () => {
      const fileInput = host.querySelector('#visFile')
      const file = fileInput?.files?.[0]
      if (!file) return requireField(fileInput, 'Choose an image from your phone first.')
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) return requireField(fileInput, 'Choose a JPG, PNG, WEBP or GIF image.')
      if (file.size > 8 * 1024 * 1024) return requireField(fileInput, 'Image must be 8 MB or smaller.')
      banner('')
      setVisual.disabled = true
      setVisual.textContent = 'Uploading…'
      try {
        const form = new FormData()
        form.append('mode', host.querySelector('#visMode').value)
        form.append('caption', host.querySelector('#visCaption').value)
        form.append('image', file, file.name)
        const response = await fetch('/dashboard/api/visual-upload', {
          method: 'POST', credentials: 'same-origin', body: form,
          headers: { 'x-architect-csrf': csrf }
        })
        const out = await response.json().catch(() => ({ error: `Invalid server response (HTTP ${response.status})` }))
        if (!response.ok) throw Error(out.error || out.message || `HTTP ${response.status}`)
        toast(out.message || 'Visual uploaded')
        fileInput.value = ''
        await load()
      } catch (e) { banner(e.message); toast(e.message) }
      finally { setVisual.disabled = false; setVisual.textContent = 'Upload & set visual' }
    }

    const grantAuth = host.querySelector('#grantAuth')
    if (grantAuth) grantAuth.onclick = () => {
      const userId = host.querySelector('#authNumber').value.replace(/\D/g, '')
      if (!/^\d{8,15}$/.test(userId)) return requireField(host.querySelector('#authNumber'), 'Enter a phone number in international format, digits only.')
      const kind = host.querySelector('#authKind').value
      act(kind === 'number' ? 'number-add' : 'role-add', { userId, role: 'rhm' }).catch(() => {})
    }

    const saveSettings = host.querySelector('#saveSettings')
    if (saveSettings) saveSettings.onclick = () => act('settings', {
      prefix: host.querySelector('#setPrefix').value,
      xpDailyLimit: host.querySelector('#setXp').value,
      zenDailyLimit: host.querySelector('#setZen').value,
      partyMax: host.querySelector('#setPartyMax').value,
      partyMin: host.querySelector('#setPartyMin').value,
      selfHealPerCombat: host.querySelector('#setHeals').value,
      classMovesPerDay: host.querySelector('#setClass').value,
      cardAbilitiesPerDay: host.querySelector('#setCards').value,
      groupRegistrationRequired: host.querySelector('#setReg').value === '1',
      duelAutoPromote: host.querySelector('#setDuel').value === '1'
    }).catch(() => {})

    /* Creators — saved exactly as typed, no casing or trimming of inner text. */
    const saveCreators = host.querySelector('#saveCreators')
    if (saveCreators) saveCreators.onclick = () => {
      const one = host.querySelector('#setCreator1')
      const two = host.querySelector('#setCreator2')
      const names = [one.value, two.value].map(x => x.trim()).filter(Boolean)
      if (!names.length) return requireField(one, 'Enter at least one creator name.')
      return act('settings', {
        creators: names,
        botName: host.querySelector('#setBotName').value
      }).catch(() => {})
    }

    const saveAi = host.querySelector('#saveAi')
    if (saveAi) saveAi.onclick = () => act('settings', {
      aiEnabled: host.querySelector('#setAi').value === '1',
      aiModel: host.querySelector('#setAiModel').value,
      aiTimeoutMs: host.querySelector('#setAiTimeout').value
    }).catch(() => {})

    /* Reward desk — one button, one real action. */
    const doGrant = host.querySelector('#doGrant')
    if (doGrant) doGrant.onclick = () => {
      const userId = host.querySelector('#grantUser').value
      const item = host.querySelector('#grantItem').value
      const qty = host.querySelector('#grantQty').value
      if (!userId) return requireField(host.querySelector('#grantUser'), 'No player selected — nobody has used !arise yet.')
      if (!item) return requireField(host.querySelector('#grantItem'), 'Pick an item to grant.')
      const entry = (data.catalogue || []).find(x => x.key === item)
      const action = entry && entry.kind === 'ability' ? 'player-grant-ability' : 'player-grant-item'
      act(action, { userId, item, qty }).catch(() => {})
    }
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
      if (a === 'grant-item') {
        /* The per-row Grant button uses the reward desk's player picker, so the
         * operator chooses the item from the table and the player from the
         * select above — no prompt, no free-text id. */
        const picker = $('#grantUser')
        const userId = picker ? picker.value : ''
        if (!userId) return requireField(picker, 'Choose a player in the reward desk first.')
        const entry = (data.catalogue || []).find(x => x.key === btn.dataset.item)
        const action = entry && entry.kind === 'ability' ? 'player-grant-ability' : 'player-grant-item'
        return await act(action, { userId, item: btn.dataset.item, qty: 1 })
      }
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
      /* act() already surfaced it. */
    } finally {
      btn.disabled = false
    }
  }

  /* ------------------------------------------------------------ help list */

  async function loadCommands () {
    const host = $('#helpCommands')
    if (!host) return
    try {
      const out = await api('commands')
      const rows = out.commands || []
      if (!rows.length) { host.innerHTML = '<p class="admin-empty">No commands registered.</p>'; return }
      host.innerHTML = rows.map(c => `<div class="cmd-card"><code>${esc(c.usage)}</code><p>${esc(c.desc)}</p><span class="sec">${esc(c.section)}</span></div>`).join('')
    } catch (e) {
      host.innerHTML = `<p class="admin-empty">Could not load commands: ${esc(e.message)}</p>`
    }
  }

  /* ----------------------------------------------------------------- boot */

  async function load () {
    if (loading) return
    loading = true
    try {
      data = await api('admin')
      /* Re-render only the screens already visited, so switching stays instant. */
      for (const name of rendered) renderScreen(name)
    } finally {
      loading = false
    }
  }

  /** Called by the dashboard's screen switcher on every screen change. */
  async function renderFor (name) {
    if (name === 'help') { await loadCommands(); return }
    /* Feedback is public: it renders without the admin snapshot, so a guest
     * (or a signed-out visitor) can use it. */
    if (name === 'feedback') {
      if (window.architectLoadFeedback) await window.architectLoadFeedback()
      if (window.architectLoadInbox) await window.architectLoadInbox()
      return
    }
    if (!VIEWS[name]) return
    if (!data) {
      try { await load() } catch (e) { banner(e.message); return }
    }
    renderScreen(name)
  }

  async function mount () {
    try {
      const s = await api('session')
      if (!s.authenticated) { mounted = false; return false }
      csrf = s.csrf || csrf
      mounted = true
      await load()
      return true
    } catch (e) {
      banner(e.message)
      return false
    }
  }

  return { mount, load, renderFor, banner, loadCommands }
})()

/* The dashboard calls this on every screen switch. */
window.architectRenderScreen = name => { A.renderFor(name).catch(() => {}) }

function bootAdmin () { A.mount().catch(() => {}) }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootAdmin)
else bootAdmin()
document.addEventListener('architect:login', bootAdmin)
document.addEventListener('architect:logout', () => { A.banner('') })
