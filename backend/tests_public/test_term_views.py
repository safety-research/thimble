"""Terminal views (app/term_views.py, app/term_kit): a view's view.term.js runs sandboxed, one process per open view, and
draws the view in thimble-term's panel. The sandbox lets it read no file and open no socket; the host answers its
reader queries through the views' reader calls and passes its acts on only with the frame that answers the analyst's
key or click; `draw_text` draws a view as text with no Claude Code, as the worked example Timeline shows at 120 and 200
columns. Reader calls run in this process (views._runner), so no kernel starts."""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path

import pytest

from app import config, kernel_wrap, local, srt, term_views, views

NODE = srt.node()
SRT = srt.package(config.REPO_ROOT)
LINUX = sys.platform.startswith("linux")


def _works(wrap: str) -> bool:
    if NODE is None or (srt.node_version(NODE) or (0, 0)) < term_views.NODE_MIN:
        return False
    if wrap == "srt":
        return kernel_wrap.srt_works(NODE, SRT)
    if wrap == "bwrap":
        return LINUX and kernel_wrap.works()
    return wrap == "node"


SANDBOXES = [w for w in ("srt", "bwrap") if _works(w)]
# the wrap the drawing tests run their program in: a real sandbox where one runs, else Node's permission model alone
DRAW_WRAP = SANDBOXES[0] if SANDBOXES else "node"
needs_node = pytest.mark.skipif(not _works("node"), reason="needs Node 20.11 or later")

READER = """
def build_index(paths):
    rows = []
    for p in paths:
        with open(p) as fh:
            rows += [line.rstrip("\\n") for line in fh]
    return rows


def records(index, query):
    return {"rows": index, "asked": query}


def resolve(index, locator):
    return None
"""
HTML = "<!doctype html><div id=v></div>"
CORPUS = "board"


async def _inproc_run(c: str, code: str, timeout: float) -> tuple[list[dict], str]:
    buf = io.StringIO()
    here = os.getcwd()
    os.chdir(config.corpus_dir(c))
    try:
        with contextlib.redirect_stdout(buf):
            exec(code, {})  # noqa: S102 — the snippet the views kernel runs
    finally:
        os.chdir(here)
    return [{"text/plain": buf.getvalue(), "_stream": "stdout"}], "ok"


@pytest.fixture()
def inproc(monkeypatch):
    monkeypatch.setattr(views, "_runner", _inproc_run)
    views._bind_loop()


@pytest.fixture()
def board(tmp_path, monkeypatch, workspaces_tmp) -> Path:
    d = tmp_path / "data"
    (d / CORPUS).mkdir(parents=True)
    (d / CORPUS / "manifest.json").write_text(json.dumps({"name": CORPUS, "description": "a message board"}))
    (d / CORPUS / "board.jsonl").write_text("".join(json.dumps({"body": b}) + "\n" for b in ("first", "second", "third")))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    return d / CORPUS


def _view(program: str, slug: str = "board") -> str:
    views.write_view(CORPUS, slug, name="Board", description="the board", scope=["board.jsonl"], reader=READER, html=HTML,
                     term=program)
    return slug


# ------------------------------------------------------------------------------------------------------ the sandbox

PROBE = r"""
import { draw } from 'thimble-term'
const got = {}
const tryIt = async (name, fn) => {
  try {
    const v = await fn()
    got[name] = `ALLOWED ${String(v).slice(0, 40)}`
  } catch (e) {
    got[name] = `denied ${e.code || e.name || e.message}`
  }
}
const connect = (how) => new Promise(async (ok, no) => {
  const net = await import('node:net')
  const s = net.connect(how)
  const t = setTimeout(() => { s.destroy(); no(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })) }, 3000)
  s.on('connect', () => { clearTimeout(t); s.destroy(); ok('connected') })
  s.on('error', (e) => { clearTimeout(t); no(e) })
})
await tryIt('read the secret', async () => (await import('node:fs')).readFileSync(SECRET, 'utf8'))
await tryIt('read /etc/passwd', async () => (await import('node:fs')).readFileSync('/etc/passwd', 'utf8'))
await tryIt('list the home', async () => (await import('node:fs')).readdirSync(HOME).join(','))
await tryIt('import the secret', async () => (await import(`file://${SECRET}`)))
await tryIt('write a file', async () => (await import('node:fs')).writeFileSync(`${HOME}/written-by-a-view`, 'x'))
await tryIt('start a process', async () => (await import('node:child_process')).execFileSync('/bin/echo', ['hi']).toString())
await tryIt('start a worker', async () => new (await import('node:worker_threads')).Worker('1', { eval: true }))
await tryIt('tcp to 127.0.0.1', () => connect({ host: '127.0.0.1', port: PORT }))
await tryIt('a unix socket', () => connect({ path: SOCK }))
await tryIt('http fetch', async () => (await fetch(`http://127.0.0.1:${PORT}/`)).status)
draw((d) => { for (const [k, v] of Object.entries(got)) d.line(`${k}: ${v}`) })
"""


class _Listener:
    """A TCP server on 127.0.0.1 and a Unix socket server that count the connections they accept: the host can reach
    both (the control), so a program that reaches neither was stopped by its sandbox."""

    def __init__(self) -> None:
        self.accepted = 0
        self.tcp = socket.create_server(("127.0.0.1", 0))
        self.port = self.tcp.getsockname()[1]
        self.dir = tempfile.mkdtemp(prefix="tv-test-", dir="/tmp" if Path("/tmp").is_dir() else None)
        self.path = os.path.join(self.dir, "s")
        self.unix = socket.socket(socket.AF_UNIX)
        self.unix.bind(self.path)
        self.unix.listen()
        self.open = True
        for s in (self.tcp, self.unix):
            s.settimeout(0.2)
            threading.Thread(target=self._accept, args=(s,), daemon=True).start()

    def _accept(self, s: socket.socket) -> None:
        while self.open:
            try:
                c, _ = s.accept()
            except (TimeoutError, socket.timeout):
                continue
            except OSError:
                return
            self.accepted += 1
            c.close()

    def close(self) -> None:
        self.open = False
        self.tcp.close()
        self.unix.close()
        shutil.rmtree(self.dir, ignore_errors=True)


