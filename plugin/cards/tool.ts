// tool.ts: the `card` tool. Claude writes its rows as a JSON file with its own code and calls card with the file's
// path, a title and a short JavaScript view. One call:
//
//   0. asks the person's permission rules: a deny rule for the card tool, or for reading the data file, refuses the
//      call, as plan mode's refusal does. An `ask` that a rule of the person's makes refuses it too, since Claude Code
//      cannot put its dialog in front of a plugin's own tool; one that comes only from the mode (a tool of a plugin, a
//      file outside the working folder) lets it go on, since the card reads only a file of the session's folders or
//      temp folder, and runs its view in the runner's sandbox
//   1. checks the file is in the session's folder or the temp folder, and copies it into the card's folder
//   2. loads the view and the copy into the runner (runner.mjs), which draws the card and makes its text copy
//   3. keeps the card (store.ts) and draws it where the call stands (draw.ts), or under the answer v was pressed on when
//      the designer fork called; a new version draws in the card's place
//   4. tries the call's actions, keys and clicks in order, then puts the card back as it was
//   5. answers what the card read (rows, columns, the first row), the text copy at the card's width, the copy at the
//      width a side pane leaves it when a row that fits at the card's width wraps there, and the copy after each
//      action. Nothing in it asks for a new version: notes come only for what is wrong (a key the card cannot get, a
//      row a side pane breaks, a card taller than the screen)
//
// So Claude learns what its card shows without printing the rows itself. A call with `id` draws a new version of that
// card in the card's place, under the call that first drew it or under the answer v was pressed on (its view whole, or
// the view of the last call with `edits`; its rows new, or kept), and keeps the title unless the call gives a new one;
// the later call shows one line that points to it. A version that fails leaves the one on screen, its view and rows are
// kept for the next call's `edits`, and the view's error goes back to Claude.
// The designer fork changes only the cards it drew under its answer: its call with the id of another card (main's,
// which it reads in its copy of the conversation) draws a new card of its own from that card's view and rows.
import type { EngineInterface } from 'claude-code'

import { failCleared } from '../bar/notice'
import { startDir } from '../core/env'
import { forkOf } from '../core/forks'
import { tempDir } from '../core/home'
import { paneNow } from '../core/pane'
import { mainTurn } from '../core/turn'
import { designAnchor } from '../designer/v'
import { threadCardAnchor } from '../threads/seam'
import { ownKeys } from '../hooks/keys'
import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
import { record } from '../telemetry/telemetry'
import { ask, sandboxNotice } from './ask'
import { applyAnswer, askCard, canRedraw, cardWidth, cardWidthBesidePane, screenRows } from './draw'
import { type CardCall, type CardMeta, cardIdOf, isCardId, metaOf, saveMeta, saveState, setFocus, setTree, treeOf, versionDir } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const MAX_ROWS_BYTES = 64 * 1024 * 1024
const COPY_LINES = 60
/** Rows of the screen the card's frame, the prompt box and the bar above it take, besides the card's own. */
const AROUND_ROWS = 14

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'what the card shows, in a few words; with `id`, leave out to keep the title' },
    data: { type: 'string', description: 'the path of the JSON file of rows, in this folder or $TMPDIR (may start with $TMPDIR/); with `id`, leave out to keep the rows' },
    view: { type: 'string', description: 'JavaScript that defines function view(props, surface); with `id`, give `edits` instead, or only new `data` to keep the view' },
    edits: {
      type: 'array',
      description: 'with `id`: changes to the view of your last call of that card (also one that failed), in order; each `old` occurs once in it',
      items: { type: 'object', required: ['old', 'new'], properties: { old: { type: 'string' }, new: { type: 'string' } } },
    },
    id: { type: 'string', description: 'the id of a card you drew, for a new version in its place' },
    actions: {
      type: 'array',
      description: 'keys and clicks to try in order; each returns a text copy, then the card goes back',
      items: { type: 'object', properties: { key: { type: 'string' }, click: { description: 'words the card shows (a click there, as the analyst clicks), or [x, y] in cells', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] } } },
    },
  },
}

