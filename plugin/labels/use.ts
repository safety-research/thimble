// use.ts: the labels an answer or a card used, shown once, where they add something, and the ask before a large label
// run (0.10: shell/labeluse.ts; the ask in shell/labels.ts and shell.tsx). core/answerview.ts calls each function by
// name, since Claude Code follows `$` only into functions a file declares or imports.
//
// The label rows. Which labels a turn used are the `thimble label` commands its Bash calls ran (core/answers.ts
// labelsOf); a card's are those its turn ran before the card's call (CardUse.seq). A card gets one row under it: each
// label's name, how it was made in plain words (regex, code, read by Claude, or values Claude gave: the labels pane's
// words) and over how many records, and the values its records have, then the records with no value (in the pane's
// gray): under a card in the colors the card gives them (a plain dim dot where it gives none, so the row never shows
// a color the card does not use), under an answer in the label's own colors (the labels pane's). An answer gets a row
// only for the labels its turn used that none of its cards shows. A press on the name opens the label in the labels
// pane; a press on a value opens it on that value's records. The labels are read from hooks, never from a drawing
// (`thimble label --json`, the person's read): at each load of the plugin, after each of main's turns, after a
// `thimble label` command and after the person's answer to an ask; the rows draw what was last read. Claude Code stops
// every call a drawing made that still runs when a newer drawing replaces it, so a read started there could end
// `aborted` and leave the rows empty.
//
// The ask. A --prompt label over more than a sample of records (engine/kernel/estimate.py) does not start: the kernel
// writes a `label_ask` line in the change feed (core/feed.ts hands it to labelAskFromFeed). After the Bash call that
// made it, Claude reads the ask as the input of Claude Code's own question tool (use.mjs askContext: run all, or the
// rest after a sample; run on a sample; cancel; each with its model calls and about how long they take), and asks the
// person with it. Their answer in that tool's result is the choice (use.mjs answerChoice): it runs as the person
// (`thimble label NAME --answer all|sample|cancel --ask ID`, an id Claude never sees), the model's reads start beside
// the session (labels.ts labelFromFeed), and Claude reads what was chosen after the tool's result. An answer in the
// person's own words starts nothing; the same command again asks again.
//
//   labelsUnderAnswer($, els, row, cols)   the row under an answer
//   labelsUnderCard($, els, id, cols)      the row under a card
//   labelAskFromFeed($, ev)                a `label_ask` line of the kernel's change feed
//   answerAsk($, choice, ask?)             the person's choice; what Claude reads of it
//   registerLabelUse                       the reads of the labels (session.start, turn.complete, a `thimble label`
//                                          command), the ask after that command, and the person's answer to it
import type { EngineInterface, Register } from 'claude-code'

import { failNotice } from '../bar/notice'
import { metaOf, treeOf } from '../cards/store'
import { labelsOf, turnOfRow, turnsNow } from '../core/answers'
import { rootHere, runThimble } from '../core/env'
import { readFeed } from '../core/feed'
import { featureOn } from '../settings/features.mjs'
import { labelFromFeed, labelsChanged } from './labels'
import { colorOf, openLabels } from './pane'
import { answerChoice, answerNote, askContext, askOf, howMade, NO_VALUE, rowValues, tonesInTree, usedNames } from './use.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** A label a row names: its values (all of them, which fix each value's color), how it was made, over how many records.
 *  `shown`: the values the row names (use.mjs rowValues: those some record has, then the records with no value); all
 *  of `values` when not given. `tones`, set only under a card: the colors the card gives its values. */
export type UsedLabel = { name: string; values: string[]; shown?: { v: string; name: string }[]; kind?: string; records?: number; tones?: Record<string, string> }
/** The ask that waits for the person's choice. */
export type LabelAsk = { root: string; name: string; ask: string; text: string; meta: string; units: number; sample: number; rest: boolean; calls?: number }
type Choice = 'all' | 'sample' | 'cancel'

const LABELASK = { plugin: 'thimble', key: 'labelAsk' } as const
/** The values a row names at most. */
const VALUES_SHOWN = 8

// ------------------------------------------------------------------------------------------------ the labels, read

