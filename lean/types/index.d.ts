// The shell's values in $.state (the session's, kept across a reload of the hooks module).

/** One object as the shell points at it: its id, its version (null: the latest) and the folder that holds it. */
export type ObjRef = { id: string; v: number | null; root: string }

/** What the detail view shows: the object, the selected region (its part), which example, and whether `? all` is open;
 *  the knobs' values the person set (`state`) and the knob turned last; `prog` while the program is laid over the card
 *  (`p`); or, with `cite`, one citation of Claude's words and the rows behind it; or, with `cites`, the values a reply
 *  cites, each a press from its rows. */
export type Sel = ObjRef & { region: string | null; ex: number; all: boolean; cite?: string | null; cites?: { ref: string; label: string }[]; state?: Record<string, unknown>; knob?: string | null; prog?: boolean; pages?: 'all' | 'one' }

/** A verb's run, as the /verb command's row draws it. */
export type Ran = { verb: string; text?: string; note?: string; ask?: string; error?: string; saved?: ObjRef | null; on?: string; failed?: boolean }

/** A verb running on an object (the row under it says `<verb>… <text>`, its progress), or what it said last. */
export type Said = { verb: string; text?: string; error?: string; running?: boolean }

/** The hint row of one object version as the observer ranked it: its 2-3 verbs, each with a few words for this object. */
export type Ranking = { verbs: { verb: string; phrase?: string }[]; at: number; by: 'observer' }

/** The observer's one line above the prompt: the line, then (after Learn more) its explanation, written already. */
export type ObserverLine = {
  kind: 'offer' | 'explained'
  line: string
  title: string
  explanation: string
  decision: string
  shownAt: number
  /** prompts the person submitted while it was open: it clears at the second */
  prompts: number
}

/** One mark in a message (CONTRACT 1): a citation, a gloss or a sparkline, as offsets into the shown markdown. */
export type Mark = { kind: 'cite' | 'gloss' | 'spark'; start: number; end: number; ref?: string; label?: string; gloss?: string; values?: number[] | null; problem?: string; loose?: boolean; anchor?: 'form' | 'word' }

/** A gloss the observer wrote for a message: the term as it stands in the text, what it is, where it mattered here. */
export type Gloss = { term: string; title?: string; body?: string; here?: string; program?: string; refs?: string[] }

/** The record of one of Claude's messages (CONTRACT 1), kept in thimble/messages/<session>/<row>.json. */
export type MsgRecord = {
  v: 1
  row: string
  /** the row's whole id, as the transcript's drawing names it (e.requestId) */
  uuid?: string
  session: string
  at?: string | null
  text: string
  shown: string | null
  marks: Mark[]
  glosses: Record<string, Gloss>
  verbs: Record<string, { lit?: boolean; note?: string; proposals?: string[]; chips?: unknown[]; offer?: unknown }>
  objects: string[]
  /** the turn's answer: the row its verb row is drawn under */
  final?: boolean
  /** the squeeze chips' state (verbs/squeeze/chips.mjs): the levels set, the person's own chips, the versions written */
  squeeze?: Squeeze
  /** a catch-up's own record (it is no row of the transcript): what it covers, drawn under `host` */
  catchup?: CatchUp
  /** the catch-up drawn under this answer: the newest written when this was the newest reply */
  caughtUp?: string
}

/** A catch-up: one message the squeeze chips write of Claude's messages since the person's last prompt (`rows`, in
 *  order; `replies` of them ended a turn), drawn under the newest reply (`host`). `question` is the person's prompt,
 *  `prompt` its row. A dismissed one is drawn no more; one that showed a version counts as read. */
export type CatchUp = { host: string; rows: string[]; replies: number; question: string; prompt: string | null; dismissed?: boolean }

/** A message's squeeze: where its chips are, the person's stretches, every version written by its levels, the
 *  original's marks, whether it arrived squeezed, what a rewrite said that the original does not, and each call made. */
export type Squeeze = {
  at?: Record<string, number>
  own?: { id: string; kind?: 'stretch'; from: string; to: string }[]
  versions?: Record<string, string>
  orig?: { marks: Mark[] }
  auto?: boolean
  problems?: string[]
  made?: { key: string; ms: number; model: string; usage?: unknown; at?: string }[]
}

/** The chips' line of one message as the person works it: the picked chip, whether they type a stretch (and what
 *  they typed), a call running (and the frame of its turning glyph), a call that failed, and the new text writing
 *  itself in (`reveal.n` of its characters shown), and the levels a change on its way goes to (`want`). */
export type SqzUi = { focus: string; adding: boolean; running: { since: number } | null; error: string | null; tick: number; typing?: string; reveal?: { n: number; total: number } | null; want?: Record<string, number> | null }

/** The thimble line's counts, as last counted (`cov` the share of the folder's data read, 0 to 1), and when each
 *  changed (it brightens for a moment). */
export type LineCounts = { cards: number; threads: number; cites: number; claims: number; cov: number; at: number; changed: Record<string, number> }

/** One card of the tray: a mark of a message (with what it shows: its ref and words, or its gloss), or a citation
 *  inside a card (panes/tray.js frameOf). */
