'use strict'
/*
 * The play toolchain: resolution order, honest reporting, and the guarantee
 * that a missing program produces a message naming it.
 *
 * These tests never require the real binaries to be installed — they assert
 * the resolver's behaviour, which is what decides whether a deploy works.
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const binaries = require('../src/binaries')
const music = require('../src/music')

test('binaries: the repo-local bundle is the second lookup, after the env override', () => {
  const src = fs.readFileSync(require.resolve('../src/binaries'), 'utf8')
  /* Order matters: an operator override must win over the bundle. */
  const envAt = src.indexOf('ENV_OVERRIDE[name]')
  const bundleAt = src.indexOf("path.join(TOOLS_DIR, name)")
  const pathAt = src.indexOf('onPath(name)')
  assert.ok(envAt > 0 && bundleAt > 0 && pathAt > 0, 'resolver lost one of its three lookups')
  assert.ok(envAt < bundleAt, 'env override must be checked before the bundle')
  assert.ok(bundleAt < pathAt, 'the bundle must be checked before PATH')
})

test('binaries: the bundle lives inside the repo, not a temp dir', () => {
  assert.ok(binaries.TOOLS_DIR.includes('.tools'), `unexpected bundle dir: ${binaries.TOOLS_DIR}`)
  assert.ok(path.isAbsolute(binaries.TOOLS_DIR))
})

