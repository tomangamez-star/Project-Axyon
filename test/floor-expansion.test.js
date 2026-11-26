'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const floorStory = require('../src/floor-story')

test('floors 6 through 10 have distinct story chapters and decisions', () => {
  const titles = []
  for (let floor = 6; floor <= 10; floor++) {
    const scene = floorStory.begin(floor, {})
    assert.match(scene.text, new RegExp(`CHAPTER ${floor}`))
    assert.equal(scene.chapter.choices.length, 4)
    titles.push(scene.chapter.title)
  }
  assert.equal(new Set(titles).size, 5)
})

test('floor ten choice records its own quest and progression history', () => {
  const result = floorStory.choose(10, 3, {})
  assert.equal(result.ok, true)
  assert.equal(result.state.history.at(-1).floor, 10)
  assert.ok(result.state.quests.system_answer)
})
