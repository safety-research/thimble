// sandbox-node.mjs: run an object's program in a sandbox and print its drawing (kit.js) as JSON.
//
//   node --permission --allow-fs-read=<this folder> sandbox-node.mjs < {program, data, w, h, mode, limit}
//
// The program runs in a fresh vm context that holds the JavaScript built-ins, kit.js and the input as JSON text,
// nothing of this process: no require, no process, no fetch, no timers, no file system. Only strings cross into the
// context and only a JSON string comes out, so no object of this realm is reachable from the program. The run has a
// time limit (vm timeout) and microtasks are drained inside it. Started with --permission, this process itself can
// read only this folder and cannot write files or start processes.
//
// As a module: runProgram(object, opts) -> drawing, the same sandbox in this process (tests, the browser demo build).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const KIT_SOURCE = readFileSync(HERE + 'kit.js', 'utf8')
const KIT_SCRIPT = new vm.Script(KIT_SOURCE, { filename: 'kit.js' })
const RUN_SCRIPT = new vm.Script(
  'JSON.stringify(DrawKit.run(__program, JSON.parse(__data), JSON.parse(__opts)))',
  { filename: 'run.js' })

/**
 * Run `object.program` on `object.data` in a fresh vm context.
 * @param {{program: string, data?: unknown}} object
 * @param {{w?: number, h?: number, mode?: string, limit?: number, state?: object}} [opts] state: the knobs' values (k.knob)
 * @returns {object} the drawing
 */
export function runProgram(object, opts = {}) {
  const limit = Math.max(50, Math.min(10000, Number(opts.limit) || 2000))
  const context = vm.createContext(Object.create(null), {
    name: 'draw-program',
    codeGeneration: { strings: true, wasm: false },
    microtaskMode: 'afterEvaluate',
  })
  // only strings cross in
  context.__program = String(object && object.program != null ? object.program : '')
  context.__data = JSON.stringify(object && object.data !== undefined ? object.data : {})
  context.__opts = JSON.stringify({ w: opts.w, h: opts.h, mode: opts.mode, limit, state: opts.state })
  KIT_SCRIPT.runInContext(context, { timeout: 1000 })
  let text
  try {
    text = RUN_SCRIPT.runInContext(context, { timeout: limit + 500 })
  } catch (e) {
    // a vm timeout, or a program that broke the kit itself: report it as a drawing that says so
    const name = /timed out/i.test(String(e && e.message)) ? 'TimeLimit' : 'SandboxError'
    return {
      kit: 1, w: opts.w || 96, h: opts.h || 24, mode: opts.mode || 'inline', regions: [], cites: {}, examples: {}, warnings: [], ms: limit,
      error: { name, message: name === 'TimeLimit' ? `the program ran past the ${limit} ms limit` : String(e && e.message).slice(0, 300), line: null, source: '' },
      root: { t: 'frame', title: [{ s: 'program error', tone: 'bad', b: true }], tone: 'bad', grow: 1, kid: { t: 'text', runs: [{ s: name + ': the program was stopped, so nothing was drawn', tone: 'dim' }] } },
    }
  }
  if (typeof text !== 'string') throw new Error('the sandbox returned no drawing')
  return JSON.parse(text)
}

async function main() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const items = Array.isArray(input.batch) ? input.batch : [input]
  const out = items.map(it => runProgram(it, it))
  process.stdout.write(JSON.stringify(Array.isArray(input.batch) ? out : out[0]))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1) })
}