@pytest.mark.parametrize("wrap", SANDBOXES or [pytest.param("srt", marks=pytest.mark.skip(reason="neither srt nor bubblewrap runs here"))])
async def test_a_view_program_can_read_no_file_open_no_socket_and_start_no_process(wrap, board, inproc, tmp_path):
    """In the sandbox a view's program reads no file (a secret beside the workspace, /etc/passwd, the home folder, by
    fs or by import), writes none, starts no process or worker, and reaches neither a TCP server on 127.0.0.1 nor a Unix
    socket, both of which the host reaches; its frame still arrives over stdout."""
    secret = tmp_path / "secret.txt"
    secret.write_text("the analyst's secret")
    home = Path.home()
    lis = _Listener()
    try:
        with socket.create_connection(("127.0.0.1", lis.port), timeout=2):
            pass
        with socket.socket(socket.AF_UNIX) as s:
            s.connect(lis.path)
        await asyncio.sleep(0.5)
        control = lis.accepted
        assert control == 2, "the host reaches both servers"
        program = (PROBE.replace("SECRET", json.dumps(str(secret))).replace("HOME", json.dumps(str(home)))
                   .replace("PORT", str(lis.port)).replace("SOCK", json.dumps(lis.path)))
        slug = _view(program)
        out = await term_views.draw_text(CORPUS, slug, cols=100, rows=20, wrap=wrap, panel=False)
        got = dict(line.strip().split(": ", 1) for line in out.splitlines() if ": " in line)
        assert set(got) == {"read the secret", "read /etc/passwd", "list the home", "import the secret", "write a file",
                            "start a process", "start a worker", "tcp to 127.0.0.1", "a unix socket", "http fetch"}, out
        assert all(v.startswith("denied") for v in got.values()), out
        assert lis.accepted == control, "no connection reached the servers from the sandbox"
        assert not (home / "written-by-a-view").exists()
    finally:
        lis.close()


def test_the_sandbox_gives_no_network_hides_the_user_s_folders_and_lets_node_read_only_the_kit(monkeypatch, tmp_path):
    """srt's settings refuse every host and hide the home folder, thimble's folders and the temp folders, showing only
    the kit, Node and srt's seccomp helper; bubblewrap shares no network and binds the kit read-only with a clean
    environment; Node's permission model reads the kit's folder alone."""
    if NODE is None:
        pytest.skip("needs node")
    kit = str(term_views._real(term_views.KIT_DIR))
    flags = term_views.node_flags(NODE)
    assert flags[0] in ("--permission", "--experimental-permission")
    assert [f for f in flags if f.startswith("--allow-")] == [f"--allow-fs-read={kit}{os.sep}"]
    monkeypatch.setattr(kernel_wrap, "srt_works", lambda node, pkg: pkg is not None)
    if SRT is not None:
        wrap, argv, env, tmp = term_views.sandbox_argv("srt")
        try:
            settings = json.loads(Path(argv[argv.index("--settings") + 1]).read_text())
            assert settings["network"] == {"allowedDomains": [], "deniedDomains": []}
            deny = set(settings["filesystem"]["denyRead"])
            assert str(term_views._real(Path.home())) in deny or any(str(term_views._real(Path.home())).startswith(d) for d in deny)
            assert settings["filesystem"]["allowWrite"] == []
            assert set(settings["filesystem"]["allowRead"]) <= {kit, str(term_views._real(NODE).parent), str(term_views._real(SRT / "vendor" / "seccomp"))}
            assert argv[argv.index("--") + 1:][:2] == [NODE, flags[0]]
            # the program's environment: a few of the caller's (no key, no login) and srt's own folders
            assert set(env) <= {*term_views.ENV_KEEP, "HOME", "TMPDIR", "CLAUDE_CODE_TMPDIR"}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    wrap, argv, env, tmp = term_views.sandbox_argv("bwrap")
    assert wrap == "bwrap" and tmp is None
    assert "--unshare-all" in argv and "--share-net" not in argv and "--clearenv" in argv
    i = argv.index(kit)
    assert argv[i - 1] == "--ro-bind" and argv[i + 1] == kit
    assert "--bind" not in argv, "nothing is writable but the sandbox's own /tmp"


def test_no_sandbox_no_view(monkeypatch):
    """Where neither srt nor bubblewrap runs, no view program runs: the panel says why."""
    monkeypatch.setattr(kernel_wrap, "srt_works", lambda node, pkg: False)
    monkeypatch.setattr(kernel_wrap, "works", lambda: False)
    if NODE is None:
        with pytest.raises(term_views.SandboxError, match="Node"):
            term_views.sandbox_argv()
        return
    with pytest.raises(term_views.SandboxError, match="neither thimble's sandbox runtime nor bubblewrap"):
        term_views.sandbox_argv()


# ------------------------------------------------------------------------------------------------------ the protocol

PROGRAM = r"""
import { draw, fetch, keep, kept, open } from 'thimble-term'
let rows = null
let presses = Number(kept('presses') || 0)
fetch({ op: 'all' }).then((got) => { rows = got.rows })
setTimeout(() => { try { open('board.jsonl#L9') } catch (e) { console.log(`refused: ${e.message}`) } }, 10)
draw((d) => {
  d.line(`presses ${presses}`)
  for (const r of rows || ['◌ reading']) d.line(r)
  d.key('o', 'to open its place', () => { presses++; keep('presses', presses); open('board.jsonl#L1') })
})
"""


