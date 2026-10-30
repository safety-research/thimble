"""app.notebook's kernels: a cell runs and its output is stored; it runs in the workspace's scratch mirror of the
corpus, one link per entry of the corpus folder, so its writes never reach the corpus and a folder of many files starts
it as fast as a small one; and the kernel's environment holds no credential.

Each test gets a fresh workspace dir (workspaces_tmp) and shuts its kernel down at the end. Kernel startup takes a
second or two, so timeouts are generous."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from app import config, notebook


@pytest.fixture()
def corpus(workspaces_tmp) -> str:
    """The corpus to run against: the synthetic `mini`, with the test's own workspaces."""
    return "mini"


@pytest.fixture(autouse=True)
async def _kernels_down():
    yield
    await notebook.shutdown_all()


@pytest.fixture()
def app() -> FastAPI:
    # only our router, so these tests do not depend on other owners' modules importing cleanly
    a = FastAPI()
    a.include_router(notebook.router, prefix="/api")
    return a


@pytest.fixture()
async def client(app):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=180) as c:
        yield c


def _text(cell: dict) -> str:
    return "".join(b.get("text/plain", "") for b in cell["outputs"] if "_stream" in b)


async def test_create_and_run_print(client, corpus, workspaces_tmp):
    r = await client.post(f"/api/ws/{corpus}/notebooks/main/cells", json={"code": "print(1+1)"})
    assert r.status_code == 200
    cell = r.json()
    assert len(cell["id"]) == 8 and cell["status"] == "idle" and cell["exec_count"] is None
    assert cell["created_by"] == "user" and cell["outputs"] == []

    r = await client.post(f"/api/ws/{corpus}/notebooks/main/cells/{cell['id']}/run")
    assert r.status_code == 200
    ran = r.json()
    assert ran["id"] == cell["id"]
    assert ran["status"] == "ok"
    assert ran["exec_count"] == 1
    assert ran["outputs"] == [{"text/plain": "2\n", "_stream": "stdout"}]

    # persisted as plain json in the workspace dir (notebooks/<id>.json)
    on_disk = json.loads((workspaces_tmp / corpus / "notebooks" / "main.json").read_text())
    assert on_disk["cells"][0]["outputs"] == ran["outputs"] and on_disk["id"] == "main"
    assert ran["notebook"] == "main" and cell["notebook"] == "main"
    assert (await client.get(f"/api/ws/{corpus}/notebooks/main")).json() == on_disk


@pytest.mark.parametrize("wrap", ["none", "srt", "bwrap"])
async def test_a_kernel_whose_port_another_process_took_first_starts_again_on_new_ports(wrap, client, corpus,
                                                                                        monkeypatch):
    """write_connection_file finds free ports and lets them go; a process that binds one before the kernel does keeps
    it, and the kernel ends at its start. Here another process's zmq socket holds the first file's shell port, so the
    server's socket also meets a peer that is not the kernel, after which zmq drops its only pipe and a blocking send
    would never return. The start never waits on the socket: it sees the kernel end, also inside a sandbox that
    outlives it a while, and starts it on new ports."""
    import zmq
    from test_kernel_sandbox import _wrap_works

    if wrap != "none" and not _wrap_works(wrap):
        pytest.skip(f"{wrap} can't sandbox a process here")
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, wrap)

    ctx, taken = zmq.Context(), []
    real = notebook.write_connection_file

    def first_port_taken(fname: str, **kw):
        if taken:
            return real(fname, **kw)
        # the foreign socket holds its port before the file names it, so no other process can take it in between
        sock = ctx.socket(zmq.PUB)
        taken.append(sock)
        return real(fname, **{**kw, "shell_port": sock.bind_to_random_port("tcp://127.0.0.1")})

    monkeypatch.setattr(notebook, "write_connection_file", first_port_taken)
    try:
        cell = (await client.post(f"/api/ws/{corpus}/notebooks/main/cells", json={"code": "print(6 * 7)"})).json()
        ran = (await client.post(f"/api/ws/{corpus}/notebooks/main/cells/{cell['id']}/run")).json()
    finally:
        ctx.destroy(linger=0)  # closes every socket it made first, so it never waits on one
    assert taken and ran["status"] == "ok" and _text(ran) == "42\n", ran["outputs"]


