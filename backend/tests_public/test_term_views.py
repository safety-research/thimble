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
    """A panel drawn as text: its body (`rows` rows after `head` rows of header) and its hint row, one row."""
    body = lines[head:head + rows]
    assert len(body) == rows
    rest = [x.strip() for x in lines[head + rows:]]
    assert len(rest) == 1 and rest[0], "the hint row, one row, follows the body"
    return body, rest[0]


def _key_list(out: str) -> list[list[str]]:
    """The list `?` opens, drawn as text: each row's keys and their words."""
    return [re.split(r"\s{2,}", x.strip(" │")) for x in out.splitlines() if x.startswith("  │")]


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
    """The worked example at 120 and 200 columns: the search and Filter by on Incident with its values as toggles; Rows
    on Source, then Color by with its chips; the time range's readout and strip, a lane per source, and the axis alone
    (no key of failed events, no incidents' flags); then what the list shows and how many, its columns' headings, and
    the events with no day's heading between them, each with its time (a day's first with its date), source, kind,
    actor, incident and text; its hint row names
    ↑↓, Enter and `?`, which lists the keys of the controls the top row shows."""
    out = await term_views.draw_text(timeline, "timeline", cols=cols, rows=36, wrap=DRAW_WRAP)
    lines = out.splitlines()
    assert lines[0] == "  Timeline"
    body, hints = _split(lines, 2, 36)
    assert all(len(x) <= cols + 2 for x in body)
    assert body[0].startswith("  / search events  Filter by  Incident  ● INC-312 100  ● INC-313 23  ● INC-311 11  ● no incident 64")
    assert body[1].startswith("  Rows  Source  Color by  Service  ● payments 79  ● web 45")
    assert body[2] == "  16 May 01:14 – 19 May 14:25 · 3d 13h"
    assert [x[2:12].strip() for x in body[4:9]] == ["alert", "deploy", "agent", "chat", "ticket"]
    assert body[9].startswith(" " * 12) and "17 May 00:00" in body[9] and "18 May 00:00" in body[9]
    assert "failed" not in "\n".join(body[:11]) and "INC-311" not in "\n".join(body[2:11])
    assert body[10] == ""
    assert body[11] == "  In the range  198 events"
    assert body[12].split() == ["time", "source", "kind", "actor", "incident", "text"]
    assert body[13].startswith("❯ ● 16 May 01:40:12  chat    message      Oona")
    assert body[14].startswith("  ●        02:00:05  deploy  started      deploybot")
    assert not any(re.match(r"\s*(Sat|Sun|Mon|Tue) \d+ May", x) for x in body[13:]), "no day's heading breaks the list"
    assert "02:57:20  alert   fired        monitor     INC-311   payments: database connections at 181 of 200 for 5 min" in body[20]
    if cols == 200:
        assert "Tonight's release train: web 2.31.0 and payments 4.12.0. deploybot starts at 02:00." in body[13]
    assert hints == "↑↓ to choose · Enter to open · ? for all keys · b to go back · x to close"
    out = await term_views.draw_text(timeline, "timeline", cols=cols, rows=36, wrap=DRAW_WRAP, keys=["?"], panel=False)
    assert out.splitlines()[0].startswith("  ╭─ keys ─")
    assert _key_list(out) == [["↑↓", "to choose"], ["Enter", "to open"], ["c", "to color by"], ["/", "to search"],
                              ["f", "to filter by"], ["g", "for rows"], ["a", "to ask"]]


def _timeline_pane(rows: list[str]) -> list[str]:
    """The side pane's rows, right of its `│`."""
    return [x.rsplit("│ ", 1)[1].rstrip() for x in rows if "│ " in x]


