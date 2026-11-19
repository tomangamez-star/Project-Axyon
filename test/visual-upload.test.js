'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { _test } = require('../src/dashboard')

function request (contentType, data) {
  return { headers: { 'content-type': contentType }, async *[Symbol.asyncIterator] () { yield data } }
}

test('visual uploads identify supported image formats by file signature', () => {
  assert.equal(_test.imageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg')
  assert.equal(_test.imageMime(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png')
  assert.equal(_test.imageMime(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(_test.imageMime(Buffer.from('not an image')), '')
})

test('visual uploads parse selected image, mode and caption from phone form data', async () => {
  const boundary = 'architect-test-boundary'
  const raw = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\nbattle\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nThe battle begins\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`,
    '\x89PNG\r\n\x1a\n',
    `\r\n--${boundary}--\r\n`
  ].join(''), 'binary')
  const fields = await _test.multipart(request(`multipart/form-data; boundary=${boundary}`, raw))
  assert.equal(fields.mode, 'battle')
  assert.equal(fields.caption, 'The battle begins')
  assert.equal(fields.image.filename, 'logo.png')
  assert.equal(_test.imageMime(fields.image.data), 'image/png')
})