async def test_a_start_s_limit_holds_while_its_socket_has_no_pipe_to_send_to(tmp_path):
    """A socket with no pipe that takes a message blocks jupyter_client's send for good: its one pipe full (a kernel
    that reads nothing), or gone (zmq drops it once the peer turns out not to be the kernel, here a PUB socket on the
    shell port, as another kernel's iopub). On the event loop that would hold the server and the start's own limit with
    it. _wait_ready never blocks on its socket, so the limit holds."""
    import zmq
    from jupyter_client.connect import write_connection_file

    class Alive:  # a kernel process that runs and never answers
        log = tmp_path / "k.log"

        def alive(self) -> bool:
            return True

    ctx = zmq.Context()
    pub = ctx.socket(zmq.PUB)
    conn = tmp_path / "k.conn.json"
    write_connection_file(str(conn), ip="127.0.0.1", key=b"k", shell_port=pub.bind_to_random_port("tcp://127.0.0.1"))
    kc = notebook._client(conn)
    try:
        # requests until none goes: the pipe is full (zmq's high-water mark is 1000) or gone, whichever comes first
        assert not all(notebook._kernel_info_nowait(kc, kc.shell_channel) for _ in range(100_000))
        with pytest.raises(TimeoutError, match="did not answer kernel_info within 1 s"):
            await notebook._wait_ready(Alive(), kc, 1.0, control=False)
    finally:
        notebook._close_client(kc)
        pub.close(linger=0)
        ctx.term()


def test_a_kernel_client_starts_no_thread_whose_stop_could_hold_the_server(tmp_path):
    """The heartbeat's channel is a thread, and its stop joins it on the event loop: stopped before the thread had
    begun, as a failed start on a busy machine did, it ran on and the join never returned. The server opens no
    heartbeat channel (a kernel's liveness is its pid), so a client starts no thread and its close waits for none."""
    from jupyter_client.connect import write_connection_file

    conn = tmp_path / "k.conn.json"
    write_connection_file(str(conn), ip="127.0.0.1", key=b"k")
    before = set(threading.enumerate())
    kc = notebook._client(conn)
    try:
        assert set(threading.enumerate()) - before == set()
    finally:
        notebook._close_client(kc)


def test_a_kernel_client_the_garbage_collector_takes_unclosed_has_its_sockets_closed_then_its_context(tmp_path):
    """A start whose task the loop dropped leaves its client unclosed, in a cycle the garbage collector takes whole.
    Left to themselves, the context's finalizer could run first, find none of the sockets (the collector clears its
    list of them before any finalizer runs) and wait on them for good, wherever the collection ran. The client's closer,
    which holds the sockets and the context apart from it, closes the sockets and then the context when the collector
    takes the client."""
    import gc
    import weakref

    from jupyter_client.connect import write_connection_file

    conn = tmp_path / "k.conn.json"
    write_connection_file(str(conn), ip="127.0.0.1", key=b"k")
    kc = notebook._client(conn)
    notebook._kernel_info_nowait(kc, kc.shell_channel)  # a message waits in the socket, as a start's kernel_info does
    socks, ctx, gone = [getattr(kc, attr).socket for attr in notebook.CHANNELS], kc.context, weakref.ref(kc)
    held: list = [kc]
    held.append(held)
    del kc, held
    gc.collect()
    assert gone() is None and all(sock.closed for sock in socks) and ctx.closed


async def test_kernel_cwd_is_the_scratch_mirror_and_writes_never_reach_the_corpus(corpus):
    """The kernel starts in workspaces/<c>/scratch, a link to each entry of the corpus folder, so relative
    reads work while every file a cell creates lands in scratch — never in the corpus directory."""
    corpus_dir = config.corpus_dir(corpus)
    scratch = config.workspace_dir(corpus) / notebook.SCRATCH_DIR
    cell = await notebook.run_code(corpus, "import os, glob\n"
                                           "print(os.getcwd()); print(os.path.exists('manifest.json'))\n"
                                           "print(os.path.realpath('manifest.json'))\n"
                                           "print(len(glob.glob('agents/*')) > 0, os.path.isdir('agents'))\n"
                                           "import sqlite3; sqlite3.connect('made-by-a-cell.db').close()\n"
                                           "open('notes.txt', 'w').write('x')", "user")
    assert cell["status"] == "ok", cell["outputs"]
    lines = _text(cell).splitlines()
    assert lines[0] == str(scratch) and lines[1] == "True"
    assert lines[2] == str((corpus_dir / "manifest.json").resolve())  # read through the link
    assert lines[3] == "True True"  # a folder is one link, which glob reads through
    assert (scratch / "made-by-a-cell.db").is_file() and (scratch / "notes.txt").is_file()
    assert not (corpus_dir / "made-by-a-cell.db").exists() and not (corpus_dir / "notes.txt").exists()
    # the mirror is rebuilt on the next kernel start and leaves what the cell made alone
    await notebook.shutdown_all()
    cell = await notebook.run_code(corpus, "import os; print(os.path.exists('notes.txt'), os.path.islink('manifest.json'))", "user")
    assert _text(cell).strip() == "True True"