@needs_node
async def test_timeline_opens_an_event_in_the_side_pane_filters_and_picks_a_lane(timeline):
    """Enter opens the chosen event in the side pane beside the list, never under its row: its words, its facts named
    plainly, the events that answer it and its place, with no `ask about it` (the place asks); a click on a Filter by
    value hides its events; a click on a lane's name shows that lane's events, the list naming them; a citation of an
    incident narrows Filter by to it and frames its burst."""
    out = await term_views.draw_text(timeline, "timeline", cols=120, rows=36, wrap=DRAW_WRAP,
                                     keys=["down"] * 8 + ["return"], panel=False)
    rows = out.splitlines()
    at = next(i for i, x in enumerate(rows) if x.startswith("❯"))
    assert "03:00:48  alert   fired" in rows[at] and rows[at + 1].startswith("  ●        03:01:05  agent"), "nothing opens under the row"
    pane = _timeline_pane(rows)
    assert pane[0].startswith("alert fired · 03:00:48") and pane[0].endswith("close")
    assert pane[1:5] == ["payments: health check failing on 2 of 3 replicas", "service payments · severity critical",
                         "incident INC-311 · by monitor · alert id alr-42", "Responses · 5"]
    assert pane[5].startswith("03:01:05  agent opened  Opened INC-311")
    assert "↗ alerts/monitor-20260516-0000.jsonl line 2" in pane
    assert "ask about it" not in out
    assert rows[1].rstrip().endswith("reset"), "Reset shows once an event is open"
    out = await term_views.draw_text(timeline, "timeline", cols=120, rows=36, wrap=DRAW_WRAP, keys=["click:INC-312"],
                                     panel=False)
    rows = out.splitlines()
    assert "○ INC-312 100  ● INC-313 23  ● INC-311 11  ● no incident 64" in rows[0] and rows[1].rstrip().endswith("reset")
    assert "In the range  98 events" in out and not any("INC-312" in x for x in _list_rows(rows))
    out = await term_views.draw_text(timeline, "timeline", cols=120, rows=36, wrap=DRAW_WRAP, keys=["click:alert"],
                                     panel=False)
    assert "  Source: alert  34 events" in out.splitlines()
    assert {x[21:29].strip() for x in _list_rows(out.splitlines())} == {"alert"}
    out = await term_views.draw_text(timeline, "timeline", cols=120, rows=36, wrap=DRAW_WRAP, ref="view:timeline/INC-313",
                                     panel=False)
    rows = out.splitlines()
    assert "○ INC-312 100  ● INC-313 23  ○ INC-311 11  ○ no incident 64" in rows[0]
    assert rows[2].startswith("  18 May 06:39 – 09:49")
    assert all("INC-313" in x for x in _list_rows(rows))


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


def _tree(body: list[str]) -> list[str]:
    """The lanes' names, from the row under the time range's strip to the axis, whose key starts `× failed`."""
    top = next(i for i, x in enumerate(body) if re.match(r"\s+\d+ \w{3} \d\d:\d\d", x)) + 2
    end = next(i for i, x in enumerate(body) if x.startswith("  × failed"))
    return [re.match(r"\s*\S+(?: \S+)*", x[2:])[0] for x in body[top:end]]


def _linked_pane(rows: list[str], title: str) -> list[str]:
    """The side pane's rows beside the transcript whose title starts `title`, at the right of the `│` between them."""
    t = next(i for i, x in enumerate(rows) if x.startswith(f"  {title}"))
    return [x[x.index("│") + 1:].strip() for x in rows[t + 1:] if "│" in x]


