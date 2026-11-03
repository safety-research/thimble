"""The ANTHROPIC_* variables that a `claude` thimble starts signs in with (config.launch_environ) reach none of the
commands its sessions run: every session thimble fences runs its commands in Claude Code's sandbox, which unsets them
(cc_settings.env_denies); on Claude Code sign-in the checker's fork runs its python there too; and a dev ticket's gates
run without them, as the card kernels do. The live test runs the user's own `claude` with a made-up key against a
stand-in for Anthropic's API on 127.0.0.1, so it needs no login and reaches no network; it needs THIMBLE_LIVE_CLAUDE=1
and Claude Code's sandbox."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import agent_session, cc_settings, claude_access, config, dev, marks, runtime_api, runtime_cc

FAKE_KEY = "-".join(("sk", "ant", "made", "up", "key", "for", "tests"))  # built, so no scanner takes it for a key
DENIED = [{"name": "ANTHROPIC_API_KEY", "mode": "deny"}, {"name": "ANTHROPIC_BASE_URL", "mode": "deny"}]
LIVE = os.environ.get("THIMBLE_LIVE_CLAUDE") == "1"
REAL_CLAUDE = shutil.which("claude")  # read at import, before the suite's stand-in goes first on PATH


@pytest.fixture()
def key(monkeypatch):
    """A made-up ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL where thimble runs, and no other ANTHROPIC_* variable."""
    for k in [k for k in os.environ if k.startswith("ANTHROPIC_")]:
        monkeypatch.delenv(k)
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9")


def test_every_session_thimble_fences_runs_its_commands_without_the_anthropic_variables(key, tmp_path, monkeypatch):
    """runtime_cc's sessions, a program's sessions (agent_session.fence) and a dev ticket's (dev.ticket_fence) take
    their sandbox from cc_settings.offline_sandbox; a name Claude Code would refuse in its settings is left out."""
    monkeypatch.setenv("ANTHROPIC_NOT.A-NAME", "x")
    box = cc_settings.offline_sandbox()
    assert box["credentials"] == {"envVars": DENIED}
    spec = SimpleNamespace(model="claude-opus-5-5", effort="high", cwd=tmp_path, write_roots=[], private=[],
                           no_write=[])
    assert runtime_cc.settings(spec, True, tmp_path / "t")["sandbox"]["credentials"] == {"envVars": DENIED}
    fenced = agent_session.fence(tmp_path / "corpus", tmp_path / "work", sandbox=True, data="ask")
    assert fenced["sandbox"]["credentials"] == {"envVars": DENIED}


def test_with_no_anthropic_variable_the_sandbox_settings_name_none(monkeypatch):
    for k in [k for k in os.environ if k.startswith("ANTHROPIC_")]:
        monkeypatch.delenv(k)
    assert "credentials" not in cc_settings.offline_sandbox(network=True)


def test_a_dev_ticket_s_gates_run_without_the_anthropic_variables(key, monkeypatch):
    monkeypatch.setenv("THIMBLE_PORT", "1")
    env = dev._gate_environ({"THIMBLE_SKIP_KEY": "1"})
    assert not [k for k in env if k.startswith("ANTHROPIC_")]
    assert env["THIMBLE_SKIP_KEY"] == "1" and "THIMBLE_PORT" not in env and env["PATH"] == os.environ["PATH"]


class FakeFork:
    """A `claude` process that answers at once, as the fork's stand-in."""

    returncode = 0
    pid = 0

    async def communicate(self, _input: bytes) -> tuple[bytes, bytes]:
        return json.dumps({"type": "result", "subtype": "success", "result": "ok"}).encode() + b"\n", b""


@pytest.mark.parametrize("sandbox", ["1", "0"])
async def test_the_checker_s_fork_runs_python_in_the_sandbox_on_claude_code_sign_in(key, tmp_path, monkeypatch,
                                                                                     sandbox):
    """Where Claude Code's sandbox runs, the fork's settings put its python in it, without the ANTHROPIC_* variables,
    while its own environment keeps them to sign in; it gets a short TMPDIR of its own, which goes when it ends, as does
    the .claude/.cc-writes/ the sandbox makes in the corpus. Where the sandbox can't run, the fork runs as before."""
    monkeypatch.setenv("THIMBLE_SANDBOX", sandbox)
    monkeypatch.setenv("THIMBLE_RUNTIME", "on")
    claude_access.save(claude_access.CLAUDE_CODE, consent=True)
    monkeypatch.setattr(runtime_api, "cc_main_session", lambda c: "sid-of-main")
    monkeypatch.setattr(marks, "_model", lambda c, main, prompt: ("claude-opus-5-5", "low"))
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    seen: dict = {}

    async def fake_exec(*argv, cwd, env, **_kw):
        seen.update(argv=list(argv), cwd=cwd, env=env, tmp_there=Path(env.get("TMPDIR") or "/nowhere").is_dir())
        if sandbox == "1":
            (Path(cwd) / ".claude" / ".cc-writes").mkdir(parents=True)  # as Claude Code's sandbox makes it
        return FakeFork()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    got = await marks.run_fork("mini", {"cwd": str(corpus)}, "cut", "Check [2](#).")
    assert got["error"] is None and seen["cwd"] == str(corpus)
    argv = seen["argv"]
    assert argv[argv.index("--resume") + 1] == "sid-of-main"
    settings = json.loads(argv[argv.index("--settings") + 1])
    assert seen["env"]["ANTHROPIC_API_KEY"] == FAKE_KEY, "Claude Code signs in with it"
    if sandbox == "0":
        assert "sandbox" not in settings and "CLAUDE_CODE_TMPDIR" not in seen["env"]
        return
    assert settings["sandbox"] == {**cc_settings.offline_sandbox(required=True), "credentials": {"envVars": DENIED}}
    assert settings["sandbox"]["failIfUnavailable"] and not settings["sandbox"]["autoAllowBashIfSandboxed"]
    tmp = Path(seen["env"]["TMPDIR"])
    assert seen["tmp_there"] and seen["env"]["CLAUDE_CODE_TMPDIR"] == str(tmp)
    assert len(str(tmp)) <= runtime_cc.TMP_MAX and not tmp.exists(), "a short TMPDIR of its own, gone at the end"
    assert not (corpus / ".claude").exists(), "the corpus is left as it was"


