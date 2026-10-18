// The shell's values in $.state (the session's, kept across a reload of the hooks module).

/** One object as the shell points at it: its id, its version (null: the latest) and the folder that holds it. */
export type ObjRef = { id: string; v: number | null; root: string }

/** What the detail view shows: the object, the selected region, which example, and whether `? all` is open; the
 *  knobs' values the person set (`state`) and the knob turned last; or, with `cite`, one citation of Claude's words
 *  and the rows behind it; or, with `cites`, the values a reply cites, each a press from its rows. */
export type Sel = ObjRef & { region: string | null; ex: number; all: boolean; cite?: string | null; cites?: { ref: string; label: string }[]; state?: Record<string, unknown>; knob?: string | null }

/** A verb's run, as the /verb command's row draws it. */
export type Ran = { verb: string; text?: string; note?: string; ask?: string; error?: string; saved?: ObjRef | null; on?: string }

/** A verb running on an object (the hint row says so), or what it said last (the detail view shows it). */
export type Said = { verb: string; text?: string; error?: string; running?: boolean }

/** The browser page's server: its base URL (token included), or why there is none. */
export type Web = { base?: string; root?: string; problem?: string; opened?: string }

declare module 'claude-code' {
  interface PluginState {
    'thimble-lean': {
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
      /** the verbs' latest requests to Claude (the head of each one's words): their rows read as one line */
      asks: { head: string; verb: string; on: string }[]
      /** `lean resolve --json` of a ref, by root and ref */
      rows: StateFamily<unknown>
      web: Web
      /** when an object's drawing at a width became ready, by root, id, version and width: a drawing waiting on it redraws */
      ready: StateFamily<number>
    }
  }
}
