// run.mjs: the Trace verb (key t). Where something came from and where it went.
//
//   run(ctx) -> {object?, text?, note?}
//
// The first t shows a short path at once: the thing traced, its steps back (a value's query and code, the label it
// builds on, its rows and their file; a line's words, the moment its agent read them, the agent who wrote them first),
// the files not behind it, how far a passage spread, and what uses it (queries, objects, answers). Each step is a
// region with its ref, so t on a step traces on from there. t on the trace itself asks Claude for the full trace:
// Claude writes a program against the drawing contract for this case and decides how deep to go (prompt.mjs).
//
// ctx, as the shell gives it (shell/node/verb.mjs; every field optional but one of ref, region or object):
//   object     the object on screen: a kernel object (id, data, lineage, ...) or a drawn one; a trace object made here
//              carries verb: 'trace' and its target in `traced`
//   region     the selected region's id; regionMeta its meta (meta.ref, meta.text or meta.cite lead to what it shows)
//   refs       the kernel refs behind the selected region, as the shell found them
//   drawing    the object's drawing (kit.js), where a region's cite is looked up
//   kernel     how to run `thimble`: {run(args) -> {stdout}}, or a function (args) -> stdout text or parsed JSON
//   draw       {runProgram(object, {w}) -> drawing, or a promise of one}, to check a program Claude wrote before it
//              is shown
//   model      the session's model: $.model's {fork} or {complete} (through the shell), or a function (prompt) ->
//              text; absent, the full trace is asked of Claude in the conversation (ask)
//   skill      the text of this verb's SKILL.md, and toolkit the text of lean/draw/TOOLKIT.md: what Claude reads
//              before it writes the full trace (a short fallback stands in for each when absent)
//   w          the width in columns; args: the person's words, when they typed some with the verb
//   ref, text  a ref or words to trace directly (cli.mjs), without an object
//   full       true to go straight to the full trace
//
// No file, process or network access here: everything goes through ctx, so the shell can import this in its hooks
// module and the CLI (cli.mjs) can run it in Node.
import { SHORT_PATH } from './programs.mjs'
import { composePrompt, parseReply, slimFacts } from './prompt.mjs'
import { modelWhy } from '../../shell/why.js'

