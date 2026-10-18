// Stub texts of the prompt registry (prompts/<feature>/<version>.md) for the hooks tests, whose $.fs is mocked: short
// templates with the same placeholders and sections as the real ones, so a test sees what the observer composed.

const STUBS: Record<string, string> = {
  'observer/v1': 'OBSERVER {{QUESTION}} | {{DECISION}} | {{OBJECTS}} | {{COVERAGE}} | {{NOTES}} | {{OPEN}} {{LINE_RULE}} | {{GLOSSED}} | CLAIMS {{CLAIMS}} | CLUSTERS {{CLUSTERS}} {{GROWN}}',
  'observer/v2': 'FRAME\n{{LENSES}}\nREPLY {{SKELETON}}',
  'observer/attention-v1': 'FRAME ATTENTION\n{{LENSES}}\nREPLY {{SKELETON}}',
  'observer-turn/v1': 'TURN {{QUESTION_STEP}} | {{QUESTION}} | {{DECISION}} | {{ROW}} | STEPS {{STEPS}} | {{ANSWER}} {{SHOWN}} | {{OBJECTS}} | {{COVERAGE}} | EARLIER {{EARLIER}}\n{{DIGEST}}\n{{RULES}}',
  'question/v1': 'QUESTION {{QUESTION}} {{ANSWER}}',
  'lens-notes/v1': 'LENS notes\n<!-- digest -->\n| {{NOTES}}',
  'lens-line/v1': 'LENS line\n<!-- digest -->\n| {{SEEN}} | {{KNOWN}} | {{OPEN}}\n<!-- when open -->\nA line is open above the prompt now. Give no new line this time.\n<!-- when backoff -->\nGive no line this time: backoff.',
  'lens-actions/v2': 'LENS actions',
  'lens-actions/v3': 'LENS actions',
  'lens-squeeze/v1': 'LENS squeeze',
  'lens-explain/v2': 'LENS explain\n<!-- digest -->\n| {{GLOSSED}}\n<!-- when backoff -->\nGive no explain marks this time.',
  'lens-claims/v1': 'LENS claims\n<!-- digest -->\nCLAIMS {{CLAIMS}} | CLUSTERS {{CLUSTERS}} {{GROWN}}',
  'lens-claims/v2': 'LENS claims\n<!-- digest -->\nCLAIMS {{NEAR}}{{LEFT_OUT}} | CLUSTERS {{CLUSTERS}} {{GROWN}}\n<!-- when quiet -->\nNO CLAIMS THIS TURN',
  'squeeze/v3': 'THE PROMPT',
  'squeeze/v4': 'THE PROMPT',
  'squeeze/v5': 'THE PROMPT',
  'thread/v1': 'THE THREAD PROMPT',
  'forms/v2': '# Card forms\n\n## Principles\n\nOLD PRINCIPLES\n\n## Worked examples\n\nTHE WORKED FORMS',
  'card/v1': '# Card after\n\n## The request\n\nREQUEST {{QUESTION}} | {{ANSWER}} | {{CARDS}} | {{GUIDANCE}} | {{TOOLKIT}}\n\n## The fix\n\nFIX {{PROBLEMS}} | {{CARD}} | {{TOOLKIT}}\n\n## Saving\n\n**Save what the person will keep as an object.** CARDS COME AFTER.\n\n## What the person sees\n\nTHE CARD COMES AFTER THE ANSWER',
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
