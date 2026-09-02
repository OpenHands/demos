#!/usr/bin/env python3
"""Original-style Vibe Kanban manager automation."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import vibestore  # noqa: E402

CONFIG_PATH = Path(__file__).with_name("config.json")
CONFIG = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
if CONFIG.get("store_dir"):
    os.environ.setdefault("VIBE_KANBAN_STORE_DIR", CONFIG["store_dir"])
if CONFIG.get("working_dir"):
    os.environ.setdefault("VIBE_KANBAN_WORKING_DIR", CONFIG["working_dir"])

WORKSPACE_ID = "default"
WORKSPACE_PATH = CONFIG.get("working_dir") or os.environ.get("VIBE_KANBAN_WORKING_DIR") or "workspace/project"
CANVAS_BASE = (CONFIG.get("canvas_base") or "").rstrip("/")
VIBECTL = vibestore.install_cli()
MANAGER_STALE_SECONDS = 45 * 60
RETRY_INTERVAL_SECONDS = 10 * 60
MAX_RETRY_ATTEMPTS = 3
TERMINAL_CONV_STATUSES = {"finished", "idle", "error", "stuck", "deleted", "paused"}
MANAGER_FAILED_STATUSES = {"error", "stuck"}


def state_path() -> Path:
    return vibestore.store_root() / "manager-state.json"


def load_state() -> dict:
    try:
        return json.loads(state_path().read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False))
    tmp.replace(path)


def fire_callback(status: str = "COMPLETED", error: str | None = None) -> None:
    url = os.environ.get("AUTOMATION_CALLBACK_URL", "")
    if not url:
        return
    body = {"status": status, "run_id": os.environ.get("AUTOMATION_RUN_ID", "")}
    if error:
        body["error"] = error
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ.get('AUTOMATION_CALLBACK_API_KEY', '')}",
        },
    )
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as exc:  # noqa: BLE001
        print(f"callback error (non-fatal): {exc}")


def conversation_status(conversation_id: str | None) -> str | None:
    if not conversation_id:
        return None
    try:
        return vibestore.conversation_info(conversation_id).get("execution_status") or "unknown"
    except urllib.error.HTTPError as exc:
        return "deleted" if exc.code == 404 else f"error_{exc.code}"
    except Exception:
        return "unknown"


def snapshot() -> dict:
    return vibestore.snapshot(WORKSPACE_ID)


def enrich(board: dict) -> tuple[dict, list[dict]]:
    tickets = []
    for ticket in board["tickets"]:
        ticket["conv_status"] = conversation_status(ticket.get("conversation_id"))
        tickets.append(ticket)
    return board["workspace"], tickets


def has_undispatched_entries(ticket: dict) -> bool:
    dispatched = int(ticket.get("dispatched_entry_count") or 0)
    return any(entry.get("author") != "manager" for entry in ticket.get("entries", [])[dispatched:])


def apply_mechanical_transitions(tickets: list[dict]) -> None:
    for ticket in tickets:
        conv_status = ticket.get("conv_status")
        if ticket.get("status") != "in_progress" and ticket.get("conversation_id") and conv_status == "running":
            vibestore.patch_ticket(ticket["id"], status="in_progress", manager_note="")
            ticket["status"] = "in_progress"
            ticket["manager_note"] = ""
        if ticket.get("status") == "in_progress" and conv_status in {"error", "stuck", "deleted"}:
            vibestore.patch_ticket(
                ticket["id"],
                status="needs_input",
                append_entry=f"Worker conversation is {conv_status}; manager review is needed.",
            )
            ticket["status"] = "needs_input"


def fingerprint(ws: dict, tickets: list[dict]) -> str:
    relevant = {
        "workspace": {
            "max_concurrent": ws.get("max_concurrent"),
            "manager_conversation_id": ws.get("manager_conversation_id"),
        },
        "tickets": [
            {
                "id": t.get("id"),
                "status": t.get("status"),
                "title": t.get("title"),
                "conversation_id": t.get("conversation_id"),
                "conv_status": t.get("conv_status"),
                "manager_note": t.get("manager_note"),
                "dispatched_entry_count": t.get("dispatched_entry_count"),
                "entries": t.get("entries"),
            }
            for t in tickets
        ],
    }
    return hashlib.sha256(json.dumps(relevant, sort_keys=True).encode()).hexdigest()


def compute_signals(ws: dict, tickets: list[dict]) -> tuple[list[str], list[str]]:
    signals: list[str] = []
    retry_safe: list[str] = []
    running = sum(1 for t in tickets if t.get("conversation_id") and t.get("conv_status") == "running")
    for ticket in tickets:
        if has_undispatched_entries(ticket):
            sig = f"new-entries:{ticket['id']}"
            signals.append(sig)
            if ticket.get("conversation_id"):
                retry_safe.append(sig)
        if (
            ticket.get("status") == "pending"
            and not ticket.get("conversation_id")
            and not ticket.get("manager_note")
            and running < int(ws.get("max_concurrent") or 3)
        ):
            sig = f"dispatchable:{ticket['id']}"
            signals.append(sig)
            retry_safe.append(sig)
        if (
            ticket.get("status") == "in_progress"
            and ticket.get("conversation_id")
            and (ticket.get("conv_status") or "") in TERMINAL_CONV_STATUSES
        ):
            sig = f"worker-done:{ticket['id']}"
            signals.append(sig)
            retry_safe.append(sig)
        if ticket.get("status") != "in_progress" and ticket.get("conversation_id") and ticket.get("conv_status") == "running":
            sig = f"agent-resumed:{ticket['id']}"
            signals.append(sig)
            retry_safe.append(sig)
    return signals, retry_safe


def manager_conversation_state(state: dict, ws: dict) -> dict:
    conv_id = state.get("manager_conversation_id") or ws.get("manager_conversation_id")
    if not conv_id:
        return {"id": None, "status": None, "started_at": 0, "active": False, "failed": False}
    status = conversation_status(conv_id)
    started_at = float(state.get("manager_started_at") or 0)
    return {
        "id": conv_id,
        "status": status,
        "started_at": started_at,
        "active": status == "running",
        "failed": status in MANAGER_FAILED_STATUSES,
    }


def kickoff_decision(state: dict, changed: bool, signals: list[str], retry_safe: list[str], manager_failed: bool = False) -> tuple[bool, int]:
    retry_count = 0 if changed else int(state.get("retry_count") or 0)
    waited = time.time() - float(state.get("manager_started_at") or 0)
    stale_retry = bool(retry_safe) and retry_count < MAX_RETRY_ATTEMPTS and (manager_failed or waited > RETRY_INTERVAL_SECONDS)
    return bool(signals and changed) or stale_retry, retry_count


def conv_statuses(tickets: list[dict]) -> dict[str, str]:
    return {t["conversation_id"]: t.get("conv_status") or "unknown" for t in tickets if t.get("conversation_id")}


def build_manager_prompt(ws: dict, tickets: list[dict], signals: list[str]) -> str:
    board_json = json.dumps([
        {
            "id": t["id"],
            "status": t.get("status"),
            "title": t.get("title"),
            "priority_rank": t.get("sort_order"),
            "conversation_id": t.get("conversation_id"),
            "conversation_status": t.get("conv_status"),
            "manager_note": t.get("manager_note"),
            "dispatched_entry_count": t.get("dispatched_entry_count", 0),
            "entries": [
                {"index": i, "author": e.get("author"), "body": e.get("body"), "created_at": e.get("created_at")}
                for i, e in enumerate(t.get("entries", []))
            ],
        }
        for t in tickets
    ], indent=2, ensure_ascii=False)
    return f"""You are the Vibe Kanban Manager for the project at `{WORKSPACE_PATH}`.
