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

function numberFromJid (jid) { return norm(String(jid || '').split('@')[0]) }
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
  const jids = jidsFromKey(key)
  const phone = jids.find(isPhoneJid)
  if (phone) return numberFromJid(phone)
  const mapping = sock?.signalRepository?.lidMapping
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
  visibleText,
  commandParts
}