/** The folder's labels as last read, by folder; the read that runs, by folder, and whether another is asked after it
 *  (the labels changed while it ran). */
const lists = new Map<string, Any[]>()
const reading = new Map<string, Promise<void>>()
const again = new Set<string>()

/** Read the folder's labels (`thimble label --json`) beside the session, and draw again once read. Asked from hooks
 *  only (needLabelList: registerLabelUse, answerAsk, turnLabelUse). One read runs at a time per folder; one asked
 *  while it runs reads once more after it, so the last read is after the newest change. A read that fails keeps the
 *  list as it stood. */
export async function readLabelList($: Engine): Promise<void> {
  const root = await rootHere($)
  if (!root) return
  if (reading.has(root)) {
    again.add(root)
    return
  }
  const run = (async () => {
    do {
      again.delete(root)
      try {
        // read here, not through the pane's labelsData: its answers are kept per labelGen, which a hook beside this one
        // may not have moved on yet when this reads
        const r = await runThimble($, root, ['label', '--json'], { timeoutMs: 60000 })
        const v = JSON.parse(r.stdout)
        if (r.code === 0 && Array.isArray(v)) lists.set(root, v)
      } catch {
        // the rows keep the list as it stood; the next hook reads again
      }
      $.ui.invalidate('ui.render')
    } while (again.has(root))
  })().finally(() => { reading.delete(root) })
  reading.set(root, run)
  await run
}

/** Read the folder's labels a moment after the hook that asks (as bar/counts.ts needCounts counts), beside the
 *  session. */
export function needLabelList($: Engine): void {
  $.clock.after(0, () => { void readLabelList($).catch(() => undefined) })
}

/** The folder's labels as last read, or null before the first read. A drawing reads nothing itself. */
function labelList(root: string): Any[] | null {
  return lists.get(root) ?? null
}

/** The labels named, as the folder holds them now (a name no label has any more is left out); null while read. */
async function usedOf($: Engine, names: string[]): Promise<UsedLabel[] | null> {
  if (!names.length) return []
  const root = await rootHere($)
  if (!root) return []
  const list = labelList(root)
  if (!list) return null
  const out: UsedLabel[] = []
  for (const name of names) {
    const l = list.find(x => x && x.name === name)
    if (!l || !Array.isArray(l.values)) continue
    out.push({ name, values: l.values.map(String), shown: rowValues(l), ...(typeof l.kind === 'string' ? { kind: l.kind } : {}), ...(typeof l.records === 'number' ? { records: l.records } : {}) })
  }
  return out
}

// ------------------------------------------------------------------------------------------------ the rows

/** The row under a card or an answer: `label has-link · regex · 412 records  ● yes  ● no`, each name and value a
 *  press. Each label is one group, so a row too long for the width wraps between labels, never inside one; the word
 *  `label` (`labels`) is one item with the first name, so a wrap never leaves it alone on its row. */
