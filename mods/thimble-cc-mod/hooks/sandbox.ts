// The sandbox of the scripts the mod runs itself (helper/sandbox.py plans it once a session): a card's script run again,
// a verification script, a view's checks, the file browser's helper and a label's run. Claude Code's sandbox covers its
// tools' calls, not a plugin's $.process.run, so these are wrapped as browser mode wraps its notebook kernels.

/** helper/sandbox.py's plan: run [...prefix, python, script, ...] with env over the environment. `error` set: a sandbox
 *  THIMBLE_KERNEL_WRAP names cannot run here, and nothing runs. */
export type SandboxPlan = {
  wrap: 'srt' | 'bwrap' | 'none'
  prefix: string[]
  python: string
  env: Record<string, string>
  line: string
  error: string
}

/** What the scripts are, for the notice and /thimble-cc-mod. */
export const SCRIPTS = "the scripts the mod runs itself (card reruns, verifications, views' checks, labels)"

/** The plan the helper printed (its last line), or null when it printed none. */
export function parsePlan(stdout: string): SandboxPlan | null {
  const last = stdout.trim().split('\n').at(-1) ?? ''
  let v: unknown
  try {
    v = JSON.parse(last)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const p = v as Record<string, unknown>
  const wrap = p.wrap
  if (wrap !== 'srt' && wrap !== 'bwrap' && wrap !== 'none') return null
  const prefix = Array.isArray(p.prefix) ? p.prefix.map(String) : []
  const error = typeof p.error === 'string' ? p.error : ''
  // a wrapper without its command is no sandbox: nothing runs
  const broken = wrap !== 'none' && !prefix.length && !error ? `the ${wrap} plan has no command` : ''
  const env: Record<string, string> = {}
  if (p.env && typeof p.env === 'object') for (const [k, x] of Object.entries(p.env as Record<string, unknown>)) env[k] = String(x)
  return {
    wrap,
    prefix,
    python: typeof p.python === 'string' && p.python ? p.python : 'python3',
    env,
    line: typeof p.line === 'string' ? p.line : '',
    error: error || broken,
  }
}

/** The plan when the helper gave none: the scripts run as before, and the notice says why. */
export function noPlan(why: string): SandboxPlan {
  const last = why.trim().split('\n').filter(Boolean).at(-1) ?? ''
  return { wrap: 'none', prefix: [], python: 'python3', env: {}, line: `run unsandboxed, with your user's access (the sandbox helper gave no plan${last ? `: ${last.slice(0, 160)}` : ''})`, error: '' }
}

/** A command as the plan runs it: the wrapper's prefix, then the command, `python3` named by the plan's interpreter. */
export function boxedArgv(plan: SandboxPlan, argv: readonly string[]): string[] {
  const cmd = argv.map((a, i) => (i === 0 && a === 'python3' ? plan.python : a))
  return plan.wrap === 'none' ? [...argv] : [...plan.prefix, ...cmd]
}

/** The one notice of an unsandboxed session, in the transcript (dim, not sent to the model), which the engine draws
 *  after the plugin's name. */
export function unboxedNotice(plan: SandboxPlan): string {
  return `${SCRIPTS} ${plan.line}`
}
