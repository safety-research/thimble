// A pilot study of thimble: 7 participants (P1..P7), each a screen recording, a speech transcript, and the thimble
// workspace they returned (telemetry of their clicks, their chats with the agent, their notebooks).

/** @records P*/recording.mp4 @file */
type Recording = { _bytes: number; /** @derived (r) => r._path.split("/")[0] */ participant: string }

/** @records P*/transcript.md */
type SpeechLine = {
  text: string
  /** @derived (l) => l._path.split("/")[0] */ participant: string
  /** @derived (l) => (l.text.match(/^\*\*([^*:]+?)( \(\?\))?:\*\*/) || [])[1] || null */ speaker: string | null
  /** @derived (l) => /^\*\*\d\d:\d\d:\d\d\*\*$/.test(l.text.trim()) */ is_timestamp: boolean
}

/** @records P*/return/telemetry.jsonl */
type Click = {
  ts: Time
  seq: number
  actor: "analyst" | "model"
  session: string | null
  kind: "ui-click" | "ui-select" | "tab-activate" | "ask-send" | "file-close" | "visibility" | "error" | "page-load"
      | "notebook-switch" | "report-open" | "label-open" | "cell-edit" | "submit"
  target: string | null
  target_kind: "ui" | "panel" | "chat" | "report" | "file" | "notebook" | "cell" | "concept" | "claim" | null
  detail: Record<string, unknown> | null
  duration_ms: number | null
  /** @derived (c) => c._path.split("/")[0] */ participant: Recording["participant"]
  /** @derived (c, all) => (Date.parse(c.ts) - Math.min(...all.Click.filter((x) => x._path === c._path).map((x) => Date.parse(x.ts)))) / 60000 */ minute: number
}

/** @records P*/return/chats/*.jsonl */
type ChatLine =
  | { type: "user"; text: string; ts: Time; source?: string }
  | { type: "text"; delta: string; ts?: Time }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; content: unknown }
  | { type: "done"; ts: Time; session_id: string | null }

/** @records P*/return/notebook/*.json#/cells */
type Cell = {
  id: string
  notebook: string
  kind: "code" | "markdown" | "note" | "example" | "table" | "plot"
  code?: string | null
  takeaway?: string | null
  outputs?: unknown[]
  /** @derived (c) => c._path.split("/")[0] */ participant: string
}
