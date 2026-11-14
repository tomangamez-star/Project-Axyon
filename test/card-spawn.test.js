'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { MODE_FREE, modeOf } = require('../src/axyon-commands')
const spawn = require('../src/card-spawn')

test('card claim and owner spawn commands are mode-free', () => {
  assert.equal(MODE_FREE.has('claim'), true)
  assert.equal(MODE_FREE.has('spawncard'), true)
  assert.equal(modeOf('claim', 'cards'), null)
  assert.equal(modeOf('spawncard', 'management'), null)
})

test('automatic card spawn interval is six hours', () => {
  assert.equal(spawn.AUTO_INTERVAL_MS, 6 * 60 * 60 * 1000)
})

test('all three inherited card renderers produce a 700x900 PNG', async () => {
  const source = await sharp({
    create: { width: 480, height: 720, channels: 3, background: '#243B55' }
  }).png().toBuffer()
  const card = {
    name: 'AXYON Test Character',
    series: 'Anime Character',
    favorites: 1200,
    forced_tier: 3,
    weapon: 'System Blade',
    damage: 29,
    ability: 'Shadow Extraction',
    ability_damage: 39,
    rating: 3
  }
  const renderers = [
    require('../src/card-renderers/hunt-card'),
    require('../src/card-renderers/special-hunt-card'),
    require('../src/card-renderers/jtf-gen-card')
  ]
  for (const renderer of renderers) {
    assert.equal(renderer.available(), true)
    const result = await renderer.render(card, source)
    assert.ok(Buffer.isBuffer(result.buffer))
    const metadata = await sharp(result.buffer).metadata()
    assert.equal(metadata.width, 700)
    assert.equal(metadata.height, 900)
    assert.equal(metadata.format, 'png')
  }
})
