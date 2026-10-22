// Runs one command in Anthropic's sandbox runtime (srt, pinned in package.json beside this file), which confines a
// process with Seatbelt (sandbox-exec) on macOS and bubblewrap on Linux. The server (thimble_browser/cards/sandbox.py)
// starts it for each run of a card's code or a view's reader:
//
//   node run.mjs [--print] <rules JSON> -- <command...>
//
// The rules are srt's configuration (sandbox.rules): filesystem rules, and a network rule that allows no domain, so
// the command has no network at all; on Linux also bwrapPath, the bwrap.sh beside this file. --print prints the
// wrapped command (on macOS, with the Seatbelt profile srt made of the rules) instead of running it. This process
// stays the command's parent, passes SIGTERM and SIGHUP on, stops the command when the server that started it is gone
// (a long-lived command, such as the card runner, would stay otherwise), and exits with the command's status, or with 3
// when the sandbox could not be set up.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const print = args[0] === '--print';
const [rulesJson, sep, ...argv] = print ? args.slice(1) : args;
if (!rulesJson || sep !== '--' || argv.length === 0) {
  console.error('usage: node run.mjs [--print] <rules JSON> -- <command...>');
  process.exit(2);
}

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const command = argv.map(quote).join(' ');

// srt looks for dangerous files (shell and git dotfiles) under its own working directory and guards them, so it works
// from this folder, which the command cannot write. The command starts where this process was started.
const cwd = process.cwd();
process.chdir(dirname(fileURLToPath(import.meta.url)));

let SandboxManager;
let wrapped;
try {
  const srt = await import('@anthropic-ai/sandbox-runtime');
  SandboxManager = srt.SandboxManager;
  const rules = srt.SandboxRuntimeConfigSchema.parse(JSON.parse(rulesJson));
  // The rules become srt's configuration (bwrapPath is read only from there) without initialize(), which would start
  // the network proxies that a command with no network does not need.
  SandboxManager.updateConfig(rules);
  wrapped = await SandboxManager.wrapWithSandbox(command, undefined, rules);
} catch (e) {
  console.error(`the sandbox could not be set up: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(3);
}
if (!wrapped || wrapped === command) {
  console.error('the sandbox could not be set up: srt returned the command unwrapped');
  process.exit(3);
}

if (print) {
  console.log(wrapped);
  SandboxManager.cleanupAfterCommand();
  process.exit(0);
}

const child = spawn('/bin/sh', ['-c', `exec ${wrapped}`], { cwd, stdio: 'inherit' });
for (const sig of ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
const server = process.ppid;
setInterval(() => { if (process.ppid !== server) child.kill('SIGTERM'); }, 2000).unref();
child.on('error', (e) => {
  console.error(`the sandbox could not be started: ${e.message}`);
  process.exit(3);
});
child.on('exit', (code, signal) => {
  SandboxManager.cleanupAfterCommand();
  process.exit(code ?? 128 + (constants.signals[signal] ?? 0));
});
