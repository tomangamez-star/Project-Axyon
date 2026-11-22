'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { createCommands } = require('../src/axyon-commands')
const { createAxyon } = require('../src/axyon-rpg')
const spawn = require('../src/card-spawn')
const artwork = require('../src/card-artwork')
const oldGen = require('../src/card-renderers/special-hunt-card')
const aiCustom = require('../src/card-renderers/ai-custom-card')

test('card collection, management and drop commands remain registered', () => {
  const router = createCommands({ axyon: createAxyon({}) })
  for (const name of ['claim', 'spawncard', 'card', 'cards', 'cardadmin']) assert.equal(router.BY_NAME.has(name), true)
  assert.equal(router.BY_NAME.has('mode'), false)
})

test('automatic card spawn interval remains six hours and new drops expire after 30 days by default', () => {
  assert.equal(spawn.AUTO_INTERVAL_MS, 6 * 60 * 60 * 1000)
  assert.equal(spawn.CARD_VALIDITY_DAYS, 30)
})

test('Old Gen remains the automatic drop renderer while AI Custom is available for Card Studio', () => {
  assert.deepEqual(spawn.renderers.map(x => x.key), ['old-gen', 'ai-custom'])
  assert.equal(spawn.renderers[0].render, oldGen)
  assert.equal(spawn.renderers[1].render.style, undefined)
})


test('Card Studio renderer selection defaults to AI Custom without changing Old Gen drops', () => {
  assert.equal(spawn.rendererFor(undefined, 'ai-custom').key, 'ai-custom')
  assert.equal(spawn.rendererFor('old-gen').key, 'old-gen')
  assert.equal(spawn.rendererFor('ai-custom').key, 'ai-custom')
})

test('AI Custom is an independent 700x900 battle-card renderer with a gloss layer', async () => {
  const source = await sharp({ create: { width: 480, height: 720, channels: 3, background: '#9B302A' } }).png().toBuffer()
  const card = { name: 'Makima', series: 'Chainsaw Man', card_type: 'character', damage: 35, ability: 'Control', ability_damage: 40, forced_tier: 5, percent_rating: 80, star_rating: 7 }
  const result = await aiCustom.render(card, source)
  assert.equal(result.style, 'ai-custom')
  assert.equal(result.width, 700)
  assert.equal(result.height, 900)
  assert.equal((await sharp(result.buffer).metadata()).format, 'png')
  assert.match(aiCustom.svgOverlay(card, { a: '#C33A35', b: '#F0B45B' }).toString(), /SPECIAL ABILITY/)
})

test('AI Custom derives two distinct accents from artwork colours instead of a fixed pink complement', () => {
  const samples = []
  for (let i = 0; i < 120; i++) samples.push({ r: 210, g: 28, b: 24 })
  for (let i = 0; i < 100; i++) samples.push({ r: 24, g: 92, b: 220 })
  const palette = aiCustom.paletteFrom(samples)
  assert.equal(palette.source, 'artwork-multi')
  assert.notEqual(palette.a, palette.b)
  assert.match(palette.a, /^#[0-9a-f]{6}$/i)
  assert.match(palette.b, /^#[0-9a-f]{6}$/i)
})

test('Danbooru tag matching is exact and supports series-qualified tags', () => {
  assert.equal(artwork.tagMatches('yor_forger anya_forger', 'Yor Forger'), true)
  assert.equal(artwork.tagMatches('yor_forger_(spy_x_family)', 'Yor Forger'), true)
  assert.equal(artwork.tagMatches('gojo_satoru_(jujutsu_kaisen)', 'Satoru Gojo'), true)
  assert.deepEqual(artwork.tagAliases('Satoru Gojo'), ['satoru_gojo', 'gojo_satoru'])
  assert.equal(artwork.tagMatches('yor_forger anya_forger', 'Yor'), false)
  assert.equal(artwork.tagMatches('unrelated_character', 'Gojo Satoru'), false)
})

test('artwork URL validation only accepts HTTPS direct image formats', () => {
  assert.equal(artwork.validImageUrl('https://cdn.example.com/card.jpg'), true)
  assert.equal(artwork.validImageUrl('http://cdn.example.com/card.jpg'), false)
  assert.equal(artwork.validImageUrl('https://example.com/card.html'), false)
  assert.equal(artwork.validImageUrl('https://127.0.0.1/card.jpg'), false)
  assert.equal(artwork.validImageUrl('https://localhost/card.jpg'), false)
})

test('upgraded Old Gen renderer embeds the full card combat schema in a 700x900 PNG', async () => {
  const source = await sharp({
    create: { width: 480, height: 720, channels: 3, background: '#243B55' }
  }).png().toBuffer()
  const card = {
    name: 'AXYON Test Character',
    series: 'Anime Character',
    card_type: 'character',
    character_id: 'test-001',
    weapon: 'System Blade',
    damage: 129,
    ability: 'Shadow Extraction',
    ability_damage: 139,
    rating: 5,
    forced_tier: 5,
    expires_at: new Date(Date.now() + 5 * 86400000).toISOString()
  }
  const svg = oldGen.overlaySvg(card).toString('utf8')
  for (const value of ['AXYON Test Character', 'CHARACTER', 'BASE DAMAGE', '129', 'SPECIAL ABILITY', 'Shadow Extraction', 'ABILITY DMG', '139', 'RATING', 'EXPIRY', '5D LEFT', 'AXYN CORE']) {
    assert.ok(svg.includes(value), `overlay should contain ${value}`)
  }
  const result = await oldGen.render(card, source)
  assert.ok(Buffer.isBuffer(result.buffer))
  assert.equal(result.style, 'old-gen')
  const metadata = await sharp(result.buffer).metadata()
  assert.equal(metadata.width, 700)
  assert.equal(metadata.height, 900)
  assert.equal(metadata.format, 'png')
})
