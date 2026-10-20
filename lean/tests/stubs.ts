// Stub texts of the prompt registry (prompts/<feature>/<version>.md) for the hooks tests, whose $.fs is mocked: short
// templates with the same placeholders and sections as the real ones, so a test sees what the observer composed.

const STUBS: Record<string, string> = {
  'observer/v2': 'FRAME\n{{LENSES}}\nREPLY {{SKELETON}}',
  'observer/attention-v1': 'FRAME ATTENTION\n{{LENSES}}\nREPLY {{SKELETON}}',
  'observer/v3': 'FRAME\n{{LENSES}}\nREPLY {{SKELETON}}',
  'observer-turn/v1': 'TURN {{QUESTION}} | {{ROW}} | STEPS {{STEPS}} | {{ANSWER}} {{SHOWN}} | {{OBJECTS}} | {{COVERAGE}} | EARLIER {{EARLIER}}\n{{DIGEST}}\n{{RULES}}',
  'lens-notes/v1': 'LENS notes\n<!-- digest -->\n| {{NOTES}}',
  'lens-actions/v2': 'LENS actions',
  'lens-actions/v3': 'LENS actions',
  'lens-squeeze/v1': 'LENS squeeze',
  'lens-explain/v2': 'LENS explain\n<!-- digest -->\n| {{GLOSSED}}\n<!-- when backoff -->\nGive no explain marks this time.',
  'lens-explain/v3': 'LENS explain\n<!-- digest -->\n| {{GLOSSED}}\n<!-- when backoff -->\nGive no explain marks this time.',
  'lens-claims/v1': 'LENS claims\n<!-- digest -->\nCLAIMS {{CLAIMS}} | CLUSTERS {{CLUSTERS}} {{GROWN}}',
  'lens-claims/v2': 'LENS claims\n<!-- digest -->\nCLAIMS {{NEAR}}{{LEFT_OUT}} | CLUSTERS {{CLUSTERS}} {{GROWN}}\n<!-- when quiet -->\nNO CLAIMS THIS TURN',
  'squeeze/v3': 'THE PROMPT',
  'squeeze/v4': 'THE PROMPT',
  'squeeze/v5': 'THE PROMPT',
  'squeeze/v6': 'THE PROMPT',
  'thread/v1': 'THE THREAD PROMPT',
  'thread/v2': 'THE THREAD PROMPT',
  'forms/v2': '# Card forms\n\n## Principles\n\nOLD PRINCIPLES\n\n## Worked examples\n\nTHE WORKED FORMS',
  'forms/v3': '# Card guidance\n\n## Making a card\n\nTHE WORKED FORMS',
}

/** The stub text of a registry path (`…/prompts/<feature>/<version>.md`), or undefined for any other path. */
export function promptStub(path: string): string | undefined {
  // the card ablation's shared parts: the principles, and a pool of three examples
  const part = /\/prompts\/forms\/parts\/([^/]+)\.md$/.exec(path)
  if (part) return part[1] === 'principles' ? '## What makes a great output\n\nTHE PRINCIPLES' : `## Worked examples\n\nPOOL ${part[1]}\n\n### Alpha\n\nA\n\n### Beta\n\nB\n\n### Gamma\n\nC\n\n### Delta\n\nD\n`
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
