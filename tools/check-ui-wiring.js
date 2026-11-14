const fs = require('fs')
const html = fs.readFileSync('public/dashboard.html', 'utf8')
const js = fs.readFileSync('public/dashboard.js', 'utf8')

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
const refs = new Set([...js.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map(m => m[1]))
const missing = [...refs].filter(r => !ids.has(r))
console.log('html ids:', ids.size, '| js refs:', refs.size)
console.log('MISSING IDS:', missing.length ? missing.join(', ') : 'none')

const screens = [...html.matchAll(/data-screen="([^"]+)"/g)].map(m => m[1])
const declared = [...js.matchAll(/const SCREENS = \[([^\]]+)\]/g)][0][1].split(',').map(s => s.trim().replace(/'/g, ''))
console.log('html screens:', screens.join(','))
console.log('js screens  :', declared.join(','))
const mismatch = screens.filter(s => !declared.includes(s)).concat(declared.filter(s => !screens.includes(s)))
console.log('SCREEN MISMATCH:', mismatch.length ? mismatch.join(',') : 'none')

const nav = [...html.matchAll(/data-goto="([^"]+)"/g)].map(m => m[1])
console.log('NAV WITHOUT SCREEN:', nav.filter(n => !screens.includes(n)).join(',') || 'none')

// every screen that needs an adminBody container must have one
const adminScreens = ['groups', 'players', 'shop', 'stages', 'floors', 'modes', 'visuals', 'authority', 'settings', 'log']
const bodies = new Set([...html.matchAll(/id="adminBody-([^"]+)"/g)].map(m => m[1]))
console.log('ADMIN BODIES MISSING:', adminScreens.filter(s => !bodies.has(s)).join(',') || 'none')

// admin.js VIEWS keys must all have a body
const adminJs = fs.readFileSync('public/admin.js', 'utf8')
const viewsBlock = adminJs.match(/const VIEWS = \{([\s\S]*?)\n  \}/)
if (viewsBlock) {
  const keys = [...viewsBlock[1].matchAll(/^\s*([a-z]+):/gm)].map(m => m[1])
  console.log('VIEWS keys:', keys.join(','))
  console.log('VIEWS WITHOUT BODY:', keys.filter(k => !bodies.has(k)).join(',') || 'none')
}