You manage a kanban queue and worker agent conversations. You do NOT do the task work yourself; you coordinate workers and update the board.

## Current board
```json
{board_json}
```

## Signals this run
{json.dumps(signals, indent=2)}

## Board control
Run `{VIBECTL}` from the terminal. Every command prints JSON.

- Re-read board: `{VIBECTL} snapshot`
- Update ticket: `{VIBECTL} patch <ticket_id> [--status pending|in_progress|needs_input|finished] [--title "..."] [--conversation-id <id>] [--manager-note "..."] [--dispatched-entry-count <n>] [--append-entry "..."]`
- Start worker: `{VIBECTL} dispatch --ticket <ticket_id> --prompt-file <file> --title "🎫 <short summary>"`
- Follow up existing worker: `{VIBECTL} followup <conversation_id> --ticket <ticket_id> --prompt-file <file>`
- Inspect conversation: `{VIBECTL} conversation <conversation_id> --final-response`

## Your job this run
1. For each pending ticket with no conversation: decide whether it can be completed by board bookkeeping alone. If yes, patch it `--status finished` with `--append-entry` explaining the completion. Otherwise write a concise worker prompt to a temp file, dispatch a worker, then immediately patch the ticket with `--conversation-id <id> --status in_progress --title "<short title>" --dispatched-entry-count <entry_count>`.
2. For tickets with new user entries beyond `dispatched_entry_count` and an existing conversation: write only the new instructions to a temp file, run `followup`, then patch `--status in_progress --dispatched-entry-count <entry_count>` and clear any stale manager note.
3. For in_progress tickets whose conversation_status is finished/idle/paused: inspect the conversation final response. If the task appears done, patch `--status finished` with a short append-entry. If it needs the user, patch `--status needs_input` with a short append-entry.
4. If a worker is running but the card is not in_progress, patch it back to in_progress.
5. If you deliberately defer a pending ticket, set a concise `--manager-note`; that suppresses repeated manager summons.

