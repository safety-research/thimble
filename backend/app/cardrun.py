"""Card code run in the caller's Bash, for terminal mode: `thimble-run card <cell> | label <label> | stale`.

In browser mode a card's code runs in a kernel the server owns. Terminal mode has no server, and code a model wrote never
runs in the MCP shim: add_card and edit_card store the card with a `run` record ({state: waiting, by: bash, script}) and
answer with one Bash command (`## card-run`); a code label answers with `## label-run`, and cards that read a changed
label with `## cards-stale`. The caller runs the command in its Bash, inside main's sandbox, where `thimble-run` runs
the code as a kernel cell would: one IPython shell (LocalKernel) set up with the kernel's own startup lines
(notebook.startup_lines: Altair's mimetype renderer, pandas' column width, the figure formatter, the page's faces, the
cell-reads hook and the `thimble` module with WS set), thimble's matplotlibrc and the inline backend's SVG figures,
then the same storage path as a kernel run (notebook._execute_cell: output bounding, memos, reads, labels read). It
writes the card's outputs into the group under the store's lock and prints what add_card prints in browser mode, and
exits 0, or 1 when the code errored. No kernel lasts between runs, so each run loads its data again.

A card whose run ends with a takeaway (add_card's `takeaway`) is marked `check: "pending"`; the shim's CardWatch sees
the group file change and starts its card check (card_check.start), or skips it as browser mode does without Chromium
or the built frontend. A run that `thimble-run` did not finish (Bash's timeout killed it) is marked interrupted by the
watch once its process is gone.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import queue
import logging
import os
import shlex
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config

log = logging.getLogger("thimble.cardrun")

RUNS_DIR = "card-runs"  # workspace-relative: each card's code as `thimble-run` runs it, <cell>.py, and the shell's state
BIN = "thimble-run"
BY = "bash"
WAITING, RUNNING, DONE = "waiting", "running", "done"
PENDING = "pending"  # a card's `check` while its card check waits for the shim (CardWatch)
GRACE_S = 10.0  # after an interrupt, how long a run has to stop before the runner gives it up (notebook._execute's 10 s)
WATCH_S = 1.0  # how often the shim's CardWatch looks at the groups' files
DEAD_ENAME, DEAD_EVALUE = "Interrupted", "thimble-run stopped before the card's run ended; run the command again"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def in_runner() -> bool:
    """Whether this process is a card runner, where card code runs (notebook.local_kernel is set)."""
    from . import notebook  # noqa: PLC0415

    return notebook.local_kernel is not None


def defers(c: str) -> bool:
    """Whether a run of card code asked for in workspace `c` goes to `thimble-run` instead of running here: a terminal-
    mode workspace, in a process that is no card runner (the MCP shim, the hooks, `thimble act`)."""
    from . import local  # noqa: PLC0415

    return not in_runner() and local.terminal(c)


# --------------------------------------------------------------------------- the command and its folders


def bin_path() -> Path:
    """`thimble-run` in the plugin copy this session loaded (local.PLUGIN_ROOT), whose path the launcher's allow rule
    names, else in this tree's plugin/."""
    from . import local  # noqa: PLC0415

    return (local.PLUGIN_ROOT or config.REPO_ROOT / "plugin") / "bin" / BIN


def command(kind: str, ident: str = "") -> str:
    """The Bash command that runs `thimble-run <kind> [<ident>]`, which main's `--allowedTools` lets run without asking."""
    return shlex.join([str(bin_path()), kind, *([ident] if ident else [])])


def write_dirs(c: str) -> list[Path]:
    """The folders of workspace `c` a card run writes, which main's fence gives its Bash (allowWrite): the groups, their
    outputs' side files, the labels' rows and definitions (a code label's run records its application there), this
    module's folder and the scratch mirror the code runs in (the kernels' cwd)."""
    from . import notebook  # noqa: PLC0415

    ws = config.workspace_dir(c)
    return [ws / "notebooks", ws / notebook.OUTPUTS_DIR, ws / "labels", ws / "concepts", ws / RUNS_DIR,
            ws / notebook.SCRATCH_DIR]


def waiting(c: str, cell: dict[str, Any], lines: list[str]) -> str:
    """What add_card or edit_card answers with for a card whose code waits for `thimble-run`: the card's ref, the
    `## card-run` line with its command (prepare), and the call's other lines."""
    from . import tools  # noqa: PLC0415

    cmd = prepare(c, cell)
    run = tools.hint("card-run", command=cmd) or f"Run with Bash: {cmd}"
    return "\n\n".join([f"card:{cell['id']}", run, *lines])


def mirror(c: str) -> None:
    """Refresh the scratch mirror of the corpus a card's code runs in (notebook.scratch_dir), from the process that gives
    the command: its manifest is under thimble's home, which main's sandbox cannot write. Never raises."""
    from . import notebook  # noqa: PLC0415

    try:
        notebook.scratch_dir(c)
    except Exception:  # noqa: BLE001 — the run then reads the corpus folder itself
        log.warning("%s: the scratch mirror was not refreshed", c, exc_info=True)