@needs_node
@pytest.mark.parametrize("cols", [120, 200])
async def test_linked_sessions_draws_what_its_browser_page_shows(linked, cols):
    """The worked example at 120 and 200 columns: the top row (search, Filter by, Rows, Color by with its chips), the
    time range's readout and its strip broken where the runs lie hours apart, each run's sessions as a tree of lanes (a
    lead, the subagents it started under it with their guides), the axis with the key of the failed calls, what links
    the lead read to the others, then its transcript under a title that names it and counts its turns: the user's
    prompt, each tool call on one line, a Task call naming the subagent it started; its hint row names ↑↓, Enter, its
    own n p and `?`."""
    out = await term_views.draw_text(linked, "linked-sessions", cols=cols, rows=40, wrap=DRAW_WRAP)
    lines = out.splitlines()
    assert lines[:2] == ["  Linked sessions", "  3 runs · 17 sessions · 352 turns"]
    body, hints = _split(lines, 3, 40)
    assert all(len(x) <= cols + 2 for x in body)
    assert body[0].startswith("  / search  Filter by  none  Rows  Session  Color by  Speaker  ● client-port 100  ● lead 63")
    assert body[1] == "  12 Sep 14:02 – 13 Sep 09:53 · 19h 51m"
    assert body[2].count(" // ") == 2
    assert _tree(body) == [
        "▾ Run 1 · lead", "  ├ survey", "  ├ client-port", "  │ ├ pagination", "  │ └ auth-headers", "  ├ webhooks",
        "  └ test-runner", "▾ Run 2 · lead", "  ├ client-port", "  ├ webhooks", "  └ test-runner", "▾ Run 3 · lead",
        "  ├ survey", "  ├ client-port", "  ├ webhooks", "  ├ reviewer", "  └ reviewer 2"]
    # each run's lanes stand in its own stretch of the axis: Run 2's start after the first break, Run 3's after the second
    breaks = [i for i in range(len(body[2])) if body[2][i:i + 4] == " // "]
    assert body[3][22:breaks[0]].strip() and not body[10][22:breaks[0]].strip() and body[10][breaks[0]:breaks[1]].strip()
    axis = next(i for i, x in enumerate(body) if x.startswith("  × failed"))
    assert body[axis].count("//") == 2 and "12 Sep 14:15" in body[axis] and "13 Sep 09:15" in body[axis]
    assert body[axis + 1] == ""
    assert body[axis + 2].startswith("  lead of Run 1 · nested team · subagents survey 14:03:10, client-port 14:09:05, webhooks 14:09:06")
    assert body[axis + 3].startswith("  lead · Run 1 · nested team  20 turns · 14:02:00 – 14:46:10")
    rows = [re.sub(r"\s*▌*$", "", x) for x in body[axis + 4:]]
    assert rows[:2] == ["  12 Sep 2026", "❯ 14:02:00  ● user"]
    assert rows[2].strip().startswith("Upgrade invoicer from Brambleway API v2 to v3.")
    assert "  14:03:10  ⎿ Task → survey Find every v2 call site" in rows
    assert hints == "↑↓ to choose · Enter to open · n p for the next or previous lane · ? for all keys · b to go back · x to close"


@needs_node
async def test_linked_sessions_folds_a_run_where_the_lanes_have_no_room(linked):
    """In a short panel the largest run folds to one lane of all its sessions, so the transcript keeps its rows; ▸
    unfolds it, and another run folds in its place."""
    out = await term_views.draw_text(linked, "linked-sessions", cols=92, rows=36, wrap=DRAW_WRAP, panel=False)
    body = out.splitlines()
    assert _tree(body)[:2] == ["▸ Run 1 · lead", "▾ Run 2 · lead"]
    assert body[3][22:].strip(), "a folded run draws its sessions' turns in one lane"
    out = await term_views.draw_text(linked, "linked-sessions", cols=92, rows=36, wrap=DRAW_WRAP, panel=False, keys=["click:▸"])
    lanes = _tree(out.splitlines())
    assert lanes[:3] == ["▾ Run 1 · lead", "  ├ survey", "  ├ client-port"] and lanes[-1] == "▸ Run 3 · lead"


@needs_node
async def test_linked_sessions_reads_a_subagent_and_the_session_that_started_it(linked):
    """n reads the next lane, client-port: over its transcript, when lead's Task call started it, when its result came
    back and the subagents it started; its first turn is the prompt lead gave it. u reads lead at that Task call, chosen
    and opened in the side pane beside the transcript (the subagent it started, its whole prompt, what came back, its
    place); s on that call reads client-port again."""
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP, keys=["n", "n"])
    body, hints = _split(out.splitlines(), 3, 40)
    at = next(i for i, x in enumerate(body) if x.startswith("  started by"))
    assert body[at] == ("  started by lead 14:09:05 · result back to lead 14:29:35 · subagents pagination 14:12:40, "
                        "auth-headers 14:12:41")
    assert body[at + 1].startswith("  client-port · Run 1 · nested team  40 turns · 14:09:08 – 14:29:35")
    assert re.sub(r"\s*▌*$", "", body[at + 3]) == "❯ 14:09:08  ● lead"
    # the hint row has room for n p alone of the view's own keys at 120 columns; `?` lists u
    assert "n p for the next or previous lane" in hints and "u to read lead" not in hints
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP, keys=["n", "n", "?"],
                                     panel=False)
    assert ["u", "to read lead"] in _key_list(out)
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP, keys=["n", "n", "u"],
                                     panel=False)
    rows = out.splitlines()
    assert "14:09:05  ⎿ Task → client-port Port invoicer/client to v3" in next(x for x in rows if x.startswith("❯"))
    pane = _linked_pane(rows, "lead · Run 1 · nested team")
    assert pane[0].startswith("lead · Task · 14:09:05") and pane[0].endswith("close")
    assert pane[1] == "→ client-port  Port invoicer/client to v3"
    assert pane[3].startswith("Port invoicer/client to Brambleway v3")
    assert pane[4].startswith("Client on v3 with its interface kept")
    assert pane[5].startswith("↗ …/36fe6b9d") and pane[5].endswith("line 14")
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP,
                                     keys=["n", "n", "u", "s"], panel=False)
    assert any(x.startswith("  client-port · Run 1 · nested team  40 turns") for x in out.splitlines())


