// start.mjs: the card runner for the Node tests, started as the hooks start it (ask.ts): sandbox/setup.mjs installs srt
// in the test's THIMBLE_HOME (test-home.mjs) and checks it, and argv.mjs gives the command, in the sandbox. A machine
// where the sandbox does not work fails the test with setup.mjs's reason, since cards never run without it.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runnerArgv } from '../argv.mjs'

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')

/** The sandbox from setup.mjs: {ok, node, srt, platform, why, fix}. */
export function sandbox() {
  const r = spawnSync(process.execPath, [join(PLUGIN, 'sandbox', 'setup.mjs'), '--json'], { encoding: 'utf8', timeout: 300000 })
  return JSON.parse(String(r.stdout).trim().split('\n').pop() || '{}')
}

/** A runner that reads the card copies in `cards`, with its own folder for its socket: {sock, ask, stop}. */
export async function startRunner(cards) {
  const s = sandbox()
  if (!s.ok) throw new Error(`the sandbox does not work here: ${s.why}. ${s.fix}`)
  const run = mkdtempSync(join(tmpdir(), 'thimble-run-'))
  const sock = join(run, 'cards.sock')
  const argv = runnerArgv({ plugin: PLUGIN, node: s.node, srt: s.srt, platform: s.platform, cards, run, sock, home: homedir(), thimbleHome: process.env.THIMBLE_HOME, path: process.env.PATH })
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] })
  let said = ''
  child.stderr.on('data', d => { said += d })
  const ask = (op, body) => new Promise((resolve, reject) => {
    const q = http.request({ socketPath: sock, path: `/${op}`, method: 'POST' }, res => {
      let t = ''
      res.on('data', d => { t += d })
      res.on('end', () => resolve(JSON.parse(t)))
    })
    q.on('error', reject)
    q.end(JSON.stringify(body))
  })
  const stop = () => { child.kill(); rmSync(run, { recursive: true, force: true }) }
  for (let i = 0; i < 500; i++) {
    try { if ((await ask('ping', {})).ok) return { sock, ask, stop } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 20))
  }
  stop()
  throw new Error(`the runner did not start: ${said.trim()}`)
}
