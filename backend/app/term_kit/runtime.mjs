// The sandboxed process that runs one view's view.term.js (app/term_views.py starts it, one per open view):
//
//   node --permission --allow-fs-read=<this folder> runtime.mjs
//
// inside Anthropic's sandbox runtime (or bubblewrap) with no network and no file of the user's. Node's permission model
// lets it read this folder alone (the kit) and start no process, worker or addon; the program's source arrives in the
// first message, so the program reads no file either. Messages are JSON, one per line: thimble's on stdin (init,
// resize, key, click, drag, wheel, answer, labels, open), the program's on stdout (frame, query, cancel, act, state,
// error, log). docs/terminal-views.md, "The protocol".
import { createInterface } from 'node:readline'

import * as kit from './kit.mjs'

const KIT_URL = new URL('./kit.mjs', import.meta.url).href
const LINE_MAX = 4 * 1024 * 1024

function write(msg) {
  let text
  try {
    text = JSON.stringify(msg)
  } catch (e) {
    text = JSON.stringify({ t: 'error', message: `a message could not be sent: ${e && e.message}` })
  }
  process.stdout.write(`${text}\n`)
}

kit.__driver.connect(write)

// what the program prints goes to thimble as a log line, never into the protocol
for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
  console[name] = (...args) => write({ t: 'log', level: name, text: args.map((a) => (typeof a === 'string' ? a : safe(a))).join(' ').slice(0, 2000) })
}
function safe(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** The program's source with its imports of the kit pointed at it (`import { draw } from 'thimble-term'`). */
export function linked(source) {
  return `${String(source).replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])thimble-term\2/g, (_, a, q) => `${a}${q}${KIT_URL}${q}`)}\n//# sourceURL=view.term.js\n`
}

function describe(e) {
  const msg = e && e.message ? e.message : String(e)
  const at = /view\.term\.js:(\d+)/.exec(String(e && e.stack))
  return `${e && e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${msg}${at ? ` (view.term.js line ${at[1]})` : ''}`
}

process.on('uncaughtException', (e) => {
  write({ t: 'error', message: describe(e) })
  kit.__driver.fail(describe(e))
})
process.on('unhandledRejection', (e) => {
  if (e && e.name === 'AbortError') return
  write({ t: 'error', message: describe(e) })
  kit.__driver.fail(describe(e))
})

let started = false
let starting = false
const queue = []

async function start(init) {
  kit.handle({ ...init, t: 'init' })
  try {
    await import(`data:text/javascript;base64,${Buffer.from(linked(init.source || '')).toString('base64')}`)
  } catch (e) {
    write({ t: 'error', message: describe(e) })
    kit.__driver.fail(describe(e))
  }
  started = true
  for (const m of queue.splice(0)) kit.handle(m)
  kit.redraw()
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim() || line.length > LINE_MAX) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (!msg || typeof msg !== 'object') return
  if (msg.t === 'init') {
    if (!starting) {
      starting = true
      void start(msg)
    }
    return
  }
  if (!started) return void queue.push(msg)
  kit.handle(msg)
})
rl.on('close', () => process.exit(0))
