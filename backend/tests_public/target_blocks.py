"""A stand-in for the core lane's build-target flags (prompts.TARGETS) where prompts.py does not have them yet: the view
prompts' `{{if:term-page}}` and `{{if:html-page}}` blocks read as 0.8.0's `{{if:terminal}}` and `{{if:browser}}`, the
modes that views.target_flags names there. With the core lane's prompts.py the fixture does nothing. Test modules that
render the view prompts use it as `from target_blocks import target_blocks  # noqa: F401`."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def target_blocks(monkeypatch):
    from app import prompts

    if hasattr(prompts, "TARGETS"):
        return
    real = prompts._modes_out

    def modes_out(text, rel, mode):
        return real(text.replace("{{if:term-page}}", "{{if:terminal}}").replace("{{if:html-page}}", "{{if:browser}}"),
                    rel, mode)

    monkeypatch.setattr(prompts, "_modes_out", modes_out)
