// setup.mjs: installs the sandbox the card runner runs in, and says whether it works. The sandbox is Anthropic's sandbox
// runtime (srt, npm @anthropic-ai/sandbox-runtime), at the version package.json beside this file pins, installed with
// `npm ci` from package-lock.json (which holds each package's checksum) into <THIMBLE_HOME>/srt/<version>, the one place
// the plugin keeps it. scripts/install.sh and the try-it script run it after they install the plugin, and the plugin
// runs it at each session start (a plugin installed with `claude plugin install` alone runs no setup of its own).
//
//   node setup.mjs [--home DIR] [--json] [--probe]
//
// It needs nothing but the Node it runs on, which is the Node that will run the runner (the hooks run it by `node` on
// the session's PATH). It installs srt when that version is not there (it never runs sudo), then asks srt whether this
// machine has what it needs (Linux: bubblewrap, socat and ripgrep; macOS: sandbox-exec), and with --probe starts the
// card runner in the sandbox and waits for its answer. Setups that run at the same time (two sessions start, a card
// is called while the session start installs) install once: the others wait for that install. It prints one line, or
// with --json one JSON object:
//   {ok, node, platform, version, srt, why, fix, ms}
// `node` is this Node's binary (the runner's), `srt` the folder srt is in, `why` what is wrong and `fix` the one command
// or step that fixes it, `ms` how long the probe's runner took to answer. Exits 0 when the sandbox works, else 1.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runnerArgv } from '../cards/argv.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = dirname(HERE)
const NODE_MIN = [22, 12]
const PROBE_MS = 15000

const args = process.argv.slice(2)
const flag = f => args.includes(f)
const valueOf = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const home = (valueOf('--home') || process.env.THIMBLE_HOME || join(os.homedir(), '.thimble')).replace(/\/+$/, '')
const pin = JSON.parse(fs.readFileSync(join(HERE, 'package.json'), 'utf8')).dependencies['@anthropic-ai/sandbox-runtime']
const lock = fs.readFileSync(join(HERE, 'package-lock.json'), 'utf8')
const srt = join(home, 'srt', pin)
const platform = process.platform
const out = { ok: false, node: process.execPath, platform, version: pin, srt, why: '', fix: '' }

/** The first of these commands on PATH, or null. */
function which(cmd) {
  for (const d of String(process.env.PATH || '').split(delimiter)) {
    if (!d) continue
    try { fs.accessSync(join(d, cmd), fs.constants.X_OK); return join(d, cmd) } catch { /* not here */ }
  }
  return null
}

/** Whether srt is installed in its folder from this lock file. */
function installed() {
  try {
    const meta = JSON.parse(fs.readFileSync(join(srt, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'package.json'), 'utf8'))
    return meta.version === pin && fs.readFileSync(join(srt, 'node_modules', '.thimble-lock.json'), 'utf8') === lock
  } catch {
    return false
  }
}

const again = `node ${join(HERE, 'setup.mjs')} --probe`
// npm's messages when it cannot reach its registry
const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|FetchError|network|proxy|certificate|\b(E40[37]|E5\d\d)\b/i

/** Install srt into its folder: `npm ci` in a new folder beside it, then moved into place, so a session that starts at
 *  the same time never reads half an install. null when it is installed, else why not and the fix. */