@needs_node
async def test_a_program_draws_after_its_answer_and_an_act_comes_only_with_the_key_that_made_it(board, inproc):
    """The first frame comes before the reader answers, a frame the program draws on its own follows the answer; the
    frame that answers a key acknowledges it, with the act the key made; an act asked from a timer is refused; what the
    program keeps is kept for the view and given back at its next opening."""
    slug = _view(PROGRAM)
    pushed: list[dict] = []
    p = term_views.Program(CORPUS, slug, push=lambda pid, m: pushed.append(m), wrap=DRAW_WRAP)
    try:
        first = await p.start(60, 10, text="plain")
        assert first["text"].splitlines()[0].strip() == "presses 0"
        await p.settle()
        assert any("second" in (m["frame"].get("text") or "") for m in pushed if m["t"] == "frame"), pushed
        assert p.frame["hints"] == ["o to open its place"] and p.frame["keys"] == ["o"]
        got = await p.event({"t": "key", "key": "o"})
        assert got["frame"]["ack"] == p.n
        assert got["frame"]["text"].splitlines()[0].strip() == "presses 1"
        assert got["acts"] == [{"kind": "open", "ref": "board.jsonl#L1"}]
        assert any("refused: open() works only during the analyst's own click or key" in line for line in p.logs), p.logs
        await asyncio.sleep(0.2)
        assert term_views.read_state(CORPUS, slug) == {"presses": 1}
    finally:
        await p.close()
    again = term_views.Program(CORPUS, slug, wrap=DRAW_WRAP)
    try:
        assert (await again.start(60, 10, text="plain"))["text"].splitlines()[0].strip() == "presses 1"
    finally:
        await again.close()
    # draw_text draws the view as it opens (not on the kept 1) and keeps nothing
    out = await term_views.draw_text(CORPUS, slug, cols=60, rows=10, keys=["o", "o"], wrap=DRAW_WRAP)
    assert "presses 2" in out and term_views.read_state(CORPUS, slug) == {"presses": 1}


@needs_node
async def test_a_program_that_fails_is_one_red_line_and_one_that_draws_nothing_does_not_open(board, inproc, monkeypatch):
    slug = _view("import { draw } from 'thimble-term'\nconst x = undefined\ndraw((d) => d.line(x.y))\n")
    out = await term_views.draw_text(CORPUS, slug, cols=80, rows=5, wrap=DRAW_WRAP, panel=False)
    assert out.strip().startswith("× the view could not be drawn: TypeError:") and "view.term.js line 3" in " ".join(out.split())
    slug = _view("const n = 1\n", "quiet")
    monkeypatch.setattr(term_views, "START_WAIT_S", 1.0)
    with pytest.raises(term_views.TermViewError, match="did not start"):
        await term_views.draw_text(CORPUS, slug, cols=80, rows=5, wrap=DRAW_WRAP)


async def test_a_view_built_in_browser_mode_has_no_terminal_program(board, inproc):
    views.write_view(CORPUS, "page", name="Page", description="", scope=["board.jsonl"], reader=READER, html=HTML)
    with pytest.raises(term_views.TermViewError, match="built in browser mode"):
        await term_views.draw_text(CORPUS, "page", wrap=DRAW_WRAP)
    _view("import { draw } from 'thimble-term'\ndraw((d) => d.line('hi'))\n")
    rows = {r["slug"]: r for r in local._home_views(CORPUS)}
    assert rows["page"]["term"] is False and rows["board"]["term"] is True


def test_a_view_installed_from_a_folder_keeps_its_terminal_program(board, tmp_path):
    """install_view (the demo's examples, a pre-cache's views) copies view.term.js with the view's other files, so the
    copy that passed runs in the terminal too."""
    src = tmp_path / "timeline"
    shutil.copytree(views.EXAMPLES_DIR / "timeline", src, ignore=shutil.ignore_patterns("sample"))
    views.install_view(config.workspace_dir(CORPUS), src)
    assert (views.views_dir(CORPUS) / "timeline" / term_views.VIEW_TERM).read_text() == (src / term_views.VIEW_TERM).read_text()


@needs_node
async def test_the_host_serves_thimble_term_over_its_socket_with_its_token(board, inproc, monkeypatch, capsys):
    """`thimble view host`: a ready line naming a socket in a private folder and a token; a request without the token is
    refused; /open answers the first frame, /event the frame that answers it with its acts, /close ends the program."""
    slug = _view(PROGRAM)
    real = term_views.Program
    monkeypatch.setattr(term_views, "Program", lambda *a, **k: real(*a, **{**k, "wrap": DRAW_WRAP}))
    host = term_views.Host(CORPUS)
    task = asyncio.ensure_future(host.serve())
    from app import view_calls

    kernel = view_calls.KERNEL
    try:
        ready = None
        for _ in range(100):
            await asyncio.sleep(0.05)
            out = capsys.readouterr().out
            ready = next((json.loads(x) for x in out.splitlines() if '"ready"' in x), None)
            if ready:
                break
        assert ready and ready["t"] == "ready"
        assert oct(os.stat(os.path.dirname(ready["socket"])).st_mode & 0o777) == "0o700"

        async def post(path: str, body: dict, token: str | None = ready["token"]) -> tuple[int, dict]:
            r, w = await asyncio.open_unix_connection(ready["socket"])
            data = json.dumps(body).encode()
            head = f"POST {path} HTTP/1.1\r\nHost: thimble-views\r\nContent-Length: {len(data)}\r\n"
            if token:
                head += f"x-thimble-token: {token}\r\n"
            w.write(head.encode() + b"\r\n" + data)
            await w.drain()
            raw = await r.read()
            w.close()
            status = int(raw.split(b" ", 2)[1])
            return status, json.loads(raw.split(b"\r\n\r\n", 1)[1])

        assert (await post("/open", {"slug": slug}, token="wrong"))[0] == 403
        status, opened = await post("/open", {"slug": slug, "cols": 60, "rows": 10})
        assert status == 200 and opened["id"] and opened["frame"]["lines"]
        status, got = await post("/event", {"id": opened["id"], "event": {"t": "key", "key": "o"}})
        assert got["acts"] == [{"kind": "open", "ref": "board.jsonl#L1"}]
        assert (await post("/event", {"id": opened["id"], "event": {"t": "nope"}}))[1] == {"error": "no such event"}
        assert (await post("/close", {"id": opened["id"]}))[1] == {"ok": True}
        assert (await post("/event", {"id": opened["id"], "event": {"t": "key", "key": "o"}}))[1] == {"error": "the view is not open"}
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    assert view_calls.KERNEL == kernel, "the host's own kernels' name is its own while it serves"


