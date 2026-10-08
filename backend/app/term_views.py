"""Terminal views: a view's view.term.js drawn in thimble-term's panel, as its view.html is drawn in the browser.

A view built in terminal mode has view.term.js beside its reader.py: a program the view builder writes on the terminal
view kit (term_kit/kit.mjs, docs/terminal-views.md). The program runs sandboxed, as a view's page runs in a sandboxed
iframe: one process per open view, alive while the view is open, which reads no file, opens no socket and starts no
process. It hears the panel's size, the theme, what thimble keeps for the view, the analyst's keys and clicks and the
answers of its reader queries, and answers each with a frame: rows of styled runs, their hot regions, the keys it binds
and the words of its hint row.

    thimble-term ──POST /open /event /close──▶ host (this module, `thimble view host`) ──stdin──▶ sandboxed program
                 ◀────── stdout: frames ──────                                       ◀──stdout──  (runtime.mjs + kit)

The host is one process per Claude Code session, started by thimble-term the first time a view opens: it serves
thimble-term over a Unix socket in a private folder (each request carries the token it printed), runs each open view's
program, answers the program's reader queries through thimble's sandboxed views kernel (views.reader_call, on kernels
of its own, `term-views`), keeps what the program asks to keep per view (terminal/views/<slug>.json in the workspace),
and prints the frames the program draws on its own (after an answer) for thimble-term to draw. An act the program asks
for (a record's place, a side thread, a label's panel) reaches thimble-term only with the frame that answers the
analyst's own key or click, as the browser's label calls need the analyst's gesture; a label the analyst checks in
Color by, or chooses in Filter by or Rows, the host itself turns on in Files and every view, as show_label does
(Program.show_labels).

The sandbox (sandbox_argv): Node's permission model inside Anthropic's sandbox runtime (srt), or inside bubblewrap where
srt does not run. Node lets the program read only the kit's folder and start no child process, worker, addon or WASI;
srt (or bubblewrap) gives it no network (srt's proxy refuses every host and, on Linux, a network namespace of its own;
bubblewrap unshares the network) and hides the home folder, thimble's folders, the temp folders and where user data
lives. A machine where neither runs draws no terminal view (the panel says why).

`thimble view text <slug> --cwd <dir> --width 120` (draw_text) draws a view as text with no Claude Code, for the tests.
draw_check draws a view's draft the same way for its checks (views.term_draws: at 120 and 200 columns, in light and
dark) and its reviewer's pictures (view_review.py), and says whether the program failed, timed out or drew past the
panel; with `sweep`, the test label on, it then tries every choice of the kit's Color by, Filter by and Rows the program
drew, as the browser's checks try a page's (Program.sweep), and says which gave an error.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import pwd
import re
import secrets
import shutil
import signal
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

from . import config

log = logging.getLogger("thimble.term_views")

VIEW_TERM = "view.term.js"
KIT_DIR = Path(__file__).with_name("term_kit")
RUNTIME = KIT_DIR / "runtime.mjs"
KERNEL = "term-views"  # the host's reader kernels (view_calls.KERNEL), apart from the shim's `views`
STATE_DIR = "terminal/views"  # under the workspace: what each view keeps (its Color by choice, its time range)
NODE_PERMISSION = (22, 13)  # Node's `--permission`; older Nodes spell it `--experimental-permission`
NODE_MIN = (20, 11)
MEMORY_MB = 256  # the program's heap
EVENT_WAIT_S = 2.0  # how long an event waits for the frame that answers it
START_WAIT_S = 20.0  # how long a program has to draw its first frame
SETTLE_QUIET_S = 0.25  # a ticker of this period or less draws frame after frame: settle waits for this long without one
SETTLE_MAX_S = 120.0
IDLE_DUE_S = 0.5  # a timer a program waits on that is due later than this is its clock, not work it is doing
SYNC_WAIT_S = 2.0  # how long a sync waits for the program's answer
# the longest message a program takes (runtime.mjs LINE_MAX): a reader answer longer than this reaches the program as an
# error that says to page it, rather than being dropped, which would leave the view loading for good
ANSWER_MAX = 16 * 1024 * 1024
# the view checks' draws of a view built in terminal mode (views.term_draws): its columns and theme as it opens, each
# CHECK_ROWS tall, as a laptop's terminal and a large screen show the panel
CHECK_DRAWS = ((120, "light"), (120, "dark"), (200, "light"), (200, "dark"))
CHECK_ROWS = 40
# the checks' sweep of the kit's choices (Program.sweep): the choices one sweep tries, and how long one is waited for
SWEEP_MAX = 40
CHOICE_WAIT_S = 10.0
# the acts a program makes during the analyst's key or click: a record's place, a side thread, a label's panel, which
# thimble-term does, and a label turned on or off in Files (`show`), which the host does (Program.show_labels)
ACT_KINDS = ("open", "ask", "label", "show")
IDLE_S = 600.0  # the host ends this long after its last view closed
LINE_MAX = 8 * 1024 * 1024
ENV_KEEP = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ")
TOKEN_HEADER = "x-thimble-token"
NOT_TERMINAL = ("This view was built in browser mode, so only the browser draws it. To see it, quit, run `thimble mode "
                "browser`, and start `thimble` again in this folder.")


class TermViewError(Exception):
    """A view that cannot be drawn in the terminal, with the line the panel shows."""


class SandboxError(TermViewError):
    """No sandbox runs on this machine, so no view program runs."""


# --------------------------------------------------------------------------------------------------------- the view


def term_view(c: str, slug: str, *, live: bool = False) -> tuple[dict[str, Any], str]:
    """(the view as it last passed its checks, its view.term.js) for workspace `c`; TermViewError for a view that is
    not there, never passed, or has no view.term.js (built in browser mode). `live`: the view's live folder, its draft,
    which the view's checks draw (draw_check)."""
    from . import views  # noqa: PLC0415

    view = views.read_view(c, slug) if live else views.read_built(c, slug)
    if view is None or not view.get("dir"):
        raise TermViewError(f"there is no view {slug!r}")
    path = Path(view["dir"]) / VIEW_TERM
    if not path.is_file():
        raise TermViewError(NOT_TERMINAL)
    return view, path.read_text("utf-8")


def has_term(view: dict[str, Any] | None) -> bool:
    """Whether a view record's folder holds a view.term.js."""
    d = (view or {}).get("dir")
    return bool(d) and (Path(d) / VIEW_TERM).is_file()