export function labelRowEl(els: Any, used: UsedLabel[], o: { key: string; onOpen: (name: string, value: string | null) => unknown }): Any | null {
  if (!used.length) return null
  const { Box, Button, Text } = els
  const row: Any[] = []
  used.forEach((l, i) => {
    if (i) row.push(Text({ key: `${o.key}-s${i}`, dimColor: true, children: '   ' }))
    const kids: Any[] = []
    const name = Button({ key: `${o.key}-n${i}`, plain: true, label: `open the label ${l.name}`, onPress: () => o.onOpen(l.name, null), children: [Text({ key: 'n', bold: true, children: l.name })] })
    kids.push(i ? name : Box({ key: `${o.key}-w`, flexDirection: 'row', flexShrink: 0, children: [Text({ key: 'w', dimColor: true, children: used.length === 1 ? 'label ' : 'labels ' }), name] }))
    const how = howMade(l.kind)
    if (how) kids.push(Text({ key: `${o.key}-h${i}`, dimColor: true, children: ` · ${how}` }))
    if (typeof l.records === 'number') kids.push(Text({ key: `${o.key}-d${i}`, dimColor: true, children: ` · ${l.records.toLocaleString('en-US')} ${l.records === 1 ? 'record' : 'records'}` }))
    ;(l.shown ?? l.values.map(v => ({ v, name: v }))).slice(0, VALUES_SHOWN).forEach(({ v, name }, j) => {
      // under a card (`tones`): the color the card gives the value, or a plain dim dot where it gives none; under an
      // answer: the label's own colors. The records with no value: the pane's gray, under a card too
      const none = v === NO_VALUE
      const color = none ? colorOf(l.values, v) : l.tones ? l.tones[v] : colorOf(l.values, v)
      const words = color ? [Text({ key: 'v', color, children: `● ${name}` })] : [Text({ key: 'd', dimColor: true, children: '●' }), Text({ key: 'v', children: ` ${name}` })]
      kids.push(Text({ key: `${o.key}-g${i}-${j}`, children: '  ' }))
      kids.push(Button({ key: `${o.key}-v${i}-${j}`, plain: true, label: none ? `the records of ${l.name} with ${name === 'no value' ? 'no value' : 'no value yet'}` : `the records of ${l.name} that are ${v}`, onPress: () => o.onOpen(l.name, v), children: words }))
    })
    row.push(Box({ key: `${o.key}-l${i}`, flexDirection: 'row', flexWrap: 'wrap', children: kids }))
  })
  return Box({ key: o.key, flexDirection: 'row', flexWrap: 'wrap', children: row })
}

/** What a press on a row's label name (value null) or value does: open the labels pane on it. The open is returned, so
 *  it is made while the press runs: Claude Code places the pane at any width only for such an open. */
function opener($: Engine): (name: string, value: string | null) => Promise<unknown> {
  return (name, value) => openLabels($, value == null ? { label: name } : { label: name, value })
}

/** The labels a card's newest call used: those its turn ran before the call. */
async function cardNames($: Engine, id: string): Promise<string[]> {
  const turns = await turnsNow($)
  for (const t of [...turns].reverse()) {
    const use = [...(t.cards ?? [])].reverse().find(c => c.id === id)
    if (use) return usedNames(await labelsOf($, t.turnId, use.seq))
  }
  return []
}

export async function labelsUnderAnswer($: Engine, els: Any, row: string, _cols: number): Promise<Any[]> {
  // none while thimble is off in this session (/thimble-off), as the answer's other lines
  if (!featureOn('thimble')) return []
  const turn = await turnOfRow($, row)
  if (!turn || turn.answer !== row || !turn.labels?.length) return []
  // not those a card of this answer shows
  const shown: string[] = []
  for (const c of turn.cards ?? []) {
    const meta = await metaOf($, c.id)
    if (meta && meta.version > 0) shown.push(...usedNames(await labelsOf($, turn.turnId, c.seq)))
  }
  const used = await usedOf($, usedNames(await labelsOf($, turn.turnId), shown))
  const el = used ? labelRowEl(els, used, { key: `lu-${row}`, onOpen: opener($) }) : null
  return el ? [els.Box({ key: `lu-box-${row}`, marginLeft: 2, children: [el] })] : []
}

export async function labelsUnderCard($: Engine, els: Any, id: string, _cols: number): Promise<Any[]> {
  if (!featureOn('thimble')) return []
  const found = await usedOf($, await cardNames($, id))
  if (!found?.length) return []
  const tree = (await treeOf($, id))?.tree ?? null
  const used = found.map(l => ({ ...l, tones: tonesInTree(tree, l.values) as Record<string, string> }))
  const el = labelRowEl(els, used, { key: `lu-card-${id}`, onOpen: opener($) })
  return el ? [els.Box({ key: `lu-box-card-${id}`, marginLeft: 2, children: [el] })] : []
}

// ------------------------------------------------------------------------------------------------ the ask

/** The asks already shown, by id: an ask the person answered never comes back. */
const asksSeen = new Set<string>()

/** A /clear or a /resume (hooks/turnover.ts): the label rows read the new conversation's labels, and an ask about a
 *  label of the earlier one leaves the screen (its label keeps it: the same command in that conversation asks
 *  again). */
