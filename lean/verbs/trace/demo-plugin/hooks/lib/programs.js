// programs.mjs: the one program the Trace verb draws without Claude, the short path. It is a program against the
// drawing contract (lean/draw/TOOLKIT.md) like any other object's, and it draws whatever path the kernel found: a head
// (the thing traced), the steps back, the files not behind it, how far a passage spread, and what uses it. Each step
// is a region whose meta carries its ref, so the person can select a step and trace on from there. The full trace is
// not drawn here: Claude writes that program for the case at hand (prompt.mjs, SKILL.md).

export const SHORT_PATH = String.raw`
const e = k.escape
const meta = s => ({ label: s.label || s.text, ref: s.ref, text: s.passage })
const line = (s, lead) => k.text(lead + (s.tone ? '{' + s.tone + ':' + e(s.text) + '}' : e(s.text)) + (s.sub ? '  {dim:' + e(s.sub) + '}' : ''), { wrap: false })
const indent = (n, part) => k.beside(k.text('', { w: n }), part, { gap: 0 })
const parts = []
if (data.head) parts.push(k.region(data.head.id, meta(data.head), k.text('**' + e(data.head.text) + '**' + (data.head.sub ? '  {dim:' + e(data.head.sub) + '}' : ''), { wrap: false })))
;(data.back || []).forEach((s, i) => parts.push(indent(Math.min(2 + 2 * (s.depth != null ? s.depth : i), 8), k.region(s.id, meta(s), line(s, s.arrow === false ? '' : '{dim:←} ')))))
if (data.fog && data.fog.files.length) {
  parts.push(indent(2, k.beside(k.unseen({ label: '', w: 3, h: 1 }), k.text('{dim:' + e(data.fog.label) + '}'), { gap: 1 })))
}
const sp = data.spread
if (sp) {
  const total = Math.max(1, sp.copied + sp.own + sp.held + sp.never)
  const bar = k.bar([{ value: sp.copied, tone: 'accent' }, { value: sp.own, tone: 'c2' }, { value: sp.held, tone: 'dim' },
    { value: sp.never, tone: 'unseen' }], { max: total, w: Math.max(8, Math.min(20, k.w - 72)) })
  const words = '{accent:● ' + sp.copied + ' wrote it after reading it}' + (sp.own ? '  {c2:◆ ' + sp.own + ' on their own}' : '')
    + '  {dim:○ ' + sp.held + ' read it, held out}' + (sp.never ? '  {dim:· ' + sp.never + ' never read it}' : '')
  parts.push(indent(2, k.region('spread', { label: sp.label, ref: sp.ref, text: sp.text }, k.beside(bar, k.text(words), { gap: 1 }))))
}
;(data.forward || []).forEach(f => parts.push(k.region(f.id, meta(f), line(f, '{dim:→} '))))
if (data.more) parts.push(k.text('{dim:' + e(data.more) + '}'))
return k.frame(k.stack(parts), { title: 'trace · ' + e(data.title), right: e(data.right || ''), bottom: e(data.hint || '') })
`
