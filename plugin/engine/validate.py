"""The marks' check after the checker fork answered, as the plugin's hooks run it (marks/checker.ts): JSON on stdin,
JSON on stdout. No model call, and no code run: kernel/evidence.py reads the files and the calls' real outputs.

    stdin   {"cwd": the working folder, "root": the folder the session started in, which the paths shown start from,
             "tmp": the session's temp folder, where Claude keeps its own code,
             "marks": [{"n", "words", "sentence"}], "answer": the checker's last message,
             "calls": [{"command", "output", "by": "checker" | "main"}],
             "cards": the session's cards' outputs (kernel/evidence.py check_card), or "cards_dir": the terminal's
             cards folder (cards/store.ts), read with terminal_cards}
    stdout  {"parsed": bool, "results": [{"n", "status", "shown", "reason", "was"?, "failedBy"?, "evidence"?, "note"?}]}

With "index": a path instead, it writes the cards' places and values there for the checker to grep (card_index), and
answers {"cards": the number of cards}.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kernel.evidence import card_index, check_all, terminal_cards  # noqa: E402


def main() -> int:
    req = json.load(sys.stdin)
    cards = req.get("cards") if isinstance(req.get("cards"), list) else terminal_cards(req.get("cards_dir"))
    if req.get("index"):
        Path(str(req["index"])).write_text(card_index(cards), encoding="utf-8")
        json.dump({"cards": len(cards)}, sys.stdout)
        return 0
    out = check_all(req.get("marks") or [], str(req.get("answer") or ""), req.get("calls") or [], str(req.get("cwd") or "."), req.get("root") or None, req.get("tmp") or None, cards)
    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
