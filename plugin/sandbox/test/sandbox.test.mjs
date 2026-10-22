// The sandbox the card runner runs in (Anthropic's sandbox runtime, srt): its rules (cards/argv.mjs) on any machine,
// then, on this machine, a process under those rules: it reads no file but the ones the rules name, writes only its own
// folder, has no network and no variable of the session's. setup.mjs installs srt in the test's THIMBLE_HOME, and names
// the system packages srt lacks with the one command that installs them. All paths and names are made up.
//   node --test plugin/sandbox/test/sandbox.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runnerArgv, runnerRules } from '../../cards/argv.mjs'
import { sandbox } from '../../cards/test/start.mjs'

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const SETUP = join(PLUGIN, 'sandbox', 'setup.mjs')
const paths = entries => entries.map(e => { assert.equal(e.literal, true, 'every path is a literal, never a pattern'); return e.path })
const MADE_UP = { plugin: '/home/t/.claude/plugins/cache/thimble/thimble/abc', node: '/home/t/.nvm/versions/node/v22.20.0/bin/node', srt: '/home/t/.thimble/srt/0.0.79', cards: '/home/t/.thimble/conversations/c1/cards', run: '/home/t/.thimble/run/cards-1', home: '/home/t', thimbleHome: '/home/t/.thimble' }

test('on Linux the rules hide everything but the system, Node, the runner code, the card copies and its own folder', () => {
  const r = runnerRules({ platform: 'linux', ...MADE_UP })
  assert.deepEqual(paths(r.filesystem.denyRead), ['/'])
  const shown = paths(r.filesystem.allowRead)
  assert.ok(shown.includes('/usr') && shown.includes('/home/t/.thimble/srt/0.0.79/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp'))
  assert.deepEqual(shown.slice(-5), ['/home/t/.nvm/versions/node/v22.20.0', `${MADE_UP.plugin}/cards`, `${MADE_UP.plugin}/core/text.js`, MADE_UP.cards, MADE_UP.run])
  assert.ok(!shown.some(p => p === '/home/t' || p === '/home/t/.thimble' || p === '/etc'))
  assert.deepEqual(paths(r.filesystem.allowWrite), [MADE_UP.run])
  assert.deepEqual(r.network.allowedDomains, [])
  assert.equal(r.bwrapPath, `${MADE_UP.plugin}/sandbox/bwrap.sh`)
})

test('on macOS the rules hide the folders of people\'s files, the home folder and thimble\'s home, and show the runner\'s', () => {
  const m = { ...MADE_UP, home: '/Users/t', thimbleHome: '/Users/t/.thimble', cards: '/Users/t/.thimble/conversations/c1/cards', run: '/Users/t/.thimble/run/cards-1' }
  const r = runnerRules({ platform: 'darwin', ...m })
  assert.deepEqual(paths(r.filesystem.denyRead), ['/Users', '/Volumes', '/private/tmp', '/private/var/tmp', '/private/var/folders', '/Users/t', '/Users/t/.thimble'])
  assert.ok(paths(r.filesystem.allowRead).includes(m.cards))
  assert.deepEqual(paths(r.filesystem.allowWrite), [m.run])
  assert.deepEqual(r.network, { allowedDomains: [], deniedDomains: [], allowUnixSockets: [m.run] })
  assert.equal(r.bwrapPath, undefined)
})

