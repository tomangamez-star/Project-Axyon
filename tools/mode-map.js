'use strict'
const { createAxyon } = require('../src/axyon-rpg')
const { createCommands, GAME_MODES, modeOf } = require('../src/axyon-commands')
const a = createAxyon({})
createCommands({ axyon: a })
console.log('total commands:', a.COMMANDS.length)
for (const [k, v] of Object.entries(GAME_MODES)) {
  const rows = a.COMMANDS.filter(x => v.sections.includes(x.section) && !x.hidden).map(x => x.name)
  console.log(k.padEnd(8), '->', rows.join(', '))
}
const free = a.COMMANDS.filter(x => modeOf(x.name, x.section) === null).map(x => x.name)
console.log('free    ->', free.join(', '))
