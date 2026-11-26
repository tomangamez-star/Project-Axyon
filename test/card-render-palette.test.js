'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const oldGen = require('../src/card-renderers/special-hunt-card')
const aiCustom = require('../src/card-renderers/ai-custom-card')

function hue (hex) {
  const value = String(hex).replace('#', '')
  const rgb = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16) / 255)
  const max = Math.max(...rgb); const min = Math.min(...rgb); const delta = max - min
  if (!delta) return 0
  let h = max === rgb[0] ? ((rgb[1] - rgb[2]) / delta) % 6 : max === rgb[1] ? (rgb[2] - rgb[0]) / delta + 2 : (rgb[0] - rgb[1]) / delta + 4
  return (h * 60 + 360) % 360
}
function distance (a, b) { const d = Math.abs(a - b); return Math.min(d, 360 - d) }

test('Old Gen palette keeps accents in the artwork hue family', () => {
  const colors = oldGen.paletteFrom({ r: 72, g: 38, b: 226 }, { accent: '#fff', accent2: '#000' })
  const artworkHue = hue('#4826E2')
  assert.ok(distance(hue(colors.accent), artworkHue) <= 8)
  assert.ok(distance(hue(colors.accent2), artworkHue) <= 30)
})

test('AI Custom does not choose an unrelated complementary accent', () => {
  const colors = aiCustom.paletteFrom([
    { r: 70, g: 35, b: 230 }, { r: 82, g: 42, b: 237 },
    { r: 45, g: 65, b: 220 }, { r: 110, g: 72, b: 242 }
  ])
  assert.ok(distance(hue(colors.a), hue(colors.b)) <= 45)
})