async def ready_types(c: str, code: str) -> None:
    """The card types refreshed before code that draws one runs, as notebook._run_card_code refreshes them before a
    kernel runs it: here in the shim, since the workspace's registry is outside what main's sandbox may write."""
    from . import cardtypes  # noqa: PLC0415

    if cardtypes.CARD_CALL in code:
        await cardtypes.refresh_quietly(c, warm=False)


def prepare(c: str, cell: dict[str, Any]) -> str:
    """Write the card's code to card-runs/<cell>.py, as the script its `run` record names, refresh the scratch mirror
    (mirror), and return the command that runs it. The script is the code as stored now, for the record; `thimble-run`
    runs the card's code from its group."""
    mirror(c)
    d = config.workspace_dir(c) / RUNS_DIR
    d.mkdir(parents=True, exist_ok=True)
    cid = str(cell["id"])
    head = f"# thimble card:{cid}: {' '.join(str(cell.get('title') or '').split())}\n"
    from . import ledger  # noqa: PLC0415

    ledger.write_under(config.workspace_dir(c), d / f"{cid}.py", head + str(cell.get("code") or ""))
    return command("card", cid)


def run_record(cid: str, *, takeaway: str | None, default_timeout_s: float | None, session: str | None) -> dict:
    """The `run` record a card waiting for `thimble-run` carries: its state, who runs it, its script, and what its run
    needs from the call that asked for it (the takeaway given with it, the time limit its caller has, the caller's
    session, whose card check it is)."""
    rec: dict[str, Any] = {"state": WAITING, "by": BY, "script": f"{RUNS_DIR}/{cid}.py", "queued": _now()}
    if takeaway:
        rec["takeaway"] = takeaway
    if default_timeout_s is not None:
        rec["default_timeout_s"] = default_timeout_s
    if session:
        rec["session"] = session
    return rec


# --------------------------------------------------------------------------- the shell that stands in for a kernel


