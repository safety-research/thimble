// The sandbox the card runner runs in (Anthropic's sandbox runtime, srt): its rules (cards/argv.mjs) on any machine,
// then, on this machine, a process under those rules: it reads no file but the ones the rules name, writes only its own
// folder, has no network and no variable of the session's. setup.mjs installs srt in the test's THIMBLE_HOME, says
// which of the runner's grants its Node takes, names the system packages srt lacks with the one command that installs
// them, and says how a runner that did not start ended, on which Node, and the error it said. All paths and names are
// made up.
//   node --test plugin/sandbox/test/sandbox.test.mjs
import '../../test-home.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { GRANTS, endOf, runnerArgv, runnerRules, saidOf } from '../../cards/argv.mjs'
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

test('the runner gets each of its grants that its Node takes, and no other: --allow-net where Node covers its socket', () => {
  // the flags between --permission and the runner's files
  const given = grants => {
    const argv = runnerArgv({ platform: 'linux', ...MADE_UP, grants, sock: `${MADE_UP.run}/cards.sock` })
    return argv.slice(argv.lastIndexOf('--permission') + 1, argv.indexOf(`--allow-fs-read=${MADE_UP.plugin}/cards`))
  }
  assert.deepEqual(GRANTS, ['--allow-net'])
  assert.deepEqual(given({ '--allow-net': true }), ['--allow-net'])
  // a Node that refuses the flag (Node 24 and earlier), and a setup that said nothing of it
  for (const g of [{ '--allow-net': false }, {}, undefined, null]) assert.deepEqual(given(g), [], JSON.stringify(g))
  // a grant the runner does not need is never given, whatever the answer named
  assert.deepEqual(given({ '--allow-net': true, '--allow-child-process': true, '--allow-fs-read=/': true }), ['--allow-net'])
})

test('what the runner said as it ended, in one line: the error and its code from the report Node prints, else its last two lines', () => {
  // the report as Node prints it: the line of code that threw, the error, its stack, its properties, Node's version
  const report = (error, code = 'ERR_ACCESS_DENIED') => `file:///made-up/cards/runner.mjs:792\n  const server = http.createServer(serve)\n                      ^\n\n${error}\n${'    at serve (file:///made-up/cards/runner.mjs:792:23)\n'.repeat(10)} {\n  code: '${code}'\n}\n\nNode.js v26.1.0\n`
  const refused = saidOf(report('Error: made-up: refused'))
  assert.ok(refused.includes('Error: made-up: refused') && refused.includes('ERR_ACCESS_DENIED'), refused)
  assert.doesNotMatch(refused, /Node\.js|\bat serve\b|}/)
  // a code the error's own line names is not said twice
  const missing = saidOf(report("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/made-up/x.js'", 'ERR_MODULE_NOT_FOUND'))
  assert.equal(missing.split('ERR_MODULE_NOT_FOUND').length, 2, missing)
  // a long error is cut, and keeps its code
  const long = saidOf(report(`Error: ${'made-up '.repeat(60)}`))
  assert.ok(long.length <= 300 && long.includes('ERR_ACCESS_DENIED'), long)
  // what is no report of Node's: its last two lines, but Node's version
  assert.equal(saidOf('bwrap: setting up uid map: Permission denied\n'), 'bwrap: setting up uid map: Permission denied')
  assert.equal(saidOf('one\ntwo\n  three\n\nNode.js v26.1.0\n'), 'two three')
  assert.equal(saidOf(''), '')
})

test('how the runner ended: its exit status or the signal, and the signal of a status above 128 where the caller knows their numbers', () => {
  assert.match(endOf({ code: 0, signal: null }), /exit 0\b/)
  assert.match(endOf({ code: null, signal: 'SIGTERM' }), /SIGTERM/)
  // run.mjs, which starts the runner, exits with 128 and the number of the signal that stopped it
  assert.match(endOf({ code: 137, signal: null }, { SIGKILL: 9 }), /137.*SIGKILL/)
  // the hooks, which have no numbers of the signals
  assert.match(endOf({ code: 137, signal: null }), /exit 137\b/)
})

