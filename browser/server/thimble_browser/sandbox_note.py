"""The line the server prints at its start about where card code runs."""
from .cards import sandbox


def line(unsandboxed: bool) -> str:
    st = sandbox.status()
    if st.kind:
        return f"  card code runs in a sandbox ({st.kind}): it reads the folder, with no network"
    if unsandboxed:
        return f"  ! no sandbox ({st.why}): card code runs with your access (--no-sandbox)"
    return (f"  ! no sandbox ({st.why}), so cards with code will not run. {st.fix}\n"
            "    thimble-browser --check-sandbox tests the sandbox.")
