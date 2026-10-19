// What the hooks share of the engine with the terminal UI's other files: the host calls they make and the state values
// they read and write, each a function bound to the `$` of the hook that made it (cxOf). A drawing builds its own (its
// reads subscribe it); a timer or a handler uses the one its hook built. `$` goes only into cxOf, which register.tsx
// and band.tsx call.
import { atom, update } from 'claude-code'
import type { Elements, EngineInterface, FsEntry, FsStat, HttpInit, HttpResponse, McpToolResult, PaneOpenArgs, ProcessRunInit, ProcessRunResult, RenderElement, ResolveInput, UiOpenResult } from 'claude-code'

import type { ChatHomeUi, ChatNav, ChatNews, ChatSignal, LabelUnsure, Links, Pressing, SummarySeen, TermAgent, TermAnswer, TermCard, TermFilesUi, TermHome, TermLabelRuns, TermLabelUi, TermPanel, TermPending, TermThread, TermThreadRow, TermVerdict } from './types'
import { HOME_UI_EMPTY } from './home'
import { keepRow, keepSession } from './kept'
import type { KeptRow } from './kept'
import { NAV_EMPTY } from './nav'
import { themeFrom } from './paint'
import type { Theme } from './paint'
import { FILES_UI_EMPTY, LABEL_UI_EMPTY, PANEL, rt } from './term'
import type { Activated, AnswerComment, CiteRow, CoverageSummary, FeatureSettings } from './contracts'
import { bridgeActivated } from '../thimble'

type Dollar = EngineInterface

/** What `thimble state` printed for a surface the panel shows, or why it failed. */
export type SurfaceGot = { ok: true; value: unknown } | { ok: false; error: string }

