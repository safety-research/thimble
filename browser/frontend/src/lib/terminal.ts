// Cleaning terminal output for reading in the Transcript view. An agent's terminal tool stores its output as the bytes
// the pseudo-terminal emitted: ANSI escapes that colour and move the cursor, carriage returns and backspaces that redraw
// a line in place, the odd control byte, and (some harnesses) a `<counter>` marker before each prompt. Read verbatim
// that is noise. cleanTerminal applies the cursor moves and drops the escapes, so a line redrawn in place reads as the
// line it ended on. The Transcript view shows the cleaned text and keeps the stored bytes under a Raw toggle; nothing
// here touches a record's canonical blocks, so refs and citations resolve against the stored text as before.

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b[@-_][0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// a prompt counter some agent harnesses wrap around each shell prompt (`<counter>11</counter> user@host:~$`); the space
// it is followed by goes with it
const COUNTER = /<counter>\d*<\/counter> ?/g
// control bytes with no place in readable text, once the cursor moves (\r, \b) have been applied; \n and \t are kept
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** Carriage returns and backspaces applied as a terminal applies them: `\r` returns the cursor to the line's start and
 * `\b` moves it one left, both without erasing, so a character written under the cursor overwrites what is there. A line
 * redrawn in place (a progress bar, a command echoed then rubbed back) reads as the text it ended showing. Newlines end
 * a line; every other character is written at the cursor. Pure. */
export function applyCursor(s: string): string {
  const out: string[] = []
  let line: string[] = []
  let col = 0
  const flush = () => {
    out.push(line.join(''))
    line = []
    col = 0
  }
  for (const ch of s) {
    if (ch === '\n') {
      flush()
      continue
    }
    if (ch === '\r') {
      col = 0
      continue
    }
    if (ch === '\b') {
      if (col > 0) col--
      continue
    }
    if (col < line.length) line[col] = ch
    else {
      while (line.length < col) line.push(' ')
      line.push(ch)
    }
    col++
  }
  flush()
  return out.join('\n')
}

/** Each line without its trailing spaces and tabs, and the blank lines at the file's start and end removed. Keeps blank
 * lines inside, which may separate output. Pure. */
export function trimLines(s: string): string {
  const lines = s.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  let a = 0
  let b = lines.length
  while (a < b && lines[a] === '') a++
  while (b > a && lines[b - 1] === '') b--
  return lines.slice(a, b).join('\n')
}

/** Terminal output cleaned for reading: ANSI escapes and counter markers dropped, carriage returns and backspaces
 * applied, any other control byte dropped, trailing spaces and the blank lines at either end removed. The stored bytes
 * stay available under Raw. Pure. */
export function cleanTerminal(s: string): string {
  if (!s) return s
  const applied = applyCursor(s.replace(ANSI, '').replace(COUNTER, ''))
  return trimLines(applied.replace(CTRL, ''))
}

/** Whether cleaning changes `s`, so the view offers Raw only when the stored bytes differ from what it shows. Pure. */
export function needsClean(s: string): boolean {
  return cleanTerminal(s) !== s
}
