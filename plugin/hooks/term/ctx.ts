// What the hooks share of the engine with the terminal UI's other files: the host calls they make and the state values
// they read and write, each a function bound to the `$` of the hook that made it (cxOf). A drawing builds its own (its
// reads subscribe it); a timer or a handler uses the one its hook built. `$` goes only into cxOf, which register.tsx
// and band.tsx call.
import { atom, update } from 'claude-code'
import type { Elements, EngineInterface, FsEntry, FsStat, HttpInit, HttpResponse, PaneOpenArgs, ProcessRunInit, ProcessRunResult, RenderElement, ResolveInput, UiOpenResult } from 'claude-code'

import type { ChatHomeUi, ChatNav, ChatNews, ChatSignal, TermAgent, TermAnswer, TermCard, TermFilesUi, TermHome, TermLabelUi, TermPanel, TermPending, TermThread, TermThreadRow, TermVerdict } from './types'
import { HOME_UI_EMPTY } from './home'
import { keepRow } from './kept'
import { NAV_EMPTY } from './nav'
import { FILES_UI_EMPTY, LABEL_UI_EMPTY, PANEL, rt } from './term'

type Dollar = EngineInterface

/** What `thimble state` printed for a surface the panel shows, or why it failed. */
export type SurfaceGot = { ok: true; value: unknown } | { ok: false; error: string }

export type Ctx = {
  // ---- the host
  now: () => Promise<number>
  /** Claude Code's theme as a view's program hears it: `light` for a light theme, else `dark` */
  theme: () => Promise<'dark' | 'light'>
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
  /** `fn` once, `ms` from now, beside the hook that asked */
  later: (ms: number, fn: () => void) => void
  log: (text: string) => void
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
  filesUi: () => Promise<TermFilesUi>
  setFilesUi: (u: TermFilesUi) => Promise<void>
  /** a count a drawing of the panel reads, so a bump draws it again */
  panelTick: () => Promise<number>
  bumpPanel: () => Promise<void>
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
const filesUiRef = { plugin: 'thimble', key: 'filesUi' } as const
const panelTickRef = { plugin: 'thimble', key: 'panelTick' } as const
const panelTickA = atom(panelTickRef, 0)

/** The context the other files take, bound to a hook's `$`: every file that registers hooks builds it here, since a
 *  hooks module passes `$` only to a function declared in its own file or imported from one of the module's files. */
export function cxOf($: Dollar): Ctx {
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
