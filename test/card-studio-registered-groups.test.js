'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const dashboard = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8')
const studio = fs.readFileSync(path.join(__dirname, '../public/card-studio.js'), 'utf8')
const html = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8')

test('Card Studio lists only active registered groups available in WhatsApp', () => {
  assert.match(dashboard, /cardStore\.groups\(\)/)
  assert.match(dashboard, /g\.status === 'ACTIVE' && g\.enabled !== false && participating\?\.\[g\.group_jid\]/)
})

test('Card Studio spawn validates registration and live group membership server-side', () => {
  assert.match(dashboard, /registeredGroups\.find\(g => g\.group_jid === jid && g\.status === 'ACTIVE' && g\.enabled !== false\)/)
  // WhatsApp uses both modern numeric-only group JIDs and legacy numeric-numeric JIDs.
  assert.match(dashboard, /\\d\{5,30\}\(\?:-\\d\{5,25\}\)\?@g\\\.us/)
  assert.match(dashboard, /participating\?\.\[jid\]/)
  assert.match(dashboard, /WhatsApp rejected the card send/)
})

test('Card Studio UI requires dropdown selection and has no manual JID fallback', () => {
  assert.match(html, /Choose registered WhatsApp group/)
  assert.doesNotMatch(html, /csGroupJid|enter group JID manually/i)
  assert.match(studio, /Select an active registered WhatsApp group first/)
  assert.doesNotMatch(studio, /csGroupJid/)
})

test('character completion uses SerpApi image search when artwork is blank', () => {
  assert.match(dashboard, /engine:'google_images'/)
  assert.match(dashboard, /safe\.imageUrl = artworkUrl/)
  assert.match(studio, /set\('csImage',f\.imageUrl\)/)
})
