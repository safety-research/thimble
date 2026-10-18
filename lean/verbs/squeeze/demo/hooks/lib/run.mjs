// run.mjs: the Squeeze verb (key s). Squeeze makes something shorter on the dimensions that matter, while each
// squeezed line stays attached to the spans of the original it came from.
//
//   run(ctx) -> {object?, text?, note?}
//
// ctx, from the shell (or the demo plugin, or cli.mjs):
//   object   what to squeeze: anything with `text` (a reply, a report, a kernel object), or `units` [{id, text}] (a
//            session's turns, a run's steps), or a squeeze object made earlier (then `args` moves it)
//   region   the selected region id, if any (`line-2` of a squeeze: `why` tells where it came from)
//   args     optional words: '' makes a squeeze (or squeezes more), 'shorter', 'fuller', a dimension's id (its next
//            level), 'reader=new to it', 'original', 'why 2', or any request in plain words ("for my manager")
//   model    {complete(request)}: the plugin's $.model.complete, wrapped (req => $.model.complete(req))
//   skill    the text of SKILL.md (else ctx.read(<this folder>/SKILL.md) is tried)
//   verb     verb.json as parsed: its `model`, `effort` and `maxTokens` are the defaults below
//
// It returns the new object (a squeeze: program + data + lineage, drawn by program.mjs), a short plain text of what
// the person sees (for a renderer that draws no objects), and a note for main (one line it may read).
//
// ---------------------------------------------------------------------------------------------- how versions are made
// Both ways, with one skill (SKILL.md):
//
// 1. Pressing s, and the default that long text arrives squeezed, run here: one quiet $.model.complete call with
//    SKILL.md as its system prompt and the original cut into numbered spans as its prompt. The model picks the
//    dimensions for THIS text and writes the version shown first plus up to two neighbors; a move to a point not yet
//    written is one more call that writes that version alone. Why here and not main:
//    - no clutter: main's chat gets no tool row and no second copy of the text; the person sees only the object;
//    - cost: the call reads the text once (a few thousand tokens) on a mid-size model, instead of main's model
//      writing every version and carrying them in its context for the rest of the session;
//    - Manual mode stays manual: the call reads only text already on screen and writes no file. run() returns the
//      object; the caller keeps it outside the person's folder ($THIMBLE_HOME) until the person keeps it.
// 2. Main writes a squeeze, guided by the same skill, when the person asks for one in words, or when a good squeeze
//    needs files main has not shown yet (a transcript behind a summary). Main reads through its own tools, so every
//    read and write goes through the permission mode, and it saves with `lean verb squeeze ... --from FILE`, a Bash
//    call Manual mode asks about like any other. cli.mjs builds the same object from main's JSON.
//
// No imports beyond this folder and no Node: the shell's hooks module imports this file.

import { cut, expand, lineCount, numbered, plain } from './spans.mjs'
import { PROGRAM } from './program.mjs'

const DEFAULTS = { model: 'sonnet', effort: 'low', maxTokens: 8000, timeoutMs: 120000 }
const MAX_DIMS = 3
const MAX_LEVELS = 5

/** The JSON a model call answers with. The code reads exactly this; SKILL.md says why and shows it in examples. */
export const FORMAT = `Answer with one JSON object and nothing else (no prose, no code fence):
{"dims": [{"id": "length", "name": "length", "levels": ["one line", "short", "most of it"], "why": "one line on why this matters for this text"}],
 "first": {"length": 0},
 "versions": [{"at": {"length": 0},
               "lines": [{"text": "a squeezed line", "from": ["1.1", "3.2-3.4"]}],
               "out": [{"what": "a few words naming what this version leaves out", "from": ["4.1-4.6"]}]}]}
- dims: one to three, chosen for this text and this reader. List first the one that makes the text shorter: the
  person's "shorter" and "fuller" move along it. Levels go from most squeezed to fullest, two to four of them. The
  original itself is always one key away, so no level needs to be the whole text.
- first: where the version the person sees first sits, one level per dimension.
- versions: the one at "first", and at most two neighbors the person is likely to want next. Each line names in
  "from" every span it came from, by id or range. "out" names what the version leaves out.`

// ---------------------------------------------------------------------------------------------- small helpers

function hash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'text'
const atKey = at => Object.keys(at || {}).sort().map(k => `${k}=${at[k]}`).join('&')
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)))