# ------------------------------------------------------------------------------------------------------ Timeline


def _split(lines: list[str], head: int, rows: int) -> tuple[list[str], str]:
    """A panel drawn as text: its body (`rows` rows after `head` rows of header) and its hint row, which wraps to the
    panel's width, as one string."""
    body = lines[head:head + rows]
    assert len(body) == rows
    rest = [x.strip() for x in lines[head + rows:]]
    assert rest and all(rest), "the hint row's rows follow the body"
    return body, " · ".join(rest)


@pytest.fixture()
def timeline(workspaces_tmp, tmp_path, monkeypatch, inproc) -> str:
    """The worked example Timeline saved as a view of its own sample, with its terminal program."""
    d = tmp_path / "data"
    shutil.copytree(views.EXAMPLES_DIR / "timeline" / "sample", d / "timeline")
    (d / "timeline" / "manifest.json").write_text(json.dumps({"name": "timeline", "description": "an example's sample"}))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    src = views.EXAMPLES_DIR / "timeline"
    raw = json.loads((src / "view.json").read_text("utf-8"))
    views.write_view("timeline", "timeline", reader=(src / "reader.py").read_text("utf-8"),
                     html=(src / "view.html").read_text("utf-8"), term=(src / "view.term.js").read_text("utf-8"),
                     **{k: raw.get(k) for k in ("name", "description", "scope", "records", "accepts", "units", "libs")})
    return "timeline"


@needs_node
@pytest.mark.parametrize("cols", [120, 200])
async def test_timeline_draws_what_its_browser_page_shows(timeline, cols):
    """The worked example at 120 and 200 columns: the top row (search, incident, Color by with its chips), the time
    range's readout and strip, a lane per source, the axis with the incidents' marks, then the events by day, each with
    its time, source, kind, actor, incident and text; its hint row names only keys the pane passes on."""
    out = await term_views.draw_text(timeline, "timeline", cols=cols, rows=36, wrap=DRAW_WRAP)
    lines = out.splitlines()
    assert lines[0] == "  Timeline"
    body, hints = _split(lines, 2, 36)
    assert all(len(x) <= cols + 2 for x in body)
    assert body[0].startswith("  / search events  incident  all  Color by  Service  ● payments 79  ● web 45")
    assert body[1] == "  16 May 01:14 – 19 May 14:25 · 3d 13h"
    assert [x[2:10].strip() for x in body[3:8]] == ["alert", "deploy", "agent", "chat", "ticket"]
    assert "17 May 00:00" in body[8] and "18 May 00:00" in body[8]
    assert body[9].split() == ["INC-311", "INC-312", "INC-313"]
    assert body[10] == ""
    assert body[11].startswith("  Sat 16 May 2026")
    assert body[12].startswith("❯ ● 01:40:12  chat    message     Oona")
    assert "02:57:20  alert   fired       monitor     INC-311  payments: database connections at 181 of 200 for 5 min" in body[19]
    if cols == 200:
        assert "Tonight's release train: web 2.31.0 and payments 4.12.0. deploybot starts at 02:00." in body[12]
    assert hints == ("↑↓ to choose · Enter to open · c to color by · / to search · i for incident · [ ] to "
                                 "pan · + - to zoom · a to ask · b to go back · x to close")


@needs_node
async def test_timeline_opens_an_event_in_place_and_narrows_to_an_incident(timeline):
    """Enter opens the chosen event in place: its words, its facts, the events that answer it, its line as the file
    holds it and its place; the incident menu narrows to INC-312 and frames its burst; a citation of an incident opens
    the view narrowed to it."""
    out = await term_views.draw_text(timeline, "timeline", cols=120, rows=36, wrap=DRAW_WRAP,
                                     keys=["down"] * 8 + ["return"], panel=False)
    rows = [re.sub(r"\s*▌*$", "", x) for x in out.splitlines()]
    at = next(i for i, x in enumerate(rows) if x.startswith("❯"))
    assert "03:00:48  alert   fired" in rows[at]
    assert rows[at + 1].strip() == "payments: health check failing on 2 of 3 replicas"
    assert rows[at + 2].strip() == "service payments · severity critical · id alr-42"
    assert rows[at + 3].strip() == "Answered by"
    assert rows[at + 4].strip().startswith("03:01:05  agent · pagerbot  Opened INC-311")
    # its facts say what its line holds, so the line itself is behind ↗, in the citation panel
    assert not any(x.strip().startswith('2  {"id": "alr-42"') for x in rows)
    assert any(x.strip().startswith("↗ alerts/monitor-20260516-0000.jsonl line 2  ask about it") for x in rows)
    out = await term_views.draw_text(timeline, "timeline", cols=120, rows=36, wrap=DRAW_WRAP, keys=["i", "down", "down", "return"],
                                     panel=False)
    rows = out.splitlines()
    assert "incident  INC-312" in rows[0] and rows[0].rstrip().endswith("reset")
    assert rows[1].startswith("  16 May 07:30 – 11:39")
    assert all("INC-312" in x for x in rows if x.startswith(("❯ ●", "  ●")))
    out = await term_views.draw_text(timeline, "timeline", cols=120, rows=36, wrap=DRAW_WRAP, ref="view:timeline/INC-313",
                                     panel=False)
    assert "incident  INC-313" in out.splitlines()[0]


# ------------------------------------------------------------------------------------------------------ Linked sessions


