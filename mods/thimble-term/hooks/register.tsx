// thimble-term: thimble's terminal-mode renderer. The `thimble` command loads this plugin in terminal mode only
// (`thimble mode terminal`), so browser mode loads nothing new. It registers no model tools, agents, guidance or
// commands, and keeps no data except what is on screen: what it draws comes from `thimble state`, and every change it
// makes goes through `thimble act` (hooks/data.ts). What main's chat drew under its rows is kept in the workspace's
// terminal/chat.json for a resumed session (hooks/kept.ts). Its scope check: THIMBLE_WS names a workspace whose
// trusted/launch.json has `mode: "terminal"`; anywhere else every hook passes through.
//
// What it draws (its look is SPEC.md's "The visual system"):
//   - main's replies on the mod's grid, each citation a link, red when its place does not hold its value (reply.tsx)
//   - each card a turn of main added or changed, once, under the turn's last reply, in its last state, its takeaway
//     under it; no hex id, and Claude Code's tool groups left folded
//   - one row above the prompt, a toast: what is new in the workspace since home was last opened (`open ›` opens home
//     and the row goes); Claude Code's agent tray shows thimble's agents, and side threads have `↳` rows
//   - one panel (panel.tsx): home, a card, a citation's place, the threads, a label, a document, the files, an agent
//   - side threads: the blue "?" beside a passage or a card, or a selection's "ask"; a `↳ thread` row under main's
//     latest row when an answer comes in while the panel shows something else, and a blue ↳ beside the passage asked
//     about. A right-click does what a click does: there is no menu
//   - `/thimble` opens the home panel, with no model turn
// It hides main's end token, `(shown in the dashboard)`, as the browser does.
//
// `$` stays in this file (Claude Code follows it into no import): each hook builds the context the other files take
// (cxOf, hooks/ctx.ts).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, ResolveInput } from 'claude-code'

import type { Ctx } from './ctx'
import { act, scopeOf } from './data'
import type { Sent } from './gestures'
import { chipState, claimsIn, streamLink, streamStep, streaming } from './cite'
import type { StreamLook, Streaming } from './cite'
import type { CardData } from './draw'
import { bareCard, cardWords, cid, citeSpans, citations, clip, cut, embeddedCards, labelRef, needsDrawing, quoted } from './lib'
import { cardsOfCall, docsOf, forkDescription, labelsOf, namedForks, namedThreads, noteLines, reportOf, runIds, runShown, saysWriter, threadOf, withoutEnd, withoutLines, withoutNotes, withoutToldThreads, withoutWriterLines } from './model'
import { HOME_UI_EMPTY } from './home'
import { keepLast, keepRow, loadKept, resetKept } from './kept'
import { linesMessage, onListClick } from './lines'
import { ANSWER_ELEMENT, RELAY, docEditMessage, drawPanel, fieldMessage, focusedField, hasList, homeViews, onGesture, openAsk, openCard, openCite, openFile, openHomeNew, openLabel, openThread, openView, relayKey, relayMove, scrollPending, viewWheelAt, wheelWindow } from './panel'
import type { PaneEvent } from './panel'
// the file browser and a file, drawn by a module of their own (panel.tsx drawsView, term.ts loadsView)
import './filesview'
import { MARGIN, chipOf, drawCards, drawReply, placeUrl, toolWords } from './reply'
import { COLORS } from './paint'
import { isAnchor, signalEnd, signalQuestion } from './signal'
import type { AppendedRow } from './signal'
import { NAV_EMPTY } from './nav'
import { FILES_UI_EMPTY, LABEL_UI_EMPTY, PANEL, checkQueued, closePanel, loadCards, loadCardsBatch, navOrigin, openHome, openPanel, openPending, paneTitle, panelColumns, placedLater, readSurface, readThread, retryPending, rt, surfaceValue, takeKeys, threadsNow, tick } from './term'
import type { UiApply } from './term'
import { turns } from './turns'
import { PUMP_MS, closeView, openViewState, sendEvent, viewFault, viewMessage, viewPump } from './viewhost'

type Dollar = EngineInterface

/** /thimble's description and argument hint in terminal mode (the command.describe hook). */
export const THIMBLE_DESCRIPTION =
  "Opens thimble's home panel in this terminal: documents, side threads, cards, labels and files. `/thimble threads`, `cite <n>`, `card <n>`, `files [path[:line]]` and `documents` open those."
export const THIMBLE_ARGS = '[threads | cite <n> | card <n> | files [path[:line]] | documents]'
/** What `/thimble` says in terminal mode: the home panel is open, and how to reach the browser instead. */
export const HOME_LINE = 'thimble: terminal mode. The home panel is open. For the browser workspace, quit, run `thimble mode browser`, and start `thimble` again.'

// the text Claude Code stores as the reply of a turn that ended with none (its `<synthetic>` model's)
const SYNTHETIC_RE = /^\s*No response requested\.\s*$/
const THIMBLE_TOOL = /^mcp__plugin_thimble_thimble__/
const CARD_TOOL = /^mcp__plugin_thimble_thimble__(add_card|edit_card|apply_label)$/
const VIEW_TOOL = /^mcp__plugin_thimble_thimble__propose_view$/

/** The text of a tool's result as the transcript holds it: a string, or content blocks. */
function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  const blocks = Array.isArray(output) ? output : (output as { content?: unknown } | undefined)?.content
  return Array.isArray(blocks) ? blocks.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : ''
}
const ABOVE_LABEL = 12
const paneTurns = turns()

// the state the drawings read (types/index.d.ts)
const CARDS = { plugin: 'thimble-term', key: 'cards' } as const
const TURN_CARDS = { plugin: 'thimble-term', key: 'turnCards' } as const
const VERDICTS = { plugin: 'thimble-term', key: 'verdicts' } as const
const THREAD = { plugin: 'thimble-term', key: 'thread' } as const
const THREAD_ROWS = { plugin: 'thimble-term', key: 'threadRows' } as const
const ANSWERS = { plugin: 'thimble-term', key: 'answers' } as const
const VIEW_ROWS = { plugin: 'thimble-term', key: 'viewRows' } as const
const SURFACE = { plugin: 'thimble-term', key: 'surface' } as const
const panelA = { plugin: 'thimble-term', key: 'panel' } as const
const navRef = { plugin: 'thimble-term', key: 'nav' } as const
const pendingRef = { plugin: 'thimble-term', key: 'pending' } as const
const homeRef = { plugin: 'thimble-term', key: 'home' } as const
const homeSeenRef = { plugin: 'thimble-term', key: 'homeSeen' } as const
const agentsRef = { plugin: 'thimble-term', key: 'agents' } as const
const threadsRef = { plugin: 'thimble-term', key: 'threads' } as const
const newsRef = { plugin: 'thimble-term', key: 'threadNews' } as const
const homeUiRef = { plugin: 'thimble-term', key: 'homeUi' } as const
const labelUiRef = { plugin: 'thimble-term', key: 'labelUi' } as const
const filesUiRef = { plugin: 'thimble-term', key: 'filesUi' } as const
const panelTickRef = { plugin: 'thimble-term', key: 'panelTick' } as const
const panelTickA = atom(panelTickRef, 0)

