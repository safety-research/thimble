// thimble-cc-mod's state contract: every value the hooks module keeps in $.state.

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

/** The citations of main's last reply, for the band, by the key of each claim (cite.ts claimKey). */
export type ChatTurn = { id: string; ids: string[] }

/** A card's script run by the mod (a param picked, or "rerun"): `rev` counts finished runs, so drawings reread it.
 *  `written`: while a picked choice shows, the param values the replies were written for (JSON), else absent. */
export type ChatRun = { rev: number; busy?: string; error?: string; stdout?: string; stderr?: string; exitCode?: number; at?: number; written?: string }

/** One question of a side thread and its answer, while running its tool calls and latest text. */
export type ChatThreadTurn = { q: string; a: string; state: string; tools: number; partial: string }

/** A side thread: what it is about, the subagent answering it, its exchange, and the file it is saved to. */
export type ChatThread = { id: string; label: string; ref: string; context: string; agentId: string; engine: string; turns: ChatThreadTurn[]; file: string }

/** A citation (by its claim's key) or a card (`card-<id>`) a fix round works on: `fixing` while its subagent runs, then `fixed`
 *  or `failed` with why. */
export type ChatFix = { state: string; why?: string }

/** One passage a fix round asks to correct: the reply's text as it stands (a sentence, or a card's embed line), what
 *  is wrong in it, the citations whose chips follow it, and the keys of their claims. */
export type ChatFixItem = { old: string; problems: { raw: string; why: string }[]; cites: string[]; keys?: string[]; card?: string }

/** A text row of main's reply, by its uuid (the `requestId` its drawing gets), as the model wrote it. */
export type ChatRow = { id: string; text: string }

/** A subagent the mod started: a side thread's, a fix round's or a verification's, with what its end updates. A fix
 *  round keeps the turn's rows and its answer's end, so its corrections reach their row and the answer file. */
export type ChatAgent = { kind: string; label: string; thread?: string; cite?: string; items?: ChatFixItem[]; reply?: string; endRow?: string; rows?: ChatRow[]; end?: ChatEnd }

/** A passage of a reply a fix round corrected: drawn as `new` in place of `old`, unmarked, in the row it was made for. */
export type ChatCorrection = { old: string; new: string; at: number; row: string }

/** The last text row of an answer, which carries the answer's summary line: the answer's rows as written, its cards,
 *  and its file with its heading. */
export type ChatEnd = { rows: ChatRow[]; cards: string[]; file: string; head: string }

/** What a gesture acts on (hooks/gestures.tsx): `ref` the place it cites (bare, or a whole `[[value|ref]]`), `text` its
 *  shown value or its words, `cardId` the card it is on, `script` that card's script, `claim` the key of a reply
 *  citation's claim (its sentence and answer). */
export type ChatTarget = { kind: 'card' | 'mark' | 'sentence' | 'citation' | 'row' | 'record' | 'node'; ref?: string; text?: string; cardId?: string; script?: string; claim?: string }

/** A pane a click opened that Claude Code keeps undrawn on a narrow terminal (`why`: its reason), until the person
 *  opens it from the row above the prompt. */
export type ChatWaiting = { id: string; title: string; rows?: number; columns?: number; why: string }

declare module 'claude-code' {
  interface PluginState {
    'thimble-cc-mod': {
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
      waiting: ChatWaiting | null
    }
  }
}
