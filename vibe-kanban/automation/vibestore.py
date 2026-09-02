"""File-backed Vibe Kanban store and Agent Server helpers."""

from __future__ import annotations

import json
import os
import shutil
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

STATUSES = ("pending", "in_progress", "needs_input", "finished")
STORE_SUBPATH = ".openhands/vibe-kanban"
DEFAULT_WORKSPACE_ID = "default"
DEFAULT_MAX_CONCURRENT = 3


def now() -> float:
    return time.time()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def store_root() -> Path:
    override = os.environ.get("VIBE_KANBAN_STORE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / STORE_SUBPATH


def index_path() -> Path:
    return store_root() / "index.json"


def tickets_dir() -> Path:
    return store_root() / "tickets"


def ticket_path(ticket_id: str) -> Path:
    return tickets_dir() / f"{ticket_id}.json"


def default_index() -> dict:
    return {
        "version": 2,
        "workspace": {
            "id": DEFAULT_WORKSPACE_ID,
            "path": os.environ.get("VIBE_KANBAN_WORKING_DIR", "workspace/project"),
            "name": "Vibe Kanban",
            "max_concurrent": DEFAULT_MAX_CONCURRENT,
            "push_mode": "none",
            "manager_conversation_id": None,
        },
        "ticket_ids": [],
        "automation_id": None,
        "last_run_at": None,
        "last_error": None,
    }


def read_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"corrupt JSON at {path}: {exc}") from exc


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    tmp.replace(path)


def read_index() -> dict:
    idx = read_json(index_path(), default_index()) or default_index()
    base = default_index()
    base.update(idx)
    workspace = default_index()["workspace"]
    workspace.update(base.get("workspace") or {})
    base["workspace"] = workspace
    base["ticket_ids"] = list(dict.fromkeys(base.get("ticket_ids") or base.get("task_ids") or []))
    return base


def write_index(index: dict) -> dict:
    index["version"] = 2
    index["updated_at"] = now()
    index["rev"] = (index.get("rev") or 0) + 1
    index["writer"] = f"vibestore-{new_id()}"
    write_json(index_path(), index)
    return index


def update_workspace(**patch) -> dict:
    idx = read_index()
    idx.setdefault("workspace", {}).update(patch)
    write_index(idx)
    return idx["workspace"]


def read_ticket(ticket_id: str) -> dict | None:
    return read_json(ticket_path(ticket_id), None)


def write_ticket(ticket: dict) -> dict:
    ticket["updated_at"] = now()
    ticket["rev"] = (ticket.get("rev") or 0) + 1
    ticket["writer"] = f"vibestore-{new_id()}"
    write_json(ticket_path(ticket["id"]), ticket)
    return ticket


def migrate_ticket(ticket: dict) -> dict:
    status_map = {"submitted": "pending", "queued": "pending", "done": "finished", "failed": "needs_input"}
    ticket["status"] = status_map.get(ticket.get("status"), ticket.get("status") or "pending")
    if "entries" not in ticket:
        body = ticket.get("body") or ticket.get("title") or ""
        created = ticket.get("created_at") or now()
        ticket["entries"] = [{"id": new_id(), "author": "user", "body": body, "created_at": created}]
    ticket.setdefault("title", ticket.get("title") or None)
    ticket.setdefault("sort_order", ticket.get("created_at") or now())
    ticket.setdefault("conversation_id", ticket.get("routed_conversation_id"))
    ticket.setdefault("manager_note", ticket.get("error") or ticket.get("manager_reason"))
    ticket.setdefault("dispatched_entry_count", 0)
    ticket.setdefault("created_at", now())
    ticket.setdefault("updated_at", ticket["created_at"])
    return ticket


def list_tickets() -> list[dict]:
    idx = read_index()
    ids = list(idx.get("ticket_ids") or [])
    if not ids and tickets_dir().is_dir():
        ids = [p.stem for p in sorted(tickets_dir().glob("*.json"))]
        idx["ticket_ids"] = ids
        write_index(idx)
    tickets = []
    for ticket_id in ids:
        ticket = read_ticket(ticket_id)
        if ticket:
            tickets.append(migrate_ticket(ticket))
    tickets.sort(key=lambda t: (t.get("sort_order") or 0, t.get("created_at") or 0))
    return tickets


def snapshot(workspace_id: str = DEFAULT_WORKSPACE_ID) -> dict:
    idx = read_index()
    return {"workspace": idx.get("workspace") or default_index()["workspace"], "tickets": list_tickets()}