test('the runner starts with an empty environment, in srt, under Node\'s permission model', () => {
  const argv = runnerArgv({ platform: 'linux', ...MADE_UP, sock: `${MADE_UP.run}/cards.sock`, path: '/made-up/bin:/usr/bin' })
  assert.deepEqual(argv.slice(0, 3), ['env', '-i', 'PATH=/made-up/bin:/usr/bin'])
  const at = argv.indexOf('--')
  assert.deepEqual(argv.slice(at - 4, at - 1), [`${MADE_UP.plugin}/sandbox/run.mjs`, '--srt', MADE_UP.srt])
  assert.deepEqual(argv.slice(at + 1, at + 6), ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', MADE_UP.node, '--permission'])
  assert.deepEqual(argv.slice(-2), [`${MADE_UP.plugin}/cards/runner.mjs`, `${MADE_UP.run}/cards.sock`])
})

// ---------------------------------------------------------------- in the sandbox, on this machine

let s
let dir
let cards
let run
let secret

before(() => {
  s = sandbox()
  dir = mkdtempSync(join(tmpdir(), 'thimble-sandbox-test-'))
  cards = join(dir, 'cards')
  run = join(dir, 'run')
  secret = join(dir, 'secret')
  for (const d of [cards, run, secret]) mkdirSync(d, { mode: 0o700 })
  writeFileSync(join(cards, 'rows.json'), '[]')
  writeFileSync(join(secret, 'key.txt'), 'made-up secret')
})

after(() => rmSync(dir, { recursive: true, force: true }))

/** What `code` prints when Node runs it under the runner's rules, with the environment the runner gets. */
function inSandbox(code) {
  const rules = runnerRules({ platform: s.platform, plugin: PLUGIN, node: s.node, srt: s.srt, cards, run, home: homedir(), thimbleHome: process.env.THIMBLE_HOME })
  const r = spawnSync(s.node, [join(PLUGIN, 'sandbox', 'run.mjs'), '--srt', s.srt, JSON.stringify(rules), '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', s.node, '-e', code],
    { encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: run, TMPDIR: run, CLAUDE_CODE_TMPDIR: run, MADE_UP_TOKEN: 'x' } })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

test('setup.mjs installs srt in thimble\'s home, and the sandbox works here', () => {
  assert.equal(s.ok, true, `${s.why}. ${s.fix}`)
  assert.equal(s.srt, join(process.env.THIMBLE_HOME, 'srt', JSON.parse(readFileSync(join(PLUGIN, 'sandbox', 'package.json'), 'utf8')).dependencies['@anthropic-ai/sandbox-runtime']))
})

test('in the sandbox: the card copies read, nothing else of the files; writes only in its own folder', () => {
  const fs = 'const fs = require("fs"); const t = f => { try { return f() } catch (e) { return e.code } }'
  assert.equal(inSandbox(`${fs}; console.log(t(() => fs.readFileSync(${JSON.stringify(join(cards, 'rows.json'))}, "utf8")))`), '[]')
  assert.equal(inSandbox(`${fs}; console.log(t(() => fs.readFileSync(${JSON.stringify(join(secret, 'key.txt'))}, "utf8")))`), 'ENOENT')
  assert.equal(inSandbox(`${fs}; console.log(t(() => fs.readdirSync(${JSON.stringify(homedir())}).length))`), s.platform === 'linux' ? 'ENOENT' : 'EPERM')
  assert.match(inSandbox(`${fs}; console.log(t(() => fs.writeFileSync(${JSON.stringify(join(cards, 'new.json'))}, "x")))`), /EROFS|EPERM|EACCES/)
  assert.equal(inSandbox(`${fs}; console.log(t(() => fs.writeFileSync(${JSON.stringify(join(run, 'new.txt'))}, "x")) ?? "wrote")`), 'wrote')
})

test('in the sandbox: no network, and no variable of the session\'s', () => {
  const out = inSandbox('require("net").connect(80, "1.1.1.1").on("connect", () => console.log("connected")).on("error", e => console.log(e.code))')
  assert.notEqual(out, 'connected')
  assert.notEqual(inSandbox('fetch("https://example.com").then(() => console.log("fetched"), () => console.log("no"))'), 'fetched')
  assert.deepEqual(JSON.parse(inSandbox('console.log(JSON.stringify(Object.keys(process.env)))')), ['PATH'])
})

test('setup.mjs names what srt lacks on Linux, with the one command that installs it', { skip: process.platform !== 'linux' }, () => {
  // a PATH with Node alone: no bubblewrap, socat or ripgrep, and no package manager
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  symlinkSync(s.node, join(bin, 'node'))
  const r = spawnSync(join(bin, 'node'), [SETUP, '--json'], { encoding: 'utf8', env: { PATH: bin, THIMBLE_HOME: process.env.THIMBLE_HOME } })
  const got = JSON.parse(r.stdout)
  assert.equal(got.ok, false)
  assert.match(got.why, /bubblewrap/)
  assert.match(got.fix, /bubblewrap, socat, ripgrep/)
  assert.equal(r.status, 1)
})
