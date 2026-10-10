"""`profile_data`: main's description of the data, checked against the records (views round 5; exploration).

Main passes TypeScript types of the corpus's records (`types`), or a description in plain words and the files to
profile (`description`, `files`). The tool runs profile_types.py on them, in the sandbox the workspace's card kernels
run in (notebook.wrapped_argv or sandboxed_argv, as settings.json's kernel_wrap says; unwrapped only where the
kernels are), since a type's derived fields are code main wrote: the corpus read-only, the workspace writable, the
install tree hidden. So the engine and what it imports (profile_derive.mjs, kernel_thimble.py, for labels) are copied
into the workspace's views-work/profile/.engine first. It answers with the profile, which the engine also saves with
its input in views-work/profile (types.ts or description.md, and profile.txt), where dev.data_text finds them for each
build. The tool is listed only where the prompts' tools.md has its section (tools.Spec.optional)."""
from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path
from typing import Any

from . import config, profile_types

ENGINE_FILES = ("profile_types.py", "profile_derive.mjs", "kernel_thimble.py")
TIMEOUT_S = 300.0  # the tool waits this long for the profile, which main waits for


def folder(c: str) -> Path:
    return config.workspace_dir(c) / profile_types.PROFILE_DIR


def saved(c: str) -> tuple[str, str] | None:
    """(main's last types or description, its profile), or None when main made none."""
    d = folder(c)
    prof = d / "profile.txt"
    if not prof.is_file():
        return None
    for name in ("types.ts", "description.md"):
        if (d / name).is_file():
            try:
                return (d / name).read_text("utf-8"), prof.read_text("utf-8")
            except OSError:
                return None
    return None


def run_engine(c: str, cmd: str, text: str, globs: list[str] | None) -> tuple[int, str]:
    """(exit code, what the engine printed: the profile, or why there is none). Blocking (a thread)."""
    from . import kernel_wrap, notebook  # noqa: PLC0415

    ws, corpus = config.workspace_dir(c).resolve(), config.corpus_dir(c).resolve()
    out = folder(c)
    engine = out / ".engine"
    engine.mkdir(parents=True, exist_ok=True)
    here = Path(__file__).resolve().parent
    for name in ENGINE_FILES:
        shutil.copy2(here / name, engine / name)
    inp = engine / ("input.ts" if cmd == "types" else "input.md")
    inp.write_text(text, "utf-8")
    node = shutil.which("node")
    argv = [notebook.PYTHON, str(engine / "profile_types.py"), cmd,
            *([str(inp)] if cmd == "types" else [*(globs or []), "--input", str(inp)]),
            "--out", str(out), "--root", str(corpus), "--ws", str(ws), *(["--node", node] if node else [])]
    wrap, source = config.resolve_kernel_wrap(notebook._ws_settings(c))
    env = notebook.kernel_env()
    if wrap == config.KERNEL_WRAP_BWRAP:
        conn = engine / "conn"
        conn.mkdir(exist_ok=True)
        argv = notebook.wrapped_argv(argv, workspace=c, corpus=corpus, connection_file=conn / "none", source=source)
    elif wrap == config.KERNEL_WRAP_SRT:
        argv = notebook.sandboxed_argv(argv, workspace=c, corpus=corpus, source=source)
        home = engine / "home"
        shutil.rmtree(home, ignore_errors=True)
        (home / "tmp").mkdir(parents=True)
        env = kernel_wrap.srt_env(env, home=home)
    r = subprocess.run(argv, cwd=str(corpus), env=env, capture_output=True, text=True, timeout=TIMEOUT_S,
                       stdin=subprocess.DEVNULL)
    said = r.stdout if r.returncode == 0 else (r.stderr.strip() or r.stdout.strip())
    return r.returncode, said


async def tool_profile_data(ctx: Any, args: dict[str, Any]) -> Any:
    """The `profile_data` tool: the profile of main's types, or of the files its plain description names."""
    from . import tools  # noqa: PLC0415

    types = str(args.get("types") or "").strip()
    desc = str(args.get("description") or "").strip()
    files = args.get("files") or []
    files = [files] if isinstance(files, str) else [str(f) for f in files if str(f).strip()]
    if types:
        cmd, text, globs = "types", types, None
    elif desc:
        cmd, text, globs = "files", desc, files
    else:
        return tools.err("profile_data: give `types`, or `description` and `files`")
    try:
        code, said = await asyncio.to_thread(run_engine, ctx.c, cmd, text, globs)
    except subprocess.TimeoutExpired:
        return tools.err(f"profile_data: the profile took longer than {TIMEOUT_S / 60:.0f} minutes")
    except (OSError, RuntimeError, subprocess.SubprocessError) as e:
        return tools.err(f"profile_data: the profile could not run ({e})")
    if code != 0:
        return tools.err(said[-3000:] or f"profile_data: the profile ended with code {code}")
    return tools.ok(said)