export type Ctx = {
  // ---- the host
  now: () => Promise<number>
  /** The theme Claude Code draws in (paint.ts themeFrom), from its /config `theme` row or `setting` when given (a
   *  change not written yet); null when thimble cannot tell (`auto` with nothing that says the terminal's background) */
  theme: (setting?: unknown) => Promise<Theme | null>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  /** a command that may run longer than `run` allows (a label's run on every record): started beside the session, which
   *  it ends with, its whole output read once it exits */
  runLong: (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string> }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** a command beside the session that runs on (thimble's view host): each line it prints, then `done` as it ends;
   *  `stop` ends it */
  spawnLines: (argv: readonly string[], init: { cwd?: string; env?: Record<string, string> }, onLine: (line: string) => void, onErr?: (text: string) => void) => { stop: () => void; done: Promise<void> }
  /** an HTTP request through the host, over a Unix socket with `socketPath` (thimble's view host) */
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  read: (path: string) => Promise<string>
  /** a file written whole, its folders made (the workspace's terminal/chat.json, kept.ts) */
  write: (path: string, text: string) => Promise<void>
  stat: (path: string) => Promise<FsStat>
  list: (path: string) => Promise<FsEntry[]>
  env: (name: string) => Promise<string | undefined>
  /** the session's folder: the corpus */
  root: () => Promise<string>
  /** this plugin's folder */
  pluginRoot: string
  open: (args: PaneOpenArgs) => Promise<UiOpenResult>
  close: (id: string) => Promise<void>
  /** this plugin's open panes as the engine records them: placed, and holding the keyboard */
  panes: () => Promise<readonly { id: string; isPlaced: boolean; isFocused?: boolean }[]>
  /** `fn` once, `ms` from now, beside the hook that asked; `cancel()` before then stops it */
  later: (ms: number, fn: () => void) => { cancel: () => void }
  log: (text: string) => void
  /** a line of the debug log only (never the transcript) */
  debug: (text: string) => void
  toast: (text: string) => void
  /** a prompt to main, as the analyst's (a code label's run, which only main's Bash runs; a new label described) */
  submit: (text: string) => Promise<void>
  /** a slash command run as if the analyst typed it (a plugin's skill, such as `thimble:write`) */
  command: (name: string, args: string) => Promise<void>
  /** the prompt box's draft */
  promptText: () => Promise<string>
  /** text typed into the prompt box at its cursor, as the person's typing (a key the panel does not bind) */
  fill: (text: string) => Promise<void>
  /** the panel's focus ring onto one of its elements, by its key, while the pane holds the keys: true once the ring is
   *  there (moved, or there already) */
  focus: (key: string) => Promise<boolean>
  /** the panel's element drawn with `key` scrolled into view, `block` saying where it lands (a document's chosen
   *  comment) */
  scroll: (key: string, block?: 'start' | 'center' | 'end' | 'nearest') => Promise<void>
  /** the element table of the surface a drawing is for */
  els: (e: ResolveInput) => Elements['terminal']
  // ---- thimble-term's state (types/index.d.ts)
  card: (id: string) => Promise<TermCard | undefined>
  setCard: (id: string, v: TermCard) => Promise<void>
  turnCards: (row: string) => Promise<string[]>
  setTurnCards: (row: string, ids: string[]) => Promise<void>
  verdict: (id: string) => Promise<TermVerdict | undefined>
  setVerdict: (id: string, v: TermVerdict) => Promise<void>
  thread: (id: string) => Promise<TermThread | undefined>
  setThread: (id: string, v: TermThread) => Promise<void>
  threadRows: (row: string) => Promise<ChatSignal[]>
  setThreadRows: (row: string, rows: ChatSignal[]) => Promise<void>
  answer: (row: string) => Promise<TermAnswer | undefined>
  setAnswer: (row: string, a: TermAnswer) => Promise<void>
  viewRows: (row: string) => Promise<string[]>
  setViewRows: (row: string, slugs: string[]) => Promise<void>
  surface: (key: string) => Promise<SurfaceGot | undefined>
  setSurface: (key: string, v: SurfaceGot) => Promise<void>
  panel: () => Promise<TermPanel | null>
  setPanel: (p: TermPanel | null) => Promise<void>
  nav: () => Promise<ChatNav>
  setNav: (n: ChatNav) => Promise<void>
  pending: () => Promise<TermPending | null>
  setPending: (p: TermPending | null) => Promise<void>
  home: () => Promise<TermHome | null>
  setHome: (h: TermHome | null) => Promise<void>
  homeSeen: () => Promise<TermHome | null>
  setHomeSeen: (h: TermHome | null) => Promise<void>
  agents: () => Promise<TermAgent[]>
  setAgents: (a: TermAgent[]) => Promise<void>
  threads: () => Promise<TermThreadRow[]>
  setThreads: (t: TermThreadRow[]) => Promise<void>
  news: () => Promise<ChatNews>
  setNews: (n: ChatNews) => Promise<void>
  homeUi: () => Promise<ChatHomeUi>
  setHomeUi: (u: ChatHomeUi) => Promise<void>
  labelUi: () => Promise<TermLabelUi>
  setLabelUi: (u: TermLabelUi) => Promise<void>
  /** the labels' runs going on in any process, from their run files (term.ts runsLane) */
  labelRuns: () => Promise<TermLabelRuns>
  setLabelRuns: (r: TermLabelRuns) => Promise<void>
  filesUi: () => Promise<TermFilesUi>
  setFilesUi: (u: TermFilesUi) => Promise<void>
  /** a count a drawing of the panel reads, so a bump draws it again */
  panelTick: () => Promise<number>
  bumpPanel: () => Promise<void>
  // ---- 0.9.0: activation, the guide, settings (activate.ts, settings.ts)
  /** this conversation's id, read per call (a /clear changes it) */
  sessionId: () => Promise<string>
  /** a path's stat with where it lands (`realPath`, links followed), or undefined when it cannot be read */
  real: (path: string) => Promise<FsStat | undefined>
  /** a tool of one of the session's MCP servers, called as the plugin (thimble's shim: `load_thimble`) */
  mcp: (server: string, tool: string, args: Record<string, unknown>) => Promise<McpToolResult>
  /** a hidden user row in main's conversation, which the model reads: whether the session stored it */
  append: (text: string) => Promise<{ stored: boolean; reason?: string }>
  /** this plugin's store, kept between sessions (`settings.synced`, the folders that had their toast) */
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  /** a /config row set as a person would (a thimble switch changed in the browser); `deny` when it was refused */
  configSet: (key: string, value: boolean) => Promise<{ deny?: string }>
  /** `fn` every `ms`, for the rest of the module's life */
  every: (ms: number, fn: () => void) => void
  /** thimble.ts told of an activation, so it registers thimble's agent types and turns its bridge on (C13) */
  bridge: (a: Activated) => Promise<void>
  /** what a kind of drawing draws asked again (the band once thimble turns on, /thimble's description) */
  invalidate: (what: 'ui.render' | 'command.describe') => void
  activated: () => Promise<Activated | null>
  setActivated: (a: Activated | null) => Promise<void>
  settings: () => Promise<FeatureSettings | undefined>
  setSettings: (s: FeatureSettings) => Promise<void>
  coverageSummary: () => Promise<CoverageSummary | null>
  setCoverageSummary: (s: CoverageSummary | null) => Promise<void>
  citeIndex: () => Promise<CiteRow[]>
  setCiteIndex: (rows: CiteRow[]) => Promise<void>
  answerComments: () => Promise<AnswerComment[]>
  setAnswerComments: (c: AnswerComment[]) => Promise<void>
  checksRunning: () => Promise<number>
  setChecksRunning: (n: number) => Promise<void>
  /** the comment the panel's Checks view shows (the panel lane writes it) */
  checksOpen: () => Promise<string | null>
  // ---- 0.9.0, the panel's (C13): the comment open in the Checks view, the labels' unsure counts, the summary line's
  // seen counts, a press while it runs, the remote rows' commands, and the clipboard
  setChecksOpen: (id: string | null) => Promise<void>
  labelUnsure: () => Promise<LabelUnsure[]>
  setLabelUnsure: (rows: LabelUnsure[]) => Promise<void>
  seen: () => Promise<SummarySeen | null>
  setSeen: (s: SummarySeen | null) => Promise<void>
  pressing: () => Promise<Pressing | null>
  setPressing: (p: Pressing | null) => Promise<void>
  links: () => Promise<Links | null>
  setLinks: (l: Links | null) => Promise<void>
  /** text on the clipboard of the surface the person uses: whether it was copied, else why not */
  copy: (text: string) => Promise<{ isCopied: boolean; reason?: string }>
  /** the main conversation's transcript back in view, from an agent's (a press's: `$.ui.view({})`); '' once it shows,
   *  else why not */
  viewMain: () => Promise<string>
  /** what kept.ts kept under a row put back in the state where the state holds none (no write of the file) */
  restoreRow: (row: string, r: KeptRow) => Promise<void>
}

export type { RenderElement }

// the state the drawings read (types/index.d.ts)
const CARDS = { plugin: 'thimble', key: 'cards' } as const
const TURN_CARDS = { plugin: 'thimble', key: 'turnCards' } as const
const VERDICTS = { plugin: 'thimble', key: 'verdicts' } as const
const THREAD = { plugin: 'thimble', key: 'thread' } as const
const THREAD_ROWS = { plugin: 'thimble', key: 'threadRows' } as const
const ANSWERS = { plugin: 'thimble', key: 'answers' } as const
const VIEW_ROWS = { plugin: 'thimble', key: 'viewRows' } as const
const SURFACE = { plugin: 'thimble', key: 'surface' } as const
const panelA = { plugin: 'thimble', key: 'panel' } as const
const navRef = { plugin: 'thimble', key: 'nav' } as const
const pendingRef = { plugin: 'thimble', key: 'pending' } as const
const homeRef = { plugin: 'thimble', key: 'home' } as const
const homeSeenRef = { plugin: 'thimble', key: 'homeSeen' } as const
const agentsRef = { plugin: 'thimble', key: 'agents' } as const
const threadsRef = { plugin: 'thimble', key: 'threads' } as const
const newsRef = { plugin: 'thimble', key: 'threadNews' } as const
const homeUiRef = { plugin: 'thimble', key: 'homeUi' } as const
const labelUiRef = { plugin: 'thimble', key: 'labelUi' } as const
const labelRunsRef = { plugin: 'thimble', key: 'labelRuns' } as const
const filesUiRef = { plugin: 'thimble', key: 'filesUi' } as const
const panelTickRef = { plugin: 'thimble', key: 'panelTick' } as const
const panelTickA = atom(panelTickRef, 0)
const activatedRef = { plugin: 'thimble', key: 'activated' } as const
const settingsRef = { plugin: 'thimble', key: 'settings' } as const
const coverageSummaryRef = { plugin: 'thimble', key: 'coverageSummary' } as const
const citeIndexRef = { plugin: 'thimble', key: 'citeIndex' } as const
const answerCommentsRef = { plugin: 'thimble', key: 'answerComments' } as const
const checksRunningRef = { plugin: 'thimble', key: 'checksRunning' } as const
const checksOpenRef = { plugin: 'thimble', key: 'checksOpen' } as const
const labelUnsureRef = { plugin: 'thimble', key: 'labelUnsure' } as const
const seenRef = { plugin: 'thimble', key: 'seen' } as const
const pressingRef = { plugin: 'thimble', key: 'pressing' } as const
const linksRef = { plugin: 'thimble', key: 'links' } as const

/** The context the other files take, bound to a hook's `$`: every file that registers hooks builds it here, since a
 *  hooks module passes `$` only to a function declared in its own file or imported from one of the module's files. */
export function cxOf($: Dollar): Ctx {
  // what main's chat draws under a row is kept in the workspace too, so a resumed session draws it again (kept.ts)
  const io = { read: (path: string) => $.fs.read(path), write: (path: string, text: string) => $.fs.write(path, text) }
  const keep = async (row: string, part: Parameters<typeof keepRow>[3]) => (rt.sc ? keepRow(io, rt.sc.ws, row, part) : undefined)
  return {
    now: () => $.clock.now().catch(() => Date.now()),
    theme: async setting => {
      try {
        const s = String(setting ?? (await $.config.list()).find(r => r.key === 'theme')?.value ?? '').trim()
        // `auto` follows the terminal: Claude Code's own fallback when it cannot ask the terminal is COLORFGBG
        const fgbg = s === 'auto' ? await $.env.get('COLORFGBG').catch(() => undefined) : undefined
        // a custom theme is its file's base (`<config>/themes/<slug>.json`, as /theme writes it)
        let base: string | undefined
        if (s.startsWith('custom:') && !s.endsWith(')')) {
          const dir = (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) || `${(await $.env.get('HOME').catch(() => undefined)) ?? ''}/.claude`
          const file = await $.fs.read(`${dir.replace(/\/+$/, '')}/themes/${s.slice('custom:'.length)}.json`).catch(() => '')
          try {
            const b = (JSON.parse(String(file || '{}')) as { base?: unknown }).base
            base = typeof b === 'string' ? b : undefined
          } catch {
            base = undefined
          }
        }
        return themeFrom(s, fgbg, base)
      } catch {
        return null
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
        case 'THIMBLE_OPEN':
          return $.env.get('THIMBLE_OPEN')
        case 'HOME':
          return $.env.get('HOME')
        case 'CLAUDE_CONFIG_DIR':
          return $.env.get('CLAUDE_CONFIG_DIR')
        case 'CLAUDE_CODE_SESSION_KIND':
          return $.env.get('CLAUDE_CODE_SESSION_KIND')
        default:
          return undefined
      }
    },
    root: () => $.session.root().catch(() => $.session.cwd()),
    pluginRoot: $.plugin.root,
    open: args => $.ui.open(args),
    close: id => $.ui.close({ id }),
    panes: () => $.ui.panes().catch(() => []),
    later: (ms, fn) => $.clock.after(ms, fn),
    // a line or a toast after the session ended is lost, never an unhandled rejection
    log: text => void Promise.resolve($.ui.log(text)).catch(() => undefined),
    debug: text => void Promise.resolve($.ui.log(text, { to: 'debug' })).catch(() => undefined),
    toast: text => void Promise.resolve($.ui.toast(text)).catch(() => undefined),
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
    labelRuns: async () => (await $.state.get(labelRunsRef)).value ?? { live: {}, ended: [] },
    setLabelRuns: async r => void (await $.state.set(labelRunsRef, r)),
    filesUi: async () => ({ ...FILES_UI_EMPTY, ...((await $.state.get(filesUiRef)).value ?? {}) }),
    setFilesUi: async u => void (await $.state.set(filesUiRef, u)),
    panelTick: async () => (await $.state.get(panelTickRef)).value ?? 0,
    bumpPanel: async () => void (await update($, panelTickA, n => (n ?? 0) + 1)),
    sessionId: () => $.session.id(),
    real: path => $.fs.stat(path, { resolve: true }).catch(() => undefined),
    mcp: (server, tool, args) => $.mcp.call(server, tool, args),
    append: async text => {
      const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(err => ({ deny: String(err).slice(0, 200) }))
      return r.deny === undefined ? { stored: true } : { stored: false, reason: r.deny }
    },
    storeGet: key => $.store.get(key).catch(() => undefined),
    storeSet: async (key, value) => void (await $.store.set(key, value).catch(() => undefined)),
    configSet: async (key, value) => {
      const r = await $.config.set({ key, value }).catch(err => ({ deny: String(err).slice(0, 200) }))
      return 'deny' in r && r.deny ? { deny: String(r.deny) } : {}
    },
    every: (ms, fn) => void $.clock.every(ms, fn),
    bridge: a => bridgeActivated($, a),
    invalidate: what => $.ui.invalidate(what),
    activated: async () => (await $.state.get(activatedRef)).value ?? null,
    setActivated: async a => void (await $.state.set(activatedRef, a)),
    settings: async () => (await $.state.get(settingsRef)).value,
    setSettings: async v => void (await $.state.set(settingsRef, v)),
    coverageSummary: async () => (await $.state.get(coverageSummaryRef)).value ?? null,
    setCoverageSummary: async v => void (await $.state.set(coverageSummaryRef, v)),
    citeIndex: async () => (await $.state.get(citeIndexRef)).value ?? [],
    setCiteIndex: async rows => {
      await $.state.set(citeIndexRef, rows)
      // kept by the session's id, so a resumed session counts its answers' citations still (kept.ts)
      const sid = rt.sc ? await $.session.id().catch(() => '') : ''
      if (rt.sc && sid) await keepSession(io, rt.sc.ws, sid, { cites: rows })
    },
    answerComments: async () => (await $.state.get(answerCommentsRef)).value ?? [],
    setAnswerComments: async c => void (await $.state.set(answerCommentsRef, c)),
    checksRunning: async () => (await $.state.get(checksRunningRef)).value ?? 0,
    setChecksRunning: async n => void (await $.state.set(checksRunningRef, n)),
    checksOpen: async () => (await $.state.get(checksOpenRef)).value ?? null,
    setChecksOpen: async id => void (await $.state.set(checksOpenRef, id)),
    labelUnsure: async () => (await $.state.get(labelUnsureRef)).value ?? [],
    setLabelUnsure: async rows => void (await $.state.set(labelUnsureRef, rows)),
    seen: async () => (await $.state.get(seenRef)).value ?? null,
    setSeen: async v => void (await $.state.set(seenRef, v)),
    pressing: async () => (await $.state.get(pressingRef)).value ?? null,
    setPressing: async v => void (await $.state.set(pressingRef, v)),
    links: async () => (await $.state.get(linksRef)).value ?? null,
    setLinks: async v => void (await $.state.set(linksRef, v)),
    viewMain: async () => {
      const r = await $.ui.view({}).catch(err => ({ deny: String(err).slice(0, 200) }))
      return 'deny' in r && r.deny ? String(r.deny) : ''
    },
    copy: async text => {
      const r = await $.ui.copy({ text }).catch(err => ({ isCopied: false as const, reason: String(err).slice(0, 120) }))
      return r.isCopied ? { isCopied: true } : { isCopied: false, reason: String((r as { reason?: unknown }).reason ?? 'not copied') }
    },
    restoreRow: async (row, r) => {
      if (r.cards?.length && !(await $.state.get({ ...TURN_CARDS, id: row })).value?.length) await $.state.set({ ...TURN_CARDS, id: row }, r.cards)
      if (r.answer && !(await $.state.get({ ...ANSWERS, id: row })).value) await $.state.set({ ...ANSWERS, id: row }, r.answer)
      if (r.threads?.length && !(await $.state.get({ ...THREAD_ROWS, id: row })).value?.length) await $.state.set({ ...THREAD_ROWS, id: row }, r.threads)
      if (r.views?.length && !(await $.state.get({ ...VIEW_ROWS, id: row })).value?.length) await $.state.set({ ...VIEW_ROWS, id: row }, r.views)
    },
  }
}
