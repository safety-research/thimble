"""app.notebook's kernels: a card's code runs in the workspace's scratch mirror of the corpus, one link per entry of the
corpus folder, so it reads the corpus by its relative paths while its writes never reach the corpus, and the kernel's
environment holds no credential. Each test gets a fresh workspace dir (workspaces_tmp) and shuts its kernel down at
the end."""
from __future__ import annotations

import pytest

from app import config, notebook

CORPUS = "mini"
SECRETS = {"ANTHROPIC_API_KEY": "sk-ant-FAKE", "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-FAKE",
           "SOME_SERVICE_TOKEN": "t", "CLAUDE_CONFIG_DIR": "/tmp/cfg"}


@pytest.fixture(autouse=True)
async def _kernels_down():
    yield
    await notebook.shutdown_all()


def _text(cell: dict) -> str:
    return "".join(b.get("text/plain", "") for b in cell["outputs"] if "_stream" in b)


async def test_a_card_runs_in_a_mirror_of_the_corpus_writes_none_of_it_and_sees_no_credential(workspaces_tmp,
                                                                                            monkeypatch):
    for k, v in SECRETS.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("HARMLESS", "1")
    corpus_dir = config.corpus_dir(CORPUS)
    scratch = config.workspace_dir(CORPUS) / notebook.SCRATCH_DIR
    cell = await notebook.run_code(CORPUS, "import os, glob\n"
                                           "print(os.getcwd()); print(os.path.exists('manifest.json'))\n"
                                           "print(os.path.realpath('manifest.json'))\n"
                                           "print(len(glob.glob('agents/*')) > 0, os.path.isdir('agents'))\n"
                                           "import sqlite3; sqlite3.connect('made-by-a-cell.db').close()\n"
                                           "open('notes.txt', 'w').write('x')\n"
                                           f"print(sorted(k for k in {sorted(SECRETS)!r} if k in os.environ), "
                                           "os.environ.get('HARMLESS'))", "user")
    assert cell["status"] == "ok", cell["outputs"]
    lines = _text(cell).splitlines()
    assert lines[0] == str(scratch) and lines[1] == "True"
    assert lines[2] == str((corpus_dir / "manifest.json").resolve())  # read through the link
    assert lines[3] == "True True"  # a folder is one link, which glob reads through
    assert lines[4] == "[] 1", "the kernel's environment holds no credential"
    assert (scratch / "made-by-a-cell.db").is_file() and (scratch / "notes.txt").is_file()
    assert not (corpus_dir / "made-by-a-cell.db").exists() and not (corpus_dir / "notes.txt").exists()


SLOW_START_LIMIT = 0.5  # how long slow_starts' kernels get to answer kernel_info


@pytest.fixture()
def slow_starts(monkeypatch):
    """The first `n` fresh starts of a kernel stuck in its start lines (as on a machine too busy to start it in time),
    with a limit of 0.5 s on their answer, and each start's process as _wait_ready saw it. Set `n` before the run. The
    sandbox's start keeps its usual allowance (STARTUP_TIMEOUT, _open_gate): on a busy runner it can take longer than
    0.5 s to show the kernel's gate, which would end the start before the answer this fixture times."""
    seen: dict = {"n": 1, "procs": []}
    monkeypatch.setattr(notebook, "SHELL_LINES",
                        ("import os, time; os.environ.get('SLOW_START') and time.sleep(60)", *notebook.SHELL_LINES))
    env, wait = notebook.kernel_env, notebook._wait_ready

    def kernel_env():
        return {**env(), **({"SLOW_START": "1"} if len(seen["procs"]) < seen["n"] else {})}

    async def wait_ready(k, kc, timeout, *, control):
        seen["procs"].append(k.proc)
        # the starts that are not slow get the usual allowance, however busy the machine running the tests is
        return await wait(k, kc, SLOW_START_LIMIT if len(seen["procs"]) <= seen["n"] else timeout, control=control)

    monkeypatch.setattr(notebook, "kernel_env", kernel_env)
    monkeypatch.setattr(notebook, "_wait_ready", wait_ready)
    return seen


async def test_a_kernel_that_does_not_answer_in_time_is_killed_and_started_again(workspaces_tmp, slow_starts,
                                                                                 caplog):
    cell = await notebook.run_code(CORPUS, "print('ok')", "user", kernel="slow")
    assert cell["status"] == "ok" and _text(cell) == "ok\n", cell["outputs"]
    first, second = slow_starts["procs"]
    assert first.pid != second.pid and not notebook._group_alive(first.pid, first.pid), "the slow start is gone"
    said = [r.getMessage() for r in caplog.records if "did not answer" in r.getMessage()]
    assert len(said) == 1 and "after its start began" in said[0] and "killed, and starting it again" in said[0]


async def test_a_kernel_that_never_answers_in_time_fails_the_card_with_how_long_each_start_took(workspaces_tmp,
                                                                                               slow_starts):
    slow_starts["n"] = notebook.STARTUP_TRIES
    cell = await notebook.run_code(CORPUS, "print('ok')", "user", kernel="slow")
    assert cell["status"] == "error"
    err = next(b[notebook.ERROR_MIME] for b in cell["outputs"] if notebook.ERROR_MIME in b)
    assert err["ename"] == "TimeoutError"
    assert err["evalue"].startswith("the kernel did not answer kernel_info within 0.5 s (started 2 times, which took ")
    assert len(slow_starts["procs"]) == notebook.STARTUP_TRIES
    assert not any(notebook._group_alive(p.pid, p.pid) for p in slow_starts["procs"])
    k = notebook._kernel(CORPUS, "slow")
    assert k.kc is None and not k.record.exists() and not k.conn.exists()
