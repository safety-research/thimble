// expand.ts: an explainer of words the analyst picked in an answer (a citation's words in a pane, the selection), written on
// demand. One fork of the conversation (the registry's `explain-expand` prompt), as the look's explainers are written,
// so it reads the records main read; it is told the words, the person's question, the answer as the person reads it,
// and the lines of the files the answer points to, and writes a body and a "where it mattered" sentence with links to
// those lines. With no conversation to fork (after /clear), one side call reads the same without the records. The
// message's part `explain` keeps it as it keeps the look's explainers.
//
// The files: the places the checker's evidence found for the answer's citations (marks/store.ts MarkItem.evidence),
// then the files the answer links to, then, for the tour's sample answer, the tour's data, which Claude did not read
// for it (tour/tour.ts tourFiles). The writer reads no file itself: Claude Code refuses each tool call of a fork. So it
// reads the lines given here, and the records in the conversation. placeLines reads the lines an explainer's link
// points to, for the tray. A relative path is read in the folder the session started in, then the folder holding the
// labels, then, after a tour, the tour's sample data (readRoots). What the call reads after its text, and what its
// reply gives, are ask.mjs's, which the workbench's e reads too.
import type { EngineInterface } from 'claude-code'

import { messageOf, questionOf, setPart } from '../core/answers'
import { textView } from '../core/answerview'
import { rootHere, startDir } from '../core/env'
import { modelWhy } from '../core/why.js'
import { rowMarks } from '../marks/store'
import { promptText } from '../prompts/prompts'
import { tracked } from '../telemetry/telemetry'
import { tourData, tourFiles } from '../tour/tour'
import { askText, citedFiles, evidencePlaces, explainerOf } from './ask.mjs'
import type { ExplainPart } from './seam'
import { filePlaces } from './place.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

type Place = { path: string; from: number | null; to: number | null }

/** The lines of the files at `places`, numbered, as the call reads them (ask.mjs citedFiles): a relative path read in
 *  the folders of readRoots, in turn. */
async function filesAt($: Engine, places: Place[], roots: string[]): Promise<string> {
  return citedFiles(places, async (path: string) => {
    for (const root of path.startsWith('/') ? [''] : roots) {
      try { return String(await $.fs.read(root ? `${root}/${path}` : path)) } catch { /* the next root */ }
    }
    return null
  })
}

const PLACE_LINES = 12 // lines the tray shows of a place an explainer cites

/** The folders a relative path is read in, in turn: the folder the session started in, the folder holding the labels,
 *  and, when a tour ran in this session, the tour's sample data, whose orders.csv its answers name. */
async function readRoots($: Engine): Promise<string[]> {
  return [...new Set([await startDir($), (await rootHere($)) || '', (await tourData($).catch(() => null)) || ''].filter(Boolean))]
}

/** The lines of a file an explainer or a heads-up cites (the tray shows them when its link is pressed): from `from` to
 *  `to` (the file's first lines when no line is named), at most PLACE_LINES; else a sentence that says why not. */
export async function placeLines($: Engine, path: string, from: number | null, to: number | null): Promise<{ n: number; text: string }[] | string> {
  const roots = await readRoots($)
  const a = Math.max(1, from ?? 1)
  const b = Math.min(Math.max(a, to ?? a + PLACE_LINES - 1), a + PLACE_LINES - 1)
  for (const root of path.startsWith('/') ? [''] : roots) {
    const file = root ? `${root}/${path}` : path
    let lines: string[]
    try {
      lines = String(await $.fs.read(file)).split('\n').slice(a - 1, b)
    } catch {
      // a file over the 4 MiB one read takes: its lines from sed (the script after -e, so that macOS's sed, which stops
      // reading options at the script, takes -- as the end of them, not as a file)
      const r = await $.process.run(['sed', '-n', '-e', `${a},${b}p;${b}q`, '--', file]).catch(() => null)
      if (!r || r.exitCode !== 0) continue
      lines = String(r.stdout).replace(/\n$/, '').split('\n')
    }
    return lines.map((l, i) => ({ n: a + i, text: l.slice(0, 400) }))
  }
  return `${path} could not be read here.`
}

/** The places the checker found for the row's citations: each evidence's file and cited lines. */
async function placesOf($: Engine, row: string): Promise<Place[]> {
  return evidencePlaces((await rowMarks($, row).catch(() => null))?.items ?? [])
}

/** The `explain-expand` prompt over the conversation (a fork), else in a side call: the words, the question, the answer
 *  they stand in and the files it cites. The explainer its reply gives once written (null for none), else a sentence
 *  that says why not. */
async function writeAbout($: Engine, row: string, term: string): Promise<{ body: string; here: string } | null | string> {
  const msg = await messageOf($, row)
  if (!msg) return 'That answer is not in this session any more.'
  const roots = await readRoots($)
  const answer = (await textView($, row, msg.text)).text
  // the tour's sample answer names its data file, and links nothing: the file is read whole
  const tour = (await tourFiles($, row).catch(() => [] as string[])).map(path => ({ path, from: null, to: null }))
  const places = [...(await placesOf($, row)), ...filePlaces(answer), ...tour]
  const question = await questionOf($, row).catch(() => '')
  const system = await promptText($, 'explain-expand')
  const prompt = askText({ term, question, answer, files: await filesAt($, places, roots) })
  const req = { model: 'opus', maxTokens: 6000, timeoutMs: 120000, system: [{ text: system, cache: true }], prompt }
  const short = term.length > 40 ? `${term.slice(0, 39)}…` : term
  let r: Any
  try {
    r = await tracked($, { feature: 'explain', prompt: 'explain-expand', doing: `writing an explainer of “${short}”`, model: req.model, extra: { row, term } }, async () => {
      // the conversation, as the look reads it: the records main read are in it
      const f: Any = await $.model.fork({ prompt: `${system}\n\n${prompt}` })
      return f?.reason === 'nothing-to-fork' ? $.model.complete(req as Any) : f
    })
  } catch (err) {
    r = { isAnswered: false, reason: 'refused', error: String((err as Error)?.message || err).slice(0, 300) }
  }
  if (!r?.isAnswered) return `The explanation of “${term}” was not written: ${modelWhy(r) || 'the call gave no answer'}.`
  return explainerOf(r.text)
}

/**
 * An explainer of words the analyst picked in the message `row` (a citation's words, a term in a pane), written on
 * demand: kept in the message's part `explain` as its others are, so the words show it wherever they stand. {id} once
 * written, else a sentence that says why not.
 */
export async function askGloss($: Engine, row: string, term: string): Promise<{ id: string } | string> {
  const got = await writeAbout($, row, term)
  if (typeof got === 'string') return got
  if (!got) return `The explanation of “${term}” came back empty.`
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
