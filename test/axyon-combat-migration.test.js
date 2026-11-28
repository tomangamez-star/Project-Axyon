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

test('the HP migration recalculates max HP and clamps current HP without rewriting other progression', () => {
  const migration = source.slice(source.indexOf('async function ensureSchema'), source.indexOf('function norm'))
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS str'))
  assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS vit'))
  const hpMigration = migration.match(/UPDATE axyon_players\s+SET max_hp=CASE[\s\S]*?;/i)?.[0] || ''
  assert.match(hpMigration, /max_hp=CASE WHEN level<=10 THEN 100 ELSE level\*10 END/i)
  assert.match(hpMigration, /hp=LEAST\(hp,/i)
  assert.doesNotMatch(hpMigration, /(?:atk\s*=|def\s*=|spd\s*=|level\s*=|xp\s*=|rank\s*=)/i)
})

test('player saves persist new stats alongside the original combat progression', () => {
  assert.match(source, /atk=\$11,def=\$12,spd=\$13/)
  assert.match(source, /str=\$30,per=\$31,sta=\$32,vit=\$33,fatigue=\$34/)
})
