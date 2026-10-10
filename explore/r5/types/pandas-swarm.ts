// 16 runs of a 48-agent coding swarm on a pandas PR backlog: each run's manifest, the forge's database, its audit
// log, the message board, and each agent's Claude Code stream.

/** @records runs/*/manifest.json */
type Run = {
  name: string
  condition: "emergent" | "managed"
  models: { worker: string; manager: string }
  n_agents: number
  include_issues: boolean
  wall_clock_hours: number
  counts: { agent_records: number; sessions: number; events: number; board: number }
}

/** @records runs/*/forge.db#prs */
type PR = {
  number: number
  title: string
  author: string                    // "gh:<login>"
  state: "open" | "merged" | "closed"
  claimed_by: Agent["id"] | null
  claimed_at: Time | null
  created_at: Time
  merged_at?: Time | null
  /** @derived (p) => p._path.split("/")[1] */ run: Run["name"]
  /** @derived (p) => p.merged_at && p.claimed_at ? (Date.parse(p.merged_at) - Date.parse(p.claimed_at)) / 60000 : null */ minutes_to_merge: number | null
  /** @derived (p, all) => all.Review.filter((r) => r.pr === p.number && r._path === p._path).length */ reviews: number
}

/** @records runs/*/forge.db#agents */
type Agent = { id: string; role: "worker" | "coordinator" | "manager"; status_text: string; last_seen: Time | null }

/** @records runs/*/forge.db#reviews */
type Review = {
  pr: PR["number"]
  reviewer: Agent["id"]
  verdict: "approve" | "request_changes"
  body: string
  created_at: Time
}

/** @records runs/*/events.jsonl */
type Event = {
  id: number
  ts: Time
  agent: Agent["id"]
  action: "git.fetch" | "board.read" | "pr.show" | "pr.claim" | "pr.list" | "heartbeat" | "pr.review" | "board.post"
        | "git.push" | "pr.merge" | "pr.close" | "pr.comment" | "pr.release"
  params: { pr?: number; [key: string]: unknown }
  /** @derived (e) => e._path.split("/")[1] */ run: Run["name"]
  /** @label */ stuck: "yes" | "no"
}

/** @records runs/*/board.jsonl */
type Post = {
  id: number
  thread_id: number
  thread_title: string
  author: Agent["id"]
  body: string
  created_at: Time
  /** @derived (p) => /REVIEW WANTED/.test(p.body) */ asks_review: boolean
}

/** @records runs/*/agents/*.jsonl */
type StreamLine =
  | { type: "system"; subtype: string; session_id: string }
  | { type: "assistant"; session_id: string; timestamp?: Time;
      message: { model: string; content: Block[]; usage?: { input_tokens: number; output_tokens: number } } }
  | { type: "user"; session_id: string; tool_use_result?: unknown; message: { content: unknown } }
  | { type: "tool_progress"; tool_name: string; elapsed_time_seconds: number }

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; name: "Bash" | "Edit" | "Read"; input: { command?: string; file_path?: string } }
