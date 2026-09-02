const AUTOMATION_FILES = {"main.py":"#!/usr/bin/env python3\n\"\"\"Original-style Vibe Kanban manager automation.\"\"\"\n\nfrom __future__ import annotations\n\nimport hashlib\nimport json\nimport os\nimport sys\nimport time\nimport traceback\nimport urllib.error\nimport urllib.request\nfrom pathlib import Path\n\nsys.path.insert(0, str(Path(__file__).parent))\nimport vibestore  # noqa: E402\n\nCONFIG_PATH = Path(__file__).with_name(\"config.json\")\nCONFIG = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}\nif CONFIG.get(\"store_dir\"):\n    os.environ.setdefault(\"VIBE_KANBAN_STORE_DIR\", CONFIG[\"store_dir\"])\nif CONFIG.get(\"working_dir\"):\n    os.environ.setdefault(\"VIBE_KANBAN_WORKING_DIR\", CONFIG[\"working_dir\"])\n\nWORKSPACE_ID = \"default\"\nWORKSPACE_PATH = CONFIG.get(\"working_dir\") or os.environ.get(\"VIBE_KANBAN_WORKING_DIR\") or \"workspace/project\"\nCANVAS_BASE = (CONFIG.get(\"canvas_base\") or \"\").rstrip(\"/\")\nVIBECTL = vibestore.install_cli()\nMANAGER_STALE_SECONDS = 45 * 60\nRETRY_INTERVAL_SECONDS = 10 * 60\nMAX_RETRY_ATTEMPTS = 3\nTERMINAL_CONV_STATUSES = {\"finished\", \"idle\", \"error\", \"stuck\", \"deleted\", \"paused\"}\nMANAGER_FAILED_STATUSES = {\"error\", \"stuck\"}\n\n\ndef state_path() -> Path:\n    return vibestore.store_root() / \"manager-state.json\"\n\n\ndef load_state() -> dict:\n    try:\n        return json.loads(state_path().read_text())\n    except (FileNotFoundError, json.JSONDecodeError):\n        return {}\n\n\ndef save_state(state: dict) -> None:\n    path = state_path()\n    path.parent.mkdir(parents=True, exist_ok=True)\n    tmp = path.with_suffix(f\".{os.getpid()}.tmp\")\n    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False))\n    tmp.replace(path)\n\n\ndef fire_callback(status: str = \"COMPLETED\", error: str | None = None) -> None:\n    url = os.environ.get(\"AUTOMATION_CALLBACK_URL\", \"\")\n    if not url:\n        return\n    body = {\"status\": status, \"run_id\": os.environ.get(\"AUTOMATION_RUN_ID\", \"\")}\n    if error:\n        body[\"error\"] = error\n    req = urllib.request.Request(\n        url,\n        data=json.dumps(body).encode(),\n        method=\"POST\",\n        headers={\n            \"Content-Type\": \"application/json\",\n            \"Authorization\": f\"Bearer {os.environ.get('AUTOMATION_CALLBACK_API_KEY', '')}\",\n        },\n    )\n    try:\n        urllib.request.urlopen(req, timeout=15).read()\n    except Exception as exc:  # noqa: BLE001\n        print(f\"callback error (non-fatal): {exc}\")\n\n\ndef conversation_status(conversation_id: str | None) -> str | None:\n    if not conversation_id:\n        return None\n    try:\n        return vibestore.conversation_info(conversation_id).get(\"execution_status\") or \"unknown\"\n    except urllib.error.HTTPError as exc:\n        return \"deleted\" if exc.code == 404 else f\"error_{exc.code}\"\n    except Exception:\n        return \"unknown\"\n\n\ndef snapshot() -> dict:\n    return vibestore.snapshot(WORKSPACE_ID)\n\n\ndef enrich(board: dict) -> tuple[dict, list[dict]]:\n    tickets = []\n    for ticket in board[\"tickets\"]:\n        ticket[\"conv_status\"] = conversation_status(ticket.get(\"conversation_id\"))\n        tickets.append(ticket)\n    return board[\"workspace\"], tickets\n\n\ndef has_undispatched_entries(ticket: dict) -> bool:\n    dispatched = int(ticket.get(\"dispatched_entry_count\") or 0)\n    return any(entry.get(\"author\") != \"manager\" for entry in ticket.get(\"entries\", [])[dispatched:])\n\n\ndef apply_mechanical_transitions(tickets: list[dict]) -> None:\n    for ticket in tickets:\n        conv_status = ticket.get(\"conv_status\")\n        if ticket.get(\"status\") != \"in_progress\" and ticket.get(\"conversation_id\") and conv_status == \"running\":\n            vibestore.patch_ticket(ticket[\"id\"], status=\"in_progress\", manager_note=\"\")\n            ticket[\"status\"] = \"in_progress\"\n            ticket[\"manager_note\"] = \"\"\n        if ticket.get(\"status\") == \"in_progress\" and conv_status in {\"error\", \"stuck\", \"deleted\"}:\n            vibestore.patch_ticket(\n                ticket[\"id\"],\n                status=\"needs_input\",\n                append_entry=f\"Worker conversation is {conv_status}; manager review is needed.\",\n            )\n            ticket[\"status\"] = \"needs_input\"\n\n\ndef fingerprint(ws: dict, tickets: list[dict]) -> str:\n    relevant = {\n        \"workspace\": {\n            \"max_concurrent\": ws.get(\"max_concurrent\"),\n            \"manager_conversation_id\": ws.get(\"manager_conversation_id\"),\n        },\n        \"tickets\": [\n            {\n                \"id\": t.get(\"id\"),\n                \"status\": t.get(\"status\"),\n                \"title\": t.get(\"title\"),\n                \"conversation_id\": t.get(\"conversation_id\"),\n                \"conv_status\": t.get(\"conv_status\"),\n                \"manager_note\": t.get(\"manager_note\"),\n                \"dispatched_entry_count\": t.get(\"dispatched_entry_count\"),\n                \"entries\": t.get(\"entries\"),\n            }\n            for t in tickets\n        ],\n    }\n    return hashlib.sha256(json.dumps(relevant, sort_keys=True).encode()).hexdigest()\n\n\ndef compute_signals(ws: dict, tickets: list[dict]) -> tuple[list[str], list[str]]:\n    signals: list[str] = []\n    retry_safe: list[str] = []\n    running = sum(1 for t in tickets if t.get(\"conversation_id\") and t.get(\"conv_status\") == \"running\")\n    for ticket in tickets:\n        if has_undispatched_entries(ticket):\n            sig = f\"new-entries:{ticket['id']}\"\n            signals.append(sig)\n            if ticket.get(\"conversation_id\"):\n                retry_safe.append(sig)\n        if (\n            ticket.get(\"status\") == \"pending\"\n            and not ticket.get(\"conversation_id\")\n            and not ticket.get(\"manager_note\")\n            and running < int(ws.get(\"max_concurrent\") or 3)\n        ):\n            sig = f\"dispatchable:{ticket['id']}\"\n            signals.append(sig)\n            retry_safe.append(sig)\n        if (\n            ticket.get(\"status\") == \"in_progress\"\n            and ticket.get(\"conversation_id\")\n            and (ticket.get(\"conv_status\") or \"\") in TERMINAL_CONV_STATUSES\n        ):\n            sig = f\"worker-done:{ticket['id']}\"\n            signals.append(sig)\n            retry_safe.append(sig)\n        if ticket.get(\"status\") != \"in_progress\" and ticket.get(\"conversation_id\") and ticket.get(\"conv_status\") == \"running\":\n            sig = f\"agent-resumed:{ticket['id']}\"\n            signals.append(sig)\n            retry_safe.append(sig)\n    return signals, retry_safe\n\n\ndef manager_conversation_state(state: dict, ws: dict) -> dict:\n    conv_id = state.get(\"manager_conversation_id\") or ws.get(\"manager_conversation_id\")\n    if not conv_id:\n        return {\"id\": None, \"status\": None, \"started_at\": 0, \"active\": False, \"failed\": False}\n    status = conversation_status(conv_id)\n    started_at = float(state.get(\"manager_started_at\") or 0)\n    return {\n        \"id\": conv_id,\n        \"status\": status,\n        \"started_at\": started_at,\n        \"active\": status == \"running\",\n        \"failed\": status in MANAGER_FAILED_STATUSES,\n    }\n\n\ndef kickoff_decision(state: dict, changed: bool, signals: list[str], retry_safe: list[str], manager_failed: bool = False) -> tuple[bool, int]:\n    retry_count = 0 if changed else int(state.get(\"retry_count\") or 0)\n    waited = time.time() - float(state.get(\"manager_started_at\") or 0)\n    stale_retry = bool(retry_safe) and retry_count < MAX_RETRY_ATTEMPTS and (manager_failed or waited > RETRY_INTERVAL_SECONDS)\n    return bool(signals and changed) or stale_retry, retry_count\n\n\ndef conv_statuses(tickets: list[dict]) -> dict[str, str]:\n    return {t[\"conversation_id\"]: t.get(\"conv_status\") or \"unknown\" for t in tickets if t.get(\"conversation_id\")}\n\n\ndef build_manager_prompt(ws: dict, tickets: list[dict], signals: list[str]) -> str:\n    board_json = json.dumps([\n        {\n            \"id\": t[\"id\"],\n            \"status\": t.get(\"status\"),\n            \"title\": t.get(\"title\"),\n            \"priority_rank\": t.get(\"sort_order\"),\n            \"conversation_id\": t.get(\"conversation_id\"),\n            \"conversation_status\": t.get(\"conv_status\"),\n            \"manager_note\": t.get(\"manager_note\"),\n            \"dispatched_entry_count\": t.get(\"dispatched_entry_count\", 0),\n            \"entries\": [\n                {\"index\": i, \"author\": e.get(\"author\"), \"body\": e.get(\"body\"), \"created_at\": e.get(\"created_at\")}\n                for i, e in enumerate(t.get(\"entries\", []))\n            ],\n        }\n        for t in tickets\n    ], indent=2, ensure_ascii=False)\n    return f\"\"\"You are the Vibe Kanban Manager for the project at `{WORKSPACE_PATH}`.\nYou manage a kanban queue and worker agent conversations. You do NOT do the task work yourself; you coordinate workers and update the board.\n\n## Current board\n```json\n{board_json}\n```\n\n## Signals this run\n{json.dumps(signals, indent=2)}\n\n## Board control\nRun `{VIBECTL}` from the terminal. Every command prints JSON.\n\n- Re-read board: `{VIBECTL} snapshot`\n- Update ticket: `{VIBECTL} patch <ticket_id> [--status pending|in_progress|needs_input|finished] [--title \"...\"] [--conversation-id <id>] [--manager-note \"...\"] [--dispatched-entry-count <n>] [--append-entry \"...\"]`\n- Start worker: `{VIBECTL} dispatch --ticket <ticket_id> --prompt-file <file> --title \"🎫 <short summary>\"`\n- Follow up existing worker: `{VIBECTL} followup <conversation_id> --ticket <ticket_id> --prompt-file <file>`\n- Inspect conversation: `{VIBECTL} conversation <conversation_id> --final-response`\n\n## Your job this run\n1. For each pending ticket with no conversation: decide whether it can be completed by board bookkeeping alone. If yes, patch it `--status finished` with `--append-entry` explaining the completion. Otherwise write a concise worker prompt to a temp file, dispatch a worker, then immediately patch the ticket with `--conversation-id <id> --status in_progress --title \"<short title>\" --dispatched-entry-count <entry_count>`.\n2. For tickets with new user entries beyond `dispatched_entry_count` and an existing conversation: write only the new instructions to a temp file, run `followup`, then patch `--status in_progress --dispatched-entry-count <entry_count>` and clear any stale manager note.\n3. For in_progress tickets whose conversation_status is finished/idle/paused: inspect the conversation final response. If the task appears done, patch `--status finished` with a short append-entry. If it needs the user, patch `--status needs_input` with a short append-entry.\n4. If a worker is running but the card is not in_progress, patch it back to in_progress.\n5. If you deliberately defer a pending ticket, set a concise `--manager-note`; that suppresses repeated manager summons.\n\nImportant: finished/idle conversations are still eligible for follow-up when a later ticket entry is related. Do not reopen older finished cards unless there is a new user entry on that same ticket.\n\"\"\"\n\n\ndef start_manager_conversation(prompt: str) -> str:\n    result = vibestore.start_conversation(\n        WORKSPACE_PATH,\n        prompt,\n        title=f\"🧠 Vibe Kanban Manager {time.strftime('%m-%d %H:%M')}\",\n        role=\"manager\",\n        max_iterations=200,\n    )\n    return result[\"id\"]\n\n\ndef main() -> None:\n    state = load_state()\n    board = snapshot()\n    mgr = manager_conversation_state(state, board[\"workspace\"])\n    if mgr[\"active\"]:\n        if time.time() - mgr[\"started_at\"] < MANAGER_STALE_SECONDS:\n            print(f\"manager conversation {mgr['id']} still running — skipping\")\n            fire_callback()\n            return\n        print(f\"manager conversation {mgr['id']} exceeded stale limit — proceeding\")\n    elif state.get(\"manager_conversation_id\"):\n        state[\"last_manager_finished_at\"] = time.time()\n    state[\"manager_conversation_id\"] = None\n\n    ws, tickets = enrich(board)\n    apply_mechanical_transitions(tickets)\n    board = snapshot()\n    ws, tickets = enrich(board)\n    fp = fingerprint(ws, tickets)\n    signals, retry_safe = compute_signals(ws, tickets)\n    state[\"conv_statuses\"] = conv_statuses(tickets)\n    changed = fp != state.get(\"fingerprint\")\n    kick, retry_count = kickoff_decision(state, changed, signals, retry_safe, manager_failed=mgr[\"failed\"])\n    print(f\"fingerprint changed: {changed}; signals: {signals or 'none'}; last manager: {mgr['status'] or 'none'}; kick: {kick}\")\n\n    if kick:\n        conv_id = start_manager_conversation(build_manager_prompt(ws, tickets, signals))\n        link = f\"{CANVAS_BASE}/conversations/{conv_id}\" if CANVAS_BASE else f\"/conversations/{conv_id}\"\n        print(f\"manager kicked off: {link}\")\n        state.update({\n            \"manager_conversation_id\": conv_id,\n            \"manager_started_at\": time.time(),\n            \"fingerprint\": fp,\n            \"retry_count\": retry_count + (0 if changed else 1),\n        })\n    else:\n        state[\"fingerprint\"] = fp\n        state[\"retry_count\"] = retry_count\n    state[\"last_checked_at\"] = time.time()\n    idx = vibestore.read_index()\n    idx[\"last_run_at\"] = time.time()\n    idx[\"last_error\"] = None\n    vibestore.write_index(idx)\n    save_state(state)\n    fire_callback()\n\n\nif __name__ == \"__main__\":\n    try:\n        main()\n    except Exception as exc:  # noqa: BLE001\n        traceback.print_exc()\n        idx = vibestore.read_index()\n        idx[\"last_run_at\"] = time.time()\n        idx[\"last_error\"] = str(exc)\n        vibestore.write_index(idx)\n        fire_callback(\"FAILED\", str(exc))\n        raise\n","vibestore.py":"\"\"\"File-backed Vibe Kanban store and Agent Server helpers.\"\"\"\n\nfrom __future__ import annotations\n\nimport json\nimport os\nimport shutil\nimport time\nimport urllib.error\nimport urllib.request\nimport uuid\nfrom pathlib import Path\n\nSTATUSES = (\"pending\", \"in_progress\", \"needs_input\", \"finished\")\nSTORE_SUBPATH = \".openhands/vibe-kanban\"\nDEFAULT_WORKSPACE_ID = \"default\"\nDEFAULT_MAX_CONCURRENT = 3\n\n\ndef now() -> float:\n    return time.time()\n\n\ndef new_id() -> str:\n    return uuid.uuid4().hex[:12]\n\n\ndef store_root() -> Path:\n    override = os.environ.get(\"VIBE_KANBAN_STORE_DIR\")\n    if override:\n        return Path(override).expanduser()\n    return Path.home() / STORE_SUBPATH\n\n\ndef index_path() -> Path:\n    return store_root() / \"index.json\"\n\n\ndef tickets_dir() -> Path:\n    return store_root() / \"tickets\"\n\n\ndef ticket_path(ticket_id: str) -> Path:\n    return tickets_dir() / f\"{ticket_id}.json\"\n\n\ndef default_index() -> dict:\n    return {\n        \"version\": 2,\n        \"workspace\": {\n            \"id\": DEFAULT_WORKSPACE_ID,\n            \"path\": os.environ.get(\"VIBE_KANBAN_WORKING_DIR\", \"workspace/project\"),\n            \"name\": \"Vibe Kanban\",\n            \"max_concurrent\": DEFAULT_MAX_CONCURRENT,\n            \"push_mode\": \"none\",\n            \"manager_conversation_id\": None,\n        },\n        \"ticket_ids\": [],\n        \"automation_id\": None,\n        \"last_run_at\": None,\n        \"last_error\": None,\n    }\n\n\ndef read_json(path: Path, fallback):\n    try:\n        return json.loads(path.read_text())\n    except FileNotFoundError:\n        return fallback\n    except json.JSONDecodeError as exc:\n        raise RuntimeError(f\"corrupt JSON at {path}: {exc}\") from exc\n\n\ndef write_json(path: Path, payload) -> None:\n    path.parent.mkdir(parents=True, exist_ok=True)\n    tmp = path.with_suffix(path.suffix + f\".{os.getpid()}.tmp\")\n    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False))\n    tmp.replace(path)\n\n\ndef read_index() -> dict:\n    idx = read_json(index_path(), default_index()) or default_index()\n    base = default_index()\n    base.update(idx)\n    workspace = default_index()[\"workspace\"]\n    workspace.update(base.get(\"workspace\") or {})\n    base[\"workspace\"] = workspace\n    base[\"ticket_ids\"] = list(dict.fromkeys(base.get(\"ticket_ids\") or base.get(\"task_ids\") or []))\n    return base\n\n\ndef write_index(index: dict) -> dict:\n    index[\"version\"] = 2\n    index[\"updated_at\"] = now()\n    index[\"rev\"] = (index.get(\"rev\") or 0) + 1\n    index[\"writer\"] = f\"vibestore-{new_id()}\"\n    write_json(index_path(), index)\n    return index\n\n\ndef update_workspace(**patch) -> dict:\n    idx = read_index()\n    idx.setdefault(\"workspace\", {}).update(patch)\n    write_index(idx)\n    return idx[\"workspace\"]\n\n\ndef read_ticket(ticket_id: str) -> dict | None:\n    return read_json(ticket_path(ticket_id), None)\n\n\ndef write_ticket(ticket: dict) -> dict:\n    ticket[\"updated_at\"] = now()\n    ticket[\"rev\"] = (ticket.get(\"rev\") or 0) + 1\n    ticket[\"writer\"] = f\"vibestore-{new_id()}\"\n    write_json(ticket_path(ticket[\"id\"]), ticket)\n    return ticket\n\n\ndef migrate_ticket(ticket: dict) -> dict:\n    status_map = {\"submitted\": \"pending\", \"queued\": \"pending\", \"done\": \"finished\", \"failed\": \"needs_input\"}\n    ticket[\"status\"] = status_map.get(ticket.get(\"status\"), ticket.get(\"status\") or \"pending\")\n    if \"entries\" not in ticket:\n        body = ticket.get(\"body\") or ticket.get(\"title\") or \"\"\n        created = ticket.get(\"created_at\") or now()\n        ticket[\"entries\"] = [{\"id\": new_id(), \"author\": \"user\", \"body\": body, \"created_at\": created}]\n    ticket.setdefault(\"title\", ticket.get(\"title\") or None)\n    ticket.setdefault(\"sort_order\", ticket.get(\"created_at\") or now())\n    ticket.setdefault(\"conversation_id\", ticket.get(\"routed_conversation_id\"))\n    ticket.setdefault(\"manager_note\", ticket.get(\"error\") or ticket.get(\"manager_reason\"))\n    ticket.setdefault(\"dispatched_entry_count\", 0)\n    ticket.setdefault(\"created_at\", now())\n    ticket.setdefault(\"updated_at\", ticket[\"created_at\"])\n    return ticket\n\n\ndef list_tickets() -> list[dict]:\n    idx = read_index()\n    ids = list(idx.get(\"ticket_ids\") or [])\n    if not ids and tickets_dir().is_dir():\n        ids = [p.stem for p in sorted(tickets_dir().glob(\"*.json\"))]\n        idx[\"ticket_ids\"] = ids\n        write_index(idx)\n    tickets = []\n    for ticket_id in ids:\n        ticket = read_ticket(ticket_id)\n        if ticket:\n            tickets.append(migrate_ticket(ticket))\n    tickets.sort(key=lambda t: (t.get(\"sort_order\") or 0, t.get(\"created_at\") or 0))\n    return tickets\n\n\ndef snapshot(workspace_id: str = DEFAULT_WORKSPACE_ID) -> dict:\n    idx = read_index()\n    return {\"workspace\": idx.get(\"workspace\") or default_index()[\"workspace\"], \"tickets\": list_tickets()}\n\n\ndef patch_ticket(ticket_id: str, **patch) -> dict:\n    ticket = read_ticket(ticket_id)\n    if not ticket:\n        raise KeyError(f\"ticket {ticket_id} not found\")\n    ticket = migrate_ticket(ticket)\n    stamp = now()\n    if patch.get(\"status\") is not None:\n        status = patch[\"status\"]\n        if status not in STATUSES:\n            raise ValueError(f\"bad status {status!r}; expected one of {list(STATUSES)}\")\n        if status == \"finished\" and ticket.get(\"status\") != \"finished\":\n            ticket[\"finished_at\"] = stamp\n        ticket[\"status\"] = status\n    for key in (\"title\", \"conversation_id\", \"manager_note\"):\n        if key in patch and patch[key] is not None:\n            ticket[key] = patch[key].strip() if isinstance(patch[key], str) else patch[key]\n            if key == \"title\" and not ticket[key]:\n                ticket[key] = None\n    if patch.get(\"dispatched_entry_count\") is not None:\n        ticket[\"dispatched_entry_count\"] = int(patch[\"dispatched_entry_count\"])\n    if patch.get(\"append_entry\"):\n        ticket.setdefault(\"entries\", []).append({\n            \"id\": new_id(), \"author\": \"manager\", \"body\": patch[\"append_entry\"].strip(), \"created_at\": stamp,\n        })\n        authors = [e.get(\"author\") for e in ticket[\"entries\"]]\n        advanced = int(ticket.get(\"dispatched_entry_count\") or 0)\n        while advanced < len(authors) and authors[advanced] == \"manager\":\n            advanced += 1\n        ticket[\"dispatched_entry_count\"] = advanced\n    return write_ticket(ticket)\n\n\ndef agent_server_url() -> str:\n    return os.environ.get(\"AGENT_SERVER_URL\", \"http://127.0.0.1:18000\").rstrip(\"/\")\n\n\ndef session_key() -> str:\n    key = os.environ.get(\"SESSION_API_KEY\") or os.environ.get(\"OH_SESSION_API_KEYS_0\")\n    if not key:\n        raise RuntimeError(\"no agent-server session key available\")\n    return key\n\n\ndef agent_request(path: str, method: str = \"GET\", data: dict | None = None, extra_headers: dict | None = None, timeout: int = 60):\n    body = json.dumps(data).encode() if data is not None else None\n    req = urllib.request.Request(\n        f\"{agent_server_url()}{path}\", data=body, method=method,\n        headers={\"Content-Type\": \"application/json\", \"X-Session-API-Key\": session_key(), **(extra_headers or {})},\n    )\n    with urllib.request.urlopen(req, timeout=timeout) as r:\n        raw = r.read().decode()\n    return json.loads(raw) if raw else None\n\n\ndef agent_settings_payload() -> dict:\n    settings = agent_request(\"/api/settings\", extra_headers={\"X-Expose-Secrets\": \"encrypted\"}, timeout=30)\n    agent_settings = dict(settings.get(\"agent_settings\") or {})\n    agent_settings.pop(\"schema_version\", None)\n    agent_settings.pop(\"mcp_config\", None)\n    tools = agent_settings.get(\"tools\") if isinstance(agent_settings.get(\"tools\"), list) else []\n    names = {tool.get(\"name\") for tool in tools if isinstance(tool, dict)}\n    for name in [\"terminal\", \"file_editor\", \"task_tracker\", \"browser_tool_set\"]:\n        if name not in names:\n            tools.append({\"name\": name, \"params\": {}})\n    agent_settings[\"tools\"] = tools\n    context = dict(agent_settings.get(\"agent_context\") or {})\n    context.update({\"load_public_skills\": True, \"load_user_skills\": True, \"load_project_skills\": True})\n    agent_settings[\"agent_context\"] = context\n    return agent_settings\n\n\ndef start_conversation(working_dir: str, prompt: str, *, title: str | None = None, conversation_id: str | None = None, role: str = \"worker\", max_iterations: int = 500) -> dict:\n    if conversation_id:\n        agent_request(\n            f\"/api/conversations/{conversation_id}/events\", \"POST\",\n            {\"role\": \"user\", \"content\": [{\"type\": \"text\", \"text\": prompt}], \"run\": True}, timeout=30,\n        )\n        return {\"id\": conversation_id, \"followup\": True, \"conversation_url\": f\"/conversations/{conversation_id}\"}\n    body = {\n        \"workspace\": {\"kind\": \"LocalWorkspace\", \"working_dir\": working_dir},\n        \"worktree\": False,\n        \"agent_settings\": agent_settings_payload(),\n        \"secrets_encrypted\": True,\n        \"initial_message\": {\"role\": \"user\", \"content\": [{\"type\": \"text\", \"text\": prompt}], \"run\": True},\n        \"max_iterations\": max_iterations,\n        \"autotitle\": not title,\n        \"tags\": {\"workspace\": working_dir, \"viberole\": role},\n    }\n    created = agent_request(\"/api/conversations\", \"POST\", body, timeout=120)\n    conv_id = created.get(\"id\") or created.get(\"app_conversation_id\")\n    if not conv_id:\n        raise RuntimeError(f\"conversation create returned no id: {created}\")\n    if title:\n        try:\n            agent_request(f\"/api/conversations/{conv_id}\", \"PATCH\", {\"title\": title}, timeout=30)\n        except Exception:\n            pass\n    if role == \"manager\":\n        update_workspace(manager_conversation_id=conv_id)\n    return {\"id\": conv_id, \"followup\": False, \"conversation_url\": f\"/conversations/{conv_id}\"}\n\n\ndef conversation_info(conversation_id: str, final_response: bool = False) -> dict:\n    conv = agent_request(f\"/api/conversations/{conversation_id}?include_skills=false\", timeout=30)\n    out = {\n        \"id\": conv.get(\"id\"),\n        \"execution_status\": conv.get(\"execution_status\"),\n        \"title\": conv.get(\"title\"),\n        \"model\": ((conv.get(\"agent\") or {}).get(\"llm\") or {}).get(\"model\"),\n    }\n    if final_response:\n        try:\n            out[\"final_response\"] = agent_request(f\"/api/conversations/{conversation_id}/agent_final_response\", timeout=30)\n        except Exception as exc:\n            out[\"final_response_error\"] = str(exc)\n    return out\n\n\ndef llm_profiles() -> dict:\n    try:\n        return agent_request(\"/api/profiles\", timeout=15) or {\"profiles\": [], \"active_profile\": None}\n    except Exception:\n        return {\"profiles\": [], \"active_profile\": None}\n\n\ndef install_cli() -> str:\n    src = Path(__file__).parent\n    bin_dir = store_root() / \"bin\"\n    bin_dir.mkdir(parents=True, exist_ok=True)\n    for name in (\"vibestore.py\", \"vibectl.py\"):\n        shutil.copy2(src / name, bin_dir / name)\n    (bin_dir / \"vibectl.py\").chmod(0o755)\n    (bin_dir / \"config.json\").write_text(json.dumps({\n        \"workspace_id\": DEFAULT_WORKSPACE_ID,\n        \"workspace_path\": read_index()[\"workspace\"][\"path\"],\n        \"store_dir\": str(store_root()),\n    }, indent=2))\n    return str(bin_dir / \"vibectl.py\")\n","vibectl.py":"#!/usr/bin/env python3\n\"\"\"CLI used by the Vibe Kanban manager conversation.\"\"\"\n\nfrom __future__ import annotations\n\nimport argparse\nimport json\nimport os\nimport sys\nfrom pathlib import Path\n\nsys.path.insert(0, str(Path(__file__).parent))\nimport vibestore  # noqa: E402\n\nDEFAULTS_PATH = Path(__file__).with_name(\"config.json\")\nDEFAULTS = json.loads(DEFAULTS_PATH.read_text()) if DEFAULTS_PATH.exists() else {}\nif DEFAULTS.get(\"store_dir\"):\n    os.environ.setdefault(\"VIBE_KANBAN_STORE_DIR\", DEFAULTS[\"store_dir\"])\n\n\ndef out(value) -> int:\n    print(json.dumps(value, indent=2, ensure_ascii=False))\n    return 0\n\n\ndef read_prompt(args) -> str:\n    if args.prompt_file:\n        return Path(args.prompt_file).read_text()\n    if args.prompt:\n        return args.prompt\n    raise ValueError(\"--prompt or --prompt-file is required\")\n\n\ndef cmd_snapshot(args) -> int:\n    return out(vibestore.snapshot(args.workspace_id))\n\n\ndef cmd_patch(args) -> int:\n    fields = {k: v for k, v in {\n        \"status\": args.status,\n        \"title\": args.title,\n        \"conversation_id\": args.conversation_id,\n        \"manager_note\": args.manager_note,\n        \"dispatched_entry_count\": args.dispatched_entry_count,\n        \"append_entry\": args.append_entry,\n    }.items() if v is not None}\n    if not fields:\n        raise ValueError(\"no fields to patch\")\n    return out(vibestore.patch_ticket(args.ticket_id, **fields))\n\n\ndef cmd_dispatch(args) -> int:\n    return out(vibestore.start_conversation(\n        args.working_dir,\n        read_prompt(args),\n        title=args.title,\n        role=args.role,\n        max_iterations=args.max_iterations,\n    ))\n\n\ndef cmd_followup(args) -> int:\n    return out(vibestore.start_conversation(\n        args.working_dir,\n        read_prompt(args),\n        conversation_id=args.conversation_id,\n        max_iterations=args.max_iterations,\n    ))\n\n\ndef cmd_conversation(args) -> int:\n    return out(vibestore.conversation_info(args.conversation_id, args.final_response))\n\n\ndef cmd_profiles(args) -> int:\n    return out(vibestore.llm_profiles())\n\n\ndef build_parser() -> argparse.ArgumentParser:\n    parser = argparse.ArgumentParser(prog=\"vibectl.py\")\n    parser.add_argument(\"--workspace-id\", default=None)\n    parser.add_argument(\"--working-dir\", default=None)\n    sub = parser.add_subparsers(dest=\"command\", required=True)\n\n    sub.add_parser(\"snapshot\").set_defaults(func=cmd_snapshot)\n\n    patch = sub.add_parser(\"patch\")\n    patch.add_argument(\"ticket_id\")\n    patch.add_argument(\"--status\", choices=list(vibestore.STATUSES))\n    patch.add_argument(\"--title\")\n    patch.add_argument(\"--conversation-id\")\n    patch.add_argument(\"--manager-note\")\n    patch.add_argument(\"--dispatched-entry-count\", type=int)\n    patch.add_argument(\"--append-entry\")\n    patch.set_defaults(func=cmd_patch)\n\n    dispatch = sub.add_parser(\"dispatch\")\n    dispatch.add_argument(\"--prompt\")\n    dispatch.add_argument(\"--prompt-file\")\n    dispatch.add_argument(\"--title\")\n    dispatch.add_argument(\"--ticket\")\n    dispatch.add_argument(\"--role\", default=\"worker\", choices=[\"worker\", \"manager\"])\n    dispatch.add_argument(\"--max-iterations\", type=int, default=500)\n    dispatch.set_defaults(func=cmd_dispatch)\n\n    followup = sub.add_parser(\"followup\")\n    followup.add_argument(\"conversation_id\")\n    followup.add_argument(\"--prompt\")\n    followup.add_argument(\"--prompt-file\")\n    followup.add_argument(\"--ticket\")\n    followup.add_argument(\"--max-iterations\", type=int, default=500)\n    followup.set_defaults(func=cmd_followup)\n\n    conv = sub.add_parser(\"conversation\")\n    conv.add_argument(\"conversation_id\")\n    conv.add_argument(\"--final-response\", action=\"store_true\")\n    conv.set_defaults(func=cmd_conversation)\n\n    sub.add_parser(\"profiles\").set_defaults(func=cmd_profiles)\n    return parser\n\n\ndef main(argv=None) -> int:\n    args = build_parser().parse_args(argv)\n    args.workspace_id = args.workspace_id or os.environ.get(\"VIBE_WORKSPACE_ID\") or DEFAULTS.get(\"workspace_id\") or \"default\"\n    args.working_dir = args.working_dir or os.environ.get(\"VIBE_WORKSPACE_PATH\") or DEFAULTS.get(\"workspace_path\") or \"workspace/project\"\n    try:\n        return args.func(args)\n    except (ValueError, KeyError, RuntimeError) as exc:\n        print(json.dumps({\"error\": str(exc)}), file=sys.stderr)\n        return 1\n\n\nif __name__ == \"__main__\":\n    raise SystemExit(main())\n"};
const AUTOMATION_BASE = "/api/automation/v1";
const CRON_EVERY_MINUTE = "* * * * *";
const STORE_SUBPATH = ".openhands/vibe-kanban";
const STYLE_ID = "vibe-kanban-extension-style";
const STATUSES = ["pending", "in_progress", "needs_input", "finished"];
const STATUS_LABELS = {
  pending: "Pending",
  in_progress: "In progress",
  needs_input: "Needs input",
  finished: "Finished",
};

