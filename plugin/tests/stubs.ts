// Stub texts of the prompt registry (prompts/<text>.md) for the hooks tests, whose $.fs is mocked: short templates with
// the same placeholders and sections as the real ones, so a test sees what the observer composed.

const STUBS: Record<string, string> = {
  observer: 'FRAME\n{{LENSES}}',
  'observer-turn': 'NOW {{MESSAGES}} | {{ROW}} | {{SHOWN}} | {{OBJECTS}} | {{COVERAGE}}\n{{DIGEST}}\n{{RULES}}\nREPLY {{SKELETON}}',
  'lens-actions': 'LENS actions',
  'lens-claims': 'LENS claims\n<!-- digest -->\nCLAIMS {{CLAIMS}} | CLUSTERS {{CLUSTERS}}{{GROWN}}\n<!-- when quiet -->\nGive no claims this time.',
  'lens-explain': 'LENS explain\n<!-- digest -->\n| {{GLOSSED}}',
  'lens-heads': 'LENS heads\n<!-- digest -->\n| {{HEADS}}',
  squeeze: 'THE PROMPT',
  thread: 'THE THREAD PROMPT',
  labels: 'LABEL {{NAME}} | {{VALUES}}\n{{RECORDS}}',
}

/** The stub text of a registry path (`…/prompts/<text>.md`), or undefined for any other path. */
export function promptStub(path: string): string | undefined {
  // the card guide (forms reads it whole)
  if (/\/skills\/thimble\/cards\.md$/.test(path)) return '# The card guide\n\n## What makes a good card\n\nTHE WORKED FORMS'
  const m = /\/prompts\/([^/]+)\.md$/.exec(path)
  if (!m) return undefined
  return STUBS[m[1]!] ?? `PROMPT ${m[1]}`
}

/** A key pressed in the prompt: the answer the shell gives it, once the key's work has run. The shell answers a key at
 *  once and does what the key does after the answer (shell/keys.ts), so a test lets that work run before it looks. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function press($: any, clock: { settle: () => Promise<void> }, edit: unknown): Promise<any> {
  const answer = await $.prompt.edit(edit)
  await clock.settle()
  return answer
}
