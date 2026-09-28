"""prompts.py and the repository's own prompt files: every one loads and renders with its own slots and no `{{` left."""

import pytest

from app import prompts


@pytest.fixture()
def pdir(tmp_path, monkeypatch):
    """A fixtures prompts dir, selected via THIMBLE_PROMPTS_DIR (re-read on every call, no reload needed)."""
    monkeypatch.setenv("THIMBLE_PROMPTS_DIR", str(tmp_path))
    return tmp_path


def write(pdir, rel, text):
    p = pdir / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


# ----------------------------------------------------------------------------- the repository's own prompts


def test_real_prompts_render_clean(monkeypatch):
    """Every prompt renders with its own slots and no {{...}} survives — nothing half-filled can reach a model."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for name in (*prompts.PROMPT_NAMES, *prompts.TYPE_FILES.values(), *prompts.DEV_FILES):
        values = {s: f"<{s}>" for s in prompts.slots(name)}
        out = prompts.render(name, values)
        assert "{{" not in out and "}}" not in out, name
        prose = "\n".join(ln for ln in out.splitlines() if not ln.startswith("    "))  # an example may show it as a fault
        assert "load-bearing" not in prose.replace('"load-bearing"', ""), name  # quoted, it is shared.md's example of a flourish