function install() {
  const npm = which('npm') || [join(dirname(process.execPath), 'npm')].find(p => fs.existsSync(p))
  if (!npm) return { why: 'npm is not installed, and thimble installs the sandbox with it', fix: `Install npm (it comes with Node), then run: ${again}` }
  if (!flag('--json')) console.error(`thimble: installing Anthropic's sandbox runtime ${pin} with npm (a minute at most, unless npm cannot reach its registry)...`)
  const tmp = fs.mkdtempSync(join(home, 'srt', `.${pin}-`))
  try {
    fs.copyFileSync(join(HERE, 'package.json'), join(tmp, 'package.json'))
    fs.writeFileSync(join(tmp, 'package-lock.json'), lock)
    const r = spawnSync(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: tmp, encoding: 'utf8', timeout: 300000, env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    })
    if (r.status !== 0) {
      // npm's message line (`request to … failed, reason: …`), not its code, stack or log lines
      const lines = `${r.stderr || ''}\n${r.stdout || ''}`.split('\n').map(l => l.replace(/^npm (error|ERR!)\s*/, '').trim()).filter(Boolean)
      const said = lines.find(l => !/^(code|syscall|errno|at |A complete log|[{}])/.test(l)) || lines[0] || r.error?.message || `exit ${r.status}`
      const why = `npm could not install the sandbox runtime ${pin}: ${said.slice(0, 200)}`
      return UNREACHABLE.test(said)
        ? { why, fix: `npm cannot reach its registry. See why with \`npm ping\`, fix npm's proxy or registry setting, then run: ${again}` }
        : { why, fix: `npm's message says what failed; once it is fixed, run: ${again}` }
    }
    fs.writeFileSync(join(tmp, 'node_modules', '.thimble-lock.json'), lock)
    if (installed()) return null
    if (fs.existsSync(srt)) fs.renameSync(srt, `${tmp}-old`)
    try {
      fs.renameSync(tmp, srt)
    } catch (e) {
      // another session moved its install into place first
      if (!installed()) throw e
    }
    return null
  } catch (e) {
    return { why: `the sandbox runtime could not be installed in ${srt}: ${e.message}`, fix: `Make ${join(home, 'srt')} a folder you can write, then run: ${again}` }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(`${tmp}-old`, { recursive: true, force: true })
  }
}

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** `work` while this setup holds the install lock, a folder beside the install that one setup makes at a time, with
 *  its process id in it; the other setups wait, and take the lock over when its setup is gone. (Two installs at once
 *  stay safe, since each moves a whole install into place: the lock only keeps a setup that starts later from
 *  installing again, and makes it wait for the install that runs.) */
