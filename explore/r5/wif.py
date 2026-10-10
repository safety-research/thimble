"""Workload identity sign-in for the scratch sessions of views round 5, as orient-budget's scripts/dev/budget_batch.py
signs them in (its functions, copied, so the runner needs no other worktree).

The IDs are read in code from ~/.anthropic/wif-<org>.env and set only in a child's environment (wif_env); the Google ID
token is written to a file under the Claude Code config folder, mode 600, and kept fresh by a thread (keep_token_fresh).
Nothing here prints or logs an ID or a token. ANTHROPIC_API_KEY is never set or read."""
from __future__ import annotations

import argparse
import os
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TRUST_YES = re.compile(r"Yes, (I trust this folder|proceed)")
WIF_REFRESH_S = 20 * 60  # a Google ID token lasts an hour
WIF_AUDIENCE = "https://api.anthropic.com"
METADATA_ID_TOKEN = ("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
                     f"?audience={WIF_AUDIENCE}&format=full")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def wif_folder(opts: argparse.Namespace) -> Path:
    return Path(opts.claude_config_dir).expanduser().resolve() / "wif"


def wif_env(opts: argparse.Namespace) -> dict[str, str]:
    """Claude Code's workload identity federation variables for org opts.wif, for a child's environment only: the IDs
    from ~/.anthropic/wif-<org>.env (the GCP rule) and the token file refresh_token keeps fresh."""
    ids: dict[str, str] = {}
    with open(Path.home() / ".anthropic" / f"wif-{opts.wif}.env", encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                ids[k] = v
    folder = wif_folder(opts)
    return {"ANTHROPIC_FEDERATION_RULE_ID": ids["ANTHROPIC_FEDERATION_RULE_ID_GCP"],
            "ANTHROPIC_ORGANIZATION_ID": ids["ANTHROPIC_ORGANIZATION_ID"],
            "ANTHROPIC_SERVICE_ACCOUNT_ID": ids["ANTHROPIC_SERVICE_ACCOUNT_ID"],
            "ANTHROPIC_WORKSPACE_ID": ids["ANTHROPIC_WORKSPACE_ID"],
            "ANTHROPIC_IDENTITY_TOKEN_FILE": str(folder / "identity-token"),
            "CLAUDE_CODE_FEDERATION_CACHE_DIR": str(folder / "cache")}


def refresh_token(opts: argparse.Namespace) -> None:
    """Write a fresh Google ID token for WIF_AUDIENCE, from this VM's metadata server, to the token file (mode 600,
    replaced whole so a reader never sees half of one)."""
    req = urllib.request.Request(METADATA_ID_TOKEN, headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(req, timeout=30) as r:
        token = r.read().decode().strip()
    if not token:
        raise RuntimeError("the metadata server gave an empty identity token")
    folder = wif_folder(opts)
    (folder / "cache").mkdir(parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    tmp = folder / "identity-token.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token)
    os.replace(tmp, folder / "identity-token")


def keep_token_fresh(opts: argparse.Namespace) -> None:
    """A thread: refresh_token every WIF_REFRESH_S while the run lasts (a failure is retried in a minute)."""
    while True:
        try:
            refresh_token(opts)
            time.sleep(WIF_REFRESH_S)
        except Exception as e:  # noqa: BLE001 — the old token lasts the hour, so try again soon
            print(f"{now()} identity token refresh failed: {type(e).__name__}", flush=True)
            time.sleep(60)


def project_dirs(config_dir: Path, folder: Path) -> list[Path]:
    """Claude Code's transcript folders for sessions in `folder` (its path with every character other than a letter or
    a digit as `-`)."""
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(folder.resolve()))
    root = config_dir / "projects"
    return sorted(p for p in root.glob(f"{slug}*") if p.is_dir()) if root.is_dir() else []
