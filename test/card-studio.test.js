'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const dashboard = fs.readFileSync(path.join(root, 'src/dashboard.js'), 'utf8')
const commands = fs.readFileSync(path.join(root, 'src/axyon-commands.js'), 'utf8')
const store = fs.readFileSync(path.join(root, 'src/axyon-store.js'), 'utf8')
const client = fs.readFileSync(path.join(root, 'public/card-studio.js'), 'utf8')
test('Card Studio supports phone artwork upload and persists the source image', () => {
  assert.match(client, /csImageFile/)
  assert.match(client, /readAsDataURL/)
  assert.match(client, /const fields = async \(\) =>/)
  assert.match(client, /imageData: await readSelectedArtwork\(\)/)
  assert.match(client, /api\('preview', await fields\(\)\)/)
  assert.match(dashboard, /imageData/)
  assert.match(dashboard, /8 \* 1024 \* 1024/)
  assert.match(dashboard, /renderStudioCard/)
})
test('mobile artwork reads are cached and concurrent submit reads are deduplicated', () => {
  assert.match(client, /const artworkCache = new WeakMap\(\)/)
  assert.match(client, /const artworkReads = new WeakMap\(\)/)
  assert.match(client, /const cached = artworkCache\.get\(file\)/)
  assert.match(client, /const pending = artworkReads\.get\(file\)/)
  assert.match(client, /artworkCache\.set\(file, data\)/)
  assert.match(client, /readSelectedArtwork\(file\)/)
  assert.match(fs.readFileSync(path.join(root, 'public/dashboard.html'), 'utf8'), /card-studio\.js\?v=3/)
})
test('a phone upload is read once and the cached image is submitted for preview', async () => {
  const elements = new Map()
  const getElement = id => {
    if (!elements.has(id)) {
      const listeners = {}
      elements.set(id, {
        id, value: '', files: [], style: {}, textContent: '', innerHTML: '', className: '',
        addEventListener: (event, handler) => { listeners[event] = handler },
        _listeners: listeners
      })
    }
    return elements.get(id)
  }
  const documentListeners = {}
  let fileReadCount = 0
  let submittedBody = null
  const uploadedFile = { name: 'makima.png', type: 'image/png', size: 1024 }
  class FakeFileReader {
    readAsDataURL(file) {
      fileReadCount += 1
      queueMicrotask(() => {
        // Simulate the Android browser issue: a second read of this same local
        // file fails, while the first read succeeds for the on-screen thumbnail.
        if (fileReadCount === 1) {
          this.result = 'data:image/png;base64,QUJD'
          this.onload()
        } else this.onerror()
      })
    }
  }
  const context = {
    document: {
      getElementById: getElement,
      addEventListener: (event, handler) => { documentListeners[event] = handler }
    },
    window: { architectCsrf: () => 'csrf' },
    localStorage: { getItem: () => 'token' },
    FileReader: FakeFileReader,
    fetch: async (_url, options) => {
      submittedBody = JSON.parse(options.body)
      return { ok: true, json: async () => ({ preview: 'cG5n', caption: 'preview caption' }) }
    },
    console, setTimeout, clearTimeout, URL, Date, Promise, WeakMap, Error, String, Number, Math, JSON
  }
  vm.runInNewContext(client, context)

  const fileInput = getElement('csImageFile')
  fileInput.files = [uploadedFile]
  await fileInput._listeners.change({ target: fileInput })
  assert.equal(getElement('csArtworkThumb').style.display, 'block')
  assert.equal(fileReadCount, 1)

  getElement('csName').value = 'Makima'
  await getElement('csPreview')._listeners.click()
  assert.equal(fileReadCount, 1, 'preview should reuse the successful change-handler read')
  assert.equal(submittedBody.imageData, 'data:image/png;base64,QUJD')
  assert.equal(getElement('csPreviewImage').style.display, 'block')
  assert.equal(getElement('csError').textContent, '')
})

test('AI completion only requests missing fields and applies them to blank inputs', () => {
  assert.match(dashboard, /GROQ_API_KEY/)
  assert.match(dashboard, /missing\.join\(', '\)/)
  assert.match(client, /\$\(id\)\.value===''/)
})
test('manual spawn publishes the saved image with the full card code and claim code', () => {
  assert.match(dashboard, /sendMessage\(jid, \{ image: saved\.rendered_data, caption \}\)/)
  assert.match(dashboard, /Claim with \*\!claim card #\$\{code\}\*/)
  assert.match(dashboard, /Claim : \$\{claim\} \/ \$\{d\.claimLimit\}/)
})
test('custom card claims are unique per player and enforce expiry and claim limits', () => {
  assert.match(dashboard, /PRIMARY KEY\(card_id,user_id\)/)
  assert.match(store, /drop\.claim_count\) >= limit/)
  assert.match(store, /reason:'expired'/)
  assert.match(commands, /store\.claimStudioCard\(ctx\.userId, target\)/)
})
test('the card customizer preserves the 100-point and 10-star rating scales', () => {
  assert.match(dashboard, /percentRating: n\(input\.percentRating, 0, 100/)
  assert.match(dashboard, /starRating: n\(input\.starRating, 0, 10/)
  assert.match(dashboard, /percent_rating: data\.percentRating, star_rating: data\.starRating/)
})