class _Stream:
    """sys.stdout or sys.stderr while a cell runs: each write goes to the cell's outputs as a stream bundle."""

    def __init__(self, kernel: "LocalKernel", name: str) -> None:
        self.kernel, self.name = kernel, name
        self.encoding = "utf-8"
        self.errors = "replace"

    def write(self, text: Any) -> int:
        s = text if isinstance(text, str) else str(text)
        if s:
            self.kernel._stream(self.name, s)
        return len(s)

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        return 1 if self.name == "stdout" else 2

    @property
    def closed(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def readable(self) -> bool:
        return False


class LocalKernel:
    """The in-process IPython shell a card runner runs card code in, with the fields of notebook._Kernel that the run
    path reads (lock, last_reads, last_expr, last_result, last_labels, last_label_revs) and `local = True`, by which
    notebook._ensure_started and notebook._execute hand over to start() and execute(). Its outputs are the bundles
    notebook._execute collects from a kernel: stream bundles marked `_stream` (consecutive writes to one stream joined),
    display bundles with their display ids, the execute_result, error bundles with their tracebacks, and the reads
    record taken out. The code runs in the process's main thread, as a kernel runs it, while the runner's event loop
    runs in a thread of its own (serve), so a cell's own top-level await and a signal that interrupts it both work as in
    a kernel."""

    local = True

    def __init__(self, workspace: str) -> None:
        self.workspace = workspace
        self.name: str | None = None
        self.key = "local"
        self.lock = asyncio.Lock()
        self.kc: Any = self  # trial_settle reads `kc` and alive()
        self.pid = os.getpid()
        self.last_reads: dict | None = None
        self.last_expr: dict | None = None
        self.last_result: int | None = None
        self.last_labels: list[str] = []
        self.last_label_revs: dict[str, int] = {}
        self.shell: Any = None
        self.dead = False
        self._errored = False
        self._outputs: list[dict] | None = None
        self._pending: dict[str, list[str]] = {}  # stream writes not yet in the outputs (_stream)
        self._env: dict[str, str] = {}  # what the shell's runs set in the environment (_build)
        self._chunks: dict[int, list[str]] = {}
        self._display_index: dict[str, int] = {}
        self._out_lock = threading.Lock()

    def alive(self) -> bool:
        return not self.dead

    def interrupt(self) -> None:
        """A kernel's interrupt: here a run's own SIGALRM interrupts it (_execute)."""

    # ------------------------------------------------------------------ collecting outputs

    def _stream(self, name: str, text: str) -> None:
        """A write to stdout or stderr, held until the next output or the cell's end, as ipykernel buffers each stream
        and flushes stdout, then stderr, before it publishes anything else."""
        with self._out_lock:
            if self._outputs is not None:
                self._pending.setdefault(name, []).append(text)

    def _flush_streams(self) -> None:
        """The held writes into the outputs, stdout's first (call with _out_lock held)."""
        out = self._outputs
        if out is None:
            return
        for name in ("stdout", "stderr"):
            parts = self._pending.pop(name, None)
            if not parts:
                continue
            if out and out[-1].get("_stream") == name and (len(out) - 1) in self._chunks:
                self._chunks[len(out) - 1].extend(parts)
            else:
                self._chunks[len(out)] = list(parts)
                out.append({"text/plain": "", "_stream": name})

    def _display(self, data: dict, transient: dict | None, update: bool) -> None:
        from . import notebook  # noqa: PLC0415

        with self._out_lock:
            out = self._outputs
            if out is None:
                return
            self._flush_streams()
            did = (transient or {}).get("display_id")
            if update:
                if did in self._display_index:
                    out[self._display_index[did]] = dict(data)
                return
            rb = notebook.reads_bundle(data)
            if rb is not None:  # the cell-reads record: not an output of the cell
                self.last_reads = rb
                return
            if did:
                self._display_index[did] = len(out)
            out.append(dict(data))

    def _result(self, data: dict) -> None:
        with self._out_lock:
            out = self._outputs
            if out is None:
                return
            self._flush_streams()
            self.last_result = len(out)
            out.append(dict(data))

    def _error(self, etype: Any, evalue: Any, stb: list[str]) -> None:
        from . import notebook  # noqa: PLC0415

        name = getattr(etype, "__name__", None) or type(evalue).__name__
        with self._out_lock:
            if self._outputs is not None:
                self._flush_streams()
                self._outputs.append(notebook._error_bundle(str(name), str(evalue), list(stb or [])))
                self._errored = True

    # ------------------------------------------------------------------ the shell

    async def start(self) -> None:
        if self.shell is None:
            await _on_main(self._build)

    def _build(self) -> None:
        """The shell, set up as notebook.kernel_argv sets up a kernel (module note)."""
        from IPython.core.displayhook import DisplayHook
        from IPython.core.displaypub import DisplayPublisher
        from IPython.core.interactiveshell import InteractiveShell
        from traitlets.config import Config

        from . import notebook  # noqa: PLC0415

        kernel = self

        class _Publisher(DisplayPublisher):
            def publish(self, data: Any, metadata: Any = None, source: Any = None, *, transient: Any = None,
                        update: bool = False, **kwargs: Any) -> None:
                kernel._display(dict(data or {}), transient, update)

            def clear_output(self, wait: bool = False) -> None:
                pass  # a kernel's clear_output message is not kept by notebook._execute either

        class _Hook(DisplayHook):
            def start_displayhook(self) -> None:
                self._data: dict | None = None

            def write_output_prompt(self) -> None:
                pass

            def write_format_data(self, format_dict: Any, md_dict: Any = None) -> None:
                self._data = dict(format_dict or {})

            def finish_displayhook(self) -> None:
                if getattr(self, "_data", None):
                    kernel._result(self._data)
                self._data = None

        ws = config.workspace_dir(self.workspace)
        corpus = config.corpus_dir(self.workspace)
        # the scratch mirror the shim refreshed when it gave the command (mirror); the corpus itself when there is none
        scratch = ws / notebook.SCRATCH_DIR
        cwd = scratch if scratch.is_dir() else Path(corpus)
        state = ws / RUNS_DIR
        self._env = {
            "MPLBACKEND": os.environ.get("MPLBACKEND") or "module://matplotlib_inline.backend_inline",  # ipykernel's
            "MATPLOTLIBRC": os.environ.get("MATPLOTLIBRC") or str(notebook.MATPLOTLIBRC),  # as notebook._launch sets it
            # main's sandbox writes nothing in the home folder: IPython's folder and the caches of matplotlib and
            # fontconfig are the workspace's, which keeps their warnings out of a card's outputs (a kernel under srt
            # has a home folder of its own for the same reason)
            "IPYTHONDIR": str(state / "ipython"),
            "MPLCONFIGDIR": str(state / "matplotlib"),
            "XDG_CACHE_HOME": str(state / "cache"),
        }
        os.environ.update(self._env)
        os.chdir(cwd)
        cfg = Config()
        cfg.HistoryManager.enabled = False
        cfg.InlineBackend.figure_format = "svg"
        shell = InteractiveShell.instance(config=cfg, display_pub_class=_Publisher, displayhook_class=_Hook)
        shell._showtraceback = self._error  # ipykernel sends {ename, evalue, traceback} the same way
        self.shell = shell
        # the startup lines run with their own outputs thrown away, as a kernel's exec_lines reach no card
        self._outputs, self._chunks, self._display_index, self._pending = [], {}, {}, {}
        try:
            for line in notebook.startup_lines((str(cwd), str(Path(corpus).resolve())), ws.resolve()):
                shell.run_cell(line, store_history=False, silent=True)
        finally:
            self._outputs = None
        self.last_reads = None

    async def execute(self, code: str, timeout: float, user_expressions: dict[str, str] | None
                      ) -> tuple[list[dict], int | None, str]:
        """Run `code` and collect its outputs: (outputs, exec_count, status), as notebook._execute answers."""
        await self.start()
        return await _on_main(lambda: self._execute(code, timeout, user_expressions or {}))

    def _execute(self, code: str, timeout: float, user_expressions: dict[str, str]) -> tuple[list[dict], int | None, str]:
        """execute() in the process's main thread, where a kernel runs its cells too: a run past `timeout` gets the
        TimeoutError bundle and a KeyboardInterrupt from SIGALRM, as a kernel gets SIGINT; one that does not stop
        within GRACE_S more is given up (dead), its result handed back at once and the process left to end."""
        from . import notebook  # noqa: PLC0415

        self._outputs, self._chunks, self._display_index, self._pending = [], {}, {}, {}
        self._errored = False
        self.last_expr, self.last_result, self.last_reads = None, None, None
        timed_out = [False]

        def collect() -> list[dict]:
            with self._out_lock:
                self._flush_streams()
                outputs = self._outputs or []
                for j, parts in self._chunks.items():
                    outputs[j]["text/plain"] = "".join(parts)
                self._outputs = None
            return outputs

        def on_alarm(signum: int, frame: Any) -> None:
            if not timed_out[0]:
                timed_out[0] = True
                bundle = notebook._error_bundle("TimeoutError", f"execution exceeded {timeout:g} s and was interrupted")
                bundle[notebook.ERROR_MIME]["timeout_s"] = timeout
                with self._out_lock:
                    self._flush_streams()
                    if self._outputs is not None:
                        self._outputs.append(bundle)
                signal.setitimer(signal.ITIMER_REAL, GRACE_S)
                raise KeyboardInterrupt
            self.dead = True  # the code did not stop: its result goes back now, and the runner ends the process
            outputs = collect()
            outputs.append(notebook._error_bundle("KernelDied", "the card's code did not stop after its time limit; "
                                                                "thimble-run gave it up"))
            _give_up((outputs, None, "error"))

        alarm = threading.current_thread() is threading.main_thread()
        old = signal.signal(signal.SIGALRM, on_alarm) if alarm else None
        if alarm and timeout and timeout > 0:
            signal.setitimer(signal.ITIMER_REAL, timeout)
        res: Any = None
        failed = False
        try:
            res = self._run(code, user_expressions)
        except BaseException:  # noqa: BLE001 — an interrupt that landed outside the cell's own frames
            failed = True
        finally:
            if alarm:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, old)
        outputs = collect()
        exec_count = res.execution_count if res is not None else None
        status = "error" if timed_out[0] or failed or self._errored or (res is not None and not res.success) else "ok"
        if res is not None:
            self.last_expr = res.expr
        return outputs, exec_count, status

    def _run(self, code: str, user_expressions: dict[str, str]) -> Any:
        """The cell, with stdout and stderr (Python's and the process's file descriptors) going to its outputs and the
        environment a kernel's (notebook.kernel_env: no keys or tokens)."""
        from . import notebook  # noqa: PLC0415

        saved_env = dict(os.environ)
        saved_out, saved_err = sys.stdout, sys.stderr
        fds = _FdCapture(self)
        try:
            os.environ.clear()
            os.environ.update({**notebook.kernel_env_of(saved_env), **self._env})
            fds.start()
            sys.stdout, sys.stderr = _Stream(self, "stdout"), _Stream(self, "stderr")
            res = self.shell.run_cell(code, store_history=True, silent=False)
            # ipykernel reads the user expressions after a cell that ran clean, and answers {} after one that raised
            expr = self.shell.user_expressions(user_expressions) if res.success else {}
            return _Result(res, expr)
        finally:
            sys.stdout, sys.stderr = saved_out, saved_err
            fds.stop()
            os.environ.clear()
            os.environ.update(saved_env)