/** The card guide, as the model reads it: card-tool.md with the temp folder and thimble's own keys filled in. The
 *  tool's description, and what a squeeze's request shows of how a card's view is written (squeeze/cards.ts). */
export async function cardGuide($: Engine): Promise<string> {
  const text = await promptText($, 'card-tool')
  const own = ownKeys()
  const kept = `${own.slice(0, -1).join(', ')} or ${own[own.length - 1]}`
  return fill(text, { TMPDIR: await tempDir($), KEPT: kept }).trim()
}

/** The tool, as the model reads it. */
export async function registerCardTool($: Engine): Promise<void> {
  await $.tool.register({ name: 'card', isDeferred: false, description: await cardGuide($), inputSchema: SCHEMA })
}

/** Why the person's permission rules refuse this call, or null (step 0 above). */
async function refused($: Engine, input: Record<string, unknown>, file: string | null): Promise<string | null> {
  const says = (v: { decision: string; reason?: string; rule?: string }) => v.decision === 'deny' || (v.decision === 'ask' && !!v.rule)
  const card = await $.tool.check({ tool: 'mcp__thimble__card', input })
  if (says(card)) return card.reason || `the permission rule ${card.rule ?? ''} refuses the card tool`.replace('  ', ' ')
  if (!file) return null
  const read = await $.tool.check({ tool: 'Read', input: { file_path: file } })
  if (says(read)) return read.reason || `the permission rule ${read.rule ?? ''} refuses reading ${file}`.replace('  ', ' ')
  return null
}

/** The folders a data file may be in, each as its real path: the session's folders and the temp folder. */
async function roots($: Engine): Promise<string[]> {
  const out: string[] = []
  for (const c of [await $.session.cwd().catch(() => ''), await startDir($).catch(() => ''), await tempDir($)]) {
    if (!c) continue
    const st = await $.fs.stat(c, { resolve: true }).catch(() => null)
    if (st?.kind === 'dir' && st.realPath && !out.includes(st.realPath)) out.push(st.realPath)
  }
  return out
}

/** The data file's real path, or why it cannot be read. */
async function dataFile($: Engine, raw: string): Promise<{ path?: string; bad?: string }> {
  const p = String(raw ?? '').trim()
  if (!p) return { bad: '`data` is empty: give the path of the JSON file of rows you wrote' }
  const expanded = p.replace(/^\$\{?TMPDIR\}?(?=\/)/, await tempDir($))
  const path = expanded.startsWith('/') ? expanded : `${await $.session.cwd()}/${expanded}`
  const st = await $.fs.stat(path, { resolve: true }).catch(() => null)
  if (!st || st.kind !== 'file' || !st.realPath) return { bad: `there is no file at ${p}` }
  const real = st.realPath
  if (!(await roots($)).some(r => real === r || real.startsWith(`${r}/`))) return { bad: `${p} is outside this folder and the temp folder ($TMPDIR); write the data file in one of them` }
  if (st.size > MAX_ROWS_BYTES) return { bad: `${p} is ${Math.round(st.size / 1048576)} MB; a card reads at most 64 MB, so write only the rows it shows` }
  return { path: real }
}

/** The view of a call: the whole `view` it gives, or the view of the card's last call (in `last`, that call's
 *  folder, also when its version did not draw) with the call's `edits` made in order, each `old` text standing once
 *  in it, or as it is when the call gives only new rows. */
async function viewOf($: Engine, input: Any, last: string | null): Promise<{ text?: string; bad?: string }> {
  if (typeof input.view === 'string' && input.view.trim()) return { text: input.view }
  const edits = Array.isArray(input.edits) ? input.edits : []
  // new rows for the view on screen: the view of the last call as it is
  if (!edits.length && last && String(input.data ?? '').trim()) return readView($, last)
  if (!edits.length) return { bad: last ? 'give the whole `view`, `edits` to the view of your last call, or new `data` for it' : '`view` is empty: give the JavaScript that defines function view(props, surface)' }
  if (!last) return { bad: '`edits` change a card you called card for: give its `id`, or the whole `view` for a new card' }
  const read = await readView($, last)
  if (read.bad) return read
  let text = read.text!
  for (const [k, x] of edits.entries()) {
    const old = String(x?.old ?? '')
    const n = old ? text.split(old).length - 1 : 0
    if (n > 1) return { bad: `edit ${k + 1}: its \`old\` text stands ${n} times in the view, not once; give more of the text around it` }
    if (!n) {
      // where its first line stands, so the next try copies the view's own text
      const first = old.split('\n')[0]!.trim()
      const at = first ? text.indexOf(first) : -1
      return { bad: `edit ${k + 1}: its \`old\` text is not in the view of your last call${at >= 0 ? `, which has here: ${JSON.stringify(text.slice(at, at + old.length + 20))}` : ''}` }
    }
    text = text.replace(old, () => String(x?.new ?? ''))
  }
  return { text }
}

