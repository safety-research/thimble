// The sandbox the card runner runs in (Anthropic's sandbox runtime, srt): its rules (cards/argv.mjs) and the runner's
// command on any machine, then, on this machine, setup.mjs installs srt in the test's THIMBLE_HOME, and a process under
// those rules reads no file but the ones the rules name, writes only its own folder, has no network and no variable of
// the session's; with rules that allow a site, as thimble fix's fixer has, that site alone (when this machine reaches
// it at all), with nothing of srt's proxies left after. All paths and names are made up.
//   node --test plugin/sandbox/test/sandbox.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runnerArgv, runnerRules } from '../../cards/argv.mjs'
import { sandbox } from '../../cards/test/start.mjs'

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
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

test('the runner starts with an empty environment, in srt, under Node\'s permission model', () => {
  const argv = runnerArgv({ platform: 'linux', ...MADE_UP, sock: `${MADE_UP.run}/cards.sock`, path: '/made-up/bin:/usr/bin' })
  assert.deepEqual(argv.slice(0, 3), ['env', '-i', 'PATH=/made-up/bin:/usr/bin'])
  const at = argv.indexOf('--')
  assert.deepEqual(argv.slice(at - 4, at - 1), [`${MADE_UP.plugin}/sandbox/run.mjs`, '--srt', MADE_UP.srt])
  assert.deepEqual(argv.slice(at + 1, at + 6), ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', MADE_UP.node, '--permission'])
  assert.deepEqual(argv.slice(-2), [`${MADE_UP.plugin}/cards/runner.mjs`, `${MADE_UP.run}/cards.sock`])
})

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

/** The runner's rules on this machine, for the test's card copies and run folder. */
const rulesHere = () => runnerRules({ platform: s.platform, plugin: PLUGIN, node: s.node, srt: s.srt, cards, run, home: homedir(), thimbleHome: process.env.THIMBLE_HOME })

/** What `code` prints when Node runs it under the runner's rules, with the environment the runner gets (and `path`,
 *  the PATH srt is started with). */
function inSandbox(code, path = process.env.PATH) {
  const rules = rulesHere()
  const r = spawnSync(s.node, [join(PLUGIN, 'sandbox', 'run.mjs'), '--srt', s.srt, JSON.stringify(rules), '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', s.node, '-e', code],
    { encoding: 'utf8', timeout: 60000, env: { PATH: path, HOME: run, TMPDIR: run, CLAUDE_CODE_TMPDIR: run, MADE_UP_TOKEN: 'x' } })
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
  // a hidden file: bwrap leaves it out of the runner's files, and Seatbelt refuses to open it
  assert.equal(inSandbox(`${fs}; console.log(t(() => fs.readFileSync(${JSON.stringify(join(secret, 'key.txt'))}, "utf8")))`), s.platform === 'linux' ? 'ENOENT' : 'EPERM')
  // on Linux bwrap makes the folders that lead to a shown path, empty but for that path: a checkout in the home folder
  // (as on a CI runner) shows the home folder with the one folder that leads to it, and nothing else of it
  const home = homedir()
  const shown = paths(rulesHere().filesystem.allowRead).filter(p => p.startsWith(`${home}/`))
  const leading = [...new Set(shown.map(p => p.slice(home.length + 1).split('/')[0]))].sort()
  const homeSeen = s.platform !== 'linux' ? 'EPERM' : leading.length ? JSON.stringify(leading) : 'ENOENT'
  assert.equal(inSandbox(`${fs}; console.log(t(() => JSON.stringify(fs.readdirSync(${JSON.stringify(home)}).sort())))`), homeSeen)
  assert.match(inSandbox(`${fs}; console.log(t(() => fs.writeFileSync(${JSON.stringify(join(cards, 'new.json'))}, "x")))`), /EROFS|EPERM|EACCES/)
  assert.equal(inSandbox(`${fs}; console.log(t(() => fs.writeFileSync(${JSON.stringify(join(run, 'new.txt'))}, "x")) ?? "wrote")`), 'wrote')
})

test('in the sandbox: no network, and no variable of the session\'s', () => {
  const out = inSandbox('require("net").connect(80, "1.1.1.1").on("connect", () => console.log("connected")).on("error", e => console.log(e.code))')
  assert.notEqual(out, 'connected')
  assert.notEqual(inSandbox('fetch("https://example.com").then(() => console.log("fetched"), () => console.log("no"))'), 'fetched')
  const vars = JSON.parse(inSandbox('console.log(JSON.stringify(process.env))'))
  // macOS gives every process __CF_USER_TEXT_ENCODING, the user's number and text encoding (0x1F5:0:0), which holds
  // nothing of the session
  if (s.platform === 'darwin' && '__CF_USER_TEXT_ENCODING' in vars) {
    assert.match(vars.__CF_USER_TEXT_ENCODING, /^0x[0-9A-F]+(:(0x)?[0-9A-F]+){2}$/i)
    delete vars.__CF_USER_TEXT_ENCODING
  }
  assert.deepEqual(Object.keys(vars), ['PATH'])
})

test('in the sandbox, with rules that allow a site (the fixer\'s shell, thimble fix): that site, through srt\'s proxies, and no other', t => {
  if (!existsSync('/usr/bin/curl')) return t.skip('no curl on this machine')
  // the card runner's rules, with the fixer's sites and, as the fixer's rules show it, /etc (curl's certificates on Linux)
  const base = rulesHere()
  const rules = { ...base, filesystem: { ...base.filesystem, allowRead: [...base.filesystem.allowRead, '/etc'] }, network: { ...base.network, allowedDomains: ['registry.npmjs.org'] } }
  const status = url => `curl -s -m 30 -o /dev/null -w '%{http_code}\\n' ${url}`
  // the site itself, outside the sandbox: a machine with no network, or behind a proxy of its own, cannot reach it
  const online = spawnSync('/bin/sh', ['-c', status('https://registry.npmjs.org/')], { encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin' } }).stdout.trim() === '200'
  // a temp folder short enough for the sockets of srt's bridges on Linux, which must be gone when the command ends
  const tmp = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'thimble-net-'))
  const r = spawnSync(s.node, [join(PLUGIN, 'sandbox', 'run.mjs'), '--srt', s.srt, JSON.stringify(rules), '--', '/usr/bin/env', '/bin/sh', '-c',
    `echo "$HTTPS_PROXY"; ${status('https://registry.npmjs.org/')}; ${status('https://example.com/')}`],
  { encoding: 'utf8', timeout: 120000, env: { PATH: '/usr/bin:/bin', TMPDIR: tmp } })
  const left = readdirSync(tmp).filter(f => /^claude-(http|socks)-/.test(f))
  rmSync(tmp, { recursive: true, force: true })
  const [proxy, registry, other] = r.stdout.trim().split('\n')
  assert.match(proxy, /@localhost:\d+$/, r.stderr)
  if (online) assert.equal(registry, '200')
  else t.diagnostic('registry.npmjs.org does not answer here, outside the sandbox either')
  assert.notEqual(other, '200')
  assert.deepEqual(left, [])
})
