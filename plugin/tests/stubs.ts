// Stub texts of the prompt registry (prompts/<text>.md) for the hooks tests, whose $.fs is mocked: short templates with
// the same placeholders as the real ones.

const STUBS: Record<string, string> = {
  labels: 'LABEL {{NAME}} | {{VALUES}}\n{{RECORDS}}',
}

/** The stub text of a registry path (`…/prompts/<text>.md`), or undefined for any other path. */
export function promptStub(path: string): string | undefined {
  const m = /\/prompts\/([^/]+)\.md$/.exec(path)
  if (!m) return undefined
  return STUBS[m[1]!] ?? `PROMPT ${m[1]}`
}