@pytest.fixture()
def linked(workspaces_tmp, tmp_path, monkeypatch, inproc) -> str:
    """The worked example Linked sessions saved as a view of its own sample, with its terminal program."""
    d = tmp_path / "data"
    shutil.copytree(views.EXAMPLES_DIR / "linked-sessions" / "sample", d / "linked")
    (d / "linked" / "manifest.json").write_text(json.dumps({"name": "linked", "description": "an example's sample"}))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    src = views.EXAMPLES_DIR / "linked-sessions"
    raw = json.loads((src / "view.json").read_text("utf-8"))
    views.write_view("linked", "linked-sessions", reader=(src / "reader.py").read_text("utf-8"),
                     html=(src / "view.html").read_text("utf-8"), term=(src / "view.term.js").read_text("utf-8"),
                     **{k: raw.get(k) for k in ("name", "description", "scope", "records", "accepts", "units", "libs")})
    return "linked"


LEAD1 = "runs/r1/36fe6b9d-6e6d-4582-aef9-c97a0fe8f576.jsonl"
PORT1 = "runs/r1/36fe6b9d-6e6d-4582-aef9-c97a0fe8f576/subagents/agent-a07a4da7.jsonl"


def _lanes(body: list[str]) -> list[str]:
    """The lanes' names, from the row under the strip to the axis, the row above the blank one."""
    end = body.index("", 3) - 1
    return [re.match(r"\s*\S+(?: \S+)*", x[2:])[0] for x in body[3:end]]


@needs_node
@pytest.mark.parametrize("cols", [120, 200])
async def test_linked_sessions_draws_what_its_browser_page_shows(linked, cols):
    """The worked example at 120 and 200 columns: the top row (search, the sessions menu, Color by with its chips), the
    time range's readout and its strip broken where the runs lie hours apart, a lane per session under its run with each
    subagent under the session that spawned it, the axis with its breaks, then the messages and calls under each run's
    name, each with its time, session, tool or kind, first line and how long a call took; its hint row names only keys
    the pane passes on."""
    out = await term_views.draw_text(linked, "linked-sessions", cols=cols, rows=40, wrap=DRAW_WRAP)
    lines = out.splitlines()
    assert lines[:2] == ["  Linked sessions", "  3 runs · 17 sessions · 316 calls · 36 messages"]
    body, hints = _split(lines, 3, 40)
    assert all(len(x) <= cols + 2 for x in body)
    assert body[0].startswith("  / search  sessions  all  Color by  Speaker  ● client-port 100  ● lead 63  ● webhooks 63")
    assert body[1] == "  12 Sep 14:02 – 13 Sep 09:53 · 19h 51m"
    assert body[2].count(" // ") == 2
    assert _lanes(body) == [
        "▾ Run 1 · nested team", "  lead", "  ├ survey", "  ├ client-port", "  │ ├ pagination", "  │ └ auth-headers",
        "  ├ webhooks", "  └ test-runner", "▾ Run 2 · flat team", "  lead", "  ├ client-port", "  ├ webhooks",
        "  └ test-runner", "▾ Run 3 · with reviewer", "  lead", "  ├ survey", "  ├ client-port", "  ├ webhooks",
        "  ├ reviewer", "  └ reviewer 2"]
    # each run's lanes stand in its own stretch of the axis: Run 2's start after the first break, Run 3's after the second
    breaks = [i for i in range(len(body[2])) if body[2][i:i + 4] == " // "]
    assert body[4][27:breaks[0]].strip() and not body[13][27:breaks[0]].strip() and body[13][breaks[0]:breaks[1]].strip()
    axis_row = body[23]
    assert axis_row.startswith("  ─ running  × failed"), "the key of the lanes' own marks, in the names' column"
    assert axis_row.count("//") == 2 and "12 Sep 14:15" in axis_row and "12 Sep 16:45" in axis_row and "13 Sep 09:15" in axis_row
    assert body[24] == ""
    assert body[25].startswith("  Run 1 · nested team")
    assert body[26].startswith("❯ ● 14:02:00  lead          Prompt     Upgrade invoicer from Brambleway API v2 to v3.")
    assert re.match(r"  ● 14:03:10  lead          Task       Find every v2 call site +292 s", body[31])
    assert re.match(r"  ● 14:04:31  survey        WebSearch  Brambleway API v3 changelog +× error  30 s", body[38])
    assert hints == ("↑↓ to choose · Enter to open · c to color by · / to search · s for sessions · [ ] to "
                                 "pan · + - to zoom · a to ask · b to go back · x to close")


@needs_node
async def test_linked_sessions_folds_a_run_where_the_lanes_have_no_room(linked):
    """In a short panel the largest run folds to one lane of all its sessions, so the list keeps its rows; ▸ unfolds it,
    and another run folds in its place."""
    out = await term_views.draw_text(linked, "linked-sessions", cols=92, rows=36, wrap=DRAW_WRAP, panel=False)
    body = out.splitlines()
    assert _lanes(body)[:2] == ["▸ Run 1 · nested team", "▾ Run 2 · flat team"]
    assert body[3][25:].strip(), "a folded run draws its sessions' records in one lane"
    out = await term_views.draw_text(linked, "linked-sessions", cols=92, rows=36, wrap=DRAW_WRAP, panel=False, keys=["click:▸"])
    lanes = _lanes(out.splitlines())
    assert lanes[:3] == ["▾ Run 1 · nested team", "  lead", "  ├ survey"] and lanes[-1].startswith("▸ Run 3")


