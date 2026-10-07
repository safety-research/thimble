// thimble-term: thimble's terminal-mode renderer. The `thimble` command loads this plugin in terminal mode only
// (`thimble mode terminal`), so browser mode loads nothing new. It registers no model tools, agents, guidance or
// commands, and keeps no data except what is on screen: what it draws comes from `thimble state`, and every change it
// makes goes through `thimble act` (hooks/data.ts). Its scope check: THIMBLE_WS names a workspace whose
// trusted/launch.json has `mode: "terminal"`; anywhere else every hook passes through.
//
// What it draws (its look is views/SPEC.md's "The visual system", from thimble-cc-mod):
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
import { needsDrawing } from './lib'
import { cardsOfCall, labelsOf, withoutEnd } from './model'
import { HOME_UI_EMPTY } from './home'
import { linesMessage } from './lines'
import { drawPanel, fieldMessage, onGesture, openAsk, openFile, openLabel, openThread } from './panel'
import type { PaneEvent } from './panel'
import { MARGIN, drawCards, drawReply } from './reply'
import { COLORS } from './paint'
import { isAnchor } from './signal'
import type { AppendedRow } from './signal'
import { NAV_EMPTY } from './nav'
import { FILES_UI_EMPTY, LABEL_UI_EMPTY, PANEL, checkQueued, closePanel, loadCards, navOrigin, openHome, openPanel, readSurface, rt, surfaceValue, tick } from './term'
import type { UiApply } from './term'
import { turns } from './turns'

type Dollar = EngineInterface

/** What `/thimble` says in terminal mode: the home panel is open, and how to reach the browser instead. */
export const HOME_LINE = 'thimble: terminal mode. The home panel is open. For the browser workspace, quit, run `thimble mode browser`, and start `thimble` again.'

const THIMBLE_TOOL = /^mcp__plugin_thimble_thimble__/
const CARD_TOOL = /^mcp__plugin_thimble_thimble__(add_card|edit_card|apply_label)$/

/** The text of a tool's result as the transcript holds it: a string, or content blocks. */
function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  const blocks = Array.isArray(output) ? output : (output as { content?: unknown } | undefined)?.content
  return Array.isArray(blocks) ? blocks.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : ''
}
const ID_IN_TEXT = /\b(?:card|cell):([A-Za-z0-9_-]{4,})/g
const ABOVE_LABEL = 12
const paneTurns = turns()

