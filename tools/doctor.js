'use strict'
/*
 * `npm run doctor` — is this host able to play full songs?
 *
 * Prints the resolved path, source and version of each program `!play` needs,
 * then optionally runs one real end-to-end download. This is the check to run
 * on a host you cannot shell into: it answers "is yt-dlp installed, and does a
 * download actually work here?" in one command, with the same resolver the bot
 * uses at runtime.
 *
 *   node tools/doctor.js              toolchain report only
 *   node tools/doctor.js "song name"  report + one real download
 */
const binaries = require('../src/binaries')
const music = require('../src/music')

function pad (s, n) { return String(s).padEnd(n) }

async function main () {
  const query = process.argv.slice(2).join(' ').trim()
  const d = await binaries.describe()

  console.log('AXYON play toolchain')
  console.log('====================')
  for (const t of [d.ytdlp, d.ffmpeg, d.ffprobe]) {
    const state = t.found ? `${t.version || 'unknown version'}` : 'MISSING'
    console.log(`${pad(t.name, 9)} ${pad(state, 28)} ${t.found ? `${t.source}: ${t.path}` : '—'}`)
  }
  console.log('')
  console.log(`bundle dir: ${binaries.TOOLS_DIR}`)
  console.log(`status:     ${d.ok ? 'all tools present' : `missing ${d.missing.join(', ')}`}`)

  if (!d.ok) {
    console.log('')
    console.log('Fix: run `bash render-build.sh` (or `npm run setup:tools`) on this host,')
    console.log('or set YTDLP_PATH / FFMPEG_PATH / FFPROBE_PATH to existing binaries.')
  }

  if (!query) {
    console.log('')
    console.log('Pass a song name to run a real download, e.g.:')
    console.log('  node tools/doctor.js "blinding lights"')
    return d.ok ? 0 : 1
  }

  console.log('')
  console.log(`resolving: ${query}`)
  const r = await music.resolve(query, { logger: { warn: (...a) => console.log('[warn]', ...a) } })
  if (!r.ok) {
    console.log(`FAILED (${r.reason || 'unknown'}): ${r.message}`)
    return 1
  }
  const st = require('fs').statSync(r.file)
  const secs = await music.probeSeconds(r.file)
  console.log(`OK  source=${r.source}  ${music.mmss(secs || r.track.duration)}  ${(st.size / 1024 / 1024).toFixed(2)} MB`)
  console.log(`    title="${r.track.title}"  artist="${r.track.artist}"`)
  console.log(`    mimetype=${music.mimeFor(r.file)}  filename="${music.fileNameFor(r.track.title, r.file)}"`)
  await music.cleanup(r.dir)
  return 0
}

main().then(code => process.exit(code)).catch(e => {
  console.error('doctor failed:', e?.message || e)
  process.exit(1)
})
