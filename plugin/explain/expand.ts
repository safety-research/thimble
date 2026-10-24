// expand.ts: an explainer of words the analyst picked in an answer (a citation's words in a pane, /explain), written on
// demand. One side call (the registry's `explain-expand` prompt) reads the words, the person's question, the answer as
// the person reads it, and the lines of the files the answer points to, and writes a body and a "where it mattered"
// sentence with links to those lines. The message's part `explain` keeps it as it keeps the look's explainers.
//
// The files: the places the checker's evidence found for the answer's citations (marks/store.ts MarkItem.evidence),
// then the files the answer links to. placeLines reads the lines an explainer's link points to, for the tray.
import type { EngineInterface } from 'claude-code'

import { messageOf, partOf, questionOf, setPart } from '../core/answers'
import { textView } from '../core/answerview'
import { rootHere, startDir } from '../core/env'
import { modelWhy } from '../core/why.js'
import { rowMarks } from '../marks/store'
import { jsonIn } from '../observer/reply.mjs'
import { promptText } from '../prompts/prompts'
import { tracked } from '../telemetry/telemetry'
import type { ExplainPart } from './seam'
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

const PLACE_LINES = 12 // lines the tray shows of a place an explainer cites

/** The lines of a file an explainer or a heads-up cites (the tray shows them when its link is pressed): from `from` to
 *  `to` (the file's first lines when no line is named), at most PLACE_LINES; else a sentence that says why not. */
export async function placeLines($: Engine, path: string, from: number | null, to: number | null): Promise<{ n: number; text: string }[] | string> {
  const roots = [...new Set([await startDir($), (await rootHere($)) || ''].filter(Boolean))]
  const a = Math.max(1, from ?? 1)
  const b = Math.min(Math.max(a, to ?? a + PLACE_LINES - 1), a + PLACE_LINES - 1)
  for (const root of path.startsWith('/') ? [''] : roots) {
    const file = root ? `${root}/${path}` : path
    let lines: string[]
    try {
      lines = String(await $.fs.read(file)).split('\n').slice(a - 1, b)
    } catch {
      // a file over the 4 MiB one read takes: its lines from sed
      const r = await $.process.run(['sed', '-n', `${a},${b}p;${b}q`, '--', file]).catch(() => null)
      if (!r || r.exitCode !== 0) continue
      lines = String(r.stdout).replace(/\n$/, '').split('\n')
    }
    return lines.map((l, i) => ({ n: a + i, text: l.slice(0, 400) }))
  }
  return `${path} could not be read here.`
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

/** One side call of the `explain-expand` prompt: the words, the question, the answer they stand in and the files it
 *  cites. {body, here} once written, else a sentence that says why not. */
async function writeExplainer($: Engine, row: string, term: string): Promise<{ body: string; here: string } | string> {
  const msg = await messageOf($, row)
  if (!msg) return 'That answer is not in this session any more.'
  const roots = [...new Set([await startDir($), (await rootHere($)) || ''].filter(Boolean))]
  const answer = (await textView($, row, msg.text)).text
  const places = [...(await evidencePlaces($, row)), ...filePlaces(answer)]
  const question = await questionOf($, row).catch(() => '')
  const system = await promptText($, 'explain-expand')
  const prompt = [
    `The term: ${term}`,
    '',
    `The analyst's question: ${String(question || '(not known)').slice(0, 2000)}`,
    '',
    'The answer the term stands in:',
    '<answer>', answer.slice(0, 12000), '</answer>',
    '',
    'The files the answer cites, with their line numbers:',
    await citedFiles($, places, roots),
  ].join('\n')
  const req = { model: 'opus', maxTokens: 6000, timeoutMs: 120000, system: [{ text: system, cache: true }], prompt }
  let r: Any
  try {
    r = await tracked($, { feature: 'explain', prompt: 'explain-expand', doing: 'writing an explainer you asked for', model: req.model, extra: { row, term } }, () => $.model.complete(req as Any))
  } catch (err) {
    r = { isAnswered: false, reason: 'refused', error: String((err as Error)?.message || err).slice(0, 300) }
  }
  if (!r?.isAnswered) return `The explanation of “${term}” was not written: ${modelWhy(r) || 'the call gave no answer'}.`
  const d = jsonIn(r.text) as Any
  const body = str(d?.body, 2400)
  if (!body) return `The explanation of “${term}” came back empty.`
  return { body, here: str(d?.here, 800) }
}

/**
 * An explainer of words the analyst picked in the message `row` (a citation's words, a term in a pane), written on
 * demand: kept in the message's part `explain` as its others are, so the words show it wherever they stand. {id} once
 * written, else a sentence that says why not.
 */
export async function askGloss($: Engine, row: string, term: string): Promise<{ id: string } | string> {
  const got = await writeExplainer($, row, term)
  if (typeof got === 'string') return got
  let id = ''
  await setPart<ExplainPart>($, row, 'explain', cur => {
    const items = { ...(cur?.items ?? {}) }
    let n = 1
    while (items[`a${n}`]) n++
    id = `a${n}`
    items[id] = { id, term, body: got.body, here: got.here, asked: true }
    return { items, order: [...(cur?.order ?? Object.keys(cur?.items ?? {})), id] }
  })
  return { id }
}
