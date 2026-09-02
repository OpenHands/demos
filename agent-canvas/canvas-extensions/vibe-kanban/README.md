# Vibe Kanban Canvas Extension

This is a compact reference implementation artifact for converting the core
Vibe Manager idea into an Agent Canvas Extension plus cron automation.

It intentionally removes the standalone FastAPI app, SQLite database, nginx,
systemd, and any separate backend service. The extension, cron loop, manager
agent, and `vibectl.py` CLI share state through JSON files on the active Agent
Server filesystem.

## What it demonstrates

- An installable Canvas Extension page at `/extensions/vibe-kanban/board`.
- A Vibe-like Kanban UI rendered inside Agent Canvas.
- Ticket persistence as JSON files under `~/.openhands/vibe-kanban/`.
- A manager automation scheduled every minute with `* * * * *`.
- The original Vibe Manager control pattern:
  - deterministic cron loop snapshots the board and computes actionable signals,
  - cron loop avoids overlapping manager conversations,
  - a full manager agent conversation is kicked off only when board state needs
    judgment,
  - the manager agent runs `vibectl.py` to patch tickets, dispatch workers,
    follow up existing conversations, and inspect completed workers.
- Follow-up routing to existing conversations without requiring brittle JSON-only
  classifier responses from the manager.

## Install-flow demo

1. Run the full local Agent Canvas stack with the automation backend enabled.
2. Open **Customize -> Extensions**.
3. Install this extension from the PR branch:

   ```text
   Source: https://github.com/OpenHands/demos.git
   Ref: add-kanban-demo-extension
   Repository path: agent-canvas/canvas-extensions/vibe-kanban
   ```

   For a checked-out local copy of this repo, install from the backend-local
   path `agent-canvas/canvas-extensions/vibe-kanban`, or use its absolute path
   if the Agent Server resolves relative paths from a different directory.
4. Installation should leave the extension disabled.
5. Enable it and open the **Vibe Kanban** nav item.
6. Submit a task and click **Start manager**.
7. Click **Run now** or wait for the cron automation to run.

## Files

- `canvas-extension.json` — Canvas Extension manifest.
- `extension.js` — self-contained browser ESM. It contains the UI, scoped CSS,
  JSON store client, minimal tar/gzip writer, automation lifecycle controls,
  and embedded manager automation source.
- `automation/main.py` — deterministic cron loop that snapshots file-backed
  board state, computes signals, and starts the manager conversation.
- `automation/vibestore.py` — JSON-file store plus Agent Server helpers used by
  the manager CLI.
- `automation/vibectl.py` — CLI the manager agent runs to snapshot, patch,
  dispatch, follow up, and inspect conversations.
- `build.mjs` — stdlib-only helper that re-embeds `automation/*.py` into
  `extension.js` after automation edits.

## Storage layout

```text
~/.openhands/vibe-kanban/
  index.json
  manager-state.json
  tickets/
    <ticket-id>.json
  bin/
    vibectl.py
    vibestore.py
    config.json
```

`index.json` tracks the automation id and workspace metadata. Each ticket file
tracks status, conversation id, manager note, dispatched entry count, and the
user/manager entry thread. `manager-state.json` stores the cron loop fingerprint,
retry count, and current manager conversation id.

## Simplifications versus vibe-manager

This artifact does not include:

- FastAPI routes or SQLite; JSON files are the shared store.
- workspace picker / per-workspace boards.
- attachments.
- PR/merge verification.
- budget enforcement.
- manager chat.
- theme picker.
- worker worktrees.

The point is to keep the extension + automation seam easy to study and reuse.

## Automation endpoint assumption

The browser-side **Start manager** flow follows the same raw-bundle approach as
Vibe Manager:

1. Create a small tar archive containing `main.py`, `vibestore.py`, `vibectl.py`, and `config.json`.
2. Gzip it in the browser with `CompressionStream`.
3. Upload to `/api/automation/v1/uploads`.
4. Create or re-enable `/api/automation/v1` with entrypoint `python3 main.py`.

If the active automation backend does not expose raw bundle endpoints yet, use
the files in `automation/` as a manual custom-automation bundle and write the
created automation id into `index.json`.
