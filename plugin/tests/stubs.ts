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

/** core/home.ts tempDir has the shell make its folder and print the folder's real path: that answer, the folder as
 *  named; null for any other command. */
export function tempRun(argv: string[]): { exitCode: number; stdout: string; stderr: string } | null {
  return argv[0] === 'sh' && String(argv[2] ?? '').includes('pwd -P') ? { exitCode: 0, stdout: `${argv[argv.length - 1]}\n`, stderr: '' } : null
}