@needs_node
async def test_linked_sessions_opens_a_call_in_place_narrows_to_a_run_and_follows_a_citation(linked):
    """Enter opens the chosen call in place: what came back, the subagent its Task spawned (a click shows that session
    alone) and its place; an Edit opened from its citation shows its change; a run's name in the lanes narrows the view
    to it, as the sessions menu does, and a citation of a run opens the view narrowed to it."""
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP,
                                     keys=["down"] * 5 + ["return"], panel=False)
    rows = [re.sub(r"\s*▌*$", "", x) for x in out.splitlines()]
    at = next(i for i, x in enumerate(rows) if x.startswith("❯"))
    assert "14:03:10  lead          Task       Find every v2 call site" in rows[at]
    assert rows[at + 1].strip().startswith("14 call sites in 9 files.")
    assert rows[at + 2].strip() == "Subagent"
    assert rows[at + 3].strip() == "14:03:12  survey  Find every v2 call site in invoicer/ and summarise the v3 changes that affect them."
    assert rows[at + 4].strip() == f"↗ {LEAD1} line 10  ask about it"
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP,
                                     keys=["down"] * 5 + ["return", "click:Find every v2 call site in invoicer/ and"], panel=False)
    rows = out.splitlines()
    assert "sessions  survey" in rows[0] and rows[0].rstrip().endswith("reset")
    assert _lanes(rows) == ["▾ Run 1 · nested team", "  survey"]
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP, ref=f"{PORT1}#L13", panel=False)
    rows = [re.sub(r"\s*▌*$", "", x) for x in out.splitlines()]
    at = next(i for i, x in enumerate(rows) if x.startswith("❯"))
    assert "14:10:20  client-port   Edit       invoicer/client/http.py" in rows[at]
    assert rows[at + 1].strip() == '− BASE_URL = "https://api.brambleway.example/v2"'
    assert rows[at + 2].strip() == '+ BASE_URL = "https://api.brambleway.example/v3"'
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP, keys=["click:Run 2 · flat team"],
                                     panel=False)
    rows = out.splitlines()
    assert "sessions  Run 2 · flat team" in rows[0]
    assert rows[1].startswith("  12 Sep 16:4")
    assert _lanes(rows) == ["▾ Run 2 · flat team", "  lead", "  ├ client-port", "  ├ webhooks", "  └ test-runner"]
    assert not any(x.startswith("  Run ") for x in rows), "one run in view needs no heading"
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP, ref="view:linked-sessions/r3",
                                     panel=False)
    assert "sessions  Run 3 · with reviewer" in out.splitlines()[0]


# ------------------------------------------------------------------------------------------------------ Repository


@pytest.fixture()
def repository(workspaces_tmp, tmp_path, monkeypatch, inproc) -> str:
    """The worked example Repository saved as a view of its own sample, with its terminal program."""
    d = tmp_path / "data"
    shutil.copytree(views.EXAMPLES_DIR / "repository" / "sample", d / "repository")
    (d / "repository" / "manifest.json").write_text(json.dumps({"name": "repository", "description": "an example's sample"}))
    monkeypatch.setattr(config, "DATA_DIR", d.resolve())
    src = views.EXAMPLES_DIR / "repository"
    raw = json.loads((src / "view.json").read_text("utf-8"))
    views.write_view("repository", "repository", reader=(src / "reader.py").read_text("utf-8"),
                     html=(src / "view.html").read_text("utf-8"), term=(src / "view.term.js").read_text("utf-8"),
                     **{k: raw.get(k) for k in ("name", "description", "scope", "records", "accepts", "units", "libs")})
    return "repository"


def _row(rows: list[str], start: str) -> str:
    return next(x for x in rows if x[2:].startswith(start))


@needs_node
@pytest.mark.parametrize("cols", [120, 200])
async def test_repository_draws_what_its_browser_page_shows(repository, cols):
    """The worked example at 120 and 200 columns: the top row (search, the kind of item, Color by with its chips), the
    time range's readout and strip with a break between the runs' days, the table's header with each run's name over
    the activity, then a row per pull request: its item, its title with its flags gray as they fit, its area, author and
    state, and its records as marks on the range's scale; its hint row names only keys the pane passes on."""
    out = await term_views.draw_text(repository, "repository", cols=cols, rows=36, wrap=DRAW_WRAP)
    lines = out.splitlines()
    assert lines[0] == "  Repository"
    body, hints = _split(lines, 2, 36)
    assert all(len(x) <= cols + 2 for x in body)
    assert body[0] == "  / search  items  pull requests  Color by  State  ● merged 28  ● closed 4  ● open 3"
    assert body[1] == "  11 May 09:24 – 14 May 13:42 · 3d 4h"
    assert body[2].count(" // ") == 3
    assert body[3] == ""
    head = body[4].split()
    # the area from 120 cells, the author from 100, so the activity keeps its share
    cols_shown = ["item", "title", "author", "state"] if cols == 120 else ["item", "title", "area", "author", "state"]
    assert head[:len(cols_shown)] == cols_shown and head[len(cols_shown):len(cols_shown) + 4] == ["r1", "r2", "r3", "r4"]
    assert body[5].startswith("❯ ● r1 #9   Treat 'next <weekday>' as never today")
    # the strip of each row starts under its run's name: r1's rows at the left, r2's after r1's
    act = body[4].index("r1")
    first = {r: min(x.index("●", act) for x in body[5:] if x[4:6] == r) for r in ("r1", "r2", "r3")}
    assert first["r1"] == act and first["r1"] < body[4].index("r2") <= first["r2"] < body[4].index("r3") <= first["r3"]
    eleven = _row(body, "● r1 #11")
    if cols == 120:
        assert "Keep wall-clock time across DST in biweekly rules  +3  cedar" in eleven
        assert "Treat 'next <weekday>' as never today  +1  " in body[5]
    else:
        assert "Keep wall-clock time across DST in biweekly rules  merged by its author · +2  schedules   cedar    merged" in eleven
        assert "●●─●●●" in eleven
    assert "Reject 30 February  merged by its author" in _row(body, "● r4 #12")
    assert hints == ("↑↓ to choose · Enter to open · c to color by · / to search · i for items · [ ] to "
                                 "pan · + - to zoom · a to ask · b to go back · x to close")