Important: finished/idle conversations are still eligible for follow-up when a later ticket entry is related. Do not reopen older finished cards unless there is a new user entry on that same ticket.
"""


def start_manager_conversation(prompt: str) -> str:
    result = vibestore.start_conversation(
        WORKSPACE_PATH,
        prompt,
        title=f"🧠 Vibe Kanban Manager {time.strftime('%m-%d %H:%M')}",
        role="manager",
        max_iterations=200,
    )
    return result["id"]


def main() -> None:
    state = load_state()
    board = snapshot()
    mgr = manager_conversation_state(state, board["workspace"])
    if mgr["active"]:
        if time.time() - mgr["started_at"] < MANAGER_STALE_SECONDS:
            print(f"manager conversation {mgr['id']} still running — skipping")
            fire_callback()
            return
        print(f"manager conversation {mgr['id']} exceeded stale limit — proceeding")
    elif state.get("manager_conversation_id"):
        state["last_manager_finished_at"] = time.time()
    state["manager_conversation_id"] = None

    ws, tickets = enrich(board)
    apply_mechanical_transitions(tickets)
    board = snapshot()
    ws, tickets = enrich(board)
    fp = fingerprint(ws, tickets)
    signals, retry_safe = compute_signals(ws, tickets)
    state["conv_statuses"] = conv_statuses(tickets)
    changed = fp != state.get("fingerprint")
    kick, retry_count = kickoff_decision(state, changed, signals, retry_safe, manager_failed=mgr["failed"])
    print(f"fingerprint changed: {changed}; signals: {signals or 'none'}; last manager: {mgr['status'] or 'none'}; kick: {kick}")

    if kick:
        conv_id = start_manager_conversation(build_manager_prompt(ws, tickets, signals))
        link = f"{CANVAS_BASE}/conversations/{conv_id}" if CANVAS_BASE else f"/conversations/{conv_id}"
        print(f"manager kicked off: {link}")
        state.update({
            "manager_conversation_id": conv_id,
            "manager_started_at": time.time(),
            "fingerprint": fp,
            "retry_count": retry_count + (0 if changed else 1),
        })
    else:
        state["fingerprint"] = fp
        state["retry_count"] = retry_count
    state["last_checked_at"] = time.time()
    idx = vibestore.read_index()
    idx["last_run_at"] = time.time()
    idx["last_error"] = None
    vibestore.write_index(idx)
    save_state(state)
    fire_callback()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        idx = vibestore.read_index()
        idx["last_run_at"] = time.time()
        idx["last_error"] = str(exc)
        vibestore.write_index(idx)
        fire_callback("FAILED", str(exc))
        raise