async function readView($: Engine, last: string): Promise<{ text?: string; bad?: string }> {
  try { return { text: String(await $.fs.read(`${last}/view.js`)) } } catch { return { bad: 'the view of your last call cannot be read; give the whole `view`' } }
}

const baseName = (p: string) => String(p).split('/').filter(Boolean).pop() ?? String(p)
const oneLine = (s: string, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim(); return [...t].length > n ? `${[...t].slice(0, n - 1).join('')}…` : t }

/** A text copy for Claude: at most COPY_LINES lines, and a note on the lines cut at the card's width. */
function copyText(lines: string[], cut: number[], width: number): string[] {
  const out = lines.slice(0, COPY_LINES)
  if (lines.length > COPY_LINES) out.push(`(${lines.length - COPY_LINES} more lines)`)
  if (cut.length) out.push(`(line${cut.length > 1 ? 's' : ''} ${cut.slice(0, 8).join(', ')} ${cut.length > 1 ? 'are' : 'is'} wider than the card's ${width} columns and cut there)`)
  return out
}

/** The card as a side pane draws it, when a row that fits at the card's width wraps there (the runner's load says:
 *  runner.mjs besideOf). */
function besidePane(beside: Any, width: number): string[] {
  if (!beside?.wrapped?.length) return []
  const lines = beside.wrapped as number[]
  const which = `line${lines.length > 1 ? 's' : ''} ${lines.slice(0, 8).join(', ')}`
  return ['', `When a side pane opens beside the conversation, the card is ${beside.width} columns wide, and rows that fit at ${width} columns wrap there, out of their columns (${which}):`, ...copyText(beside.lines, beside.cut, beside.width)]
}

/** What a call answers when the version did not draw: what to fix, or, when the runner cannot start, that the card is
 *  not the cause (the person sees why in the failure line). */
function failed(id: string, r: Any, update: boolean): string {
  const error = String(r?.error || 'no answer').slice(0, 800)
  if (r?.down) return `The card did not draw: ${error}. The view is not the cause, and cards cannot draw in this session until the analyst fixes it; answer in words.`
  const fix = r?.phase === 'rows' ? 'Fix the data file' : 'Fix the view (`edits` change the view of this call)'
  const kept = update ? ' The version on screen stays.' : ''
  return `The card did not draw: ${error}.${kept}\n${fix} and call card again with id "${id}".`
}

/** One call of the card tool. Its line in the session's events (telemetry) says how long the call took to draw the
 *  card: `drawn_ms` from the call to the drawing in place, `ms` to the answer with its actions. */
