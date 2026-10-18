// verb.mjs: run one verb on one object, the way a key press, a click or /verb runs it.
//
//   node verb.mjs list                         -> {verbs, problems}
//   node verb.mjs run <name|key> < {object, region, root, w, ...}  -> {verb, text?, note?, ask?, saved?, error?, need?}
//
// It imports lean/verbs/<name>/run.mjs and calls run(ctx) with:
//
//   ctx.object     the object as the kernel keeps it: {id, version, title, program, data, lineage, text, ...}
//   ctx.region     the selected region's id, or null; ctx.regionMeta its meta from the drawing
//   ctx.refs       the kernel refs behind the region (or behind the object's citations, with none selected), which
//                  `ctx.kernel.resolve` opens down to their source rows
//   ctx.drawing    the object as the person sees it: its program's drawing (regions, cites, examples, knobs)
//   ctx.state      the knobs' values the person set ({} for none)
//   ctx.args       the words the person typed after the verb (`/verb squeeze fuller`), else ''
//   ctx.root       the folder under analysis (where thimble/ is)
//   ctx.verb       the verb's own verb.json, every field kept, with `dir`, its folder
//   ctx.skill      the text of the verb's SKILL.md ('' when it has none)
//   ctx.kernel     the `lean` command: run(args, {input}) -> {code, stdout, stderr}; json(args) parses its --json;
//                  resolve(ref, n) and list(id) as `lean resolve`/`lean list`; objects() every object as saved;
//                  save(name, spec) saves an object and returns {id, v, out}
//   ctx.draw       {runProgram, renderTerm, renderSvg, gridText}: the drawing contract, to draw or check an object
//   ctx.model      {complete(request), fork(request)}: one quiet call to the session's own model, as $.model.complete
//                  (no history) and $.model.fork (over the conversation) answer it: {isAnswered, text, usage, reason}
//   ctx.w          the columns the person's terminal has for it
//
// run(ctx) returns any of:
//   object  an object to show: a spec this runner saves with `lean save` ({name?, title, program, data, ...}; a
//           `lineage` of the verb's own rides along under `declared`), or one the verb saved itself ({id, version})
//   text    words for the person; Claude reads them too
//   note    words for Claude alone, before its next reply
//   ask     a request for Claude, sent as a prompt once the session is idle, when the verb needs Claude to do the work
//           with its tools (a view that needs a new query, say)
// Any other field is kept and handed back.
//
// The model, across a process: the hooks module holds $.model, this process does not. A call of ctx.model that has
// no answer yet stops the run: the runner hands back {need: {kind, request, key}}, the module makes the call and runs
// the verb again with every answer so far in `answers`, and the same call then resolves at once. A verb needs nothing
// for this but to call ctx.model again the same way, which a run of the same input does.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProgram } from '../../draw/sandbox-node.mjs'
import { renderSvg } from '../../draw/svg.js'
import { gridText, renderTerm } from '../../draw/term.js'
import { findVerb, listVerbs } from './registry.mjs'

const LEAN = fileURLToPath(new URL('../../bin/lean', import.meta.url))

export function kernelFor(root, lean = LEAN) {
  const run = (args, { input } = {}) => {
    const r = spawnSync(lean, args, { cwd: root, input: input ?? '', encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, LEAN_ROOT: root } })
    return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || String(r.error || '') }
  }
  const json = (args) => {
    const r = run([...args, '--json'])
    try { return JSON.parse(r.stdout) } catch { return { error: (r.stdout + r.stderr).trim().slice(0, 600) } }
  }
  return {
    run,
    json,
    resolve: (ref, n = 5) => json(['resolve', ref, '-n', String(n)]),
    list: id => json(id ? ['list', id] : ['list']),
    objects() {
      const d = join(root, 'thimble', 'objects')
      if (!existsSync(d)) return []
      const out = []
      for (const f of readdirSync(d).filter(x => x.endsWith('.json')).sort()) {
        try { out.push(JSON.parse(readFileSync(join(d, f), 'utf8'))) } catch { /* a file being written */ }
      }
      return out
    },
    save(name, spec) {
      const r = run(['save', ...(name ? [name] : [])], { input: JSON.stringify(spec) })
      const m = /saved (\S+) v(\d+)/.exec(r.stdout)
      return m ? { id: m[1], v: Number(m[2]), out: r.stdout } : { error: (r.stdout + r.stderr).trim().slice(0, 600) }
    },
  }
}