class _Result:
    """run_cell's ExecutionResult with the user expressions read after it."""

    def __init__(self, res: Any, expr: dict) -> None:
        self.success = bool(res.success)
        self.execution_count = res.execution_count
        self.expr = expr


class _FdCapture:
    """The process's file descriptors 1 and 2 sent to a cell's outputs while it runs, as ipykernel captures what a
    library or a child process writes there."""

    def __init__(self, kernel: LocalKernel) -> None:
        self.kernel = kernel
        self.saved: dict[int, int] = {}
        self.readers: list[threading.Thread] = []

    def start(self) -> None:
        for fd, name in ((1, "stdout"), (2, "stderr")):
            try:
                sys.__stdout__ and sys.__stdout__.flush()
                sys.__stderr__ and sys.__stderr__.flush()
                r, w = os.pipe()
                self.saved[fd] = os.dup(fd)
                os.dup2(w, fd)
                os.close(w)
            except OSError:
                continue
            t = threading.Thread(target=self._read, args=(r, name), daemon=True)
            t.start()
            self.readers.append(t)

    def _read(self, r: int, name: str) -> None:
        with os.fdopen(r, "rb", buffering=0) as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    return
                self.kernel._stream(name, chunk.decode("utf-8", "replace"))

    def stop(self) -> None:
        for fd, keep in self.saved.items():
            with contextlib.suppress(OSError):
                os.dup2(keep, fd)
                os.close(keep)
        self.saved.clear()
        for t in self.readers:
            t.join(timeout=2.0)
        self.readers.clear()