def labels_list(c: str, claimed: list[str] | None = None) -> list[dict[str, Any]]:
    """Every label over files as the kit's Color by lists it: views.label_definition's {id, name, kind, text, spec,
    scope, values: [{name, highlight, meaning, n}]}, with `here` for a label whose scope holds one of the view's files
    and `on` for one the analyst turned on in Files or filters by, which the view opens colored by, as in the browser."""
    from . import concepts, views  # noqa: PLC0415

    try:
        ws = config.workspace_dir(c)
        ks = concepts.list_concepts(ws)
    except Exception:  # noqa: BLE001 — a view draws without labels
        return []
    try:
        f = concepts.read_filters(ws).get("files") or {}
    except Exception:  # noqa: BLE001
        f = {}
    out: list[dict[str, Any]] = []
    for k in ks:
        if k.get("unit") not in concepts.FILE_UNITS or k.get("marks") == "file":
            continue
        d = views.label_definition(c, k["id"])
        if d is None:
            continue
        glob = d.get("scope") or ""
        # a label run over several globs has them in its scope parted by ", "
        globs = [g for g in re.split(r",\s+", glob) if g.strip()]
        d["here"] = not globs or claimed is None or any(views.glob_matches(p, g) for g in globs for p in claimed)
        d["on"] = bool(k.get("shown") or f.get("concept") == k["id"])
        out.append(d)
    return out


def probe_label() -> dict[str, Any]:
    """The checks' test label (views.probe_context) as labels_list lists a label: on, over the view's files, its one
    value marking about one record in PROBE_EVERY, as the browser's checks' `choices` state has it."""
    from . import kernel_thimble, views  # noqa: PLC0415

    name = kernel_thimble.PROBE_NAME
    return {"id": kernel_thimble.PROBE_ID, "name": name, "kind": "", "text": "", "spec": "", "scope": "",
            "values": [{"name": name, "highlight": True, "n": None,
                        "meaning": f"the checks' test label: about one record in {views.PROBE_EVERY}"}],
            "here": True, "on": True}


def labels_signature(c: str) -> str:
    """A stamp of the workspace's labels: their files' names, sizes and times, so the host sees a label change."""
    try:
        ws = config.workspace_dir(c)
    except Exception:  # noqa: BLE001
        return ""
    parts = []
    for sub in ("concepts", "labels"):
        d = ws / sub
        with contextlib.suppress(OSError):
            for p in sorted(d.iterdir()):
                st = p.stat()
                parts.append(f"{sub}/{p.name}:{st.st_size}:{st.st_mtime_ns}")
    with contextlib.suppress(OSError):
        st = (ws / "filters.json").stat()
        parts.append(f"filters:{st.st_size}:{st.st_mtime_ns}")
    return "|".join(parts)


def state_path(c: str, slug: str) -> Path:
    return config.workspace_dir(c) / STATE_DIR / f"{slug}.json"


