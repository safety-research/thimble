// The shell's values in $.state (the session's, kept across a reload of the hooks module).

/** One object as the shell points at it: its id, its version (null: the latest) and the folder that holds it. */
export type ObjRef = { id: string; v: number | null; root: string }

/** What the detail view shows: the object, the selected region, which example, and whether `? all` is open; or, with
 *  `cite`, one citation of Claude's words and the rows behind it. */
export type Sel = ObjRef & { region: string | null; ex: number; all: boolean; cite?: string | null }

/** A verb's run, as the /verb command's row draws it. */
export type Ran = { verb: string; text?: string; note?: string; ask?: string; error?: string; saved?: ObjRef | null; on?: string }

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
      /** a verb's run, by the /verb command's arguments */
      ran: StateFamily<Ran>
      /** `lean resolve --json` of a ref, by root and ref */
      rows: StateFamily<unknown>
      web: Web
      /** when an object's drawing at a width became ready, by root, id, version and width: a drawing waiting on it redraws */
      ready: StateFamily<number>
    }
  }
}