/** The context the other files take, bound to this hook's `$`. */
function cxOf($: Dollar): Ctx {
  // what main's chat draws under a row is kept in the workspace too, so a resumed session draws it again (kept.ts)
  const io = { read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text) }
  const keep = async (row: string, part: Parameters<typeof keepRow>[3]) => (rt.sc ? keepRow(io, rt.sc.ws, row, part) : undefined)
  return {
    now: () => $.clock.now().catch(() => Date.now()),
    theme: async () => {
      try {
        const v = (await $.config.list()).find(r => r.key === 'theme')?.value
        return /light/i.test(String(v ?? '')) ? 'light' : 'dark'
      } catch {
        return 'dark'
      }
    },
    run: (argv, init) => $.process.run(argv, init),
    runLong: async (argv, init) => {
      const child = $.process.spawn({ argv, ...(init?.cwd ? { cwd: init.cwd } : {}), ...(init?.env ? { env: init.env } : {}) })
      let stdout = ''
      let stderr = ''
      for await (const piece of child) {
        if (piece.stream === 'stdout') stdout += piece.text
        else stderr += piece.text
      }
      const end = await child.result
      return { exitCode: end.code ?? 1, stdout, stderr }
    },
    spawnLines: (argv, init, onLine, onErr) => {
      const child = $.process.spawn({ argv, ...(init.cwd ? { cwd: init.cwd } : {}), ...(init.env ? { env: init.env } : {}) })
      const done = (async () => {
        let buf = ''
        try {
          for await (const piece of child) {
            if (piece.stream !== 'stdout') {
              onErr?.(piece.text.slice(-500))
              continue
            }
            buf += piece.text
            let i = buf.indexOf('\n')
            while (i >= 0) {
              onLine(buf.slice(0, i))
              buf = buf.slice(i + 1)
              i = buf.indexOf('\n')
            }
          }
        } catch (err) {
          onErr?.(String(err).slice(0, 300))
        }
      })()
      return { stop: () => void child.return(undefined as never).catch(() => undefined), done }
    },
    fetch: (url, init) => $.http.fetch(url, init),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    stat: path => $.fs.stat(path),
    list: path => $.fs.list(path),
    // each variable by its literal name, so `claude plugin validate` lists what the module reads
    env: async name => {
      switch (name) {
        case 'THIMBLE_WS':
          return $.env.get('THIMBLE_WS')
        case 'THIMBLE_TERM_CLI':
          return $.env.get('THIMBLE_TERM_CLI')
        case 'THIMBLE_HOME':
          return $.env.get('THIMBLE_HOME')
        case 'THIMBLE_PORT':
          return $.env.get('THIMBLE_PORT')
        case 'THIMBLE_UI_PORT':
          return $.env.get('THIMBLE_UI_PORT')
        default:
          return undefined
      }
    },
    root: () => $.session.root().catch(() => $.session.cwd()),
    pluginRoot: $.plugin.root,
    open: args => $.ui.open(args),
    close: id => $.ui.close({ id }),
    panes: () => $.ui.panes().catch(() => []),
    later: (ms, fn) => void $.clock.after(ms, fn),
    log: text => $.ui.log(text),
    toast: text => $.ui.toast(text),
    submit: async text => {
      rt.own.add(text)
      await $.prompt.submit({ text, asUser: true })
    },
    command: async (name, args) => void (await $.command.run({ command: name, args })),
    promptText: async () => (await $.prompt.read().catch(() => ({ text: '' }))).text,
    fill: async text => void (await $.prompt.fill({ text, mode: 'insert' }).catch(() => undefined)),
    focus: async key => {
      const r = await $.ui.focus({ requestId: PANEL, key }).catch(() => ({ deny: 'failed' }))
      return !r.deny
    },
    scroll: async (key, block) => void (await $.ui.scroll({ to: { key }, in: PANEL, block: block ?? 'nearest' }).catch(() => undefined)),
    els: e => $.ui.resolve(e as ResolveInput<'Pane', 'terminal'>),
    card: async id => (await $.state.get({ ...CARDS, id })).value,
    setCard: async (id, v) => void (await $.state.set({ ...CARDS, id }, v)),
    turnCards: async row => (await $.state.get({ ...TURN_CARDS, id: row })).value ?? [],
    setTurnCards: async (row, ids) => {
      await $.state.set({ ...TURN_CARDS, id: row }, ids)
      await keep(row, { cards: ids })
    },
    verdict: async id => (await $.state.get({ ...VERDICTS, id })).value,
    setVerdict: async (id, v) => void (await $.state.set({ ...VERDICTS, id }, v)),
    thread: async id => (await $.state.get({ ...THREAD, id })).value,
    setThread: async (id, v) => void (await $.state.set({ ...THREAD, id }, v)),
    threadRows: async row => (await $.state.get({ ...THREAD_ROWS, id: row })).value ?? [],
    setThreadRows: async (row, rows) => {
      await $.state.set({ ...THREAD_ROWS, id: row }, rows)
      await keep(row, { threads: rows })
    },
    answer: async row => (await $.state.get({ ...ANSWERS, id: row })).value,
    setAnswer: async (row, a) => {
      await $.state.set({ ...ANSWERS, id: row }, a)
      await keep(row, { answer: a })
    },
    viewRows: async row => (await $.state.get({ ...VIEW_ROWS, id: row })).value ?? [],
    setViewRows: async (row, slugs) => {
      await $.state.set({ ...VIEW_ROWS, id: row }, slugs)
      await keep(row, { views: slugs })
    },
    surface: async key => (await $.state.get({ ...SURFACE, id: key })).value as never,
    setSurface: async (key, v) => void (await $.state.set({ ...SURFACE, id: key }, v)),
    panel: async () => (await $.state.get(panelA)).value ?? null,
    setPanel: async p => void (await $.state.set(panelA, p)),
    nav: async () => (await $.state.get(navRef)).value ?? NAV_EMPTY,
    setNav: async n => void (await $.state.set(navRef, n)),
    pending: async () => (await $.state.get(pendingRef)).value ?? null,
    setPending: async p => void (await $.state.set(pendingRef, p)),
    home: async () => (await $.state.get(homeRef)).value ?? null,
    setHome: async h => void (await $.state.set(homeRef, h)),
    homeSeen: async () => (await $.state.get(homeSeenRef)).value ?? null,
    setHomeSeen: async h => void (await $.state.set(homeSeenRef, h)),
    agents: async () => (await $.state.get(agentsRef)).value ?? [],
    setAgents: async a => void (await $.state.set(agentsRef, a)),
    threads: async () => (await $.state.get(threadsRef)).value ?? [],
    setThreads: async t => void (await $.state.set(threadsRef, t)),
    news: async () => (await $.state.get(newsRef)).value ?? { n: 0, one: '' },
    setNews: async n => void (await $.state.set(newsRef, n)),
    homeUi: async () => ({ ...HOME_UI_EMPTY, ...((await $.state.get(homeUiRef)).value ?? {}) }),
    setHomeUi: async u => void (await $.state.set(homeUiRef, u)),
    labelUi: async () => ({ ...LABEL_UI_EMPTY, ...((await $.state.get(labelUiRef)).value ?? {}) }),
    setLabelUi: async u => void (await $.state.set(labelUiRef, u)),
    filesUi: async () => ({ ...FILES_UI_EMPTY, ...((await $.state.get(filesUiRef)).value ?? {}) }),
    setFilesUi: async u => void (await $.state.set(filesUiRef, u)),
    panelTick: async () => (await $.state.get(panelTickRef)).value ?? 0,
    bumpPanel: async () => void (await update($, panelTickA, n => (n ?? 0) + 1)),
  }
}

/** A ui.jsonl record a tool wrote for the renderer (set_layout, open_view, set_filter, show_label): the panel shows the
 *  surface it names. */
const applyUi: UiApply = async (cx, kind, args) => {
  const surfaces = Array.isArray(args.surfaces) ? args.surfaces.map(String) : typeof args.surface === 'string' ? [args.surface] : []
  const view = String(args.view ?? args.slug ?? '')
  if (kind === 'open_view' || (kind === 'layout' && surfaces.some(s => s.startsWith('view:')))) {
    const slug = view || (surfaces.find(s => s.startsWith('view:')) ?? '').slice(5)
    if (slug) await openPanel(cx, { view: 'view', title: String(args.name ?? slug), slug })
    return
  }
  if (kind === 'layout') {
    const first = surfaces.find(s => s !== 'canvas') ?? surfaces[0] ?? ''
    if (first === 'files') await openPanel(cx, { view: 'files', title: 'Files' })
    else if (first === 'report') await openPanel(cx, { view: 'docs', title: 'Documents' })
    else if (first) await openHome(cx)
    return
  }
  const p = await cx.panel()
  if ((kind === 'filter' || kind === 'label') && p?.view.startsWith('file')) await openPanel(cx, p)
}

/** `/thimble <what>` in terminal mode, a keyboard way to what the chat and the panel draw: `threads`, `cite [n]` (the
 *  n-th citation of the last reply), `card [n|id]` (the n-th card of the last turn, or a card by its id), `files
 *  [path[:line]]`, `documents`. What it says, or null for plain `/thimble` (home). */
