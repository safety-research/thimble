// verb.mjs: run one verb on one object, the way a key press, a click or /verb runs it.
//
//   node verb.mjs list                         -> {verbs, problems}
//   node verb.mjs run <name|key> < {object, region, root, lean, w}  -> {verb, text?, note?, ask?, saved?, error?}
//
// It imports lean/verbs/<name>/run.mjs and calls run(ctx) with:
//
//   ctx.object   the object as the kernel keeps it: {id, version, title, program, data, lineage, text, ...}
//   ctx.region   the selected region's id, or null; ctx.regionMeta its meta from the drawing, when it ran
//   ctx.refs     the kernel refs behind the region (or behind the object's citations, with none selected), which
//                `ctx.kernel.resolve` opens down to their source rows
//   ctx.root     the folder under analysis (where thimble/ is)
//   ctx.verb     the verb's own verb.json, every field kept
//   ctx.kernel   the `lean` command: run(args, {input}) -> {code, stdout, stderr}; resolve(ref, n) and list(id) parse
//                its --json; save(name, spec) saves an object and returns {id, v, out}
//   ctx.draw     {runProgram, renderTerm, renderSvg, gridText}: the drawing contract, to draw or check an object
//   ctx.w        the columns the person's terminal has for it
//
// run(ctx) returns any of:
//   object  an object to show: one the verb saved itself ({id} or {id, version}), or a spec this runner saves with
//           `lean save` ({name?, title, program, data, ...}), so its lineage is the kernel's like any other object
//   text    words for the person; Claude reads them too, as a command's output
//   note    words for Claude alone, kept beside the output
//   ask     a request for Claude, sent as a prompt once the session is idle, when the verb needs the model to do
//           its work (a squeeze written by Claude, say); the person sees it in the transcript as sent by thimble
// Any other field is kept and handed back.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
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
    resolve: (ref, n = 5) => json(['resolve', ref, '-n', String(n)]),
    list: id => json(id ? ['list', id] : ['list']),
    save(name, spec) {
      const r = run(['save', ...(name ? [name] : [])], { input: JSON.stringify(spec) })
      const m = /saved (\S+) v(\d+)/.exec(r.stdout)
      return m ? { id: m[1], v: Number(m[2]), out: r.stdout } : { error: (r.stdout + r.stderr).trim().slice(0, 600) }
    },
  }
}

/** Run one verb. Never throws: a verb that fails comes back as {error}. */
export async function runVerb(word, input, { dir, lean } = {}) {
  const { verbs } = listVerbs(dir)
  const verb = findVerb(verbs, word)
  if (!verb) return { error: `no verb "${word}"; the verbs: ${verbs.map(v => v.name).join(', ') || 'none'}` }
  const root = String(input.root || process.cwd())
  const kernel = kernelFor(root, lean)
  const ctx = {
    object: input.object || null,
    region: input.region || null,
    regionMeta: input.regionMeta || null,
    refs: Array.isArray(input.refs) ? input.refs : [],
    root,
    verb: { ...verb },
    kernel,
    draw: { runProgram, renderTerm, renderSvg, gridText },
    w: Number(input.w) || 96,
  }
  let out
  try {
    const mod = await import(pathToFileURL(join(verb.dir, 'run.mjs')).href)
    if (typeof mod.run !== 'function') return { verb: verb.name, error: `${verb.folder}/run.mjs exports no run(ctx)` }
    out = (await mod.run(ctx)) || {}
  } catch (e) {
    return { verb: verb.name, error: `${verb.name} failed: ${String(e && e.message || e).slice(0, 600)}` }
  }
  const res = { ...out, verb: verb.name }
  const o = out.object
  if (o && typeof o === 'object') {
    delete res.object
    if (o.id && (o.version != null || o.v != null || !o.program)) res.saved = { id: String(o.id), v: Number(o.version ?? o.v) || null }
    else {
      const { name, ...spec } = o
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
