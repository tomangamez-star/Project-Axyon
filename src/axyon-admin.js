'use strict'
/*
 * AXYON ADMIN — moderation API for the WhatsApp bot.
 *
 * Mounted under /dashboard/api/admin* by dashboard.js, so it inherits the
 * existing password session and CSRF protection. Nothing here is reachable
 * without a signed-in dashboard session.
 *
 * Scope: everything an operator needs to moderate the bot without touching
 * WhatsApp directly — groups, players, economy, stages, floors, modes,
 * visuals, prefix and the audit log.
 */
const store = require('./axyon-store')
const items = require('./axyon-items')

const MODES = ['duel', 'solo', 'multiplayer', 'party']

function num (v, fallback = null) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

function createAxyonAdmin ({ logger }) {
  /** Full snapshot for the admin panel. */
  async function snapshot () {
    const [settings, groups, players, stages, floors, modes, visuals, log, roles, numbers] = await Promise.all([
      store.settings(),
      store.groups(),
      store.leaderboard(200),
      store.stages(),
      store.floors(),
      store.modes(),
      store.visuals(),
      store.recentLog(60),
      store.roles(),
      store.axyonNumbers()
    ])
    return {
      settings,
      groups: groups.map(g => ({
        jid: g.group_jid,
        name: g.name,
        enabled: g.enabled,
        status: g.status || (g.enabled ? 'ACTIVE' : 'DISABLED'),
        registrationId: g.registration_id,
        registrationMode: g.registration_mode || 'normal',
        features: Array.isArray(g.features) ? g.features : [],
        prefix: g.prefix,
        registeredBy: g.registered_by,
        registeredAt: g.registered_at || g.created_at,
        lastActivity: g.last_activity
      })),
      players: players.map(p => ({
        userId: p.userId,
        name: p.name,
        rank: p.rank,
        grade: p.grade,
        level: p.level,
        xp: p.xp,
        zen: p.zen,
        hp: p.hp,
        maxHp: p.maxHp,
        atk: p.atk,
        def: p.def,
        stage: p.stage,
        wins: p.wins,
        losses: p.losses,
        class: p.class
      })),
      stages: stages.map(s => ({
        ordinal: s.ordinal, name: s.name, hp: s.hp, atk: s.atk, def: s.def,
        xp: s.xp, zen: s.zen, locked: s.locked, original: s.original
      })),
      floors: floors.map(f => ({
        ordinal: f.ordinal, name: f.name, hp: f.hp, atk: f.atk, def: f.def,
        xp: f.xp, zen: f.zen, locked: f.locked, boss: f.boss
      })),
      modes: modes.map(m => ({ mode: m.mode, enabled: m.enabled, maxPlayers: m.max_players })),
      visuals: visuals.map(v => ({ mode: v.mode, url: v.url, caption: v.caption })),
      roles: roles.map(r => ({ userId: r.user_id, role: r.role })),
      numbers: numbers.map(n => ({ userId: n.user_id, mode: n.mode })),
      /* The shop catalogue, so the panel's reward pickers are built from the
       * same list the bot sells from — they cannot drift apart. */
      catalogue: items.catalogue().map(x => ({
        key: x.key, name: x.name, kind: x.kind, price: x.price, desc: x.desc
      })),
      log: log.map(l => ({
        id: l.id, actor: l.actor, action: l.action, target: l.target,
        detail: l.detail, at: l.created_at
      }))
    }
  }

  /**
   * Applies one moderation action. Returns { ok, message, ... }.
   * Every mutation is written to the audit log with the dashboard as actor.
   */
  async function act (action, input = {}) {
    const actor = 'dashboard'

    switch (action) {
      /* ------------------------------------------------------------ groups */
      case 'group-enable': {
        const g = await store.setGroupEnabled(input.jid, true)
        if (!g) return { ok: false, message: 'Group not found.' }
        await store.log(actor, 'admin_group_enable', input.jid)
        return { ok: true, message: 'Group enabled.' }
      }
      case 'group-disable': {
        const g = await store.setGroupEnabled(input.jid, false)
        if (!g) return { ok: false, message: 'Group not found.' }
        await store.log(actor, 'admin_group_disable', input.jid)
        return { ok: true, message: 'Group disabled — Architect will ignore it.' }
      }
      case 'group-remove': {
        const gone = await store.unregisterGroup(input.jid)
        if (!gone) return { ok: false, message: 'Group not found.' }
        await store.log(actor, 'admin_group_remove', input.jid)
        return { ok: true, message: 'Group unregistered.' }
      }
      case 'group-prefix': {
        const prefix = String(input.prefix || '').trim()
        if (!prefix || prefix.length > 3) return { ok: false, message: 'Prefix must be 1–3 characters.' }
        const g = await store.group(input.jid)
        if (!g) return { ok: false, message: 'Group not found.' }
        await store.setGroupPrefix(input.jid, prefix)
        await store.log(actor, 'admin_group_prefix', input.jid, { prefix })
        return { ok: true, message: `Group prefix set to ${prefix}` }
      }

      /* ----------------------------------------------------------- players */
      case 'player-reset': {
        const p = await store.resetPlayer(input.userId)
        if (!p) return { ok: false, message: 'Player not found.' }
        await store.log(actor, 'admin_player_reset', input.userId)
        return { ok: true, message: `Reset ${p.name || input.userId} to rank E, level 1.` }
      }
      case 'player-zen': {
        const amount = num(input.amount)
        if (amount === null) return { ok: false, message: 'Amount must be a number.' }
        const p = await store.player(input.userId)
        if (!p) return { ok: false, message: 'Player not found.' }
        p.zen = Math.max(0, p.zen + amount)
        await store.savePlayer(p)
        await store.log(actor, 'admin_player_zen', input.userId, { amount })
        return { ok: true, message: `${amount >= 0 ? 'Granted' : 'Removed'} ${Math.abs(amount)} Zen.` }
      }
      case 'player-heal': {
        const p = await store.player(input.userId)
        if (!p) return { ok: false, message: 'Player not found.' }
        p.hp = p.maxHp
        p.powerEnergy = p.maxPowerEnergy
        await store.savePlayer(p)
        await store.log(actor, 'admin_player_heal', input.userId)
        return { ok: true, message: 'HP and Power Energy restored.' }
      }
      case 'player-clear-battle': {
        await store.setBattle(input.userId, null)
        await store.log(actor, 'admin_player_clear_battle', input.userId)
        return { ok: true, message: 'Active battle cleared.' }
      }
      /*
       * REWARDS
       * -------
       * Items, cash and abilities can be handed out from the panel. This is the
       * "given out as rewards" half of the inventory system: the shop is how a
       * player spends Zen, this is how an operator grants stock directly.
       */
      case 'player-grant-item': {
        const entry = items.get(input.item)
        if (!entry) return { ok: false, message: 'Unknown item.' }
        const qty = Math.max(1, Math.min(99, num(input.qty, 1) || 1))
        const p = await store.player(input.userId)
        if (!p) return { ok: false, message: 'Player not found.' }
        const total = await store.addItem(input.userId, entry.key, qty)
        await store.log(actor, 'admin_grant_item', input.userId, { item: entry.key, qty })
        return { ok: true, message: `Granted ${qty}\u00d7 ${entry.name}. They now hold ${total}.` }
      }
      case 'player-grant-ability': {
        const entry = items.get(input.item)
        if (!entry || entry.kind !== 'ability') return { ok: false, message: 'Unknown ability.' }
        const p = await store.player(input.userId)
        if (!p) return { ok: false, message: 'Player not found.' }
        if (await store.inventoryQty(input.userId, entry.key) > 0) {
          return { ok: false, message: `They already own ${entry.name}.` }
        }
        await store.addItem(input.userId, entry.key, 1)
        await store.log(actor, 'admin_grant_ability', input.userId, { item: entry.key })
        return { ok: true, message: `Granted the ability ${entry.name}.` }
      }

      /* ---------------------------------------------------------- settings */
      case 'settings': {
        const patch = {}
        if (input.prefix !== undefined) {
          const prefix = String(input.prefix).trim()
          if (!prefix || prefix.length > 3) return { ok: false, message: 'Prefix must be 1–3 characters.' }
          patch.prefix = prefix
        }
        for (const key of ['xpDailyLimit', 'zenDailyLimit', 'partyMax', 'partyMin', 'selfHealPerCombat', 'classMovesPerDay', 'cardAbilitiesPerDay']) {
          if (input[key] !== undefined) {
            const n = num(input[key])
            if (n === null || n < 0) return { ok: false, message: `${key} must be a non-negative number.` }
            patch[key] = n
          }
        }
        if (input.groupRegistrationRequired !== undefined) patch.groupRegistrationRequired = !!input.groupRegistrationRequired
        if (input.duelAutoPromote !== undefined) patch.duelAutoPromote = !!input.duelAutoPromote

        /*
         * CREATORS
         * --------
         * The two names shown in every card header. AXYON is the OWNER TITLE of
         * the bot, not a creator, so it is deliberately not editable here.
         * Stored exactly as typed — no trimming of inner spacing, no title
         * casing, no reordering.
         */
        if (input.creators !== undefined) {
          const list = Array.isArray(input.creators) ? input.creators : String(input.creators).split(',')
          const clean = list.map(x => String(x ?? '').trim()).filter(Boolean)
          if (clean.length < 1 || clean.length > 4) return { ok: false, message: 'Enter between 1 and 4 creator names.' }
          if (clean.some(x => x.length > 40)) return { ok: false, message: 'Each creator name must be 40 characters or fewer.' }
          patch.creators = clean
        }
        if (input.botName !== undefined) {
          const name = String(input.botName).trim()
          if (!name || name.length > 40) return { ok: false, message: 'Bot name must be 1–40 characters.' }
          patch.botName = name
        }
        if (input.aiEnabled !== undefined) patch.aiEnabled = !!input.aiEnabled
        if (input.aiModel !== undefined) patch.aiModel = String(input.aiModel).trim().slice(0, 60)
        if (input.aiTimeoutMs !== undefined) {
          const n = num(input.aiTimeoutMs)
          if (n === null || n < 3000 || n > 30000) return { ok: false, message: 'AI timeout must be between 3000 and 30000 ms.' }
          patch.aiTimeoutMs = n
        }

        if (!Object.keys(patch).length) return { ok: false, message: 'Nothing to update.' }
        const next = await store.setSettings(patch)
        await store.log(actor, 'admin_settings', '', patch)
        return { ok: true, message: 'Settings saved.', settings: next }
      }

      /* ------------------------------------------------------------ stages */
      case 'stage-add': {
        const name = String(input.name || '').trim()
        if (!name) return { ok: false, message: 'Stage name is required.' }
        const s = await store.addStage({
          name,
          hp: num(input.hp, 80), atk: num(input.atk, 6), def: num(input.def, 3),
          xp: num(input.xp, 50), zen: num(input.zen, 80)
        })
        await store.log(actor, 'admin_stage_add', s.key, { name })
        return { ok: true, message: `Stage ${s.ordinal} added.` }
      }
      case 'stage-edit': {
        const ordinal = num(input.ordinal)
        if (!ordinal) return { ok: false, message: 'Stage number is required.' }
        const s = await store.editStage(ordinal, {
          name: input.name ? String(input.name).trim() : null,
          hp: num(input.hp), atk: num(input.atk), def: num(input.def),
          xp: num(input.xp), zen: num(input.zen)
        })
        if (!s) return { ok: false, message: 'Stage not found.' }
        await store.log(actor, 'admin_stage_edit', String(ordinal))
        return { ok: true, message: `Stage ${ordinal} updated.` }
      }
      case 'stage-lock': {
        const s = await store.lockStage(num(input.ordinal), !!input.locked)
        if (!s) return { ok: false, message: 'Stage not found.' }
        await store.log(actor, input.locked ? 'admin_stage_lock' : 'admin_stage_unlock', String(input.ordinal))
        return { ok: true, message: `Stage ${input.ordinal} ${input.locked ? 'locked' : 'unlocked'}.` }
      }
      case 'stage-remove': {
        const r = await store.removeStage(num(input.ordinal))
        if (!r.ok) return { ok: false, message: r.message }
        await store.log(actor, 'admin_stage_remove', String(input.ordinal))
        return { ok: true, message: `Stage ${input.ordinal} removed.` }
      }

      /* ------------------------------------------------------------ floors */
      case 'floor-add': {
        const name = String(input.name || '').trim()
        if (!name) return { ok: false, message: 'Floor name is required.' }
        const f = await store.addFloor({
          name,
          hp: num(input.hp, 200), atk: num(input.atk, 12), def: num(input.def, 6),
          xp: num(input.xp, 150), zen: num(input.zen, 200), boss: !!input.boss
        })
        await store.log(actor, 'admin_floor_add', f.key, { name })
        return { ok: true, message: `Floor ${f.ordinal} added.` }
      }
      case 'floor-edit': {
        const ordinal = num(input.ordinal)
        if (!ordinal) return { ok: false, message: 'Floor number is required.' }
        const f = await store.editFloor(ordinal, {
          name: input.name ? String(input.name).trim() : null,
          hp: num(input.hp), atk: num(input.atk), def: num(input.def),
          xp: num(input.xp), zen: num(input.zen)
        })
        if (!f) return { ok: false, message: 'Floor not found.' }
        await store.log(actor, 'admin_floor_edit', String(ordinal))
        return { ok: true, message: `Floor ${ordinal} updated.` }
      }
      case 'floor-lock': {
        const f = await store.lockFloor(num(input.ordinal), !!input.locked)
        if (!f) return { ok: false, message: 'Floor not found.' }
        await store.log(actor, input.locked ? 'admin_floor_lock' : 'admin_floor_unlock', String(input.ordinal))
        return { ok: true, message: `Floor ${input.ordinal} ${input.locked ? 'locked' : 'unlocked'}.` }
      }
      case 'floor-remove': {
        const f = await store.removeFloor(num(input.ordinal))
        if (!f) return { ok: false, message: 'Floor not found.' }
        await store.log(actor, 'admin_floor_remove', String(input.ordinal))
        return { ok: true, message: `Floor ${input.ordinal} removed.` }
      }

      /* ------------------------------------------------------------- modes */
      case 'mode': {
        const mode = String(input.mode || '').toLowerCase()
        if (!MODES.includes(mode)) return { ok: false, message: 'Unknown mode.' }
        const patch = {}
        if (input.enabled !== undefined) patch.enabled = !!input.enabled
        if (input.maxPlayers !== undefined) {
          const n = num(input.maxPlayers)
          if (!n || n < 2) return { ok: false, message: 'Max players must be 2 or more.' }
          patch.maxPlayers = n
        }
        const m = await store.setMode(mode, patch)
        if (mode === 'party' && patch.maxPlayers) await store.setSetting('partyMax', patch.maxPlayers)
        await store.log(actor, 'admin_mode', mode, patch)
        return { ok: true, message: `${mode} updated.`, mode: m }
      }

      /* ----------------------------------------------------------- visuals */
      case 'visual-set': {
        const mode = String(input.mode || '').trim().toLowerCase()
        const url = String(input.url || '').trim()
        if (!mode) return { ok: false, message: 'Mode is required.' }
        if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'URL must start with http:// or https://' }
        await store.setVisual(mode, url, String(input.caption || '').trim())
        await store.log(actor, 'admin_visual_set', mode, { url: url.slice(0, 80) })
        return { ok: true, message: `Visual set for ${mode}.` }
      }
      case 'visual-remove': {
        await store.clearVisual(String(input.mode || '').trim().toLowerCase())
        await store.log(actor, 'admin_visual_remove', String(input.mode || ''))
        return { ok: true, message: 'Visual removed.' }
      }

      /* ------------------------------------------------- roles and numbers */
      case 'role-add': {
        const userId = String(input.userId || '').replace(/\D/g, '')
        if (!/^\d{8,15}$/.test(userId)) return { ok: false, message: 'Enter a valid phone number.' }
        await store.addRole(userId, String(input.role || 'rhm').toLowerCase(), actor)
        await store.log(actor, 'admin_role_add', userId, { role: input.role })
        return { ok: true, message: 'RHM role granted.' }
      }
      case 'role-remove': {
        const userId = String(input.userId || '').replace(/\D/g, '')
        const gone = await store.removeRole(userId)
        if (!gone) return { ok: false, message: 'No role for that number.' }
        await store.log(actor, 'admin_role_remove', userId)
        return { ok: true, message: 'RHM role removed.' }
      }
      case 'number-add': {
        const userId = String(input.userId || '').replace(/\D/g, '')
        if (!/^\d{8,15}$/.test(userId)) return { ok: false, message: 'Enter a valid phone number.' }
        await store.addAxyonNumber(userId, actor)
        await store.log(actor, 'admin_number_add', userId)
        return { ok: true, message: 'AXYON authority granted to that number.' }
      }
      case 'number-remove': {
        const userId = String(input.userId || '').replace(/\D/g, '')
        const gone = await store.removeAxyonNumber(userId)
        if (!gone) return { ok: false, message: 'That number has no AXYON authority.' }
        await store.log(actor, 'admin_number_remove', userId)
        return { ok: true, message: 'AXYON authority removed.' }
      }

      default:
        return { ok: false, message: `Unknown action: ${action}` }
    }
  }

  return { snapshot, act }
}

module.exports = { createAxyonAdmin }