async function thimbleCommand(cx: Ctx, args: string): Promise<string | null> {
  const [what = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ')
  const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`
  switch (what.toLowerCase()) {
    case '':
      return null
    case 'threads': {
      await openPanel(cx, { view: 'threads', title: 'Threads' })
      return `thimble: ${plural((await cx.threads()).length, 'side thread')}`
    }
    case 'documents':
    case 'docs':
    case 'reports': {
      await readSurface(cx, 'docs', 'docs')
      const got = await surfaceValue(cx, 'docs')
      await openPanel(cx, { view: 'docs', title: 'Documents' })
      return `thimble: ${plural(got?.ok ? docsOf(got.value).length : 0, 'document')}`
    }
    case 'cite': {
      const cs = citations(rt.lastReply)
      const n = Number(arg)
      if (!cs.length) return 'thimble: the last reply cites nothing'
      if (!Number.isInteger(n) || n < 1 || n > cs.length) return `thimble: the last reply has ${plural(cs.length, 'citation')}: \`/thimble cite <1-${cs.length}>\` opens one`
      const c = cs[n - 1]!
      await openCite(cx, c.ref, c.display)
      return `thimble: citation ${n} of ${cs.length}`
    }
    case 'card': {
      const ids = rt.lastCards
      const n = Number(arg)
      if (arg && !Number.isInteger(n)) {
        const id = arg.replace(/^(?:card|cell):/, '')
        await loadCards(cx, [id])
        if (!(await cx.card(id))?.data) return 'thimble: no such card in this workspace'
        await openCard(cx, id)
        return 'thimble: the card is open'
      }
      if (!ids.length) return 'thimble: the last turn made no card'
      if (!Number.isInteger(n) || n < 1 || n > ids.length) return `thimble: the last turn has ${plural(ids.length, 'card')}: \`/thimble card <1-${ids.length}>\` opens one`
      await openCard(cx, ids[n - 1]!)
      return `thimble: card ${n} of ${ids.length}`
    }
    case 'files': {
      if (!arg) {
        await openPanel(cx, { view: 'files', title: 'Files' })
        return 'thimble: the file browser is open'
      }
      const m = /^(.*?)(?::(\d+))?$/.exec(arg)
      const path = (m?.[1] ?? arg).replace(/^\.\//, '')
      const line = m?.[2] ? Number(m[2]) : undefined
      await openFile(cx, path, line ? Math.max(1, line - 5) : 1, line)
      return `thimble: ${path}${line ? ` line ${line}` : ''} is open`
    }
    default:
      return `thimble: \`/thimble\` opens home; \`/thimble threads\`, \`cite [n]\`, \`card [n]\`, \`files [path[:line]]\` and \`documents\` open those`
  }
}

// a text block as Claude Code was handed it while it streamed -> as the model wrote it
const asWritten = new Map<string, string>()

/** The part of a turn that is its answer: the last that cites or embeds a card, else the last with text. Earlier parts
 *  are what main wrote while it worked ("Reading the files…"). */
function answerPart(parts: { uuid: string; text: string }[][]): { uuid: string; text: string }[] | undefined {
  const full = parts.filter(p => p.some(r => r.text.trim()))
  return [...full].reverse().find(p => needsDrawing(p.map(r => r.text).join('\n\n'))) ?? full.at(-1)
}

function hasText(content: unknown): boolean {
  return Array.isArray(content) && content.some(b => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && String((b as { text?: unknown }).text ?? '').trim() !== '')
}

/** The rows a side thread's answer leaves under a row of main's chat (signal.ts, SPEC.md "Main's chat"), one
 *  blank row above the first: `↳` at column 0 and its words at 2, dim (`thread · "<the turn's question>" · answered`,
 *  `failed` in red), `new` in green until it is read; a press on the question opens the thread. Each turn once. */
async function signalRows(cx: Ctx, e: ResolveInput & { requestId: string; viewport?: { columns: number } }): Promise<RenderElement | null> {
  const rows = await cx.threadRows(e.requestId)
  if (!rows.length) return null
  const { Box, Text, Button } = cx.els(e)
  const threads = await cx.threads()
  const seen = new Set<string>()
  const out: RenderElement[] = []
  const n = Math.max(16, Math.min(60, (e.viewport?.columns ?? 100) - 30))
  for (const s of rows) {
    const k = `${s.thread}:${s.turn}`
    if (seen.has(k)) continue
    seen.add(k)
    const row = threads.find(x => x.id === s.thread)
    const tt = await cx.thread(s.thread)
    const th = tt?.events.length ? threadOf(tt.meta, tt.events) : null
    const label = row?.anchorText || (row?.anchor ? await anchorName(cx, row.anchor) : '') || row?.title || 'the side thread'
    const q = th ? signalQuestion({ turns: th.turns, label }, s.turn, n) : quoted(clip(row?.question || row?.title || label, n))
    const end = th ? signalEnd(th, s.turn) ?? 'answered' : 'answered'
    // `new` while the thread holds an answer the analyst has not opened (thimble's `unread`), on its latest answer's row
    const latest = th ? th.turns.map((x, i) => (x.state === 'done' ? i + 1 : 0)).reduce((a, b) => Math.max(a, b), 0) : s.turn
    const fresh = Boolean(row?.unread) && s.turn >= latest
    out.push(
      <Box key={`signal-${k}`} flexDirection="row" {...(out.length ? {} : { marginTop: 1 })}>
        <Text dimColor>{'↳ '}</Text>
        <Text dimColor>{'thread · '}</Text>
        <Button key={`signal-open-${s.thread}`} label={q} plain dimColor onPress={() => openThread(cx, s.thread)} />
        {end === 'failed' ? <Text color={COLORS.problem}>{' · failed'}</Text> : <Text dimColor>{' · answered'}</Text>}
        {fresh && end !== 'failed' ? <Text color={COLORS.fresh}>{' · new'}</Text> : null}
      </Box>,
    )
  }
  return <Box flexDirection="column">{out}</Box>
}

/** What a thread's anchor names, in words: a card by its question, a citation's place in words. */
async function anchorName(cx: Ctx, anchor: string): Promise<string> {
  const id = /^(?:card|cell):([A-Za-z0-9_-]+)/.exec(anchor)?.[1]
  if (id) {
    const q = ((await cx.card(id))?.data as CardData | null | undefined)?.question
    return q ? cardWords(q) : 'a card'
  }
  return anchor
}

/** An Agent call's stored result with a thread's fork named by the thread's first question where its `prompt` or
 *  `description` names the fork's slug (`thread:<slug>`, what ctrl+o shows under `Prompt:`); the result itself when it
 *  names none. */
function forkOutput(output: unknown, threads: Parameters<typeof namedForks>[1]): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  const o = output as Record<string, unknown>
  const named = (v: unknown) => (typeof v === 'string' && /\bthread:/.test(v) ? namedForks(v, threads) : v)
  const prompt = named(o.prompt)
  const description = named(o.description)
  return prompt === o.prompt && description === o.description ? output : { ...o, prompt, description }
}

/** A Bash command that runs `thimble-run`, as its row shows it (model.ts runShown), the cards it names by their
 *  questions as read. */
async function runWords(cx: Ctx, command: string): Promise<string> {
  const questions = new Map<string, string>()
  for (const id of runIds(command)) {
    const q = ((await cx.card(id))?.data as CardData | null | undefined)?.question
    if (q) questions.set(id, q)
  }
  return runShown(command, id => questions.get(id))
}

/** The `↳ view` rows under a row of main's chat (SPEC.md, "Main's chat"): a view main proposed, `↳` dim at 0,
 *  `view · <name> · building|built|proposed` dim, `failed` in red, then `new` in green once built and not yet opened;
 *  a press on its name opens its line in the panel. */
