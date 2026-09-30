// The notebook kernel inside Anthropic's sandbox runtime (@anthropic-ai/sandbox-runtime, "srt"), which confines a
// process with Seatbelt on macOS and bubblewrap on Linux. notebook.py starts the kernel as
//
//   node kernel_srt.mjs [--print] <srt package dir> <rules JSON> -- <kernel argv...>
//
// where the rules are kernel_wrap.srt_rules' filesystem rules; --print prints the wrapped command (on macOS, with the
// Seatbelt profile srt made) instead of running it. No network rules are given, so the kernel keeps the host's network
// (the server reaches its ZMQ ports on 127.0.0.1). This process stays the kernel's parent and exits with it: SIGTERM
// and SIGHUP are passed on, and SIGINT is ignored here and by the wrapper processes (the server interrupts a sandboxed
// kernel with an interrupt_request on its control channel).
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const print = args[0] === '--print';
const [srtArg, rulesJson, sep, ...argv] = print ? args.slice(1) : args;
if (!srtArg || !rulesJson || sep !== '--' || argv.length === 0) {
  console.error('usage: node kernel_srt.mjs [--print] <srt package dir> <rules JSON> -- <command...>');
  process.exit(2);
}

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

process.on('SIGINT', () => {});

// srt guards shell and git dotfiles under its own working directory, on Linux by mounting empty read-only files over
// them, which would show in the kernel's working directory. So srt works from this file's folder, which the kernel
// cannot write, and the kernel starts where this process was started.
const cwd = process.cwd();
const srtDir = resolve(srtArg);
process.chdir(dirname(fileURLToPath(import.meta.url)));

let wrapped;
let SandboxManager;
try {
  const srt = await import(pathToFileURL(join(srtDir, 'dist', 'index.js')).href);
  SandboxManager = srt.SandboxManager;
  const rules = JSON.parse(rulesJson);
  srt.FilesystemConfigSchema.parse(rules.filesystem);
  wrapped = await SandboxManager.wrapWithSandbox(argv.map(quote).join(' '), undefined, rules);
} catch (e) {
  console.error(`kernel_srt: the sandbox could not be set up: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(3);
}

if (print) {
  console.log(wrapped);
  SandboxManager.cleanupAfterCommand();
  process.exit(0);
}

const child = spawn('/bin/sh', ['-c', `trap "" INT; exec ${wrapped}`], { cwd, stdio: 'inherit' });
for (const sig of ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('error', (e) => {
  console.error(`kernel_srt: ${e.message}`);
  process.exit(3);
});
child.on('exit', (code, signal) => {
  SandboxManager.cleanupAfterCommand();
  process.exit(code ?? 128 + (constants.signals[signal] ?? 0));
});
