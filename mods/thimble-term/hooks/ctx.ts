// What register.tsx shares of the engine with thimble-term's other files (`$` itself never crosses an import): the host
// calls they make and the state values they read and write, each a function bound to the `$` of the hook that made it.
// A drawing builds its own (its reads subscribe it); a timer or a handler uses the one its hook built.
import type { Elements, FsEntry, FsStat, PaneOpenArgs, ProcessRunInit, ProcessRunResult, RenderElement, ResolveInput, UiOpenResult } from 'claude-code'

import type { ChatHomeUi, ChatNav, ChatNews, ChatSignal, TermAgent, TermAnswer, TermCard, TermFilesUi, TermHome, TermLabelUi, TermPanel, TermThread, TermThreadRow, TermVerdict } from '../types'

/** What `thimble state` printed for a surface the panel shows, or why it failed. */
export type SurfaceGot = { ok: true; value: unknown } | { ok: false; error: string }

export type Ctx = {
  // ---- the host
  now: () => Promise<number>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  /** a command that may run longer than `run` allows (a label's run on every record): started beside the session, which
   *  it ends with, its whole output read once it exits */
  runLong: (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string> }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
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
  /** the panel's focus ring onto one of its elements, by its key, while the pane holds the keys: true once the ring is
   *  there (moved, or there already) */
  focus: (key: string) => Promise<boolean>
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
  pending: () => Promise<{ title: string } | null>
  setPending: (p: { title: string } | null) => Promise<void>
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
