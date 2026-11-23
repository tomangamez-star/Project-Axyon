'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const story = require('../src/floor-story')

test('floor campaign has distinct chapter scenes with four meaningful choices', () => {
  const titles = new Set()
  for (let floor = 1; floor <= 5; floor++) {
    const scene = story.begin(floor, {})
    titles.add(scene.chapter.title)
    assert.match(scene.text, /YOUR DECISION/)
    assert.equal(scene.chapter.choices.length, 4)
  }
  assert.equal(titles.size, 5)
})

test('story choices persist flags and unlock NPC side quests', () => {
  const result = story.choose(1, 1, {})
  assert.equal(result.ok, true)
  assert.ok(result.state.flags.includes('mira_saved'))
  assert.equal(result.state.quests.brass_delivery.status, 'active')
})

test('invalid story choices do not mutate progress', () => {
  const result = story.choose(1, 9, {})
  assert.equal(result.ok, false)
})

test('side quest becomes claimable only after the floor encounter is won', () => {
  let state = story.choose(1, 1, {}).state
  assert.equal(story.claim(state, 'brass_delivery').ok, false)
  state = story.completeQuest(state, 'brass_delivery')
  const claimed = story.claim(state, 'brass_delivery')
  assert.equal(claimed.ok, true)
  assert.deepEqual(claimed.reward, { xp: 90, zen: 120 })
  assert.equal(story.claim(claimed.state, 'brass_delivery').ok, false)
})
