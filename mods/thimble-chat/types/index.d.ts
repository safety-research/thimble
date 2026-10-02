// thimble-chat's state contract: every value the hooks module keeps in $.state.

/** One line of the place a citation names, as helper/resolve.py read it; `hit` on the cited lines, `spans` where the
 *  shown value stands in them. */
export type ChatLine = { n: number; text: string; hit: boolean; spans?: number[][] }

/** A citation as checked: ok (resolves, and its shown value is there or it shows none), differs (resolves, the value
 *  is not there), missing (does not resolve), unchecked (a whole file), pending (not checked yet). */
export type ChatVerdict = {
  id: string
  raw: string
  ref: string
  display: string | null
  status: string
  why: string
  kind: string
  file?: string
  start?: number
  end?: number
  window: ChatLine[]
  value?: string
  column?: string
  row?: string
  card?: string
  question?: string
  command?: string
  call?: string
}

/** A verification script for one citation: asked of main, then run by the mod. */
export type ChatVerify = {
  id: string
  state: string
  script: string
  expected: string | null
  source?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  result?: string | null
  ranAt?: number
}

/** The citations of main's last reply, for the band. */
export type ChatTurn = { id: string; ids: string[] }

/** A card's script run by the mod (a param picked, or "rerun"): `rev` counts finished runs, so drawings reread it. */
export type ChatRun = { rev: number; busy?: string; error?: string; stdout?: string; stderr?: string; exitCode?: number; at?: number }

/** One question of a side thread and its answer, while running its tool calls and latest text. */
export type ChatThreadTurn = { q: string; a: string; state: string; tools: number; partial: string }

/** A side thread: what it is about, the subagent answering it, its exchange, and the file it is saved to. */
export type ChatThread = { id: string; label: string; ref: string; context: string; agentId: string; engine: string; turns: ChatThreadTurn[]; file: string }

/** The last text row of an answer, which carries the answer's summary line. */
export type ChatEnd = { ids: string[]; cards: string[]; file: string }

declare module 'claude-code' {
  interface PluginState {
    'thimble-chat': {
      verdicts: StateFamily<ChatVerdict>
      verify: StateFamily<ChatVerify>
      open: string
      turn: ChatTurn | null
      hidden: string
      pending: string[]
      paneCard: string
      picked: string
      hover: string
      runs: StateFamily<ChatRun>
      threads: StateFamily<ChatThread>
      thread: string
      threadList: string[]
      ends: StateFamily<ChatEnd>
      band: boolean
      paneMode: string
    }
  }
}