export async function cardCall($: Engine, e: Any): Promise<{ result: string }> {
  const t0 = Date.now()
  const input = e ?? {}
  const toolUseId = String(input.tool_use_id ?? '')
  const given = String(input.id ?? '').trim()
  const update = !!given
  const target = update ? given : cardIdOf(toolUseId)
  const found = isCardId(target) ? await metaOf($, target) : null
  if (update && !found) return { result: `There is no card "${oneLine(given, 40)}" to replace. Leave out \`id\` to draw a new card.` }

  // a card stands at a call of main's, under the answer the running designer fork draws for, or in the side thread
  // whose fork drew it (`thread:<key>`, under that thread's answer in its pane); another agent's call stands in that
  // agent's own transcript, where the person never sees a card
  const fork = forkOf(input.agentId)
  const anchorRow = fork?.kind === 'designer' ? await designAnchor($, input.agentId) : fork?.kind === 'thread' ? await threadCardAnchor($, input.agentId, target) : null
  if (input.agentId && !anchorRow) return { result: 'The card did not draw: only the main conversation, the copy that v starts and a side thread draw cards, since a card stands at its call and the analyst sees only those calls. Give the rows and the view to the main conversation instead.' }
  // the designer fork draws its own cards under the answer v was pressed on. A card that does not stand there (main's,
  // whose id the fork read in its copy of the conversation, or one under another answer) is not the fork's to change:
  // its call draws a new card, from that card's view and rows
  const borrowed = fork?.kind === 'designer' && found && found.anchorRow !== anchorRow ? found : null
  const id = borrowed ? cardIdOf(toolUseId) : target
  const before = borrowed ? null : found
  // a version keeps the card's title unless the call gives a new one
  const title = oneLine(String(input.title ?? ''), 120) || found?.title || ''
  if (!title) return { result: 'The card did not draw: `title` is empty: give the card\'s title, what it shows in a few words.' }
  const placeWords = (row: string | null) => (row?.startsWith('thread:') ? 'in the side thread, under your answer' : 'under the answer v was pressed on')
  const meta: CardMeta = before ?? {
    id, version: 0, last: 0, lastFile: '', title, toolUseId, agentId: input.agentId ? String(input.agentId) : null, anchorRow,
    keys: [], read: '', columns: [], file: '', gen: 0, error: null, errorWidth: null, calls: {}, at: Date.now(),
  }
  const remember = (m: CardMeta, call: CardCall) => saveMeta($, { ...m, calls: { ...m.calls, [toolUseId]: call } })
  const refuse = async (why: string) => {
    await remember(meta, { version: meta.version, error: why })
    return { result: `The card did not draw: ${why}.` }
  }

  // a new version may keep the view of the card's last call with a few edits, and its rows: writing the whole view
  // again takes the model half a minute. The last call's folder is the version on screen, or the version after it
  // when that call did not draw (its view did not parse, say), so `edits` fix the view the error was about
  const base = borrowed ?? meta
  const lastNo = base.last ?? base.version
  const last = lastNo > 0 ? await versionDir($, base.id, lastNo) : null
  const view = await viewOf($, input, last)
  if (view.bad) return refuse(view.bad)
  const keep = !String(input.data ?? '').trim() && last
  const data = keep ? { path: `${last}/rows.json` } : await dataFile($, input.data)
  if (data.bad) return refuse(data.bad)
  // the card tool's rules decide every call; the Read rules, a call with new rows (kept rows were read before)
  const no = await refused($, { title, data: input.data, view: view.text, ...(input.id ? { id: input.id } : {}) }, keep ? null : data.path!)
  if (no) return refuse(no)
  const file = keep ? (base.lastFile ?? base.file) : String(input.data)
  const version = meta.version + 1
  const dir = await versionDir($, id, version)
  await $.fs.write(`${dir}/view.js`, view.text!)
  const copied = data.path === `${dir}/rows.json` ? { exitCode: 0, stderr: '' } : await $.process.run(['cp', '--', data.path!, `${dir}/rows.json`])
  if (copied.exitCode !== 0) {
    const error = `thimble could not copy ${file} (${String(copied.stderr).trim().slice(0, 200)})`
    await remember(meta, { version: meta.version, error })
    return { result: `The card did not draw: ${error}.` }
  }

  const width = (await treeOf($, id))?.width ?? cardWidth()
  // a pane open now: the card is drawn at the width it leaves, and no narrower copy is asked for
  const beside = (await paneNow($)) ? 0 : cardWidthBesidePane()
  const r = await ask($, 'load', { id, version, title, view: view.text, rows: `${dir}/rows.json`, state: null, width, beside })
  if (!r?.ok) {
    // the folder stays as the last call's, for the next call's `edits`; the version on screen stays
    await remember({ ...meta, last: version, lastFile: file }, { version: meta.version, error: String(r?.error || 'no answer'), ...(r?.down ? { down: true } : {}) })
    if (r?.down) sandboxNotice($, `Cards cannot draw: ${String(r.error).slice(0, 600)}`, !!r.machine)
    return { result: failed(id, r, update && meta.version > 0) }
  }

  const asked = [...new Set([...String(r.keys || '')].filter(k => !/\s/.test(k)))]
  const keys = asked.filter(k => /^\p{L}$/u.test(k) && !ownKeys().includes(k))
  // a new version takes the card's place: under the call of main's that drew its first version, or under the answer v
  // was pressed on when the designer fork drew it. Where Claude Code cannot draw that place again (the main screen,
  // once main's turn that drew it ended), main's version stands at its own call
  const stays = meta.version > 0 && (!!fork || (await canRedraw($, meta.turn)))
  const home = stays ? { toolUseId: meta.toolUseId, anchorRow: meta.anchorRow, turn: meta.turn } : { toolUseId, anchorRow, turn: fork ? meta.turn : await mainTurn($) }
  const next: CardMeta = {
    ...meta, ...home, version, last: version, lastFile: file, title, keys, read: String(r.summary.read), columns: r.summary.columns, file,
    gen: meta.gen + 1, error: null, errorWidth: null, at: Date.now(), agentId: input.agentId ? String(input.agentId) : null,
  }
  await remember(next, { version, title, file, read: next.read })
  await setTree($, id, { gen: next.gen, width, tree: r.tree, seq: Number(r.seq) || 0 })
  await setFocus($, id)
  await failCleared($, `card:${id}`)
  await failCleared($, 'sandbox')
  const drawnMs = Date.now() - t0
  await saveState($, id, version, r.state)
  if (meta.version > 0) void $.process.run(['rm', '-rf', '--', await versionDir($, id, meta.version)]).catch(() => undefined)

  const out: string[] = [
    ...(borrowed ? [`Card "${borrowed.id}" is ${borrowed.anchorRow ? 'a card under another answer' : "the main conversation's card"}, so this call did not change it: it drew a new card of your own from that card's view and rows.`] : []),
    stays
      ? `Version ${version} of “${title}” is drawn in place of version ${meta.version}, ${next.anchorRow ? placeWords(next.anchorRow) : 'under the call that first drew the card'}.`
      : meta.version > 0
        ? `Version ${version} of “${title}” is drawn where this call stands, since the terminal cannot draw the earlier place again; the earlier call shows one line that points here.`
        : `“${title}” is drawn ${next.anchorRow ? placeWords(next.anchorRow) : 'where this call stands, above the words you write after it'}. Its id is "${id}".`,
    `It read ${r.summary.read} from ${baseName(file)}${r.summary.columns.length ? `, with the columns ${r.summary.columns.join(', ')}` : ''}.`,
  ]
  if (r.summary.other) out.push(`The file is an object: props.data is the whole object, with ${(r.summary.other as string[]).join(', ')}, and props.rows its "rows" list${r.summary.hasRows ? '' : ' (it has none, so props.rows is empty)'}.`)
  if (r.summary.first) out.push(`The first row: ${r.summary.first}`)
  for (const note of (r.notes ?? []) as string[]) out.push(`Note: ${note}.`)
  const own = asked.filter(k => ownKeys().includes(k))
  if (own.length) out.push(`Note on the view: ${own.join(' ')} ${own.length > 1 ? 'are' : 'is'} thimble's own, so the card does not get ${own.length > 1 ? 'them' : 'it'}; give the card other keys. The analyst has not seen ${own.length > 1 ? 'these keys' : 'this key'} on the card.`)
  const other = asked.filter(k => !/^\p{L}$/u.test(k))
  if (other.length) out.push(`Note on the view: a card takes letters only, so it does not get ${other.join(' ')}. The analyst has not seen ${other.length > 1 ? 'these keys' : 'this key'} on the card.`)
  out.push('', `What it draws, ${width} columns wide:`, ...copyText(r.lines, r.cut, width))
  out.push(...besidePane(r.beside, width))

  let tallest = r.lines.length
  const actions = Array.isArray(input.actions) ? input.actions : []
  if (actions.length) {
    const a = await askCard($, next, 'act', { actions, width })
    if (a?.ok) {
      for (const c of a.copies as Any[]) {
        if (c.error) out.push('', `After ${c.what}, the view FAILED: ${c.error}`)
        else out.push('', `After ${c.what}${c.note ? ` (${c.note})` : ''}:`, ...copyText(c.lines, c.cut, width))
      }
      out.push('', 'The card is back as it was before these actions.')
      await applyAnswer($, next, a, width)
      for (const c of a.copies as Any[]) if (!c.error) tallest = Math.max(tallest, c.lines.length)
    } else out.push('', `The actions did not run: ${a?.error ?? 'no answer'}`)
  }
  const screen = screenRows()
  if (screen && tallest + AROUND_ROWS > screen) out.push('', `Note: the card is up to ${tallest} rows tall, and the analyst's screen has ${screen} rows, which also hold its frame, the prompt and the bar, so they never see its top and bottom together.`)
  void record($, { kind: 'card', feature: forkOf(input.agentId)?.kind ?? 'main', card: id, version, rows: r.summary.rows, actions: actions.length, drawn_ms: drawnMs, ms: Date.now() - t0 })
  return { result: out.join('\n') }
}