async function locked(work) {
  fs.mkdirSync(join(home, 'srt'), { recursive: true, mode: 0o700 })
  const at = join(home, 'srt', `.${pin}.lock`)
  for (;;) {
    try {
      fs.mkdirSync(at)
      fs.writeFileSync(join(at, 'pid'), String(process.pid))
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    const pid = Number(read(join(at, 'pid')))
    const age = (() => { try { return Date.now() - fs.statSync(at).mtimeMs } catch { return 0 } })()
    if ((pid && !alive(pid)) || (!pid && age > 5000)) fs.rmSync(at, { recursive: true, force: true })
    else await new Promise(r => setTimeout(r, 200))
  }
  try {
    return work()
  } finally {
    fs.rmSync(at, { recursive: true, force: true })
  }
}

/** The command that installs these packages with this Linux's package manager. */
function installCommand(packages) {
  const managers = [['apt-get', 'sudo apt-get install'], ['dnf', 'sudo dnf install'], ['yum', 'sudo yum install'],
    ['pacman', 'sudo pacman -S'], ['zypper', 'sudo zypper install'], ['apk', 'sudo apk add']]
  const found = managers.find(([m]) => which(m))
  return found ? `${found[1]} ${packages.join(' ')}` : `install ${packages.join(', ')} with your system's package manager`
}

/** What this machine lacks for srt, as srt says it (Linux: bubblewrap, socat, ripgrep), with the fix. */
async function needs() {
  if (platform !== 'linux' && platform !== 'darwin') return { why: `thimble's sandbox works on macOS and Linux, not on ${platform}`, fix: 'Use macOS or Linux to draw cards.' }
  if (platform === 'darwin' && !fs.existsSync('/usr/bin/sandbox-exec')) return { why: "macOS's /usr/bin/sandbox-exec is missing", fix: 'Use a macOS that has sandbox-exec.' }
  const { SandboxManager } = await import(pathToFileURL(join(srt, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'index.js')).href)
  const { errors } = SandboxManager.checkDependencies()
  if (!errors.length) return null
  const packages = platform === 'linux' ? [['bwrap', 'bubblewrap'], ['socat', 'socat'], ['rg', 'ripgrep']].filter(([c]) => !which(c)).map(([, p]) => p) : []
  return { why: `this machine lacks what the sandbox needs: ${errors.join('; ')}`, fix: packages.length ? `Install ${packages.length > 1 ? 'them' : 'it'}: ${installCommand(packages)}` : '' }
}

/** Start the card runner in the sandbox, as the hooks do, and wait for its answer: '' and the time it took, or why not. */
async function probe() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'thimble-probe-'))
  const [cards, run] = [join(dir, 'cards'), join(dir, 'run')]
  for (const d of [cards, run]) fs.mkdirSync(d, { mode: 0o700 })
  const sock = join(run, 'cards.sock')
  const argv = runnerArgv({ plugin: PLUGIN, node: process.execPath, srt, cards, run, sock, platform, home: os.homedir(), thimbleHome: home, path: process.env.PATH || '/usr/bin:/bin' })
  const t0 = Date.now()
  let said = ''
  let ended = false
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', d => { said = `${said}${d}`.slice(-600) })
  child.on('exit', () => { ended = true })
  const ping = () => new Promise(resolve => {
    const q = http.request({ socketPath: sock, path: '/ping', method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)) })
    q.on('error', () => resolve(false))
    q.end('{}')
  })
  try {
    while (Date.now() - t0 < PROBE_MS && !ended) {
      if (await ping()) return { error: '', ms: Date.now() - t0 }
      await new Promise(r => setTimeout(r, 20))
    }
    await new Promise(r => setTimeout(r, 50))
    const why = said.trim().split('\n').filter(l => l.trim()).slice(-2).join(' ').slice(0, 300)
    return { error: ended ? `the card runner did not start in the sandbox${why ? ` (${why})` : ''}` : `the card runner did not answer in ${PROBE_MS / 1000} s`, said }
  } finally {
    child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function read(path) {
  try { return fs.readFileSync(path, 'utf8').trim() } catch { return '' }
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < NODE_MIN[0] || (major === NODE_MIN[0] && minor < NODE_MIN[1])) {
    return { why: `Node ${process.versions.node} is too old for the sandbox runtime`, fix: `Install Node ${NODE_MIN.join('.')} or later.` }
  }
  if (!installed()) {
    const failed = await locked(() => (installed() ? null : install()))
    if (failed) return failed
  }
  const lacking = await needs()
  if (lacking) return lacking
  if (!flag('--probe')) return null
  const p = await probe()
  out.ms = p.ms
  if (!p.error) return null
  // bubblewrap could not make its namespaces, and AppArmor restricts them (Ubuntu 24.04 and later): srt's README gives
  // this command. Any other failure is said as bwrap or the runner said it
  const userns = /bwrap: .*(uid map|namespace|RTM_NEWADDR|Operation not permitted|Permission denied)/i.test(p.said || '')
  const fix = userns && platform === 'linux' && read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1'
    ? 'AppArmor keeps bubblewrap from making its namespaces. Allow them: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0'
    : ''
  return { why: p.error, fix }
}

let problem
try {
  problem = await main()
} catch (e) {
  problem = { why: `thimble could not check its sandbox (${e?.message || e})`, fix: '' }
}
if (problem) Object.assign(out, problem)
else out.ok = true
if (flag('--json')) {
  console.log(JSON.stringify(out))
} else if (out.ok) {
  console.log(`thimble: cards run in Anthropic's sandbox runtime ${pin} (${platform === 'darwin' ? 'Seatbelt' : 'bubblewrap'}), installed in ${srt}${out.ms ? `; the runner started in ${out.ms} ms` : ''}.`)
} else {
  console.log(`thimble: cards cannot run yet: ${out.why}.${out.fix ? `\n  ${out.fix}` : ''}`)
}
process.exitCode = out.ok ? 0 : 1
