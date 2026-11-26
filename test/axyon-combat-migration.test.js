'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../src/axyon-store.js'), 'utf8')

test('new combat stats are added with additive migrations and safe defaults', () => {
  for (const [column, fallback] of [['str', 5], ['per', 5], ['sta', 5], ['vit', 5], ['fatigue', 0]]) {
    assert.ok(source.includes(`ADD COLUMN IF NOT EXISTS ${column} INT NOT NULL DEFAULT ${fallback}`), `${column} migration`)
  }
  assert.ok(source.includes('ADD COLUMN IF NOT EXISTS fatigue_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'))
})

test('existing ATK, DEF, SPD, HP and progression are not rewritten by the migration', () => {
  const migration = source.slice(source.indexOf('async function ensureSchema'), source.indexOf('function norm'))
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS str'))
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS vit'))
  assert.ok(!/UPDATE axyon_players SET[^;]*(?:atk\s*=|def\s*=|spd\s*=|hp\s*=|level\s*=|xp\s*=|rank\s*=)/i.test(migration))
})

test('player saves persist new stats alongside the original combat progression', () => {
  assert.match(source, /atk=\$11,def=\$12,spd=\$13/)
  assert.match(source, /str=\$30,per=\$31,sta=\$32,vit=\$33,fatigue=\$34/)
})