# The main thread's work for the runner's event loop, which runs in a thread of its own (serve): each item is (a
# function, the future of its result); None ends the service.
_main_work: "queue.Queue[tuple[Any, concurrent.futures.Future] | None] | None" = None
_current: list[concurrent.futures.Future] = []  # the future of the work the main thread runs now


async def _on_main(fn: Any) -> Any:
    """`fn()` in the process's main thread when serve() runs this loop, else in a worker thread (no signal limits)."""
    if _main_work is None:
        return await asyncio.to_thread(fn)
    fut: concurrent.futures.Future = concurrent.futures.Future()
    _main_work.put((fn, fut))
    return await asyncio.wrap_future(fut)


def _give_up(result: Any) -> None:
    """Hand back the result of the work the main thread cannot finish (a cell that did not stop), and leave the main
    thread to the code: the event loop's thread stores the result, prints it and ends the process."""
    if _current and not _current[-1].done():
        _current[-1].set_result(result)
    while True:
        time.sleep(3600)


def serve(coro: Any) -> Any:
    """Run the coroutine on an event loop in a thread of its own while the main thread runs the cells it hands over
    (_on_main); its result, or its exception raised here."""
    global _main_work
    _main_work = queue.Queue()
    box: dict[str, Any] = {}

    def loop() -> None:
        try:
            box["out"] = asyncio.run(coro)
        except BaseException as e:  # noqa: BLE001 — raised again in the main thread
            box["err"] = e
        finally:
            assert _main_work is not None
            _main_work.put(None)

    t = threading.Thread(target=loop, name="thimble-run-loop", daemon=True)
    t.start()
    try:
        while (item := _main_work.get()) is not None:
            fn, fut = item
            _current.append(fut)
            try:
                out = fn()
                if not fut.done():
                    fut.set_result(out)
            except BaseException as e:  # noqa: BLE001 — the loop's thread reads it from the future
                if not fut.done():
                    fut.set_exception(e)
            finally:
                _current.pop()
        t.join()
    finally:
        _main_work = None
    if "err" in box:
        raise box["err"]
    return box["out"]


_kernels: dict[str, LocalKernel] = {}


def install() -> None:
    """Make this process a card runner: every kernel the run path asks for is this process's one shell
    (notebook.local_kernel), and a label's apply waits for its end, since the run ends with this process."""
    from . import concepts, notebook  # noqa: PLC0415

    def factory(workspace: str, kernel: str | None = None) -> LocalKernel:
        k = _kernels.get(workspace)
        if k is None:
            k = _kernels[workspace] = LocalKernel(workspace)
        return k

    notebook.local_kernel = factory
    concepts.APPLY_WAIT_S = float("inf")


# --------------------------------------------------------------------------- thimble-run card


class RunError(Exception):
    """A run `thimble-run` refuses, with the line it prints."""


def _ctx(c: str) -> Any:
    from . import tools  # noqa: PLC0415

    return tools.Ctx(c, tools.ANALYST)


def _run_lock(ws: Path, cid: str) -> Path:
    return ws / RUNS_DIR / f"{cid}.run.lock"


_held_runs: list[int] = []  # the fds of the run locks this process holds until it ends


def hold_run(ws: Path, cid: str) -> None:
    """Take card `cid`'s run lock for the rest of this process: the shim's CardWatch reads a run whose lock is free as
    one whose process is gone. A lock, not the pid, since main's sandbox runs `thimble-run` in a pid namespace of its
    own."""
    import fcntl  # noqa: PLC0415

    p = _run_lock(ws, cid)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0), 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    _held_runs.append(fd)


