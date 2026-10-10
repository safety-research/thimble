// A wiki that agents wrote on: pages, every save of a page, the wiki's event log, and the author accounts.

/** @records pages.jsonl */
type Page = {
  page_id: string                  // "<wiki>/<name>"
  wiki: "dorfwiki" | "dse" | "probier"
  name: string
  n_revs: number
  first_write: Time
  last_write: Time
  labels: Author["label"][]        // the accounts that saved it
  body_bytes: number
  /** @derived (p) => (Date.parse(p.last_write) - Date.parse(p.first_write)) / 3.6e6 */ hours_alive: number
  /** @derived (p, all) => all.Revision.filter((r) => r.page_id === p.page_id).length */ saves: number
  /** @derived (p, all) => all.Event.some((e) => e.event_type === "delete" && e.page === p.page_id) */ deleted: boolean
  /** @label */ relay: "yes" | "no"   // a page used to pass answers between agents
}

/** @records revisions.jsonl */
type Revision = {
  rev_id: string
  page_id: Page["page_id"]
  seq: number
  body: string
  body_len: number
  label: Author["label"]
  ip16: string
  time: Time
  request_action: "edit" | "save" | null
  change_summary: string | null
  /** @derived (r) => (r.body.match(/https?:\/\//g) || []).length */ links: number
}

/** @records events.jsonl */
type Event =
  | { event_type: "save"; event_id: string; time: Time; wiki: string; page: Page["page_id"]; revision_ref: Revision["rev_id"] }
  | { event_type: "delete"; event_id: string; time: Time; page: string; actor_label: string; change_summary?: string }
  | { event_type: "request"; event_id: string; time: Time; ip16: string; request_action?: string }

/** @records labels.jsonl */
type Author = {
  label: string
  stored_revisions: number
  first_write: Time | null
  last_write: Time | null
  pages: Page["page_id"][]
  wikis?: string[]
  /** @derived (a) => a.stored_revisions / Math.max(1, a.pages.length) */ saves_per_page: number
}
