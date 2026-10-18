// Terminal output cleaned for reading: cursor moves applied, ANSI escapes and counter markers dropped, control bytes
// gone, trailing space and the blank lines at either end trimmed (src/lib/terminal.ts).
import { describe, expect, test } from 'vitest'
import { cleanTerminal } from '../../src/lib/terminal.ts'

describe('cleanTerminal', () => {
  test('drops ANSI colour and cursor escapes', () => {
    expect(cleanTerminal('\x1b[31mred\x1b[0m text')).toBe('red text')
    expect(cleanTerminal('\x1b[2K\x1b[Gline')).toBe('line')
  })
  test('a real-shaped echo: a command echoed, rubbed back with backspaces, and the counter prompt', () => {
    const raw = '\n<counter>11</counter> user@host:~$ \n\n<ssh ... && echo R_UP || echo R_FAIL          \b\b\b\b\b\b\b\b\b\b\n'
    const out = cleanTerminal(raw)
    expect(out).not.toContain('<counter>')
    expect(out).not.toContain('\b')
    expect(out).toContain('user@host:~$')
    expect(out).toContain('echo R_UP || echo R_FAIL')
  })
})