@needs_node
async def test_repository_opens_an_item_in_place_with_the_same_issue_in_every_run(repository):
    """Enter opens a pull request in place: its title where its row cut it and its flags, the issue it fixes in every
    run, then its records in time order, each with its time, author, action, words, diff and `↗` to its line; a click
    on another run's issue opens it among the issues; the other kinds fill only the columns their items have."""
    out = await term_views.draw_text(repository, "repository", cols=120, rows=60, wrap=DRAW_WRAP,
                                     keys=["down", "down", "return"], panel=False)
    rows = [re.sub(r"\s*▌*$", "", x) for x in out.splitlines()]
    at = next(i for i, x in enumerate(rows) if x.startswith("❯"))
    assert "r1 #11  Keep wall-clock time across DST in biweekly rules" in rows[at], "its row holds its title whole"
    assert rows[at + 1].strip() == "merged by its author · merged over a change request · pushed after its last approval"
    assert rows[at + 2].strip() == "r1 #3 fixed  r2 #3 fixed  r3 #3 fixed  r4 #3 fixed"
    assert rows[at + 3].strip().startswith("09:50  cedar  opened             Occurrences are computed in local time")
    assert rows[at + 3].endswith("↗")
    assert any(x.strip() == "09:53  cedar  pushed             4079459 · Compute occurrences in local time                                      ↗" for x in rows)
    assert any(x.strip() == "+        at = local + n * self.period" for x in rows)
    assert any(x.strip().startswith("10:35  ash    changes requested  No test for the spring-forward week itself") for x in rows)
    assert any(x.strip() == "ask about it" for x in rows)
    out = await term_views.draw_text(repository, "repository", cols=120, rows=36, wrap=DRAW_WRAP,
                                     keys=["down", "down", "return", "click:r2 #3 fixed"], panel=False)
    rows = out.splitlines()
    assert "items  issues" in rows[0]
    at = next(i for i, x in enumerate(rows) if x.startswith("❯"))
    assert rows[at].startswith("❯ ● r2 #3   Every-other-week schedule moves an hour")
    assert any(re.match(r"\s+\d\d:\d\d  \S+\s+merged #11", x) for x in rows[at:])
    out = await term_views.draw_text(repository, "repository", cols=120, rows=36, wrap=DRAW_WRAP,
                                     keys=["i", "down", "down", "return"], panel=False)
    rows = out.splitlines()
    assert rows[4].split()[:3] == ["item", "title", "author"] and rows[4].split()[3:] == ["r1", "r2", "r3", "r4"]
    assert rows[5].startswith("❯ ● r1 #1  Splitting the backlog") and rows[5].split()[-2:] == ["ash", "●"]
    out = await term_views.draw_text(repository, "repository", cols=120, rows=36, wrap=DRAW_WRAP,
                                     keys=["i", "down", "down", "down", "return", "return"], panel=False)
    rows = out.splitlines()
    assert rows[4].split()[:2] == ["item", "agent"]
    assert rows[5].startswith("❯ ● r1    ash")
    assert re.match(r"\s+09:24  ash\s+opened #9\s+When today is the named weekday", rows[[i for i, x in enumerate(rows) if "09:09" in x][0] + 1])


@needs_node
async def test_repository_follows_its_citations_and_its_chips(repository):
    """A citation of a record opens its item with the record on the selection background, in view however far down its
    item's details it is; a run's citation frames the run's day in the time range; a chip turned off leaves out the
    items of its value."""
    out = await term_views.draw_text(repository, "repository", cols=120, rows=24, wrap=DRAW_WRAP,
                                     ref="runs/r1/events.jsonl#L35", panel=False, ansi=True)
    rows = out.splitlines()
    cited = next(x for x in rows if "I still wanted a test for the skipped hour." in x)
    assert "48;5;238" in cited and re.sub(r"\x1b\[[0-9;]*m", "", cited).strip().startswith("10:58  ash    commented")
    out = await term_views.draw_text(repository, "repository", cols=120, rows=24, wrap=DRAW_WRAP, ref="view:repository/r2",
                                     panel=False)
    rows = out.splitlines()
    # the run's day framed, its edges at its first and last records, since an edge never stays in a break
    assert rows[1] == "  12 May 09:30 – 14:12 · 4h 42m" and rows[0].rstrip().endswith("reset")
    assert {x[4:6] for x in rows[5:] if x[2:3] == "●"} == {"r2"}
    out = await term_views.draw_text(repository, "repository", cols=120, rows=40, wrap=DRAW_WRAP, keys=["click:closed 4"],
                                     panel=False)
    rows = out.splitlines()
    assert "○ closed 4" in rows[0]
    assert {x.split()[-2] for x in rows[5:] if x[2:3] == "●" or x.startswith("❯")} == {"merged", "open"}


# ------------------------------------------------------------------------------------------------------ narrow panels


