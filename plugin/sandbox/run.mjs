// Runs one command in Anthropic's sandbox runtime (srt, pinned in package.json beside this file), which confines a
// process with Seatbelt (sandbox-exec) on macOS and bubblewrap on Linux. The plugin starts its card runner with it
// (cards/argv.mjs), and the browser workbench each run of card code or of a view's reader, and its card runner
// (browser/server/thimble_browser/cards/sandbox.py):
//
//   node run.mjs --srt <folder> [--print] <rules JSON> -- <command...>
//
// --srt names the folder srt is installed in (it holds node_modules): the plugin's is <THIMBLE_HOME>/srt/<version>,
// which setup.mjs installs, the browser's browser/server/sandbox. The rules are srt's configuration: filesystem rules,
// and a network rule that allows no domain, so the command has no network at all; on Linux also bwrapPath, the bwrap.sh
// beside this file. --print prints the wrapped command (on macOS, with the Seatbelt profile srt made of the rules)
// instead of running it. This process stays the command's parent, passes SIGTERM and SIGHUP on, stops the command when
// the process that started it is gone (a long-lived command, such as the card runner, would stay otherwise), and exits
// with the command's status, or with 3 when the sandbox could not be set up.
import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const usage = () => {
  console.error('usage: node run.mjs --srt <folder> [--print] <rules JSON> -- <command...>')
  process.exit(2)
}
const all = process.argv.slice(2)
if (all[0] !== '--srt' || !all[1]) usage()
const srtDir = all[1]
const args = all.slice(2)
const print = args[0] === '--print'
const [rulesJson, sep, ...argv] = print ? args.slice(1) : args
if (!rulesJson || sep !== '--' || argv.length === 0) usage()

const quote = s => `'${s.replaceAll("'", "'\\''")}'`
const command = argv.map(quote).join(' ')

// srt looks for dangerous files (shell and git dotfiles) under its own working directory and guards them, so it works
// from this folder, which the command cannot write. The command starts where this process was started.
const cwd = process.cwd()
process.chdir(dirname(fileURLToPath(import.meta.url)))

/** The shell srt starts the command from, inside the sandbox: the system's bash. Left to srt, it is the first bash on
 *  PATH, and one outside the system folders (Homebrew on Linux, Nix, conda) is hidden by rules that show only those,
 *  so nothing would start. Undefined (srt's own choice) on a machine with no bash in /bin or /usr/bin. */
function systemBash() {
  return ['/bin/bash', '/usr/bin/bash'].find(p => { try { accessSync(p, fsConstants.X_OK); return true } catch { return false } })
}

let SandboxManager
let wrapped
try {
  let entry
  try {
    entry = createRequire(join(srtDir, 'package.json')).resolve('@anthropic-ai/sandbox-runtime')
  } catch {
    throw new Error(`the sandbox runtime is not installed in ${srtDir}`)
  }
  const srt = await import(pathToFileURL(entry).href)
  SandboxManager = srt.SandboxManager
  const rules = srt.SandboxRuntimeConfigSchema.parse(JSON.parse(rulesJson))
  // The rules become srt's configuration (bwrapPath is read only from there) without initialize(), which would start
  // the network proxies that a command with no network does not need.
  SandboxManager.updateConfig(rules)
  wrapped = await SandboxManager.wrapWithSandbox(command, systemBash(), rules)
} catch (e) {
  console.error(`the sandbox could not be set up: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(3)
}
if (!wrapped || wrapped === command) {
  console.error('the sandbox could not be set up: srt returned the command unwrapped')
  process.exit(3)
}

if (print) {
  console.log(wrapped)
  SandboxManager.cleanupAfterCommand()
  process.exit(0)
}

const child = spawn('/bin/sh', ['-c', `exec ${wrapped}`], { cwd, stdio: 'inherit' })
for (const sig of ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig))
}
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) child.kill('SIGTERM') }, 2000).unref()
child.on('error', e => {
  console.error(`the sandbox could not be started: ${e.message}`)
  process.exit(3)
})
child.on('exit', (code, signal) => {
  SandboxManager.cleanupAfterCommand()
  process.exit(code ?? 128 + (constants.signals[signal] ?? 0))
})
