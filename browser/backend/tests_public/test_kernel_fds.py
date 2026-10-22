"""A server out of file descriptors. A kernel start that fails, whichever step fails, leaves no descriptor, process,
lease or file behind, so failures in a row keep the server's count of open descriptors flat (a leak here ran a Mac's
default 256 out). The server raises its own limit at start, says once a minute that it cannot accept connections rather
than thousands of times a second, and a corpus whose record cannot be read for want of descriptors is not taken for one
that is not registered."""
from __future__ import annotations

import asyncio
import errno
import logging
import os
import subprocess
from pathlib import Path

import pytest
import zmq
from jupyter_client import AsyncKernelClient

from app import config, notebook, procs

CORPUS = "mini"  # conftest's corpus
TRIES = 3


def open_fds() -> int:
    """How many descriptors this process holds."""
    return len(os.listdir("/proc/self/fd" if os.path.isdir("/proc/self/fd") else "/dev/fd"))


class ControlOutOfFiles(AsyncKernelClient):
    """A client whose control channel fails as zmq does in a process out of descriptors: after the shell, iopub and
    stdin sockets and the heartbeat's thread are made, the last channel's socket is not."""

    def connect_control(self, identity=None):
        raise zmq.ZMQError(errno.EMFILE)


@pytest.fixture()
def spawned(monkeypatch) -> list[subprocess.Popen]:
    """Every process the kernel start spawns, unwrapped, so the test sees whether it is left running."""
    monkeypatch.setenv(config.KERNEL_WRAP_ENV, "none")
    out: list[subprocess.Popen] = []
    real = subprocess.Popen

    def popen(*a, **kw):
        p = real(*a, **kw)
        out.append(p)
        return p

    monkeypatch.setattr(notebook.subprocess, "Popen", popen)
    return out


async def _start_fails(name: str) -> str:
    k = notebook._kernel(CORPUS, name)
    async with k.lock:
        with pytest.raises(Exception) as e:
            await notebook._ensure_started(k, CORPUS, name)
    assert k.kc is None and k.proc is None and k.pid is None and k.lease_fd is None
    assert not k.record.exists() and not k.conn.exists()
    return str(e.value)


def _kernel_procs(spawned: list[subprocess.Popen]) -> list[int]:
    return [p.pid for p in spawned if "ipykernel_launcher" in " ".join(map(str, p.args)) and procs.alive(p.pid)]


@pytest.mark.parametrize("step", ["channels", "record", "dies"])
async def test_kernel_starts_that_fail_leave_the_count_of_open_descriptors_flat(step, spawned, monkeypatch):
    """A start whose channels fail part way (zmq out of descriptors), whose record cannot be written after the process
    was spawned, or whose process dies before it answers: each closes the channels and zmq context it made, ends the
    process it spawned and drops its files, so after a first failure (which may load what a process loads once) more
    failures add no descriptor."""
    if step == "channels":
        monkeypatch.setattr(notebook, "AsyncKernelClient", ControlOutOfFiles)
    elif step == "record":
        def no_record(k, rec):
            raise OSError(errno.EMFILE, "Too many open files")

        monkeypatch.setattr(notebook, "_write_record", no_record)
    else:
        real_argv = notebook.kernel_argv

        def dies(conn, record, **kw):
            return [notebook.PYTHON, "-c", "import sys; sys.exit(3)", "ipykernel_launcher", *real_argv(conn, record, **kw)[3:]]

        monkeypatch.setattr(notebook, "kernel_argv", dies)
    try:
        said = await _start_fails("fds")
        before = open_fds()
        for _ in range(TRIES):
            assert await _start_fails("fds") == said
        assert open_fds() == before, f"{open_fds() - before} descriptors left by {TRIES} failed starts ({said})"
        assert len(spawned) == TRIES + 1 and not _kernel_procs(spawned), "a failed start leaves no kernel running"
    finally:
        await notebook.shutdown_all()