# --------------------------------------------------------------------------- live: the user's own claude


class StandIn(BaseHTTPRequestHandler):
    """Anthropic's Messages API, made up: to a request whose tools hold Bash it answers with a Bash call of COMMAND, and
    to the one that carries that call's result with "done". It keeps each request's x-api-key and each result."""

    COMMAND = ("python3 -c \"import os; print('KEY=[%s]' % os.environ.get('ANTHROPIC_API_KEY', 'unset')); "
               "print(sorted(k for k in os.environ if k.startswith('ANTHROPIC_')))\"")
    keys: list = []
    results: list = []

    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if not self.path.startswith("/v1/messages") or self.path.startswith("/v1/messages/count_tokens"):
            data = json.dumps({"input_tokens": 1}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.keys.append(self.headers.get("x-api-key"))
        given = []
        for m in reversed(body.get("messages") or []):
            if m.get("role") == "assistant":
                break
            for b in m.get("content") if isinstance(m.get("content"), list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    c = b.get("content")
                    given.append(c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or []))
        self.results.extend(given)
        if not given and "Bash" in [t.get("name") for t in body.get("tools") or []]:
            block = {"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:12]}", "name": "Bash",
                     "input": {"command": self.COMMAND, "description": "Print the variables"}}
            stop = "tool_use"
        else:
            block, stop = {"type": "text", "text": "done"}, "end_turn"
        msg = {"id": "msg_1", "type": "message", "role": "assistant", "model": body.get("model"), "content": [],
               "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}
        events = [("message_start", {"type": "message_start", "message": msg}),
                  ("content_block_start", {"type": "content_block_start", "index": 0,
                                           "content_block": {**block, "input": {}} if stop == "tool_use" else
                                           {"type": "text", "text": ""}}),
                  ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta":
                                           {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
                                           if stop == "tool_use" else {"type": "text_delta", "text": block["text"]}}),
                  ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                  ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                                     "usage": {"output_tokens": 1}}),
                  ("message_stop", {"type": "message_stop"})]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for name, data in events:
            self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())
        self.close_connection = True


def _live_ok() -> str:
    if not LIVE:
        return "set THIMBLE_LIVE_CLAUDE=1 to run the user's own claude"
    if not REAL_CLAUDE:
        return "no claude on PATH"
    if not cc_settings.sandbox_ok():
        return "Claude Code's sandbox can't run here"
    return ""


@pytest.mark.skipif(bool(_live_ok()), reason=_live_ok() or "runs")
def test_live_a_session_s_and_the_fork_s_python_never_see_the_key_claude_code_signs_in_with(key, tmp_path,
                                                                                             monkeypatch):
    """A session as runtime_cc starts it and the checker's fork of it, on the user's `claude` with a made-up key and the
    stand-in API: Claude Code signs in with the key, and the python each runs in Bash sees no ANTHROPIC_* value."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), StandIn)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    StandIn.keys, StandIn.results = [], []
    tmp = None
    try:
        monkeypatch.setenv("ANTHROPIC_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}")
        home, corpus = tmp_path / "home", tmp_path / "corpus"
        corpus.mkdir(parents=True)
        home.mkdir()
        tmp = runtime_cc.short_tmp()
        own = {"HOME": str(home), "CLAUDE_CONFIG_DIR": str(home / ".claude"), "DISABLE_AUTOUPDATER": "1",
               "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "TMPDIR": str(tmp), "CLAUDE_CODE_TMPDIR": str(tmp)}
        spec = SimpleNamespace(model="claude-opus-5-5", effort="low", cwd=corpus, write_roots=[], private=[],
                               no_write=[])
        env = {**config.launch_environ(), **own}
        done = subprocess.run([REAL_CLAUDE, "-p", "Run the command.", "--model", "claude-opus-5-5", "--allowedTools",
                               "Bash", "--settings", json.dumps(runtime_cc.settings(spec, True, tmp)), "--safe-mode",
                               "--strict-mcp-config", "--setting-sources", "user", "--output-format", "json",
                               "--max-turns", "3"], cwd=corpus, env=env, capture_output=True, text=True,
                              stdin=subprocess.DEVNULL, timeout=180)
        sid = json.loads(done.stdout or "{}").get("session_id")
        assert sid and len(StandIn.results) == 1, done.stdout[-500:] + done.stderr[-500:]
        argv = marks.fork_argv({"sid": sid}, None, "claude-opus-5-5", "low", sandbox=True)
        argv[0] = REAL_CLAUDE
        done = subprocess.run(argv, cwd=corpus, input="Check the reply.", capture_output=True, text=True, timeout=180,
                              env={**marks._env({}), **own})
        assert len(StandIn.results) == 2, done.stdout[-500:] + done.stderr[-500:]
        assert StandIn.keys and set(StandIn.keys) == {FAKE_KEY}, "Claude Code signs in with the key"
        for said in StandIn.results:  # the model variables the fork blanks (sdk.SCRUBBED_ENV) hold nothing
            assert FAKE_KEY not in said and "KEY=[unset]" in said and "ANTHROPIC_BASE_URL" not in said
    finally:
        server.shutdown()
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)
