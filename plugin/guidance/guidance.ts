// guidance.ts: thimble's guidance (prompts/guidance.md) in every conversation, as one context block named `thimble`
// (prompt.context), never through the Skill tool. Claude Code sends a block it does not route once, and again after a
// compaction; a resumed session keeps its one copy. The sections of a switched-off feature are left out.
//
// The guidance lane builds it here. Until then this registers nothing.
import type { Register } from 'claude-code'

export const registerGuidance: Register = () => {}