async def _labels_on(c: str, example: str) -> None:
    """The example's sample labels (its labels.json) defined in workspace `c`, turned on in Files and applied, as
    `thimble demo --examples` defines them: the labels the view opens colored by, as in the browser."""
    import httpx  # noqa: PLC0415
    from fastapi import FastAPI  # noqa: PLC0415

    from app import concepts  # noqa: PLC0415

    a = FastAPI()
    a.include_router(concepts.router, prefix="/api")
    specs = json.loads((views.EXAMPLES_DIR / example / "labels.json").read_text("utf-8"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t", timeout=120) as api:
        for i, sp in enumerate(specs):
            if i:
                await asyncio.sleep(1.1)  # a label's time is in seconds: they keep labels.json's order
            r = await api.post(f"/api/ws/{c}/concepts", json={"name": sp["name"], "kind": sp["kind"], "spec": sp["spec"],
                                                             "labels": sp["labels"], "shown": True})
            assert r.status_code == 200, r.text
            r = await api.post(f"/api/ws/{c}/concepts/{r.json()['id']}/apply", json={"wait": True, "paths": sp["paths"]})
            assert r.status_code == 200, r.text


def _list_rows(body: list[str]) -> list[str]:
    """A list's rows (a record's, the chosen one's), the track at their right edge left out."""
    return [re.sub(r"\s*▌*$", "", x) for x in body if x.startswith(("  ● ", "❯ ● "))]


WIDTHS = [47, 92, 140]  # the docked panel at 120 and 200 columns, and a wide one


@needs_node
async def test_timeline_opens_as_its_browser_page_does_and_reads_at_every_width(timeline):
    """Colored by the label that is on, its values as chips with their counts; Color by's name whole on a row of its own
    where the top row has no room, its chips under it where they have none beside it; list rows cut with …; every key
    in the hint row, which wraps; a zoomed range's window between `[` `]`."""
    await _labels_on(timeline, "timeline")
    for cols in WIDTHS:
        out = await term_views.draw_text(timeline, "timeline", cols=cols, rows=34, wrap=DRAW_WRAP)
        lines = out.splitlines()
        body, hints = _split(lines, 2, 34)
        assert all(len(x) <= cols + 2 for x in body), cols
        top = "\n".join(body[:3])
        assert "/ search events  incident  all" in body[0]
        assert "Color by  Database connections ↗" in top and "● connections 22" in top and "● not marked 176" in top, cols
        for k in ("c to color by", "/ to search", "i for incident", "[ ] to pan", "+ - to zoom", "a to ask", "b to go back"):
            assert k in hints, (cols, k)
        rows = _list_rows(body)
        assert rows and all(len(x) <= cols for x in rows)
        if cols == 47:
            assert body[1].strip() == "Color by  Database connections ↗" and body[2].strip() == "● connections 22  ● not marked 176"
            assert rows[0].endswith("Tonight's release…"), "a cut row ends in …"
    out = await term_views.draw_text(timeline, "timeline", cols=47, rows=34, wrap=DRAW_WRAP, keys=["+", "+"], panel=False)
    strip = next(x for x in out.splitlines() if "[" in x and "]" in x)
    assert strip.index("[") < strip.index("]")


@needs_node
async def test_timeline_details_and_menu_read_in_a_narrow_panel(timeline):
    """At 47 cells an opened event's words and facts wrap to the panel's width, its place keeps its line with ask about
    it under it; the Color by menu stands in a frame, the label's values and definition under its name, its ↗ whole."""
    await _labels_on(timeline, "timeline")
    out = await term_views.draw_text(timeline, "timeline", cols=47, rows=34, wrap=DRAW_WRAP, keys=["down"] * 8 + ["return"],
                                     panel=False)
    rows = [re.sub(r"\s*▌*$", "", x) for x in out.splitlines()]
    at = next(i for i, x in enumerate(rows) if x.startswith("❯"))
    assert rows[at + 1].strip() == "payments: health check failing on 2 of 3"
    assert rows[at + 3].strip() == "service payments · severity critical"
    assert any(x.strip() == "↗ …/monitor-20260516-0000.jsonl line 2" for x in rows)
    assert any(x.strip() == "ask about it" for x in rows)
    assert rows[0].rstrip().endswith("reset"), "reset shows once a row is opened"
    out = await term_views.draw_text(timeline, "timeline", cols=47, rows=34, wrap=DRAW_WRAP, keys=["c"], panel=False)
    rows = out.splitlines()
    top = next(i for i, x in enumerate(rows) if "╭─ Color by" in x)
    box = [x[4:].rstrip(" │") for x in rows[top + 1:] if x.startswith("  │")]
    at = next(i for i, x in enumerate(box) if x.startswith("❯ Database connections"))
    assert box[at + 1].strip() == "● connections  ● not marked"
    assert any(x.strip().endswith("definition ↗") for x in box[at + 1:])
    assert all(len(x) <= 47 + 2 for x in rows)


@needs_node
async def test_linked_sessions_opens_as_its_browser_page_does_and_reads_at_every_width(linked):
    """Colored by the label that is on; each run's name whole on its row; list rows cut with …; every key in the hint
    row; zoomed into one run, the lanes of the sessions that did not run then fold away."""
    await _labels_on(linked, "linked-sessions")
    for cols in WIDTHS:
        out = await term_views.draw_text(linked, "linked-sessions", cols=cols, rows=40, wrap=DRAW_WRAP)
        body, hints = _split(out.splitlines(), 3, 40)
        assert all(len(x) <= cols + 2 for x in body), cols
        top = "\n".join(body[:3])
        assert "Color by  Pagination ↗" in top and "● pagination 20" in top, cols
        assert "▾ Run 3 · with reviewer" in "\n".join(body), cols
        for k in ("c to color by", "s for sessions", "[ ] to pan", "+ - to zoom"):
            assert k in hints, (cols, k)
        assert all(len(x) <= cols for x in _list_rows(body))
    out = await term_views.draw_text(linked, "linked-sessions", cols=47, rows=40, wrap=DRAW_WRAP, keys=["+", "+", "]"],
                                     panel=False)
    lanes = "\n".join(out.splitlines()[:16])
    assert "Run 2 · flat team" in lanes and "Run 1" not in lanes


@needs_node
async def test_repository_opens_as_its_browser_page_does_and_reads_at_every_width(repository):
    """Colored by the label that is on; the table's header names every run over the activity; an item's records read
    across a narrow panel, their words under their time, author and action."""
    await _labels_on(repository, "repository")
    for cols in WIDTHS:
        out = await term_views.draw_text(repository, "repository", cols=cols, rows=36, wrap=DRAW_WRAP)
        body, hints = _split(out.splitlines(), 2, 36)
        assert all(len(x) <= cols + 2 for x in body), cols
        top = "\n".join(body[:3])
        assert "Color by  Clock change ↗" in top and "● clock change 6" in top, cols
        head = next(x for x in body if x.split()[:2] == ["item", "title"]).split()
        assert head[-4:] == ["r1", "r2", "r3", "r4"], cols
        assert "i for items" in hints and "[ ] to pan" in hints
    out = await term_views.draw_text(repository, "repository", cols=47, rows=50, wrap=DRAW_WRAP, keys=["down", "down", "return"],
                                     panel=False)
    rows = [re.sub(r"\s*▌*$", "", x) for x in out.splitlines()]
    at = next(i for i, x in enumerate(rows) if x.strip().startswith("09:50  cedar  opened"))
    assert rows[at].rstrip().endswith("↗")
    assert rows[at + 1].strip() == "Occurrences are computed in local time"
