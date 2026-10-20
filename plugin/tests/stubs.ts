// Stub texts of the prompt registry (prompts/<feature>/<version>.md) for the hooks tests, whose $.fs is mocked: short
// templates with the same placeholders and sections as the real ones, so a test sees what the observer composed.

const STUBS: Record<string, string> = {
  'observer/v3': 'FRAME\n{{LENSES}}\nREPLY {{SKELETON}}',
  'observer/v4': 'FRAME\n{{LENSES}}\nREPLY {{SKELETON}}',
  'observer/v5': 'FRAME\n{{LENSES}}',
  'observer-turn/v2': 'TURN {{QUESTION}} | {{ROW}} | STEPS {{STEPS}} | {{ANSWER}} {{SHOWN}} | {{OBJECTS}} | {{COVERAGE}} | EARLIER {{EARLIER}}\n{{DIGEST}}\n{{RULES}}',
  'observer-turn/v3': 'NOW {{MESSAGES}} | {{ROW}} | {{SHOWN}} | {{OBJECTS}} | {{COVERAGE}}\n{{DIGEST}}\n{{RULES}}\nREPLY {{SKELETON}}',
  'lens-notes/v2': 'LENS notes\n<!-- digest -->\n| {{NOTES}}',
  'lens-actions/v4': 'LENS actions',
  'lens-squeeze/v2': 'LENS squeeze',
  'lens-explain/v3': 'LENS explain\n<!-- digest -->\n| {{GLOSSED}}\n<!-- when backoff -->\nGive no explain marks this time.',
  'lens-claims/v3': 'LENS claims\n<!-- digest -->\nCLAIMS {{NEAR}}{{LEFT_OUT}} | CLUSTERS {{CLUSTERS}}{{GROWN}}\n<!-- when quiet -->\nGive no claims this time.',
  'lens-explain/v4': 'LENS explain\n<!-- digest -->\n| {{GLOSSED}}\n<!-- when backoff -->\nGive one explain mark at most this time.',
  'squeeze/v6': 'THE PROMPT',
  'thread/v2': 'THE THREAD PROMPT',
  'labels/v2': 'LABEL {{NAME}} | {{VALUES}}\n{{RECORDS}}',
}

/** The stub text of a registry path (`…/prompts/<feature>/<version>.md`), or undefined for any other path. */
export function promptStub(path: string): string | undefined {
  // the card guide (forms:v4 reads it whole)
  if (/\/skills\/thimble\/cards\.md$/.test(path)) return '# The card guide\n\n## What makes a good card\n\nTHE WORKED FORMS'
  const m = /\/prompts\/([^/]+)\/([^/]+)\.md$/.exec(path)
  if (!m) return undefined
  return STUBS[`${m[1]}/${m[2]}`] ?? `PROMPT ${m[1]}:${m[2]}`
}

/** A key pressed in the prompt: the answer the shell gives it, once the key's work has run. The shell answers a key at
 *  once and does what the key does after the answer (shell/keys.ts), so a test lets that work run before it looks. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function press($: any, clock: { settle: () => Promise<void> }, edit: unknown): Promise<any> {
  const answer = await $.prompt.edit(edit)
  await clock.settle()
  return answer
}