export type TrayFrame = { row?: string; i?: number; ref?: string; label?: string; kind?: 'cite' | 'spark' | 'gloss'; gloss?: Record<string, unknown> }

/** The tray: the stack of cards it shows, the top one drawn; `asking` once 1 was pressed (its footer says how to ask). */
export type Tray = { stack: TrayFrame[]; asking?: boolean }

/** Browser mode (`on`, the `browser` setting) and its page server: its base URL (token included), the page opened
 *  last, why there is none, or why it stopped on its own (no page open). */
export type Web = { on?: boolean; base?: string; root?: string; problem?: string; opened?: string; stopped?: string }

declare module 'claude-code' {
  interface PluginState {
    'thimble': {
      /** the objects drawn under a row of the transcript, by the row's id (its first 24 characters) */
      under: StateFamily<ObjRef[]>
      /** the detail view's selection */
      sel: Sel | null
      /** the latest object drawn, which /obj opens with no argument */
      last: ObjRef | null
      /** the object and region a prompt was asked about, by the prompt row's id */
      asked: StateFamily<{ id: string; v: number | null; region: string | null; label: string }>
      /** a verb running on an object, or what it said last, by the object's id */
      said: StateFamily<Said | null>
      /** words for Claude alone, given with the next prompt */
      notes: string[]
      /** the row an object is drawn under, by the object's id: a verb's object is drawn under the same row */
      where: StateFamily<string>
      /** `thimble resolve --json` of a ref, by root and ref */
      rows: StateFamily<unknown>
      web: Web
      /** when an object's drawing at a width became ready, by root, id, version and width: a drawing waiting on it redraws */
      ready: StateFamily<number>
      /** the observer's ranking of an object version's hint row, by root, id and version */
      ranked: StateFamily<Ranking | null>
      /** the observer's line above the prompt, or none */
      line: ObserverLine | null
      /** each message's record, by its row key */
      msg: StateFamily<MsgRecord | null>
      /** the rows of Claude's messages in this session, oldest first */
      msgrows: string[]
      /** the tray above the prompt, or none */
      tray: Tray | null
      /** the line a verb opened under a message's verb row, or none */
      /** the line a verb opened under a message's verb row (c opens the Claims pane instead), or none */
      pick: { row: string; verb: string; open?: string | null } | null
      /** the message the keys act on, when the person picked one other than the latest */
      selrow: string | null
      /** the row of the latest turn's answer */
      answer: string | null
      /** the rows of the session's answers (each turn's last words, a turn that ended in an error left out), oldest first */
      answers: string[]
      /** the card under a reply that has the keys (] reached it): its own keys win over the verbs until 0 */
      cardfocus: (ObjRef & { row: string }) | null
      /** a verb of the row running on a message, by its row */
      running: StateFamily<string | null>
      /** the verbs of the row, as the registry lists them */
      rowverbs: { key: string; name: string; color?: unknown }[] | null
      /** the squeeze chips' line of a message, by its row */
      sqz: StateFamily<SqzUi | null>
      /** what Claude reads with the next prompt of the version the person reads now, by row */
      sqznote: Record<string, string>
      /** the thimble line's counts above the prompt */
      counts: LineCounts | null
      /** where a card's values come from (object.js fromFacts), by root, id and version: the detail's "from" line */
      facts: StateFamily<unknown>
      /** a side thread (shell/thread.ts), by its key: its scope, its agent, its questions and turns */
      thread: StateFamily<unknown>
      /** the turns whose failed look the observer runs again now (observer.ts readAgain): the Claims pane says so */
      reread: number[]
      /** this session's claims (CONTRACT 7), as held for the drawing; thimble/claims/<session>.json on disk */
      claims: Record<string, unknown> | null
      /** a turn's prompt row, its number and Claude's message rows, by turn id: where its claims were said */
      turns: StateFamily<{ prompt: { row: string; text: string } | null; rows: string[]; turn: number | null } | null>
      /** the Claims pane: the message it was opened from, the claim the ring is on (its card shows), and the replay
       *  while one grows the graph (how many of the claims, in the order made, are shown) */
      claimpane: { row: string; focus: string | null; replay: { gen: number; k: number; order: string[] } | null } | null
      /** how far this session's change feed ($THIMBLE_HOME/lean/events/<session>.jsonl) has been read */
      events: { file: string; n: number; bytes?: number }
      /** what takes the keys, newest last (the shell's focus stack): the thimble line says the keys of the top one */
      focus: ('detail' | 'claims' | 'chips' | 'proposals' | 'tray' | 'card')[]
      /** when a card's state file last changed, by root and id: a drawing that reads the card's state draws again */
      cardver: StateFamily<number>
      /** how many times a pane was asked to draw again, by the pane's instance: its drawings read it */
      panever: StateFamily<number>
      /** how many checks of label values the person has made (shell/labels.ts): the examples read their labels again */
      labelgen: number
      /** the labels of a set of records, by folder, generation and refs (`thimble label --of`) */
      labelsof: StateFamily<unknown>
    }
  }
}