def run_alive(ws: Path, cid: str) -> bool:
    """Whether a `thimble-run` process holds card `cid`'s run lock (hold_run)."""
    import fcntl  # noqa: PLC0415

    try:
        fd = os.open(_run_lock(ws, cid), os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    except OSError:
        return False
    finally:
        os.close(fd)  # closing it lets go of a lock taken here
    return False


async def run_card(c: str, cid: str) -> tuple[str, int]:
    """Run card `cid`'s code (module note): (the text add_card answers with in browser mode, 0, or 1 when the code
    errored)."""
    from . import card_check, notebook, tools  # noqa: PLC0415

    ws = config.workspace_dir(c)
    hold_run(ws, cid)
    with notebook.editing(ws):
        hit = notebook._locate(ws, cid)
        if hit is None:
            raise RunError(f"thimble-run: there is no card:{cid} in this workspace")
        nb, cell = hit
        if not notebook.runnable(cell):
            raise RunError(f"thimble-run: card:{cid} is a {cell.get('kind')} card, which has no code to run")
        run = dict(cell.get(notebook.RUN_KEY) or {})
        run.update(state=RUNNING, by=BY, pid=os.getpid(), started=_now())
        run.setdefault("script", f"{RUNS_DIR}/{cid}.py")
        cell[notebook.RUN_KEY] = run
        if cell.get("check") == PENDING:  # a check its last run asked for, which this run replaces
            cell.pop("check")
    default_s = run.get("default_timeout_s")
    stored, full = await notebook._execute_cell(c, nb, cell, None, None,
                                                float(default_s) if isinstance(default_s, (int, float)) else None)
    kept = run.get("kept")
    if isinstance(kept, str) and kept and notebook.outputs_text(full.get("outputs") or []) != kept:
        full[notebook.TAKEAWAY_STALE] = True
        notebook._mark_takeaway_stale(c, cid)
    ctx = _ctx(c)
    kind = str(full.get("kind") or notebook.DEFAULT_KIND)
    text = tools._format_cell_result(full, lines=tools.result_lines(c)) + tools._run_hint(full, kind)
    line, noted = tools._takeaway_after(ctx, cid, run.get("takeaway"), full)
    if line:
        text += f"\n\n{line}"
    after = notebook.get_cell(c, cid) or full
    if not noted:
        text += tools._takeaway_missing(ctx, str(after.get("notebook") or ""), {**after, "status": full.get("status")})
    _finish(c, cid, str(full.get("status") or ""), check=card_check.enabled() and card_check.auto(c))
    return text, 1 if full.get("status") != "ok" else 0


def _finish(c: str, cid: str, status: str, *, check: bool) -> None:
    """The card's `run` record ended (the takeaway and kept text it carried are spent), and `check: "pending"` when its
    card check is to start (card_check.wants_check), for the shim's CardWatch."""
    from . import card_check, notebook  # noqa: PLC0415

    ws = config.workspace_dir(c)
    with notebook.editing(ws):
        hit = notebook._locate(ws, cid)
        if hit is None:
            return
        nb, cell = hit
        run = {k: v for k, v in (cell.get(notebook.RUN_KEY) or {}).items() if k not in ("takeaway", "kept", "pid")}
        run.update(state=DONE, ended=_now(), status=status)
        cell[notebook.RUN_KEY] = run
        if check and card_check.wants_check(cell):
            cell["check"] = PENDING
        notebook.write_notebook(ws, nb)
    notebook._emit(c, cell)


# --------------------------------------------------------------------------- thimble-run label and stale


async def run_label(c: str, ident: str) -> tuple[str, int]:
    """Run the code label `ident` (its id or name) that apply_label left waiting (concepts.PENDING_RUN): the same call
    apply_label made, run here, where the code runs. (apply_label's result, 0 or 1 when the call failed.)"""
    from . import concepts, tools  # noqa: PLC0415

    ws = config.workspace_dir(c)
    concept = concepts.find_concept(ws, ident)
    if concept is None:
        raise RunError(f"thimble-run: there is no label {ident!r} in this workspace")
    pending = concept.get(concepts.PENDING_RUN)
    if not isinstance(pending, dict) or not isinstance(pending.get("args"), dict):
        raise RunError(f"thimble-run: label {concept['name']!r} has no run waiting; apply_label starts one")
    concepts.told_in_label_done(c, str(concept["id"]))  # its reruns go in this run's text, not in an event
    res = await tools.call(c, "apply_label", dict(pending["args"]), session=pending.get("session") or None)
    concepts.clear_pending_run(c, str(concept["id"]))
    text = res.text.split("\n", 1)[1] if res.text.startswith("$ ") else res.text  # the call line is the command's
    reran = await concepts.reruns_of(c, str(concept["id"]))
    if reran:
        text += "\n\n" + concepts.rerun_note(c, reran)
    return text, 1 if res.is_error else 0


async def run_stale(c: str) -> tuple[str, int]:
    """Run again every card that read a label at an older revision (concepts.stale_cards, notebook.rerun_on_labels).
    (The cards that need their author, as rerun_readers tells main of them in browser mode: each one whose takeaway the
    new output left behind, or that failed, with its output; 0, or 1 when one failed.)"""
    from . import concepts, notebook  # noqa: PLC0415

    ws = config.workspace_dir(c)
    cards: list[dict] = []
    for concept in concepts.list_concepts(ws):
        cards.extend(x for x in concepts.stale_cards(ws, concept) if x["id"] not in {y["id"] for y in cards})
    if not cards:
        return "thimble-run: no card reads a label that changed since it ran.", 0
    ran = []
    for cell in cards:
        got = await notebook.rerun_on_labels(c, str(cell["id"]))
        if got is not None:
            ran.append(notebook.get_cell(c, str(cell["id"])) or got)
    if not ran:
        return "thimble-run: no card needed to run again.", 0
    told = [x for x in ran if x.get("status") != "ok" or x.get(notebook.TAKEAWAY_STALE)]
    if not told:
        return f"thimble-run: ran {len(ran)} card(s) again; none needs you.", 0
    return concepts.rerun_text(c, told), 1 if any(x.get("status") != "ok" for x in told) else 0


# --------------------------------------------------------------------------- the shim's watch


class CardWatch:
    """A task of the shim's event loop in terminal mode: once a second it looks at the workspace's group files, and
    when one changed it starts the card check of each card marked `check: "pending"` (card_check.start, which skips a
    card without Chromium or the built frontend as browser mode does) and marks interrupted a card whose `thimble-run`
    process is gone mid-run (its run lock is free: hold_run). The check runs on this loop and ends with the session, as a
    browser-mode check ends with its server."""

    _tasks: dict[str, asyncio.Task] = {}

    @classmethod
    def start(cls, c: str) -> asyncio.Task:
        """Start the watch of workspace `c` on the running loop, once per process. RuntimeError with no running loop."""
        task = cls._tasks.get(c)
        if task is not None and not task.done():
            return task
        task = asyncio.get_running_loop().create_task(cls(c).run(), name=f"thimble-cardwatch-{c}")
        cls._tasks[c] = task
        return task

    @classmethod
    def stop_all(cls) -> None:
        for task in cls._tasks.values():
            task.cancel()
        cls._tasks.clear()

    def __init__(self, c: str) -> None:
        self.c = c
        self.seen: dict[str, tuple[int, int]] = {}
        self.ended: dict[str, Any] = {}  # card -> its run's `ended` as last seen, so each run is recorded once
        self.primed = False  # the first look only notes the runs that ended before this session

    async def run(self) -> None:
        while True:
            try:
                self.look()  # on the loop: a check it starts is a task of this loop
            except Exception:  # noqa: BLE001 — the watch outlives a bad file
                log.exception("%s: the card watch failed once", self.c)
            await asyncio.sleep(WATCH_S)

    def changed(self) -> list[Path]:
        from . import notebook  # noqa: PLC0415

        d = notebook.notebooks_dir(config.workspace_dir(self.c))
        out = []
        for p in sorted(d.glob("*.json")) if d.is_dir() else ():
            try:
                st = p.stat()
            except OSError:
                continue
            sig = (st.st_mtime_ns, st.st_size)
            if self.seen.get(p.name) != sig:
                self.seen[p.name] = sig
                out.append(p)
        return out

    def look(self) -> None:
        from . import canvas_history, card_check, notebook  # noqa: PLC0415

        ws = config.workspace_dir(self.c)
        for p in self.changed():
            if not notebook.ID_RE.match(p.stem):
                continue
            nb = notebook.read_notebook(ws, p.stem)
            for cell in (nb or {}).get("cells") or []:
                run = cell.get(notebook.RUN_KEY) if isinstance(cell.get(notebook.RUN_KEY), dict) else {}
                cid = str(cell.get("id") or "")
                if run.get("state") == DONE and self.ended.get(cid) != run.get("ended"):
                    self.ended[cid] = run.get("ended")
                    if self.primed:  # the run's change, recorded here as the server records a kernel run's
                        with canvas_history.acting(str(cell.get("created_by") or "") or None):
                            notebook._emit(self.c, cell)
                if cell.get("check") == PENDING:
                    author = card_check.author_of(run.get("session") or None)
                    self._clear_pending(ws, str(cell["id"]))
                    card_check.start(self.c, str(cell["id"]), author)
                elif run.get("state") == RUNNING and not run_alive(ws, cid):
                    self._interrupted(ws, cid)
        self.primed = True

    def _clear_pending(self, ws: Path, cid: str) -> None:
        from . import notebook  # noqa: PLC0415

        with notebook.editing(ws):
            hit = notebook._locate(ws, cid)
            if hit is not None and hit[1].get("check") == PENDING:
                hit[1].pop("check", None)
                notebook.write_notebook(ws, hit[0])

    def _interrupted(self, ws: Path, cid: str) -> None:
        from . import notebook  # noqa: PLC0415

        with notebook.editing(ws):
            hit = notebook._locate(ws, cid)
            if hit is None:
                return
            nb, cell = hit
            run = cell.get(notebook.RUN_KEY) or {}
            if run.get("state") != RUNNING or run_alive(ws, cid):
                return
            cell[notebook.RUN_KEY] = {**{k: v for k, v in run.items() if k != "pid"}, "state": DONE, "ended": _now(),
                                      "status": "error"}
            if cell.get("status") == "running":
                cell.update(status="error", outputs=[notebook._error_bundle(DEAD_ENAME, DEAD_EVALUE)], ts=_now())
            notebook.write_notebook(ws, nb)
        notebook._emit(self.c, cell)


# --------------------------------------------------------------------------- the command line


USAGE = "usage: thimble-run card <card id> | label <label id or name> | stale"


def _workspace(cid: str | None = None) -> str:
    """The workspace of this Bash's folder, else THIMBLE_WS's; with `cid`, the first of the two that holds that card."""
    from . import local, notebook  # noqa: PLC0415

    found = []
    for c in (local.workspace(os.getcwd()), local.workspace(None)):
        if c and c not in found:
            found.append(c)
    if not found:
        raise RunError(f"thimble-run: {os.getcwd()} is not inside a corpus thimble knows")
    if cid:
        for c in found:
            if notebook.find_cell(config.workspace_dir(c), cid) is not None:
                return c
    return found[0]


def main(argv: list[str]) -> int:
    """`thimble-run card <id> | label <id or name> | stale` (module note): prints the result's text, exits 0, or 1
    when the code errored or the run was refused."""
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="thimble-run %(levelname)s: %(message)s")
    if not argv or argv[0] not in ("card", "label", "stale") or (argv[0] != "stale" and len(argv) < 2):
        print(USAGE, file=sys.stderr)
        return 2
    kind = argv[0]
    ident = argv[1].strip().removeprefix("card:").removeprefix("concept:") if len(argv) > 1 else ""
    from . import local  # noqa: PLC0415

    local.settle_dirs()
    try:
        c = _workspace(ident if kind == "card" else None)
        from . import local  # noqa: PLC0415

        if not local.terminal(c):
            raise RunError("thimble-run: this workspace's session runs in browser mode, where the kernel runs cards")
        install()
        stop = _on_term(c, ident if kind == "card" else "")
        try:
            text, code = serve(_main(c, kind, ident))
        finally:
            stop()
    except RunError as e:
        print(str(e))
        return 1
    sys.stdout.write(text.rstrip() + "\n")
    sys.stdout.flush()
    return code