const CSS = `
.vibe-kanban{min-height:100%;padding:28px;color:var(--oh-text-primary,#f7f4ff);background:radial-gradient(circle at 20% 0%,rgba(120,92,255,.24),transparent 32rem),linear-gradient(135deg,#14111f,#1e182b 48%,#111827);font-family:Inter,ui-sans-serif,system-ui,sans-serif;}
.vibe-kanban *{box-sizing:border-box}.kd-shell{max-width:1500px;margin:0 auto}.kd-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:22px}.kd-eyebrow{margin:0 0 7px;text-transform:uppercase;letter-spacing:.14em;font-size:12px;color:#a8fff1}.kd-title{margin:0;font-size:34px;line-height:1.05;font-weight:800}.kd-copy{max-width:740px;margin:10px 0 0;color:rgba(247,244,255,.72);font-size:14px;line-height:1.6}.kd-status{min-width:310px;border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:14px;background:rgba(255,255,255,.07);box-shadow:0 20px 55px rgba(0,0,0,.22)}.kd-status-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;color:rgba(247,244,255,.78);font-size:12px}.kd-status-row strong{color:#fff;font-weight:700;overflow:hidden;text-overflow:ellipsis}.kd-form{display:grid;grid-template-columns:minmax(180px,300px) 1fr auto;gap:10px;align-items:start;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.075);border-radius:22px;padding:14px;margin-bottom:18px}.kd-input,.kd-textarea{width:100%;border:1px solid rgba(255,255,255,.16);background:rgba(8,9,18,.52);border-radius:14px;color:#fff;padding:12px 13px;outline:none}.kd-textarea{min-height:74px;resize:vertical}.kd-input:focus,.kd-textarea:focus{border-color:#54f0dd;box-shadow:0 0 0 3px rgba(84,240,221,.16)}.kd-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}.kd-btn{appearance:none;border:0;border-radius:999px;padding:10px 14px;font-weight:750;color:#171322;background:#fff;cursor:pointer;white-space:nowrap}.kd-btn:hover{transform:translateY(-1px)}.kd-btn.secondary{background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.15)}.kd-btn.danger{background:#ff6f8b;color:#22070d}.kd-btn:disabled{opacity:.55;cursor:not-allowed;transform:none}.kd-board{display:grid;grid-template-columns:repeat(4,minmax(230px,1fr));gap:12px;align-items:start}.kd-lane{min-height:360px;border:1px solid rgba(255,255,255,.13);border-radius:22px;padding:12px;background:rgba(255,255,255,.06)}.kd-lane[data-status=pending]{--lane:#8d93b8}.kd-lane[data-status=in_progress]{--lane:#3fd8c8}.kd-lane[data-status=needs_input]{--lane:#ffb454}.kd-lane[data-status=finished]{--lane:#a794ff}.kd-lane-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.kd-lane-title{display:flex;align-items:center;gap:8px;font-weight:800}.kd-dot{width:10px;height:10px;border-radius:50%;background:var(--lane);box-shadow:0 0 18px var(--lane)}.kd-count{color:rgba(255,255,255,.65);font-size:12px}.kd-empty{border:1px dashed rgba(255,255,255,.16);border-radius:16px;padding:18px 12px;text-align:center;color:rgba(255,255,255,.48);font-size:13px}.kd-card{border:1px solid rgba(255,255,255,.14);border-left:4px solid var(--lane);border-radius:17px;padding:12px;margin-bottom:10px;background:rgba(10,12,24,.58);box-shadow:0 14px 34px rgba(0,0,0,.2)}.kd-card h3{margin:0 0 8px;font-size:15px;line-height:1.25}.kd-card p{margin:0;color:rgba(255,255,255,.72);font-size:13px;line-height:1.45;white-space:pre-wrap}.kd-meta{display:grid;gap:5px;margin-top:10px;color:rgba(255,255,255,.6);font-size:11px}.kd-pill{display:inline-flex;width:max-content;border-radius:999px;padding:3px 8px;background:rgba(255,255,255,.11);color:rgba(255,255,255,.82);font-size:11px}.kd-card a{color:#8efff1}.kd-error{margin-top:10px;color:#ffd5dc;background:rgba(255,111,139,.12);border:1px solid rgba(255,111,139,.25);border-radius:12px;padding:8px;font-size:12px;white-space:pre-wrap}.kd-toast{position:fixed;right:22px;bottom:22px;z-index:1000;max-width:420px;border-radius:14px;padding:12px 14px;background:#fff;color:#171322;box-shadow:0 22px 70px rgba(0,0,0,.42);font-size:13px}.kd-toast.error{background:#ffdae1;color:#2a0710}@media(max-width:1100px){.kd-board{grid-template-columns:repeat(2,minmax(240px,1fr))}.kd-form{grid-template-columns:1fr}.kd-actions{justify-content:flex-start}.kd-hero{display:block}.kd-status{margin-top:16px}}@media(max-width:680px){.kd-board{grid-template-columns:1fr}.vibe-kanban{padding:16px}.kd-title{font-size:28px}}
`;

