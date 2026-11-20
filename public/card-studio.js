(() => {
  const $ = id => document.getElementById(id)
  const parseRows = value => String(value || '').split('\n').map(line => {
    const at = line.lastIndexOf(':')
    return at < 0 ? { name: line.trim(), damage: 0 } : { name: line.slice(0, at).trim(), damage: Number(line.slice(at + 1).trim()) || 0 }
  }).filter(x => x.name)
  // Mobile browsers can fail when the same local File is read again after its
  // first successful preview. Cache the data URL by File object and share an
  // in-flight read between the change handler and Preview/Save submissions.
  const artworkCache = new WeakMap()
  const artworkReads = new WeakMap()
  const readSelectedArtwork = async (file = $('csImageFile')?.files?.[0]) => {
    if (!file) return ''
    if (file.size > 8 * 1024 * 1024) throw Error('Artwork must be 8 MB or smaller.')
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw Error('Choose a PNG, JPEG, GIF or WebP image.')

    const cached = artworkCache.get(file)
    if (cached) return cached
    const pending = artworkReads.get(file)
    if (pending) return pending

    const readPromise = new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const data = String(reader.result || '')
        if (!data.startsWith('data:image/')) {
          reject(Error('The selected artwork could not be read. Please choose the file again.'))
          return
        }
        resolve(data)
      }
      reader.onerror = () => reject(Error('The selected artwork could not be read. Please choose the file again.'))
      reader.onabort = () => reject(Error('Artwork reading was interrupted. Please choose the file again.'))
      reader.readAsDataURL(file)
    })
    artworkReads.set(file, readPromise)
    try {
      const data = await readPromise
      artworkCache.set(file, data)
      return data
    } finally {
      if (artworkReads.get(file) === readPromise) artworkReads.delete(file)
    }
  }
  const fields = async () => ({
    // Read the actual file input at submit time. Do not depend on a prior change event
    // having completed (mobile browsers can dispatch it late or restore the input).
    imageData: await readSelectedArtwork(), name: $('csName').value, version: $('csVersion').value, arc: $('csArc').value,
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
      const data = await api('preview', await fields())
      $('csPreviewImage').src = `data:image/png;base64,${data.preview}`
      $('csPreviewImage').style.display = 'block'
      $('csCaption').textContent = data.caption
      $('csError').textContent = ''
    } catch (e) { $('csError').textContent = e.message }
  }
  async function save() {
    $('csError').textContent = 'Saving…'
    try {
      const data = await api('save', await fields())
      $('csError').textContent = `Saved card #${data.card.id}. It has not been sent to WhatsApp.`
      await refresh()
    } catch (e) { $('csError').textContent = e.message }
  }
  async function refresh() {
    try {
      const data = await api('list')
      $('csSavedList').className = data.cards.length ? 'list' : 'list empty'
      $('csSavedList').innerHTML = data.cards.length ? data.cards.map(c => `<div class="list-row"><div><b>${String(c.name).replace(/[&<>"']/g, '')}</b><small>Card #${c.id} · ${new Date(c.created_at).toLocaleString()} · ${c.spawned_at ? 'Spawned' : 'Not spawned'} · Claims ${c.claim_count || 0}/${c.claim_limit || 30}${c.claim_code ? ' · Code #' + c.claim_code : ''}</small></div><button type="button" data-spawn-card="${c.id}">Spawn</button></div>`).join('') : 'No saved cards yet.'
      try {
        const groups = await api('groups')
        const select = $('csGroupSelect')
        const current = select.value
        select.innerHTML = groups.groups.length ? '<option value="">Select a registered group…</option>' + groups.groups.map(g => `<option value="${g.jid}">${String(g.name).replace(/[&<>"']/g, '')}</option>`).join('') : '<option value="">No active registered groups available</option>'
        if (groups.groups.some(g => g.jid === current)) select.value = current
      } catch (groupError) { $('csGroupSelect').innerHTML = `<option value="">${String(groupError.message || 'Could not load registered groups').replace(/[&<>"']/g, '')}</option>` }
    } catch (e) { $('csSavedList').textContent = e.message }
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-spawn-card]')
    if (!b) return
    const jid = String($('csGroupSelect')?.value || '').trim()
    if (!jid) { $('csError').textContent = 'Select an active registered WhatsApp group first.'; return }
    b.disabled = true
    try { const r = await api('spawn', { id: b.dataset.spawnCard, groupJid: jid }); $('csError').textContent = r.message; await refresh() }
    catch (err) { $('csError').textContent = err.message }
    finally { b.disabled = false }
  })
  $('csImageFile')?.addEventListener('change', async e => {
    const file = e.target.files?.[0]
    if (!file) { $('csArtworkThumb').style.display='none'; return }
    try {
      const previewData = await readSelectedArtwork(file)
      $('csArtworkThumb').src = previewData
      $('csArtworkThumb').style.display = 'block'
      $('csError').textContent = `Artwork selected: ${file.name}`
    } catch (error) {
      e.target.value = ''
      $('csArtworkThumb').style.display = 'none'
      $('csError').textContent = error.message
    }
  })
  $('csComplete')?.addEventListener('click', async () => {
    $('csError').textContent='Searching character details and filling empty fields…'
    try {
      const data = await api('complete', {fields:await fields()})
      const f=data.fields || {}; const set=(id,v)=>{ if(v!==undefined && v!==null && $(id).value==='') $(id).value=String(v) }
      set('csName',f.name); set('csImage',f.imageUrl); set('csVersion',f.version); set('csArc',f.arc); set('csDamage',f.baseDamage); set('csCoin',f.coin); set('csZen',f.zen); set('csPercent',f.percentRating); set('csStars',f.starRating); set('csRarity',f.rarity)
      if (Array.isArray(f.abilities) && !$('csAbilities').value.trim()) $('csAbilities').value=f.abilities.map(x=>`${x.name} : ${x.damage}`).join('\n')
      if (Array.isArray(f.weapons) && !$('csWeapons').value.trim()) $('csWeapons').value=f.weapons.map(x=>`${x.name} : ${x.damage}`).join('\n')
      $('csError').textContent=(data.note ? `${data.note} ` : '') + 'Completed empty fields only.'
    } catch(e) { $('csError').textContent=e.message }
  })
  $('csPreview')?.addEventListener('click', preview)
  $('csSave')?.addEventListener('click', save)
  $('csRefresh')?.addEventListener('click', refresh)
  document.addEventListener('click', e => { if (e.target.closest('[data-goto="cardstudio"]')) refresh() })
})()
