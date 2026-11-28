'use strict'
/*
 * IDENTITY — one place that answers "who sent this?" and "what did they type?".
 *
 * The old build had these helpers buried inside the legacy economy router,
 * which meant every new module had to import the old command system just to
 * read a phone number. They live here now, with no legacy dependency.
 */
const { norm } = require('./access')

function jidsFromKey (key = {}) {
  return [...new Set([key.participantAlt, key.remoteJidAlt, key.participant, key.remoteJid].filter(Boolean).map(String))]
}

function numberFromJid (jid) { return norm(String(jid || '').split(':')[0].split('@')[0]) }
function isPhoneJid (jid) { return /@(s\.whatsapp\.net|hosted)$/i.test(String(jid || '')) }
function isLidJid (jid) { return /@(lid|hosted\.lid)$/i.test(String(jid || '')) }

/**
 * Resolves the sender to a bare phone number.
 *
 * WhatsApp now delivers many messages with a LID (a privacy id) instead of a
 * phone JID. When that happens we ask Baileys to map it back to the real
 * number, because every stored player key is a phone number.
 */
async function resolveMessageUserId (sock, message = {}) {
  const key = message.key || {}
  const mapping = sock?.signalRepository?.lidMapping

  /*
   * A fromMe message is authored by the connected WhatsApp account, not by
   * key.remoteJid. In a DM remoteJid is the recipient; in a group it is the
   * group itself. Treating either as the sender can create a player under the
   * wrong ID and makes !arise appear to do nothing for the real account.
   */
  if (key.fromMe) {
    const selfJids = [sock?.user?.id, sock?.user?.jid, sock?.user?.lid]
      .filter(Boolean).map(String)
    const selfPhone = selfJids.find(isPhoneJid)
    if (selfPhone) return numberFromJid(selfPhone)

    const selfLids = selfJids.filter(isLidJid)
    if (mapping?.getPNForLID) {
      for (const lid of selfLids) {
        try {
          const pn = await mapping.getPNForLID(lid)
          if (pn) return numberFromJid(pn)
        } catch { /* retain the LID fallback below */ }
      }
    }
    if (selfLids.length) return numberFromJid(selfLids[0])
  }

  const jids = jidsFromKey(key)
  const phone = jids.find(isPhoneJid)
  if (phone) return numberFromJid(phone)
  if (mapping?.getPNForLID) {
    for (const lid of jids.filter(isLidJid)) {
      try {
        const pn = await mapping.getPNForLID(lid)
        if (!pn) continue
        if (String(key.remoteJid || '').endsWith('@g.us')) key.participantAlt = key.participantAlt || pn
        else key.remoteJidAlt = key.remoteJidAlt || pn
        return numberFromJid(pn)
      } catch { /* fall through to the raw jid */ }
    }
  }
  return numberFromJid(jids[0])
}

/** Synchronous best-effort id, used where no socket is available. */
function canonicalUserId (key = {}) {
  const candidates = [key.participantAlt, key.remoteJidAlt, key.participant, key.remoteJid].filter(Boolean)
  const jid = candidates.find(v => String(v).endsWith('@s.whatsapp.net')) || candidates[0] || ''
  return String(jid).split(':')[0].split('@')[0]
}

function displayName (m) { return String(m?.pushName || '').trim() }

/** The id of the person a message is replying to, if any. */
function quotedUserId (content = {}) {
  const x = content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo || {}
  const jid = x.participantAlt || x.participant
  return jid ? String(jid).split(':')[0].split('@')[0] : null
}

/** First @-mentioned number in the message, if any. */
function mentionedId (content = {}) {
  const ci = content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo || {}
  const jid = (ci.mentionedJid || [])[0] || ci.participant
  return jid ? String(jid).split(':')[0].split('@')[0] : null
}

/** Resolve a mentioned WhatsApp LID to the phone-number key used by AXYON. */
async function resolveMentionedId (sock, content = {}) {
  const ci = content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo || {}
  const raw = (ci.mentionedJid || [])[0] || ci.participant
  if (!raw) return null
  const jid = String(raw).split(':')[0]
  if (/@s\.whatsapp\.net$/i.test(jid)) return numberFromJid(jid)
  if (/@(?:hosted\.)?lid$/i.test(jid)) {
    const mapping = sock?.signalRepository?.lidMapping
    if (mapping?.getPNForLID) {
      try {
        const pn = await mapping.getPNForLID(jid)
        if (pn) return numberFromJid(pn)
      } catch { /* retain the raw id; the caller can report not registered */ }
    }
    return null
  }
  return numberFromJid(jid)
}

/** Raw visible text of a message, whatever shape it arrived in. */
function visibleText (content = {}) {
  return String(
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    ''
  ).trim()
}

/**
 * Splits `<prefix>command args...` into parts.
 * Returns null when the text does not start with the prefix.
 */
function commandParts (content = {}, prefix = '!') {
  const raw = visibleText(content)
  if (!raw || !raw.startsWith(prefix)) return null
  const parts = raw.slice(prefix.length).split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  return { command: parts[0].toLowerCase().split('@')[0], args: parts.slice(1), raw }
}


/** Resolve the mentioned or replied-to player to AXYON's canonical phone key. */
async function resolveTargetUserId (sock, content = {}) {
  const ci = content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo ||
    content?.documentMessage?.contextInfo || {}
  const raw = (ci.mentionedJid || [])[0] || ci.participantAlt || ci.participant
  if (!raw) return null
  const jid = String(raw).split(':')[0]
  if (/@s\.whatsapp\.net$/i.test(jid)) return numberFromJid(jid)
  if (/@(?:hosted\.)?lid$/i.test(jid)) {
    const mapping = sock?.signalRepository?.lidMapping
    if (mapping?.getPNForLID) {
      try {
        const pn = await mapping.getPNForLID(jid)
        if (pn) return numberFromJid(pn)
      } catch {}
    }
    return null
  }
  return numberFromJid(jid)
}

module.exports = {
  resolveMessageUserId,
  jidsFromKey,
  numberFromJid,
  isPhoneJid,
  isLidJid,
  canonicalUserId,
  displayName,
  quotedUserId,
  mentionedId,
  resolveMentionedId,
  resolveTargetUserId,
  visibleText,
  commandParts
}
