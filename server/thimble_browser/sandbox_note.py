"""The one line the server prints about where card code runs."""
from .cards import sandbox


def line(unsandboxed: bool) -> str:
    kind = sandbox.available()
    if kind:
        return f"  card code runs in a sandbox ({kind}): it reads the folder, with no network"
    if unsandboxed:
        return "  ! no sandbox found: card code runs with your access (--no-sandbox)"
    return "  ! no sandbox found: cards with code will not run (install bubblewrap, or start with --no-sandbox)"
