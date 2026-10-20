// prep.mjs: what the terminal needs to draw one object: its drawing at a width.
//
//   node --permission --allow-fs-read=<plugin> prep.mjs < {object, w, h, state, mode, event, keys, check, all}
//        ->  {drawing, check}
//
// `state` holds the knobs' values the person set (k.knob): the program runs with them. `mode` is where it is drawn
// (k.mode): 'inline' under a reply, 'detail' in the detail view. `check` (a save) also tries each interaction the
// drawing declares once, as the person would (draw/exercise.mjs): `check.line` is the one line for Claude when one
// fails, with the tries and their milliseconds. `all` (the detail's "all at once") draws every page of that knob
// (true: the card's page knob), one after another (draw/kit.js).
//
// The object's program runs in the drawing contract's sandbox (draw/sandbox-node.mjs: a fresh vm context with the
// toolkit and the data only). Started with --permission, this process reads only the plugin's folder and writes no
// file and starts no process, so the program can do no more than compute.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { exercise, exerciseLine } from '../../draw/exercise.mjs'
import { forDrawing } from '../object.js'
import { hostKeys } from '../../panes/host.js'

export async function prep({ object, w = 96, h = 24, state, mode, event, keys, check, all }) {
  const o = forDrawing(object || {})
  const m = mode === 'detail' ? 'detail' : 'inline'
  // an event (a key, a press) runs the program's handler, which patches the state it then draws with; the program
  // learns the keys the terminal keeps where it is drawn (k.keys), so a key it cannot get is named at its save
  const opts = { w, h, state: state && typeof state === 'object' ? state : undefined, mode: m, keys: keys && typeof keys === 'object' ? keys : { taken: hostKeys(m, 'terminal') } }
  const drawing = runProgram(o, { ...opts, event: event && typeof event === 'object' ? event : undefined, ...(all ? { all } : {}) })
  const tried = check && !event && !drawing.error ? exercise(o, opts, drawing) : null
  const checked = tried ? { line: exerciseLine(tried), tried: tried.tried, total: tried.total, failed: tried.failed.length, cut: tried.cut, ms: tried.ms } : undefined
  return { drawing, ...(checked ? { check: checked } : {}) }
}

async function main() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  process.stdout.write(JSON.stringify(await prep(input)))
}

const self = fileURLToPath(import.meta.url)
const argv1 = (() => { try { return realpathSync(process.argv[1] || '') } catch { return process.argv[1] } })()
if (argv1 === self) main().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1) })
