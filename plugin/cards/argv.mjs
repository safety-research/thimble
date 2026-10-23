// argv.mjs: the command that starts the card runner (runner.mjs) in Anthropic's sandbox runtime (srt), for the hooks
// (ask.ts), sandbox/setup.mjs's check and the tests alike. Pure: no `$`, no file system.
//
//   runnerCommand({plugin, node, cards, run, sock})   the runner itself: Node's permission model (it reads the plugin's
//       cards/ code, core/text.js and the session's card copies, and writes only its own folder `run`), no code made
//       from strings, at most 1 GB of memory. The browser workbench starts the same command (cardrunner.py).
//   runnerRules({platform, plugin, node, srt, cards, run, home, thimbleHome})   srt's rules for it: no network (no
//       domain is allowed; only the runner's own Unix socket), writes only `run`, and reads only the runner's code, the
//       card copies, `run`, and the Node it runs on with what Node needs of the system (Linux: everything else is
//       hidden; macOS: the folders that hold people's files, the home folder and thimble's home are hidden)
//   runnerArgv({..., path})   the whole command: run.mjs, with an environment that holds only PATH and the runner's
//       own folder, wraps an empty environment (`env -i`) and runnerCommand in srt with runnerRules
//
// `node` is the absolute path of the Node binary (process.execPath), `srt` the folder srt is installed in
// (setup.mjs), `run` the runner's own folder (mode 700), which holds its socket `sock` (a path of at most SOCKET_MAX
// characters) and is its TMPDIR. srt itself makes no socket for the runner: it starts no proxy, since no domain is
// allowed.

// the longest path of the runner's socket: a Unix socket's path holds at most 108 bytes on Linux, 104 on macOS
export const SOCKET_MAX = 100

// Linux: what is shown of the system, for Node and the shell srt starts it from
export const LINUX_SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/etc/ld.so.cache']
// macOS: where people's files are, hidden besides the home folder and thimble's home
export const MACOS_HIDDEN = ['/Users', '/Volumes', '/private/tmp', '/private/var/tmp', '/private/var/folders']
// srt lets every command it runs write its own temp folder; the runner may not (on Linux bwrap.sh also hides it)
const NO_WRITE = ['/tmp/claude', '/private/tmp/claude']

const trim = p => String(p).replace(/\/+$/, '') || '/'
const parent = p => trim(p).replace(/\/[^/]*$/, '') || '/'
const literal = path => ({ path, literal: true })

export function runnerCommand({ plugin, node = 'node', cards, run, sock }) {
  const here = trim(plugin)
  return [
    node, '--permission', `--allow-fs-read=${here}/cards`, `--allow-fs-read=${here}/core/text.js`, `--allow-fs-read=${cards}`,
    `--allow-fs-write=${run}`, '--disallow-code-generation-from-strings', '--max-old-space-size=1024',
    `${here}/cards/runner.mjs`, sock,
  ]
}

/** srt's seccomp helper, which runs inside the sandbox on Linux. */
export const seccompDir = srt => `${trim(srt)}/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp`

export function runnerRules({ platform, plugin, node, srt, cards, run, home, thimbleHome }) {
  const here = trim(plugin)
  const linux = platform === 'linux'
  // the Node binary's installation (<prefix>/bin/node): its own libraries lie under the prefix
  const nodeDir = parent(parent(node))
  const shown = [...(linux ? [...LINUX_SYSTEM, seccompDir(srt)] : []), nodeDir, `${here}/cards`, `${here}/core/text.js`, trim(cards), trim(run)]
  const hidden = linux ? ['/'] : [...MACOS_HIDDEN, trim(home), trim(thimbleHome)]
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      // the runner listens on its socket, in its own folder: Linux's seccomp filter otherwise refuses any Unix socket.
      // Allowing them reaches no other program's: a network rule makes srt start bwrap with a network namespace of its
      // own (--unshare-net), which holds the abstract sockets the runner can name, and a socket file is reached only
      // by its path, which the file rules hide unless it is in the folders they show
      ...(linux ? { allowAllUnixSockets: true } : { allowUnixSockets: [trim(run)] }),
    },
    filesystem: {
      denyRead: [...new Set(hidden)].map(literal),
      allowRead: [...new Set(shown.filter(p => p !== '/'))].map(literal),
      allowWrite: [literal(trim(run))],
      denyWrite: NO_WRITE.map(literal),
    },
    ...(linux ? { bwrapPath: `${here}/sandbox/bwrap.sh` } : {}),
  }
}

export function runnerArgv({ plugin, node, srt, cards, run, sock, platform, home, thimbleHome, path = '/usr/bin:/bin' }) {
  const here = trim(plugin)
  const rules = runnerRules({ platform, plugin, node, srt, cards, run, home, thimbleHome })
  return [
    'env', '-i', `PATH=${path}`, `HOME=${run}`, `TMPDIR=${run}`, `CLAUDE_CODE_TMPDIR=${run}`, 'LANG=C.UTF-8',
    node, `${here}/sandbox/run.mjs`, '--srt', trim(srt), JSON.stringify(rules), '--',
    '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', ...runnerCommand({ plugin, node, cards, run, sock }),
  ]
}
