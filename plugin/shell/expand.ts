// expand.ts: an explainer written again at more length, in its place. `e` on an explainer (the tray, or the side panel)
// asks for it: one side call (the registry's `explain-expand` prompt) reads the term, the explainer as it stands, the
// person's question, the answer, and the lines of the files the explainer and the answer cite, and writes a longer body,
// a "where it mattered" sentence with citations, and a picture when one helps. The answer's record keeps the longer one
// in place of the short one (and the short one beside it), so the explainer reads the same wherever it opens next.
import type { EngineInterface } from 'claude-code'

import type { MsgRecord, TrayFrame } from '../types'
import { promptText } from '../prompts/prompts'
import { tracked } from '../telemetry/telemetry'
import { jsonIn } from '../observer/evidence.js'
import { linksIn, wholeFile } from './cards.js'
import { citeRef } from './object.js'
import { remark, shownOf } from './message.js'
import { modelWhy } from './why.js'
import { questionBefore, recordNow, rootHere, saveRecord } from './shell'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const FILES_BUDGET = 14000 // characters of cited files the call reads
const AROUND = 12 // lines read on each side of a cited span

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '')

/** The lines of the files a gloss and its answer cite, numbered, as the call reads them; at most FILES_BUDGET. */
async function citedFiles($: Engine, refs: string[], root: string): Promise<string> {
  const out: string[] = []
  let used = 0
  const seen = new Set<string>()
  for (const raw of refs) {
    const ref = citeRef(raw)
    if (!ref || /^([qr]\d+|obj:|card:)/.test(ref) || seen.has(ref)) continue
    seen.add(ref)
    const [path, frag = ''] = ref.split('#')
    let text = ''
    try { text = String(await $.fs.read(path.startsWith('/') ? path : `${root}/${path}`)) } catch { continue }
    const all = text.split('\n')
    const m = /^L(\d+)(?:-L?(\d+))?/.exec(frag)
    const a = m ? Math.max(1, Number(m[1]) - AROUND) : 1
    const b = m ? Math.min(all.length, Number(m[2] || m[1]) + AROUND) : Math.min(all.length, wholeFile(ref) ? 120 : 60)
    const body = all.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(5)}  ${l.slice(0, 240)}`).join('\n')
    const piece = `--- ${path} (lines ${a}–${b} of ${all.length})\n${body}`
    if (used + piece.length > FILES_BUDGET) break
    out.push(piece)
    used += piece.length
  }
  return out.join('\n\n') || '(no file the explainer cites could be read)'
}

/**
 * The explainer of `frame` (a tray frame of kind gloss) written again at more length: the answer's record takes it in
 * place of the short one. Returns the new gloss, or a sentence that says why it was not written.
 */
export async function expandGloss($: Engine, frame: TrayFrame): Promise<Record<string, unknown> | string> {
  const row = frame.row
  const id = (frame.gloss as Any)?.id
  if (row == null || !id) return 'This explainer is not one of an answer of this session, so it cannot be written again.'
  const rec = (await recordNow($, row)) as MsgRecord | null
  const g = (rec?.glosses as Any)?.[id]
  if (!rec || !g) return 'That answer is not in this session any more.'
  if (g.expanded) return g
  const root = (await rootHere($)) || String(await $.session.cwd()).replace(/\/+$/, '')
  const answer = shownOf(rec)
  // the explainer's citations first, then the answer's: its links and the `path:line` in its code, as its marks hold them
  const cited = (Array.isArray(rec.marks) ? rec.marks : []).filter((m: Any) => m && m.kind === 'cite' && typeof m.ref === 'string').map((m: Any) => m.ref)
  const refs = [...(Array.isArray(g.refs) ? g.refs : []), ...linksIn(`${g.body || ''}\n${g.here || ''}`).map((l: Any) => l.ref), ...cited, ...linksIn(answer).map((l: Any) => l.ref)]
  const question = await questionBefore($, row).catch(() => '')
  const pt = await promptText($, 'explain-expand')
  const prompt = [
    `The term: ${g.term}`,
    '',
    'The explainer as it stands:',
    `body: ${g.body || ''}`,
    `here: ${g.here || ''}`,
    g.program ? `program:\n${g.program}` : '',
    '',
    `The analyst's question: ${String(question || '(not known)').slice(0, 2000)}`,
    '',
    'The answer the term stands in:',
    '<answer>', answer.slice(0, 12000), '</answer>',
    '',
    'The files the explainer and the answer cite, with their line numbers:',
    await citedFiles($, refs, root),
  ].filter(x => x !== '').join('\n')
  const req = { model: 'opus', maxTokens: 6000, timeoutMs: 120000, system: [{ text: pt.text, cache: true }], prompt }
  const r: Any = await tracked($, { feature: 'explain-expand', prompt: pt.id, model: req.model, extra: { row, term: g.term } }, () => $.model.complete(req as Any))
  if (!r?.isAnswered) return `The longer explanation was not written: ${modelWhy(r) || 'the call gave no answer'}. Press e to try again.`
  const d = jsonIn(r.text) as Any
  const body = str(d?.body, 2400)
  if (!body) return 'The longer explanation came back empty. Press e to try again.'
  const next = {
    ...g, body, here: str(d?.here, 800) || g.here || '',
    program: typeof d?.program === 'string' && d.program.trim() ? d.program.slice(0, 6000) : g.program || '',
    ...(d?.data && typeof d.data === 'object' ? { data: d.data } : {}),
    expanded: true,
    short: { body: g.body || '', here: g.here || '', program: g.program || '' },
  }
  const fresh = ((await recordNow($, row)) as MsgRecord | null) || rec
  await saveRecord($, remark({ ...fresh, glosses: { ...(fresh.glosses || {}), [id]: next } }) as MsgRecord)
  return next
}