@needs_node
async def test_linked_sessions_opens_a_cited_call_beside_its_transcript_and_filters_to_a_cited_run(linked):
    """A citation of an Edit reads its session, the call chosen and opened in the side pane: the lines it took out and
    put in, what came back and its place. A citation of a run turns Filter by to Run with that run alone on, reads its
    lead and leaves only its lanes; Reset turns every run back on."""
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP, ref=f"{PORT1}#L13", panel=False)
    rows = out.splitlines()
    assert "14:10:20  ⎿ Edit invoicer/client/http.py" in next(x for x in rows if x.startswith("❯"))
    pane = _linked_pane(rows, "client-port · Run 1 · nested team")
    assert pane[0].startswith("client-port · Edit · 14:10:20")
    assert pane[1:5] == ["invoicer/client/http.py", '− BASE_URL = "https://api.brambleway.example/v2"',
                         '+ BASE_URL = "https://api.brambleway.example/v3"', "The file invoicer/client/http.py has been updated."]
    assert pane[5].startswith("↗ …/agent-a07a4da7.jsonl line 13")
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP, ref="view:linked-sessions/r3",
                                     panel=False)
    rows = out.splitlines()
    assert rows[0].startswith("  / search  Filter by  Run  ○ Run 1 166  ○ Run 2 95  ● Run 3 91  Rows  Session")
    assert rows[0].rstrip().endswith("reset")
    assert _tree(rows) == ["▾ Run 3 · lead", "  ├ survey", "  ├ client-port", "  ├ webhooks", "  ├ reviewer", "  └ reviewer 2"]
    assert any(x.startswith("  lead · Run 3 · with reviewer  17 turns") for x in rows)
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP, ref="view:linked-sessions/r3",
                                     keys=["r"], panel=False)
    rows = out.splitlines()
    assert "● Run 1 166  ● Run 2 95  ● Run 3 91" in rows[0]
    assert _tree(rows)[0] == "▾ Run 1 · lead"


@needs_node
async def test_linked_sessions_groups_its_lanes_by_agent_and_reads_a_lane_across_its_sessions(linked):
    """Rows by Agent: a lane per agent across the runs, and the transcript of a lane read holds its turns in every session
    in time order, its title naming the lane and counting its turns and sessions."""
    out = await term_views.draw_text(linked, "linked-sessions", cols=120, rows=40, wrap=DRAW_WRAP,
                                     keys=["g", "click:Agent", "n", "n"], panel=False)
    rows = out.splitlines()
    assert "Rows  Agent" in rows[0]
    assert [x.strip() for x in _tree(rows)] == ["lead", "survey", "client-port", "webhooks", "pagination", "auth-headers",
                                                "test-runner", "reviewer"]
    assert any(x.startswith("  Agent: client-port  101 turns · 3 sessions") for x in rows)


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


def _repository_pane(rows: list[str]) -> list[str]:
    """The side pane's half of each row drawn beside the list, after its `│`."""
    return [x.split(" │ ", 1)[1].rstrip() for x in rows if " │ " in x]


