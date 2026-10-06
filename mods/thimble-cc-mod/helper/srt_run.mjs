// A command inside Anthropic's sandbox runtime (@anthropic-ai/sandbox-runtime, "srt"), which confines a process with
// Seatbelt on macOS and bubblewrap on Linux: the scripts thimble-cc-mod runs itself (helper/sandbox.py), as thimble's
// backend/app/kernel_srt.mjs runs the notebook kernel.
//
//   node srt_run.mjs <srt package dir> <rules JSON> --home <dir> -- <command...>
//
// The rules are sandbox.py's srt_rules. No network rules are given, so the command keeps the host's network. HOME is
// <dir> and TMPDIR <dir>/tmp, the XDG_* folders unset (kernel_wrap.srt_env). This process stays the command's parent
// and exits with its code; SIGTERM and SIGHUP are passed on.
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [srtArg, rulesJson, homeFlag, home, sep, ...argv] = process.argv.slice(2)
if (!srtArg || !rulesJson || homeFlag !== '--home' || !home || sep !== '--' || argv.length === 0) {
  console.error('usage: node srt_run.mjs <srt package dir> <rules JSON> --home <dir> -- <command...>')
  process.exit(2)
}

const quote = s => `'${s.replaceAll("'", "'\\''")}'`

// srt guards shell and git dotfiles under its own working directory (on Linux by mounting empty read-only files over
// them), so it works from this file's folder, and the command starts where this process was started
const cwd = process.cwd()
process.chdir(dirname(fileURLToPath(import.meta.url)))

let wrapped
let SandboxManager
try {
  const srt = await import(pathToFileURL(join(resolve(srtArg), 'dist', 'index.js')).href)
  SandboxManager = srt.SandboxManager
  const rules = JSON.parse(rulesJson)
  srt.FilesystemConfigSchema.parse(rules.filesystem)
  wrapped = await SandboxManager.wrapWithSandbox(argv.map(quote).join(' '), undefined, rules)
} catch (e) {
  console.error(`srt_run: the sandbox could not be set up: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(3)
}

const env = { ...process.env, HOME: home, TMPDIR: join(home, 'tmp') }
for (const k of ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) delete env[k]
const child = spawn('/bin/sh', ['-c', `exec ${wrapped}`], { cwd, env, stdio: 'inherit' })
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig))
child.on('error', e => {
  console.error(`srt_run: ${e.message}`)
  process.exit(3)
})
child.on('exit', (code, signal) => {
  SandboxManager.cleanupAfterCommand()
  process.exit(code ?? 128 + (constants.signals[signal] ?? 0))
})
