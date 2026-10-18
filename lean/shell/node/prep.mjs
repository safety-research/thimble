// prep.mjs: what the terminal needs to draw one object: its drawing at a width, and the verbs for it.
//
//   node --permission --allow-fs-read=<lean> prep.mjs < {object, w, h, state}  ->  {drawing, verbs, problems}
//
// `state` holds the knobs' values the person set (k.knob): the program runs with them.
//
// The object's program runs in the drawing contract's sandbox (draw/sandbox-node.mjs: a fresh vm context with the
// toolkit and the data only). Started with --permission, this process reads only the plugin's folder and writes no
// file and starts no process, so neither the program nor a verb's hint.mjs can do more than compute.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { forDrawing } from '../object.js'
import { verbsFor } from './registry.mjs'

export async function prep({ object, w = 96, h = 24, state }) {
  const o = forDrawing(object || {})
  const drawing = runProgram(o, { w, h, state: state && typeof state === 'object' ? state : undefined })
  const { verbs, problems } = await verbsFor(object || {}, { drawing })
  return { drawing, verbs, problems }
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