async def _main(c: str, kind: str, ident: str) -> tuple[str, int]:
    if kind == "card":
        out = await run_card(c, ident)
    elif kind == "label":
        out = await run_label(c, ident)
    else:
        out = await run_stale(c)
    await _drain()
    if any(k.dead for k in _kernels.values()):  # the main thread is stuck in the card's code: end here
        sys.stdout.write(out[0].rstrip() + "\n")
        sys.stdout.flush()
        os._exit(out[1])
    return out


JOB_WORKER = "thimble-job-worker-"  # the name of jobs.py's workers, which wait for work for ever


async def _drain(timeout: float = 60.0) -> None:
    """Wait for the work a run left on this loop (the labels chat that follows a label's run, a rerun, the job that
    links a takeaway's numbers), up to `timeout` s, since it ends with this process. jobs.py's idle workers do not
    count."""
    me = asyncio.current_task()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        left = [t for t in asyncio.all_tasks() if t is not me and not t.done() and not t.get_name().startswith(JOB_WORKER)]
        jobs = sys.modules.get("app.jobs")
        if not left and not (jobs is not None and getattr(jobs, "_active", None)):
            return
        if left:
            await asyncio.wait(left, timeout=min(0.5, max(0.05, deadline - time.monotonic())))
        else:
            await asyncio.sleep(0.05)


def _on_term(c: str, cid: str) -> Any:
    """On SIGTERM (Bash's timeout stops the command), the card's run is ended as interrupted before the process goes;
    returns the function that puts the old handler back."""
    if not cid:
        return lambda: None

    def handler(signum: int, frame: Any) -> None:
        from . import notebook  # noqa: PLC0415

        try:
            ws = config.workspace_dir(c)
            with notebook.editing(ws):
                hit = notebook._locate(ws, cid)
                if hit is not None:
                    nb, cell = hit
                    run = cell.get(notebook.RUN_KEY) or {}
                    cell[notebook.RUN_KEY] = {**{k: v for k, v in run.items() if k != "pid"}, "state": DONE,
                                              "ended": _now(), "status": "error"}
                    if cell.get("status") == "running":
                        cell.update(status="error", outputs=[notebook._error_bundle(DEAD_ENAME, DEAD_EVALUE)],
                                    ts=_now())
                    notebook.write_notebook(ws, nb)
        finally:
            os._exit(143)

    try:
        old = signal.signal(signal.SIGTERM, handler)
    except ValueError:  # not the main thread
        return lambda: None
    return lambda: signal.signal(signal.SIGTERM, old)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