/**
 * A version of a card that the person's action makes, not a call of Claude's: a squeeze's version of one of the answer's
 * cards, or a card it adds (squeeze/cards.ts). The view runs over a copy of the rows file `rows`, in the runner as a
 * call's does, and draws in the card's place; a new card (`id` not drawn yet) draws under the answer `anchorRow`, as
 * v's do. Answers the version drawn, or why it did not draw (the version on screen stays).
 */
export async function personVersion($: Engine, o: { id: string; title: string; view: string; rows: string; anchorRow?: string | null }): Promise<{ version: number; error?: undefined } | { error: string }> {
  if (!isCardId(o.id)) return { error: `"${oneLine(o.id, 40)}" is no card's id` }
  const before = await metaOf($, o.id)
  if (!before && !o.anchorRow) return { error: `there is no card ${o.id}` }
  const meta: CardMeta = before ?? {
    id: o.id, version: 0, last: 0, lastFile: '', title: o.title, toolUseId: '', agentId: null, anchorRow: o.anchorRow ?? null,
    keys: [], read: '', columns: [], file: '', gen: 0, error: null, errorWidth: null, calls: {}, at: Date.now(),
  }
  const title = oneLine(o.title, 120) || meta.title
  const version = Math.max(meta.version, meta.last ?? 0) + 1
  const dir = await versionDir($, o.id, version)
  await $.fs.write(`${dir}/view.js`, o.view)
  const copied = await $.process.run(['cp', '--', o.rows, `${dir}/rows.json`])
  if (copied.exitCode !== 0) return { error: `thimble could not copy the rows (${String(copied.stderr).trim().slice(0, 200)})` }
  const width = (await treeOf($, o.id))?.width ?? cardWidth()
  const r = await ask($, 'load', { id: o.id, version, title, view: o.view, rows: `${dir}/rows.json`, state: null, width })
  if (!r?.ok) {
    void $.process.run(['rm', '-rf', '--', dir]).catch(() => undefined)
    if (r?.down) sandboxNotice($, `Cards cannot draw: ${String(r.error).slice(0, 600)}`, !!r.machine)
    return { error: String(r?.error || 'no answer').slice(0, 400) }
  }
  const keys = [...new Set([...String(r.keys || '')])].filter(k => /^\p{L}$/u.test(k) && !ownKeys().includes(k))
  const next: CardMeta = {
    ...meta, version, last: version, title, keys, read: String(r.summary.read), columns: r.summary.columns,
    gen: meta.gen + 1, error: null, errorWidth: null, at: Date.now(),
  }
  await saveMeta($, next)
  await setTree($, o.id, { gen: next.gen, width, tree: r.tree, seq: Number(r.seq) || 0 })
  await saveState($, o.id, version, r.state)
  await failCleared($, `card:${o.id}`)
  if (meta.version > 0) void $.process.run(['rm', '-rf', '--', await versionDir($, o.id, meta.version)]).catch(() => undefined)
  return { version }
}