async function viewRowsEl(cx: Ctx, e: ResolveInput & { requestId: string }): Promise<RenderElement | null> {
  const slugs = await cx.viewRows(e.requestId)
  if (!slugs.length) return null
  const { Box, Text, Button } = cx.els(e)
  const views = await homeViews(cx)
  const out: RenderElement[] = []
  for (const slug of [...new Set(slugs)]) {
    const v = views.find(x => x.slug === slug)
    const state = v?.state ?? 'proposed'
    out.push(
      <Box key={`view-row-${slug}`} flexDirection="row" {...(out.length ? {} : { marginTop: 1 })}>
        <Text dimColor>{'↳ view · '}</Text>
        <Button key={`view-open-${slug}`} label={v?.name ?? slug} plain dimColor onPress={() => openView(cx, slug, v?.name ?? slug)} />
        {state === 'failed' ? <Text color={COLORS.problem}>{' · failed'}</Text> : <Text dimColor>{` · ${state === 'built' ? 'built' : state === 'building' ? 'building' : 'proposed'}`}</Text>}
        {v?.fresh ? <Text color={COLORS.fresh}>{' · new'}</Text> : null}
      </Box>,
    )
  }
  return <Box flexDirection="column">{out}</Box>
}

/** The footer under a turn's answer (SPEC.md, "Main's chat"), one blank row under it at column 2: `N citations ·
 *  N cards` dim, ` · N problems` in red (counted from the checks as they stand now), then `ask about this answer ›`. The
 *  facts are cut first; the problems stay whole. */
async function footerEl(cx: Ctx, e: ResolveInput & { requestId: string }): Promise<RenderElement | null> {
  const ans = await cx.answer(e.requestId)
  if (!ans) return null
  const { Box, Text, Button } = cx.els(e)
  // a card cited whole (`[[card:<id>]]`) is no cited value, and a label's link (`[33](concept:<id>/yes)`) names no place
  // a check reads: the footer counts the values cited, and only their problems (live check term-fix6, new quirk 1)
  const cls = claimsIn(ans.text, e.requestId).filter(cl => !bareCard(cl.c) && !labelRef(cl.c.ref))
  let red = 0
  for (const cl of cls) {
    const v = await cx.verdict(cid(cl.c.raw))
    const st = chipState(v?.status, undefined)
    if (st === 'problem' || st === 'failed') red++
  }
  const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`
  const facts = [...(cls.length ? [plural(cls.length, 'citation')] : []), ...(ans.cards.length ? [plural(ans.cards.length, 'card')] : [])].join(' · ')
  return (
    <Box key={`footer-${e.requestId}`} marginTop={1} marginLeft={MARGIN} flexDirection="row" columnGap={2}>
      <Box flexShrink={1} flexDirection="row">
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">{facts}</Text>
        </Box>
        {red ? (
          <Box flexShrink={0}>
            <Text color={COLORS.problem}>{` · ${plural(red, 'problem')}`}</Text>
          </Box>
        ) : null}
      </Box>
      <Box flexShrink={0}>
        <Button key={`ask-answer-${e.requestId}`} label="ask about this answer ›" plain onPress={() => openAsk(cx, { kind: 'sentence', text: withoutNotes(ans.text).slice(0, 6000), label: 'this answer' }, { element: ANSWER_ELEMENT })} />
      </Box>
    </Box>
  )
}

/** A row of main's chat without its `↳ The writer …` line when an earlier row said that writer run's end (the run: the
 *  writer whose chat began last when the row was first drawn, kept with the row so a resumed session decides the same). */
async function withoutSaidWriter(cx: Ctx, row: string, text: string): Promise<string> {
  if (!row || !saysWriter(text)) return text
  let chat = rt.writerOf.get(row)
  if (!chat) {
    // the writer that began last: its chat's start, the newest
    const latest = (await cx.agents()).filter(a => a.role === 'writer' && a.chat).sort((a, b) => a.started.localeCompare(b.started)).at(-1)
    if (!latest) return text
    chat = latest.chat
    rt.writerOf.set(row, chat)
    if (!rt.writerSaid.has(chat)) rt.writerSaid.set(chat, row)
    if (rt.sc) await keepRow(cx, rt.sc.ws, row, { writer: { chat, first: rt.writerSaid.get(chat) === row } })
  }
  return rt.writerSaid.get(chat) === row || !rt.writerSaid.has(chat) ? text : withoutWriterLines(text)
}

/** A prompt of main's: when it reports on a subagent run (model.ts reportOf), one of the reports main answers next, and
 *  whether it is the run's second report after a first that main answered with a `↳` line. Reports that come before
 *  main replies are answered together; a prompt the analyst or an event gave (not a note of thimble's) answers none. */
function heard(text: string, door: string, meta: boolean): void {
  const r = reportOf(text)
  if (!r) {
    if (door === 'prompt' && !meta) rt.answering = null
    return
  }
  if (!rt.answering || rt.answering.replied) rt.answering = { reports: [], replied: false }
  const first = rt.reports.get(r.agent)
  let again = false
  if (first && first.kind !== r.kind && !first.paired) {
    first.paired = true
    again = first.said
  } else rt.reports.set(r.agent, { kind: r.kind, said: false, paired: false })
  rt.answering.reports.push({ agent: r.agent, again })
}

/** A text row of main's answering reports: which of its `↳` lines are said and which repeat a run's end said already
 *  (live QA on 0.7.0: `↳ The view builder finished` once for its hand-back and again for Claude Code's task
 *  notification, which the browser's chat hides). For one report its lines answer it; for several, main writes a line
 *  for each in their order, so where the turn's first text row has one line per report each line answers its report;
 *  where that is unclear, no line is hidden. */
async function noteAnswer(cx: Ctx, row: string, text: string): Promise<void> {
  const a = rt.answering
  if (!a) return
  const lines = noteLines(text)
  const one = a.reports.length === 1
  const mapped = !one && !a.replied && lines.length === a.reports.length
  a.replied = true
  if (!lines.length) return
  a.reports.forEach(r => {
    const first = rt.reports.get(r.agent)
    if (!r.again && (one || mapped) && first && !first.paired) first.said = true
  })
  const hide = one ? (a.reports[0]!.again ? lines : []) : mapped ? lines.filter((_, i) => a.reports[i]!.again) : []
  if (!hide.length) return
  rt.repeats.set(row, [...new Set([...(rt.repeats.get(row) ?? []), ...hide])])
  if (rt.sc) await keepRow(cx, rt.sc.ws, row, { repeat: rt.repeats.get(row)! })
}

/** A row of main's chat with what thimble-term draws under it: the turn's cards (when no reply row carries them) and
 *  the side threads' rows. */
async function underRow(cx: Ctx, e: ResolveInput & { requestId: string; viewport?: { columns: number } }, next: () => Promise<RenderElement>): Promise<RenderElement> {
  const ids = await cx.turnCards(e.requestId)
  const told = await signalRows(cx, e)
  const views = await viewRowsEl(cx, e)
  if (!ids.length && !told && !views) return next()
  const { Box } = cx.els(e)
  const cards = await drawCards(cx, e, ids, (e.viewport?.columns ?? 100) - 2, t => openAsk(cx, t), id => openThread(cx, id))
  return (
    <Box flexDirection="column">
      {await next()}
      {cards}
      {told}
      {views}
    </Box>
  )
}

/** What main's chat drew under its rows in earlier processes of this conversation (kept.ts), put in the state where
 *  it holds none (a file read, awaited at the session's start); then, beside the session, the cards those rows draw,
 *  read in one call, and the threads their `↳ thread` rows name. */
async function restoreKept($: Dollar, cx: Ctx): Promise<void> {
  if (!rt.sc) return
  resetKept()
  const k = await loadKept(cx, rt.sc.ws)
  const ids = new Set<string>()
  for (const [row, r] of Object.entries(k.rows)) {
    if (r.cards?.length && !(await $.state.get({ ...TURN_CARDS, id: row })).value?.length) await $.state.set({ ...TURN_CARDS, id: row }, r.cards)
    if (r.answer && !(await $.state.get({ ...ANSWERS, id: row })).value) await $.state.set({ ...ANSWERS, id: row }, r.answer)
    if (r.threads?.length && !(await $.state.get({ ...THREAD_ROWS, id: row })).value?.length) await $.state.set({ ...THREAD_ROWS, id: row }, r.threads)
    if (r.views?.length && !(await $.state.get({ ...VIEW_ROWS, id: row })).value?.length) await $.state.set({ ...VIEW_ROWS, id: row }, r.views)
    for (const id of [...(r.cards ?? []), ...(r.answer?.cards ?? []), ...embeddedCards(r.answer?.text ?? '')]) ids.add(id)
    for (const v of r.views ?? []) rt.viewsTold.add(v)
    for (const t of r.threads ?? []) rt.told.add(t.thread)
    if (r.repeat?.length) rt.repeats.set(row, r.repeat)
    if (r.writer) {
      if (!rt.writerOf.has(row)) rt.writerOf.set(row, r.writer.chat)
      if (r.writer.first && !rt.writerSaid.has(r.writer.chat)) rt.writerSaid.set(r.writer.chat, row)
    }
  }
  if (!rt.lastReply && k.last.reply) rt.lastReply = k.last.reply
  if (!rt.lastCards.length && k.last.cards.length) rt.lastCards = k.last.cards
  const threads = new Set(Object.values(k.rows).flatMap(r => (r.threads ?? []).map(t => t.thread)))
  void (async () => {
    await loadCardsBatch(cx, [...ids])
    // each `↳ thread` row names its turn's question, from the thread's chat
    for (const id of threads) await readThread(cx, id)
  })().catch(err => $.ui.log(`thimble-term: the cards main's chat drew before could not be read: ${String(err).slice(0, 200)}`))
}

