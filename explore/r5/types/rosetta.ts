// 11 episodes; in each, three engineers (u1, u2, u3) work with an AI coding agent. A file is one engineer's
// conversations: a pool of messages by id, and conversations that list message ids in order.

/** @records */transcripts/*_conversations.json */
type Engineer = {
  agent: "u1" | "u2" | "u3"
  system: { type: "text"; text: string }[]
  counter: number
  last_extended: string
  /** @derived (e) => e._path.split("/")[0] */ episode: string
  /** @derived (e) => Object.keys(e.messages).length */ n_messages: number
  /** @derived (e) => Object.keys(e.conversations).length */ n_conversations: number
}

/** @records */transcripts/*_conversations.json#/messages/* */
type Message = {
  id: string
  role: "user" | "assistant"
  first_seen_ts: Time
  content: Block[]
  /** @derived (m) => m._path.split("/")[0] */ episode: string
  /** @derived (m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").length : 0 */ tool_calls: number
  /** @derived (m) => Array.isArray(m.content) && m.content.some((b) => b.is_error) */ has_error: boolean
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | unknown[]; is_error?: boolean }

/** @records */transcripts/*_conversations.json#/conversations/* */
type Conversation = {
  id: string
  messages: Message["id"][]
  forked_from: string | null
  first_ts: Time
  last_ts: Time
  /** @derived (c) => c.messages.length */ length: number
}