def read_state(c: str, slug: str) -> dict[str, Any]:
    try:
        v = json.loads(state_path(c, slug).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def write_state(c: str, slug: str, st: Any) -> None:
    if not isinstance(st, dict):
        return
    text = json.dumps(st, ensure_ascii=False)
    if len(text) > 256 * 1024:
        return
    p = state_path(c, slug)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(text, "utf-8")
    os.replace(tmp, p)


# ------------------------------------------------------------------------------------------------------ the sandbox


def _real(p: Path | str) -> Path:
    return Path(os.path.realpath(p))


def _under(p: Path, root: Path) -> bool:
    return p == root or root in p.parents


def denied_roots() -> list[Path]:
    """What a view's program never reads: the home folder (HOME's and the account's), thimble's home and install tree,
    the workspaces, the data folder, Claude Code's config, the temp folders and where user data lives on the system."""
    from . import cli, kernel_wrap  # noqa: PLC0415

    system = "darwin" if sys.platform == "darwin" else "linux"
    roots = [Path.home(), Path(pwd.getpwuid(os.getuid()).pw_dir), cli.home(), config.claude_config_dir(), config.REPO_ROOT,
             config.WORKSPACES_DIR, config.DATA_DIR, Path("/tmp"), Path(tempfile.gettempdir()),
             *map(Path, kernel_wrap.SRT_HIDDEN[system])]
    out: list[Path] = []
    for r in roots:
        p = _real(r)
        if p != Path("/") and p.exists() and not any(_under(p, q) for q in out):
            out = [q for q in out if not _under(q, p)] + [p]
    return out


def node_problem() -> str:
    """Why no view program runs on this machine for want of Node, '' when its Node is NODE_MIN or newer: what a view
    build in terminal mode needs (views.build_problem_for). The line reaches the orientation and main too, so it names
    what is missing and no command."""
    from . import srt  # noqa: PLC0415

    need = ".".join(map(str, NODE_MIN))
    node = srt.node()
    if not node:
        return f"Terminal views need Node {need}+, and this machine has no Node."
    have = srt.node_version(node) or (0, 0)
    if have < NODE_MIN:
        return f"Terminal views need Node {need}+, and this machine has Node {'.'.join(map(str, have))}."
    return ""


def node_flags(node: str) -> list[str]:
    """Node's permission model for the program: reads in the kit's folder alone, no child process, worker, addon or
    WASI (none is allowed), and a heap of MEMORY_MB."""
    from . import srt  # noqa: PLC0415

    have = srt.node_version(node) or (0, 0)
    flag = "--permission" if have >= NODE_PERMISSION else "--experimental-permission"
    return [flag, f"--allow-fs-read={_real(KIT_DIR)}{os.sep}", f"--max-old-space-size={MEMORY_MB}", "--no-warnings"]


def _short_tmp() -> Path:
    """A private folder for srt's own sockets, with a short path (a Unix socket's path holds about 100 bytes)."""
    base = "/tmp" if Path("/tmp").is_dir() else None
    return Path(tempfile.mkdtemp(prefix="thimble-tv-", dir=base))


def sandbox_argv(wrap: str | None = None) -> tuple[str, list[str], dict[str, str], Path | None]:
    """(the wrapper, the argv, the environment, the folder to remove after) of a view program: `srt` where Anthropic's
    sandbox runtime runs, else `bwrap` on Linux where bubblewrap runs; SandboxError where neither does. `wrap` names one
    (the tests'); `node` alone, Node's permission model with no wrapper, is only for the tests that draw a view as text
    where no sandbox runs."""
    from . import kernel_wrap, srt  # noqa: PLC0415

    node = srt.node()
    if not node:
        raise SandboxError("Node is not installed, and a terminal view runs in Node")
    if (srt.node_version(node) or (0, 0)) < NODE_MIN:
        raise SandboxError(f"Node {'.'.join(map(str, srt.node_version(node) or ()))} is too old for a terminal view")
    program = [node, *node_flags(node), str(_real(RUNTIME))]
    package = srt.package(config.REPO_ROOT)
    choice = wrap or ("srt" if kernel_wrap.srt_works(node, package) else
                      "bwrap" if sys.platform.startswith("linux") and kernel_wrap.works() else "")
    base_env = {k: os.environ[k] for k in ENV_KEEP if k in os.environ}
    base_env.setdefault("LANG", "C.UTF-8")
    if choice == "srt":
        if package is None:
            raise SandboxError(srt.missing(config.REPO_ROOT, node) or "thimble's sandbox runtime is not installed")
        tmp = _short_tmp()
        reads = [_real(KIT_DIR), _real(node).parent]
        if sys.platform.startswith("linux"):
            reads.append(_real(package / "vendor" / "seccomp"))
        settings = {"network": {"allowedDomains": [], "deniedDomains": []},
                    "filesystem": {"denyRead": [str(p) for p in denied_roots()], "allowRead": sorted({str(p) for p in reads}),
                                   "allowWrite": [], "denyWrite": []}}
        (tmp / "home").mkdir()
        (tmp / "tmp").mkdir()
        (tmp / "srt-settings.json").write_text(json.dumps(settings), "utf-8")
        argv = [node, str(package / "dist" / "cli.js"), "--settings", str(tmp / "srt-settings.json"), "--", *program]
        env = {**base_env, "HOME": str(tmp / "home"), "TMPDIR": str(tmp), "CLAUDE_CODE_TMPDIR": str(tmp / "tmp")}
        return "srt", argv, env, tmp
    if choice == "bwrap":
        bwrap = shutil.which("bwrap") or "bwrap"
        argv = [bwrap, "--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session",
                "--ro-bind", "/usr", "/usr"]
        for d in kernel_wrap.SYSTEM_RO[1:]:
            argv += ["--ro-bind-try", d, d]
        for name in ("ld.so.cache", "ld.so.conf", "ld.so.conf.d", "localtime", "ssl", "alternatives"):
            argv += ["--ro-bind-try", f"/etc/{name}", f"/etc/{name}"]
        argv += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
        prefix = _real(node).parent.parent
        if not any(_under(prefix, Path(d)) for d in kernel_wrap.SYSTEM_RO):
            argv += ["--ro-bind", str(prefix), str(prefix)]
        argv += ["--ro-bind", str(_real(KIT_DIR)), str(_real(KIT_DIR)), "--clearenv", "--setenv", "HOME", "/tmp",
                 "--setenv", "LANG", base_env["LANG"], "--chdir", "/", "--", *program]
        return "bwrap", argv, {**base_env, "HOME": "/tmp"}, None
    if choice == "node":
        return "node", program, {**base_env, "HOME": str(_real(KIT_DIR))}, None
    raise SandboxError("neither thimble's sandbox runtime nor bubblewrap runs on this machine, so no view program runs "
                       "here (`thimble doctor` says why)")


# ------------------------------------------------------------------------------------------------------ the program


Push = Callable[[str, dict[str, Any]], None]


class Program:
    """One open view's sandboxed program (module note)."""

    def __init__(self, c: str, slug: str, *, pid: str = "", push: Push | None = None, wrap: str | None = None,
                 keep: bool = True, live: bool = False, answers: int = 0, probe: bool = False) -> None:
        self.c, self.slug, self.id = c, slug, pid or secrets.token_hex(6)
        self.keep = keep  # whether it opens on what the view kept and keeps what changes (False: as the view opens)
        self.live = live  # whether it runs the view's draft and its reader calls read the draft (the view's checks)
        # whether its one label is the checks' test label, on, in place of the workspace's (views.probe_context), as the
        # browser's checks load the page with it
        self.probe = probe
        self.answers_kept = answers  # how many of the reader's answers to keep (`answers`), for the view's checks
        self.answers: list[Any] = []
        self.fetches = 0
        self.failed: list[str] = []  # the reader's errors the program's fetches got
        self.name = slug
        self.push = push
        self.wrap = wrap
        self.proc: asyncio.subprocess.Process | None = None
        self.tmp: Path | None = None
        self.frame: dict[str, Any] | None = None
        self.n = 0
        self.waiting: dict[int, asyncio.Future] = {}
        self.acts: dict[int, list[dict[str, Any]]] = {}
        self.queries: dict[int, asyncio.Task] = {}
        self.last_frame_at = 0.0
        self.errors: list[str] = []
        self.logs: list[str] = []
        self.reader: asyncio.Task | None = None
        self.first = asyncio.get_running_loop().create_future()
        self.closed = False
        self.labels_sig = ""
        self.claimed: list[str] | None = None
        # settle's view of the program: each frame and query it sent (seen), set on each and on each answer (activity),
        # the syncs out and when it last answered one, whether the last settle found it idle (settled), and whether it
        # answered no sync in the last SYNC_WAIT_S of it (unanswered)
        self.seen = 0
        self.activity = asyncio.Event()
        self.syncs: dict[int, asyncio.Future] = {}
        self.sync_n = 0
        self.synced_at = 0.0
        self.settled = False
        self.unanswered = False
        # the lists of choices the program answered (choices), and while the checks try them (sweeping) every error it
        # said and every error frame it drew, in order (said)
        self.asked: dict[int, asyncio.Future] = {}
        self.ask_n = 0
        self.sweeping = False
        self.said: list[str] = []

    def _labels(self) -> list[dict[str, Any]]:
        """The labels the program lists: the workspace's (labels_list), or the checks' test label alone (probe)."""
        return [probe_label()] if self.probe else labels_list(self.c, self.claimed)

    def _ctx(self, want: list[str]) -> dict[str, Any]:
        """The labels context its queries run under: the workspace's (_context), or the test label's (probe)."""
        from . import views  # noqa: PLC0415

        return views.probe_context() if self.probe else _context(self.c, want)

    async def start(self, cols: int, rows: int, theme: str = "dark", ref: str | None = None,
                    text: str = "") -> dict[str, Any]:
        """Start the program and return its first frame. TermViewError when the view or the sandbox cannot run it."""
        from . import views  # noqa: PLC0415

        view, source = await asyncio.to_thread(lambda: term_view(self.c, self.slug, live=self.live))
        self.name = str(view.get("name") or self.slug)
        self.claimed = await asyncio.to_thread(lambda: views.claimed_paths(self.c, view, wait=False))
        wrap, argv, env, self.tmp = await asyncio.to_thread(sandbox_argv, self.wrap)
        self.wrap = wrap
        self.proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                         stderr=asyncio.subprocess.PIPE, env=env, cwd=str(_real(KIT_DIR)),
                                                         start_new_session=True, limit=LINE_MAX)
        self.reader = asyncio.ensure_future(self._read())
        asyncio.ensure_future(self._drain_stderr())
        place = None
        if ref:
            with self._reads():
                place = await views.open_place(self.c, self.slug, ref, views.locator_of(ref))
        self.labels_sig = await asyncio.to_thread(labels_signature, self.c)
        init = {"t": "init", "source": source, "cols": int(cols), "rows": int(rows), "theme": theme,
                "view": {"slug": self.slug, "name": view.get("name") or self.slug},
                "state": await asyncio.to_thread(read_state, self.c, self.slug) if self.keep else {},
                "labels": await asyncio.to_thread(self._labels), "open": place, "text": text}
        await self._send(init)
        try:
            return await asyncio.wait_for(asyncio.shield(self.first), START_WAIT_S)
        except asyncio.TimeoutError:
            await self.close()
            why = self.errors[-1] if self.errors else "it drew nothing"
            raise TermViewError(f"the view's program did not start: {why}") from None

    def _reads(self) -> Any:
        """Where its reader calls read: the view's draft for a live program (views.live_reads), else the view as it last
        passed."""
        from . import views  # noqa: PLC0415

        return views.live_reads() if self.live else contextlib.nullcontext()

    async def _send(self, msg: dict[str, Any]) -> None:
        await self._send_bytes((json.dumps(msg, ensure_ascii=False, default=str) + "\n").encode("utf-8"))

    async def _send_bytes(self, line: bytes) -> None:
        if self.proc is None or self.proc.stdin is None or self.proc.returncode is not None:
            raise TermViewError("the view's program has ended")
        self.proc.stdin.write(line)
        with contextlib.suppress(ConnectionError):
            await self.proc.stdin.drain()

    async def _drain_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").rstrip()
            if text:
                self.errors.append(text[-500:])
                del self.errors[:-20]

    async def _read(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        while True:
            try:
                line = await self.proc.stdout.readline()
            except (ValueError, asyncio.LimitOverrunError):
                self.errors.append("a message of the program was too long")
                continue
            if not line:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict):
                self._take(msg)
        self.closed = True
        why = self.errors[-1] if self.errors else "it ended"
        if not self.first.done():
            self.first.set_exception(TermViewError(f"the view's program ended: {why}"))
        for f in [*self.waiting.values(), *self.syncs.values(), *self.asked.values()]:
            if not f.done():
                f.set_result(None)
        self.activity.set()
        if self.push:
            self.push(self.id, {"t": "ended", "error": why})

    def _take(self, msg: dict[str, Any]) -> None:
        t = msg.get("t")
        if t in ("frame", "query"):
            self.seen += 1
            self.activity.set()
        if t == "synced":
            self.synced_at = time.monotonic()
            f = self.syncs.get(msg.get("id"))
            if f is not None and not f.done():
                f.set_result(msg)
        elif t == "frame":
            self.frame = msg
            self.last_frame_at = time.monotonic()
            if self.sweeping and msg.get("error"):
                self.said.append(str(msg["error"])[:500])
            if not self.first.done():
                self.first.set_result(msg)
                return
            ack = msg.get("ack") or 0
            waited = False
            for n, f in list(self.waiting.items()):
                if n <= ack and not f.done():
                    f.set_result(msg)
                    waited = True
            if not waited and self.push:
                self.push(self.id, {"t": "frame", "frame": msg})
        elif t == "query":
            qid = msg.get("id")
            if isinstance(qid, int):
                self.queries[qid] = asyncio.ensure_future(self._answer(qid, msg.get("q"), msg.get("labels") or []))
        elif t == "cancel":
            task = self.queries.pop(msg.get("id"), None)
            if task is not None:
                task.cancel()
        elif t == "act":
            n, a = msg.get("n"), msg.get("act")
            if isinstance(n, int) and isinstance(a, dict) and a.get("kind") in ACT_KINDS:
                self.acts.setdefault(n, []).append({k: str(v)[:2000] for k, v in a.items()})
        elif t == "choices":
            f = self.asked.get(msg.get("id"))
            if f is not None and not f.done():
                f.set_result(msg.get("choices"))
        elif t == "state" and self.keep:
            with contextlib.suppress(OSError):
                write_state(self.c, self.slug, msg.get("state"))
        elif t == "error":
            self.errors.append(str(msg.get("message") or "")[:500])
            del self.errors[:-20]
            if self.sweeping:
                self.said.append(self.errors[-1])
        elif t == "log":
            self.logs.append(str(msg.get("text") or "")[:500])
            del self.logs[:-50]

    async def _answer(self, qid: int, q: Any, want: list[Any]) -> None:
        from . import views  # noqa: PLC0415

        try:
            data = await self._query(q, [str(x) for x in want][:8])
            msg: dict[str, Any] = {"t": "answer", "id": qid, "data": data}
            if len(self.answers) < self.answers_kept and not (isinstance(q, dict) and views.KIT_QUERY in q):
                self.answers.append(data)
        except asyncio.CancelledError:
            return
        except views.ReaderError as e:
            msg = {"t": "answer", "id": qid, "error": e.message}
            self.failed.append(e.message[:500])
        except Exception as e:  # noqa: BLE001 — the program shows what failed
            log.warning("view %s: a query failed", self.slug, exc_info=True)
            msg = {"t": "answer", "id": qid, "error": f"{type(e).__name__}: {e}"}
        finally:
            self.queries.pop(qid, None)
        self.last_frame_at = time.monotonic()  # the frame the answer brings is due: settle waits for it
        line = (json.dumps(msg, ensure_ascii=False, default=str) + "\n").encode("utf-8")
        if len(line) > ANSWER_MAX:
            why = (f"the reader's answer is {len(line) / 1048576:.1f} MB, more than the {ANSWER_MAX // 1048576} MB one fetch "
                   "takes: answer in pages (a `from` in the query, the next page's start in the answer)")
            self.failed.append(why)
            line = (json.dumps({"t": "answer", "id": qid, "error": why}) + "\n").encode("utf-8")
        with contextlib.suppress(TermViewError, ConnectionError):
            await self._send_bytes(line)
        self.activity.set()

    async def _query(self, q: Any, want: list[str]) -> Any:
        """A reader query: the view kit's own ({$thimble: label | labels | marks}), else reader.records(index, q) under
        the workspace's labels and those the program colors by."""
        from . import views  # noqa: PLC0415

        if isinstance(q, dict) and views.KIT_QUERY in q:
            what = q.get(views.KIT_QUERY)
            if what == "labels":
                return await asyncio.to_thread(self._labels)
            if what == "marks":
                refs = [str(r) for r in (q.get("refs") or [])][: views.MARKS_MAX]
                ctx = await asyncio.to_thread(self._ctx, want)
                with self._reads():
                    marks = await views.marks_for(self.c, self.slug, refs, ctx)
                return {r: {v["id"]: v["value"] for v in m.get("values") or []} for r, m in marks.items()}
            return (await asyncio.to_thread(views.kit_answer, self.c, q))[1]
        ctx = await asyncio.to_thread(self._ctx, want)
        self.fetches += 1
        with self._reads():
            return await views.reader_call(self.c, self.slug, "records", q, labels=ctx)

    async def event(self, ev: dict[str, Any], wait: float = EVENT_WAIT_S) -> dict[str, Any]:
        """Send an event (resize, key, click, drag, wheel, open) and return {frame, acts}: the frame that answers it (or
        the last one, when the program drew nothing new within `wait`) and the acts made while it was handled."""
        self.n += 1
        n = self.n
        fut = asyncio.get_running_loop().create_future()
        self.waiting[n] = fut
        try:
            await self._send({**ev, "n": n})
            try:
                frame = await asyncio.wait_for(fut, wait)
            except asyncio.TimeoutError:
                frame = None
        finally:
            self.waiting.pop(n, None)
        return {"frame": frame or self.frame, "acts": self.acts.pop(n, [])}

    async def labels_changed(self) -> None:
        if self.probe:
            return
        sig = await asyncio.to_thread(labels_signature, self.c)
        if sig == self.labels_sig:
            return
        self.labels_sig = sig
        from . import views  # noqa: PLC0415

        ctx = await asyncio.to_thread(views.labels_context, self.c)
        with contextlib.suppress(TermViewError, ConnectionError):
            await self._send({"t": "labels", "labels": await asyncio.to_thread(labels_list, self.c, self.claimed),
                              "filter": ctx.get("filter")})

    async def show_labels(self, acts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The `show` acts among `acts` done: each label the analyst checked in Color by, or chose in Filter by or Rows,
        turned on in Files and every view, or one unchecked turned off, as show_label does (concepts.show_concept), and
        the labels sent to the program again. The other acts, for thimble-term."""
        from . import concepts  # noqa: PLC0415

        rest = [a for a in acts if a.get("kind") != "show"]
        shown = [a for a in acts if a.get("kind") == "show" and a.get("id")]
        for a in shown:
            try:
                await asyncio.to_thread(concepts.show_concept, self.c, str(a["id"]), a.get("on") != "off")
            except Exception as e:  # noqa: BLE001 — a label gone or of cards: the view keeps its choice
                log.info("view %s: label %s not turned %s: %s", self.slug, a.get("id"), a.get("on"), e)
        if shown:
            await self.labels_changed()
        return rest

    async def choices(self, wait: float = SYNC_WAIT_S) -> list[tuple[str, str]]:
        """Every choice of the kit's parts the program drew, [(control, choice)] (kit.mjs `choices`), Color by's first;
        none when it does not answer within `wait` seconds."""
        self.ask_n += 1
        n = self.ask_n
        fut = asyncio.get_running_loop().create_future()
        self.asked[n] = fut
        try:
            await self._send({"t": "choices", "id": n})
            got = await asyncio.wait_for(fut, wait)
        except (asyncio.TimeoutError, TermViewError, ConnectionError):
            return []
        finally:
            self.asked.pop(n, None)
        return [(str(x[0]), str(x[1])) for x in got or [] if isinstance(x, list) and len(x) == 2]

    async def sweep(self, wait: float = CHOICE_WAIT_S) -> list[dict[str, Any]]:
        """Every choice of the kit's parts the program drew tried in turn, as the analyst's own key makes it, Color by's
        Off and Filter by's and Rows' None among them, then each part's first choice again after the others, as the
        browser's checks try a page's (view_shot.mjs `sweep`): [{control, choice, errors}], `errors` what the program
        said or drew as an error, and the fetches its reader could not answer, while it drew that choice, each choice
        waited for until the program is idle or `wait` seconds pass."""
        listing = (await self.choices())[:SWEEP_MAX]
        firsts: dict[str, str] = {}
        for control, choice in listing:
            firsts.setdefault(control, choice)
        out: list[dict[str, Any]] = []
        self.sweeping = True
        try:
            for control, choice, again in [*((a, b, False) for a, b in listing), *((a, b, True) for a, b in firsts.items())]:
                if self.closed:
                    break
                self.said.clear()
                failed = len(self.failed)
                await self.event({"t": "choose", "control": control, "choice": choice})
                await self.settle(timeout=wait)
                errors = [*self.said, *(f"a fetch failed: {e}" for e in self.failed[failed:])]
                if self.closed:
                    errors.append(f"the program ended: {self.errors[-1] if self.errors else 'it exited'}")
                out.append({"control": control, "choice": f"{choice} (after the others)" if again else choice,
                            "errors": list(dict.fromkeys(errors))[:3]})
        finally:
            self.sweeping = False
        return out

    def quiet(self, quiet: float = SETTLE_QUIET_S) -> bool:
        """Whether the program is quiet: no query out and no new frame for `quiet` seconds."""
        return not self.queries and time.monotonic() - self.last_frame_at >= quiet

    async def idle(self, wait: float = SYNC_WAIT_S) -> bool | None:
        """Whether the program is idle: no reader query out, everything sent to it handled and the frames that drew out
        (it answers a sync only then, runtime.mjs), nothing new from it meanwhile, no timer it waits on due within
        IDLE_DUE_S, and, while an interval of SETTLE_QUIET_S or less runs (a ticker), no frame for SETTLE_QUIET_S. None
        when it does not answer within `wait` seconds."""
        if self.queries:
            return False
        self.sync_n += 1
        n = self.sync_n
        fut = asyncio.get_running_loop().create_future()
        self.syncs[n] = fut
        seen = self.seen
        try:
            await self._send({"t": "sync", "id": n})
            got = await asyncio.wait_for(fut, wait)
        except (asyncio.TimeoutError, TermViewError, ConnectionError):
            return None
        finally:
            self.syncs.pop(n, None)
        if not isinstance(got, dict):
            return None
        due, every = got.get("due"), got.get("every")
        ticking = isinstance(every, (int, float)) and every <= SETTLE_QUIET_S * 1000 and not self.quiet()
        return (not self.queries and self.seen == seen and not ticking
                and (not isinstance(due, (int, float)) or due > IDLE_DUE_S * 1000))

    async def _activity(self, wait: float) -> None:
        """Until the program sends a frame or a query, an answer goes to it, or `wait` seconds pass."""
        self.activity.clear()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self.activity.wait(), max(0.0, wait))

    async def settle(self, timeout: float = SETTLE_MAX_S) -> dict[str, Any] | None:
        """The frame once the program is idle (draw_text, draw_check), or after `timeout` seconds; `settled` says which.
        It asks the program (idle) as soon as no reader query is out, so a frame drawn quickly is taken at once, and a
        program still at work after its last answer (decoding it, in chunks between timers, or in one stretch that
        leaves its sync unanswered) is waited for."""
        start = time.monotonic()
        end = start + timeout
        self.settled = self.unanswered = False
        while not self.closed and (left := end - time.monotonic()) > 0:
            if self.queries:
                await self._activity(min(left, 0.5))
                continue
            if await self.idle(min(left, SYNC_WAIT_S)):
                self.settled = True
                return self.frame
            await self._activity(min(left, 0.02))
        self.unanswered = not self.queries and time.monotonic() - max(start, self.synced_at) >= SYNC_WAIT_S
        return self.frame

    async def close(self) -> None:
        for task in list(self.queries.values()):
            task.cancel()
        proc, self.proc = self.proc, None
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), 3.0)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(proc.pid, signal.SIGKILL)
                await proc.wait()
        if self.reader is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self.reader, 2.0)
        if self.tmp is not None:
            shutil.rmtree(self.tmp, ignore_errors=True)
            self.tmp = None


def _context(c: str, want: list[str]) -> dict[str, Any]:
    """The labels context a query runs under: the workspace's (views.labels_context), and the labels the program colors
    by although they are not on in Files, so the reader's thimble.colour_value reads them."""
    from . import views  # noqa: PLC0415

    ctx = views.labels_context(c)
    have = {lab["id"] for lab in ctx.get("labels") or []}
    extra = [i for i in want if i not in have]
    if extra:
        ctx = {**ctx, "labels": [*(ctx.get("labels") or []), *views.labels_context(c, only=extra)["labels"]]}
    return ctx


@contextlib.contextmanager
def own_kernels():
    """While inside, this process's reader kernels are its own (`term-views`, apart from the shim's), and it starts no
    spare one beside a slow call: one view is open at a time."""
    from . import view_calls  # noqa: PLC0415

    was = view_calls.KERNEL, view_calls.SPARE_AFTER_S
    view_calls.KERNEL, view_calls.SPARE_AFTER_S = KERNEL, float("inf")
    try:
        yield
    finally:
        view_calls.KERNEL, view_calls.SPARE_AFTER_S = was


async def stop_kernels(c: str) -> None:
    """Shut down the reader kernels this process started for workspace `c`, leaving every other process's alone."""
    from . import view_calls  # noqa: PLC0415

    for w in list(view_calls._pools.get(c, [])):
        with contextlib.suppress(Exception):
            await view_calls._stop(c, w.name)
    view_calls.forget_workspace(c)


# ------------------------------------------------------------------------------------------------------ as text


def _hint_need(h: str) -> int:
    """What a view's hint row keeps first where it has no room for every hint (thimble-term's chrome.tsx hintNeed): ↑↓,
    Enter, the way back, `?` (every key), closing, then the view's own keys."""
    for i, pre in enumerate(("↑↓", "Enter", "b to go back", "? ", "x to close")):
        if h.startswith(pre):
            return i
    return 5


def hint_row(hints: list[str], cols: int | None) -> str:
    """The hint row in `cols` cells, as thimble-term's view panel fits it (fitHints): one row of whole hints parted by
    ` · `, the most needed kept, in their order (every hint with no `cols`)."""
    keep: set[int] = set()
    used = 0
    for i, h in sorted(enumerate(hints), key=lambda x: (_hint_need(x[1]), x[0])):
        add = len(h) + (3 if keep else 0)
        if cols is not None and used + add > cols:
            continue
        keep.add(i)
        used += add
    return " · ".join(h for i, h in enumerate(hints) if i in keep)


def panel_text(view_name: str, frame: dict[str, Any], *, ansi: bool = False, cols: int | None = None) -> str:
    """A frame as thimble-term's panel shows it, with no Claude Code: the view's name, its subtitle, the rule, the
    frame's rows (frame.text), and its hint row with the panel's own keys, fitted to `cols` as the panel fits it."""
    sub = " · ".join(frame.get("sub") or [])
    hints = [hint_row([*(frame.get("hints") or []), "b to go back", "x to close"], cols)]
    body = frame.get("text") or "\n".join("".join(s.get("s", "") for s in line) for line in frame.get("lines") or [])
    width = cols + 2 if cols else max([len(view_name), *(len(x) for x in body.split("\n"))] or [40])
    if ansi:
        head = [f"  \x1b[1;36m{view_name}\x1b[0m", f"  \x1b[2m{sub}\x1b[0m" if sub else None, f"  \x1b[90m{'─' * max(10, width - 2)}\x1b[0m"]
        tail = [f"  \x1b[2;3m{h}\x1b[0m" for h in hints]
    else:
        head = [f"  {view_name}", f"  {sub}" if sub else None, f"  {'─' * max(10, width - 2)}"]
        tail = [f"  {h}" for h in hints]
    return "\n".join([*(h for h in head if h is not None), body, *tail])


async def draw_text(c: str, slug: str, *, cols: int = 120, rows: int = 40, keys: list[str] | None = None,
                    theme: str = "dark", ansi: bool = False, ref: str | None = None, wrap: str | None = None,
                    panel: bool = True) -> str:
    """The view `slug` of workspace `c` drawn as text at `cols` × `rows` (the panel's body), as it opens (not on what
    the analyst's last opening kept, and keeping nothing), after `keys` (key names, `click:<words>` for a click on the
    first hot region whose text holds those words, `drag:<x0>-<x1>` for a drag across those cells of the first region a
    drag moves (the time range's strip), `wheel:<n>` and `wheel:<n>@<words>` for the wheel over the first row that holds
    those words, `text:<words>` for what a field that takes typing holds): what the view checks and the reviewer read,
    with no Claude Code."""
    from . import views  # noqa: PLC0415

    views._bind_loop()
    p = Program(c, slug, wrap=wrap, keep=False)
    try:
        first = await p.start(cols, rows, theme, ref, text="ansi" if ansi else "plain")
        frame = await p.settle() or first
        for k in keys or []:
            ev = _event_of(k, frame)
            if ev is None:
                raise TermViewError(f"no hot region shows {k[6:]!r}" if k.startswith("click:")
                                    else f"no row shows {k.partition('@')[2]!r}" if k.startswith("wheel:")
                                    else "no region takes a drag")
            await p.event(ev)
            frame = await p.settle() or frame
        view = views.read_built(c, slug) or {}
        name = str(view.get("name") or slug)
        return panel_text(name, frame, ansi=ansi, cols=cols) if panel else str(frame.get("text") or "")
    finally:
        await p.close()


async def draw_check(c: str, slug: str, *, cols: int, theme: str, rows: int = CHECK_ROWS, ref: str | None = None,
                     keys: list[str] | None = None, answers: int = 0, wrap: str | None = None,
                     timeout: float | None = None, sweep: bool = False) -> dict[str, Any]:
    """The view's draft (its live folder) drawn as draw_text draws it, for the view's checks (views.term_draws) and its
    reviewer's pictures: {cols, rows, theme, ref, ok, text, error, timeout, overflow, missed, answers, fetches}. Not ok
    for a program that fails (an error it throws, a fetch its reader cannot answer, a program that ends or draws
    nothing), one still busy after `timeout` seconds, SETTLE_MAX_S by default (a fetch still out, or frame after
    frame), or a frame that draws past the panel's rows or columns, which the kit cuts (the frame's `overflow`). `text`
    is the panel as draw_text shows it; `missed` the keys of `keys` that found no hot region; `answers` the first that
    many reader answers. With `sweep` its one label is the checks' test label, on (probe_label), and once it is drawn
    ok every choice of the kit's parts it drew is tried in turn (Program.sweep), each with its errors in `choices`,
    which are no part of the draw's own: `ok`, `text` and the rest are the view as it opens."""
    from . import views  # noqa: PLC0415

    views._bind_loop()
    timeout = SETTLE_MAX_S if timeout is None else timeout
    out: dict[str, Any] = {"cols": cols, "rows": rows, "theme": theme, "ref": ref, "ok": False, "text": "",
                           "missed": [], "answers": [], "fetches": 0}
    p = Program(c, slug, wrap=wrap, keep=False, live=True, answers=answers, probe=sweep)
    try:
        try:
            frame = await p.start(cols, rows, theme, ref, text="plain")
            frame = await p.settle(timeout=timeout) or frame
            for k in keys or []:
                if (ev := _event_of(k, frame)) is None:
                    out["missed"].append(k)
                    continue
                await p.event(ev)
                frame = await p.settle(timeout=timeout) or frame
        except TermViewError as e:
            out["error"] = str(e)
            return out
        # the hint row fitted to the panel's columns, as the panel and draw_text fit it
        out.update(text=panel_text(p.name, frame, cols=cols), answers=p.answers, fetches=p.fetches)
        if p.failed:
            out["error"] = f"a fetch failed: {p.failed[0]}"
        elif frame.get("error"):
            out["error"] = str(frame["error"])
        elif p.closed:
            out["error"] = f"the program ended: {p.errors[-1] if p.errors else 'it exited'}"
        elif not p.settled:
            out["timeout"] = ("a fetch still waits for the reader" if p.queries else "it is still at work: it answers no sync"
                              if p.unanswered else "it draws frame after frame")
        elif isinstance(frame.get("overflow"), dict):
            out["overflow"] = dict(frame["overflow"])
        else:
            out["ok"] = True
        if sweep and out["ok"]:
            out["choices"] = await p.sweep()
            out["fetches"] = p.fetches
        return out
    finally:
        await p.close()


def _event_of(k: str, frame: dict[str, Any]) -> dict[str, Any] | None:
    if k.startswith("click:"):
        words = k[6:]
        lines = ["".join(s.get("s", "") for s in line) for line in frame.get("lines") or []]
        for i, h in enumerate(frame.get("hits") or []):
            text = lines[h["y"]][h["x0"]:h["x1"]] if h["y"] < len(lines) else ""
            if words and words in text:
                return {"t": "click", "i": i, "seq": frame.get("seq"), "x": 0}
        return None
    if k.startswith("drag:"):
        # a drag across the cells x0 to x1 of the first region a drag moves (the time range's strip), as the panel sends it
        a, _, b = k[5:].partition("-")
        for i, h in enumerate(frame.get("hits") or []):
            if h.get("drag"):
                return {"t": "drag", "i": i, "seq": frame.get("seq"), "x0": int(a or 0), "x1": int(b or 0)}
        return None
    if k.startswith("wheel:"):
        # `wheel:<n>@<words>`: the wheel over the first row that shows those words, at their first cell, as the panel
        # sends the cell under the pointer; `wheel:<n>` names no cell, and moves the list that has the keys
        by, _, words = k[6:].partition("@")
        ev: dict[str, Any] = {"t": "wheel", "by": int(by or 0)}
        if not words:
            return ev
        for y, line in enumerate(frame.get("lines") or []):
            text = "".join(s.get("s", "") for s in line)
            if words in text:
                return {**ev, "seq": frame.get("seq"), "x": text.index(words), "y": y}
        return None
    if k.startswith("text:"):
        return {"t": "text", "value": k[5:]}
    return {"t": "key", "key": {"enter": "return", " ": "space"}.get(k, k)}


# ------------------------------------------------------------------------------------------------------ the host


class Host:
    """thimble-term's view host for one session (module note): a Unix socket in a private folder, each request with
    the token printed in the ready line; frames the programs draw on their own on stdout."""

    def __init__(self, c: str) -> None:
        self.c = c
        self.programs: dict[str, Program] = {}
        self.token = secrets.token_hex(16)
        self.dir: Path | None = None
        self.idle_since = time.monotonic()
        self.parent = os.getppid()

    def say(self, msg: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(msg, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()

    def pushed(self, pid: str, msg: dict[str, Any]) -> None:
        self.say({**msg, "id": pid})

    async def serve(self) -> None:
        with own_kernels():
            await self._serve()

    async def _serve(self) -> None:
        from . import views  # noqa: PLC0415

        views._bind_loop()
        self.dir = _short_tmp()
        os.chmod(self.dir, 0o700)
        sock = self.dir / "s"
        server = await asyncio.start_unix_server(self._conn, path=str(sock), limit=LINE_MAX)
        os.chmod(sock, 0o600)
        # thimble-term ends the host with the session (or a reload of its module): the programs, the kernels and the
        # socket's folder go with it
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            with contextlib.suppress(NotImplementedError, RuntimeError, ValueError):
                loop.add_signal_handler(sig, stop.set)
        self.say({"t": "ready", "socket": str(sock), "token": self.token, "pid": os.getpid()})
        try:
            async with server:
                while not stop.is_set():
                    with contextlib.suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(stop.wait(), 1.0)
                    if os.getppid() != self.parent:
                        break
                    for p in list(self.programs.values()):
                        if p.closed:
                            self.programs.pop(p.id, None)
                        else:
                            await p.labels_changed()
                    if self.programs:
                        self.idle_since = time.monotonic()
                    elif time.monotonic() - self.idle_since > IDLE_S:
                        break
        finally:
            for p in list(self.programs.values()):
                await p.close()
            await stop_kernels(self.c)
            shutil.rmtree(self.dir, ignore_errors=True)

    async def _conn(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        status, body = 200, {}
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            lines = head.decode("latin-1").split("\r\n")
            method, path = (lines[0].split(" ") + ["", ""])[:2]
            headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:] if ln)}
            n = int(headers.get("content-length") or 0)
            raw = await reader.readexactly(n) if n else b""
            if not secrets.compare_digest(headers.get(TOKEN_HEADER, ""), self.token):
                status, body = 403, {"error": "no token"}
            elif method != "POST":
                status, body = 405, {"error": "POST only"}
            else:
                req = json.loads(raw or b"{}")
                body = await self._route(path.split("?")[0], req if isinstance(req, dict) else {})
        except TermViewError as e:
            body = {"error": str(e)}
        except Exception as e:  # noqa: BLE001 — thimble-term shows the line
            log.warning("view host: a request failed", exc_info=True)
            status, body = 500, {"error": f"{type(e).__name__}: {e}"}
        data = json.dumps(body, ensure_ascii=False, default=str).encode("utf-8")
        writer.write(f"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n"
                     f"Connection: close\r\n\r\n".encode("latin-1") + data)
        with contextlib.suppress(ConnectionError):
            await writer.drain()
        writer.close()

    async def _route(self, path: str, req: dict[str, Any]) -> dict[str, Any]:
        if path == "/open":
            slug = str(req.get("slug") or "")
            old = self.programs.pop(str(req.get("replace") or ""), None)
            if old is not None:
                await old.close()
            p = Program(self.c, slug, push=self.pushed)
            frame = await p.start(int(req.get("cols") or 100), int(req.get("rows") or 30), str(req.get("theme") or "dark"),
                                  str(req["ref"]) if req.get("ref") else None)
            self.programs[p.id] = p
            return {"id": p.id, "frame": frame, "wrap": p.wrap}
        p = self.programs.get(str(req.get("id") or ""))
        if path == "/close":
            if p is not None:
                self.programs.pop(p.id, None)
                await p.close()
            return {"ok": True}
        if p is None:
            raise TermViewError("the view is not open")
        if path == "/event":
            ev = req.get("event")
            if not isinstance(ev, dict) or ev.get("t") not in ("resize", "key", "text", "click", "drag", "wheel", "open"):
                raise TermViewError("no such event")
            if ev.get("t") == "open":
                from . import views  # noqa: PLC0415

                ref = str(ev.get("ref") or "")
                ev = {"t": "open", "place": await views.open_place(self.c, p.slug, ref, views.locator_of(ref))}
            got = await p.event(ev)
            # a label the analyst checked or chose is turned on here; the rest are thimble-term's to do
            return {**got, "acts": await p.show_labels(got["acts"])}
        raise TermViewError(f"no route {path}")


# ------------------------------------------------------------------------------------------------------ the command

USAGE = ("thimble view host --cwd <dir> | thimble view text <slug> --cwd <dir> [--width N] [--height N] "
         "[--keys 'down return …'] [--open <ref>] [--theme light] [--ansi]")


def main(argv: list[str]) -> int:
    """`view host --cwd <dir>`: the host thimble-term starts (module note), until its parent ends. `view text <slug>
    --cwd <dir> …`: the view drawn as text (draw_text), printed."""
    from . import local  # noqa: PLC0415

    if not argv or argv[0] not in ("host", "text"):
        sys.stdout.write(json.dumps({"error": f"usage: {USAGE}"}) + "\n")
        return 1
    verb, rest = argv[0], argv[1:]
    cwd = local._flag(rest, "--cwd", os.getcwd()) or os.getcwd()
    c = local.workspace(cwd)
    if not c:
        sys.stdout.write(json.dumps({"error": f"{cwd} is not inside a corpus thimble knows"}) + "\n")
        return 1
    if verb == "host":
        asyncio.run(Host(c).serve())
        return 0
    pos = local._positional(rest)
    if not pos:
        sys.stdout.write(json.dumps({"error": f"usage: {USAGE}"}) + "\n")
        return 1
    keys = (local._flag(rest, "--keys", "") or "").split()
    try:
        out = asyncio.run(_text_main(c, pos[0], int(local._flag(rest, "--width", "120") or 120),
                                     int(local._flag(rest, "--height", "40") or 40), keys,
                                     local._flag(rest, "--theme", "dark") or "dark", "--ansi" in rest,
                                     local._flag(rest, "--open", None)))
    except TermViewError as e:
        sys.stdout.write(json.dumps({"error": str(e)}) + "\n")
        return 1
    sys.stdout.write(out + "\n")
    return 0


async def _text_main(c: str, slug: str, cols: int, rows: int, keys: list[str], theme: str, ansi: bool,
                     ref: str | None) -> str:
    with own_kernels():
        try:
            return await draw_text(c, slug, cols=cols, rows=rows, keys=keys, theme=theme, ansi=ansi, ref=ref)
        finally:
            await stop_kernels(c)