def patch_ticket(ticket_id: str, **patch) -> dict:
    ticket = read_ticket(ticket_id)
    if not ticket:
        raise KeyError(f"ticket {ticket_id} not found")
    ticket = migrate_ticket(ticket)
    stamp = now()
    if patch.get("status") is not None:
        status = patch["status"]
        if status not in STATUSES:
            raise ValueError(f"bad status {status!r}; expected one of {list(STATUSES)}")
        if status == "finished" and ticket.get("status") != "finished":
            ticket["finished_at"] = stamp
        ticket["status"] = status
    for key in ("title", "conversation_id", "manager_note"):
        if key in patch and patch[key] is not None:
            ticket[key] = patch[key].strip() if isinstance(patch[key], str) else patch[key]
            if key == "title" and not ticket[key]:
                ticket[key] = None
    if patch.get("dispatched_entry_count") is not None:
        ticket["dispatched_entry_count"] = int(patch["dispatched_entry_count"])
    if patch.get("append_entry"):
        ticket.setdefault("entries", []).append({
            "id": new_id(), "author": "manager", "body": patch["append_entry"].strip(), "created_at": stamp,
        })
        authors = [e.get("author") for e in ticket["entries"]]
        advanced = int(ticket.get("dispatched_entry_count") or 0)
        while advanced < len(authors) and authors[advanced] == "manager":
            advanced += 1
        ticket["dispatched_entry_count"] = advanced
    return write_ticket(ticket)


def agent_server_url() -> str:
    return os.environ.get("AGENT_SERVER_URL", "http://127.0.0.1:18000").rstrip("/")


def session_key() -> str:
    key = os.environ.get("SESSION_API_KEY") or os.environ.get("OH_SESSION_API_KEYS_0")
    if not key:
        raise RuntimeError("no agent-server session key available")
    return key


def agent_request(path: str, method: str = "GET", data: dict | None = None, extra_headers: dict | None = None, timeout: int = 60):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(
        f"{agent_server_url()}{path}", data=body, method=method,
        headers={"Content-Type": "application/json", "X-Session-API-Key": session_key(), **(extra_headers or {})},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw else None


def agent_settings_payload() -> dict:
    settings = agent_request("/api/settings", extra_headers={"X-Expose-Secrets": "encrypted"}, timeout=30)
    agent_settings = dict(settings.get("agent_settings") or {})
    agent_settings.pop("schema_version", None)
    agent_settings.pop("mcp_config", None)
    tools = agent_settings.get("tools") if isinstance(agent_settings.get("tools"), list) else []
    names = {tool.get("name") for tool in tools if isinstance(tool, dict)}
    for name in ["terminal", "file_editor", "task_tracker", "browser_tool_set"]:
        if name not in names:
            tools.append({"name": name, "params": {}})
    agent_settings["tools"] = tools
    context = dict(agent_settings.get("agent_context") or {})
    context.update({"load_public_skills": True, "load_user_skills": True, "load_project_skills": True})
    agent_settings["agent_context"] = context
    return agent_settings


def start_conversation(working_dir: str, prompt: str, *, title: str | None = None, conversation_id: str | None = None, role: str = "worker", max_iterations: int = 500) -> dict:
    if conversation_id:
        agent_request(
            f"/api/conversations/{conversation_id}/events", "POST",
            {"role": "user", "content": [{"type": "text", "text": prompt}], "run": True}, timeout=30,
        )
        return {"id": conversation_id, "followup": True, "conversation_url": f"/conversations/{conversation_id}"}
    body = {
        "workspace": {"kind": "LocalWorkspace", "working_dir": working_dir},
        "worktree": False,
        "agent_settings": agent_settings_payload(),
        "secrets_encrypted": True,
        "initial_message": {"role": "user", "content": [{"type": "text", "text": prompt}], "run": True},
        "max_iterations": max_iterations,
        "autotitle": not title,
        "tags": {"workspace": working_dir, "viberole": role},
    }
    created = agent_request("/api/conversations", "POST", body, timeout=120)
    conv_id = created.get("id") or created.get("app_conversation_id")
    if not conv_id:
        raise RuntimeError(f"conversation create returned no id: {created}")
    if title:
        try:
            agent_request(f"/api/conversations/{conv_id}", "PATCH", {"title": title}, timeout=30)
        except Exception:
            pass
    if role == "manager":
        update_workspace(manager_conversation_id=conv_id)
    return {"id": conv_id, "followup": False, "conversation_url": f"/conversations/{conv_id}"}


def conversation_info(conversation_id: str, final_response: bool = False) -> dict:
    conv = agent_request(f"/api/conversations/{conversation_id}?include_skills=false", timeout=30)
    out = {
        "id": conv.get("id"),
        "execution_status": conv.get("execution_status"),
        "title": conv.get("title"),
        "model": ((conv.get("agent") or {}).get("llm") or {}).get("model"),
    }
    if final_response:
        try:
            out["final_response"] = agent_request(f"/api/conversations/{conversation_id}/agent_final_response", timeout=30)
        except Exception as exc:
            out["final_response_error"] = str(exc)
    return out


def llm_profiles() -> dict:
    try:
        return agent_request("/api/profiles", timeout=15) or {"profiles": [], "active_profile": None}
    except Exception:
        return {"profiles": [], "active_profile": None}


def install_cli() -> str:
    src = Path(__file__).parent
    bin_dir = store_root() / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name in ("vibestore.py", "vibectl.py"):
        shutil.copy2(src / name, bin_dir / name)
    (bin_dir / "vibectl.py").chmod(0o755)
    (bin_dir / "config.json").write_text(json.dumps({
        "workspace_id": DEFAULT_WORKSPACE_ID,
        "workspace_path": read_index()["workspace"]["path"],
        "store_dir": str(store_root()),
    }, indent=2))
    return str(bin_dir / "vibectl.py")
