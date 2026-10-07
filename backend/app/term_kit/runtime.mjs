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
// the longest message thimble sends (app/term_views.py ANSWER_MAX): a longer reader answer comes as an error to page it
const LINE_MAX = 16 * 1024 * 1024

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

// the one-shot timers the program and the kit wait on, each with when it is due, and the intervals with their periods,
// so thimble knows whether the program is still at work once it answered everything sent before (a `sync`): a view
// decoding in chunks between timers, a debounce, a ticker that draws while it loads
const timers = new Map() // the timer -> when it is due (ms since the epoch)
const intervals = new Map() // the interval -> its period in ms
const { setTimeout: setT, clearTimeout: clearT, setImmediate: setI, clearImmediate: clearI, setInterval: setIv, clearInterval: clearIv } = globalThis
globalThis.setTimeout = function (fn, ms, ...args) {
  const t = setT(function (...a) {
    timers.delete(t)
    if (typeof fn === 'function') return fn.apply(this, a)
  }, ms, ...args)
  timers.set(t, Date.now() + Math.max(1, Number(ms) || 0))
  return t
}
globalThis.clearTimeout = function (t) {
  if (t !== null && t !== undefined) for (const k of timers.keys()) if (k === t || +k === +t) timers.delete(k)
  return clearT(t)
}
globalThis.setInterval = function (fn, ms, ...args) {
  const t = setIv(fn, ms, ...args)
  intervals.set(t, Math.max(1, Number(ms) || 1))
  return t
}
globalThis.clearInterval = function (t) {
  if (t !== null && t !== undefined) for (const k of intervals.keys()) if (k === t || +k === +t) intervals.delete(k)
  return clearIv(t)
}
globalThis.setImmediate = function (fn, ...args) {
  const t = setI((...a) => {
    timers.delete(t)
    fn(...a)
  }, ...args)
  timers.set(t, Date.now())
  return t
}
globalThis.clearImmediate = function (t) {
  timers.delete(t)
  return clearI(t)
}

// the answer to a sync, once everything sent before it is handled and the frames it drew are out: the ms until the next
// timer the program waits on and the shortest interval's period (each null for none)
function synced(id) {
  setI(() => {
    let due = null
    const now = Date.now()
    for (const at of timers.values()) due = due === null ? Math.max(0, at - now) : Math.min(due, Math.max(0, at - now))
    let every = null
    for (const ms of intervals.values()) every = every === null ? ms : Math.min(every, ms)
    write({ t: 'synced', id, due, every })
  })
}

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
  for (const m of queue.splice(0)) (m.t === 'sync' ? synced(m.id) : kit.handle(m))
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
  if (msg.t === 'sync') return void (started ? synced(msg.id) : queue.push(msg))
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