async def test_a_launched_kernel_is_alive_by_its_process_even_where_its_command_line_cannot_be_read(spawned, monkeypatch):
    """A kernel this server launched is alive while its process has not exited, without reading /proc or running ps,
    which fail in a process out of descriptors (and took a live kernel for dead: "the kernel died before answering
    kernel_info"); its shutdown ends it all the same."""
    k = notebook._kernel(CORPUS, "alive")
    try:
        async with k.lock:
            await notebook._ensure_started(k, CORPUS, "alive")
        pid = k.pid
        monkeypatch.setattr(procs, "argv", lambda pid: [])  # what procs answers when it cannot read the process
        assert k.alive()
        await notebook.shutdown_kernel(CORPUS, "alive")
        assert not procs.alive(pid) and not _kernel_procs(spawned)
    finally:
        await notebook.shutdown_all()


def test_the_server_raises_its_open_files_limit_toward_the_hard_limit(monkeypatch):
    """At start the server raises its soft limit of open files to OPEN_FILES, or to the hard limit when that is lower,
    and says so; a limit that is high enough already is left as it is."""
    import resource

    from app import main

    set_to: list[tuple[int, int]] = []
    monkeypatch.setattr(resource, "setrlimit", lambda what, v: set_to.append(v))
    monkeypatch.setattr(resource, "getrlimit", lambda what: (256, resource.RLIM_INFINITY))
    assert main.raise_open_files() == f"open files: raised the soft limit from 256 to {main.OPEN_FILES} (hard unlimited)"
    monkeypatch.setattr(resource, "getrlimit", lambda what: (256, 4096))
    assert main.raise_open_files() == "open files: raised the soft limit from 256 to 4096 (hard 4096)"
    assert set_to == [(main.OPEN_FILES, resource.RLIM_INFINITY), (4096, 4096)]
    monkeypatch.setattr(resource, "getrlimit", lambda what: (main.OPEN_FILES * 2, resource.RLIM_INFINITY))
    assert main.raise_open_files() == "" and len(set_to) == 2

    def refused(what, v):
        raise ValueError("not allowed")

    monkeypatch.setattr(resource, "getrlimit", lambda what: (256, 1024))
    monkeypatch.setattr(resource, "setrlimit", refused)
    assert main.raise_open_files() == "open files: the soft limit stays 256 (hard 1024); raising it to 1024 failed: not allowed"


def test_a_server_out_of_descriptors_says_once_a_minute_that_it_cannot_accept_connections(caplog):
    """asyncio reports each failed accept() of a process out of descriptors, thousands a second: the server logs one
    line in ACCEPT_LOG_S for them, and passes any other error to the handler the loop had."""
    from app import main

    loop = asyncio.new_event_loop()
    others: list[str] = []
    loop.set_exception_handler(lambda lp, context: others.append(context["message"]))
    try:
        main.quiet_accept_errors(loop)
        with caplog.at_level(logging.ERROR, logger="thimble"):
            for _ in range(1000):
                loop.call_exception_handler({"message": main.ACCEPT_ERROR, "exception": OSError(errno.EMFILE, "out")})
            loop.call_exception_handler({"message": "another error"})
    finally:
        loop.close()
    lines = [r.getMessage() for r in caplog.records if "cannot accept connections" in r.getMessage()]
    assert len(lines) == 1 and "thimble server restart" in lines[0]
    assert others == ["another error"]


def test_a_corpus_whose_record_cannot_be_read_for_want_of_descriptors_is_not_called_unregistered(tmp_path, monkeypatch):
    """corpus_dir raises the OSError of a process out of descriptors rather than "no such corpus", which the server log
    said of a corpus that was registered all along."""
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    (tmp_path / "logs").mkdir()
    name = config.register_corpus(tmp_path / "logs")["name"]
    assert config.corpus_dir(name) == (tmp_path / "logs").resolve()
    real = Path.read_text

    def read_text(self, *a, **kw):
        if self == config.sidecar_path(name):
            raise OSError(errno.EMFILE, "Too many open files")
        return real(self, *a, **kw)

    monkeypatch.setattr(Path, "read_text", read_text)
    with pytest.raises(OSError) as e:
        config.corpus_dir(name)
    assert e.value.errno == errno.EMFILE
    with pytest.raises(ValueError, match="no such corpus"):
        config.corpus_dir("not-registered")