test('binaries: an env override pointing at a real executable is honoured', () => {
  binaries.reset()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axyon-bin-'))
  const fake = path.join(dir, 'yt-dlp')
  fs.writeFileSync(fake, '#!/bin/sh\necho 9999.9.9\n')
  fs.chmodSync(fake, 0o755)

  const prev = process.env.YTDLP_PATH
  process.env.YTDLP_PATH = fake
  try {
    const found = binaries.locate('yt-dlp')
    assert.strictEqual(found.path, fake)
    assert.strictEqual(found.source, 'env')
  } finally {
    if (prev === undefined) delete process.env.YTDLP_PATH
    else process.env.YTDLP_PATH = prev
    binaries.reset()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('binaries: a bogus override is ignored rather than trusted', () => {
  binaries.reset()
  const prev = process.env.FFMPEG_PATH
  process.env.FFMPEG_PATH = '/nonexistent/definitely/not/ffmpeg'
  try {
    const found = binaries.locate('ffmpeg')
    assert.notStrictEqual(found.path, '/nonexistent/definitely/not/ffmpeg')
    assert.notStrictEqual(found.source, 'env')
  } finally {
    if (prev === undefined) delete process.env.FFMPEG_PATH
    else process.env.FFMPEG_PATH = prev
    binaries.reset()
  }
})

test('binaries: describe() reports all three tools and lists what is missing', async () => {
  binaries.reset()
  const d = await binaries.describe()
  for (const key of ['ytdlp', 'ffmpeg', 'ffprobe']) {
    assert.ok(d[key], `describe() omitted ${key}`)
    assert.strictEqual(typeof d[key].found, 'boolean')
    assert.ok('version' in d[key])
    assert.ok('source' in d[key])
  }
  assert.strictEqual(d.ok, d.missing.length === 0)
  for (const name of d.missing) {
    assert.ok(['yt-dlp', 'ffmpeg', 'ffprobe'].includes(name), `unexpected missing entry: ${name}`)
  }
})

test('binaries: logStartup logs versions when present and names what is missing', async () => {
  binaries.reset()
  const lines = []
  const logger = {
    info: (payload, msg) => lines.push({ level: 'info', payload, msg }),
    warn: (payload, msg) => lines.push({ level: 'warn', payload, msg })
  }
  const d = await binaries.logStartup(logger)
  assert.strictEqual(lines.length, 1, 'startup must log exactly one toolchain line')
  const entry = lines[0]
  assert.strictEqual(entry.level, d.ok ? 'info' : 'warn')
  assert.ok(Array.isArray(entry.payload.missing))
  if (!d.ok) {
    for (const name of d.missing) {
      assert.ok(entry.msg.includes(name), `startup log did not name the missing tool: ${name}`)
    }
    assert.match(entry.msg, /render-build\.sh/, 'startup log must say how to fix it')
  }
})

test('music: a missing yt-dlp is reported by name, not as a generic failure', async () => {
  binaries.reset()
  if (binaries.has('yt-dlp')) {
    /* The real binary is installed here, so this assertion cannot be exercised. */
    return
  }
  const r = await music.resolve('some song')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'missing-ytdlp')
  assert.match(r.message, /yt-dlp/)
  assert.match(r.message, /render-build\.sh/)
})

test('music: the failure message names the step and the tool, never just "could not download"', () => {
  const src = fs.readFileSync(require.resolve('../src/music'), 'utf8')
  /* The old generic sentence must now be followed by specifics. */
  assert.match(src, /yt-dlp \$\{ytStep \|\| 'download'\} failed/)
  assert.match(src, /ffmpeg is not installed/)
  assert.match(src, /ffprobe is not installed/)
  /* And the download path must report a step, not swallow the error. */
  assert.match(src, /step: ffmpeg \? 'download\+transcode \(ffmpeg\)' : 'download'/)
})

test('music: binaries are resolved through the resolver, never called by bare name', () => {
  const src = fs.readFileSync(require.resolve('../src/music'), 'utf8')
  assert.match(src, /require\('\.\/binaries'\)/)
  /* A bare `run('yt-dlp', ...)` would bypass the bundle and fail on Render. */
  assert.doesNotMatch(src, /run\('yt-dlp'/)
  assert.doesNotMatch(src, /run\('ffprobe'/)
  assert.match(src, /binaries\.binPath\('yt-dlp'\)/)
  assert.match(src, /binaries\.binPath\('ffprobe'\)/)
})

test('music: the full-song behaviour is unchanged', () => {
  const src = fs.readFileSync(require.resolve('../src/music'), 'utf8')
  assert.match(src, /ytsearch1:/)
  assert.match(src, /full: true/)
  assert.match(src, /MIN_FULL_SECONDS/)
  assert.match(src, /is_streamable/)
  /* The Audius fallback and its two guards must survive. */
  assert.match(src, /DERIVATIVE/)
  assert.match(src, /track\.duration \* 0\.85/)
  /* No preview path may come back. */
  assert.doesNotMatch(src, /source = 'preview'/)
  assert.doesNotMatch(src, /downloadPreview/)
})

test('music: the download walks a client x format ladder instead of one bestaudio call', () => {
  const src = fs.readFileSync(require.resolve('../src/music'), 'utf8')
  /*
   * Regression: `bestaudio` alone selects format 251, whose media URL now
   * needs a GVS PO token and returns HTTP 403. The muxed `best` stream still
   * downloads, so the ladder must try both, and more than one player client.
   */
  assert.match(src, /const PLAYER_CLIENTS = \[[^\]]*'mweb'/)
  assert.match(src, /const FORMAT_LADDER = \[/)
  assert.match(src, /selector: 'bestaudio\[ext=m4a\]\/bestaudio'/)
  assert.match(src, /selector: 'best'/)
  /* Every rung gets its own directory, so a partial file cannot be mistaken
   * for a finished download. */
  assert.match(src, /try\$\{n\}/)
  /* The muxed stream is mp4; the mimetype must stay honest for it. */
  assert.match(src, /ext === 'mp4'\) return 'audio\/mp4'/)
})

test('music: a YouTube failure still tries a cleaned Audius query', () => {
  const src = fs.readFileSync(require.resolve('../src/music'), 'utf8')
  assert.match(src, /function cleanQuery/)
  assert.match(src, /queries\.push\(cleaned\)/)
  /* A YouTube title carries noise Audius cannot match. */
  assert.match(src, /official\\s\*\(music\\s\*\)\?video/)
})

test('music: the sent file name is the song title with the real extension', () => {
  assert.strictEqual(music.fileNameFor('Blinding Lights', '/tmp/x/track.mp3'), 'Blinding Lights.mp3')
  assert.strictEqual(music.fileNameFor('A/B: C?', '/tmp/x/track.m4a'), 'A B C.m4a')
  assert.strictEqual(music.fileNameFor('', '/tmp/x/track.mp3'), 'track.mp3')
  assert.strictEqual(music.mimeFor('/tmp/x/track.mp3'), 'audio/mpeg')
})

test('render.yaml builds through render-build.sh, not bare npm ci', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8')
  assert.match(yml, /buildCommand:\s*bash render-build\.sh/)
  assert.doesNotMatch(yml, /buildCommand:\s*npm ci\s*$/m)
})

test('render-build.sh installs all three tools and verifies them', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'render-build.sh'), 'utf8')
  assert.match(sh, /yt-dlp_linux/, 'must use the static yt-dlp build (no python3 on the host)')
  assert.match(sh, /ffmpeg-release-amd64-static/)
  assert.match(sh, /ffprobe/)
  assert.match(sh, /set -euo pipefail/)
  /* A failed download must fail the build, not the first !play. */
  assert.match(sh, /will not run on this host/)
})

test('the Dockerfile installs the same three tools', () => {
  const df = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8')
  assert.match(df, /apt-get install[\s\S]{0,200}?ffmpeg/)
  assert.match(df, /yt-dlp_linux/)
  assert.match(df, /ffprobe -version/)
})