export async function turnLabelUse($: Engine): Promise<void> {
  lists.clear()
  await setLabelAsk($, null)
  needLabelList($)
}

export async function labelAskNow($: Engine): Promise<LabelAsk | null> {
  return ((await $.state.get(LABELASK)).value ?? null) as LabelAsk | null
}

/** The ask that waits (null: none). */
export async function setLabelAsk($: Engine, a: LabelAsk | null): Promise<void> {
  await $.state.set(LABELASK, a)
}

/** The asks the feed brought since the last Bash call took them (askContext tells Claude of each). */
let fresh: LabelAsk[] = []

export async function labelAskFromFeed($: Engine, ev: unknown): Promise<void> {
  const a = askOf(ev) as LabelAsk | null
  if (!a || asksSeen.has(a.ask)) return
  asksSeen.add(a.ask)
  fresh.push(a)
  await setLabelAsk($, a)
}

/** The person's choice for the ask: run all, run on a sample, or cancel, as their own command. The reads start here,
 *  beside the session. Returns what Claude reads of it, or null when the choice did not run (a failure line says why). */
export async function answerAsk($: Engine, choice: Choice, given?: LabelAsk): Promise<string | null> {
  const a = given ?? (await labelAskNow($))
  if (!a) return null
  await setLabelAsk($, null)
  const about = `label-ask:${a.root}|${a.name}`
  let out = ''
  let ok = false
  try {
    const r = await runThimble($, a.root, ['label', a.name, '--answer', choice, '--ask', a.ask])
    out = `${r.stdout}\n${r.stderr}`.trim()
    ok = r.code === 0
  } catch (err) {
    out = String((err as Error)?.message || err)
  }
  let got: Any = null
  try { got = JSON.parse(out) } catch { got = null }
  if (!ok || !got) {
    const why = out.split('\n').slice(-1)[0]?.replace(/^thimble label: /, '').slice(0, 200) || 'thimble label gave nothing'
    failNotice($, `× The label ${a.name} did not start: ${why}. Ask Claude to run it again.`, about)
    return `The analyst's choice for the label ${a.name} did not run: ${why}. Run the same \`thimble label\` command again to ask them again.`
  }
  await labelsChanged($)
  needLabelList($)
  if (choice !== 'cancel') labelFromFeed($, { name: a.name, root: a.root, t: `${a.ask}-${choice}` })
  return answerNote(a, choice, got)
}

/** A Bash command of Claude's that runs `thimble label` (labels/register.ts reads it alike). */
const LABEL_COMMAND = /\bthimble\b[^\n|;&]*\blabel\b/

export const registerLabelUse: Register = on => {
  // the labels at each load of the plugin (a new or resumed session, a reload, a switch turned on)
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    needLabelList($)
    return r
  }).catch(($, e, next) => next(e))
  // after each of main's turns, which may have run a label
  on('turn.complete', { reason: /^(answer|aborted|refusal|error)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) needLabelList($)
    return r
  }).catch(($, e, next) => next(e))
  // a `thimble label` command of Claude's (main's or a fork's) may change a label, or make an ask: Claude reads the ask
  // after the command's output, as the question to ask the person
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    if (!LABEL_COMMAND.test(String((e as { command?: unknown }).command || ''))) return r
    needLabelList($)
    await readFeed($)
    const asks = fresh
    fresh = []
    if (!asks.length || 'deny' in r) return r
    return { ...r, context: [...(r.context ?? []), ...asks.map(a => askContext(a))] }
  }).catch(($, e, next) => next(e))
  // the person's answer to Claude's question about an ask: their choice runs, and Claude reads what it started
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const r = await next(e)
    const a = await labelAskNow($)
    if (!a || 'deny' in r) return r
    const choice = answerChoice(a, e, (r as { result?: unknown }).result) as Choice | null
    if (!choice) return r
    const note = await answerAsk($, choice, a)
    return note ? { ...r, context: [...(r.context ?? []), note] } : r
  }).catch(($, e, next) => next(e))
}

/** For tests: nothing read, no ask seen. */
export function resetLabelUse(): void {
  lists.clear()
  reading.clear()
  again.clear()
  asksSeen.clear()
  fresh = []
}
