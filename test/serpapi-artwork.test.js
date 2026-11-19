'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const artwork = require('../src/card-artwork')
const spawn = require('../src/card-spawn')

test('card character catalogue contains 100+ distinct anime variants with search terms', () => {
  assert.ok(spawn.CHARACTER_VARIANTS.length >= 100)
  const names = spawn.CHARACTER_VARIANTS.map(x => x.name)
  assert.equal(new Set(names).size, names.length)
  assert.ok(spawn.CHARACTER_VARIANTS.every(x => x.name && x.series && x.searchTerm))
  assert.ok(names.includes('Son Goku (Base Form)'))
  assert.ok(names.includes('Son Goku (Mastered Ultra Instinct)'))
})

test('Pinterest query uses the selected character variant search term', () => {
  assert.equal(
    artwork.pinterestQuery('Son Goku (Mastered Ultra Instinct)', 'Mastered Ultra Instinct Goku'),
    'Mastered Ultra Instinct Goku anime character portrait illustration'
  )
})

test('Pinterest selector rejects landscape, undersized, invalid and explicit pins', () => {
  const pins = [
    { original: 'https://i.pinimg.com/originals/a/b/landscape.jpg', original_width: 1400, original_height: 700 },
    { original: 'https://i.pinimg.com/originals/a/b/small.jpg', original_width: 300, original_height: 500 },
    { original: 'https://i.pinimg.com/originals/a/b/explicit.jpg', original_width: 736, original_height: 1104, title: 'NSFW anime art' },
    { original: 'https://example.com/not-image.html', original_width: 736, original_height: 1104 },
    { original: 'https://i.pinimg.com/originals/a/b/portrait.jpg', original_width: 736, original_height: 1104, title: 'Anime portrait' }
  ]
  const selected = artwork.selectPinterestPin(pins)
  assert.equal(selected.original.endsWith('/portrait.jpg'), true)
})

test('SerpApi Pinterest request sends engine, query and key without exposing it in errors', async () => {
  const previousKey = process.env.SERPAPI_API_KEY
  const previousFetch = global.fetch
  process.env.SERPAPI_API_KEY = 'test-secret-key'
  let requestedUrl = ''
  global.fetch = async url => {
    requestedUrl = String(url)
    return {
      ok: true,
      async json () {
        return {
          pins: [{
            pin_id: '123',
            pin_link: 'https://www.pinterest.com/pin/123/',
            original: 'https://i.pinimg.com/originals/a/b/portrait.jpg',
            original_width: 736,
            original_height: 1104,
            pinner: { name: 'Artist' }
          }]
        }
      }
    }
  }
  try {
    const pin = await artwork.searchPinterest('Satoru Gojo', 'Satoru Gojo blindfold')
    const url = new URL(requestedUrl)
    assert.equal(url.origin + url.pathname, artwork.SERPAPI_ENDPOINT)
    assert.equal(url.searchParams.get('engine'), 'pinterest')
    assert.equal(url.searchParams.get('type'), 'pins')
    assert.equal(url.searchParams.get('q'), 'Satoru Gojo blindfold anime character portrait illustration')
    assert.equal(url.searchParams.get('api_key'), 'test-secret-key')
    assert.equal(pin.pin_id, '123')
  } finally {
    global.fetch = previousFetch
    if (previousKey === undefined) delete process.env.SERPAPI_API_KEY
    else process.env.SERPAPI_API_KEY = previousKey
  }
})


test('required Pinterest mode reports a missing Render API key clearly', async () => {
  const previousKey = process.env.SERPAPI_API_KEY
  const previousRequired = process.env.SERPAPI_REQUIRED
  delete process.env.SERPAPI_API_KEY
  process.env.SERPAPI_REQUIRED = 'true'
  try {
    await assert.rejects(
      artwork.resolveArtwork({ name: 'Satoru Gojo', kind: 'character' }),
      /SERPAPI_API_KEY is not configured/
    )
  } finally {
    if (previousKey === undefined) delete process.env.SERPAPI_API_KEY
    else process.env.SERPAPI_API_KEY = previousKey
    if (previousRequired === undefined) delete process.env.SERPAPI_REQUIRED
    else process.env.SERPAPI_REQUIRED = previousRequired
  }
})