export const register: Register = on => {
  // a click on an empty part of a list hands the keys back to the pane (term.ts takeKeys)
  onListClick(takeKeys)
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const cx = cxOf($)
    rt.sc = await scopeOf(cx)
    if (!rt.sc) return started
    rt.sig = null
    rt.uiN = -1
    // a pane that waited undrawn before the module loaded again (its state is the session's)
    rt.waiting = (await cx.pending()) !== null
    // when this conversation began: its first launch, so a thread asked before a `--continue` is not an earlier one's
    rt.startedAt = await $.session
      .usage()
      .then(u => u.startedAt)
      .catch(() => $.clock.now())
      .catch(() => Date.now())
    // what main's chat drew under its rows before a resume, and the cards it drew
    await restoreKept($, cx).catch(err => $.ui.log(`thimble-term: what main's chat drew before could not be read: ${String(err).slice(0, 200)}`))
    $.clock.every(1000, () => void tick(cx, applyUi))
    $.clock.every(250, () => void checkQueued(cx))
    // the open view matched to what the panel draws, and thimble's view host started the first time a view opens, from
    // a timer of the session's, which lives as long as it (viewhost.ts)
    $.clock.every(PUMP_MS, () => void viewPump(cx))
    void tick(cx, applyUi)
    // what drew before the scope was known (the band above the prompt) draws again, now reading thimble-term's state;
    // the typeahead lists /thimble again with its terminal description
    $.ui.invalidate('ui.render')
    $.ui.invalidate('command.describe')
    return started
  })

  // /thimble in terminal mode: the home panel, with no model turn
  on('command.run', async ($, e, next) => {
    if (!rt.sc) return next(e)
    const cx = cxOf($)
    if (e.presentation?.columns > 0) rt.termColumns = e.presentation.columns
    await navOrigin(cx, false)
    if (e.command === 'thimble:thimble' || e.command === 'thimble') {
      const said = await thimbleCommand(cx, String(e.args ?? ''))
      if (said !== null) return { text: said }
      await openHome(cx)
      return { text: HOME_LINE }
    }
    return next(e)
  })
  // /thimble as the typeahead and /help describe it in terminal mode: what it does here, never the browser's server and
  // URL (live check term-fix7, quirk 8: the skill's description, written for both modes, named those first)
  on('command.describe', async ($, e, next) => {
    if (!rt.sc || (e.command !== 'thimble:thimble' && e.command !== 'thimble')) return next(e)
    return next({ ...e, description: THIMBLE_DESCRIPTION, argumentHint: THIMBLE_ARGS })
  })
  // where Claude Code routes the skill past command.run, its prompt opens the panel and main says the skill's line
  on('skill.prompt', async ($, e, next) => {
    if (rt.sc && (e.skill === 'thimble:thimble' || e.skill === 'thimble')) await openHome(cxOf($))
    return next(e)
  })

  // a citation typed or pasted into the prompt is painted there as the reply's are, blue and underlined
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    if (!rt.sc) return r
    const d = citeSpans(r.text).map(sp => ({ start: sp.at, end: sp.end, underline: true, color: COLORS.link }))
    return d.length ? { ...r, decorations: [...(r.decorations ?? []), ...d] } : r
  })

  // ---------------------------------------------------------------------------------------------- main's turn

  on('turn.start', async ($, e, next) => {
    if (rt.sc) {
      const own = rt.own.has(e.text)
      rt.own.delete(e.text)
      rt.turn = { id: e.turnId, at: new Date(await $.clock.now()).toISOString(), cards: [], row: '', parts: [[]], views: [], own }
    }
    return next(e)
  })

  // main's fork of a side thread runs with the thread's question as its description, which Claude Code's agent tray and
  // its exit dialog show beside the fork's name (never `thread:<slug>`); the prompt keeps `thread:<name>`, by which
  // thimble knows the fork (backend threads.fork_ref)
  on('tool.call', async ($, e, next) => {
    let call = e
    try {
      if (rt.sc && e.agentId === undefined && e.tool === 'Agent') {
        const input = e as unknown as Record<string, unknown>
        const rows = await cxOf($).threads()
        const description = forkDescription(input, rows) ?? (input.subagent_type === 'fork' ? forkDescription(input, await threadsNow(cxOf($))) : null)
        if (description) call = { ...e, description } as typeof e
      }
    } catch {
      // the call runs as main wrote it
    }
    const ran = await next(call)
    try {
      if (!rt.sc || e.agentId !== undefined || ran.deny !== undefined) return ran
      const ids = cardsOfCall(String(e.tool), e, String(ran.text ?? ''))
      if (ids.length) {
        if (rt.turn) for (const id of ids) if (!rt.turn.cards.includes(id)) rt.turn.cards.push(id)
        void loadCards(cxOf($), ids)
      }
      // a view main proposed: its `↳ view` row under the turn's answer
      if (VIEW_TOOL.test(String(e.tool)) && rt.turn) {
        const name = String((e as { name?: unknown }).name ?? '')
        const slug = /\bview:([a-z0-9][a-z0-9-]*)/.exec(String(ran.text ?? ''))?.[1] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        if (slug && !rt.turn.views.includes(slug)) rt.turn.views.push(slug)
      }
    } catch {
      // the call's answer stands whatever thimble-term makes of it
    }
    return ran
  })

  // main's reply as it streams: each citation handed to Claude Code as a Markdown link (never its raw spelling) and a
  // card's line as a placeholder naming the card; a citation, code span or card line not yet closed waits. The row is
  // stored as the model wrote it (session.append), and drawn by AssistantMessage once it is whole.
  on('turn.step', async function* ($, e, next) {
    if (!rt.sc || e.agentId !== undefined) return yield* next(e)
    const cx = cxOf($)
    const blocks = new Map<number, Streaming>()
    const urls = new Map<string, string>()
    const questions = new Map<string, string>()
    const look: StreamLook = {
      link: c => streamLink(c, urls.get(c.ref) ?? ''),
      card: id => `◌ ${(questions.get(id) || 'drawing the card').replace(/[\\[\]*_`<>]/g, m => `\\${m}`)}`,
    }
    const end = (i: number, st: Streaming) => {
      const out = streamStep(st, '', true, look)
      if (st.shown !== st.raw) {
        asWritten.set(st.shown, st.raw)
        if (asWritten.size > 50) asWritten.delete(asWritten.keys().next().value!)
      }
      return out ? [{ kind: 'text' as const, index: i, text: out }] : []
    }
    for await (const ch of next(e)) {
      if (ch.kind === 'text') {
        const st = blocks.get(ch.index) ?? streaming()
        blocks.set(ch.index, st)
        const ahead = `${st.raw.slice(st.done)}${ch.text}`
        try {
          for (const c of citations(ahead)) if (!urls.has(c.ref)) urls.set(c.ref, await placeUrl(cx, c.ref))
          for (const m of ahead.matchAll(/\[\[card:([A-Za-z0-9_-]+)\]\]/g)) if (!questions.has(m[1]!)) questions.set(m[1]!, ((await cx.card(m[1]!))?.data as CardData | null | undefined)?.question ?? '')
        } catch {
          // a link without its file still hides the raw spelling
        }
        const out = streamStep(st, ch.text, false, look)
        if (out === ch.text) yield ch
        else if (out) yield { ...ch, text: out }
        continue
      }
      // a block ends before anything else of the response passes: what it held back is handed over
      for (const [i, st] of blocks) yield* end(i, st)
      blocks.clear()
      yield ch
    }
    for (const [i, st] of blocks) yield* end(i, st)
  })

  // the rows of main's chat a drawing stands under, by the uuid they are stored under (their `requestId`): the
  // latest row a line can stand under, and the turn's latest text row; each text row of the turn in its part (a tool
  // call starts the next part), for the turn's answer. A block of main's reply is stored as the model wrote it, not as
  // it showed while it streamed.
  on('session.append', async ($, e, next) => {
    let msg = e.message
    try {
      if (rt.sc && e.agentId === undefined) {
        if (msg.type === 'user' && (e.door === 'prompt' || e.door === 'delivery')) heard(resultText(msg.content), e.door, Boolean(msg.isMeta))
        if (e.door === 'response' && Array.isArray(msg.content)) {
          const shown = msg.content as { type?: string; text?: string }[]
          const blocks = shown.map(b => (b.type === 'text' && typeof b.text === 'string' && asWritten.has(b.text) ? { ...b, text: asWritten.get(b.text)! } : b))
          if (blocks.some((b, i) => b !== shown[i])) msg = { ...msg, content: blocks as typeof msg.content }
          const texts = blocks.flatMap(b => (b.type === 'text' && typeof b.text === 'string' && b.text.trim() ? [b.text] : []))
          if (rt.turn) {
            if (texts.length) rt.turn.parts.at(-1)!.push({ uuid: e.uuid, text: texts.join('\n\n') })
            if (blocks.some(b => b.type === 'tool_use')) rt.turn.parts.push([])
          }
          if (rt.answering && texts.length) await noteAnswer(cxOf($), e.uuid, texts.join('\n'))
          // the cards a reply embeds, read so they draw
          const embeds = texts.flatMap(t => embeddedCards(t))
          if (embeds.length) void loadCards(cxOf($), embeds)
        }
        if (isAnchor({ ...e, message: msg } as unknown as AppendedRow)) rt.anchor = e.uuid
        if (e.door === 'response' && rt.turn && hasText(msg.content)) rt.turn.row = e.uuid
      }
    } catch {
      // the row is stored whatever thimble-term makes of it
    }
    return next(msg === e.message ? e : { ...e, message: msg })
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (rt.sc && e.agentId === undefined && rt.turn) {
      const t = rt.turn
      rt.turn = null
      const row = t.row || rt.anchor
      const cx = cxOf($)
      if (t.cards.length && row) {
        const cur = await cx.turnCards(row)
        await cx.setTurnCards(row, [...cur, ...t.cards.filter(id => !cur.includes(id))])
      }
      // what `/thimble cite` and `/thimble card` open: the turn's citations and cards
      const all = t.parts.flat().map(r => r.text).join('\n\n')
      if (all.trim()) rt.lastReply = all
      if (all.trim() || t.cards.length) rt.lastCards = [...new Set([...embeddedCards(all), ...t.cards])]
      if ((all.trim() || t.cards.length) && rt.sc) await keepLast(cx, rt.sc.ws, rt.lastReply, rt.lastCards)
      // the answer: its last part that cites or embeds a card, else its last; the footer stands under its last row
      const part = answerPart(t.parts)
      const last = part?.at(-1)?.uuid ?? ''
      if (part && last && !t.own) {
        const text = part.map(r => r.text).join('\n\n')
        const shows = [...new Set([...embeddedCards(text), ...(last === row ? t.cards : [])])]
        if (citations(text).length || shows.length) await cx.setAnswer(last, { rows: part.map(r => r.uuid), text, cards: shows })
      }
      // the views this turn proposed: their rows under the answer
      const vrow = last || row
      if (t.views.length && vrow) {
        const cur = await cx.viewRows(vrow)
        await cx.setViewRows(vrow, [...cur, ...t.views.filter(v => !cur.includes(v))])
        for (const v of t.views) rt.viewsTold.add(v)
      }
    }
    return done
  })

  // ---------------------------------------------------------------------------------------------- main's chat

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!rt.sc) return next(e)
    const cx = cxOf($)
    const ids = await cx.turnCards(e.requestId)
    const told = await signalRows(cx, e)
    const views = await viewRowsEl(cx, e)
    const footer = await footerEl(cx, e)
    // without main's end token, and a `↳ thread` line naming its thread by its first question, not its fork's slug; no
    // such line for a thread whose `↳ thread` row thimble-term drew, which says the same
    const rows = await cx.threads()
    // Claude Code's own stand-in for a reply that never came (its `<synthetic>` text, as after a quit stopped a thread),
    // which main never wrote: not drawn (live check term-fix9, quirk 13)
    const said = SYNTHETIC_RE.test(e.props.text) ? '' : e.props.text
    // and none of main's `↳` lines that answer a subagent run's second report, whose first an earlier row answered
    const repeats = rt.repeats.get(e.requestId)
    const text = await withoutSaidWriter(cx, e.requestId, namedThreads(withoutToldThreads(withoutEnd(repeats ? withoutLines(said, repeats) : said), rows, rt.told), rows))
    const live = e.surface === 'terminal' || e.surface === 'desktop'
    if (!ids.length && !told && !views && !footer && text === e.props.text && !live && !needsDrawing(text)) return next(e)
    const { Box } = $.ui.resolve(e)
    // the reply fills the terminal's width, less 2, its cards as wide as its prose
    const cols = (e.viewport?.columns ?? 100) - 2
    // a sentence that cites a card whole keeps its chip (`[ card ]`) though the card is drawn under the reply
    const body = text.trim() ? await drawReply(cx, e, text, cols - MARGIN, { first: Boolean(e.props.isFirstOfReply), skipCards: new Set(ids), ask: t => openAsk(cx, t), open: id => openThread(cx, id) }) : []
    const cards = await drawCards(cx, e, ids, cols, t => openAsk(cx, t), id => openThread(cx, id))
    // a block that held only a line thimble-term hides: nothing (ctrl+o's view still draws the reply's time and model
    // above it, which no hook reaches; the engine's own block with no text draws the same)
    if (!body.length && !cards && !told && !views && !footer) return <Box />
    return (
      <Box flexDirection="column">
        {body}
        {cards}
        {footer}
        {told}
        {views}
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => (rt.sc ? underRow(cxOf($), e, () => next(e)) : next(e)))
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => (rt.sc ? underRow(cxOf($), e, () => next(e)) : next(e)))
  // /thimble's line as thimble says it, not under the plugin's name, which Claude Code puts before a hook's answer
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (!rt.sc) return next(e)
    // `/thimble …` answers as thimble, not under the plugin's name, which Claude Code puts before a hook's answer
    const own = (e.props.command === 'thimble:thimble' || e.props.command === 'thimble') && /^\s*(?:thimble-term:\s*)?thimble:/.test(e.props.text)
    const shown = own ? { ...e, props: { ...e.props, text: e.props.text.replace(/^\s*thimble-term:\s*/, '') } } : e
    return underRow(cxOf($), e, () => next(shown))
  })

  // a thimble tool's row, and a card's run in Bash, name the card by its question, never by its id, and a citation by
  // its words (in the row and in ctrl+o's detailed view); a side thread's fork is named by the thread's first question,
  // never its slug
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!rt.sc) return next(e)
    const cx = cxOf($)
    const tool = String(e.props.tool)
    const input = e.props.input as Record<string, unknown> | undefined
    if (!input || typeof input !== 'object') return next(e)
    if (THIMBLE_TOOL.test(tool)) {
      let changed = false
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input)) {
        const s = typeof v === 'string' ? await toolWords(cx, k, v) : v
        if (s !== v) changed = true
        out[k] = s
      }
      return changed ? next({ ...e, props: { ...e.props, input: out } }) : next(e)
    }
    if (tool === 'Bash' && typeof input.command === 'string' && /thimble-run\b/.test(input.command)) {
      return next({ ...e, props: { ...e.props, input: { ...input, command: await runWords(cx, input.command) } } })
    }
    if (tool === 'Agent' || tool === 'Task') {
      // a fork's description and its prompt (ctrl+o's `Prompt:`) name the thread by its first question, never its slug
      const threads = await cx.threads()
      const named = (v: unknown) => (typeof v === 'string' && /\bthread:/.test(v) ? namedForks(v, threads) : v)
      const description = named(input.description)
      const prompt = named(input.prompt)
      const output = forkOutput(e.props.output, threads)
      if (description !== input.description || prompt !== input.prompt || output !== e.props.output) return next({ ...e, props: { ...e.props, input: { ...input, description, prompt }, ...(output !== undefined ? { output } : {}) } })
    }
    return next(e)
  })

  // the row saying a side thread's fork finished names the thread by its first question, never the fork's slug
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } }, async ($, e, next) => {
    if (!rt.sc || !/\bthread:/.test(e.props.text)) return next(e)
    const text = namedForks(e.props.text, await cxOf($).threads())
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  // a card tool's result row: the card by its question, since the card itself is drawn under the turn's last reply; a
  // label's, its name and each value's count. An error stays Claude Code's row.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!rt.sc || e.props.isErrored) return next(e)
    // a fork's result (`Backgrounded agent`, and in ctrl+o its `Prompt:`) names the thread by its first question
    if (e.props.tool === 'Agent' || e.props.tool === 'Task') {
      const output = forkOutput(e.props.output, await cxOf($).threads())
      return output === e.props.output ? next(e) : next({ ...e, props: { ...e.props, output } })
    }
    if (!CARD_TOOL.test(String(e.props.tool))) return next(e)
    const ids = cardsOfCall(String(e.props.tool), {}, resultText(e.props.output))
    const tc = ids[0] ? await cxOf($).card(ids[0]) : undefined
    const data = tc?.data as CardData | null | undefined
    const q = data?.question
    if (!q) return next(e)
    const { Text } = $.ui.resolve(e)
    // the row cut at a word, as every cut, to the terminal's width
    const room = Math.max(20, (e.viewport?.columns ?? 100) - 2)
    if (data.kind === 'label' && data.label) {
      const counts = ((data.rows ?? []) as { label: string; value: number }[]).map(r => `${r.label} ${r.value.toLocaleString('en-US')}`).join(' · ')
      return <Text dimColor wrap="truncate-end">{cut(`  ⎿  label ${quoted(data.label.name)}${counts ? ` · ${counts}` : ''}${tc?.busy ? ` · ${tc.busy}` : ''}`, room)}</Text>
    }
    return <Text dimColor wrap="truncate-end">{cut(`  ⎿  card ${quoted(q)}${tc?.busy ? ` · ${tc.busy}` : ''}`, room)}</Text>
  })

  // ---------------------------------------------------------------------------------------------- above the prompt

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!rt.sc || e.props.hasSurvey || e.props.view.agentId) return next(e)
    const cx = cxOf($)
    const panes = await cx.panes()
    if (e.surface === 'terminal' && e.viewport?.columns && !panes.some(p => p.isPlaced)) rt.termColumns = e.viewport.columns
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows: RenderElement[] = []
    const label = (s: string) => (
      <Box width={ABOVE_LABEL} flexShrink={0}>
        <Text dimColor>{`  ${s}`}</Text>
      </Box>
    )
    // a panel Claude Code left undrawn (an open it was not asked for, on a terminal narrower than it places those at),
    // and why; `open panel` opens it as `/thimble` does, from the press, which Claude Code places at any width. Gone
    // once the pane is drawn (Claude Code places it when the terminal is widened to that width)
    const pending = await cx.pending()
    const placed = panes.some(p => p.id === PANEL && p.isPlaced)
    if (pending && placed) $.clock.after(0, () => void placedLater(cx))
    if (pending && !placed) {
      const columns = (e.surface === 'terminal' ? e.viewport?.columns : 0) || pending.columns || 0
      const more = pending.floor && columns ? pending.floor - columns : 0
      if (pending.floor && columns && more <= 0) $.clock.after(0, () => void retryPending(cx, columns))
      rows.push(
        <Box key="above-panel" flexDirection="row">
          {label('panel')}
          <Box flexDirection="row" columnGap={2} flexShrink={1}>
            <Box flexShrink={1}>
              <Text wrap="truncate-end">{`${pending.title} is ready`}</Text>
            </Box>
            <Box flexDirection="row" columnGap={2} flexShrink={0}>
              <Button key="above-panel-open" label="open panel" plain onPress={() => openPending(cx)} />
              <Button key="above-panel-dismiss" label="dismiss" plain onPress={() => closePanel(cx)} />
            </Box>
          </Box>
        </Box>,
      )
    }
    // what is new in the workspace since home was last opened, like a toast: open › opens home on the first new item
    // and the row goes; none while home shows (live check term-fix8, quirk 6: it stayed beside home, which showed them)
    const home = await cx.home()
    const homeShown = (await cx.panel())?.view === 'home' && panes.some(p => p.id === PANEL && p.isPlaced)
    if (home && !homeShown) {
      // the first count of a session (refreshHome keeps it) is what was there already, so nothing is new yet
      const seen = (await cx.homeSeen()) ?? home
      const fresh = (k: 'cards' | 'labels' | 'docs' | 'views') => Math.max(0, home[k] - (seen as typeof home)[k])
      const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} new ${w}${n === 1 ? '' : 's'}`
      const words = [fresh('cards') ? plural(fresh('cards'), 'card') : '', fresh('labels') ? plural(fresh('labels'), 'label') : '', fresh('docs') ? plural(fresh('docs'), 'document') : '', fresh('views') ? plural(fresh('views'), 'view') : ''].filter(Boolean).join(' · ')
      if (words) {
        rows.push(
          <Box key="above-home" flexDirection="row">
            {label('thimble')}
            <Box flexDirection="row" columnGap={2} flexShrink={1}>
              {/* the word `new` in green, as wherever it shows (SPEC.md, rule 8) */}
              <Text wrap="truncate-end">{words.split(/( new )/).map((w, i) => (w === ' new ' ? <Text key={`new-${i}`}>{' '}<Text color={COLORS.fresh}>new</Text>{' '}</Text> : w))}</Text>
              <Button key="above-home-open" label="open ›" plain onPress={() => openHomeNew(cx)} />
            </Box>
          </Box>,
        )
      }
    }
    // side threads show as `↳ thread` rows under main's latest row and as `N new` on the panel's title row (SPEC.md,
    // "Main's chat"): no row of their own here
    if (!rows.length) return next(e)
    return <Box flexDirection="column">{rows}</Box>
  })

  // ---------------------------------------------------------------------------------------------- the panel

  // the panel's drawings run one at a time (turns.ts, two seconds at most each); one that settles after a later one
  // began, or that Claude Code abandoned, draws once more 50 ms after, so the shown panel's buttons and fields work
  const paneDraws = { draws: 0, settled: 0, redrawing: false }
  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e, next) => {
    if (!rt.sc) return next(e)
    const pe = e as PaneEvent
    const cx = cxOf($)
    // a pane that waited undrawn is drawn now (Claude Code placed it once the terminal was wide enough): the row above
    // the prompt that offered it goes
    if (rt.waiting) {
      rt.waiting = false
      $.clock.after(0, () => void placedLater(cx))
    }
    if (pe.surface === 'terminal' && pe.viewport?.columns && (pe.props.placement === 'dock' || pe.props.placement === 'inline')) {
      rt.termColumns = pe.props.placement === 'dock' ? pe.viewport.columns + pe.props.bodyColumns + 1 : pe.viewport.columns
      // a resize keeps the dock at the width it was opened with: it opens again at the panel's width for the terminal
      // now (a width the person dragged still wins)
      if (pe.props.placement === 'dock' && rt.termColumns !== rt.fittedFor && rt.termColumns >= 110) {
        rt.fittedFor = rt.termColumns
        if (panelColumns() !== pe.props.bodyColumns) {
          $.clock.after(0, () => {
            void (async () => {
              const placed = (await cx.panes()).some(p => p.id === PANEL && p.isPlaced)
              const p = await cx.panel()
              if (placed && p) await cx.open({ id: PANEL, title: paneTitle(p), columns: panelColumns() }).catch(() => undefined)
            })()
          })
        }
      }
    }
    return paneTurns.run(async () => {
      const n = ++paneDraws.draws
      await read($, panelTickA)
      const tree = await drawPanel(cx, pe)
      const late = paneDraws.settled > n
      paneDraws.settled = Math.max(paneDraws.settled, n)
      if ((late || next.signal.aborted) && !paneDraws.redrawing) {
        paneDraws.redrawing = true
        $.clock.after(50, () => {
          paneDraws.redrawing = false
          // an aborted drawing draws again only when no drawing began since; drawing again regardless would abort a
          // drawing slower than 50 ms each time, and the panel would never show
          if (late || paneDraws.draws === n) void update($, panelTickA, k => (k ?? 0) + 1)
        })
      }
      return tree
    }, fire => $.clock.after(2000, fire))
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANEL) {
      rt.panelFocus = ''
      rt.waiting = false
      await $.state.set(pendingRef, null).catch(() => undefined)
      await $.state.set(panelA, null).catch(() => undefined)
      // a terminal view's program ends with its pane
      closeView()
    }
    return closed
  })

  // the panel's focus ring: while a text field holds it the hint row names Enter and Esc alone (panel.tsx endHints),
  // since a letter goes into the field; off every element, NO_FOCUS (not '', which is a view just opened)
  const NO_FOCUS = '-'
  // A list's keys reach it through the relay's three Buttons (panel.tsx RELAY): a move of the ring from the middle one
  // onto a neighbour (↑, ↓, Tab) is that key for the list, and the ring stays; a move onto a neighbour from elsewhere
  // lands on the middle one. Every move draws the panel again, so its hint row names the keys where the ring is.
  on('ui.focus', { requestId: PANEL }, async ($, e, next) => {
    // the person moving the ring while the panel's typing went to the prompt (panel.tsx typeThrough): the panel has its
    // keys again
    if (rt.sc && rt.typeThrough && e.origin.kind === 'person') rt.typeThrough = false
    const how = rt.sc ? relayMove(rt.panelFocus, e.element) : ''
    if (how === 'up' || how === 'down') {
      await relayKey(how).catch(() => undefined)
      void cxOf($).bumpPanel()
      // a document's comment the key chose, scrolled into view once the panel is drawn again
      scrollPending(cxOf($))
      return {}
    }
    // a ring put back on a text field the panel no longer draws (the new thread's form left by back, live check
    // term-fix9, quirk 1) is on none of its elements: onto the list's keys when it draws a list
    const stale = Boolean(rt.sc && e.element && focusedField(e.element) && !rt.fields.has(e.element))
    const park = how === 'park' || (stale && hasList())
    const moved = await next(park ? { ...e, element: RELAY.pick } : e)
    try {
      if (rt.sc && !moved.deny) {
        rt.panelFocus = park ? RELAY.pick : stale ? NO_FOCUS : (e.element ?? NO_FOCUS)
        void cxOf($).bumpPanel()
      }
    } catch {
      // the ring moves whatever thimble-term makes of it
    }
    return moved
  })

  // the wheel over a list the panel cut to its rows (panel.tsx windowList) moves the list's rows, the choice where it is;
  // over any other panel the pane scrolls
  on('ui.scroll', { requestId: PANEL }, async ($, e, next) => {
    if (!rt.sc || !e.pointer || e.origin.kind !== 'person') return next(e)
    // over a terminal view the wheel is the view's: the list under the pointer moves its rows, so it goes with the
    // frame's cell there
    if (openViewState()?.id && (await cxOf($).panel())?.view === 'view') {
      void sendEvent(cxOf($), { t: 'wheel', by: e.by, ...viewWheelAt(e.pointer) })
      return {}
    }
    if (!wheelWindow(e.by)) return next(e)
    void cxOf($).bumpPanel()
    return {}
  })

  // ---------------------------------------------------------------------------------------------- clicks

  // "ask" beside a selection (para.tsx): its press is the person's own (a press on a card's title is a gesture,
  // card.tsx, which asks a side thread about the card)
  on('ui.press', async ($, e, next) => {
    if (!rt.sc) return next(e)
    const cx = cxOf($)
    await navOrigin(cx, e.component === 'Pane' && e.requestId === PANEL)
    if (e.element === 'sel-ask' && rt.selection) await openAsk(cx, { kind: 'sentence', text: rt.selection.slice(0, 1200) })
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    if (!rt.sc) return next(e)
    const cx = cxOf($)
    const d = (e.data ?? {}) as Record<string, unknown>
    const inPanel = e.component === 'Pane' && e.requestId === PANEL
    // every post of a Client that uses hooks/gestures.tsx carries its recent gestures; each is handled once
    if (Array.isArray(d.gestures) && typeof d.origin === 'string') {
      const last = rt.seenGestures.get(d.origin) ?? 0
      const fresh = (d.gestures as Sent[]).filter(g => typeof g?.seq === 'number' && g.seq > last)
      if (fresh.length) rt.seenGestures.set(d.origin, Math.max(...fresh.map(g => g.seq)))
      for (const g of fresh) {
        if (!g.gesture || !g.target) continue
        await navOrigin(cx, inPanel)
        try {
          await onGesture(cx, g.gesture, g.target)
        } catch (err) {
          $.ui.log(`thimble-term: the ${g.gesture} gesture failed: ${String(err).slice(0, 200)}`)
        }
      }
    }
    if (d.type === 'home') {
      await navOrigin(cx, inPanel)
      await linesMessage(cx, d.horigin, d.hacts)
    } else if (d.type === 'view') {
      // a click or a drag in a terminal view (viewclient.tsx); like a click on a list, it gives the pane its keys back
      await navOrigin(cx, inPanel)
      if (await viewMessage(cx, d)) await takeKeys(cx)
    } else if (d.type === 'copy' && typeof d.text === 'string') {
      const text = d.text.slice(0, 100000)
      rt.selection = text
      const r = await $.ui.copy({ text, surface: e.surface })
      $.ui.toast(r.isCopied ? `copied ${text.length} characters` : `could not copy: ${r.reason}`)
    } else if (d.type === 'label-open' && typeof d.slug === 'string') {
      // a press on a card's label row (its name or its ↗): the label's panel, under its name
      await navOrigin(cx, inPanel)
      const find = async () => {
        const got = await surfaceValue(cx, 'labels')
        return got?.ok ? labelsOf(got.value).find(l => l.id === d.slug || l.name === d.slug) : undefined
      }
      // the labels as last read may be older than the label (home read them before main made it): read them again
      let hit = await find()
      if (!hit) {
        await readSurface(cx, 'labels', 'labels')
        hit = await find()
      }
      if (!hit) cx.toast('thimble: that label is no longer in this workspace')
      else await openLabel(cx, hit.id, hit.name ?? hit.id)
    } else if (d.type === 'field' && typeof d.name === 'string' && typeof d.text === 'string') {
      // a field's words (field.tsx): a draft, or a save
      await fieldMessage(cx, d.name, d.text.slice(0, 20000), d.save === true)
    } else if (d.type === 'doc-edit' && typeof d.slug === 'string' && typeof d.text === 'string') {
      // a document's editor (docedit.tsx): what was typed, or a save
      await docEditMessage(cx, d.slug, d.text, d.save === true)
    } else if (d.type === 'files-open' && typeof d.path === 'string') {
      await openFile(cx, d.path)
    }
    return next(e)
  })

  // a Client of thimble-term that could not draw (its tree did not validate, its module threw): why goes to the debug
  // log, never to main's chat; the open view's own says so in the panel, dim, in its place (panel.tsx drawView), as
  // the engine draws the panel again once this answers
  on('ui.fault', async ($, e, next) => {
    $.ui.log(`thimble-term: ${e.module} could not draw in ${e.component} (${e.phase}): ${e.reason}`, { to: 'debug' })
    if (e.component === 'Pane' && e.requestId === PANEL && /(^|\/)viewclient\.tsx$/.test(e.module)) viewFault(e.reason)
    return next(e)
  })
}
