// test-home.mjs: every lean test runs with a THIMBLE_HOME of its own, so a test (or a `lean` it starts) never writes
// into the person's ~/.thimble. Imported first by each *.test.mjs; the pytest side is tests/conftest.py.
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const real = join(homedir(), '.thimble')
if (!process.env.THIMBLE_HOME || process.env.THIMBLE_HOME === real) process.env.THIMBLE_HOME = mkdtempSync(join(tmpdir(), 'lean-test-home-'))