let styleRefCount = 0;
function acquireStyle() {
  styleRefCount += 1;
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }
  return () => {
    styleRefCount = Math.max(0, styleRefCount - 1);
    if (styleRefCount === 0) el.remove();
  };
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[ch]);
}
function short(value, length = 180) {
  const text = String(value ?? "").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
function newId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function nowIso() {
  return new Date().toISOString();
}
function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function isNotFound(error) {
  return error && (error.status === 404 || error.statusCode === 404 || String(error.message || "").includes("404"));
}

class Store {
  constructor(host) {
    this.host = host;
    this.root = null;
    this.rootPromise = null;
    this.queue = Promise.resolve();
  }
  serialize(fn) {
    const run = this.queue.then(fn);
    this.queue = run.then(() => {}, () => {});
    return run;
  }
  async storeRoot() {
    if (this.root) return this.root;
    if (!this.rootPromise) {
      this.rootPromise = this.host.agentServer.request({ path: "/api/file/home" }).then((raw) => {
        const data = parseMaybeJson(raw);
        const home = data?.home;
        if (!home) throw new Error("Agent Server did not report a home directory.");
        this.root = `${String(home).replace(/\/+$/, "")}/${STORE_SUBPATH}`;
        return this.root;
      }).catch((error) => {
        this.rootPromise = null;
        throw error;
      });
    }
    return this.rootPromise;
  }
  async indexPath() {
    return `${await this.storeRoot()}/index.json`;
  }
  async taskPath(id) {
    return `${await this.storeRoot()}/tickets/${id}.json`;
  }
  defaultIndex() {
    return { version: 2, ticket_ids: [], automation_id: null, workspace: { id: "default", path: "workspace/project", name: "Vibe Kanban", max_concurrent: 3, push_mode: "none", manager_conversation_id: null }, last_run_at: null, last_error: null };
  }
  async readJson(path, fallback) {
    try {
      const raw = await this.host.agentServer.request({ path: `/api/file/download?path=${encodeURIComponent(path)}&_=${Date.now()}`, headers: { "Cache-Control": "no-cache" } });
      return parseMaybeJson(raw);
    } catch (error) {
      if (fallback !== undefined && isNotFound(error)) return fallback;
      throw error;
    }
  }
  async writeJson(path, payload) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    await this.host.agentServer.request({ method: "POST", path: `/api/file/create_directory?path=${encodeURIComponent(dir)}` });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const form = new FormData();
    form.append("file", blob, path.split("/").pop());
    await this.host.agentServer.request({ method: "POST", path: `/api/file/upload?path=${encodeURIComponent(path)}`, body: form });
  }
  async readIndex() {
    const index = await this.readJson(await this.indexPath(), this.defaultIndex());
    return { ...this.defaultIndex(), ...(index || {}), ticket_ids: Array.from(new Set(index?.ticket_ids || index?.task_ids || [])), workspace: { ...this.defaultIndex().workspace, ...(index?.workspace || {}) } };
  }
  async writeIndex(index) {
    const next = { ...this.defaultIndex(), ...index, version: 2, updated_at: nowIso(), rev: (index.rev || 0) + 1, writer: `browser-${newId()}` };
    await this.writeJson(await this.indexPath(), next);
    return next;
  }
  async readTask(id) {
    return this.readJson(await this.taskPath(id), null);
  }
  async writeTask(task) {
    const next = { ...task, updated_at: Date.now() / 1000, rev: (task.rev || 0) + 1, writer: `browser-${newId()}` };
    await this.writeJson(await this.taskPath(next.id), next);
    return next;
  }
  normalizeTask(task) {
    const next = { ...task };
    const mapped = { submitted: "pending", queued: "pending", done: "finished", failed: "needs_input" };
    next.status = mapped[next.status] || next.status || "pending";
    next.conversation_id = next.conversation_id || next.routed_conversation_id || null;
    next.manager_note = next.manager_note || next.error || next.manager_reason || null;
    if (!Array.isArray(next.entries)) {
      next.entries = [{ id: newId(), author: "user", body: next.body || next.title || "", created_at: next.created_at || Date.now() / 1000 }];
    }
    next.dispatched_entry_count = Number(next.dispatched_entry_count || 0);
    return next;
  }
  async readBoard() {
    const index = await this.readIndex();
    const tasks = (await Promise.all(index.ticket_ids.map((id) => this.readTask(id).catch((error) => {
      if (isNotFound(error)) return null;
      throw error;
    })))).filter(Boolean).map((task) => this.normalizeTask(task)).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    return { index, tasks };
  }
  async createTask({ title, body }) {
    return this.serialize(async () => {
      const index = await this.readIndex();
      const created = Date.now() / 1000;
      const bodyText = body.trim();
      const task = await this.writeTask({ id: newId(), title: title.trim() || null, body: bodyText, status: "pending", sort_order: Date.now(), conversation_id: null, manager_note: null, dispatched_entry_count: 0, created_at: created, updated_at: created, entries: [{ id: newId(), author: "user", body: bodyText, created_at: created }] });
      index.ticket_ids = Array.from(new Set([...(index.ticket_ids || []), task.id]));
      await this.writeIndex(index);
      return task;
    });
  }
  async updateIndex(patch) {
    return this.serialize(async () => {
      const index = await this.readIndex();
      return this.writeIndex({ ...index, ...patch });
    });
  }
}

