#!/usr/bin/env python3
"""CLI used by the Vibe Kanban manager conversation."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import vibestore  # noqa: E402

DEFAULTS_PATH = Path(__file__).with_name("config.json")
DEFAULTS = json.loads(DEFAULTS_PATH.read_text()) if DEFAULTS_PATH.exists() else {}
if DEFAULTS.get("store_dir"):
    os.environ.setdefault("VIBE_KANBAN_STORE_DIR", DEFAULTS["store_dir"])


def out(value) -> int:
    print(json.dumps(value, indent=2, ensure_ascii=False))
    return 0


def read_prompt(args) -> str:
    if args.prompt_file:
        return Path(args.prompt_file).read_text()
    if args.prompt:
        return args.prompt
    raise ValueError("--prompt or --prompt-file is required")


def cmd_snapshot(args) -> int:
    return out(vibestore.snapshot(args.workspace_id))


def cmd_patch(args) -> int:
    fields = {k: v for k, v in {
        "status": args.status,
        "title": args.title,
        "conversation_id": args.conversation_id,
        "manager_note": args.manager_note,
        "dispatched_entry_count": args.dispatched_entry_count,
        "append_entry": args.append_entry,
    }.items() if v is not None}
    if not fields:
        raise ValueError("no fields to patch")
    return out(vibestore.patch_ticket(args.ticket_id, **fields))


def cmd_dispatch(args) -> int:
    return out(vibestore.start_conversation(
        args.working_dir,
        read_prompt(args),
        title=args.title,
        role=args.role,
        max_iterations=args.max_iterations,
    ))


def cmd_followup(args) -> int:
    return out(vibestore.start_conversation(
        args.working_dir,
        read_prompt(args),
        conversation_id=args.conversation_id,
        max_iterations=args.max_iterations,
    ))


def cmd_conversation(args) -> int:
    return out(vibestore.conversation_info(args.conversation_id, args.final_response))


def cmd_profiles(args) -> int:
    return out(vibestore.llm_profiles())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vibectl.py")
    parser.add_argument("--workspace-id", default=None)
    parser.add_argument("--working-dir", default=None)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("snapshot").set_defaults(func=cmd_snapshot)

    patch = sub.add_parser("patch")
    patch.add_argument("ticket_id")
    patch.add_argument("--status", choices=list(vibestore.STATUSES))
    patch.add_argument("--title")
    patch.add_argument("--conversation-id")
    patch.add_argument("--manager-note")
    patch.add_argument("--dispatched-entry-count", type=int)
    patch.add_argument("--append-entry")
    patch.set_defaults(func=cmd_patch)

    dispatch = sub.add_parser("dispatch")
    dispatch.add_argument("--prompt")
    dispatch.add_argument("--prompt-file")
    dispatch.add_argument("--title")
    dispatch.add_argument("--ticket")
    dispatch.add_argument("--role", default="worker", choices=["worker", "manager"])
    dispatch.add_argument("--max-iterations", type=int, default=500)
    dispatch.set_defaults(func=cmd_dispatch)

    followup = sub.add_parser("followup")
    followup.add_argument("conversation_id")
    followup.add_argument("--prompt")
    followup.add_argument("--prompt-file")
    followup.add_argument("--ticket")
    followup.add_argument("--max-iterations", type=int, default=500)
    followup.set_defaults(func=cmd_followup)

    conv = sub.add_parser("conversation")
    conv.add_argument("conversation_id")
    conv.add_argument("--final-response", action="store_true")
    conv.set_defaults(func=cmd_conversation)

    sub.add_parser("profiles").set_defaults(func=cmd_profiles)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    args.workspace_id = args.workspace_id or os.environ.get("VIBE_WORKSPACE_ID") or DEFAULTS.get("workspace_id") or "default"
    args.working_dir = args.working_dir or os.environ.get("VIBE_WORKSPACE_PATH") or DEFAULTS.get("workspace_path") or "workspace/project"
    try:
        return args.func(args)
    except (ValueError, KeyError, RuntimeError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
