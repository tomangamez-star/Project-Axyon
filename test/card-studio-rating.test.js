'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const renderer = require('../src/card-renderers/special-hunt-card')

test('Old Gen renderer supports percent ratings out of 100 and star ratings out of 10', () => {
  const svg = renderer.overlaySvg({ name: 'Naruto', rating: 3, percent_rating: 92, star_rating: 9, damage: 29, ability: 'Rasengan', ability_damage: 13 })
  assert.match(svg.toString(), />92<tspan[^>]*>\/100<\/tspan>/)
  assert.equal((svg.toString().match(/>★<\/text>/g) || []).length, 10)
  assert.match(svg.toString(), /fill="#667085"/)
})