function resolveBackendCredentials(backendId) {
  try {
    const raw = localStorage.getItem("openhands-backends");
    const parsed = raw ? JSON.parse(raw) : null;
    const list = Array.isArray(parsed) ? parsed : parsed?.backends;
    const match = Array.isArray(list) ? (list.find((item) => item?.id === backendId) || list[0]) : null;
    if (match?.host) return { host: String(match.host).replace(/\/+$/, ""), apiKey: match.apiKey || match.sessionApiKey || "" };
  } catch {}
  try {
    const raw = localStorage.getItem("openhands-agent-server-config");
    const cfg = raw ? JSON.parse(raw) : null;
    if (cfg?.host) return { host: String(cfg.host).replace(/\/+$/, ""), apiKey: cfg.sessionApiKey || cfg.apiKey || "" };
  } catch {}
  if (window.__AGENT_CANVAS_SESSION_API_KEY__) return { host: window.location.origin, apiKey: window.__AGENT_CANVAS_SESSION_API_KEY__ };
  return { host: window.location.origin, apiKey: "" };
}
async function automationFetch(host, path, options = {}) {
  const creds = resolveBackendCredentials(host.backend?.id);
  const headers = { ...(options.headers || {}), ...(creds.apiKey ? { "X-Session-API-Key": creds.apiKey } : {}) };
  const res = await fetch(`${creds.host}${AUTOMATION_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      detail = (await res.json()).detail || detail;
    } catch {}
    throw new Error(detail);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}
async function gzip(data) {
  if (!globalThis.CompressionStream) throw new Error("This browser does not support CompressionStream for automation upload.");
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const encoder = new TextEncoder();
function putString(block, offset, value, length) {
  block.set(encoder.encode(value).subarray(0, length - 1), offset);
}
function putOctal(block, offset, value, length) {
  putString(block, offset, value.toString(8).padStart(length - 1, "0"), length);
}
function tarHeader(name, size, mtime) {
  const block = new Uint8Array(512);
  putString(block, 0, name, 100);
  putOctal(block, 100, 0o644, 8);
  putOctal(block, 108, 0, 8);
  putOctal(block, 116, 0, 8);
  putOctal(block, 124, size, 12);
  putOctal(block, 136, mtime, 12);
  block.fill(32, 148, 156);
  block[156] = 48;
  putString(block, 257, "ustar", 6);
  block[263] = 48;
  block[264] = 48;
  putString(block, 265, "root", 32);
  putString(block, 297, "root", 32);
  let sum = 0;
  for (const byte of block) sum += byte;
  putString(block, 148, sum.toString(8).padStart(6, "0"), 8);
  block[154] = 0;
  block[155] = 32;
  return block;
}
function tar(files) {
  const blocks = [];
  let total = 0;
  const mtime = Math.floor(Date.now() / 1000);
  for (const [name, text] of Object.entries(files)) {
    const data = encoder.encode(text);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    const head = tarHeader(name, data.length, mtime);
    blocks.push(head, padded);
    total += head.length + padded.length;
  }
  blocks.push(new Uint8Array(1024));
  total += 1024;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

async function ensureAutomation(host, store) {
  const index = await store.readIndex();
  const name = "Vibe Kanban Manager";
  const config = { store_dir: await store.storeRoot(), working_dir: (await store.readIndex()).workspace?.path || "workspace/project", agent_server: "http://127.0.0.1:18000", canvas_base: window.location.origin };
  const archive = await gzip(tar({ ...AUTOMATION_FILES, "config.json": `${JSON.stringify(config, null, 2)}\n` }));
  const uploadQuery = `?${new URLSearchParams({ name: "vibe-kanban-manager", description: "Vibe Kanban manager automation" })}`;
  const upload = await automationFetch(host, `/uploads${uploadQuery}`, { method: "POST", headers: { "Content-Type": "application/gzip" }, body: archive });
  const tarballPath = upload.tarball_path;
  if (!tarballPath) throw new Error("Automation upload returned no tarball_path.");
  let automationId = index.automation_id;
  if (!automationId) {
    try {
      const list = await automationFetch(host, "?limit=100");
      automationId = (list.automations || []).find((automation) => automation.name === name)?.id || null;
    } catch {}
  }
  if (automationId) {
    await automationFetch(host, `/${encodeURIComponent(automationId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tarball_path: tarballPath, enabled: true }) });
  } else {
    const created = await automationFetch(host, "", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, trigger: { type: "cron", schedule: CRON_EVERY_MINUTE, timezone: "UTC" }, tarball_path: tarballPath, entrypoint: "python3 main.py", timeout: 300 }) });
    automationId = created.id;
    if (!automationId) throw new Error("Automation create returned no id.");
  }
  await store.updateIndex({ automation_id: automationId });
  return automationId;
}
async function dispatchAutomation(host, automationId) {
  return automationFetch(host, `/${encodeURIComponent(automationId)}/dispatch`, { method: "POST" });
}
async function stopAutomation(host, automationId) {
  return automationFetch(host, `/${encodeURIComponent(automationId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
}
async function readAutomationStatus(host, automationId) {
  if (!automationId) return null;
  try {
    const [automation, runs] = await Promise.all([
      automationFetch(host, `/${encodeURIComponent(automationId)}`),
      automationFetch(host, `/${encodeURIComponent(automationId)}/runs?limit=1`).catch(() => null),
    ]);
    return { automation, lastRun: runs?.runs?.[0] || null };
  } catch (error) {
    return { error: error.message };
  }
}

function boardMarkup() {
  return `<section class="vibe-kanban"><div class="kd-shell"><div class="kd-hero"><div><p class="kd-eyebrow">Canvas Extension + Automation reference</p><h1 class="kd-title">Vibe Kanban</h1><p class="kd-copy">Submit work, then let a one-minute cron manager summon a full manager agent to dispatch workers or follow up existing conversations. State is JSON on the Agent Server filesystem; no DB or extra service required.</p></div><div class="kd-status" data-role="status"></div></div><form class="kd-form" data-role="form"><input class="kd-input" name="title" placeholder="Task title" required><textarea class="kd-textarea" name="body" placeholder="Describe the task. The manager will decide where it belongs." required></textarea><div class="kd-actions"><button class="kd-btn" type="submit">Submit task</button><button class="kd-btn secondary" type="button" data-action="refresh">Refresh</button><button class="kd-btn secondary" type="button" data-action="start">Start manager</button><button class="kd-btn secondary" type="button" data-action="run">Run now</button><button class="kd-btn danger" type="button" data-action="stop">Stop</button></div></form><div class="kd-board" data-role="board"></div></div></section>`;
}
function renderStatus(root, index, automationStatus) {
  const el = root.querySelector('[data-role="status"]');
  const auto = automationStatus?.automation;
  const run = automationStatus?.lastRun;
  const error = automationStatus?.error || index.last_error;
  el.innerHTML = `<div class="kd-status-row"><span>Automation</span><strong>${escapeHtml(index.automation_id || "not configured")}</strong></div><div class="kd-status-row"><span>Enabled</span><strong>${escapeHtml(auto?.enabled ?? "unknown")}</strong></div><div class="kd-status-row"><span>Last run</span><strong>${escapeHtml(run?.status || index.last_run_at || "never")}</strong></div><div class="kd-status-row"><span>Manager conversation</span><strong>${escapeHtml(index.workspace?.manager_conversation_id || "not started")}</strong></div>${error ? `<div class="kd-error">${escapeHtml(short(error, 500))}</div>` : ""}`;
}
function renderBoard(root, tasks, host) {
  const board = root.querySelector('[data-role="board"]');
  board.innerHTML = STATUSES.map((status) => {
    const laneTasks = tasks.filter((task) => task.status === status);
    return `<section class="kd-lane" data-status="${status}"><div class="kd-lane-head"><div class="kd-lane-title"><span class="kd-dot"></span>${STATUS_LABELS[status]}</div><span class="kd-count">${laneTasks.length}</span></div>${laneTasks.length ? laneTasks.map((task) => cardHtml(task)).join("") : `<div class="kd-empty">No cards</div>`}</section>`;
  }).join("");
  board.querySelectorAll("a[data-conversation]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      host.navigate(`/conversations/${link.getAttribute("data-conversation")}`);
    });
  });
}
function cardHtml(task) {
  const cid = task.conversation_id || task.routed_conversation_id;
  return `<article class="kd-card"><h3>${escapeHtml(task.title || "Untitled task")}</h3><p>${escapeHtml(short(task.body || task.entries?.[task.entries.length - 1]?.body, 240))}</p><div class="kd-meta">${task.manager_note ? `<span class="kd-pill">${escapeHtml(short(task.manager_note, 80))}</span>` : ""}${cid ? `<span>Conversation: <a href="/conversations/${encodeURIComponent(cid)}" data-conversation="${escapeHtml(cid)}">${escapeHtml(cid)}</a></span>` : ""}${Array.isArray(task.entries) && task.entries.length ? `<span>Entries: ${task.entries.length} · dispatched ${task.dispatched_entry_count || 0}</span>` : ""}<span>${escapeHtml(new Date(task.updated_at || task.created_at || Date.now()).toLocaleString())}</span></div>${task.error ? `<div class="kd-error">${escapeHtml(short(task.error, 700))}</div>` : ""}</article>`;
}
function toast(root, message, error = false) {
  const el = document.createElement("div");
  el.className = `kd-toast${error ? " error" : ""}`;
  el.textContent = message;
  root.append(el);
  setTimeout(() => el.remove(), 4200);
}

function mountBoard({ container, host }) {
  const releaseStyle = acquireStyle();
  const wrapper = document.createElement("div");
  wrapper.innerHTML = boardMarkup();
  const root = wrapper.firstElementChild;
  container.append(root);
  const store = new Store(host);
  let disposed = false;
  let pollId = null;
  let busy = false;

  async function load() {
    if (disposed) return;
    const { index, tasks } = await store.readBoard();
    const automationStatus = await readAutomationStatus(host, index.automation_id);
    if (disposed) return;
    renderStatus(root, index, automationStatus);
    renderBoard(root, tasks, host);
  }
  async function action(label, fn) {
    if (busy) return;
    busy = true;
    root.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      const result = await fn();
      toast(root, result || `${label} complete`);
      await load();
    } catch (error) {
      toast(root, `${label} failed: ${error.message}`, true);
    } finally {
      busy = false;
      root.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
  }

  root.querySelector('[data-role="form"]').addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    action("Submit task", async () => {
      await store.createTask({ title: form.elements.title.value, body: form.elements.body.value });
      form.reset();
      return "Ticket created";
    });
  });
  root.querySelector('[data-action="refresh"]').addEventListener("click", () => action("Refresh", async () => { await load(); return "Board refreshed"; }));
  root.querySelector('[data-action="start"]').addEventListener("click", () => action("Start manager", async () => `Manager automation ready: ${await ensureAutomation(host, store)}`));
  root.querySelector('[data-action="run"]').addEventListener("click", () => action("Run manager", async () => {
    const index = await store.readIndex();
    if (!index.automation_id) throw new Error("Start the manager automation first.");
    await dispatchAutomation(host, index.automation_id);
    return "Manager dispatched";
  }));
  root.querySelector('[data-action="stop"]').addEventListener("click", () => action("Stop manager", async () => {
    const index = await store.readIndex();
    if (!index.automation_id) throw new Error("No manager automation is configured.");
    await stopAutomation(host, index.automation_id);
    return "Manager disabled";
  }));

  load().catch((error) => toast(root, error.message, true));
  pollId = setInterval(() => load().catch(() => {}), 5000);
  return () => {
    disposed = true;
    if (pollId) clearInterval(pollId);
    releaseStyle();
    root.remove();
  };
}

export function activate(host) {
  return host.registerPage("board", ({ container }) => mountBoard({ container, host }));
}
