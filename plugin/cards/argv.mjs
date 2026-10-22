// argv.mjs: the command that starts the card runner (runner.mjs), for the hooks (ask.ts) and the tests alike. Pure.
//
//   runnerArgv({plugin, cards, run, sock, path})  `env -i` and the node command: an empty environment but PATH (the
//       runner reads no variable, so none of the session's reaches it), Node's permission model (read the plugin's
//       cards/ code, core/text.js and the session's card copies; write only the socket's folder), no code made from
//       strings, at most 1 GB of memory
export function runnerArgv({ plugin, cards, run, sock, path = '/usr/bin:/bin' }) {
  const here = `${String(plugin).replace(/\/+$/, '')}`
  return [
    'env', '-i', `PATH=${path}`,
    'node', '--permission', `--allow-fs-read=${here}/cards`, `--allow-fs-read=${here}/core/text.js`, `--allow-fs-read=${cards}`,
    `--allow-fs-write=${run}`, '--disallow-code-generation-from-strings', '--max-old-space-size=1024',
    `${here}/cards/runner.mjs`, sock,
  ]
}