const REF = /^([qr]\d+(#.*)?|obj:[A-Za-z0-9_.-]+(#\/.*)?|[^\s#][^#\n]*#[^\s].*|[^\s#]+\.(jsonl|ndjson|csv|tsv|json|db|sqlite|md|txt|log|diff|patch))$/

export const isRef = s => typeof s === 'string' && REF.test(s.trim()) && !/^https?:/.test(s)

// ------------------------------------------------------------------ what to trace

/** {ref?, text?, label?} of what the person selected, or null. */
export function targetOf(ctx) {
  const r = ctx.ref
  if (r && typeof r === 'object' && (r.ref || r.text)) return { ref: r.ref, text: r.text, label: r.label }
  if (isRef(r)) return { ref: r.trim(), text: ctx.text, label: ctx.label }
  const region = typeof ctx.region === 'string'
    ? (ctx.drawing?.regions || []).find(x => x.id === ctx.region) || { id: ctx.region }
    : ctx.region
  const meta = ctx.regionMeta || region?.meta || {}
  const cite = typeof meta.cite === 'string' ? ctx.drawing?.cites?.[meta.cite] : (meta.cite && typeof meta.cite === 'object' ? meta.cite : null)
  const label = meta.label || cite?.text
  const text = meta.text || meta.quote || cite?.quote || ctx.text
  for (const c of [meta.ref, meta.trace, cite?.ref, cite?.query, ...(Array.isArray(cite?.rows) ? cite.rows : [])]) {
    if (isRef(c)) return { ref: c.trim(), text, label }
    if (c && typeof c === 'object' && isRef(c.ref)) return { ref: c.ref, text: c.quote || text, label }
  }
  // the refs the shell found behind the selected part (a data row matched by the part's id, say)
  const found = region && (ctx.refs || []).find(isRef)
  if (found) return { ref: found.trim(), text, label }
  const obj = ctx.object
  const traced = obj?.traced || (obj?.source && (obj.source.ref || obj.source.text) ? obj.source : null)
  if (obj?.verb === 'trace' && traced && !region) return { ...traced, again: true }
  if (text && !obj) return { text, label }
  if (obj?.id && obj.lineage) {
    // a kernel object with one value bound: that value; else the whole object
    const b = obj.lineage.bindings || []
    if (b.length === 1 && b[0].at) return { ref: `obj:${obj.id}#${b[0].at}`, label: obj.title }
    return { ref: `obj:${obj.id}`, text, label: obj.title }
  }
  return text ? { text, label } : null
}

// ------------------------------------------------------------------ the kernel

async function kernelJson(kernel, args) {
  if (!kernel) throw new Error('no kernel to ask')
  const call = typeof kernel === 'function' ? kernel : kernel.run || kernel.lean || kernel.json
  if (typeof call !== 'function') throw new Error('the kernel has no way to run `thimble`')
  let out = await call.call(kernel, [...args, '--json'])
  if (out && typeof out === 'object' && 'stdout' in out) out = out.stdout
  if (typeof out === 'string') {
    try { return JSON.parse(out) } catch { throw new Error(out.trim().split('\n').slice(-1)[0] || 'thimble trace said nothing') }
  }
  return out
}

/** The facts `thimble trace` gives for a target. */
export async function facts(ctx, t) {
  const args = ['trace']
  if (t.ref) args.push(t.ref)
  if (t.text) args.push('--text', t.text)
  if (t.within) args.push('--in', t.within)
  return kernelJson(ctx.kernel, args)
}

// ------------------------------------------------------------------ the short path, from the facts

const fmt = n => typeof n === 'number' ? n.toLocaleString('en-US') : String(n ?? '')
const hhmm = t => (/T(\d\d:\d\d)(:\d\d)?/.exec(t || '') || [])[1] || ''
const line = ref => (/#(L\d+)/.exec(ref || '') || [])[1] || ''
const cut = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1) + '…' }
const slug = (s, i) => (String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'step') + (i == null ? '' : '-' + i)
const fileOf = ref => String(ref || '').split('#')[0]
/** The line of a text that holds the words, cut around them. */
export function lineWith(text, words) {
  const s = String(text || '')
  const i = words ? s.toLowerCase().indexOf(String(words).toLowerCase()) : -1
  if (i < 0) return s.split('\n')[0]
  const a = s.lastIndexOf('\n', i) + 1
  const b = s.indexOf('\n', i)
  const ln = s.slice(a, b < 0 ? s.length : b).trim()
  const k = i - a
  return k > 40 ? '…' + ln.slice(k - 30) : ln
}
const short = p => { const parts = String(p || '').split('/'); return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : String(p || '') }

/** The value an object's chain ends on, as people read it. */
function valueText(v) {
  if (typeof v === 'number') return fmt(v)
  if (typeof v === 'string') return cut(v, 60)
  return ''
}

/** The data of the short path drawing. */
export function shortData(f, t, w = 100) {
  const back = []
  const forward = []
  let head = null
  let title = 'where it came from'
  let right = ''
  let fog = null
  let spread = null
  const chain = f.back?.chain || []
  const obj = chain.find(s => s.step === 'object')
  const binding = chain.find(s => s.step === 'binding')
  const queries = chain.filter(s => s.step === 'query')
  if (f.back && !f.copied_from) {
    const v = obj && 'value' in obj ? valueText(obj.value) : queries[0] && 'value' in queries[0] ? valueText(queries[0].value) : ''
    const what = t.label || f.label
    const label = what && v && !String(what).includes(v) ? `${v} · ${cut(what, 50)}` : what || v || f.ref
    if (chain.every(s => s.step === 'source')) {
      const rec = f.back.records?.[0]
      head = { id: 'traced', text: cut(t.label || f.ref, 70), sub: rec ? cut(rec.text, Math.max(20, w - 30 - (t.label || f.ref).length)) : '', ref: f.ref }
      title = `${short(fileOf(f.ref))} ${line(f.ref) || ''}`.trim()
      back.push({ id: 'source', text: `a row of ${fileOf(f.ref)}: it starts here`, ref: fileOf(f.ref), tone: 'dim' })
    } else {
      head = { id: 'traced', text: cut(label, 70), sub: obj ? `object ${obj.id}${obj.at ? ' at ' + obj.at : ''}` : '', ref: f.ref }
      title = `where ${v || 'this'} comes from`
      queries.forEach((q, i) => {
        const ref = i === 0 && binding ? binding.from : q.id
        back.push({ id: `q-${q.id}`, text: `${q.id} · ${cut(q.about || 'a query', 50)}`, sub: q.lineage === 'exact' ? 'its code keeps each row' : `rows: ${q.lineage}`, ref })
        const up = (us, depth) => us.forEach(u => {
          const ins = (u.inputs || []).map(x => x.path).join(', ')
          back.push({ id: `q-${u.query}`, text: `uses "${u.name}", kept by ${u.query} · ${cut(u.about || '', 40)}`, sub: ins ? `reads ${ins}` : '', ref: u.query })
          up(u.upstream || [], depth + 1)
        })
        up(q.upstream || [], 0)
      })
      if (f.back.rows?.length) {
        const files = [...new Set(f.back.rows.map(fileOf))]
        const of = queries.flatMap(q => [...(q.inputs || []), ...(q.upstream || []).flatMap(u => u.inputs || [])]).find(x => files.includes(x.path))
        const n = f.back.count
        const rec = f.back.records?.[0]
        back.push({ id: 'rows', text: `${n != null ? fmt(n) : 'whole files'}${of?.rows_read ? ' of ' + fmt(of.rows_read) : ''} rows · ${files.join(', ')}`,
          sub: rec ? `first ${line(rec.ref) || rec.ref}` : '', ref: rec?.ref || f.back.rows[0] })
        right = files.join(', ')
      }
    }
    const nu = f.files?.not_used || []
    if (nu.length) fog = { files: nu, label: `not behind it: ${nu.slice(0, 4).join(', ')}${nu.length > 4 ? ` and ${nu.length - 4} more` : ''}` }
    for (const note of f.back.notes || []) if (/changed since|found by key|no query or row/.test(note)) back.push({ id: slug('note', back.length), text: cut(note, 90), tone: 'warn' })
  }
  const cf = f.copied_from
  if (cf) {
    const pick = cf.sources.find(s => s.passage === f.text) || (f.text ? null : cf.sources[0])
    const words = pick?.passage || f.text
    head = { id: 'traced', text: `${cf.agent} wrote: ${cut(lineWith(cf.block || cf.text, words), Math.max(30, w - 30))}`, sub: hhmm(cf.t), ref: f.ref, passage: words }
    title = 'where this line came from'
    right = cf.agent
    if (pick) {
      back.push({ id: 'read', text: `read "${cut(pick.passage, 40)}" at ${hhmm(pick.t) || line(pick.from)}`,
        sub: `${line(pick.from)}${pick.via ? ' · in what ' + cut(String(pick.via).replace(/^Bash: /, ''), 36) + ' showed' : ', a ' + String(pick.kind || 'record').replace('_', ' ')}`,
        ref: pick.from, passage: pick.passage })
      if (pick.origin && pick.origin.agent !== cf.agent) {
        back.push({ id: 'origin', text: `${pick.origin.agent} wrote them first, ${hhmm(pick.origin.t)}`, sub: line(pick.origin.ref), ref: pick.origin.ref, passage: pick.passage, tone: 'accent', depth: 1 })
      } else back.push({ id: 'outside', text: 'from outside these transcripts: no agent here wrote them before one read them', tone: 'dim', depth: 1 })
    } else if (f.text && f.spread?.origin?.agent === cf.agent) {
      back.push({ id: 'origin', text: `★ ${cf.agent} wrote "${cut(f.text, 40)}" first: it had read these words nowhere before`, tone: 'accent' })
    } else if (f.text && f.spread?.origin) {
      const me = (f.spread.per_file || []).find(e => e.agent === cf.agent)
      if (me?.first_read) back.push({ id: 'read', text: `read "${cut(f.text, 40)}" at ${hhmm(me.first_read.t) || line(me.first_read.ref)}`, sub: line(me.first_read.ref), ref: me.first_read.ref, passage: f.text })
      back.push({ id: 'origin', text: `${f.spread.origin.agent} wrote them first, ${hhmm(f.spread.origin.first_wrote.t)}`, sub: line(f.spread.origin.first_wrote.ref), ref: f.spread.origin.first_wrote.ref, passage: f.text, tone: 'accent', depth: 1 })
    } else if (!cf.sources.length) back.push({ id: 'own', text: `${cf.agent}'s own words: it read none of them before`, tone: 'dim' })
    const others = cf.sources.filter(s => s !== pick && s.passage !== words).slice(0, 2)
    if (others.length) back.push({ id: 'also', text: 'also from what it read: ' + others.map(s => `"${cut(s.passage, 28)}" (${s.origin && s.origin.agent !== cf.agent ? s.origin.agent : 'outside'})`).join(' · '), tone: 'dim', depth: 0, arrow: false })
  }
  const sp = f.spread
  if (sp) {
    const o = sp.origin
    if (!cf) {
      const rec = f.back?.records?.[0]
      const sourceRow = f.back && (f.back.chain || []).every(s => s.step === 'source')
      head = sourceRow
        ? { id: 'traced', text: `"${cut(sp.text, 40)}" in ${short(fileOf(f.ref))} ${line(f.ref)}`, sub: rec ? cut(rec.line || rec.text, Math.max(20, w - 40 - Math.min(40, sp.text.length))) : '', ref: f.ref, passage: sp.text }
        : { id: 'traced', text: `"${cut(sp.text, 60)}"`, sub: `in ${sp.files} transcripts`, ref: f.ref, passage: sp.text }
      if (sourceRow) back.splice(back.findIndex(s => s.id === 'source'), 1)
      title = 'where these words came from and where they went'
      if (o) back.push({ id: 'origin', text: `${o.agent} wrote them first, ${hhmm(o.first_wrote.t)}`, sub: line(o.first_wrote.ref), ref: o.first_wrote.ref, passage: sp.text, tone: 'accent' })
      else if (sp.outside) back.push({ id: 'outside', text: `from outside these transcripts: ${sp.outside.agent} read them first, ${hhmm(sp.outside.first_read.t)}`, ref: sp.outside.first_read.ref, tone: 'dim' })
    }
    spread = { copied: sp.copied.length, own: sp.own.length, held: sp.held_out.length, never: sp.never.length, text: sp.text,
      label: `"${cut(sp.text, 40)}" across ${sp.files} transcripts`, ref: f.ref }
    if (!cf) right = sp.within || ''
  }
  const fw = f.forward
  if (fw) {
    const items = []
    for (const a of fw.answers || []) items.push({ id: slug('answer', items.length), text: `answer, turn ${a.turn}: "${cut(a.text, Math.max(30, w - 30))}"`, ref: a.ref })
    for (const o of fw.objects || []) items.push({ id: slug('object-' + o.id), text: `object ${o.id} · ${cut(o.title || '', 40)}`, sub: o.at.slice(0, 3).map(a => a.at).join(', '), ref: `obj:${o.id}` })
    for (const q of fw.queries || []) items.push({ id: slug('query-' + q.id), text: `${q.id} · ${cut(q.about || '', 40)}`, sub: q.rows ? `${q.output_rows} of ${q.of} output rows rest on it` : q.how, ref: q.id })
    forward.push(...items.slice(0, 3))
    if (items.length > 3) forward.push({ id: 'more-uses', text: `and ${items.length - 3} more that use it`, tone: 'dim' })
    if (!items.length && !sp) forward.push({ id: 'unused', text: 'nothing kept here uses it yet', tone: 'dim' })
  }
  const steps = back.filter(s => s.ref).length + forward.filter(s => s.ref).length
  const hint = steps ? 't full trace · select a step and t to follow it' : 't full trace'
  return { title, right, head, back, fog, spread, forward, hint }
}

/** A stable id for what was traced: the readable end of its ref, and a short hash of the ref and the words, so two
 *  rows of one file never share an id. */
export function traceId(t) {
  const key = `${t.ref || ''}|${t.text || ''}`
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
  // the words it is known by (its label, else the readable end of its ref), cut at a word
  const words = slug(t.label || String(t.ref || t.text || 'target').split('/').slice(-1)[0])
  const tail = words.length <= 32 ? words : words.slice(0, 33).replace(/-[^-]*$/, '') || words.slice(0, 32)
  return `trace-${tail}-${h.toString(36).slice(0, 5)}`
}

/** A trace object: the program, its data, and what was traced, so t on it again knows the target. */
function traceObject(t, program, data, extra = {}) {
  const id = traceId(t)
  return { id, verb: 'trace', title: 'Trace · ' + (data.title || data.facts?.title || ''), program, data,
    traced: { ref: t.ref, text: t.text, label: t.label }, ...extra }
}

/** What Claude is told after the short path: what the person is looking at, in a few lines. */
export function noteFor(f, t, d) {
  const steps = [d.head?.text, ...d.back.map(s => s.text)].filter(Boolean).join(' ← ')
  const fw = d.forward.map(s => s.text).join('; ')
  const sp = d.spread ? ` "${cut(d.spread.text, 40)}": ${d.spread.copied} wrote it after reading it, ${d.spread.held} read it and held out.` : ''
  return `The person traced ${t.ref || JSON.stringify(t.text)} (t). It showed: ${cut(steps, 400)}.${sp}${fw ? ' Used by: ' + cut(fw, 200) + '.' : ''}` +
    ` \`thimble trace ${t.ref || ''}${t.text ? ` --text ${JSON.stringify(t.text)}` : ''} --json\` has the facts; the trace skill says how to draw a fuller one.`
}

// ------------------------------------------------------------------ the full trace, by Claude

async function ask(model, prompt) {
  if (typeof model === 'function') return String(await model(prompt))
  const r = model.fork ? await model.fork({ prompt }) : await model.complete({ model: model.name || 'opus', prompt, maxTokens: 12000 })
  if (r && typeof r === 'object') {
    if (r.isAnswered === false) throw new Error(`no reply: ${modelWhy(r)}`)
    return String(r.text ?? '')
  }
  return String(r ?? '')
}

/** Claude writes the full trace's program; it runs once here, and once more with the error if it failed. */
export async function compose(ctx, f, t) {
  let prompt = composePrompt(f, t, { w: ctx.w || 100, ask: ctx.ask || ctx.args, skill: ctx.skill, toolkit: ctx.toolkit })
  let last = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await ask(ctx.model, prompt)
    const got = parseReply(reply)
    if (!got.program) { last = 'the reply held no ```js program'; prompt += `\n\nYour reply held no \`\`\`js block. Reply again with the program in one.`; continue }
    const data = { facts: slimFacts(f), claude: got.data || {} }
    const title = got.title && /^trace\b/i.test(got.title) ? got.title : 'Trace · ' + (got.title || 'full')
    const object = traceObject(t, got.program, data, { title, full: true, by: 'claude' })
    if (!ctx.draw?.runProgram) return object
    const drawing = await ctx.draw.runProgram(object, { w: ctx.w || 100 })  // a sandbox in a child process is async
    if (!drawing.error) return object
    last = `${drawing.error.name}: ${drawing.error.message}${drawing.error.line ? ` (line ${drawing.error.line})` : ''}`
    prompt += `\n\nYour program failed: ${last}\nReply again with the whole program fixed.`
  }
  throw new Error(`Claude's program did not run: ${last}`)
}