test('a Node too old for srt is told the plugin\'s minimum, the one scripts/install.sh and the hooks name; the check stays at srt\'s floor', () => {
  const text = path => readFileSync(join(PLUGIN, '..', path), 'utf8')
  const setup = text('plugin/sandbox/setup.mjs')
  const minimum = /const PLUGIN_NODE_MIN = '([\d.]+)'/.exec(setup)?.[1]
  assert.equal(/\[ "\$plugin" = 1 \] && node_min=([\d.]+)\.0/.exec(text('scripts/install.sh'))?.[1], minimum)
  assert.equal(/Install Node ([\d.]+) or later/.exec(text('plugin/cards/ask.ts'))?.[1], minimum)
  // srt's own floor, which the browser workbench's Node may be at when it installs srt with setup.mjs
  const [, major, minor] = /const NODE_MIN = \[(\d+), (\d+)\]/.exec(setup)
  assert.equal(JSON.parse(text('plugin/sandbox/package.json')).engines.node, `>=${major}.${minor}.0`)
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

test('setup.mjs says which of the runner\'s grants its Node takes, as that Node\'s own command line takes them', () => {
  // setup.mjs reads the flags Node allows in NODE_OPTIONS: a grant kept out of them fails here, on a Node that takes it
  assert.equal(s.nodeVersion, process.versions.node)
  for (const g of GRANTS) {
    const r = spawnSync(s.node, ['--permission', g, '-e', '0'], { encoding: 'utf8' })
    assert.equal(s.grants[g], r.status === 0, `Node ${s.nodeVersion}, ${g}: ${r.stderr}`)
  }
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

test('the probe\'s runner starts with a temp folder too long for a socket in it, and the folder stays empty', () => {
  // a Unix socket's path holds at most 108 bytes (104 on macOS): a long TMPDIR kept the probe's runner from listening
  const long = join(dir, 'a-rather-long-temp-folder-of-a-long-user-name-'.repeat(2))
  mkdirSync(long)
  const r = spawnSync(s.node, [SETUP, '--json', '--probe'], { encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, THIMBLE_HOME: process.env.THIMBLE_HOME, TMPDIR: long } })
  const got = JSON.parse(r.stdout)
  assert.equal(got.ok, true, `${got.why}. ${got.fix}`)
  assert.deepEqual(readdirSync(long), [])
})

/** setup.mjs's probe (its JSON, or with `json` false the line it prints) in a THIMBLE_HOME of its own, whose sandbox
 *  runtime is a made-up one that runs the shell command `command` in place of the card runner. */
function probeWith(command, json = true) {
  const home = mkdtempSync(join(dir, 'home-'))
  const pkg = join(home, 'srt', s.version, 'node_modules', '@anthropic-ai', 'sandbox-runtime')
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/sandbox-runtime', version: s.version, type: 'module', main: 'dist/index.js' }))
  writeFileSync(join(pkg, 'dist', 'index.js'), `export const SandboxRuntimeConfigSchema = { parse: rules => rules }
export const SandboxManager = { checkDependencies: () => ({ errors: [], warnings: [] }), updateConfig() {}, cleanupAfterCommand() {}, wrapWithSandbox: async () => ${JSON.stringify(command)} }\n`)
  // the lock file it was installed from, by which setup.mjs knows it is installed
  writeFileSync(join(home, 'srt', s.version, 'node_modules', '.thimble-lock.json'), readFileSync(join(PLUGIN, 'sandbox', 'package-lock.json'), 'utf8'))
  const r = spawnSync(s.node, [SETUP, ...(json ? ['--json'] : []), '--probe'], { encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, THIMBLE_HOME: home } })
  return json ? JSON.parse(r.stdout) : r.stdout
}

test('a runner that ends before it opens its socket: the probe says how it ended and on which Node, also when it said nothing', () => {
  const node = `Node ${s.nodeVersion} (${s.node})`
  // as the runner ended on Node 25 without --allow-net: exit 0, and not a word
  const silent = probeWith('true')
  assert.equal(silent.ok, false)
  assert.match(silent.why, /exit 0\b/)
  assert.ok(silent.why.includes(node), silent.why)
  const said = probeWith("sh -c 'echo made-up: no socket >&2; exit 7'")
  assert.match(said.why, /exit 7\b.*made-up: no socket/)
  assert.ok(said.why.includes(node), said.why)
  // a signal stopped it: run.mjs exits with 128 and the signal's number
  assert.match(probeWith("sh -c 'kill -KILL $$'").why, /SIGKILL/)
  // the line it prints says why, what the sandbox is for, and that the rest of thimble works without it
  const line = probeWith('true', false)
  assert.match(line, /cards cannot run yet: .*exit 0/)
  assert.match(line, /code Claude writes/)
  assert.match(line, /rest of thimble works/)
})

test('a runner that an error ends before it opens its socket: the probe quotes the error and its code, not the last lines of Node\'s report', () => {
  // as a Node whose permission model refuses something the runner does at its start, a few calls deep: the error comes
  // before its stack in Node's report, more than 600 characters from its end
  const start = 'startTheMadeUpCardRunnerThatThisNodeRefusesSomethingOf'
  const runner = `function ${start}(n) { if (n) return ${start}(n - 1); throw Object.assign(new Error("made-up: refused"), { code: "ERR_ACCESS_DENIED" }) } ${start}(20)`
  const got = probeWith(`'${s.node}' -e '${runner}'`)
  assert.equal(got.ok, false)
  assert.match(got.why, /exit 1\b/)
  assert.ok(got.why.includes('made-up: refused') && got.why.includes('ERR_ACCESS_DENIED'), got.why)
  assert.doesNotMatch(got.why, /Node\.js v/)
})

test('the sandbox starts its command with the system\'s bash, also when PATH finds another bash first', () => {
  // as Homebrew on Linux, Nix or conda set PATH up: a bash in a folder the rules hide
  const own = join(dir, 'own-bash')
  mkdirSync(own)
  const bash = ['/bin/bash', '/usr/bin/bash'].find(existsSync)
  symlinkSync(bash, join(own, 'bash'))
  assert.equal(inSandbox('console.log("started")', `${own}:${process.env.PATH}`), 'started')
})

/** setup.mjs's answer with a PATH whose `bwrap` is a made-up one that says `said` and fails. */
function withFailingBwrap(said) {
  const bin = mkdtempSync(join(dir, 'bwrap-'))
  writeFileSync(join(bin, 'bwrap'), `#!/bin/sh\necho ${JSON.stringify(said)} >&2\nexit 1\n`)
  chmodSync(join(bin, 'bwrap'), 0o755)
  const r = spawnSync(s.node, [SETUP, '--json', '--probe'], { encoding: 'utf8', timeout: 60000, env: { PATH: `${bin}:${process.env.PATH}`, THIMBLE_HOME: process.env.THIMBLE_HOME } })
  return JSON.parse(r.stdout)
}

/** setup.mjs in a THIMBLE_HOME of its own, with npm's cache of its own; `env` adds to its environment. */
function freshSetup(env = {}) {
  const home = mkdtempSync(join(dir, 'home-'))
  const cache = mkdtempSync(join(dir, 'npm-cache-'))
  return { home, run: () => spawn(s.node, [SETUP, '--json'], { env: { PATH: process.env.PATH, THIMBLE_HOME: home, npm_config_cache: cache, ...env } }) }
}

const answer = child => new Promise(resolve => {
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.on('exit', () => resolve(JSON.parse(out.trim().split('\n').pop())))
})

test('setup.mjs names the fix of what keeps the sandbox from installing or starting: what srt lacks on Linux, AppArmor only when bubblewrap could not make its namespaces, and an npm that cannot reach its registry', async () => {
  if (process.platform === 'linux') {
    // what srt lacks on Linux, with the one command that installs it
    // a PATH with Node alone: no bubblewrap, socat or ripgrep, and no package manager
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    symlinkSync(s.node, join(bin, 'node'))
    const r = spawnSync(join(bin, 'node'), [SETUP, '--json'], { encoding: 'utf8', env: { PATH: bin, THIMBLE_HOME: process.env.THIMBLE_HOME } })
    const got = JSON.parse(r.stdout)
    assert.equal(got.ok, false)
    assert.match(got.why, /^this machine lacks what the sandbox needs: .*bubblewrap/)
    assert.match(got.fix, /bubblewrap, socat, ripgrep/)
    assert.equal(r.status, 1)
    // bubblewrap, socat and ripgrep there, but no `which`, with which srt looks for them: the fix installs `which`
    const found = join(dir, 'found')
    mkdirSync(found)
    for (const c of ['node', 'bwrap', 'socat', 'rg']) symlinkSync(c === 'node' ? s.node : spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim(), join(found, c))
    const noWhich = JSON.parse(spawnSync(join(found, 'node'), [SETUP, '--json'], { encoding: 'utf8', env: { PATH: found, THIMBLE_HOME: process.env.THIMBLE_HOME } }).stdout)
    assert.equal(noWhich.ok, false)
    assert.equal(noWhich.fix, "Install it: install which with your system's package manager")
    // the AppArmor fix is given only when bubblewrap could not make its namespaces
    const other = withFailingBwrap('bwrap: execvp /made-up/bash: No such file or directory')
    assert.equal(other.ok, false)
    assert.match(other.why, /execvp \/made-up\/bash/)
    assert.doesNotMatch(other.fix, /AppArmor|sysctl/)
    const userns = withFailingBwrap('bwrap: setting up uid map: Permission denied')
    assert.equal(userns.ok, false)
    // a kernel without Ubuntu's AppArmor setting (Arch, Fedora) has no such file: not restricted, as setup.mjs reads it
    const sysctl = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
    const restricted = existsSync(sysctl) && readFileSync(sysctl, { encoding: 'utf8', flag: 'r' }).trim() === '1'
    if (restricted) assert.equal(userns.fix, 'AppArmor keeps bubblewrap from making its namespaces. Allow them: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0')
  }
  // npm that cannot reach its registry: the fix says how to see why, and the command that tries again
  const npm = await answer(freshSetup({ npm_config_registry: 'http://127.0.0.1:9/', npm_config_fetch_retries: '0' }).run())
  assert.equal(npm.ok, false)
  assert.match(npm.why, /^npm could not install the sandbox runtime .*ECONNREFUSED/)
  assert.match(npm.fix, /`npm ping`/)
  assert.ok(npm.fix.endsWith(`run: node ${SETUP} --probe`), npm.fix)
})

test('a setup waits for the install another setup is making, and takes over the lock of one that is gone', async () => {
  const one = freshSetup()
  const lock = join(one.home, 'srt', `.${s.version}.lock`)
  // a setup that is gone left its lock: the next one takes it over and installs
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'pid'), '999999999')
  assert.equal((await answer(one.run())).ok, true)
  assert.equal(existsSync(lock), false)
  // a setup that installs holds the lock (a live process stands for it): the next one waits until it lets go
  const two = freshSetup()
  const lock2 = join(two.home, 'srt', `.${s.version}.lock`)
  const holder = spawn('sleep', ['30'])
  mkdirSync(lock2, { recursive: true })
  writeFileSync(join(lock2, 'pid'), String(holder.pid))
  const t0 = Date.now()
  const waiting = answer(two.run())
  await new Promise(r => setTimeout(r, 800))
  assert.equal(existsSync(join(two.home, 'srt', s.version)), false, 'it did not install while the lock was held')
  rmSync(lock2, { recursive: true, force: true })
  holder.kill()
  assert.equal((await waiting).ok, true)
  assert.ok(Date.now() - t0 >= 800)
})
