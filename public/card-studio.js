(() => {
  const $ = id => document.getElementById(id)
  const parseRows = value => String(value || '').split('\n').map(line => {
    const at = line.lastIndexOf(':')
    return at < 0 ? { name: line.trim(), damage: 0 } : { name: line.slice(0, at).trim(), damage: Number(line.slice(at + 1).trim()) || 0 }
  }).filter(x => x.name)
  const fields = () => ({
    name: $('csName').value, version: $('csVersion').value, arc: $('csArc').value,
    cardType: $('csType').value, imageUrl: $('csImage').value, rarity: $('csRarity').value,
    percentRating: $('csPercent').value, starRating: $('csStars').value, baseDamage: $('csDamage').value,
    abilities: parseRows($('csAbilities').value), weapons: parseRows($('csWeapons').value),
    coin: $('csCoin').value, zen: $('csZen').value, claimLimit: $('csClaims').value,
    expiresAt: $('csExpiry').value ? new Date(`${$('csExpiry').value}T23:59:59`).toISOString() : null
  })
  async function api(path, body) {
    const token = localStorage.getItem('architect.token') || ''
    const csrf = window.architectCsrf?.() || ''
    const r = await fetch(`/dashboard/api/card-studio/${path}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-architect-token': token, 'x-architect-csrf': csrf }, body: body ? JSON.stringify(body) : undefined })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw Error(data.error || `HTTP ${r.status}`)
    return data
  }
  async function preview() {
    $('csError').textContent = 'Rendering…'
    try {
      const data = await api('preview', fields())
      $('csPreviewImage').src = `data:image/png;base64,${data.preview}`
      $('csPreviewImage').style.display = 'block'
      $('csCaption').textContent = data.caption
      $('csError').textContent = ''
    } catch (e) { $('csError').textContent = e.message }
  }
  async function save() {
    $('csError').textContent = 'Saving…'
    try {
      const data = await api('save', fields())
      $('csError').textContent = `Saved card #${data.card.id}. It has not been sent to WhatsApp.`
      await refresh()
    } catch (e) { $('csError').textContent = e.message }
  }
  async function refresh() {
    try {
      const data = await api('list')
      $('csSavedList').className = data.cards.length ? 'list' : 'list empty'
      $('csSavedList').innerHTML = data.cards.length ? data.cards.map(c => `<div class="list-row"><div><b>${String(c.name).replace(/[&<>"']/g, '')}</b><small>Card #${c.id} · ${new Date(c.created_at).toLocaleString()} · ${c.spawned_at ? 'Spawned' : 'Not spawned'}</small></div><button type="button" data-spawn-card="${c.id}">Spawn</button></div>`).join('') : 'No saved cards yet.'
    } catch (e) { $('csSavedList').textContent = e.message }
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-spawn-card]')
    if (!b) return
    const jid = $('csGroupJid').value.trim()
    if (!jid) { $('csError').textContent = 'Enter the target WhatsApp group JID first.'; return }
    b.disabled = true
    try { const r = await api('spawn', { id: b.dataset.spawnCard, groupJid: jid }); $('csError').textContent = r.message; await refresh() }
    catch (err) { $('csError').textContent = err.message }
    finally { b.disabled = false }
  })
  $('csPreview')?.addEventListener('click', preview)
  $('csSave')?.addEventListener('click', save)
  $('csRefresh')?.addEventListener('click', refresh)
  document.addEventListener('click', e => { if (e.target.closest('[data-goto="cardstudio"]')) refresh() })
})()
