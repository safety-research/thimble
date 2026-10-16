// Coverage facts in the terminal UI (term-transcript lane, build spec 3.9): what each tool call of main and its
// subagents read, searched or never opened of the data files, kept per turn and sent once at its end with
// `thimble act coverage --stdin` (C7).
//
// SCAFFOLD STUB: the Fact type of C7, and factsOfCall, which finds no fact yet. Nothing here runs at import.

/** One fact of C7: a data file (or a folder a recursive search covered) and how a call touched it. */
export type Fact = {
  path: string
  how: 'whole' | 'part' | 'searched'
  lines?: [number, number]
  pages?: [number, number]
  total?: number
  folder?: true
  by: 'Read' | 'Bash' | 'search' | 'agent'
  at: number
}

/** The facts one tool call gives, from its input and its result (relative to `cwd`). The stub gives none. */
export function factsOfCall(_cwd: string, _tool: string, _input: Record<string, unknown>, _result: unknown): Fact[] {
  return []
}
