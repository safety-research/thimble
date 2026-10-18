// prompt.mjs: what Claude is asked when the person wants the full trace, and how its reply is read.
//
// The principles and worked examples are the verb's SKILL.md and the toolkit is lean/draw/TOOLKIT.md: the caller
// reads both files and passes their text (opts.skill, opts.toolkit), so there is one copy of each. Without them a
// short fallback keeps the request whole.

const FALLBACK_SKILL = `Draw the trace for this case. Answer the question the person has; decide how deep to go. Draw the
shape of this case (a chain, a fan-in of rows into a value, a tree of who read and who copied, a timeline), composed
from the toolkit; there is no trace type. Counts come from data.facts; your judgments (groups of variants, short names)
go in your json block. Show what is not behind it as k.unseen. Make every step a region whose meta has its ref.`

const FALLBACK_TOOLKIT = `A program is the body of (k, data) => node. k.text(str, {tone, bold}) with **bold**, {dim:words}
and [words](#id) in str; k.escape(s) for data. k.stack(...parts, {gap}), k.beside(...parts, {gap}), k.frame(part,
{title, right, bottom}). k.bar(value, {max, tone}) or k.bar([{value, tone}], {max}); k.spark(values); k.table(rows,
{cols}); k.unseen({label, w, h}); k.dots(n, total). k.region(id, {label, ref, ...}, part); k.cite(id, {text, source,
rows}). const c = k.canvas(w, h): c.text(x, y, str, {tone}), c.hline(x, y, w, ch, tone), c.vline(x, y, h, ch, tone),
c.region(id, x, y, w, h, meta). k.w is the width in columns; k.fmt(n) formats a number. Tones: ink dim accent good bad
warn unseen c1..c6.`

const cut = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1) + '…' }

/** The facts as the full trace's program reads them: everything the kernel said, cut to what a drawing can use. */
export function slimFacts(f) {
  const keep = (xs, n) => (xs || []).slice(0, n)
  const per = e => e && { agent: e.agent, read: e.first_read && { ref: e.first_read.ref, t: e.first_read.t },
    wrote: e.first_wrote && { ref: e.first_wrote.ref, t: e.first_wrote.t }, lines: keep(e.lines, 2) }
  const sp = f.spread && {
    text: f.spread.text, within: f.spread.within, files: f.spread.files, read: f.spread.read,
    origin: per(f.spread.origin), outside: f.spread.outside, copied: f.spread.copied.map(per),
    own: f.spread.own.map(per), held_out: f.spread.held_out.map(e => e.agent), never: f.spread.never,
  }
  const back = f.back && {
    chain: (f.back.chain || []).map(s => ({ ...s, code: s.code && String(s.code).slice(0, 1200), rows: keep(s.rows, 5) })),
    count: f.back.count, rows: keep(f.back.rows, 3).map(r => cut(r, 200)), records: keep(f.back.records, 3), notes: f.back.notes,
  }
  const cf = f.copied_from && { ...f.copied_from, block: cut(f.copied_from.block, 600) }
  return { ref: f.ref, text: f.text, label: f.label, back, files: f.files, copied_from: cf, spread: sp,
    forward: f.forward && { queries: keep(f.forward.queries, 8), objects: keep(f.forward.objects, 8), answers: keep(f.forward.answers, 8) } }
}

/** The request for the full trace. */
export function composePrompt(f, t, opts = {}) {
  const facts = JSON.stringify(slimFacts(f), null, 1)
  const what = t.ref ? `${t.ref}${t.text ? ` (the words "${t.text}")` : ''}` : `the words "${t.text}"`
  return [
    `The person pressed t again on a trace: draw the full trace of ${what}, where it came from and where it went.`,
    opts.ask ? `They asked: "${opts.ask}"` : '',
    'Write it as a program against the drawing toolkit. It will be drawn in the terminal at ' +
      `${opts.w || 100} columns, and the same program draws in the browser. Keep it under about 24 rows.`,
    '',
    '## How to trace (the trace skill)',
    String(opts.skill || FALLBACK_SKILL).replace(/^---[\s\S]*?---\s*/, ''),
    '',
    '## The drawing toolkit',
    String(opts.toolkit || FALLBACK_TOOLKIT),
    '',
    '## The facts (the program reads them as data.facts)',
    'From `lean trace --json`, cut to what a drawing can use. Every count you draw must come from these lists.',
    '```json',
    facts,
    '```',
    '',
    '## Reply with exactly these three parts',
    'title: <a few words>',
    '```js',
    '// the program body: (k, data) => node. data.facts is above; data.claude is your json block below.',
    '```',
    '```json',
    '{"your": "judgments only, such as groups of agents by how their copy differs, with a short label each"}',
    '```',
  ].filter(x => x !== undefined).join('\n')
}

/** {title, program, data} from Claude's reply; program null when there is no ```js block. */
export function parseReply(text) {
  const s = String(text || '')
  const title = (/^\s*title:\s*(.+)$/m.exec(s) || [])[1]?.trim()
  const js = /```(?:js|javascript)\s*\n([\s\S]*?)```/.exec(s)
  const json = /```json\s*\n([\s\S]*?)```/.exec(s)
  let data = null
  if (json) {
    try { data = JSON.parse(json[1]) } catch { data = null }
  }
  return { title: title || null, program: js ? js[1].trim() : null, data }
}
