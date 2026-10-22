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
//      the designer fork called
//   4. tries the call's actions, keys and clicks in order, then puts the card back as it was
//   5. answers what the card read (rows, columns, the first row), the text copy at the card's width, and the copy after
//      each action
//
// So Claude learns what its card shows without printing the rows itself. A call with `id` draws a new version of that
// card where this call stands, and the earlier call shows one line that points to it, so the card the reply talks
// about is always the one right above it; a version that fails leaves the one on screen, and the view's error goes back
// to Claude.
import type { EngineInterface } from 'claude-code'

import { failCleared, failNotice } from '../bar/fix'
import { startDir } from '../core/env'
import { forkOf } from '../core/forks'
import { tempDir } from '../core/home'
import { designAnchor } from '../designer/v'
import { OWN_KEYS } from '../hooks/keys'
import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
import { record } from '../telemetry/telemetry'
import { ask } from './ask'
import { applyAnswer, askCard, cardWidth, screenRows } from './draw'
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
  required: ['title', 'data', 'view'],
  properties: {
    title: { type: 'string', description: 'the card\'s title: what it shows, in a few words' },
    data: { type: 'string', description: 'the path of the JSON file of rows you wrote, in this folder or in $TMPDIR (a path may start with $TMPDIR/)' },
    view: { type: 'string', description: 'JavaScript that defines function view(props, surface)' },
    id: { type: 'string', description: 'the id of a card you drew, to draw a new version of it here; leave it out for a new card' },
    actions: {
      type: 'array',
      description: 'keys and clicks to try in order; each returns a text copy, then the card goes back',
      items: { type: 'object', properties: { key: { type: 'string' }, click: { description: 'the words on a Button, or [x, y] in cells', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] } } },
    },
  },
}

/** The tool, as the model reads it: card-tool.md with the temp folder and thimble's own keys filled in. */
export async function registerCardTool($: Engine): Promise<void> {
  const text = await promptText($, 'card-tool')
  const kept = `${OWN_KEYS.slice(0, -1).join(', ')} or ${OWN_KEYS[OWN_KEYS.length - 1]}`
  await $.tool.register({ name: 'card', isDeferred: false, description: fill(text, { TMPDIR: await tempDir($), KEPT: kept }).trim(), inputSchema: SCHEMA })
}