test('music: external cookie secrets are copied per run and never bundled', () => {
  const src = fs.readFileSync(require.resolve('../src/music'), 'utf8')
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'data', 'cookies.txt')), false, 'cookie jar must not be bundled')
  assert.match(src, /YTDLP_COOKIES_FILE/, 'external cookie secret path must be supported')
  /* yt-dlp writes its jar back, so every run must use a private copy. */
  assert.match(src, /async function cookieJarFor/, 'the per-run copy helper must exist')
  assert.match(src, /fs\.copyFile\(jar, copy\)/, 'the jar must be copied, not used in place')
  /* The download loop must pass a work dir, so the copy lands in the temp dir. */
  assert.match(src, /youtubeArgs\(client, sub\)/, 'every ladder rung must get its own jar copy')
  assert.match(src, /youtubeArgs\(PLAYER_CLIENTS\[0\], scratch\)/, 'the search must get its own jar copy')
})

test('music: an age-restricted video is named as such, not as a generic failure', () => {
  assert.strictEqual(music.ytFailureReason('ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate for some users.'), 'age')
  assert.strictEqual(music.ytFailureReason('Sorry, this content is age-restricted'), 'age')
  assert.strictEqual(music.ytFailureReason('Sign in to confirm you\u2019re not a bot'), 'botcheck')
  assert.strictEqual(music.ytFailureReason('Private video. Sign in if you have been granted access'), 'restricted')
  assert.strictEqual(music.ytFailureReason('Requested format is not available'), 'format')
  assert.strictEqual(music.ytFailureReason(''), null)
  assert.strictEqual(music.ytFailureReason('some unrelated explosion'), null)

  /* The user-facing sentence must explain the cause and the fix. */
  const src = fs.readFileSync(require.resolve('../src/music'), 'utf8')
  assert.match(src, /age-restricted, so YouTube will only serve it to a signed-in account/)
  assert.match(src, /reason: ytReason \|\| 'download-failed'/)
})

/*
 * TUBEGRAB FALLBACK
 * -----------------
 * The operator's downloader is a separate deployment, so the tests assert the
 * two things that decide whether it helps or hurts: it must sit between yt-dlp
 * and Audius, and a dead worker must not stall the chain.
 */
test('tubegrab: sits between the yt-dlp ladder and the Audius fallback', () => {
  const src = fs.readFileSync(require.resolve('../src/music'), 'utf8')
  const ytAt = src.indexOf('const r = await downloadYt(')
  const tgAt = src.indexOf('await tubegrabDownload(')
  const audiusAt = src.indexOf('await audiusSearch(')
  assert.ok(ytAt > 0 && tgAt > 0 && audiusAt > 0, 'one of the three sources is missing from resolve()')
  assert.ok(ytAt < tgAt, 'yt-dlp must stay first')
  assert.ok(tgAt < audiusAt, 'TubeGrab must be tried before Audius')
})

test('tubegrab: a job stuck in queued gives up instead of waiting the full budget', () => {
  const src = fs.readFileSync(require.resolve('../src/music'), 'utf8')
  assert.match(src, /TUBEGRAB_QUEUE_GRACE_MS/, 'the queue grace period is gone')
  assert.match(src, /no worker claimed the job/, 'the dead-worker guard is gone')
  /* The grace must be well under the overall job budget, or it does nothing. */
  const grace = Number(src.match(/TUBEGRAB_QUEUE_GRACE_MS = (\d+)/)[1])
  const total = Number(src.match(/TUBEGRAB_JOB_TIMEOUT_MS = (\d+)/)[1])
  assert.ok(grace < total / 2, `queue grace ${grace}ms is not meaningfully shorter than ${total}ms`)
})

test('tubegrab: the file extension follows the real content, not a guess', () => {
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)])
  const m4a = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(20)])
  assert.equal(music.sniffAudioExt('application/octet-stream', mp3), 'mp3')
  assert.equal(music.sniffAudioExt('application/octet-stream', m4a), 'm4a')
  assert.equal(music.sniffAudioExt('audio/mpeg', null), 'mp3')
  assert.equal(music.sniffAudioExt('audio/mp4', null), 'm4a')
  assert.equal(music.sniffAudioExt('audio/webm', null), 'webm')
  /* An unknown type with no usable bytes must still yield a playable name. */
  assert.equal(music.sniffAudioExt('', null), 'mp3')
})

test('tubegrab: a failure returns null rather than throwing', async () => {
  /* Point at a host that cannot answer, so this never touches the network. */
  const prev = process.env.TUBEGRAB_URL
  process.env.TUBEGRAB_URL = 'http://127.0.0.1:9'
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-'))
    const r = await music.tubegrabDownload('anything', '', dir, {})
    assert.equal(r, null, 'a dead service must resolve to null, not throw')
    fs.rmSync(dir, { recursive: true, force: true })
  } finally {
    if (prev === undefined) delete process.env.TUBEGRAB_URL
    else process.env.TUBEGRAB_URL = prev
  }
})
