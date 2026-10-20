// prep.mjs: what the terminal needs to draw one object: its drawing at a width.
//
//   node --permission --allow-fs-read=<plugin> prep.mjs < {object, w, h, state, mode, event, keys, check, all, labels}
//        ->  {drawing, check}
//
// `labels` are the labels the object's queries read ([{name, values, queries}], from the host): a part made from a row
// that holds a label's value is drawn in the label's color for it (labelKeys).
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
import { valueTone } from '../../panes/labels.js'

/** For each label a query of the object read, the key of that query's rows in the object's data that holds the label's
 *  values (every value it has there is one of the label's), with the label's tone for each value: [{query, key, label,
 *  tones}]. A query whose rows have two such keys, none named as the label, gets none. */
export function labelKeys(object, labels) {
  if (!Array.isArray(labels) || !labels.length) return []
  const seen = {}
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 6) return
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return }
    if (typeof v._ref !== 'string') { Object.values(v).forEach(x => walk(x, depth + 1)); return }
    const keys = (seen[v._ref.split('#')[0]] ||= {})
    for (const [key, x] of Object.entries(v)) if (!key.startsWith('_') && x != null && typeof x !== 'object') (keys[key] ||= new Set()).add(String(x))
  }
  walk(object && object.data, 0)
  const out = []
  for (const l of labels) {
    const values = (l && Array.isArray(l.values) ? l.values : []).map(String)
    if (!values.length) continue
    const tones = Object.fromEntries(values.map(v => [v, valueTone(values, v)]))
    for (const query of l.queries || []) {
      const fit = Object.entries(seen[query] || {}).filter(([, s]) => [...s].every(x => values.includes(x))).map(([key]) => key)
      const key = fit.length === 1 ? fit[0] : fit.includes(l.name) ? l.name : null
      if (key) out.push({ query, key, label: l.name, tones })
    }
  }
  return out
}

export async function prep({ object, w = 96, h = 24, state, mode, event, keys, check, all, labels }) {
  const o = forDrawing(object || {})
  const m = mode === 'detail' ? 'detail' : 'inline'
  // an event (a key, a press) runs the program's handler, which patches the state it then draws with; the program
  // learns the keys the terminal keeps where it is drawn (k.keys), so a key it cannot get is named at its save
  const lk = labelKeys(o, labels)
  const opts = { w, h, state: state && typeof state === 'object' ? state : undefined, mode: m, keys: keys && typeof keys === 'object' ? keys : { taken: hostKeys(m, 'terminal') }, ...(lk.length ? { labels: lk } : {}) }
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