/** Why the person's permission rules refuse this call, or null (step 0 above). */
async function refused($: Engine, input: Record<string, unknown>, file: string): Promise<string | null> {
  const says = (v: { decision: string; reason?: string; rule?: string }) => v.decision === 'deny' || (v.decision === 'ask' && !!v.rule)
  const card = await $.tool.check({ tool: 'mcp__thimble__card', input })
  if (says(card)) return card.reason || `the permission rule ${card.rule ?? ''} refuses the card tool`.replace('  ', ' ')
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

const baseName = (p: string) => String(p).split('/').filter(Boolean).pop() ?? String(p)
const oneLine = (s: string, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim(); return [...t].length > n ? `${[...t].slice(0, n - 1).join('')}…` : t }

/** A text copy for Claude: at most COPY_LINES lines, and a note on the lines cut at the card's width. */
function copyText(lines: string[], cut: number[], width: number): string[] {
  const out = lines.slice(0, COPY_LINES)
  if (lines.length > COPY_LINES) out.push(`(${lines.length - COPY_LINES} more lines)`)
  if (cut.length) out.push(`(line${cut.length > 1 ? 's' : ''} ${cut.slice(0, 8).join(', ')} ${cut.length > 1 ? 'are' : 'is'} wider than the card's ${width} columns and cut there)`)
  return out
}

/** What a call answers when the version did not draw: what to fix, or, when the runner cannot start, that the card is
 *  not the cause (the person sees why in the failure line). */
function failed(id: string, r: Any, update: boolean): string {
  const error = String(r?.error || 'no answer').slice(0, 800)
  if (r?.down) return `The card did not draw: ${error}. The view is not the cause, and cards cannot draw in this session until the analyst fixes it; answer in words.`
  const fix = r?.phase === 'rows' ? 'Fix the data file' : 'Fix the view'
  const kept = update ? ' The version on screen stays.' : ''
  return `The card did not draw: ${error}.${kept}\n${fix} and call card again with id "${id}".`
}

/** One call of the card tool. Its line in the session's events (telemetry) says how long the call took to draw the
 *  card: `drawn_ms` from the call to the drawing in place, `ms` to the answer with its actions. */
export async function cardCall($: Engine, e: Any): Promise<{ result: string }> {
  const t0 = Date.now()
  const input = e ?? {}
  const toolUseId = String(input.tool_use_id ?? '')
  const title = oneLine(String(input.title ?? ''), 120) || 'Card'
  const view = String(input.view ?? '')
  const given = String(input.id ?? '').trim()
  const update = !!given
  const id = update ? given : cardIdOf(toolUseId)
  const before = isCardId(id) ? await metaOf($, id) : null
  if (update && !before) return { result: `There is no card "${oneLine(given, 40)}" to replace. Leave out \`id\` to draw a new card.` }

  // a card stands at a call of main's, or under the answer the running designer fork draws for; another agent's call
  // stands in that agent's own transcript, where the person never sees a card
  const fork = forkOf(input.agentId)
  const anchorRow = fork?.kind === 'designer' ? await designAnchor($, input.agentId) : null
  if (input.agentId && !anchorRow) return { result: 'The card did not draw: only the main conversation and the copy that v starts draw cards, since a card stands at its call and the analyst sees only those calls. Give the rows and the view to the main conversation instead.' }
  const meta: CardMeta = before ?? {
    id, version: 0, title, toolUseId, agentId: input.agentId ? String(input.agentId) : null, anchorRow,
    keys: [], rows: 0, columns: [], file: '', gen: 0, error: null, calls: {}, at: Date.now(),
  }
  const remember = (m: CardMeta, call: CardCall) => saveMeta($, { ...m, calls: { ...m.calls, [toolUseId]: call } })

  const data = await dataFile($, input.data)
  if (data.bad) {
    await remember(meta, { version: meta.version, error: data.bad })
    return { result: `The card did not draw: ${data.bad}.` }
  }
  const no = await refused($, { title: input.title, data: input.data, view: input.view, ...(input.id ? { id: input.id } : {}) }, data.path!)
  if (no) {
    await remember(meta, { version: meta.version, error: no })
    return { result: `The card did not draw: ${no}.` }
  }
  const version = meta.version + 1
  const dir = await versionDir($, id, version)
  await $.fs.write(`${dir}/view.js`, view)
  const copied = await $.process.run(['cp', '--', data.path!, `${dir}/rows.json`])
  if (copied.exitCode !== 0) {
    const error = `thimble could not copy ${input.data} (${String(copied.stderr).trim().slice(0, 200)})`
    await remember(meta, { version: meta.version, error })
    return { result: `The card did not draw: ${error}.` }
  }

  const width = (await treeOf($, id))?.width ?? cardWidth()
  const r = await ask($, 'load', { id, version, title, view, rows: `${dir}/rows.json`, state: null, width })
  if (!r?.ok) {
    await $.process.run(['rm', '-rf', '--', dir])
    await remember(meta, { version: meta.version, error: String(r?.error || 'no answer') })
    if (r?.down) failNotice($, `Cards cannot draw: ${String(r.error).slice(0, 200)}`)
    return { result: failed(id, r, update && meta.version > 0) }
  }

  const asked = [...new Set([...String(r.keys || '')].filter(k => !/\s/.test(k)))]
  const keys = asked.filter(k => /^\p{L}$/u.test(k) && !OWN_KEYS.includes(k))
  // a card draws under the call of main's that drew this version, or under the answer v was pressed on when the
  // designer fork drew it
  const next: CardMeta = {
    ...meta, version, title, keys, rows: r.summary.rows, columns: r.summary.columns, file: String(input.data),
    gen: meta.gen + 1, error: null, at: Date.now(), agentId: input.agentId ? String(input.agentId) : null,
    anchorRow,
    toolUseId: fork?.kind === 'designer' ? meta.toolUseId : toolUseId,
  }
  await remember(next, { version, title, file: String(input.data), rows: next.rows })
  await setTree($, id, { gen: next.gen, width, tree: r.tree, seq: Number(r.seq) || 0 })
  await setFocus($, id)
  await failCleared($, `card:${id}`)
  const drawnMs = Date.now() - t0
  await saveState($, id, version, r.state)
  if (meta.version > 0) void $.process.run(['rm', '-rf', '--', await versionDir($, id, meta.version)]).catch(() => undefined)

  const where = next.anchorRow ? 'under the answer v was pressed on' : 'where this call stands, above the words you write after it'
  const out: string[] = [
    update && meta.version > 0
      ? `Version ${version} of “${title}” is drawn ${where}${next.anchorRow ? '' : '; the earlier call shows one line that points here'}.`
      : `“${title}” is drawn ${where}. Its id is "${id}": to change it, call card again with this id.`,
    `It read ${r.summary.rows} row${r.summary.rows === 1 ? '' : 's'} from ${baseName(String(input.data))}${r.summary.columns.length ? `, with the columns ${r.summary.columns.join(', ')}` : ''}.`,
  ]
  if (r.summary.other) out.push(`The file is an object: props.data is the whole object, with ${(r.summary.other as string[]).join(', ')}, and props.rows its "rows" list${r.summary.hasRows ? '' : ' (it has none, so props.rows is empty)'}.`)
  if (r.summary.first) out.push(`The first row: ${r.summary.first}`)
  for (const note of (r.notes ?? []) as string[]) out.push(`Note: ${note}.`)
  const own = asked.filter(k => OWN_KEYS.includes(k))
  if (own.length) out.push(`Note on the view: ${own.join(' ')} ${own.length > 1 ? 'are' : 'is'} thimble's own, so the card does not get ${own.length > 1 ? 'them' : 'it'}; give the card other keys. The analyst has not seen ${own.length > 1 ? 'these keys' : 'this key'} on the card.`)
  const other = asked.filter(k => !/^\p{L}$/u.test(k))
  if (other.length) out.push(`Note on the view: a card takes letters only, so it does not get ${other.join(' ')}. The analyst has not seen ${other.length > 1 ? 'these keys' : 'this key'} on the card.`)
  out.push('', `What it draws, ${width} columns wide:`, ...copyText(r.lines, r.cut, width))

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
  void record($, { kind: 'card', feature: forkOf(input.agentId)?.kind ?? 'main', card: id, version, rows: next.rows, actions: actions.length, drawn_ms: drawnMs, ms: Date.now() - t0 })
  return { result: out.join('\n') }
}