const keyOf = (kind, request) => createHash('sha256').update(kind + '\n' + JSON.stringify(request)).digest('hex').slice(0, 24)

/** ctx.model for one run: answers from `answers`, else the first call without one is said in `need` and stops it. */
function modelFor(answers, need) {
  const call = kind => async request => {
    const key = keyOf(kind, request)
    if (answers && answers[key]) return answers[key]
    if (!need.call) need.call = { kind, request, key }
    throw Object.assign(new Error('the model call is being made; this run waits for it'), { needsModel: true })
  }
  return { complete: call('complete'), fork: call('fork') }
}

/** The spec a verb's object becomes for `lean save`: the kernel keeps its own lineage, so a verb's rides along as
 *  declared, and the kernel's own fields (id, version) are left to it. */
export function specOf(o, verbName) {
  const { name, id, version, v, lineage, ...spec } = o
  if (lineage !== undefined) spec.declared = { ...(spec.declared && typeof spec.declared === 'object' ? spec.declared : {}), [verbName]: lineage }
  return { name: name || id || null, spec }
}

/** Run one verb. Never throws: a verb that fails comes back as {error}. */
export async function runVerb(word, input, { dir, lean } = {}) {
  const { verbs } = listVerbs(dir)
  const verb = findVerb(verbs, word)
  if (!verb) return { error: `no verb "${word}"; the verbs: ${verbs.map(v => v.name).join(', ') || 'none'}` }
  const root = String(input.root || process.cwd())
  const kernel = kernelFor(root, lean)
  const need = {}
  let skill = ''
  try { skill = readFileSync(join(verb.dir, 'SKILL.md'), 'utf8') } catch { skill = '' }
  const ctx = {
    object: input.object || null,
    region: input.region || null,
    regionMeta: input.regionMeta || null,
    refs: Array.isArray(input.refs) ? input.refs : [],
    drawing: input.drawing || null,
    state: input.state && typeof input.state === 'object' ? input.state : {},
    args: typeof input.args === 'string' ? input.args : '',
    root,
    verb: { ...verb },
    skill,
    kernel,
    draw: { runProgram, renderTerm, renderSvg, gridText },
    model: modelFor(input.answers, need),
    w: Number(input.w) || 96,
  }
  let out
  try {
    const mod = await import(pathToFileURL(join(verb.dir, 'run.mjs')).href)
    if (typeof mod.run !== 'function') return { verb: verb.name, error: `${verb.folder}/run.mjs exports no run(ctx)` }
    out = (await mod.run(ctx)) || {}
  } catch (e) {
    if (need.call) return { verb: verb.name, need: need.call }
    return { verb: verb.name, error: `${verb.name} failed: ${String(e && e.message || e).slice(0, 600)}` }
  }
  // a verb that caught the stop itself still waits for its call
  if (need.call) return { verb: verb.name, need: need.call }
  const res = { ...out, verb: verb.name }
  const o = out.object
  if (o && typeof o === 'object') {
    delete res.object
    if (o.id && o.program == null) res.saved = { id: String(o.id), v: Number(o.version ?? o.v) || null }
    else {
      const { name, spec } = specOf(o, verb.name)
      const s = kernel.save(name || (input.object ? `${input.object.id}-${verb.name}`.replace(/^\d+-/, '') : verb.name), spec)
      if (s.error) res.error = `${verb.name} made an object the kernel did not save: ${s.error}`
      else res.saved = { id: s.id, v: s.v }
    }
  }
  for (const k of ['text', 'note', 'ask']) if (res[k] != null && typeof res[k] !== 'string') res[k] = JSON.stringify(res[k])
  return res
}

async function main() {
  const [cmd, word] = process.argv.slice(2)
  if (cmd === 'list') { process.stdout.write(JSON.stringify(listVerbs())); return }
  if (cmd !== 'run') { process.stderr.write('usage: verb.mjs list | run <verb> < input.json\n'); process.exit(2) }
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  process.stdout.write(JSON.stringify(await runVerb(word, input)))
}

const self = fileURLToPath(import.meta.url)
const argv1 = (() => { try { return realpathSync(process.argv[1] || '') } catch { return process.argv[1] } })()
if (argv1 === self) main().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1) })