@needs_node
@pytest.mark.parametrize("cols", [120, 200])
async def test_repository_draws_what_its_browser_page_shows(repository, cols):
    """The worked example at 120 and 200 columns, a code forge as its command line draws it: the tabs with their counts,
    the top row (search, Filter by with the runs as toggles, Color by with its chips), the time range's readout and strip
    with a break between the runs' days, the columns' names, then a heading per run and a row per pull request: its
    number, its title, its area, state, comments and lines, and under it the dim line a forge writes there."""
    out = await term_views.draw_text(repository, "repository", cols=cols, rows=36, wrap=DRAW_WRAP)
    lines = out.splitlines()
    assert lines[0] == "  Repository"
    body, hints = _split(lines, 2, 36)
    assert all(len(x) <= cols + 2 for x in body)
    assert body[0].split() == ["pull", "requests", "35", "issues", "36", "discussions", "12", "agents", "16"]
    assert body[1].startswith("  / search  Filter by  Run  ● r") and "● r1 8  ● r2 7" in body[1]
    assert "Color by  State  ● merged 28  ● closed 4  ● open 3" in body[1]
    assert body[2] == "  11 May 09:24 – 14 May 13:42 · 3d 4h"
    assert body[3].count(" // ") == 3 and body[4] == ""
    assert body[5].split() == ["pull", "request", "area", "state", "comments", "lines"]
    assert body[6].strip(" ▌") == "r1 · 3 agents · 1 approval to merge · Mon 11 May 2026"
    assert re.match(r"❯ ● #9   Treat 'next <weekday>' as never today +parser +merged +0 +\+1 -1", body[7])
    assert body[8].strip().startswith("opened 09:24 by ash · fixes #1 · approved · merged by its author")
    eleven = next(i for i, x in enumerate(body) if x.startswith("  ● #11  Keep wall-clock"))
    assert body[eleven + 1].strip().startswith("opened 09:50 by cedar · fixes #3 · changes requested · merged by its author")
    assert hints == "↑↓ to choose · Enter to open · 1 2 3 4 for the tabs · ? for all keys · b to go back · x to close"


@needs_node
async def test_repository_opens_a_pull_request_as_its_page_in_the_side_pane(repository):
    """Enter opens a pull request's page beside the list, never under its row: its facts named plainly, the issue it
    fixes and the same issue in the other runs, its flags, then its records in time order, each commit with its diff,
    which ↑↓ move through and Enter opens at its place; a click on another run's issue opens that issue's page."""
    out = await term_views.draw_text(repository, "repository", cols=120, rows=44, wrap=DRAW_WRAP,
                                     keys=["down", "down", "return"], panel=False)
    rows = out.splitlines()
    pane = _repository_pane(rows)
    assert pane[0].startswith("r1 #11 Keep wall-clock time") and pane[0].endswith("close")
    assert pane[1] == "state merged · opened 09:50 by cedar"
    assert "review changes requested · approvals 1 of 1" in pane
    assert pane[pane.index("review changes requested · approvals 1 of 1") + 1].startswith("fixes  #3 Every-other-week")
    assert "other runs  r2 #3 fixed  r3 #3 fixed  r4 #3 fixed" in pane
    assert any(x.startswith("09:53  cedar  pushed 4079459") for x in pane)
    assert "+        at = local + n * self.period" in [x.strip(" ▌") for x in pane]
    assert any(x.startswith("10:35  ash  changes requested") for x in pane)
    assert not any("ask about it" in x for x in rows)
    assert next(x for x in rows if x.startswith("❯")).startswith("❯ ● #11  Keep wall-clock"), "its row stays in the list"
    out = await term_views.draw_text(repository, "repository", cols=120, rows=44, wrap=DRAW_WRAP,
                                     keys=["down", "down", "return", "click:r2 #3 fixed"], panel=False)
    pane = _repository_pane(out.splitlines())
    assert pane[0].startswith("r2 #3 Every-other-week schedule")
    assert any(re.match(r"\d\d:\d\d  \S+\s+merged #11", x) for x in pane)


@needs_node
async def test_repository_draws_a_thread_as_replies_and_an_agent_as_its_profile(repository):
    """The board's threads: a row per thread with its first words, and its page the first post with the replies under
    it on tree guides; the agents: a row per agent with its sign-off, and its page what it did."""
    out = await term_views.draw_text(repository, "repository", cols=120, rows=40, wrap=DRAW_WRAP, keys=["3", "return"],
                                     panel=False)
    rows = out.splitlines()
    assert next(x for x in rows if x.startswith("❯")).startswith("❯ ● Splitting the backlog")
    pane = _repository_pane(rows)
    at = pane.index("ash  09:02")
    assert pane[at + 1:at + 5] == ["│ I'll take #1 and #4, both in parse and format.", "├ birch  09:02", "│ #2 and #6 for me.",
                                   "├ cedar  09:06"]
    assert "└ ash  09:09" in pane
    out = await term_views.draw_text(repository, "repository", cols=140, rows=40, wrap=DRAW_WRAP, keys=["4", "return"],
                                     panel=False)
    rows = out.splitlines()
    assert any('"Signing off: three merged, four reviews given."' in x for x in rows)
    pane = _repository_pane(rows)
    assert any(x.startswith("run r1 · pull requests 3") for x in pane)
    assert any(x.startswith("09:24  opened #9") for x in pane)