// the state the drawings read (types/index.d.ts)
const CARDS = { plugin: 'thimble-term', key: 'cards' } as const
const TURN_CARDS = { plugin: 'thimble-term', key: 'turnCards' } as const
const VERDICTS = { plugin: 'thimble-term', key: 'verdicts' } as const
const THREAD = { plugin: 'thimble-term', key: 'thread' } as const
const THREAD_ROWS = { plugin: 'thimble-term', key: 'threadRows' } as const
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
  return {
    now: () => $.clock.now().catch(() => Date.now()),
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
    read: path => $.fs.read(path),
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
    log: text => $.ui.log(text),
    toast: text => $.ui.toast(text),
    submit: async text => void (await $.prompt.submit({ text, asUser: true })),
    els: e => $.ui.resolve(e as ResolveInput<'Pane', 'terminal'>),
    card: async id => (await $.state.get({ ...CARDS, id })).value,
    setCard: async (id, v) => void (await $.state.set({ ...CARDS, id }, v)),
    turnCards: async row => (await $.state.get({ ...TURN_CARDS, id: row })).value ?? [],
    setTurnCards: async (row, ids) => void (await $.state.set({ ...TURN_CARDS, id: row }, ids)),
    verdict: async id => (await $.state.get({ ...VERDICTS, id })).value,
    setVerdict: async (id, v) => void (await $.state.set({ ...VERDICTS, id }, v)),
    thread: async id => (await $.state.get({ ...THREAD, id })).value,
    setThread: async (id, v) => void (await $.state.set({ ...THREAD, id }, v)),
    threadRows: async row => (await $.state.get({ ...THREAD_ROWS, id: row })).value ?? [],
    setThreadRows: async (row, rows) => void (await $.state.set({ ...THREAD_ROWS, id: row }, rows)),
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

function hasText(content: unknown): boolean {
  return Array.isArray(content) && content.some(b => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && String((b as { text?: unknown }).text ?? '').trim() !== '')
}

/** The rows a side thread's answer leaves under a row of main's chat (signal.ts, views/SPEC.md "Main's chat"): `↳` at
 *  column 0 and its words at 2, dim (`thread · "<question>" · answered`), `new` in green until it is read; a press on
 *  the question opens the thread. */
async function signalRows(cx: Ctx, e: ResolveInput & { requestId: string }): Promise<RenderElement | null> {
  const rows = await cx.threadRows(e.requestId)
  if (!rows.length) return null
  const { Box, Text, Button } = cx.els(e)
  const threads = await cx.threads()
  const seen = new Set<string>()
  const out: RenderElement[] = []
  for (const s of rows) {
    if (seen.has(s.thread)) continue
    seen.add(s.thread)
    const t = threads.find(x => x.id === s.thread)
    const q = `"${(t?.title || t?.anchorText || 'side thread').replace(/\s+/g, ' ').slice(0, 60)}"`
    out.push(
      <Box key={`signal-${s.thread}`} flexDirection="row">
        <Text dimColor>{'↳ '}</Text>
        <Text dimColor>{'thread · '}</Text>
        <Button key={`signal-open-${s.thread}`} label={q} plain dimColor onPress={() => void openThread(cx, s.thread)} />
        <Text dimColor>{t?.running ? ' · answering' : ' · answered'}</Text>
        {t?.unread ? <Text color={COLORS.fresh}>{' · new'}</Text> : null}
      </Box>,
    )
  }
  return <Box flexDirection="column">{out}</Box>
}

/** A row of main's chat with what thimble-term draws under it: the turn's cards (when no reply row carries them) and
 *  the side threads' rows. */
async function underRow(cx: Ctx, e: ResolveInput & { requestId: string; viewport?: { columns: number } }, next: () => Promise<RenderElement>): Promise<RenderElement> {
  const ids = await cx.turnCards(e.requestId)
  const told = await signalRows(cx, e)
  if (!ids.length && !told) return next()
  const { Box } = cx.els(e)
  const cards = await drawCards(cx, e, ids, (e.viewport?.columns ?? 100) - 2, t => void openAsk(cx, t))
  return (
    <Box flexDirection="column">
      {await next()}
      {cards}
      {told}
    </Box>
  )
}

/** Hex ids in a thimble tool's row, as the card's question (or `card`): the analyst never reads an id. */
async function scrubIds(cx: Ctx, text: string): Promise<string> {
  let out = text
  for (const m of text.matchAll(ID_IN_TEXT)) {
    const tc = await cx.card(m[1]!)
    const q = (tc?.data as { question?: string } | undefined)?.question
    out = out.replace(m[0], q ? `card "${q.length > 40 ? `${q.slice(0, 39)}…` : q}"` : 'card')
  }
  return out
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const cx = cxOf($)
    rt.sc = await scopeOf(cx)
    if (!rt.sc) return started
    rt.sig = null
    rt.uiN = -1
    $.clock.every(1000, () => void tick(cx, applyUi))
    $.clock.every(250, () => void checkQueued(cx))
    void tick(cx, applyUi)
    // what drew before the scope was known (the band above the prompt) draws again, now reading thimble-term's state
    $.ui.invalidate('ui.render')
    return started
  })

  // /thimble in terminal mode: the home panel, with no model turn
  on('command.run', async ($, e, next) => {
    if (!rt.sc) return next(e)
    const cx = cxOf($)
    if (e.presentation?.columns > 0) rt.termColumns = e.presentation.columns
    await navOrigin(cx, false)
    if (e.command === 'thimble:thimble' || e.command === 'thimble') {
      await openHome(cx)
      return { text: HOME_LINE }
    }
    return next(e)
  })
  // where Claude Code routes the skill past command.run, its prompt opens the panel and main says the skill's line
  on('skill.prompt', async ($, e, next) => {
    if (rt.sc && (e.skill === 'thimble:thimble' || e.skill === 'thimble')) await openHome(cxOf($))
    return next(e)
  })

  // ---------------------------------------------------------------------------------------------- main's turn

  on('turn.start', async ($, e, next) => {
    if (rt.sc) rt.turn = { id: e.turnId, at: new Date(await $.clock.now()).toISOString(), cards: [], row: '' }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (!rt.sc || e.agentId !== undefined || ran.deny !== undefined) return ran
      const ids = cardsOfCall(String(e.tool), e, String(ran.text ?? ''))
      if (ids.length) {
        if (rt.turn) for (const id of ids) if (!rt.turn.cards.includes(id)) rt.turn.cards.push(id)
        void loadCards(cxOf($), ids)
      }
    } catch {
      // the call's answer stands whatever thimble-term makes of it
    }
    return ran
  })

  // the rows of main's chat a drawing stands under, by the uuid they are stored under (their `requestId`): the
  // latest row a line can stand under, and the turn's latest text row
  on('session.append', async ($, e, next) => {
    try {
      if (rt.sc && e.agentId === undefined) {
        if (isAnchor(e as unknown as AppendedRow)) rt.anchor = e.uuid
        if (e.door === 'response' && rt.turn && hasText(e.message.content)) rt.turn.row = e.uuid
      }
    } catch {
      // the row is stored whatever thimble-term makes of it
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (rt.sc && e.agentId === undefined && rt.turn) {
      const t = rt.turn
      rt.turn = null
      const row = t.row || rt.anchor
      if (t.cards.length && row) {
        const cur = (await $.state.get({ ...TURN_CARDS, id: row })).value ?? []
        await $.state.set({ ...TURN_CARDS, id: row }, [...cur, ...t.cards.filter(id => !cur.includes(id))])
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
    const text = withoutEnd(e.props.text)
    const live = e.surface === 'terminal' || e.surface === 'desktop'
    if (!ids.length && !told && text === e.props.text && !live && !needsDrawing(text)) return next(e)
    const { Box } = $.ui.resolve(e)
    const cols = (e.viewport?.columns ?? 100) - 2
    const body = text.trim() ? await drawReply(cx, e, text, cols - MARGIN, { first: Boolean(e.props.isFirstOfReply), skipCards: new Set(ids), ask: t => void openAsk(cx, t), open: id => void openThread(cx, id) }) : []
    const cards = await drawCards(cx, e, ids, cols, t => void openAsk(cx, t))
    if (!body.length && !cards && !told) return <Box />
    return (
      <Box flexDirection="column">
        {body}
        {cards}
        {told}
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => (rt.sc ? underRow(cxOf($), e, () => next(e)) : next(e)))
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => (rt.sc ? underRow(cxOf($), e, () => next(e)) : next(e)))
  // /thimble's line as thimble says it, not under the plugin's name, which Claude Code puts before a hook's answer
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (!rt.sc) return next(e)
    const own = (e.props.command === 'thimble:thimble' || e.props.command === 'thimble') && e.props.text.includes(HOME_LINE.slice(9, 40))
    const shown = own ? { ...e, props: { ...e.props, text: HOME_LINE } } : e
    return underRow(cxOf($), e, () => next(shown))
  })

  // a thimble tool's row, and a card's run in Bash, name the card by its question, never by its id
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
        const s = typeof v === 'string' ? await scrubIds(cx, v) : v
        if (s !== v) changed = true
        out[k] = s
      }
      return changed ? next({ ...e, props: { ...e.props, input: out } }) : next(e)
    }
    if (tool === 'Bash' && typeof input.command === 'string' && /thimble-run\s+(card|label|stale)/.test(input.command)) {
      const m = /(?:^|\s)\S*thimble-run\s+(card|label|stale)\s*'?"?([A-Za-z0-9_-]*)/.exec(input.command)
      let shown = m ? `thimble-run ${m[1]}` : 'thimble-run'
      if (m?.[1] === 'card' && m[2]) shown = await scrubIds(cx, `thimble-run card:${m[2]}`)
      return next({ ...e, props: { ...e.props, input: { ...input, command: shown } } })
    }
    return next(e)
  })

  // a card tool's result row: the card by its question, since the card itself is drawn under the turn's last reply
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!rt.sc || e.props.isErrored || !CARD_TOOL.test(String(e.props.tool))) return next(e)
    const ids = cardsOfCall(String(e.props.tool), {}, resultText(e.props.output))
    const tc = ids[0] ? await cxOf($).card(ids[0]) : undefined
    const q = (tc?.data as { question?: string } | undefined)?.question
    if (!q) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor wrap="truncate-end">{`  ⎿  card "${q}"${tc?.busy ? ` · ${tc.busy}` : ''}`}</Text>
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
    // a panel a click opened that waits undrawn on a narrow terminal
    const pending = await cx.pending()
    if (pending && !panes.some(p => p.id === PANEL && p.isPlaced)) {
      rows.push(
        <Box key="above-panel" flexDirection="row">
          {label('panel')}
          <Box flexDirection="row" columnGap={2}>
            <Text>{`${pending.title} is ready`}</Text>
            <Button
              key="above-panel-open"
              label="open panel"
              plain
              onPress={() =>
                void (async () => {
                  const p = await cx.panel()
                  if (p) await openPanel(cx, p)
                })()
              }
            />
            <Button key="above-panel-dismiss" label="dismiss" plain onPress={() => void closePanel(cx)} />
          </Box>
        </Box>,
      )
    }
    // what is new in the workspace since home was last opened, like a toast: open › opens home and the row goes
    const home = await cx.home()
    if (home) {
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
              {/* the word `new` in green, as wherever it shows (views/SPEC.md, rule 8) */}
              <Text wrap="truncate-end">{words.split(/( new )/).map((w, i) => (w === ' new ' ? <Text key={`new-${i}`}>{' '}<Text color={COLORS.fresh}>new</Text>{' '}</Text> : w))}</Text>
              <Button key="above-home-open" label="open ›" plain onPress={() => void openHome(cx)} />
            </Box>
          </Box>,
        )
      }
    }
    // side threads show as `↳ thread` rows under main's latest row and as `N new` on the panel's path row (views/SPEC.md,
    // "Main's chat"): no row of their own here
    if (!rows.length) return next(e)
    return <Box flexDirection="column">{rows}</Box>
  })

  // ---------------------------------------------------------------------------------------------- the panel

  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e, next) => {
    if (!rt.sc) return next(e)
    const pe = e as PaneEvent
    if (pe.surface === 'terminal' && pe.viewport?.columns) rt.termColumns = pe.props.placement === 'dock' ? pe.viewport.columns + pe.props.bodyColumns + 1 : pe.viewport.columns
    await read($, panelTickA)
    const cx = cxOf($)
    return paneTurns.run(() => drawPanel(cx, pe), fire => $.clock.after(2000, fire))
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANEL) {
      await $.state.set(pendingRef, null).catch(() => undefined)
      await $.state.set(panelA, null).catch(() => undefined)
    }
    return closed
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
    } else if (d.type === 'copy' && typeof d.text === 'string') {
      const text = d.text.slice(0, 100000)
      rt.selection = text
      const r = await $.ui.copy({ text, surface: e.surface })
      $.ui.toast(r.isCopied ? `copied ${text.length} characters` : `could not copy: ${r.reason}`)
    } else if (d.type === 'label-open' && typeof d.slug === 'string') {
      // a press on a card's label row (its name or its ↗): the label's panel, under its name
      await navOrigin(cx, inPanel)
      if (!(await surfaceValue(cx, 'labels'))?.ok) await readSurface(cx, 'labels', 'labels')
      const got = await surfaceValue(cx, 'labels')
      const hit = got?.ok ? labelsOf(got.value).find(l => l.id === d.slug || l.name === d.slug) : undefined
      await openLabel(cx, hit?.id ?? d.slug, hit?.name ?? d.slug)
    } else if (d.type === 'field' && typeof d.name === 'string' && typeof d.text === 'string') {
      // a field's words (field.tsx): a draft, or a save
      await fieldMessage(cx, d.name, d.text.slice(0, 20000), d.save === true)
    } else if (d.type === 'files-open' && typeof d.path === 'string') {
      await openFile(cx, d.path)
    }
    return next(e)
  })
}
