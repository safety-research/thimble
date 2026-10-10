// 11 Claude Code runs on long ML and software tasks: each run's prompt, its main transcript, its subagents'
// transcripts (most inside workflows), and the results it left.

/** @records */prompt.md @file */
type Prompt = {
  text: string
  /** @derived (p) => p._path.split("/")[0] */ run: string
  /** @derived (p) => p._path.split("/")[0].split("__")[1] */ condition: "specified" | "underspecified" | "specified-fan-out" | "goal"
  /** @derived (p) => p.text.split(/\s+/).length */ words: number
}

/** @records */transcript.jsonl */
type Line =
  | { type: "system"; subtype: "init"; session_id: string; model: string; tools: string[] }
  | { type: "system"; subtype: string }
  | { type: "assistant"; parent_tool_use_id: string | null;
      message: { model: string; content: Block[]; usage: { input_tokens: number; output_tokens: number } } }
  | { type: "user"; message: { content: unknown }; tool_use_result?: unknown }
  | { type: "tool_progress"; tool_name: string; elapsed_time_seconds: number }
  | { type: "result"; subtype: "success" | "error_max_turns" | "error_during_execution"; duration_ms: number;
      num_turns: number; total_cost_usd: number; is_error: boolean }

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }

/** @records **/subagents/**/agent-*.meta.json */
type Subagent = {
  agentType: "general-purpose" | "workflow-subagent" | "Explore" | "Plan"
  description?: string
  spawnDepth: number
  /** @derived (s) => s._path.includes("/workflows/") */ in_workflow: boolean
  /** @derived (s, all) => all.SubagentLine.filter((l) => s._path.endsWith(`agent-${l.agentId}.meta.json`)).length */ lines: number
}

/** @records **/subagents/**/agent-*.jsonl */
type SubagentLine = {
  type: "assistant" | "user" | "attachment"
  agentId: string
  sessionId: string
  timestamp: Time
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  message?: { role: "assistant" | "user"; content: unknown }
}

/** @records */results/*.jsonl */
type ResultRow = { [key: string]: unknown; /** @derived (r) => r._path.split("/")[0] */ run: string }
