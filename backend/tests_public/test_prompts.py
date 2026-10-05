"""prompts.py and the repository's own prompt files: every one loads and renders with its own slots and no `{{` left."""

from app import prompts


def test_real_prompts_render_clean(monkeypatch):
    """Every prompt renders with its own slots and no {{...}} survives — nothing half-filled can reach a model."""
    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for name in (*prompts.PROMPT_NAMES, *prompts.TYPE_FILES.values(), *prompts.DEV_FILES):
        values = {s: f"<{s}>" for s in prompts.slots(name)}
        out = prompts.render(name, values)
        assert "{{" not in out and "}}" not in out, name


def test_main_renders_with_either_ending(tmp_path, monkeypatch):
    """Main's prompt renders with the ending of each mode (terminal_tools.ENDINGS), each found on exactly one line."""
    from app import events, terminal_tools

    monkeypatch.delenv("THIMBLE_PROMPTS_DIR", raising=False)
    for terminal in (True, False):
        out = events.render_prompts(["main"], str(tmp_path), terminal=terminal)
        assert terminal_tools.ENDINGS[terminal] in out and terminal_tools.ENDINGS[not terminal] not in out
