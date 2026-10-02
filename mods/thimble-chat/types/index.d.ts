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

/** A verification script for one citation: written by a forked subagent, then run by the mod. */
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

/** A citation (by its id) or a card (`card-<id>`) a fix round works on: `fixing` while its subagent runs, then `fixed`
 *  or `failed` with why. */
export type ChatFix = { state: string; why?: string }

/** One passage a fix round asks to correct: the reply's text as it stands (a sentence, or a card's embed line), what
 *  is wrong in it, and the citations whose chips follow it. */
export type ChatFixItem = { old: string; problems: { raw: string; why: string }[]; cites: string[]; card?: string }

/** A subagent the mod started: a side thread's, a fix round's or a verification's, with what its end updates. */
export type ChatAgent = { kind: string; label: string; thread?: string; cite?: string; items?: ChatFixItem[]; reply?: string; endRow?: string }

/** A passage of a reply a fix round corrected: drawn as `new` in place of `old`, unmarked. */
export type ChatCorrection = { old: string; new: string; at: number }

/** The last text row of an answer, which carries the answer's summary line. */
export type ChatEnd = { ids: string[]; cards: string[]; file: string }

/** What a gesture acts on (hooks/gestures.tsx): `ref` the place it cites (bare, or a whole `[[value|ref]]`), `text` its
 *  shown value or its words, `cardId` the card it is on, `script` that card's script. */
export type ChatTarget = { kind: 'card' | 'mark' | 'sentence' | 'citation' | 'row' | 'record' | 'node'; ref?: string; text?: string; cardId?: string; script?: string }

declare module 'claude-code' {
  interface PluginState {
    'thimble-chat': {
      verdicts: StateFamily<ChatVerdict>
      verify: StateFamily<ChatVerify>
      open: string
      turn: ChatTurn | null
      hidden: string
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
      fixes: StateFamily<ChatFix>
      agents: StateFamily<ChatAgent>
      corrections: ChatCorrection[]
      menu: ChatTarget | null
    }
  }
}
