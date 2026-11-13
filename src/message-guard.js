'use strict'
/*
 * MESSAGE GUARD — decides whether an upsert is worth routing at all.
 *
 * THE BUG THIS FIXES
 * ------------------
 * The previous guard admitted a `fromMe` message only when it matched a
 * hardcoded list of legacy slash commands (`/start`, `/balance`, ...) or a
 * legacy button id. The new RPG uses `!` and `!arise`, neither of which was in
 * that list — so every command sent from the connected account was dropped
 * before the router ever saw it. That is why `!arise` "did nothing".
 *
 * The rule is now prefix-driven instead of list-driven: if the text starts
 * with the active prefix, it is a command, whoever sent it. Ordinary outgoing
 * chatter is still ignored, so the bot never answers its own conversation.
 */

/** Button ids this build can emit. Kept in one place so the guard and the
 *  router cannot disagree about what counts as a tap. */
const BUTTON_PREFIXES = ['ax_', 'adm_']

function clean (t) {
  return String(t || '')
    .replace(/[\u200b-\u200f\u2060\ufeff\ufe0f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
}

function visibleText (c = {}) {
  return String(
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.buttonsResponseMessage?.selectedDisplayText ||
    c.templateButtonReplyMessage?.selectedDisplayText ||
    c.listResponseMessage?.title ||
    ''
  ).trim()
}

/** Reads the id out of a native-flow (interactive) button tap. */
function nativeButton (c = {}) {
  const raw = c.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
  if (!raw) return { id: '', text: '' }
  try {
    const v = JSON.parse(raw)
    return {
      id: String(v.id || v.button_id || v.selected_id || ''),
      text: String(v.display_text || v.title || v.text || '')
    }
  } catch { return { id: '', text: '' } }
}

function isButtonId (id) {
  return typeof id === 'string' && BUTTON_PREFIXES.some(p => id.startsWith(p))
}

/**
 * Resolves a button tap to its id, or null.
 * Accepts native-flow taps, quick-reply taps and list selections.
 */
function resolveButtonId (c = {}) {
  const n = nativeButton(c)
  const candidates = [
    n.id,
    c.buttonsResponseMessage?.selectedButtonId,
    c.templateButtonReplyMessage?.selectedId,
    c.listResponseMessage?.singleSelectReply?.selectedRowId
  ]
  for (const x of candidates) if (isButtonId(x)) return x
  return null
}

function isKnownButtonInteraction (c = {}) { return !!resolveButtonId(c) }

/**
 * True when the text is a command under the given prefix.
 * `!arise`, `!help battle`, `!arise@12345` all qualify.
 */
function isCommandText (c = {}, prefix = '!') {
  const raw = visibleText(c)
  if (!raw || !prefix) return false
  if (!raw.startsWith(prefix)) return false
  const rest = raw.slice(prefix.length).trim()
  return rest.length > 0
}

/**
 * The gate.
 *
 * @param content  normalised message content
 * @param opts.fromMe  the message came from the connected account itself
 * @param opts.type    'notify' (live) or 'append' (history sync)
 * @param opts.prefix  the active command prefix
 */
function shouldHandleUpsert (content = {}, opts = {}) {
  const { fromMe = false, type = 'notify', prefix = '!' } = opts
  const button = isKnownButtonInteraction(content)
  const command = isCommandText(content, prefix)

  // A command or a button tap is always worth routing — including from the
  // connected account, which is the whole point of this fix.
  if (button || command) return type === 'notify' || type === 'append'

  // Anything else: only live incoming messages, never our own chatter and
  // never replayed history.
  if (fromMe) return false
  return type === 'notify'
}

/**
 * FLOOD CONTROL — scoped per chat AND per sender.
 *
 * WHAT WAS WRONG
 * --------------
 * The old limiter keyed only on the sender and counted every message that
 * reached it, including the bot's own outgoing messages. Three consequences,
 * all of which the operator saw as "the easy-there warning fires everywhere":
 *
 *   1. The bot's own replies counted against the sender, so a single command
 *      that produced a few messages could trip the warning on the next one.
 *   2. The key ignored the chat, so three commands in one group muted the same
 *      person in every other group and in DMs.
 *   3. Three messages in five seconds is ordinary conversation, not spam.
 *
 * WHAT IT DOES NOW
 * ----------------
 *   - key = chat + sender, so each conversation is independent
 *   - `fromMe` messages are never counted and never warned about
 *   - the window is 10 s and the allowance is 6, which no human conversation
 *     reaches but a scripted flood does
 *   - the warning is emitted at most once per mute window, not on every
 *     suppressed message
 */
class ReplyRateLimiter {
  constructor ({ maxReplies = 6, windowMs = 10000, minMuteMs = 4000, maxMuteMs = 8000 } = {}) {
    this.users = new Map()
    this.maxReplies = maxReplies
    this.windowMs = windowMs
    this.minMuteMs = minMuteMs
    this.maxMuteMs = maxMuteMs
  }

  /** Chat + sender. Two different groups are two different buckets. */
  key (m) {
    const k = m?.key || {}
    const chat = String(k.remoteJid || k.remoteJidAlt || 'unknown').split(':')[0]
    const sender = String(k.participantAlt || k.participant || k.remoteJidAlt || k.remoteJid || 'unknown')
      .split(':')[0].split('@')[0]
    return `${chat}|${sender}`
  }

  check (m) {
    /* The bot's own messages are never spam and never counted. */
    if (m?.key?.fromMe) return { allowed: true, warn: false }

    const now = Date.now()
    const k = this.key(m)
    let s = this.users.get(k) || { times: [], mutedUntil: 0, warned: false }

    if (s.mutedUntil > now) {
      /* Already muted: stay quiet, and do not warn twice for one window. */
      return { allowed: false, warn: false, remainingMs: s.mutedUntil - now }
    }
    if (s.mutedUntil) s = { times: [], mutedUntil: 0, warned: false }

    s.times = s.times.filter(t => now - t <= this.windowMs)
    if (s.times.length >= this.maxReplies) {
      const d = this.minMuteMs + Math.floor(Math.random() * (this.maxMuteMs - this.minMuteMs + 1))
      s.mutedUntil = now + d
      s.warned = true
      this.users.set(k, s)
      return { allowed: false, warn: true, durationMs: d }
    }
    s.times.push(now)
    this.users.set(k, s)
    return { allowed: true, warn: false }
  }

  /** Drops buckets that have gone quiet, so the map cannot grow forever. */
  prune (now = Date.now()) {
    for (const [k, s] of this.users) {
      const last = s.times[s.times.length - 1] || 0
      if (s.mutedUntil < now && now - last > this.windowMs * 6) this.users.delete(k)
    }
  }
}

module.exports = {
  resolveButtonId,
  isKnownButtonInteraction,
  isCommandText,
  shouldHandleUpsert,
  visibleText,
  clean,
  ReplyRateLimiter,
  BUTTON_PREFIXES
}
