// expand.ts: an explainer written again at more length, in its place (0.10's shell/expand.ts, Longer). `e` on an
// explainer the tray shows asks for it: one side call (the registry's `explain-expand` prompt) reads the term, the
// explainer as it stands, the person's question, the answer as the person reads it, and the lines of the files the
// explainer and the answer point to, and writes a longer body and a "where it mattered" sentence with links to those
// lines. The message's part `explain` keeps the longer one in place of the short one (and the short one beside it), so
// the explainer reads the same wherever it opens next.
//
// The files: those the explainer's words link to (`[words](path#L12-20)`), then the places the checker's evidence found
// for the answer's citations (marks/store.ts MarkItem.evidence), then the files the answer links to.
import type { EngineInterface } from 'claude-code'

import { messageOf, partOf, questionOf, setPart } from '../core/answers'
import { textView } from '../core/answerview'
import { rootHere, startDir } from '../core/env'
import { modelWhy } from '../core/why.js'
import { rowMarks } from '../marks/store'
import { jsonIn } from '../observer/reply.mjs'
import { promptText } from '../prompts/prompts'
import { tracked } from '../telemetry/telemetry'
import type { ExplainPart, Gloss } from './seam'
import { filePlaces } from './place.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const FILES_BUDGET = 14000 // characters of cited files the call reads
const AROUND = 12 // lines read on each side of a cited span

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '')

type Place = { path: string; from: number | null; to: number | null }

/** The lines of the files at `places`, numbered, as the call reads them; at most FILES_BUDGET. */
async function citedFiles($: Engine, places: Place[], roots: string[]): Promise<string> {
  const out: string[] = []
  let used = 0
  const seen = new Set<string>()
  for (const p of places) {
    const key = `${p.path}#${p.from ?? ''}-${p.to ?? ''}`
    if (!p.path || seen.has(key)) continue
    seen.add(key)
    let text: string | null = null
    for (const root of p.path.startsWith('/') ? [''] : roots) {
      try { text = String(await $.fs.read(root ? `${root}/${p.path}` : p.path)); break } catch { /* the next root */ }
    }
    if (text == null) continue
    const all = text.split('\n')
    const a = p.from ? Math.max(1, p.from - AROUND) : 1
    const b = p.from ? Math.min(all.length, (p.to ?? p.from) + AROUND) : Math.min(all.length, 60)
    const body = all.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(5)}  ${l.slice(0, 240)}`).join('\n')
    const piece = `--- ${p.path} (lines ${a}–${b} of ${all.length})\n${body}`
    if (used + piece.length > FILES_BUDGET) break
    out.push(piece)
    used += piece.length
  }
  return out.join('\n\n') || '(no file the explainer cites could be read)'
}

/** The places the checker found for the row's citations: each evidence's file and cited lines. */
async function evidencePlaces($: Engine, row: string): Promise<Place[]> {
  const out: Place[] = []
  for (const it of (await rowMarks($, row).catch(() => null))?.items ?? []) {
    const ev = it.evidence as Any
    if (!ev || ev.kind === 'computed' || ev.kind === 'card') continue
    for (const pl of [ev, ...(Array.isArray(ev.more) ? ev.more : [])]) {
      if (typeof pl?.file !== 'string') continue
      const m = /^(\d+)(?:\D+(\d+))?/.exec(String(pl.line ?? ''))
      out.push({ path: pl.file, from: m ? Number(m[1]) : null, to: m ? Number(m[2] || m[1]) : null })
    }
  }
  return out
}

/**
 * The explainer `id` of the message `row`, written again at more length: the message's part takes it in place of the
 * short one. Returns null when it did, or a sentence that says why it was not written.
 */
export async function expandGloss($: Engine, row: string, id: string): Promise<string | null> {
  const msg = await messageOf($, row)
  const g = (await partOf<ExplainPart>($, row, 'explain'))?.items?.[id]
  if (!msg || !g) return 'That answer is not in this session any more.'
  if (g.expanded) return null
  const roots = [...new Set([await startDir($), (await rootHere($)) || ''].filter(Boolean))]
  const answer = (await textView($, row, msg.text)).text
  const places = [...filePlaces(`${g.body || ''}\n${g.here || ''}`), ...(await evidencePlaces($, row)), ...filePlaces(answer)]
  const question = await questionOf($, row).catch(() => '')
  const system = await promptText($, 'explain-expand')
  const prompt = [
    `The term: ${g.term}`,
    '',
    'The explainer as it stands:',
    `body: ${g.body || ''}`,
    `here: ${g.here || ''}`,
    '',
    `The analyst's question: ${String(question || '(not known)').slice(0, 2000)}`,
    '',
    'The answer the term stands in:',
    '<answer>', answer.slice(0, 12000), '</answer>',
    '',
    'The files the explainer and the answer cite, with their line numbers:',
    await citedFiles($, places, roots),
  ].join('\n')
  const req = { model: 'opus', maxTokens: 6000, timeoutMs: 120000, system: [{ text: system, cache: true }], prompt }
  let r: Any
  try {
    r = await tracked($, { feature: 'explain', prompt: 'explain-expand', doing: 'writing a longer explainer', model: req.model, extra: { row, term: g.term } }, () => $.model.complete(req as Any))
  } catch (err) {
    r = { isAnswered: false, reason: 'refused', error: String((err as Error)?.message || err).slice(0, 300) }
  }
  if (!r?.isAnswered) return `The longer explanation of “${g.term}” was not written: ${modelWhy(r) || 'the call gave no answer'}. Press e on it to try again.`
  const d = jsonIn(r.text) as Any
  const body = str(d?.body, 2400)
  if (!body) return `The longer explanation of “${g.term}” came back empty. Press e on it to try again.`
  const next: Gloss = { ...g, body, here: str(d?.here, 800) || g.here || '', expanded: true, short: { body: g.body || '', here: g.here || '' } }
  await setPart<ExplainPart>($, row, 'explain', cur => (cur?.items?.[id] ? { ...cur, items: { ...cur.items, [id]: next } } : cur))
  return null
}
