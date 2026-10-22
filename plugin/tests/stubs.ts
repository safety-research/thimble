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

/** The commands the hooks run for their folders, answered: core/home.ts tempDir has the shell make its folder and
 *  print the folder's real path (the folder as named), and cards/ask.ts runs sandbox/setup.mjs, whose answer is a
 *  sandbox that works (`sandbox` gives another); null for any other command. */
export function tempRun(argv: string[], sandbox: Record<string, unknown> = {}): { exitCode: number; stdout: string; stderr: string } | null {
  if (argv[0] === 'sh' && String(argv[2] ?? '').includes('pwd -P')) return { exitCode: 0, stdout: `${argv[argv.length - 1]}\n`, stderr: '' }
  if (String(argv[1] ?? '').endsWith('/sandbox/setup.mjs')) {
    const s = { ok: true, node: '/made-up/bin/node', srt: '/made-up/.thimble/srt/0.0.79', platform: 'linux', why: '', fix: '', ...sandbox }
    return { exitCode: s.ok ? 0 : 1, stdout: `${JSON.stringify(s)}\n`, stderr: '' }
  }
  return null
}