@needs_node
async def test_repository_follows_its_citations_its_filter_and_its_chips(repository):
    """A citation of a record opens its item's page with the record chosen and in view; a run's citation frames the
    run's day in the time range; a Filter by toggle leaves out a run, and a Color by chip turned off the items of its
    value."""
    out = await term_views.draw_text(repository, "repository", cols=120, rows=24, wrap=DRAW_WRAP,
                                     ref="runs/r1/events.jsonl#L35", panel=False)
    pane = _repository_pane(out.splitlines())
    assert pane[0].startswith("r1 #11 Keep wall-clock time")
    assert any(x.startswith("10:58  ash  commented") for x in pane), "the cited record is in view"
    out = await term_views.draw_text(repository, "repository", cols=120, rows=24, wrap=DRAW_WRAP, ref="view:repository/r2",
                                     panel=False)
    rows = out.splitlines()
    assert rows[2] == "  12 May 09:30 – 14:12 · 4h 42m" and rows[1].rstrip().endswith("reset")
    assert [x.strip()[:2] for x in rows if "approval to merge" in x or "approvals to merge" in x] == ["r2"]
    out = await term_views.draw_text(repository, "repository", cols=120, rows=40, wrap=DRAW_WRAP, keys=["click:r1 8"],
                                     panel=False)
    rows = out.splitlines()
    assert "○ r1 8" in rows[1] and not any(x.strip().startswith("r1 ·") for x in rows)
    out = await term_views.draw_text(repository, "repository", cols=120, rows=90, wrap=DRAW_WRAP, keys=["click:closed 4"],
                                     panel=False)
    rows = out.splitlines()
    assert "○ closed 4" in rows[1]
    states = {m[1] for x in rows if re.match(r"(❯| ) ● #\d+", x) and (m := re.search(r" (merged|closed|open) ", x))}
    assert states == {"merged", "open"}


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
    where the row has no room, its chips under it where they have none beside it; Filter by's values behind `+N` where
    they do not fit; list rows cut with …; the hint row one row, its most needed hints kept; a range a drag framed has
    its window between `[` `]`."""
    await _labels_on(timeline, "timeline")
    for cols in WIDTHS:
        out = await term_views.draw_text(timeline, "timeline", cols=cols, rows=34, wrap=DRAW_WRAP)
        lines = out.splitlines()
        body, hints = _split(lines, 2, 34)
        assert all(len(x) <= cols + 2 for x in body), cols
        top = "\n".join(body[:4])
        assert "/ search events  Filter by  Incident" in body[0]
        assert "Color by  Database connections ↗" in top and "● connections 22" in top and "● not marked 176" in top, cols
        assert len(hints) <= cols, cols
        assert hints == ("↑↓ to choose · Enter to open · b to go back" if cols < 60 else
                         "↑↓ to choose · Enter to open · ? for all keys · b to go back · x to close"), cols
        rows = _list_rows(body)
        assert rows and all(len(x) <= cols for x in rows)
        if cols == 47:
            assert body[0].strip() == "/ search events  Filter by  Incident  +4"
            assert body[1].strip() == "Rows  Source"
            assert body[2].strip() == "Color by  Database connections ↗" and body[3].strip() == "● connections 22  ● not marked 176"
            assert rows[0].endswith("Tonight's release…"), "a cut row ends in …"
    out = await term_views.draw_text(timeline, "timeline", cols=47, rows=34, wrap=DRAW_WRAP, keys=["drag:10-30"], panel=False)
    strip = next(x for x in out.splitlines() if "[" in x and "]" in x)
    assert strip.index("[") < strip.index("]")
    # the signs that zoomed and panned it do nothing now
    again = await term_views.draw_text(timeline, "timeline", cols=47, rows=34, wrap=DRAW_WRAP, keys=["drag:10-30", "+", "]", "{"],
                                       panel=False)
    assert again == out


@needs_node
async def test_timeline_details_and_menu_read_in_a_narrow_panel(timeline):
    """At 47 cells the side pane stands under the list, a rule between them: an opened event's words and facts wrap to
    the panel's width and its place keeps its line. The Color by menu stands in a frame, the label's values and
    definition under its name, its ↗ whole."""
    await _labels_on(timeline, "timeline")
    out = await term_views.draw_text(timeline, "timeline", cols=47, rows=40, wrap=DRAW_WRAP,
                                     keys=["down"] * 8 + ["return"], panel=False)
    rows = [re.sub(r"\s*▌*$", "", x) for x in out.splitlines()]
    at = next(i for i, x in enumerate(rows) if x.startswith("❯"))
    assert "03:00:48  alert" in rows[at] and set(rows[at + 1].strip()) == {"─"}
    assert rows[at + 2].strip().startswith("alert fired · 03:00:48") and rows[at + 2].rstrip().endswith("close")
    assert rows[at + 3].strip() == "payments: health check failing on 2 of 3"
    assert rows[at + 5].strip() == "service payments · severity critical"
    assert any(x.strip() == "↗ alerts/monitor-20260516-0000.jsonl line 2" for x in rows)
    assert "ask about it" not in out
    assert rows[1].rstrip().endswith("reset"), "reset shows once a row is opened"
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
    """Colored by the label that is on; each run's lead whole on its lane; the hint row one row; framed on one run, the
    lanes of the sessions that did not run then go, and the transcript reads a session that did."""
    await _labels_on(linked, "linked-sessions")
    for cols in WIDTHS:
        out = await term_views.draw_text(linked, "linked-sessions", cols=cols, rows=40, wrap=DRAW_WRAP)
        body, hints = _split(out.splitlines(), 3, 40)
        assert all(len(x) <= cols + 2 for x in body), cols
        top = "\n".join(body[:4])
        assert "Color by  Pagination ↗" in top and "● pagination 20" in top, cols
        assert "Run 3 · lead" in "\n".join(body), cols
        assert len(hints) <= cols and hints.startswith("↑↓ to choose · Enter to open"), cols
    out = await term_views.draw_text(linked, "linked-sessions", cols=47, rows=40, wrap=DRAW_WRAP, keys=["drag:9-17"],
                                     panel=False)
    rows = out.splitlines()
    lanes = "\n".join(_tree(rows))
    assert "Run 2 · lead" in lanes and "Run 1" not in lanes
    assert any(x.startswith("  lead · Run 2") for x in rows), "\n".join(rows)


@needs_node
async def test_repository_opens_as_its_browser_page_does_and_reads_at_every_width(repository):
    """Colored by the label that is on; the tabs, a heading per run and the columns' names read at every width, the tabs'
    names shorter where the panel is narrow; in a narrow panel an item's page stands under the list."""
    await _labels_on(repository, "repository")
    for cols in WIDTHS:
        out = await term_views.draw_text(repository, "repository", cols=cols, rows=36, wrap=DRAW_WRAP)
        body, hints = _split(out.splitlines(), 2, 36)
        assert all(len(x) <= cols + 2 for x in body), cols
        assert body[0].split()[:2] == (["pulls", "35"] if cols < 60 else ["pull", "requests"]), cols
        top = "\n".join(body[1:4])
        assert "Color by  Clock change ↗" in top and "● clock change" in top, cols
        assert any(x.strip().startswith("r1 · 3 agents") for x in body), cols
        assert next(x for x in body if x.split()[:2] == ["pull", "request"]), cols
        assert len(hints) <= cols and ("1 2 3 4 for the tabs" in hints) == (cols >= 140), cols
    out = await term_views.draw_text(repository, "repository", cols=47, rows=50, wrap=DRAW_WRAP, keys=["down", "down", "return"],
                                     panel=False)
    rows = [re.sub(r"\s*▌*$", "", x) for x in out.splitlines()]
    rule = next(i for i, x in enumerate(rows) if set(x.strip()) == {"─"})
    assert rows[rule + 1].strip().startswith("r1 #11 Keep wall-clock") and rows[rule + 1].endswith("close")
    at = next(i for i, x in enumerate(rows) if x[2:].startswith("09:50  cedar  opened"))
    assert rows[at].startswith("❯"), "its first record is chosen"
    assert rows[at + 1].strip().startswith("Occurrences are computed in local")