/** The skill's text without its frontmatter. */
function skillText(s) {
  return String(s || '').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}

/** The first JSON object in a model's answer (a code fence or a line of prose around it is tolerated). */
export function parseAnswer(text) {
  const t = String(text || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('the answer holds no JSON object')
  return JSON.parse(t.slice(a, b + 1))
}

/** Numbers a line states that none of its spans states: a squeezed line must not add a number. */
export function strayNumbers(line, spanTexts) {
  const norm = s => String(s).replace(/(\d),(?=\d{3}\b)/g, '$1')
  const src = norm(spanTexts.join(' '))
  const nums = (norm(line).match(/\d+(?:\.\d+)?/g) || []).filter(n => n.length > 1 || Number(n) > 9)
  return [...new Set(nums.filter(n => !new RegExp(`(^|[^\\d.])${n.replace('.', '\\.')}(?![\\d])`).test(src)))]
}

// ---------------------------------------------------------------------------------------------- the original

/** What an object offers to squeeze: its spans and blocks, how long it is, and how to name it. */
export function originalOf(object) {
  const o = object || {}
  if (Array.isArray(o.units) && o.units.length) {
    const spans = o.units.map((u, i) => ({ id: String(u.id ?? i + 1), b: i + 1, kind: 'unit', text: String(u.text ?? ''), cites: u.ref ? [u.ref] : [] }))
    return {
      spans, blocks: spans.map(s => ({ b: s.b, kind: 'unit', lead: '', spans: [s.id] })),
      lines: spans.length, text: spans.map(s => s.text).join('\n'),
    }
  }
  const text = typeof o.text === 'string' ? o.text : typeof o.data?.text === 'string' ? o.data.text : ''
  const { spans, blocks } = cut(text)
  return { spans, blocks, lines: lineCount(text), text }
}

export const isSqueeze = o => !!(o && o.kind === 'squeeze' && o.data && Array.isArray(o.data.versions))

/** Is this text long enough that it should arrive squeezed? (the default; the shell asks before it squeezes) */
export function isLong(text, opts = {}) {
  const lines = lineCount(text)
  const chars = String(text || '').length
  return lines >= (opts.lines ?? 16) || chars >= (opts.chars ?? 1600)
}

// ---------------------------------------------------------------------------------------------- reading an answer

/** A model's (or main's) answer, held to what the object needs: known span ids, levels in range, a problem named on
 *  each line that cites no span or states a number its spans do not. */
export function normalize(raw, spans, prevDims) {
  const problems = []
  const byId = new Map(spans.map(s => [s.id, s]))
  let dims = Array.isArray(raw.dims) && raw.dims.length ? raw.dims : prevDims || []
  dims = dims.slice(0, MAX_DIMS).map((d, i) => {
    const levels = (Array.isArray(d.levels) ? d.levels : []).map(x => String(x)).filter(Boolean).slice(0, MAX_LEVELS)
    return { id: slug(d.id || d.name || `dim${i + 1}`), name: String(d.name || d.id || `dimension ${i + 1}`), levels: levels.length ? levels : ['short', 'fuller'], why: d.why ? String(d.why) : '' }
  })
  if ((raw.dims || []).length > MAX_DIMS) problems.push(`the model chose ${(raw.dims || []).length} dimensions; the first ${MAX_DIMS} are kept`)
  const fixAt = at => Object.fromEntries(dims.map(d => [d.id, clampInt((at || {})[d.id] ?? (at || {})[d.name], 0, d.levels.length - 1)]))
  const versions = []
  for (const v of Array.isArray(raw.versions) ? raw.versions : []) {
    const at = fixAt(v.at)
    const lines = (Array.isArray(v.lines) ? v.lines : []).map(l => {
      const line = typeof l === 'string' ? { text: l, from: [] } : l || {}
      const from = expand(line.from || [], spans)
      const out = { text: String(line.text || '').trim(), from }
      if (!from.length) out.problem = 'cites no span of the original'
      else {
        const stray = strayNumbers(plain(out.text), from.map(id => plain(byId.get(id).text)))
        if (stray.length) out.problem = `${stray.map(n => `"${n}"`).join(', ')} ${stray.length === 1 ? 'is' : 'are'} not in the spans it cites`
      }
      return out
    }).filter(l => l.text)
    const outs = (Array.isArray(v.out) ? v.out : []).map(o => (typeof o === 'string' ? { what: o, from: [] } : { what: String(o.what || ''), from: expand(o.from || [], spans) })).filter(o => o.what)
    if (!lines.length) { problems.push(`a version at ${atKey(at)} has no lines`); continue }
    lines.filter(l => l.problem).forEach(l => problems.push(`${atKey(at)}: "${l.text.slice(0, 60)}" ${l.problem}`))
    versions.push({ at, lines, out: outs })
  }
  const first = raw.first ? fixAt(raw.first) : versions.length ? versions[0].at : fixAt({})
  return { dims, versions, first, problems }
}

// ---------------------------------------------------------------------------------------------- the model call

async function complete(ctx, prompt) {
  const cfg = { ...DEFAULTS, ...(ctx.verb || {}), ...(ctx.settings || {}) }
  const model = ctx.model && typeof ctx.model.complete === 'function' ? ctx.model : null
  if (!model) throw new Error('no model to write the squeeze: ctx.model.complete (the plugin\'s $.model.complete) is missing')
  let skill = ctx.skill
  if (!skill && typeof ctx.read === 'function' && ctx.dir) skill = await ctx.read(`${ctx.dir}/SKILL.md`).catch(() => '')
  if (!skill) throw new Error('no skill text: pass ctx.skill (SKILL.md) or ctx.read and ctx.dir')
  const system = [{ text: skillText(skill) + '\n\n' + FORMAT, cache: true }]
  const r = await model.complete({ model: cfg.model, system, prompt, maxTokens: cfg.maxTokens, effort: cfg.effort, timeoutMs: cfg.timeoutMs })
  if (!r || !r.isAnswered) {
    const why = r ? (r.reason === 'api-error' ? `the API answered ${r.status ?? 'nothing'} (${r.error || 'error'})` : r.reason) : 'no result'
    const e = new Error(`the model gave no squeeze: ${why}`)
    e.usage = r && r.usage
    throw e
  }
  return { answer: parseAnswer(r.text), usage: r.usage, model: cfg.model }
}

function request(orig, o, extra) {
  const head = []
  if (o.question) head.push(`The person asked: ${o.question}`)
  if (o.title) head.push(`It is: ${o.title}`)
  head.push(`The original, ${orig.lines} lines, cut into ${orig.spans.length} spans:`)
  return head.join('\n') + '\n\n' + numbered(orig.spans) + '\n\n' + extra
}

// ---------------------------------------------------------------------------------------------- making and moving

/** The plain text a person sees of a squeeze at its `at` (for a renderer that draws no objects, and for main). */
export function shownText(sq) {
  const d = sq.data
  const v = versionAt(d, d.at) || d.versions[0]
  const where = d.dims.map(x => `${x.name}: ${x.levels[v.at[x.id] ?? 0]}`).join(' · ')
  const out = (v.out || []).map(o => o.what).join(' · ')
  return v.lines.map(l => plain(l.text)).join('\n') + `\n(${v.lines.length} of ${d.of.lines} lines · ${where}${out ? ` · left out: ${out}` : ''})`
}

export function versionAt(d, at) {
  return d.versions.find(v => atKey(v.at) === atKey(at))
}

/** A squeeze object from an original and an answer (the model's, or main's). */
export function build(object, orig, norm, made) {
  const o = object || {}
  const ref = o.ref || (o.id ? (String(o.id).includes(':') ? String(o.id) : `obj:${o.id}`) : `text:${hash(orig.text)}`)
  const title = o.title || plain(orig.spans[0]?.text || '').slice(0, 60) || 'text'
  const data = {
    of: { id: ref, title, lines: orig.lines, question: o.question || undefined },
    spans: orig.spans, blocks: orig.blocks, dims: norm.dims, versions: norm.versions,
    at: versionAt({ versions: norm.versions }, norm.first) ? norm.first : norm.versions[0].at,
  }
  const sq = {
    id: `squeeze-${slug(title)}-${hash(orig.text).slice(0, 6)}`, v: 1, kind: 'squeeze', verb: 'squeeze',
    title: `Squeezed: ${title}`, question: o.question, contract: 'lean/draw', program: PROGRAM, data,
    lineage: lineageOf(data, [made], norm.problems),
  }
  sq.text = shownText(sq)
  return sq
}

/** Each line's link to the spans it came from, and through them to whatever the original cited. */
function lineageOf(data, made, problems) {
  const byId = new Map(data.spans.map(s => [s.id, s]))
  const cites = []
  const rows = new Set()
  data.versions.forEach((v, vi) => v.lines.forEach((l, li) => {
    const via = [...new Set(l.from.flatMap(id => byId.get(id)?.cites || []))]
    via.forEach(r => rows.add(r))
    cites.push({ in: `/versions/${vi}/lines/${li}`, of: data.of.id, spans: l.from, ...(via.length ? { via } : {}), ...(l.problem ? { problem: l.problem } : {}) })
  }))
  return { of: data.of.id, cites, rows: [...rows], made, problems: problems || [] }
}

function withVersion(sq, change) {
  const next = { ...sq, v: (sq.v || sq.version || 1) + 1, data: { ...sq.data } }
  change(next)
  next.text = shownText(next)
  return next
}

/** What the person's words ask for. */
export function parseArgs(args, dims) {
  const a = String(args || '').trim()
  const low = a.toLowerCase()
  if (!a) return { kind: 'default' }
  if (a === 'S' || /^(fuller|longer|more detail|f)$/.test(low)) return { kind: 'step', by: 1 }
  if (/^(shorter|more|less|s)$/.test(low)) return { kind: 'step', by: -1 }
  if (/^(original|full|o)$/.test(low)) return { kind: 'show', show: 'original' }
  if (/^(squeezed|back)$/.test(low)) return { kind: 'show', show: null }
  if (/^again$/.test(low)) return { kind: 'again' }
  const why = /^(?:why|from|where)\s+(?:line\s*)?(\d+)$/.exec(low) || /^(?:line\s*)?(\d+)$/.exec(low)
  if (why) return { kind: 'why', line: Number(why[1]) }
  const set = /^([\w -]+?)\s*[=:]\s*(.+)$/.exec(a)
  const dim = d => (dims || []).find(x => x.id === slug(d) || x.name.toLowerCase() === d.toLowerCase())
  if (set && dim(set[1])) return { kind: 'set', dim: dim(set[1]).id, level: set[2].trim() }
  if (dim(a)) return { kind: 'set', dim: dim(a).id, level: '+1' }
  return { kind: 'ask', text: a }
}

/** The verb. */
export async function run(ctx) {
  const o = ctx.object
  if (!o) return { text: 'Nothing to squeeze: no object is selected.' }
  if (isSqueeze(o)) return move(ctx, o)
  const orig = originalOf(o)
  if (orig.spans.length < 2 || !isLong(orig.text, { lines: 4, chars: 300 })) {
    return { text: `It is already short (${orig.lines} ${orig.lines === 1 ? 'line' : 'lines'}), so there is nothing to squeeze.` }
  }
  const args = parseArgs(ctx.args)
  const ask = args.kind === 'ask' ? `The person asked for this squeeze: "${args.text}". Choose dimensions that serve it, and put "first" where it asks.\n\n` : ''
  const { answer, usage, model } = await complete(ctx, request(orig, o, ask + 'Choose the dimensions and write the versions.'))
  const norm = normalize(answer, orig.spans)
  if (!norm.versions.length) throw new Error(`the model wrote no usable version${norm.problems.length ? ': ' + norm.problems[0] : ''}`)
  const sq = build(o, orig, norm, { by: 'model', model, usage, at: new Date().toISOString(), asked: ctx.args || '' })
  return { object: sq, text: sq.text, note: noteFor(sq, 'squeezed') }
}

async function move(ctx, sq) {
  const d = sq.data
  const args = ctx.region && /^line-\d+$/.test(ctx.region) && !ctx.args ? { kind: 'why', line: Number(ctx.region.slice(5)) } : parseArgs(ctx.args, d.dims)
  const cur = (versionAt(d, d.at) || d.versions[0]).at
  if (args.kind === 'why') {
    const v = versionAt(d, d.at) || d.versions[0]
    const l = v.lines[args.line - 1]
    if (!l) return { text: `This version has ${v.lines.length} lines; there is no line ${args.line}.` }
    const byId = new Map(d.spans.map(s => [s.id, s]))
    return { text: `Line ${args.line} came from ${l.from.join(', ') || 'no span'}:\n` + l.from.map(id => `  [${id}] ${plain(byId.get(id).text)}`).join('\n') + (l.problem ? `\n  (${l.problem})` : '') }
  }
  if (args.kind === 'show') return { object: withVersion(sq, n => { n.data.show = args.show }), text: args.show ? 'The original, with what this version keeps underlined.' : sq.text }
  if (args.kind === 'again') return run({ ...ctx, object: { ref: d.of.id, title: d.of.title, question: d.of.question, text: originalText(d) }, args: '' })
  let at = { ...cur }
  let ask = ''
  if (args.kind === 'default' || args.kind === 'step') {
    const dim = d.dims[0]
    const by = args.kind === 'default' ? -1 : args.by
    const to = (cur[dim.id] ?? 0) + by
    if (to < 0) return { object: sq, text: `This is the shortest version on ${dim.name}. The original is one key away.` }
    if (to >= dim.levels.length) return { object: withVersion(sq, n => { n.data.show = 'original' }), text: `This was the fullest version on ${dim.name}; here is the original beside it.` }
    at[dim.id] = to
  } else if (args.kind === 'set') {
    const dim = d.dims.find(x => x.id === args.dim)
    const i = args.level === '+1' ? ((cur[dim.id] ?? 0) + 1) % dim.levels.length : dim.levels.findIndex(x => x.toLowerCase() === args.level.toLowerCase())
    if (i < 0) return { object: sq, text: `${dim.name} has the levels ${dim.levels.join(', ')}.` }
    at[dim.id] = i
  } else if (args.kind === 'ask') {
    ask = args.text
  }
  if (!ask) {
    const have = versionAt(d, at)
    if (have) {
      const next = withVersion(sq, n => { n.data.at = have.at; n.data.show = null })
      return { object: next, text: next.text, note: noteFor(next, 'moved') }
    }
  }
  // a version nobody wrote yet: one more call writes it (or, for words, adjusts the dimensions and writes one)
  const orig = { spans: d.spans, blocks: d.blocks, lines: d.of.lines, text: originalText(d) }
  const written = d.versions.map(v => ({ at: v.at, lines: v.lines.map(l => ({ text: l.text, from: l.from })) }))
  const extra = `The dimensions so far: ${JSON.stringify(d.dims)}\nThe versions written so far: ${JSON.stringify(written)}\n\n` + (ask
    ? `The person asked: "${ask}". Write one version for it. Keep the dimensions, or replace the last one with a dimension that names what they asked for; answer with "dims" (all of them), "first" (where the new version sits) and "versions" (the new one only).`
    : `Write the version at ${JSON.stringify(at)} only. Answer with {"versions": [ ... ]}.`)
  const { answer, usage, model } = await complete(ctx, request(orig, { title: d.of.title, question: d.of.question }, extra))
  const norm = normalize(answer, d.spans, d.dims)
  if (!norm.versions.length) throw new Error(`the model wrote no usable version${norm.problems.length ? ': ' + norm.problems[0] : ''}`)
  const fresh = ask ? norm.versions[0] : { ...norm.versions[0], at }
  const next = withVersion(sq, n => {
    const dimsChanged = ask && JSON.stringify(norm.dims) !== JSON.stringify(d.dims)
    n.data.dims = norm.dims
    const keep = dimsChanged ? d.versions.filter(v => norm.dims.every(x => v.at[x.id] != null)) : d.versions
    n.data.versions = keep.filter(v => atKey(v.at) !== atKey(fresh.at)).concat([fresh])
    n.data.at = fresh.at
    n.data.show = null
    n.lineage = lineageOf(n.data, (sq.lineage?.made || []).concat([{ by: 'model', model, usage, at: new Date().toISOString(), asked: ctx.args || '' }]), (sq.lineage?.problems || []).concat(norm.problems))
  })
  return { object: next, text: next.text, note: noteFor(next, 'moved') }
}

function originalText(d) {
  return d.blocks.map(b => b.lead + b.spans.map(id => d.spans.find(s => s.id === id)?.text || '').join(' ')).join('\n\n')
}

function noteFor(sq, how) {
  const d = sq.data
  const v = versionAt(d, d.at) || d.versions[0]
  const where = d.dims.map(x => `${x.name} ${x.levels[v.at[x.id] ?? 0]}`).join(', ')
  return `The person sees ${d.of.id} ${how === 'moved' ? 'now ' : ''}squeezed to ${v.lines.length} of ${d.of.lines} lines (${where}); the original is unchanged and one key away.`
}