async def test_the_first_card_on_a_folder_of_many_files_waits_for_no_link_per_file(data_tmp, workspaces_tmp):
    """The kernel's cwd shows each entry of the corpus folder through one link, so the first card on a folder of a
    million screenshots (AI Village's) waits for no link per file, and reads every file by its relative path."""
    shots = data_tmp / "mini" / "images" / "turns"
    for day in range(20):
        (shots / f"day-{day}").mkdir(parents=True)
        for i in range(100):
            (shots / f"day-{day}" / f"{i}.png").write_bytes(b"png")
    cell = await notebook.run_code("mini", "import glob; print(len(glob.glob('images/turns/*/*.png')))", "user")
    assert cell["status"] == "ok" and _text(cell).strip() == "2000", cell["outputs"]
    scratch = config.workspace_dir("mini") / notebook.SCRATCH_DIR
    made = {str(Path(d, n).relative_to(scratch)) for d, ds, fs in os.walk(scratch) for n in ds + fs}
    assert made == set(os.listdir(data_tmp / "mini")) and all((scratch / n).is_symlink() for n in made)


def test_kernel_env_drops_secrets(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-FAKE")
    monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", "wrkspc_x")
    monkeypatch.setenv("CI_ACCESS_TOKEN", "ci_x")
    monkeypatch.setenv("SOME_SERVICE_TOKEN", "t")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-FAKE")  # the CLI's long-lived token: CLAUDE_* and TOKEN both catch it
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/tmp/cfg")
    monkeypatch.setenv("HARMLESS", "1")
    env = notebook.kernel_env()
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID", "CI_ACCESS_TOKEN", "SOME_SERVICE_TOKEN",
              "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"):
        assert k not in env
    assert env["HARMLESS"] == "1" and "PATH" in env


async def test_a_large_output_is_unpacked_off_the_event_loop(corpus, monkeypatch):
    """A call whose output is tens of megabytes, as a view's reader can return: the kernel's message is unpacked, its
    signature checked over every byte and its JSON parsed, in a thread, so the server's loop keeps turning."""
    from jupyter_client.session import Session

    loop_thread = threading.get_ident()
    seen: list[tuple[int, bool]] = []
    deserialize = Session.deserialize

    def spy(self, msg_list, content=True, copy=True):
        seen.append((sum(len(m) for m in msg_list), threading.get_ident() == loop_thread))
        return deserialize(self, msg_list, content, copy)

    monkeypatch.setattr(Session, "deserialize", spy)
    outputs, _, status = await notebook.execute_on(
        corpus, "big", "from IPython.display import publish_display_data\n"
                       "publish_display_data({'text/plain': 'x' * 80_000_000})")
    assert status == "ok" and len(outputs[0]["text/plain"]) == 80_000_000
    large = [on_loop for size, on_loop in seen if size > notebook.MSG_INLINE_BYTES]
    assert large and not any(large), "a large message was unpacked on the event loop"


async def test_a_card_made_is_announced_with_who_made_it_and_an_edit_is_not(corpus, monkeypatch):
    """The workspace record of a card made names its maker (`by`), so the page goes to a card Claude made and leaves a
    card the person made where it is (frontend lib/follow.ts); later records of the card carry no maker."""
    from app import investigation

    sent: list[dict] = []
    monkeypatch.setattr(investigation, "emit", lambda c, inv, ev: sent.append(ev))
    mine = notebook.insert_cell(corpus, "main", notebook.new_cell("code", "user", code="1"))
    claude = notebook.insert_cell(corpus, "main", notebook.new_cell("code", "main", code="2"))
    notebook.edit_cell(corpus, claude["id"], title="Two")
    made = {e["cell"]: e for e in sent if e.get("op") == "created"}
    assert made[mine["id"]]["by"] == "user" and made[claude["id"]]["by"] == "main"
    later = [e for e in sent if e.get("cell") == claude["id"] and e.get("op") != "created"]
    assert later and all("by" not in e for e in later)


async def test_a_card_a_chat_made_is_announced_with_that_chat_s_role(corpus, monkeypatch):
    """A card made by a chat (`chat:<id>`) carries the chat's role (`by_role`), so the page does not follow a card that a
    chat working in the background made, such as a writer's figure (frontend lib/follow.ts)."""
    from app import agents, investigation

    sent: list[dict] = []
    monkeypatch.setattr(investigation, "emit", lambda c, inv, ev: sent.append(ev))
    writer = agents.new_agent(corpus, "writer", "Report", announce=False)
    figure = notebook.insert_cell(corpus, "main", notebook.new_cell("code", f"chat:{writer['id']}", code="1"))
    plain = notebook.insert_cell(corpus, "main", notebook.new_cell("code", "main", code="2"))
    gone = notebook.insert_cell(corpus, "main", notebook.new_cell("code", "chat:abcd1234", code="3"))
    made = {e["cell"]: e for e in sent if e.get("op") == "created"}
    assert made[figure["id"]]["by_role"] == "writer"
    assert "by_role" not in made[plain["id"]] and "by_role" not in made[gone["id"]]