// ------------------------------------------------------------------ the verb

export async function run(ctx) {
  const t = targetOf(ctx)
  if (!t) return { text: 'Nothing here to trace: select a value, a quote or a line, then t.' }
  let f
  try {
    f = await facts(ctx, t)
  } catch (err) {
    return { text: `Could not trace ${t.ref || JSON.stringify(t.text)}: ${String(err?.message || err).slice(0, 200)}` }
  }
  if (!t.text && f.text) t.text = f.text
  const w = ctx.w || 100
  const full = ctx.full || t.again
  if (!full) {
    const data = shortData(f, t, w)
    // the short path names t first under it: t again draws the full trace
    return { object: traceObject(t, SHORT_PATH, data, { hints: ['trace'] }), note: noteFor(f, t, data) }
  }
  if (!ctx.model) {
    const words = ctx.ask || ctx.args
    return {
      text: 'Asked Claude for the full trace.',
      ask: `The person asked for the full trace of ${t.ref || JSON.stringify(t.text)}${words ? `: "${words}"` : ''}. ` +
        `Run \`thimble trace ${t.ref || ''}${t.text ? ` --text ${JSON.stringify(t.text)}` : ''} --json\`, decide how deep to go for what they asked, ` +
        'and draw it as an object (the trace skill has the principles and examples).',
    }
  }
  try {
    const object = await compose(ctx, f, t)
    return { object, note: `Claude drew the full trace of ${t.ref || JSON.stringify(t.text)} as ${object.id}.` }
  } catch (err) {
    const data = shortData(f, t, w)
    return { object: traceObject(t, SHORT_PATH, data), text: `The full trace failed (${String(err?.message || err).slice(0, 160)}); here is the short path.` }
  }
}
